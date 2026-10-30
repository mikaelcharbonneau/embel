import type { Metadata } from "next";
import { AccountProjectEntry } from "@/components/workspace/account-project-entry";

export const metadata: Metadata = { title: "Account brand" };
export default async function AccountBrandPage({ params, searchParams }: { params: Promise<{ projectId: string }>; searchParams: Promise<{ view?: string }> }) {
  const { projectId } = await params;
  return <AccountProjectEntry key={projectId} projectId={projectId.toLowerCase()} view={(await searchParams).view} />;
}
