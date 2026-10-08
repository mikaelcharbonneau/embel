import type { Metadata } from "next";
import { LogoEditorWorkspace } from "@/features/logo-vector/components/logo-editor-workspace";
export const metadata: Metadata = { title: "Logo editor" };
export default async function LogoEditorPage({ params }: { params: Promise<{ projectId: string }> }) {
  const projectId = (await params).projectId.toLowerCase();
  return <LogoEditorWorkspace key={projectId} projectId={projectId} />;
}
