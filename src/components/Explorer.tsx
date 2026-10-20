"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import type { LiveStatus } from "@/lib/live-status";
import { DifficultyBadge, ManagedBadge, ScenarioDots } from "./badges";

export interface PathSummary {
  label: string;
  difficulty: string;
  wait: string;
}

export interface CardData {
  slug: string;
  name: string;
  summary: string;
  managed: string;
  origin: "seed" | "live";
  levels: string[];
  easiest: PathSummary | null;
  hardest: PathSummary | null;
  verified: string;
  duplicateName: boolean;
}

const FILTERS = [
  { id: "all", label: "All" },
  { id: "managed", label: "Composio-managed" },
  { id: "byo", label: "Bring your own" },
  { id: "hard", label: "Has a hard path" },
] as const;

export function Explorer({ cards, status, replay }: { cards: CardData[]; status: LiveStatus; replay: string }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["id"]>("all");
  const term = q.trim().toLowerCase();

  const shown = useMemo(
    () =>
      cards.filter((c) => {
        if (term && !`${c.name} ${c.slug}`.toLowerCase().includes(term)) return false;
        if (filter === "managed") return c.managed === "yes";
        if (filter === "byo") return c.managed !== "yes";
        if (filter === "hard") return c.levels.includes("hard");
        return true;
      }),
    [cards, term, filter],
  );

  const submit = () => {
    if (term.length < 2) return;
    const exact = cards.find((c) => c.origin === "seed" && (c.name.toLowerCase() === term || c.slug === term)) ?? cards.find((c) => c.name.toLowerCase() === term);
    if (exact) router.push(`/guides/${exact.slug}`);
    else if (status.available) router.push(`/generate?q=${encodeURIComponent(q.trim())}`);
  };

  const library = shown.filter((c) => c.origin === "seed");
  const generated = shown.filter((c) => c.origin === "live");

  return (
    <div className="space-y-10">
      <div className="max-w-3xl space-y-3">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
          className="flex flex-col gap-2 rounded-2xl border border-line bg-surface p-2 sm:flex-row"
        >
          <label htmlFor="app-query" className="sr-only">
            App name or website
          </label>
          <input
            id="app-query"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search or add an app, e.g. Gmail or asana.com"
            aria-describedby="search-hint"
            className="w-full rounded-xl bg-surface-2 px-4 py-3 text-base text-ink placeholder:text-faint outline-none focus:ring-2 focus:ring-accent/60"
          />
          <button
            type="submit"
            disabled={term.length < 2 || (!status.available && !cards.some((c) => c.name.toLowerCase() === term))}
            className="whitespace-nowrap rounded-xl bg-accent-strong px-5 py-3 font-medium text-white transition hover:bg-violet-600 disabled:cursor-not-allowed disabled:bg-surface-3 disabled:text-faint"
          >
            Get guide
          </button>
        </form>
        <p id="search-hint" className="text-sm text-muted">
          {status.available ? (
            "Not listed? The agent researches it in about 2 minutes."
          ) : (
            <>
              {status.reason}{" "}
              <Link href={`/generate?replay=${replay}`} className="text-accent hover:underline">
                Watch a recorded run →
              </Link>
            </>
          )}
        </p>
      </div>

      <div role="group" aria-label="Filter guides" className="scrollbar-none -mx-1 flex gap-1.5 overflow-x-auto px-1">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            onClick={() => setFilter(f.id)}
            aria-pressed={filter === f.id}
            className={`whitespace-nowrap rounded-full px-3 py-1.5 text-sm ring-1 ring-inset transition ${
              filter === f.id ? "bg-ink text-bg ring-ink" : "text-muted ring-line-strong hover:text-ink"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {term && shown.length === 0 && (
        <div className="rounded-xl border border-dashed border-line-strong p-6 text-center">
          <p className="font-medium">No guide for &ldquo;{q.trim()}&rdquo; yet.</p>
          {status.available ? (
            <button onClick={submit} className="mt-3 rounded-lg bg-accent-strong px-4 py-2 text-sm font-medium text-white hover:bg-violet-600">
              Generate it (about 2 min)
            </button>
          ) : (
            <p className="mt-2 text-sm text-muted">
              {status.reason}{" "}
              <Link href={`/generate?replay=${replay}`} className="text-accent hover:underline">
                Watch a recorded run →
              </Link>
            </p>
          )}
        </div>
      )}

      {library.length > 0 && <Group title="Library" subtitle="Researched ahead of time." cards={library} />}
      {generated.length > 0 && <Group title="Generated" subtitle="Created by the agent on request." cards={generated} />}
    </div>
  );
}

function Group({ title, subtitle, cards }: { title: string; subtitle: string; cards: CardData[] }) {
  return (
    <section aria-labelledby={`h-${title}`}>
      <h2 id={`h-${title}`} className="text-lg font-semibold tracking-tight">
        {title} <span className="ml-1 font-mono text-sm font-normal text-faint">{cards.length}</span>
      </h2>
      <p className="mb-4 text-sm text-muted">{subtitle}</p>
      <div className="grid gap-3 md:grid-cols-2">
        {cards.map((c) => (
          <GuideCard key={c.slug} c={c} />
        ))}
      </div>
    </section>
  );
}

function GuideCard({ c }: { c: CardData }) {
  const generated = c.origin === "live";
  return (
    <Link
      href={`/guides/${c.slug}`}
      className={`group flex flex-col rounded-xl border bg-surface p-5 transition hover:border-accent/50 hover:bg-surface-2 ${
        generated ? "border-dashed border-line-strong" : "border-line"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <h3 className="truncate text-base font-semibold group-hover:text-accent">
          {c.name}
          {c.duplicateName && <span className="ml-2 text-xs font-normal text-faint">agent run</span>}
        </h3>
        <ScenarioDots levels={c.levels} />
      </div>
      <dl className="mt-3 space-y-2 text-sm">
        {c.easiest && <Path title="Easiest" p={c.easiest} />}
        {c.hardest && c.hardest.label !== c.easiest?.label && <Path title="Hardest" p={c.hardest} />}
      </dl>
      <div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1.5 pt-4 text-xs">
        <ManagedBadge managed={c.managed} />
        <span className="font-mono text-faint">{c.verified} quotes verified</span>
      </div>
    </Link>
  );
}

function Path({ title, p }: { title: string; p: PathSummary }) {
  return (
    <div className="grid grid-cols-[64px_1fr] gap-x-3">
      <dt className="pt-0.5 text-xs text-faint">{title}</dt>
      <dd className="min-w-0">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <DifficultyBadge level={p.difficulty} />
          <span className="text-ink/90">{p.label}</span>
        </span>
        <span className="mt-0.5 block text-xs text-muted">Wait: {p.wait}</span>
      </dd>
    </div>
  );
}
