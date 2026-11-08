import { getMatches } from "../../../lib/odds.js";
import { predict } from "../../../lib/ai.js";
import { enrich } from "../../../lib/stats.js";
import { enrichAll } from "../../../lib/enrich.js";
import { prepare, solve } from "../../../lib/pipeline.js";
import { isSimulated, DEFAULTS, parseMarkets } from "../../../lib/slips.js";
import { researchNews } from "../../../lib/news.js";
import { recordRun } from "../../../lib/ledger.js";

// Past stats for up to 100 matches, AI predictions and one selector call per target all happen in this request.
// Raise this as far as your hosting plan allows.
export const maxDuration = 300;

const blank = (v) => v === undefined || v === null || String(v).trim() === "";
// A number from the request, kept inside lo and hi. Falls back to d when it is missing or not a number.
const num = (v, lo, hi, d) => {
  if (blank(v) || !Number.isFinite(Number(v))) return d;
  return Math.min(hi, Math.max(lo, Number(v)));
};

export async function POST(req) {
  const body = await req.json().catch(() => ({}));
  const targets = [...new Set((body.targets || []).map(Number))]
    .filter((n) => n >= 2 && n <= 1000).sort((a, b) => a - b).slice(0, 5);
  const models = [...new Set((body.models || []).map((m) => String(m).trim()))].filter(Boolean).slice(0, 4);
  if (!targets.length || !models.length) {
    return Response.json({ error: "Pick at least one target and one model." }, { status: 400 });
  }
  // body.markets: "all", or one or more keys such as ["dc_no12", "under"] (see MARKET_OPTIONS in lib/slips.js).
  // Legacy values "totals" and "result" still work.
  const parsed = parseMarkets(body.markets);
  const kinds = parsed.sel;
  if (parsed.unknown.length) return Response.json({ error: `Unknown market: ${parsed.unknown.join(", ")}` }, { status: 400 });
  if (kinds && !kinds.length) return Response.json({ error: "Pick at least one market." }, { status: 400 });
  // Time window: any number of hours (1 to 168), starting now or a number of hours from now (0 to 96). OddsPapi reads at most 10 days at a time.
  const fromHours = Math.round(num(body.fromHours, 0, 96, 0));
  const hours = Math.min(Math.round(num(body.hours, 1, 168, 47)), 240 - fromHours);
  const leagues = String(body.leagues || "").slice(0, 200);
  const matchLimit = Math.round(num(body.matchLimit, 10, 100, DEFAULTS.maxEnrich));
  const compare = body.mode === "compare" && models.length > 1;
  const unique = body.unique !== false;
  // Optional AI selector. Send body.selector, or set SELECTOR_MODEL. "none" turns it off.
  const picked = String(body.selector || process.env.SELECTOR_MODEL || models[0]).trim();
  const selectorModel = picked === "none" ? null : picked;
  // Web news from Tavily (set TAVILY_API_KEY). At most TAVILY_MAX_CALLS searches per request, one per match, default 10.
  // No AI call is spent on news: the predictors read the snippets and rate each team. news:false turns it off.
  const newsCalls = body.news === false ? 0 : Math.max(0, Math.min(Number(body.newsCalls) || 10, Number(process.env.TAVILY_MAX_CALLS) || 10));

  // Everything the user can set. Blank leg limits mean automatic (1 to 30 legs). A blank top price per leg means no cap.
  const opts = {
    maxEnrich: matchLimit,
    requireStats: body.requireStats !== false,
    allowDraw: body.allowDraw === true,
    prefer1X: body.prefer1X !== false,
    basis: body.basis === "balanced" ? "balanced" : "led",
    tolerance: num(body.tolerance, 0, 50, DEFAULTS.tolerance * 100) / 100,
    minLegOdds: num(body.minLegOdds, 1.01, 5, DEFAULTS.minLegOdds),
    maxLegOdds: body.maxLegOdds === undefined ? DEFAULTS.maxLegOdds : num(body.maxLegOdds, 1.05, 100, Infinity),
    newsCalls,
  };
  if (body.prefer1X === false) opts.pref = {}; // no preference for 1, 2, 1X, X2 over 12
  if (!blank(body.minLegs)) opts.minLegs = Math.round(num(body.minLegs, 1, 40, 1));
  if (!blank(body.maxLegs)) opts.maxLegs = Math.round(num(body.maxLegs, 1, 40, 30));
  if (opts.minLegs && opts.maxLegs && opts.maxLegs < opts.minLegs) opts.maxLegs = opts.minLegs;
  if (body.minProb != null && Number(body.minProb) >= 0 && Number(body.minProb) <= 0.95) opts.minProb = Number(body.minProb);

  // From here the answer is streamed, one JSON object per line: a "plan", a "stage" event as each stage starts, and finally
  // "result" or "error". The page turns these into its progress bar and time estimate. Problems found above (bad input)
  // are still ordinary JSON responses with a status code.
  const stages = ["odds", "stats", ...(newsCalls > 0 ? ["news"] : []), "ai", "slips"];
  const fail = (error) => new Error(error);
  const work = async (send) => {
    send({ type: "plan", stages, n: matchLimit, models: models.length, targets: targets.length, news: newsCalls, selector: !!selectorModel });
    send({ type: "stage", id: "odds" });
    const upcoming = (await getMatches(hours, matchLimit, fromHours, leagues)).filter((m) => new Date(m.start) > new Date());
    const matches = upcoming.filter((m) => !isSimulated(m)).map((m) => ({ ...m }));
    const skipped = upcoming.length - matches.length;
    if (matches.length < 3) {
      throw fail(`Only ${matches.length} real (non-simulated) Stake matches with odds between ${fromHours} and ${fromHours + hours} hours from now. Try a longer window or clear the league filter.`);
    }

    // Stages 1 and 2, once: past performance, league position and match type for every match, then the stats ranking.
    // Past data is always collected. The API-Football source only returns text, so it cannot feed the stats model.
    const useApi = process.env.FORM_SOURCE === "apifootball" && process.env.APIFOOTBALL_KEY;
    if (useApi) opts.requireStats = false;
    const form = useApi
      ? (list) => enrich(list, Number(process.env.FORM_MATCHES) || list.length)
      : (list, n, sport) => enrichAll(list, Number(process.env.FORM_MATCHES) || n, sport);
    send({ type: "stage", id: "stats", n: Math.min(matches.length, opts.maxEnrich) });
    const prep = await prepare({ matches, kinds, opts, enrich: form });
    const warnings = [...prep.warnings];
    if (useApi) warnings.unshift("FORM_SOURCE is apifootball, which gives form text only. The stats model was skipped and picks use the market and AI.");
    if (skipped) warnings.unshift(`Skipped ${skipped} simulated (SRL or virtual) matches. Their results are random, so stats and form mean nothing.`);
    if (!prep.list.length) {
      throw fail(`No match had usable past data. ${prep.warnings.join(" ")}`.trim());
    }

    // Stage 3a: web news for the best ranked matches, before the AI predictors so they can read it.
    let newsInfo = { count: 0, calls: 0 };
    if (newsCalls > 0) {
      send({ type: "stage", id: "news" });
      newsInfo = await researchNews(prep.list, { maxCalls: newsCalls });
      if (newsInfo.warning) warnings.push(newsInfo.warning);
    }

    // Stage 3b: every model predicts the selected matches.
    send({ type: "stage", id: "ai" });
    const results = await Promise.allSettled(models.map((m) => predict(m, prep.list)));
    const ok = [];
    results.forEach((r, i) => {
      if (r.status === "fulfilled") {
        ok.push({ model: models[i], preds: r.value });
        if (r.value.warnings?.length) warnings.push(`${models[i]}: ${r.value.warnings.join("; ")}`);
      }
      else warnings.push(`${models[i]}: ${r.reason.message}`);
    });
    if (!ok.length) {
      // No AI answer. Slips can still be built from the stats model and the market.
      warnings.push("No AI model answered, so slips use the stats model and the market only.");
      ok.push({ model: "stats only", preds: {} });
    }

    // Stage 4: best combination plus AI selector, per model in compare mode, otherwise on the merged predictions.
    send({ type: "stage", id: "slips" });
    const groups = compare
      ? ok.map((o) => ({ model: o.model, predsList: [o.preds] }))
      : [{ model: ok.map((o) => o.model).join(" + "), predsList: ok.map((o) => o.preds) }];
    const sets = await Promise.all(groups.map(async (g) => ({
      model: g.model,
      slips: await solve({ list: prep.list, predsList: g.predsList, selectorModel, kinds, targets, unique, opts, title: g.model }),
    })));

    // History: log every outcome of every analysed match and the slips shown, so results can be settled later (npm run settle).
    const ledger = await recordRun({
      list: prep.list, predsList: ok.map((o) => o.preds), sets,
      meta: { targets, models, selector: selectorModel, markets: body.markets ?? "all", window: { fromHours, hours }, opts: { minLegOdds: opts.minLegOdds } },
    });
    if (ledger.error) warnings.push(`History log not written: ${ledger.error}`);

    const marketsSeen = matches.reduce((a, m) => a + m.markets.length, 0);
    return {
      matches: matches.length, shortlisted: prep.list.length, marketsSeen, enriched: prep.enriched,
      window: { fromHours, hours },
      selector: selectorModel, news: { calls: newsInfo.calls, matches: newsInfo.count }, sets, warnings,
    };
  };

  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (o) => controller.enqueue(enc.encode(`${JSON.stringify(o)}\n`));
      try { send({ type: "result", data: await work(send) }); }
      catch (e) { send({ type: "error", error: e.message }); }
      controller.close();
    },
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store, no-transform" } });
}