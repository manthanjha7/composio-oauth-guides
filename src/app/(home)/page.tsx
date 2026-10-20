import { difficultyRange, hardestScenario } from "@/components/badges";
import { GenerateBox } from "@/components/GenerateBox";
import { Library, type CardData } from "@/components/Library";
import { liveStatus } from "@/lib/live-status";
import { listGuides } from "@/lib/store";

// Lists change whenever the agent saves a new guide.
export const dynamic = "force-dynamic";

export default async function Home() {
  const guides = await listGuides();
  const cards: CardData[] = guides
    .sort((a, b) => (a.meta.origin === b.meta.origin ? b.meta.generated_at.localeCompare(a.meta.generated_at) : a.meta.origin === "seed" ? -1 : 1))
    .map((r) => ({
      slug: r.slug,
      name: r.guide.app.name.replace(/\s*\(.*\)\s*$/, "") || r.guide.app.name,
      summary: r.guide.summary,
      managed: r.guide.composio.managed_oauth,
      origin: r.meta.origin,
      reviewed: r.meta.reviewed,
      range: difficultyRange(r),
      scenarios: r.guide.scenarios.length,
      claims: r.guide.claims.length,
      verified: `${r.meta.verification.quotes_verified}/${r.meta.verification.quotes_checked}`,
      worstWait: hardestScenario(r)?.waiting.estimate ?? "Unknown",
      hardestLabel: hardestScenario(r)?.label ?? "",
      hardestLevel: hardestScenario(r)?.difficulty ?? "unknown",
      levels: r.guide.scenarios.map((s) => s.difficulty),
      date: r.meta.generated_at.slice(0, 10),
    }));

  return (
    <div className="space-y-14">
      <section className="space-y-6 pt-4">
        <p className="font-mono text-xs uppercase tracking-[0.2em] text-accent">OAuth app setup, before you commit to a launch date</p>
        <h1 className="max-w-3xl text-4xl font-semibold leading-[1.1] tracking-tight sm:text-5xl">
          Will your OAuth app take an hour, or six weeks and a security audit?
        </h1>
        <p className="max-w-3xl text-lg leading-relaxed text-muted">
          Your agent&apos;s users connect Gmail, Slack or Shopify through an OAuth app. Composio&apos;s managed apps get you started; production or a
          bring-your-own app means creating one and getting it approved. Each guide tells you <span className="text-ink">if you need your own app</span>,{" "}
          <span className="text-ink">how hard it is for your scenario</span>, <span className="text-ink">your time vs. time waiting on the provider</span>,{" "}
          <span className="text-ink">what blocks approval</span>, and <span className="text-ink">which steps an agent can do for you</span>. Every claim shows its
          evidence.
        </p>
        <div className="max-w-3xl">
          <GenerateBox status={liveStatus()} />
        </div>
      </section>
      <Library cards={cards} />
    </div>
  );
}
