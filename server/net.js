// Safe outbound HTTP: http(s) only, SSRF protection after DNS resolution,
// timeouts, manual redirect handling and a response size cap.
import dns from "node:dns";
import net from "node:net";
import { Agent, fetch as ufetch } from "undici";

export const UA = "Mozilla/5.0 (compatible; IntentInterceptor/1.0; +https://github.com/) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128 Safari/537.36";
export const MAX_BYTES = 9 * 1024 * 1024;

export function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19) && process.env.SSRF_ALLOW_FAKE_IP !== "1") || a >= 224;
  }
  if (net.isIPv6(ip)) {
    const x = ip.toLowerCase();
    if (x === "::" || x === "::1") return true;
    const m = x.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (m) return isPrivateIp(m[1]);
    return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(x) || x.startsWith("64:ff9b") || x.startsWith("2001:db8");
  }
  return true;
}

function safeLookup(hostname, options, cb) {
  dns.lookup(hostname, { all: true, family: 0 }, (err, addrs) => {
    if (err) return cb(err);
    const bad = addrs.find((a) => isPrivateIp(a.address));
    if (bad || !addrs.length) return cb(Object.assign(new Error(`Blocked address for ${hostname}`), { code: "SSRF_BLOCKED" }));
    if (options && options.all) return cb(null, addrs);
    cb(null, addrs[0].address, addrs[0].family);
  });
}

const safeAgent = new Agent({ connect: { lookup: safeLookup, timeout: 8000 }, headersTimeout: 12000, bodyTimeout: 15000 });
const apiAgent = new Agent({ connect: { timeout: 8000 }, headersTimeout: 12000, bodyTimeout: 15000 });

export class FetchError extends Error {
  constructor(msg, code, status) { super(msg); this.code = code; this.status = status; }
}

export function assertPublicUrl(u) {
  let url;
  try { url = new URL(u); } catch { throw new FetchError("Invalid URL", "BAD_URL"); }
  if (!/^https?:$/.test(url.protocol)) throw new FetchError("Only http(s) URLs are allowed", "BAD_URL");
  if (url.username || url.password) throw new FetchError("Credentials in URL not allowed", "BAD_URL");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host) && isPrivateIp(host)) throw new FetchError("Private address blocked", "SSRF_BLOCKED");
  if (/^(localhost|.*\.local|.*\.internal|.*\.localhost)$/i.test(host)) throw new FetchError("Private host blocked", "SSRF_BLOCKED");
  return url;
}

async function readCapped(res, max = MAX_BYTES) {
  const len = Number(res.headers.get("content-length") || 0);
  if (len > max) throw new FetchError("Response too large", "TOO_LARGE");
  const reader = res.body.getReader();
  const chunks = []; let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) { reader.cancel().catch(() => {}); throw new FetchError("Response too large", "TOO_LARGE"); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Fetch an arbitrary user-supplied (untrusted) URL safely. */
export async function safeFetchText(u, { signal, timeout = 15000, accept = "*/*" } = {}) {
  let url = assertPublicUrl(u);
  for (let hop = 0; hop < 5; hop++) {
    const ac = AbortSignal.any([signal, AbortSignal.timeout(timeout)].filter(Boolean));
    let res;
    try {
      res = await ufetch(url.href, { dispatcher: safeAgent, redirect: "manual", signal: ac, headers: { "user-agent": UA, accept, "accept-language": "en" } });
    } catch (e) {
      const c = e.cause?.code || e.code;
      if (c === "SSRF_BLOCKED") throw new FetchError("Private address blocked", "SSRF_BLOCKED");
      if (e.name === "TimeoutError" || e.name === "AbortError") throw new FetchError("Timed out", signal?.aborted ? "ABORTED" : "TIMEOUT");
      throw new FetchError(`Network error: ${c || e.message}`, "NETWORK");
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      res.body?.cancel().catch(() => {});
      url = assertPublicUrl(new URL(res.headers.get("location"), url).href);
      continue;
    }
    if (!res.ok) { res.body?.cancel().catch(() => {}); throw new FetchError(`HTTP ${res.status}`, res.status === 429 ? "RATE_LIMITED" : (res.status === 403 || res.status === 401) ? "BLOCKED" : "HTTP", res.status); }
    return { text: await readCapped(res), finalUrl: url.href, contentType: res.headers.get("content-type") || "" };
  }
  throw new FetchError("Too many redirects", "REDIRECTS");
}

/** Fetch JSON from a fixed, trusted public API. */
export async function apiJson(u, { signal, headers = {}, timeout = 12000, method = "GET", body } = {}) {
  const ac = AbortSignal.any([signal, AbortSignal.timeout(timeout)].filter(Boolean));
  const res = await ufetch(u, { dispatcher: apiAgent, signal: ac, method, body, headers: { "user-agent": UA, accept: "application/json", ...headers } });
  const text = await readCapped(res, 4 * 1024 * 1024);
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, ok: res.ok, headers: res.headers, json, text };
}
