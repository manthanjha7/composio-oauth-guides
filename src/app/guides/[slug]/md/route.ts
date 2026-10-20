import { guideToMarkdown } from "@/lib/markdown";
import { getGuide } from "@/lib/store";

export async function GET(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const record = await getGuide(slug);
  if (!record) return new Response("Guide not found", { status: 404 });
  const url = new URL(req.url);
  // Behind a proxy the request URL can be an internal host; prefer the forwarded host.
  const host = req.headers.get("x-forwarded-host") ?? url.host;
  const proto = req.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "");
  return new Response(guideToMarkdown(record, `${proto}://${host}`, url.searchParams.get("s")), {
    headers: { "content-type": "text/markdown; charset=utf-8" },
  });
}
