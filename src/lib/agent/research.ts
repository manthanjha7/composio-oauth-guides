import { createHash } from "node:crypto";
import { baseDomain, canonicalUrl, quoteInText } from "../evidence";
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

  /** Fetch a page once per run. Concurrent requests for the same URL share one fetch. */
  fetch(url: string): Promise<Page | null> {
    const key = canonicalUrl(url);
    const have = this.pages.get(key);
    if (have) return Promise.resolve(have);
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const p = this.doFetch(url).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  private async doFetch(url: string): Promise<Page | null> {
    const store = (u: string, title: string | null, text: string, links: string[], via: Page["via"]): Page => {
      const page: Page = { url: u, title, text, links, fetched_at: new Date().toISOString(), hash: createHash("sha256").update(text).digest("hex").slice(0, 16), via };
      this.pages.set(canonicalUrl(u), page);
      if (canonicalUrl(u) !== canonicalUrl(url)) this.pages.set(canonicalUrl(url), page);
      this.onFetch?.(u, true, text.length, via === "composio_fetch" ? "Composio fetch" : "direct");
      return page;
    };
    try {
      const p = await fetchPageText(url);
      if (p.text.length < 400 && this.search) throw new Error("page looks empty (likely rendered by JavaScript)");
      return store(p.url, p.title, p.text, p.links ?? [], "direct");
    } catch (e) {
      if (this.search) {
        try {
          const p = await this.search.fetch(url);
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
   * Sibling domains (docs.dropboxapi.com for dropbox.com) count as official only when an official page links
   * to them and they share the brand. A look-alike blog (salesforceben.com) is never linked from the provider.
   */
  expandOfficialFromLinks() {
    for (const page of this.pages.values()) {
      if (!this.official.has(baseDomain(page.url))) continue;
      for (const link of page.links) {
        const d = baseDomain(link);
        if (!d || this.official.has(d)) continue;
        if ([...this.brands].some((b) => d.split(".")[0].startsWith(b))) this.official.add(d);
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
  addEvidence(e: { question: QuestionId; url: string; quote: string; answer: string; via: EvidenceItem["via"] }): EvidenceItem {
    const page = this.pages.get(canonicalUrl(e.url));
    const status: EvidenceItem["status"] = !page ? "not_fetched" : quoteInText(e.quote, page.text) ? "verified" : "not_on_page";
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

  /** Found = at least one verified evidence item. A model saying "found" is not enough. */
  status(q: QuestionId): "found" | "not_found" {
    if (q === "G6" && this.verified("R1").length) return "found"; // developer reports can answer timelines, labelled as reports
    return this.verified(q).length ? "found" : "not_found";
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
