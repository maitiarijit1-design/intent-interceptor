import express from "express";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { assertPublicUrl } from "./net.js";
import * as P from "./pipeline.js";

// tiny .env loader (no dependency)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const f of [".env", ".env.x"]) { try { for (const l of fs.readFileSync(path.join(root, f), "utf8").split("\n")) { const m = l.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, ""); } } catch {} }

const app = express();
app.set("trust proxy", true);
app.disable("x-powered-by");
const PORT = Number(process.env.PORT || 8787);

/* ---------------- rate limiting ---------------- */
const WINDOW = 15 * 60 * 1000, PER_WINDOW = Number(process.env.SCANS_PER_15MIN || 6), MAX_GLOBAL = Number(process.env.MAX_CONCURRENT_SCANS || 4);
const hits = new Map(); const active = new Map(); let globalActive = 0;
const clientIp = (req) => (req.headers["cf-connecting-ip"] || req.ip || "unknown").toString();

app.get("/api/health", (_req, res) => res.json({ ok: true }));
app.get("/api/config", (_req, res) => {
  const c = P.cfg();
  res.json({
    sources: { reddit: { configured: true, auth: "public" }, github: { configured: true, auth: c.github ? "token" : "unauthenticated" }, hn: { configured: true, auth: "public" }, x: { configured: c.x, auth: !c.x ? "not connected" : P.sourceState.x.status === "credits" ? "connected · credits depleted" : P.sourceState.x.status === "rate" ? "connected · rate limited" : "bearer token", status: P.sourceState.x.status } },
    ai: { grok: c.xai, model: c.xai ? c.xaiModel : null }, maxPosts: Number(process.env.MAX_POSTS || 15), limits: { scansPer15Min: PER_WINDOW },
  });
});

const cache = new Map(); // query cache across scans, 10 min
async function cached(key, fn) {
  const c = cache.get(key); if (c && Date.now() - c.t < 600000) { c.v.fresh = false; return c.v; }
  const v = await fn(); cache.set(key, { t: Date.now(), v }); v.fresh = true; return v;
}
async function pool(items, n, fn) { const out = []; let i = 0; await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } })); return out; }

app.get("/api/scan", async (req, res) => {
  const ip = clientIp(req);
  const send = (event, data) => { if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" });
  res.write(": ok\n\n");
  const fail = (code, message) => { send("fail", { code, message }); res.end(); };

  let input = String(req.query.url || "").trim();
  if (input && !/^https?:\/\//i.test(input)) input = `https://${input}`;
  try { assertPublicUrl(input); } catch (e) { return fail(e.code === "SSRF_BLOCKED" ? "SSRF_BLOCKED" : "BAD_URL", e.code === "SSRF_BLOCKED" ? "That address points to a private network and is blocked." : "Enter a valid public http(s) URL."); }
  const recent = (hits.get(ip) || []).filter((t) => Date.now() - t < WINDOW);
  if (recent.length >= PER_WINDOW) return fail("RATE_LIMITED", `Rate limit: ${PER_WINDOW} scans per 15 minutes per visitor. Try again in ${Math.ceil((WINDOW - (Date.now() - recent[0])) / 60000)} min.`);
  if (active.get(ip)) return fail("RATE_LIMITED", "You already have a scan running. Cancel it or wait for it to finish.");
  if (globalActive >= MAX_GLOBAL) return fail("BUSY", "The server is busy with other scans. Try again in a minute.");
  recent.push(Date.now()); hits.set(ip, recent); active.set(ip, true); globalActive++;

  const ac = new AbortController();
  const hardTimeout = setTimeout(() => ac.abort(), 4 * 60 * 1000);
  const ping = setInterval(() => res.write(": ping\n\n"), 15000);
  res.on("close", () => ac.abort());
  const signal = ac.signal;
  const log = (text, kind = "info") => send("log", { text, kind });
  const step = (i, state) => send("step", { i, state });
  const c = P.cfg();
  const want = { reddit: req.query.reddit !== "0", github: req.query.github !== "0", hn: req.query.hn !== "0", x: req.query.x !== "0" && c.x };

  try {
    log(`$ interceptor scan --url ${input}`, "cmd");
    step(0, "running");
    const d = await P.discoverUrls(input, { signal, log });
    log(`⚙️ Parsing Sitemap XML... Found ${d.contentCount} content URLs${d.fallback ? " (no blog-style paths matched, using all pages)" : ""} out of ${d.total} total. Scanning the ${d.picked.length} newest.`, "info");
    const hp = new URL(input).hostname.split("."); const brand = (hp.length > 1 ? hp[hp.length - 2] : hp[0]).toLowerCase();
    send("meta", { origin: new URL(input).origin, total: d.total, content: d.contentCount, picked: d.picked.length });
    step(0, "done"); step(1, "running");

    log("🕷️ Scraping content metadata and subheaders...");
    let blocked = 0;
    const posts = (await pool(d.picked, 4, async (u, k) => {
      if (signal.aborted) return null;
      try { const p = await P.scrapePost(u, { signal }); log(`   [${k + 1}/${d.picked.length}] ${p.title.slice(0, 80)} · ${p.headers.length} subheaders`, "muted"); return p; }
      catch (e) { if (e.code === "BLOCKED" || e.code === "RATE_LIMITED") blocked++; log(`   [${k + 1}/${d.picked.length}] ✗ ${u.loc} (${e.message})`, "warn"); return null; }
    })).filter(Boolean);
    if (signal.aborted) throw Object.assign(new Error("aborted"), { code: "ABORTED" });
    if (!posts.length) throw Object.assign(new Error(blocked ? "The site blocked our scraper (HTTP 403/429) on every post." : "Could not scrape any of the posts."), { code: blocked ? "BLOCKED" : "SCRAPE_FAILED" });
    log(`   Scraped ${posts.length}/${d.picked.length} posts.`, "ok");
    step(1, "done"); step(2, "running");

    log(c.xai ? `🏷️ Extracting core technical topics using Grok API (${c.xaiModel})...` : "🏷️ Extracting core technical topics using keyword heuristics (no XAI_API_KEY set; Grok mode off)...");
    await pool(posts, 3, async (p) => {
      let r = null;
      if (c.xai) { try { r = await P.grokTopics(p, { signal }); p.topicMode = "grok"; } catch (e) { log(`   Grok topic extraction failed for "${p.title.slice(0, 40)}" (${e.message.slice(0, 80)}); using heuristic.`, "warn"); } }
      if (!r) { r = P.heuristicTopics(p, brand); p.topicMode = "heuristic"; }
      Object.assign(p, r);
    });
    step(2, "done"); step(3, "running");

    const names = [want.x && "X", want.reddit && "Reddit", want.github && "GitHub", want.hn && "Hacker News"].filter(Boolean);
    log(`🔍 Tracing live friction points on X, Reddit, and GitHub... (live sources: ${names.join(", ")}${c.x ? "" : "; X not connected"})`);
    const counts = { reddit: 0, github: 0, hn: 0, x: 0 }; const warned = new Set();
    const finder = { reddit: P.searchReddit, github: P.searchGitHub, hn: P.searchHN, x: P.searchX };
    let gaps = 0; const results = []; let xRead = 0; const X_CAP = Number(process.env.X_MAX_POSTS_PER_SCAN || 200); const xSeenQ = new Set();
    await pool(posts, 2, async (p, idx) => {
      if (signal.aborted) return;
      const items = []; const seenUrl = new Set();
      for (const [src, fn] of Object.entries(finder)) {
        if (!want[src]) continue;
        const qs = src === "hn" ? p.queries : p.queries.slice(0, 1);
        for (const q of qs) {
          if (src === "x") {
            const hit = cache.get(`x:${q}`); const isCached = hit && Date.now() - hit.t < 600000;
            if (!isCached && xRead + 10 > X_CAP) { if (!warned.has("x:cap")) { warned.add("x:cap"); log(`   ⚠ X: per-scan cap of ${X_CAP} posts reached, skipping further X queries`, "warn"); } continue; }
          }
          try {
            const got = await cached(`${src}:${q}`, () => fn(q, { signal }));
            if (src === "x" && got.fresh) xRead += got.length;
            for (const it of got) if (!seenUrl.has(it.url)) { seenUrl.add(it.url); items.push(it); }
          } catch (e) {
            if (e.code === "ABORTED" || signal.aborted) return;
            const k = `${src}:${e.code}`; if (!warned.has(k)) { warned.add(k); log(`   ⚠ ${({ hn: "Hacker News", x: "X", github: "GitHub", reddit: "Reddit" })[src]}: ${e.message}`, "warn"); }
          }
        }
      }
      items.forEach((it) => counts[it.source]++);
      const s = P.scorePost(p, items, brand);
      let narr;
      if (c.xai) { try { narr = await P.grokNarrative(p, s, { signal }); } catch (e) { log(`   Grok narrative failed (${e.message.slice(0, 80)}); using template.`, "warn"); } }
      if (!narr) narr = P.templateNarrative(p, s);
      if (s.severity !== "low") gaps++;
      const row = {
        id: `p${idx}`, title: p.title, url: p.url, path: p.path, updated: p.date, score: s.score, severity: s.severity,
        topics: p.topics, queries: p.queries, topicMode: p.topicMode, aiWritten: narr.aiWritten,
        sources: [...new Set(s.top.slice(0, 5).map((t) => t.source))], harvested: items.length,
        intents: s.top.slice(0, 5).map((t) => ({ source: t.source, title: t.title, text: t.text, handle: t.handle, url: t.url, created: t.created, engagement: t.engagement })),
        reason: narr.reason, markdown: narr.markdown,
      };
      results.push(row); send("post", row);
      log(`   ✓ ${p.title.slice(0, 60)} → ${items.length} live items, relevancy ${s.score}/100 (${s.severity})`, "muted");
    });
    if (signal.aborted) throw Object.assign(new Error("aborted"), { code: "ABORTED" });
    if (want.x) log(`   X: ${xRead} posts read, about $${(xRead * 0.005).toFixed(2)} estimated API spend${P.sourceState.x.status === "credits" ? " (API credits depleted, X skipped)" : ""}`, "info");
    log(`   Harvested: Reddit ${counts.reddit} · GitHub ${counts.github} · Hacker News ${counts.hn} · X ${c.x ? counts.x : "not connected"}`, "info");
    step(3, "done"); step(4, "done");
    const avg = results.length ? Math.round(results.reduce((a, b) => a + b.score, 0) / results.length) : 0;
    log(`✅ Gap analysis complete. ${gaps} of ${results.length} posts flagged with active intent gaps. Average relevancy ${avg}/100.`, "ok");
    send("done", { scanned: results.length, gaps, score: avg, counts, mode: { topics: c.xai ? "grok" : "heuristic", narrative: c.xai ? "grok" : "template" } });
    res.end();
  } catch (e) {
    if (e.code === "ABORTED" || signal.aborted) { if (!res.writableEnded) fail("CANCELLED", "Scan cancelled or timed out."); }
    else fail(e.code || "ERROR", e.message || "Scan failed");
  } finally {
    clearTimeout(hardTimeout); clearInterval(ping); active.delete(ip); globalActive--;
  }
});

const dist = path.join(root, "dist");
app.use(express.static(dist, { maxAge: "1h", index: false }));
app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(dist, "index.html")));
app.listen(PORT, () => console.log(`Intent Interceptor listening on http://localhost:${PORT}`));
