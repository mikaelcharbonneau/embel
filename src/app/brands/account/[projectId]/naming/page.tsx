import { ProjectNamingWorkspace } from "@/components/naming/project-naming-workspace";

export default async function ProjectNamingPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return <ProjectNamingWorkspace projectId={projectId} />;
}
