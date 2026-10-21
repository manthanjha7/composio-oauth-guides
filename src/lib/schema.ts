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
/** What must happen before a customer outside your company can connect (the strictest mandatory gate). */
export const Path = z.enum(["automatic", "self_serve", "app_review", "partner"]);
/** What a provider review inspects. One submission can check several. */
export const ReviewCheck = z.enum(["identity", "use_case", "working_demo", "security", "listing"]);
export const Trigger = z.enum(["always", "sensitive_scopes", "scale", "none"]);
export const ModifierKind = z.enum([
  "customer_admin",
  "limited_before_approval",
  "threshold",
  "paid_access",
  "builder_prerequisite",
  "use_restrictions",
  "recurring",
]);
const Modifier = z.object({
  kind: ModifierKind,
  qualifier: z.enum(["required", "optional"]).nullable().optional(),
  note: z.string().describe("At most 10 words"),
  claim_ids: z.array(z.string()),
});

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
    max_days: z.number().nullable().optional().describe("Longest documented wait in calendar days, or null if no source gives one"),
  }),
  approval: z.string().describe("What review/verification this scenario triggers, if any"),
  claim_ids: z.array(z.string()),
  // Optional so guides saved before these fields existed still load.
  path: Path.optional().describe("automatic = nothing to register; self_serve = create the app and go live; app_review = the provider reviews your app; partner = the provider must accept your company first"),
  review_checks: z.array(ReviewCheck).optional().describe("What the review inspects; empty if there is no review"),
  shortcut: z.string().nullable().optional().describe("A documented way to avoid or shrink the review for this goal, in one sentence, or null"),
  extras: z.array(z.string()).optional().describe("Up to 3 short facts that change the experience (max 8 words each): customer admin approval, limits before approval, paid plan, yearly re-review"),
  // v2: structured categorisation, each part tied to claims.
  trigger: Trigger.optional().describe("What triggers the review for this setup"),
  gate_sequence: z.array(z.string()).optional().describe("Mandatory steps before outside customers can connect, in order, each at most 8 words"),
  modifiers: z.array(Modifier).optional(),
  path_claim_ids: z.array(z.string()).optional().describe("Claims (from G2 evidence) that back the path"),
  shortcut_claim_ids: z.array(z.string()).optional(),
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
  scenario_ids: z.array(z.string()).optional().describe("Scenario ids this applies to; empty or missing = all"),
});

const Blocker = z.object({
  symptom: z.string().describe("What the developer sees, e.g. an error or a review requirement"),
  what_it_means: z.string(),
  what_to_do: z.string(),
  agent_can_help: z.string().nullable().describe("What an AI agent can do here, or null"),
  claim_ids: z.array(z.string()),
  scenario_ids: z.array(z.string()).optional().describe("Scenario ids this applies to; empty or missing = all"),
});

const guideFields = {
  app: z.object({
    name: z.string(),
    website: z.string().nullable(),
    developer_docs_url: z.string().nullable(),
  }),
  oauth_supported: z.enum(["yes", "no", "unclear"]),
  summary: z.string().describe("2-3 plain sentences: how hard is it, and what decides that"),
  verdict: z.string().optional().describe("One sentence, max 25 words: the easiest and the hardest realistic case, with times"),
  default_scenario: z.string().optional().describe("Scenario id of the most common production setup for an AI agent"),
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

/** v2 writer output: claims cite an evidence id; code fills label, url and quote from the evidence ledger. */
export const WriterClaim = z.object({
  id: z.string().describe("Short stable id, e.g. c1"),
  text: z.string().describe("One factual statement, in plain language"),
  evidence_id: z.string().nullable().describe("An evidence id (E#) from the dossier that supports this claim, or null if unconfirmed"),
});
export const WriterGuideSchema = z.object({ ...guideFields, claims: z.array(WriterClaim) });
export type WriterGuide = z.infer<typeof WriterGuideSchema>;
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

/** v2 provenance: what was asked, what was found, from where, and how the run ended. */
export const ResearchRecord = z.object({
  version: z.literal(2),
  prompt_version: z.string(),
  models: z.record(z.string(), z.string()),
  questions: z.array(
    z.object({ id: z.string(), status: z.enum(["found", "not_found"]), evidence: z.array(z.string()), tried: z.array(z.string()) }),
  ),
  evidence: z.array(
    z.object({
      id: z.string(),
      question: z.string(),
      url: z.string(),
      quote: z.string(),
      answer: z.string(),
      kind: z.enum(["provider_docs", "composio_docs", "reported"]),
      status: z.enum(["verified", "not_on_page", "not_fetched", "rejected"]),
      via: z.enum(["extract", "gapfill"]),
      /** Further citations that support the same sentence together with `quote`. */
      extra_quotes: z.array(z.string()).optional(),
      /** Character offsets of the quote in the text sent to the model (Citations API). */
      offsets: z.tuple([z.number(), z.number()]).optional(),
      fetched_at: z.string().nullable(),
      page_hash: z.string().nullable(),
    }),
  ),
  workers: z.array(z.object({ name: z.string(), stop: z.string(), ms: z.number() })),
  judge: z
    .object({ checked: z.number(), supported: z.number(), partial: z.number(), unsupported: z.number().optional(), contradicted: z.number(), unchecked: z.number().optional() })
    .nullable(),
  served: z.record(z.string(), z.array(z.string())).optional(),
  timings_ms: z.record(z.string(), z.number()),
});
export type ResearchRecordT = z.infer<typeof ResearchRecord>;

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
    warnings: z.array(z.string()).optional(),
    usage: z
      .object({ usd: z.number(), input_tokens: z.number(), output_tokens: z.number(), cache_read_tokens: z.number(), web_searches: z.number() })
      .optional(),
    verification: z.object({
      claims_total: z.number(),
      quotes_checked: z.number(),
      quotes_verified: z.number(),
      downgraded: z.number(),
    }),
    sources: z.array(SourceRecord),
    probes: z.array(ProbeRecord),
    research: ResearchRecord.optional(),
  }),
});

export type GuideRecord = z.infer<typeof GuideRecordSchema>;
export type SourceRecordT = z.infer<typeof SourceRecord>;
export type ProbeRecordT = z.infer<typeof ProbeRecord>;
