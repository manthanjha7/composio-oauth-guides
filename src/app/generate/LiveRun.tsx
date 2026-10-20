"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Badge } from "@/components/badges";
import type { AgentEvent } from "@/lib/agent/run";

/** `at`: wall-clock ms when received; `rt`: recorded seconds (replays only). */
type Ev = AgentEvent & { at: number; rt?: number };
type Status = "connecting" | "running" | "done" | "error" | "ambiguous" | "not_oauth" | "unavailable";

const PHASES = [
  { id: "composio", label: "Composio check" },
  { id: "identify", label: "Identify" },
  { id: "research", label: "Read docs" },
  { id: "probe", label: "Probe" },
  { id: "write", label: "Write guide" },
  { id: "verify", label: "Check evidence" },
  { id: "save", label: "Save" },
] as const;
type PhaseId = (typeof PHASES)[number]["id"];

function phaseOf(e: AgentEvent): PhaseId | null {
  if (e.type === "composio") return "composio";
  if (e.type === "identified") return "identify";
  if (e.type === "search" || e.type === "fetch") return "research";
  if (e.type === "probe") return "probe";
  if (e.type === "verify" || e.type === "cost") return "verify";
  if (e.type === "done") return "save";
  if (e.type === "stage") {
    const map: Record<string, PhaseId | null> = { start: null, composio: "composio", identify: "identify", research: "research", probe: "probe", write: "write", verify: "verify", save: "save" };
    return map[e.stage] ?? null;
  }
  return null;
}

interface Replay {
  query: string;
  recorded_at: string;
  note: string;
  events: { t: number; event: AgentEvent }[];
}

export function LiveRun() {
  const params = useSearchParams();
  const router = useRouter();
  const replayName = params.get("replay");
  const fresh = params.get("fresh") === "1";
  const [q, setQ] = useState(params.get("q") ?? "");
  const [events, setEvents] = useState<Ev[]>([]);
  const [status, setStatus] = useState<Status>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [replay, setReplay] = useState<Replay | null>(null);
  const [speed, setSpeed] = useState(4);
  const [virtual, setVirtual] = useState(0); // replay clock, in recorded seconds
  const [endedAt, setEndedAt] = useState<number | null>(null);
  const speedRef = useRef(speed);
  const [started, setStarted] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    speedRef.current = speed;
  }, [speed]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    // Start on the next tick and cancel in cleanup: React's dev double-invoke then yields exactly one run
    // (one API request), instead of a duplicate or an aborted-and-never-restarted one.
    const ctrl = new AbortController();
    let cancelled = false;
    // Terminal states also freeze the elapsed clock.
    const stop = (st: Status) => {
      setStatus(st);
      setEndedAt((t) => t ?? Date.now());
    };
    const handle = (e: AgentEvent, at: number, rt?: number) => {
      setEvents((xs) => [...xs, { ...e, at, rt }]);
      if (e.type === "done") {
        stop("done");
      } else if (e.type === "error") {
        setError(e.message);
        stop("error");
      } else if (e.type === "ambiguous") stop("ambiguous");
      else if (e.type === "not_oauth") stop("not_oauth");
      else setStatus((s) => (s === "connecting" ? "running" : s));
    };

    // Replay: a recorded real run, played back in the browser with no model calls.
    const runReplay = () =>
      (async () => {
        const res = await fetch(`/replays/${encodeURIComponent(replayName ?? "")}.json`, { signal: ctrl.signal });
        if (!res.ok) {
          setError("Recorded run not found.");
          stop("error");
          return;
        }
        const data = (await res.json()) as Replay;
        setReplay(data);
        setQ(data.query);
        const t0 = Date.now();
        setStarted(t0);
        let clock = 0; // seconds of recorded time already played
        let last = Date.now();
        for (const item of data.events) {
          while (clock < item.t) {
            if (ctrl.signal.aborted) return;
            await new Promise((r) => setTimeout(r, 100));
            const n = Date.now();
            clock = Math.min(item.t, clock + ((n - last) / 1000) * speedRef.current);
            last = n;
            setVirtual(clock);
          }
          handle(item.event, t0, item.t);
        }
      })().catch((e) => {
        if ((e as Error).name !== "AbortError") {
          setError((e as Error).message);
          stop("error");
        }
      });

    const query = params.get("q") ?? "";
    const runLive = () =>
      (async () => {
      try {
        const res = await fetch("/api/generate", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ query, fresh }),
          signal: ctrl.signal,
        });
        if (!(res.headers.get("content-type") ?? "").includes("text/event-stream")) {
          const json = (await res.json()) as { existing?: string; error?: string };
          if (json.existing) {
            router.replace(`/guides/${json.existing}`);
            return;
          }
          setError(json.error ?? `Request failed (${res.status})`);
          stop(res.status === 503 ? "unavailable" : "error");
          return;
        }
        setStatus("running");
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
            if (["done", "error", "ambiguous", "not_oauth"].includes(e.type)) finished = true;
            handle(e, Date.now());
          }
        }
        if (!finished) {
          setError("The connection closed before the guide was finished.");
          stop("error");
        }
      } catch (e) {
        if ((e as Error).name !== "AbortError") {
          setError((e as Error).message);
          stop("error");
        }
      }
    })();

    const timer = setTimeout(() => {
      if (cancelled) return;
      if (replayName) runReplay();
      else if (query) runLive();
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [replayName, params, fresh, router]);

  if (!q && !replayName) {
    return (
      <p className="text-muted">
        Type an app name on the{" "}
        <Link className="text-accent hover:underline" href="/">
          home page
        </Link>
        .
      </p>
    );
  }

  const find = <T extends AgentEvent["type"]>(t: T) => events.find((e) => e.type === t) as Extract<Ev, { type: T }> | undefined;
  const identified = find("identified");
  const composio = find("composio");
  const verify = find("verify");
  const ambiguous = find("ambiguous");
  const notOauth = find("not_oauth");
  const done = find("done");
  const running = status === "running" || status === "connecting";
  const elapsed = replay ? Math.round(virtual) : Math.max(0, Math.round(((running ? now : (endedAt ?? now)) - started) / 1000));

  // Phase status: done if a later phase has started; active = latest seen.
  const seen = events.map(phaseOf).filter((p): p is PhaseId => !!p);
  const latest = seen.at(-1);
  const latestIdx = latest ? PHASES.findIndex((p) => p.id === latest) : -1;
  const phaseState = (i: number) => (status === "done" || i < latestIdx ? "done" : i === latestIdx && running ? "active" : i === latestIdx ? "done" : "pending");

  const writing = running && latest === "write";
  const writeEv = events.find((e) => e.type === "stage" && e.stage === "write");
  const writeSecs = writeEv ? (writeEv.rt !== undefined ? Math.round(virtual - writeEv.rt) : Math.round((now - writeEv.at) / 1000)) : 0;
  const pagesRead = events.filter((e) => e.type === "fetch" && e.ok).length;
  const searches = events.filter((e) => e.type === "search").length;
  const probes = events.filter((e) => e.type === "probe").length;

  return (
    <div className="space-y-8">
      {replay && (
        <div role="note" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-sky-400/30 bg-sky-500/10 px-4 py-3 text-sm text-sky-100">
          <p>
            <b>Recorded run</b> ({replay.recorded_at}). {replay.note}
          </p>
          <div className="flex items-center gap-1" role="group" aria-label="Playback speed">
            {[1, 4, 16].map((s) => (
              <button
                key={s}
                onClick={() => setSpeed(s)}
                aria-pressed={speed === s}
                className={`rounded-md px-2 py-1 font-mono text-xs ring-1 ring-inset ${speed === s ? "bg-sky-200 text-bg ring-sky-200" : "ring-sky-400/40 hover:bg-sky-500/20"}`}
              >
                {s}×
              </button>
            ))}
          </div>
        </div>
      )}

      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="font-mono text-xs uppercase tracking-[0.2em] text-accent">{replay ? "Recorded run" : "Live research"}</p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight">{identified?.name ?? q}</h1>
        </div>
        <div className={`flex items-center gap-2 font-mono text-sm text-muted ${status === "unavailable" ? "hidden" : ""}`} aria-live="off">
          {running && <span aria-hidden className="pulse-dot h-2 w-2 rounded-full bg-emerald-400" />}
          <span>{running ? "working" : status === "done" ? "finished" : "stopped"}</span>
          <span className="text-ink">{elapsed}s</span>
          {replay && <span className="text-faint">(recorded time, {speed}× speed)</span>}
        </div>
      </header>

      {/* Phase stepper */}
      {status !== "unavailable" && (
      <ol aria-label="Progress" className="scrollbar-none relative flex gap-1 overflow-x-auto">
        {PHASES.map((p, i) => {
          const st = status === "connecting" ? "pending" : phaseState(i);
          return (
            <li key={p.id} className="min-w-[110px] flex-1">
              <div className={`h-1 rounded-full ${st === "done" ? "bg-emerald-400" : st === "active" ? "pulse-dot bg-accent" : "bg-surface-3"}`} />
              <p className={`mt-2 text-xs ${st === "pending" ? "text-faint" : "text-ink"}`}>
                <span className="sr-only">{st}: </span>
                {p.label}
              </p>
            </li>
          );
        })}
      </ol>
      )}

      {/* Outcome banners */}
      <div aria-live="polite">
        {status === "done" && done && (
          <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-emerald-400/30 bg-emerald-500/10 p-5">
            <div>
              <p className="font-semibold text-emerald-200">Guide ready{done.partial ? " (incomplete: research timed out)" : ""}</p>
              {verify && (
                <p className="mt-1 text-sm text-emerald-100/80">
                  {verify.verified}/{verify.checked} quotes verified{verify.downgraded ? ` · ${verify.downgraded} flagged` : ""}
                </p>
              )}
            </div>
            <Link href={`/guides/${done.slug}`} className="rounded-lg bg-emerald-400 px-4 py-2 text-sm font-semibold text-bg hover:bg-emerald-300">
              Open the guide →
            </Link>
          </div>
        )}
        {status === "error" && (
          <div className="rounded-2xl border border-rose-400/30 bg-rose-500/10 p-5">
            <p className="font-semibold text-rose-200">Couldn&apos;t finish this guide.</p>
            <p className="mt-1 text-sm text-rose-100/80">{error}</p>
            <button onClick={() => location.reload()} className="mt-3 rounded-lg border border-rose-300/40 px-3 py-1.5 text-sm text-rose-100 hover:bg-rose-500/20">
              Try again
            </button>
          </div>
        )}
        {status === "unavailable" && (
          <div className="rounded-2xl border border-amber-400/30 bg-amber-500/10 p-5">
            <p className="font-semibold text-amber-200">{error}</p>
            <div className="mt-3 flex flex-wrap gap-2 text-sm">
              <Link href="/generate?replay=gmail" className="rounded-lg bg-amber-300 px-3 py-1.5 font-medium text-bg hover:bg-amber-200">
                Watch a recorded run (Gmail)
              </Link>
              <Link href="/" className="rounded-lg border border-amber-300/40 px-3 py-1.5 text-amber-100 hover:bg-amber-500/20">
                Browse the library
              </Link>
            </div>
          </div>
        )}
        {status === "ambiguous" && ambiguous && (
          <div className="rounded-2xl border border-amber-400/30 bg-amber-500/10 p-5">
            <p className="font-semibold text-amber-200">&ldquo;{q}&rdquo; could mean several products. Which one?</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {ambiguous.candidates.map((c) => (
                <Link key={c} href={`/generate?q=${encodeURIComponent(c)}`} className="rounded-full border border-amber-300/40 px-3 py-1 text-sm text-amber-100 hover:bg-amber-500/20">
                  {c}
                </Link>
              ))}
            </div>
          </div>
        )}
        {status === "not_oauth" && notOauth && (
          <div className="rounded-2xl border border-line-strong bg-surface p-5">
            <p className="font-semibold">No OAuth app needed (as far as the agent could tell)</p>
            <p className="mt-1 text-sm text-muted">{notOauth.message}</p>
          </div>
        )}
      </div>

      {status !== "unavailable" && (
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="min-w-0 space-y-4">
          {writing && (
            <div role="status" className="rounded-2xl border border-accent/30 bg-violet-500/[0.07] p-5">
              <div className="flex items-center gap-2">
                <span aria-hidden className="pulse-dot h-2 w-2 rounded-full bg-accent" />
                <p className="font-semibold">Writing the guide…</p>
                <span className="ml-auto font-mono text-sm text-muted">{writeSecs}s</span>
              </div>
              <p className="mt-2 text-sm text-muted">No updates for about a minute. Then every quote is checked against the pages read below.</p>
              <dl className="mt-4 grid grid-cols-3 gap-2 text-center">
                <Stat label="pages read" value={pagesRead} />
                <Stat label="searches" value={searches} />
                <Stat label="live probes" value={probes} />
              </dl>
            </div>
          )}

          <ol className="overflow-hidden rounded-2xl border border-line bg-surface font-mono text-[13px]">
            {events.length === 0 && <li className="px-4 py-3 text-faint">{status === "connecting" ? "Connecting…" : "No events."}</li>}
            {events.map((e, i) => (
              <EventRow key={i} e={e} t={e.rt ?? Math.max(0, Math.round((e.at - started) / 1000))} />
            ))}
            {running && events.length > 0 && <li className="pulse-dot px-4 py-2 text-faint">…</li>}
          </ol>
        </div>

        <aside className="space-y-3 text-sm">
          <Panel title="Researching">
            {identified ? (
              <>
                <p className="font-semibold">{identified.name}</p>
                <p className="mt-1 break-all font-mono text-xs text-muted">{identified.website}</p>
                {identified.docs && (
                  <a href={identified.docs} target="_blank" rel="noreferrer" className="mt-1 block break-all font-mono text-xs text-accent hover:underline">
                    {identified.docs} ↗
                  </a>
                )}
                {identified.oauth !== "yes" && (
                  <p className="mt-2 text-xs text-muted">
                    OAuth for other apps: <span className="text-ink">{identified.oauth}</span>
                  </p>
                )}
                {!replay && (
                  <p className="mt-2 text-xs text-faint">
                    Not what you meant?{" "}
                    <Link href="/" className="text-accent hover:underline">
                      Search again with a website
                    </Link>
                  </p>
                )}
              </>
            ) : (
              <p className="text-faint">{running ? "Identifying the provider…" : "—"}</p>
            )}
          </Panel>
          <Panel title="Composio">
            {composio ? (
              <div className="space-y-1">
                <Badge tone={composio.managed === "yes" ? "accent" : composio.managed === "no" ? "solid" : "neutral"}>
                  {composio.managed === "yes" ? "Composio-managed app" : composio.managed === "no" ? "Bring your own app" : composio.managed === "not_in_composio" ? "Not in Composio" : "Unknown"}
                </Badge>
                {composio.slug && <p className="font-mono text-xs text-muted">toolkit {composio.slug}</p>}
                {composio.guide && (
                  <a href={composio.guide} target="_blank" rel="noreferrer" className="block text-xs text-accent hover:underline">
                    Composio credential guide ↗
                  </a>
                )}
              </div>
            ) : (
              <p className="text-faint">{running ? "Checking…" : "—"}</p>
            )}
          </Panel>
          <Panel title="What happens">
            <p className="text-muted">Reads Composio and provider docs, tests the OAuth endpoint, writes the guide. Claims it can&apos;t back with a quote are flagged.</p>
          </Panel>
        </aside>
      </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-line bg-surface p-2">
      <dd className="font-mono text-xl text-ink">{value}</dd>
      <dt className="text-xs text-faint">{label}</dt>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <p className="mb-2 font-mono text-[11px] uppercase tracking-wider text-faint">{title}</p>
      {children}
    </div>
  );
}

function host(url: string) {
  try {
    const u = new URL(url);
    return u.hostname + (u.pathname.length > 1 ? u.pathname.replace(/\/$/, "") : "");
  } catch {
    return url;
  }
}

/** Prefer the decoded provider error over a long redirect URL. */
function probeSummary(observation: string): string {
  const decoded = observation.match(/Decoded error in redirect: "([^"]+)"/);
  if (decoded) return `Provider says: "${decoded[1].trim()}"`;
  return observation.length > 200 ? `${observation.slice(0, 200)}…` : observation;
}

function EventRow({ e, t }: { e: Ev; t: number }) {
  const row = (icon: string, body: React.ReactNode, tone = "text-ink/90") => (
    <li className={`flex gap-3 border-b border-line/60 px-4 py-2 last:border-0 ${tone}`}>
      <span className="w-10 shrink-0 text-right text-faint">{t}s</span>
      <span aria-hidden className="w-5 shrink-0 text-center">
        {icon}
      </span>
      <div className="min-w-0 flex-1 break-words">{body}</div>
    </li>
  );
  switch (e.type) {
    case "stage":
      return e.stage === "start" ? row("▸", e.message, "text-muted") : row("▸", <span className="font-sans font-medium">{e.message}</span>);
    case "identified":
      return row("🎯", <>Identified {e.name}{e.website ? ` (${host(e.website)})` : ""}{e.oauth !== "yes" ? ` · OAuth: ${e.oauth}` : ""}</>);
    case "composio":
      return row("🟣", <>Composio: {e.managed === "yes" ? "managed app available" : e.managed === "no" ? "bring your own app" : e.managed === "not_in_composio" ? "not in catalog" : "status unknown"}</>);
    case "search":
      return row(
        "🔍",
        <>
          Searched &ldquo;{e.query}&rdquo; <span className="text-faint">via {e.via}</span>
          <ul className="mt-1 space-y-0.5 text-xs text-muted">
            {e.results.map((r) => (
              <li key={r.url} className="truncate">
                ↳ {r.title} <span className="text-faint">{host(r.url).split("/")[0]}</span>
              </li>
            ))}
          </ul>
        </>,
      );
    case "fetch":
      return e.ok
        ? row("📄", <>Read <a className="text-accent hover:underline" href={e.url} target="_blank" rel="noreferrer">{host(e.url)}</a> <span className="text-faint">({Math.round(e.chars / 1000)}k chars)</span></>)
        : row("⚠", <>Couldn&apos;t read {host(e.url)}: {e.error}</>, "text-amber-200");
    case "probe":
      return row(
        "🔎",
        <>
          Tested {host(e.url).slice(0, 60)}… → <span className="text-sky-300">{e.status ?? "no response"}</span>
          <div className="mt-0.5 text-xs text-muted">{probeSummary(e.observation)}</div>
        </>,
      );
    case "note":
      return row("💭", e.text, "text-muted");
    case "verify":
      return row("✅", <>{e.verified}/{e.checked} quotes verified{e.downgraded ? ` · ${e.downgraded} flagged` : ""}</>, "text-emerald-200");
    case "cost":
      return row("💲", <>Cost ~${e.usd.toFixed(2)}</>, "text-muted");
    case "warning":
      return row("⚠", e.message, "text-amber-200");
    case "error":
      return row("✖", e.message, "text-rose-300");
    case "done":
      return row("🎉", <>Saved{e.partial ? " (partial)" : ""} → /guides/{e.slug}</>, "text-emerald-200");
    default:
      return null;
  }
}
