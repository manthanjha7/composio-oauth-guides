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
  it("counts a question as found only with verified evidence", () => {
    const store = new ResearchStore(null);
    store.pages.set("https://a.example/p", { url: "https://a.example/p", title: null, text: "Apps need review before launch.", links: [], fetched_at: "", hash: "h", via: "direct" });
    store.addEvidence({ question: "G2", url: "https://a.example/p", quote: "This is not on the page anywhere.", answer: "x", via: "gapfill" });
    expect(store.status("G2")).toBe("not_found");
    store.addEvidence({ question: "G2", url: "https://a.example/p", quote: "Apps need review before launch.", answer: "x", via: "gapfill" });
    expect(store.status("G2")).toBe("found");
  });
});
