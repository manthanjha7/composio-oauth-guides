import { Explorer, type CardData, type PathSummary } from "@/components/Explorer";
import { liveStatus } from "@/lib/live-status";
import type { GuideRecord } from "@/lib/schema";
import { listGuides } from "@/lib/store";

// Lists change whenever the agent saves a new guide.
export const dynamic = "force-dynamic";

const RANK = { easy: 0, medium: 1, hard: 2, unknown: -1 } as const;
const shortName = (r: GuideRecord) => r.guide.app.name.replace(/\s*\(.*\)\s*$/, "") || r.guide.app.name;

function paths(r: GuideRecord): { easiest: PathSummary | null; hardest: PathSummary | null } {
  const known = r.guide.scenarios.filter((s) => s.difficulty !== "unknown");
  const list = known.length ? known : r.guide.scenarios;
  if (!list.length) return { easiest: null, hardest: null };
  const toPath = (s: (typeof list)[number]): PathSummary => ({ label: s.label, difficulty: s.difficulty, wait: s.waiting.estimate });
  const easiest = list.reduce((a, b) => (RANK[b.difficulty] < RANK[a.difficulty] ? b : a));
  // Hardest = highest difficulty; ties broken by the longest documented wait, then by order.
  const hardest = list.reduce((a, b) => {
    if (RANK[b.difficulty] !== RANK[a.difficulty]) return RANK[b.difficulty] > RANK[a.difficulty] ? b : a;
    return (b.waiting.max_days ?? -1) >= (a.waiting.max_days ?? -1) ? b : a;
  });
  return { easiest: toPath(easiest), hardest: toPath(hardest) };
}

export default async function Home() {
  const guides = await listGuides();
  const names = guides.map(shortName);
  const cards: CardData[] = guides
    .sort((a, b) => (a.meta.origin === b.meta.origin ? shortName(a).localeCompare(shortName(b)) : a.meta.origin === "seed" ? -1 : 1))
    .map((r) => ({
      slug: r.slug,
      name: shortName(r),
      summary: r.guide.summary,
      managed: r.guide.composio.managed_oauth,
      origin: r.meta.origin,
      levels: r.guide.scenarios.map((s) => s.difficulty),
      ...paths(r),
      verified: `${r.meta.verification.quotes_verified}/${r.meta.verification.quotes_checked}`,
      duplicateName: r.meta.origin === "live" && names.filter((n) => n === shortName(r)).length > 1,
    }));

  return (
    <div className="space-y-12">
      <section className="space-y-4 pt-2">
        <h1 className="max-w-3xl text-4xl font-semibold leading-[1.1] tracking-tight sm:text-5xl">
          Will your OAuth app take an hour, or six weeks and a security audit?
        </h1>
        <p className="max-w-2xl text-lg leading-relaxed text-muted">
          For each app: whether you need your own OAuth app, how hard approval is for your setup, how long it takes, and what an agent can do for you.
        </p>
      </section>
      <Explorer cards={cards} status={liveStatus()} replay="asana" />
    </div>
  );
}
