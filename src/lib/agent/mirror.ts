/**
 * TEST MIRROR (development only; never used by the live route).
 *
 * Runs the agent's model calls through headless Claude Code (`claude -p`) on the developer's own Claude
 * subscription, so evaluation loops don't spend API credits. Same pipeline, prompts and code checks; only the
 * transport differs. Production always uses the Anthropic API (llm.ts).
 *
 * Differences from production, by design of the transport:
 * - Tool use is emulated with a JSON protocol (the model replies with tool calls as JSON; our code runs them).
 * - Citations are emulated: the model returns exact quotes, which our code verifies against the page exactly
 *   as it verifies Citations-API quotes. A quote that isn't on the page is rejected.
 * - Server web search isn't available: run with COMPOSIO_API_KEY so search goes through Composio Search.
 * Treat mirror results as a proxy; confirm final changes with a few real API runs.
 */
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BetaMessage, BetaMessageParam, BetaToolUnion } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { extractJson, newSpend, type CallParams, type Llm } from "./llm";

const WORKDIR = mkdtempSync(join(tmpdir(), "agent-mirror-"));

/** Environment for the child: the API key is removed so the subscription is used and API credits can't be. */
function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  return env;
}

interface CliResult {
  result: string;
  /** Present when --json-schema was used: the reply, already parsed and schema-shaped. */
  structured_output?: unknown;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number };
  is_error?: boolean;
  subtype?: string;
}

/** One headless Claude Code call. Rejects on timeout, a non-zero exit, or an error result. */
export function runClaude(o: { system: string; prompt: string; model: string; effort: string; timeoutMs: number; signal?: AbortSignal; schema?: object }): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const args = ["-p", "--output-format", "json", "--model", o.model, "--system-prompt", o.system, "--tools", "", "--effort", o.effort, "--no-session-persistence"];
    // A JSON schema forces the reply's shape, so the model can't drift into prose instead of tool calls.
    if (o.schema) args.push("--json-schema", JSON.stringify(o.schema));
    const child = spawn("claude", args, { cwd: WORKDIR, env: childEnv(), stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const kill = () => child.kill("SIGKILL");
    const timer = setTimeout(() => {
      kill();
      reject(new Error(`mirror call timed out after ${Math.round(o.timeoutMs / 1000)}s`));
    }, Math.max(1_000, o.timeoutMs));
    o.signal?.addEventListener("abort", kill, { once: true });
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      o.signal?.removeEventListener("abort", kill);
      try {
        const json = JSON.parse(out) as CliResult;
        if (json.is_error || code !== 0) return reject(new Error(`claude -p failed (${json.subtype ?? code}): ${(json.result ?? err).slice(0, 300)}`));
        resolve(json);
      } catch {
        reject(new Error(`claude -p returned no JSON (exit ${code}): ${(err || out).slice(0, 300)}`));
      }
    });
    child.stdin.end(o.prompt);
  });
}

type Block = Record<string, unknown>;
const asBlocks = (c: BetaMessageParam["content"]): Block[] => (typeof c === "string" ? [{ type: "text", text: c }] : (c as unknown as Block[]));

/** The conversation so far as plain text the CLI can read. */
function transcript(messages: BetaMessageParam[]): string {
  return messages
    .map((m) => {
      const parts = asBlocks(m.content).map((b) => {
        if (b.type === "text") return String(b.text);
        if (b.type === "tool_use") return `<tool_call id="${b.id}" name="${b.name}">${JSON.stringify(b.input)}</tool_call>`;
        if (b.type === "tool_result") {
          const content = typeof b.content === "string" ? b.content : JSON.stringify(b.content);
          return `<tool_result id="${b.tool_use_id}"${b.is_error ? ' error="true"' : ""}>\n${content}\n</tool_result>`;
        }
        if (b.type === "document") return `<document title="${b.title ?? ""}">\n${(b.source as { data?: string })?.data ?? ""}\n</document>`;
        return "";
      });
      return `[${m.role}]\n${parts.join("\n")}`;
    })
    .join("\n\n");
}

function toolProtocol(tools: BetaToolUnion[]): string {
  const custom = tools.filter((t) => "input_schema" in t) as { name: string; description?: string; input_schema: unknown }[];
  return `# Tools
You request tool calls through your structured reply; you cannot run them yourself.
- To call tools: put them in "tool_calls" ([{"name": "<tool name>", "input": { ... }}]); several are allowed. Their results come back as <tool_result> blocks in the next message.
- When you are done and need no more tools: leave "tool_calls" empty and put your final answer in "final".

${custom.map((t) => `- ${t.name}: ${t.description ?? ""}\n  input schema: ${JSON.stringify(t.input_schema)}`).join("\n")}`;
}

const message = (content: Block[], stop: string, usage: CliResult["usage"]): BetaMessage =>
  ({
    id: `mirror_${Math.random().toString(36).slice(2)}`,
    type: "message",
    role: "assistant",
    model: "mirror",
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage: { input_tokens: usage?.input_tokens ?? 0, output_tokens: usage?.output_tokens ?? 0, cache_read_input_tokens: usage?.cache_read_input_tokens ?? 0 },
  }) as unknown as BetaMessage;

let toolSeq = 0;

const TOOL_SCHEMA = {
  type: "object",
  properties: {
    tool_calls: { type: "array", items: { type: "object", properties: { name: { type: "string" }, input: { type: "object" } }, required: ["name", "input"] } },
    final: { type: "string" },
  },
  required: ["tool_calls"],
};
const FACTS_SCHEMA = {
  type: "object",
  properties: {
    facts: {
      type: "array",
      items: { type: "object", properties: { question: { type: "string" }, answer: { type: "string" }, quote: { type: "string" } }, required: ["question", "answer", "quote"] },
    },
  },
  required: ["facts"],
};

export function createMirrorLlm(opts: { signal?: AbortSignal } = {}): Llm {
  const spend = newSpend();
  const track = (p: CallParams, u: CliResult["usage"]) => {
    spend.input_tokens += (u?.input_tokens ?? 0) + (u?.cache_read_input_tokens ?? 0);
    spend.output_tokens += u?.output_tokens ?? 0;
    const list = (spend.served[p.stage] ??= []);
    if (!list.includes(`${p.model} (Claude Code mirror)`)) list.push(`${p.model} (Claude Code mirror)`);
  };

  async function call(p: CallParams, deadlineAt: number): Promise<BetaMessage> {
    const timeoutMs = deadlineAt - Date.now();
    if (timeoutMs < 3_000) throw new Error(`No time left for the ${p.stage} call`);
    const first = asBlocks(p.messages[0]?.content ?? "");
    const doc = first.find((b) => b.type === "document");

    // Extraction: emulate the Citations API with exact quotes that our code then verifies.
    if (doc) {
      const text = String((doc.source as { data?: string }).data ?? "");
      const ask = first.filter((b) => b.type === "text").map((b) => String(b.text)).join("\n");
      const system = `${p.system}

Output format for this run (replaces "## G5" sections): your structured reply's "facts" list, one object per fact:
{"question": "G5", "answer": "one short sentence in plain words", "quote": "the exact sentence copied character for character from the document"}
The quote must be copied exactly from the document; it is checked. Return an empty list if the document answers none of the questions.`;
      const r = await runClaude({ system, prompt: `<document title="${doc.title ?? ""}">\n${text}\n</document>\n\n${ask}`, model: p.model, effort: p.effort, timeoutMs, signal: opts.signal, schema: FACTS_SCHEMA });
      track(p, r.usage);
      let facts: { question: string; answer: string; quote: string }[] = [];
      const so = r.structured_output as { facts?: typeof facts } | undefined;
      if (Array.isArray(so?.facts)) facts = so.facts;
      else {
        try {
          const parsed = JSON.parse(extractJson(r.result));
          facts = Array.isArray(parsed) ? parsed : (parsed.facts ?? []);
        } catch {
          facts = [];
        }
      }
      const blocks: Block[] = [];
      for (const f of Array.isArray(facts) ? facts : []) {
        if (!f?.question || !f?.quote) continue;
        const at = text.indexOf(f.quote);
        blocks.push({ type: "text", text: `\n## ${f.question}\n`, citations: null });
        blocks.push({
          type: "text",
          text: f.answer ?? f.quote,
          citations: [{ type: "char_location", cited_text: f.quote, document_index: 0, document_title: doc.title ?? null, start_char_index: Math.max(0, at), end_char_index: Math.max(0, at) + f.quote.length }],
        });
      }
      return message(blocks.length ? blocks : [{ type: "text", text: "NONE", citations: null }], "end_turn", r.usage);
    }

    // Tool loops: emulate tool use with a JSON protocol.
    if (p.tools?.length) {
      const system = `${p.system}\n\n${toolProtocol(p.tools)}`;
      const r = await runClaude({ system, prompt: transcript(p.messages), model: p.model, effort: p.effort, timeoutMs, signal: opts.signal, schema: TOOL_SCHEMA });
      track(p, r.usage);
      type Reply = { tool_calls?: { name: string; input: Record<string, unknown> }[]; final?: string };
      let reply = r.structured_output as Reply | undefined;
      if (!reply) {
        try {
          reply = JSON.parse(extractJson(r.result)) as Reply;
        } catch {
          reply = { tool_calls: [], final: r.result };
        }
      }
      if (reply.tool_calls?.length) {
        return message(
          reply.tool_calls.map((t) => ({ type: "tool_use", id: `tu_${++toolSeq}`, name: t.name, input: t.input ?? {} })),
          "tool_use",
          r.usage,
        );
      }
      return message([{ type: "text", text: reply.final ?? r.result, citations: null }], "end_turn", r.usage);
    }

    // Plain calls (writer, judge).
    const r = await runClaude({ system: p.system, prompt: transcript(p.messages), model: p.model, effort: p.effort, timeoutMs, signal: opts.signal });
    track(p, r.usage);
    return message([{ type: "text", text: r.result, citations: null }], "end_turn", r.usage);
  }

  return { call, spend };
}
