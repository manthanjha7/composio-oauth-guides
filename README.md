# OAuth App Setup Guides for agent builders

**Live:** https://composio-oauth-guides-one.vercel.app

A developer building an AI agent on Composio wants their users to connect an app. Composio's managed OAuth apps cover prototyping for many apps. Production use (your own name on the consent screen, your own quota, extra scopes), and every "bring your own" toolkit, means creating a provider OAuth app and getting it approved. That path differs per provider and per scenario, and it is rarely written down in one place.

This project gives developers:

- **A library of guides.** Seed apps: Gmail, Slack, Shopify, Notion.
- **A live agent.** Type any app name or website, watch it research the app, and get a shareable guide, including for apps outside the library and outside Composio's catalog.

Each guide answers six questions:

- **Do I need my own OAuth app?**
- **How hard is it for my scenario?** Scenarios cover scopes × audience × distribution.
- **How much of my own time does it take, and how long will I wait on the provider?** These are reported separately.
- **What do I need first?**
- **What will block me, and what do I do then?**
- **Which steps can an agent do (🤖) and which must I do (👤)?** Waiting steps are marked ⏳.

Every claim carries an evidence label: 🧪 Tested · 🔎 Probed · 📘 Provider docs · 🟣 Composio docs · 💬 Reported · ❓ Unknown.

## Quick start

```bash
npm install
cp .env.example .env.local   # add ANTHROPIC_API_KEY to enable live generation
npm run dev                  # http://localhost:3000
npm test                     # 34 unit tests, incl. a scripted run of the full agent loop
```

| Env var | Needed for |
|---|---|
| `ANTHROPIC_API_KEY` | Live generation. The library works without it. `AGENT_RESEARCH_MODEL` / `AGENT_MODEL` override the Haiku/Sonnet defaults; `GENERATE_DAILY_CAP` limits spend. |
| `COMPOSIO_API_KEY` | Optional. Research via the **Composio Search** toolkit in a Composio session, and managed-auth status from the toolkit API. Without it, the agent uses Anthropic web search and Composio's public docs. |
| `KV_REST_API_URL` + `KV_REST_API_TOKEN` (Upstash Redis) or `BLOB_READ_WRITE_TOKEN` (Vercel Blob) | Durable storage for generated guides. **One is required on Vercel** (live generation refuses to run without it, so share links never break). Locally, guides go to `./.data`. |

Useful scripts:

- `npx tsx scripts/check-guide.mts data/guides/gmail.json` re-fetches every cited page and string-matches each quote.
- `npx tsx scripts/probe.mts <url>` runs the same probe the agent uses.
- `npx tsx scripts/composio-lookup.mts <app>` returns the Composio facts the agent sees.
- `npx tsx --env-file=.env.local scripts/generate.mts <app>` runs the full agent from the terminal and saves the guide.

## How the agent works

`src/lib/agent/run.ts` is a manual tool-use loop. Research turns run on **Claude Haiku 5.5** (many cheap tool calls, prompt-cached conversation); the guide is written by **Claude Sonnet 5.5** (server-side refusal fallback on). A typical run takes 50-110 s and costs **$0.07-0.30** (tracked per run and stored in the guide's metadata).

1. **Composio check** (`composio_lookup`): the managed-auth directory, the toolkit page header + FAQ (not the 600 KB of tool definitions), the `composio.dev/auth/<app>` credential guide, and the toolkit API's `composio_managed_auth_schemes` when a key is set.
2. **Identify** (`confirm_app`): name, website, docs URL and OAuth support are shown on screen first, so a wrong match is obvious. Ambiguous input gets a "did you mean". Apps without OAuth get an honest "no OAuth app needed".
3. **Research**: `web_search` and `fetch_page`, with budgets of about 5 searches and 8 reads.
   - Search uses Composio Search (`COMPOSIO_SEARCH_WEB`) through a direct-tools session, falling back to Anthropic's `web_search` server tool.
   - Fetch is a direct, SSRF-guarded fetch, falling back to `COMPOSIO_SEARCH_FETCH_URL_CONTENT` for JS-rendered pages.
4. **Probe** (`probe_url`): one request to the provider's real authorize endpoint with a dummy client, recording what comes back. For example, Google redirects with a base64 error that decodes to "invalid_client: The OAuth client was not found".
5. **Write**: a second call writes the guide as JSON against a fixed schema, from a dossier of everything read. Zod validates it, with one repair turn on errors. (API structured outputs reject this schema as too large: "compiled grammar is too large".)
6. **Enforce evidence, in code** (`src/lib/evidence.ts`):
   - A docs claim survives only if its quote appears verbatim in a page the agent actually fetched, on the right authority (the provider's own domains, or composio.dev).
   - Every number in the claim must also appear in the quote; negation mismatches get a visible note.
   - Probed claims need a recorded probe. Reported claims need a URL the agent saw.
   - Everything else is downgraded to ❓ Unknown (or 💬 Reported for real, non-official pages), with a note.
   - A wait estimate with no verified backing becomes "Unknown"; unbacked time spans in the summary are shown as warnings.
   - The generator can't assign 🧪 Tested.
7. **Save, read back, then link.** Research stops itself at about 150 s and writes a partial guide rather than timing out. Progress streams to the browser as real agent events over SSE.

## Key decisions

| Decision | Chosen | Why |
|---|---|---|
| Knowledge source | Live research. The library is agent output that a human checked. | Unfamiliar apps must work, and docs go stale. No RAG infrastructure needed. |
| Unit of guidance | A verdict per **scenario** | Desk research showed difficulty depends on the scenario. Gmail is easy for an internal tool and hard for a server-side agent reading inboxes. |
| Time | Hands-on time vs. waiting time, each with its basis | "1 hour of work + weeks of review" is a different plan from "a week of work". No invented ranges. |
| Evidence | Per-claim label + verbatim quote, checked by code | A URL alone doesn't prove support. Reviewers asked for sound judgment about evidence. |
| "Attempt the setup" | The agent probes live endpoints, plus recorded agent-driven setup attempts (`attempts/`) | Logins, 2FA and ToS make a signup bot fragile. The agent does the config work, a human does the logins. |
| Stack | Composio Search + Composio docs/API, Next.js on Vercel | Built on what Composio already ships. Links to Composio's credential walkthroughs instead of rewriting them. |
| Sharing | Public URL + Markdown export per guide | "Shareable" means a link. The Markdown serves coding agents and docs. |

The planning doc (user flows, system design, reviewer feedback) is in `docs/plan.html`.

## Verification

- `/verification` shows two things:
  - the automatic quote check per guide (e.g. Slack: 75/75 quotes verified on live pages)
  - a manual ledger of material claims: what we believed, how we checked it, and whether it was confirmed, corrected or unverifiable
- Live dry run (5 apps, $0.63 total): Calendly, HubSpot, Xero, Box, and Gmail compared against its seed (9/10 key facts matched). Results are in the ledger (v17, v18).
- Seed guides were researched at build time by Claude research agents under the same schema and evidence rules as the live agent (`docs/seed-research-brief.md`), because no Anthropic API key was configured yet.
- Hands-on setup attempts are tracked in `attempts/`. Until they're done, no claim is labelled 🧪 Tested.

Agents also reviewed the work: Claude and Codex reviewed the plan, and Codex reviewed the code. Every code finding has a regression test. See `docs/reviews.md`.

## Limitations

- **Freshness.** Guides are dated research aids. Provider policies change. Re-run the agent to refresh. There's no scheduled refresh yet.
- **Claim support is heuristic.** Code proves the quote exists on an authoritative page and that the claim's numbers are in it. It can't fully prove meaning, so the quote is always shown next to the claim.
- **Search budget.** With Anthropic web search, the per-run search budget can overshoot by about one search per turn (the server tool needs at least one allowed use).
- **Logged-in areas.** The agent can't see behind developer-console logins. Those parts come from docs or human attempts.
- **Review timelines.** These are rarely published. When they're missing, guides say Unknown, plus labelled developer reports.
- **Rate limiting** on `/api/generate` is in-memory, per instance: good enough for a demo, not for production.
- **Review status.** Seed guides and live guides share a schema, but live guides are marked "not human-reviewed" until someone checks them.
- **Scale.** 4 seed guides, not 100. The route to 100: batch-run the same pipeline over Composio's 211 bring-your-own toolkits and its top managed ones, then human-review them in order of usage.
