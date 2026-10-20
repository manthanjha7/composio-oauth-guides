import { describe, expect, it } from "vitest";
import { enforceEvidence, quoteInText } from "@/lib/evidence";
import type { GeneratedGuide } from "@/lib/schema";

const PAGE = `Apps that request restricted scopes must complete a security assessment.\n\nThe assessment must be completed at least every 12 months.`;

describe("quoteInText", () => {
  it("matches verbatim text regardless of case, whitespace and markdown", () => {
    expect(quoteInText("apps that request   RESTRICTED scopes must complete a **security assessment**", PAGE)).toBe(true);
  });
  it("accepts an ellipsis-split quote when parts appear in order", () => {
    expect(quoteInText("restricted scopes must complete ... at least every 12 months", PAGE)).toBe(true);
    expect(quoteInText("at least every 12 months ... restricted scopes must complete", PAGE)).toBe(false);
  });
  it("rejects paraphrases and trivially short quotes", () => {
    expect(quoteInText("restricted scopes require an annual audit", PAGE)).toBe(false);
    expect(quoteInText("scopes", PAGE)).toBe(false);
  });
});

function guide(claims: GeneratedGuide["claims"]): GeneratedGuide {
  return {
    app: { name: "Test", website: null, developer_docs_url: null },
    oauth_supported: "yes",
    summary: "s",
    composio: { toolkit_slug: null, managed_oauth: "unknown", credential_guide_url: null, note: "" },
    need_own_app: { answer: "a", reasons: [] },
    scenarios: [{ id: "s1", label: "l", when_this_applies: "w", difficulty: "hard", hands_on: { estimate: "1h", basis: "b" }, waiting: { estimate: "Unknown", basis: "b" }, approval: "a", claim_ids: ["c1", "missing"] }],
    prerequisites: [],
    steps: [{ title: "t", owner: "you", detail: "d", inputs: [], done_when: "x", scenario_ids: ["s1", "s9"], link: null, claim_ids: ["c2"] }],
    traps: [],
    blockers: [],
    open_questions: [],
    claims,
  };
}

describe("enforceEvidence", () => {
  const ctx = () => ({
    pages: new Map([["https://docs.example.com/verify", PAGE], ["https://docs.example.com/other", "Testing apps are limited to 100 test users listed on the consent screen."]]),
    seenUrls: new Set(["https://forum.example.com/t/1"]),
    probes: [{ id: "p1", url: "https://x", purpose: "", status: 302, location: null, observation: "", at: "" }],
  });

  it("keeps verified quotes, fixes a wrong URL, and downgrades unverifiable claims", () => {
    const { guide: g, stats } = enforceEvidence(
      guide([
        { id: "c1", text: "t", label: "provider_docs", source_url: "https://docs.example.com/verify#x", quote: "must be completed at least every 12 months", probe_id: null },
        { id: "c2", text: "t", label: "provider_docs", source_url: "https://docs.example.com/verify", quote: "limited to 100 test users", probe_id: null },
        { id: "c3", text: "t", label: "provider_docs", source_url: "https://docs.example.com/verify", quote: "review takes two weeks on average", probe_id: null },
        { id: "c4", text: "t", label: "probed", source_url: null, quote: null, probe_id: "p7" },
        { id: "c5", text: "t", label: "reported", source_url: "https://forum.example.com/t/1", quote: null, probe_id: null },
        { id: "c6", text: "t", label: "reported", source_url: "https://made-up.example.com", quote: null, probe_id: null },
        { id: "c7", text: "t", label: "composio_docs", source_url: null, quote: null, probe_id: null },
      ]),
      ctx(),
    );
    const by = Object.fromEntries(g.claims.map((c) => [c.id, c]));
    expect(by.c1.label).toBe("provider_docs");
    expect(by.c2.label).toBe("provider_docs");
    expect(by.c2.source_url).toBe("https://docs.example.com/other");
    expect(by.c3.label).toBe("unknown");
    expect(by.c3.note).toMatch(/not found/);
    expect(by.c4.label).toBe("unknown");
    expect(by.c5.label).toBe("reported");
    expect(by.c6.label).toBe("unknown");
    expect(by.c7.label).toBe("unknown");
    expect(stats).toEqual({ claims_total: 7, quotes_checked: 4, quotes_verified: 2, downgraded: 4 });
  });

  it("removes dangling claim and scenario references", () => {
    const { guide: g } = enforceEvidence(guide([{ id: "c1", text: "t", label: "unknown", source_url: null, quote: null, probe_id: null }]), ctx());
    expect(g.scenarios[0].claim_ids).toEqual(["c1"]);
    expect(g.steps[0].claim_ids).toEqual([]);
    expect(g.steps[0].scenario_ids).toEqual(["s1"]);
  });
});
