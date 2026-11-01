import * as cheerio from "cheerio";
import { safeFetchText, apiJson, FetchError } from "./net.js";

const XAI_URL = "https://api.x.ai/v1/chat/completions";
export const cfg = () => ({
  xai: !!process.env.XAI_API_KEY,
  xaiModel: process.env.XAI_MODEL || "grok-4-fast-non-reasoning",
  github: !!process.env.GITHUB_TOKEN,
  x: !!process.env.X_BEARER_TOKEN,
});

const CONTENT_RE = /\/(blog|posts?|guides?|articles?|tutorials?|learn|resources|insights|news|engineering|stories|changelog|docs\/guides)\//i;
const SKIP_RE = /\/(tag|tags|category|categories|author|authors|page)\/|\.(png|jpe?g|gif|svg|pdf|zip|webp|mp4)$/i;
const MAX_POSTS = Number(process.env.MAX_POSTS || 15);

/* ---------------------------- 1. Sitemap ---------------------------- */
function parseSitemap(xml) {
  const $ = cheerio.load(xml, { xmlMode: true });
  const sitemaps = $("sitemapindex > sitemap").map((_, el) => ({ loc: $(el).find("loc").first().text().trim(), lastmod: $(el).find("lastmod").first().text().trim() })).get();
  const urls = $("urlset > url").map((_, el) => ({ loc: $(el).find("loc").first().text().trim(), lastmod: $(el).find("lastmod").first().text().trim() })).get();
  return { sitemaps: sitemaps.filter((s) => s.loc), urls: urls.filter((u) => u.loc) };
}

export async function discoverUrls(input, { signal, log, maxPosts }) {
  const start = new URL(input);
  const origin = start.origin;
  const candidates = [];
  if (/\.xml(\.gz)?$|sitemap/i.test(start.pathname)) candidates.push(start.href);
  try {
    const { text } = await safeFetchText(`${origin}/robots.txt`, { signal, timeout: 8000 });
    for (const m of text.matchAll(/^\s*sitemap:\s*(\S+)/gim)) candidates.push(m[1]);
  } catch (e) { if (e.code === "SSRF_BLOCKED" || e.code === "BAD_URL") throw e; }
  candidates.push(`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`, `${origin}/blog/sitemap.xml`);
  const queue = [...new Set(candidates)];
  const seen = new Set(); const all = new Map(); let fetched = 0; let blocked = 0;
  while (queue.length && fetched < 40) {
    const sm = queue.shift();
    if (seen.has(sm)) continue; seen.add(sm);
    try {
      const { text } = await safeFetchText(sm, { signal, timeout: 12000, accept: "application/xml,text/xml,*/*" });
      if (!/<(urlset|sitemapindex)/i.test(text)) continue;
      fetched++;
      const { sitemaps, urls } = parseSitemap(text);
      // prioritise child sitemaps that look like blog/post sitemaps
      sitemaps.sort((a, b) => (/(blog|post|article|guide)/i.test(b.loc) ? 1 : 0) - (/(blog|post|article|guide)/i.test(a.loc) ? 1 : 0));
      for (const s of sitemaps) if (!seen.has(s.loc)) queue.splice(/(blog|post|article|guide)/i.test(s.loc) ? 0 : queue.length, 0, s.loc);
      for (const u of urls) all.set(u.loc, u);
      log(`   ↳ ${sm} → ${urls.length} URLs${sitemaps.length ? `, ${sitemaps.length} child sitemaps` : ""}`, "muted");
      if (all.size > 20000) break;
    } catch (e) {
      if (e.code === "ABORTED") throw e;
      if (e.code === "BLOCKED" || e.code === "RATE_LIMITED") blocked++;
    }
  }
  if (!all.size) throw new FetchError(blocked ? "The site blocked our sitemap requests (HTTP 403/429)." : "No XML sitemap found (checked robots.txt, /sitemap.xml, /sitemap_index.xml).", blocked ? "BLOCKED" : "NO_SITEMAP");
  const list = [...all.values()].filter((u) => { try { return new URL(u.loc).protocol.startsWith("http") && !SKIP_RE.test(u.loc); } catch { return false; } });
  let content = list.filter((u) => CONTENT_RE.test(new URL(u.loc).pathname) && new URL(u.loc).pathname.split("/").filter(Boolean).length >= 2);
  const fallback = !content.length;
  if (fallback) content = list;
  content.sort((a, b) => (Date.parse(b.lastmod) || 0) - (Date.parse(a.lastmod) || 0));
  return { total: all.size, contentCount: content.length, fallback, picked: content.slice(0, maxPosts ?? MAX_POSTS), content: content.slice(0, 5000) };
}

/* ---------------------------- 2. Scrape ---------------------------- */
export async function scrapePost(u, { signal }) {
  const { text, finalUrl, contentType } = await safeFetchText(u.loc, { signal, timeout: 15000, accept: "text/html,*/*" });
  if (!/html/i.test(contentType) && !/<html/i.test(text.slice(0, 2000))) throw new FetchError("Not HTML", "NOT_HTML");
  const $ = cheerio.load(text);
  $("script,style,noscript,svg,nav,footer,header,aside,form").remove();
  const meta = (n) => $(`meta[name="${n}"],meta[property="${n}"]`).attr("content")?.trim();
  const rawTitle = (meta("og:title") || $("h1").first().text() || $("title").text() || u.loc).replace(/\s+/g, " ").trim();
  const title = rawTitle.replace(/\s+[|\-–—]\s+[^|\-–—]{2,40}$/, "").replace(/\s+[|\-–—]\s+[^|\-–—]{2,40}$/, "").trim() || rawTitle;
  $("h2 a.anchor, h3 a.anchor, h2 button, h3 button, [aria-label*='link' i], .sr-only").remove();
  const headers = [...new Set($("h2,h3").map((_, el) => $(el).text().replace(/\s+/g, " ").replace(/(copy link|link to (this )?heading|permalink|#)\s*$/i, "").trim()).get().filter((h) => h && h.length < 140))].slice(0, 40);
  const root = $("article").length ? $("article").first() : $("main").length ? $("main").first() : $("body");
  const body = root.text().replace(/\s+/g, " ").trim();
  const published = meta("article:published_time") || $("time[datetime]").first().attr("datetime") || meta("date") || null;
  const modified = meta("article:modified_time") || meta("og:updated_time") || u.lastmod || null;
  return {
    url: finalUrl, path: new URL(finalUrl).pathname, title: title.slice(0, 200),
    description: (meta("description") || meta("og:description") || "").slice(0, 400),
    headers, published, modified, date: modified || published,
    excerpt: body.slice(0, 600), bodyText: body.slice(0, 60000).toLowerCase(),
  };
}

/* ---------------------------- 3. Topics ---------------------------- */
const STOP = new Set(("a an the and or but if then else for to of in on at by with from as is are was were be been being this that these those it its your you we our us they their them how what why when where which who whom will can could should would may might must do does did done not no yes vs via into over under about more most less least very just than so such also using use used guide complete ultimate introduction intro part new best tips top way ways get getting make making build building learn learning step steps everything need know first now here there all any each every other some own same out up down one two three blog post posts article read announcing announcement today launch week day update updates feature features copy link heading permalink anchor section click here docs pages page knowledge base changelog mastering moving scale scaling deep dive faster easier ease simple simplifying better great now supports support introducing")
  .split(/\s+/));
export const TECH = new Set("postgres postgresql pgbouncer supavisor rls sql nosql redis kafka graphql rest grpc websocket websockets react nextjs next.js vue svelte nuxt remix astro vite webpack turbopack node nodejs deno bun typescript javascript python rust go golang java kotlin swift docker kubernetes k8s terraform aws gcp azure vercel netlify cloudflare edge serverless lambda middleware auth oauth jwt sso saml api sdk cli llm ai rag embeddings vector pgvector openai cache caching cdn ssr isr ssg hydration migration migrations indexes index replication sharding pooling connection realtime storage s3 webhooks cron queue queues postgis prisma drizzle supabase firebase mongodb mysql sqlite clickhouse duckdb tailwind css html wasm ci cd github actions oidc".split(" "));

function tokens(s) { return (s.toLowerCase().match(/[a-z0-9][a-z0-9.+#-]*[a-z0-9+#]|[a-z0-9]/g) || []).filter((t) => t.length > 1 && !STOP.has(t) && !/^[\d.]+$/.test(t) && !/^v?\d+(\.\d+)*$/.test(t)); }

export function heuristicTopics(p, brand = "") {
  const score = new Map();
  const add = (t, w) => score.set(t, (score.get(t) || 0) + w);
  const tt = tokens(p.title); tt.forEach((t) => add(t, 3));
  for (let i = 0; i < tt.length - 1; i++) add(`${tt[i]} ${tt[i + 1]}`, 2.5);
  p.headers.forEach((h) => tokens(h).forEach((t) => add(t, 1)));
  tokens(p.description).forEach((t) => add(t, 0.8));
  for (const [t] of score) if (brand && t.split(" ").includes(brand)) score.delete(t);
  for (const [t, v] of score) { const parts = t.split(" "); if (parts.some((x) => TECH.has(x))) score.set(t, v * 2.2); }
  const ranked = [...score.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t);
  const topics = [];
  for (const t of ranked) { if (topics.some((x) => x.includes(t) || t.includes(x))) continue; topics.push(t); if (topics.length >= 6) break; }
  const tech = topics.filter((t) => t.split(" ").some((x) => TECH.has(x)));
  const base = tech.length ? tech : topics;
  const techN = (t) => t.split(" ").filter((x) => TECH.has(x)).length;
  const bigram = ranked.filter((t) => t.includes(" ") && techN(t) > 0).sort((a, b) => techN(b) - techN(a))[0];
  const q1 = bigram || [base[0], topics.find((t) => t !== base[0])].filter(Boolean).join(" ");
  const q2 = brand && base[0] ? `${brand} ${base[0].split(" ")[0]}` : base[1];
  const queries = [...new Set([q1, q2].filter(Boolean))].slice(0, 2);
  return { topics: topics.map(titleCase), queries };
}
const titleCase = (s) => s.replace(/\b\w/g, (c) => c.toUpperCase());

async function grok(messages, { signal, json = true, maxTokens = 900 }) {
  const r = await apiJson(XAI_URL, {
    signal, method: "POST", timeout: 45000,
    headers: { authorization: `Bearer ${process.env.XAI_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ model: cfg().xaiModel, messages, temperature: 0.2, max_tokens: maxTokens, ...(json ? { response_format: { type: "json_object" } } : {}) }),
  });
  if (!r.ok) throw new Error(`xAI HTTP ${r.status}: ${r.text.slice(0, 160)}`);
  const c = r.json?.choices?.[0]?.message?.content || "";
  return json ? JSON.parse(c.replace(/^```json|```$/g, "")) : c;
}

export async function grokTopics(p, { signal }) {
  const out = await grok([
    { role: "system", content: "You extract core technical topics from developer blog posts. Reply with JSON only: {\"topics\": [3-6 short technical topics], \"queries\": [2 short search queries (2-4 words) a developer would type when hitting problems with these topics]}" },
    { role: "user", content: `Title: ${p.title}\nDescription: ${p.description}\nHeaders: ${p.headers.slice(0, 25).join(" | ")}\nExcerpt: ${p.excerpt}` },
  ], { signal, maxTokens: 300 });
  const topics = (out.topics || []).map(String).slice(0, 6); const queries = (out.queries || []).map(String).slice(0, 2);
  if (!topics.length || !queries.length) throw new Error("empty Grok topics");
  return { topics, queries };
}

/* ---------------------------- 4. Sources ---------------------------- */
const DAY = 86400000;
export const sourceState = { github: { remaining: null, reset: 0 }, x: { status: null, until: 0 } };

export async function searchReddit(q, { signal }) {
  const r = await apiJson(`https://www.reddit.com/search.json?q=${encodeURIComponent(q)}&sort=new&t=month&limit=15&raw_json=1`, { signal });
  if (r.status === 429) throw new FetchError("Reddit rate limited", "RATE_LIMITED", 429);
  if (r.status === 403) return searchRedditRss(q, { signal });
  if (!r.ok || !r.json) throw new FetchError(`Reddit HTTP ${r.status}`, "HTTP", r.status);
  return (r.json.data?.children || []).map(({ data: d }) => ({
    source: "reddit", title: d.title, text: (d.selftext || "").slice(0, 280), handle: `u/${d.author} · r/${d.subreddit}`,
    url: `https://www.reddit.com${d.permalink}`, created: d.created_utc * 1000, engagement: { score: d.score, comments: d.num_comments },
  }));
}

async function searchRedditRss(q, { signal }) {
  const r = await apiJson(`https://www.reddit.com/search.rss?q=${encodeURIComponent(q)}&sort=new&t=month&limit=15`, { signal, headers: { accept: "application/atom+xml" } });
  if (r.status === 429) throw new FetchError("Reddit rate limited", "RATE_LIMITED", 429);
  if (!r.ok) throw new FetchError(`Reddit blocked this server (HTTP ${r.status})`, "BLOCKED", r.status);
  const $ = cheerio.load(r.text, { xmlMode: true });
  return $("entry").map((_, el) => {
    const e = $(el); const html = e.find("content").text();
    const text = cheerio.load(html).text().replace(/submitted by.*$/s, "").replace(/\s+/g, " ").trim();
    return { source: "reddit", title: e.find("title").text(), text: text.slice(0, 280), handle: `${e.find("author > name").text()} · ${e.find("category").attr("label") || "reddit"}`,
      url: e.find("link").attr("href"), created: Date.parse(e.find("published").text() || e.find("updated").text()), engagement: {} };
  }).get().filter((x) => x.url && Date.now() - x.created < 31 * DAY);
}

export async function searchGitHub(q, { signal }) {
  const st = sourceState.github;
  if (st.remaining === 0 && st.reset - Date.now() < 30000 && st.reset > Date.now()) await new Promise((r) => setTimeout(r, st.reset - Date.now() + 500));
  if (st.remaining === 0 && Date.now() < st.reset) throw new FetchError(`GitHub search rate limit reached; resets in ${Math.ceil((st.reset - Date.now()) / 1000)}s`, "RATE_LIMITED", 403);
  const since = new Date(Date.now() - 30 * DAY).toISOString().slice(0, 10);
  const headers = { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const r = await apiJson(`https://api.github.com/search/issues?q=${encodeURIComponent(`${q} is:issue created:>${since}`)}&sort=created&order=desc&per_page=15`, { signal, headers });
  st.remaining = Number(r.headers.get("x-ratelimit-remaining") ?? st.remaining);
  st.reset = Number(r.headers.get("x-ratelimit-reset") || 0) * 1000;
  if (r.status === 403 || r.status === 429) throw new FetchError("GitHub rate limited", "RATE_LIMITED", r.status);
  if (!r.ok) throw new FetchError(`GitHub HTTP ${r.status}`, "HTTP", r.status);
  return (r.json.items || []).map((i) => ({
    source: "github", title: i.title, text: (i.body || "").replace(/\s+/g, " ").slice(0, 280),
    handle: `@${i.user?.login} · ${i.repository_url?.split("/repos/")[1] || "github"}`, url: i.html_url, created: Date.parse(i.created_at),
    engagement: { reactions: i.reactions?.total_count || 0, comments: i.comments },
  }));
}

export async function searchHN(q, { signal }) {
  const since = Math.floor((Date.now() - 30 * DAY) / 1000);
  const r = await apiJson(`https://hn.algolia.com/api/v1/search_by_date?query=${encodeURIComponent(q)}&tags=(story,comment)&numericFilters=created_at_i>${since}&hitsPerPage=15`, { signal });
  if (!r.ok) throw new FetchError(`HN HTTP ${r.status}`, r.status === 429 ? "RATE_LIMITED" : "HTTP", r.status);
  return (r.json.hits || []).map((h) => {
    const txt = (h.comment_text || h.story_text || "").replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
    return {
      source: "hn", title: h.title || h.story_title || txt.slice(0, 100), text: txt.slice(0, 280), handle: `${h.author} · Hacker News`,
      url: `https://news.ycombinator.com/item?id=${h.objectID}`, created: h.created_at_i * 1000, engagement: { score: h.points || 0, comments: h.num_comments || 0 },
    };
  });
}

export async function searchX(q, { signal }) {
  const xs = sourceState.x;
  if (xs.status && Date.now() < xs.until) throw new FetchError(xs.status === "credits" ? "connected but API credits depleted, skipped" : "rate limited, skipped", xs.status === "credits" ? "CREDITS" : "RATE_LIMITED");
  const r = await apiJson(`https://api.x.com/2/tweets/search/recent?query=${encodeURIComponent(`${q} (error OR bug OR issue OR leak OR timeout OR broken OR "how do" OR slow) -is:retweet -is:reply lang:en`)}&max_results=10&tweet.fields=created_at,public_metrics,author_id&expansions=author_id&user.fields=username`, { signal, headers: { authorization: `Bearer ${process.env.X_BEARER_TOKEN}` } });
  if (r.status === 402) { xs.status = "credits"; xs.until = Date.now() + 10 * 60000; throw new FetchError("connected but API credits depleted, skipped", "CREDITS", 402); }
  if (r.status === 429) { xs.status = "rate"; xs.until = Number(r.headers.get("x-rate-limit-reset") || 0) * 1000 || Date.now() + 15 * 60000; throw new FetchError("rate limited, skipped", "RATE_LIMITED", 429); }
  xs.status = r.ok ? "ok" : xs.status;
  if (!r.ok) throw new FetchError(`X HTTP ${r.status}`, r.status === 401 || r.status === 403 ? "BLOCKED" : "HTTP", r.status);
  const users = Object.fromEntries((r.json.includes?.users || []).map((u) => [u.id, u.username]));
  const seen = new Set();
  const norm = (t) => t.toLowerCase().replace(/https?:\/\/\S+/g, "").replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim().slice(0, 80);
  const mathBold = (t) => ([...t].filter((c) => { const cp = c.codePointAt(0); return cp >= 0x1d400 && cp <= 0x1d7ff; }).length / Math.max(1, [...t].length));
  return (r.json.data || []).filter((t) => {
    if (mathBold(t.text) > 0.05) return false;
    const k = norm(t.text); if (!k || seen.has(k)) return false; seen.add(k); return true;
  }).map((t) => ({
    source: "x", title: t.text.slice(0, 120), text: t.text.slice(0, 280), handle: `@${users[t.author_id] || t.author_id}`,
    url: `https://x.com/${users[t.author_id] || "i"}/status/${t.id}`, created: Date.parse(t.created_at),
    engagement: { score: t.public_metrics?.like_count || 0, comments: t.public_metrics?.reply_count || 0, reposts: t.public_metrics?.retweet_count || 0 },
  }));
}

/* ---------------------------- 5. Scoring ---------------------------- */
const FRICTION = /\b(error|errors|bug|bugs|fail|fails|failing|failed|broken|breaks|issue|crash|crashes|slow|timeout|timeouts|leak|leaks|regression|cannot|can't|unable|not working|doesn't work|help|problem|stuck|exception|deprecated|warning|oom|500|404)\b/i;

export function scorePost(post, items, brand = "") {
  const now = Date.now();
  const postTokens = new Set(tokens(`${post.title} ${post.headers.join(" ")} ${post.bodyText.slice(0, 30000)}`));
  const topicTokens = new Set(post.topics.flatMap((t) => tokens(t)).filter((t) => t !== brand && t.length > 2 || TECH.has(t)));
  const scored = items.map((it) => {
    const words = [...new Set(tokens(`${it.title} ${it.text}`))].filter((w) => w.length > 2);
    const onTopic = words.filter((w) => topicTokens.has(w)).length;
    const hasBrand = brand ? words.includes(brand) : false;
    const novel = words.filter((w) => !postTokens.has(w));
    const uncovered = words.length ? novel.length / words.length : 0;
    const ageDays = Math.max(0, (now - it.created) / DAY);
    const recency = Math.exp(-ageDays / 12);
    const e = it.engagement || {};
    const eng = Math.log10(1 + (e.score || 0) + (e.reactions || 0) + 2 * (e.comments || 0) + (e.reposts || 0));
    const friction = FRICTION.test(`${it.title} ${it.text}`) ? 1 : 0.45;
    const relevance = Math.min(1, 0.35 + onTopic * 0.3);
    const pressure = relevance * friction * (0.4 + uncovered) * (0.35 + recency) * (0.6 + eng / 2);
    return { ...it, onTopic, hasBrand, pressure, uncovered, novelTerms: novel.slice(0, 6) };
  }).filter((it) => it.onTopic >= 2 || (it.onTopic >= 1 && brand && it.hasBrand)).sort((a, b) => b.pressure - a.pressure);
  const top = scored.slice(0, 8);
  const pressureSum = top.reduce((a, b) => a + b.pressure, 0);
  const postAgeDays = post.date && Date.parse(post.date) ? (now - Date.parse(post.date)) / DAY : 365;
  const agePenalty = Math.min(15, Math.max(0, postAgeDays - 90) / 30);
  const score = Math.max(5, Math.min(98, Math.round(100 - 9 * pressureSum - agePenalty)));
  const severity = score < 45 ? "critical" : score < 60 ? "high" : score < 75 ? "medium" : "low";
  return { score, severity, top, postAgeDays: Math.round(postAgeDays) };
}

/* ---------------------------- 6. Narrative ---------------------------- */
const SRC_LABEL = { reddit: "Reddit", github: "GitHub", hn: "Hacker News", x: "X", web: "Web", so: "Stack Overflow", devto: "dev.to" };
const rel = (t) => { const h = Math.round((Date.now() - t) / 3600000); return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`; };

export function templateNarrative(post, s) {
  const top = s.top.slice(0, 3);
  if (!top.length) return {
    reason: "[Template] No recent discussions matching this post's topics were found in the last 30 days on the connected sources, so there is no measurable intent gap right now.",
    markdown: "", aiWritten: false,
  };
  const terms = [...new Set(top.flatMap((t) => t.novelTerms))].slice(0, 6);
  const srcs = [...new Set(top.map((t) => SRC_LABEL[t.source]))].join(", ");
  const reason = `[Template] ${top.length} recent ${srcs} discussion${top.length > 1 ? "s" : ""} on "${post.topics.slice(0, 2).join(", ")}" raise points this post doesn't cover in its headers or body${terms.length ? ` (uncovered terms: ${terms.join(", ")})` : ""}. Most pressing: "${top[0].title}" (${SRC_LABEL[top[0].source]}, ${rel(top[0].created)}). The post was last updated ${s.postAgeDays} days ago.`;
  const md = `## What developers are asking about ${post.topics[0] || "this topic"} right now

> Template draft generated from live discussions. Review and rewrite before publishing.

Recent threads show readers running into questions this guide doesn't yet answer:

${top.map((t) => `- **${t.title.replace(/\n/g, " ").slice(0, 140)}** ([${SRC_LABEL[t.source]}](${t.url}), ${rel(t.created)})`).join("\n")}

If you're hitting one of these, start by checking ${terms.length ? terms.slice(0, 3).map((x) => `\`${x}\``).join(", ") : "the linked threads"} against your setup, and follow the linked discussions for the current status and workarounds reported by the community.`;
  return { reason, markdown: md, aiWritten: false };
}

export async function grokNarrative(post, s, { signal }) {
  const top = s.top.slice(0, 5);
  if (!top.length) return templateNarrative(post, s);
  const evidence = top.map((t, i) => `[${i + 1}] ${SRC_LABEL[t.source]} | ${rel(t.created)} | ${t.url}\nTitle: ${t.title}\nSnippet: ${t.text}`).join("\n\n");
  const out = await grok([
    { role: "system", content: "You are a technical content strategist. Using ONLY the evidence provided, explain what recent developer friction the blog post fails to address, and write a Markdown section to add to the post. Do not invent facts, versions, numbers or fixes that are not in the evidence; if a fix isn't stated, point readers to the linked thread. Reply as JSON: {\"reason\": \"2-3 sentences\", \"markdown\": \"## H2 heading followed by 2-3 short paragraphs; you may cite sources as Markdown links\"}" },
    { role: "user", content: `Post title: ${post.title}\nPost headers: ${post.headers.slice(0, 25).join(" | ")}\nPost last updated: ${post.date || "unknown"}\nTopics: ${post.topics.join(", ")}\n\nEvidence:\n${evidence}` },
  ], { signal, maxTokens: 900 });
  if (!out.reason || !out.markdown) throw new Error("empty Grok narrative");
  return { reason: String(out.reason), markdown: String(out.markdown), aiWritten: true };
}
