import { baseDomain, canonicalUrl } from "../evidence";
import type { ComposioSearch, SearchHit } from "../search";
import { QUESTIONS } from "./questions";
import type { ResearchStore } from "./research";

export interface Candidate {
  url: string;
  label: string;
  score: number;
  from: "entry" | "llms" | "search" | "link";
}

const SKIP = /\.(png|jpe?g|gif|svg|webp|zip|mp4|pdf)(\?|$)|\/(login|signin|signup|pricing-calculator)\b|#/i;
const FORUM = /(stackoverflow|reddit|medium|dev\.to|community|forum|discuss|github\.com\/[^/]+\/[^/]+\/issues)/i;
const KEYWORDS = [...new Set(QUESTIONS.filter((q) => q.id !== "R1").flatMap((q) => q.keywords))];
const STRONG = ["oauth", "authorization", "verification", "review", "publish", "distribution", "marketplace", "scopes", "rate-limit", "rate limit", "app-review", "partner"];

/** Keyword score for a URL plus its link text or search title/snippet. Strong OAuth/review words count double. */
export function scoreText(url: string, label: string): number {
  const t = `${decodeURIComponent(url).toLowerCase().replace(/[-_/]/g, " ")} ${label.toLowerCase()}`;
  let s = 0;
  for (const k of KEYWORDS) if (t.includes(k)) s += 1;
  for (const k of STRONG) if (t.includes(k.replace("-", " "))) s += 2;
  return s;
}

/** Links from an llms.txt index ("- [Title](url): description"). */
export function parseLlmsTxt(text: string, base: string): { url: string; label: string }[] {
  const out: { url: string; label: string }[] = [];
  for (const m of text.matchAll(/\[([^\]]+)\]\(([^)\s]+)\)(?::\s*([^\n]*))?/g)) {
    try {
      out.push({ url: new URL(m[2], base).toString(), label: `${m[1]} ${m[3] ?? ""}`.trim() });
    } catch {
      /* skip */
    }
  }
  return out;
}

export const searchQueries = (app: string) => [
  `${app} OAuth app review verification requirements`,
  `${app} OAuth unverified app limits rate limits`,
  `${app} developer app publish marketplace partner program`,
  `${app} OAuth refresh token expiration testing mode limits`,
];

/**
 * Candidate pages for the extraction pass, ranked. Code does the finding so every run reads the pages most
 * likely to hold the facts, instead of relying on one model's choices.
 */
export async function discover(opts: {
  app: string;
  entryPoints: string[];
  docsUrl: string | null;
  store: ResearchStore;
  search: ComposioSearch | null;
  max: number;
  /** Absolute time by which discovery must finish; slow searches or llms.txt fetches are dropped. */
  deadlineAt: number;
  onSearch?: (query: string, results: SearchHit[]) => void;
}): Promise<{ candidates: Candidate[]; hits: SearchHit[] }> {
  const { store } = opts;
  const all = new Map<string, Candidate>();
  const add = (c: Candidate) => {
    if (SKIP.test(c.url)) return;
    const key = canonicalUrl(c.url);
    const prev = all.get(key);
    if (!prev || prev.score < c.score) all.set(key, c);
  };
  const officialish = (url: string) => {
    const d = baseDomain(url);
    return store.official.has(d) || [...store.official].some((o) => d.split(".")[0].startsWith(o.split(".")[0]) && o.split(".")[0].length >= 4);
  };

  for (const u of opts.entryPoints) add({ url: u, label: "entry point", score: 8 + scoreText(u, ""), from: "entry" });

  // llms.txt indexes on the docs hosts: a curated, machine-readable map of the docs.
  const origins = [...new Set([opts.docsUrl, ...opts.entryPoints].filter((u): u is string => !!u).map((u) => new URL(u).origin))].slice(0, 2);
  const llms = origins.map(async (o) => {
    const page = await store.fetch(`${o}/llms.txt`, opts.deadlineAt);
    if (!page) return;
    for (const l of parseLlmsTxt(page.text, o)) {
      const s = scoreText(l.url, l.label);
      if (s >= 2) add({ url: l.url, label: l.label, score: s + (officialish(l.url) ? 2 : 0), from: "llms" });
    }
  });

  // Templated searches, run by code in parallel (only when a search provider is available to code).
  const hits: SearchHit[] = [];
  const searches = opts.search
    ? searchQueries(opts.app).map(async (q) => {
        try {
          const results = await Promise.race([
            opts.search!.search(q),
            new Promise<SearchHit[]>((r) => setTimeout(() => r([]), Math.max(0, opts.deadlineAt - Date.now()))),
          ]);
          opts.onSearch?.(q, results);
          results.forEach((r) => {
            hits.push(r);
            store.seenUrls.add(r.url);
            const s = scoreText(r.url, `${r.title} ${r.snippet}`);
            add({ url: r.url, label: r.title, score: s + (officialish(r.url) ? 3 : 0) - (FORUM.test(r.url) ? 4 : 0), from: "search" });
          });
        } catch {
          /* a failed search just contributes nothing */
        }
      })
    : [];

  await Promise.race([Promise.all([...llms, ...searches]), new Promise((r) => setTimeout(r, Math.max(0, opts.deadlineAt - Date.now())))]);

  // Prefer official pages; keep at most 2 from any single non-official host.
  const ranked = [...all.values()].sort((a, b) => b.score - a.score);
  const picked: Candidate[] = [];
  const perHost = new Map<string, number>();
  for (const c of ranked) {
    const host = baseDomain(c.url);
    const n = perHost.get(host) ?? 0;
    if (!officialish(c.url) && n >= 2) continue;
    perHost.set(host, n + 1);
    picked.push(c);
    if (picked.length >= opts.max) break;
  }
  return { candidates: picked, hits };
}
