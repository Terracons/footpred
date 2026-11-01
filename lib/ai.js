const SYSTEM =
  "You are a football analyst. For each match you receive market probabilities for several markets. " +
  "Give your own probability for every listed outcome, using what you know about the teams. " +
  "Outcomes within one market must sum to 1. You have no live data. Reply with JSON only: " +
  '{"predictions":[{"id":"...","p":{"101:101":0.4},"reason":"max 12 words"}]}. ' +
  "Keys are marketId:outcomeId exactly as listed.";

function describe(m) {
  const rows = m.markets.map(
    (mk) => `  ${mk.name}: ` + mk.outcomes.map((o) => `${mk.mid}:${o.oid} ${o.label} ${o.fair.toFixed(2)}`).join(", ")
  );
  return [`${m.id} | ${m.league} | ${m.home} v ${m.away} | ${m.start}`, ...rows].join("\n");
}

export async function predict(model, matches) {
  const out = {};
  const batches = [];
  for (let i = 0; i < matches.length; i += 6) batches.push(matches.slice(i, i + 6));
  await Promise.all(
    batches.map(async (batch) => {
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model, temperature: 0.2, max_tokens: 6000,
          messages: [
            { role: "system", content: SYSTEM },
            { role: "user", content: batch.map(describe).join("\n\n") },
          ],
        }),
      });
      if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const text = (await res.json()).choices?.[0]?.message?.content ?? "";
      try {
        const json = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
        for (const p of json.predictions ?? []) out[p.id] = p;
      } catch {
        throw new Error("The model did not return valid JSON. Try another model.");
      }
    })
  );
  return out;
}
