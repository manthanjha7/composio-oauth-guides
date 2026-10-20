"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge, DifficultyBadge, ManagedBadge, ReviewBadge } from "@/components/badges";
import { LABEL_INFO } from "@/lib/evidence";
import type { ClaimT, GuideRecord } from "@/lib/schema";
import { ClaimPreview, Rich, type ChipHandlers, type Jump } from "./claims";

const OWNER = {
  agent: { icon: "🤖", label: "Agent can do", tone: "accent" },
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

type PreviewState = { id: string; el: HTMLElement; pinned: boolean; tick: number } | null;

export function GuideView({ record, initialScenario, libraryTwin }: { record: GuideRecord; initialScenario: string | null; libraryTwin: string | null }) {
  const g = record.guide;
  const [scenarioId, setScenarioId] = useState(
    initialScenario && g.scenarios.some((s) => s.id === initialScenario) ? initialScenario : (g.scenarios[0]?.id ?? ""),
  );
  const [copyState, setCopyState] = useState<"idle" | "ok" | "fail">("idle");
  const [flash, setFlash] = useState<{ id: string; n: number } | null>(null);
  const [labelFilter, setLabelFilter] = useState<ClaimT["label"] | "all">("all");
  const [preview, setPreview] = useState<PreviewState>(null);
  const hideTimer = useRef<number | undefined>(undefined);

  const claims = useMemo(() => new Map(g.claims.map((c) => [c.id, c])), [g.claims]);
  const scenarioNames = useMemo(() => new Map(g.scenarios.map((s) => [s.id, s.label])), [g.scenarios]);
  const scenario = g.scenarios.find((s) => s.id === scenarioId);
  const steps = g.steps.filter((s) => s.scenario_ids.length === 0 || s.scenario_ids.includes(scenarioId));
  const owners = steps.reduce<Record<string, number>>((a, s) => ({ ...a, [s.owner]: (a[s.owner] ?? 0) + 1 }), {});
  const counts = g.claims.reduce<Partial<Record<ClaimT["label"], number>>>((a, c) => ({ ...a, [c.label]: (a[c.label] ?? 0) + 1 }), {});
  const labels = (Object.keys(LABEL_INFO) as ClaimT["label"][]).filter((k) => counts[k]);
  const shownClaims = labelFilter === "all" ? g.claims : g.claims.filter((c) => c.label === labelFilter);
  const name = g.app.name.replace(/\s*\(.*\)\s*$/, "") || g.app.name;
  const v = record.meta.verification;

  const sections = [
    { id: "setup", label: "Your setup" },
    { id: "before", label: "Before you start", show: g.prerequisites.length > 0 },
    { id: "steps", label: "Steps" },
    { id: "traps", label: "Traps", show: g.traps.length > 0 },
    { id: "stuck", label: "Stuck?", show: g.blockers.length > 0 },
    { id: "unconfirmed", label: "Unconfirmed", show: g.open_questions.length > 0 },
    { id: "evidence", label: "Evidence" },
  ].filter((s) => s.show !== false);

  const pickScenario = (id: string) => {
    setScenarioId(id);
    const url = new URL(window.location.href);
    url.searchParams.set("s", id);
    url.hash = "";
    history.replaceState(null, "", url.toString());
  };

  const jump: Jump = useCallback((id) => {
    setPreview(null);
    setLabelFilter("all");
    setFlash((f) => ({ id, n: (f?.n ?? 0) + 1 }));
    requestAnimationFrame(() => {
      const el = document.getElementById(`claim-${id}`);
      const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      el?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "center" });
      el?.focus({ preventScroll: true });
    });
  }, []);

  // One shared, viewport-clamped claim preview (hover, focus, or first tap on touch). Esc closes it.
  const showPreview = useCallback((id: string, el: HTMLElement, pinned = false) => {
    window.clearTimeout(hideTimer.current);
    setPreview({ id, el, pinned, tick: 0 });
  }, []);
  const hidePreview = useCallback(() => {
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setPreview((p) => (p?.pinned ? p : null)), 150);
  }, []);
  const keepPreview = useCallback(() => window.clearTimeout(hideTimer.current), []);
  const h: ChipHandlers = { jump, show: showPreview, hide: hidePreview, openId: preview?.id ?? null };
  useEffect(() => {
    if (!preview) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setPreview(null);
    // Follow the chip on scroll/resize (keyboard focus scrolls the page) instead of closing.
    let frame = 0;
    const follow = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setPreview((p) => (p ? { ...p, tick: p.tick + 1 } : p)));
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", follow, { passive: true });
    window.addEventListener("resize", follow);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", follow);
      window.removeEventListener("resize", follow);
    };
  }, [preview?.id]); // eslint-disable-line react-hooks/exhaustive-deps

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

  const R = (text: string, extra?: string[]) => <Rich text={text} extra={extra} claims={claims} scenarios={scenarioNames} h={h} />;

  return (
    <div className="grid gap-10 pb-16 lg:grid-cols-[minmax(0,1fr)_200px] lg:pb-0">
      <article className="min-w-0 space-y-12">
        <header className="space-y-5">
          <div className="flex flex-wrap gap-1.5">
            <ManagedBadge managed={g.composio.managed_oauth} />
            <ReviewBadge record={record} />
            {record.meta.partial && <Badge tone="bad">Incomplete: research timed out</Badge>}
          </div>
          <h1 className="text-3xl font-semibold leading-tight tracking-tight sm:text-4xl">{name}: OAuth app setup</h1>
          <p className="max-w-3xl text-lg leading-relaxed text-muted">{R(g.summary)}</p>
          <div className="flex flex-wrap gap-2 text-sm">
            <button onClick={copy} className="rounded-lg bg-ink px-3.5 py-2 font-medium text-bg transition hover:bg-white">
              <span aria-live="polite">{copyState === "ok" ? "✓ Link copied" : copyState === "fail" ? "Couldn't copy: use the address bar" : "Copy share link"}</span>
            </button>
            <a href={`/guides/${record.slug}/md?s=${scenarioId}`} className="rounded-lg border border-line-strong px-3.5 py-2 text-ink transition hover:bg-surface-2">
              Markdown
            </a>
            {g.app.developer_docs_url && (
              <a href={g.app.developer_docs_url} target="_blank" rel="noreferrer" className="rounded-lg border border-line-strong px-3.5 py-2 text-ink transition hover:bg-surface-2">
                Provider docs ↗
              </a>
            )}
            {g.composio.credential_guide_url && (
              <a href={g.composio.credential_guide_url} target="_blank" rel="noreferrer" className="rounded-lg border border-line-strong px-3.5 py-2 text-ink transition hover:bg-surface-2">
                Composio setup guide ↗
              </a>
            )}
          </div>
          <p className="font-mono text-xs text-faint">
            Researched {new Date(record.meta.generated_at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })} ·{" "}
            {v.quotes_verified}/{v.quotes_checked} quotes verified
            {counts.unknown ? ` · ${counts.unknown} unconfirmed` : ""}
          </p>
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

        <section className="rounded-2xl border border-accent/25 bg-gradient-to-b from-violet-500/[0.08] to-transparent p-6">
          <h2 className="text-lg font-semibold">Do you need your own OAuth app?</h2>
          <p className="mt-2 leading-relaxed text-ink/90">{R(g.need_own_app.answer)}</p>
          {g.need_own_app.reasons.length > 0 && (
            <ul className="mt-3 space-y-1.5 text-sm text-muted">
              {g.need_own_app.reasons.map((r) => (
                <li key={r} className="flex gap-2">
                  <span aria-hidden className="text-accent">
                    →
                  </span>
                  <span>{R(r)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section id="setup" className="scroll-mt-24">
          <SectionTitle title="Your setup" sub="Pick the closest match. The steps below follow it." />
          <div role="group" aria-label="Setups" className="overflow-hidden rounded-2xl border border-line">
            <div className="hidden grid-cols-[minmax(0,1.6fr)_110px_minmax(0,1fr)_minmax(0,1.2fr)] gap-4 bg-surface-2 px-4 py-2 font-mono text-[11px] uppercase tracking-wider text-faint md:grid">
              <span>Setup</span>
              <span>Difficulty</span>
              <span>Your time</span>
              <span>Provider wait</span>
            </div>
            {g.scenarios.map((s) => {
              const on = s.id === scenarioId;
              return (
                <button
                  key={s.id}
                  onClick={() => pickScenario(s.id)}
                  aria-pressed={on}
                  className={`grid w-full gap-x-4 gap-y-1 border-t border-line px-4 py-3 text-left text-sm transition first:border-t-0 md:grid-cols-[minmax(0,1.6fr)_110px_minmax(0,1fr)_minmax(0,1.2fr)] ${
                    on ? "bg-violet-500/[0.12] ring-1 ring-inset ring-accent/50" : "bg-surface hover:bg-surface-2"
                  }`}
                >
                  <span className="font-medium text-ink">
                    <span aria-hidden className={`mr-2 inline-block h-3 w-3 rounded-full border align-[-1px] ${on ? "border-accent bg-accent" : "border-line-strong"}`} />
                    {s.label}
                  </span>
                  <span>
                    <DifficultyBadge level={s.difficulty} />
                  </span>
                  <span className="text-muted">
                    <span className="text-faint md:hidden">Your time: </span>
                    {s.hands_on.estimate}
                  </span>
                  <span className="text-muted">
                    <span className="text-faint md:hidden">Provider wait: </span>
                    {s.waiting.estimate}
                  </span>
                </button>
              );
            })}
          </div>
          {scenario && (
            <dl aria-live="polite" className="mt-4 grid gap-4 rounded-2xl border border-line bg-surface p-5 text-sm md:grid-cols-2">
              <Detail title="When this applies" wide>
                {R(scenario.when_this_applies)}
              </Detail>
              <Detail title="Approval">{R(scenario.approval, scenario.claim_ids)}</Detail>
              <Detail title="Why these times">
                <span className="block">Your time: {R(scenario.hands_on.basis)}</span>
                <span className="mt-1 block">Provider wait: {R(scenario.waiting.basis)}</span>
              </Detail>
            </dl>
          )}
        </section>

        {g.prerequisites.length > 0 && (
          <section id="before" className="scroll-mt-24">
            <SectionTitle title="Before you start" />
            <ul className="grid gap-2 md:grid-cols-2">
              {g.prerequisites.map((p) => (
                <li key={p.title} className="rounded-xl border border-line bg-surface p-4 text-sm">
                  <p className="font-medium">{R(p.title)}</p>
                  <p className="mt-1 leading-relaxed text-muted">{R(p.detail, p.claim_ids)}</p>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section id="steps" className="scroll-mt-24">
          <SectionTitle
            title="Steps"
            sub={scenario ? `For: ${scenario.label}` : undefined}
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
                    <h3 className="font-medium">{R(s.title)}</h3>
                    <Badge tone={OWNER[s.owner].tone}>
                      <span aria-hidden>{OWNER[s.owner].icon}</span> {OWNER[s.owner].label}
                    </Badge>
                  </div>
                  <p className="mt-2 text-sm leading-relaxed text-muted">{R(s.detail, s.claim_ids)}</p>
                  <div className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
                    {s.inputs.length > 0 && (
                      <div>
                        <p className="font-mono text-[11px] uppercase tracking-wider text-faint">You need</p>
                        <ul className="mt-1 space-y-0.5 text-ink/85">
                          {s.inputs.map((x) => (
                            <li key={x}>· {R(x)}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                    <div>
                      <p className="font-mono text-[11px] uppercase tracking-wider text-faint">Done when</p>
                      <p className="mt-1 text-ink/85">{R(s.done_when)}</p>
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

        {g.traps.length > 0 && (
          <section id="traps" className="scroll-mt-24">
            <SectionTitle title="Traps" />
            <ul className="space-y-2">
              {g.traps.map((t) => (
                <li key={t.title} className="rounded-xl border border-amber-400/20 bg-amber-500/[0.06] p-4 text-sm">
                  <p className="font-medium text-amber-200">⚠ {R(t.title)}</p>
                  <p className="mt-1 leading-relaxed text-muted">{R(t.detail, t.claim_ids)}</p>
                </li>
              ))}
            </ul>
          </section>
        )}

        {g.blockers.length > 0 && (
          <section id="stuck" className="scroll-mt-24">
            <SectionTitle title="Stuck?" />
            <div className="hidden rounded-xl border border-line md:block">
              <table className="w-full text-left text-sm">
                <thead className="bg-surface-2 font-mono text-[11px] uppercase tracking-wider text-faint">
                  <tr>
                    <th className="rounded-tl-xl p-3 font-normal">You see</th>
                    <th className="p-3 font-normal">It means</th>
                    <th className="p-3 font-normal">Do this</th>
                    <th className="rounded-tr-xl p-3 font-normal">🤖 Agent can do</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line bg-surface">
                  {g.blockers.map((b) => (
                    <tr key={b.symptom} className="align-top">
                      <td className="p-3 font-medium">{R(b.symptom)}</td>
                      <td className="p-3 text-muted">{R(b.what_it_means, b.claim_ids)}</td>
                      <td className="p-3 text-ink/85">{R(b.what_to_do)}</td>
                      <td className="p-3 text-muted">{b.agent_can_help ? R(b.agent_can_help) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <ul className="space-y-2 md:hidden">
              {g.blockers.map((b) => (
                <li key={b.symptom} className="rounded-xl border border-line bg-surface p-4 text-sm">
                  <p className="font-medium">{R(b.symptom)}</p>
                  <p className="mt-2 text-muted">{R(b.what_it_means, b.claim_ids)}</p>
                  <p className="mt-1 text-ink/85">→ {R(b.what_to_do)}</p>
                  {b.agent_can_help && <p className="mt-1 text-muted">🤖 {R(b.agent_can_help)}</p>}
                </li>
              ))}
            </ul>
          </section>
        )}

        {g.open_questions.length > 0 && (
          <section id="unconfirmed" className="scroll-mt-24">
            <SectionTitle title="Unconfirmed" />
            <ul className="space-y-1.5 text-sm text-muted">
              {g.open_questions.map((q) => (
                <li key={q} className="flex gap-2">
                  <span aria-hidden className="text-faint">
                    ❓
                  </span>
                  <span>{R(q)}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section id="evidence" className="scroll-mt-24">
          <SectionTitle title="Evidence" />
          <div role="group" aria-label="Filter evidence" className="scrollbar-none -mx-1 mb-4 flex gap-1.5 overflow-x-auto px-1">
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
              <li
                key={flash?.id === c.id ? `${c.id}-${flash.n}` : c.id}
                id={`claim-${c.id}`}
                tabIndex={-1}
                className={`scroll-mt-24 rounded-xl border border-line bg-surface p-4 text-sm ${flash?.id === c.id ? "claim-flash" : ""}`}
              >
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="font-mono text-xs text-faint">{c.id}</span>
                  <Badge tone={LABEL_TONE[c.label]}>
                    {LABEL_INFO[c.label].icon} {LABEL_INFO[c.label].name}
                  </Badge>
                </div>
                <p className="mt-2 leading-relaxed text-ink/90">{c.text}</p>
                {c.quote && <blockquote className="mt-2 border-l-2 border-accent/50 pl-3 font-mono text-xs leading-relaxed text-muted">“{c.quote}”</blockquote>}
                {c.source_url && (
                  <a href={c.source_url} target="_blank" rel="noreferrer" className="mt-2 block break-all font-mono text-xs text-accent hover:underline">
                    {c.source_url} ↗
                  </a>
                )}
                {c.probe_id && <p className="mt-1 font-mono text-xs text-faint">Endpoint check {c.probe_id}, below</p>}
                {c.note && <p className="mt-2 text-xs italic text-amber-200/80">{c.note}</p>}
              </li>
            ))}
          </ul>

          {record.meta.probes.length > 0 && (
            <div className="mt-8">
              <h3 className="mb-2 font-semibold">Endpoint checks</h3>
              <ul className="space-y-2">
                {record.meta.probes.map((p) => (
                  <li key={p.id} className="rounded-xl border border-sky-400/20 bg-sky-500/[0.05] p-4 text-xs">
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

          <div className="mt-6 space-y-2 rounded-xl border border-line bg-surface p-4 text-sm text-muted">
            <p className="font-medium text-ink">About this guide</p>
            <p>
              {record.meta.origin === "seed" ? "Library guide." : "Generated by the agent on request."} Each quote was matched word for word against its source page.
              No step has been hands-on tested yet.{" "}
              <Link href="/verification" className="text-accent hover:underline">
                Verification log
              </Link>
            </p>
            {record.meta.review_note && <p>{record.meta.review_note}</p>}
            {record.meta.sources.length > 0 && (
              <details>
                <summary className="cursor-pointer hover:text-ink">{record.meta.sources.length} pages read</summary>
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
        </section>
      </article>

      {preview && claims.get(preview.id) && (
        <ClaimPreview claim={claims.get(preview.id)!} anchor={preview.el} onEnter={keepPreview} onLeave={hidePreview} onJump={() => jump(preview.id)} />
      )}

      <aside className="hidden lg:block">
        <nav aria-label="On this page" className="sticky top-24 space-y-1 text-sm">
          <p className="mb-2 font-mono text-[11px] uppercase tracking-wider text-faint">On this page</p>
          {sections.map((s) => (
            <a key={s.id} href={`#${s.id}`} className="block rounded-md px-2 py-1 text-muted transition hover:bg-surface-2 hover:text-ink">
              {s.label}
            </a>
          ))}
          <div className="mt-4 rounded-lg border border-line p-3 text-xs text-muted">
            {labels.map((k) => (
              <p key={k} title={LABEL_INFO[k].meaning}>
                {LABEL_INFO[k].icon} {LABEL_INFO[k].name}
              </p>
            ))}
          </div>
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

function Detail({ title, wide, children }: { title: string; wide?: boolean; children: React.ReactNode }) {
  return (
    <div className={wide ? "md:col-span-2" : ""}>
      <dt className="font-mono text-[11px] uppercase tracking-wider text-faint">{title}</dt>
      <dd className="mt-1 leading-relaxed text-ink/90">{children}</dd>
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
