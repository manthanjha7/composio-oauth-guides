"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { LiveStatus } from "@/lib/live-status";

const EXAMPLES = ["Asana", "Linear", "Intercom", "DocuSign"];

export function GenerateBox({ status }: { status: LiveStatus }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const disabled = !status.available;
  const go = (value: string) => {
    const v = value.trim();
    if (!disabled && v.length >= 2) router.push(`/generate?q=${encodeURIComponent(v)}`);
  };
  return (
    <div className="rounded-2xl border border-line bg-surface p-2 shadow-[0_0_0_1px_rgba(0,0,0,0.2),0_20px_60px_-30px_rgba(139,92,246,0.35)]">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          go(q);
        }}
        className="flex flex-col gap-2 sm:flex-row"
      >
        <label htmlFor="app-query" className="sr-only">
          App name or website
        </label>
        <input
          id="app-query"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          disabled={disabled}
          placeholder="App name or website, e.g. Asana or asana.com"
          aria-describedby="generate-hint"
          className="w-full rounded-xl border border-transparent bg-surface-2 px-4 py-3 text-base text-ink placeholder:text-faint outline-none focus:border-accent/60 disabled:cursor-not-allowed disabled:opacity-60"
        />
        <button
          type="submit"
          disabled={disabled || q.trim().length < 2}
          className="whitespace-nowrap rounded-xl bg-accent-strong px-5 py-3 font-medium text-white transition hover:bg-violet-600 disabled:cursor-not-allowed disabled:bg-surface-3 disabled:text-faint"
        >
          Generate guide
        </button>
      </form>
      <div id="generate-hint" className="px-2 pb-1 pt-2 text-sm text-muted">
        {disabled ? (
          <p>
            <span className="text-amber-300">{status.reason}</span>{" "}
            <Link href="/generate?replay=gmail" className="text-accent underline-offset-2 hover:underline">
              Watch a recorded run of the agent →
            </Link>
          </p>
        ) : (
          <p>
            Not in the library? An agent researches it live (about 1–2 minutes) and you get a shareable guide. Try:{" "}
            {EXAMPLES.map((x, i) => (
              <span key={x}>
                <button type="button" onClick={() => go(x)} className="text-accent underline-offset-2 hover:underline">
                  {x}
                </button>
                {i < EXAMPLES.length - 1 ? ", " : ""}
              </span>
            ))}
          </p>
        )}
      </div>
    </div>
  );
}
