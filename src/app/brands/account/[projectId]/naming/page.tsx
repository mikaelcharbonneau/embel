import type { Metadata } from "next";
import { ProjectNamingWorkspace } from "@/components/naming/project-naming-workspace";

export const metadata: Metadata = { title: "Naming" };
export default async function ProjectNamingPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return <ProjectNamingWorkspace projectId={projectId} />;
}
