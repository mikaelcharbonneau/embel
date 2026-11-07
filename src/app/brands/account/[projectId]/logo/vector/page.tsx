import type { Metadata } from "next";
import { LogoEditorWorkspace } from "@/features/logo-vector/components/logo-editor-workspace";
export const metadata: Metadata = { title: "Vector logo" };
export default async function VectorEditorPage({ params }: { params: Promise<{ projectId: string }> }) {
  const projectId = (await params).projectId.toLowerCase();
  return <LogoEditorWorkspace key={projectId} projectId={projectId} />;
}
