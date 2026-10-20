"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { AgentEvent } from "@/lib/agent/run";

type Ev = AgentEvent & { at: number };

export function LiveRun() {
  const params = useSearchParams();
  const router = useRouter();
  const q = params.get("q") ?? "";
  const fresh = params.get("fresh") === "1";
  const [events, setEvents] = useState<Ev[]>([]);
  const [status, setStatus] = useState<"running" | "done" | "error" | "ambiguous" | "not_oauth">("running");
  const [error, setError] = useState<string | null>(null);
  const [slug, setSlug] = useState<string | null>(null);
  const [started] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  const ran = useRef(false);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (ran.current || !q) return;
    ran.current = true;
    const ctrl = new AbortController();
    (async () => {
      try {
        const res = await fetch("/api/generate", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ query: q, fresh }),
          signal: ctrl.signal,
        });
        const ct = res.headers.get("content-type") ?? "";
        if (!ct.includes("text/event-stream")) {
          const json = (await res.json()) as { existing?: string; error?: string };
          if (json.existing) {
            router.replace(`/guides/${json.existing}`);
            return;
          }
          setError(json.error ?? `Request failed (${res.status})`);
          setStatus("error");
          return;
        }
        const reader = res.body!.getReader();
        const dec = new TextDecoder();
        let buf = "";
        let finished = false;
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const chunks = buf.split("\n\n");
          buf = chunks.pop() ?? "";
          for (const chunk of chunks) {
            const line = chunk.split("\n").find((l) => l.startsWith("data: "));
            if (!line) continue;
            const e = JSON.parse(line.slice(6)) as AgentEvent;
            setEvents((xs) => [...xs, { ...e, at: Date.now() }]);
            if (e.type === "done") {
              finished = true;
              setSlug(e.slug);
              setStatus("done");
            } else if (e.type === "error") {
              finished = true;
              setError(e.message);
              setStatus("error");
            } else if (e.type === "ambiguous") {
              finished = true;
              setStatus("ambiguous");
            } else if (e.type === "not_oauth") {
              finished = true;
              setStatus("not_oauth");
            }
          }
        }
        if (!finished) {
          setError("The connection closed before the guide was finished. Try again.");
          setStatus("error");
        }
      } catch (e) {
        if ((e as Error).name !== "AbortError") {
          setError((e as Error).message);
          setStatus("error");
        }
      }
    })();
    return () => ctrl.abort();
  }, [q, fresh, router]);

  if (!q) return <p>Type an app name on the <Link className="text-violet-700 underline" href="/">home page</Link>.</p>;

  const identified = events.find((e) => e.type === "identified") as Extract<AgentEvent, { type: "identified" }> | undefined;
  const composio = events.find((e) => e.type === "composio") as Extract<AgentEvent, { type: "composio" }> | undefined;
  const verify = events.find((e) => e.type === "verify") as Extract<AgentEvent, { type: "verify" }> | undefined;
  const ambiguous = events.find((e) => e.type === "ambiguous") as Extract<AgentEvent, { type: "ambiguous" }> | undefined;
  const notOauth = events.find((e) => e.type === "not_oauth") as Extract<AgentEvent, { type: "not_oauth" }> | undefined;
  const elapsed = Math.round(((status === "running" ? now : (events.at(-1)?.at ?? now)) - started) / 1000);

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm text-stone-500">Live research</p>
        <h1 className="text-2xl font-semibold tracking-tight">
          {identified ? identified.name : q}
          <span className="ml-3 align-middle text-sm font-normal text-stone-500">
            {status === "running" ? `working… ${elapsed}s` : `${elapsed}s`}
          </span>
        </h1>
        {identified && (
          <p className="mt-1 text-sm text-stone-600">
            Researching <b>{identified.name}</b>
            {identified.website && <> · {identified.website}</>}
            {identified.docs && <> · docs: <a className="text-violet-700 underline" href={identified.docs} target="_blank" rel="noreferrer">{identified.docs}</a></>}
            {" "}· OAuth for third-party apps: <b>{identified.oauth}</b>. Not what you meant? <Link className="text-violet-700 underline" href="/">Search again</Link> with a website.
          </p>
        )}
      </div>

      {status === "done" && slug && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4">
          <p className="font-medium text-emerald-900">Guide ready{verify ? `: ${verify.verified} of ${verify.checked} quoted claims verified against the source pages, ${verify.downgraded} downgraded to Unknown` : ""}.</p>
          <Link href={`/guides/${slug}`} className="mt-2 inline-block rounded-lg bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800">
            Open the guide →
          </Link>
        </div>
      )}
      {status === "error" && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-rose-900">
          <p className="font-medium">Couldn&apos;t finish this guide.</p>
          <p className="text-sm">{error}</p>
        </div>
      )}
      {status === "ambiguous" && ambiguous && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
          <p className="font-medium">&quot;{q}&quot; could mean several products. Which one?</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {ambiguous.candidates.map((c) => (
              <a key={c} href={`/generate?q=${encodeURIComponent(c)}`} className="rounded-full bg-white px-3 py-1 text-sm ring-1 ring-amber-300 hover:bg-amber-100">
                {c}
              </a>
            ))}
          </div>
        </div>
      )}
      {status === "not_oauth" && notOauth && (
        <div className="rounded-xl border border-stone-200 bg-white p-4">
          <p className="font-medium">No OAuth app needed (as far as the agent could tell)</p>
          <p className="text-sm text-stone-600">{notOauth.message}</p>
        </div>
      )}

      <div className="grid gap-6 md:grid-cols-[1fr_260px]">
        <ol className="space-y-2">
          {events.map((e, i) => (
            <EventRow key={i} e={e} t={Math.round((e.at - started) / 1000)} />
          ))}
          {status === "running" && <li className="animate-pulse text-sm text-stone-400">…</li>}
        </ol>
        <aside className="space-y-3 text-sm">
          <div className="rounded-lg border border-stone-200 bg-white p-3">
            <p className="text-xs uppercase tracking-wide text-stone-400">Composio</p>
            {composio ? (
              <p className="mt-1">
                Managed OAuth app: <b>{composio.managed}</b>
                {composio.slug && <> · toolkit <code>{composio.slug}</code></>}
                {composio.guide && <> · <a className="text-violet-700 underline" href={composio.guide} target="_blank" rel="noreferrer">credential guide</a></>}
              </p>
            ) : (
              <p className="mt-1 text-stone-400">checking…</p>
            )}
          </div>
          <div className="rounded-lg border border-stone-200 bg-white p-3 text-stone-600">
            <p className="text-xs uppercase tracking-wide text-stone-400">What happens</p>
            <p className="mt-1">The agent reads Composio&apos;s docs and the provider&apos;s official docs, probes the live OAuth endpoint, then writes the guide. Code then checks every quoted claim against the pages it actually read; anything it can&apos;t confirm is marked Unknown.</p>
          </div>
        </aside>
      </div>
    </div>
  );
}

function EventRow({ e, t }: { e: Ev; t: number }) {
  const time = <span className="w-10 shrink-0 font-mono text-xs text-stone-400">{t}s</span>;
  const row = (icon: string, body: React.ReactNode, tone = "text-stone-700") => (
    <li className={`flex gap-3 text-sm ${tone}`}>
      {time}
      <span className="w-5 shrink-0">{icon}</span>
      <div className="min-w-0 flex-1">{body}</div>
    </li>
  );
  switch (e.type) {
    case "stage":
      return row("▸", <b>{e.message}</b>);
    case "identified":
      return row("🎯", <>Identified <b>{e.name}</b>{e.website ? ` (${e.website})` : ""}</>);
    case "composio":
      return row("🟣", <>Composio: managed app <b>{e.managed}</b>{e.slug ? `, toolkit ${e.slug}` : ""}</>);
    case "search":
      return row(
        "🔍",
        <>
          Searched <q>{e.query}</q> <span className="text-stone-400">via {e.via}</span>
          <ul className="mt-1 space-y-0.5 text-xs text-stone-500">
            {e.results.map((r) => (
              <li key={r.url} className="truncate">↳ {r.title} <span className="text-stone-400">{new URL(r.url).hostname}</span></li>
            ))}
          </ul>
        </>,
      );
    case "fetch":
      return e.ok
        ? row("📄", <>Read <a className="break-all text-violet-700 hover:underline" href={e.url} target="_blank" rel="noreferrer">{e.url}</a> <span className="text-stone-400">({Math.round(e.chars / 1000)}k chars, {e.via})</span></>)
        : row("⚠️", <>Couldn&apos;t read <span className="break-all">{e.url}</span>: {e.error}</>, "text-amber-700");
    case "probe":
      return row("🔎", <>Probed <span className="break-all">{e.url}</span> → <b>{e.status ?? "no response"}</b><div className="text-xs text-stone-500">{e.observation}</div></>);
    case "note":
      return row("💭", <span className="text-stone-500">{e.text}</span>);
    case "verify":
      return row("✅", <>Evidence check: {e.verified}/{e.checked} quotes found on the source pages · {e.downgraded} claims downgraded to Unknown · {e.total} claims total</>);
    case "warning":
      return row("⚠️", e.message, "text-amber-700");
    case "error":
      return row("✖", e.message, "text-rose-700");
    case "done":
      return row("🎉", <>Saved{e.partial ? " (partial: research hit its time budget)" : ""}</>);
    default:
      return null;
  }
}
