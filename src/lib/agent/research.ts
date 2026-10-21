import { createHash } from "node:crypto";
import { baseDomain, canonicalUrl, isTenantHost, quoteInText } from "../evidence";
import type { ResearchRecordT, SourceRecordT } from "../schema";
import type { ComposioSearch } from "../search";
import { fetchPageText } from "../web";
import { QUESTIONS, type QuestionId } from "./questions";

export interface Page {
  url: string;
  title: string | null;
  text: string;
  links: string[];
  fetched_at: string;
  hash: string;
  via: SourceRecordT["via"];
}

export type EvidenceItem = ResearchRecordT["evidence"][number];

/** Suffixes that turn a brand into its developer domain (empty = same name on another TLD, e.g. slack.dev). */
const SIBLING = /^(?:|api|apis|dev|developer|developers|docs|platform|cloud|app|apps|usercontent|static|cdn|content|hq|status)$/;
const TIME_SPAN = /\b\d+(?:\s*[-–]\s*\d+)?\s*(?:business\s+|working\s+)?(?:minutes?|hours?|days?|weeks?|months?)\b|\b(?:a|one|two|three|four|five|six|several|few)\s+(?:days?|weeks?|months?)\b/i;

const isComposio = (url: string) => {
  try {
    return /(^|\.)composio\.dev$/.test(new URL(url).hostname);
  } catch {
    return false;
  }
};

/**
 * Shared state for one run: the page cache (each URL fetched once, even when two workers ask at the same
 * time), the evidence ledger (every item verified the moment it arrives), and the official-domain set.
 */
export class ResearchStore {
  readonly pages = new Map<string, Page>();
  private inflight = new Map<string, Promise<Page | null>>();
  readonly failed = new Map<string, string>();
  readonly evidence: EvidenceItem[] = [];
  readonly tried = new Map<QuestionId, Set<string>>();
  /** Registrable domains treated as the provider's own. Built only from pages that were actually fetched. */
  readonly official = new Set<string>();
  /** Brand labels of the seed domains, for accepting sibling domains that official pages link to. */
  private brands = new Set<string>();
  seenUrls = new Set<string>();

  constructor(
    private search: ComposioSearch | null,
    private onFetch?: (url: string, ok: boolean, chars: number, via: string, error?: string) => void,
  ) {}

  /**
   * Fetch a page once per run. Concurrent requests for the same URL share one fetch. The fetch stops at
   * `deadlineAt` (and on the run's abort signal) so reading can never eat into the writer's time.
   */
  fetch(url: string, deadlineAt = Date.now() + 12_000): Promise<Page | null> {
    const key = canonicalUrl(url);
    const have = this.pages.get(key);
    if (have) return Promise.resolve(have);
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const ms = Math.min(12_000, deadlineAt - Date.now());
    if (ms < 1_500) return Promise.resolve(null);
    // After the deadline, a late result is ignored: it must not change what the run has already used.
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const p = Promise.race([
      this.doFetch(url, ms, () => live),
      new Promise<null>((r) => {
        timer = setTimeout(() => r(null), ms + 500);
      }),
    ]).finally(() => {
      live = false;
      clearTimeout(timer);
      this.inflight.delete(key);
    });
    this.inflight.set(key, p);
    return p;
  }

  signal?: AbortSignal;

  private async doFetch(url: string, timeoutMs: number, live: () => boolean): Promise<Page | null> {
    const store = (u: string, title: string | null, text: string, links: string[], via: Page["via"]): Page | null => {
      if (!live()) return null;
      const page: Page = { url: u, title, text, links, fetched_at: new Date().toISOString(), hash: createHash("sha256").update(text).digest("hex").slice(0, 16), via };
      this.pages.set(canonicalUrl(u), page);
      if (canonicalUrl(u) !== canonicalUrl(url)) this.pages.set(canonicalUrl(url), page);
      this.onFetch?.(u, true, text.length, via === "composio_fetch" ? "Composio fetch" : "direct");
      return page;
    };
    try {
      const p = await fetchPageText(url, { timeoutMs, signal: this.signal });
      if (p.text.length < 400 && this.search) throw new Error("page looks empty (likely rendered by JavaScript)");
      return store(p.url, p.title, p.text, p.links ?? [], "direct");
    } catch (e) {
      if (this.search) {
        try {
          let t: ReturnType<typeof setTimeout> | undefined;
          const p = await Promise.race([
            this.search.fetch(url),
            new Promise<null>((r) => {
              t = setTimeout(() => r(null), Math.max(1_000, timeoutMs / 2));
            }),
          ]).finally(() => clearTimeout(t));
          if (p && p.text.length >= 200) return store(p.url, p.title, p.text, [], "composio_fetch");
        } catch {
          /* fall through */
        }
      }
      this.failed.set(canonicalUrl(url), (e as Error).message);
      this.onFetch?.(url, false, 0, "direct", (e as Error).message);
      return null;
    }
  }

  /** Seed the official set with a domain we have independent reason to trust (Composio's catalog, a fetched docs page). */
  addOfficial(urlOrHost: string | null | undefined) {
    if (!urlOrHost) return;
    const d = baseDomain(urlOrHost);
    if (!d || d === "composio.dev") return;
    this.official.add(d);
    const label = d.split(".")[0];
    if (label.length >= 4) this.brands.add(label);
  }

  /**
   * Sibling domains count as official only when an official page links to them AND the name is the brand plus a
   * known developer suffix: dropbox → dropboxapi.com, google → googleapis.com, slack.com → slack.dev. A linked
   * look-alike (salesforce → salesforceben.com) is not a sibling.
   */
  expandOfficialFromLinks() {
    for (const page of this.pages.values()) {
      if (!this.official.has(baseDomain(page.url))) continue;
      for (const link of page.links) {
        const d = baseDomain(link);
        // A tenant on a shared platform (acme.readme.io) is never a sibling: someone else may control it.
        if (!d || this.official.has(d) || isTenantHost(d)) continue;
        const label = d.split(".")[0];
        if ([...this.brands].some((b) => SIBLING.test(label.slice(b.length)) && label.startsWith(b))) this.official.add(d);
      }
    }
  }

  kindOf(url: string): EvidenceItem["kind"] {
    if (isComposio(url)) return "composio_docs";
    return this.official.has(baseDomain(url)) ? "provider_docs" : "reported";
  }

  markTried(q: QuestionId, url: string) {
    if (!this.tried.has(q)) this.tried.set(q, new Set());
    this.tried.get(q)!.add(url);
  }

  /** Add one piece of evidence; it is verified against the fetched page immediately. Returns the stored item. */
  addEvidence(e: {
    question: QuestionId;
    url: string;
    quote: string;
    answer: string;
    via: EvidenceItem["via"];
    extra_quotes?: string[];
    offsets?: [number, number];
  }): EvidenceItem {
    const page = this.pages.get(canonicalUrl(e.url));
    const allOnPage = !!page && [e.quote, ...(e.extra_quotes ?? [])].every((q) => quoteInText(q, page.text));
    const status: EvidenceItem["status"] = !page ? "not_fetched" : allOnPage ? "verified" : "not_on_page";
    const dup = this.evidence.find((x) => x.question === e.question && canonicalUrl(x.url) === canonicalUrl(e.url) && x.quote === e.quote);
    if (dup) return dup;
    const item: EvidenceItem = {
      id: `E${this.evidence.length + 1}`,
      question: e.question,
      url: page?.url ?? e.url,
      quote: e.quote.trim(),
      answer: e.answer.trim(),
      kind: this.kindOf(page?.url ?? e.url),
      status,
      via: e.via,
      fetched_at: page?.fetched_at ?? null,
      page_hash: page?.hash ?? null,
      ...(e.extra_quotes?.length ? { extra_quotes: e.extra_quotes.map((q) => q.trim()) } : {}),
      ...(e.offsets ? { offsets: e.offsets } : {}),
    };
    this.evidence.push(item);
    return item;
  }

  /** Re-label evidence after the official set grows (links from official pages are known only after reading). */
  relabel() {
    for (const e of this.evidence) e.kind = this.kindOf(e.url);
  }

  verified(q?: QuestionId) {
    return this.evidence.filter((e) => e.status === "verified" && (!q || e.question === q));
  }

  /** Mark evidence as rejected (its claim was contradicted or unsupported); it no longer answers its question. */
  reject(ids: string[]) {
    for (const e of this.evidence) if (ids.includes(e.id)) e.status = "rejected";
  }

  /**
   * Found = at least one verified, non-rejected evidence item from an official source. A model saying "found"
   * is not enough, and a blog post does not answer a docs question. Developer reports answer R1, and answer G6
   * (timelines) only when they actually state a time span.
   */
  status(q: QuestionId): "found" | "not_found" {
    const ev = this.verified(q);
    if (q === "R1") return ev.length ? "found" : "not_found";
    if (q === "C1") return ev.some((e) => e.kind !== "reported") ? "found" : "not_found";
    // Provider questions are answered by the provider's own docs, not by Composio's pages or blogs.
    if (ev.some((e) => e.kind === "provider_docs")) return "found";
    if (q === "G6") {
      const timed = [...ev, ...this.verified("R1")].some((e) => TIME_SPAN.test(`${e.quote} ${(e.extra_quotes ?? []).join(" ")}`));
      return timed ? "found" : "not_found";
    }
    return "not_found";
  }

  openCritical(): QuestionId[] {
    return QUESTIONS.filter((q) => q.critical && this.status(q.id) === "not_found")
      .sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99))
      .map((q) => q.id);
  }

  sources(): SourceRecordT[] {
    const seen = new Set<string>();
    const out: SourceRecordT[] = [];
    for (const p of this.pages.values()) {
      if (seen.has(p.url)) continue;
      seen.add(p.url);
      out.push({ url: p.url, title: p.title, fetched_at: p.fetched_at, via: p.via, chars: p.text.length });
    }
    return out;
  }

  questionRecords(): ResearchRecordT["questions"] {
    return QUESTIONS.map((q) => ({
      id: q.id,
      status: this.status(q.id),
      evidence: this.verified(q.id).map((e) => e.id),
      tried: [...(this.tried.get(q.id) ?? [])].slice(0, 12),
    }));
  }
}
