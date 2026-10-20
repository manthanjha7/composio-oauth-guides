import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { baseDomain, enforceEvidence, supportIssue } from "@/lib/evidence";
import type { GeneratedGuide } from "@/lib/schema";
import { assertPublicUrl, readCapped } from "@/lib/web";

// Regression tests for the Codex code review findings (see README > Verification).

describe("[P1] SSRF via IPv4-mapped / embedded IPv6", () => {
  it.each(["http://[::ffff:127.0.0.1]/", "http://[::ffff:a9fe:a9fe]/latest/meta-data", "http://[::ffff:10.0.0.1]/", "http://[64:ff9b::7f00:1]/", "http://[::127.0.0.1]/"])(
    "rejects %s",
    async (u) => {
      await expect(assertPublicUrl(u)).rejects.toThrow();
    },
  );
});

describe("[P2] response size cap is enforced while streaming", () => {
  it("stops reading at maxBytes and cancels the stream", async () => {
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled++;
        c.enqueue(new Uint8Array(1000).fill(97));
        if (pulled > 1000) c.close();
      },
    });
    const text = await readCapped(new Response(stream), 2500);
    expect(text.length).toBe(2500);
    expect(pulled).toBeLessThan(10);
  });
});

const PAGES = new Map([
  ["https://docs.acme.dev/review", "Public applications require review. Reviews are processed in the order received."],
  ["https://forum.example.org/t/42", "Public applications require review, and mine took 3 days."],
]);

function guide(claims: GeneratedGuide["claims"], summary = "s", waiting = "None"): GeneratedGuide {
  return {
    app: { name: "Acme", website: "https://acme.dev", developer_docs_url: "https://docs.acme.dev" },
    oauth_supported: "yes",
    summary,
    composio: { toolkit_slug: null, managed_oauth: "unknown", credential_guide_url: null, note: "" },
    need_own_app: { answer: "a", reasons: [] },
    scenarios: [{ id: "s1", label: "Public", when_this_applies: "w", difficulty: "medium", hands_on: { estimate: "1h", basis: "b" }, waiting: { estimate: waiting, basis: "c1" }, approval: "review", claim_ids: claims.map((c) => c.id) }],
    prerequisites: [],
    steps: [],
    traps: [],
    blockers: [],
    open_questions: [],
    claims,
  };
}
const ctx = () => ({ pages: PAGES, seenUrls: new Set(["https://forum.example.org/t/42"]), probes: [], officialDomains: ["https://acme.dev", "https://docs.acme.dev"] });

describe("[P1] downgraded facts don't survive in dependent fields", () => {
  it("replaces an unbacked waiting estimate with Unknown and warns about the summary", () => {
    const { guide: g, warnings } = enforceEvidence(
      guide(
        [{ id: "c1", text: "Review takes 3 days", label: "provider_docs", source_url: "https://docs.acme.dev/review", quote: "Reviews take 3 days", probe_id: null }],
        "Approval takes about 3 days.",
        "3 days",
      ),
      ctx(),
    );
    expect(g.claims[0].label).toBe("unknown");
    expect(g.scenarios[0].waiting.estimate).toBe("Unknown");
    expect(g.scenarios[0].waiting.basis).toMatch(/3 days/);
    expect(warnings.join(" ")).toMatch(/3 days/);
  });
});

describe("[P1] a verbatim quote must also support the claim, from the right authority", () => {
  it("downgrades a claim whose numbers aren't in the quote", () => {
    expect(supportIssue("Public apps require review within 3 days", "Public applications require review.")).toMatch(/3/);
    const { guide: g } = enforceEvidence(
      guide([{ id: "c1", text: "Review takes 3 days", label: "provider_docs", source_url: "https://docs.acme.dev/review", quote: "Public applications require review", probe_id: null }]),
      ctx(),
    );
    expect(g.claims[0].label).toBe("unknown");
  });

  it("treats a forum page cited as provider docs as a report, and does not 'repair' to it", () => {
    const { guide: g } = enforceEvidence(
      guide([{ id: "c1", text: "Review took 3 days", label: "provider_docs", source_url: "https://forum.example.org/t/42", quote: "mine took 3 days", probe_id: null }]),
      ctx(),
    );
    expect(g.claims[0].label).toBe("reported");
    expect(g.claims[0].note).toMatch(/not an official page/);
  });

  it("adds a visible note when a negated claim rests on an un-negated quote", () => {
    const { guide: g } = enforceEvidence(
      guide([{ id: "c1", text: "Public apps never require review", label: "provider_docs", source_url: "https://docs.acme.dev/review", quote: "Public applications require review", probe_id: null }]),
      ctx(),
    );
    expect(g.claims[0].note).toMatch(/negative/);
  });

  it("computes registrable domains", () => {
    expect(baseDomain("https://support.google.com/cloud/answer/1")).toBe("google.com");
    expect(baseDomain("docs.slack.dev")).toBe("slack.dev");
    expect(baseDomain("https://www.example.co.uk/x")).toBe("example.co.uk");
  });
});

vi.mock("@/lib/composio", () => ({
  composioLookup: vi.fn(async () => ({ query: "Acme", matches: [], chosen: null, managed_oauth: "not_in_composio", api_managed_schemes: null, toolkit: null, credential_guide: null, directory_url: "", pages: [] })),
}));

describe("[P1/P2] agent deadlines and search budget", () => {
  it("turns a timed-out research call into a partial guide instead of an error", async () => {
    const { runAgent } = await import("@/lib/agent/run");
    const guideJson = JSON.stringify({ ...guide([]), summary: "Partial." });
    const script: (() => unknown)[] = [
      () => ({ stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "confirm_app", input: { name: "Acme", website: "https://acme.dev", oauth_for_third_party_apps: "yes" } }] }),
      () => {
        throw new Anthropic.APIConnectionTimeoutError();
      },
      () => ({ stop_reason: "end_turn", content: [{ type: "text", text: guideJson }] }),
    ];
    const toolsSeen: unknown[] = [];
    const client = {
      beta: {
        messages: {
          stream: (p: { tools?: unknown }) => {
            toolsSeen.push(p.tools);
            const step = script.shift()!;
            return { finalMessage: async () => step() };
          },
        },
      },
    } as unknown as Anthropic;
    const events: { type: string }[] = [];
    const r = await runAgent({ query: "Acme", emit: (e) => events.push(e), client, search: null, maxSearches: 3 });
    expect(r.outcome).toBe("ok");
    if (r.outcome === "ok") expect(r.record.meta.partial).toBe(true);
    // Server web search is offered with the remaining budget.
    const ws = (toolsSeen[0] as { name?: string; type?: string; max_uses?: number }[]).find((t) => t.name === "web_search" && !!t.type);
    expect(ws?.max_uses).toBe(3);
  });
});
