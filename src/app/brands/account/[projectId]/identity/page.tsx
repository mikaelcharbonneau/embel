import { ProjectIdentityPageWorkspace } from "@/components/identity/project-identity-page";

export default async function ProjectIdentityPage({ params }: { params: Promise<{ projectId: string }> }) {
  const projectId = (await params).projectId.toLowerCase();
  return <ProjectIdentityPageWorkspace key={projectId} projectId={projectId} />;
}
