import type { Metadata } from "next";
import { AccountProjectEntry } from "@/components/workspace/account-project-entry";

type Props = { params: Promise<{ projectId: string }>; searchParams: Promise<{ view?: string }> };

// The project name is only read for its verified owner in the browser, so the
// tab names the page instead.
export async function generateMetadata({ searchParams }: Props): Promise<Metadata> {
  return { title: (await searchParams).view === "strategy" ? "Strategy" : "Project" };
}
export default async function AccountBrandPage({ params, searchParams }: Props) {
  const { projectId } = await params;
  return <AccountProjectEntry key={projectId} projectId={projectId.toLowerCase()} view={(await searchParams).view} />;
}
