import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { BetaMessageParam, BetaToolUnion, BetaToolUseBlock } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { z } from "zod";
import { composioLookup, type ComposioLookup } from "../composio";
import { canonicalUrl, enforceEvidence, type EvidenceContext } from "../evidence";
import { GeneratedGuideSchema, type GuideRecord, type ProbeRecordT, type SourceRecordT } from "../schema";
import { createComposioSearch, type ComposioSearch, type SearchHit } from "../search";
import { slugify } from "../slug";
import { fetchPageText, probe, trimForModel } from "../web";
import { researchSystem, WRITE_SYSTEM } from "./prompt";


export const MODEL = process.env.AGENT_MODEL || "claude-opus-5-5";
const EFFORT = (process.env.AGENT_EFFORT || "medium") as "low" | "medium" | "high";
const BETAS: Anthropic.Beta.AnthropicBeta[] = ["server-side-fallback-2026-07-01"];

export type AgentEvent =
  | { type: "stage"; stage: "start" | "composio" | "identify" | "research" | "probe" | "write" | "verify" | "save"; message: string }
  | { type: "identified"; name: string; website: string | null; docs: string | null; oauth: string }
  | { type: "composio"; managed: string; slug: string | null; guide: string | null }
  | { type: "search"; query: string; via: string; results: { title: string; url: string }[] }
  | { type: "fetch"; url: string; ok: boolean; chars: number; via: string; error?: string }
  | { type: "probe"; id: string; url: string; status: number | null; observation: string }
  | { type: "note"; text: string }
  | { type: "verify"; total: number; checked: number; verified: number; downgraded: number }
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
          name: { type: "string" },
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
  const maxFetches = opts.maxFetches ?? 8;
  const researchDeadline = started + (opts.researchBudgetMs ?? 150_000);
  const runId = Math.random().toString(36).slice(2, 10);

  let search: ComposioSearch | null = null;
  if (opts.search !== undefined) search = opts.search;
  else {
    try {
      search = await createComposioSearch(runId);
    } catch (e) {
      emit({ type: "warning", message: `Composio Search unavailable (${(e as Error).message}); using Anthropic web search instead.` });
    }
  }
  const searchVia = search ? "composio_search" : "anthropic_web_search";

  const ctx: EvidenceContext = { pages: new Map(), seenUrls: new Set(), probes: [] };
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

  emit({ type: "stage", stage: "start", message: `Researching "${opts.query}" (search via ${search ? "Composio Search" : "Anthropic web search"})` });

  const tools = customTools(!!search);
  if (!search) {
    tools.push({ type: "web_search_20260209", name: "web_search", max_uses: maxSearches } as BetaToolUnion);
  }

  async function runTool(name: string, input: Record<string, unknown>): Promise<{ content: string; isError?: boolean; stop?: "finish" | "ambiguous" | "not_oauth" }> {
    switch (name) {
      case "composio_lookup": {
        emit({ type: "stage", stage: "composio", message: "Checking Composio's managed-auth directory and toolkit docs" });
        lookup = await composioLookup(String(input.app_name ?? opts.query), input.slug_hint ? String(input.slug_hint) : undefined);
        for (const p of lookup.pages) addPage(p.url, p.text, "direct");
        emit({ type: "composio", managed: lookup.managed_oauth, slug: lookup.chosen?.slug ?? lookup.toolkit?.slug ?? null, guide: lookup.credential_guide?.url ?? null });
        return {
          content: JSON.stringify({
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
          return { content: `URL: ${page.url}\nTITLE: ${page.title ?? ""}\n\n${trimForModel(page.text)}` };
        } catch (e) {
          if (search) {
            try {
              const page = await search.fetch(url);
              if (page) {
                addPage(page.url, page.text, "composio_fetch", page.title);
                if (page.url !== url) ctx.pages.set(canonicalUrl(url), page.text);
                emit({ type: "fetch", url: page.url, ok: true, chars: page.text.length, via: "Composio fetch" });
                return { content: `URL: ${page.url}\nTITLE: ${page.title ?? ""}\n\n${trimForModel(page.text)}` };
              }
            } catch {
              /* fall through */
            }
          }
          emit({ type: "fetch", url, ok: false, chars: 0, via: "direct", error: (e as Error).message });
          return { content: `Could not fetch: ${(e as Error).message}`, isError: true };
        }
      }
      case "probe_url": {
        emit({ type: "stage", stage: "probe", message: "Probing a live endpoint" });
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
        emit({ type: "warning", message: "Research time budget reached; writing the guide from what was found so far." });
        break;
      }
      opts.signal?.throwIfAborted();
      const stream = client.beta.messages.stream(
        {
          model: MODEL,
          max_tokens: 16000,
          betas: BETAS,
          fallbacks: "default",
          output_config: { effort: EFFORT },
          system: researchSystem(maxSearches, maxFetches),
          tools,
          messages,
        },
        { signal: opts.signal },
      );
      const msg = await stream.finalMessage();

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
    if (e instanceof Anthropic.APIError) {
      emit({ type: "error", message: `Model API error (${e.status ?? "network"}): ${e.message}` });
      return { outcome: "error", message: e.message };
    }
    if (opts.signal?.aborted) return { outcome: "error", message: "Cancelled" };
    // Non-API failure mid-research: keep going with what we have.
    partial = true;
    emit({ type: "warning", message: `Research stopped early: ${(e as Error).message}` });
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

  // ---- Phase 2: write the guide from a dossier (structured output) ----
  emit({ type: "stage", stage: "write", message: "Writing the guide from the evidence gathered" });
  const lk = lookup as ComposioLookup | null;
  const dossier = buildDossier({ query: opts.query, ident, lookup: lk, notes, ctx, hits, partial });

  let generated: z.infer<typeof GeneratedGuideSchema> | null = null;
  for (let attempt = 0; attempt < 2 && !generated; attempt++) {
    try {
      const stream = client.beta.messages.stream(
        {
          model: MODEL,
          max_tokens: 32000,
          betas: BETAS,
          fallbacks: "default",
          output_config: { effort: EFFORT, format: betaZodOutputFormat(GeneratedGuideSchema) },
          system: WRITE_SYSTEM,
          messages: [
            {
              role: "user",
              content:
                attempt === 0
                  ? dossier
                  : `${dossier}\n\nYour previous answer did not match the schema. Return only valid JSON for the schema.`,
            },
          ],
        },
        { signal: opts.signal },
      );
      const msg = await stream.finalMessage();
      if (msg.stop_reason === "refusal") throw new Error("The model declined to write this guide.");
      const text = msg.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
      const parsed = GeneratedGuideSchema.safeParse(JSON.parse(text));
      if (parsed.success) generated = parsed.data;
      else emit({ type: "warning", message: "Guide did not match the schema; retrying once." });
    } catch (e) {
      if (e instanceof Anthropic.APIError) {
        emit({ type: "error", message: `Model API error while writing (${e.status ?? "network"}): ${e.message}` });
        return { outcome: "error", message: e.message };
      }
      if (attempt === 1) {
        emit({ type: "error", message: `Could not produce a valid guide: ${(e as Error).message}` });
        return { outcome: "error", message: (e as Error).message };
      }
      emit({ type: "warning", message: `Retrying guide generation: ${(e as Error).message}` });
    }
  }
  if (!generated) {
    emit({ type: "error", message: "Could not produce a valid guide." });
    return { outcome: "error", message: "Could not produce a valid guide." };
  }

  // ---- Phase 3: enforce evidence rules ----
  emit({ type: "stage", stage: "verify", message: "Checking every quoted claim against the pages actually read" });
  const { guide, stats } = enforceEvidence(generated, ctx);
  emit({ type: "verify", total: stats.claims_total, checked: stats.quotes_checked, verified: stats.quotes_verified, downgraded: stats.downgraded });

  const record: GuideRecord = {
    slug: slugify(guide.app.name || opts.query),
    guide,
    meta: {
      origin: "live",
      reviewed: false,
      review_note: null,
      generated_at: new Date().toISOString(),
      generated_by: `${MODEL} (effort ${EFFORT}) + ${searchVia}`,
      duration_ms: Date.now() - started,
      query: opts.query,
      partial,
      verification: stats,
      sources,
      probes: ctx.probes,
    },
  };
  return { outcome: "ok", record };
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
