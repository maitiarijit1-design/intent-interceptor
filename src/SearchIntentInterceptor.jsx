import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Radar, FileSearch, AlertTriangle, Gauge, Play, Loader2, Terminal, CheckCircle2, Circle, ChevronDown, Copy, Check,
  Search, GitBranch, MessageSquare, AtSign, Settings, LayoutGrid, Workflow, Tag, Quote, Lightbulb, Clock, ExternalLink,
  ArrowUpDown, Sparkles, Flame, Square, KeyRound, Wifi, XCircle, Globe, HelpCircle, Newspaper, Swords,
} from "lucide-react";
import SeoPanel, { saveRankHistory } from "./SeoPanel.jsx";
import { TrendingUp } from "lucide-react";

const PIPELINE_STEPS = [
  { id: 1, label: "Sitemap ingestion" }, { id: 2, label: "Content scraping" }, { id: 3, label: "Topic extraction" },
  { id: 4, label: "Live intent tracing" }, { id: 5, label: "Gap scoring" },
];
const SEVERITY = {
  critical: { label: "Critical", cls: "bg-rose-500/15 text-rose-300 ring-rose-500/30", rank: 4 },
  high: { label: "High", cls: "bg-amber-500/15 text-amber-300 ring-amber-500/30", rank: 3 },
  medium: { label: "Medium", cls: "bg-indigo-500/15 text-indigo-300 ring-indigo-500/30", rank: 2 },
  low: { label: "Minor gap", cls: "bg-sky-500/15 text-sky-300 ring-sky-500/30", rank: 1 },
  none: { label: "No active gap", cls: "bg-emerald-500/15 text-emerald-300 ring-emerald-500/30", rank: 0 },
};
const SOURCE = {
  x: { label: "X", Icon: AtSign, cls: "bg-zinc-100/10 text-zinc-200 ring-zinc-400/30" },
  reddit: { label: "Reddit", Icon: MessageSquare, cls: "bg-orange-500/15 text-orange-300 ring-orange-500/30" },
  github: { label: "GitHub", Icon: GitBranch, cls: "bg-violet-500/15 text-violet-300 ring-violet-500/30" },
  hn: { label: "Hacker News", Icon: Flame, cls: "bg-amber-500/15 text-amber-300 ring-amber-500/30" },
  web: { label: "Web", Icon: Globe, cls: "bg-sky-500/15 text-sky-300 ring-sky-500/30" },
  so: { label: "Stack Overflow", Icon: HelpCircle, cls: "bg-yellow-500/15 text-yellow-300 ring-yellow-500/30" },
  devto: { label: "dev.to", Icon: Newspaper, cls: "bg-zinc-100/10 text-zinc-200 ring-zinc-400/30" },
};
const BADGE_ONLY = { competitor: { label: "Competitor", Icon: Swords, cls: "bg-fuchsia-500/15 text-fuchsia-300 ring-fuchsia-500/30" } };
const ERRORS = {
  NO_SITEMAP: "No sitemap found", BLOCKED: "Site blocked the scraper", RATE_LIMITED: "Rate limited", BAD_URL: "Invalid URL",
  SSRF_BLOCKED: "Address not allowed", BUSY: "Server busy", CANCELLED: "Scan cancelled", SCRAPE_FAILED: "Scrape failed", NETWORK: "Connection lost",
};
const focusRing = "focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950";
const scoreColor = (s) => (s >= 70 ? "bg-emerald-400" : s >= 50 ? "bg-amber-400" : "bg-rose-400");
const scoreText = (s) => (s >= 70 ? "text-emerald-300" : s >= 50 ? "text-amber-300" : "text-rose-300");
const ts = () => new Date().toLocaleTimeString([], { hour12: false });
const fmtDate = (d) => { const t = Date.parse(d); return Number.isNaN(t) ? d : new Date(t).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }); };
function relTime(t) {
  const m = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (m < 60) return `${m}m ago`; const h = Math.round(m / 60); if (h < 48) return `${h}h ago`; return `${Math.round(h / 24)}d ago`;
}
function engText(e = {}) {
  const p = [];
  if (e.score) p.push(`${e.score} pts`); if (e.reactions) p.push(`${e.reactions} reactions`); if (e.comments) p.push(`${e.comments} comments`); if (e.reposts) p.push(`${e.reposts} reposts`);
  return p.join(" · ");
}

function SourceBadge({ source }) {
  const s = SOURCE[source] || BADGE_ONLY[source] || SOURCE.web;
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ${s.cls}`}>
      <s.Icon className="h-3 w-3" aria-hidden="true" /> {s.label}
    </span>
  );
}

function MetricCard({ icon: Icon, label, value, hint, accent }) {
  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5">
      <div className="flex items-center justify-between">
        <p className="text-sm text-zinc-400">{label}</p>
        <span className={`rounded-xl p-2 ${accent}`}><Icon className="h-4 w-4" aria-hidden="true" /></span>
      </div>
      <p className="mt-3 text-3xl font-semibold tracking-tight text-zinc-50 tabular-nums">{value}</p>
      <p className="mt-1 text-xs text-zinc-500">{hint}</p>
    </div>
  );
}

function CopyButton({ text }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); } catch { /* noop */ }
      document.body.removeChild(ta);
    }
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 2000);
  };
  return (
    <button type="button" onClick={copy} aria-live="polite"
      className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition ${focusRing} ${
        copied ? "bg-emerald-500/20 text-emerald-300" : "bg-indigo-500 text-white hover:bg-indigo-400"}`}>
      {copied ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : <Copy className="h-3.5 w-3.5" aria-hidden="true" />}
      {copied ? "Copied!" : "Copy Markdown"}
    </button>
  );
}

/* ---------------------------- Gap row ---------------------------- */
function GapRow({ blog, open, onToggle, domain }) {
  const sev = SEVERITY[blog.severity] || SEVERITY.low;
  const panelId = `panel-${blog.id}`;
  return (
    <li className={`rounded-2xl border transition-colors ${open ? "border-indigo-500/40 bg-zinc-900" : "border-zinc-800 bg-zinc-900/50 hover:border-zinc-700"}`}>
      <button type="button" onClick={onToggle} aria-expanded={open} aria-controls={panelId}
        className={`flex w-full flex-col gap-4 rounded-2xl p-4 text-left sm:p-5 md:flex-row md:items-center ${focusRing}`}>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ${sev.cls}`}>{sev.label}</span>
            {blog.sources.map((s) => <SourceBadge key={s} source={s} />)}
            {!blog.aiWritten && <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-[11px] text-zinc-400">heuristic</span>}
          </div>
          <h3 className="mt-2 text-base font-semibold text-zinc-100">{blog.title}</h3>
          <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-500">
            <span className="break-all">{blog.path}</span>
            <span className="inline-flex items-center gap-1"><Clock className="h-3 w-3" aria-hidden="true" />{blog.updated ? `Updated ${fmtDate(blog.updated)}` : "No date found"}</span>
            <span>{blog.harvested} harvested → {blog.keptCount ?? blog.intents.length} relevant</span>
            {blog.compScore != null && <span>Competitor gap {blog.compScore}/100 · Social gap {blog.socialScore}/100</span>}
          </p>
        </div>
        <div className="flex items-center gap-4 md:w-56">
          <div className="flex-1">
            <div className="flex items-baseline justify-between text-xs">
              <span className="text-zinc-400">Relevancy</span>
              <span className={`font-semibold tabular-nums ${scoreText(blog.score)}`}>{blog.score}/100</span>
            </div>
            <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-zinc-800">
              <div className={`h-full rounded-full ${scoreColor(blog.score)} transition-all duration-700`} style={{ width: `${blog.score}%` }} />
            </div>
          </div>
          <ChevronDown className={`h-5 w-5 shrink-0 text-zinc-400 transition-transform duration-300 ${open ? "rotate-180" : ""}`} aria-hidden="true" />
        </div>
      </button>

      <div id={panelId} role="region" aria-label={`${blog.title} gap details`}
        className={`grid transition-all duration-300 ease-out ${open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"}`}>
        <div className="overflow-hidden">
          <div className="grid gap-5 border-t border-zinc-800 p-4 sm:p-5 lg:grid-cols-2">
            <div className="space-y-5">
              <section>
                <h4 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-zinc-400"><Tag className="h-3.5 w-3.5" aria-hidden="true" />Extracted Topics</h4>
                <p className="mt-1 text-[11px] text-zinc-500">{blog.topicMode === "grok" ? "Extracted by Grok" : "Keyword heuristic"} · searched: {blog.queries.map((q) => `"${q}"`).join(", ")}</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {blog.topics.map((t) => <span key={t} className="rounded-lg bg-zinc-800 px-2.5 py-1 text-xs text-zinc-200">{t}</span>)}
                </div>
              </section>
              <section>
                <h4 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-zinc-400"><Quote className="h-3.5 w-3.5" aria-hidden="true" />Live Harvested Internet Intent</h4>
                {blog.intents.length === 0 ? <p className="mt-2 text-sm text-zinc-500">No on-topic discussions survived the relevance filter (last 90 days).</p> : (
                <ul className="mt-2 space-y-2">
                  {blog.intents.map((q, i) => (
                    <li key={i} className="rounded-xl border-l-2 border-indigo-500/60 bg-zinc-950/60 p-3">
                      <a href={q.url} target="_blank" rel="noopener noreferrer nofollow" className="group block">
                        <p className="text-sm font-medium leading-snug text-zinc-100 group-hover:text-indigo-300">{q.title}<ExternalLink className="ml-1 inline h-3 w-3 opacity-60" aria-hidden="true" /></p>
                        {q.text && q.text !== q.title && <p className="mt-1 line-clamp-3 text-[13px] leading-relaxed text-zinc-400">“{q.text}”</p>}
                      </a>
                      <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-zinc-500">
                        <SourceBadge source={q.source} />{q.sim != null && <span>sim {q.sim}</span>}<span>{q.handle}</span><span>· {relTime(q.created)}</span>{engText(q.engagement) && <span>· {engText(q.engagement)}</span>}
                      </div>
                    </li>
                  ))}
                </ul>)}
              </section>
              <section>
                <h4 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-zinc-400"><Swords className="h-3.5 w-3.5" aria-hidden="true" />Competitor Coverage (70% weight)</h4>
                {!blog.competitors?.length ? <p className="mt-2 text-sm text-zinc-500">No competitor page closely matches this post.</p> : (
                <ul className="mt-2 space-y-2">
                  {blog.competitors.map((m, i) => (
                    <li key={i} className="rounded-xl border-l-2 border-fuchsia-500/60 bg-zinc-950/60 p-3">
                      <a href={m.url} target="_blank" rel="noopener noreferrer nofollow" className="text-sm font-medium text-zinc-100 hover:text-fuchsia-300">{m.title}<ExternalLink className="ml-1 inline h-3 w-3 opacity-60" aria-hidden="true" /></a>
                      <p className="mt-1 text-[11px] text-zinc-500">{m.competitor} · sim {m.sim}</p>
                      {m.missing?.length > 0 && <p className="mt-1 text-[12px] text-zinc-400">They cover, you don't: {m.missing.join("; ")}</p>}
                    </li>
                  ))}
                </ul>)}
              </section>
              <section>
                <h4 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-zinc-400"><Lightbulb className="h-3.5 w-3.5" aria-hidden="true" />Gap Assessment Reason</h4>
                <p className="mt-2 rounded-xl bg-amber-500/5 p-3 text-sm leading-relaxed text-zinc-300 ring-1 ring-amber-500/20">{blog.reason}</p>
              </section>
            </div>
            <section className="flex min-w-0 flex-col">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h4 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-zinc-400"><Sparkles className="h-3.5 w-3.5" aria-hidden="true" />Copy-Pasteable Markdown Injection</h4>
                {blog.markdown && <CopyButton text={blog.markdown} />}
              </div>
              <pre className="mt-2 max-h-[28rem] flex-1 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-zinc-800 bg-zinc-950 p-4 font-mono text-[12.5px] leading-relaxed text-emerald-200/90">{blog.markdown || "No injection needed: no recent friction found for this post."}</pre>
            </section>
          </div>
        </div>
      </div>
    </li>
  );
}

/* ---------------------------- Main app ---------------------------- */
export default function SearchIntentInterceptor() {
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const [tab, setTab] = useState("pipeline");
  const [url, setUrl] = useState(params.get("url") || "https://supabase.com");
  const [error, setError] = useState(null);
  const [scanning, setScanning] = useState(false);
  const [stepState, setStepState] = useState(PIPELINE_STEPS.map(() => "pending"));
  const [logs, setLogs] = useState(() => [{ t: ts(), text: "Ready. Enter a site or sitemap URL and press Scan Sitemap.", kind: "muted" }]);
  const [blogs, setBlogs] = useState([]);
  const [meta, setMeta] = useState(null);
  const [summary, setSummary] = useState(null);
  const [openId, setOpenId] = useState(null);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("severity");
  const [sources, setSources] = useState({ web: true, so: true, devto: true, x: true, reddit: true, github: true, hn: true });
  const [config, setConfig] = useState(null);
  const [seo, setSeo] = useState(null);
  const [competitors, setCompetitors] = useState(params.get("competitors") || "");
  const esRef = useRef(null);
  const logRef = useRef(null);

  useEffect(() => { fetch("/api/config").then((r) => r.json()).then(setConfig).catch(() => {}); }, []);
  useEffect(() => () => esRef.current?.close(), []);
  useEffect(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, [logs]);

  const addLog = (text, kind = "info") => setLogs((l) => [...l.slice(-400), { t: ts(), text, kind }]);
  const progress = Math.round((stepState.filter((s) => s === "done").length / PIPELINE_STEPS.length) * 100);

  const finish = () => { esRef.current?.close(); esRef.current = null; setScanning(false); };

  const startScan = useCallback(() => {
    let target = url.trim();
    if (target && !/^https?:\/\//i.test(target)) target = `https://${target}`;
    try {
      const p = new URL(target);
      if (!/^https?:$/.test(p.protocol) || !p.hostname.includes(".")) throw new Error();
    } catch { setError({ code: "BAD_URL", message: "Enter a valid URL, e.g. https://supabase.com" }); return; }
    setError(null); esRef.current?.close();
    setScanning(true); setTab("pipeline"); setOpenId(null); setBlogs([]); setSummary(null); setMeta(null); setSeo(null);
    setStepState(PIPELINE_STEPS.map(() => "pending")); setLogs([]);
    const qs = new URLSearchParams({ url: target });
    if (competitors.trim()) qs.set("competitors", competitors.trim());
    Object.entries(sources).forEach(([k, v]) => { if (!v) qs.set(k, "0"); });
    const es = new EventSource(`/api/scan?${qs}`);
    esRef.current = es;
    es.addEventListener("log", (e) => { const d = JSON.parse(e.data); addLog(d.text, d.kind); });
    es.addEventListener("step", (e) => { const d = JSON.parse(e.data); setStepState((prev) => prev.map((s, j) => (j === d.i ? d.state : s))); });
    es.addEventListener("meta", (e) => setMeta(JSON.parse(e.data)));
    es.addEventListener("competitors", (e) => { const d = JSON.parse(e.data); if (d.list?.length) setCompetitors(d.list.join(", ")); });
    es.addEventListener("seo", (e) => { const d = JSON.parse(e.data); saveRankHistory(d); setSeo(d); });
    es.addEventListener("post", (e) => { const row = JSON.parse(e.data); setBlogs((b) => [...b, row]); });
    es.addEventListener("done", (e) => {
      fetch("/api/config").then((r) => r.json()).then(setConfig).catch(() => {});
      const d = JSON.parse(e.data); setSummary(d); finish(); addLog("Done. Results ready in Gap Matrix.", "muted");
      setTab("matrix");
      if (params.get("expand")) setBlogs((b) => { const first = [...b].sort((x, y) => x.score - y.score)[0]; if (first) setOpenId(first.id); return b; });
    });
    es.addEventListener("fail", (e) => { const d = JSON.parse(e.data); setError(d); addLog(`✗ ${d.message}`, "err"); setStepState((p) => p.map((s) => (s === "running" ? "failed" : s))); finish(); });
    es.onerror = () => {
      if (!esRef.current) return;
      setError({ code: "NETWORK", message: "Lost connection to the scan server." }); addLog("✗ Lost connection to the scan server.", "err"); finish();
    };
  }, [url, sources, params, competitors]);

  const cancel = () => { finish(); addLog("✗ Scan cancelled by user.", "err"); setStepState((p) => p.map((s) => (s === "running" ? "failed" : s))); };

  useEffect(() => { if (params.get("autoscan")) startScan(); /* eslint-disable-next-line */ }, []);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return blogs
      .filter((b) => !b.sources.length || b.sources.some((s) => sources[s]))
      .filter((b) => !q || b.title.toLowerCase().includes(q) || b.topics.some((t) => t.toLowerCase().includes(q)))
      .sort((a, b) => sort === "score" ? a.score - b.score : sort === "newest" ? (Date.parse(b.updated) || 0) - (Date.parse(a.updated) || 0) : (SEVERITY[b.severity]?.rank || 0) - (SEVERITY[a.severity]?.rank || 0) || a.score - b.score);
  }, [blogs, query, sort, sources]);

  const live = blogs.length > 0;
  const gaps = blogs.filter((b) => b.status !== "no_gap" && b.score < 80).length;
  const avg = blogs.length ? Math.round(blogs.reduce((a, b) => a + b.score, 0) / blogs.length) : null;

  const TABS = [
    { id: "pipeline", label: "Pipeline", Icon: Workflow },
    { id: "matrix", label: "Gap Matrix", Icon: LayoutGrid, badge: blogs.length || null },
    { id: "seo", label: "SEO & Keywords", Icon: TrendingUp, badge: seo?.avgScore ?? null },
    { id: "settings", label: "Settings", Icon: Settings },
  ];
  const srcCfg = config?.sources || {};

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 antialiased">
      <style>{`@keyframes sii-fade{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}.sii-fade{animation:sii-fade .35s ease-out}@keyframes sii-blink{50%{opacity:0}}.sii-cursor{animation:sii-blink 1s step-end infinite}`}</style>

      <header className="sticky top-0 z-10 border-b border-zinc-800/80 bg-zinc-950/80 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <div className="flex items-center gap-3">
            <span className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 shadow-lg shadow-indigo-900/40">
              <Radar className="h-5 w-5 text-white" aria-hidden="true" />
            </span>
            <div>
              <p className="text-sm font-semibold leading-tight">Search Intent Shift Interceptor</p>
              <p className="text-[11px] text-zinc-500">Content relevancy radar for B2B SaaS</p>
            </div>
          </div>
          <nav aria-label="Main" className="flex rounded-xl bg-zinc-900 p-1 ring-1 ring-zinc-800">
            {TABS.map(({ id, label, Icon, badge }) => (
              <button key={id} type="button" onClick={() => setTab(id)} aria-current={tab === id ? "page" : undefined}
                className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm transition ${focusRing} ${tab === id ? "bg-indigo-500 text-white shadow" : "text-zinc-400 hover:text-zinc-100"}`}>
                <Icon className="h-4 w-4" aria-hidden="true" /><span className="hidden sm:inline">{label}</span>
                {badge && <span className="rounded-full bg-white/15 px-1.5 text-[10px] tabular-nums">{badge}</span>}
              </button>
            ))}
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-7xl space-y-6 px-4 py-6 sm:px-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Where is your content losing the conversation?</h1>
            <p className="mt-1 text-sm text-zinc-400">Scan any site's real blog posts against competitor content (70%) and live discussion (30%) across the web, Stack Overflow, dev.to, Reddit, GitHub, Hacker News{srcCfg.x?.configured ? " and X" : ""}.</p>
          </div>
          {live && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-3 py-1 text-xs font-medium text-emerald-300 ring-1 ring-emerald-500/30">
              <Wifi className="h-3.5 w-3.5" aria-hidden="true" /> Live data{meta ? ` · ${new URL(meta.origin).hostname}` : ""}
            </span>
          )}
        </div>

        <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4" aria-label="Key metrics">
          <MetricCard icon={FileSearch} label="Total Blogs Scanned" value={blogs.length || "–"} hint={meta ? `${meta.content} content URLs found in ${meta.total} sitemap URLs` : "URLs parsed from sitemap"} accent="bg-indigo-500/15 text-indigo-300" />
          <MetricCard icon={AlertTriangle} label="Active Gaps Found" value={live ? gaps : "–"} hint="Posts scoring below 80/100 (else: No active gap)" accent="bg-rose-500/15 text-rose-300" />
          <MetricCard icon={Gauge} label="AI Relevancy Score" value={avg != null ? `${avg}%` : "–"} hint={summary ? `Avg. across scanned posts · ${summary.mode.topics === "grok" ? "Grok" : "heuristic"} mode · 70% competitor / 30% social` : "70% competitor / 30% social"} accent="bg-emerald-500/15 text-emerald-300" />
          <MetricCard icon={Swords} label="Competitor Coverage" value={summary?.competitorCoverage ? `${summary.competitorCoverage.covered}/${summary.competitorCoverage.total}` : "–"} hint={summary?.competitors?.length ? `Your posts that competitors also cover · ${summary.competitors.join(", ")}` : "Posts competitors also cover"} accent="bg-fuchsia-500/15 text-fuchsia-300" />
        </section>

        <section className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5">
          <p className="text-xs font-semibold uppercase tracking-wider text-indigo-300">Step 1 · Sitemap ingestion</p>
          <form className="mt-3 flex flex-col gap-3 sm:flex-row" onSubmit={(e) => { e.preventDefault(); if (!scanning) startScan(); }} noValidate>
            <label htmlFor="sitemap" className="sr-only">Site or XML sitemap URL</label>
            <input id="sitemap" type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://supabase.com or https://example.com/sitemap.xml"
              aria-invalid={!!error} aria-describedby={error ? "sitemap-err" : undefined}
              className={`min-w-0 flex-1 rounded-xl border bg-zinc-950 px-4 py-2.5 font-mono text-sm text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-indigo-400 ${error ? "border-rose-500/60" : "border-zinc-800"}`} />
            {scanning ? (
              <button type="button" onClick={cancel} className={`inline-flex items-center justify-center gap-2 rounded-xl bg-zinc-800 px-5 py-2.5 text-sm font-semibold text-zinc-100 ring-1 ring-zinc-700 transition hover:bg-zinc-700 ${focusRing}`}>
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Cancel <Square className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            ) : (
              <button type="submit" className={`inline-flex items-center justify-center gap-2 rounded-xl bg-indigo-500 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-indigo-400 ${focusRing}`}>
                <Play className="h-4 w-4" aria-hidden="true" /> Scan Sitemap
              </button>
            )}
          </form>
          <label htmlFor="competitors" className="mt-3 block text-xs text-zinc-400">Competitors (optional, comma-separated domains; left empty = auto-discover 3–5)</label>
          <input id="competitors" type="text" value={competitors} onChange={(e) => setCompetitors(e.target.value)} placeholder="firebase.google.com, neon.tech, planetscale.com"
            className="mt-1 w-full rounded-xl border border-zinc-800 bg-zinc-950 px-4 py-2 font-mono text-sm text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-indigo-400" />
          <p className="mt-2 text-xs text-zinc-500">Checks robots.txt, /sitemap.xml and /sitemap_index.xml, then scans the {config?.maxPosts || 15} newest blog or guide posts. A scan takes about 2–4 minutes.</p>
          {error && (
            <div id="sitemap-err" role="alert" className="mt-3 flex items-start gap-2 rounded-xl bg-rose-500/10 p-3 text-sm text-rose-200 ring-1 ring-rose-500/30">
              <XCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <span><strong className="font-semibold">{ERRORS[error.code] || "Scan failed"}.</strong> {error.message}</span>
            </div>
          )}
        </section>

        <div key={tab} className="sii-fade">
          {tab === "pipeline" && (
            <section className="grid gap-4 lg:grid-cols-[18rem_1fr]">
              <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5">
                <p className="text-xs font-semibold uppercase tracking-wider text-indigo-300">Steps 2–5 · Pipeline</p>
                <div className="mt-3 h-2 overflow-hidden rounded-full bg-zinc-800" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}>
                  <div className="h-full rounded-full bg-gradient-to-r from-indigo-500 to-violet-500 transition-all duration-500" style={{ width: `${progress}%` }} />
                </div>
                <p className="mt-1 text-right text-xs tabular-nums text-zinc-500">{progress}%</p>
                <ol className="mt-3 space-y-3">
                  {PIPELINE_STEPS.map((s, i) => {
                    const st = stepState[i];
                    return (
                      <li key={s.id} className="flex items-center gap-3 text-sm">
                        {st === "done" ? <CheckCircle2 className="h-5 w-5 text-emerald-400" aria-hidden="true" />
                          : st === "running" ? <Loader2 className="h-5 w-5 animate-spin text-indigo-300" aria-hidden="true" />
                          : st === "failed" ? <XCircle className="h-5 w-5 text-rose-400" aria-hidden="true" />
                          : <Circle className="h-5 w-5 text-zinc-600" aria-hidden="true" />}
                        <span className={st === "pending" ? "text-zinc-500" : "text-zinc-200"}>{s.id}. {s.label}</span>
                        <span className="ml-auto text-[11px] capitalize text-zinc-500">{st}</span>
                      </li>
                    );
                  })}
                </ol>
                {blogs.length > 0 && <button type="button" onClick={() => setTab("matrix")} className={`mt-5 w-full rounded-xl bg-indigo-500/15 px-3 py-2 text-sm text-indigo-200 ring-1 ring-indigo-500/30 hover:bg-indigo-500/25 ${focusRing}`}>View {blogs.length} result{blogs.length > 1 ? "s" : ""} in Gap Matrix</button>}
              </div>
              <div className="overflow-hidden rounded-2xl border border-zinc-800 bg-black/70">
                <div className="flex items-center gap-2 border-b border-zinc-800 px-4 py-2.5">
                  <span className="h-2.5 w-2.5 rounded-full bg-rose-500/70" /><span className="h-2.5 w-2.5 rounded-full bg-amber-500/70" /><span className="h-2.5 w-2.5 rounded-full bg-emerald-500/70" />
                  <Terminal className="ml-2 h-4 w-4 text-zinc-500" aria-hidden="true" /><span className="text-xs text-zinc-500">interceptor — live pipeline</span>
                </div>
                <div ref={logRef} role="log" aria-live="polite" className="h-96 overflow-y-auto p-4 font-mono text-[12.5px] leading-6">
                  {logs.map((l, i) => (
                    <div key={i} className="sii-fade flex gap-3">
                      <span className="shrink-0 text-zinc-600">[{l.t}]</span>
                      <span className={`break-all whitespace-pre-wrap ${l.kind === "cmd" ? "text-indigo-300" : l.kind === "ok" ? "text-emerald-300" : l.kind === "muted" ? "text-zinc-500" : l.kind === "warn" ? "text-amber-300" : l.kind === "err" ? "text-rose-300" : "text-zinc-200"}`}>{l.text}</span>
                    </div>
                  ))}
                  <span className="sii-cursor inline-block h-4 w-2 translate-y-0.5 bg-emerald-400" aria-hidden="true" />
                </div>
              </div>
            </section>
          )}

          {tab === "matrix" && (
            <section aria-label="Gap analysis matrix">
              {summary?.competitorCoverage?.uncovered?.length > 0 && (
                <div className="mb-4 rounded-2xl border border-fuchsia-500/30 bg-fuchsia-500/5 p-4">
                  <p className="text-xs font-semibold uppercase tracking-wider text-fuchsia-300">Competitor coverage · topics they publish that no scanned post of yours covers</p>
                  <ul className="mt-2 space-y-1 text-sm">
                    {summary.competitorCoverage.uncovered.map((u) => (
                      <li key={u.url}><a href={u.url} target="_blank" rel="noopener noreferrer nofollow" className="text-zinc-200 hover:text-fuchsia-300">{u.title}</a> <span className="text-xs text-zinc-500">· {u.competitor}</span></li>
                    ))}
                  </ul>
                </div>
              )}
              <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-xs font-semibold uppercase tracking-wider text-indigo-300">Steps 4–5 · Gap Analysis Matrix {meta && <span className="normal-case text-zinc-500">· {meta.origin}</span>}</p>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <label className="relative">
                    <span className="sr-only">Search posts or topics</span>
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" aria-hidden="true" />
                    <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search posts or topics"
                      className="w-full rounded-xl border border-zinc-800 bg-zinc-900 py-2 pl-9 pr-3 text-sm placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-indigo-400 sm:w-64" />
                  </label>
                  <label className="relative">
                    <span className="sr-only">Sort by</span>
                    <ArrowUpDown className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" aria-hidden="true" />
                    <select value={sort} onChange={(e) => setSort(e.target.value)}
                      className="w-full appearance-none rounded-xl border border-zinc-800 bg-zinc-900 py-2 pl-9 pr-8 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400">
                      <option value="severity">Sort: Severity</option>
                      <option value="score">Sort: Lowest score</option>
                      <option value="newest">Sort: Recently updated</option>
                    </select>
                  </label>
                </div>
              </div>
              {scanning && (
                <div className="mb-3 flex items-center gap-2 rounded-xl border border-dashed border-zinc-800 p-3 text-sm text-zinc-400">
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Scan in progress. Rows appear as each post finishes ({blogs.length}{meta ? `/${meta.picked}` : ""}).
                </div>
              )}
              {visible.length === 0 ? (
                !scanning && <div className="rounded-2xl border border-dashed border-zinc-800 p-10 text-center text-sm text-zinc-400">{blogs.length ? "No posts match your filters." : "No results yet. Run a scan from Step 1."}</div>
              ) : (
                <ul className="space-y-3">
                  {visible.map((b) => (
                    <GapRow key={b.id} blog={b} open={openId === b.id} onToggle={() => setOpenId((o) => (o === b.id ? null : b.id))} />
                  ))}
                </ul>
              )}
            </section>
          )}

          {tab === "seo" && <SeoPanel seo={seo} />}

          {tab === "settings" && (
            <div className="grid gap-4 lg:grid-cols-2">
              <section className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5">
                <h2 className="text-sm font-semibold">Intent sources</h2>
                <p className="mt-1 text-xs text-zinc-500">Choose which communities feed the next scan and filter the matrix.</p>
                <ul className="mt-4 divide-y divide-zinc-800">
                  {Object.keys(SOURCE).map((k) => {
                    const connected = k !== "x" || srcCfg.x?.configured;
                    const on = sources[k] && connected;
                    return (
                      <li key={k} className="flex items-center justify-between gap-3 py-3">
                        <span className="flex items-center gap-2 text-sm">{React.createElement(SOURCE[k].Icon, { className: "h-4 w-4 text-zinc-400", "aria-hidden": true })}{SOURCE[k].label}
                          <span className={`rounded-full px-2 py-0.5 text-[10px] ${connected ? "bg-emerald-500/10 text-emerald-300" : "bg-zinc-800 text-zinc-500"}`}>{srcCfg[k]?.auth || (connected ? "public" : "not connected")}</span>
                        </span>
                        <button type="button" role="switch" aria-checked={on} aria-label={SOURCE[k].label} disabled={!connected} onClick={() => setSources((s) => ({ ...s, [k]: !s[k] }))}
                          className={`relative h-6 w-11 shrink-0 rounded-full transition disabled:cursor-not-allowed disabled:opacity-40 ${focusRing} ${on ? "bg-indigo-500" : "bg-zinc-700"}`}>
                          <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${on ? "left-[22px]" : "left-0.5"}`} />
                        </button>
                      </li>
                    );
                  })}
                </ul>
                {srcCfg.x?.status === "credits" && <p className="mt-2 text-xs text-amber-300">X token is connected, but the X API account has no credits left (HTTP 402). X is skipped and no X data is shown.</p>}
                {!srcCfg.x?.configured && <p className="mt-2 text-xs text-zinc-500">X needs an X API bearer token on the server (X_BEARER_TOKEN). No X results are shown without it.</p>}
              </section>
              <section className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5">
                <h2 className="flex items-center gap-2 text-sm font-semibold"><KeyRound className="h-4 w-4 text-zinc-400" aria-hidden="true" />Server configuration</h2>
                <p className="mt-1 text-xs text-zinc-500">Which keys the server has. Key values are never sent to the browser.</p>
                <ul className="mt-4 space-y-2 text-sm">
                  {[["XAI_API_KEY", config?.ai?.grok, config?.ai?.grok ? `Grok topics + gap copy (${config.ai.model})` : "Off: keyword heuristics and template copy"],
                    ["GITHUB_TOKEN", srcCfg.github?.auth === "token", srcCfg.github?.auth === "token" ? "Authenticated GitHub search (30/min)" : "Unauthenticated GitHub search (10/min, shared)"],
                    ["X_BEARER_TOKEN", srcCfg.x?.configured, srcCfg.x?.configured ? `X recent search: ${srcCfg.x.auth}` : "X not connected"]].map(([k, ok, d]) => (
                    <li key={k} className="flex items-start gap-3 rounded-xl bg-zinc-950/60 p-3">
                      {ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" aria-hidden="true" /> : <Circle className="mt-0.5 h-4 w-4 shrink-0 text-zinc-600" aria-hidden="true" />}
                      <span><code className="text-xs text-zinc-300">{k}</code><span className="block text-xs text-zinc-500">{d}</span></span>
                    </li>
                  ))}
                </ul>
                {config && <p className="mt-3 text-xs text-zinc-500">Fair use: {config.limits.scansPer15Min} scans per 15 minutes per visitor.</p>}
              </section>
            </div>
          )}
        </div>

        <footer className="flex items-center gap-1.5 pb-4 text-xs text-zinc-600">
          <ExternalLink className="h-3 w-3" aria-hidden="true" /> Live build · posts are scraped from the scanned site and every quote links to its public source.
        </footer>
      </main>
    </div>
  );
}
