/**
 * Live evaluation runner for agent v2. USES THE MODEL (costs money). Writes each result to eval/runs/ only;
 * nothing is saved to the guide store or the live site.
 *
 *   npx tsx --env-file=.env.local scripts/eval-run.mts [--cap 2.00] <app> [<app> ...]
 *
 * Runs apps one after another and stops before starting another once the spend cap is reached.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { runAgentV2 } from "../src/lib/agent/pipeline";

const args = process.argv.slice(2);
const ci = args.indexOf("--cap");
const cap = ci >= 0 ? Number(args[ci + 1]) : 2;
const apps = args.filter((a, i) => !(ci >= 0 && (i === ci || i === ci + 1)));
mkdirSync("eval/runs", { recursive: true });

let spent = 0;
for (const app of apps) {
  if (spent >= cap) {
    console.log(`STOP: spend cap $${cap} reached ($${spent.toFixed(3)}); skipping ${app} and the rest.`);
    break;
  }
  const t0 = Date.now();
  const log: string[] = [];
  const result = await runAgentV2({
    query: app,
    emit: (e) => {
      const line = `[${((Date.now() - t0) / 1000).toFixed(0).padStart(3)}s] ${e.type}: ${JSON.stringify(e).slice(0, 300)}`;
      log.push(line);
      if (["stage", "warning", "error", "note", "cost", "verify", "done"].includes(e.type)) console.log(`${app} ${line}`);
    },
  });
  const slug = app.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  writeFileSync(`eval/runs/${slug}-v2.json`, JSON.stringify(result.outcome === "ok" ? result.record : result, null, 2));
  writeFileSync(`eval/runs/${slug}-v2.log`, log.join("\n"));
  const usd = result.outcome === "ok" ? (result.record.meta.usage?.usd ?? 0) : 0;
  spent += usd;
  if (result.outcome === "ok") {
    const m = result.record.meta;
    const q = m.research!.questions;
    console.log(
      `\nDONE ${app}: ${result.record.guide.claims.length} claims · quotes ${m.verification.quotes_verified}/${m.verification.quotes_checked} · ` +
        `critical found ${q.filter((x) => ["G2", "G3", "G4", "G5", "G8"].includes(x.id) && x.status === "found").length}/5 · ` +
        `$${usd.toFixed(3)} · ${Math.round((m.duration_ms ?? 0) / 1000)}s · partial=${m.partial} · total spent $${spent.toFixed(3)}\n`,
    );
  } else {
    console.log(`\nOUTCOME ${app}: ${result.outcome} ${JSON.stringify(result).slice(0, 300)} · total spent $${spent.toFixed(3)}\n`);
  }
}
