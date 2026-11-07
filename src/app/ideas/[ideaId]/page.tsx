import type { Metadata } from "next";
import { IdeaDetail } from "@/components/ideas/idea-detail";

export const metadata: Metadata = { title: "Idea" };
export default async function IdeaPage({ params }: { params: Promise<{ ideaId: string }> }) {
  const { ideaId } = await params;
  return <IdeaDetail key={ideaId} ideaId={ideaId} />;
}
