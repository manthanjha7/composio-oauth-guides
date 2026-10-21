import type Anthropic from "@anthropic-ai/sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Network-free and model-free: Composio lookup, page fetches and the model are all fakes.
vi.mock("@/lib/composio", () => ({
  composioLookup: vi.fn(async () => ({
    query: "Acme",
    matches: [],
    chosen: null,
    managed_oauth: "no",
    api_managed_schemes: [],
    app_url: "https://acme.example",
    toolkit: null,
    credential_guide: null,
    directory_url: "https://docs.composio.dev/toolkits/managed-auth",
    facts: [],
    pages: [],
  })),
}));

const PAGES: Record<string, string> = {
  "https://acme.example": "Acme helps teams. Read our developer docs at https://developers.acme.example/docs for building integrations and apps.",
  "https://developers.acme.example/docs":
    "Acme developer docs. Public apps must pass an app review before they can be installed by other organizations. Reviews take up to 10 business days. Apps under review can be used by up to 25 test users. " +
    "Only workspace admins can install apps that request admin scopes. ".repeat(3),
  "https://developers.acme.example/docs/review": "App review. Submit your app for review from the developer console. Reviewers check your use case and a demo video. ".repeat(12),
  "https://developers.acme.example/docs/scopes": "Scopes. The files.read scope is a sensitive scope and requires additional review. ".repeat(6),
  "https://acmeblog-unofficial.example/post": "I waited about 6 weeks for my Acme app review to be approved, which was frustrating. ".repeat(6),
};
vi.mock("@/lib/web", async (orig) => {
  const actual = await orig<typeof import("@/lib/web")>();
  return {
    ...actual,
    fetchPageText: vi.fn(async (url: string) => {
      const text = PAGES[url.replace(/\/$/, "")];
      if (!text) throw new Error("HTTP 404");
      const links = url.includes("acme.example") && !url.includes("unofficial") ? ["https://developers.acme.example/docs"] : [];
      return { url: url.replace(/\/$/, ""), title: "Acme", status: 200, text, links };
    }),
  };
});

import { composioLookup } from "@/lib/composio";
import { anchorOfficial, collectCitations, ensureCriticalLimits, runAgentV2 } from "@/lib/agent/pipeline";
import { EXTRACT_SYSTEM, GAPFILL_SYSTEM, IDENTIFY_SYSTEM, JUDGE_SYSTEM, MODIFIER_SWEEP_SYSTEM } from "@/lib/agent/prompts";
import { ResearchStore } from "@/lib/agent/research";
import type { AgentEvent } from "@/lib/agent/run";

type Block = Record<string, unknown>;
const msg = (content: Block[], stop_reason = "end_turn") => ({ content, stop_reason, usage: { input_tokens: 100, output_tokens: 50 } });
const tool = (id: string, name: string, input: Record<string, unknown>) => ({ type: "tool_use", id, name, input });
const cite = (text: string, quote: string, url: string) => ({
  type: "text",
  text,
  citations: [{ type: "char_location", cited_text: quote, document_index: 0, document_title: url, start_char_index: 0, end_char_index: quote.length }],
});

/** Evidence id in the dossier whose quote starts with `prefix` (ids depend on parallel completion order). */
const idFor = (dossier: string, prefix: string) => dossier.match(new RegExp(`(E\\d+) \\[[a-z_]+\\] \\([A-Z0-9]+\\) \\S+\\n  quote: "${prefix}`))?.[1] ?? "E_MISSING";

function writerGuide(over: Record<string, unknown> = {}, dossier = "") {
  return {
    app: { name: "Acme", website: "https://acme.example", developer_docs_url: "https://developers.acme.example/docs" },
    oauth_supported: "yes",
    summary: "Public apps need review; it takes up to 10 business days.",
    verdict: "Up to 10 business days of review for public apps.",
    default_scenario: "s2",
    composio: { toolkit_slug: null, managed_oauth: "no", credential_guide_url: null, note: "Bring your own app." },
    need_own_app: { answer: "Yes.", reasons: ["No managed app"] },
    scenarios: [
      { id: "s1", label: "Internal", when_this_applies: "Your org only", difficulty: "easy", hands_on: { estimate: "30-60 min", basis: "steps" }, waiting: { estimate: "None", basis: "no review" }, approval: "None", claim_ids: [], path: "self_serve", path_claim_ids: [] },
      {
        id: "s2",
        label: "Public app",
        when_this_applies: "Other orgs install it",
        difficulty: "medium",
        hands_on: { estimate: "1-2 days", basis: "steps" },
        waiting: { estimate: "Up to 10 business days", basis: "c2", max_days: 14 },
        approval: "App review (c1).",
        claim_ids: ["c1", "c2"],
        path: "app_review",
        trigger: "always",
        gate_sequence: ["App review"],
        review_checks: ["use_case"],
        path_claim_ids: ["c1"],
        modifiers: [{ kind: "limited_before_approval", qualifier: "required", note: "25 test users before approval", claim_ids: ["c3"] }],
        shortcut: "Use only basic scopes.",
        shortcut_claim_ids: ["c9"],
      },
    ],
    prerequisites: [],
    steps: [{ title: "Create the app", owner: "you", detail: "In the console.", inputs: [], done_when: "You have a client ID.", scenario_ids: [], link: null, claim_ids: [] }],
    traps: [],
    blockers: [],
    open_questions: [],
    claims: [
      { id: "c1", text: "Public apps must pass an app review before other organizations can install them.", evidence_id: idFor(dossier, "Public apps must pass") },
      { id: "c2", text: "Reviews take up to 10 business days.", evidence_id: idFor(dossier, "Reviews take up to 10") },
      { id: "c3", text: "Apps under review can be used by up to 25 test users.", evidence_id: idFor(dossier, "Apps under review") },
      { id: "c4", text: "A developer reports waiting about 6 weeks.", evidence_id: idFor(dossier, "I waited about 6 weeks") },
      { id: "c9", text: "Basic scopes skip review.", evidence_id: "E999" },
    ],
    ...over,
  };
}

/** Fake model: answers by stage (parallel calls arrive in any order) and by conversation length. */
function fakeClient(
  opts: {
    writer?: (dossier: string) => Record<string, unknown>;
    judge?: (items: { id: string }[]) => unknown[];
    gap?: boolean;
    identify?: (turn: number) => ReturnType<typeof msg> | null;
    writerFails?: boolean;
    gapFetchOfficial?: boolean;
  } = {},
) {
  const calls: { system: string; messages: unknown[]; tools?: unknown[]; raw: Record<string, unknown> }[] = [];
  const respond = (p: { system: string; messages: { role: string; content: unknown }[] }) => {
    const turn = p.messages.length;
    if (p.system === IDENTIFY_SYSTEM) {
      const custom = opts.identify?.(turn);
      if (custom) return custom;
      return turn === 1
        ? msg([tool("i1", "submit_identity", { name: "Acme", website: "https://acme.example", developer_docs_url: "https://developers.acme.example/docs", oauth: "yes", entry_points: ["https://developers.acme.example/docs/scopes"] })], "tool_use")
        : msg([{ type: "text", text: "done" }]);
    }
    if (p.system === EXTRACT_SYSTEM) {
      const doc = (p.messages[0].content as { type: string; title?: string }[]).find((b) => b.type === "document");
      const url = doc?.title ?? "";
      if (url.endsWith("/docs"))
        return msg([
          { type: "text", text: "## G2\n" },
          cite("Public apps need a review.", "Public apps must pass an app review before they can be installed by other organizations.", url),
          { type: "text", text: "\n## G6\n" },
          cite("Reviews take up to 10 business days.", "Reviews take up to 10 business days.", url),
          { type: "text", text: "\n## G5\n" },
          cite("Up to 25 test users before approval.", "Apps under review can be used by up to 25 test users.", url),
          { type: "text", text: "\n## G8\n" },
          cite("Admin scopes need a workspace admin to install.", "Only workspace admins can install apps that request admin scopes.", url),
        ]);
      if (url.endsWith("/scopes")) return msg([{ type: "text", text: "## G4\n" }, cite("files.read is sensitive.", "The files.read scope is a sensitive scope and requires additional review.", url)]);
      return msg([{ type: "text", text: "NONE" }]);
    }
    if (p.system === GAPFILL_SYSTEM) {
      const user = String(p.messages[0].content);
      if (opts.gap === false) return msg([tool(`f${turn}`, "finish", { notes: "nothing" })], "tool_use");
      if (user.includes("R1")) {
        if (turn === 1) return msg([tool("g1", "fetch_page", { url: "https://acmeblog-unofficial.example/post" })], "tool_use");
        if (turn === 3)
          return msg(
            [
              tool("g2", "record_finding", { question: "R1", url: "https://acmeblog-unofficial.example/post", quote: "I waited about 6 weeks for my Acme app review to be approved", answer: "About 6 weeks." }),
              tool("g3", "record_finding", { question: "R1", url: "https://acmeblog-unofficial.example/post", quote: "This sentence is not on the page at all, made up.", answer: "x" }),
            ],
            "tool_use",
          );
        return msg([tool(`f${turn}`, "finish", { notes: "done" })], "tool_use");
      }
      if (opts.gapFetchOfficial && turn === 1) return msg([tool("g9", "fetch_page", { url: "https://developers.acme.example/docs/review" })], "tool_use");
      return msg([tool(`f${turn}`, "finish", { notes: "could not find G3" })], "tool_use");
    }
    if (p.system.startsWith(JUDGE_SYSTEM)) {
      const items = JSON.parse(String(p.messages[0].content)) as { id: string }[];
      return msg([{ type: "text", text: JSON.stringify(opts.judge ? opts.judge(items) : items.map((i) => ({ id: i.id, verdict: "supported" }))) }]);
    }
    if (p.system === MODIFIER_SWEEP_SYSTEM) return msg([{ type: "text", text: "[]" }]);
    // writer
    if (opts.writerFails) throw new Error("simulated writer outage");
    const dossier = String(p.messages[0].content);
    const g = opts.writer ? opts.writer(dossier) : writerGuide({}, dossier);
    return msg([{ type: "text", text: JSON.stringify(g) }]);
  };
  const client = {
    beta: {
      messages: {
        stream: (params: { system: string; messages: { role: string; content: unknown }[]; tools?: unknown[] }) => {
          calls.push({ system: params.system, messages: [...params.messages], tools: params.tools, raw: params as unknown as Record<string, unknown> });
          const out = respond(params);
          return { finalMessage: async () => out };
        },
      },
    },
  };
  return { client: client as unknown as Anthropic, calls };
}

describe("agent v2 pipeline (offline)", () => {
  let events: AgentEvent[];
  beforeEach(() => {
    events = [];
  });

  it("builds a guide whose claims come from verified evidence, with labels and quotes filled by code", async () => {
    const { client } = fakeClient({
      // The writer cites E ids by position; map the blog report onto whatever id the ledger gave it.
      writer: (d) => writerGuide({}, d),
    });
    const r = await runAgentV2({ query: "Acme", client, search: null, emit: (e) => events.push(e), totalBudgetMs: 270_000 });
    expect(r.outcome).toBe("ok");
    if (r.outcome !== "ok") return;
    const g = r.record.guide;
    const c1 = g.claims.find((c) => c.id === "c1")!;
    expect(c1.label).toBe("provider_docs");
    expect(c1.quote).toBe("Public apps must pass an app review before they can be installed by other organizations.");
    expect(c1.source_url).toBe("https://developers.acme.example/docs");
    // Evidence that doesn't exist becomes unconfirmed, and the shortcut that relied on it is removed.
    expect(g.claims.find((c) => c.id === "c9")!.label).toBe("unknown");
    const s2 = g.scenarios.find((s) => s.id === "s2")!;
    expect(s2.shortcut).toBeNull();
    expect(s2.path).toBe("app_review"); // backed by a G2 claim
    expect(s2.modifiers?.length).toBe(1);
    // Question coverage is computed from verified evidence.
    const q = new Map(r.record.meta.research!.questions.map((x) => [x.id, x.status]));
    expect(q.get("G2")).toBe("found");
    expect(q.get("G3")).toBe("not_found");
    expect(g.open_questions.some((x) => x.startsWith("Not found:"))).toBe(true);
    // Provenance stored.
    expect(r.record.meta.research!.evidence.every((e) => e.page_hash !== undefined)).toBe(true);
    expect(r.record.meta.generated_by).toMatch(/agent v2/);
  });

  it("labels evidence from a non-official site as a report, and rejects a quote that is not on the page", async () => {
    const { client } = fakeClient();
    const r = await runAgentV2({ query: "Acme", client, search: null, emit: (e) => events.push(e) });
    expect(r.outcome).toBe("ok");
    if (r.outcome !== "ok") return;
    const ev = r.record.meta.research!.evidence;
    const blog = ev.filter((e) => e.url.includes("unofficial"));
    expect(blog.some((e) => e.status === "verified" && e.kind === "reported")).toBe(true);
    expect(blog.some((e) => e.status === "not_on_page")).toBe(true);
    // Sibling docs domain linked from the official site counts as official.
    expect(ev.find((e) => e.url === "https://developers.acme.example/docs")?.kind).toBe("provider_docs");
  });

  it("clears a path that no verified G2 source backs", async () => {
    const { client } = fakeClient({
      writer: (d) => {
        const g = writerGuide({}, d);
        (g.scenarios[1] as Record<string, unknown>).path_claim_ids = ["c2"]; // a timeline claim, not a G2 claim
        return g;
      },
    });
    const r = await runAgentV2({ query: "Acme", client, search: null, emit: (e) => events.push(e) });
    if (r.outcome !== "ok") throw new Error(r.outcome);
    const s2 = r.record.guide.scenarios.find((s) => s.id === "s2")!;
    expect(s2.path).toBeUndefined();
    expect(r.record.meta.warnings!.some((w) => w.includes("not backed"))).toBe(true);
  });

  it("downgrades a claim the judge finds contradicted", async () => {
    const { client } = fakeClient({ judge: (items) => items.map((i) => ({ id: i.id, verdict: i.id === "c3" ? "contradicted" : "supported", reason: "test" })) });
    const r = await runAgentV2({ query: "Acme", client, search: null, emit: (e) => events.push(e) });
    if (r.outcome !== "ok") throw new Error(r.outcome);
    expect(r.record.guide.claims.find((c) => c.id === "c3")!.label).toBe("unknown");
    expect(r.record.meta.research!.judge?.contradicted).toBe(1);
  });

  it("rebuilds a verdict whose numbers no verified claim supports", async () => {
    const { client } = fakeClient({ writer: (d) => writerGuide({ verdict: "Takes 99 days." }, d) });
    const r = await runAgentV2({ query: "Acme", client, search: null, emit: (e) => events.push(e) });
    if (r.outcome !== "ok") throw new Error(r.outcome);
    expect(r.record.guide.verdict).not.toMatch(/99/);
    expect(r.record.guide.verdict).toMatch(/Public app \(app review/); // rebuilt from the setup that survived
  });

  it("returns an error, not a crash, when there is no time to identify the app", async () => {
    const { client } = fakeClient();
    const r = await runAgentV2({ query: "Acme", client, search: null, emit: (e) => events.push(e), totalBudgetMs: 60_000 });
    expect(r.outcome).toBe("error");
  });

  it("keeps each conversation append-only with fixed system and tools", async () => {
    const { client, calls } = fakeClient();
    await runAgentV2({ query: "Acme", client, search: null, emit: () => {} });
    const gap = calls.filter((c) => c.system === GAPFILL_SYSTEM);
    for (let i = 1; i < gap.length; i++) {
      // each later call in the same conversation extends the earlier history
      const prev = gap[i - 1].messages;
      const cur = gap[i].messages;
      if (cur.length > prev.length && JSON.stringify(cur[0]) === JSON.stringify(prev[0])) expect(JSON.stringify(cur.slice(0, prev.length))).toBe(JSON.stringify(prev));
    }
  });
});

describe("collectCitations", () => {
  it("assigns each cited sentence to the question heading above it", () => {
    const store = new ResearchStore(null);
    const page = { url: "https://x.example/d", title: null, text: "Apps must be reviewed. Up to 5 test users.", links: [], fetched_at: "", hash: "h", via: "direct" as const };
    store.pages.set("https://x.example/d", page);
    const m = {
      content: [
        { type: "text", text: "## G2\n" },
        cite("Review needed.", "Apps must be reviewed.", page.url),
        { type: "text", text: "\n## G5\n" },
        cite("5 users.", "Up to 5 test users.", page.url),
        { type: "text", text: "\n## Z9\n" },
        cite("ignored", "Apps must be reviewed.", page.url),
      ],
    };
    const n = collectCitations(m as never, page, store, ["G2", "G5"]);
    expect(n).toBe(2);
    expect(store.evidence.map((e) => e.question)).toEqual(["G2", "G5"]);
  });
});

describe("agent v2: review follow-ups (offline)", () => {
  const run = (c: ReturnType<typeof fakeClient>) => runAgentV2({ query: "Acme", client: c.client, search: null, emit: () => {} });

  it("sends documents with citations on, explicit effort, and the web-search version for the model that runs it", async () => {
    const c = fakeClient();
    await run(c);
    const ex = c.calls.find((x) => x.system === EXTRACT_SYSTEM)!;
    const doc = (ex.messages[0] as { content: Record<string, unknown>[] }).content[0];
    expect(doc).toMatchObject({ type: "document", source: { type: "text", media_type: "text/plain" }, citations: { enabled: true } });
    expect(ex.raw.output_config).toMatchObject({ effort: expect.any(String) });
    const idTools = c.calls.find((x) => x.system === IDENTIFY_SYSTEM)!.tools as { type?: string; name: string }[];
    expect(idTools.find((t) => t.name === "web_search")?.type).toBe("web_search_20250305"); // identify runs on Haiku by default
  });

  it("keeps tools identical across turns of one conversation", async () => {
    const c = fakeClient();
    await run(c);
    const gap = c.calls.filter((x) => x.system === GAPFILL_SYSTEM && String((x.messages[0] as { content: string }).content).includes("R1"));
    for (let i = 1; i < gap.length; i++) expect(JSON.stringify(gap[i].tools)).toBe(JSON.stringify(gap[0].tools));
  });

  it("continues after pause_turn and ends a conversation once its server searches are spent", async () => {
    const serverSearch = (id: string) => ({ type: "server_tool_use", id, name: "web_search", input: { query: "acme oauth" } });
    const c = fakeClient({
      identify: (turn) => (turn === 1 ? msg([serverSearch("s1")], "pause_turn") : turn === 3 ? msg([serverSearch("s2"), serverSearch("s3")], "pause_turn") : msg([serverSearch(`s${turn}`)], "pause_turn")),
    });
    const r = await run(c);
    const identifyCalls = c.calls.filter((x) => x.system === IDENTIFY_SYSTEM).length;
    expect(identifyCalls).toBe(2); // budget of 2 searches: stops after the second call instead of running all 6 turns
    expect(r.outcome).toBe("error"); // never identified
  });

  it("removes a path, its wait and coverage when the judge contradicts the G2 claim behind them", async () => {
    const c = fakeClient({ judge: (items) => items.map((i) => ({ id: i.id, verdict: i.id === "c1" ? "contradicted" : "supported" })) });
    const r = await run(c);
    if (r.outcome !== "ok") throw new Error(r.outcome);
    const s2 = r.record.guide.scenarios.find((s) => s.id === "s2")!;
    expect(s2.path).toBeUndefined();
    expect(r.record.guide.claims.find((x) => x.id === "c1")!.label).toBe("unknown");
    expect(r.record.meta.research!.questions.find((q) => q.id === "G2")!.status).toBe("not_found");
  });

  it("drops a field the judge finds unsupported by its quotes, even when the claim itself is fine", async () => {
    const c = fakeClient({ judge: (items) => items.map((i) => ({ id: i.id, verdict: i.id === "s2.path" ? "unsupported" : "supported" })) });
    const r = await run(c);
    if (r.outcome !== "ok") throw new Error(r.outcome);
    expect(r.record.guide.scenarios.find((s) => s.id === "s2")!.path).toBeUndefined();
    expect(r.record.guide.claims.find((x) => x.id === "c1")!.label).toBe("provider_docs");
  });

  it("treats missing judge verdicts as unchecked, not as passed", async () => {
    const c = fakeClient({ judge: (items) => items.filter((i) => i.id !== "s2.path" && i.id !== "c3").map((i) => ({ id: i.id, verdict: "supported" })) });
    const r = await run(c);
    if (r.outcome !== "ok") throw new Error(r.outcome);
    expect(r.record.guide.scenarios.find((s) => s.id === "s2")!.path).toBeUndefined();
    expect(r.record.guide.claims.find((x) => x.id === "c3")!.note).toMatch(/Not double-checked/);
    expect(r.record.meta.research!.judge!.unchecked).toBe(2);
  });

  it("withholds setup conclusions when the judge cannot run", async () => {
    const c = fakeClient({ judge: () => { throw new Error("judge outage"); } });
    const r = await run(c);
    if (r.outcome !== "ok") throw new Error(r.outcome);
    const s2 = r.record.guide.scenarios.find((s) => s.id === "s2")!;
    expect(s2.path).toBeUndefined();
    expect(s2.modifiers ?? []).toEqual([]);
    expect(s2.waiting.estimate).toBe("Unknown");
    expect(r.record.meta.warnings!.some((w) => w.includes("not shown"))).toBe(true);
  });

  it("never shows the writer's free-text extras when their modifiers were rejected", async () => {
    const c = fakeClient({
      writer: (d) => {
        const g = writerGuide({}, d);
        (g.scenarios[1] as Record<string, unknown>).extras = ["Exempt from review for startups"];
        return g;
      },
      judge: (items) => items.map((i) => ({ id: i.id, verdict: i.id.includes(".mod") ? "unsupported" : "supported" })),
    });
    const r = await run(c);
    if (r.outcome !== "ok") throw new Error(r.outcome);
    expect(r.record.guide.scenarios.find((s) => s.id === "s2")!.extras).toEqual([]);
  });

  it("replaces a summary whose number comes with a different unit than any source", async () => {
    const c = fakeClient({ writer: (d) => writerGuide({ summary: "Review takes 25 days.", verdict: undefined }, d) });
    const r = await run(c);
    if (r.outcome !== "ok") throw new Error(r.outcome);
    expect(r.record.guide.summary).not.toMatch(/25 days/); // sources say 25 test users, not 25 days
  });

  it("never keeps a free-text conclusion: the summary is built from the setups that survived", async () => {
    const c = fakeClient({
      writer: (d) => writerGuide({ summary: "Public apps require no review at all.", verdict: "No review needed for anyone." }, d),
      judge: (items) => items.map((i) => ({ id: i.id, verdict: i.id === "verdict" ? "contradicted" : "supported" })),
    });
    const r = await run(c);
    if (r.outcome !== "ok") throw new Error(r.outcome);
    expect(r.record.guide.summary).not.toMatch(/no review/i);
    expect(r.record.guide.verdict).not.toMatch(/no review/i);
    expect(r.record.guide.summary).toMatch(/approval path unconfirmed/); // s1 had no G2 claim
  });

  it("replaces the summary even when no setup survives", async () => {
    const c = fakeClient({ writer: (d) => writerGuide({ summary: "No review needed for anyone.", scenarios: [] }, d) });
    const r = await run(c);
    if (r.outcome !== "ok") throw new Error(r.outcome);
    expect(r.record.guide.summary).not.toMatch(/no review/i);
  });

  it("checks a wait written in words, even on a confirmed self-serve path", async () => {
    const c = fakeClient({
      writer: (d) => {
        const g = writerGuide({}, d);
        const s1 = g.scenarios[0] as Record<string, unknown>;
        s1.path_claim_ids = ["c1"]; // backed by a G2 claim for the test
        s1.waiting = { estimate: "ten weeks", basis: "guess" };
        return g;
      },
      judge: (items) => items.map((i) => ({ id: i.id, verdict: i.id === "s1.wait" ? "unsupported" : "supported" })),
    });
    const r = await run(c);
    if (r.outcome !== "ok") throw new Error(r.outcome);
    expect(r.record.guide.scenarios.find((s) => s.id === "s1")!.waiting.estimate).toBe("Unknown");
  });

  it.each(["0.5 days", "0-2 weeks", "None for testing; production takes ten weeks"])("treats %s as a real wait that needs a source", async (est) => {
    const c = fakeClient({
      writer: (d) => {
        const g = writerGuide({}, d);
        const s1 = g.scenarios[0] as Record<string, unknown>;
        s1.path_claim_ids = ["c1"];
        s1.waiting = { estimate: est, basis: "guess" };
        return g;
      },
      judge: (items) => items.map((i) => ({ id: i.id, verdict: i.id === "s1.wait" ? "unsupported" : "supported" })),
    });
    const r = await run(c);
    if (r.outcome !== "ok") throw new Error(r.outcome);
    expect(r.record.guide.scenarios.find((s) => s.id === "s1")!.waiting.estimate).toBe("Unknown");
  });

  it("marks difficulty unknown when a setup's path can't be confirmed", async () => {
    const c = fakeClient();
    const r = await run(c);
    if (r.outcome !== "ok") throw new Error(r.outcome);
    const s1 = r.record.guide.scenarios.find((s) => s.id === "s1")!;
    expect(s1.path).toBeUndefined();
    expect(s1.difficulty).toBe("unknown");
  });

  it("saves a partial guide of verified facts when the writer fails", async () => {
    const c = fakeClient({ writerFails: true });
    const r = await run(c);
    if (r.outcome !== "ok") throw new Error(r.outcome);
    expect(r.record.meta.partial).toBe(true);
    expect(r.record.guide.claims.length).toBeGreaterThan(0);
    expect(r.record.guide.claims.every((x) => x.quote)).toBe(true);
    expect(r.record.meta.warnings!.some((w) => w.includes("could not write"))).toBe(true);
  });
});

describe("collectCitations, harder cases", () => {
  const mk = () => {
    const store = new ResearchStore(null);
    const page = { url: "https://x.example/d", title: null, text: "Apps must be reviewed by our team. Up to 5 test users are allowed. Admins approve installs for the org.", links: [], fetched_at: "", hash: "h", via: "direct" as const };
    store.pages.set("https://x.example/d", page);
    return { store, page };
  };
  it("follows headings inside a block and keeps joint citations together", () => {
    const { store, page } = mk();
    const m = {
      content: [
        { type: "text", text: "## G2\nSome intro.\n## G5\n" },
        {
          type: "text",
          text: "Up to 5 test users, reviewed by the team.",
          citations: [
            { type: "char_location", cited_text: "Up to 5 test users are allowed.", document_index: 0, start_char_index: 35, end_char_index: 66 },
            { type: "char_location", cited_text: "Apps must be reviewed by our team.", document_index: 0, start_char_index: 0, end_char_index: 34 },
          ],
        },
      ],
    };
    expect(collectCitations(m as never, page, store, ["G2", "G5"])).toBe(1);
    expect(store.evidence[0]).toMatchObject({ question: "G5", extra_quotes: ["Apps must be reviewed by our team."], offsets: [35, 66] });
  });
  it("skips a cited block whose prose spans two sections, instead of guessing", () => {
    const { store, page } = mk();
    const m = {
      content: [
        {
          type: "text",
          text: "## G2\nApps must be reviewed.\n## G6\nReviews take 10 days.",
          citations: [{ type: "char_location", cited_text: "Apps must be reviewed by our team.", document_index: 0, start_char_index: 0, end_char_index: 34 }],
        },
      ],
    };
    expect(collectCitations(m as never, page, store, ["G2", "G6"])).toBe(0);
    expect(store.evidence).toHaveLength(0);
  });
  it("drops citations whose heading is not an allowed question", () => {
    const { store, page } = mk();
    const m = { content: [{ type: "text", text: "## G8\n" }, cite("Admins approve.", "Admins approve installs for the org.", page.url)] };
    expect(collectCitations(m as never, page, store, ["G2"])).toBe(0);
  });
});

describe("deadlines", () => {
  it("a fetch that hangs gives up at its deadline", async () => {
    const store = new ResearchStore({ search: async () => [], fetch: () => new Promise(() => {}) });
    const t = Date.now();
    const p = await store.fetch("https://hangs.example/never", Date.now() + 2_000);
    expect(p).toBeNull();
    expect(Date.now() - t).toBeLessThan(4_000);
  });
});

describe("anchorOfficial", () => {
  const page = (url: string, links: string[], text = "Acme developer platform") => ({ url, title: "Acme", text, links, fetched_at: "", hash: url, via: "direct" as const });
  const lookup = { app_url: "https://acme.example" } as never;
  it("does not let an untrusted website vouch for docs", async () => {
    const store = new ResearchStore(null);
    store.pages.set("https://acme.example", page("https://acme.example", []));
    store.pages.set("https://acme-tools.example", page("https://acme-tools.example", ["https://acme-docs-mirror.example/oauth"]));
    store.pages.set("https://acme-docs-mirror.example/oauth", page("https://acme-docs-mirror.example/oauth", []));
    await anchorOfficial(store, { name: "Acme", oauth: "yes", website: "https://acme-tools.example", developer_docs_url: "https://acme-docs-mirror.example/oauth" }, lookup, Date.now() + 5_000);
    expect(store.official.has("acme.example")).toBe(true);
    expect(store.official.has("acme-tools.example")).toBe(false);
    expect(store.official.has("acme-docs-mirror.example")).toBe(false);
  });
  it("without a catalog entry, needs the app's name in both the domain and the page", async () => {
    const store = new ResearchStore(null);
    store.pages.set("https://best-oauth-tips.example", page("https://best-oauth-tips.example", [], "All about Acme OAuth"));
    await anchorOfficial(store, { name: "Acme", oauth: "yes", website: "https://best-oauth-tips.example" }, null, Date.now() + 5_000);
    expect(store.official.size).toBe(0);
  });
  it("with no catalog entry and no readable website, accepts docs whose domain is exactly the name", async () => {
    const store = new ResearchStore(null);
    store.pages.set("https://docs.x.com/overview", page("https://docs.x.com/overview", [], "X Developer Platform. Build with the X API."));
    store.pages.set("https://docs.xtips.example/x", page("https://docs.xtips.example/x", [], "X API tips"));
    await anchorOfficial(store, { name: "X", oauth: "yes", website: null, developer_docs_url: "https://docs.x.com/overview" } as never, null, Date.now() + 5_000);
    expect(store.official.has("x.com")).toBe(true);
    const other = new ResearchStore(null);
    other.pages.set("https://docs.xtips.example/x", page("https://docs.xtips.example/x", [], "X API tips"));
    await anchorOfficial(other, { name: "X", oauth: "yes", website: null, developer_docs_url: "https://docs.xtips.example/x" } as never, null, Date.now() + 5_000);
    expect(other.official.size).toBe(0);
  });
});

describe("self-serve inference", () => {
  const run = (c: ReturnType<typeof fakeClient>) => runAgentV2({ query: "Acme", client: c.client, search: null, emit: () => {} });
  it("is not inferred when any verified evidence mentions a review", async () => {
    const c = fakeClient({
      writer: (d) => {
        const g = writerGuide({}, d);
        (g.scenarios[0] as Record<string, unknown>).path_claim_ids = [];
        return g;
      },
    });
    const r = await run(c);
    if (r.outcome !== "ok") throw new Error(r.outcome);
    // Acme's docs say public apps must pass a review, so self-serve can't be inferred for s1.
    expect(r.record.guide.scenarios.find((s) => s.id === "s1")!.path).toBeUndefined();
  });
});

describe("late extraction", () => {
  it("reads in full an official page a gap worker fetched but discovery never read", async () => {
    const c = fakeClient({ gapFetchOfficial: true });
    const r = await runAgentV2({ query: "Acme", client: c.client, search: null, emit: () => {} });
    if (r.outcome !== "ok") throw new Error(r.outcome);
    const extractedTitles = c.calls
      .filter((x) => x.system === EXTRACT_SYSTEM)
      .map((x) => ((x.messages[0] as { content: { type: string; title?: string }[] }).content.find((b) => b.type === "document")?.title ?? ""));
    expect(extractedTitles).toContain("https://developers.acme.example/docs/review");
    expect(extractedTitles.filter((t) => t === "https://developers.acme.example/docs").length).toBe(1);
  });
});

describe("identify fallback", () => {
  it("continues from Composio's toolkit and website when identify never submits", async () => {
    const base = await (composioLookup as unknown as () => Promise<Record<string, unknown>>)();
    vi.mocked(composioLookup).mockResolvedValueOnce({ ...base, toolkit: { slug: "acme", header: "Acme" } } as never);
    const events: AgentEvent[] = [];
    const c = fakeClient({ identify: () => msg([{ type: "text", text: "Still checking." }]) });
    const r = await runAgentV2({ query: "Acme", client: c.client, search: null, emit: (e) => events.push(e) });
    expect(r.outcome).toBe("ok");
    expect(events.some((e) => e.type === "warning" && /continuing from what Composio knows/.test(e.message))).toBe(true);
  });
});

describe("partner fallback", () => {
  const partnerWriter = (d: string) => {
    const g = writerGuide({}, d);
    Object.assign(g.scenarios[1], { path: "partner", gate_sequence: undefined, review_checks: undefined, trigger: undefined });
    return g;
  };
  it("shows app review when partner acceptance is not confirmed but a provider review is", async () => {
    const c = fakeClient({ writer: partnerWriter, judge: (items) => items.map((i) => ({ id: i.id, verdict: i.id === "s2.path" ? "partial" : "supported" })) });
    const r = await runAgentV2({ query: "Acme", client: c.client, search: null, emit: () => {} });
    if (r.outcome !== "ok") throw new Error(r.outcome);
    expect(r.record.guide.scenarios.find((s) => s.id === "s2")!.path).toBe("app_review");
  });
  it("keeps partner when it is confirmed", async () => {
    const c = fakeClient({ writer: partnerWriter });
    const r = await runAgentV2({ query: "Acme", client: c.client, search: null, emit: () => {} });
    if (r.outcome !== "ok") throw new Error(r.outcome);
    expect(r.record.guide.scenarios.find((s) => s.id === "s2")!.path).toBe("partner");
  });
});

describe("factor wording", () => {
  it("keeps a factor whose kind is supported but shows plain wording when its note is not", async () => {
    const c = fakeClient({ judge: (items) => items.map((i) => ({ id: i.id, verdict: i.id === "s2.mod0.note" ? "partial" : "supported" })) });
    const r = await runAgentV2({ query: "Acme", client: c.client, search: null, emit: () => {} });
    if (r.outcome !== "ok") throw new Error(r.outcome);
    const m = r.record.guide.scenarios.find((s) => s.id === "s2")!.modifiers![0];
    expect(m.kind).toBe("limited_before_approval");
    expect(m.note).toBe("Limited until approved");
  });
  it("drops a factor whose kind is not supported", async () => {
    const c = fakeClient({ judge: (items) => items.map((i) => ({ id: i.id, verdict: i.id === "s2.mod0" ? "partial" : "supported" })) });
    const r = await runAgentV2({ query: "Acme", client: c.client, search: null, emit: () => {} });
    if (r.outcome !== "ok") throw new Error(r.outcome);
    expect(r.record.guide.scenarios.find((s) => s.id === "s2")!.modifiers ?? []).toHaveLength(0);
  });
});

describe("ensureCriticalLimits", () => {
  it("adds a numeric limit from critical evidence that no claim covers, and nothing already covered", () => {
    const store = new ResearchStore(null);
    store.addOfficial("https://g.example");
    const page = { url: "https://g.example/t", title: null, text: "Testing apps allow up to 100 test users. Refresh tokens expire after 7 days in testing.", links: [], fetched_at: "", hash: "g", via: "direct" as const };
    store.pages.set(page.url, page);
    store.addEvidence({ question: "G5", url: page.url, quote: "Testing apps allow up to 100 test users.", answer: "Up to 100 test users in testing.", via: "extract" });
    store.addEvidence({ question: "G5", url: page.url, quote: "Refresh tokens expire after 7 days in testing.", answer: "Refresh tokens expire after 7 days in testing mode.", via: "extract" });
    const g = {
      claims: [{ id: "c1", text: "Up to 100 test users in testing.", label: "provider_docs", source_url: page.url, quote: "Testing apps allow up to 100 test users.", probe_id: null, note: null }],
      traps: [],
    } as never;
    const warnings: string[] = [];
    const out = ensureCriticalLimits(g, store, () => true, warnings);
    expect(out.claims).toHaveLength(2);
    expect(out.claims[1].text).toMatch(/7 days/);
    expect(out.traps[0].claim_ids).toEqual([out.claims[1].id]);
    expect(warnings[0]).toMatch(/added under "Watch out"/);
  });
});

