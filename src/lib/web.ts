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
  if (v6.startsWith("::ffff:")) return isPrivateIp(v6.slice(7));
  return v6 === "::1" || v6 === "::" || v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("fe80");
}

export async function assertPublicUrl(raw: string): Promise<URL> {
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
  const addrs = net.isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
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

/** GET with manual, re-validated redirects and a hard timeout. */
export async function safeGet(
  raw: string,
  opts: { follow?: boolean; timeoutMs?: number; maxBytes?: number } = {},
): Promise<RawResponse> {
  const follow = opts.follow ?? true;
  const timeoutMs = opts.timeoutMs ?? 12_000;
  const maxBytes = opts.maxBytes ?? 3_000_000;
  const redirects: string[] = [];
  let current = raw;
  for (let hop = 0; hop < 5; hop++) {
    const url = await assertPublicUrl(current);
    const res = await fetch(url, {
      redirect: "manual",
      headers: { "user-agent": UA, "accept-language": "en-US,en;q=0.9", accept: "text/html,text/markdown,text/plain,application/json;q=0.9,*/*;q=0.5" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const location = res.headers.get("location");
    if (follow && res.status >= 300 && res.status < 400 && location) {
      redirects.push(current);
      current = new URL(location, url).toString();
      continue;
    }
    const buf = await res.arrayBuffer();
    const body = new TextDecoder("utf-8", { fatal: false }).decode(buf.slice(0, maxBytes));
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
}

export async function fetchPageText(raw: string): Promise<FetchedPage> {
  const res = await safeGet(raw);
  if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
  const ct = res.contentType.toLowerCase();
  if (ct.includes("html")) {
    const { title, text } = htmlToText(res.body);
    return { url: res.url, title, text, status: res.status };
  }
  if (ct.includes("json") || ct.includes("text") || ct.includes("markdown") || ct === "") {
    return { url: res.url, title: null, text: res.body, status: res.status };
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
