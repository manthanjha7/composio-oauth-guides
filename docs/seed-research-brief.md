# Seed guide research brief (shared by all seed agents)

You are producing ONE seed guide for a Composio take-home project: OAuth app setup guides for developers building AI agents.
Project: /home/vercel-sandbox/oauth-guides (Next.js/TypeScript). Do NOT edit anything except your own output file `data/guides/<slug>.json`.

## Read first
- `src/lib/schema.ts`: `GuideRecordSchema` is the exact shape of your output file (guide + meta).
- `src/lib/agent/prompt.ts`: WRITE_SYSTEM = the content and evidence rules. Follow them exactly. The live agent writes guides under the same rules.
- Composio facts for your app: `npx tsx scripts/composio-lookup.mts "<app>" [slug]` (run from the project dir).

## Evidence rules (hard)
- Every claim with label `provider_docs` or `composio_docs` needs `source_url` + a SHORT `quote` copied VERBATIM from that page (exact words; it is string-matched). Prefer one sentence or a clause of 6-25 words. Do not paraphrase, and don't stitch text across bullet points.
- For docs.composio.dev pages, cite the `.md` URL (e.g. https://docs.composio.dev/toolkits/gmail.md, https://docs.composio.dev/toolkits/managed-auth.md); those fetch cleanly.
- Cite the official page you actually fetched. If a docs site renders with JavaScript and the checker cannot fetch it, find another official page with the same fact, or label the claim `unknown`/`reported`.
- `probed`: run `npx tsx scripts/probe.mts "<url>" "<purpose>"` and put the record in `meta.probes` with ids p1, p2...; the claim's `probe_id` must match. Probe at least the provider's OAuth authorize endpoint with client_id=invalid-client-id-test and redirect_uri=https://example.com/callback.
- `reported`: a non-official URL (forum, blog, GitHub issue) you actually read. Never present as fact.
- `unknown`: anything you could not confirm. Unknown beats invented. NEVER use label `tested` (no one has tested it yet; Manthan's hands-on tests will add those later).
- Time estimates: give a basis. If no official timeline exists, say "Unknown" plus what reports say (labelled reported).
- Composio redirect/callback URI: tell developers to copy it from their Composio dashboard. Do not hard-code one (Composio's docs show two different ones).

## Content
- Write for a developer who must decide: do I need my own OAuth app, how hard is it, my hands-on time vs waiting on the provider, prerequisites, blockers, and what an AI agent can do for them vs what they must do.
- 2-4 scenarios that genuinely change the path (scopes, audience, distribution, data on servers).
- Steps in order with owner agent/you/waiting, inputs, done_when, scenario_ids (empty = all).
- Include Composio steps (auth config with own client ID/secret).
- Concise, concrete, no marketing language.

## meta block to use
```json
"meta": {
  "origin": "seed",
  "reviewed": false,
  "review_note": "Researched at build time by a Claude research agent using the same schema and evidence rules as the live agent (no Anthropic API key was configured yet). Quotes machine-checked against live pages. Awaiting Manthan's hands-on test.",
  "generated_at": "<ISO now>",
  "generated_by": "Claude research subagent (build-time seed)",
  "duration_ms": null,
  "query": null,
  "partial": false,
  "verification": {"claims_total": 0, "quotes_checked": 0, "quotes_verified": 0, "downgraded": 0},
  "sources": [ {"url": "...", "title": "...", "fetched_at": "<ISO>", "via": "manual"} ],
  "probes": [ ... ]
}
```

## Done = this passes with 0 problems
`npx tsx scripts/check-guide.mts data/guides/<slug>.json --write`
(It validates the schema, flags dangling claim ids, and re-fetches every cited page to string-match each quote.) Fix or relabel anything it flags, then rerun until clean.

## Report back (under 250 words)
Slug, claim counts by label, the 3 most surprising findings (things a developer would not expect), and anything you had to label unknown that matters.
