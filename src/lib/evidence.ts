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
  /** Registrable domains of the provider (from its website / docs URL). Empty = don't enforce. */
  officialDomains?: string[];
}

export interface VerificationStats {
  claims_total: number;
  quotes_checked: number;
  quotes_verified: number;
  downgraded: number;
}

/** "docs.slack.dev" -> "slack.dev", "support.google.com" -> "google.com", "foo.co.uk" -> "foo.co.uk". */
export function baseDomain(urlOrHost: string): string {
  let host = urlOrHost;
  try {
    host = new URL(urlOrHost.includes("://") ? urlOrHost : `https://${urlOrHost}`).hostname;
  } catch {
    /* use as-is */
  }
  const parts = host.toLowerCase().replace(/\.$/, "").split(".");
  if (parts.length <= 2) return parts.join(".");
  const sld = parts[parts.length - 2];
  const take = ["co", "com", "org", "net", "gov", "ac", "edu"].includes(sld) && parts[parts.length - 1].length === 2 ? 3 : 2;
  return parts.slice(-take).join(".");
}

const isComposio = (url: string) => /(^|\.)composio\.dev$/.test(safeHost(url));
function safeHost(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

const NUM_WORDS: Record<string, string> = {
  two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10",
  eleven: "11", twelve: "12", fifteen: "15", twenty: "20", thirty: "30", fifty: "50", hundred: "100",
};
function numbersIn(text: string): Set<string> {
  const t = text.toLowerCase();
  const out = new Set<string>();
  for (const m of t.matchAll(/(?<![\w.$])\$?(\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?![\w])/g)) out.add(m[1].replace(/,/g, ""));
  for (const [w, d] of Object.entries(NUM_WORDS)) if (new RegExp(`\\b${w}\\b`).test(t)) out.add(d);
  return out;
}
const NEGATION = /\b(not|no|never|cannot|can't|don't|doesn't|isn't|aren't|won't|without|none|neither|nor)\b/i;

/**
 * Cheap checks that the quote actually supports the claim (a verbatim quote can still be misused):
 * every number in the claim must appear in the quote, and a negated claim needs a negated quote.
 * Returns a reason when the support looks wrong, else null.
 */
export function supportIssue(claimText: string, quote: string): string | null {
  const q = numbersIn(quote);
  const missing = [...numbersIn(claimText)].filter((n) => !q.has(n));
  if (missing.length) return `The claim states ${missing.join(", ")}, which the quote does not contain.`;
  return null;
}

/** Softer signal: a negated claim backed by an un-negated quote. Shown to readers as a note, not a downgrade. */
export function negationNote(claimText: string, quote: string): string | null {
  const norm = (x: string) => x.replace(/[\u2018\u2019]/g, "'");
  return NEGATION.test(norm(claimText)) && !NEGATION.test(norm(quote))
    ? "The claim is phrased as a negative but the quote is not. Read the quote before relying on it."
    : null;
}

export interface EnforceResult {
  guide: Guide;
  stats: VerificationStats;
  warnings: string[];
}

/**
 * Enforce the evidence rules on a generated guide:
 *  - provider_docs / composio_docs need a verbatim quote found in a page the agent fetched, from the right
 *    authority (provider's own domains / composio.dev), and the quote must plausibly support the claim
 *  - probed needs a real probe id; reported needs a URL the agent actually saw
 *  - anything that fails is downgraded (to "reported" if it is a real non-official page, else "unknown") with a note
 *  - a scenario's waiting time with no verified backing becomes "Unknown"; unbacked time spans in the summary become warnings
 *  - dangling claim ids are removed from scenarios/steps/etc.
 */
export function enforceEvidence(g: GeneratedGuide, ctx: EvidenceContext): EnforceResult {
  const stats: VerificationStats = { claims_total: g.claims.length, quotes_checked: 0, quotes_verified: 0, downgraded: 0 };
  const probeIds = new Set(ctx.probes.map((p) => p.id));
  const seen = new Set([...ctx.seenUrls, ...ctx.pages.keys()].map(canonicalUrl));
  const official = new Set((ctx.officialDomains ?? []).map(baseDomain).filter(Boolean));
  const authorityOk = (label: "provider_docs" | "composio_docs", url: string) =>
    label === "composio_docs" ? isComposio(url) : official.size === 0 || official.has(baseDomain(url));

  const claims: ClaimT[] = g.claims.map((c) => {
    const claim: ClaimT = { ...c, note: null };
    const downgrade = (why: string, to: "unknown" | "reported" = "unknown") => {
      stats.downgraded++;
      return { ...claim, label: to, note: why };
    };

    if (c.label === "provider_docs" || c.label === "composio_docs") {
      stats.quotes_checked++;
      if (!c.quote || !c.source_url) return downgrade("No verbatim quote or source URL was given, so this is unconfirmed.");
      const label = c.label;
      // Find the page holding the quote: the cited page first, then other pages of the same authority.
      let foundAt: string | null = null;
      const direct = ctx.pages.get(canonicalUrl(c.source_url));
      if (direct && quoteInText(c.quote, direct)) foundAt = c.source_url;
      else {
        for (const [url, text] of ctx.pages) {
          if (authorityOk(label, url) && quoteInText(c.quote, text)) {
            foundAt = url;
            break;
          }
        }
      }
      if (!foundAt) return downgrade("The quoted text was not found in the page the agent read, so the claim is unconfirmed.");
      if (!authorityOk(label, foundAt)) {
        const why = label === "composio_docs" ? "Source is not a Composio page." : "Source is not an official page of this provider.";
        return seen.has(canonicalUrl(foundAt)) ? downgrade(`${why} Shown as a report, not as documentation.`, "reported") : downgrade(why);
      }
      const issue = supportIssue(c.text, c.quote);
      if (issue) return { ...downgrade(issue), source_url: foundAt };
      stats.quotes_verified++;
      return { ...claim, source_url: foundAt, note: negationNote(c.text, c.quote) };
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

  const byId = new Map(claims.map((c) => [c.id, c]));
  const keep = (xs: string[]) => xs.filter((x) => byId.has(x));
  const scenarioIds = new Set(g.scenarios.map((s) => s.id));
  const backed = (ids: string[]) => ids.some((id) => byId.get(id) && byId.get(id)!.label !== "unknown");
  const verifiedText = claims
    .filter((c) => c.label !== "unknown")
    .map((c) => `${c.text} ${c.quote ?? ""}`)
    .join(" ");
  const verifiedNumbers = numbersIn(verifiedText);

  const scenarios = g.scenarios.map((s) => {
    const claim_ids = keep(s.claim_ids);
    const waiting =
      /\d/.test(s.waiting.estimate) && !backed(claim_ids)
        ? { estimate: "Unknown", basis: `No verified source backs a timeline here (the agent's unconfirmed estimate was "${s.waiting.estimate}").` }
        : s.waiting;
    return { ...s, claim_ids, waiting };
  });

  const warnings: string[] = [];
  const TIME = /\b(\d+)(?:\s*[-–]\s*\d+)?\+?\s*(?:business\s+|working\s+)?(?:minutes?|mins?|hours?|days?|weeks?|months?)\b/gi;
  for (const m of g.summary.matchAll(TIME)) {
    if (!verifiedNumbers.has(m[1])) warnings.push(`The summary mentions "${m[0]}", which no verified claim supports. Treat it as an estimate.`);
  }

  const guide: Guide = {
    ...g,
    claims,
    scenarios,
    steps: g.steps.map((s) => ({
      ...s,
      claim_ids: keep(s.claim_ids),
      scenario_ids: s.scenario_ids.filter((x) => scenarioIds.has(x)),
    })),
    prerequisites: g.prerequisites.map((p) => ({ ...p, claim_ids: keep(p.claim_ids) })),
    traps: g.traps.map((t) => ({ ...t, claim_ids: keep(t.claim_ids) })),
    blockers: g.blockers.map((b) => ({ ...b, claim_ids: keep(b.claim_ids) })),
  };
  return { guide, stats, warnings };
}

export const LABEL_INFO: Record<ClaimT["label"], { icon: string; name: string; meaning: string }> = {
  tested: { icon: "🧪", name: "Tested", meaning: "Observed in a recorded setup attempt" },
  probed: { icon: "🔎", name: "Probed", meaning: "The agent hit a live endpoint and recorded the response" },
  provider_docs: { icon: "📘", name: "Provider docs", meaning: "Official docs, with a verbatim quote checked against the page" },
  composio_docs: { icon: "🟣", name: "Composio docs", meaning: "Composio docs or API, quote checked against the page" },
  reported: { icon: "💬", name: "Reported", meaning: "Developers report it (forum, blog, issue). Not official" },
  unknown: { icon: "❓", name: "Unknown", meaning: "Not confirmed. Treat as a lead, not a fact" },
};
