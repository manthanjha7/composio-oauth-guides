import { lookup } from "node:dns/promises";
import net from "node:net";

/**
 * Outbound HTTP for the agent. The agent chooses URLs, so every request is
 * checked: http(s) only, default ports only, and no private / loopback /
 * link-local / metadata addresses (re-checked on every redirect hop).
 */

const UA = "oauth-guides-research-agent/0.1 (+https://github.com/manthanjha7)";

function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224
    );
  }
  const v6 = ip.toLowerCase();
  // IPv4-mapped (::ffff:a.b.c.d, which URL() normalises to ::ffff:7f00:1): classify the embedded IPv4.
  const mapped = v6.match(/^(?:0{0,4}:){0,5}:?ffff:(.+)$/);
  if (mapped) {
    const tail = mapped[1];
    if (net.isIPv4(tail)) return isPrivateIp(tail);
    const hex = tail.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (!hex) return true;
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return isPrivateIp(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  // Other forms that embed IPv4 (IPv4-compatible ::a.b.c.d, NAT64 64:ff9b::/96, 6to4 2002::/16) are refused outright.
  if (v6.startsWith("::") || v6.startsWith("64:ff9b:") || v6.startsWith("2002:")) return true;
  return v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("fe8") || v6.startsWith("fe9") || v6.startsWith("fea") || v6.startsWith("feb") || v6.startsWith("ff");
}

/** Resolve a promise or reject when `ms` runs out (DNS lookups have no timeout of their own). */
function within<T>(p: Promise<T>, ms: number, what: string, signal?: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const stop = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new Error(`${what} timed out`)), Math.max(1, ms));
    if (signal) {
      onAbort = () => rej(new Error(`${what} cancelled`));
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
  return Promise.race([p, stop]).finally(() => {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  });
}

export async function assertPublicUrl(raw: string, timeoutMs = 5_000, signal?: AbortSignal): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Not a valid URL: ${raw}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Only http(s) URLs are allowed");
  if (url.port && url.port !== "80" && url.port !== "443") throw new Error("Non-standard ports are not allowed");
  if (url.username || url.password) throw new Error("Credentials in URLs are not allowed");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) throw new Error("Private host");
  const addrs = net.isIP(host) ? [{ address: host }] : await within(lookup(host, { all: true }), timeoutMs, "DNS lookup", signal);
  if (addrs.length === 0 || addrs.some((a) => isPrivateIp(a.address))) throw new Error("Private or unresolvable address");
  return url;
}

export interface RawResponse {
  url: string;
  status: number;
  location: string | null;
  contentType: string;
  body: string;
  redirects: string[];
}

/**
 * GET with manual, re-validated redirects. One deadline covers the whole request: DNS, every redirect hop and
 * the body. An optional signal cancels it (e.g. the client disconnected).
 */
export async function safeGet(
  raw: string,
  opts: { follow?: boolean; timeoutMs?: number; maxBytes?: number; signal?: AbortSignal } = {},
): Promise<RawResponse> {
  const follow = opts.follow ?? true;
  const deadline = Date.now() + (opts.timeoutMs ?? 12_000);
  const maxBytes = opts.maxBytes ?? 3_000_000;
  const redirects: string[] = [];
  let current = raw;
  const left = () => {
    const ms = deadline - Date.now();
    if (ms <= 0) throw new Error("Request timed out");
    return ms;
  };
  for (let hop = 0; hop < 5; hop++) {
    opts.signal?.throwIfAborted();
    const url = await assertPublicUrl(current, left(), opts.signal);
    const timeout = AbortSignal.timeout(left());
    const res = await fetch(url, {
      redirect: "manual",
      headers: { "user-agent": UA, "accept-language": "en-US,en;q=0.9", accept: "text/html,text/markdown,text/plain,application/json;q=0.9,*/*;q=0.5" },
      signal: opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout,
    });
    const location = res.headers.get("location");
    if (follow && res.status >= 300 && res.status < 400 && location) {
      redirects.push(current);
      current = new URL(location, url).toString();
      continue;
    }
    const body = await readCapped(res, maxBytes);
    return {
      url: url.toString(),
      status: res.status,
      location: location ? new URL(location, url).toString() : null,
      contentType: res.headers.get("content-type") ?? "",
      body,
      redirects,
    };
  }
  throw new Error("Too many redirects");
}

/** Read at most `maxBytes` of the (decoded) body, then cancel the stream instead of buffering everything. */
export async function readCapped(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < maxBytes) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
  }
  if (size >= maxBytes) await reader.cancel().catch(() => {});
  const all = new Uint8Array(Math.min(size, maxBytes));
  let off = 0;
  for (const c of chunks) {
    const take = Math.min(c.byteLength, all.length - off);
    all.set(c.subarray(0, take), off);
    off += take;
    if (off >= all.length) break;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(all);
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", hellip: "…" };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Rough but dependable HTML -> readable text. Keeps headings and list structure as line breaks. */
export function htmlToText(html: string): { title: string | null; text: string } {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? null;
  let s = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template|iframe)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(nav|footer|header)[^>]*>[\s\S]*?<\/\1>/gi, " ");
  const main = s.match(/<(main|article)[^>]*>([\s\S]*)<\/\1>/i);
  if (main && main[2].length > 2000) s = main[2];
  s = s
    .replace(/<(br|hr)\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<\/(p|div|section|h[1-6]|li|tr|table|ul|ol|pre|blockquote|dd|dt)>/gi, "\n")
    .replace(/<h([1-6])[^>]*>/gi, (_m, n) => "\n" + "#".repeat(Number(n)) + " ")
    .replace(/<\/t[dh]>/gi, " | ")
    .replace(/<[^>]+>/g, " ");
  s = decodeEntities(s)
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { title: title ? decodeEntities(title) : null, text: s };
}

export interface FetchedPage {
  url: string;
  title: string | null;
  text: string;
  status: number;
  /** Outbound links, used to decide which domains an official page vouches for. */
  links?: string[];
}

/** Markdown/MDX source: drop JSX/HTML tags but keep their text ("<Link href=..>Client Credentials</Link>" -> "Client Credentials"). */
export function cleanMarkdown(md: string): string {
  return md
    .replace(/^---[\s\S]*?---\s*/, "")
    .replace(/^(?:import|export)\s[^\n]*;\s*$/gm, "") // one-line MDX imports/exports
    .replace(/^export\s+(?:const|function)\s[^\n]*(?:\{|\(|=>)\s*$[\s\S]*?^\};?\s*$/gm, "") // multi-line component definitions
    .replace(/<[A-Za-z][^>]*?\b(?:caption|alt|title)="([^"]+)"[^>]*>/g, "\n$1\n") // keep figure captions
    .replace(/<\/?[A-Za-z][^>]*>/g, "");
}

// Docs sites built on MDX (Mintlify and similar) server-render pages with empty slots where
// client components such as <Link> go ("applications using <!-- --> or"), silently dropping words.
// They also publish the source at URL + ".md", which keeps every word.
const looksClientRendered = (html: string) => html.includes("mdx-content") || /<!-- -->\s*(or|and|,)/.test(html);

/** Absolute http(s) links found in HTML anchors or Markdown links, resolved against the page URL. */
export function extractLinks(body: string, base: string, max = 400): string[] {
  const out = new Set<string>();
  const add = (href: string) => {
    try {
      const u = new URL(decodeEntities(href.trim()), base);
      if (u.protocol === "http:" || u.protocol === "https:") out.add(u.toString().split("#")[0]);
    } catch {
      /* not a URL */
    }
  };
  for (const m of body.matchAll(/<a\b[^>]*?href\s*=\s*["']([^"'#][^"']*)["']/gi)) {
    add(m[1]);
    if (out.size >= max) break;
  }
  for (const m of body.matchAll(/\]\((https?:\/\/[^)\s]+|\/[^)\s]*)\)/g)) {
    add(m[1]);
    if (out.size >= max) break;
  }
  return [...out];
}

export async function fetchPageText(raw: string, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<FetchedPage> {
  const deadline = Date.now() + (opts.timeoutMs ?? 12_000);
  const res = await safeGet(raw, { timeoutMs: opts.timeoutMs ?? 12_000, signal: opts.signal });
  if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
  const ct = res.contentType.toLowerCase();
  if (ct.includes("html")) {
    const { title, text } = htmlToText(res.body);
    if (looksClientRendered(res.body)) {
      const mdUrl = `${res.url.split(/[?#]/)[0].replace(/\/$/, "")}.md`;
      try {
        const md = await safeGet(mdUrl, { timeoutMs: Math.min(8_000, deadline - Date.now()), signal: opts.signal });
        const mct = md.contentType.toLowerCase();
        if (md.status === 200 && (mct.includes("markdown") || mct.includes("text/plain")) && md.body.length > 200) {
          return { url: res.url, title, text: cleanMarkdown(md.body), status: res.status, links: extractLinks(res.body, res.url) };
        }
      } catch {
        /* fall back to the HTML text */
      }
    }
    return { url: res.url, title, text, status: res.status, links: extractLinks(res.body, res.url) };
  }
  if (ct.includes("markdown") || /\.mdx?(\?|$)/.test(res.url)) {
    return { url: res.url, title: null, text: cleanMarkdown(res.body), status: res.status, links: extractLinks(res.body, res.url) };
  }
  if (ct.includes("json") || ct.includes("text") || ct === "") {
    return { url: res.url, title: null, text: res.body, status: res.status, links: ct.includes("json") ? [] : extractLinks(res.body, res.url) };
  }
  throw new Error(`Unsupported content type: ${ct}`);
}

export interface ProbeResult {
  url: string;
  status: number | null;
  location: string | null;
  observation: string;
}

/**
 * Probe a live endpoint without following redirects and record what came back:
 * e.g. an OAuth authorize URL with a dummy client_id (does the provider say
 * "invalid client", redirect to a login page, or 404?), or whether a
 * developer-console / review page is publicly reachable.
 */
export async function probe(raw: string): Promise<ProbeResult> {
  try {
    const res = await safeGet(raw, { follow: false, timeoutMs: 10_000, maxBytes: 400_000 });
    let observation = "";
    if (res.location) {
      observation += `Redirects to ${res.location}. `;
      const decoded = decodeAuthError(res.location);
      if (decoded) observation += `Decoded error in redirect: "${decoded}". `;
    }
    const ct = res.contentType.toLowerCase();
    const text = ct.includes("html") ? htmlToText(res.body) : { title: null, text: res.body };
    if (text.title) observation += `Page title: "${text.title}". `;
    const snippet = text.text.replace(/\s+/g, " ").slice(0, 600);
    if (snippet) observation += `Body starts: "${snippet}"`;
    return { url: res.url, status: res.status, location: res.location, observation: observation.trim() || "Empty response" };
  } catch (e) {
    return { url: raw, status: null, location: null, observation: `Request failed: ${(e as Error).message}` };
  }
}

/** Some providers (e.g. Google) put a base64 protobuf error in the redirect; pull out the readable text. */
export function decodeAuthError(location: string): string | null {
  try {
    const v = new URL(location).searchParams.get("authError");
    if (!v) return null;
    const bytes = Buffer.from(v.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("latin1");
    const text = bytes.replace(/[^\x20-\x7e]+/g, " ").replace(/\s+/g, " ").trim();
    return text.length >= 6 ? text : null;
  } catch {
    return null;
  }
}

/** Trim long pages for the model while keeping the parts most likely to matter. */
export function trimForModel(text: string, max = 14_000): string {
  if (text.length <= max) return text;
  const keywords = /(oauth|scope|review|verif|approv|publish|distribut|marketplace|redirect|client id|client secret|partner|security|assessment|limit|test user|install|app directory|listing|sensitive|restricted|days|weeks)/i;
  const paras = text.split(/\n{1,2}/);
  const head = text.slice(0, Math.floor(max * 0.35));
  const picked: string[] = [];
  let size = head.length;
  for (const p of paras) {
    if (size > max) break;
    if (keywords.test(p) && !head.includes(p)) {
      picked.push(p);
      size += p.length + 1;
    }
  }
  return `${head}\n\n[... trimmed: showing paragraphs that mention OAuth, scopes, review, limits ...]\n\n${picked.join("\n")}`.slice(0, max + 500);
}
