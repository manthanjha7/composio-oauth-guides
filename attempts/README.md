# Recorded setup attempts

The live agent can't log in to developer consoles, so setup attempts are recorded here: an **agent does the configuration**, a **human does only what needs a person** (consent, logins). A claim is labelled 🧪 Tested only when backed by an entry here.

## Slack (20 Oct 2026): done

Script: `slack/run-attempt.mts` · raw log: `slack/log.json` · manifest: `slack/manifest.json`

| # | Who | Action | Result |
|---|---|---|---|
| 1 | 👤 | Generated a short-lived Slack App Configuration Token in a test workspace | Token handed to the agent |
| 2 | 🤖 | Validated and created the app from a manifest (`apps.manifest.validate`, `apps.manifest.create`) | OK |
| 3 | 🤖 | Created a Composio auth config with the app's client ID/secret over the REST API | **Rejected**: `authScheme: Required`. The docs' example uses `auth_scheme`. Deleted the app (its secret was lost), recreated it, retried with `authScheme`: OK |
| 4 | 🤖 | Created a Composio connect link | OK, but it expired before it was opened (10 minutes). A second link hit "Too many requests. Retry after 60s" on the hosted page |
| 5 | 🤖 | Started the connection directly (`POST /connected_accounts`) and inspected Slack's authorize URL | Found that Composio requests the scopes as **user scopes** (`user_scope`); the app only declared bot scopes |
| 6 | 🤖 | Added the scopes as user scopes (`apps.manifest.update`) and issued a fresh authorize link | OK |
| 7 | 👤 | Opened the link and clicked Allow | Connected |
| 8 | 🤖 | Checked the connected account and ran `SLACK_LIST_ALL_CHANNELS` through it | **ACTIVE**, call **successful** |

What it confirmed or changed in the Slack guide: apps can be created via the manifest API by an agent (🧪), an undistributed app installs in its own workspace with no Slack review (🧪), Composio's Slack toolkit uses user auth (🧪), plus four new 🧪 findings (camelCase `authScheme`; user scopes; legacy default redirect URI vs the v3 one that worked; 10-minute link expiry and rate limit).

## Not yet attempted

Google (Gmail), Shopify, Notion: see `/verification`.
