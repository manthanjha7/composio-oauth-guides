/**
 * Scores a round of category runs (no model calls).
 *   npx tsx scripts/eval-categories.mts <suffix>      e.g. "mirror-c1" for eval/runs/<app>-mirror-c1-v2.json
 * Per app: outcome, path (any confirmed scenario path in the expected set), modifiers present, must-have facts.
 */
import { existsSync, readFileSync } from "node:fs";

type Case = { app: string; category: string; outcome?: string; path?: string[]; modifiers?: string[]; must?: [string, string][] };
const { apps } = JSON.parse(readFileSync("eval/categories.json", "utf8")) as { apps: Case[] };
const suffix = process.argv[2] ? `-${process.argv[2]}` : "";
const slug = (a: string) => a.toLowerCase().replace(/[^a-z0-9]+/g, "-");

let pass = 0;
const totals = { path: [0, 0], mods: [0, 0], must: [0, 0] };
for (const c of apps) {
  const f = `eval/runs/${slug(c.app)}${suffix}-v2.json`;
  if (!existsSync(f)) {
    console.log(`- ${c.app.padEnd(13)} [${c.category}] NOT RUN`);
    continue;
  }
  const r = JSON.parse(readFileSync(f, "utf8"));
  const lines: string[] = [];
  let ok = true;
  if (c.outcome) {
    const got = r.outcome ?? (r.guide ? "ok" : "?");
    ok = got === c.outcome;
    lines.push(`outcome ${got} ${ok ? "✓" : `✗ (expected ${c.outcome})`}`);
  } else if (!r.guide) {
    ok = false;
    lines.push(`outcome ${r.outcome}: ${String(r.message ?? "").slice(0, 80)} ✗`);
  } else {
    const g = r.guide;
    const paths = g.scenarios.map((s: { path?: string; path_basis?: string }) => (s.path ? `${s.path}${s.path_basis === "inferred" ? "*" : ""}` : "—"));
    const pathOk = !c.path || g.scenarios.some((s: { path?: string }) => s.path && c.path!.includes(s.path));
    if (c.path) {
      totals.path[1]++;
      if (pathOk) totals.path[0]++;
    }
    const kinds = new Set(g.scenarios.flatMap((s: { modifiers?: { kind: string }[] }) => (s.modifiers ?? []).map((m) => m.kind)));
    const modsHit = (c.modifiers ?? []).filter((m) => kinds.has(m));
    totals.mods[0] += modsHit.length;
    totals.mods[1] += (c.modifiers ?? []).length;
    const text = g.claims.filter((x: { label: string }) => x.label !== "unknown").map((x: { text: string; quote?: string }) => `${x.text} ${x.quote ?? ""}`).join(" ");
    const must = (c.must ?? []).map(([fact, re]) => ({ fact, ok: new RegExp(re, "i").test(text) }));
    totals.must[0] += must.filter((m) => m.ok).length;
    totals.must[1] += must.length;
    ok = pathOk && modsHit.length === (c.modifiers ?? []).length && must.every((m) => m.ok);
    lines.push(`paths [${paths.join(", ")}] ${pathOk ? "✓" : `✗ want ${c.path!.join("/")}`}`);
    if (c.modifiers?.length) lines.push(`modifiers ${modsHit.length}/${c.modifiers.length}${modsHit.length < c.modifiers.length ? ` ✗ missing ${c.modifiers.filter((m) => !kinds.has(m)).join(",")}` : " ✓"} (has: ${[...kinds].join(",") || "none"})`);
    if (must.length) lines.push(`facts ${must.filter((m) => m.ok).length}/${must.length}${must.some((m) => !m.ok) ? ` ✗ ${must.filter((m) => !m.ok).map((m) => m.fact).join("; ")}` : " ✓"}`);
    lines.push(`${r.meta.duration_ms ? Math.round(r.meta.duration_ms / 1000) : "?"}s`);
  }
  if (ok) pass++;
  console.log(`${ok ? "✓" : "✗"} ${c.app.padEnd(13)} [${c.category}] ${lines.join(" · ")}`);
}
console.log(`\nPASS ${pass}/${apps.length} · paths ${totals.path[0]}/${totals.path[1]} · modifiers ${totals.mods[0]}/${totals.mods[1]} · facts ${totals.must[0]}/${totals.must[1]}  (* = self-serve inferred from silent docs)`);
