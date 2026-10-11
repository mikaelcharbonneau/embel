import type { Metadata } from "next";
import { LogoCreationWorkspace } from "@/components/logo-creation/logo-creation-workspace";
export const metadata: Metadata = { title: "Logo editor" };
export default async function LogoEditorPage({ params }: { params: Promise<{ projectId: string }> }) {
  const projectId = (await params).projectId.toLowerCase();
  return <LogoCreationWorkspace key={projectId} projectId={projectId} mode="refine" />;
}
