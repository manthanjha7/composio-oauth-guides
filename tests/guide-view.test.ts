import { describe, expect, it } from "vitest";
import { appliesTo, defaultScenario, stripCites, verdictOf } from "../src/lib/guide-view";

describe("stripCites", () => {
  it("removes parenthesised and bare citations and returns their ids", () => {
    expect(stripCites("Grants expire after 7 days in Testing (c11, c35). Limit is 100 (c10).")).toEqual({
      text: "Grants expire after 7 days in Testing. Limit is 100.",
      ids: ["c11", "c35", "c10"],
    });
    expect(stripCites("No security assessment (gmail.send is sensitive, not restricted: c1).").text).toBe(
      "No security assessment (gmail.send is sensitive, not restricted).",
    );
  });
  it("rewrites citations used as a noun", () => {
    expect(stripCites("(This is an inference from c25 + c41; not stated by either party.)").text).toBe(
      "(This is an inference from the sources; not stated by either party.)",
    );
  });
  it("keeps a qualifier that shares the brackets", () => {
    expect(stripCites("staff said ~3 weeks (c55, reported); later 4+ weeks (c56, reported).").text).toBe("staff said ~3 weeks (reported); later 4+ weeks (reported).");
  });
  it("leaves prose without citations alone", () => {
    expect(stripCites("OAuth 2.0 needs a redirect URI.")).toEqual({ text: "OAuth 2.0 needs a redirect URI.", ids: [] });
  });
});

describe("defaultScenario", () => {
  const scenarios = [
    { id: "s1", label: "Prototype or personal use" },
    { id: "s2", label: "Internal tool, your company only" },
    { id: "s3", label: "Public app that only sends email" },
  ] as never;
  it("uses the guide's own pick when valid", () => expect(defaultScenario({ scenarios, default_scenario: "s2" })).toBe("s2"));
  it("otherwise skips prototype and internal setups", () => expect(defaultScenario({ scenarios })).toBe("s3"));
  it("ignores an unknown pick", () => expect(defaultScenario({ scenarios, default_scenario: "s9" })).toBe("s3"));
});

describe("verdictOf", () => {
  it("falls back to the summary's first sentence", () => expect(verdictOf({ summary: "Easy to start. Hard to list." })).toBe("Easy to start."));
  it("prefers the verdict", () => expect(verdictOf({ summary: "x.", verdict: " Fast. " })).toBe("Fast."));
});

describe("appliesTo", () => {
  it("treats a missing or empty list as all setups", () => {
    expect(appliesTo(undefined, "s1")).toBe(true);
    expect(appliesTo([], "s1")).toBe(true);
    expect(appliesTo(["s2"], "s1")).toBe(false);
  });
});
