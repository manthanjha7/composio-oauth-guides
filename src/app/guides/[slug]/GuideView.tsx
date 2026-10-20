"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { DifficultyBadge, ManagedBadge, OriginBadge } from "@/components/badges";
import { LABEL_INFO } from "@/lib/evidence";
import type { ClaimT, GuideRecord } from "@/lib/schema";

const OWNER = {
  agent: { icon: "🤖", label: "Agent can do this", style: "bg-violet-50 text-violet-700 ring-violet-200" },
  you: { icon: "👤", label: "You", style: "bg-stone-100 text-stone-700 ring-stone-300" },
  waiting: { icon: "⏳", label: "Waiting on provider", style: "bg-amber-50 text-amber-800 ring-amber-200" },
} as const;

export function GuideView({ record }: { record: GuideRecord }) {
  const g = record.guide;
  const [scenarioId, setScenarioId] = useState<string>(g.scenarios[0]?.id ?? "");
  const [copied, setCopied] = useState(false);
  const scenario = g.scenarios.find((s) => s.id === scenarioId);
  const claims = useMemo(() => new Map(g.claims.map((c) => [c.id, c])), [g.claims]);
  const steps = g.steps.filter((s) => s.scenario_ids.length === 0 || s.scenario_ids.includes(scenarioId));
  const counts = g.claims.reduce<Record<string, number>>((acc, c) => ({ ...acc, [c.label]: (acc[c.label] ?? 0) + 1 }), {});
  const owners = steps.reduce<Record<string, number>>((acc, s) => ({ ...acc, [s.owner]: (acc[s.owner] ?? 0) + 1 }), {});


  return (
    <article className="space-y-8">
      <header className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <ManagedBadge managed={g.composio.managed_oauth} />
          <OriginBadge record={record} />
          {record.meta.partial && <span className="rounded-full bg-rose-50 px-2 py-0.5 text-xs text-rose-700 ring-1 ring-rose-200">Partial: research hit its time limit</span>}
        </div>
        <h1 className="text-3xl font-semibold tracking-tight">{g.app.name}: getting your own OAuth app ready</h1>
        <p className="max-w-3xl text-stone-700">{g.summary}</p>
        <div className="flex flex-wrap gap-2 text-sm">
          <button
            onClick={async () => {
              await navigator.clipboard.writeText(window.location.href);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
            className="rounded-lg bg-stone-900 px-3 py-1.5 font-medium text-white hover:bg-stone-700"
          >
            {copied ? "Link copied" : "Copy share link"}
          </button>
          <a href={`/guides/${record.slug}/md`} className="rounded-lg bg-white px-3 py-1.5 font-medium ring-1 ring-stone-300 hover:bg-stone-50">
            Markdown (for docs or your coding agent)
          </a>
          {g.app.developer_docs_url && (
            <a href={g.app.developer_docs_url} target="_blank" rel="noreferrer" className="rounded-lg bg-white px-3 py-1.5 ring-1 ring-stone-300 hover:bg-stone-50">
              Provider docs ↗
            </a>
          )}
          {g.composio.credential_guide_url && (
            <a href={g.composio.credential_guide_url} target="_blank" rel="noreferrer" className="rounded-lg bg-white px-3 py-1.5 ring-1 ring-stone-300 hover:bg-stone-50">
              Composio credential walkthrough ↗
            </a>
          )}
        </div>
        <p className="text-xs text-stone-500">
          {record.meta.origin === "live" ? "Generated live" : "Seed guide"} on {record.meta.generated_at.slice(0, 10)} by {record.meta.generated_by}
          {record.meta.duration_ms ? ` in ${Math.round(record.meta.duration_ms / 1000)}s` : ""} · {g.claims.length} claims (
          {Object.entries(counts).map(([k, v], i) => (
            <span key={k}>{i ? ", " : ""}{LABEL_INFO[k as ClaimT["label"]].icon} {v}</span>
          ))}
          ) · {record.meta.verification.quotes_verified}/{record.meta.verification.quotes_checked} doc quotes verified on the live page
          {record.meta.review_note ? ` · ${record.meta.review_note}` : ""}
        </p>
      </header>

      <section className="rounded-xl border border-violet-200 bg-violet-50/60 p-5">
        <h2 className="font-semibold">Do you need your own OAuth app?</h2>
        <p className="mt-1 text-stone-700">{g.need_own_app.answer}</p>
        {g.need_own_app.reasons.length > 0 && (
          <ul className="mt-2 list-disc space-y-0.5 pl-5 text-sm text-stone-700">
            {g.need_own_app.reasons.map((r) => <li key={r}>{r}</li>)}
          </ul>
        )}
        <p className="mt-2 text-sm text-stone-600">{g.composio.note}</p>
      </section>

      <section>
        <h2 className="mb-2 text-lg font-semibold">Pick your scenario</h2>
        <p className="mb-3 text-sm text-stone-500">Difficulty depends on what you&apos;re building (scopes, who your users are, how you distribute), not just on the app.</p>
        <div className="flex flex-wrap gap-2">
          {g.scenarios.map((s) => (
            <button
              key={s.id}
              onClick={() => setScenarioId(s.id)}
              className={`rounded-lg px-3 py-2 text-left text-sm ring-1 ${s.id === scenarioId ? "bg-stone-900 text-white ring-stone-900" : "bg-white ring-stone-300 hover:bg-stone-50"}`}
            >
              <span className="font-medium">{s.label}</span>
            </button>
          ))}
        </div>
        {scenario && (
          <div className="mt-4 grid gap-3 rounded-xl border border-stone-200 bg-white p-5 shadow-sm md:grid-cols-4">
            <div className="md:col-span-4 text-sm text-stone-600">
              <b className="text-stone-800">When this applies:</b> {scenario.when_this_applies}
            </div>
            <Metric title="Difficulty"><DifficultyBadge level={scenario.difficulty} /></Metric>
            <Metric title="Your hands-on time" sub={scenario.hands_on.basis}>{scenario.hands_on.estimate}</Metric>
            <Metric title="Waiting on the provider" sub={scenario.waiting.basis}>{scenario.waiting.estimate}</Metric>
            <Metric title="Review / approval">
              <span className="text-sm font-normal">{scenario.approval}</span>
              <Cite claims={claims} ids={scenario.claim_ids} />
            </Metric>
          </div>
        )}
      </section>

      {g.prerequisites.length > 0 && (
        <section>
          <h2 className="mb-2 text-lg font-semibold">Before you start</h2>
          <ul className="space-y-2">
            {g.prerequisites.map((p) => (
              <li key={p.title} className="rounded-lg border border-stone-200 bg-white p-3 text-sm">
                <b>{p.title}</b>: {p.detail}
                <Cite claims={claims} ids={p.claim_ids} />
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-lg font-semibold">Steps for this scenario</h2>
          <p className="text-sm text-stone-500">
            {owners.agent ?? 0} 🤖 an agent can do · {owners.you ?? 0} 👤 you do · {owners.waiting ?? 0} ⏳ waiting
          </p>
        </div>
        <ol className="space-y-3">
          {steps.map((s, i) => (
            <li key={`${s.title}-${i}`} className="rounded-xl border border-stone-200 bg-white p-4 shadow-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-stone-900 text-xs font-semibold text-white">{i + 1}</span>
                <h3 className="font-medium">{s.title}</h3>
                <span className={`rounded-full px-2 py-0.5 text-xs ring-1 ring-inset ${OWNER[s.owner].style}`}>
                  {OWNER[s.owner].icon} {OWNER[s.owner].label}
                </span>
              </div>
              <p className="mt-2 text-sm text-stone-700">
                {s.detail}
                <Cite claims={claims} ids={s.claim_ids} />
              </p>
              <div className="mt-2 grid gap-2 text-sm sm:grid-cols-2">
                {s.inputs.length > 0 && (
                  <div className="text-stone-600">
                    <span className="text-xs uppercase tracking-wide text-stone-400">You need</span>
                    <ul className="list-disc pl-5">{s.inputs.map((x) => <li key={x}>{x}</li>)}</ul>
                  </div>
                )}
                <div className="text-stone-600">
                  <span className="text-xs uppercase tracking-wide text-stone-400">Done when</span>
                  <p>{s.done_when}</p>
                </div>
              </div>
              {s.link && (
                <a href={s.link} target="_blank" rel="noreferrer" className="mt-2 inline-block break-all text-sm text-violet-700 hover:underline">
                  {s.link} ↗
                </a>
              )}
            </li>
          ))}
        </ol>
      </section>

      {g.traps.length > 0 && (
        <section>
          <h2 className="mb-2 text-lg font-semibold">Traps people hit</h2>
          <ul className="space-y-2">
            {g.traps.map((t) => (
              <li key={t.title} className="rounded-lg border border-amber-200 bg-amber-50/60 p-3 text-sm">
                <b>⚠ {t.title}</b>: {t.detail}
                <Cite claims={claims} ids={t.claim_ids} />
              </li>
            ))}
          </ul>
        </section>
      )}

      {g.blockers.length > 0 && (
        <section>
          <h2 className="mb-2 text-lg font-semibold">Stuck?</h2>
          <div className="overflow-x-auto rounded-xl border border-stone-200 bg-white">
            <table className="w-full text-left text-sm">
              <thead className="bg-stone-50 text-xs uppercase tracking-wide text-stone-500">
                <tr><th className="p-3">You see</th><th className="p-3">It means</th><th className="p-3">Do this</th><th className="p-3">🤖 Agent can help</th></tr>
              </thead>
              <tbody>
                {g.blockers.map((b) => (
                  <tr key={b.symptom} className="border-t border-stone-100 align-top">
                    <td className="p-3 font-medium">{b.symptom}</td>
                    <td className="p-3 text-stone-700">{b.what_it_means}<Cite claims={claims} ids={b.claim_ids} /></td>
                    <td className="p-3 text-stone-700">{b.what_to_do}</td>
                    <td className="p-3 text-stone-600">{b.agent_can_help ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {g.open_questions.length > 0 && (
        <section>
          <h2 className="mb-2 text-lg font-semibold">Still uncertain</h2>
          <ul className="list-disc space-y-1 pl-5 text-sm text-stone-700">
            {g.open_questions.map((q) => <li key={q}>{q}</li>)}
          </ul>
        </section>
      )}

      <section id="evidence">
        <h2 className="mb-1 text-lg font-semibold">Evidence</h2>
        <p className="mb-3 text-sm text-stone-500">
          {Object.values(LABEL_INFO).map((i) => `${i.icon} ${i.name}: ${i.meaning}`).join(" · ")}
        </p>
        <ul className="space-y-2">
          {g.claims.map((c) => (
            <li key={c.id} id={`claim-${c.id}`} className="scroll-mt-20 rounded-lg border border-stone-200 bg-white p-3 text-sm target:ring-2 target:ring-violet-400">
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="font-mono text-xs text-stone-400">{c.id}</span>
                <span className="rounded bg-stone-100 px-1.5 py-0.5 text-xs">{LABEL_INFO[c.label].icon} {LABEL_INFO[c.label].name}</span>
                <span className="text-stone-800">{c.text}</span>
              </div>
              {c.quote && <blockquote className="mt-1 border-l-2 border-stone-300 pl-2 text-stone-600">&ldquo;{c.quote}&rdquo;</blockquote>}
              {c.source_url && (
                <a href={c.source_url} target="_blank" rel="noreferrer" className="mt-1 block break-all text-xs text-violet-700 hover:underline">{c.source_url}</a>
              )}
              {c.probe_id && <span className="mt-1 block text-xs text-stone-500">Probe {c.probe_id}: see below</span>}
              {c.note && <p className="mt-1 text-xs italic text-stone-500">{c.note}</p>}
            </li>
          ))}
        </ul>
        {record.meta.probes.length > 0 && (
          <>
            <h3 className="mb-2 mt-5 font-semibold">Live probes</h3>
            <ul className="space-y-2">
              {record.meta.probes.map((p) => (
                <li key={p.id} className="rounded-lg border border-stone-200 bg-white p-3 text-xs text-stone-600">
                  <b className="font-mono">{p.id}</b> · {p.purpose} · {p.at.slice(0, 10)}
                  <div className="break-all font-mono">GET {p.url} → {p.status ?? "no response"}</div>
                  <div className="mt-1">{p.observation}</div>
                </li>
              ))}
            </ul>
          </>
        )}
        {record.meta.sources.length > 0 && (
          <details className="mt-4 text-sm">
            <summary className="cursor-pointer text-stone-600">{record.meta.sources.length} pages read</summary>
            <ul className="mt-2 space-y-1 text-xs">
              {record.meta.sources.map((s, i) => (
                <li key={`${s.url}-${i}`} className="break-all">
                  <a className="text-violet-700 hover:underline" href={s.url} target="_blank" rel="noreferrer">{s.title || s.url}</a>{" "}
                  <span className="text-stone-400">({s.via}, {s.fetched_at.slice(0, 10)})</span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>

      <p className="text-sm text-stone-500">
        Something wrong or out of date? <Link className="text-violet-700 underline" href={`/generate?q=${encodeURIComponent(g.app.name)}&fresh=1`}>Re-run the agent</Link> or check the <Link className="text-violet-700 underline" href="/verification">verification log</Link>.
      </p>
    </article>
  );
}

function Cite({ ids, claims }: { ids: string[]; claims: Map<string, ClaimT> }) {
  if (!ids.length) return null;
  return (
    <span className="ml-1 inline-flex flex-wrap gap-1 align-middle">
      {ids.map((id) => {
        const c = claims.get(id);
        if (!c) return null;
        return (
          <a
            key={id}
            href={`#claim-${id}`}
            title={`${LABEL_INFO[c.label].name}: ${c.text}${c.quote ? `\n"${c.quote}"` : ""}`}
            className={`rounded px-1 py-px font-mono text-[11px] ring-1 ring-inset ${c.label === "unknown" ? "bg-stone-50 text-stone-500 ring-stone-200" : "bg-white text-stone-600 ring-stone-200"} hover:ring-violet-400`}
          >
            {LABEL_INFO[c.label].icon}
            {id}
          </a>
        );
      })}
    </span>
  );
}

function Metric({ title, sub, children }: { title: string; sub?: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-stone-400">{title}</p>
      <div className={`mt-1 font-semibold text-stone-900 ${typeof children === "string" && children.length > 28 ? "text-sm" : "text-lg"}`}>{children}</div>
      {sub && <p className="mt-1 text-xs text-stone-500">Basis: {sub}</p>}
    </div>
  );
}
