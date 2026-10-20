import { promises as fs } from "node:fs";
import path from "node:path";
import { get, list, put } from "@vercel/blob";
import { GuideRecordSchema, type GuideRecord } from "./schema";

/**
 * Two kinds of guides:
 *  - seed guides: JSON files in ./data/guides, committed (meta.reviewed says whether a human has checked them)
 *  - live guides: written by the agent at request time; stored in Vercel Blob when
 *    BLOB_READ_WRITE_TOKEN is set, otherwise on local disk (fine for `next dev`,
 *    ephemeral on serverless - the README says so).
 */

const SEED_DIR = path.join(process.cwd(), "data", "guides");
const LOCAL_DIR = process.env.LOCAL_GUIDE_DIR || path.join(process.cwd(), ".data", "generated");
const blobEnabled = () => !!process.env.BLOB_READ_WRITE_TOKEN;
const blobPath = (slug: string) => `guides/${slug}.json`;

export function storageMode(): "blob" | "local" | "unavailable" {
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
  if (blobEnabled()) {
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
