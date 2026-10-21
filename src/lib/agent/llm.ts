import Anthropic from "@anthropic-ai/sdk";
import type { BetaMessage, BetaMessageParam, BetaToolUnion } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { capabilities, estimateCost, type Effort, type Stage, type Usage } from "./models";

const FALLBACK_BETA: Anthropic.Beta.AnthropicBeta[] = ["server-side-fallback-2026-07-01"];

export interface Spend {
  usd: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  web_searches: number;
  by_stage: Partial<Record<Stage, number>>;
  /** Models that actually served each stage (a refusal fallback can switch models). */
  served: Partial<Record<Stage, string[]>>;
}
export const newSpend = (): Spend => ({ usd: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, web_searches: 0, by_stage: {}, served: {} });

export interface CallParams {
  stage: Stage;
  model: string;
  effort: Effort;
  system: string;
  messages: BetaMessageParam[];
  tools?: BetaToolUnion[];
  maxTokens?: number;
  /** Cache the growing conversation (tool loops). */
  cache?: boolean;
}

export interface Llm {
  call(p: CallParams, deadlineAt: number): Promise<BetaMessage>;
  spend: Spend;
}

/**
 * One wrapper for every model call in the pipeline.
 * - Timeout derives from an absolute deadline, so no call outlives the function.
 * - 429 / 529 / connection errors retry with backoff while the deadline allows.
 * - Server-side refusal fallback is used only where the model supports it; if the API rejects the
 *   parameter for a request shape, the client turns it off for the rest of the run.
 * - Effort is always sent explicitly (model defaults differ).
 */
export function createLlm(client: Anthropic, opts: { signal?: AbortSignal; onWarning?: (m: string) => void } = {}): Llm {
  const spend = newSpend();
  let fallbacks = process.env.AGENT_FALLBACKS !== "off";

  const record = (stage: Stage, model: string, servedBy: string | undefined, u: Usage | undefined) => {
    const by = servedBy || model;
    const list = (spend.served[stage] ??= []);
    if (!list.includes(by)) list.push(by);
    if (!u) return;
    const usd = estimateCost(by, u);
    spend.usd += usd;
    spend.by_stage[stage] = (spend.by_stage[stage] ?? 0) + usd;
    spend.input_tokens += u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
    spend.output_tokens += u.output_tokens;
    spend.cache_read_tokens += u.cache_read_input_tokens ?? 0;
    spend.web_searches += u.server_tool_use?.web_search_requests ?? 0;
  };

  async function once(p: CallParams, deadlineAt: number, withFallback: boolean): Promise<BetaMessage> {
    const params = {
      model: p.model,
      max_tokens: p.maxTokens ?? 32_000,
      system: p.system,
      messages: p.messages,
      output_config: { effort: p.effort },
      ...(p.tools?.length ? { tools: p.tools } : {}),
      ...(p.cache ? { cache_control: { type: "ephemeral" as const } } : {}),
      ...(withFallback ? { betas: FALLBACK_BETA, fallbacks: "default" as const } : {}),
    };
    const msg = await client.beta.messages
      .stream(params as Parameters<typeof client.beta.messages.stream>[0], {
        signal: opts.signal,
        timeout: Math.max(5_000, deadlineAt - Date.now()),
        maxRetries: 0, // retries are ours, bounded by the deadline
      })
      .finalMessage();
    record(p.stage, p.model, (msg as { model?: string }).model, msg.usage as Usage | undefined);
    return msg;
  }

  async function call(p: CallParams, deadlineAt: number): Promise<BetaMessage> {
    const useFallback = fallbacks && capabilities(p.model).fallback;
    for (let attempt = 0; ; attempt++) {
      if (deadlineAt - Date.now() < 3_000) throw new Error(`No time left for the ${p.stage} call`);
      try {
        return await once(p, deadlineAt, useFallback && fallbacks);
      } catch (e) {
        if (opts.signal?.aborted) throw e;
        // Only a rejection of the fallback parameter itself turns fallbacks off; other 400s are real request errors.
        if (e instanceof Anthropic.BadRequestError && useFallback && fallbacks && /fallback/i.test(e.message)) {
          fallbacks = false;
          opts.onWarning?.("Retrying without the safety fallback");
          continue;
        }
        const retryable =
          e instanceof Anthropic.RateLimitError ||
          e instanceof Anthropic.InternalServerError ||
          e instanceof Anthropic.APIConnectionError ||
          (e instanceof Anthropic.APIError && (e.status === 529 || e.status === 503));
        const wait = Math.min(8_000, 1_000 * 2 ** attempt) + Math.random() * 500;
        if (!retryable || attempt >= 3 || Date.now() + wait > deadlineAt - 5_000) throw e;
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  }

  return { call, spend };
}

/** Text of a message's text blocks. */
export const textOf = (m: BetaMessage) => m.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");

/** Pull the JSON value out of a reply that may include code fences or a stray sentence. */
export function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const starts = [body.indexOf("{"), body.indexOf("[")].filter((i) => i >= 0);
  if (!starts.length) return body;
  const a = Math.min(...starts);
  const close = body[a] === "{" ? "}" : "]";
  const b = body.lastIndexOf(close);
  return b > a ? body.slice(a, b + 1) : body;
}
