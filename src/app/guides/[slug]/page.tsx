import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getGuide } from "@/lib/store";
import { GuideView } from "./GuideView";

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const r = await getGuide(slug);
  if (!r) return { title: "Guide not found" };
  return { title: `${r.guide.app.name}: OAuth app setup guide`, description: r.guide.summary };
}

export default async function GuidePage({ params }: Props) {
  const { slug } = await params;
  const record = await getGuide(slug);
  if (!record) notFound();
  return <GuideView record={record} />;
}
