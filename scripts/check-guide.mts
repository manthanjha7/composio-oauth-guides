/**
 * Usage: npx tsx scripts/check-guide.ts data/guides/gmail.json [--write]
 * Validates the file against the schema, then re-fetches every cited page and checks
 * each quote verbatim (same matcher the live agent uses). --write stores the counts
 * in meta.verification.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { baseDomain, quoteInText, supportIssue } from "../src/lib/evidence";
import { GuideRecordSchema } from "../src/lib/schema";
import { fetchPageText } from "../src/lib/web";

const file = process.argv[2];
const write = process.argv.includes("--write");
const raw = JSON.parse(readFileSync(file, "utf8"));
const parsed = GuideRecordSchema.safeParse(raw);
if (!parsed.success) {
  console.error("SCHEMA INVALID:", JSON.stringify(parsed.error.issues.slice(0, 10), null, 2));
  process.exit(2);
}
const rec = parsed.data;
const ids = new Set(rec.guide.claims.map((c) => c.id));
const refs = [
  ...rec.guide.scenarios.flatMap((s) => s.claim_ids),
  ...rec.guide.steps.flatMap((s) => s.claim_ids),
  ...rec.guide.prerequisites.flatMap((s) => s.claim_ids),
  ...rec.guide.traps.flatMap((s) => s.claim_ids),
  ...rec.guide.blockers.flatMap((s) => s.claim_ids),
];
const dangling = refs.filter((r) => !ids.has(r));
if (dangling.length) console.error("DANGLING CLAIM IDS:", [...new Set(dangling)].join(", "));
const probeIds = new Set(rec.meta.probes.map((p) => p.id));
// Official domains: the provider's website and docs host, plus any extra passed as --official=a.com,b.dev
const extra = (process.argv.find((a) => a.startsWith("--official=")) ?? "").replace("--official=", "").split(",").filter(Boolean);
const official = new Set([rec.guide.app.website, rec.guide.app.developer_docs_url, ...extra].filter((x): x is string => !!x).map(baseDomain));

const cache = new Map<string, string | Error>();
let checked = 0, verified = 0;
const failures: string[] = [];
for (const c of rec.guide.claims) {
  if (c.label === "probed" && (!c.probe_id || !probeIds.has(c.probe_id))) failures.push(`${c.id}: probed claim without a recorded probe`);
  if (c.label !== "provider_docs" && c.label !== "composio_docs") continue;
  checked++;
  if (!c.quote || !c.source_url) { failures.push(`${c.id}: missing quote/source`); continue; }
  if (!cache.has(c.source_url)) {
    try { cache.set(c.source_url, (await fetchPageText(c.source_url)).text); }
    catch (e) { cache.set(c.source_url, e as Error); }
  }
  const page = cache.get(c.source_url)!;
  if (page instanceof Error) { failures.push(`${c.id}: could not fetch ${c.source_url} (${page.message})`); continue; }
  if (!quoteInText(c.quote, page)) {
    failures.push(`${c.id}: quote NOT found on ${c.source_url}\n      "${c.quote.slice(0, 160)}"`);
    continue;
  }
  const issue = supportIssue(c.text, c.quote);
  if (issue) {
    failures.push(`${c.id}: ${issue}\n      claim: "${c.text.slice(0, 160)}"\n      quote: "${c.quote.slice(0, 160)}"`);
    continue;
  }
  if (c.label === "composio_docs" && baseDomain(c.source_url) !== "composio.dev") {
    failures.push(`${c.id}: composio_docs claim cites a non-Composio page ${c.source_url}`);
    continue;
  }
  if (c.label === "provider_docs" && official.size && !official.has(baseDomain(c.source_url))) {
    failures.push(`${c.id}: provider_docs claim cites a non-official domain ${baseDomain(c.source_url)} (official: ${[...official].join(", ")})`);
    continue;
  }
  verified++;
}
console.log(`${file}: ${rec.guide.claims.length} claims, ${checked} quoted, ${verified} verified on live pages, ${failures.length} problems`);
failures.forEach((f) => console.log("  - " + f));
if (write) {
  rec.meta.verification = { claims_total: rec.guide.claims.length, quotes_checked: checked, quotes_verified: verified, downgraded: rec.meta.verification.downgraded };
  writeFileSync(file, JSON.stringify(rec, null, 2) + "\n");
}
process.exit(failures.length || dangling.length ? 1 : 0);
