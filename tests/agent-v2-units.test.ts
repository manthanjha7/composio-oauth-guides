import { describe, expect, it } from "vitest";
import { parseLlmsTxt, scoreText } from "@/lib/agent/discover";
import { capabilities, estimateCost, normalizeModelId, resolveEffort, resolveModels } from "@/lib/agent/models";
import { ResearchStore } from "@/lib/agent/research";

describe("models are configuration", () => {
  it("one setting runs every stage on one model, and a per-run override wins", () => {
    expect(resolveModels(undefined, { AGENT_MODEL_ALL: "claude-opus-5-5" })).toEqual({
      identify: "claude-opus-5-5",
      research: "claude-opus-5-5",
      write: "claude-opus-5-5",
      critic: "claude-opus-5-5",
    });
    expect(resolveModels({ write: "claude-opus-5-5" }, { AGENT_MODEL_ALL: "claude-haiku-5-5" }).write).toBe("claude-opus-5-5");
    expect(resolveModels(undefined, {}).write).toBe("claude-sonnet-5-5");
    expect(resolveModels(undefined, { AGENT_MODEL_WRITE: "claude-fable-5-1" }).write).toBe("claude-fable-5-1");
  });
  it("normalises platform ids and treats unknown models conservatively", () => {
    expect(normalizeModelId("us.anthropic.claude-sonnet-5-5[1m]")).toBe("claude-sonnet-5-5");
    expect(capabilities("anthropic.claude-haiku-5-5").fallback).toBe(false);
    const unknown = capabilities("claude-future-9");
    expect(unknown.fallback).toBe(false);
    expect(unknown.price[0]).toBeGreaterThanOrEqual(capabilities("claude-opus-5-5").price[0]);
  });
  it("prices Haiku's long prompts at the higher rate and caches per model", () => {
    const short = estimateCost("claude-haiku-5-5", { input_tokens: 50_000, output_tokens: 0 });
    const long = estimateCost("claude-haiku-5-5", { input_tokens: 150_000, output_tokens: 0 });
    expect(long / 150_000).toBeCloseTo((short / 50_000) * 5, 10);
    expect(estimateCost("claude-opus-5-5", { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1_000_000 })).toBeCloseTo(0.2, 5);
  });
  it("always sends an explicit effort", () => {
    expect(resolveEffort("write", {})).toBe("medium");
    expect(resolveEffort("critic", {})).toBe("low");
    expect(resolveEffort("research", { AGENT_EFFORT_RESEARCH: "high" })).toBe("high");
    expect(resolveEffort("research", { AGENT_EFFORT_RESEARCH: "bogus" })).toBe("medium");
  });
});

describe("discovery", () => {
  it("reads an llms.txt index and ranks review and OAuth pages above others", () => {
    const links = parseLlmsTxt(
      "# Docs\n- [OAuth 2.0 guide](/docs/oauth): authorization code flow\n- [App review](https://dev.acme.example/docs/app-review): submit your app\n- [Changelog](/changelog)\n",
      "https://dev.acme.example",
    );
    expect(links.map((l) => l.url)).toEqual(["https://dev.acme.example/docs/oauth", "https://dev.acme.example/docs/app-review", "https://dev.acme.example/changelog"]);
    const s = (i: number) => scoreText(links[i].url, links[i].label);
    expect(s(1)).toBeGreaterThan(s(2));
    expect(s(0)).toBeGreaterThan(s(2));
  });
});

describe("official domains", () => {
  it("accepts a sibling docs domain only when an official page links to it", () => {
    const store = new ResearchStore(null);
    store.addOfficial("https://www.dropbox.com");
    store.pages.set("https://www.dropbox.com/developers", {
      url: "https://www.dropbox.com/developers",
      title: null,
      text: "",
      links: ["https://docs.dropboxapi.com/oauth", "https://www.dropboxtips-unofficial.example/x", "https://github.com/dropbox"],
      fetched_at: "",
      hash: "a",
      via: "direct",
    });
    store.expandOfficialFromLinks();
    expect(store.official.has("dropboxapi.com")).toBe(true);
    expect(store.kindOf("https://docs.dropboxapi.com/oauth")).toBe("provider_docs");
    expect(store.official.has("github.com")).toBe(false); // linked, but not the brand
    expect(store.kindOf("https://dropboxforum-fan.example/x")).toBe("reported"); // brand-like, never linked
  });
  it("counts a question as found only with verified evidence from an official page", () => {
    const store = new ResearchStore(null);
    store.addOfficial("https://a.example");
    store.pages.set("https://a.example/p", { url: "https://a.example/p", title: null, text: "Apps need review before launch.", links: [], fetched_at: "", hash: "h", via: "direct" });
    store.addEvidence({ question: "G2", url: "https://a.example/p", quote: "This is not on the page anywhere.", answer: "x", via: "gapfill" });
    expect(store.status("G2")).toBe("not_found");
    store.addEvidence({ question: "G2", url: "https://a.example/p", quote: "Apps need review before launch.", answer: "x", via: "gapfill" });
    expect(store.status("G2")).toBe("found");
    store.reject([store.verified("G2")[0].id]);
    expect(store.status("G2")).toBe("not_found");
  });
  it("does not let a blog answer a docs question, and needs a stated time for G6", () => {
    const store = new ResearchStore(null);
    store.pages.set("https://blog.example/p", { url: "https://blog.example/p", title: null, text: "Apps need review. It was rejected twice. Approval took about three weeks in total.", links: [], fetched_at: "", hash: "b", via: "direct" });
    store.addEvidence({ question: "G2", url: "https://blog.example/p", quote: "Apps need review.", answer: "x", via: "gapfill" });
    expect(store.status("G2")).toBe("not_found");
    store.addEvidence({ question: "R1", url: "https://blog.example/p", quote: "It was rejected twice.", answer: "x", via: "gapfill" });
    expect(store.status("G6")).toBe("not_found");
    store.addEvidence({ question: "R1", url: "https://blog.example/p", quote: "Approval took about three weeks in total.", answer: "x", via: "gapfill" });
    expect(store.status("G6")).toBe("found");
  });
  it("does not let Composio's pages answer the timeline question", () => {
    const store = new ResearchStore(null);
    store.pages.set("https://docs.composio.dev/x", { url: "https://docs.composio.dev/x", title: null, text: "Approval usually takes two weeks.", links: [], fetched_at: "", hash: "c", via: "direct" });
    store.addEvidence({ question: "G6", url: "https://docs.composio.dev/x", quote: "Approval usually takes two weeks.", answer: "x", via: "extract" });
    expect(store.status("G6")).toBe("not_found");
  });
  it("rejects a linked look-alike domain and tenant hosts on shared platforms", () => {
    const store = new ResearchStore(null);
    store.addOfficial("https://www.salesforce.com");
    store.pages.set("https://www.salesforce.com/x", { url: "https://www.salesforce.com/x", title: null, text: "", links: ["https://www.salesforceben.com/a", "https://developer.salesforce.com/docs", "https://acme.readme.io/x"], fetched_at: "", hash: "s", via: "direct" });
    store.expandOfficialFromLinks();
    expect(store.official.has("salesforceben.com")).toBe(false);
    expect(store.kindOf("https://developer.salesforce.com/docs")).toBe("provider_docs");
    expect(store.official.has("readme.io")).toBe(false);
  });
  it("never promotes a linked tenant host to official", () => {
    const store = new ResearchStore(null);
    store.addOfficial("https://acme.com");
    store.pages.set("https://acme.com/dev", { url: "https://acme.com/dev", title: null, text: "", links: ["https://acme.readme.io/docs", "https://acme.github.io/sdk", "https://acmeapi.com/ref"], fetched_at: "", hash: "t", via: "direct" });
    store.expandOfficialFromLinks();
    expect(store.official.has("acme.readme.io")).toBe(false);
    expect(store.official.has("acme.github.io")).toBe(false);
    expect(store.official.has("acmeapi.com")).toBe(true);
  });
  it("treats a shared platform's own developer docs as official for that platform", () => {
    const store = new ResearchStore(null);
    store.addOfficial("https://www.zendesk.com");
    expect(store.kindOf("https://developer.zendesk.com/documentation/x")).toBe("provider_docs");
    expect(store.kindOf("https://acme.zendesk.com/hc/x")).toBe("reported");
  });
});

describe("number words", () => {
  it("are checked like digits, with their units", async () => {
    const { supportIssue, numberUnitPairs } = await import("@/lib/evidence");
    expect([...numberUnitPairs("Review takes ten weeks.")]).toContain("10 week");
    expect(supportIssue("Review takes ten weeks.", "Review takes 10 days.")).toMatch(/week/);
  });
  it("parses compound number words without false alarms", async () => {
    const { supportIssue, wordsToDigits } = await import("@/lib/evidence");
    expect(wordsToDigits("twenty-one days, two hundred users, one of them")).toBe("21 days, 200 users, one of them");
    expect(supportIssue("Review takes twenty-one days.", "Review takes 21 days.")).toBeNull();
    expect(supportIssue("Review takes thirteen weeks.", "Review takes thirteen days.")).toMatch(/13 weeks/);
    expect(supportIssue("Each customer installs one app.", "Each customer installs the app.")).toBeNull();
  });
  it.each([
    ["one hundred-two hundred users", "100-200 users"],
    ["twenty and one", "20 and 1"],
    ["twenty-one", "21"],
    ["twenty one", "21"],
    ["one hundred and five", "105"],
    ["twenty-one-twenty-three days", "21-23 days"],
    ["two thousand five hundred", "2500"],
    ["thirty-forty minutes", "30-40 minutes"],
    ["one", "one"],
    ["one hundred and two hundred users", "100 and 200 users"],
    ["one thousand and two thousand users", "1000 and 2000 users"],
    ["one thousand two hundred", "1200"],
    ["one hundred and twenty-one", "121"],
    ["two hundred thousand", "200000"],
    ["one thousand and five", "1005"],
  ])("number words: %s -> %s", async (input, out) => {
    const { wordsToDigits } = await import("@/lib/evidence");
    expect(wordsToDigits(input)).toBe(out);
  });
  it("keeps spelled-out ranges as ranges", async () => {
    const { supportIssue, wordsToDigits } = await import("@/lib/evidence");
    expect(wordsToDigits("two-three days")).toBe("2-3 days");
    expect(wordsToDigits("one hundred and five users")).toBe("105 users");
    expect(supportIssue("Review takes five days.", "Review takes two-three days.")).toMatch(/5/);
  });
});


describe("factor sweep", () => {
  it("adds only new-kind factors that cite listed facts, to existing setups", async () => {
    const { sweepModifiers } = await import("@/lib/agent/pipeline");
    const g = {
      claims: [
        { id: "c1", text: "Listing needs 10 active workspaces.", label: "provider_docs" },
        { id: "c2", text: "Unconfirmed thing.", label: "unknown" },
        { id: "c3", text: "Admins may restrict installs.", label: "provider_docs" },
      ],
      scenarios: [{ id: "s1", label: "Marketplace", path: "app_review", modifiers: [{ kind: "customer_admin", note: "Admins may restrict installs", claim_ids: ["c3"] }] }],
    } as never;
    const q = new Map([["c1", "G11"], ["c2", "G11"], ["c3", "G8"]]);
    const reply = [
      { scenario_id: "s1", kind: "threshold", note: "At least 10 active workspaces", claim_ids: ["c1", "c9"] },
      { scenario_id: "s1", kind: "customer_admin", note: "dup kind", claim_ids: ["c3"] },
      { scenario_id: "s1", kind: "paid_access", note: "cites an unconfirmed fact", claim_ids: ["c2"] },
      { scenario_id: "s9", kind: "recurring", note: "no such setup", claim_ids: ["c1"] },
    ];
    const ask = async () => ({ content: [{ type: "text", text: JSON.stringify(reply) }] }) as never;
    const r = await sweepModifiers(g, q, ask);
    expect(r.added).toBe(1);
    const mods = (r.guide.scenarios[0].modifiers ?? []).map((m) => [m.kind, m.claim_ids]);
    expect(mods).toEqual([["customer_admin", ["c3"]], ["threshold", ["c1"]]]);
  });
});
