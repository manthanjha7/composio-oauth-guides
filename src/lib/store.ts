import { promises as fs } from "node:fs";
import path from "node:path";
import { neon } from "@neondatabase/serverless";
import { get, list, put } from "@vercel/blob";
import { GuideRecordSchema, type GuideRecord } from "./schema";

/**
 * Two kinds of guides:
 *  - seed guides: JSON files in ./data/guides, committed (meta.reviewed says whether a human has checked them)
 *  - live guides: written by the agent at request time; stored in Upstash Redis (KV_REST_API_*),
 *    Postgres (DATABASE_URL, e.g. Neon) or Vercel Blob (BLOB_READ_WRITE_TOKEN) when configured,
 *    otherwise on local disk (local dev only).
 */

const SEED_DIR = path.join(process.cwd(), "data", "guides");
const LOCAL_DIR = process.env.LOCAL_GUIDE_DIR || path.join(process.cwd(), ".data", "generated");
const blobEnabled = () => !!process.env.BLOB_READ_WRITE_TOKEN;
const blobPath = (slug: string) => `guides/${slug}.json`;

// Upstash Redis over REST (Vercel marketplace), used when Blob isn't available. Either env-var naming works.
const redisUrl = () => process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const redisToken = () => process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const redisEnabled = () => !!(redisUrl() && redisToken());
const INDEX_KEY = "oauth-guides:index";
const redisKey = (slug: string) => `oauth-guides:guide:${slug}`;

async function redis<T = unknown>(command: (string | number)[]): Promise<T> {
  const res = await fetch(redisUrl()!, {
    method: "POST",
    headers: { authorization: `Bearer ${redisToken()}`, "content-type": "application/json" },
    body: JSON.stringify(command),
    cache: "no-store",
  });
  const json = (await res.json()) as { result?: T; error?: string };
  if (!res.ok || json.error) throw new Error(`Redis ${command[0]} failed: ${json.error ?? res.status}`);
  return json.result as T;
}

// Postgres (Neon over HTTP). One table, created on first use.
const pgUrl = () => process.env.DATABASE_URL || process.env.POSTGRES_URL;
const pgEnabled = () => !!pgUrl();
let pgReady: Promise<unknown> | null = null;
function pg() {
  const sql = neon(pgUrl()!);
  pgReady ??= sql`CREATE TABLE IF NOT EXISTS oauth_guides (slug text PRIMARY KEY, body jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())`;
  return { sql, ready: pgReady };
}

function parseRecord(text: string | null): GuideRecord | null {
  if (!text) return null;
  const parsed = GuideRecordSchema.safeParse(JSON.parse(text));
  return parsed.success ? parsed.data : null;
}

export function storageMode(): "redis" | "postgres" | "blob" | "local" | "unavailable" {
  if (redisEnabled()) return "redis";
  if (pgEnabled()) return "postgres";
  if (blobEnabled()) return "blob";
  // Deployed serverless filesystems are read-only (and ephemeral), so live guides need Blob there.
  return process.env.VERCEL ? "unavailable" : "local";
}

async function readJsonDir(dir: string): Promise<GuideRecord[]> {
  let files: string[] = [];
  try {
    files = (await fs.readdir(dir)).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out: GuideRecord[] = [];
  for (const f of files) {
    try {
      const parsed = GuideRecordSchema.safeParse(JSON.parse(await fs.readFile(path.join(dir, f), "utf8")));
      if (parsed.success) out.push(parsed.data);
      else console.error(`Invalid guide file ${f}:`, parsed.error.issues.slice(0, 3));
    } catch (e) {
      console.error(`Unreadable guide file ${f}:`, e);
    }
  }
  return out;
}

export async function listSeedGuides(): Promise<GuideRecord[]> {
  return readJsonDir(SEED_DIR);
}

async function readBlob(pathname: string): Promise<GuideRecord | null> {
  const res = await get(pathname, { access: "private", useCache: false });
  if (!res || !res.stream) return null;
  const text = await new Response(res.stream).text();
  const parsed = GuideRecordSchema.safeParse(JSON.parse(text));
  return parsed.success ? parsed.data : null;
}

export async function listLiveGuides(): Promise<GuideRecord[]> {
  if (redisEnabled()) {
    const slugs = await redis<string[]>(["SMEMBERS", INDEX_KEY]);
    if (!slugs.length) return [];
    const texts = await redis<(string | null)[]>(["MGET", ...slugs.map(redisKey)]);
    return texts.map(parseRecord).filter((r): r is GuideRecord => r !== null);
  }
  if (pgEnabled()) {
    const { sql, ready } = pg();
    await ready;
    const rows = (await sql`SELECT body FROM oauth_guides ORDER BY updated_at DESC LIMIT 200`) as { body: unknown }[];
    return rows.map((r) => GuideRecordSchema.safeParse(r.body)).flatMap((p) => (p.success ? [p.data] : []));
  }
  if (!blobEnabled()) return readJsonDir(LOCAL_DIR);
  const { blobs } = await list({ prefix: "guides/", limit: 200 });
  const records = await Promise.all(blobs.map((b) => readBlob(b.pathname).catch(() => null)));
  return records.filter((r): r is GuideRecord => r !== null);
}

export async function listGuides(): Promise<GuideRecord[]> {
  const [seeds, live] = await Promise.all([listSeedGuides(), listLiveGuides().catch(() => [])]);
  const seedSlugs = new Set(seeds.map((s) => s.slug));
  return [...seeds, ...live.filter((l) => !seedSlugs.has(l.slug))];
}

export async function getGuide(slug: string): Promise<GuideRecord | null> {
  if (!/^[a-z0-9-]{1,60}$/.test(slug)) return null;
  const seeds = await listSeedGuides();
  const seed = seeds.find((s) => s.slug === slug);
  if (seed) return seed;
  if (redisEnabled()) return redis<string | null>(["GET", redisKey(slug)]).then(parseRecord).catch(() => null);
  if (pgEnabled()) {
    try {
      const { sql, ready } = pg();
      await ready;
      const rows = (await sql`SELECT body FROM oauth_guides WHERE slug = ${slug}`) as { body: unknown }[];
      const parsed = rows[0] ? GuideRecordSchema.safeParse(rows[0].body) : null;
      return parsed?.success ? parsed.data : null;
    } catch {
      return null;
    }
  }
  if (blobEnabled()) return readBlob(blobPath(slug)).catch(() => null);
  try {
    const parsed = GuideRecordSchema.safeParse(JSON.parse(await fs.readFile(path.join(LOCAL_DIR, `${slug}.json`), "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Saves and then reads back, so a share link is only shown for a guide that can actually be loaded. */
export async function saveGuide(record: GuideRecord): Promise<void> {
  const body = JSON.stringify(record, null, 2);
  if (redisEnabled()) {
    await redis(["SET", redisKey(record.slug), body]);
    await redis(["SADD", INDEX_KEY, record.slug]);
  } else if (pgEnabled()) {
    const { sql, ready } = pg();
    await ready;
    await sql`INSERT INTO oauth_guides (slug, body, updated_at) VALUES (${record.slug}, ${body}::jsonb, now())
      ON CONFLICT (slug) DO UPDATE SET body = EXCLUDED.body, updated_at = now()`;
  } else if (blobEnabled()) {
    await put(blobPath(record.slug), body, {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: "application/json",
    });
  } else {
    await fs.mkdir(LOCAL_DIR, { recursive: true });
    await fs.writeFile(path.join(LOCAL_DIR, `${record.slug}.json`), body);
  }
  const back = await getGuide(record.slug);
  if (!back) throw new Error("Guide was saved but could not be read back");
}
