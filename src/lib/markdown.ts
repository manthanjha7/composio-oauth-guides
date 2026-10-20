import { LABEL_INFO } from "./evidence";
import type { GuideRecord } from "./schema";

const OWNER = { agent: "🤖 Agent can do", you: "👤 You", waiting: "⏳ Waiting" } as const;

/** Plain Markdown version of a guide: for sharing in docs/tickets, or handing to a coding agent. */
export function guideToMarkdown(r: GuideRecord, baseUrl: string): string {
  const g = r.guide;
  const cite = (ids: string[]) =>
    ids.length
      ? " " + ids.map((id) => {
          const c = g.claims.find((x) => x.id === id);
          return c ? `[${LABEL_INFO[c.label].icon}${id}]` : "";
        }).join("")
      : "";
  const L: string[] = [];
  L.push(`# OAuth app setup guide: ${g.app.name}`);
  L.push("");
  L.push(`> ${r.meta.origin === "seed" ? (r.meta.reviewed ? "Human-reviewed seed guide" : "Seed guide") : "Agent-generated, not yet human-reviewed"} · generated ${r.meta.generated_at.slice(0, 10)} · ${baseUrl}/guides/${r.slug}`);
  L.push("");
  L.push(g.summary);
  L.push("");
  L.push(`**Composio:** managed OAuth app: **${g.composio.managed_oauth}**${g.composio.toolkit_slug ? ` (toolkit \`${g.composio.toolkit_slug}\`)` : ""}. ${g.composio.note}`);
  if (g.composio.credential_guide_url) L.push(`Composio credential walkthrough: ${g.composio.credential_guide_url}`);
  L.push("");
  L.push(`## Do you need your own OAuth app?`);
  L.push(g.need_own_app.answer);
  g.need_own_app.reasons.forEach((x) => L.push(`- ${x}`));
  L.push("");
  L.push(`## Scenarios`);
  L.push("| Scenario | Difficulty | Your time | Waiting on provider | Review |");
  L.push("|---|---|---|---|---|");
  g.scenarios.forEach((s) =>
    L.push(`| **${s.label}**: ${s.when_this_applies} | ${s.difficulty} | ${s.hands_on.estimate} | ${s.waiting.estimate} | ${s.approval}${cite(s.claim_ids)} |`),
  );
  L.push("");
  L.push(`## Before you start`);
  g.prerequisites.forEach((p) => L.push(`- **${p.title}**: ${p.detail}${cite(p.claim_ids)}`));
  L.push("");
  L.push(`## Steps`);
  g.steps.forEach((s, i) => {
    const scen = s.scenario_ids.length ? ` _(only: ${s.scenario_ids.map((id) => g.scenarios.find((x) => x.id === id)?.label ?? id).join(", ")})_` : "";
    L.push(`${i + 1}. **${s.title}** · ${OWNER[s.owner]}${scen}`);
    L.push(`   ${s.detail}${cite(s.claim_ids)}`);
    if (s.inputs.length) L.push(`   - Needs: ${s.inputs.join("; ")}`);
    L.push(`   - Done when: ${s.done_when}`);
    if (s.link) L.push(`   - ${s.link}`);
  });
  L.push("");
  L.push(`## Traps`);
  g.traps.forEach((t) => L.push(`- **${t.title}**: ${t.detail}${cite(t.claim_ids)}`));
  L.push("");
  L.push(`## Stuck?`);
  g.blockers.forEach((b) => {
    L.push(`- **${b.symptom}**: ${b.what_it_means} → ${b.what_to_do}${b.agent_can_help ? ` (🤖 ${b.agent_can_help})` : ""}${cite(b.claim_ids)}`);
  });
  if (g.open_questions.length) {
    L.push("");
    L.push(`## Still uncertain`);
    g.open_questions.forEach((q) => L.push(`- ${q}`));
  }
  L.push("");
  L.push(`## Evidence`);
  g.claims.forEach((c) => {
    const info = LABEL_INFO[c.label];
    L.push(`- ${info.icon} **${c.id}** (${info.name}): ${c.text}${c.source_url ? ` · ${c.source_url}` : ""}${c.quote ? `\n  > "${c.quote}"` : ""}${c.note ? `\n  _${c.note}_` : ""}`);
  });
  if (r.meta.probes.length) {
    L.push("");
    L.push(`## Probes`);
    r.meta.probes.forEach((p) => L.push(`- ${p.id}: GET ${p.url} → ${p.status ?? "no response"} · ${p.observation.slice(0, 200)}`));
  }
  L.push("");
  L.push(`_Legend: ${Object.values(LABEL_INFO).map((i) => `${i.icon} ${i.name}`).join(" · ")}_`);
  return L.join("\n");
}
