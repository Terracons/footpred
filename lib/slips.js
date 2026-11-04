import { statsModel, resultType } from "./model.js";

// How much each source counts. Past stats lead by default. The stats weight is scaled by the model's confidence
// (sample size, match type), so a team with few games behind it counts for less.
const BASIS = {
  led: { market: 0.25, ai: 0.15, stats: 0.6 },
  balanced: { market: 0.45, ai: 0.2, stats: 0.35 },
};
export const DEFAULTS = {
  minProb: 0, // optional hard floor per leg. 0 = no cut-off, the optimiser simply maximises the combined chance
  requireStats: true, // true = only matches with table, form and goals data behind them
  basis: "led", // "led" = past stats lead, "balanced" = the market counts almost as much
  allowDraw: false, // false = never pick a draw
  prefer1X: true, // lean toward double chance (1X, X2) over single results when chances are close
  minLegOdds: 1.08, // legs shorter than this add risk for almost no odds
  maxLegOdds: 2.2, // legs longer than this are left out, so the slip is built from safer legs. Infinity = no cap
  minLegs: 1, // no leg floor by default. The optimiser uses as many legs as it needs
  maxLegs: 30,
  tolerance: 0.08, // the slip should land between the target and this much above it (8%)
  pool: 0, // 0 = size the candidate pool from the leg range
  maxEnrich: 60, // stats are extracted for up to this many matches before any selection is made
  newsCalls: 10, // web news searches per run (one per match, best ranked first). Tavily basic search costs 1 credit each
};

// Multipliers used only when choosing between legs (the leg's shown chance is not changed).
export const prefFor = (o) => (o.prefer1X
  ? { "1": 1, "2": 1, "1X": 1.05, X2: 1.03, "12": 0.92 }
  : { "1": 1, "2": 1, "1X": 1, X2: 1, "12": 0.95 });

// A leg is usable when its price is inside the allowed range and it is not a draw (unless draws are switched on).
const usable = (mk, o, opts) => o.odds >= opts.minLegOdds && o.odds <= opts.maxLegOdds && (opts.allowDraw || resultType(mk, o) !== "X");

export function legRange(o = {}) {
  const min = Math.max(1, Math.floor(Number(o.minLegs)) || DEFAULTS.minLegs);
  const max = Math.max(min, Math.floor(Number(o.maxLegs)) || DEFAULTS.maxLegs);
  return { min, max };
}

// Team news ratings from the predictors: sentiment and confidence are averaged, risk takes the highest level.
function mergeNews(list) {
  if (!list.length) return null;
  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, Number(x) || 0));
  const avg = (f) => list.reduce((a, n) => a + f(n), 0) / list.length;
  const rank = { low: 0, medium: 1, high: 2 };
  const risk = list.map((n) => n.risk).filter((r) => r in rank).sort((a, b) => rank[b] - rank[a])[0] || "low";
  return { home: avg((n) => clamp(n.home, -2, 2)), away: avg((n) => clamp(n.away, -2, 2)), confidence: avg((n) => clamp(n.confidence, 0, 1)), risk };
}

// Sets (or clears) m.news from this set of predictions. Call it right before building legs: matches are shared
// between sets running at the same time, so each set must apply its own ratings just before it uses them.
export function applyNews(list, preds) {
  for (const m of list) {
    const n = preds[m.id]?.news;
    if (n) m.news = n; else delete m.news;
  }
}

// Average several models' probabilities for the same outcome.
export function merge(list) {
  const acc = {};
  for (const preds of list) {
    for (const [id, pr] of Object.entries(preds)) {
      const o = (acc[id] ??= { sum: {}, n: {}, reason: pr.reason, news: [] });
      if (pr.news && typeof pr.news === "object") o.news.push(pr.news);
      for (const [k, v] of Object.entries(pr.p || {})) {
        const x = Number(v);
        if (x > 0) { o.sum[k] = (o.sum[k] || 0) + x; o.n[k] = (o.n[k] || 0) + 1; }
      }
    }
  }
  return Object.fromEntries(Object.entries(acc).map(([id, o]) => [
    id, { reason: o.reason, news: mergeNews(o.news), p: Object.fromEntries(Object.keys(o.sum).map((k) => [k, o.sum[k] / o.n[k]])) },
  ]));
}

// Stake's "SRL" and similar are simulated games with random results. Team stats mean nothing for them.
export const isSimulated = (m) => /\bSRL\b|esoccer|e-soccer|virtual|cyber|simulated|\bebasketball\b/i.test(`${m.league} ${m.home} ${m.away}`);

// Stage 1: cheap ranking with no API calls. A match is a likely candidate if the market already
// rates one of its usable outcomes highly. Takes the top n (all of them when there are fewer than n).
export function shortlist(matches, kinds, n, o = {}) {
  const opts = { ...DEFAULTS, ...o };
  const score = (m) => {
    let best = 0;
    for (const mk of m.markets) {
      if (kinds && !kinds.includes(mk.kind)) continue;
      for (const x of mk.outcomes) if (usable(mk, x, opts) && x.fair > best) best = x.fair;
    }
    return best;
  };
  return matches.filter((m) => !isSimulated(m)).map((m) => ({ m, s: score(m) })).sort((a, b) => b.s - a.s).slice(0, n).map((x) => x.m)
    .sort((a, b) => a.start.localeCompare(b.start));
}

// Stage 2 ranking, after stats were extracted: how favourable is each match? Uses the stats model and the market
// (the AI has not run yet). Matches with no stats are scored from the market alone, minus a margin, so they can
// still compete but need to be clearly better. Returns the matches best first.
export function rankMatches(matches, kinds, o = {}) {
  const opts = { ...DEFAULTS, ...o };
  const pref = prefFor(opts);
  const marketOnly = (m) => {
    let best = 0;
    for (const mk of m.markets) {
      if (kinds && !kinds.includes(mk.kind)) continue;
      for (const x of mk.outcomes) if (usable(mk, x, opts)) best = Math.max(best, x.fair * (pref[resultType(mk, x)] ?? 1));
    }
    return best - 0.08;
  };
  return matches
    .map((m) => {
      const c = candidatesFor(m, {}, kinds, opts);
      return { m, s: c.length ? Math.max(...c.map((x) => x.score)) : marketOnly(m) };
    })
    .sort((a, b) => b.s - a.s)
    .map((x) => x.m);
}

// One line of past data behind a pick: table position, points per game, goals, form, and the model's expected goals.
function whyStats(m, sm) {
  const s = m.stats;
  if (!s || !sm) return "";
  const side = (name, t) => {
    const table = t.pos ? `#${t.pos} of ${t.size}` : "table n/a";
    const goals = t.gp ? `${(t.gf / t.gp).toFixed(1)} scored and ${(t.ga / t.gp).toFixed(1)} conceded a game` : "no goals data";
    return `${name} ${table}, ${t.ppg.toFixed(2)} pts a game, ${goals}, form ${t.form || "n/a"}`;
  };
  return `${side(m.home, s.home)}. ${side(m.away, s.away)}. Model expects ${sm.lh.toFixed(1)} to ${sm.la.toFixed(1)} goals.`;
}

// Legs for one match. Three sources are blended: the no-vig market, the AI and the stats model (form, goals, table).
// The blended chance is then lowered when the sources disagree (a quarter of the gap between the highest and lowest),
// for cup and European ties, and when there are no stats behind the match. Of all outcomes, only the ones not beaten
// on both chance and odds by another outcome are kept (at most 5), so the optimiser can trade chance for odds.
export function candidatesFor(m, pred, kinds, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const { minProb, requireStats } = o;
  const W = BASIS[o.basis] || BASIS.led;
  const pref = prefFor(o);
  const sm = statsModel(m);
  const hasAi = pred.p && Object.keys(pred.p).length;
  if (requireStats && !sm) return [];
  const why = whyStats(m, sm);
  // No stats costs more than a typical source disagreement, so a match with no data can never beat one with data on that alone.
  const penalty = (m.stats && m.stats.kind !== "league" ? 0.02 : 0) + (sm ? 0 : 0.08) + (hasAi || sm ? 0 : 0.06) + ({ high: 0.04, medium: 0.02 }[m.news?.risk] || 0);
  const out = [];
  for (const mk of m.markets) {
    if (kinds && !kinds.includes(mk.kind)) continue;
    const sumTo = mk.sumTo || 1;
    const raw = mk.outcomes.map((x) => Number(pred.p?.[`${mk.mid}:${x.oid}`]));
    const aiOk = hasAi && raw.every((v) => v > 0);
    const rawSum = raw.reduce((a, b) => a + b, 0);
    mk.outcomes.forEach((x, i) => {
      if (!usable(mk, x, o)) return;
      const src = { market: x.fair };
      if (aiOk) src.ai = Math.min(0.99, (raw[i] / rawSum) * sumTo);
      const sp = sm?.prob(mk, x);
      if (sp != null) src.stats = sp;
      const w = { market: W.market, ai: aiOk ? W.ai : 0, stats: sp != null ? W.stats * sm.conf : 0 };
      const wSum = w.market + w.ai + w.stats;
      const blend = (w.market * src.market + w.ai * (src.ai || 0) + w.stats * (src.stats || 0)) / wSum;
      const vals = Object.values(src);
      const prob = Math.min(0.99, Math.max(0.01, blend - 0.25 * (Math.max(...vals) - Math.min(...vals)) - penalty));
      if (prob < minProb) return;
      const type = resultType(mk, x);
      out.push({
        matchId: m.id, match: `${m.home} v ${m.away}`, league: m.league, start: m.start,
        label: x.label, odds: x.odds, prob, type, score: prob * (pref[type] ?? 1), reason: pred.reason || "", why,
        matchType: m.stats?.kind || "unknown",
        sources: Object.fromEntries(Object.entries(src).map(([k, v]) => [k, Math.round(v * 100) / 100])),
      });
    });
  }
  out.sort((a, b) => b.score - a.score);
  const keep = [];
  let top = 0;
  for (const c of out) if (c.odds > top) { keep.push(c); top = c.odds; }
  return keep.slice(0, 5);
}

// Keeps the k matches with the likeliest legs, with all their candidates.
function topPool(cands, k) {
  const by = new Map();
  for (const c of cands) (by.get(c.matchId) ?? by.set(c.matchId, []).get(c.matchId)).push(c);
  return [...by.values()]
    .sort((a, b) => Math.max(...b.map((x) => x.score)) - Math.max(...a.map((x) => x.score)))
    .slice(0, k).flat();
}

// The slip with the highest combined probability whose total odds land between the target and the target plus
// `tol` (0.08 = up to 8% above), using between min and max legs, one per match. Dynamic programming over
// (legs used, log odds reached). Each leg's log odds are rounded down, so a slip it returns always really does
// reach the target, and the overshoot stays within tol plus a fraction of a percent. Returns null when no slip fits.
export function optimise(pool, target, min, max, tol = DEFAULTS.tolerance) {
  const STEP = 0.001;
  const need = Math.ceil(Math.log(target) / STEP);
  const hi = Math.max(need, Math.floor(Math.log(target * (1 + tol)) / STEP));
  const Wd = hi + 1;
  const size = (max + 1) * Wd;
  const by = new Map();
  for (const c of pool) {
    const leg = { c, lo: Math.floor(Math.log(c.odds) / STEP), lp: Math.log(c.score ?? c.prob) };
    (by.get(c.matchId) ?? by.set(c.matchId, []).get(c.matchId)).push(leg);
  }
  const groups = [...by.values()];
  let cur = new Float64Array(size).fill(-Infinity);
  cur[0] = 0;
  const trail = [];
  for (const g of groups) {
    const next = new Float64Array(size).fill(-Infinity);
    const choice = new Int8Array(size).fill(-1);
    for (let c = 0; c <= max; c++) {
      const row = c * Wd;
      for (let b = 0; b <= hi; b++) {
        const v = cur[row + b];
        if (v === -Infinity) continue;
        if (v > next[row + b]) { next[row + b] = v; choice[row + b] = -1; }
        if (c < max) {
          for (let j = 0; j < g.length; j++) {
            const nb = b + g[j].lo;
            if (nb > hi) continue;
            const nk = (c + 1) * Wd + nb;
            const nv = v + g[j].lp;
            if (nv > next[nk]) { next[nk] = nv; choice[nk] = j; }
          }
        }
      }
    }
    trail.push(choice);
    cur = next;
  }
  let bestC = -1;
  let bestB = -1;
  let bestV = -Infinity;
  for (let c = min; c <= max; c++) {
    for (let b = need; b <= hi; b++) {
      const v = cur[c * Wd + b]; // strict ">" keeps the lowest b on a tie, which is the closest to the target
      if (v > bestV) { bestV = v; bestC = c; bestB = b; }
    }
  }
  if (bestC < 0) return null;
  const legs = [];
  let c = bestC;
  let b = bestB;
  for (let i = groups.length - 1; i >= 0; i--) {
    const j = trail[i][c * Wd + b];
    if (j >= 0) { legs.push(groups[i][j].c); b -= groups[i][j].lo; c--; }
  }
  legs.reverse();
  const odds = legs.reduce((a, l) => a * l.odds, 1);
  const prob = legs.reduce((a, l) => a * l.prob, 1);
  return { legs, odds, prob, expected: prob * odds };
}

// Tries the requested tolerance first. If nothing fits, widens it step by step and reports the tolerance it needed.
export function optimiseNear(pool, target, min, max, tol = DEFAULTS.tolerance) {
  for (const t of [tol, Math.max(tol * 3, 0.25), 1, 4]) {
    const r = optimise(pool, target, min, max, t);
    if (r) return { ...r, tol: t };
  }
  return null;
}

// When the rules cannot be met, a slip is still returned:
//  1. "relaxed": the minimum leg count is dropped (there are not enough usable matches) and the target is still reached.
//  2. "closest": the target is out of reach, so this is the highest-odds slip the matches allow (longest leg of every match).
// The result says which one it is, so the slip is never mistaken for one that met the rules.
export function fallbackSlip(pool, target, min, max, tol = DEFAULTS.tolerance) {
  const n = new Set(pool.map((l) => l.matchId)).size;
  if (!n) return null;
  const hi = Math.max(max, n);
  const r = optimiseNear(pool, target, 1, hi, tol);
  if (r) {
    return { ...r, kind: "relaxed", range: { min: 1, max: hi },
      relaxed: `Could not reach ${target}x with at least ${min} legs from ${n} usable matches, so this slip has ${r.legs.length} legs and a lower win chance than a full slip would have.` };
  }
  const best = new Map();
  for (const c of pool) if (!best.has(c.matchId) || c.odds > best.get(c.matchId).odds) best.set(c.matchId, c);
  const legs = [...best.values()].sort((a, b) => b.odds - a.odds);
  const odds = legs.reduce((a, l) => a * l.odds, 1);
  const prob = legs.reduce((a, l) => a * l.prob, 1);
  return { legs, odds, prob, expected: prob * odds, kind: "closest", range: { min: 1, max: hi },
    relaxed: `${target}x is out of reach with ${legs.length} usable matches. This is the highest-odds slip they allow (${odds.toFixed(2)}x), so its win chance is low.` };
}

export function poolFor(matches, preds, kinds, used, max, opts = {}) {
  const k = opts.pool || 2 * max + 4;
  const cands = matches.filter((m) => !used.has(m.id)).flatMap((m) => candidatesFor(m, preds[m.id] || {}, kinds, opts));
  return topPool(cands, k);
}

export function shortNote(pool, target, min, max, minProb) {
  const legs = new Set(pool.map((l) => l.matchId)).size;
  const best = new Map();
  for (const c of pool) if (!best.has(c.matchId) || c.odds > best.get(c.matchId).odds) best.set(c.matchId, c);
  const reach = [...best.values()].sort((a, b) => b.odds - a.odds).slice(0, max).reduce((a, l) => a * l.odds, 1);
  const floor = minProb > 0 ? ` with a ${Math.round(minProb * 100)}% floor per leg` : "";
  if (!legs) return `No usable legs${floor}. Try a longer window, a wider odds range per leg or more matches.`;
  if (legs < min) return `Only ${legs} real matches had usable legs${floor} and ${min} are needed. Try a longer window or a lower minimum.`;
  return `No combination of ${min} to ${max} legs reaches ${target}x${floor}. The best available is about ${reach.toFixed(2)}x. Try a longer window, a higher odds limit per leg or a lower target.`;
}