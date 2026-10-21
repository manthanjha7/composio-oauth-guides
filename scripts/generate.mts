/**
 * Usage: npx tsx --env-file=.env.local scripts/generate.mts [--v2] [--model <id>] "<app name or website>"
 * Runs the agent (v1 by default, v2 with --v2), prints its events, and saves the guide to the local store.
 * --model runs every v2 stage on one model for this run, e.g. --model claude-opus-5-5. USES THE MODEL (costs money).
 */
import { runAgentV2 } from "../src/lib/agent/pipeline";
import { runAgent } from "../src/lib/agent/run";
import { listSeedGuides, saveGuide } from "../src/lib/store";

const args = process.argv.slice(2);
const v2 = args.includes("--v2") || process.env.AGENT_VERSION === "v2";
const mi = args.indexOf("--model");
const model = mi >= 0 ? args[mi + 1] : undefined;
const query = args.filter((a, i) => a !== "--v2" && !(mi >= 0 && (i === mi || i === mi + 1))).join(" ");
if (!query) {
  console.error('usage: tsx --env-file=.env.local scripts/generate.mts "<app>"');
  process.exit(1);
}
const t0 = Date.now();
const result = await (v2 ? runAgentV2 : runAgent)({
  query,
  ...(v2 && model ? { models: { all: model } } : {}),
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
