import type Anthropic from "@anthropic-ai/sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Network-free: stub Composio lookups and page fetches; the model is a scripted fake.
vi.mock("@/lib/composio", () => ({
  composioLookup: vi.fn(async () => ({
    query: "Acme",
    matches: [],
    chosen: null,
    managed_oauth: "not_in_composio",
    api_managed_schemes: null,
    toolkit: null,
    credential_guide: null,
    directory_url: "https://docs.composio.dev/toolkits/managed-auth",
    pages: [{ url: "https://docs.composio.dev/toolkits/managed-auth.md", text: "# Managed OAuth apps\nComposio can provide the OAuth app that your users authorize." }],
  })),
}));
vi.mock("@/lib/web", async (orig) => {
  const actual = await orig<typeof import("@/lib/web")>();
  return {
    ...actual,
    fetchPageText: vi.fn(async (url: string) => ({
      url,
      title: "Acme OAuth",
      status: 200,
      text: "Acme developer docs. Public apps must pass an app review before they can be installed by other organizations. Reviews are processed in the order received.",
    })),
    probe: vi.fn(async (url: string) => ({ url, status: 400, location: null, observation: 'Body starts: "invalid_client"' })),
  };
});

import { runAgent, type AgentEvent } from "@/lib/agent/run";

type Msg = { content: unknown[]; stop_reason: string };

function fakeClient(script: Msg[]) {
  const calls: unknown[] = [];
  const client = {
    beta: {
      messages: {
        stream: (params: unknown) => {
          calls.push(params);
          const next = script.shift();
          if (!next) throw new Error("script exhausted");
          return { finalMessage: async () => next };
        },
      },
    },
  };
  return { client: client as unknown as Anthropic, calls };
}

const tool = (id: string, name: string, input: Record<string, unknown>) => ({ type: "tool_use", id, name, input });

const GUIDE = {
  app: { name: "Acme", website: "https://acme.example", developer_docs_url: "https://acme.example/docs" },
  oauth_supported: "yes",
  summary: "Easy to start, review needed for other orgs.",
  composio: { toolkit_slug: null, managed_oauth: "not_in_composio", credential_guide_url: null, note: "Not in Composio." },
  need_own_app: { answer: "Yes.", reasons: ["No Composio toolkit"] },
  scenarios: [
    { id: "s1", label: "Your own org", when_this_applies: "internal", difficulty: "easy", hands_on: { estimate: "30 min", basis: "estimate" }, waiting: { estimate: "None", basis: "c1" }, approval: "None", claim_ids: ["c1"] },
  ],
  prerequisites: [],
  steps: [{ title: "Create app", owner: "you", detail: "d", inputs: [], done_when: "has client id", scenario_ids: [], link: null, claim_ids: ["c1", "c2"] }],
  traps: [],
  blockers: [],
  open_questions: ["Review duration"],
  claims: [
    { id: "c1", text: "Public apps need review", label: "provider_docs", source_url: "https://acme.example/docs/oauth", quote: "Public apps must pass an app review before they can be installed by other organizations", probe_id: null },
    { id: "c2", text: "Reviews take 3 days", label: "provider_docs", source_url: "https://acme.example/docs/oauth", quote: "Reviews take about three business days", probe_id: null },
    { id: "c3", text: "Authorize endpoint rejects unknown clients", label: "probed", source_url: null, quote: null, probe_id: "p1" },
  ],
};

describe("runAgent (scripted model)", () => {
  let events: AgentEvent[];
  beforeEach(() => {
    events = [];
  });

  it("runs research tools, writes a guide, and enforces evidence", async () => {
    const { client, calls } = fakeClient([
      { stop_reason: "tool_use", content: [tool("t1", "composio_lookup", { app_name: "Acme" })] },
      { stop_reason: "tool_use", content: [tool("t2", "confirm_app", { name: "Acme", website: "https://acme.example", developer_docs_url: "https://acme.example/docs", oauth_for_third_party_apps: "yes" })] },
      { stop_reason: "tool_use", content: [tool("t3", "fetch_page", { url: "https://acme.example/docs/oauth" }), tool("t4", "probe_url", { url: "https://acme.example/oauth/authorize?client_id=invalid-client-id-test", purpose: "dummy client" })] },
      { stop_reason: "tool_use", content: [tool("t5", "finish_research", { notes: "Review needed for public apps; duration unknown." })] },
      { stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(GUIDE) }] },
    ]);

    const result = await runAgent({ query: "Acme", emit: (e) => events.push(e), client, search: null });
    expect(result.outcome).toBe("ok");
    if (result.outcome !== "ok") return;

    const byId = Object.fromEntries(result.record.guide.claims.map((c) => [c.id, c]));
    expect(byId.c1.label).toBe("provider_docs"); // quote found on the fetched page
    expect(byId.c2.label).toBe("unknown"); // invented timeline -> downgraded
    expect(byId.c3.label).toBe("probed"); // probe p1 was recorded
    expect(result.record.meta.verification).toMatchObject({ quotes_checked: 2, quotes_verified: 1, downgraded: 1 });
    expect(result.record.meta.probes).toHaveLength(1);
    expect(result.record.slug).toBe("acme");

    // No Composio key -> Anthropic server-side web search is offered as the search tool.
    const firstTools = (calls[0] as { tools: { name: string; type?: string }[] }).tools;
    expect(firstTools.some((t) => t.name === "web_search" && t.type?.startsWith("web_search_"))).toBe(true);
    // Tool results for parallel calls come back in ONE user message.
    const history = (calls[3] as { messages: { role: string; content: string | { type: string }[] }[] }).messages;
    const parallel = history.find((m) => Array.isArray(m.content) && m.content.filter((c) => c.type === "tool_result").length === 2);
    expect(parallel?.role).toBe("user");

    const types = events.map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(["composio", "identified", "fetch", "probe", "verify"]));
  });

  it("stops with candidates when the input is ambiguous", async () => {
    const { client } = fakeClient([
      { stop_reason: "tool_use", content: [tool("t1", "confirm_app", { name: "Box", oauth_for_third_party_apps: "unclear", ambiguous: true, candidates: ["Box (cloud storage)", "Box Sign"] })] },
    ]);
    const result = await runAgent({ query: "Box", emit: (e) => events.push(e), client, search: null });
    expect(result).toEqual({ outcome: "ambiguous", candidates: ["Box (cloud storage)", "Box Sign"] });
  });

  it("reports non-OAuth apps honestly instead of writing a guide", async () => {
    const { client } = fakeClient([
      { stop_reason: "tool_use", content: [tool("t1", "confirm_app", { name: "Perplexity API", oauth_for_third_party_apps: "no" })] },
      { stop_reason: "tool_use", content: [tool("t2", "finish_research", { notes: "API keys only." })] },
    ]);
    const result = await runAgent({ query: "Perplexity", emit: (e) => events.push(e), client, search: null });
    expect(result.outcome).toBe("not_oauth");
  });

  it("writes a partial guide when the research budget is exhausted", async () => {
    const { client } = fakeClient([{ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(GUIDE) }] }]);
    const result = await runAgent({ query: "Acme", emit: (e) => events.push(e), client, search: null, researchBudgetMs: -1 });
    // Nothing was identified or read, so the agent refuses to invent a guide.
    expect(result.outcome).toBe("error");
    expect(events.some((e) => e.type === "warning")).toBe(true);
  });
});
