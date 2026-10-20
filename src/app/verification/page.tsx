import Link from "next/link";
import { Badge, type Tone } from "@/components/badges";
import { loadLedger } from "@/lib/ledger";
import { listGuides } from "@/lib/store";

// Lists change whenever the agent saves a new guide.
export const dynamic = "force-dynamic";

const OUTCOME: Record<string, Tone> = { confirmed: "good", corrected: "bad", unverifiable: "neutral", pending: "warn" };
const ORIGIN: Record<string, string> = { "plan_v0.1": "my initial assumption", seed_agent: "library guide", live_agent: "agent run", composio_docs: "Composio docs" };
// Cases where checking the sources changed the answer: the strongest evidence that the checks matter.
const FEATURED = ["v19", "v1", "v10", "v4"];

export default async function VerificationPage() {
  const [ledger, guides] = await Promise.all([loadLedger(), listGuides()]);
  const entries = ledger?.entries ?? [];
  const count = (o: string) => entries.filter((e) => e.outcome === o).length;
  const claims = guides.reduce((n, g) => n + g.guide.claims.length, 0);
  const verified = guides.reduce((n, g) => n + g.meta.verification.quotes_verified, 0);
  const checked = guides.reduce((n, g) => n + g.meta.verification.quotes_checked, 0);
  const tested = guides.reduce((n, g) => n + g.guide.claims.filter((c) => c.label === "tested").length, 0);
  const featured = FEATURED.map((id) => entries.find((e) => e.id === id)).filter((e): e is (typeof entries)[number] => !!e);

  return (
    <div className="space-y-12">
      <header className="max-w-3xl space-y-3">
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Verification</h1>
        <p className="text-lg text-muted">What was checked, what turned out wrong, and what is still unconfirmed.</p>
      </header>

      <dl className="grid gap-3 sm:grid-cols-3">
        <Stat value={claims} label="claims across all guides" />
        <Stat value={`${verified}/${checked}`} label="docs quotes matched word for word on the source page" />
        <Stat value={tested} label="claims confirmed by a hands-on setup (none yet)" />
      </dl>

      {featured.length > 0 && (
        <section>
          <h2 className="mb-4 text-xl font-semibold tracking-tight">Where checking changed the answer</h2>
          <ul className="grid gap-3 md:grid-cols-2">
            {featured.map((e) => (
              <li key={e.id} className="rounded-xl border border-line bg-surface p-4 text-sm">
                <p className="text-xs text-faint">
                  {e.app} · {ORIGIN[e.origin] ?? e.origin}
                </p>
                <p className="mt-1 text-muted line-through decoration-rose-400/60">{e.claim}</p>
                <p className="mt-2 leading-relaxed text-ink/90">{e.finding}</p>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h2 className="mb-4 text-xl font-semibold tracking-tight">Quote checks per guide</h2>
        <div className="overflow-x-auto rounded-xl border border-line">
          <table className="w-full min-w-[560px] text-left text-sm">
            <thead className="bg-surface-2 font-mono text-[11px] uppercase tracking-wider text-faint">
              <tr>
                <th className="p-3 font-normal">Guide</th>
                <th className="p-3 font-normal">Claims</th>
                <th className="p-3 font-normal">Quotes verified</th>
                <th className="p-3 font-normal">Flagged by the check</th>
                <th className="p-3 font-normal">Unconfirmed</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line bg-surface font-mono text-[13px]">
              {guides.map((g) => {
                const v = g.meta.verification;
                const all = v.quotes_checked > 0 && v.quotes_verified === v.quotes_checked;
                return (
                  <tr key={g.slug}>
                    <td className="p-3 font-sans">
                      <Link className="text-accent hover:underline" href={`/guides/${g.slug}`}>
                        {g.guide.app.name.replace(/\s*\(.*\)\s*$/, "")}
                      </Link>
                      <span className="ml-2 text-xs text-faint">{g.meta.origin === "seed" ? "library" : "generated"}</span>
                    </td>
                    <td className="p-3">{g.guide.claims.length}</td>
                    <td className={`p-3 ${all ? "text-emerald-300" : "text-amber-200"}`}>
                      {v.quotes_verified}/{v.quotes_checked}
                    </td>
                    <td className="p-3">{v.downgraded}</td>
                    <td className="p-3">{g.guide.claims.filter((c) => c.label === "unknown").length}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2 className="text-xl font-semibold tracking-tight">All checked claims</h2>
        {ledger ? (
          <>
            <p className="mb-4 mt-1 text-sm text-muted">
              {entries.length} claims · {count("confirmed")} confirmed · {count("corrected")} corrected · {count("unverifiable")} unverifiable · {count("pending")} pending
            </p>
            <ul className="space-y-2">
              {entries.map((e) => (
                <li key={e.id} className="rounded-xl border border-line bg-surface p-4 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={OUTCOME[e.outcome]}>{e.outcome}</Badge>
                    <span className="text-xs text-muted">
                      {e.app} · {ORIGIN[e.origin] ?? e.origin}
                    </span>
                  </div>
                  <p className="mt-2 text-muted">
                    <span className="text-faint">Claimed: </span>
                    {e.claim}
                  </p>
                  <p className="mt-1 leading-relaxed text-ink/90">
                    <span className="text-faint">Found: </span>
                    {e.finding}
                  </p>
                  <p className="mt-2 text-xs text-faint">
                    {e.check}
                    {e.evidence_url && (
                      <>
                        {" "}·{" "}
                        <a className="break-all font-mono text-accent hover:underline" href={e.evidence_url} target="_blank" rel="noreferrer">
                          source ↗
                        </a>
                      </>
                    )}
                  </p>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="mt-2 text-sm text-faint">No ledger yet.</p>
        )}
      </section>

      {ledger && ledger.hands_on.length > 0 && (
        <section>
          <h2 className="text-xl font-semibold tracking-tight">Planned hands-on tests</h2>
          <p className="mb-4 mt-1 text-sm text-muted">None completed yet. Until then, no claim is labelled 🧪 Tested.</p>
          <ul className="space-y-2">
            {ledger.hands_on.map((h) => (
              <li key={h.provider} className="rounded-xl border border-line bg-surface p-4 text-sm">
                <span className="font-medium">{h.provider}</span>
                <span className="text-muted">: {h.what}</span>
                {h.result && <p className="mt-1 text-ink/90">{h.result}</p>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function Stat({ value, label }: { value: number | string; label: string }) {
  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <dd className="font-mono text-2xl text-ink">{value}</dd>
      <dt className="mt-1 text-sm text-muted">{label}</dt>
    </div>
  );
}
