import { getMatches } from "../../../lib/odds.js";
import { predict } from "../../../lib/ai.js";
import { buildSlips } from "../../../lib/slips.js";

export const maxDuration = 60;

const KINDS = { totals: ["totals"], result: ["result"] }; // anything else means all markets

export async function GET(req) {
  const { searchParams } = new URL(req.url);
  const book = searchParams.get("book") || "sportybet";
  const model = searchParams.get("model") || process.env.DEFAULT_MODEL || "anthropic/claude-sonnet-4.5";
  const kinds = KINDS[searchParams.get("markets")] || null;
  try {
    const matches = await getMatches(book);
    if (matches.length < 5) {
      return Response.json({ error: "Not enough fixtures with odds in the next 47 hours." }, { status: 404 });
    }
    const preds = await predict(model, matches);
    const marketsSeen = matches.reduce((a, m) => a + m.markets.length, 0);
    return Response.json({ book, model, matches: matches.length, marketsSeen, slips: buildSlips(matches, preds, kinds) });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
