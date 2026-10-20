import { describe, expect, it } from "vitest";
import { matchCatalog, parseManagedAuthCatalog } from "@/lib/composio";
import { slugify } from "@/lib/slug";
import { assertPublicUrl, decodeAuthError, htmlToText } from "@/lib/web";

describe("assertPublicUrl (SSRF guard)", () => {
  it.each([
    "http://localhost/x",
    "http://127.0.0.1/",
    "http://169.254.169.254/latest/meta-data",
    "http://10.0.0.5/",
    "http://[::1]/",
    "file:///etc/passwd",
    "https://example.com:8443/",
    "https://user:pass@example.com/",
  ])("rejects %s", async (u) => {
    await expect(assertPublicUrl(u)).rejects.toThrow();
  });
});

describe("htmlToText", () => {
  it("drops scripts/nav and keeps structure", () => {
    const { title, text } = htmlToText(
      "<html><head><title>Docs &amp; Guides</title><script>evil()</script></head><body><nav>menu</nav><h2>Scopes</h2><ul><li>gmail.send</li><li>gmail.readonly</li></ul><p>Use &ldquo;restricted&rdquo; scopes carefully.</p></body></html>",
    );
    expect(title).toBe("Docs & Guides");
    expect(text).not.toMatch(/evil|menu/);
    expect(text).toMatch(/## Scopes/);
    expect(text).toMatch(/- gmail.send/);
    expect(text).toMatch(/“restricted”/);
  });
});

describe("decodeAuthError", () => {
  it("decodes Google's base64 authError", () => {
    const loc = "https://accounts.google.com/signin/oauth/error?authError=Cg5pbnZhbGlkX2NsaWVudBIfVGhlIE9BdXRoIGNsaWVudCB3YXMgbm90IGZvdW5kLiCRAw&flowName=x";
    expect(decodeAuthError(loc)).toMatch(/invalid_client The OAuth client was not found/);
  });
});

const MD = `# Managed OAuth apps

## Composio-managed OAuth available (2)

| Toolkit | Slug |
|---------|------|
| [Gmail](/toolkits/gmail.md) | \`GMAIL\` |
| [Google Calendar](/toolkits/googlecalendar.md) | \`GOOGLECALENDAR\` |

## Bring your own OAuth app (2)

| Toolkit | Slug |
|---------|------|
| [Shopify](/toolkits/shopify.md) | \`SHOPIFY\` |
| [Notion MCP](/toolkits/notion_mcp.md) | \`NOTION_MCP\` |
`;

describe("managed-auth catalog", () => {
  const entries = parseManagedAuthCatalog(MD);
  it("parses both sections", () => {
    expect(entries).toEqual([
      { name: "Gmail", slug: "gmail", managed: true },
      { name: "Google Calendar", slug: "googlecalendar", managed: true },
      { name: "Shopify", slug: "shopify", managed: false },
      { name: "Notion MCP", slug: "notion_mcp", managed: false },
    ]);
  });
  it("matches names and websites", () => {
    expect(matchCatalog("shopify.com", entries)[0].slug).toBe("shopify");
    expect(matchCatalog("Google Calendar", entries)[0].slug).toBe("googlecalendar");
    expect(matchCatalog("Calendly", entries)).toEqual([]);
  });
});

describe("slugify", () => {
  it("normalises names and URLs", () => {
    expect(slugify("Google Calendar")).toBe("google-calendar");
    expect(slugify("https://www.calendly.com/pricing")).toBe("calendly");
    expect(slugify("HubSpot")).toBe("hubspot");
  });
});

describe("cleanMarkdown (MDX docs sources)", () => {
  it("keeps link text and captions, drops component code", async () => {
    const { cleanMarkdown } = await import("@/lib/web");
    const md = [
      'export const docsUrl = "https://x";',
      "",
      "export const Link = ({href, children}) => {",
      "  return <a href={href}>{children}</a>;",
      "};",
      "",
      'Apps using <Link href="/jwt">JWT</Link> or <Link href="/ccg">Client Credentials Grant</Link> must be authorized.',
      '<Frame caption="The Authorization URL field populates after review">',
      "Kept paragraph after the export.",
    ].join("\n");
    const out = cleanMarkdown(md);
    expect(out).toContain("Apps using JWT or Client Credentials Grant must be authorized.");
    expect(out).toContain("The Authorization URL field populates after review");
    expect(out).toContain("Kept paragraph after the export.");
    expect(out).not.toMatch(/export const|children/);
  });
});
