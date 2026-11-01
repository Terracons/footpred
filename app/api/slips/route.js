import { getMatches } from "../../../lib/odds.js";
import { predict } from "../../../lib/ai.js";
import { buildSlips } from "../../../lib/slips.js";

export const maxDuration = 60;

const KINDS = { totals: ["totals"], result: ["result"] }; // anything else means all markets

export async function POST(req) {
  const body = await req.json().catch(() => ({}));
  const targets = [...new Set((body.targets || []).map(Number))]
    .filter((n) => n >= 2 && n <= 1000).sort((a, b) => a - b).slice(0, 5);
  const models = [...new Set((body.models || []).map((m) => String(m).trim()))].filter(Boolean).slice(0, 4);
  if (!targets.length || !models.length) {
    return Response.json({ error: "Pick at least one target and one model." }, { status: 400 });
  }
  const kinds = KINDS[body.markets] || null;
  const hours = [12, 24, 47].includes(Number(body.hours)) ? Number(body.hours) : 47;
  const compare = body.mode === "compare" && models.length > 1;
  const unique = body.unique !== false;
  try {
    const matches = await getMatches(hours);
    if (matches.length < 5) {
      return Response.json({ error: `Only ${matches.length} Stake matches with odds in the next ${hours} hours. Try a longer window.` }, { status: 404 });
    }
    const results = await Promise.allSettled(models.map((m) => predict(m, matches)));
    const ok = [];
    const warnings = [];
    results.forEach((r, i) => {
      if (r.status === "fulfilled") ok.push({ model: models[i], preds: r.value });
      else warnings.push(`${models[i]}: ${r.reason.message}`);
    });
    if (!ok.length) return Response.json({ error: warnings.join(" | ") }, { status: 502 });
    const sets = compare
      ? ok.map((o) => ({ model: o.model, slips: buildSlips(matches, [o.preds], kinds, targets, unique) }))
      : [{ model: ok.map((o) => o.model).join(" + "), slips: buildSlips(matches, ok.map((o) => o.preds), kinds, targets, unique) }];
    const marketsSeen = matches.reduce((a, m) => a + m.markets.length, 0);
    return Response.json({ matches: matches.length, marketsSeen, sets, warnings });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
