const HOST = "https://api.oddspapi.io/v4";
export const BOOKS = {
  sportybet: process.env.SPORTYBET_SLUG || "sportybet",
  stake: process.env.STAKE_SLUG || "stake",
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Cached to protect the free tier quota (250 requests per month).
async function get(path, params, revalidate = 3600) {
  const qs = new URLSearchParams({ ...params, apiKey: process.env.ODDSPAPI_KEY });
  const res = await fetch(`${HOST}${path}?${qs}`, { next: { revalidate } });
  if (!res.ok) throw new Error(`OddsPapi ${path} failed with status ${res.status}`);
  return res.json();
}

// Full time result, double chance, both teams to score and goal totals (1.5 to 4.5).
async function getCatalog() {
  const rows = await get("/markets", { sportId: 10 }, 86400);
  const wanted = /Full Time Result|Double Chance|Both Teams To Score|Over Under Full Time/i;
  const out = new Map();
  for (const m of rows) {
    if (m.sportId !== 10 || m.playerProp || m.period !== "fulltime" || !wanted.test(m.marketName)) continue;
    const totals = /Over Under/i.test(m.marketName);
    if (totals && (m.handicap < 1.5 || m.handicap > 4.5)) continue;
    out.set(String(m.marketId), {
      name: totals ? `Over/Under ${m.handicap}` : m.marketName,
      handicap: m.handicap, outcomes: m.outcomes,
      kind: totals ? "totals" : /Both Teams/i.test(m.marketName) ? "btts" : "result",
    });
  }
  return out;
}

function label(mk, o, home, away) {
  const n = o.outcomeName;
  if (/Full Time Result/i.test(mk.name)) return n === "1" ? `${home} to win` : n === "2" ? `${away} to win` : "Draw";
  if (mk.kind === "totals") return `${n} ${mk.handicap} goals`;
  if (mk.kind === "btts") return `Both teams to score: ${n}`;
  return `${mk.name}: ${n}`;
}

export async function getMatches(book, limit = 30) {
  const slug = BOOKS[book];
  if (!slug) throw new Error("Unknown bookmaker");
  const catalog = await getCatalog();
  const from = new Date();
  const to = new Date(from.getTime() + 47 * 3600 * 1000);
  const fixtures = await get("/fixtures", {
    sportId: 10, from: from.toISOString(), to: to.toISOString(),
    statusId: 0, hasOdds: true, bookmakers: slug,
  });
  const byId = new Map(fixtures.map((f) => [f.fixtureId, f]));
  const tids = [...new Set(fixtures.map((f) => f.tournamentId))].slice(0, 12);
  const matches = [];
  for (let i = 0; i < tids.length; i += 4) {
    await sleep(2100);
    const rows = await get("/odds-by-tournaments", {
      bookmaker: slug, tournamentIds: tids.slice(i, i + 4).join(","),
    });
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
            ? { oid: String(o.outcomeId), label: label(mk, o, fx.participant1Name, fx.participant2Name), odds: p.price }
            : null;
        });
        if (items.some((x) => !x)) continue; // need every outcome to remove the margin
        const inv = items.reduce((a, x) => a + 1 / x.odds, 0);
        markets.push({
          mid, name: mk.name, kind: mk.kind,
          outcomes: items.map((x) => ({ ...x, fair: 1 / x.odds / inv })),
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
