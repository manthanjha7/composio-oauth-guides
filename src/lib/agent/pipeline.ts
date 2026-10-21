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
import { baseDomain, canonicalUrl, enforceEvidence, type EvidenceContext } from "../evidence";
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

const Verdicts = z.array(z.object({ id: z.string(), verdict: z.enum(["supported", "partial", "contradicted"]), reason: z.string().optional() }));

const MAX_PAGES = 8;
const MAX_CLAIMS = 40;
const MAX_SCENARIOS = 4;
const VERIFY_RESERVE = 20_000;

type ToolResult = { content: string; isError?: boolean; stop?: boolean };

/**
 * One tool-using conversation. Append-only: system, tools and effort are fixed for its whole life (current
 * models tie thinking to the exact history), budgets are enforced by refusing tool calls in code, and a
 * deadline simply ends the loop. Returns why it stopped.
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
  signal?: AbortSignal;
}): Promise<"finished" | "deadline" | "turns" | "no_tool_call" | `error: ${string}`> {
  const messages: BetaMessageParam[] = [{ role: "user", content: o.user }];
  const effort = resolveEffort(o.stage);
  for (let turn = 0; turn < o.maxTurns; turn++) {
    if (o.deadline - Date.now() < 6_000) return "deadline";
    o.signal?.throwIfAborted();
    let msg: BetaMessage;
    try {
      msg = await o.llm.call({ stage: o.stage, model: o.model, effort, system: o.system, tools: o.tools, messages, cache: true, maxTokens: 16_000 }, o.deadline);
    } catch (e) {
      if (o.signal?.aborted) throw e;
      return Date.now() >= o.deadline - 6_000 ? "deadline" : `error: ${(e as Error).message}`;
    }
    o.onMessage?.(msg);
    if (msg.stop_reason === "refusal") return "error: the model declined";
    messages.push({ role: "assistant", content: msg.content });
    if (msg.stop_reason === "pause_turn") continue;
    const uses = msg.content.filter((b): b is BetaToolUseBlock => b.type === "tool_use");
    if (!uses.length) return "no_tool_call";
    let stop = false;
    const results = await Promise.all(
      uses.map(async (t) => {
        try {
          const r = await o.runTool(t.name, (t.input ?? {}) as Record<string, unknown>);
          if (r.stop) stop = true;
          return { type: "tool_result" as const, tool_use_id: t.id, content: r.content, is_error: r.isError };
        } catch (e) {
          return { type: "tool_result" as const, tool_use_id: t.id, content: `Tool error: ${(e as Error).message}`, is_error: true };
        }
      }),
    );
    // All results for one turn go back in a single user message.
    messages.push({ role: "user", content: results });
    if (stop) return "finished";
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
  const client = opts.client ?? new Anthropic();
  const models = resolveModels(opts.models);
  const llm = createLlm(client, { signal: opts.signal, onWarning: (m) => emit({ type: "warning", message: m }) });
  const runDeadline = started + (opts.totalBudgetMs ?? 270_000);
  // Plan backwards from the writer: it needs the most time and runs last.
  const writeReserve = Math.min(150_000, Math.max(90_000, Math.round((7_000 / capabilities(models.write).outputTps) * 1000) + 15_000));
  const researchDeadline = runDeadline - writeReserve - VERIFY_RESERVE;
  const timings: Record<string, number> = {};
  const mark = (k: string, t0: number) => (timings[k] = Date.now() - t0);
  const workers: { name: string; stop: string; ms: number }[] = [];
  const runId = Math.random().toString(36).slice(2, 10);

  emit({ type: "stage", stage: "start", message: `Researching ${opts.query}` });

  // ---- 1. Identify: Composio lookup and the search session start together ----
  let t0 = Date.now();
  emit({ type: "stage", stage: "composio", message: "Checking Composio" });
  const searchP: Promise<ComposioSearch | null> =
    opts.search !== undefined
      ? Promise.resolve(opts.search)
      : Promise.race([createComposioSearch(runId), new Promise<null>((r) => setTimeout(() => r(null), 15_000))]).catch(() => null);
  const lookup: ComposioLookup | null = await composioLookup(opts.query).catch(() => null);
  if (lookup) emit({ type: "composio", managed: lookup.managed_oauth, slug: lookup.chosen?.slug ?? lookup.toolkit?.slug ?? null, guide: lookup.credential_guide?.url ?? null });
  const search = await searchP;
  if (!search && opts.search === undefined && process.env.COMPOSIO_API_KEY) emit({ type: "warning", message: "Composio Search unavailable; using Anthropic web search." });
  const searchVia = search ? "composio_search" : "anthropic_web_search";

  const store = new ResearchStore(search, (url, ok, chars, via, error) => emit({ type: "fetch", url, ok, chars, via, error }));
  store.addOfficial(lookup?.app_url ?? null);
  for (const p of lookup?.pages ?? []) {
    // Composio's own pages, read during lookup, become citable pages.
    store.pages.set(canonicalUrl(p.url), { url: p.url, title: null, text: p.text, links: [], fetched_at: new Date().toISOString(), hash: "", via: "direct" });
  }

  // Server web search is declared once per conversation, with its budget fixed up front.
  const searchTools = (maxUses: number): BetaToolUnion[] =>
    search ? [searchTool] : [{ type: capabilities(models.identify).webSearchTool, name: "web_search", max_uses: maxUses } as BetaToolUnion];
  const onServerSearch = (m: BetaMessage) => {
    for (const b of m.content) {
      if (b.type === "web_search_tool_result" && Array.isArray(b.content)) {
        const results = b.content.flatMap((r) => (r.type === "web_search_result" ? [{ title: r.title, url: r.url }] : []));
        results.forEach((r) => store.seenUrls.add(r.url));
        emit({ type: "search", query: "", via: "Anthropic web search", results: results.slice(0, 5) });
      }
    }
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
  const runFetch = async (url: string, budget: { left: number }, maxChars: number): Promise<ToolResult> => {
    if (budget.left <= 0) return { content: "Page budget spent. Use what you have, then finish.", isError: true };
    budget.left--;
    const page = await store.fetch(url);
    if (!page) return { content: `Could not fetch ${url}. Try the same URL + ".md", the site's /llms.txt, or another page.`, isError: true };
    return { content: `URL: ${page.url}\nTITLE: ${page.title ?? ""}\n\n<page>\n${trimForModel(page.text, maxChars)}\n</page>` };
  };

  emit({ type: "stage", stage: "identify", message: "Identifying the provider" });
  let identity: IdentityT | null = null;
  {
    const sBudget = { left: 2 };
    const fBudget = { left: 2 };
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
        ...searchTools(2),
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
      deadline: Math.min(started + 30_000, researchDeadline),
      maxTurns: 6,
      signal: opts.signal,
      onMessage: onServerSearch,
      runTool: async (name, input) => {
        if (name === "web_search") return runSearch(String(input.query ?? ""), sBudget);
        if (name === "fetch_page") return runFetch(String(input.url ?? ""), fBudget, 6_000);
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

  // ---- 2–3. Discover and read ----
  t0 = Date.now();
  emit({ type: "stage", stage: "research", message: `Finding ${ident.name}'s OAuth, review and limits pages` });
  // The model's URLs are leads. A domain becomes official only once a page on it was actually fetched.
  const anchors = await Promise.all([ident.website, ident.developer_docs_url].filter((u): u is string => !!u).map((u) => store.fetch(u)));
  anchors.forEach((p) => p && store.addOfficial(p.url));
  const entry = [...new Set([...(ident.entry_points ?? []), ident.developer_docs_url ?? ""].filter((u) => /^https?:\/\//.test(u)))].slice(0, 8);
  const { candidates } = await discover({
    app: ident.name,
    entryPoints: entry,
    docsUrl: ident.developer_docs_url ?? null,
    store,
    search,
    max: MAX_PAGES,
    onSearch: (query, results) => emit({ type: "search", query, via: "Composio Search", results: results.slice(0, 5).map(({ title, url }) => ({ title, url })) }),
  });
  emit({ type: "stage", stage: "research", message: `Reading ${candidates.length} pages` });
  const read = (await Promise.all(candidates.map((c) => store.fetch(c.url)))).filter((p): p is Page => !!p);
  store.expandOfficialFromLinks();
  store.relabel();
  mark("discover_read", t0);

  // ---- 4. Extract: one citations call per page, all in parallel ----
  t0 = Date.now();
  const providerPages = dedupePages(read).filter((p) => !/composio\.dev/.test(p.url) && !/\/llms\.txt$/.test(p.url));
  const composioPages = [...store.pages.values()].filter((p) => /composio\.dev/.test(p.url)).slice(0, 3);
  emit({ type: "stage", stage: "research", message: `Extracting facts from ${providerPages.length + composioPages.length} pages` });
  const extractDeadline = Math.min(Date.now() + 45_000, researchDeadline - 15_000);
  const extractOne = async (page: Page, ids: QuestionId[]) => {
    const tStart = Date.now();
    try {
      const msg = await llm.call(
        {
          stage: "research",
          model: models.research,
          effort: resolveEffort("research"),
          system: EXTRACT_SYSTEM,
          maxTokens: 8_000,
          messages: [
            {
              role: "user",
              content: [
                { type: "document", source: { type: "text", media_type: "text/plain", data: trimForModel(page.text, 60_000) }, title: page.url, citations: { enabled: true } },
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
  };
  await Promise.all([...providerPages.map((p) => extractOne(p, PROVIDER_QUESTIONS)), ...composioPages.map((p) => extractOne(p, COMPOSIO_QUESTIONS))]);
  mark("extract", t0);
  emitCoverage(emit, store);

  // ---- 6. Gap fill: open critical questions, and developer reports, in parallel ----
  t0 = Date.now();
  const open = store.openCritical().slice(0, 3);
  const gapDeadline = researchDeadline;
  const gapJobs: { name: string; ids: QuestionId[] }[] = [];
  if (open.length) gapJobs.push({ name: "gap: official docs", ids: open });
  if (store.status("R1") === "not_found") gapJobs.push({ name: "gap: developer reports", ids: store.status("G6") === "found" ? ["R1"] : ["R1", "G6"] });
  if (gapJobs.length && gapDeadline - Date.now() > 15_000) {
    emit({ type: "stage", stage: "research", message: open.length ? `Searching for what the docs didn't answer (${open.join(", ")})` : "Looking for developer reports" });
    await Promise.all(
      gapJobs.map(async (job) => {
        const tStart = Date.now();
        const sBudget = { left: 2 };
        const fBudget = { left: 3 };
        const stop = await toolLoop({
          llm,
          stage: "research",
          model: models.research,
          system: GAPFILL_SYSTEM,
          tools: [
            ...searchTools(2),
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
          deadline: gapDeadline,
          maxTurns: 8,
          signal: opts.signal,
          onMessage: onServerSearch,
          runTool: async (name, input) => {
            if (name === "web_search") return runSearch(String(input.query ?? ""), sBudget);
            if (name === "fetch_page") {
              const r = await runFetch(String(input.url ?? ""), fBudget, 12_000);
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
  for (let attempt = 0; attempt < 2 && !written; attempt++) {
    if (attempt > 0 && runDeadline - Date.now() < 40_000) break;
    try {
      const msg = await llm.call({ stage: "write", model: models.write, effort: resolveEffort("write"), system, messages: writeMessages, maxTokens: 48_000 }, runDeadline - VERIFY_RESERVE + 10_000);
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
      emit({ type: "warning", message: "Fixing the guide's format (one retry)" });
      writeMessages.push({ role: "assistant", content: msg.content }, { role: "user", content: `Fix these problems and return the complete corrected JSON object only:\n${problem}` });
    } catch (e) {
      const message = e instanceof Anthropic.APIError ? `Model API error while writing (${e.status ?? "network"}): ${e.message}` : `Could not write the guide: ${(e as Error).message}`;
      emit({ type: "error", message });
      return { outcome: "error", message };
    }
  }
  mark("write", t0);
  if (!written) {
    emit({ type: "error", message: "Could not produce a valid guide." });
    return { outcome: "error", message: "Could not produce a valid guide." };
  }

  // ---- 8. Verify ----
  t0 = Date.now();
  emit({ type: "stage", stage: "verify", message: "Checking every claim against its source" });
  const generated = fromWriter(written, store);
  const ctx: EvidenceContext = {
    pages: new Map([...store.pages.values()].map((p) => [canonicalUrl(p.url), p.text])),
    seenUrls: new Set([...store.seenUrls, ...[...store.pages.values()].map((p) => p.url)]),
    probes: [],
    officialDomains: [...store.official],
    strictOfficial: true,
  };
  const enforced = enforceEvidence(generated, ctx);
  const warnings = [...enforced.warnings];
  const evQuestion = new Map(store.evidence.filter((e) => e.status === "verified").map((e) => [e.id, e.question]));
  const claimQuestion = new Map(written.claims.map((c) => [c.id, c.evidence_id ? evQuestion.get(c.evidence_id) : undefined]));
  const guide = applyInvariants(enforced.guide, store, warnings, claimQuestion);

  // Entailment judge: claims on the critical questions, plus any claim the word checks flagged.
  let judge: { checked: number; supported: number; partial: number; contradicted: number } | null = null;
  const toJudge = guide.claims
    .filter((c) => c.quote && (c.label === "provider_docs" || c.label === "composio_docs" || c.label === "reported"))
    .filter((c) => ["G2", "G3", "G4", "G5", "G6", "G7", "G8"].includes(claimQuestion.get(c.id) ?? "") || (c.note ?? "").includes("Check the quote"))
    .slice(0, 30);
  if (toJudge.length && runDeadline - Date.now() > 25_000) {
    try {
      const msg = await llm.call(
        {
          stage: "critic",
          model: models.critic,
          effort: resolveEffort("critic"),
          system: JUDGE_SYSTEM,
          maxTokens: 6_000,
          messages: [{ role: "user", content: JSON.stringify(toJudge.map((c) => ({ id: c.id, claim: c.text, quote: c.quote }))) }],
        },
        runDeadline - 8_000,
      );
      const verdicts = Verdicts.safeParse(JSON.parse(extractJson(textOf(msg))));
      if (verdicts.success) {
        judge = { checked: toJudge.length, supported: 0, partial: 0, contradicted: 0 };
        const byIdV = new Map(verdicts.data.map((v) => [v.id, v]));
        guide.claims = guide.claims.map((c) => {
          const v = byIdV.get(c.id);
          if (!v || !toJudge.some((t) => t.id === c.id)) return c;
          judge![v.verdict]++;
          if (v.verdict === "contradicted") return { ...c, label: "unknown", note: `The quote does not support this claim${v.reason ? `: ${v.reason}` : "."}` };
          if (v.verdict === "partial") return { ...c, note: `Partly supported by the quote${v.reason ? `: ${v.reason}` : "."}` };
          return { ...c, note: (c.note ?? "").includes("Check the quote") ? null : c.note };
        });
        if (judge.contradicted) enforced.stats.downgraded += judge.contradicted;
      } else warnings.push("The evidence judge's answer could not be read; claims were not double-checked.");
    } catch (e) {
      warnings.push(`The evidence judge did not run: ${(e as Error).message}`);
    }
  }
  mark("verify", t0);

  emit({ type: "verify", total: enforced.stats.claims_total, checked: enforced.stats.quotes_checked, verified: enforced.stats.quotes_verified, downgraded: enforced.stats.downgraded });
  warnings.forEach((w) => emit({ type: "warning", message: w }));
  emit({ type: "cost", usd: llm.spend.usd, input_tokens: llm.spend.input_tokens, output_tokens: llm.spend.output_tokens, web_searches: llm.spend.web_searches });

  const partial = store.openCritical().length > 0 || workers.some((w) => w.stop === "deadline");
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
      verification: enforced.stats,
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
        questions: store.questionRecords(),
        evidence: store.evidence,
        workers,
        judge,
        timings_ms: timings,
      },
    },
  };
  return { outcome: "ok", record };
}

function dedupePages(pages: Page[]): Page[] {
  const seen = new Set<string>();
  return pages.filter((p) => (seen.has(p.hash) ? false : (seen.add(p.hash), true)));
}

function emitCoverage(emit: (e: AgentEvent) => void, store: ResearchStore) {
  const found = QUESTIONS.filter((q) => store.status(q.id) === "found").map((q) => q.id);
  const open = store.openCritical();
  emit({ type: "note", text: `Answered ${found.length} of ${QUESTIONS.length} questions${open.length ? `; still open: ${open.join(", ")}` : ""}.` });
}

/**
 * Turn a Citations-API reply into evidence. The reply has "## G5" headings; each cited sentence becomes one
 * evidence item per citation, with the cited text as the quote (it points into the page by construction).
 */
export function collectCitations(msg: BetaMessage, page: Page, store: ResearchStore, allowed: QuestionId[]): number {
  let current: QuestionId | null = null;
  let n = 0;
  for (const b of msg.content) {
    if (b.type !== "text") continue;
    const headings = [...b.text.matchAll(/##\s*([A-Z]\d{1,2})\b/g)].map((m) => m[1]);
    const last = headings.at(-1);
    if (last && isQuestionId(last) && allowed.includes(last)) current = last;
    else if (last) current = null;
    if (!current || !b.citations?.length) continue;
    const answer = b.text.replace(/##\s*[A-Z]\d{1,2}\b/g, "").trim();
    for (const c of b.citations) {
      if (c.type !== "char_location" || !c.cited_text?.trim()) continue;
      const item = store.addEvidence({ question: current, url: page.url, quote: c.cited_text.trim(), answer: answer || c.cited_text.trim(), via: "extract" });
      if (item.status === "verified") n++;
    }
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
      .map((e) => `${e.id} [${e.kind}] (${e.question}) ${e.url}\n  quote: "${e.quote.slice(0, 400)}"\n  answer: ${e.answer.slice(0, 300)}`)
      .join("\n")}`,
  );
  const failed = store.evidence.length - verified.length;
  if (failed) parts.push(`(${failed} more findings failed verification and are not citable.)`);
  return parts.join("\n\n");
}

/** Writer output → generated guide: label, url and quote come from the evidence ledger, never from the writer. */
export function fromWriter(w: WriterGuide, store: ResearchStore): GeneratedGuide {
  const ev = new Map(store.evidence.filter((e) => e.status === "verified").map((e) => [e.id, e]));
  const claims = w.claims.slice(0, MAX_CLAIMS).map((c) => {
    const e = c.evidence_id ? ev.get(c.evidence_id) : undefined;
    return e
      ? { id: c.id, text: c.text, label: e.kind, source_url: e.url, quote: e.quote, probe_id: null }
      : { id: c.id, text: c.text, label: "unknown" as const, source_url: null, quote: null, probe_id: null };
  });
  return { ...w, scenarios: w.scenarios.slice(0, MAX_SCENARIOS), claims };
}

/** Code checks that replace an LLM critique (SPEC §5, rules 6–9). Mutates nothing; returns a new guide. */
export function applyInvariants(g: Guide, store: ResearchStore, warnings: string[], claimQuestion: Map<string, string | undefined>): Guide {
  const claims = new Map(g.claims.map((c) => [c.id, c]));
  const verifiedClaim = (id: string) => {
    const c = claims.get(id);
    return !!c && c.label !== "unknown";
  };
  // A path is backed only by a verified claim whose own evidence answers G2 (not any claim from the same page).
  const backsPath = (id: string) => verifiedClaim(id) && claimQuestion.get(id) === "G2";
  const scenarios = g.scenarios.map((s) => {
    const out = { ...s };
    if (out.path && !(out.path_claim_ids ?? []).some(backsPath)) {
      warnings.push(`"${s.label}": the path ("${out.path}") is not backed by a verified source, so it is shown as unconfirmed.`);
      delete out.path;
      delete out.trigger;
      delete out.gate_sequence;
    }
    if (out.shortcut && !(out.shortcut_claim_ids ?? []).some(verifiedClaim)) out.shortcut = null;
    if (out.modifiers) out.modifiers = out.modifiers.filter((m) => m.claim_ids.some(verifiedClaim)).slice(0, 6);
    if (!out.extras?.length && out.modifiers?.length) out.extras = out.modifiers.map((m) => m.note).slice(0, 3);
    if (out.extras) out.extras = out.extras.slice(0, 3).map((x) => x.split(/\s+/).slice(0, 8).join(" "));
    if (out.gate_sequence) out.gate_sequence = out.gate_sequence.slice(0, 5);
    return out;
  });
  const ids = new Set(scenarios.map((s) => s.id));
  const default_scenario = g.default_scenario && ids.has(g.default_scenario) ? g.default_scenario : undefined;

  // Numbers in the verdict must come from verified claims; otherwise rebuild it from the scenarios.
  const verifiedText = g.claims.filter((c) => c.label !== "unknown").map((c) => `${c.text} ${c.quote ?? ""}`).join(" ");
  let verdict = g.verdict;
  const nums = (verdict ?? "").match(/\d+/g) ?? [];
  if (verdict && nums.some((n) => !new RegExp(`\\b${n}\\b`).test(verifiedText))) {
    warnings.push("The one-line verdict used numbers no verified claim supports; it was rebuilt from the setups.");
    const rank = { easy: 0, medium: 1, hard: 2, unknown: 3 } as const;
    const sorted = [...scenarios].sort((a, b) => rank[a.difficulty] - rank[b.difficulty]);
    const e = sorted[0];
    const h = [...scenarios].filter((s) => s.difficulty !== "unknown").sort((a, b) => rank[b.difficulty] - rank[a.difficulty])[0];
    verdict = e && h && e.id !== h.id ? `Easiest: ${e.label} (${e.difficulty}). Hardest: ${h.label} (${h.difficulty}).` : undefined;
  }
  // Each critical question not found is listed as unconfirmed, with where the agent looked.
  const open = store.openCritical().map((q) => {
    const tried = [...(store.tried.get(q) ?? [])].slice(0, 2);
    const text = QUESTIONS.find((x) => x.id === q)!.text.split(":")[0].split("(")[0].trim();
    return `Not found: ${text.charAt(0).toLowerCase()}${text.slice(1)}.${tried.length ? ` Checked ${tried.map((u) => baseDomain(u)).join(", ")}.` : ""}`;
  });
  const open_questions = [...g.open_questions, ...open.filter((o) => !g.open_questions.some((x) => x.includes(o.slice(11, 40))))];
  return { ...g, scenarios, default_scenario, verdict, open_questions };
}
