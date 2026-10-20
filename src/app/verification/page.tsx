import Link from "next/link";
import { loadLedger } from "@/lib/ledger";
import { listGuides } from "@/lib/store";

// Lists change whenever the agent saves a new guide.
export const dynamic = "force-dynamic";

const OUTCOME: Record<string, string> = {
  confirmed: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  corrected: "bg-rose-50 text-rose-700 ring-rose-200",
  unverifiable: "bg-stone-100 text-stone-600 ring-stone-300",
  pending: "bg-amber-50 text-amber-800 ring-amber-200",
};

export default async function VerificationPage() {
  const [ledger, guides] = await Promise.all([loadLedger(), listGuides()]);
  const entries = ledger?.entries ?? [];
  const count = (o: string) => entries.filter((e) => e.outcome === o).length;

  return (
    <div className="space-y-8">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Verification log</h1>
        <p className="max-w-3xl text-stone-600">
          What we checked, what turned out to be wrong, and what we could not verify. Two layers: an <b>automatic check</b> on every guide (each quoted
          docs claim is string-matched against the page it cites) and a <b>manual ledger</b> of material claims checked against official docs and setup
          attempts.
        </p>
      </header>

      <section>
        <h2 className="mb-2 text-lg font-semibold">Automatic quote checks, per guide</h2>
        <div className="overflow-x-auto rounded-xl border border-stone-200 bg-white">
          <table className="w-full text-left text-sm">
            <thead className="bg-stone-50 text-xs uppercase tracking-wide text-stone-500">
              <tr><th className="p-3">Guide</th><th className="p-3">Origin</th><th className="p-3">Claims</th><th className="p-3">Docs quotes verified</th><th className="p-3">Downgraded to Unknown</th><th className="p-3">Unknown claims</th></tr>
            </thead>
            <tbody>
              {guides.map((g) => (
                <tr key={g.slug} className="border-t border-stone-100">
                  <td className="p-3"><Link className="text-violet-700 hover:underline" href={`/guides/${g.slug}`}>{g.guide.app.name}</Link></td>
                  <td className="p-3">{g.meta.origin}</td>
                  <td className="p-3">{g.guide.claims.length}</td>
                  <td className="p-3">{g.meta.verification.quotes_verified}/{g.meta.verification.quotes_checked}</td>
                  <td className="p-3">{g.meta.verification.downgraded}</td>
                  <td className="p-3">{g.guide.claims.filter((c) => c.label === "unknown").length}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2 className="mb-1 text-lg font-semibold">Manual ledger</h2>
        {ledger ? (
          <>
            <p className="mb-3 text-sm text-stone-500">
              {entries.length} material claims · {count("confirmed")} confirmed · {count("corrected")} corrected · {count("unverifiable")} unverifiable · {count("pending")} pending · updated {ledger.updated}. {ledger.note}
            </p>
            <ul className="space-y-2">
              {entries.map((e) => (
                <li key={e.id} className="rounded-lg border border-stone-200 bg-white p-3 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs text-stone-400">{e.id}</span>
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${OUTCOME[e.outcome]}`}>{e.outcome}</span>
                    <span className="text-xs text-stone-500">{e.app} · from {e.origin.replace("_", " ")}</span>
                  </div>
                  <p className="mt-1 text-stone-500">Claimed: <span className="text-stone-700">{e.claim}</span></p>
                  <p className="mt-1">Found: {e.finding}</p>
                  <p className="mt-1 text-xs text-stone-500">How checked: {e.check}{e.evidence_url && <> · <a className="break-all text-violet-700 hover:underline" href={e.evidence_url} target="_blank" rel="noreferrer">{e.evidence_url}</a></>}</p>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="text-sm text-stone-500">No ledger file yet.</p>
        )}
      </section>

      {ledger && ledger.hands_on.length > 0 && (
        <section>
          <h2 className="mb-2 text-lg font-semibold">Hands-on setup attempts</h2>
          <ul className="space-y-2">
            {ledger.hands_on.map((h) => (
              <li key={h.provider} className="rounded-lg border border-stone-200 bg-white p-3 text-sm">
                <span className={`mr-2 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${OUTCOME[h.status === "done" ? "confirmed" : "pending"]}`}>{h.status}</span>
                <b>{h.provider}</b>: {h.what}
                {h.result && <p className="mt-1 text-stone-600">{h.result}</p>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
