import { statsModel } from "./model.js";

const pct = (x) => (x == null || !Number.isFinite(x) ? "-" : `${Math.round(x * 100)}%`);
const per = (v, n) => (n ? (v / n).toFixed(2) : "n/a");

// Stage 2 output: what we know about each shortlisted match, and what the stats model says against the market.
export function statsMarkdown(list) {
  const out = ["# Stats for shortlisted matches", ""];
  for (const m of list) {
    const s = m.stats;
    out.push(`## ${m.home} v ${m.away}`, `${m.league} | ${m.start}${s ? ` | ${s.kind} match` : ""}`, "");
    if (!s) {
      out.push("_No ESPN data found for this match, so it is judged on market and AI only._", "");
      continue;
    }
    const row = (label, fn) => `| ${label} | ${fn(s.home)} | ${fn(s.away)} |`;
    const table = (t) => (t.pos ? `${t.pos} of ${t.size}, ${t.pts} pts` : "n/a");
    out.push(
      `| | ${m.home} (home) | ${m.away} (away) |`,
      "|---|---|---|",
      row("Table", table),
      row("Points per game", (t) => (t.gp ? t.ppg.toFixed(2) : "n/a")),
      row("Goals for / against per game", (t) => `${per(t.gf, t.gp)} / ${per(t.ga, t.gp)}`),
      row("Last 5", (t) => t.form || "n/a"),
      row("Last 5 at this venue", (t) => t.venueForm || "n/a"),
      "",
    );
    const sm = statsModel(m);
    if (!sm) {
      out.push("_Too few completed games for the stats model._", "");
      continue;
    }
    out.push(`Expected goals: ${m.home} ${sm.lh.toFixed(2)} - ${sm.la.toFixed(2)} ${m.away} (model confidence ${pct(sm.conf)})`, "");
    const rows = [];
    for (const mk of m.markets) {
      for (const o of mk.outcomes) {
        const sp = sm.prob(mk, o);
        if (Math.max(o.fair, sp ?? 0) >= 0.6) rows.push({ label: o.label, odds: o.odds, market: o.fair, stats: sp });
      }
    }
    rows.sort((a, b) => Math.max(b.market, b.stats ?? 0) - Math.max(a.market, a.stats ?? 0));
    if (rows.length) {
      out.push("| Outcome | Odds | Market | Stats model |", "|---|---|---|---|");
      for (const r of rows.slice(0, 8)) out.push(`| ${r.label} | ${r.odds.toFixed(2)} | ${pct(r.market)} | ${pct(r.stats)} |`);
      out.push("");
    }
  }
  return out.join("\n");
}

// Final output: each slip with where every leg's probability came from.
export function slipMarkdown(slips) {
  const out = ["# Final slips", ""];
  for (const s of slips) {
    if (!s.legs.length) {
      out.push(`## ${s.target}x`, `_${s.note}_`, "");
      continue;
    }
    out.push(
      `## ${s.target}x: ${s.legs.length} legs, odds ${s.odds.toFixed(2)}, win chance ${pct(s.prob)} (${s.source === "ai" ? "chosen by AI selector" : s.source === "closest" ? "highest odds possible, target not reached" : "best computed combination"})`,
      "",
      "| # | Match | Pick | Odds | Win % | Market | Stats | AI | Type |",
      "|---|---|---|---|---|---|---|---|---|",
      ...s.legs.map((l, i) => `| ${i + 1} | ${l.match} | ${l.label} | ${l.odds.toFixed(2)} | ${pct(l.prob)} | ${pct(l.sources.market)} | ${pct(l.sources.stats)} | ${pct(l.sources.ai)} | ${l.matchType} |`),
      "",
    );
    if (s.relaxed) out.push(`Note: ${s.relaxed}`, "");
    if (s.notes) out.push(`Selector notes: ${s.notes}`, "");
    if (s.rejected?.length) out.push("Rejected by the selector:", ...s.rejected.map((r) => `- ${r.match || r.id}: ${r.why}`), "");
    if (s.warning) out.push(`Warning: ${s.warning}`, "");
  }
  return out.join("\n");
}

// Web news found by Tavily, per match.
export function newsMarkdown(list) {
  const out = ["# Web news (Tavily)", ""];
  let any = false;
  for (const m of list) {
    const w = m.web;
    if (!w) continue;
    any = true;
    out.push(`## ${m.home} v ${m.away}`, ...(w.answer ? [`Summary: ${w.answer}`] : []),
      ...w.items.map((i) => `- ${i.title}${i.date ? ` (${String(i.date).slice(0, 10)})` : ""}: ${i.text} ${i.url}`), "");
  }
  if (!any) out.push("_No web news found._", "");
  return out.join("\n");
}

// What the AI predictors made of the news: sentiment per team (-2 to +2), risk, confidence.
export function sentimentMarkdown(list, title = "") {
  const rows = list.filter((m) => m.news);
  if (!rows.length) return "";
  const sg = (x) => `${x >= 0 ? "+" : ""}${x.toFixed(1)}`;
  return ["# Team news sentiment" + (title ? ` (${title})` : ""), "", "| Match | Home | Away | Risk | Confidence |", "|---|---|---|---|---|",
    ...rows.map((m) => `| ${m.home} v ${m.away} | ${sg(m.news.home)} | ${sg(m.news.away)} | ${m.news.risk} | ${pct(m.news.confidence)} |`), ""].join("\n");
}