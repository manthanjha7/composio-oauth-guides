import { LABEL_INFO } from "@/lib/evidence";
import { stripCites } from "@/lib/guide-view";
import type { ClaimT } from "@/lib/schema";

/** Short scenario name for inline references like "s3". */
export const shortLabel = (label: string) => (label.length > 34 ? `${label.slice(0, 32).trimEnd()}…` : label);

/** Guide prose without inline citations, with scenario ids ("s3") replaced by their names. */
export function plain(text: string, scenarios: Map<string, string>): { text: string; ids: string[] } {
  const named = text.replace(/\b(s\d+)\b/g, (m) => (scenarios.has(m) ? `“${shortLabel(scenarios.get(m)!)}”` : m));
  return stripCites(named);
}

/**
 * A quiet "Sources" disclosure for one block of prose: the evidence stays one click away instead of
 * interrupting every sentence. Shows label icons with counts; opens to the claims with their quotes.
 */
export function Sources({ ids, claims }: { ids: string[]; claims: Map<string, ClaimT> }) {
  const list = [...new Set(ids)].map((id) => claims.get(id)).filter((c): c is ClaimT => !!c);
  if (!list.length) return null;
  const icons = [...new Set(list.map((c) => LABEL_INFO[c.label].icon))].join("");
  return (
    <details className="group mt-2 text-xs">
      <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 rounded-md px-1.5 py-0.5 text-faint ring-1 ring-inset ring-line transition hover:text-ink hover:ring-line-strong [&::-webkit-details-marker]:hidden">
        <span aria-hidden>{icons}</span>
        {list.length} {list.length === 1 ? "source" : "sources"}
        <span aria-hidden className="transition group-open:rotate-90">›</span>
      </summary>
      <ul className="mt-2 space-y-2 border-l border-line pl-3">
        {list.map((c) => (
          <li key={c.id}>
            <span className="text-muted">
              {LABEL_INFO[c.label].icon} <span className="text-ink/90">{c.text}</span>
            </span>
            {c.quote && <span className="mt-1 block font-mono text-[11px] leading-relaxed text-faint">“{c.quote.length > 240 ? `${c.quote.slice(0, 238)}…` : c.quote}”</span>}
            {c.source_url && (
              <a href={c.source_url} target="_blank" rel="noreferrer" className="mt-0.5 block break-all font-mono text-[11px] text-accent hover:underline">
                {c.source_url.replace(/^https?:\/\//, "")} ↗
              </a>
            )}
            {c.note && <span className="mt-0.5 block italic text-amber-200/80">{c.note}</span>}
          </li>
        ))}
      </ul>
    </details>
  );
}
