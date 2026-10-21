"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Badge, DifficultyBadge, ManagedBadge, ReviewBadge } from "@/components/badges";
import { LABEL_INFO } from "@/lib/evidence";
import { appliesTo, CHECK_INFO, defaultScenario, PATH_INFO, pathLabel, verdictOf } from "@/lib/guide-view";
import type { ClaimT, GuideRecord } from "@/lib/schema";
import { plain, Sources } from "./claims";

const OWNER = {
  agent: { icon: "🤖", label: "Agent can do" },
  you: { icon: "👤", label: "You" },
  waiting: { icon: "⏳", label: "Waiting on provider" },
} as const;

const LABEL_TONE: Record<ClaimT["label"], "good" | "info" | "accent" | "warn" | "neutral"> = {
  tested: "good",
  probed: "info",
  provider_docs: "info",
  composio_docs: "accent",
  reported: "warn",
  unknown: "neutral",
};

/** How many traps show before "Show more". */
const TOP_TRAPS = 3;

export function GuideView({ record, initialScenario, libraryTwin }: { record: GuideRecord; initialScenario: string | null; libraryTwin: string | null }) {
  const g = record.guide;
  const [scenarioId, setScenarioId] = useState(initialScenario && g.scenarios.some((s) => s.id === initialScenario) ? initialScenario : defaultScenario(g));
  const [copyState, setCopyState] = useState<"idle" | "ok" | "fail">("idle");
  const [labelFilter, setLabelFilter] = useState<ClaimT["label"] | "all">("all");

  const claims = useMemo(() => new Map(g.claims.map((c) => [c.id, c])), [g.claims]);
  const scenarioNames = useMemo(() => new Map(g.scenarios.map((s) => [s.id, s.label])), [g.scenarios]);
  const P = (text: string) => plain(text, scenarioNames);

  const scenario = g.scenarios.find((s) => s.id === scenarioId);
  const steps = g.steps.filter((s) => appliesTo(s.scenario_ids, scenarioId));
  const prereqs = g.prerequisites.filter((p) => appliesTo(p.scenario_ids, scenarioId));
  const traps = g.traps.filter((t) => appliesTo(t.scenario_ids, scenarioId));
  const blockers = g.blockers.filter((b) => appliesTo(b.scenario_ids, scenarioId));
  const owners = steps.reduce<Record<string, number>>((a, s) => ({ ...a, [s.owner]: (a[s.owner] ?? 0) + 1 }), {});
  const counts = g.claims.reduce<Partial<Record<ClaimT["label"], number>>>((a, c) => ({ ...a, [c.label]: (a[c.label] ?? 0) + 1 }), {});
  const labels = (Object.keys(LABEL_INFO) as ClaimT["label"][]).filter((k) => counts[k]);
  const shownClaims = labelFilter === "all" ? g.claims : g.claims.filter((c) => c.label === labelFilter);
  const name = g.app.name.replace(/\s*\(.*\)\s*$/, "") || g.app.name;
  const v = record.meta.verification;
  const need = P(g.need_own_app.answer);
  const approval = scenario ? P(scenario.approval) : null;

  const sections = [
    { id: "setup", label: "Your setup" },
    { id: "steps", label: "Steps" },
    { id: "ready", label: "Have ready", show: prereqs.length > 0 },
    { id: "watch", label: "Watch out", show: traps.length > 0 },
    { id: "stuck", label: "Stuck?", show: blockers.length > 0 },
    { id: "evidence", label: "Sources" },
  ].filter((s) => s.show !== false);

  const pickScenario = (id: string) => {
    setScenarioId(id);
    const url = new URL(window.location.href);
    url.searchParams.set("s", id);
    url.hash = "";
    history.replaceState(null, "", url.toString());
  };

  const copy = async () => {
    const url = new URL(window.location.href);
    url.hash = "";
    url.searchParams.set("s", scenarioId);
    let ok = false;
    try {
      await navigator.clipboard.writeText(url.toString());
      ok = true;
    } catch {
      // Clipboard API refused (permissions, insecure context): fall back to a selected textarea.
      const ta = document.createElement("textarea");
      ta.value = url.toString();
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        ok = document.execCommand("copy");
      } catch {
        ok = false;
      }
      ta.remove();
    }
    setCopyState(ok ? "ok" : "fail");
    setTimeout(() => setCopyState("idle"), 2500);
  };

  const action = "text-muted underline decoration-line-strong underline-offset-4 transition hover:text-ink";

  return (
    <div className="grid gap-10 pb-16 lg:grid-cols-[minmax(0,1fr)_180px] lg:pb-0">
      <article className="min-w-0 max-w-3xl space-y-12">
        <header className="space-y-4">
          <div className="flex flex-wrap gap-1.5">
            <ManagedBadge managed={g.composio.managed_oauth} />
            <ReviewBadge record={record} />
            {record.meta.partial && <Badge tone="bad">Incomplete: research timed out</Badge>}
          </div>
          <div>
            <p className="font-mono text-xs uppercase tracking-[0.2em] text-faint">OAuth app setup</p>
            <h1 className="mt-1 text-3xl font-semibold leading-tight tracking-tight sm:text-4xl">{name}</h1>
          </div>
          <p className="text-lg leading-relaxed text-ink/90">{P(verdictOf(g)).text}</p>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
            <button onClick={copy} className={action}>
              <span aria-live="polite">{copyState === "ok" ? "✓ Link copied" : copyState === "fail" ? "Couldn't copy: use the address bar" : "Copy link"}</span>
            </button>
            <a href={`/guides/${record.slug}/md?s=${scenarioId}`} className={action}>
              Markdown
            </a>
            {g.composio.credential_guide_url && (
              <a href={g.composio.credential_guide_url} target="_blank" rel="noreferrer" className={action}>
                Composio guide ↗
              </a>
            )}
            {g.app.developer_docs_url && (
              <a href={g.app.developer_docs_url} target="_blank" rel="noreferrer" className={action}>
                {name} docs ↗
              </a>
            )}
          </div>
          {libraryTwin && (
            <p className="text-sm text-muted">
              Generated by the agent. A more thorough{" "}
              <Link href={`/guides/${libraryTwin}`} className="text-accent hover:underline">
                library guide for {name}
              </Link>{" "}
              exists.
            </p>
          )}
        </header>

        {(record.meta.warnings ?? []).length > 0 && (
          <div role="note" className="rounded-xl border border-amber-400/30 bg-amber-500/10 p-4 text-sm text-amber-200">
            <ul className="list-disc space-y-0.5 pl-5">
              {record.meta.warnings!.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </div>
        )}

        <section aria-labelledby="need" className="rounded-xl border border-line bg-surface px-5 py-4 text-sm">
          <h2 id="need" className="font-medium text-ink">
            Do you need your own OAuth app?
          </h2>
          <p className="mt-1 leading-relaxed text-muted">{need.text}</p>
          {g.need_own_app.reasons.length > 0 && (
            <details className="group mt-2">
              <summary className="cursor-pointer list-none text-xs text-faint hover:text-ink [&::-webkit-details-marker]:hidden">
                Why <span className="inline-block transition group-open:rotate-90">›</span>
              </summary>
              <ul className="mt-2 space-y-1 text-muted">
                {g.need_own_app.reasons.map((r) => (
                  <li key={r}>· {P(r).text}</li>
                ))}
              </ul>
            </details>
          )}
          <Sources ids={[...need.ids, ...g.need_own_app.reasons.flatMap((r) => P(r).ids)]} claims={claims} />
        </section>

        <section id="setup" className="scroll-mt-24">
          <SectionTitle title="What are you building?" sub="Pick the closest match. Everything below follows it." />
          <div role="group" aria-label="Setups" className="grid gap-2 sm:grid-cols-2">
            {g.scenarios.map((s) => {
              const on = s.id === scenarioId;
              return (
                <button
                  key={s.id}
                  onClick={() => pickScenario(s.id)}
                  aria-pressed={on}
                  className={`rounded-xl px-4 py-3 text-left text-sm ring-1 ring-inset transition ${
                    on ? "bg-violet-500/[0.12] ring-accent/60" : "bg-surface ring-line hover:bg-surface-2"
                  }`}
                >
                  <span className="flex items-start justify-between gap-3">
                    <span className="font-medium text-ink">{s.label}</span>
                    <DifficultyBadge level={s.difficulty} />
                  </span>
                  <span className="mt-1.5 block text-xs text-muted">
                    You: {s.hands_on.estimate} · Wait: {s.waiting.estimate}
                  </span>
                </button>
              );
            })}
          </div>

          {scenario && (
            <div aria-live="polite" className="mt-4 space-y-4 rounded-2xl border border-accent/25 bg-gradient-to-b from-violet-500/[0.07] to-transparent p-5">
              <dl className="grid grid-cols-3 gap-3">
                <Stat title="Difficulty">
                  <DifficultyBadge level={scenario.difficulty} />
                </Stat>
                <Stat title="Your time">{scenario.hands_on.estimate}</Stat>
                <Stat title="Provider wait">{scenario.waiting.estimate}</Stat>
              </dl>

              {scenario.path && (
                <p className="text-sm">
                  <span className="font-medium text-ink">{pathLabel(scenario)}:</span>{" "}
                  <span className="text-muted">{PATH_INFO[scenario.path].meaning}.</span>
                </p>
              )}
              {!!scenario.review_checks?.length && (
                <div className="flex flex-wrap items-center gap-1.5 text-xs">
                  <span className="text-faint">The review checks:</span>
                  {scenario.review_checks.map((c) => (
                    <span key={c} className="rounded-full bg-surface-3 px-2 py-0.5 text-ink/90 ring-1 ring-inset ring-line-strong">
                      {CHECK_INFO[c]}
                    </span>
                  ))}
                </div>
              )}

              {approval && (
                <div className="text-sm leading-relaxed text-ink/90">
                  {approval.text}
                  <Sources ids={[...approval.ids, ...scenario.claim_ids]} claims={claims} />
                </div>
              )}

              {scenario.shortcut && (
                <p className="rounded-lg bg-emerald-500/10 px-3 py-2 text-sm text-emerald-200 ring-1 ring-inset ring-emerald-400/25">
                  <span className="font-medium">Shortcut:</span> {P(scenario.shortcut).text}
                </p>
              )}

              {!!scenario.extras?.length && (
                <ul className="flex flex-wrap gap-1.5 text-xs">
                  {scenario.extras.map((x) => (
                    <li key={x} className="rounded-full px-2 py-0.5 text-amber-200/90 ring-1 ring-inset ring-amber-400/30">
                      {P(x).text}
                    </li>
                  ))}
                </ul>
              )}

              <details className="group text-sm">
                <summary className="cursor-pointer list-none text-xs text-faint hover:text-ink [&::-webkit-details-marker]:hidden">
                  When this applies, and why these times <span className="inline-block transition group-open:rotate-90">›</span>
                </summary>
                <div className="mt-2 space-y-1.5 text-muted">
                  <p>{P(scenario.when_this_applies).text}</p>
                  <p>Your time: {P(scenario.hands_on.basis).text}</p>
                  <p>Provider wait: {P(scenario.waiting.basis).text}</p>
                </div>
              </details>
            </div>
          )}
        </section>

        <section id="steps" className="scroll-mt-24">
          <SectionTitle
            title="Steps"
            right={
              <span className="font-mono text-xs text-muted">
                {owners.agent ?? 0} 🤖 agent · {owners.you ?? 0} 👤 you · {owners.waiting ?? 0} ⏳ wait
              </span>
            }
          />
          <ol className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
            {steps.map((s, i) => {
              const d = P(s.detail);
              return (
                <li key={`${s.title}-${i}`}>
                  <details className="group">
                    <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3 text-sm transition hover:bg-surface-2 [&::-webkit-details-marker]:hidden">
                      <span className="w-5 shrink-0 text-right font-mono text-xs text-faint">{i + 1}</span>
                      <span aria-label={OWNER[s.owner].label} title={OWNER[s.owner].label} className="shrink-0">
                        {OWNER[s.owner].icon}
                      </span>
                      <span className="min-w-0 flex-1 text-ink">{P(s.title).text}</span>
                      <span aria-hidden className="text-faint transition group-open:rotate-90">
                        ›
                      </span>
                    </summary>
                    <div className="space-y-2 px-4 pb-4 pl-[3.25rem] text-sm text-muted">
                      <p className="leading-relaxed">{d.text}</p>
                      {s.inputs.length > 0 && <p>You need: {s.inputs.map((x) => P(x).text).join(" · ")}</p>}
                      <p>Done when: {P(s.done_when).text}</p>
                      {s.link && (
                        <a href={s.link} target="_blank" rel="noreferrer" className="inline-block break-all font-mono text-xs text-accent hover:underline">
                          {s.link.replace(/^https?:\/\//, "")} ↗
                        </a>
                      )}
                      <Sources ids={[...d.ids, ...s.claim_ids]} claims={claims} />
                    </div>
                  </details>
                </li>
              );
            })}
          </ol>
        </section>

        {prereqs.length > 0 && (
          <section id="ready" className="scroll-mt-24">
            <SectionTitle title="Have these ready" />
            <ul className="space-y-1.5 text-sm">
              {prereqs.map((p) => (
                <li key={p.title} className="flex gap-2">
                  <span aria-hidden className="text-faint">
                    ☐
                  </span>
                  <span>
                    <span className="text-ink">{P(p.title).text}.</span> <span className="text-muted">{P(p.detail).text}</span>
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {traps.length > 0 && (
          <section id="watch" className="scroll-mt-24">
            <SectionTitle title="Watch out" />
            <ul className="space-y-2">
              {traps.slice(0, TOP_TRAPS).map((t) => (
                <Trap key={t.title} t={t} P={P} claims={claims} />
              ))}
            </ul>
            {traps.length > TOP_TRAPS && (
              <details className="group mt-2">
                <summary className="cursor-pointer list-none text-sm text-muted hover:text-ink [&::-webkit-details-marker]:hidden">
                  Show {traps.length - TOP_TRAPS} more <span className="inline-block transition group-open:rotate-90">›</span>
                </summary>
                <ul className="mt-2 space-y-2">
                  {traps.slice(TOP_TRAPS).map((t) => (
                    <Trap key={t.title} t={t} P={P} claims={claims} />
                  ))}
                </ul>
              </details>
            )}
          </section>
        )}

        {blockers.length > 0 && (
          <section id="stuck" className="scroll-mt-24">
            <SectionTitle title="Stuck?" sub="Find what you see." />
            <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
              {blockers.map((b) => {
                const m = P(b.what_it_means);
                const d = P(b.what_to_do);
                return (
                  <li key={b.symptom}>
                    <details className="group">
                      <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3 text-sm transition hover:bg-surface-2 [&::-webkit-details-marker]:hidden">
                        <span className="min-w-0 flex-1 text-ink">{P(b.symptom).text}</span>
                        <span aria-hidden className="text-faint transition group-open:rotate-90">
                          ›
                        </span>
                      </summary>
                      <div className="space-y-1.5 px-4 pb-4 text-sm">
                        <p className="text-muted">{m.text}</p>
                        <p className="text-ink/90">→ {d.text}</p>
                        {b.agent_can_help && <p className="text-muted">🤖 {P(b.agent_can_help).text}</p>}
                        <Sources ids={[...m.ids, ...d.ids, ...b.claim_ids]} claims={claims} />
                      </div>
                    </details>
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        <section id="evidence" className="scroll-mt-24">
          <details className="group rounded-xl border border-line bg-surface">
            <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-2 px-5 py-4 [&::-webkit-details-marker]:hidden">
              <span>
                <span className="font-semibold">Sources and evidence</span>
                <span className="ml-2 font-mono text-xs text-faint">
                  {g.claims.length} claims · {v.quotes_verified}/{v.quotes_checked} quotes verified
                  {counts.unknown ? ` · ${counts.unknown} unconfirmed` : ""}
                </span>
              </span>
              <span aria-hidden className="text-faint transition group-open:rotate-90">
                ›
              </span>
            </summary>
            <div className="space-y-6 border-t border-line px-5 py-5 text-sm">
              <p className="text-muted">
                {labels.map((k) => `${LABEL_INFO[k].icon} ${LABEL_INFO[k].name}`).join(" · ")}. Every docs quote was matched word for word on its source page.{" "}
                {record.meta.origin === "seed" ? "Library guide." : "Generated by the agent on request."}{" "}
                {counts.tested ? `${counts.tested} claims confirmed in a recorded setup.` : "Not hands-on tested yet."}{" "}
                <Link href="/verification" className="text-accent hover:underline">
                  Verification log
                </Link>
              </p>
              {record.meta.review_note && <p className="text-muted">{record.meta.review_note}</p>}

              {g.open_questions.length > 0 && (
                <div>
                  <h3 className="mb-1.5 font-medium">Still unconfirmed</h3>
                  <ul className="space-y-1 text-muted">
                    {g.open_questions.map((q) => (
                      <li key={q}>❓ {P(q).text}</li>
                    ))}
                  </ul>
                </div>
              )}

              <div>
                <div role="group" aria-label="Filter evidence" className="scrollbar-none -mx-1 mb-3 flex gap-1.5 overflow-x-auto px-1">
                  <FilterChip active={labelFilter === "all"} onClick={() => setLabelFilter("all")}>
                    All <span className="font-mono text-faint">{g.claims.length}</span>
                  </FilterChip>
                  {labels.map((k) => (
                    <FilterChip key={k} active={labelFilter === k} onClick={() => setLabelFilter(k)} title={LABEL_INFO[k].meaning}>
                      {LABEL_INFO[k].icon} {LABEL_INFO[k].name} <span className="font-mono text-faint">{counts[k]}</span>
                    </FilterChip>
                  ))}
                </div>
                <ul className="space-y-2">
                  {shownClaims.map((c) => (
                    <li key={c.id} id={`claim-${c.id}`} className="rounded-lg border border-line p-3">
                      <div className="flex flex-wrap items-baseline gap-2">
                        <span className="font-mono text-xs text-faint">{c.id}</span>
                        <Badge tone={LABEL_TONE[c.label]}>
                          {LABEL_INFO[c.label].icon} {LABEL_INFO[c.label].name}
                        </Badge>
                      </div>
                      <p className="mt-1.5 leading-relaxed text-ink/90">{c.text}</p>
                      {c.quote && <blockquote className="mt-1.5 border-l-2 border-accent/50 pl-3 font-mono text-xs leading-relaxed text-muted">“{c.quote}”</blockquote>}
                      {c.source_url && (
                        <a href={c.source_url} target="_blank" rel="noreferrer" className="mt-1.5 block break-all font-mono text-xs text-accent hover:underline">
                          {c.source_url} ↗
                        </a>
                      )}
                      {c.probe_id && <p className="mt-1 font-mono text-xs text-faint">Endpoint check {c.probe_id}, below</p>}
                      {c.note && <p className="mt-1.5 text-xs italic text-amber-200/80">{c.note}</p>}
                    </li>
                  ))}
                </ul>
              </div>

              {record.meta.probes.length > 0 && (
                <div>
                  <h3 className="mb-1.5 font-medium">Endpoint checks</h3>
                  <ul className="space-y-2">
                    {record.meta.probes.map((p) => (
                      <li key={p.id} className="rounded-lg border border-sky-400/20 bg-sky-500/[0.05] p-3 text-xs">
                        <p className="text-muted">
                          <span className="font-mono text-ink">{p.id}</span> · {p.purpose}
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
                <details>
                  <summary className="cursor-pointer text-muted hover:text-ink">{record.meta.sources.length} pages read</summary>
                  <ul className="mt-2 space-y-1 text-xs">
                    {record.meta.sources.map((s, i) => (
                      <li key={`${s.url}-${i}`} className="break-all">
                        <a className="text-accent hover:underline" href={s.url} target="_blank" rel="noreferrer">
                          {s.title || s.url}
                        </a>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          </details>
        </section>
      </article>

      <aside className="hidden lg:block">
        <nav aria-label="On this page" className="sticky top-24 space-y-1 text-sm">
          <p className="mb-2 font-mono text-[11px] uppercase tracking-wider text-faint">On this page</p>
          {sections.map((s) => (
            <a key={s.id} href={`#${s.id}`} className="block rounded-md px-2 py-1 text-muted transition hover:bg-surface-2 hover:text-ink">
              {s.label}
            </a>
          ))}
        </nav>
      </aside>

      <nav aria-label="Jump to" className="fixed inset-x-0 bottom-0 z-30 flex justify-around border-t border-line bg-bg/95 py-2 text-sm backdrop-blur lg:hidden">
        {sections
          .filter((s) => ["setup", "steps", "stuck", "evidence"].includes(s.id))
          .map((s) => (
            <a key={s.id} href={`#${s.id}`} className="rounded-md px-3 py-1.5 text-muted hover:text-ink">
              {s.label}
            </a>
          ))}
      </nav>
    </div>
  );
}

type Plain = (text: string) => { text: string; ids: string[] };

function Trap({ t, P, claims }: { t: GuideRecord["guide"]["traps"][number]; P: Plain; claims: Map<string, ClaimT> }) {
  const d = P(t.detail);
  return (
    <li className="rounded-xl border border-amber-400/20 bg-amber-500/[0.06] px-4 py-3 text-sm">
      <p className="font-medium text-amber-200">{P(t.title).text}</p>
      <p className="mt-1 leading-relaxed text-muted">{d.text}</p>
      <Sources ids={[...d.ids, ...t.claim_ids]} claims={claims} />
    </li>
  );
}

function SectionTitle({ title, sub, right }: { title: string; sub?: string; right?: React.ReactNode }) {
  return (
    <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
        {sub && <p className="mt-1 text-sm text-muted">{sub}</p>}
      </div>
      {right}
    </div>
  );
}

function Stat({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="font-mono text-[11px] uppercase tracking-wider text-faint">{title}</dt>
      <dd className="mt-1 text-sm leading-snug text-ink">{children}</dd>
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
