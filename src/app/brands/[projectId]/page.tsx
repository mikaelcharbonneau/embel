import type { Metadata } from "next";
import { ProjectEditor } from "@/components/workspace/project-editor";

export const metadata: Metadata = { title: "Brand draft" };
export default async function BrandDraftPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return <ProjectEditor projectId={projectId} />;
}
