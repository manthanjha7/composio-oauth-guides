import Link from "next/link";
import { Badge, type Tone } from "@/components/badges";
import { loadLedger } from "@/lib/ledger";
import { listGuides } from "@/lib/store";

// Lists change whenever the agent saves a new guide.
export const dynamic = "force-dynamic";

const OUTCOME: Record<string, Tone> = { confirmed: "good", corrected: "bad", unverifiable: "neutral", pending: "warn" };

export default async function VerificationPage() {
  const [ledger, guides] = await Promise.all([loadLedger(), listGuides()]);
  const entries = ledger?.entries ?? [];
  const count = (o: string) => entries.filter((e) => e.outcome === o).length;

  return (
    <div className="space-y-12">
      <header className="max-w-3xl space-y-3">
        <p className="font-mono text-xs uppercase tracking-[0.2em] text-accent">Evidence</p>
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Verification log</h1>
        <p className="text-lg leading-relaxed text-muted">
          What we checked, what turned out to be wrong, and what we couldn&apos;t verify. Two layers: an <span className="text-ink">automatic check</span> on every
          guide (each quoted docs claim is matched word-for-word against the page it cites) and a <span className="text-ink">manual ledger</span> of material claims
          checked against official docs and real runs.
        </p>
      </header>

      <section>
        <h2 className="mb-4 text-xl font-semibold tracking-tight">Automatic quote checks</h2>
        <div className="overflow-x-auto rounded-xl border border-line">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead className="bg-surface-2 font-mono text-[11px] uppercase tracking-wider text-faint">
              <tr>
                <th className="p-3 font-normal">Guide</th>
                <th className="p-3 font-normal">Origin</th>
                <th className="p-3 font-normal">Claims</th>
                <th className="p-3 font-normal">Docs quotes verified</th>
                <th className="p-3 font-normal">Downgraded</th>
                <th className="p-3 font-normal">Unknown claims</th>
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
                      {g.meta.origin === "live" && <span className="ml-2 text-xs text-faint">agent</span>}
                    </td>
                    <td className="p-3 text-muted">{g.meta.origin}</td>
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
        <h2 className="text-xl font-semibold tracking-tight">Manual ledger</h2>
        {ledger ? (
          <>
            <p className="mb-4 mt-1 text-sm text-muted">
              <span className="text-ink">{entries.length} material claims</span> · {count("confirmed")} confirmed · {count("corrected")} corrected · {count("unverifiable")} unverifiable ·{" "}
              {count("pending")} pending · updated {ledger.updated}. {ledger.note}
            </p>
            <ul className="space-y-2">
              {entries.map((e) => (
                <li key={e.id} className="rounded-xl border border-line bg-surface p-4 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs text-faint">{e.id}</span>
                    <Badge tone={OUTCOME[e.outcome]}>{e.outcome}</Badge>
                    <span className="text-xs text-muted">
                      {e.app} · from {e.origin.replace("_", " ")}
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
                    How checked: {e.check}
                    {e.evidence_url && (
                      <>
                        {" "}·{" "}
                        <a className="break-all font-mono text-accent hover:underline" href={e.evidence_url} target="_blank" rel="noreferrer">
                          {e.evidence_url} ↗
                        </a>
                      </>
                    )}
                  </p>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="mt-2 text-sm text-faint">No ledger file yet.</p>
        )}
      </section>

      {ledger && ledger.hands_on.length > 0 && (
        <section>
          <h2 className="mb-4 text-xl font-semibold tracking-tight">Hands-on setup attempts</h2>
          <ul className="space-y-2">
            {ledger.hands_on.map((h) => (
              <li key={h.provider} className="rounded-xl border border-line bg-surface p-4 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={h.status === "done" ? "good" : "warn"}>{h.status}</Badge>
                  <span className="font-medium">{h.provider}</span>
                </div>
                <p className="mt-1 text-muted">{h.what}</p>
                {h.result && <p className="mt-1 text-ink/90">{h.result}</p>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
