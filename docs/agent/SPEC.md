# Guide agent v2: design spec (v2.2)

Status: built behind `AGENT_VERSION=v2`; production stays on v1 until a live evaluation is approved and passes (section 11).
History: v2.0 draft → independent design review → v2.1 → Codex end-to-end review (21 Oct 2026, `docs/reviews.md`) → this version.

Control flow is ours. Models fill well-defined slots; code decides the steps, the budgets, and what counts as evidence.

## 1. Job

Input: an app name or website. Output: a saved, shareable guide that answers, per realistic setup:

1. Do I need my own OAuth app?
2. What must happen before a customer outside my company can connect (path, trigger, gate sequence), and what does any review check?
3. How much of my time, and how long do I wait on the provider?
4. What do I need ready, what will block me, and what do I do then?
5. Which steps can an agent do, and which must I do?

Every fact is a claim with a label, traced to evidence that code verified. Unknown is a valid answer; a guess is not.

## 2. Why change v1

| v1 behaviour | Evidence it hurts | v2 answer |
|---|---|---|
| One researcher decides alone what to read | Generated guides: 15–31 claims vs 48–81 for library guides. Xero read 3 pages, 0 searches, stopped at 78 s, and missed the security assessment above 1,000 connections | Code discovers and ranks pages, reads them in parallel, and extracts against a fixed question set |
| Research not driven by the categorisation | path / review checks / shortcut were filled by the writer with no targeted research | Questions map 1:1 to the final categorisation (v8) |
| Nobody checks coverage | The writer cannot tell "not found" from "not looked for" | Question status comes from verified evidence; open critical questions get a targeted search |
| The writer types quotes | Quotes drift; found only after writing | Quotes come from the Citations API (`cited_text` points into the page); the writer cites evidence ids and code fills url + quote |
| Verifier: numbers only | Negation, may→must, unit swaps, stitched ellipsis fragments pass | number+unit pairs, negation/modal check, ellipsis limits, entailment check on critical claims |
| "Official" by brand prefix; empty set = everything official | salesforceben.com would count as Salesforce docs | Official hosts are built in code from fetched pages, Composio metadata and links on official pages |
| Prompts inline; models hard-wired; tools rebuilt every turn | Hard to review; can't try Opus for one run; changing tools mid-conversation breaks thinking on current models | Prompts in versioned files; models per stage by config; each conversation's system and tools are fixed for its life |

## 3. Principles (with sources)

- **Workflow, not a free-roaming agent**, because the steps are known. Anthropic, *Building effective agents*.
- **Parallelise by page, not by topic.** Facts for several questions sit on the same page; one extraction pass per page reads each page once. Anthropic, *How we built our multi-agent research system* (breadth-first, independent directions; agents that share context fit badly).
- **Citation checking is a separate job, done in code** and backed by the API's own citations. Same post (CitationAgent); Claude Citations docs; ALCE (citation precision via entailment).
- **Own your prompts and your control flow; keep context append-only.** HumanLayer *12-factor agents* (factors 2, 3, 8); Claude prompting best practices.
- **Plan → read → reflect on gaps → write.** LangChain open_deep_research; GPT Researcher.
- **Model-agnostic.** No prompt relies on one model's quirks. Any stage runs on any Claude model by configuration.

## 4. Pipeline

```
query
 └─ 1 Identify ── Composio lookup (code) ∥ Composio Search session ∥ identify call (model, ≤2 searches, ≤2 pages)
     └─ ambiguous / not OAuth → stop with that answer
 └─ 2 Discover (code) ── entry points + llms.txt links + 3 templated searches → ranked candidate URLs
 └─ 3 Read (code) ────── fetch the top 8 in parallel (in-flight dedupe, .md fallback); collect links → official hosts
 └─ 4 Extract ∥ ──────── one model call per page, Citations API, all questions → evidence ledger (verified on arrival)
 └─ 5 Coverage (code) ── question status from verified evidence only
 └─ 6 Gap fill ∥ ─────── ≤2 search workers: (a) open critical questions in priority order, (b) developer reports (R1)
 └─ 7 Write ──────────── guide JSON from the ledger; claims cite evidence ids; structured categorisation
 └─ 8 Verify (code + 1 entailment call) ── rules in section 5
 └─ 9 Save, read back, link
```

### 4.1 Questions

| Id | Question | Critical | Priority |
|---|---|---|---|
| G1 | Who can create an app: developer account, program, plan, region; is this the current (not legacy) platform | | |
| G2 | Every step that must happen before a customer outside the developer's company can connect, in order: nothing, an app review, a required listing, partner acceptance. What triggers each (always, sensitive scopes, scale). Is registration automatic (dynamic client registration) | ✓ | 1 |
| G3 | What each review checks and what to submit (identity, use case and scopes, demo, security, listing) | ✓ | 2 |
| G4 | Scope tiers: which scopes a typical agent needs; which trigger extra review | ✓ | 5 |
| G5 | Limits before approval: test users, installs, connections, rate limits, "unreviewed" warnings | ✓ | 3 |
| G6 | Published review times; re-reviews on changes or yearly; waivers | | 6 |
| G7 | Pricing: paid plan, credits or fees for API access | | |
| G8 | Customer side: admin approval, allowlists, per-customer setup | ✓ | 4 |
| G9 | Redirect URI and domain rules (domain verification vs Composio's callback) | | |
| G10 | Setup steps: console path, credentials, scopes, redirect URI | | |
| G11 | Thresholds to apply or be listed (N users, workspaces, customers) and use restrictions (no competing products, naming, eligibility) | | |
| R1 | What developers report: real wait times, rejections, blockers | | |
| C1 | Composio: managed or bring-your-own, callback, known errors (code, from Composio's API and docs) | | |

R1 can satisfy G6 as *reported*.

### 4.2 Contracts

**Identify → code:** `{ name, website, developer_docs_url, oauth: yes|no|unclear, ambiguous, candidates[], entry_points[] }`. The model's URLs are leads, not authority.

**Extract (per page):** a Citations-API call with the page as a plain-text document. The model writes `## G2` style sections; every factual sentence carries citations. Code turns each cited sentence into an evidence item `{ id E#, question, answer sentence, cited_text, url, kind }`. Pages are data: an instruction inside a page is never followed.

**Gap fill (per worker):** a tool loop with `web_search`, `fetch_page` and `record_finding({ question, url, quote, answer })`. Each `record_finding` is verified on arrival (quote on the fetched page) and stored, so a worker cut off at its deadline loses nothing. System prompt, tool list and effort are fixed for the worker's life; budgets are enforced by refusing over-budget calls in code.

**Write:** input = identity, Composio facts, question statuses, verified evidence (and a list of what failed verification). Output = guide JSON whose `claims[]` are `{ id, text, evidence_id | null }`; code fills label, url and quote from the ledger. Each scenario carries `path`, `trigger`, `gate_sequence`, `review_checks`, `modifiers[]` (`{ kind, qualifier, note, claim_ids }`) and an optional `shortcut` with claim ids.

## 5. Verification (code, after writing)

Order matters (Codex review): the judge runs **before** any conclusion is drawn, and every categorical field (path, trigger, gates, checks, wait, shortcut, modifiers) is judged as the guide states it, against the quotes of the claims behind it. A field survives only if its claims are accepted (sourced and, when judged, fully supported) and the field itself was judged supported. Missing verdicts count as unchecked, not passed. Contradicted or unsupported claims become unknown and their evidence is rejected, so coverage is recomputed. If the judge cannot run, fields stay with a visible "not double-checked" warning.


1. url, quote and label come from the ledger, never from the writer. No evidence → unknown.
2. Official: Composio's `app_url` is the anchor. The identify step's website and docs are leads; they count once fetched **and** (same owner as the anchor, linked from the anchor's page, or, with no catalog entry, the page names the app). Sibling domains need a link from an official page **and** the brand plus a developer suffix (dropbox→dropboxapi, google→googleapis); look-alikes (salesforceben) never count. Ownership is Public-Suffix aware and tenant-specific on shared platforms (acme.readme.io, acme.github.io). composio.dev is Composio's authority. Everything else is *reported*, and a reported quote must still be on its fetched page.
3. Quote rules: ellipsis parts ≥ 20 characters each and within 400 characters of each other.
4. Support rules: every number in the claim appears in the quote **with the same unit** (minutes/hours/days/weeks/months/users/requests…); negation and must/may/can't differences between claim and quote downgrade the claim.
5. Entailment (one batch model call, if ≥ 25 s remain): claims on G2–G8 are judged supported / partial / contradicted against their quote. Contradicted → unknown; partial → note.
6. Question status = found only with ≥ 1 verified, non-rejected evidence item from an official source. Developer reports answer R1, and G6 only when they state a time span.
7. Every scenario `path` (including self-serve) needs an accepted claim whose own evidence answers G2, and a supported field verdict; else path, trigger, gates and checks are cleared. A numeric wait needs an accepted G6/R1 claim and a supported field; "None" needs an accepted no-review path; else Unknown. `shortcut` and each `modifier` need an accepted claim and a supported field.
8. Numbers in `verdict` and `summary` must appear in an accepted claim; else the verdict is rebuilt from the scenarios and the summary replaced.
9a. If the writer fails, a partial guide of the verified facts is saved, clearly marked, instead of nothing.
9. Scenario ids, default scenario, ≤ 40 claims, ≤ 4 scenarios, brevity limits, step owners: checked in code (this replaces an LLM critique).
10. Existing rules stay: unbacked waits → Unknown; "tested" impossible.

## 6. Models (configuration)

| Stage | Env var | Default |
|---|---|---|
| identify | `AGENT_MODEL_IDENTIFY` | claude-haiku-5-5 |
| extract + gap fill | `AGENT_MODEL_RESEARCH` | claude-haiku-5-5 |
| write | `AGENT_MODEL_WRITE` | claude-sonnet-5-5 |
| entailment | `AGENT_MODEL_CRITIC` | claude-haiku-5-5 |
| all | `AGENT_MODEL_ALL` | unset (e.g. claude-opus-5-5 for one run) |

Per-run override: `runAgent({ models })`, `scripts/generate.mts --model`. A capabilities table by model family (refusal fallback, web-search tool version, prices incl. cache reads and Haiku's long-prompt rate, typical output speed for budget planning) has conservative defaults for unknown ids; `us.anthropic.` prefixes and `[1m]` suffixes are normalised. Effort is set explicitly per stage. Model ids and prompt version are stored with the guide.

## 7. Budgets (300 s function)

Planned backwards: 5 s save, 20 s judge, then the writer (`reserve = clamp(7,000 tokens ÷ model speed + 20 s, 90–190 s)`); research gets what is left. Lookup, discovery, every fetch (DNS, redirects, Markdown fallback) and every tool call are bounded by these deadlines and the run's abort signal. Extraction runs at most 4 pages at a time with 3,000 output tokens each. Server web-search budgets are cumulative per conversation (`max_uses` is per request), enforced by ending the conversation.

| Stage | Time | Pages | Searches |
|---|---|---|---|
| Identify | ≤ 25 s | 2 | 2 |
| Discover + read | ≤ 20 s | 8 | 3 (code) |
| Extract (parallel) | ≤ 35 s | — | — |
| Gap fill (2 parallel) | ≤ 45 s | 3 each | 2 each |
| Write | reserve (≥ 120 s on Sonnet) | | |
| Verify (+ entailment) | ≤ 25 s | | |

All deadlines are absolute; every call's timeout derives from them. 429s retry with backoff within the deadline.

## 8. Prompts

`src/lib/agent/prompts/`: one file per stage plus a shared `context` block (OAuth app, the Composio chain, the categorisation) so every stage uses the same terms. Each prompt states the objective and why it matters, the inputs, the output format with one short example, and stop rules (enforced in code). Documents first, questions last; quote first, then answer. No capitals for emphasis. `PROMPT_VERSION` is stored with each guide.

## 9. Failure modes

| Failure | Handling |
|---|---|
| Ambiguous name / no OAuth | Identify stops with candidates / the reason |
| JS-rendered docs | `.md` / llms.txt, then Composio fetch |
| No Composio search | Discovery uses entry points + llms.txt; gap-fill workers use Anthropic web search, declared once per worker |
| Extract call fails for a page | That page's questions stay open for gap fill |
| Worker errors or deadline | Its recorded findings are kept; questions stay open |
| Writer invalid JSON | One repair turn with exact errors |
| Refusal | Error with the message (fallback where the model supports it) |
| Prompt injection in a page | Pages are documents; tools are read-only; every claim must survive verification |
| Budget exhausted | Partial guide, marked partial, listing unanswered questions and URLs tried |

## 10. Observability

Events per stage, per page and per worker; a coverage event; cost per stage. Stored in `meta.research`: prompt version, models, per-question status with evidence ids and URLs tried, why each worker stopped, entailment results, and per-claim provenance (claim → evidence → page url, fetched_at, content hash).

## 11. Evaluation

Offline (free, done before any live run):
- **Verifier mutation suite:** mutate verified claims from the stored guides (negation, may→must, unit swap, scope-tier swap, wrong number, stitched fragments); measure how many slip through, before and after v2's rules.
- **Fake-model pipeline tests:** parallel extraction, gap fill, deadline cut-offs, invalid evidence ids, a worker killed mid-tool, unofficial hosts, path without evidence.
- **Discovery tests** on saved llms.txt fixtures.

Live (needs approval and budget): held-out apps from the 86-provider study plus Gmail, Slack, Xero, Box; v2 vs stored v1; 2 runs each where budget allows. Metrics: must-have facts, path accuracy vs the study, critical-question coverage, sampled claim precision, unknown rate, time, cost. Ship v2 only if it is not worse than v1 on any app's must-have facts and finishes under 270 s.

## 12. Out of scope

Logging into consoles, creating apps for users, browser automation, scraping behind logins. Hands-on tests stay in `attempts/`.
