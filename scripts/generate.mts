/**
 * Usage: npx tsx --env-file=.env.local scripts/generate.mts "<app name or website>"
 * Runs the same agent as /api/generate, prints its events, and saves the guide to the local store.
 */
import { runAgent } from "../src/lib/agent/run";
import { listSeedGuides, saveGuide } from "../src/lib/store";

const query = process.argv.slice(2).join(" ");
if (!query) {
  console.error('usage: tsx --env-file=.env.local scripts/generate.mts "<app>"');
  process.exit(1);
}
const t0 = Date.now();
const result = await runAgent({
  query,
  emit: (e) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(3)}s] ${e.type}: ${JSON.stringify(e)}`),
});
if (result.outcome === "ok") {
  // Same rule as the API route: never overwrite a seed guide; save the agent's version alongside it.
  if ((await listSeedGuides()).some((g) => g.slug === result.record.slug)) result.record.slug = `${result.record.slug}-agent`;
  await saveGuide(result.record);
  const m = result.record.meta;
  console.log(`\nSAVED ${result.record.slug} | ${result.record.guide.claims.length} claims | quotes ${m.verification.quotes_verified}/${m.verification.quotes_checked} | downgraded ${m.verification.downgraded} | $${m.usage?.usd} | ${Math.round((m.duration_ms ?? 0) / 1000)}s`);
} else {
  console.log(`\nOUTCOME ${result.outcome}: ${JSON.stringify(result)}`);
}
