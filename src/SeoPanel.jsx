import React, { useMemo } from "react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell, LineChart, Line } from "recharts";

const card = "rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5";
const tip = { contentStyle: { background: "#18181b", border: "1px solid #3f3f46", borderRadius: 8, fontSize: 12 }, labelStyle: { color: "#e4e4e7" } };
const scoreColor = (s) => (s >= 85 ? "#34d399" : s >= 65 ? "#fbbf24" : "#f87171");
const HKEY = (site) => `ii-rank-history:${site}`;

/** Rank history lives in this browser's localStorage (Render free plan has no persistent disk). */
export function saveRankHistory(seo) {
  try {
    const r = seo?.ranks; if (!r?.rows?.length || !r.site) return;
    const h = JSON.parse(localStorage.getItem(HKEY(r.site)) || "[]");
    h.push({ at: r.at || Date.now(), engine: r.engine, rows: r.rows.map((x) => ({ k: x.keyword, p: x.positions || {} })) });
    localStorage.setItem(HKEY(r.site), JSON.stringify(h.slice(-30)));
  } catch {}
}
function loadHistory(site) { try { return JSON.parse(localStorage.getItem(HKEY(site)) || "[]"); } catch { return []; } }

export default function SeoPanel({ seo }) {
  const history = useMemo(() => (seo?.ranks?.site ? loadHistory(seo.ranks.site) : []), [seo]);
  if (!seo) return <section className={card}><p className="text-sm text-zinc-400">Run a scan to see the on-page SEO audit, keywords, competitor overlap, autocomplete ideas and rank tracking.</p></section>;
  const audits = seo.audits || [];
  const scoreData = audits.map((a, i) => ({ name: `#${i + 1}`, title: a.title, score: a.score ?? 0 }));
  const kwData = (seo.siteKeywords || []).slice(0, 15).map((k) => ({ name: k.keyword, score: k.score }));
  const ov = seo.overlap || { shared: [], compOnly: [], userOnly: [] };
  const doms = seo.ranks?.domains || [];
  const ideas = seo.ideas || { status: {}, list: [] };
  const best = seo.ranks?.engine !== "brave";
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <section className={card}>
        <h2 className="text-sm font-semibold">On-page SEO score per post <span className="text-zinc-500">· avg {seo.avgScore}/100</span></h2>
        <div className="mt-3 h-56"><ResponsiveContainer><BarChart data={scoreData}><XAxis dataKey="name" stroke="#71717a" fontSize={11} /><YAxis domain={[0, 100]} stroke="#71717a" fontSize={11} /><Tooltip {...tip} formatter={(v, n, p) => [v, p.payload.title]} /><Bar dataKey="score" radius={[4, 4, 0, 0]}>{scoreData.map((d, i) => <Cell key={i} fill={scoreColor(d.score)} />)}</Bar></BarChart></ResponsiveContainer></div>
      </section>
      <section className={card}>
        <h2 className="text-sm font-semibold">Top site keywords & phrases <span className="text-zinc-500">· TF-IDF</span></h2>
        <div className="mt-3 h-56"><ResponsiveContainer><BarChart data={kwData} layout="vertical" margin={{ left: 10 }}><XAxis type="number" stroke="#71717a" fontSize={11} /><YAxis type="category" dataKey="name" width={150} stroke="#a1a1aa" fontSize={10} /><Tooltip {...tip} /><Bar dataKey="score" fill="#818cf8" radius={[0, 4, 4, 0]} /></BarChart></ResponsiveContainer></div>
      </section>

      <section className={`${card} lg:col-span-2`}>
        <h2 className="text-sm font-semibold">Audit details & fixes</h2>
        <div className="mt-3 max-h-96 space-y-2 overflow-auto pr-1">
          {audits.map((a, i) => (
            <details key={i} className="rounded-xl border border-zinc-800 bg-zinc-950/50 p-3">
              <summary className="flex cursor-pointer items-center gap-3 text-sm"><span className="w-10 font-mono font-semibold" style={{ color: scoreColor(a.score ?? 0) }}>{a.score ?? "–"}</span><span className="truncate">#{i + 1} {a.title}</span></summary>
              <div className="mt-2 grid gap-1 text-xs text-zinc-400 sm:grid-cols-4">
                <span>Title {a.titleLen} ch</span><span>Meta desc {a.descLen} ch</span><span>H1 ×{a.h1} · {a.headings} headings</span><span>Canonical {a.canonical ? "✓" : "✗"} · OG {a.og}</span>
                <span>Schema {(a.schema || []).join(", ") || "none"}</span><span>Images {a.images} · alt {a.altPct ?? "–"}%</span><span>Links {a.internal} int / {a.external} ext</span><span>{a.words} words · Flesch {a.flesch} · {a.ms} ms</span>
              </div>
              {a.fixes?.length > 0 && <ul className="mt-2 list-disc pl-5 text-xs text-amber-300">{a.fixes.map((f, j) => <li key={j}>{f}</li>)}</ul>}
              {a.keywords?.length > 0 && <div className="mt-2 flex flex-wrap gap-1">{a.keywords.slice(0, 10).map((k) => <span key={k.keyword} className="rounded bg-zinc-800 px-1.5 py-0.5 text-[11px] text-zinc-300">{k.keyword} <span className="text-zinc-500">{k.density}%</span></span>)}</div>}
              <a href={a.url} target="_blank" rel="noreferrer" className="mt-2 inline-block text-xs text-indigo-300 hover:underline">{a.url}</a>
            </details>
          ))}
        </div>
      </section>

      <section className={`${card} lg:col-span-2`}>
        <h2 className="text-sm font-semibold">Competitor keyword overlap</h2>
        <div className="mt-3 grid gap-3 md:grid-cols-3">
          {[["Only competitors cover", ov.compOnly, "text-rose-300", (x) => x.competitor], ["Shared", ov.shared, "text-emerald-300", (x) => x.competitor], ["Only you cover", ov.userOnly, "text-sky-300", (x) => x.user]].map(([label, list, cls, pg]) => (
            <div key={label} className="rounded-xl border border-zinc-800 bg-zinc-950/50 p-3">
              <div className={`text-xs font-semibold ${cls}`}>{label} · {list.length}</div>
              <ul className="mt-2 max-h-64 space-y-1 overflow-auto text-xs">{list.slice(0, 30).map((x) => { const p = pg(x)?.[0]; return <li key={x.keyword}><a href={p?.url} target="_blank" rel="noreferrer" className="text-zinc-200 hover:underline" title={p?.title}>{x.keyword}</a>{p?.competitor && <span className="text-zinc-500"> · {p.competitor}</span>}</li>; })}</ul>
            </div>
          ))}
        </div>
      </section>

      <section className={card}>
        <h2 className="text-sm font-semibold">Rank tracking <span className="text-zinc-500">· {seo.ranks?.engine}{best ? " (best effort)" : " top 20"}</span></h2>
        <p className="mt-1 text-[11px] text-zinc-500">History is stored in this browser (localStorage), up to 30 scans.</p>
        <div className="mt-2 max-h-96 overflow-auto"><table className="w-full text-xs"><thead><tr className="text-left text-zinc-500"><th className="py-1">Keyword</th>{doms.map((d) => <th key={d} className="px-1">{d}</th>)}<th>Trend</th></tr></thead>
          <tbody>{(seo.ranks?.rows || []).map((r) => {
            const trend = history.map((h, i) => { const row = h.rows.find((x) => x.k === r.keyword); const p = row?.p?.[doms[0]]; return { i, v: p ? 21 - p : 0 }; });
            return <tr key={r.keyword} className="border-t border-zinc-800"><td className="py-1 pr-2 text-zinc-200">{r.keyword}{r.engine === "unavailable" && <span className="text-zinc-500"> (no data)</span>}</td>
              {doms.map((d) => { const p = r.positions?.[d]; return <td key={d} className="px-1 font-mono">{p ? <a href={r.urls?.[d]} target="_blank" rel="noreferrer" className="text-emerald-300">{p}</a> : <span className="text-zinc-600">–</span>}</td>; })}
              <td className="w-20">{trend.length > 1 ? <ResponsiveContainer width={70} height={20}><LineChart data={trend}><Line dataKey="v" stroke="#818cf8" dot={false} strokeWidth={1.5} isAnimationActive={false} /></LineChart></ResponsiveContainer> : <span className="text-zinc-600">–</span>}</td></tr>;
          })}</tbody></table></div>
      </section>

      <section className={card}>
        <h2 className="text-sm font-semibold">Keyword ideas (autocomplete)</h2>
        <div className="mt-1 flex gap-2 text-[11px]">{Object.entries(ideas.status || {}).map(([k, v]) => <span key={k} className={v === "ok" ? "text-emerald-400" : "text-rose-400"}>{k}: {v}</span>)}</div>
        <ul className="mt-2 max-h-96 space-y-1 overflow-auto text-xs">{(ideas.list || []).map((x) => <li key={x.idea} className="flex justify-between gap-2"><span className="text-zinc-200">{x.idea}</span><span className="text-zinc-500">{x.sources.join(" · ")}</span></li>)}</ul>
      </section>
    </div>
  );
}
