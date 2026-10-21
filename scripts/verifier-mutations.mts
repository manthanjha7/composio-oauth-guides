/**
 * Verifier mutation suite (no model calls, no network).
 * Takes every verified docs claim in the stored guides, makes it wrong in a known way, and counts how many
 * wrong claims the support check still accepts. Also counts false alarms on the original, correct claims.
 *
 *   npx tsx scripts/verifier-mutations.mts
 */
import { readdirSync, readFileSync } from "node:fs";
import { supportFlags, supportIssue } from "../src/lib/evidence";
import { GuideRecordSchema } from "../src/lib/schema";

type Mutation = { name: string; apply: (t: string) => string | null };

const swap = (pairs: [RegExp, string][]) => (t: string) => {
  for (const [re, to] of pairs) if (re.test(t)) return t.replace(re, to);
  return null;
};

export const MUTATIONS: Mutation[] = [
  { name: "negation", apply: (t) => (/\b(is|are|can|must|will|does|do|should|requires?|needs?)\b/i.test(t) ? t.replace(/\b(is|are|can|must|will|does|do|should)\b/i, "$1 not").replace(/\b(requires?|needs?)\b/i, "does not $1") : null) },
  { name: "may→must", apply: swap([[/\bmay\b/i, "must"], [/\bcan\b/i, "must"], [/\boptional\b/i, "required"], [/\brecommended\b/i, "required"]]) },
  { name: "must→may", apply: swap([[/\bmust\b/i, "may"], [/\brequired\b/i, "optional"], [/\balways\b/i, "sometimes"]]) },
  {
    name: "unit swap",
    apply: swap([
      [/\bdays\b/i, "weeks"], [/\bweeks\b/i, "months"], [/\bhours\b/i, "days"], [/\bminutes\b/i, "hours"],
      [/\bper minute\b/i, "per day"], [/\bper day\b/i, "per month"], [/\bmonths?\b/i, "years"], [/\busers\b/i, "workspaces"],
    ]),
  },
  { name: "wrong number", apply: (t) => (/\b\d+\b/.test(t) ? t.replace(/\b(\d+)\b/, (m) => String(Number(m) * 10 + 1)) : null) },
  {
    name: "tier swap",
    apply: swap([[/\brestricted\b/i, "sensitive"], [/\bsensitive\b/i, "restricted"], [/\binternal\b/i, "external"], [/\bexternal\b/i, "internal"], [/\bpublic\b/i, "private"], [/\bunlisted\b/i, "listed"]]),
  },
];

export function runSuite() {
  const claims: { text: string; quote: string }[] = [];
  for (const f of readdirSync("data/guides")) {
    const r = GuideRecordSchema.parse(JSON.parse(readFileSync(`data/guides/${f}`, "utf8")));
    for (const c of r.guide.claims) if ((c.label === "provider_docs" || c.label === "composio_docs") && c.quote && !c.note) claims.push({ text: c.text, quote: c.quote });
  }
  const falseAlarms = claims.filter((c) => supportIssue(c.text, c.quote)).length;
  const falseFlags = claims.filter((c) => !supportIssue(c.text, c.quote) && supportFlags(c.text, c.quote).length).length;
  const rows = MUTATIONS.map((m) => {
    let tried = 0;
    let hard = 0;
    let flagged = 0;
    for (const c of claims) {
      const bad = m.apply(c.text);
      if (!bad || bad === c.text) continue;
      tried++;
      if (supportIssue(bad, c.quote)) hard++;
      else if (supportFlags(bad, c.quote).length) flagged++;
    }
    return { mutation: m.name, tried, hard, flagged, slipped: tried - hard - flagged };
  });
  return { claims: claims.length, falseAlarms, falseFlags, rows };
}

if (process.argv[1]?.endsWith("verifier-mutations.mts")) {
  const { claims, falseAlarms, falseFlags, rows } = runSuite();
  const pct = (a: number, b: number) => `${b ? Math.round((100 * a) / b) : 0}%`;
  console.log(`Correct claims: ${claims} · wrongly downgraded: ${falseAlarms} (${pct(falseAlarms, claims)}) · sent to the judge: ${falseFlags} (${pct(falseFlags, claims)})`);
  for (const r of rows)
    console.log(`${r.mutation.padEnd(14)} tried ${String(r.tried).padStart(3)} · downgraded ${String(r.hard).padStart(3)} · flagged ${String(r.flagged).padStart(3)} · slipped ${String(r.slipped).padStart(3)} (${pct(r.slipped, r.tried)})`);
  const t = rows.reduce((a, r) => ({ tried: a.tried + r.tried, slipped: a.slipped + r.slipped }), { tried: 0, slipped: 0 });
  console.log(`TOTAL          tried ${t.tried} · slipped ${t.slipped} (${pct(t.slipped, t.tried)})`);
}
