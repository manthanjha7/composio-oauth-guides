"""One-off hand edit of the four library guides for the lighter guide page (20 Oct 2026).
Adds verdict, default setup, path/checks/shortcut/extras per setup, scopes traps/prerequisites/blockers
to setups, shortens a few texts, and adds three forum-reported Gmail items (verified against the posts)."""
import json, sys

def load(slug):
    return json.load(open(f"data/guides/{slug}.json"))

def save(slug, r):
    json.dump(r, open(f"data/guides/{slug}.json", "w"), indent=2, ensure_ascii=False)
    open(f"data/guides/{slug}.json", "a").write("\n")

def by_title(items, key="title"):
    return {i[key]: i for i in items}

def scope(items, mapping, key="title"):
    """mapping: {title_prefix: [scenario ids]}; order of mapping = new order (unmapped keep order at end)."""
    out, used = [], set()
    for prefix, ids in mapping.items():
        for i, it in enumerate(items):
            if i not in used and it[key].startswith(prefix):
                it["scenario_ids"] = ids
                out.append(it); used.add(i); break
        else:
            sys.exit(f"no item starting with {prefix!r}")
    out += [it for i, it in enumerate(items) if i not in used]
    return out

def scen(g, sid, **kw):
    s = next(s for s in g["scenarios"] if s["id"] == sid)
    s.update(kw)

# ---------------- Gmail ----------------
r = load("gmail"); g = r["guide"]
g["verdict"] = "Under an hour for an internal tool. Weeks of Google review, a security assessment and a yearly re-check if your agent reads inboxes."
g["default_scenario"] = "s4"
g["need_own_app"]["answer"] = "Not to prototype: Composio's managed Gmail app works today. To launch, almost always: for your own name on the consent screen, your own quota, and permissions beyond Composio's defaults."
scen(g, "s1", label="Prototype or personal use", path="self_serve", review_checks=[], shortcut=None, extras=["Max 100 test users", "Logins expire every 7 days"])
scen(g, "s2", label="Internal tool, your company only", path="self_serve", review_checks=[], shortcut=None, extras=["Your Workspace admin may need to trust it"])
scen(g, "s3", label="Public app that only sends email", path="app_review", review_checks=["identity", "use_case", "working_demo"], shortcut=None, extras=["Needs a domain you own"])
scen(g, "s4", label="Public agent that reads inboxes", path="app_review", review_checks=["identity", "use_case", "working_demo", "security"],
     shortcut="Only need to send email? Ask for gmail.send alone. It needs no security assessment (c1).",
     extras=["Security assessment repeats every 12 months", "Assessor fees reported from about $540"],
     approval="Brand verification, restricted-scope verification, and a CASA security assessment by a Google-approved assessor (c5, c6).")
for p in g["prerequisites"]:
    if p["title"].startswith("A domain you control"): p["title"] = "A domain you control"; p["scenario_ids"] = ["s3", "s4"]
    if p["title"].startswith("Security posture"): p["title"] = "Security posture for restricted scopes"; p["scenario_ids"] = ["s4"]
g["traps"] = scope(g["traps"], {
    "Redirect on Composio": ["s3", "s4"],
    "gmail.compose and gmail.modify": ["s3", "s4"],
    "AI-agent-specific": ["s3", "s4"],
    "Testing mode breaks": ["s1"],
    "The 100-user caps": ["s1"],
})
g["blockers"] = scope(g["blockers"], {"Error 403: org_internal": ["s2"], "'Google hasn't verified": ["s1", "s3", "s4"], "invalid_grant": ["s1"]}, key="symptom")
g["blockers"] += [
    {"symptom": "Under review for weeks with no reply",
     "what_it_means": "Developers report reviews sitting for 8+ weeks with no email from Google's Trust & Safety team (c71).",
     "what_to_do": "Reply on your existing verification case or use Google's OAuth verification support form. Drop every scope you don't call: one team was approved two days after removing unneeded scopes (c72).",
     "agent_can_help": "List the scopes your code actually calls and draft the reply.",
     "claim_ids": ["c71", "c72"], "scenario_ids": ["s3", "s4"]},
    {"symptom": "The security assessment (CASA) email never arrived",
     "what_it_means": "Google's verification team sends the invitation. Developers report it going missing, even after checking spam (c73).",
     "what_to_do": "Check the project owner and support contact mailboxes, then reply on the verification case or use the OAuth verification support form. Only Google can resend it.",
     "agent_can_help": None, "claim_ids": ["c73"], "scenario_ids": ["s4"]},
]
g["claims"] += [
    {"id": "c71", "label": "reported", "text": "A developer reports a sensitive-scope-only verification stuck under review for over 8 weeks, with no email from Trust & Safety.",
     "source_url": "https://discuss.google.dev/t/oauth-data-access-verification-stuck-under-review-for-8-weeks-sensitive-scope-only-spreadsheets-no-trust-safety-contact/375352",
     "quote": "has been stuck in “under review” for over 8 weeks", "probe_id": None, "note": None},
    {"id": "c72", "label": "reported", "text": "One team reports verification took almost a month; after removing unnecessary scopes it was verified within two days.",
     "source_url": "https://kartaca.com/en/google-oath-application-verification-process/",
     "quote": "we received an email within two days confirming that our application was verified.", "probe_id": None, "note": None},
    {"id": "c73", "label": "reported", "text": "A developer reports never receiving the CASA invitation from Trust & Safety. The advice given: use the OAuth verification support form or reply to the existing case.",
     "source_url": "https://discuss.google.dev/t/stuck-on-casa-assessment-requirement-no-email-received-from-trust-safety-team/381887",
     "quote": "use the OAuth verification support form or reply to the existing verification case", "probe_id": None, "note": None},
]
r["meta"]["verification"]["claims_total"] = len(g["claims"])
save("gmail", r)

# ---------------- Slack ----------------
r = load("slack"); g = r["guide"]
g["verdict"] = "Under an hour in your own workspace. Reading customers' channels at full speed needs a Marketplace listing: 10 active workspaces and up to 10 weeks of review."
g["default_scenario"] = "s4"
g["need_own_app"]["answer"] = "Not for a quick prototype. Yes for anything real: your name on the install screen, full rate limits, and any Marketplace listing."
scen(g, "s1", label="Internal agent, your own workspace", path="self_serve", review_checks=[], shortcut=None, extras=["Your workspace admin may need to approve"])
scen(g, "s2", label="Prototype on Composio's managed app", path="automatic", review_checks=[], shortcut=None, extras=["Strict workspaces may block it"])
scen(g, "s3", label="Unlisted app, a few customer workspaces", path="self_serve", review_checks=[], shortcut=None,
     extras=["Channel reads limited to 1 request a minute", "Each customer's admin may need to approve"])
scen(g, "s4", label="Listed on the Slack Marketplace", path="app_review", review_checks=["use_case", "working_demo", "listing"], shortcut=None,
     extras=["Needs 10 active workspaces to apply"])
for p in g["prerequisites"]:
    if p["title"].startswith("For distribution"): p["title"] = "Public HTTPS endpoints"; p["scenario_ids"] = ["s3", "s4"]
    if p["title"].startswith("For the Marketplace"): p["title"] = "Landing page, privacy policy, support contact and test accounts"; p["scenario_ids"] = ["s4"]
g["traps"] = scope(g["traps"], {
    "Unlisted apps can barely": ["s2", "s3"],
    "Composio's managed Slack app": ["s2"],
    "Some AI-agent designs": ["s4"],
    "Sandboxes don't count": ["s4"],
    "Composio asks Slack for user scopes": ["s1", "s3", "s4"],
    "Auth config and Slack app scopes": ["s1", "s3", "s4"],
    "Having each customer create": ["s3", "s4"],
    "Turning off distribution": ["s3", "s4"],
    "Automation platforms": ["s4"],
})
g["blockers"] = scope(g["blockers"], {
    "'This app isn't listed": ["s2", "s3"], "conversations.history": ["s2", "s3"],
    "Marketplace submission is blocked": ["s4"], "Submission returned": ["s4"],
}, key="symptom")
save("slack", r)

# ---------------- Shopify ----------------
r = load("shopify"); g = r["guide"]
g["verdict"] = "An hour or two for one store, with no review. Serving many merchants means Shopify app review, which has no published timeline."
g["default_scenario"] = "s3"
g["need_own_app"]["answer"] = "Yes, always. Composio has no managed Shopify app, so even a dev store needs your own app."
scen(g, "s1", label="Prototype on your own dev store", path="self_serve", review_checks=[], shortcut=None, extras=[])
scen(g, "s2", label="One merchant store (custom app)", path="self_serve", review_checks=[], shortcut=None, extras=["Orders older than 60 days need approval"])
scen(g, "s3", label="Many merchants (public app)", path="app_review", review_checks=["use_case", "working_demo", "security", "listing"],
     shortcut="Serving one merchant? A custom app needs no review.", extras=["Merchants must install from Shopify", "No official review timeline"])
scen(g, "s4", label="A few merchants, one app each", path="self_serve", review_checks=[], shortcut=None, extras=["One app per merchant"])
for p in g["prerequisites"]:
    if p["title"].startswith("For the App Store"): p["title"] = "App Store requirements"; p["scenario_ids"] = ["s3"]
g["traps"] = scope(g["traps"], {
    "Composio's connect flow": ["s3"],
    "App Store requires a real UI": ["s3"],
    "You can't even prototype": ["s1"],
    "Custom distribution is one merchant": ["s2", "s4"],
})
g["blockers"] = scope(g["blockers"], {"App review stuck": ["s3"]}, key="symptom")
save("shopify", r)

# ---------------- Notion ----------------
r = load("notion"); g = r["guide"]
g["verdict"] = "Minutes to prototype, under an hour for your own public connection. Only an optional Marketplace listing is reviewed, in 5 to 10 business days."
g["default_scenario"] = "s3"
g["need_own_app"]["answer"] = "Not to prototype: Composio's managed Notion app works. For one workspace you own, skip OAuth and use an internal token. For other people's workspaces, use your own public connection."
scen(g, "s1", label="Prototype on Composio's managed app", path="automatic", review_checks=[], shortcut=None, extras=[])
scen(g, "s2", label="Internal connection, your own workspace", path="self_serve", review_checks=[], shortcut=None, extras=["Needs the Workspace Owner role"])
scen(g, "s3", label="Public connection, not listed", path="self_serve", review_checks=[], shortcut=None, extras=["Enterprise workspaces may block installs"])
scen(g, "s4", label="Listed on the Notion Marketplace", path="app_review", review_checks=["security", "listing"], shortcut=None, extras=[])
for p in g["prerequisites"]:
    if p["title"].startswith("Website, privacy policy"): p["title"] = "Website, privacy policy, terms of use, support email and icon"; p["scenario_ids"] = ["s3", "s4"]
    if p["title"].startswith("A second Notion workspace"): p["scenario_ids"] = ["s3", "s4"]
g["blockers"] = scope(g["blockers"], {
    "Authorization URL field": ["s3", "s4"], "User can't find or install": ["s3", "s4"], "Marketplace listing rejected": ["s4"],
}, key="symptom")
save("notion", r)
print("ok")
