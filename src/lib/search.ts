import { Composio, SessionPreset } from "@composio/core";

/**
 * Web search through Composio's own Composio Search toolkit (no provider auth
 * needed), executed via a Composio session with the direct-tools preset so the
 * session exposes exactly the two tools this agent uses.
 *
 * If COMPOSIO_API_KEY is missing, `createComposioSearch` returns null and the
 * agent falls back to Anthropic's server-side web search tool.
 */

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

export interface ComposioSearch {
  search(query: string): Promise<SearchHit[]>;
  fetch(url: string): Promise<{ url: string; title: string | null; text: string } | null>;
}

const SEARCH = "COMPOSIO_SEARCH_WEB";
const FETCH = "COMPOSIO_SEARCH_FETCH_URL_CONTENT";

export async function createComposioSearch(runId: string): Promise<ComposioSearch | null> {
  const apiKey = process.env.COMPOSIO_API_KEY;
  if (!apiKey) return null;
  const composio = new Composio({ apiKey });
  const session = await composio.create(`oauth-guides-${runId}`, {
    toolkits: ["composio_search"],
    tools: { composio_search: { enable: [SEARCH, FETCH] } },
    sessionPreset: SessionPreset.DIRECT_TOOLS,
  });

  // Composio calls get their own timeout so a slow search can't stall the run.
  const timed = <T,>(p: Promise<T>, ms = 20_000) =>
    Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`Composio call timed out after ${ms / 1000}s`)), ms))]);

  let last = 0;
  const throttle = async () => {
    // Composio Search asks for ~1-2 requests/second; bursts get HTTP 429.
    const wait = last + 700 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    last = Date.now();
  };

  return {
    async search(query) {
      await throttle();
      const res = await timed(session.execute(SEARCH, { query }));
      return extractHits(res).slice(0, 8);
    },
    async fetch(url) {
      await throttle();
      const res = await timed(session.execute(FETCH, { urls: [url], text: true, max_characters: 60_000 }));
      const pages = extractPages(res);
      return pages[0] ?? null;
    },
  };
}

/** Composio returns `{ data, error, successful }` where `data` may be an object or a JSON string; walk it defensively. */
function unwrap(res: unknown): unknown {
  let v: unknown = res;
  if (v && typeof v === "object" && "data" in v) v = (v as { data: unknown }).data;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      /* plain text */
    }
  }
  return v;
}

function walk(v: unknown, visit: (o: Record<string, unknown>) => void, depth = 0) {
  if (depth > 8 || v == null) return;
  if (Array.isArray(v)) return v.forEach((x) => walk(x, visit, depth + 1));
  if (typeof v === "object") {
    visit(v as Record<string, unknown>);
    for (const x of Object.values(v)) walk(x, visit, depth + 1);
  }
}

export function extractHits(res: unknown): SearchHit[] {
  const hits: SearchHit[] = [];
  const seen = new Set<string>();
  walk(unwrap(res), (o) => {
    const url = (o.url ?? o.link ?? o.id) as unknown;
    if (typeof url !== "string" || !/^https?:\/\//.test(url) || seen.has(url)) return;
    seen.add(url);
    const title = String(o.title ?? o.name ?? url);
    const snippet = String(o.snippet ?? o.text ?? o.summary ?? o.highlights ?? "").replace(/\s+/g, " ").slice(0, 400);
    hits.push({ title, url, snippet });
  });
  return hits;
}

export function extractPages(res: unknown): { url: string; title: string | null; text: string }[] {
  const pages: { url: string; title: string | null; text: string }[] = [];
  walk(unwrap(res), (o) => {
    const url = o.url ?? o.id;
    const text = o.text ?? o.content ?? o.markdown;
    if (typeof url === "string" && typeof text === "string" && text.length > 200) {
      pages.push({ url, title: typeof o.title === "string" ? o.title : null, text });
    }
  });
  return pages;
}
