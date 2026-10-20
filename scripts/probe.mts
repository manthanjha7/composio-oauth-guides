/** Usage: npx tsx scripts/probe.ts <url> [purpose]  -> prints a probe record (same code path as the agent's probe_url tool). */
import { probe } from "../src/lib/web";

const [url, ...purpose] = process.argv.slice(2);
if (!url) {
  console.error("usage: tsx scripts/probe.ts <url> [purpose]");
  process.exit(1);
}
const r = await probe(url);
console.log(JSON.stringify({ url: r.url, purpose: purpose.join(" "), status: r.status, location: r.location, observation: r.observation, at: new Date().toISOString() }, null, 2));
