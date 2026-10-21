/**
 * Scores the live v2 runs in eval/runs/ against stored v1 guides and the categorisation study (no model calls).
 *   npx tsx scripts/eval-score.mts
 */
import { existsSync, readFileSync } from "node:fs";
import { GuideRecordSchema, type GuideRecord } from "../src/lib/schema";

// Facts a correct guide must state (regex over verified claim text + quotes).
const MUST: Record<string, { fact: string; re: RegExp }[]> = {
  gmail: [
    { fact: "100 test users in Testing", re: /100 (test )?users|up to 100/i },
    { fact: "7-day expiry in Testing", re: /7 days|seven days/i },
    { fact: "authorized domain / redirect domain rule", re: /authori[sz]ed domain|domain (ownership|verification)|verif(y|ied) (your )?domain/i },
    { fact: "restricted scopes need a security assessment", re: /security assessment|CASA/i },
    { fact: "sensitive vs restricted scopes", re: /restricted scope/i },
  ],
  slack: [
    { fact: "Marketplace needs active workspaces first", re: /\b(5|10|five|ten) (or more )?(active )?workspaces/i },
    { fact: "unlisted apps rate-limited for history reads", re: /1 request|one request|per minute|rate.limit/i },
    { fact: "Marketplace review", re: /review/i },
  ],
  xero: [
    { fact: "connection caps / plans", re: /connection|Starter|uncertified/i },
    { fact: "security assessment above 1,000 connections", re: /1,?000 connections|security (self-)?assessment/i },
    { fact: "App certification / partner program", re: /certif|App Partner|partner/i },
  ],
  box: [
    { fact: "OAuth apps may need admin enablement if inactive by default", re: /enabl|inactive/i },
    { fact: "admin authorization is for JWT/CCG apps (not every OAuth app)", re: /JWT|Client Credentials|server authentication/i },
    { fact: "publishing to Box Integrations is a separate review", re: /Integrations|App Center|publish/i },
  ],
  intercom: [
    { fact: "app must be approved before other workspaces install", re: /review|approv/i },
    { fact: "private until approved (own workspace only)", re: /own workspace|private|development workspace|only.*(your|the) workspace/i },
  ],
  harvest: [{ fact: "OAuth app registration in Harvest ID / developers", re: /Harvest ID|developers|OAuth2? application/i }],
};

// Expected provider path for the realistic public setup, from the 86-provider categorisation study.
const EXPECTED_PATH: Record<string, string[]> = {
  intercom: ["app_review"],
  harvest: ["self_serve"],
  slack: ["app_review", "self_serve"], // listed vs unlisted
  gmail: ["app_review", "self_serve"], // public vs internal
  box: ["self_serve", "app_review"],
  xero: ["partner", "app_review", "self_serve"],
};

const V1: Record<string, string> = { gmail: "data/guides/gmail-agent.json", xero: "data/guides/xero.json", box: "data/guides/box.json", slack: "data/guides/slack.json" };

function score(r: GuideRecord, app: string) {
  const g = r.guide;
  const verified = g.claims.filter((c) => c.label !== "unknown");
  const text = verified.map((c) => `${c.text} ${c.quote ?? ""}`).join(" ");
  const must = (MUST[app] ?? []).map((m) => (m.re.test(text) ? "✓" : "✗") + " " + m.fact);
  const v = r.meta.verification;
  return {
    claims: g.claims.length,
    verified: verified.length,
    unconfirmed: g.claims.length - verified.length,
    quotes: `${v.quotes_verified}/${v.quotes_checked}`,
    paths: g.scenarios.map((s) => s.path ?? "—").join(", "),
    must,
    mustScore: must.filter((m) => m.startsWith("✓")).length,
    cost: r.meta.usage?.usd ?? null,
    secs: r.meta.duration_ms ? Math.round(r.meta.duration_ms / 1000) : null,
  };
}

for (const app of ["gmail", "slack", "xero", "intercom", "harvest", "box"]) {
  const f = `eval/runs/${app}-v2.json`;
  if (!existsSync(f)) {
    console.log(`\n## ${app}: no v2 run`);
    continue;
  }
  const raw = JSON.parse(readFileSync(f, "utf8"));
  if (!raw.guide) {
    console.log(`\n## ${app}: v2 outcome ${raw.outcome}: ${raw.message ?? ""}`);
    continue;
  }
  const r2 = GuideRecordSchema.parse(raw);
  const s2 = score(r2, app);
  const R = r2.meta.research!;
  const crit = R.questions.filter((q) => ["G2", "G3", "G4", "G5", "G8"].includes(q.id));
  const expected = EXPECTED_PATH[app] ?? [];
  const pathHit = r2.guide.scenarios.some((s) => s.path && expected.includes(s.path));
  console.log(`\n## ${app}`);
  console.log(
    `v2: ${s2.claims} claims (${s2.verified} sourced, ${s2.unconfirmed} unconfirmed) · quotes ${s2.quotes} · critical ${crit.filter((q) => q.status === "found").length}/5 · paths [${s2.paths}] ${pathHit ? "✓ matches study" : "✗ no expected path"} · judge ${JSON.stringify({ ...(R.judge ?? {}), items: undefined })} · $${s2.cost?.toFixed(3)} · ${s2.secs}s · partial=${r2.meta.partial}`,
  );
  console.log(`    must-have ${s2.mustScore}/${s2.must.length}: ${s2.must.join(" | ")}`);
  if (V1[app]) {
    const s1 = score(GuideRecordSchema.parse(JSON.parse(readFileSync(V1[app], "utf8"))), app);
    console.log(`v1 (${V1[app]}): ${s1.claims} claims (${s1.verified} sourced) · quotes ${s1.quotes} · must-have ${s1.mustScore}/${s1.must.length}: ${s1.must.join(" | ")}`);
  }
}
