/**
 * Agent-driven Slack setup attempt. The agent does the configuration; a human only provides a short-lived
 * Slack App Configuration Token and clicks "Allow" on the consent screen.
 *
 *   SLACK_CONFIG_TOKEN=xoxe.xoxp-... npx tsx --env-file=.env.local attempts/slack/run-attempt.mts setup
 *   npx tsx --env-file=.env.local attempts/slack/run-attempt.mts verify   (after clicking Allow)
 *
 * Every round is appended to attempts/slack/log.json. Secrets are never written there.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const LOG = "attempts/slack/log.json";
const STATE = "/tmp/slack-attempt-state.json"; // holds ids and the client secret; outside the repo
const COMPOSIO = "https://backend.composio.dev/api/v3.1";
const USER_ID = "slack-attempt-user";
const log = (step: string, outcome: string, detail: unknown) => {
  const entries = existsSync(LOG) ? JSON.parse(readFileSync(LOG, "utf8")) : [];
  entries.push({ at: new Date().toISOString(), step, outcome, detail });
  writeFileSync(LOG, JSON.stringify(entries, null, 2) + "\n");
  console.log(`[${outcome}] ${step}: ${JSON.stringify(detail).slice(0, 400)}`);
};
const slack = async (method: string, body: Record<string, string>) => {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.SLACK_CONFIG_TOKEN}`, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
  return (await res.json()) as Record<string, any>;
};
const composio = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`${COMPOSIO}${path}`, {
    method,
    headers: { "x-api-key": process.env.COMPOSIO_API_KEY!, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, any> };
};

const mode = process.argv[2];
if (mode === "setup") {
  if (!process.env.SLACK_CONFIG_TOKEN) throw new Error("SLACK_CONFIG_TOKEN missing");
  const manifest = JSON.parse(readFileSync("attempts/slack/manifest.json", "utf8"));
  const redirect = manifest.oauth_config.redirect_urls[0];
  const scopes = manifest.oauth_config.scopes.bot.join(",");

  const v = await slack("apps.manifest.validate", { manifest: JSON.stringify(manifest) });
  log("Slack: validate manifest (apps.manifest.validate)", v.ok ? "ok" : "rejected", v.ok ? { ok: true } : { error: v.error, errors: v.errors });
  if (!v.ok) process.exit(1);

  const c = await slack("apps.manifest.create", { manifest: JSON.stringify(manifest) });
  if (!c.ok) {
    log("Slack: create app (apps.manifest.create)", "rejected", { error: c.error, errors: c.errors });
    process.exit(1);
  }
  log("Slack: create app (apps.manifest.create)", "ok", { app_id: c.app_id, client_id: c.credentials?.client_id, oauth_authorize_url: c.oauth_authorize_url });
  writeFileSync(STATE, JSON.stringify({ app_id: c.app_id, client_id: c.credentials.client_id, client_secret: c.credentials.client_secret }));

  const ac = await composio("POST", "/auth_configs", {
    toolkit: { slug: "slack" },
    auth_config: {
      type: "use_custom_auth",
      authScheme: "OAUTH2", // the REST API requires camelCase here; the docs' examples show auth_scheme (rejected: "authScheme: Required")
      name: "Slack (agent setup test)",
      credentials: { client_id: c.credentials.client_id, client_secret: c.credentials.client_secret, oauth_redirect_uri: redirect, scopes },
    },
  });
  const authConfigId = ac.json?.auth_config?.id;
  log("Composio: create auth config with our client ID/secret, v3 callback and matching scopes", authConfigId ? "ok" : "rejected", authConfigId ? { auth_config_id: authConfigId, oauth_redirect_uri: redirect, scopes } : { status: ac.status, body: ac.json });
  if (!authConfigId) process.exit(1);

  const link = await composio("POST", "/connected_accounts/link", { auth_config_id: authConfigId, user_id: USER_ID });
  const url = link.json?.redirect_url;
  log("Composio: create connect link", url ? "ok" : "rejected", url ? { connected_account_id: link.json?.connected_account_id } : { status: link.status, body: link.json });
  writeFileSync(STATE, JSON.stringify({ app_id: c.app_id, client_id: c.credentials.client_id, client_secret: c.credentials.client_secret, auth_config_id: authConfigId, connected_account_id: link.json?.connected_account_id }));
  if (url) console.log(`\nCONNECT LINK (open, then click Allow): ${url}`);
} else if (mode === "relink") {
  // Connect links expire quickly ("Link session has expired"); issue a new one for the same auth config.
  const st = JSON.parse(readFileSync(STATE, "utf8"));
  const link = await composio("POST", "/connected_accounts/link", { auth_config_id: st.auth_config_id, user_id: USER_ID });
  const url = link.json?.redirect_url;
  log("Composio: new connect link (previous one expired before it was opened)", url ? "ok" : "rejected", url ? { connected_account_id: link.json?.connected_account_id, expires_at: link.json?.expires_at ?? null } : { status: link.status, body: link.json });
  if (url) {
    writeFileSync(STATE, JSON.stringify({ ...st, connected_account_id: link.json?.connected_account_id }));
    console.log(`\nCONNECT LINK: ${url}\nresponse keys: ${Object.keys(link.json).join(", ")}`);
  }
} else if (mode === "direct") {
  // The hosted Connect Link page rate-limited us ("Too many requests. Retry after 60s") and links expire after
  // 10 minutes. For custom auth configs, POST /connected_accounts returns the provider's authorize URL directly.
  const st = JSON.parse(readFileSync(STATE, "utf8"));
  const r = await composio("POST", "/connected_accounts", { auth_config: { id: st.auth_config_id }, connection: { user_id: USER_ID } });
  const url = r.json?.redirect_url ?? r.json?.redirectUrl;
  log("Composio: initiate connection directly (POST /connected_accounts)", url ? "ok" : "rejected", url ? { connected_account_id: r.json?.id, redirect_host: new URL(url).host } : { status: r.status, body: r.json });
  if (url) {
    writeFileSync(STATE, JSON.stringify({ ...st, connected_account_id: r.json?.id }));
    console.log(`\nAUTHORIZE URL: ${url}`);
  }
} else if (mode === "update-manifest") {
  // Composio's Slack toolkit sends the configured scopes as user_scope (user token), so the app must declare
  // them as user scopes too; bot-only scopes make Slack reject the install.
  const st = JSON.parse(readFileSync(STATE, "utf8"));
  const manifest = JSON.parse(readFileSync("attempts/slack/manifest.json", "utf8"));
  const u = await slack("apps.manifest.update", { app_id: st.app_id, manifest: JSON.stringify(manifest) });
  log("Slack: add the scopes as user scopes (apps.manifest.update)", u.ok ? "ok" : "rejected", u.ok ? { user_scopes: manifest.oauth_config.scopes.user } : { error: u.error, errors: u.errors });
} else if (mode === "delete-app") {
  const appId = process.argv[3];
  const d = await slack("apps.manifest.delete", { app_id: appId });
  log(`Slack: delete app ${appId} (apps.manifest.delete)`, d.ok ? "ok" : "rejected", d.ok ? { deleted: appId } : { error: d.error });
} else if (mode === "verify") {
  const st = JSON.parse(readFileSync(STATE, "utf8"));
  const acc = await composio("GET", `/connected_accounts/${st.connected_account_id}`);
  log("Composio: connected account status after consent", acc.json?.status === "ACTIVE" ? "ok" : "not-active", { status: acc.json?.status, status_reason: acc.json?.status_reason ?? null });
  if (acc.json?.status !== "ACTIVE") process.exit(1);
  const tool = process.argv[3] ?? "SLACK_LIST_ALL_CHANNELS";
  const ex = await composio("POST", `/tools/execute/${tool}`, { connected_account_id: st.connected_account_id, user_id: USER_ID, arguments: { limit: 5 } });
  const ok = ex.json?.successful === true;
  log(`Composio: run ${tool} through the new connection`, ok ? "ok" : "failed", ok ? { successful: true } : { status: ex.status, error: ex.json?.error ?? ex.json?.data?.error ?? ex.json });
} else {
  console.log("usage: run-attempt.mts setup|verify [TOOL_SLUG]");
}
