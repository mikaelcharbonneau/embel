import type { Metadata } from "next";
import { AccountProjectEditor } from "@/components/workspace/account-project-editor";

export const metadata: Metadata = { title: "Account brand" };
export default async function AccountBrandPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return <AccountProjectEditor key={projectId} projectId={projectId} />;
}
