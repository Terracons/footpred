const HOST = "https://v3.football.api-sports.io";
const norm = (s) => String(s).toLowerCase().normalize("NFD").replace(/[^a-z0-9]/g, "");

async function api(path, params, revalidate) {
  const res = await fetch(`${HOST}${path}?${new URLSearchParams(params)}`, {
    headers: { "x-apisports-key": process.env.APIFOOTBALL_KEY },
    next: { revalidate },
  });
  if (!res.ok) throw new Error(`API-Football ${path} failed with status ${res.status}`);
  const j = await res.json();
  const errs = Array.isArray(j.errors) ? [] : Object.values(j.errors || {});
  if (errs.length) throw new Error(`API-Football: ${errs[0]}`);
  return j.response || [];
}

// Team names come from OddsPapi, so match them by name. Skip the match if the name is ambiguous.
async function teamId(name) {
  const rows = await api("/teams", { search: name }, 604800);
  const hit = rows.find((r) => norm(r.team.name) === norm(name)) || (rows.length === 1 ? rows[0] : null);
  return hit ? hit.team.id : null;
}

async function form(id) {
  const rows = (await api("/fixtures", { team: id, last: 5 }, 43200))
    .sort((a, b) => new Date(a.fixture.date) - new Date(b.fixture.date));
  let scored = 0;
  let conceded = 0;
  const res = rows.map((r) => {
    const home = r.teams.home.id === id;
    const gf = (home ? r.goals.home : r.goals.away) ?? 0;
    const ga = (home ? r.goals.away : r.goals.home) ?? 0;
    scored += gf;
    conceded += ga;
    return gf > ga ? "W" : gf < ga ? "L" : "D";
  });
  return `${res.join("") || "no games"} (scored ${scored}, conceded ${conceded})`;
}

async function h2h(a, b) {
  const rows = (await api("/fixtures/headtohead", { h2h: `${a}-${b}`, last: 5 }, 43200))
    .sort((x, y) => new Date(x.fixture.date) - new Date(y.fixture.date));
  return rows.length ? rows.map((r) => `${r.teams.home.name} ${r.goals.home}-${r.goals.away} ${r.teams.away.name}`).join("; ") : "no recent meetings";
}

// Adds a short past performance summary to the soonest matches. About 5 requests per match, cached.
export async function enrich(matches, limit = 8) {
  let count = 0;
  let warning = "";
  const todo = matches.slice(0, limit);
  for (let i = 0; i < todo.length; i += 2) {
    await Promise.all(todo.slice(i, i + 2).map(async (m) => {
      try {
        const [a, b] = await Promise.all([teamId(m.home), teamId(m.away)]);
        if (!a || !b) return;
        const [fa, fb, hh] = await Promise.all([form(a), form(b), h2h(a, b)]);
        m.context = `${m.home} last 5, oldest to newest: ${fa}. ${m.away} last 5: ${fb}. Head to head, latest last: ${hh}.`;
        count++;
      } catch (e) {
        warning ||= e.message;
      }
    }));
  }
  return { count, warning };
}