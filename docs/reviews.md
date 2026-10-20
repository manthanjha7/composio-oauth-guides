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
