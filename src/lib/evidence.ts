import type { ClaimT, GeneratedGuide, Guide, ProbeRecordT } from "./schema";

/** Normalise text for quote matching: case, whitespace, quotes/dashes, markdown noise. */
export function normalizeForMatch(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”‟]/g, '"')
    .replace(/[–—−]/g, "-")
    .replace(/ /g, " ")
    .replace(/[*_`#>|]/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

export function canonicalUrl(u: string): string {
  try {
    const url = new URL(u);
    url.hash = "";
    let s = url.toString();
    if (s.endsWith("/")) s = s.slice(0, -1);
    return s.replace(/^http:\/\//, "https://").replace("://www.", "://");
  } catch {
    return u.trim();
  }
}

/**
 * True when the quote appears in the page text. Allows an ellipsis-split quote
 * ("first part ... second part") as long as each part appears in order.
 */
export function quoteInText(quote: string, pageText: string): boolean {
  const page = normalizeForMatch(pageText);
  const parts = quote
    .split(/\.\.\.|…/)
    .map(normalizeForMatch)
    .filter((p) => p.length > 0);
  if (parts.length === 0) return false;
  if (parts.join(" ").length < 12) return false; // too short to be meaningful evidence
  let from = 0;
  for (const part of parts) {
    const idx = page.indexOf(part, from);
    if (idx === -1) return false;
    from = idx + part.length;
  }
  return true;
}

export interface EvidenceContext {
  /** canonical url -> page text the agent actually read */
  pages: Map<string, string>;
  /** urls seen in search results (for "reported" claims) */
  seenUrls: Set<string>;
  probes: ProbeRecordT[];
}

export interface VerificationStats {
  claims_total: number;
  quotes_checked: number;
  quotes_verified: number;
  downgraded: number;
}

/**
 * Enforce the evidence rules on a generated guide:
 *  - provider_docs / composio_docs need a verbatim quote found in a page the agent fetched
 *  - probed needs a real probe id
 *  - reported needs a URL the agent actually saw
 *  - anything that fails is downgraded to "unknown" with a note (never silently dropped)
 *  - dangling claim ids are removed from scenarios/steps/etc.
 */
export function enforceEvidence(g: GeneratedGuide, ctx: EvidenceContext): { guide: Guide; stats: VerificationStats } {
  const stats: VerificationStats = { claims_total: g.claims.length, quotes_checked: 0, quotes_verified: 0, downgraded: 0 };
  const probeIds = new Set(ctx.probes.map((p) => p.id));
  const seen = new Set([...ctx.seenUrls, ...ctx.pages.keys()].map(canonicalUrl));

  const claims: ClaimT[] = g.claims.map((c) => {
    const claim: ClaimT = { ...c, note: null };
    const downgrade = (why: string) => {
      stats.downgraded++;
      return { ...claim, label: "unknown" as const, note: why };
    };

    if (c.label === "provider_docs" || c.label === "composio_docs") {
      stats.quotes_checked++;
      if (!c.quote || !c.source_url) return downgrade("No verbatim quote or source URL was given, so this is unconfirmed.");
      const key = canonicalUrl(c.source_url);
      const direct = ctx.pages.get(key);
      if (direct && quoteInText(c.quote, direct)) {
        stats.quotes_verified++;
        return claim;
      }
      // The quote may come from another page the agent read; fix the URL if so.
      for (const [url, text] of ctx.pages) {
        if (quoteInText(c.quote, text)) {
          stats.quotes_verified++;
          return { ...claim, source_url: url };
        }
      }
      return downgrade("The quoted text was not found in the page the agent read, so the claim is unconfirmed.");
    }

    if (c.label === "probed") {
      if (!c.probe_id || !probeIds.has(c.probe_id)) return downgrade("Refers to a probe that was not recorded.");
      return claim;
    }

    if (c.label === "reported") {
      if (!c.source_url || !seen.has(canonicalUrl(c.source_url))) {
        return downgrade("The report's source was not among the pages the agent saw.");
      }
      return claim;
    }

    return claim;
  });

  const ids = new Set(claims.map((c) => c.id));
  const keep = (xs: string[]) => xs.filter((x) => ids.has(x));
  const scenarioIds = new Set(g.scenarios.map((s) => s.id));

  const guide: Guide = {
    ...g,
    claims,
    scenarios: g.scenarios.map((s) => ({ ...s, claim_ids: keep(s.claim_ids) })),
    steps: g.steps.map((s) => ({
      ...s,
      claim_ids: keep(s.claim_ids),
      scenario_ids: s.scenario_ids.filter((x) => scenarioIds.has(x)),
    })),
    prerequisites: g.prerequisites.map((p) => ({ ...p, claim_ids: keep(p.claim_ids) })),
    traps: g.traps.map((t) => ({ ...t, claim_ids: keep(t.claim_ids) })),
    blockers: g.blockers.map((b) => ({ ...b, claim_ids: keep(b.claim_ids) })),
  };
  return { guide, stats };
}

export const LABEL_INFO: Record<ClaimT["label"], { icon: string; name: string; meaning: string }> = {
  tested: { icon: "🧪", name: "Tested", meaning: "Observed in a recorded setup attempt" },
  probed: { icon: "🔎", name: "Probed", meaning: "The agent hit a live endpoint and recorded the response" },
  provider_docs: { icon: "📘", name: "Provider docs", meaning: "Official docs, with a verbatim quote checked against the page" },
  composio_docs: { icon: "🟣", name: "Composio docs", meaning: "Composio docs or API, quote checked against the page" },
  reported: { icon: "💬", name: "Reported", meaning: "Developers report it (forum, blog, issue). Not official" },
  unknown: { icon: "❓", name: "Unknown", meaning: "Not confirmed. Treat as a lead, not a fact" },
};
