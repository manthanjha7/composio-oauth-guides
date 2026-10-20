import type { Guide } from "./schema";

type Scenario = Guide["scenarios"][number];

export const PATH_INFO: Record<NonNullable<Scenario["path"]>, { name: string; meaning: string }> = {
  automatic: { name: "Automatic", meaning: "Nothing to register" },
  self_serve: { name: "Self-serve", meaning: "Create the app and go live. No review" },
  app_review: { name: "App review", meaning: "The provider reviews your app first" },
  partner: { name: "Partner acceptance", meaning: "The provider must accept your company first, and can say no" },
};

export const CHECK_INFO: Record<NonNullable<Scenario["review_checks"]>[number], string> = {
  identity: "Who you are",
  use_case: "Why you need the data",
  working_demo: "A working demo",
  security: "Security",
  listing: "Your listing",
};

const PROTOTYPE = /prototype|personal|testing|dev store|internal|own workspace|managed app/i;

/** The setup a guide opens on: the guide's own pick, else the first one that looks like a real launch. */
export function defaultScenario(g: Pick<Guide, "scenarios" | "default_scenario">): string {
  const ids = g.scenarios.map((s) => s.id);
  if (g.default_scenario && ids.includes(g.default_scenario)) return g.default_scenario;
  return (g.scenarios.find((s) => !PROTOTYPE.test(s.label)) ?? g.scenarios[0])?.id ?? "";
}

/** One-sentence answer for the header. Older guides have no verdict, so fall back to the summary's first sentence. */
export function verdictOf(g: Pick<Guide, "verdict" | "summary">): string {
  if (g.verdict?.trim()) return g.verdict.trim();
  const first = g.summary.match(/^.*?[.!?](?=\s|$)/)?.[0];
  return (first ?? g.summary).trim();
}

/** Removes inline claim citations ("(c11, c35)", "…: c1)") from prose and returns the ids it found. */
export function stripCites(text: string): { text: string; ids: string[] } {
  const ids = text.match(/\bc\d+\b/g) ?? [];
  const group = String.raw`c\d+(?:\s*(?:,|\+|&|\band\b)\s*c\d+)*`;
  const clean = text
    .replace(new RegExp(String.raw`\(\s*${group}\s*,\s*([a-z][a-z ]*)\)`, "g"), "($1)") // "(c55, reported)"
    .replace(new RegExp(String.raw`\s*\(\s*${group}\s*\)`, "g"), "") // whole "(c1, c2)" groups
    .replace(new RegExp(String.raw`\b(from|see|per|in)\s+${group}\b`, "g"), "$1 the sources") // "an inference from c25 + c41"
    .replace(new RegExp(String.raw`\s*[:;,]?\s*\b${group}\b`, "g"), "") // bare "…: c1" inside other text
    .replace(/\(\s*\)/g, "")
    .replace(/\s+([.,;:)])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
  return { text: clean, ids };
}

/** True when an item applies to the chosen setup (no scenario list = applies to all). */
export const appliesTo = (scenarioIds: string[] | undefined, id: string) => !scenarioIds?.length || scenarioIds.includes(id);
