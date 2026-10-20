"use client";

import Link from "next/link";
import { useCallback, useMemo, useState } from "react";
import { Badge, DifficultyBadge, ManagedBadge, OriginBadge } from "@/components/badges";
import { LABEL_INFO } from "@/lib/evidence";
import type { ClaimT, GuideRecord } from "@/lib/schema";

const OWNER = {
  agent: { icon: "🤖", label: "Agent can do this", tone: "accent" },
  you: { icon: "👤", label: "You", tone: "neutral" },
  waiting: { icon: "⏳", label: "Waiting on provider", tone: "warn" },
} as const;

const LABEL_TONE: Record<ClaimT["label"], "good" | "info" | "accent" | "warn" | "neutral"> = {
  tested: "good",
  probed: "info",
  provider_docs: "info",
  composio_docs: "accent",
  reported: "warn",
  unknown: "neutral",
};

const SECTIONS = [
  { id: "need-own-app", label: "Do you need your own app?" },
  { id: "scenario", label: "Your scenario" },
  { id: "before", label: "Before you start" },
  { id: "steps", label: "Steps" },
  { id: "traps", label: "Traps" },
  { id: "stuck", label: "Stuck?" },
  { id: "uncertain", label: "Still uncertain" },
  { id: "evidence", label: "Evidence" },
];

type Jump = (id: string) => void;

export function GuideView({ record }: { record: GuideRecord }) {
  const g = record.guide;
  const [scenarioId, setScenarioId] = useState(g.scenarios[0]?.id ?? "");
  const [copied, setCopied] = useState(false);
  const [flash, setFlash] = useState<{ id: string; n: number } | null>(null);
  const [labelFilter, setLabelFilter] = useState<ClaimT["label"] | "all">("all");
  const claims = useMemo(() => new Map(g.claims.map((c) => [c.id, c])), [g.claims]);
  const scenario = g.scenarios.find((s) => s.id === scenarioId);
  const steps = g.steps.filter((s) => s.scenario_ids.length === 0 || s.scenario_ids.includes(scenarioId));
  const owners = steps.reduce<Record<string, number>>((a, s) => ({ ...a, [s.owner]: (a[s.owner] ?? 0) + 1 }), {});
  const counts = g.claims.reduce<Partial<Record<ClaimT["label"], number>>>((a, c) => ({ ...a, [c.label]: (a[c.label] ?? 0) + 1 }), {});
  const shownClaims = labelFilter === "all" ? g.claims : g.claims.filter((c) => c.label === labelFilter);
  const name = g.app.name.replace(/\s*\(.*\)\s*$/, "") || g.app.name;
  const present = SECTIONS.filter((s) => {
    if (s.id === "before") return g.prerequisites.length > 0;
    if (s.id === "traps") return g.traps.length > 0;
    if (s.id === "stuck") return g.blockers.length > 0;
    if (s.id === "uncertain") return g.open_questions.length > 0;
    return true;
  });

  const jump: Jump = useCallback((id) => {
    setLabelFilter("all");
    setFlash((f) => ({ id, n: (f?.n ?? 0) + 1 }));
    requestAnimationFrame(() => {
      const el = document.getElementById(`claim-${id}`);
      const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      el?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "center" });
      history.replaceState(null, "", `#claim-${id}`);
    });
  }, []);

  const copy = async () => {
    await navigator.clipboard.writeText(window.location.href.split("#")[0]);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  return (
    <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_220px]">
      <article className="min-w-0 space-y-12">
        {/* Header */}
        <header className="space-y-5">
          <div className="flex flex-wrap gap-1.5">
            <ManagedBadge managed={g.composio.managed_oauth} />
            <OriginBadge record={record} />
            {record.meta.partial && <Badge tone="bad">Partial: research hit its time limit</Badge>}
          </div>
          <h1 className="text-3xl font-semibold leading-tight tracking-tight sm:text-4xl">
            {name}: getting your own OAuth app ready
          </h1>
          <p className="max-w-3xl text-lg leading-relaxed text-muted">{g.summary}</p>
          <div className="flex flex-wrap gap-2 text-sm">
            <button onClick={copy} className="rounded-lg bg-ink px-3.5 py-2 font-medium text-bg transition hover:bg-white" aria-live="polite">
              {copied ? "✓ Link copied" : "Copy share link"}
            </button>
            <a href={`/guides/${record.slug}/md`} className="rounded-lg border border-line-strong px-3.5 py-2 text-ink transition hover:bg-surface-2">
              Markdown <span className="text-muted">(for docs or your coding agent)</span>
            </a>
            {g.app.developer_docs_url && (
              <a href={g.app.developer_docs_url} target="_blank" rel="noreferrer" className="rounded-lg border border-line-strong px-3.5 py-2 text-ink transition hover:bg-surface-2">
                Provider docs ↗
              </a>
            )}
            {g.composio.credential_guide_url && (
              <a href={g.composio.credential_guide_url} target="_blank" rel="noreferrer" className="rounded-lg border border-line-strong px-3.5 py-2 text-ink transition hover:bg-surface-2">
                Composio credential walkthrough ↗
              </a>
            )}
          </div>
          <p className="font-mono text-xs leading-relaxed text-faint">
            {record.meta.origin === "live" ? "Agent-generated" : "Seed guide"} · {record.meta.generated_at.slice(0, 10)} · {g.claims.length} claims (
            {(Object.keys(LABEL_INFO) as ClaimT["label"][])
              .filter((k) => counts[k])
              .map((k) => `${LABEL_INFO[k].icon} ${counts[k]}`)
              .join(" · ")}
            ) · {record.meta.verification.quotes_verified}/{record.meta.verification.quotes_checked} doc quotes verified on the live page
            {record.meta.usage ? ` · research cost ~$${record.meta.usage.usd.toFixed(2)}` : ""}
          </p>
          {record.meta.review_note && <p className="max-w-3xl text-xs text-faint">{record.meta.review_note}</p>}
        </header>

        {(record.meta.warnings ?? []).length > 0 && (
          <div role="note" className="rounded-xl border border-amber-400/30 bg-amber-500/10 p-4 text-sm text-amber-200">
            <p className="font-medium">Automatic evidence check flagged:</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-5">
              {record.meta.warnings!.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </div>
        )}

        {/* Need own app */}
        <section id="need-own-app" className="scroll-mt-24 rounded-2xl border border-accent/25 bg-gradient-to-b from-violet-500/[0.08] to-transparent p-6">
          <h2 className="text-lg font-semibold">Do you need your own OAuth app?</h2>
          <p className="mt-2 leading-relaxed text-ink/90">{g.need_own_app.answer}</p>
          {g.need_own_app.reasons.length > 0 && (
            <ul className="mt-3 space-y-1.5 text-sm text-muted">
              {g.need_own_app.reasons.map((r) => (
                <li key={r} className="flex gap-2">
                  <span aria-hidden className="text-accent">→</span>
                  <span>{r}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-4 border-t border-line pt-3 text-sm text-muted">{g.composio.note}</p>
        </section>

        {/* Scenario */}
        <section id="scenario" className="scroll-mt-24">
          <SectionTitle title="Pick your scenario" sub="Difficulty depends on what you're building (scopes, who your users are, how you distribute), not just on the app." />
          <div role="tablist" aria-label="Scenarios" className="scrollbar-none -mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1 md:flex-wrap md:overflow-visible">
            {g.scenarios.map((s) => (
              <button
                key={s.id}
                role="tab"
                aria-selected={s.id === scenarioId}
                aria-controls="scenario-panel"
                onClick={() => setScenarioId(s.id)}
                className={`flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-left text-sm ring-1 ring-inset transition ${
                  s.id === scenarioId ? "bg-ink text-bg ring-ink" : "text-muted ring-line-strong hover:text-ink"
                }`}
              >
                <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${dot(s.difficulty)}`} />
                <span className="max-w-[16rem] truncate font-medium md:max-w-none md:whitespace-normal">{s.label}</span>
              </button>
            ))}
          </div>
          {scenario && (
            <div id="scenario-panel" role="tabpanel" className="mt-4 overflow-hidden rounded-2xl border border-line bg-surface">
              <p className="border-b border-line px-5 py-3 text-sm text-muted">
                <span className="text-ink">When this applies:</span> {scenario.when_this_applies}
              </p>
              <div className="grid divide-y divide-line md:grid-cols-[150px_1fr_1fr] md:divide-x md:divide-y-0">
                <Metric title="Difficulty">
                  <DifficultyBadge level={scenario.difficulty} />
                </Metric>
                <Metric title="Your hands-on time" basis={scenario.hands_on.basis}>
                  {scenario.hands_on.estimate}
                </Metric>
                <Metric title="Waiting on the provider" basis={scenario.waiting.basis}>
                  {scenario.waiting.estimate}
                </Metric>
              </div>
              <div className="border-t border-line px-5 py-4 text-sm">
                <p className="font-mono text-[11px] uppercase tracking-wider text-faint">Review / approval</p>
                <p className="mt-1 leading-relaxed text-ink/90">
                  {scenario.approval}
                  <Chips ids={scenario.claim_ids} claims={claims} jump={jump} />
                </p>
              </div>
            </div>
          )}
        </section>

        {/* Before you start */}
        {g.prerequisites.length > 0 && (
          <section id="before" className="scroll-mt-24">
            <SectionTitle title="Before you start" />
            <ul className="grid gap-2 md:grid-cols-2">
              {g.prerequisites.map((p) => (
                <li key={p.title} className="rounded-xl border border-line bg-surface p-4 text-sm">
                  <p className="font-medium">{p.title}</p>
                  <p className="mt-1 leading-relaxed text-muted">
                    {p.detail}
                    <Chips ids={p.claim_ids} claims={claims} jump={jump} />
                  </p>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* Steps */}
        <section id="steps" className="scroll-mt-24">
          <SectionTitle
            title="Steps for this scenario"
            right={
              <span className="font-mono text-xs text-muted">
                {owners.agent ?? 0} 🤖 agent · {owners.you ?? 0} 👤 you · {owners.waiting ?? 0} ⏳ waiting
              </span>
            }
          />
          <ol className="relative space-y-3 before:absolute before:bottom-4 before:left-[15px] before:top-4 before:w-px before:bg-line">
            {steps.map((s, i) => (
              <li key={`${s.title}-${i}`} className="relative flex gap-4">
                <span
                  aria-hidden
                  className={`z-10 mt-4 grid h-8 w-8 shrink-0 place-items-center rounded-full font-mono text-xs ring-1 ${
                    s.owner === "agent" ? "bg-violet-500/15 text-violet-200 ring-violet-400/40" : s.owner === "waiting" ? "bg-amber-500/15 text-amber-200 ring-amber-400/40" : "bg-surface-3 text-ink ring-line-strong"
                  }`}
                >
                  {i + 1}
                </span>
                <div className="min-w-0 flex-1 rounded-xl border border-line bg-surface p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="font-medium">{s.title}</h3>
                    <Badge tone={OWNER[s.owner].tone}>
                      <span aria-hidden>{OWNER[s.owner].icon}</span> {OWNER[s.owner].label}
                    </Badge>
                  </div>
                  <p className="mt-2 text-sm leading-relaxed text-muted">
                    {s.detail}
                    <Chips ids={s.claim_ids} claims={claims} jump={jump} />
                  </p>
                  <div className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
                    {s.inputs.length > 0 && (
                      <div>
                        <p className="font-mono text-[11px] uppercase tracking-wider text-faint">You need</p>
                        <ul className="mt-1 space-y-0.5 text-ink/85">
                          {s.inputs.map((x) => (
                            <li key={x} className="flex gap-1.5">
                              <span aria-hidden className="text-faint">·</span>
                              {x}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    <div>
                      <p className="font-mono text-[11px] uppercase tracking-wider text-faint">Done when</p>
                      <p className="mt-1 text-ink/85">{s.done_when}</p>
                    </div>
                  </div>
                  {s.link && (
                    <a href={s.link} target="_blank" rel="noreferrer" className="mt-3 inline-block break-all font-mono text-xs text-accent hover:underline">
                      {s.link} ↗
                    </a>
                  )}
                </div>
              </li>
            ))}
          </ol>
        </section>

        {/* Traps */}
        {g.traps.length > 0 && (
          <section id="traps" className="scroll-mt-24">
            <SectionTitle title="Traps people hit" />
            <ul className="space-y-2">
              {g.traps.map((t) => (
                <li key={t.title} className="rounded-xl border border-amber-400/20 bg-amber-500/[0.06] p-4 text-sm">
                  <p className="font-medium text-amber-200">⚠ {t.title}</p>
                  <p className="mt-1 leading-relaxed text-muted">
                    {t.detail}
                    <Chips ids={t.claim_ids} claims={claims} jump={jump} />
                  </p>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* Stuck */}
        {g.blockers.length > 0 && (
          <section id="stuck" className="scroll-mt-24">
            <SectionTitle title="Stuck?" sub="What you see, what it means, and what to do." />
            <div className="hidden overflow-hidden rounded-xl border border-line md:block">
              <table className="w-full text-left text-sm">
                <thead className="bg-surface-2 font-mono text-[11px] uppercase tracking-wider text-faint">
                  <tr>
                    <th className="p-3 font-normal">You see</th>
                    <th className="p-3 font-normal">It means</th>
                    <th className="p-3 font-normal">Do this</th>
                    <th className="p-3 font-normal">🤖 Agent can help</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line bg-surface">
                  {g.blockers.map((b) => (
                    <tr key={b.symptom} className="align-top">
                      <td className="p-3 font-medium">{b.symptom}</td>
                      <td className="p-3 text-muted">
                        {b.what_it_means}
                        <Chips ids={b.claim_ids} claims={claims} jump={jump} />
                      </td>
                      <td className="p-3 text-ink/85">{b.what_to_do}</td>
                      <td className="p-3 text-muted">{b.agent_can_help ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <ul className="space-y-2 md:hidden">
              {g.blockers.map((b) => (
                <li key={b.symptom} className="rounded-xl border border-line bg-surface p-4 text-sm">
                  <p className="font-medium">{b.symptom}</p>
                  <p className="mt-2 text-muted">
                    <span className="text-faint">It means: </span>
                    {b.what_it_means}
                    <Chips ids={b.claim_ids} claims={claims} jump={jump} />
                  </p>
                  <p className="mt-1 text-ink/85">
                    <span className="text-faint">Do this: </span>
                    {b.what_to_do}
                  </p>
                  {b.agent_can_help && (
                    <p className="mt-1 text-muted">
                      <span className="text-faint">🤖 Agent can help: </span>
                      {b.agent_can_help}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* Uncertain */}
        {g.open_questions.length > 0 && (
          <section id="uncertain" className="scroll-mt-24">
            <SectionTitle title="Still uncertain" sub="What the research could not confirm, and how you could find out." />
            <ul className="space-y-1.5 text-sm text-muted">
              {g.open_questions.map((q) => (
                <li key={q} className="flex gap-2">
                  <span aria-hidden className="text-faint">❓</span>
                  {q}
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* Evidence */}
        <section id="evidence" className="scroll-mt-24">
          <SectionTitle title="Evidence" sub="Every claim the guide relies on, with how it was established." />
          <div role="group" aria-label="Filter evidence by label" className="scrollbar-none -mx-1 mb-4 flex gap-1.5 overflow-x-auto px-1">
            <FilterChip active={labelFilter === "all"} onClick={() => setLabelFilter("all")}>
              All <span className="font-mono text-faint">{g.claims.length}</span>
            </FilterChip>
            {(Object.keys(LABEL_INFO) as ClaimT["label"][])
              .filter((k) => counts[k])
              .map((k) => (
                <FilterChip key={k} active={labelFilter === k} onClick={() => setLabelFilter(k)} title={LABEL_INFO[k].meaning}>
                  {LABEL_INFO[k].icon} {LABEL_INFO[k].name} <span className="font-mono text-faint">{counts[k]}</span>
                </FilterChip>
              ))}
          </div>
          <ul className="space-y-2">
            {shownClaims.map((c) => (
              <li
                key={flash?.id === c.id ? `${c.id}-${flash.n}` : c.id}
                id={`claim-${c.id}`}
                className={`scroll-mt-24 rounded-xl border border-line bg-surface p-4 text-sm ${flash?.id === c.id ? "claim-flash" : ""}`}
              >
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="font-mono text-xs text-faint">{c.id}</span>
                  <Badge tone={LABEL_TONE[c.label]}>
                    {LABEL_INFO[c.label].icon} {LABEL_INFO[c.label].name}
                  </Badge>
                </div>
                <p className="mt-2 leading-relaxed text-ink/90">{c.text}</p>
                {c.quote && (
                  <blockquote className="mt-2 border-l-2 border-accent/50 pl-3 font-mono text-xs leading-relaxed text-muted">“{c.quote}”</blockquote>
                )}
                {c.source_url && (
                  <a href={c.source_url} target="_blank" rel="noreferrer" className="mt-2 block break-all font-mono text-xs text-accent hover:underline">
                    {c.source_url} ↗
                  </a>
                )}
                {c.probe_id && <p className="mt-1 font-mono text-xs text-faint">Probe {c.probe_id}, see Live probes below</p>}
                {c.note && <p className="mt-2 text-xs italic text-amber-200/80">{c.note}</p>}
              </li>
            ))}
          </ul>

          {record.meta.probes.length > 0 && (
            <div className="mt-8">
              <h3 className="mb-2 font-semibold">Live probes</h3>
              <ul className="space-y-2">
                {record.meta.probes.map((p) => (
                  <li key={p.id} className="rounded-xl border border-sky-400/20 bg-sky-500/[0.05] p-4 text-xs">
                    <p className="text-muted">
                      <span className="font-mono text-ink">{p.id}</span> · {p.purpose} · {p.at.slice(0, 10)}
                    </p>
                    <p className="mt-1 break-all font-mono text-ink/90">
                      GET {p.url} <span className="text-sky-300">→ {p.status ?? "no response"}</span>
                    </p>
                    <p className="mt-1 break-words text-muted">{p.observation}</p>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {record.meta.sources.length > 0 && (
            <details className="mt-6 rounded-xl border border-line bg-surface p-4 text-sm">
              <summary className="cursor-pointer text-muted hover:text-ink">{record.meta.sources.length} pages read</summary>
              <ul className="mt-3 space-y-1 text-xs">
                {record.meta.sources.map((s, i) => (
                  <li key={`${s.url}-${i}`} className="break-all">
                    <a className="text-accent hover:underline" href={s.url} target="_blank" rel="noreferrer">
                      {s.title || s.url}
                    </a>{" "}
                    <span className="font-mono text-faint">
                      {s.via} · {s.fetched_at.slice(0, 10)}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </section>

        <p className="text-sm text-muted">
          Something wrong or out of date? Check the{" "}
          <Link className="text-accent hover:underline" href="/verification">
            verification log
          </Link>{" "}
          or re-run the agent for a fresh version.
        </p>
      </article>

      {/* On this page */}
      <aside className="hidden lg:block">
        <nav aria-label="On this page" className="sticky top-24 space-y-1 text-sm">
          <p className="mb-2 font-mono text-[11px] uppercase tracking-wider text-faint">On this page</p>
          {present.map((s) => (
            <a key={s.id} href={`#${s.id}`} className="block rounded-md px-2 py-1 text-muted transition hover:bg-surface-2 hover:text-ink">
              {s.label}
            </a>
          ))}
          <div className="mt-4 rounded-lg border border-line p-3 text-xs text-muted">
            <p className="mb-1.5 font-mono text-[11px] uppercase tracking-wider text-faint">Evidence labels</p>
            {(Object.keys(LABEL_INFO) as ClaimT["label"][]).map((k) => (
              <p key={k} title={LABEL_INFO[k].meaning}>
                {LABEL_INFO[k].icon} {LABEL_INFO[k].name}
              </p>
            ))}
          </div>
        </nav>
      </aside>
    </div>
  );
}

const dot = (d: string) => (d === "easy" ? "bg-emerald-400" : d === "medium" ? "bg-amber-400" : d === "hard" ? "bg-rose-400" : "bg-faint");

function SectionTitle({ title, sub, right }: { title: string; sub?: string; right?: React.ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-2">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
        {sub && <p className="mt-1 text-sm text-muted">{sub}</p>}
      </div>
      {right}
    </div>
  );
}

function Metric({ title, basis, children }: { title: string; basis?: string; children: React.ReactNode }) {
  const long = typeof children === "string" && children.length > 32;
  return (
    <div className="px-5 py-4">
      <p className="font-mono text-[11px] uppercase tracking-wider text-faint">{title}</p>
      <div className={`mt-1.5 font-semibold text-ink ${long ? "text-sm leading-snug" : "text-xl"}`}>{children}</div>
      {basis && <p className="mt-2 text-xs leading-relaxed text-faint">Basis: {basis}</p>}
    </div>
  );
}

function FilterChip({ active, onClick, title, children }: { active: boolean; onClick: () => void; title?: string; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-pressed={active}
      className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-1 text-xs ring-1 ring-inset transition ${
        active ? "bg-ink text-bg ring-ink" : "text-muted ring-line-strong hover:text-ink"
      }`}
    >
      {children}
    </button>
  );
}

/** Inline evidence chips: hover/focus previews the claim and quote; click jumps to it in Evidence. */
function Chips({ ids, claims, jump }: { ids: string[]; claims: Map<string, ClaimT>; jump: Jump }) {
  if (!ids.length) return null;
  return (
    <span className="ml-1.5 inline-flex flex-wrap gap-1 align-middle">
      {ids.map((id) => {
        const c = claims.get(id);
        if (!c) return null;
        const info = LABEL_INFO[c.label];
        return (
          <span key={id} className="group relative inline-block">
            <button
              type="button"
              onClick={() => jump(id)}
              aria-label={`${info.name} claim ${id}: ${c.text}. Jump to evidence.`}
              className={`rounded px-1 py-px font-mono text-[11px] ring-1 ring-inset transition hover:ring-accent ${
                c.label === "unknown" ? "bg-surface-2 text-faint ring-line" : "bg-surface-3 text-muted ring-line-strong"
              }`}
            >
              {info.icon}
              {id}
            </button>
            <span
              role="tooltip"
              className="pointer-events-none invisible absolute bottom-full left-1/2 z-50 mb-2 w-72 -translate-x-1/2 rounded-lg border border-line-strong bg-surface-3 p-3 text-left text-xs leading-relaxed opacity-0 shadow-2xl transition group-focus-within:visible group-focus-within:opacity-100 group-hover:visible group-hover:opacity-100"
            >
              <span className="block font-mono text-[10px] uppercase tracking-wider text-faint">
                {info.icon} {info.name} · {id}
              </span>
              <span className="mt-1 block text-ink">{c.text}</span>
              {c.quote && <span className="mt-1.5 block border-l-2 border-accent/50 pl-2 font-mono text-muted">“{c.quote.slice(0, 220)}{c.quote.length > 220 ? "…" : ""}”</span>}
              <span className="mt-1.5 block text-accent">Click to jump to evidence</span>
            </span>
          </span>
        );
      })}
    </span>
  );
}
