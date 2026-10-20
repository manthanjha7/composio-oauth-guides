/**
 * Usage: npx tsx scripts/eval.mts <label>=<guide.json> ...
 * Scores stored guides (no model calls): evidence quality, structure, and per-app must-have facts
 * found by the output review. Run it on the old and new versions of the same app to compare.
 */
import { readFileSync } from "node:fs";
import { GuideRecordSchema } from "../src/lib/schema";

// Facts a correct guide must state (regex over verified claim text + quotes, and guide text). From the output review.
const MUST: Record<string, { fact: string; re: RegExp }[]> = {
  box: [
    { fact: "admin authorization is for JWT/CCG apps", re: /JWT|Client Credentials/i },
    { fact: "OAuth apps: enablement only if inactive by default", re: /inactive by default|enablement/i },
  ],
  xero: [
    { fact: "2026 plans / connection caps", re: /Starter|5 connections|connection (limit|cap)/i },
    { fact: "security assessment above 1,000 connections", re: /1,?000 connections/i },
    { fact: "App certification / Partner program", re: /certif|App Partner/i },
  ],
  gmail: [
    { fact: "100 test users in Testing", re: /100 test users|up to 100/i },
    { fact: "7-day expiry in Testing", re: /7 days|seven days/i },
    { fact: "100-user lifetime cap when unverified", re: /lifetime/i },
    { fact: "authorized domain / redirect domain rule", re: /authori[sz]ed domain|domain (ownership|verification)/i },
    { fact: "restricted scopes need a security assessment", re: /security assessment|CASA/i },
  ],
  calendly: [
    { fact: "separate developer account", re: /developer account/i },
    { fact: "Sandbox vs Production apps", re: /sandbox/i },
  ],
};

for (const arg of process.argv.slice(2)) {
  const [label, file] = arg.split("=");
  const r = GuideRecordSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  const g = r.guide;
  const app = label.split(":")[0];
  const verifiedText = g.claims.filter((c) => c.label !== "unknown").map((c) => `${c.text} ${c.quote ?? ""}`).join(" ");
  const allText = JSON.stringify(g);
  const must = (MUST[app] ?? []).map((m) => `${m.re.test(verifiedText) ? "✓" : m.re.test(allText) ? "~" : "✗"} ${m.fact}`);
  const v = r.meta.verification;
  const agentSteps = g.steps.filter((s) => s.owner === "agent").length;
  const row = {
    claims: g.claims.length,
    sources: new Set(r.meta.sources.map((s) => s.url)).size,
    quotes: `${v.quotes_verified}/${v.quotes_checked}`,
    flagged: v.downgraded,
    unconfirmed: g.claims.filter((c) => c.label === "unknown").length,
    scenarios: g.scenarios.length,
    maxLabel: Math.max(...g.scenarios.map((s) => s.label.length)),
    unknownHandsOn: g.scenarios.filter((s) => /unknown/i.test(s.hands_on.estimate)).length,
    steps: g.steps.length,
    agentSteps: `${agentSteps} (${Math.round((100 * agentSteps) / Math.max(1, g.steps.length))}%)`,
    traps: g.traps.length,
    blockers: g.blockers.length,
    maxDays: g.scenarios.map((s) => s.waiting.max_days ?? "-").join("/"),
    cost: r.meta.usage ? `$${r.meta.usage.usd.toFixed(2)}` : "-",
    secs: r.meta.duration_ms ? Math.round(r.meta.duration_ms / 1000) : "-",
  };
  console.log(`\n## ${label}  (${file})`);
  console.log(Object.entries(row).map(([k, val]) => `${k}=${val}`).join("  "));
  if (must.length) console.log("must-have: " + must.join(" | "));
}
