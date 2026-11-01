import express from "express";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { assertPublicUrl } from "./net.js";
import * as P from "./pipeline.js";

// tiny .env loader (no dependency)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const f of [".env", ".env.x", ".env.xai"]) { try { for (const l of fs.readFileSync(path.join(root, f), "utf8").split("\n")) { const m = l.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, ""); } } catch {} }

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
    sources: { web: { configured: true, auth: "free · DuckDuckGo" }, so: { configured: true, auth: "free API" }, devto: { configured: true, auth: "free API" }, reddit: { configured: true, auth: "public" }, github: { configured: true, auth: c.github ? "token" : "unauthenticated" }, hn: { configured: true, auth: "public" }, x: { configured: c.x, auth: !c.x ? "not connected" : P.sourceState.x.status === "credits" ? "connected · credits depleted" : P.sourceState.x.status === "rate" ? "connected · rate limited" : "bearer token", status: P.sourceState.x.status } },
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
  const hardTimeout = setTimeout(() => ac.abort(), 6 * 60 * 1000);
  const ping = setInterval(() => res.write(": ping\n\n"), 15000);
  res.on("close", () => ac.abort());
  const signal = ac.signal;
  const log = (text, kind = "info") => send("log", { text, kind });
  const step = (i, state) => send("step", { i, state });
  const c = P.cfg();
  const want = { web: req.query.web !== "0", devto: req.query.devto !== "0", so: req.query.so !== "0", reddit: req.query.reddit !== "0", github: req.query.github !== "0", hn: req.query.hn !== "0", x: req.query.x !== "0" && c.x };

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
    if (!c.xai) { const F0 = await import("./free.js"); const kp = F0.keyphrases(posts, [brand]); posts.forEach((p, i) => { if (kp[i].length >= 2) p.topics = kp[i].map((t) => t.replace(/\b\w/g, (x) => x.toUpperCase())); }); }
    step(2, "done"); step(3, "running");

    // ---------- Competitors (70% weight) ----------
    const F = await import("./free.js");
    const COMP_PAGES = Number(process.env.COMP_PAGES_PER_SITE || 8);
    const ownHost = new URL(input).hostname.replace(/^www\./, "");
    let competitors = String(req.query.competitors || "").split(/[,\s]+/).map((s) => s.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "").toLowerCase()).filter((s) => /\.[a-z]{2,}$/.test(s) && !s.endsWith(ownHost)).slice(0, 5);
    if (competitors.length) log(`🏁 Competitors (from input): ${competitors.join(", ")}`);
    else {
      log("🏁 Auto-discovering competitors via free web search, Hacker News and Reddit (\"" + brand + " alternatives\", \"" + brand + " vs\")...");
      competitors = await F.discoverCompetitors(input, { signal, log, searchers: { web: F.searchWeb, hn: P.searchHN, reddit: P.searchReddit } });
      log(competitors.length ? `   Found: ${competitors.join(", ")} (edit them in the Competitors field and re-scan to refine)` : "   No competitors discovered; competitor signal will be 0. Add domains in the Competitors field.", competitors.length ? "ok" : "warn");
    }
    send("competitors", { list: competitors });
    const topicWords = [...new Set(posts.flatMap((p) => F.topicTerms(p, [brand]).words))];
    const compPages = []; const compStats = {};
    await pool(competitors, 2, async (dom) => {
      if (signal.aborted) return;
      try {
        const cd = await P.discoverUrls(`https://${dom}`, { signal, log: () => {}, maxPosts: 0 });
        const ranked = F.rankCompetitorUrls(cd.content, topicWords, COMP_PAGES);
        const pages = (await pool(ranked, 3, async (u) => { try { return await P.scrapePost(u, { signal }); } catch { return null; } })).filter(Boolean);
        for (const pg of pages) compPages.push({ competitor: dom, title: pg.title, url: pg.url, headers: pg.headers, tokens: F.toks(`${pg.title} ${pg.title} ${pg.title} ${pg.headers.join(" ")} ${pg.headers.join(" ")} ${pg.description} ${pg.bodyText.slice(0, 6000)}`), pg });
        compStats[dom] = { urls: cd.contentCount, crawled: pages.length };
        log(`   ↳ ${dom}: ${cd.contentCount} content URLs in sitemap, ${ranked.length} topic-matched, ${pages.length} crawled`, "muted");
      } catch (e) { if (signal.aborted) return; compStats[dom] = { urls: 0, crawled: 0, error: e.message }; log(`   ⚠ ${dom}: ${e.message}`, "warn"); }
    });
    const compScorer = F.cosineScorer([...compPages.map((c) => c.tokens), ...posts.map((p) => [...F.postProfile(p).keys()])]);

    // ---------- Social listening (30% weight) ----------
    const names = [want.web && "Web", want.so && "Stack Overflow", want.devto && "dev.to", want.x && "X", want.reddit && "Reddit", want.github && "GitHub", want.hn && "Hacker News"].filter(Boolean);
    log(`🔍 Tracing live friction points on X, Reddit, and GitHub... (live sources: ${names.join(", ")}${c.x ? "" : "; X not connected"}; competitor brands included in queries)`);
    const counts = { reddit: 0, github: 0, hn: 0, x: 0, web: 0, so: 0, devto: 0 }; const kept = { ...counts }; const warned = new Set();
    const finder = { web: F.searchWeb, so: F.searchSO, reddit: P.searchReddit, github: P.searchGitHub, hn: P.searchHN, x: P.searchX };
    const compBrands = competitors.map((d) => F.brandOf(d));
    let gaps = 0; const results = []; let xRead = 0; const X_CAP = Number(process.env.X_MAX_POSTS_PER_SCAN || 200);
    const dropTotals = { generic: 0, noUrl: 0, stale: 0, offTopic: 0, lowSim: 0 };
    await pool(posts, 2, async (p, idx) => {
      if (signal.aborted) return;
      const { phrases, words } = F.topicTerms(p, [brand]);
      const phrase = phrases.find((x) => x.includes(" ")) || words.slice(0, 2).join(" ");
      const two = words.slice(0, 2).join(" ");
      const qMain = phrase.includes(" ") ? `"${phrase}"` : two;
      const qComp = compBrands[idx % Math.max(1, compBrands.length)] ? `${compBrands[idx % compBrands.length]} ${words[0] || ""}`.trim() : null;
      const plan = { web: [`${phrase} problem`], so: [two], reddit: [qMain], github: [qMain], hn: [qMain, qComp].filter(Boolean), x: [qMain] };
      if (qComp) { plan.reddit.push(qComp); plan.web.push(`${qComp} ${words[1] || ""}`.trim()); }
      const items = []; const seenUrl = new Set();
      const run = async (src, q, fn) => {
        if (src === "x") { const hit = cache.get(`x:${q}`); if (!(hit && Date.now() - hit.t < 600000) && xRead + 10 > X_CAP) { if (!warned.has("x:cap")) { warned.add("x:cap"); log(`   ⚠ X: per-scan cap of ${X_CAP} posts reached, skipping further X queries`, "warn"); } return; } }
        try {
          const got = await cached(`${src}:${q}`, () => fn(q, { signal }));
          if (src === "x" && got.fresh) xRead += got.length;
          for (const it of got) if (it.url && !seenUrl.has(it.url)) { seenUrl.add(it.url); items.push(it); }
        } catch (e) {
          if (e.code === "ABORTED" || signal.aborted) return;
          const k = `${src}:${e.code}`; if (!warned.has(k)) { warned.add(k); log(`   ⚠ ${F.LBL?.[src] || src}: ${e.message}`, "warn"); }
        }
      };
      for (const [src, qs] of Object.entries(plan)) { if (want[src] === false) continue; if (src === "x" && !want.x) continue; for (const q of qs) await run(src, q, finder[src]); }
      if (words[0] && want.devto) await run("devto", words[0], F.searchDevto);
      items.forEach((it) => counts[it.source] = (counts[it.source] || 0) + 1);
      const fr = F.filterRelevant(p, items, { brands: [brand], ownHost, contextBrands: compBrands });
      Object.keys(dropTotals).forEach((k) => dropTotals[k] += fr.dropped[k]);
      fr.kept.forEach((it) => kept[it.source] = (kept[it.source] || 0) + 1);
      const social = F.socialSignal(fr.kept);
      const comp = F.competitorSignal(p, compPages, compScorer);
      const gap = Math.round(0.7 * comp.signal + 0.3 * social);
      let narr = F.extractiveNarrative(p, fr.kept, comp); let aiWritten = false;
      if (c.xai && narr.status === "gap") {
        try {
          const ev = [...comp.matches.filter((m) => m.missing.length).map((m) => ({ source: "web", title: `Competitor ${m.competitor}: ${m.title} (covers: ${m.missing.join("; ")})`, text: "", url: m.url, created: Date.now() })), ...fr.kept.slice(0, 4)];
          const g = await P.grokNarrative(p, { top: ev }, { signal }); narr = { ...narr, reason: g.reason, markdown: g.markdown }; aiWritten = true;
        } catch (e) { log(`   Grok narrative failed (${e.message.slice(0, 80)}); using extractive copy.`, "warn"); }
      }
      const score = narr.status === "no_gap" ? Math.max(90, 100 - gap) : Math.max(5, 100 - gap);
      const severity = narr.status === "no_gap" ? "none" : score < 45 ? "critical" : score < 60 ? "high" : score < 80 ? "medium" : "low";
      if (narr.status === "gap" && score < 80) gaps++;
      const row = {
        id: `p${idx}`, title: p.title, url: p.url, path: p.path, updated: p.date, score, severity, status: narr.status,
        compScore: comp.signal, socialScore: social, mode: aiWritten ? "grok" : "heuristic",
        topics: p.topics, queries: [...new Set(Object.values(plan).flat())], topicMode: p.topicMode, aiWritten,
        sources: [...new Set([...fr.kept.slice(0, 5).map((t) => t.source), ...(comp.matches.length ? ["competitor"] : [])])], harvested: items.length, keptCount: fr.kept.length, dropped: fr.dropped,
        competitors: comp.matches,
        intents: fr.kept.slice(0, 5).map((t) => ({ source: t.source, title: t.title, text: t.text, handle: t.handle, url: t.url, created: t.created, engagement: t.engagement, sim: t.sim, hits: t.hits })),
        reason: narr.reason, markdown: narr.markdown,
      };
      results.push(row); send("post", row);
      log(`   ✓ ${p.title.slice(0, 55)} → ${items.length} harvested, ${fr.kept.length} relevant · competitor ${comp.signal}/100 · social ${social}/100 → relevancy ${score}/100${narr.status === "no_gap" ? " (no active gap)" : ""}`, "muted");
    });
    if (signal.aborted) throw Object.assign(new Error("aborted"), { code: "ABORTED" });
    if (want.x) log(`   X: ${xRead} posts read, about $${(xRead * 0.005).toFixed(2)} estimated API spend${P.sourceState.x.status === "credits" ? " (API credits depleted, X skipped)" : ""}`, "info");
    log(`   Harvested → relevant: Web ${counts.web}→${kept.web} · Stack Overflow ${counts.so}→${kept.so} · dev.to ${counts.devto}→${kept.devto} · Reddit ${counts.reddit}→${kept.reddit} · GitHub ${counts.github}→${kept.github} · HN ${counts.hn}→${kept.hn} · X ${c.x ? `${counts.x}→${kept.x}` : "not connected"}`, "info");
    log(`   Dropped: ${dropTotals.generic} generic/hiring/spam, ${dropTotals.offTopic} with <2 topic terms, ${dropTotals.lowSim} below similarity threshold, ${dropTotals.stale} older than 90 days, ${dropTotals.noUrl} without URL`, "muted");
    step(3, "done"); step(4, "done");
    // competitor topics the user's site lacks entirely
    const ownScorer = compScorer;
    const uncovered = compPages.map((cp) => ({ competitor: cp.competitor, title: cp.title, url: cp.url, best: Math.max(0, ...posts.map((p) => ownScorer(F.postProfile(p), cp.tokens))) })).filter((x) => x.best < 0.1).sort((a, b) => a.best - b.best).slice(0, 10);
    const covered = results.filter((r) => r.competitors.length).length;
    const avg = results.length ? Math.round(results.reduce((a, b) => a + b.score, 0) / results.length) : 0;
    log(`✅ Gap analysis complete (${c.xai ? "Grok-assisted" : "heuristic, free sources"}). ${gaps} of ${results.length} posts flagged. Average relevancy ${avg}/100. Competitors cover ${covered}/${results.length} of your topics; ${uncovered.length} competitor pages have no matching post on your site.`, "ok");
    send("done", { scanned: results.length, gaps, score: avg, counts, kept, competitors, compStats, competitorCoverage: { covered, total: results.length, uncovered }, mode: { topics: c.xai ? "grok" : "heuristic", narrative: c.xai ? "grok" : "extractive" } });
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
