# Agent v2: first live evaluation (21 October 2026)

Six apps, default models (Haiku research and judge, Sonnet writer), prompt v2.4. Spend for this round: $0.77 (plus $0.43 on three Box tuning runs). Raw outputs: eval/runs/*.json. Scorer: scripts/eval-score.mts.

```

## gmail
v2: 32 claims (32 sourced, 0 unconfirmed) · quotes 29/29 · critical 5/5 · paths [—, —, —] ✗ no expected path · judge {"checked":42,"supported":29,"partial":8,"unsupported":3,"contradicted":2,"unchecked":0} · $0.177 · 128s · partial=false
    must-have 4/5: ✓ 100 test users in Testing | ✗ 7-day expiry in Testing | ✓ authorized domain / redirect domain rule | ✓ restricted scopes need a security assessment | ✓ sensitive vs restricted scopes
v1 (data/guides/gmail-agent.json): 24 claims (24 sourced) · quotes 24/24 · must-have 5/5: ✓ 100 test users in Testing | ✓ 7-day expiry in Testing | ✓ authorized domain / redirect domain rule | ✓ restricted scopes need a security assessment | ✓ sensitive vs restricted scopes

## slack
v2: 30 claims (30 sourced, 0 unconfirmed) · quotes 23/23 · critical 4/5 · paths [—, app_review] ✓ matches study · judge {"checked":33,"supported":22,"partial":8,"unsupported":2,"contradicted":1,"unchecked":0} · $0.115 · 90s · partial=true
    must-have 2/3: ✗ Marketplace needs active workspaces first | ✓ unlisted apps rate-limited for history reads | ✓ Marketplace review
v1 (data/guides/slack.json): 85 claims (82 sourced) · quotes 71/71 · must-have 3/3: ✓ Marketplace needs active workspaces first | ✓ unlisted apps rate-limited for history reads | ✓ Marketplace review

## xero
v2: 26 claims (25 sourced, 1 unconfirmed) · quotes 23/24 · critical 5/5 · paths [app_review] ✓ matches study · judge {"checked":27,"supported":20,"partial":6,"unsupported":1,"contradicted":0,"unchecked":0} · $0.108 · 89s · partial=false
    must-have 3/3: ✓ connection caps / plans | ✓ security assessment above 1,000 connections | ✓ App certification / partner program
v1 (data/guides/xero.json): 16 claims (15 sourced) · quotes 15/15 · must-have 3/3: ✓ connection caps / plans | ✓ security assessment above 1,000 connections | ✓ App certification / partner program

## intercom
v2: 30 claims (30 sourced, 0 unconfirmed) · quotes 28/28 · critical 5/5 · paths [—, app_review, app_review] ✓ matches study · judge {"checked":43,"supported":34,"partial":6,"unsupported":3,"contradicted":0,"unchecked":0} · $0.154 · 116s · partial=false
    must-have 2/2: ✓ app must be approved before other workspaces install | ✓ private until approved (own workspace only)

## harvest
v2: 22 claims (21 sourced, 1 unconfirmed) · quotes 21/21 · critical 5/5 · paths [—] ✗ no expected path · judge {"checked":14,"supported":10,"partial":1,"unsupported":3,"contradicted":0,"unchecked":0} · $0.107 · 84s · partial=false
    must-have 1/1: ✓ OAuth app registration in Harvest ID / developers

## box
v2: 18 claims (18 sourced, 0 unconfirmed) · quotes 18/18 · critical 5/5 · paths [—, —] ✗ no expected path · judge {"checked":17,"supported":6,"partial":9,"unsupported":1,"contradicted":1,"unchecked":0} · $0.107 · 80s · partial=false
    must-have 3/3: ✓ OAuth apps may need admin enablement if inactive by default | ✓ admin authorization is for JWT/CCG apps (not every OAuth app) | ✓ publishing to Box Integrations is a separate review
v1 (data/guides/box.json): 25 claims (25 sourced) · quotes 25/25 · must-have 3/3: ✓ OAuth apps may need admin enablement if inactive by default | ✓ admin authorization is for JWT/CCG apps (not every OAuth app) | ✓ publishing to Box Integrations is a separate review
```

## Reading

- Fast and cheap: 80–128 s and $0.11–0.18 per guide; well inside the 270 s budget.
- Evidence: 142 of 143 quotes verified; almost no unconfirmed claims, because unsourced facts are dropped rather than shown.
- Coverage: all 5 critical questions found for 5 of 6 apps (Slack 4 of 5).
- Must-have facts: Xero, Box, Intercom, Harvest at or above v1; Gmail 4/5 vs v1 5/5 (missed the 7-day Testing expiry: the page was never read); Slack 2/3 vs the much deeper library guide 3/3.
- **Ship rule not met** (Gmail below v1).
- Biggest quality gap: approval paths left "unconfirmed" in Gmail, Harvest, Box and one Slack setup. Cause: the judge's path statements were framed around "other organizations", which internal setups don't involve, and self-serve can't be quoted when docs simply don't mention a review.

## Fixes after this round (prompt v2.4, offline-tested)

- Path statements are now relative to the setup ("for this setup, the provider reviews / doesn't review the app before it can be used").
- Self-serve may be **inferred**, and is labelled "no review step found in the docs", only when setup steps were found and no verified evidence anywhere mentions a review, verification or approval.
- Open: page discovery missed Gmail's Testing-mode expiry page.
