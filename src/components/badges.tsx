import type { GuideRecord } from "@/lib/schema";

export type Tone = "neutral" | "accent" | "good" | "warn" | "bad" | "info" | "solid";

const TONE: Record<Tone, string> = {
  neutral: "bg-surface-3 text-muted ring-line-strong",
  accent: "bg-violet-500/10 text-violet-300 ring-violet-400/30",
  good: "bg-emerald-500/10 text-emerald-300 ring-emerald-400/30",
  warn: "bg-amber-500/10 text-amber-300 ring-amber-400/30",
  bad: "bg-rose-500/10 text-rose-300 ring-rose-400/30",
  info: "bg-sky-500/10 text-sky-300 ring-sky-400/30",
  solid: "bg-ink text-bg ring-ink",
};

export function Badge({ tone = "neutral", children, className = "" }: { tone?: Tone; children: React.ReactNode; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${TONE[tone]} ${className}`}>
      {children}
    </span>
  );
}

const DIFF_TONE: Record<string, Tone> = { easy: "good", medium: "warn", hard: "bad", unknown: "neutral" };
const cap = (s: string) => s.split("–").map((x) => x[0].toUpperCase() + x.slice(1)).join(" → ");

/** `level` may be one level or a range like "easy–hard" (coloured by the hardest end). */
export function DifficultyBadge({ level }: { level: string }) {
  const hardest = level.split("–").at(-1) ?? "unknown";
  return (
    <Badge tone={DIFF_TONE[hardest] ?? "neutral"}>
      <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current" />
      {level === "unknown" ? "Unknown" : cap(level)}
    </Badge>
  );
}

export function ManagedBadge({ managed }: { managed: string }) {
  if (managed === "yes") return <Badge tone="accent">Composio-managed app</Badge>;
  if (managed === "no") return <Badge tone="solid">Bring your own app</Badge>;
  if (managed === "not_in_composio") return <Badge>Not in Composio</Badge>;
  return <Badge>Composio: unknown</Badge>;
}

export function ReviewBadge({ record }: { record: GuideRecord }) {
  return record.meta.reviewed ? <Badge tone="good">Human-reviewed</Badge> : <Badge tone="warn">Not human-reviewed</Badge>;
}

const DOT: Record<string, string> = { easy: "bg-emerald-400", medium: "bg-amber-400", hard: "bg-rose-400", unknown: "bg-faint" };

/** One dot per scenario, coloured by difficulty: shows the spread at a glance (most apps are easy to prototype, hard to ship). */
export function ScenarioDots({ levels }: { levels: string[] }) {
  const n = (l: string) => levels.filter((x) => x === l).length;
  const label = `${levels.length} scenarios: ${["easy", "medium", "hard", "unknown"].filter((l) => n(l)).map((l) => `${n(l)} ${l}`).join(", ")}`;
  return (
    <span role="img" aria-label={label} title={label} className="inline-flex items-center gap-1 rounded-full bg-surface-3 px-2 py-1 ring-1 ring-inset ring-line-strong">
      {levels.map((l, i) => (
        <span key={i} className={`h-2 w-2 rounded-full ${DOT[l] ?? DOT.unknown}`} />
      ))}
    </span>
  );
}
