import { runAgentV2 } from "@/lib/agent/pipeline";
import { runAgent, type AgentEvent } from "@/lib/agent/run";
import { slugify } from "@/lib/slug";
import { liveStatus } from "@/lib/live-status";
import { getGuide, listSeedGuides, saveGuide } from "@/lib/store";

// The agent needs ~1-3 minutes; the research loop stops itself at ~150s and writes from what it has.
export const maxDuration = 300;

// Public endpoint that spends API credits: cap runs per IP (per server instance) and per day.
const perIp = new Map<string, number[]>();
let day = new Date().toISOString().slice(0, 10);
let todayCount = 0;
const PER_IP_PER_HOUR = Number(process.env.GENERATE_PER_IP_PER_HOUR || 6);
const DAILY_CAP = Number(process.env.GENERATE_DAILY_CAP || 60);

function allow(ip: string): string | null {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== day) {
    day = today;
    todayCount = 0;
  }
  if (todayCount >= DAILY_CAP) return "Daily generation limit reached for this demo. Try a guide from the library.";
  const now = Date.now();
  const recent = (perIp.get(ip) ?? []).filter((t) => now - t < 3600_000);
  if (recent.length >= PER_IP_PER_HOUR) return "You've generated several guides in the last hour. Please wait a bit.";
  recent.push(now);
  perIp.set(ip, recent);
  todayCount++;
  return null;
}

export async function POST(req: Request) {
  let query = "";
  let fresh = false;
  try {
    const body = (await req.json()) as { query?: string; fresh?: boolean };
    query = String(body.query ?? "").trim().slice(0, 120);
    fresh = !!body.fresh;
  } catch {
    /* handled below */
  }
  if (query.length < 2) return Response.json({ error: "Type an app name or website." }, { status: 400 });

  // Library hit: no need to spend a run.
  const existing = !fresh ? await getGuide(slugify(query)) : null;
  if (existing) return Response.json({ existing: existing.slug });

  const status = liveStatus();
  if (!status.available) return Response.json({ error: status.reason }, { status: 503 });

  const ip = (req.headers.get("x-forwarded-for") ?? "local").split(",")[0].trim();
  const blocked = allow(ip);
  if (blocked) return Response.json({ error: blocked }, { status: 429 });

  const seedSlugs = new Set((await listSeedGuides()).map((g) => g.slug));
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const send = (e: AgentEvent | { type: "existing"; slug: string }) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
        } catch {
          closed = true;
        }
      };
      const heartbeat = setInterval(() => {
        if (!closed) {
          try {
            controller.enqueue(encoder.encode(": keep-alive\n\n"));
          } catch {
            closed = true;
          }
        }
      }, 15_000);
      try {
        // v2 runs only when switched on; v1 stays the default until v2 passes a live evaluation.
        const run = process.env.AGENT_VERSION === "v2" ? runAgentV2 : runAgent;
        const result = await run({ query, emit: send, signal: req.signal });
        if (result.outcome === "ok") {
          // Never overwrite a reviewed seed guide: a fresh agent run on a seed app is saved alongside it, for comparison.
          if (seedSlugs.has(result.record.slug)) result.record.slug = `${result.record.slug}-agent`;
          send({ type: "stage", stage: "save", message: "Saving the guide" });
          await saveGuide(result.record);
          send({ type: "done", slug: result.record.slug, partial: result.record.meta.partial });
        }
      } catch (e) {
        send({ type: "error", message: (e as Error).message || "Unexpected error" });
      } finally {
        clearInterval(heartbeat);
        closed = true;
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
}
