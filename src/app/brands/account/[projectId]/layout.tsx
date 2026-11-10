import { AccountProjectWorkspaceShell } from "@/components/workspace/project-workspace";

export default async function ProjectLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ projectId: string }>;
}) {
  return (
    <AccountProjectWorkspaceShell projectId={(await params).projectId.toLowerCase()}>
      {children}
    </AccountProjectWorkspaceShell>
  );
}
