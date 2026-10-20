import { z } from "zod";

/**
 * The guide schema. The agent fills `GeneratedGuideSchema` via structured output;
 * stored guides (`GuideRecord`) add metadata and allow the human-only "tested" label.
 *
 * Kept deliberately small and flat: every field must be fillable by the model in one
 * structured-output call, and every app's guide has the same shape so 100 guides stay
 * comparable.
 */

export const Owner = z.enum(["agent", "you", "waiting"]);
export const Difficulty = z.enum(["easy", "medium", "hard", "unknown"]);

/** Labels the generator may assign. "tested" is deliberately absent: only a recorded attempt can award it. */
export const AgentEvidenceLabel = z.enum(["provider_docs", "composio_docs", "probed", "reported", "unknown"]);
export const EvidenceLabel = z.enum(["tested", "provider_docs", "composio_docs", "probed", "reported", "unknown"]);

const claimFields = {
  id: z.string().describe("Short stable id, e.g. c1, c2"),
  text: z.string().describe("One factual statement, in plain language"),
  source_url: z.string().nullable().describe("URL the claim comes from; null only for label 'unknown' or 'probed'"),
  quote: z
    .string()
    .nullable()
    .describe("For provider_docs / composio_docs: a short VERBATIM sentence copied from the fetched page that supports the claim"),
  probe_id: z.string().nullable().describe("For label 'probed': the probe id returned by probe_url"),
};

export const AgentClaim = z.object({ ...claimFields, label: AgentEvidenceLabel });
export const Claim = z.object({
  ...claimFields,
  label: EvidenceLabel,
  note: z.string().nullable().optional(),
});

const Scenario = z.object({
  id: z.string().describe("e.g. s1"),
  label: z.string().describe("Short name, e.g. 'Internal tool, basic scopes' or 'Public app reading Gmail on your servers'"),
  when_this_applies: z.string(),
  difficulty: Difficulty,
  hands_on: z.object({
    estimate: z.string().describe("Developer's own working time, e.g. '30-60 min'. Use 'Unknown' if no basis."),
    basis: z.string().describe("Why this estimate: which claim ids, or 'estimate from step count, not measured'"),
  }),
  waiting: z.object({
    estimate: z.string().describe("Time waiting on the provider (review, approval). 'None', a range, or 'Unknown'."),
    basis: z.string(),
  }),
  approval: z.string().describe("What review/verification this scenario triggers, if any"),
  claim_ids: z.array(z.string()),
});

const Step = z.object({
  title: z.string(),
  owner: Owner.describe("agent = an AI agent can do this for the developer; you = needs the human; waiting = blocked on the provider"),
  detail: z.string(),
  inputs: z.array(z.string()).describe("What you need in hand for this step"),
  done_when: z.string().describe("How the developer knows this step is complete"),
  scenario_ids: z.array(z.string()).describe("Scenario ids this step applies to; empty = all scenarios"),
  link: z.string().nullable(),
  claim_ids: z.array(z.string()),
});

const Item = z.object({
  title: z.string(),
  detail: z.string(),
  claim_ids: z.array(z.string()),
});

const Blocker = z.object({
  symptom: z.string().describe("What the developer sees, e.g. an error or a review requirement"),
  what_it_means: z.string(),
  what_to_do: z.string(),
  agent_can_help: z.string().nullable().describe("What an AI agent can do here, or null"),
  claim_ids: z.array(z.string()),
});

const guideFields = {
  app: z.object({
    name: z.string(),
    website: z.string().nullable(),
    developer_docs_url: z.string().nullable(),
  }),
  oauth_supported: z.enum(["yes", "no", "unclear"]),
  summary: z.string().describe("2-3 plain sentences: how hard is it, and what decides that"),
  composio: z.object({
    toolkit_slug: z.string().nullable(),
    managed_oauth: z.enum(["yes", "no", "not_in_composio", "unknown"]),
    credential_guide_url: z.string().nullable(),
    note: z.string(),
  }),
  need_own_app: z.object({
    answer: z.string().describe("Do you need your own OAuth app? Plain answer for this app."),
    reasons: z.array(z.string()).describe("When you'd need your own app (branding, scopes, quota, no managed app, ...)"),
  }),
  scenarios: z.array(Scenario),
  prerequisites: z.array(Item),
  steps: z.array(Step),
  traps: z.array(Item),
  blockers: z.array(Blocker),
  open_questions: z.array(z.string()).describe("What remains uncertain and how someone could find out"),
};

export const GeneratedGuideSchema = z.object({ ...guideFields, claims: z.array(AgentClaim) });
export const GuideSchema = z.object({ ...guideFields, claims: z.array(Claim) });

export type GeneratedGuide = z.infer<typeof GeneratedGuideSchema>;
export type Guide = z.infer<typeof GuideSchema>;
export type ClaimT = z.infer<typeof Claim>;
export type EvidenceLabelT = z.infer<typeof EvidenceLabel>;

export const SourceRecord = z.object({
  url: z.string(),
  title: z.string().nullable().optional(),
  fetched_at: z.string(),
  via: z.enum(["direct", "composio_fetch", "composio_search", "anthropic_web_search", "manual"]),
  chars: z.number().optional(),
});

export const ProbeRecord = z.object({
  id: z.string(),
  url: z.string(),
  purpose: z.string(),
  status: z.number().nullable(),
  location: z.string().nullable(),
  observation: z.string(),
  at: z.string(),
});

export const GuideRecordSchema = z.object({
  slug: z.string(),
  guide: GuideSchema,
  meta: z.object({
    origin: z.enum(["seed", "live"]),
    reviewed: z.boolean(),
    review_note: z.string().nullable(),
    generated_at: z.string(),
    generated_by: z.string(),
    duration_ms: z.number().nullable(),
    query: z.string().nullable(),
    partial: z.boolean(),
    verification: z.object({
      claims_total: z.number(),
      quotes_checked: z.number(),
      quotes_verified: z.number(),
      downgraded: z.number(),
    }),
    sources: z.array(SourceRecord),
    probes: z.array(ProbeRecord),
  }),
});

export type GuideRecord = z.infer<typeof GuideRecordSchema>;
export type SourceRecordT = z.infer<typeof SourceRecord>;
export type ProbeRecordT = z.infer<typeof ProbeRecord>;
