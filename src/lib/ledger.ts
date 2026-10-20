import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";

export const LedgerEntry = z.object({
  id: z.string(),
  app: z.string(),
  claim: z.string().describe("What was originally believed / generated"),
  origin: z.enum(["plan_v0.1", "seed_agent", "live_agent", "composio_docs"]),
  check: z.string().describe("How it was checked"),
  outcome: z.enum(["confirmed", "corrected", "unverifiable", "pending"]),
  finding: z.string().describe("What we found / the corrected statement"),
  evidence_url: z.string().nullable(),
});

export const Ledger = z.object({
  updated: z.string(),
  note: z.string(),
  entries: z.array(LedgerEntry),
  hands_on: z.array(
    z.object({
      provider: z.string(),
      status: z.enum(["pending", "done"]),
      what: z.string(),
      result: z.string().nullable(),
    }),
  ),
});

export type LedgerT = z.infer<typeof Ledger>;

export async function loadLedger(): Promise<LedgerT | null> {
  try {
    const raw = await fs.readFile(path.join(process.cwd(), "data", "verification.json"), "utf8");
    const parsed = Ledger.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
