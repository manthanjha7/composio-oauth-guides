import { guideToMarkdown } from "@/lib/markdown";
import { getGuide } from "@/lib/store";

export async function GET(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const record = await getGuide(slug);
  if (!record) return new Response("Guide not found", { status: 404 });
  const origin = new URL(req.url).origin;
  return new Response(guideToMarkdown(record, origin), {
    headers: { "content-type": "text/markdown; charset=utf-8" },
  });
}
