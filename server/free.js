// Free, key-less intelligence layer: web search (DuckDuckGo HTML), Stack Overflow, dev.to,
// strict local relevance scoring (BM25-style TF-IDF cosine), competitor discovery/crawl and
// extractive gap narratives built only from surviving items.
import * as cheerio from "cheerio";
import { safeFetchText, apiJson, FetchError, UA } from "./net.js";
import { TECH } from "./pipeline.js";


const DAY = 86400000;
const STOP = new Set(("a an the and or but if then else for to of in on at by with from as is are was were be been being this that these those it its your you we our us they their them how what why when where which who will can could should would may might must do does did not no yes vs via into over under about more most less very just than so such also using use used guide complete ultimate introduction intro part new best tips top way ways get getting make making build building learn step steps everything need know first now here there all any each every other some own same out up down one two three blog post posts article read announcing announcement today launch week day update updates feature features copy link heading permalink anchor section click docs page pages mastering deep dive faster easier simple better great supports support introducing i me my he she his her has have had am don't can't it's i'm").split(/\s+/));
export function toks(s = "") { return (String(s).toLowerCase().match(/[a-z0-9][a-z0-9.+#-]*[a-z0-9+#]|[a-z0-9]/g) || []).filter((t) => t.length > 1 && !STOP.has(t) && !/^[\d.]+$/.test(t)); }

/* ---------------- generic / spam blocklist ---------------- */
export const GENERIC = /\b(who('?s| is) hiring|who wants to be hired|freelancer\? seeking freelancer|hiring|we'?re hiring|job (post|opening|offer)|remote jobs?|salary|show hn|launch hn|ask hn: what are you working on|weekly (thread|discussion)|monthly (thread|discussion)|megathread|daily discussion|giveaway|promo code|discount|airdrop|crypto ?pump|webinar|sponsored|top \d+ (best )?\w+ (tools|alternatives))\b/i;

/* ---------------- polite free web search (DuckDuckGo HTML, lite fallback) ---------------- */
let lastWeb = 0; let webQueue = Promise.resolve(); export const webState = { status: null, until: 0 };
function politeGap(ms = 1500) { const run = webQueue.then(async () => { const w = lastWeb + ms - Date.now(); if (w > 0) await new Promise((r) => setTimeout(r, w)); lastWeb = Date.now(); }); webQueue = run.catch(() => {}); return run; }
export async function searchWeb(q, { signal, recent = true } = {}) {
  if (webState.status && Date.now() < webState.until) throw new FetchError("web search temporarily blocked (bot check), skipped", "BLOCKED");
  await politeGap();
  const body = new URLSearchParams({ q, ...(recent ? { df: "m" } : {}) }).toString();
  let html = "";
  for (const [url, opts] of [["https://html.duckduckgo.com/html/", { method: "POST", body }], [`https://lite.duckduckgo.com/lite/?${body}`, { method: "GET" }]]) {
    try {
      const r = await fetch(url, { ...opts, signal: AbortSignal.any([signal, AbortSignal.timeout(12000)].filter(Boolean)), headers: { "user-agent": UA, "content-type": "application/x-www-form-urlencoded", "accept-language": "en" } });
      if (r.status === 200) { html = await r.text(); if (/result__a|result-link/.test(html)) break; }
    } catch (e) { if (signal?.aborted) throw new FetchError("aborted", "ABORTED"); }
  }
  if (!/result__a|result-link/.test(html)) { webState.status = "blocked"; webState.until = Date.now() + 5 * 60000; throw new FetchError("DuckDuckGo returned a bot check (HTTP 202) from this server, skipped", "BLOCKED"); }
  webState.status = "ok";
  const $ = cheerio.load(html); const out = [];
  const clean = (h) => { try { const u = new URL(h, "https://duckduckgo.com"); const real = u.searchParams.get("uddg"); return real ? decodeURIComponent(real) : u.href; } catch { return null; } };
  $(".result, tr").each((_, el) => {
    const a = $(el).find("a.result__a, a.result-link").first(); if (!a.length) return;
    const url = clean(a.attr("href")); if (!url || /duckduckgo\.com\/y\.js|bing\.com\/aclick/.test(url)) return;
    const snip = $(el).find(".result__snippet").text() || $(el).next("tr").find(".result-snippet").text();
    out.push({ source: "web", title: a.text().trim(), text: snip.replace(/\s+/g, " ").trim().slice(0, 300), handle: new URL(url).hostname.replace(/^www\./, ""), url, created: null, engagement: {} });
  });
  return out.slice(0, 12);
}

/* ---------------- Stack Overflow (Stack Exchange API, keyless) ---------------- */
export async function searchSO(q, { signal }) {
  const from = Math.floor((Date.now() - 90 * DAY) / 1000);
  const r = await apiJson(`https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=creation&q=${encodeURIComponent(q)}&site=stackoverflow&fromdate=${from}&pagesize=15&filter=withbody`, { signal });
  if (r.status === 429 || r.json?.error_id === 502) throw new FetchError("Stack Exchange throttled", "RATE_LIMITED", 429);
  if (!r.ok) throw new FetchError(`Stack Exchange HTTP ${r.status}`, "HTTP", r.status);
  const de = (s) => cheerio.load(`<p>${s || ""}</p>`).text();
  return (r.json.items || []).map((i) => ({ source: "so", title: de(i.title), text: de(i.body).replace(/\s+/g, " ").slice(0, 300), handle: `${de(i.owner?.display_name)} · [${(i.tags || []).slice(0, 3).join(", ")}]`, url: i.link, created: i.creation_date * 1000, engagement: { score: i.score, comments: i.answer_count } }));
}

/* ---------------- dev.to (free API) ---------------- */
export async function searchDevto(tag, { signal }) {
  const t = tag.toLowerCase().replace(/[^a-z0-9]/g, ""); if (!t) return [];
  const r = await apiJson(`https://dev.to/api/articles?tag=${t}&top=30&per_page=15`, { signal });
  if (!r.ok || !Array.isArray(r.json)) throw new FetchError(`dev.to HTTP ${r.status}`, "HTTP", r.status);
  return r.json.map((a) => ({ source: "devto", title: a.title, text: (a.description || "").slice(0, 300), handle: `@${a.user?.username} · dev.to`, url: a.url, created: Date.parse(a.published_at), engagement: { score: a.public_reactions_count, comments: a.comments_count } }));
}

/* ---------------- strict local relevance ---------------- */
// BM25-weighted TF-IDF cosine between post profile and each item, plus distinct topic-phrase hits.
function tf(tokens, w = 1, m = new Map()) { for (const t of tokens) m.set(t, (m.get(t) || 0) + w); return m; }
export function postProfile(p) {
  const v = new Map();
  tf(toks(p.title), 3, v); p.headers.slice(0, 30).forEach((h) => tf(toks(h), 1.5, v)); tf(toks(p.description), 1, v);
  (p.topics || []).forEach((t) => tf(toks(t), 3, v)); tf(toks((p.bodyText || "").slice(0, 8000)), 0.15, v);
  return v;
}
export function cosineScorer(docs) {
  const N = docs.length + 1; const df = new Map();
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) || 0) + 1);
  const idf = (t) => Math.log(1 + (N - (df.get(t) || 0) + 0.5) / ((df.get(t) || 0) + 0.5));
  const bm = (m) => { const out = new Map(); for (const [t, f] of m) out.set(t, ((f * 2.2) / (f + 1.2)) * idf(t)); return out; };
  return (profileMap, itemTokens) => {
    const a = bm(profileMap), b = bm(tf(itemTokens));
    let dot = 0, na = 0, nb = 0; for (const [, x] of a) na += x * x; for (const [t, y] of b) { nb += y * y; if (a.has(t)) dot += a.get(t) * y; }
    return na && nb ? dot / Math.sqrt(na * nb) : 0;
  };
}
export function topicTerms(p, brands = []) {
  const bl = new Set(brands.map((b) => b.toLowerCase()));
  const phrases = (p.topics || []).map((t) => t.toLowerCase()).filter((t) => !bl.has(t));
  const words = [...new Set([...phrases.flatMap((t) => toks(t)), ...toks(p.title)].filter((w) => !bl.has(w) && w.length > 2 && !WEAK.has(w)))];
  return { phrases, words };
}
export function filterRelevant(p, items, { brands = [], ownHost = "", contextBrands = [], minSim = Number(process.env.MIN_SIMILARITY || 0.09), maxAgeDays = 90 } = {}) {
  const { phrases, words } = topicTerms(p, brands);
  const docs = items.map((it) => toks(`${it.title} ${it.title} ${it.text}`));
  const score = cosineScorer(docs); const prof = postProfile(p);
  const kept = []; const dropped = { generic: 0, noUrl: 0, stale: 0, offTopic: 0, lowSim: 0 };
  const postSet = new Set(toks(`${p.title} ${p.headers.slice(0, 12).join(" ")} ${p.description}`));
  const VAGUE = new Set(["rest", "go", "edge", "node", "api", "sdk", "app", "web", "cloud", "ai", "auth", "cli"]);
  const context = new Set([...[...postSet].filter((t) => TECH.has(t) || TECH.has(t.replace(/\.js$/, ""))), ...brands, ...contextBrands].map((x) => x.toLowerCase()).filter((x) => x.length > 2 && !VAGUE.has(x)));
  const titleSet = new Set(toks(p.title));
  items.forEach((it, i) => {
    const txt = `${it.title} ${it.text}`.toLowerCase();
    if (!it.url || !/^https?:\/\//.test(it.url)) return dropped.noUrl++;
    if (GENERIC.test(txt)) return dropped.generic++;
    if (it.created && Date.now() - it.created > maxAgeDays * DAY) return dropped.stale++;
    const set = new Set(docs[i]);
    try { if (ownHost && new URL(it.url).hostname.replace(/^www\./, "").endsWith(ownHost)) return dropped.offTopic++; } catch {}
    const tt = toks(it.title); if (tt.length && tt.filter((w) => titleSet.has(w)).length / Math.max(tt.length, titleSet.size) > 0.8) return dropped.offTopic++; // repost of this same post
    if (context.size && ![...context].some((cx) => set.has(cx) || new RegExp(`\\b${cx.replace(/[.+#]/g, "\\$&")}\\b`, "i").test(txt))) return dropped.offTopic++;
    const hits = new Set([...phrases.filter((ph) => ph.includes(" ") && txt.includes(ph)), ...words.filter((w) => set.has(w))]);
    if (hits.size < 2) return dropped.offTopic++;
    const sim = score(prof, docs[i]);
    if (sim < minSim) return dropped.lowSim++;
    kept.push({ ...it, sim: +sim.toFixed(3), hits: [...hits].slice(0, 6) });
  });
  return { kept: kept.sort((a, b) => b.sim - a.sim), dropped };
}
const FRICTION = /\b(error|bug|fail(s|ed|ing)?|broken|issue|crash|slow|timeout|leak|regression|cannot|can't|unable|not working|doesn't work|problem|stuck|exception|deprecated|oom|migrat\w+|limit(s|ation)?)\b/i;
export function socialSignal(kept) {
  const top = kept.slice(0, 8);
  const v = top.reduce((a, it) => { const age = it.created ? (Date.now() - it.created) / DAY : 30; const e = it.engagement || {}; const eng = Math.log10(2 + (e.score || 0) + (e.reactions || 0) + 2 * (e.comments || 0)); return a + it.sim * (FRICTION.test(`${it.title} ${it.text}`) ? 1 : 0.5) * (0.4 + Math.exp(-age / 30)) * eng; }, 0);
  return Math.min(100, Math.round(v * 80));
}

/* ---------------- competitors ---------------- */
const PARENT = new Set(["google", "amazon", "microsoft", "github", "vercel", "cloudflare", "heroku", "azure"]);
export const brandOf = (host) => { const hp = host.replace(/^www\./, "").split("."); const b = (hp.length > 1 ? hp[hp.length - 2] : hp[0]).toLowerCase(); return PARENT.has(b) && hp.length > 2 ? hp[0].toLowerCase() : b; };
const NOT_COMP = /(^|\.)(github\.com|reddit\.com|ycombinator\.com|stackoverflow\.com|medium\.com|dev\.to|youtube\.com|x\.com|twitter\.com|linkedin\.com|google\.com|wikipedia\.org|g2\.com|capterra\.com|producthunt\.com|alternativeto\.net|slashdot\.org|sourceforge\.net|npmjs\.com|amazon\.com|facebook\.com|substack\.com|hashnode\.dev|stackshare\.io|saasworthy\.com|trustradius\.com|gartner\.com|bsky\.app|imgur\.com|archive\.org|apple\.com|ibm\.com|githubusercontent\.com|t\.co|f-droid\.org|worldmetrics\.org|statista\.com|zippia\.com|gitnux\.org|similarweb\.com|crunchbase\.com|vercel\.app|netlify\.app|github\.io|pages\.dev|herokuapp\.com|onrender\.com|wordpress\.com|blogspot\.com|notion\.site)$/i;
export async function discoverCompetitors(origin, { signal, log, searchers }) {
  const host = new URL(origin).hostname.replace(/^www\./, ""); const brand = brandOf(host);
  const counts = new Map(); const seen = new Map(); let cur = 0;
  const bump = (h, w) => { h = h.toLowerCase().replace(/^www\./, ""); if (!h || h.endsWith(host) || h.includes(brand) || brandOf(h) === brand || NOT_COMP.test(h) || !/\.[a-z]{2,}$/.test(h)) return; counts.set(h, (counts.get(h) || 0) + w); if (!seen.has(h)) seen.set(h, new Set()); seen.get(h).add(cur); };
  const qs = [`${brand} alternatives`, `${brand} vs`, `${brand} alternative`];
  for (const [name, fn] of Object.entries(searchers)) {
    for (const q of qs.slice(0, name === "web" ? 2 : 1)) {
      try {
        const res = await fn(q, { signal, recent: false });
        for (const it of res) {
          cur++; const t = `${it.title} ${it.text}`;
          if (name === "web") try { bump(new URL(it.url).hostname, 0.5); } catch {}
          for (const m of t.matchAll(/\b((?:[a-z0-9-]+\.)+(?:com|io|dev|tech|app|co|net|org|sh|cloud|so|ai))\b/gi)) bump(m[1], 1);
          // "X vs Y" patterns -> resolve later only if they look like domains; plain names are kept as hints
          for (const m of t.matchAll(new RegExp(`${brand}\\s+(?:vs\\.?|versus|or)\\s+([A-Z][A-Za-z0-9]+)`, "gi"))) bump(`${m[1].toLowerCase()}.com`, 0.8);
          for (const m of t.matchAll(new RegExp(`([A-Z][A-Za-z0-9]+)\\s+(?:vs\\.?|versus)\\s+${brand}`, "gi"))) bump(`${m[1].toLowerCase()}.com`, 0.8);
        }
      } catch (e) { if (signal?.aborted) throw e; log?.(`   ⚠ competitor discovery via ${name}: ${e.message}`, "warn"); }
    }
  }
  // verify candidates: homepage must share product vocabulary with the user's homepage
  const homeToks = async (h) => { try { const { text } = await safeFetchText(`https://${h}/`, { signal, timeout: 6000, accept: "text/html" }); const m = text.match(/<title[^>]*>([^<]*)<\/title>/i); const d = text.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)/i); return new Set(toks(`${m?.[1] || ""} ${d?.[1] || ""}`)); } catch { return null; } };
  const mine = await homeToks(host);
  const cands = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  const ok = new Map();
  await Promise.all(cands.map(async ([h]) => { const t = await homeToks(h); if (!t) return; const shared = mine ? [...t].filter((w) => mine.has(w)).length : 1; if (shared >= 2 || (shared >= 1 && [...t].some((w) => TECH.has(w)))) ok.set(h, shared); }));
  const ranked = cands.filter(([h]) => ok.has(h));
  const strict = ranked.filter(([h, v]) => v >= 1.5 && (seen.get(h)?.size || 0) >= 2).map(([h]) => h);
  if (strict.length < 3) for (const [h, v] of ranked) if (strict.length < 3 && v >= 1 && !strict.includes(h)) strict.push(h); // relaxed fill when web search is blocked
  return strict.slice(0, 5);
}

// pick competitor URLs whose slug best matches the union of user topics
export function rankCompetitorUrls(urls, userTopicWords, cap) {
  const score = (u) => { const slug = toks(decodeURIComponent(new URL(u.loc).pathname).replace(/[\/_-]+/g, " ")); const s = new Set(slug); let h = 0; for (const w of userTopicWords) if (s.has(w)) h++; return h; };
  return urls.map((u) => ({ ...u, h: score(u) })).filter((u) => u.h >= 1).sort((a, b) => b.h - a.h || (Date.parse(b.lastmod) || 0) - (Date.parse(a.lastmod) || 0)).slice(0, cap);
}

// competitor-content signal for one post: competitor pages similar to the post and the headings they cover that the post lacks
export function competitorSignal(p, compPages, scorer) {
  const prof = postProfile(p); const body = (p.bodyText || "") + " " + p.headers.join(" ").toLowerCase();
  const matches = [];
  for (const c of compPages) {
    const sim = scorer(prof, c.tokens);
    if (sim < Number(process.env.MIN_COMP_SIMILARITY || 0.1)) continue;
    const missing = c.headers.map((h) => h.replace(/[\u200b\u00a0]/g, " ").trim()).filter((h) => !BOILER.test(h)).filter((h) => { const ht = toks(h).filter((w) => w.length > 2); if (ht.length < 2) return false; const cov = ht.filter((w) => body.includes(w)).length / ht.length; return cov < 0.5; });
    matches.push({ competitor: c.competitor, title: c.title, url: c.url, sim: +sim.toFixed(3), missing: missing.slice(0, 5), headerCount: c.headers.length });
  }
  matches.sort((a, b) => b.sim * (1 + b.missing.length) - a.sim * (1 + a.missing.length));
  const top = matches.slice(0, 4);
  const v = top.reduce((a, m) => a + m.sim * Math.min(1, m.missing.length / Math.max(3, m.headerCount * 0.5)), 0);
  return { signal: Math.min(100, Math.round(v * 400)), matches: top };
}

const BOILER = /^(subscribe|sign up|newsletter|related|share|table of contents|on this page|get started|start for free|try .* free|contact|footer|resources|more from|recent posts|latest|about the author|was this (page )?helpful|next steps?|conclusion|summary|what'?s next|faq|join|follow us)/i;

/* ---------------- extractive narrative ---------------- */
export const LBL = { reddit: "Reddit", github: "GitHub", hn: "Hacker News", x: "X", web: "Web", so: "Stack Overflow", devto: "dev.to" };
const rel = (t) => { if (!t) return "recent"; const h = Math.round((Date.now() - t) / 3600000); return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`; };
const short = (s, n = 140) => { s = String(s || "").replace(/\s+/g, " ").trim(); return s.length > n ? `${s.slice(0, n - 1).replace(/\s\S*$/, "")}…` : s; };
export function extractiveNarrative(p, social, comp) {
  const items = social.slice(0, 3); const cm = comp.matches.filter((m) => m.missing.length).slice(0, 3);
  if (!items.length && !cm.length) return { status: "no_gap", reason: "No active gap. No competitor page covers this topic more deeply, and no on-topic discussion from the last 90 days survived the relevance filters.", markdown: "" };
  const parts = [];
  if (cm.length) parts.push(`Competitors cover angles this post lacks: ${cm.map((m) => `${m.competitor} ("${short(m.title, 70)}") covers ${m.missing.slice(0, 2).map((h) => `"${short(h, 50)}"`).join(" and ")}`).join("; ")}.`);
  if (items.length) parts.push(`Live discussion: ${items.map((it) => `"${short(it.title, 80)}" (${LBL[it.source]}, ${rel(it.created)})`).join("; ")}.`);
  const topic = (p.topics || [])[0] || p.title;
  let md = `## ${cm.length ? `What else to know about ${topic}` : `Common questions about ${topic} right now`}\n\n> Draft assembled from the cited pages and threads only. Review before publishing.\n\n`;
  if (cm.length) md += `Other guides on this topic also cover ${[...new Set(cm.flatMap((m) => m.missing.slice(0, 2)))].slice(0, 4).map((h) => `**${short(h, 60)}**`).join(", ")} (see ${cm.map((m) => `[${m.competitor}](${m.url})`).join(", ")}). Adding a short section on these keeps this post complete for readers comparing options.\n\n`;
  if (items.length) md += `Developers are currently asking about:\n\n${items.map((it) => `- [${short(it.title, 110)}](${it.url}) (${LBL[it.source]}, ${rel(it.created)})${it.text && it.text !== it.title ? `: "${short(it.text, 140)}"` : ""}`).join("\n")}\n\nAddressing these directly, with the current status and any workaround stated in the linked threads, answers the questions readers bring to this post.\n`;
  return { status: "gap", reason: parts.join(" "), markdown: md.trim() };
}

/* ---------------- corpus-aware keyphrases (TF-IDF over the scanned posts) ---------------- */
const WEAK = new Set("give run check operate confidence inside project public private beta alpha set started started fix local time open hosted team rerun investigations unified package version weekend millions automate connect actions agents agent ai real-time sync data app apps server tool tools work works working help start started available now finally announce release released releases generally ga preview easy easily fast quick quickly powerful modern production ready own let lets want wanted like look looking take taking keep kept go going come allow allows enable enables based across without within between today yesterday new year years month months team teams user users customer customers company companies product products platform".split(" "));
export function keyphrases(posts, brands = []) {
  const bl = new Set(brands); const ok = (t) => t.length > 2 && !bl.has(t) && !WEAK.has(t);
  const docs = posts.map((p) => {
    const m = new Map(); const add = (t, w) => m.set(t, (m.get(t) || 0) + w);
    const seg = (s, w) => { const t = toks(s); t.forEach((x) => ok(x) && add(x, w)); for (let i = 0; i < t.length - 1; i++) if (ok(t[i]) && ok(t[i + 1])) add(`${t[i]} ${t[i + 1]}`, w * 1.3); };
    seg(p.title, 4); p.headers.slice(0, 30).forEach((h) => seg(h, 1.5)); seg(p.description, 1.5);
    const body = (p.bodyText || "").slice(0, 20000); seg(body, 0.08);
    return m;
  });
  const df = new Map(); docs.forEach((m) => { for (const t of m.keys()) df.set(t, (df.get(t) || 0) + 1); });
  const N = docs.length;
  return docs.map((m) => {
    const ranked = [...m.entries()].filter(([t, v]) => v >= 1.2).map(([t, v]) => [t, v * Math.log(1 + N / (df.get(t) || 1)) * (t.includes(" ") ? 1.4 : 1)]).sort((a, b) => b[1] - a[1]).map(([t]) => t);
    const out = []; for (const t of ranked) { if (out.some((x) => x.includes(t) || t.includes(x))) continue; out.push(t); if (out.length >= 6) break; }
    return out;
  });
}
