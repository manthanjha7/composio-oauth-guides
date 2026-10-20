import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getGuide, listSeedGuides } from "@/lib/store";
import { GuideView } from "./GuideView";

type Props = { params: Promise<{ slug: string }>; searchParams: Promise<{ s?: string }> };

const shortName = (n: string) => n.replace(/\s*\(.*\)\s*$/, "") || n;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const r = await getGuide(slug);
  if (!r) return { title: "Guide not found" };
  return { title: `${shortName(r.guide.app.name)}: OAuth app setup guide`, description: r.guide.summary };
}

export default async function GuidePage({ params, searchParams }: Props) {
  const [{ slug }, { s }] = await Promise.all([params, searchParams]);
  const record = await getGuide(slug);
  if (!record) notFound();
  // An agent-generated guide for an app that also has a library guide links to it.
  const twin =
    record.meta.origin === "live"
      ? ((await listSeedGuides()).find((g) => shortName(g.guide.app.name).toLowerCase() === shortName(record.guide.app.name).toLowerCase())?.slug ?? null)
      : null;
  return <GuideView record={record} initialScenario={s ?? null} libraryTwin={twin} />;
}
