/**
 * The research brief: the questions every guide must answer, mapped to the approval categorisation
 * (docs/agent/SPEC.md §4.1). Status is computed in code from verified evidence, never from a model's say-so.
 */

export type QuestionId = "G1" | "G2" | "G3" | "G4" | "G5" | "G6" | "G7" | "G8" | "G9" | "G10" | "G11" | "R1" | "C1";

export interface Question {
  id: QuestionId;
  text: string;
  /** Must be found, or reported as not found with the URLs tried. */
  critical: boolean;
  /** Gap-fill order for open critical questions (lower first). */
  priority?: number;
  /** Words that suggest a page covers this question (discovery ranking). */
  keywords: string[];
  /** Search query template for gap fill; {app} is replaced. */
  search: string;
}

export const QUESTIONS: Question[] = [
  {
    id: "G1",
    text: "Who can create an OAuth app: developer account, developer program, plan or region needed; and is this the current (not legacy or deprecated) platform?",
    critical: false,
    keywords: ["developer account", "sign up", "create an app", "developer program", "deprecated", "legacy"],
    search: "{app} developer account create OAuth app requirements",
  },
  {
    id: "G2",
    text: "Every step that must happen before a customer outside the developer's own company can connect, in order: nothing, an app review or verification, a required marketplace listing, or acceptance as a partner. What triggers each step (always, only for sensitive scopes, only above some number of users or installs)? Can other organizations use the app without a provider review (for example by sharing its link)? Is client registration automatic (dynamic client registration)?",
    critical: true,
    priority: 1,
    keywords: ["review", "verification", "verify", "approval", "approve", "publish", "distribution", "marketplace", "app directory", "partner", "listing", "go live", "production"],
    search: "{app} OAuth app review verification before public users",
  },
  {
    id: "G3",
    text: "What each review or verification checks and what the developer must submit (identity or business verification, use case and scope justification, demo video or test account, security assessment, listing content).",
    critical: true,
    priority: 2,
    keywords: ["submit", "submission", "requirements", "demo", "video", "justification", "security", "assessment", "checklist", "guidelines"],
    search: "{app} app review submission requirements checklist",
  },
  {
    id: "G4",
    text: "Scope or permission tiers: which scopes a typical AI agent needs for this app, and which of them trigger extra review.",
    critical: true,
    priority: 5,
    keywords: ["scope", "scopes", "permission", "permissions", "sensitive", "restricted", "read", "write"],
    search: "{app} OAuth scopes sensitive restricted list",
  },
  {
    id: "G5",
    text: "Limits before approval: test-user caps, install or connection caps, rate limits for unreviewed apps, 'unverified app' warnings, development-mode restrictions, and tokens or authorizations that expire sooner in testing mode.",
    critical: true,
    priority: 3,
    keywords: ["limit", "limits", "test users", "rate limit", "unverified", "development mode", "testing", "sandbox", "cap", "quota", "warning", "expire", "expiration", "refresh token"],
    search: "{app} unverified app limits test users rate limit",
  },
  {
    id: "G6",
    text: "Published review timelines; whether reviews repeat (on changes, yearly); any waivers.",
    critical: false,
    priority: 6,
    keywords: ["business days", "weeks", "timeline", "how long", "annual", "re-review", "reassessment", "every 12 months"],
    search: "{app} app review how long timeline",
  },
  {
    id: "G7",
    text: "Pricing: whether a paid plan, credits or fees are needed for API access, by the developer or by their customers.",
    critical: false,
    keywords: ["pricing", "paid", "plan", "fee", "cost", "billing", "tier", "credits"],
    search: "{app} API pricing paid plan required for API access",
  },
  {
    id: "G8",
    text: "Customer side: whether each customer's admin must approve, allowlist, install, or create the integration in their own account.",
    critical: true,
    priority: 4,
    keywords: ["admin", "administrator", "allowlist", "consent", "workspace owner", "install", "enterprise", "approve apps"],
    search: "{app} admin approval third-party app install allowlist",
  },
  {
    id: "G9",
    text: "Redirect URI and domain rules: authorized domains, domain ownership verification, HTTPS requirements (relevant because Composio's callback is on Composio's domain).",
    critical: false,
    keywords: ["redirect", "callback", "redirect uri", "authorized domain", "domain verification", "https"],
    search: "{app} OAuth redirect URI authorized domain verification",
  },
  {
    id: "G10",
    text: "Setup steps: where in the developer console to create the app, how to get the client ID and secret, configure scopes and register the redirect URI.",
    critical: false,
    keywords: ["client id", "client secret", "create app", "console", "dashboard", "credentials", "authorization code"],
    search: "{app} create OAuth app client id client secret",
  },
  {
    id: "G11",
    text: "Thresholds to apply or be listed (a number of users, workspaces, customers or installs) and use restrictions (no competing products, naming or branding rules, eligibility rules).",
    critical: false,
    keywords: ["at least", "minimum", "active", "eligible", "eligibility", "must not", "prohibited", "branding", "trademark", "naming"],
    search: "{app} marketplace listing eligibility minimum installs",
  },
  {
    id: "R1",
    text: "What developers report from experience: real review wait times, rejections, common blockers.",
    critical: false,
    keywords: ["forum", "community", "stuck", "rejected", "took"],
    search: "{app} OAuth app review took weeks developer forum",
  },
  {
    id: "C1",
    text: "What Composio says about this app: whether Composio supplies a managed OAuth app or you bring your own, the callback or redirect URL to register, limits of the managed app, and known errors.",
    critical: false,
    keywords: ["composio", "managed", "auth config", "callback", "redirect"],
    search: "composio {app} toolkit auth config",
  },
];

/** Questions asked of provider pages; Composio pages are asked C1 and G9 only. */
export const PROVIDER_QUESTIONS = QUESTIONS.filter((q) => q.id !== "C1" && q.id !== "R1").map((q) => q.id);
export const COMPOSIO_QUESTIONS: QuestionId[] = ["C1", "G9"];

export const QUESTION_IDS = QUESTIONS.map((q) => q.id);
export const byId = new Map(QUESTIONS.map((q) => [q.id, q]));
export const isQuestionId = (x: string): x is QuestionId => byId.has(x as QuestionId);
