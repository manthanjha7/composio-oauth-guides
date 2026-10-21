import { getDomain } from "tldts";
import type { ClaimT, GeneratedGuide, Guide, ProbeRecordT } from "./schema";

/** Normalise text for quote matching: case, whitespace, quotes/dashes, markdown noise. */
export function normalizeForMatch(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”‟]/g, '"')
    .replace(/[–—−]/g, "-")
    .replace(/ /g, " ")
    .replace(/<\/?[a-z][^>]*>/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\]\([^)\s]*\)/g, "") // half a markdown link, e.g. a quote that starts inside one
    .replace(/[*_`#>|\[\]]/g, " ")
    .replace(/\s+([.,;:!?)])/g, "$1")
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
 * True when the quote appears in the page text. An ellipsis-split quote ("first part ... second part") is
 * allowed only as a real elision: each part at least 12 characters, in order, and each within 400 characters
 * of the previous one, so fragments can't be stitched together from different parts of a page.
 */
export function quoteInText(quote: string, pageText: string): boolean {
  const page = normalizeForMatch(pageText);
  const parts = quote
    .split(/\.\.\.|…/)
    .map(normalizeForMatch)
    .filter((p) => /[a-z0-9]/.test(p));
  if (parts.length === 0) return false;
  if (parts.join(" ").length < 12) return false; // too short to be meaningful evidence
  if (parts.length > 1 && parts.some((p) => p.length < 12)) return false;
  let from = 0;
  let prevEnd = -1;
  for (const part of parts) {
    const idx = page.indexOf(part, from);
    if (idx === -1) return false;
    if (prevEnd >= 0 && idx - prevEnd > 400) return false;
    prevEnd = idx + part.length;
    from = prevEnd;
  }
  return true;
}

export interface EvidenceContext {
  /** canonical url -> page text the agent actually read */
  pages: Map<string, string>;
  /** urls seen in search results (for "reported" claims) */
  seenUrls: Set<string>;
  probes: ProbeRecordT[];
  /** Registrable domains of the provider (from its website / docs URL). Empty = don't enforce (v1). */
  officialDomains?: string[];
  /**
   * v2: exact registrable domains built in code from pages actually fetched (no brand-prefix matching), and an
   * empty list means nothing is official. composio.dev stays Composio's authority either way.
   */
  strictOfficial?: boolean;
  /**
   * v2: further quotes that support a claim jointly with its main quote (several citations on one sentence).
   * The main quote must be on the page; the support checks read all of them.
   */
  supportQuotes?: Map<string, string[]>;
}

export interface VerificationStats {
  claims_total: number;
  quotes_checked: number;
  quotes_verified: number;
  downgraded: number;
}

// Hosts where each subdomain belongs to a different customer: the tenant host, not the platform, is the owner.
// (Public Suffix List private entries such as github.io and vercel.app are handled by tldts.)
const TENANT_PLATFORMS = new Set([
  "readme.io", "gitbook.io", "notion.site", "mintlify.app", "atlassian.net", "zendesk.com", "freshdesk.com",
  "helpscoutdocs.com", "intercom.help", "webflow.io", "wixsite.com", "medium.com", "substack.com", "hashnode.dev",
  "document360.io", "stoplight.io", "postman.co", "apiary.io", "squarespace.com", "framer.website", "super.site",
]);

/**
 * The owner of a URL's host: the registrable domain ("docs.slack.dev" -> "slack.dev", "foo.co.uk" -> "foo.co.uk"),
 * Public-Suffix aware ("acme.github.io" stays "acme.github.io"), and tenant-specific on shared docs platforms
 * ("acme.readme.io" stays "acme.readme.io", not "readme.io").
 */
/** True for a host owned by one customer of a shared platform (acme.readme.io, acme.github.io). */
export function isTenantHost(urlOrHost: string): boolean {
  const d = baseDomain(urlOrHost);
  const icann = getDomain(d, { allowPrivateDomains: false });
  return TENANT_PLATFORMS.has(icann ?? "") || (icann !== null && icann !== d);
}

/** "(number unit)" pairs in a text, e.g. "10 day", "100 user". */
export function numberUnitPairs(text: string): Set<string> {
  return numberUnits(text);
}

export function baseDomain(urlOrHost: string): string {
  let host = urlOrHost;
  try {
    host = new URL(urlOrHost.includes("://") ? urlOrHost : `https://${urlOrHost}`).hostname;
  } catch {
    /* use as-is */
  }
  host = host.toLowerCase().replace(/\.$/, "");
  const d = getDomain(host, { allowPrivateDomains: true }) ?? host;
  return TENANT_PLATFORMS.has(d) && host !== d ? host.replace(/^www\./, "") : d;
}

/**
 * Providers often publish docs on a sibling brand domain (docs.dropboxapi.com, googleapis.com, slack.dev).
 * A domain counts as official if it is one of the provider's domains or its name starts with the brand.
 */
export function isOfficialDomain(url: string, official: Set<string>): boolean {
  const d = baseDomain(url);
  if (official.has(d)) return true;
  const label = d.split(".")[0];
  return [...official].some((o) => {
    const brand = o.split(".")[0];
    return brand.length >= 4 && label.startsWith(brand);
  });
}

const isComposio = (url: string) => /(^|\.)composio\.dev$/.test(safeHost(url));
function safeHost(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

const SMALL: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const NUMBER_WORD = `(?:${[...Object.keys(SMALL), ...Object.keys(TENS), "hundred", "thousand"].join("|")})`;
const NUMBER_RUN = new RegExp(`\\b${NUMBER_WORD}(?:(?:\\s+|-|\\s+and\\s+)${NUMBER_WORD})*\\b`, "gi");

/**
 * Spelled-out numbers to digits, compounds included: "twenty-one" -> 21, "two hundred" -> 200,
 * "thirteen" -> 13. A lone "one" is left alone ("one of the apps" is not a quantity worth checking).
 */
export function wordsToDigits(text: string): string {
  return text.replace(NUMBER_RUN, (run) => {
    // Tokens with the separator before each, so a range ("two-three days") stays a range ("2-3").
    const tokens = [...run.matchAll(/(\s+and\s+|\s+|-)?([a-z]+)/gi)].map((m) => ({ sep: m[1] ?? "", w: m[2].toLowerCase() }));
    if (tokens.length === 1 && tokens[0].w === "one") return run;
    const groups: { sep: string; ws: string[] }[] = [];
    const mag = (w: string) => (w === "thousand" ? 1000 : w === "hundred" ? 100 : 0);
    tokens.forEach((t, i) => {
      const g = groups.at(-1);
      const last = g?.ws.at(-1);
      // After a scale, a value carrying its own scale of the same or larger size is a separate quantity
      // ("one hundred and two hundred" = 100 and 200), while a smaller one is a remainder ("one thousand two hundred").
      const nextScale = tokens[i + 1] && !/-|and/.test(tokens[i + 1].sep) ? mag(tokens[i + 1].w) : 0;
      // A new number starts when two values can't combine: "two three", "twenty thirty", "fifteen four".
      const hyphen = t.sep === "-";
      const and = /and/.test(t.sep);
      const tensCompound = !!last && last in TENS && t.w in SMALL && SMALL[t.w] < 10 && !and; // twenty-one, twenty one
      const scale = (t.w === "hundred" || t.w === "thousand") && !hyphen && !and; // two hundred
      const afterScale =
        (last === "hundred" || last === "thousand") && (t.w in SMALL || t.w in TENS) && !hyphen && !(nextScale && nextScale >= mag(last)); // one hundred (and) five
      // A hyphen only joins a tens compound; otherwise it marks a range ("one hundred-two hundred" = 100-200).
      // "and" only joins after hundred/thousand ("twenty and one" stays two numbers).
      const joins = !!last && (tensCompound || scale || afterScale);
      if (g && joins) g.ws.push(t.w);
      else groups.push({ sep: t.sep, ws: [t.w] });
    });
    const value = (ws: string[]) => {
      let total = 0;
      let current = 0;
      for (const w of ws) {
        if (w in SMALL) current += SMALL[w];
        else if (w in TENS) current += TENS[w];
        else if (w === "hundred") current = (current || 1) * 100;
        else if (w === "thousand") {
          total += (current || 1) * 1000;
          current = 0;
        }
      }
      return total + current;
    };
    return groups.map((g, i) => `${i ? (g.sep.trim() === "" ? " " : g.sep) : ""}${value(g.ws)}`).join("");
  });
}

function numbersIn(text: string): Set<string> {
  // Not quantities: protocol/API versions ("OAuth 2.0", "v3") and HTTP status codes ("401 error", "HTTP 403").
  const t = wordsToDigits(text)
    .toLowerCase()
    // Dates are not quantities: "1 May 2026", "May 1, 2026", "May 2025", "2025-05-14", "(2025)".
    .replace(/\b\d{1,2}\s+(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?,?\s+(?:19|20)\d{2}\b/g, " ")
    .replace(/\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(?:\d{1,2},?\s+)?(?:19|20)\d{2}\b/g, " ")
    .replace(/\b(?:19|20)\d{2}-\d{2}(?:-\d{2})?\b/g, " ")
    .replace(/\((?:19|20)\d{2}\)/g, " ")
    .replace(/\b(?:oauth|http|https|tls|api|v)\s*\d+(?:\.\d+)*\b/g, " ")
    .replace(/\b(?:status|error|code|http)\s*[1-5]\d\d\b/g, " ")
    .replace(/\b[1-5]\d\d\s*(?:errors?|status|responses?|codes?|redirects?|found|forbidden|unauthorized|not found|too many requests)\b/g, " ")
    .replace(/\b(?:returns?|returned|responds? with|redirects? with|→)\s*(?:an?\s*)?(?:http\s*)?[1-5]\d\d\b/g, " ");
  const out = new Set<string>();
  for (const m of t.matchAll(/(?<![\w.$])\$?(\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?![\w])/g)) out.add(m[1].replace(/,/g, ""));
  return out;
}
// Units that change a claim's meaning when swapped ("100 per minute" vs "100 per day").
const UNIT: [RegExp, string][] = [
  [/^(?:minutes?|mins?)$/, "minute"],
  [/^(?:hours?|hrs?)$/, "hour"],
  [/^(?:days?)$/, "day"],
  [/^(?:weeks?)$/, "week"],
  [/^(?:months?)$/, "month"],
  [/^(?:years?|yr)$/, "year"],
  [/^(?:seconds?|secs?)$/, "second"],
  [/^(?:users?|people|members?|testers?)$/, "user"],
  [/^(?:workspaces?|teams?|orgs?|organi[sz]ations?)$/, "workspace"],
  [/^(?:stores?|shops?|merchants?)$/, "store"],
  [/^(?:requests?|calls?)$/, "request"],
  [/^(?:installs?|installations?)$/, "install"],
  [/^(?:connections?)$/, "connection"],
  [/^(?:tokens?|access tokens?)$/, "token"],
  [/^(?:accounts?)$/, "account"],
  [/^(?:apps?|applications?|clients?)$/, "app"],
  [/^(?:seats?|licen[cs]es?)$/, "seat"],
  [/^(?:authori[sz]ations?)$/, "authorization"],
  [/^(?:messages?)$/, "message"],
];
const TIME_UNITS = new Set(["second", "minute", "hour", "day", "week", "month", "year"]);
const unitOf = (w: string) => UNIT.find(([re]) => re.test(w))?.[1] ?? null;

/** Normalised words, with "non-sensitive" kept apart from "sensitive" and contractions expanded. */
/** Normalised words; number words become digits ("ten weeks" -> "10 weeks") so unit checks see them. */
function words(text: string): string[] {
  return normalizeForMatch(wordsToDigits(text))
    .replace(/\bnon-(\w)/g, "non$1")
    .replace(/n't\b/g, " not")
    .split(/[^a-z0-9$,]+/)
    .filter(Boolean);
}

/** Every quantity in a text, digits or number words ("ten" -> "10"); versions and HTTP codes excluded. */
export function numbersInText(text: string): Set<string> {
  return numbersIn(text);
}

/** (number, unit) pairs: a number followed by a unit within three words ("100 test users", "10 business days"). */
function numberUnits(text: string): Set<string> {
  const w = words(text);
  const out = new Set<string>();
  w.forEach((tok, i) => {
    const n = tok.replace(/,/g, "");
    if (!/^\d+$/.test(n)) return;
    for (let j = i + 1; j <= i + 3 && j < w.length; j++) {
      // "100 per account": what follows "per"/"each" is the rate's denominator, not what is counted.
      if (w[j] === "per" || w[j] === "each" || w[j] === "every") break;
      const u = unitOf(w[j]);
      if (u) {
        out.add(`${n} ${u}`);
        break;
      }
    }
  });
  return out;
}
function timeUnits(text: string, withEquivalents = false): Set<string> {
  const out = new Set(words(text).map(unitOf).filter((u): u is string => !!u && TIME_UNITS.has(u)));
  if (!withEquivalents) return out;
  // The quote may give the same span in another unit: "60 minutes" is an hour, "24 hours" a day, "7 days" a week.
  const pairs = numberUnits(text);
  if (pairs.has("60 minute")) out.add("hour");
  if (pairs.has("24 hour")) out.add("day");
  if (pairs.has("7 day")) out.add("week");
  if (pairs.has("12 month")) out.add("year");
  return out;
}

const NEG_WORDS = new Set(["not", "no", "never", "none", "cannot", "without", "neither", "nor", "nothing"]);
/**
 * A negation in the claim that the quote doesn't carry, next to a word the quote does use
 * ("must not return" vs "must return"; "no review" vs "a review"). A "no" attached to a word the quote
 * never mentions ("with no stated duration") is the writer's own aside, not a flipped fact.
 */
function addedNegation(claimText: string, quote: string): boolean {
  const qw = words(quote);
  const negatedInQuote = (x: string) => qw.some((w, i) => w === x && qw.slice(Math.max(0, i - 3), i + 3).some((y) => NEG_WORDS.has(y)));
  const qset = new Set(qw.filter((w) => w.length >= 3 && !STOP.has(w)));
  const cw = words(claimText);
  return cw.some((w, i) => {
    if (!NEG_WORDS.has(w)) return false;
    const near = [cw[i - 1], cw[i + 1], cw[i + 2]].filter((x): x is string => !!x && qset.has(x));
    return near.length > 0 && !near.some(negatedInQuote);
  });
}

const STRONG = /\b(?:must|required|requires|require|mandatory|always|need to|needs to|have to|has to|only)\b/;
const WEAK = /\b(?:may|optional|optionally|might|could|recommended|recommend|sometimes|can choose)\b/;
// Words whose opposite flips a claim's meaning. If the claim uses one and the quote only the other, it's wrong.
const CONTRASTS: [string, string][] = [
  ["restricted", "sensitive"],
  ["internal", "external"],
  ["public", "private"],
  ["listed", "unlisted"],
  ["production", "development"],
];

/**
 * Hard checks (precise enough to downgrade a claim automatically): every number in the claim is in the
 * quote, with the same unit where both give one ("100 per minute" vs "100 per day").
 * Returns a reason when a check fails, else null.
 */
export function supportIssue(claimText: string, quote: string): string | null {
  const q = numbersIn(quote);
  const missing = [...numbersIn(claimText)].filter((n) => !q.has(n));
  if (missing.length) return `The claim states ${missing.join(", ")}, which the quote does not contain.`;
  const qNums = new Map<string, Set<string>>();
  numberUnits(quote).forEach((p) => {
    const [n, u] = p.split(" ");
    qNums.set(n, (qNums.get(n) ?? new Set()).add(u));
  });
  for (const p of numberUnits(claimText)) {
    const [n, u] = p.split(" ");
    const units = qNums.get(n);
    if (units && !units.has(u)) return `The claim says ${n} ${u}s; the quote gives ${n} ${[...units].join("/")}s.`;
  }
  return null;
}

/**
 * Soft checks: signs that a real quote may not say what the claim says. Word rules can't read meaning
 * reliably, so these flag a claim for a model judge (or a visible note) instead of downgrading it:
 *  - a time unit the quote doesn't use (per minute vs per day)
 *  - a negation the quote doesn't carry, next to a word the quote uses
 *  - "must" where the quote only says "may"/"can", or the reverse
 *  - a swapped tier (restricted vs sensitive, internal vs external, …)
 */
export function supportFlags(claimText: string, quote: string): string[] {
  const flags: string[] = [];
  const qTime = timeUnits(quote, true);
  if (qTime.size) {
    const extra = [...timeUnits(claimText)].filter((u) => !qTime.has(u));
    if (extra.length) flags.push(`The claim is about ${extra.join(", ")}s; the quote talks about ${[...timeUnits(quote)].join(", ")}s.`);
  }
  const c = ` ${words(claimText).join(" ")} `;
  const qt = ` ${words(quote).join(" ")} `;
  if (addedNegation(claimText, quote)) flags.push("The claim is negative where the quote is not.");
  if (STRONG.test(c) && !STRONG.test(qt) && (WEAK.test(qt) || /\bcan\b/.test(qt))) flags.push("The claim says required; the quote says optional or possible.");
  if (WEAK.test(c) && !WEAK.test(qt) && STRONG.test(qt)) flags.push("The claim says optional or possible; the quote says required.");
  for (const [a, b] of CONTRASTS) {
    for (const [x, y] of [[a, b], [b, a]]) {
      const has = (s: string, w: string) => new RegExp(`\\b${w}\\b`).test(s);
      if (has(c, x) && !has(qt, x) && has(qt, y)) flags.push(`The claim says "${x}"; the quote says "${y}".`);
    }
  }
  return flags;
}

const STOP = new Set("the a an and or of to in for on with by is are be can must may your you this that it its from as at not no all any per each into than then them they their which when".split(" "));
const contentWords = (x: string) =>
  new Set(
    normalizeForMatch(x)
      .split(/[^a-z0-9.]+/)
      .filter((w) => w.length >= 4 && !STOP.has(w)),
  );

/** Softer signal (note, not a downgrade): the quote shares almost no words with the claim it supposedly supports. */
export function overlapNote(claimText: string, quote: string): string | null {
  const c = contentWords(claimText);
  if (c.size < 3) return null;
  const q = contentWords(quote);
  const shared = [...c].filter((w) => q.has(w) || [...q].some((x) => x.startsWith(w.slice(0, 5)))).length;
  return shared / c.size < 0.2 ? "The quote shares few words with this claim. Read it before relying on the claim." : null;
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
    label === "composio_docs"
      ? isComposio(url)
      : ctx.strictOfficial
        ? official.has(baseDomain(url))
        : official.size === 0 || isOfficialDomain(url, official);

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
      const support = [c.quote, ...(ctx.supportQuotes?.get(c.id) ?? [])].join(" ");
      const issue = supportIssue(c.text, support);
      if (issue) return { ...downgrade(issue), source_url: foundAt };
      stats.quotes_verified++;
      const flags = supportFlags(c.text, support);
      return { ...claim, source_url: foundAt, note: flags.length ? `${flags.join(" ")} Check the quote.` : overlapNote(c.text, c.quote) };
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
  tested: { icon: "🧪", name: "Tested", meaning: "Seen in a recorded setup attempt" },
  provider_docs: { icon: "📘", name: "Provider docs", meaning: "Quoted from the provider's docs" },
  composio_docs: { icon: "🟣", name: "Composio docs", meaning: "Quoted from Composio's docs" },
  probed: { icon: "🔎", name: "Endpoint check", meaning: "The agent called the provider's endpoint and recorded the reply" },
  reported: { icon: "💬", name: "Reported", meaning: "From a forum or blog, not official" },
  unknown: { icon: "❓", name: "Unconfirmed", meaning: "Not confirmed by a source" },
};
