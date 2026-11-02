// Free SEO + keyword tracker: on-page audit, TF-IDF keywords, competitor overlap, autocomplete ideas, rank tracking.
import * as cheerio from "cheerio";
import { toks, searchBrave, searchDDG, braveState } from "./free.js";
import { UA } from "./net.js";

const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
function syllables(w) { w = w.toLowerCase().replace(/[^a-z]/g, ""); if (w.length <= 3) return 1; const m = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, "").replace(/^y/, "").match(/[aeiouy]{1,2}/g); return Math.max(1, m ? m.length : 1); }

/* ---------------- 1) On-page audit (from raw HTML, before stripping) ---------------- */
export function audit(html, url, ms) {
  const $ = cheerio.load(html); const host = new URL(url).hostname.replace(/^www\./, "");
  const title = $("head title").first().text().replace(/\s+/g, " ").trim();
  const desc = ($('meta[name="description"]').attr("content") || "").trim();
  const h1 = $("h1").map((_, e) => $(e).text().replace(/\s+/g, " ").trim()).get().filter(Boolean);
  const levels = $("h1,h2,h3,h4,h5,h6").map((_, e) => Number(e.tagName[1])).get();
  let skips = 0; for (let i = 1; i < levels.length; i++) if (levels[i] - levels[i - 1] > 1) skips++;
  const canonical = $('link[rel="canonical"]').attr("href") || "";
  const og = ["og:title", "og:description", "og:image", "og:url"].filter((p) => $(`meta[property="${p}"]`).attr("content"));
  const schema = []; $('script[type="application/ld+json"]').each((_, e) => { try { const j = JSON.parse($(e).contents().text()); const arr = Array.isArray(j) ? j : j["@graph"] || [j]; arr.forEach((x) => x?.["@type"] && schema.push([].concat(x["@type"]).join("/"))); } catch {} });
  const imgs = $("img"); const withAlt = imgs.filter((_, e) => ($(e).attr("alt") || "").trim().length > 0).length;
  let internal = 0, external = 0; $("a[href]").each((_, e) => { try { const u = new URL($(e).attr("href"), url); if (!/^https?:/.test(u.protocol)) return; u.hostname.replace(/^www\./, "").endsWith(host) ? internal++ : external++; } catch {} });
  $("script,style,noscript,svg,nav,footer,header,aside,form").remove();
  const root = $("article").length ? $("article").first() : $("main").length ? $("main").first() : $("body");
  const text = root.text().replace(/\s+/g, " ").trim();
  const words = text.split(/\s+/).filter((w) => /[a-z]/i.test(w)); const sentences = Math.max(1, (text.match(/[.!?]+(\s|$)/g) || []).length);
  const syl = words.slice(0, 5000).reduce((a, w) => a + syllables(w), 0) / Math.max(1, Math.min(words.length, 5000));
  const flesch = Math.round(clamp(206.835 - 1.015 * (words.length / sentences) - 84.6 * syl, 0, 100));
  const fixes = []; let score = 100; const pen = (n, msg) => { score -= n; fixes.push(msg); };
  if (!title) pen(15, "Add a <title> tag."); else if (title.length < 30 || title.length > 60) pen(6, `Title is ${title.length} chars; aim for 30–60.`);
  if (!desc) pen(12, "Add a meta description (120–160 chars)."); else if (desc.length < 70 || desc.length > 160) pen(5, `Meta description is ${desc.length} chars; aim for 120–160.`);
  if (h1.length === 0) pen(12, "Add exactly one H1."); else if (h1.length > 1) pen(5, `Page has ${h1.length} H1s; keep one.`);
  if (skips) pen(Math.min(8, skips * 2), `Heading levels skip ${skips} time(s) (e.g. H2→H4).`);
  if (!canonical) pen(8, "Add a canonical link tag.");
  if (og.length < 4) pen(2 * (4 - og.length), `Missing Open Graph tags: ${["og:title", "og:description", "og:image", "og:url"].filter((p) => !og.includes(p)).join(", ")}.`);
  if (!schema.length) pen(8, "Add JSON-LD structured data (e.g. Article/BlogPosting).");
  const altPct = imgs.length ? Math.round((withAlt / imgs.length) * 100) : 100;
  if (altPct < 90) pen(Math.round((90 - altPct) / 10), `${imgs.length - withAlt} of ${imgs.length} images lack alt text.`);
  if (internal < 3) pen(5, `Only ${internal} internal links; link to related posts/docs.`);
  if (words.length < 300) pen(10, `Thin content: ${words.length} words.`); else if (words.length < 600) pen(4, `Short content: ${words.length} words.`);
  if (flesch < 30) pen(5, `Hard to read (Flesch ${flesch}); shorten sentences.`);
  if (ms > 2500) pen(6, `Slow fetch: ${ms} ms.`); else if (ms > 1200) pen(2, `Fetch took ${ms} ms.`);
  return { score: clamp(Math.round(score), 0, 100), fixes, title, titleLen: title.length, desc, descLen: desc.length, h1: h1.length, headings: levels.length, headingSkips: skips, canonical: !!canonical, og: og.length, schema: [...new Set(schema)].slice(0, 5), images: imgs.length, altPct, internal, external, words: words.length, flesch, ms };
}

/* ---------------- 2) TF-IDF keywords + phrases ---------------- */
const KW_STOP = new Set("use using used new also get one two may make made way well like just can will much many need able etc via per want see learn read today now still every within without across built build part let lets work works page pages blog post posts docs guide guides click here more".split(" "));
function grams(p) {
  const field = (s, w) => ({ t: toks(s).filter((x) => x.length > 2 && !KW_STOP.has(x) && !/^\d/.test(x)), w });
  const fields = [field(p.title, 5), field((p.headers || []).join(" . "), 3), field(p.description || "", 2), field((p.bodyText || "").slice(0, 40000), 1)];
  const tf = new Map(); let total = 0;
  for (const { t, w } of fields) for (let n = 1; n <= 3; n++) for (let i = 0; i + n <= t.length; i++) { const g = t.slice(i, i + n); if (n > 1 && new Set(g).size < n) continue; const k = g.join(" "); tf.set(k, (tf.get(k) || 0) + w * (n === 1 ? 1 : n * 0.9)); if (n === 1 && w === 1) total++; }
  return { tf, total: Math.max(1, total), body: ` ${fields[3].t.join(" ")} ` };
}
export function keywords(docs, { top = 12 } = {}) {
  const G = docs.map(grams); const df = new Map(); G.forEach((g) => { for (const k of g.tf.keys()) df.set(k, (df.get(k) || 0) + 1); });
  const N = docs.length;
  const per = G.map((g, i) => {
    const sc = [...g.tf.entries()].filter(([k, v]) => v >= (k.includes(" ") ? 4 : 6)).map(([k, v]) => [k, v * Math.log(1 + (N + 1) / (df.get(k) || 1))]).sort((a, b) => b[1] - a[1]);
    const out = []; for (const [k, s] of sc) { if (out.some((o) => o.k.includes(k) || (k.includes(o.k) && o.s > s * 1.3))) continue; const occ = g.body.split(` ${k} `).length - 1; if (occ < 1 && k.includes(" ")) continue; out.push({ k, s, density: +((occ * k.split(" ").length / g.total) * 100).toFixed(2), count: occ }); if (out.length >= top) break; }
    return out.map((o) => ({ keyword: o.k, score: +o.s.toFixed(1), density: o.density, count: o.count }));
  });
  const site = new Map(); per.forEach((list, i) => list.forEach((x) => { const e = site.get(x.keyword) || { keyword: x.keyword, score: 0, posts: [] }; e.score += x.score; e.posts.push(i); site.set(x.keyword, e); }));
  return { per, site: [...site.values()].sort((a, b) => b.score - a.score).slice(0, 25).map((e) => ({ ...e, score: +e.score.toFixed(1) })) };
}

/* ---------------- 3) Competitor overlap ---------------- */
export function overlap(userDocs, compDocs) {
  const all = keywords([...userDocs, ...compDocs], { top: 10 });
  const uPer = all.per.slice(0, userDocs.length), cPer = all.per.slice(userDocs.length);
  const userText = userDocs.map((d) => ` ${d.title} ${(d.headers || []).join(" ")} ${d.bodyText || ""} `.toLowerCase()).join(" ");
  const uMap = new Map(); uPer.forEach((l, i) => l.forEach((x) => { if (!uMap.has(x.keyword)) uMap.set(x.keyword, []); uMap.get(x.keyword).push({ title: userDocs[i].title, url: userDocs[i].url }); }));
  const cMap = new Map(); cPer.forEach((l, i) => l.forEach((x) => { if (!cMap.has(x.keyword)) cMap.set(x.keyword, []); cMap.get(x.keyword).push({ title: compDocs[i].title, url: compDocs[i].url, competitor: compDocs[i].competitor }); }));
  const shared = [], compOnly = [], userOnly = [];
  for (const [k, pages] of cMap) { if (uMap.has(k)) shared.push({ keyword: k, user: uMap.get(k), competitor: pages }); else if (!userText.includes(` ${k} `)) compOnly.push({ keyword: k, competitor: pages }); }
  for (const [k, pages] of uMap) if (!cMap.has(k)) userOnly.push({ keyword: k, user: pages });
  return { shared: shared.slice(0, 20), compOnly: compOnly.sort((a, b) => b.competitor.length - a.competitor.length).slice(0, 25), userOnly: userOnly.slice(0, 25) };
}

/* ---------------- 4) Autocomplete ideas ---------------- */
async function getJson(url, signal, accept = "application/json") { const r = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(8000)].filter(Boolean)), headers: { "user-agent": UA, accept } }); if (!r.ok) throw new Error(`HTTP ${r.status}`); return JSON.parse(await r.text()); }
const SUGGEST = {
  google: async (q, s) => (await getJson(`https://suggestqueries.google.com/complete/search?client=firefox&q=${encodeURIComponent(q)}`, s))[1] || [],
  duckduckgo: async (q, s) => (await getJson(`https://duckduckgo.com/ac/?q=${encodeURIComponent(q)}&type=list`, s))[1] || [],
  bing: async (q, s) => (await getJson(`https://api.bing.com/osjson.aspx?query=${encodeURIComponent(q)}`, s))[1] || [],
};
export async function ideas(seeds, { signal, log }) {
  const status = {}; const out = new Map();
  for (const [src, fn] of Object.entries(SUGGEST)) {
    status[src] = "ok"; let ok = 0;
    for (const seed of seeds) {
      try { const list = await fn(seed, signal); ok++; for (const s of list.slice(0, 8)) { const k = String(s).toLowerCase().trim(); if (!k || k === seed) continue; const e = out.get(k) || { idea: k, seed, sources: [] }; if (!e.sources.includes(src)) e.sources.push(src); out.set(k, e); } }
      catch (e) { if (signal?.aborted) throw e; status[src] = `blocked (${e.message.slice(0, 40)})`; break; }
      await new Promise((r) => setTimeout(r, 300));
    }
    if (status[src] !== "ok") log?.(`   ⚠ Autocomplete ${src}: ${status[src]}, skipped`, "warn");
  }
  return { status, list: [...out.values()].sort((a, b) => b.sources.length - a.sources.length).slice(0, 60) };
}

/* ---------------- 5) Rank tracking ---------------- */
export async function ranks(kws, domains, { signal, log, max = 10 }) {
  const useBrave = !!process.env.BRAVE_API_KEY && braveState.status !== "auth";
  const rows = []; let engine = useBrave ? "brave" : "duckduckgo";
  for (const kw of kws.slice(0, Math.min(max, 20))) {
    let res = null;
    if (useBrave) { try { res = await searchBrave(kw, { signal, recent: false }); } catch (e) { if (e.code === "ABORTED") throw e; log?.(`   ⚠ Rank (Brave) "${kw}": ${e.message}; trying DuckDuckGo`, "warn"); } }
    let eng = res ? "brave" : "duckduckgo";
    if (!res) { try { res = await searchDDG(kw, { signal, recent: false }); } catch (e) { if (signal?.aborted) throw e; rows.push({ keyword: kw, engine: "unavailable", positions: {} }); continue; } }
    const positions = {}; const urls = {};
    for (const d of domains) { const i = res.slice(0, 20).findIndex((r) => { try { return new URL(r.url).hostname.replace(/^www\./, "").endsWith(d); } catch { return false; } }); positions[d] = i >= 0 ? i + 1 : null; if (i >= 0) urls[d] = res[i].url; }
    rows.push({ keyword: kw, engine: eng, bestEffort: eng !== "brave", results: Math.min(20, res.length), positions, urls });
    if (eng !== "brave") engine = "duckduckgo";
  }
  return { engine, rows };
}
