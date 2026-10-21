# How independent agent reviews changed this project

Agents were used as builders and also as **adversarial reviewers**, each time with a fresh context.

## 1. Plan review (before any code)

The plan (`docs/plan.html`) was reviewed by a Claude agent, which also fact-checked provider claims against official docs, and separately by Codex. Both said "sound, revise before building". Changes from v0.1 to v0.2:

| Finding | Change |
|---|---|
| Agents never really *attempt* setup | Added live endpoint probes (🔎 Probed) and recorded agent-driven attempts (`attempts/`) |
| Provider facts wrong: Slack Marketplace bar and unlisted rate limits; Shopify custom distribution needs no review; Notion review step; Google brand verification; security assessment depends on server-side data | Rewrote the provider comparison from official docs. The wrong v0.1 beliefs are now ledger corrections on `/verification` |
| Difficulty depends on the scenario, not the app | Scenario picker; a verdict per scenario |
| A URL is not evidence; the generator could self-award "Tested" | Verbatim quotes checked by code; "Tested" reserved for recorded attempts |
| Exa Answer is deprecated; toolkit pages are huge | Use `COMPOSIO_SEARCH_WEB` + fetch only; read only the toolkit header and FAQ |
| Live-demo fragility | Identify first, bounded tool calls, partial results, save before showing the link |

## 2. Code review (after the build, before any live API run)

Codex reviewed the agent, evidence, fetch and route code with network-free reproductions. Every finding was fixed and has a regression test in `tests/review-fixes.test.ts`:

| Severity | Finding | Fix |
|---|---|---|
| P1 | SSRF bypass: `[::ffff:7f00:1]` (an IPv4-mapped IPv6 address) passed the private-IP check | Decode mapped addresses; refuse other IPv4-embedding IPv6 forms |
| P1 | The research deadline was only checked between turns, so an in-flight call could outlive the 300 s function | Per-call timeouts derived from research and run deadlines; a timed-out research turn becomes a partial guide; Composio calls are time-boxed |
| P1 | A downgraded claim ("3 days") still appeared in the scenario wait estimate and the summary | Unbacked wait estimates become "Unknown" (keeping the original as context); unbacked time spans in the summary become a visible warning |
| P1 | A verbatim quote could "support" a contradicting claim, and forum pages could pass as provider docs | Provider-docs sources must be on the provider's own domains, Composio-docs on composio.dev (otherwise relabelled Reported); numbers in a claim must appear in its quote; negation mismatches get a visible note |
| P2 | Without Blob storage, saving fails on Vercel's read-only filesystem | Live generation refuses to run on Vercel without `BLOB_READ_WRITE_TOKEN`, with a clear message |
| P2 | Response size cap applied only after downloading everything | Stream with a byte cap and cancel |
| P2 | Anthropic web search `max_uses` resets every request | Pass the remaining run budget each turn |

The stricter "numbers must appear in the quote" rule then caught **15 claims in the seed guides** that stated a number their quote did not contain. Each was fixed by quoting the sentence that holds the number, or by removing the unsupported detail. These are logged on `/verification`.

## Agent v2 design review (21 October 2026)

An independent Claude reviewer read the v2 draft spec and the v1 code, with web references (Anthropic's multi-agent research post and *Building effective agents*, 12-factor agents, open_deep_research, GPT Researcher, OpenAI's agent guide, Claude prompting and Citations docs, ALCE). Codex review is pending (the CLI was logged out).

Must-change findings, all applied in SPEC v2.1:
1. The writer, not research, runs out of time first → budget planned backwards from the writer; at most 40 claims.
2. Question status and path must come from verified evidence → status computed in code; a path needs a claim whose own evidence answers G2.
3. A real quote can sit under a wrong claim → number+unit checks, negation/must-may/tier flags, an entailment judge, ellipsis limits.
4. "Official" leaked (brand prefix, empty set = all) → official domains built only from fetched pages, Composio's catalog, and brand siblings linked from official pages.
5. Worker lifecycle and model-safe turns → findings recorded incrementally; system and tools fixed per conversation.
6. Questions missed parts of the categorisation → G2 now asks for gate sequence and triggers; G11 thresholds and use restrictions; G1 legacy check.

Should-change, applied: read by page not by topic (Citations API extraction per page); structured categorisation fields; LLM critique replaced by code checks; critical flags reordered; model capabilities widened; mutation suite and offline pipeline tests.

Verifier mutation suite (`scripts/verifier-mutations.mts`), 349 correct claims from the stored guides, 551 deliberate mutations:

| | Before | After |
|---|---|---|
| Wrong claims that slip through | 488 (89%) | 243 (44%) |
| Correct claims wrongly downgraded | 0 | 0 |
| Correct claims sent to the judge | n/a | 25 (7%) |

The remaining slips go to the entailment judge in v2 when they sit on critical questions; that part can only be measured with live runs.
