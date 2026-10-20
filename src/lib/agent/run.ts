import Anthropic from "@anthropic-ai/sdk";
import type { BetaMessageParam, BetaToolUnion, BetaToolUseBlock } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { z } from "zod";
import { composioLookup, type ComposioLookup } from "../composio";
import { canonicalUrl, enforceEvidence, type EvidenceContext } from "../evidence";
import { GeneratedGuideSchema, type GuideRecord, type ProbeRecordT, type SourceRecordT } from "../schema";
import { createComposioSearch, type ComposioSearch, type SearchHit } from "../search";
import { slugify } from "../slug";
import { fetchPageText, probe, trimForModel } from "../web";
import { researchSystem, WRITE_SYSTEM } from "./prompt";


// Research (many cheap tool-calling turns) runs on Haiku; writing the guide (one careful structured call) on Sonnet.
export const RESEARCH_MODEL = process.env.AGENT_RESEARCH_MODEL || "claude-haiku-5-5";
export const MODEL = process.env.AGENT_MODEL || "claude-sonnet-5-5";
type Effort = "low" | "medium" | "high";
const RESEARCH_EFFORT = (process.env.AGENT_RESEARCH_EFFORT || "medium") as Effort;
const EFFORT = (process.env.AGENT_EFFORT || "medium") as Effort;
const BETAS: Anthropic.Beta.AnthropicBeta[] = ["server-side-fallback-2026-07-01"];

// Server-side refusal fallback ("default" form) is supported on these model families; Haiku has none.
const supportsFallback = (m: string) => /claude-(opus|sonnet|fable)-5/.test(m);
// Dynamic-filtering web search needs Sonnet/Opus 4.6+; other models use the basic variant.
const webSearchType = (m: string) => (/claude-(opus|sonnet|fable)-/.test(m) ? "web_search_20260209" : "web_search_20250305");

// USD per million tokens (input, output). Cache writes ~1.25x input, cache reads 0.1x input. Web search $10/1k.
const PRICES: Record<string, [number, number]> = {
  "claude-haiku-5-5": [0.1, 0.5],
  "claude-sonnet-5-5": [2, 10],
  "claude-opus-5-5": [4, 20],
};
type Usage = { input_tokens: number; output_tokens: number; cache_creation_input_tokens?: number | null; cache_read_input_tokens?: number | null; server_tool_use?: { web_search_requests?: number } | null };
export function estimateCost(model: string, u: Usage): number {
  const [pin, pout] = PRICES[model] ?? [4, 20];
  const searches = u.server_tool_use?.web_search_requests ?? 0;
  return (
    (u.input_tokens * pin + (u.cache_creation_input_tokens ?? 0) * pin * 1.25 + (u.cache_read_input_tokens ?? 0) * pin * 0.1 + u.output_tokens * pout) / 1e6 +
    searches * 0.01
  );
}

export type AgentEvent =
  | { type: "stage"; stage: "start" | "composio" | "identify" | "research" | "probe" | "write" | "verify" | "save"; message: string }
  | { type: "identified"; name: string; website: string | null; docs: string | null; oauth: string }
  | { type: "composio"; managed: string; slug: string | null; guide: string | null }
  | { type: "search"; query: string; via: string; results: { title: string; url: string }[] }
  | { type: "fetch"; url: string; ok: boolean; chars: number; via: string; error?: string }
  | { type: "probe"; id: string; url: string; status: number | null; observation: string }
  | { type: "note"; text: string }
  | { type: "verify"; total: number; checked: number; verified: number; downgraded: number }
  | { type: "cost"; usd: number; input_tokens: number; output_tokens: number; web_searches: number }
  | { type: "warning"; message: string }
  | { type: "done"; slug: string; partial: boolean }
  | { type: "ambiguous"; candidates: string[] }
  | { type: "not_oauth"; message: string }
  | { type: "error"; message: string };

export interface RunOptions {
  query: string;
  emit: (e: AgentEvent) => void;
  client?: Anthropic;
  /** Injected for tests; otherwise created from COMPOSIO_API_KEY (null = use Anthropic web search). */
  search?: ComposioSearch | null;
  maxSearches?: number;
  maxFetches?: number;
  researchBudgetMs?: number;
  /** Whole run, including writing. Keep below the route's maxDuration (300s) to leave time to save. */
  totalBudgetMs?: number;
  signal?: AbortSignal;
}

export type RunResult =
  | { outcome: "ok"; record: GuideRecord }
  | { outcome: "ambiguous"; candidates: string[] }
  | { outcome: "not_oauth"; message: string }
  | { outcome: "error"; message: string };

const ConfirmApp = z.object({
  name: z.string(),
  website: z.string().nullable().optional(),
  developer_docs_url: z.string().nullable().optional(),
  oauth_for_third_party_apps: z.enum(["yes", "no", "unclear"]),
  ambiguous: z.boolean().optional(),
  candidates: z.array(z.string()).optional(),
});

function customTools(useComposioSearch: boolean): BetaToolUnion[] {
  const tools: BetaToolUnion[] = [
    {
      name: "composio_lookup",
      description:
        "Look the app up in Composio's published material: the managed-OAuth directory, the toolkit page (auth type, known errors FAQ) and the composio.dev/auth credential guide. Call this first.",
      input_schema: {
        type: "object",
        properties: {
          app_name: { type: "string", description: "App name or website as the user typed it" },
          slug_hint: { type: "string", description: "Optional exact Composio toolkit slug, e.g. 'gmail'" },
        },
        required: ["app_name"],
      },
    },
    {
      name: "confirm_app",
      description:
        "State which provider you are researching before deep research. Shown to the user so a wrong match is obvious. If the input could mean several different products, set ambiguous=true with candidates.",
      input_schema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Short official product name only, e.g. 'Gmail' or 'Box' (no parentheses or company suffixes)" },
          website: { type: ["string", "null"] },
          developer_docs_url: { type: ["string", "null"] },
          oauth_for_third_party_apps: { type: "string", enum: ["yes", "no", "unclear"] },
          ambiguous: { type: "boolean" },
          candidates: { type: "array", items: { type: "string" } },
        },
        required: ["name", "oauth_for_third_party_apps"],
      },
    },
    {
      name: "fetch_page",
      description: "Fetch a public web page and return its readable text. Use for official developer docs.",
      input_schema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    },
    {
      name: "probe_url",
      description:
        "Send one GET request without following redirects and record status, redirect target and the start of the body. Use on the provider's OAuth authorize endpoint with a dummy client_id, or on a developer console / review page, to observe live behaviour. Returns a probe id to cite.",
      input_schema: {
        type: "object",
        properties: { url: { type: "string" }, purpose: { type: "string", description: "What you are checking" } },
        required: ["url", "purpose"],
      },
    },
    {
      name: "finish_research",
      description: "Call when you have enough evidence (or the budget is spent). Notes: key findings, scenarios, unknowns.",
      input_schema: { type: "object", properties: { notes: { type: "string" } }, required: ["notes"] },
    },
  ];
  if (useComposioSearch) {
    tools.push({
      name: "web_search",
      description: "Search the web (via Composio Search). Returns titles, URLs and snippets. Snippets are leads; fetch pages for evidence.",
      input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    });
  }
  return tools;
}

export async function runAgent(opts: RunOptions): Promise<RunResult> {
  const started = Date.now();
  const emit = opts.emit;
  const client = opts.client ?? new Anthropic();
  const maxSearches = opts.maxSearches ?? 5;
  const maxFetches = opts.maxFetches ?? 10;
  const researchDeadline = started + (opts.researchBudgetMs ?? 150_000);
  const runDeadline = started + (opts.totalBudgetMs ?? 270_000);
  const runId = Math.random().toString(36).slice(2, 10);

  let search: ComposioSearch | null = null;
  if (opts.search !== undefined) search = opts.search;
  else {
    try {
      search = await Promise.race([
        createComposioSearch(runId),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error("session setup timed out")), 15_000)),
      ]);
    } catch (e) {
      emit({ type: "warning", message: `Composio Search unavailable (${(e as Error).message}); using Anthropic web search instead.` });
    }
  }
  const searchVia = search ? "composio_search" : "anthropic_web_search";

  const ctx: EvidenceContext = { pages: new Map(), seenUrls: new Set(), probes: [], officialDomains: [] };
  const sources: SourceRecordT[] = [];
  const hits: SearchHit[] = [];
  let lookup: ComposioLookup | null = null;
  let identified: z.infer<typeof ConfirmApp> | null = null;
  let notes = "";
  let searches = 0;
  let fetches = 0;
  let partial = false;

  const addPage = (url: string, text: string, via: SourceRecordT["via"], title: string | null = null) => {
    ctx.pages.set(canonicalUrl(url), text);
    sources.push({ url, title, fetched_at: new Date().toISOString(), via, chars: text.length });
  };

  emit({ type: "stage", stage: "start", message: `Researching ${opts.query}` });

  const tools = customTools(!!search);
  if (!search) {
    tools.push({ type: webSearchType(RESEARCH_MODEL), name: "web_search", max_uses: maxSearches } as BetaToolUnion);
  }

  // Anthropic's server-side web search counts max_uses per request, so pass the remaining run budget each turn.
  const toolsForTurn = (): BetaToolUnion[] =>
    search
      ? tools
      : tools.map((t) => ("name" in t && t.name === "web_search" && "type" in t ? { ...t, max_uses: Math.max(1, maxSearches - searches) } : t));

  // Server-side refusal fallback is on by default; if the API rejects it for this request shape, retry once without it.
  // Every call gets a timeout derived from a deadline so a slow response can't outlive the serverless function.
  let useFallbacks = process.env.AGENT_FALLBACKS !== "off";
  const spend = { usd: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, web_searches: 0 };
  type StreamParams = Parameters<typeof client.beta.messages.stream>[0];
  async function callModel(params: StreamParams, deadlineAt: number) {
    const run = async (withFallbacks: boolean) => {
      const msg = await client.beta.messages
        .stream(withFallbacks ? { ...params, betas: BETAS, fallbacks: "default" } : params, {
          signal: opts.signal,
          timeout: Math.max(10_000, deadlineAt - Date.now()),
          maxRetries: 1,
        })
        .finalMessage();
      const u = msg.usage as Usage | undefined;
      if (u) {
        spend.usd += estimateCost(params.model, u);
        spend.input_tokens += u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
        spend.output_tokens += u.output_tokens;
        spend.cache_read_tokens += u.cache_read_input_tokens ?? 0;
        spend.web_searches += u.server_tool_use?.web_search_requests ?? 0;
      }
      return msg;
    };
    if (!useFallbacks || !supportsFallback(params.model)) return run(false);
    try {
      return await run(true);
    } catch (e) {
      if (!(e instanceof Anthropic.BadRequestError)) throw e;
      useFallbacks = false;
      emit({ type: "warning", message: "Retrying without the safety fallback" });
      return run(false);
    }
  }

  async function runTool(name: string, input: Record<string, unknown>): Promise<{ content: string; isError?: boolean; stop?: "finish" | "ambiguous" | "not_oauth" }> {
    switch (name) {
      case "composio_lookup": {
        emit({ type: "stage", stage: "composio", message: "Checking Composio" });
        lookup = await composioLookup(String(input.app_name ?? opts.query), input.slug_hint ? String(input.slug_hint) : undefined);
        for (const p of lookup.pages) addPage(p.url, p.text, "direct");
        emit({ type: "composio", managed: lookup.managed_oauth, slug: lookup.chosen?.slug ?? lookup.toolkit?.slug ?? null, guide: lookup.credential_guide?.url ?? null });
        return {
          content: JSON.stringify({
            composio_facts: lookup.facts,
            directory_url: lookup.directory_url,
            catalog_matches: lookup.matches,
            managed_oauth: lookup.managed_oauth,
            api_managed_schemes: lookup.api_managed_schemes,
            toolkit_page: lookup.toolkit ? { url: `https://docs.composio.dev/toolkits/${lookup.toolkit.slug}`, header: lookup.toolkit.header, faq: lookup.toolkit.faq } : null,
            credential_guide: lookup.credential_guide,
          }),
        };
      }
      case "confirm_app": {
        const parsed = ConfirmApp.safeParse(input);
        if (!parsed.success) return { content: `Invalid input: ${parsed.error.message}`, isError: true };
        identified = parsed.data;
        if (parsed.data.ambiguous && parsed.data.candidates?.length) {
          return { content: "Stopping: ambiguous input.", stop: "ambiguous" };
        }
        emit({ type: "identified", name: parsed.data.name, website: parsed.data.website ?? null, docs: parsed.data.developer_docs_url ?? null, oauth: parsed.data.oauth_for_third_party_apps });
        emit({ type: "stage", stage: "research", message: `Reading ${parsed.data.name}'s official developer docs` });
        if (parsed.data.oauth_for_third_party_apps === "no") return { content: "Noted: no OAuth. Call finish_research.", stop: undefined };
        return { content: "Confirmed. Continue researching." };
      }
      case "web_search": {
        if (!search) return { content: "web_search is the server tool in this run", isError: true };
        if (searches >= maxSearches) return { content: "Search budget spent. Use what you have.", isError: true };
        searches++;
        const query = String(input.query ?? "");
        try {
          const results = await search.search(query);
          results.forEach((r) => {
            hits.push(r);
            ctx.seenUrls.add(r.url);
          });
          emit({ type: "search", query, via: "Composio Search", results: results.slice(0, 5).map(({ title, url }) => ({ title, url })) });
          return { content: JSON.stringify(results) };
        } catch (e) {
          emit({ type: "warning", message: `Search failed: ${(e as Error).message}` });
          return { content: `Search failed: ${(e as Error).message}. Try fetching a known docs URL instead.`, isError: true };
        }
      }
      case "fetch_page": {
        if (fetches >= maxFetches) return { content: "Fetch budget spent. Use what you have.", isError: true };
        fetches++;
        const url = String(input.url ?? "");
        try {
          const page = await fetchPageText(url);
          if (page.text.length < 400 && search) throw new Error("page looks empty (likely rendered by JavaScript)");
          addPage(page.url, page.text, "direct", page.title);
          if (page.url !== url) ctx.pages.set(canonicalUrl(url), page.text);
          emit({ type: "fetch", url: page.url, ok: true, chars: page.text.length, via: "direct" });
          return { content: `URL: ${page.url}\nTITLE: ${page.title ?? ""}\n\n${trimForModel(page.text, 10_000)}` };
        } catch (e) {
          if (search) {
            try {
              const page = await search.fetch(url);
              if (page) {
                addPage(page.url, page.text, "composio_fetch", page.title);
                if (page.url !== url) ctx.pages.set(canonicalUrl(url), page.text);
                emit({ type: "fetch", url: page.url, ok: true, chars: page.text.length, via: "Composio fetch" });
                return { content: `URL: ${page.url}\nTITLE: ${page.title ?? ""}\n\n${trimForModel(page.text, 10_000)}` };
              }
            } catch {
              /* fall through */
            }
          }
          emit({ type: "fetch", url, ok: false, chars: 0, via: "direct", error: (e as Error).message });
          return {
            content: `Could not fetch: ${(e as Error).message}. If the docs site renders with JavaScript, try a Markdown version (same URL + ".md"), the site's /llms.txt, or search for the fact instead.`,
            isError: true,
          };
        }
      }
      case "probe_url": {
        emit({ type: "stage", stage: "probe", message: "Testing the OAuth endpoint" });
        const r = await probe(String(input.url ?? ""));
        const rec: ProbeRecordT = {
          id: `p${ctx.probes.length + 1}`,
          url: r.url,
          purpose: String(input.purpose ?? ""),
          status: r.status,
          location: r.location,
          observation: r.observation,
          at: new Date().toISOString(),
        };
        ctx.probes.push(rec);
        emit({ type: "probe", id: rec.id, url: rec.url, status: rec.status, observation: rec.observation.slice(0, 240) });
        return { content: JSON.stringify(rec) };
      }
      case "finish_research":
        notes = String(input.notes ?? "");
        return { content: "Research finished.", stop: "finish" };
      default:
        return { content: `Unknown tool ${name}`, isError: true };
    }
  }

  // ---- Phase 1: research loop ----
  const messages: BetaMessageParam[] = [{ role: "user", content: `App to investigate: ${opts.query}` }];
  let stopReason: "finish" | "ambiguous" | "not_oauth" | null = null;
  try {
    for (let turn = 0; turn < 16 && !stopReason; turn++) {
      if (Date.now() > researchDeadline) {
        partial = true;
        emit({ type: "warning", message: "Research time limit reached; writing from what was found" });
        break;
      }
      opts.signal?.throwIfAborted();
      const msg = await callModel(
        {
          model: RESEARCH_MODEL,
          max_tokens: 32000,
          // Auto-cache the growing conversation so each research turn re-reads it at 0.1x price.
          cache_control: { type: "ephemeral" },
          output_config: { effort: RESEARCH_EFFORT },
          system: researchSystem(maxSearches, maxFetches),
          tools: toolsForTurn(),
          messages,
        },
        Math.min(researchDeadline + 30_000, runDeadline - 90_000),
      );

      for (const block of msg.content) {
        if (block.type === "text" && block.text.trim()) emit({ type: "note", text: block.text.trim().slice(0, 300) });
        if (block.type === "server_tool_use" && block.name === "web_search") {
          searches++;
        }
        if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
          const results = block.content.flatMap((r) => (r.type === "web_search_result" ? [{ title: r.title, url: r.url }] : []));
          results.forEach((r) => {
            ctx.seenUrls.add(r.url);
            hits.push({ ...r, snippet: "" });
          });
          const q = msg.content.find((b) => b.type === "server_tool_use" && b.id === block.tool_use_id);
          const query = q && q.type === "server_tool_use" ? String((q.input as { query?: string }).query ?? "") : "";
          emit({ type: "search", query, via: "Anthropic web search", results: results.slice(0, 5) });
        }
      }

      if (msg.stop_reason === "refusal") throw new Error("The model declined this request.");
      if (msg.stop_reason === "pause_turn") {
        messages.push({ role: "assistant", content: msg.content });
        continue;
      }
      const toolUses = msg.content.filter((b): b is BetaToolUseBlock => b.type === "tool_use");
      if (toolUses.length === 0) break;
      if (msg.stop_reason === "max_tokens") throw new Error("Model output truncated during research.");

      messages.push({ role: "assistant", content: msg.content });
      const results = await Promise.all(
        toolUses.map(async (t) => {
          try {
            const r = await runTool(t.name, (t.input ?? {}) as Record<string, unknown>);
            if (r.stop) stopReason = r.stop;
            return { type: "tool_result" as const, tool_use_id: t.id, content: r.content, is_error: r.isError };
          } catch (e) {
            return { type: "tool_result" as const, tool_use_id: t.id, content: `Tool error: ${(e as Error).message}`, is_error: true };
          }
        }),
      );
      messages.push({ role: "user", content: results });
    }
  } catch (e) {
    if (opts.signal?.aborted) return { outcome: "error", message: "Cancelled" };
    if (e instanceof Anthropic.APIConnectionTimeoutError) {
      // A slow research turn: stop researching and write from what we have.
      partial = true;
      emit({ type: "warning", message: "A research step timed out; writing from what was found" });
    } else if (e instanceof Anthropic.APIError) {
      emit({ type: "error", message: `Model API error (${e.status ?? "network"}): ${e.message}` });
      return { outcome: "error", message: e.message };
    } else {
      // Non-API failure mid-research: keep going with what we have.
      partial = true;
      emit({ type: "warning", message: `Research stopped early: ${(e as Error).message}` });
    }
  }

  const ident = identified as z.infer<typeof ConfirmApp> | null;
  if (stopReason === "ambiguous" && ident?.candidates?.length) {
    emit({ type: "ambiguous", candidates: ident.candidates });
    return { outcome: "ambiguous", candidates: ident.candidates };
  }
  if (ident?.oauth_for_third_party_apps === "no") {
    const message = `${ident.name} does not appear to offer OAuth for third-party apps. ${notes}`.trim();
    emit({ type: "not_oauth", message });
    return { outcome: "not_oauth", message };
  }
  if (!ident && ctx.pages.size <= 2) {
    const message = `Could not identify "${opts.query}" or find its developer docs.`;
    emit({ type: "error", message });
    return { outcome: "error", message };
  }

  // ---- Phase 2: write the guide from a dossier ----
  emit({ type: "stage", stage: "write", message: "Writing the guide" });
  const lk = lookup as ComposioLookup | null;
  const dossier = buildDossier({ query: opts.query, ident, lookup: lk, notes, ctx, hits, partial });

  // JSON-in-text validated by Zod, rather than API structured outputs: the guide schema is too large for the
  // constrained-decoding grammar ("compiled grammar is too large"). One repair turn feeds back the exact errors.
  const schemaText = JSON.stringify(z.toJSONSchema(GeneratedGuideSchema));
  const system = `${WRITE_SYSTEM}\n\nReturn ONLY one JSON object (no prose, no code fences) that validates against this JSON Schema:\n${schemaText}`;
  const writeMessages: BetaMessageParam[] = [{ role: "user", content: dossier }];
  let generated: z.infer<typeof GeneratedGuideSchema> | null = null;
  for (let attempt = 0; attempt < 2 && !generated; attempt++) {
    if (attempt > 0 && runDeadline - Date.now() < 45_000) break;
    try {
      const msg = await callModel(
        { model: MODEL, max_tokens: 48000, output_config: { effort: EFFORT }, system, messages: writeMessages },
        runDeadline - 10_000,
      );
      if (msg.stop_reason === "refusal") throw new Error("The model declined to write this guide.");
      if (msg.stop_reason === "max_tokens") throw new Error("The guide was cut off (max_tokens).");
      const text = msg.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
      let problem: string;
      try {
        const parsed = GeneratedGuideSchema.safeParse(JSON.parse(extractJson(text)));
        if (parsed.success) {
          generated = parsed.data;
          break;
        }
        problem = parsed.error.issues.slice(0, 15).map((i) => `${i.path.join(".")}: ${i.message}`).join("\n");
      } catch (err) {
        problem = `Not valid JSON: ${(err as Error).message}`;
      }
      emit({ type: "warning", message: "Fixing the guide's format (one retry)" });
      writeMessages.push({ role: "assistant", content: msg.content }, { role: "user", content: `Fix these problems and return the complete corrected JSON object only:\n${problem}` });
    } catch (e) {
      if (e instanceof Anthropic.APIError) {
        emit({ type: "error", message: `Model API error while writing (${e.status ?? "network"}): ${e.message}` });
        return { outcome: "error", message: e.message };
      }
      emit({ type: "error", message: `Could not produce a valid guide: ${(e as Error).message}` });
      return { outcome: "error", message: (e as Error).message };
    }
  }
  if (!generated) {
    emit({ type: "error", message: "Could not produce a valid guide." });
    return { outcome: "error", message: "Could not produce a valid guide." };
  }

  // ---- Phase 3: enforce evidence rules ----
  emit({ type: "stage", stage: "verify", message: "Checking quotes against their sources" });
  if (ident?.website) ctx.officialDomains!.push(ident.website);
  if (ident?.developer_docs_url) ctx.officialDomains!.push(ident.developer_docs_url);
  const { guide, stats, warnings } = enforceEvidence(generated, ctx);
  warnings.forEach((w) => emit({ type: "warning", message: w }));
  emit({ type: "verify", total: stats.claims_total, checked: stats.quotes_checked, verified: stats.quotes_verified, downgraded: stats.downgraded });

  emit({ type: "cost", usd: spend.usd, input_tokens: spend.input_tokens, output_tokens: spend.output_tokens, web_searches: spend.web_searches });
  const record: GuideRecord = {
    // Prefer the user's query for the URL (short, predictable); fall back to the identified name.
    slug: slugify(opts.query) || slugify(guide.app.name),
    guide,
    meta: {
      origin: "live",
      reviewed: false,
      review_note: null,
      generated_at: new Date().toISOString(),
      generated_by: `research ${RESEARCH_MODEL} + writing ${MODEL} + ${searchVia}`,
      duration_ms: Date.now() - started,
      query: opts.query,
      partial,
      warnings,
      verification: stats,
      usage: { ...spend, usd: Math.round(spend.usd * 10000) / 10000 },
      sources,
      probes: ctx.probes,
    },
  };
  return { outcome: "ok", record };
}

/** Pull the JSON object out of a reply that may include code fences or a stray sentence. */
export function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const a = body.indexOf("{");
  const b = body.lastIndexOf("}");
  return a >= 0 && b > a ? body.slice(a, b + 1) : body;
}

function buildDossier(d: {
  query: string;
  ident: z.infer<typeof ConfirmApp> | null;
  lookup: ComposioLookup | null;
  notes: string;
  ctx: EvidenceContext;
  hits: SearchHit[];
  partial: boolean;
}): string {
  const parts: string[] = [];
  parts.push(`# Research dossier\nUser asked about: ${d.query}\nDate: ${new Date().toISOString().slice(0, 10)}`);
  if (d.partial) parts.push("NOTE: research hit its time budget; be explicit about what is unknown.");
  if (d.ident) parts.push(`## Identified provider\n${JSON.stringify(d.ident)}`);
  if (d.lookup) {
    parts.push(
      `## Composio facts\n${JSON.stringify({
        managed_oauth: d.lookup.managed_oauth,
        toolkit_slug: d.lookup.chosen?.slug ?? d.lookup.toolkit?.slug ?? null,
        api_managed_schemes: d.lookup.api_managed_schemes,
        credential_guide: d.lookup.credential_guide,
        directory_url: d.lookup.directory_url,
      })}`,
    );
  }
  if (d.notes) parts.push(`## Researcher notes\n${d.notes}`);
  if (d.ctx.probes.length) parts.push(`## Probes (cite by id)\n${d.ctx.probes.map((p) => `- ${p.id}: GET ${p.url} -> status ${p.status}. ${p.observation}`).join("\n")}`);
  if (d.hits.length) {
    const uniq = [...new Map(d.hits.map((h) => [h.url, h])).values()].slice(0, 20);
    parts.push(`## Search results seen (leads, not evidence)\n${uniq.map((h) => `- ${h.title} | ${h.url} | ${h.snippet}`).join("\n")}`);
  }
  parts.push("## Pages read (quote only from these, verbatim)");
  const budget = 150_000;
  let used = 0;
  for (const [url, text] of d.ctx.pages) {
    const t = url.includes("managed-auth") ? extractCatalogLines(text, d.lookup) : trimForModel(text, 16_000);
    if (used + t.length > budget) break;
    used += t.length;
    parts.push(`### SOURCE ${url}\n${t}`);
  }
  return parts.join("\n\n");
}

/** The managed-auth directory is long; keep the intro and the rows that mention the app. */
function extractCatalogLines(text: string, lookup: ComposioLookup | null): string {
  const lines = text.split("\n");
  const intro = lines.slice(0, 30).join("\n");
  const names = (lookup?.matches ?? []).map((m) => m.slug.toUpperCase());
  const rows = lines.filter((l) => names.some((n) => l.includes(`\`${n}\``)) || /^##\s/.test(l));
  return `${intro}\n...\n${rows.join("\n")}`;
}
