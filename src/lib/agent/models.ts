/**
 * Which model runs each stage, and what that model can do. Nothing else in the agent names a model.
 *
 * Precedence (first set wins): per-run override → AGENT_MODEL_ALL → AGENT_MODEL_<STAGE> → legacy env → default.
 * Any Claude model id works; capabilities are looked up by family with safe defaults for unknown ids.
 */

export type Stage = "identify" | "research" | "write" | "critic";
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export type StageModels = Record<Stage, string>;

const DEFAULTS: StageModels = {
  identify: "claude-haiku-5-5",
  research: "claude-haiku-5-5",
  write: "claude-sonnet-5-5",
  // The judge decides what the developer sees (paths, factors). Haiku swung 17 → 12 of 18 between identical
  // rounds; Sonnet held 18 and 17 (docs/agent/EVAL.md). About $0.03 a guide.
  critic: "claude-sonnet-5-5",
};

// v1 variable names keep working: AGENT_RESEARCH_MODEL covered research, AGENT_MODEL covered writing.
const LEGACY: Partial<Record<Stage, string>> = {
  identify: "AGENT_RESEARCH_MODEL",
  research: "AGENT_RESEARCH_MODEL",
  write: "AGENT_MODEL",
};

export function resolveModels(override?: Partial<StageModels> & { all?: string }, env: Record<string, string | undefined> = process.env): StageModels {
  const pick = (s: Stage) =>
    override?.[s] || override?.all || env.AGENT_MODEL_ALL || env[`AGENT_MODEL_${s.toUpperCase()}`] || (LEGACY[s] && env[LEGACY[s]!]) || DEFAULTS[s];
  return { identify: pick("identify"), research: pick("research"), write: pick("write"), critic: pick("critic") };
}

const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];
/** Effort is always sent explicitly: defaults differ by model (medium on Opus 5.5 and Haiku 5.5, high on Sonnet 5.5). */
export function resolveEffort(stage: Stage, env: Record<string, string | undefined> = process.env): Effort {
  const v = env[`AGENT_EFFORT_${stage.toUpperCase()}`] || (stage === "write" ? env.AGENT_EFFORT : stage === "critic" ? undefined : env.AGENT_RESEARCH_EFFORT);
  return EFFORTS.includes(v as Effort) ? (v as Effort) : stage === "critic" ? "low" : "medium";
}

export interface Capabilities {
  /** Server-side refusal fallback ("default" form). */
  fallback: boolean;
  /** Anthropic server web-search tool version this model supports. */
  webSearchTool: "web_search_20260209" | "web_search_20250305";
  /** USD per million tokens: input, output. */
  price: [number, number];
  /** Cache-read price as a fraction of input price. */
  cacheRead: number;
  /** Input/output price multiplier when a prompt exceeds `longPromptTokens` (Haiku 5.5: 5x above 100K). */
  longPrompt?: { tokens: number; multiplier: number };
  /** Rough output tokens per second, for planning how long a write may take. Conservative. */
  outputTps: number;
}

// Versioned: these values are checked for the 5.x models only (pricing: platform.claude.com prompt-caching table,
// 21 Oct 2026; capabilities: claude-api skill). Any other id, including older families, gets UNKNOWN below.
const FAMILIES: { re: RegExp; caps: Capabilities }[] = [
  { re: /^claude-opus-5-5$/, caps: { fallback: true, webSearchTool: "web_search_20260209", price: [4, 20], cacheRead: 0.05, outputTps: 45 } },
  { re: /^claude-fable-5(-1)?$/, caps: { fallback: true, webSearchTool: "web_search_20260209", price: [10, 50], cacheRead: 0.025, outputTps: 35 } },
  { re: /^claude-sonnet-5-5$/, caps: { fallback: true, webSearchTool: "web_search_20260209", price: [2, 10], cacheRead: 0.05, outputTps: 60 } },
  {
    re: /^claude-haiku-5-5$/,
    caps: { fallback: false, webSearchTool: "web_search_20250305", price: [0.1, 0.5], cacheRead: 0.1, longPrompt: { tokens: 100_000, multiplier: 5 }, outputTps: 120 },
  },
];

/** Unknown ids: no fallback, basic search, the highest price, slow output, so cost and time are never under-planned. */
const UNKNOWN: Capabilities = { fallback: false, webSearchTool: "web_search_20250305", price: [10, 50], cacheRead: 0.1, outputTps: 30 };

/** "us.anthropic.claude-sonnet-5-5[1m]" → "claude-sonnet-5-5". */
export const normalizeModelId = (model: string) => model.replace(/^(?:[a-z]{2}\.)?anthropic\./, "").replace(/\[[^\]]*\]$/, "");

export const capabilities = (model: string): Capabilities => FAMILIES.find((f) => f.re.test(normalizeModelId(model)))?.caps ?? UNKNOWN;

export type Usage = {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  server_tool_use?: { web_search_requests?: number } | null;
};

/** Cache writes cost ~1.25x input; cache reads per model. Web search $10 per 1,000. */
export function estimateCost(model: string, u: Usage): number {
  const caps = capabilities(model);
  const prompt = u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
  const m = caps.longPrompt && prompt > caps.longPrompt.tokens ? caps.longPrompt.multiplier : 1;
  const [pin, pout] = [caps.price[0] * m, caps.price[1] * m];
  const searches = u.server_tool_use?.web_search_requests ?? 0;
  return (
    (u.input_tokens * pin + (u.cache_creation_input_tokens ?? 0) * pin * 1.25 + (u.cache_read_input_tokens ?? 0) * pin * caps.cacheRead + u.output_tokens * pout) / 1e6 +
    searches * 0.01
  );
}
