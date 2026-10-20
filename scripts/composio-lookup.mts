/** Usage: npx tsx scripts/composio-lookup.mts <app name> [slug]  -> same facts the agent's composio_lookup tool returns. */
import { composioLookup } from "../src/lib/composio";

const [name, slug] = process.argv.slice(2);
const r = await composioLookup(name, slug);
console.log(JSON.stringify({ ...r, pages: r.pages.map((p) => ({ url: p.url, chars: p.text.length })) }, null, 2));
