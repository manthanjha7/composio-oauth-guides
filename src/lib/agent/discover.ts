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
// Terms that, in a page's own address, mark the pages a guide needs.
const STRONG_PATH = /oauth|authori[sz]ation|authentication|app[-_]?review|approval|verif|publish|distribut|marketplace|app[-_]?(store|directory|gallery|center)|partner|scopes?\b|rate[-_]?limit|security|getting[-_]?started|consent|production|go[-_]?live|quota/;
const ENDPOINT_PAGE = /\/(?:get|post|put|patch|delete|create|update|list|search|lookup|publish|retrieve|fetch|remove|add)-[a-z0-9-]+(?:\.md)?$/;
// Terms that suggest a page about access, rules or limits (a smaller boost).
const MEDIUM = /getting access|first request|guidelines|polic(?:y|ies)|pricing|developer (?:agreement|terms)|terms of (?:use|service)|credentials|console|dashboard|portal|limits?\b|access level|tiers?\b/;
// Pages that rarely answer approval questions: tutorials, AI/MCP features, samples, blogs, changelogs, SDK and endpoint references.
const OFF_TOPIC_PATH = /tutorial|\/mcp|[-/]ai[-/]|sample|example|\/blog|changelog|release[-_]?notes|\/sdks?\b|api[-_]?reference|\/reference\/|\/embed|webhook|cookbook/;

/**
 * How likely a page answers the research questions: strong terms in its address count most, generic keywords
 * in its title or snippet a little (capped), and pages that are usually off topic are pushed down.
 */
export function scoreText(url: string, label: string): number {
  let path = url.toLowerCase();
  try {
    path = decodeURIComponent(new URL(url).pathname).toLowerCase();
  } catch {
    /* keep the raw string */
  }
  const text = `${path.replace(/[-_/]/g, " ")} ${label.toLowerCase()}`;
  const strongInPath = (path.match(new RegExp(STRONG_PATH.source, "g")) ?? []).length;
  let s = strongInPath * 4;
  s += Math.min(4, KEYWORDS.filter((k) => text.includes(k)).length);
  if (STRONG_PATH.test(label.toLowerCase())) s += 2;
  s += Math.min(3, (text.match(new RegExp(MEDIUM.source, "g")) ?? []).length);
  if (OFF_TOPIC_PATH.test(path) && strongInPath === 0) s -= 6;
  // API endpoint pages ("get-marketplace-handle-availability", "publish-article") describe one call, not the rules.
  if (ENDPOINT_PAGE.test(path)) s -= 8;
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
    const links = parseLlmsTxt(page.text, o);
    const addLinks = (ls: { url: string; label: string }[]) => {
      for (const l of ls) {
        if (/llms\.txt$/.test(l.url)) continue;
        const s = scoreText(l.url, l.label);
        if (s >= 1) add({ url: l.url, label: l.label, score: s + (officialish(l.url) ? 4 : -5), from: "llms" });
      }
    };
    // The top-level links count straight away, so a slow nested index can't cost the whole index.
    addLinks(links);
    // Large docs sites split the index: follow up to two nested llms.txt files on official hosts, most relevant first.
    const nested = links
      .filter((l) => /llms\.txt$/.test(l.url) && officialish(l.url) && l.url !== `${o}/llms.txt`)
      .sort((a, b) => scoreText(b.url, b.label) + (/\bapi\b/i.test(b.label) ? 2 : 0) - (scoreText(a.url, a.label) + (/\bapi\b/i.test(a.label) ? 2 : 0)))
      .slice(0, 2);
    await Promise.all(nested.map(async (n) => {
      const p = await store.fetch(n.url, opts.deadlineAt);
      if (p) addLinks(parseLlmsTxt(p.text, n.url));
    }));
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
            // The provider's own pages first; others only fill in (developer reports have their own search later).
            add({ url: r.url, label: r.title, score: s + (officialish(r.url) ? 4 : -5) - (FORUM.test(r.url) ? 4 : 0), from: "search" });
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
