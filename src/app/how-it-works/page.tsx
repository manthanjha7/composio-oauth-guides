import { LABEL_INFO } from "@/lib/evidence";

export default function HowItWorks() {
  return (
    <div className="max-w-3xl space-y-8 text-stone-700">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-stone-900">How it works</h1>
        <p className="mt-2">
          A developer building on Composio wants their users to connect App X. Composio&apos;s managed OAuth apps cover prototyping for many apps, but
          production (your own name on the consent screen, your own quota, extra scopes) and every bring-your-own toolkit means creating a provider OAuth
          app and getting it approved. That process differs per provider and per scenario, and is rarely written down in one place. These guides fill
          that gap.
        </p>
      </header>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold text-stone-900">The chain to keep in mind</h2>
        <p>
          <b>1 provider OAuth app</b> (client ID/secret, redirect URI, scopes, consent screen) → <b>1 Composio auth config</b> → <b>many connected accounts</b>,
          one per end user. Approving the app connects nobody; each user still clicks Allow.
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold text-stone-900">What the agent does when you submit an app</h2>
        <ol className="list-decimal space-y-1 pl-5">
          <li><b>Composio check:</b> reads Composio&apos;s managed-auth directory, the toolkit page&apos;s header and FAQ, and the composio.dev/auth credential guide (and the toolkit API when a key is configured).</li>
          <li><b>Identify:</b> states which provider it is researching, with website and docs URL, so a wrong match is visible immediately. Ambiguous names get a &quot;did you mean&quot;.</li>
          <li><b>Research:</b> searches (Composio Search toolkit via a Composio session; Anthropic web search as a fallback) and reads official docs. Budgets: about 5 searches and 8 page reads.</li>
          <li><b>Probe:</b> sends a request to the provider&apos;s real OAuth authorize endpoint with a dummy client and records what comes back (e.g. Google: &quot;invalid_client: The OAuth client was not found&quot;).</li>
          <li><b>Write:</b> fills a fixed guide schema (structured output): scenarios, time split, steps with owners, traps, blockers, claims.</li>
          <li><b>Check:</b> code (not the model) verifies every docs claim&apos;s quote appears verbatim in a page the agent actually read. Failures are downgraded to Unknown, with a note.</li>
          <li><b>Save, then link:</b> the share link is shown only after the guide is saved and read back.</li>
        </ol>
        <p className="text-sm text-stone-500">Research stops itself at about 150 seconds and writes a partial guide rather than timing out.</p>
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold text-stone-900">Evidence labels</h2>
        <ul className="space-y-1">
          {Object.values(LABEL_INFO).map((i) => (
            <li key={i.name}><b>{i.icon} {i.name}</b>: {i.meaning}</li>
          ))}
        </ul>
        <p className="text-sm text-stone-500">The agent can never award itself Tested. That label only comes from a recorded human or agent-driven setup attempt.</p>
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold text-stone-900">Key decisions</h2>
        <ul className="list-disc space-y-1 pl-5">
          <li><b>Live research, not a pre-built docs dataset.</b> Unfamiliar apps must work, and docs go stale. The library is simply agent output that a human has checked.</li>
          <li><b>Verdict per scenario, not per app.</b> Gmail is easy for an internal tool and hard for a server-side agent that reads inboxes.</li>
          <li><b>Hands-on time and waiting time are separate.</b> &quot;1 hour of work + weeks of review&quot; is a different plan from &quot;a week of work&quot;.</li>
          <li><b>Step owners.</b> 🤖 an agent can do it (drafts, manifests, checks), 👤 you must (logins, legal, payment, submitting), ⏳ waiting on the provider.</li>
          <li><b>Built on Composio&apos;s stack.</b> Composio Search for research, Composio&apos;s docs and API for managed-app status, and links to Composio&apos;s credential walkthroughs instead of rewriting them.</li>
        </ul>
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold text-stone-900">Limitations</h2>
        <ul className="list-disc space-y-1 pl-5">
          <li>Guides are research aids, dated, and can go stale. Re-run the agent to refresh.</li>
          <li>The agent can&apos;t log in to developer consoles, so it can&apos;t observe what&apos;s behind login walls; those parts come from docs or human attempts.</li>
          <li>Review timelines are rarely published; when they aren&apos;t, the guide says Unknown rather than guessing.</li>
          <li>JavaScript-only docs pages may be unreadable to the direct fetcher (the Composio fetch tool is the fallback).</li>
        </ul>
      </section>
    </div>
  );
}
