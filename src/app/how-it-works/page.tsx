import { LABEL_INFO } from "@/lib/evidence";

export default function HowItWorks() {
  return (
    <div className="max-w-3xl space-y-10 leading-relaxed text-muted">
      <header>
        <h1 className="text-3xl font-semibold tracking-tight text-ink sm:text-4xl">How it works</h1>
        <p className="mt-3 text-lg">
          Composio&apos;s managed OAuth apps cover prototyping. Production (your own name on the consent screen, your own quota, extra scopes) and every
          bring-your-own app means creating a provider OAuth app and getting it approved. That path differs by provider and by setup, and is rarely written down in
          one place.
        </p>
      </header>

      <section className="space-y-2">
        <h2 className="text-xl font-semibold tracking-tight text-ink">The chain</h2>
        <p>
          <b className="text-ink">1 provider OAuth app</b> → <b className="text-ink">1 Composio auth config</b> → <b className="text-ink">many connected accounts</b>, one
          per end user. Approval doesn&apos;t connect anyone; each user still clicks Allow.
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="text-xl font-semibold tracking-tight text-ink">What the agent does</h2>
        <ol className="list-decimal space-y-2 pl-5 marker:font-mono marker:text-faint">
          <li>
            <b className="text-ink">Checks Composio:</b> managed app or bring your own, known errors, Composio&apos;s setup guide.
          </li>
          <li>
            <b className="text-ink">Names the provider</b> it found, so a wrong match is obvious. Ambiguous names get a &ldquo;did you mean&rdquo;.
          </li>
          <li>
            <b className="text-ink">Reads the official docs</b> against a checklist: limits before approval, pricing, review and timelines, redirect-domain rules,
            customer-side restrictions, current vs legacy platform.
          </li>
          <li>
            <b className="text-ink">Writes the guide:</b> setups, your time vs provider wait, steps with owners, traps, blockers, and a claim for every fact.
          </li>
          <li>
            <b className="text-ink">Checks the evidence in code:</b> each docs quote must appear word for word on an official page and contain the claim&apos;s numbers.
            Anything else is flagged.
          </li>
        </ol>
        <p className="text-sm text-faint">Research stops at about 2.5 minutes and writes from what it found rather than timing out.</p>
      </section>

      <section className="space-y-2">
        <h2 className="text-xl font-semibold tracking-tight text-ink">Evidence labels</h2>
        <ul className="space-y-1">
          {Object.values(LABEL_INFO).map((i) => (
            <li key={i.name}>
              {i.icon} <b className="text-ink">{i.name}</b>: {i.meaning}
            </li>
          ))}
        </ul>
        <p className="text-sm text-faint">Only a recorded setup attempt can make a claim 🧪 Tested. So far: Slack, where an agent created the app and the Composio auth config and a human only clicked Allow.</p>
      </section>

      <section className="space-y-2">
        <h2 className="text-xl font-semibold tracking-tight text-ink">Limitations</h2>
        <ul className="list-disc space-y-2 pl-5 marker:text-faint">
          <li>Guides are dated research aids. Providers change their rules.</li>
          <li>No guide is human-reviewed yet, and only Slack has been hands-on tested.</li>
          <li>The agent can&apos;t see behind developer-console logins.</li>
          <li>Review timelines are rarely published; when missing, guides say so instead of guessing.</li>
        </ul>
      </section>
    </div>
  );
}
