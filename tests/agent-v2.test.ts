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

import { collectCitations, runAgentV2 } from "@/lib/agent/pipeline";
import { EXTRACT_SYSTEM, GAPFILL_SYSTEM, IDENTIFY_SYSTEM, JUDGE_SYSTEM } from "@/lib/agent/prompts";
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
function fakeClient(opts: { writer?: (dossier: string) => Record<string, unknown>; judge?: (items: { id: string }[]) => unknown[]; gap?: boolean } = {}) {
  const calls: { system: string; messages: unknown[] }[] = [];
  const respond = (p: { system: string; messages: { role: string; content: unknown }[] }) => {
    const turn = p.messages.length;
    if (p.system === IDENTIFY_SYSTEM) {
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
      return msg([tool(`f${turn}`, "finish", { notes: "could not find G3" })], "tool_use");
    }
    if (p.system.startsWith(JUDGE_SYSTEM)) {
      const items = JSON.parse(String(p.messages[0].content)) as { id: string }[];
      return msg([{ type: "text", text: JSON.stringify(opts.judge ? opts.judge(items) : items.map((i) => ({ id: i.id, verdict: "supported" }))) }]);
    }
    // writer
    const dossier = String(p.messages[0].content);
    const g = opts.writer ? opts.writer(dossier) : writerGuide({}, dossier);
    return msg([{ type: "text", text: JSON.stringify(g) }]);
  };
  const client = {
    beta: {
      messages: {
        stream: (params: { system: string; messages: { role: string; content: unknown }[] }) => {
          calls.push({ system: params.system, messages: [...params.messages] });
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
    expect(r.record.guide.verdict).toMatch(/^Easiest: /);
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
