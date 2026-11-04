import { enrichEspn } from "./espn.js";
import { enrichNinjas } from "./ninjas.js";

// ESPN first. Any match it left empty (no m.context) goes to API Ninjas, when API_NINJAS_KEY is set.
// Returns the same { count, warning } shape as the single sources, plus how many each one covered.
export async function enrichAll(matches, limit = matches.length, sport = "football") {
  const warnings = [];
  const a = await enrichEspn(matches, limit, sport);
  if (a.warning) warnings.push(`ESPN: ${a.warning}`);
  if (!a.count && matches.length) {
    warnings.push(`ESPN returned no data for any of ${matches.length} matches. Its leagues may not cover them, or its endpoints may have changed.`);
  }

  let ninjas = 0;
  const empty = matches.filter((m) => !m.context);
  if (sport === "football" && empty.length) {
    if (!process.env.API_NINJAS_KEY) {
      warnings.push(`${empty.length} matches had no ESPN data and API_NINJAS_KEY is not set, so the fallback was skipped.`);
    } else {
      const b = await enrichNinjas(empty, empty.length);
      ninjas = b.count;
      if (b.warning) warnings.push(`API Ninjas: ${b.warning}`);
      if (!b.count) warnings.push("API Ninjas found nothing for the remaining matches. It does not cover every league (for example Japan's J2 and J3).");
    }
  }
  return { count: a.count + ninjas, espn: a.count, ninjas, warning: warnings.join(" | ") };
}