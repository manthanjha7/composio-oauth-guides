import Anthropic from "@anthropic-ai/sdk";
import type {
  BetaContentBlockParam,
  BetaMessage,
  BetaMessageParam,
  BetaToolUnion,
  BetaToolUseBlock,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { z } from "zod";
import { composioLookup, type ComposioLookup } from "../composio";
import { baseDomain, canonicalUrl, enforceEvidence, numbersInText, numberUnitPairs, type EvidenceContext } from "../evidence";
import { CHECK_INFO, pathLabel } from "../guide-view";
import { type GeneratedGuide, type Guide, type GuideRecord, type WriterGuide, WriterGuideSchema } from "../schema";
import { createComposioSearch, type ComposioSearch } from "../search";
import { slugify } from "../slug";
import { trimForModel } from "../web";
import { discover } from "./discover";
import { createLlm, extractJson, textOf, type Llm } from "./llm";
import { capabilities, resolveEffort, resolveModels, type Stage, type StageModels } from "./models";
import {
  EXTRACT_SYSTEM,
  extractUser,
  GAPFILL_SYSTEM,
  gapfillUser,
  IDENTIFY_SYSTEM,
  JUDGE_SYSTEM,
  PROMPT_VERSION,
  WRITE_SYSTEM,
} from "./prompts";
import { COMPOSIO_QUESTIONS, isQuestionId, PROVIDER_QUESTIONS, QUESTIONS, type QuestionId } from "./questions";
import { ResearchStore, type Page } from "./research";
import type { AgentEvent, RunResult } from "./run";

export interface RunOptionsV2 {
  query: string;
  emit: (e: AgentEvent) => void;
  client?: Anthropic;
  /** Injected for tests; otherwise created from COMPOSIO_API_KEY (null = Anthropic web search in tool loops). */
  search?: ComposioSearch | null;
  /** Per-run model override, e.g. { all: "claude-opus-5-5" }. */
  models?: Partial<StageModels> & { all?: string };
  /** Whole run; keep below the route's maxDuration (300 s) to leave time to save. */
  totalBudgetMs?: number;
  signal?: AbortSignal;
  /** Swap the model transport (tests and the Claude Code test mirror). Production leaves this unset. */
  llm?: Llm;
  /** Multiplies the per-stage model time caps (the mirror's headless calls are slower). Production: 1. */
  timeScale?: number;
}

const Identity = z.object({
  name: z.string().min(1),
  website: z.string().nullable().optional(),
  developer_docs_url: z.string().nullable().optional(),
  oauth: z.enum(["yes", "no", "unclear"]),
  ambiguous: z.boolean().optional(),
  candidates: z.array(z.string()).optional(),
  entry_points: z.array(z.string()).optional(),
});
type IdentityT = z.infer<typeof Identity>;

const Verdict = z.enum(["supported", "partial", "unsupported", "contradicted"]);
const Verdicts = z.array(z.object({ id: z.string(), verdict: Verdict, reason: z.string().optional() }));
type VerdictT = z.infer<typeof Verdict> | "unchecked";

const MAX_PAGES = 8;
const MAX_CLAIMS = 40;
const MAX_SCENARIOS = 4;
const EXTRACT_CONCURRENCY = 4;
const EXTRACT_MAX_TOKENS = 3_000;
const JUDGE_RESERVE = 20_000;
const SAVE_RESERVE = 5_000;
const TIMELINE_QUESTIONS = new Set(["G6", "R1"]);
/** Explicit "no wait" values; anything else that isn't Unknown is a substantive wait that must be sourced. */
// The whole value must be an explicit no-wait: "0.5 days", "0-2 weeks" or "None for testing; ten weeks for
// production" are real waits and must be sourced.
const NO_WAIT = /^(?:none|no wait|no waiting|no review|n\/a|0)\.?$/i;
const isSubstantiveWait = (est: string) => !/^unknown\.?$/i.test(est.trim()) && !NO_WAIT.test(est.trim());

type ToolResult = { content: string; isError?: boolean; stop?: boolean };

/** Settle with `fallback` if `p` hasn't settled by `deadlineAt`. The timer is cleared either way. */
function byDeadline<T>(p: Promise<T>, deadlineAt: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<T>((r) => {
    timer = setTimeout(() => r(fallback), Math.max(0, deadlineAt - Date.now()));
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}
/** Run `fn` over items with at most `limit` in flight. */
async function mapLimit<T>(items: T[], limit: number, fn: (x: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) await fn(items[i++]);
    }),
  );
}

/**
 * One tool-using conversation. Append-only: system, tools and effort are fixed for its whole life (current
 * models tie thinking to the exact history). Budgets are enforced by refusing tool calls in code, or by ending
 * the conversation (`stopWhen`) when a server-side budget is spent. Every tool call is bounded by the deadline.
 */
async function toolLoop(o: {
  llm: Llm;
  stage: Stage;
  model: string;
  system: string;
  tools: BetaToolUnion[];
  user: string;
  deadline: number;
  maxTurns: number;
  runTool: (name: string, input: Record<string, unknown>) => Promise<ToolResult>;
  onMessage?: (m: BetaMessage) => void;
  stopWhen?: () => string | null;
  signal?: AbortSignal;
}): Promise<string> {
  const messages: BetaMessageParam[] = [{ role: "user", content: o.user }];
  const effort = resolveEffort(o.stage);
  for (let turn = 0; turn < o.maxTurns; turn++) {
    if (o.deadline - Date.now() < 6_000) return "deadline";
    o.signal?.throwIfAborted();
    let msg: BetaMessage;
    try {
      msg = await o.llm.call({ stage: o.stage, model: o.model, effort, system: o.system, tools: o.tools, messages, cache: true, maxTokens: 8_000 }, o.deadline);
    } catch (e) {
      if (o.signal?.aborted) throw e;
      return Date.now() >= o.deadline - 6_000 ? "deadline" : `error: ${(e as Error).message}`;
    }
    o.onMessage?.(msg);
    if (msg.stop_reason === "refusal") return "error: the model declined";
    messages.push({ role: "assistant", content: msg.content });
    const uses = msg.content.filter((b): b is BetaToolUseBlock => b.type === "tool_use");
    if (msg.stop_reason === "pause_turn" || !uses.length) {
      const why = o.stopWhen?.();
      if (why) return why;
      if (msg.stop_reason === "pause_turn") continue;
      return "no_tool_call";
    }
    let stop = false;
    const timeout: ToolResult = { content: "Tool timed out (out of time). Finish with what you have.", isError: true };
    const results = await Promise.all(
      uses.map(async (t) => {
        try {
          const r = await byDeadline(o.runTool(t.name, (t.input ?? {}) as Record<string, unknown>), o.deadline - 3_000, timeout);
          if (r.stop) stop = true;
          return { type: "tool_result" as const, tool_use_id: t.id, content: r.content, is_error: r.isError };
        } catch (e) {
          return { type: "tool_result" as const, tool_use_id: t.id, content: `Tool error: ${(e as Error).message}`, is_error: true };
        }
      }),
    );
    // All results for one turn go back in a single user message. Budgets are checked after the turn's tool
    // calls ran, so a finding recorded alongside the last search is not lost.
    messages.push({ role: "user", content: results });
    if (stop) return "finished";
    const why = o.stopWhen?.();
    if (why) return why;
  }
  return "turns";
}

const fetchTool: BetaToolUnion = {
  name: "fetch_page",
  description: "Fetch a public web page and return its readable text.",
  input_schema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
};
const searchTool: BetaToolUnion = {
  name: "web_search",
  description: "Search the web. Returns titles, URLs and snippets. Snippets are leads; fetch a page for evidence.",
  input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
};

export async function runAgentV2(opts: RunOptionsV2): Promise<RunResult> {
  const started = Date.now();
  const emit = opts.emit;
  const models = resolveModels(opts.models);
  const k = opts.timeScale ?? 1; // stage caps for model work; network caps (lookup, fetches) don't scale
  const llm = opts.llm ?? createLlm(opts.client ?? new Anthropic(), { signal: opts.signal, onWarning: (m) => emit({ type: "warning", message: m }) });
  const runDeadline = started + (opts.totalBudgetMs ?? 270_000);
  // Plan backwards: save, then the judge, then the writer (the slowest step) get their time first.
  const writeReserve = Math.min(190_000, Math.max(90_000, Math.round((7_000 / capabilities(models.write).outputTps) * 1000) + 20_000));
  const writeDeadline = runDeadline - JUDGE_RESERVE - SAVE_RESERVE;
  const researchDeadline = writeDeadline - writeReserve;
  const timings: Record<string, number> = {};
  const mark = (k: string, t0: number) => (timings[k] = Date.now() - t0);
  const workers: { name: string; stop: string; ms: number }[] = [];
  const runId = Math.random().toString(36).slice(2, 10);

  emit({ type: "stage", stage: "start", message: `Researching ${opts.query}` });

  // ---- 1. Identify: Composio lookup and the search session start together, each with its own limit ----
  let t0 = Date.now();
  emit({ type: "stage", stage: "composio", message: "Checking Composio" });
  const searchP: Promise<ComposioSearch | null> =
    opts.search !== undefined ? Promise.resolve(opts.search) : byDeadline(createComposioSearch(runId).catch(() => null), Date.now() + 12_000, null);
  const lookup: ComposioLookup | null = await byDeadline(
    composioLookup(opts.query).catch(() => null),
    Date.now() + 10_000,
    null,
  );
  if (lookup) emit({ type: "composio", managed: lookup.managed_oauth, slug: lookup.chosen?.slug ?? lookup.toolkit?.slug ?? null, guide: lookup.credential_guide?.url ?? null });
  const search = await searchP;
  if (!search && opts.search === undefined && process.env.COMPOSIO_API_KEY) emit({ type: "warning", message: "Composio Search unavailable; using Anthropic web search." });
  const searchVia = search ? "composio_search" : "anthropic_web_search";

  const store = new ResearchStore(search, (url, ok, chars, via, error) => emit({ type: "fetch", url, ok, chars, via, error }));
  store.signal = opts.signal;
  for (const p of lookup?.pages ?? []) {
    // Composio's own pages, read during lookup, become citable pages.
    store.pages.set(canonicalUrl(p.url), { url: p.url, title: null, text: p.text, links: [], fetched_at: new Date().toISOString(), hash: "", via: "direct" });
  }

  // Server web search is declared once per conversation; its version follows the model that runs it.
  const searchTools = (model: string, maxUses: number): BetaToolUnion[] =>
    search ? [searchTool] : [{ type: capabilities(model).webSearchTool, name: "web_search", max_uses: maxUses } as BetaToolUnion];
  /**
   * Counts server-side searches. max_uses is per request, so each request may search once (max_uses 1) and the
   * conversation ends once the cumulative budget is spent: at most `budget` searches in total.
   */
  const serverSearchCounter = () => {
    let n = 0;
    return {
      onMessage: (m: BetaMessage) => {
        for (const b of m.content) {
          if (b.type === "server_tool_use" && b.name === "web_search") n++;
          if (b.type === "web_search_tool_result" && Array.isArray(b.content)) {
            const results = b.content.flatMap((r) => (r.type === "web_search_result" ? [{ title: r.title, url: r.url }] : []));
            results.forEach((r) => store.seenUrls.add(r.url));
            emit({ type: "search", query: "", via: "Anthropic web search", results: results.slice(0, 5) });
          }
        }
      },
      spent: (budget: number) => (search ? null : n >= budget ? "search budget" : null),
    };
  };
  const runSearch = async (query: string, budget: { left: number }): Promise<ToolResult> => {
    if (!search) return { content: "web_search is the server tool in this run", isError: true };
    if (budget.left <= 0) return { content: "Search budget spent. Use what you have, then finish.", isError: true };
    budget.left--;
    try {
      const results = await search.search(query);
      results.forEach((r) => store.seenUrls.add(r.url));
      emit({ type: "search", query, via: "Composio Search", results: results.slice(0, 5).map(({ title, url }) => ({ title, url })) });
      return { content: JSON.stringify(results.slice(0, 8)) };
    } catch (e) {
      return { content: `Search failed: ${(e as Error).message}`, isError: true };
    }
  };
  const runFetch = async (url: string, budget: { left: number }, maxChars: number, deadlineAt: number): Promise<ToolResult> => {
    if (budget.left <= 0) return { content: "Page budget spent. Use what you have, then finish.", isError: true };
    budget.left--;
    const page = await store.fetch(url, deadlineAt);
    if (!page) return { content: `Could not fetch ${url}. Try the same URL + ".md", the site's /llms.txt, or another page.`, isError: true };
    return { content: `URL: ${page.url}\nTITLE: ${page.title ?? ""}\n\n<page>\n${trimForModel(page.text, maxChars)}\n</page>` };
  };

  emit({ type: "stage", stage: "identify", message: "Identifying the provider" });
  let identity: IdentityT | null = null;
  {
    const sBudget = { left: 2 };
    const fBudget = { left: 2 };
    const counter = serverSearchCounter();
    const deadline = Math.min(Date.now() + 25_000 * k, researchDeadline);
    const composioSummary = lookup
      ? JSON.stringify({
          managed_oauth: lookup.managed_oauth,
          toolkit: lookup.chosen?.slug ?? lookup.toolkit?.slug ?? null,
          app_url: lookup.app_url ?? null,
          credential_guide: lookup.credential_guide?.url ?? null,
          toolkit_header: lookup.toolkit?.header.slice(0, 1200) ?? null,
        })
      : "Composio lookup unavailable.";
    const stop = await toolLoop({
      llm,
      stage: "identify",
      model: models.identify,
      system: IDENTIFY_SYSTEM,
      tools: [
        ...searchTools(models.identify, 1),
        fetchTool,
        {
          name: "submit_identity",
          description: "Submit the identified provider. Call exactly once.",
          input_schema: {
            type: "object",
            properties: {
              name: { type: "string" },
              website: { type: ["string", "null"] },
              developer_docs_url: { type: ["string", "null"] },
              oauth: { type: "string", enum: ["yes", "no", "unclear"] },
              ambiguous: { type: "boolean" },
              candidates: { type: "array", items: { type: "string" } },
              entry_points: { type: "array", items: { type: "string" } },
            },
            required: ["name", "oauth"],
          },
        },
      ],
      user: `User input: ${opts.query}\n\nComposio knows: ${composioSummary}`,
      deadline,
      maxTurns: 6,
      signal: opts.signal,
      onMessage: counter.onMessage,
      stopWhen: () => (identity ? null : counter.spent(2)),
      runTool: async (name, input) => {
        if (name === "web_search") return runSearch(String(input.query ?? ""), sBudget);
        if (name === "fetch_page") return runFetch(String(input.url ?? ""), fBudget, 6_000, deadline);
        if (name === "submit_identity") {
          const parsed = Identity.safeParse(input);
          if (!parsed.success) return { content: `Invalid input: ${parsed.error.message}`, isError: true };
          identity = parsed.data;
          return { content: "Recorded.", stop: true };
        }
        return { content: `Unknown tool ${name}`, isError: true };
      },
    });
    workers.push({ name: "identify", stop, ms: Date.now() - t0 });
  }
  mark("identify", t0);
  const ident = identity as IdentityT | null;
  if (ident?.ambiguous && ident.candidates?.length) {
    emit({ type: "ambiguous", candidates: ident.candidates });
    return { outcome: "ambiguous", candidates: ident.candidates };
  }
  if (ident?.oauth === "no") {
    const message = `${ident.name} does not appear to offer OAuth for third-party apps.`;
    emit({ type: "not_oauth", message });
    return { outcome: "not_oauth", message };
  }
  if (!ident) {
    const message = `Could not identify "${opts.query}" or its developer docs.`;
    emit({ type: "error", message });
    return { outcome: "error", message };
  }
  emit({ type: "identified", name: ident.name, website: ident.website ?? null, docs: ident.developer_docs_url ?? null, oauth: ident.oauth });

  // ---- 2–3. Establish official domains, discover, read ----
  t0 = Date.now();
  emit({ type: "stage", stage: "research", message: `Finding ${ident.name}'s OAuth, review and limits pages` });
  const readDeadline = Math.min(Date.now() + 25_000, researchDeadline - 40_000);
  await anchorOfficial(store, ident, lookup, readDeadline);
  const entry = [...new Set([...(ident.entry_points ?? []), ident.developer_docs_url ?? ""].filter((u) => /^https?:\/\//.test(u)))].slice(0, 8);
  const { candidates } = await discover({
    app: ident.name,
    entryPoints: entry,
    docsUrl: ident.developer_docs_url ?? null,
    store,
    search,
    max: MAX_PAGES,
    deadlineAt: Math.min(Date.now() + 12_000, readDeadline),
    onSearch: (query, results) => emit({ type: "search", query, via: "Composio Search", results: results.slice(0, 5).map(({ title, url }) => ({ title, url })) }),
  });
  emit({ type: "stage", stage: "research", message: `Reading ${candidates.length} pages` });
  const read = (await Promise.all(candidates.map((c) => store.fetch(c.url, readDeadline)))).filter((p): p is Page => !!p);
  store.expandOfficialFromLinks();
  store.relabel();
  mark("discover_read", t0);

  // ---- 4. Extract: one citations call per page, a few at a time ----
  t0 = Date.now();
  const providerPages = dedupePages(read).filter((p) => !/composio\.dev/.test(p.url) && !/\/llms\.txt$/.test(p.url));
  const composioPages = [...store.pages.values()].filter((p) => /composio\.dev/.test(p.url)).slice(0, 3);
  emit({ type: "stage", stage: "research", message: `Extracting facts from ${providerPages.length + composioPages.length} pages` });
  const extractDeadline = Math.min(Date.now() + 45_000 * k, researchDeadline - 15_000);
  const jobs: { page: Page; ids: QuestionId[] }[] = [
    ...providerPages.map((page) => ({ page, ids: PROVIDER_QUESTIONS })),
    ...composioPages.map((page) => ({ page, ids: COMPOSIO_QUESTIONS })),
  ];
  await mapLimit(jobs, EXTRACT_CONCURRENCY, async ({ page, ids }) => {
    const tStart = Date.now();
    if (extractDeadline - Date.now() < 8_000) {
      workers.push({ name: `extract ${page.url}`, stop: "deadline (not started)", ms: 0 });
      return;
    }
    const text = trimForModel(page.text, 60_000);
    try {
      const msg = await llm.call(
        {
          stage: "research",
          model: models.research,
          effort: resolveEffort("research"),
          system: EXTRACT_SYSTEM,
          maxTokens: EXTRACT_MAX_TOKENS,
          messages: [
            {
              role: "user",
              content: [
                { type: "document", source: { type: "text", media_type: "text/plain", data: text }, title: page.url, citations: { enabled: true } },
                { type: "text", text: extractUser(ident.name, ids) },
              ] as BetaContentBlockParam[],
            },
          ],
        },
        extractDeadline,
      );
      const n = collectCitations(msg, page, store, ids);
      workers.push({ name: `extract ${page.url}`, stop: `ok (${n} facts)`, ms: Date.now() - tStart });
    } catch (e) {
      workers.push({ name: `extract ${page.url}`, stop: `error: ${(e as Error).message}`, ms: Date.now() - tStart });
    } finally {
      ids.forEach((q) => store.markTried(q, page.url));
    }
  });
  mark("extract", t0);
  emitCoverage(emit, store);

  // ---- 6. Gap fill: missing gates first (by priority); developer reports only if gates are nearly covered ----
  t0 = Date.now();
  const open = store.openCritical();
  const gapJobs: { name: string; ids: QuestionId[] }[] = [];
  if (open.length) gapJobs.push({ name: "gap: official docs", ids: open.slice(0, 3) });
  if (open.length > 3) gapJobs.push({ name: "gap: official docs (2)", ids: open.slice(3, 6) });
  // A free slot goes to important non-critical questions (thresholds, timelines, pricing, redirect rules),
  // then to developer reports.
  const important = (["G11", "G6", "G7", "G9"] as QuestionId[]).filter((q) => store.status(q) === "not_found").slice(0, 2);
  if (gapJobs.length < 2 && important.length) gapJobs.push({ name: "gap: important details", ids: important });
  if (gapJobs.length < 2 && store.status("R1") === "not_found") gapJobs.push({ name: "gap: developer reports", ids: store.status("G6") === "found" ? ["R1"] : ["R1", "G6"] });
  if (gapJobs.length && researchDeadline - Date.now() > 15_000) {
    emit({ type: "stage", stage: "research", message: open.length ? `Searching for what the docs didn't answer (${open.join(", ")})` : "Looking for developer reports" });
    await Promise.all(
      gapJobs.map(async (job) => {
        const tStart = Date.now();
        const sBudget = { left: 2 };
        const fBudget = { left: 3 };
        const counter = serverSearchCounter();
        const stop = await toolLoop({
          llm,
          stage: "research",
          model: models.research,
          system: GAPFILL_SYSTEM,
          tools: [
            ...searchTools(models.research, 1),
            fetchTool,
            {
              name: "record_finding",
              description: "Save one fact as evidence. The quote must be copied exactly from a page you fetched.",
              input_schema: {
                type: "object",
                properties: {
                  question: { type: "string", enum: job.ids },
                  url: { type: "string" },
                  quote: { type: "string" },
                  answer: { type: "string" },
                },
                required: ["question", "url", "quote", "answer"],
              },
            },
            { name: "finish", description: "End your work. Say which questions you could not answer.", input_schema: { type: "object", properties: { notes: { type: "string" } }, required: ["notes"] } },
          ],
          user: gapfillUser(ident.name, ident.developer_docs_url ?? null, job.ids, job.ids.flatMap((q) => [...(store.tried.get(q) ?? [])])),
          deadline: researchDeadline,
          maxTurns: 8,
          signal: opts.signal,
          onMessage: counter.onMessage,
          stopWhen: () => counter.spent(2),
          runTool: async (name, input) => {
            if (name === "web_search") return runSearch(String(input.query ?? ""), sBudget);
            if (name === "fetch_page") {
              const r = await runFetch(String(input.url ?? ""), fBudget, 12_000, researchDeadline);
              job.ids.forEach((q) => store.markTried(q, String(input.url ?? "")));
              return r;
            }
            if (name === "record_finding") {
              const q = String(input.question ?? "");
              if (!isQuestionId(q) || !job.ids.includes(q)) return { content: `Question must be one of ${job.ids.join(", ")}`, isError: true };
              const item = store.addEvidence({ question: q, url: String(input.url ?? ""), quote: String(input.quote ?? ""), answer: String(input.answer ?? ""), via: "gapfill" });
              if (item.status === "verified") return { content: `Saved as ${item.id} (${item.kind}).` };
              return {
                content: item.status === "not_fetched" ? "Fetch that page first, then quote it." : "That quote is not on the page. Copy the sentence exactly.",
                isError: true,
              };
            }
            if (name === "finish") return { content: "Done.", stop: true };
            return { content: `Unknown tool ${name}`, isError: true };
          },
        });
        workers.push({ name: job.name, stop, ms: Date.now() - tStart });
      }),
    );
    store.expandOfficialFromLinks();
    store.relabel();
    emitCoverage(emit, store);
  }
  mark("gapfill", t0);

  // ---- 7. Write ----
  t0 = Date.now();
  emit({ type: "stage", stage: "write", message: "Writing the guide" });
  const dossier = buildDossier(opts.query, ident, lookup, store);
  const schemaText = JSON.stringify(z.toJSONSchema(WriterGuideSchema));
  const system = `${WRITE_SYSTEM}\n\nReturn only one JSON object (no prose, no code fences) that validates against this JSON Schema:\n${schemaText}`;
  const writeMessages: BetaMessageParam[] = [{ role: "user", content: dossier }];
  let written: WriterGuide | null = null;
  let writeFailure: string | null = null;
  for (let attempt = 0; attempt < 2 && !written; attempt++) {
    if (attempt > 0 && writeDeadline - Date.now() < 40_000) {
      writeFailure = "No time left to repair the guide's format.";
      break;
    }
    try {
      const msg = await llm.call({ stage: "write", model: models.write, effort: resolveEffort("write"), system, messages: writeMessages, maxTokens: 32_000 }, writeDeadline);
      if (msg.stop_reason === "refusal") throw new Error("The model declined to write this guide.");
      if (msg.stop_reason === "max_tokens") throw new Error("The guide was cut off (max_tokens).");
      let problem: string;
      try {
        const parsed = WriterGuideSchema.safeParse(JSON.parse(extractJson(textOf(msg))));
        if (parsed.success) {
          written = parsed.data;
          break;
        }
        problem = parsed.error.issues.slice(0, 15).map((i) => `${i.path.join(".")}: ${i.message}`).join("\n");
      } catch (err) {
        problem = `Not valid JSON: ${(err as Error).message}`;
      }
      writeFailure = problem;
      emit({ type: "warning", message: "Fixing the guide's format (one retry)" });
      writeMessages.push({ role: "assistant", content: msg.content }, { role: "user", content: `Fix these problems and return the complete corrected JSON object only:\n${problem}` });
    } catch (e) {
      if (opts.signal?.aborted) return { outcome: "error", message: "Cancelled" };
      writeFailure = e instanceof Anthropic.APIError ? `Model API error while writing (${e.status ?? "network"}): ${e.message}` : (e as Error).message;
      break;
    }
  }
  mark("write", t0);

  // ---- 8. Verify ----
  t0 = Date.now();
  emit({ type: "stage", stage: "verify", message: "Checking every claim against its source" });
  const ctx: EvidenceContext = {
    pages: new Map([...store.pages.values()].map((p) => [canonicalUrl(p.url), p.text])),
    seenUrls: new Set([...store.seenUrls, ...[...store.pages.values()].map((p) => p.url)]),
    probes: [],
    officialDomains: [...store.official],
    strictOfficial: true,
  };
  const warnings: string[] = [];
  let guide: Guide;
  let stats: ReturnType<typeof enforceEvidence>["stats"];
  let judge: { checked: number; supported: number; partial: number; unsupported: number; contradicted: number; unchecked: number } | null = null;
  let judgeLog: { id: string; verdict: string; reason: string | null }[] = [];

  if (!written) {
    // The writer failed: save what was verified rather than nothing, clearly marked as incomplete.
    warnings.push(`The agent could not write the full guide (${writeFailure ?? "unknown error"}). Showing the facts it verified.`);
    const enforced = enforceEvidence(fallbackGuide(ident, lookup, store), ctx);
    guide = { ...enforced.guide, open_questions: [...enforced.guide.open_questions, ...openQuestions(store)] };
    stats = enforced.stats;
    warnings.push(...enforced.warnings);
  } else {
    const writer = dedupeClaims(written);
    if (writer.claims.length > MAX_CLAIMS) warnings.push(`The writer produced ${writer.claims.length} claims; the ${MAX_CLAIMS} the guide uses most were kept.`);
    const evByIdForSupport = new Map(store.evidence.map((e) => [e.id, e]));
    ctx.supportQuotes = new Map(
      writer.claims.flatMap((c) => {
        const e = c.evidence_id ? evByIdForSupport.get(c.evidence_id) : undefined;
        return e?.extra_quotes?.length ? [[c.id, e.extra_quotes] as [string, string[]]] : [];
      }),
    );
    const enforced = enforceEvidence(fromWriter(writer, store), ctx);
    warnings.push(...enforced.warnings);
    stats = enforced.stats;
    let g = enforced.guide;
    const evById = new Map(store.evidence.map((e) => [e.id, e]));
    const claimEvidence = new Map(writer.claims.map((c) => [c.id, c.evidence_id && evById.get(c.evidence_id)?.status === "verified" ? c.evidence_id : null]));
    const claimQuestion = new Map([...claimEvidence].map(([id, ev]) => [id, ev ? evById.get(ev)?.question : undefined]));
    const quotesOf = (claimId: string) => {
      const ev = claimEvidence.get(claimId);
      const e = ev ? evById.get(ev) : undefined;
      return e ? [e.quote, ...(e.extra_quotes ?? [])] : [];
    };

    // Entailment judge, before any conclusion is drawn: claims on critical questions, claims the word checks
    // flagged, and each setup's path, wait, shortcut and factors as stated.
    const items = judgeItems(g, claimQuestion, quotesOf);
    const verdicts = new Map<string, VerdictT>();
    if (items.length && runDeadline - SAVE_RESERVE - Date.now() > 12_000) {
      try {
        const msg = await llm.call(
          {
            stage: "critic",
            model: models.critic,
            effort: resolveEffort("critic"),
            system: JUDGE_SYSTEM,
            maxTokens: 6_000,
            messages: [{ role: "user", content: JSON.stringify(items.map(({ id, statement, quotes }) => ({ id, statement, quotes }))) }],
          },
          runDeadline - SAVE_RESERVE,
        );
        const parsed = Verdicts.safeParse(JSON.parse(extractJson(textOf(msg))));
        if (!parsed.success) throw new Error("its answer could not be read");
        const sent = new Set(items.map((i) => i.id));
        const seen = new Set<string>();
        for (const v of parsed.data) {
          // Exactly one verdict per item sent: unknown ids and duplicates are ignored.
          if (!sent.has(v.id) || seen.has(v.id)) continue;
          seen.add(v.id);
          verdicts.set(v.id, v.verdict);
          const item = items.find((i) => i.id === v.id)!;
          item.reason = v.reason;
        }
        for (const id of sent) if (!verdicts.has(id)) verdicts.set(id, "unchecked");
        judge = { checked: items.length, supported: 0, partial: 0, unsupported: 0, contradicted: 0, unchecked: 0 };
        for (const v of verdicts.values()) judge[v]++;
        judgeLog = items.map((i) => ({ id: i.id, verdict: verdicts.get(i.id) ?? "unchecked", reason: i.reason ?? null }));
        if (judge.unchecked) warnings.push(`${judge.unchecked} statements were not double-checked by the evidence judge.`);
      } catch (e) {
        warnings.push(`The evidence judge did not run (${(e as Error).message}); setup details were not double-checked.`);
      }
    } else if (items.length) {
      warnings.push("Out of time for the evidence judge; setup details were not double-checked.");
    }
    // No judge, no categorical conclusions: everything that needed checking is unchecked.
    if (!judge) for (const i of items) verdicts.set(i.id, "unchecked");

    // Apply claim verdicts: contradicted or unsupported → unconfirmed, and their evidence no longer answers anything.
    const rejectedEvidence: string[] = [];
    g = {
      ...g,
      claims: g.claims.map((c) => {
        const v = verdicts.get(c.id);
        const reason = items.find((i) => i.id === c.id)?.reason;
        if (v === "contradicted" || v === "unsupported") {
          const ev = claimEvidence.get(c.id);
          if (ev) rejectedEvidence.push(ev);
          stats.downgraded++;
          return { ...c, label: "unknown" as const, note: `The quote does not support this claim${reason ? `: ${reason}` : "."}` };
        }
        if (v === "partial") return { ...c, note: `Only partly supported by the quote${reason ? `: ${reason}` : "."}` };
        if (v === "unchecked") return { ...c, note: c.note ?? "Not double-checked against its quote." };
        if (v === "supported" && (c.note ?? "").includes("Check the quote")) return { ...c, note: null };
        return c;
      }),
    };
    store.reject(rejectedEvidence);

    // A claim can carry a categorical conclusion only if it is sourced and, when judged, fully supported.
    const accepted = (id: string) => {
      const c = g.claims.find((x) => x.id === id);
      if (!c || c.label === "unknown") return false;
      const v = verdicts.get(id);
      return v === undefined || v === "supported";
    };
    const fieldOk = (key: string) => verdicts.get(key) === "supported";
    guide = applyInvariants(g, store, warnings, { claimQuestion, accepted, fieldOk, judged: !!judge });
  }
  mark("verify", t0);

  emit({ type: "verify", total: stats.claims_total, checked: stats.quotes_checked, verified: stats.quotes_verified, downgraded: stats.downgraded });
  emitCoverage(emit, store);
  warnings.forEach((w) => emit({ type: "warning", message: w }));
  emit({ type: "cost", usd: llm.spend.usd, input_tokens: llm.spend.input_tokens, output_tokens: llm.spend.output_tokens, web_searches: llm.spend.web_searches });

  const partial = !written || store.openCritical().length > 0 || workers.some((w) => w.stop.startsWith("deadline"));
  const record: GuideRecord = {
    slug: slugify(opts.query) || slugify(guide.app.name),
    guide,
    meta: {
      origin: "live",
      reviewed: false,
      review_note: null,
      generated_at: new Date().toISOString(),
      generated_by: `agent v2 (${PROMPT_VERSION}) · identify ${models.identify} · research ${models.research} · write ${models.write} · judge ${models.critic} · ${searchVia}`,
      duration_ms: Date.now() - started,
      query: opts.query,
      partial,
      warnings,
      verification: stats,
      usage: {
        usd: Math.round(llm.spend.usd * 10000) / 10000,
        input_tokens: llm.spend.input_tokens,
        output_tokens: llm.spend.output_tokens,
        cache_read_tokens: llm.spend.cache_read_tokens,
        web_searches: llm.spend.web_searches,
      },
      sources: store.sources(),
      probes: [],
      research: {
        version: 2,
        prompt_version: PROMPT_VERSION,
        models: { ...models },
        served: llm.spend.served as Record<string, string[]>,
        questions: store.questionRecords(),
        evidence: store.evidence,
        workers,
        judge: judge ? { ...judge, items: judgeLog } : null,
        timings_ms: timings,
      },
    },
  };
  return { outcome: "ok", record };
}

/**
 * Decide which domains are the provider's own. Composio's catalog URL is an independent anchor. The identify
 * step's website and docs URLs are only leads: a site counts once fetched AND (it is the catalog's domain, the
 * catalog's site links to it, or, with no catalog entry, its page names the app). Docs count when an official
 * page links to them or they share the official domain.
 */
export async function anchorOfficial(store: ResearchStore, ident: IdentityT, lookup: ComposioLookup | null, deadlineAt: number) {
  const name = ident.name.toLowerCase();
  const letters = name.replace(/[^a-z0-9]/g, "");
  const mentions = (p: Page) => `${p.title ?? ""} ${p.text.slice(0, 3000)}`.toLowerCase().includes(name);
  const nameInDomain = (p: Page) => letters.length >= 3 && baseDomain(p.url).split(".")[0].replace(/[^a-z0-9]/g, "").includes(letters);
  const [catalog, site, docs] = await Promise.all([
    lookup?.app_url ? store.fetch(lookup.app_url, deadlineAt) : Promise.resolve(null),
    ident.website ? store.fetch(ident.website, deadlineAt) : Promise.resolve(null),
    ident.developer_docs_url ? store.fetch(ident.developer_docs_url, deadlineAt) : Promise.resolve(null),
  ]);
  const linksTo = (from: Page | null, to: Page | null) => !!from && !!to && from.links.some((l) => baseDomain(l) === baseDomain(to.url));
  const sameOwner = (p: Page | null) => !!p && store.official.has(baseDomain(p.url));
  if (lookup?.app_url) store.addOfficial(catalog?.url ?? lookup.app_url);
  // The website counts if the catalog vouches for it; with no catalog entry, its domain and page must both name the app.
  const siteOk = !!site && (sameOwner(site) || linksTo(catalog, site) || (!lookup?.app_url && nameInDomain(site) && mentions(site)));
  if (siteOk) store.addOfficial(site!.url);
  // Docs count only when an already-trusted page vouches for them (an untrusted site can't).
  if (docs && (sameOwner(docs) || linksTo(catalog, docs) || (siteOk && linksTo(site, docs)))) store.addOfficial(docs.url);
  store.expandOfficialFromLinks();
}

function dedupePages(pages: Page[]): Page[] {
  const seen = new Set<string>();
  return pages.filter((p) => (seen.has(p.hash) ? false : (seen.add(p.hash), true)));
}

function dedupeClaims(w: WriterGuide): WriterGuide {
  const seen = new Set<string>();
  return { ...w, claims: w.claims.filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true))) };
}

function emitCoverage(emit: (e: AgentEvent) => void, store: ResearchStore) {
  const found = QUESTIONS.filter((q) => store.status(q.id) === "found").map((q) => q.id);
  const open = store.openCritical();
  emit({ type: "note", text: `Answered ${found.length} of ${QUESTIONS.length} questions${open.length ? `; still open: ${open.join(", ")}` : ""}.` });
}

/**
 * Turn a Citations-API reply into evidence. Headings ("## G5") are tracked in reading order across and within
 * text blocks. A block's citations belong to the question in force where the block's prose is; a block that
 * spans several headings is split and only an unambiguous last section keeps the citations. Several citations
 * on one sentence stay together as one evidence item (they support it jointly).
 */
export function collectCitations(msg: BetaMessage, page: Page, store: ResearchStore, allowed: QuestionId[]): number {
  let current: QuestionId | null = null;
  let n = 0;
  for (const b of msg.content) {
    if (b.type !== "text") continue;
    const segments = b.text.split(/(##\s*[A-Z]\d{1,2}\b)/);
    let proseQuestion: QuestionId | null = current;
    let prose = "";
    let sectionsWithProse = 0;
    let lastHadProse = false;
    for (const seg of segments) {
      const h = seg.match(/^##\s*([A-Z]\d{1,2})$/);
      if (h) {
        current = isQuestionId(h[1]) && allowed.includes(h[1]) ? h[1] : null;
        proseQuestion = current;
        prose = "";
        lastHadProse = false;
      } else if (seg.trim()) {
        prose += seg;
        if (!lastHadProse) sectionsWithProse++;
        lastHadProse = true;
      }
    }
    const cites = (b.citations ?? []).filter((c) => c.type === "char_location" && c.cited_text?.trim());
    // A cited block whose prose spans several question sections can't be attributed safely: skip it.
    if (sectionsWithProse > 1 && cites.length) continue;
    if (!proseQuestion || !cites.length || !prose.trim()) continue;
    const [first, ...rest] = cites as { cited_text: string; start_char_index: number; end_char_index: number }[];
    const item = store.addEvidence({
      question: proseQuestion,
      url: page.url,
      quote: first.cited_text.trim(),
      extra_quotes: rest.map((c) => c.cited_text.trim()),
      offsets: [first.start_char_index, first.end_char_index],
      answer: prose.trim(),
      via: "extract",
    });
    if (item.status === "verified") n++;
  }
  return n;
}

function buildDossier(query: string, ident: IdentityT, lookup: ComposioLookup | null, store: ResearchStore): string {
  const parts: string[] = [];
  parts.push(`# Research dossier\nUser asked about: ${query}\nDate: ${new Date().toISOString().slice(0, 10)}`);
  parts.push(`## Provider\n${JSON.stringify({ name: ident.name, website: ident.website ?? null, developer_docs_url: ident.developer_docs_url ?? null, oauth: ident.oauth })}`);
  if (lookup) {
    parts.push(
      `## Composio\n${JSON.stringify({
        managed_oauth: lookup.managed_oauth,
        toolkit_slug: lookup.chosen?.slug ?? lookup.toolkit?.slug ?? null,
        api_managed_schemes: lookup.api_managed_schemes,
        credential_guide: lookup.credential_guide,
        directory_url: lookup.directory_url,
      })}`,
    );
  }
  parts.push(
    `## Question coverage\n${store
      .questionRecords()
      .map((q) => `- ${q.id}: ${q.status === "found" ? `found (${q.evidence.join(", ")})` : `NOT FOUND${q.tried.length ? `; tried ${q.tried.slice(0, 4).join(", ")}` : ""}`}`)
      .join("\n")}`,
  );
  const verified = store.evidence.filter((e) => e.status === "verified");
  parts.push(
    `## Verified evidence (cite these ids)\n${verified
      .map((e) => {
        const extra = e.extra_quotes?.length ? `\n  also: ${e.extra_quotes.map((q) => `"${q.slice(0, 200)}"`).join(" ")}` : "";
        return `${e.id} [${e.kind}] (${e.question}) ${e.url}\n  quote: "${e.quote.slice(0, 400)}"${extra}\n  answer: ${e.answer.slice(0, 300)}`;
      })
      .join("\n")}`,
  );
  const failed = store.evidence.length - verified.length;
  if (failed) parts.push(`(${failed} more findings failed verification and are not citable.)`);
  return parts.join("\n\n");
}

/** Writer output → generated guide: label, url and quote come from the evidence ledger, never from the writer. */
export function fromWriter(w: WriterGuide, store: ResearchStore): GeneratedGuide {
  const ev = new Map(store.evidence.filter((e) => e.status === "verified").map((e) => [e.id, e]));
  // Over the cap, keep the claims the guide actually uses (setups first, then steps, traps, blockers) and drop
  // unreferenced extras, never simply the last ones written.
  const weight = new Map<string, number>();
  const bump = (ids: string[] | undefined, n: number) => (ids ?? []).forEach((id) => weight.set(id, (weight.get(id) ?? 0) + n));
  for (const s of w.scenarios) {
    bump(s.claim_ids, 5);
    bump(s.path_claim_ids, 8);
    bump(s.shortcut_claim_ids, 4);
    (s.modifiers ?? []).forEach((m) => bump(m.claim_ids, 4));
  }
  [...w.steps, ...w.traps, ...w.blockers, ...w.prerequisites].forEach((x) => bump(x.claim_ids, 2));
  const kept =
    w.claims.length <= MAX_CLAIMS
      ? w.claims
      : [...w.claims]
          .map((c, i) => ({ c, i, wt: (weight.get(c.id) ?? 0) + (c.evidence_id ? 1 : 0) }))
          .sort((a, b) => b.wt - a.wt || a.i - b.i)
          .slice(0, MAX_CLAIMS)
          .sort((a, b) => a.i - b.i)
          .map((x) => x.c);
  const claims = kept.map((c) => {
    const e = c.evidence_id ? ev.get(c.evidence_id) : undefined;
    return e
      ? { id: c.id, text: c.text, label: e.kind, source_url: e.url, quote: e.quote, probe_id: null }
      : { id: c.id, text: c.text, label: "unknown" as const, source_url: null, quote: null, probe_id: null };
  });
  return { ...w, scenarios: w.scenarios.slice(0, MAX_SCENARIOS), claims };
}

/** A minimal guide from verified evidence, for when the writer could not finish. */
function fallbackGuide(ident: IdentityT, lookup: ComposioLookup | null, store: ResearchStore): GeneratedGuide {
  const managed = lookup?.managed_oauth ?? "unknown";
  const ev = store.verified().slice(0, MAX_CLAIMS);
  return {
    app: { name: ident.name, website: ident.website ?? null, developer_docs_url: ident.developer_docs_url ?? null },
    oauth_supported: ident.oauth === "yes" ? "yes" : "unclear",
    summary: "The agent ran out of time before writing the full guide. These are the facts it verified, with their sources.",
    composio: { toolkit_slug: lookup?.chosen?.slug ?? lookup?.toolkit?.slug ?? null, managed_oauth: managed, credential_guide_url: lookup?.credential_guide?.url ?? null, note: "" },
    need_own_app: {
      answer: managed === "yes" ? "Not to prototype: Composio has a managed app. For launch, usually yes." : "Likely yes: Composio has no managed app for this.",
      reasons: [],
    },
    scenarios: [],
    prerequisites: [],
    steps: [],
    traps: [],
    blockers: [],
    open_questions: [],
    claims: ev.map((e, i) => ({ id: `c${i + 1}`, text: e.answer.slice(0, 300), label: e.kind, source_url: e.url, quote: e.quote, probe_id: null })),
  };
}

type JudgeItem = { id: string; statement: string; quotes: string[]; reason?: string };

/** What the judge checks: risky claims, and every categorical field as the guide states it, with its quotes. */
function judgeItems(g: Guide, claimQuestion: Map<string, string | undefined>, quotesOf: (id: string) => string[]): JudgeItem[] {
  const items: JudgeItem[] = [];
  for (const c of g.claims) {
    if (!c.quote || c.label === "unknown") continue;
    const q = claimQuestion.get(c.id) ?? "";
    if (["G2", "G3", "G4", "G5", "G6", "G7", "G8", "G11"].includes(q) || (c.note ?? "").includes("Check the quote")) {
      items.push({ id: c.id, statement: c.text, quotes: quotesOf(c.id) });
    }
  }
  const gather = (ids: string[] | undefined) => [...new Set((ids ?? []).flatMap(quotesOf))];
  // One atomic statement per part, so an unproven detail drops only itself, never the whole path.
  const PATH_STATEMENT = {
    automatic: "nothing has to be registered: the app's client registers itself automatically.",
    self_serve: "no review by the provider is needed before the app can be used in this setup.",
    app_review: "the provider reviews, verifies or approves the app before it can be used in this setup.",
    partner: "the provider must accept the developer's company (for example as a partner) before the app can be used in this setup.",
  } as const;
  const TRIGGER_STATEMENT = { always: "the review is always required", sensitive_scopes: "the review is required only for sensitive scopes", scale: "the review is required only above a number of users, installs or calls", none: "" } as const;
  for (const s of g.scenarios) {
    const who = `For "${s.label}"`;
    if (s.path) {
      const quotes = gather(s.path_claim_ids);
      items.push({ id: `${s.id}.path`, statement: `${who}: ${PATH_STATEMENT[s.path]}`, quotes });
      if (s.trigger && s.trigger !== "none") items.push({ id: `${s.id}.trigger`, statement: `${who}: ${TRIGGER_STATEMENT[s.trigger]}.`, quotes });
      if (s.gate_sequence?.length) items.push({ id: `${s.id}.gates`, statement: `${who}: the steps before customers can connect are, in order: ${s.gate_sequence.join("; ")}.`, quotes });
      if (s.review_checks?.length) items.push({ id: `${s.id}.checks`, statement: `${who}: the review checks ${s.review_checks.map((c) => CHECK_INFO[c].toLowerCase()).join(", ")}.`, quotes });
    }
    if (isSubstantiveWait(s.waiting.estimate)) {
      const ids = s.claim_ids.filter((id) => TIMELINE_QUESTIONS.has(claimQuestion.get(id) ?? ""));
      items.push({ id: `${s.id}.wait`, statement: `${who}: the wait on the provider is ${s.waiting.estimate}.`, quotes: gather(ids) });
    }
    if (s.shortcut) items.push({ id: `${s.id}.shortcut`, statement: `${who}: ${s.shortcut}`, quotes: gather(s.shortcut_claim_ids) });
    (s.modifiers ?? []).forEach((m, i) => items.push({ id: `${s.id}.mod${i}`, statement: `${who}: ${m.kind.replace(/_/g, " ")}: ${m.note}`, quotes: gather(m.claim_ids) }));
  }
  // The one-line verdict is judged too, against the quotes behind every setup's path and wait.
  if (g.verdict) {
    const ids = g.scenarios.flatMap((s) => [...(s.path_claim_ids ?? []), ...s.claim_ids.filter((id) => TIMELINE_QUESTIONS.has(claimQuestion.get(id) ?? ""))]);
    items.push({ id: "verdict", statement: g.verdict, quotes: gather(ids).slice(0, 10) });
  }
  // Items without quotes can't be supported; they are decided in code (removed), not sent.
  return items.filter((i) => i.quotes.length).slice(0, 45);
}

function openQuestions(store: ResearchStore): string[] {
  return store.openCritical().map((q) => {
    const tried = [...(store.tried.get(q) ?? [])].filter((u) => /^https?:/.test(u)).slice(0, 2);
    const text = QUESTIONS.find((x) => x.id === q)!.text.split(":")[0].split("(")[0].trim();
    return `Not found: ${text.charAt(0).toLowerCase()}${text.slice(1)}.${tried.length ? ` Checked ${tried.map((u) => baseDomain(u)).join(", ")}.` : ""}`;
  });
}

/**
 * Code checks that replace an LLM critique (SPEC §5). A categorical field survives only if it is backed by the
 * right kind of accepted claim AND, when the judge ran, the field as stated was judged supported.
 */
export function applyInvariants(
  g: Guide,
  store: ResearchStore,
  warnings: string[],
  c: { claimQuestion: Map<string, string | undefined>; accepted: (id: string) => boolean; fieldOk: (key: string) => boolean; judged: boolean },
): Guide {
  const fromQuestion = (id: string, qs: string[]) => c.accepted(id) && qs.includes(c.claimQuestion.get(id) ?? "");
  // Self-serve can't be quoted when docs simply describe no review. It may be inferred, and is labelled as such,
  // only when setup steps were found and no verified evidence anywhere mentions a review, verification or approval.
  const REVIEW_WORDS = /\b(review|verif|approv|certif|audit|assessment|partner program|publish)/i;
  // Only evidence about the path itself (G2) can block the inference; a review of an optional directory listing
  // (usually G3/G11 evidence) says nothing about whether customers can connect without one.
  const anyReviewEvidence = store.verified("G2").some((e) => e.kind !== "reported" && REVIEW_WORDS.test(`${e.quote} ${e.answer}`));
  const canInferSelfServe = !anyReviewEvidence && store.status("G10") === "found";
  const scenarios = g.scenarios.map((s) => {
    const out = { ...s };
    let pathOk = !!out.path && (out.path_claim_ids ?? []).some((id) => fromQuestion(id, ["G2"])) && c.fieldOk(`${s.id}.path`);
    out.path_basis = pathOk ? "stated" : undefined;
    if (!pathOk && out.path === "self_serve" && canInferSelfServe) {
      pathOk = true;
      out.path_basis = "inferred";
    }
    if (!pathOk) {
      if (out.path) warnings.push(`"${s.label}": the path ("${out.path}") is not backed by a verified source, so it is shown as unconfirmed.`);
      delete out.path;
      delete out.trigger;
      delete out.gate_sequence;
      delete out.review_checks;
      // Difficulty rests on the path; without a confirmed path it is not known.
      out.difficulty = "unknown";
    } else {
      // Each detail of a confirmed path stands or falls on its own verdict.
      if (out.trigger && out.trigger !== "none" && !c.fieldOk(`${s.id}.trigger`)) delete out.trigger;
      if (out.gate_sequence?.length && !c.fieldOk(`${s.id}.gates`)) delete out.gate_sequence;
      if (out.review_checks?.length && !c.fieldOk(`${s.id}.checks`)) delete out.review_checks;
    }
    // Waits: a number needs an accepted timeline claim (G6/R1) and a supported field; "None" needs an accepted
    // no-review path. Otherwise the wait is Unknown.
    const est = out.waiting.estimate.trim();
    if (isSubstantiveWait(est)) {
      // Any real wait ("ten weeks", "a few days", "3-5 business days") needs a sourced timeline and a supported field.
      const ok = out.claim_ids.some((id) => fromQuestion(id, ["G6", "R1"])) && c.fieldOk(`${s.id}.wait`);
      if (!ok) out.waiting = { estimate: "Unknown", basis: `No verified source backs this timeline (the agent's estimate was "${est}").`, max_days: null };
    } else if (NO_WAIT.test(est)) {
      const noReview = pathOk && (out.path === "self_serve" || out.path === "automatic");
      if (!noReview) out.waiting = { estimate: "Unknown", basis: `No verified source confirms "${est}".`, max_days: null };
    }
    if (out.shortcut && !((out.shortcut_claim_ids ?? []).some(c.accepted) && c.fieldOk(`${s.id}.shortcut`))) out.shortcut = null;
    if (out.modifiers) out.modifiers = out.modifiers.filter((m, i) => m.claim_ids.some(c.accepted) && c.fieldOk(`${s.id}.mod${i}`)).slice(0, 6);
    // Displayed extras come only from modifiers that survived; the writer's free-text extras are never shown in v2.
    out.extras = (out.modifiers ?? []).map((m) => m.note).slice(0, 3).map((x) => x.split(/\s+/).slice(0, 8).join(" "));
    if (out.gate_sequence) out.gate_sequence = out.gate_sequence.slice(0, 5);
    return out;
  });
  const ids = new Set(scenarios.map((s) => s.id));
  const default_scenario = g.default_scenario && ids.has(g.default_scenario) ? g.default_scenario : undefined;

  // The verdict survives only if the judge supported it and its numbers (with units) come from accepted claims.
  // Otherwise it is rebuilt from the setups that survived. The summary is always built from them: free text is
  // where an unchecked conclusion ("no review needed") would otherwise slip through.
  const acceptedText = g.claims.filter((x) => c.accepted(x.id)).map((x) => `${x.text} ${x.quote ?? ""}`).join(" ");
  const acceptedNums = numbersInText(acceptedText);
  const acceptedPairs = numberUnitPairs(acceptedText);
  const unsupportedNumber = (text: string | undefined) =>
    [...numbersInText(text ?? "")].some((n) => !acceptedNums.has(n)) || [...numberUnitPairs(text ?? "")].some((p) => !acceptedPairs.has(p));
  let verdict = g.verdict;
  if (verdict && (!c.fieldOk("verdict") || unsupportedNumber(verdict))) {
    warnings.push("The one-line verdict could not be confirmed against the sources; it was rebuilt from the setups.");
    verdict = undefined;
  }
  const describe = (s: (typeof scenarios)[number]) => {
    const how = s.path ? pathLabel(s)!.toLowerCase() : "approval path unconfirmed";
    const wait = /^unknown$/i.test(s.waiting.estimate) ? "" : `, wait ${s.waiting.estimate.toLowerCase()}`;
    return `${s.label} (${how}${wait})`;
  };
  const rank = { easy: 0, medium: 1, hard: 2, unknown: 3 } as const;
  const known = scenarios.filter((s) => s.path);
  const easiest = [...known].sort((a, b) => rank[a.difficulty] - rank[b.difficulty])[0];
  const hardest = [...known].sort((a, b) => rank[b.difficulty] - rank[a.difficulty])[0];
  if (!verdict) verdict = easiest && hardest && easiest.id !== hardest.id ? `Easiest: ${describe(easiest)}. Hardest: ${describe(hardest)}.` : easiest ? `${describe(easiest)}.` : undefined;
  const summary = scenarios.length
    ? `${scenarios.map(describe).join("; ")}.${known.length < scenarios.length ? " Where the path is unconfirmed, the agent did not find it in the provider's docs." : ""}`
    : "The agent could not confirm any setup for this app. The verified facts and open questions are below.";
  const open = openQuestions(store);
  const open_questions = [...g.open_questions, ...open.filter((o) => !g.open_questions.some((x) => x.includes(o.slice(11, 40))))];
  if (!c.judged && g.scenarios.length) warnings.push("Setup details (path, waits, shortcuts) could not be double-checked, so they are not shown.");
  return { ...g, scenarios, default_scenario, verdict, summary, open_questions };
}
