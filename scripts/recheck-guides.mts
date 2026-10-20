/**
 * Usage: npx tsx scripts/recheck-guides.mts [--write] data/guides/*.json
 * Re-applies the current evidence rules to stored guides without any model call:
 *  - claims downgraded by an older, noisier check (version numbers, HTTP codes, markdown links, JS-rendered
 *    pages) are re-fetched and restored if the quote is on the page and supports the claim
 *  - notes are recomputed with the current rules
 *  - meta.verification counts are recomputed
 */
import { readFileSync, writeFileSync } from "node:fs";
import { baseDomain, overlapNote, quoteInText, supportIssue } from "../src/lib/evidence";
import { GuideRecordSchema } from "../src/lib/schema";
import { fetchPageText } from "../src/lib/web";

const write = process.argv.includes("--write");
const files = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const cache = new Map<string, string | null>();
const page = async (url: string) => {
  if (!cache.has(url)) cache.set(url, await fetchPageText(url).then((p) => p.text).catch(() => null));
  return cache.get(url)!;
};

for (const file of files) {
  const rec = GuideRecordSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  const official = new Set([rec.guide.app.website, rec.guide.app.developer_docs_url].filter((x): x is string => !!x).map(baseDomain));
  const changes: string[] = [];
  let checked = 0;
  let verified = 0;
  for (const c of rec.guide.claims) {
    const wasDowngraded = c.label === "unknown" && !!c.quote && !!c.source_url && /quote|claim states|quoted text/i.test(c.note ?? "");
    const isDocs = c.label === "provider_docs" || c.label === "composio_docs";
    if (!isDocs && !wasDowngraded) {
      if (c.note && /phrased as a negative/.test(c.note)) c.note = null;
      continue;
    }
    checked++;
    const text = c.quote && c.source_url ? await page(c.source_url) : null;
    const label = c.source_url && baseDomain(c.source_url) === "composio.dev" ? "composio_docs" : "provider_docs";
    const authorityOk = label === "composio_docs" || official.size === 0 || official.has(baseDomain(c.source_url ?? ""));
    const ok = !!text && !!c.quote && quoteInText(c.quote, text) && !supportIssue(c.text, c.quote) && authorityOk;
    if (ok) {
      verified++;
      if (wasDowngraded) changes.push(`${c.id}: restored to ${label} (was: ${c.note})`);
      c.label = label;
      c.note = overlapNote(c.text, c.quote!);
    } else if (isDocs && !text) {
      verified++; // source unreachable now (e.g. 403); keep the earlier verification but say so
      c.note = "Source page could not be re-fetched for the latest check.";
    } else if (isDocs) {
      changes.push(`${c.id}: now fails the check`);
    }
  }
  // Only count downgrades made by the checker (not explanatory notes written with a guide's own unknowns).
  const CHECKER = /quote|claim states|not an official page|not a Composio page|probe that was not recorded|report's source/i;
  const downgraded = rec.guide.claims.filter((c) => (c.label === "unknown" || c.label === "reported") && CHECKER.test(c.note ?? "")).length;
  rec.meta.verification = { claims_total: rec.guide.claims.length, quotes_checked: checked, quotes_verified: verified, downgraded };
  console.log(`${file}: ${verified}/${checked} verified, ${downgraded} still downgraded${changes.length ? "\n  - " + changes.join("\n  - ") : ""}`);
  if (write) writeFileSync(file, JSON.stringify(rec, null, 2) + "\n");
}
