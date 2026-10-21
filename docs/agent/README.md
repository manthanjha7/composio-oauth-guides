# Guide agent: components

Design and decisions: [SPEC.md](SPEC.md). v1 (`src/lib/agent/run.ts`) is the default; v2 runs with `AGENT_VERSION=v2`.

| Component | File | Job |
|---|---|---|
| Pipeline | `src/lib/agent/pipeline.ts` | Identify → discover → read → extract → coverage → gap fill → write → verify → record |
| Questions | `src/lib/agent/questions.ts` | The research brief (G1–G11, R1, C1), critical flags, priority, discovery keywords |
| Prompts | `src/lib/agent/prompts/index.ts` | One prompt per stage plus a shared context block; `PROMPT_VERSION` is stored with every guide |
| Models | `src/lib/agent/models.ts` | Model per stage from configuration; capabilities, prices and output speed by model family |
| Model calls | `src/lib/agent/llm.ts` | Deadline-based timeouts, backoff on 429/5xx, refusal fallback where supported, cost per stage |
| Evidence store | `src/lib/agent/research.ts` | Page cache (each URL fetched once), evidence ledger verified on arrival, official domains, question status |
| Discovery | `src/lib/agent/discover.ts` | Entry points + llms.txt + templated searches → ranked pages |
| Verification | `src/lib/evidence.ts` | Quote match, hard checks (number, number+unit), soft flags (negation, must/may, tier, time unit), enforcement |
| Fetcher | `src/lib/web.ts` | SSRF guard, Markdown fallback for JS docs, outbound links |

## Configuration

| Variable | Default | Effect |
|---|---|---|
| `AGENT_VERSION` | `v1` | `v2` switches the live route and `scripts/generate.mts` |
| `AGENT_MODEL_ALL` | unset | Every stage on one model, e.g. `claude-opus-5-5` |
| `AGENT_MODEL_IDENTIFY` / `_RESEARCH` / `_WRITE` / `_CRITIC` | haiku / haiku / sonnet / sonnet (5.5) | Per stage |
| `AGENT_EFFORT_<STAGE>` | medium (critic: low) | Effort per stage, always sent explicitly |

One-off run on another model (uses the API): `npx tsx --env-file=.env.local scripts/generate.mts --v2 --model claude-opus-5-5 "Xero"`.

## Checks that cost nothing

```bash
npm test                                   # incl. tests/agent-v2*.test.ts: the whole v2 pipeline on a fake model
npx tsx scripts/verifier-mutations.mts     # how many deliberately wrong claims the verifier still accepts
```
