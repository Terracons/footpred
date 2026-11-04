import { unstable_cache } from "next/cache";

const HOST = "https://api.oddspapi.io/v4";
const SLUG = process.env.STAKE_SLUG || "stake";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Small responses are cached. Pass revalidate 0 for huge ones, which Next cannot cache (2MB limit).
async function get(path, params, revalidate = 3600) {
  if (!process.env.ODDSPAPI_KEY) throw new Error("ODDSPAPI_KEY is not set");
  const qs = new URLSearchParams({ ...params, apiKey: process.env.ODDSPAPI_KEY });
  const res = await fetch(`${HOST}${path}?${qs}`, revalidate ? { next: { revalidate } } : { cache: "no-store" });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 150);
    throw new Error(`OddsPapi ${path} ${JSON.stringify(params)} failed with status ${res.status} ${body}`);
  }
  return res.json();
}

// Used when the market list endpoint is unavailable. IDs come from OddsPapi docs and examples.
const FALLBACK = new Map([
  ["101", { name: "Full Time Result", handicap: 0, kind: "result",
    outcomes: [{ outcomeId: 101, outcomeName: "1" }, { outcomeId: 102, outcomeName: "X" }, { outcomeId: 103, outcomeName: "2" }] }],
  ["104", { name: "Both Teams To Score", handicap: 0, kind: "btts",
    outcomes: [{ outcomeId: 104, outcomeName: "Yes" }, { outcomeId: 105, outcomeName: "No" }] }],
  ["1010", { name: "Over/Under 2.5", handicap: 2.5, kind: "totals",
    outcomes: [{ outcomeId: 1010, outcomeName: "Over" }, { outcomeId: 1011, outcomeName: "Under" }] }],
]);

// Full time result, double chance, both teams to score and goal totals (1.5 to 4.5).
async function getCatalog() {
  let rows = null;
  for (const params of [{ sportId: 10 }, {}]) {
    try {
      rows = await get("/markets", params, 86400);
      break;
    } catch (e) {
      if (/not set/.test(e.message)) throw e;
    }
  }
  if (!rows) return FALLBACK;
  const wanted = /Full Time Result|Double Chance|Both Teams To Score|Over Under Full Time/i;
  const out = new Map();
  for (const m of rows) {
    if ((m.sportId !== undefined && m.sportId !== 10) || m.playerProp || m.period !== "fulltime" || !wanted.test(m.marketName)) continue;
    const totals = /Over Under/i.test(m.marketName);
    if (totals && (m.handicap < 1.5 || m.handicap > 4.5)) continue;
    out.set(String(m.marketId), {
      name: totals ? `Over/Under ${m.handicap}` : m.marketName,
      handicap: m.handicap, outcomes: m.outcomes,
      kind: totals ? "totals" : /Both Teams/i.test(m.marketName) ? "btts" : "result",
    });
  }
  return out.size ? out : FALLBACK;
}

function label(mk, o, home, away) {
  const n = o.outcomeName;
  if (/Full Time Result/i.test(mk.name)) return n === "1" ? `${home} to win` : n === "2" ? `${away} to win` : "Draw";
  if (mk.kind === "totals") return `${n} ${mk.handicap} goals`;
  if (mk.kind === "btts") return `Both teams to score: ${n}`;
  return `${mk.name}: ${n}`;
}

// hours: how long the window is. fromHours: how many hours from now it starts. leagues: optional comma separated words,
// a fixture is kept when its league or team names contain one of them. A word starting with "-" removes matches instead.
async function loadMatches(hours = 47, limit = 60, fromHours = 0, leagues = "") {
  const slug = SLUG;
  const catalog = await getCatalog();
  const now = new Date();
  const begin = new Date(now.getTime() + fromHours * 3600 * 1000);
  const cutoff = new Date(begin.getTime() + hours * 3600 * 1000);
  const day = (d) => d.toISOString().slice(0, 10); // date only, as in the OddsPapi docs
  // OddsPapi allows at most 10 days between from and to.
  const to = new Date(Math.min(cutoff.getTime() + 86400000, begin.getTime() + 10 * 86400000));
  const range = { sportId: 10, from: day(begin), to: day(to), statusId: 0 };
  const terms = String(leagues || "").toLowerCase().split(",").map((t) => t.trim()).filter(Boolean);
  const want = terms.filter((t) => !t.startsWith("-"));
  const skip = terms.filter((t) => t.startsWith("-")).map((t) => t.slice(1).trim()).filter(Boolean);
  const keep = (f) => {
    const text = `${f.tournamentName} ${f.participant1Name} ${f.participant2Name}`.toLowerCase();
    return (!want.length || want.some((t) => text.includes(t))) && !skip.some((t) => text.includes(t));
  };
  let fixtures;
  try {
    fixtures = await get("/fixtures", { ...range, hasOdds: true, bookmakers: slug });
  } catch (e) {
    if (!/status 404/.test(e.message)) throw e;
    await sleep(2100);
    fixtures = await get("/fixtures", range); // retry without the bookmaker filter
  }
  if (!Array.isArray(fixtures)) throw new Error("OddsPapi /fixtures returned an unexpected response");
  fixtures = fixtures.filter((f) => new Date(f.startTime) > begin && new Date(f.startTime) < cutoff && keep(f));
  if (!fixtures.length) throw new Error(`No Stake fixtures with odds found between ${fromHours} and ${fromHours + hours} hours from now${terms.length ? ` for the league filter "${leagues}"` : ""}`);
  const byId = new Map(fixtures.map((f) => [f.fixtureId, f]));
  const counts = {};
  fixtures.forEach((f) => { counts[f.tournamentId] = (counts[f.tournamentId] || 0) + 1; });
  const maxT = Math.min(40, Math.max(12, Math.ceil(limit / 2.5))); // more matches wanted means more leagues read (4 per request)
  const tids = Object.keys(counts).sort((x, y) => counts[y] - counts[x]).slice(0, maxT); // busiest leagues first
  const matches = [];
  for (let i = 0; i < tids.length; i += 4) {
    await sleep(2100);
    const rows = await get("/odds-by-tournaments", {
      bookmaker: slug, tournamentIds: tids.slice(i, i + 4).join(","),
    }, 0);
    for (const row of rows) {
      const fx = byId.get(row.fixtureId);
      if (!fx) continue;
      const bm = row.bookmakerOdds?.[slug]?.markets ?? {};
      const markets = [];
      for (const [mid, mk] of catalog) {
        const outs = bm[mid]?.outcomes;
        if (!outs) continue;
        const items = mk.outcomes.map((o) => {
          const p = outs[o.outcomeId]?.players?.["0"];
          return p && p.active !== false && p.price > 1
            ? { oid: String(o.outcomeId), n: o.outcomeName, label: label(mk, o, fx.participant1Name, fx.participant2Name), odds: p.price }
            : null;
        });
        if (items.some((x) => !x)) continue; // need every outcome to remove the margin
        const inv = items.reduce((a, x) => a + 1 / x.odds, 0);
        const sumTo = /Double Chance/i.test(mk.name) ? 2 : 1; // two of three outcomes win in double chance
        markets.push({
          mid, name: mk.name, kind: mk.kind, handicap: mk.handicap, sumTo,
          outcomes: items.map((x) => ({ ...x, fair: (sumTo / x.odds) / inv })),
        });
      }
      if (!markets.length) continue;
      matches.push({
        id: row.fixtureId, home: fx.participant1Name, away: fx.participant2Name,
        league: fx.tournamentName, start: fx.startTime, markets,
      });
    }
  }
  return matches.sort((a, b) => a.start.localeCompare(b.start)).slice(0, limit);
}

// The processed matches are small, so cache those for 15 minutes (odds move, so not longer) instead of the raw responses.
export const getMatches = unstable_cache(loadMatches, ["stake-matches-v4"], { revalidate: 900 });