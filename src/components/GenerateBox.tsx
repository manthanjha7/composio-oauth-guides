"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function GenerateBox({ examples }: { examples: string[] }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const go = (value: string) => {
    const v = value.trim();
    if (v.length >= 2) router.push(`/generate?q=${encodeURIComponent(v)}`);
  };
  return (
    <div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          go(q);
        }}
        className="flex gap-2"
      >
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="App name or website, e.g. Calendly or calendly.com"
          className="w-full rounded-lg border border-stone-300 bg-white px-4 py-3 text-base shadow-sm outline-none focus:border-violet-500 focus:ring-2 focus:ring-violet-200"
          aria-label="App name or website"
        />
        <button type="submit" className="whitespace-nowrap rounded-lg bg-violet-600 px-5 py-3 font-medium text-white shadow-sm hover:bg-violet-700">
          Generate guide
        </button>
      </form>
      <p className="mt-2 text-sm text-stone-500">
        Not in the library? An agent researches it live (about 1–3 minutes) and you get a shareable guide.{" "}
        {examples.length > 0 && (
          <>
            Try:{" "}
            {examples.map((x, i) => (
              <span key={x}>
                <button onClick={() => go(x)} className="text-violet-700 underline-offset-2 hover:underline">
                  {x}
                </button>
                {i < examples.length - 1 ? ", " : ""}
              </span>
            ))}
          </>
        )}
      </p>
    </div>
  );
}
