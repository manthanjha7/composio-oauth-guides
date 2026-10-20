import { fetchPageText, safeGet } from "./web";

/**
 * Facts about an app from Composio's own published material:
 *  - the managed-auth directory (which OAuth toolkits Composio supplies an app for)
 *  - the toolkit page header + FAQ (auth types, known errors)
 *  - the composio.dev/auth/<slug> credential guide, if one exists
 *  - the toolkit API's `composio_managed_auth_schemes`, when a COMPOSIO_API_KEY is set
 */

const DOCS = "https://docs.composio.dev";

export interface CatalogEntry {
  name: string;
  slug: string;
  managed: boolean;
}

let catalogCache: { at: number; entries: CatalogEntry[]; text: string } | null = null;

export async function loadManagedAuthCatalog(): Promise<{ entries: CatalogEntry[]; text: string; url: string }> {
  const url = `${DOCS}/toolkits/managed-auth.md`;
  if (catalogCache && Date.now() - catalogCache.at < 6 * 3600_000) return { ...catalogCache, url };
  const res = await safeGet(url);
  if (res.status !== 200) throw new Error(`Managed-auth directory returned HTTP ${res.status}`);
  const entries = parseManagedAuthCatalog(res.body);
  catalogCache = { at: Date.now(), entries, text: res.body };
  return { entries, text: res.body, url };
}

export function parseManagedAuthCatalog(md: string): CatalogEntry[] {
  const entries: CatalogEntry[] = [];
  let section: "managed" | "byo" | null = null;
  for (const line of md.split("\n")) {
    if (/^##\s+Composio-managed/i.test(line)) section = "managed";
    else if (/^##\s+Bring your own/i.test(line)) section = "byo";
    else if (/^##\s/.test(line)) section = null;
    const m = line.match(/^\|\s*\[([^\]]+)\]\([^)]*\)\s*\|\s*`([A-Z0-9_]+)`\s*\|/);
    if (m && section) entries.push({ name: m[1], slug: m[2].toLowerCase(), managed: section === "managed" });
  }
  return entries;
}

const norm = (s: string) => s.toLowerCase().replace(/\.(com|io|so|ai|app|dev|co)\b.*$/, "").replace(/[^a-z0-9]/g, "");

export function matchCatalog(query: string, entries: CatalogEntry[]): CatalogEntry[] {
  const q = norm(query.replace(/^https?:\/\/(www\.)?/, ""));
  if (!q) return [];
  const exact = entries.filter((e) => norm(e.name) === q || e.slug.replace(/_/g, "") === q);
  if (exact.length) return exact;
  return entries.filter((e) => norm(e.name).startsWith(q) || (q.length >= 4 && norm(e.name).includes(q))).slice(0, 6);
}

export interface ToolkitFacts {
  slug: string;
  page_url: string;
  header: string;
  faq: string;
}

/** Read only the header + FAQ of a toolkit page; tool definitions can run to 600KB. */
export async function toolkitPageFacts(slug: string): Promise<ToolkitFacts | null> {
  const url = `${DOCS}/toolkits/${slug.toLowerCase()}.md`;
  const res = await safeGet(url, { maxBytes: 1_500_000 });
  if (res.status !== 200 || !res.body.includes("**Slug:**")) return null;
  const body = res.body.replace(/^---[\s\S]*?---\s*/, "");
  const toolsIdx = body.search(/^## Tools\s*$/m);
  const top = toolsIdx > 0 ? body.slice(0, toolsIdx) : body.slice(0, 8000);
  const faqIdx = top.search(/^## Frequently Asked Questions/m);
  const header = (faqIdx > 0 ? top.slice(0, faqIdx) : top).trim().slice(0, 1500);
  const faq = faqIdx > 0 ? top.slice(faqIdx).trim().slice(0, 6000) : "";
  return { slug, page_url: url, header, faq };
}

export async function credentialGuide(slug: string): Promise<{ url: string; title: string } | null> {
  const url = `https://composio.dev/auth/${slug.toLowerCase()}`;
  try {
    const page = await fetchPageText(url);
    const m = `${page.title ?? ""}\n${page.text}`.match(/How to create[^\n|]{0,120}/);
    if (!m) return null;
    return { url, title: m[0].replace(/\s*\|\s*Composio\s*$/, "").trim() };
  } catch {
    return null;
  }
}

/** Uses the toolkit API when a key is configured (no key = docs-only facts). */
export async function managedSchemesFromApi(slug: string): Promise<string[] | null> {
  const key = process.env.COMPOSIO_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch(`https://backend.composio.dev/api/v3.1/toolkits/${encodeURIComponent(slug.toLowerCase())}`, {
      headers: { "x-api-key": key },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { composio_managed_auth_schemes?: string[] };
    return Array.isArray(json.composio_managed_auth_schemes) ? json.composio_managed_auth_schemes : [];
  } catch {
    return null;
  }
}

export interface ComposioLookup {
  query: string;
  matches: CatalogEntry[];
  chosen: CatalogEntry | null;
  managed_oauth: "yes" | "no" | "not_in_composio" | "unknown";
  api_managed_schemes: string[] | null;
  toolkit: ToolkitFacts | null;
  credential_guide: { url: string; title: string } | null;
  directory_url: string;
  /** Pages read, so quotes from them can be verified. */
  pages: { url: string; text: string }[];
}

export async function composioLookup(query: string, slugHint?: string): Promise<ComposioLookup> {
  const { entries, text, url } = await loadManagedAuthCatalog();
  const matches = slugHint
    ? entries.filter((e) => e.slug === slugHint.toLowerCase())
    : matchCatalog(query, entries);
  const chosen = matches.length >= 1 ? matches[0] : null;
  const slug = chosen?.slug ?? slugHint?.toLowerCase() ?? norm(query);
  const [toolkit, guide, api] = await Promise.all([
    toolkitPageFacts(slug).catch(() => null),
    credentialGuide(slug),
    managedSchemesFromApi(slug),
  ]);
  let managed: ComposioLookup["managed_oauth"] = "unknown";
  if (chosen) managed = chosen.managed ? "yes" : "no";
  else if (!toolkit) managed = "not_in_composio";
  else if (/Composio-managed OAuth available\?\*\*\s*(No|N\/A)/i.test(toolkit.header)) managed = "no";
  else if (/Composio-managed OAuth available\?\*\*\s*Yes/i.test(toolkit.header)) managed = "yes";
  if (api && api.some((s) => /oauth/i.test(s))) managed = "yes";

  const pages = [{ url, text }];
  if (toolkit) pages.push({ url: `https://docs.composio.dev/toolkits/${slug}`, text: `${toolkit.header}\n\n${toolkit.faq}` });
  return {
    query,
    matches,
    chosen,
    managed_oauth: managed,
    api_managed_schemes: api,
    toolkit,
    credential_guide: guide,
    directory_url: url.replace(/\.md$/, ""),
    pages,
  };
}
