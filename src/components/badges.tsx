import type { GuideRecord } from "@/lib/schema";

const DIFF_STYLE: Record<string, string> = {
  easy: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  medium: "bg-amber-50 text-amber-800 ring-amber-200",
  hard: "bg-rose-50 text-rose-700 ring-rose-200",
  unknown: "bg-stone-100 text-stone-600 ring-stone-200",
};

const cap = (s: string) => s.split("–").map((x) => x[0].toUpperCase() + x.slice(1)).join(" → ");

/** `level` may be a single level or a range like "easy–hard" (coloured by the hardest end). */
export function DifficultyBadge({ level }: { level: string }) {
  const hardest = level.split("–").at(-1) ?? "unknown";
  return (
    <span className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${DIFF_STYLE[hardest] ?? DIFF_STYLE.unknown}`}>
      {level === "unknown" ? "Unknown" : cap(level)}
    </span>
  );
}

export function ManagedBadge({ managed }: { managed: string }) {
  const map: Record<string, [string, string]> = {
    yes: ["Composio managed app available", "bg-violet-50 text-violet-700 ring-violet-200"],
    no: ["Bring your own app", "bg-stone-900 text-white ring-stone-900"],
    not_in_composio: ["Not in Composio yet", "bg-stone-100 text-stone-700 ring-stone-300"],
    unknown: ["Composio status unknown", "bg-stone-100 text-stone-600 ring-stone-200"],
  };
  const [label, style] = map[managed] ?? map.unknown;
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${style}`}>{label}</span>;
}

export function OriginBadge({ record }: { record: GuideRecord }) {
  const { origin, reviewed } = record.meta;
  if (reviewed) return <span className="rounded-full bg-emerald-600 px-2 py-0.5 text-xs font-medium text-white">Human-reviewed</span>;
  if (origin === "seed") return <span className="rounded-full bg-sky-50 px-2 py-0.5 text-xs font-medium text-sky-700 ring-1 ring-inset ring-sky-200">Seed guide · review pending</span>;
  return <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800 ring-1 ring-inset ring-amber-200">Agent-generated · not human-reviewed</span>;
}

const ORDER = ["easy", "medium", "hard"];
export function difficultyRange(r: GuideRecord): string {
  const levels = r.guide.scenarios.map((s) => s.difficulty).filter((d) => d !== "unknown");
  if (!levels.length) return "unknown";
  const idx = levels.map((l) => ORDER.indexOf(l));
  const lo = ORDER[Math.min(...idx)];
  const hi = ORDER[Math.max(...idx)];
  return lo === hi ? lo : `${lo}–${hi}`;
}
