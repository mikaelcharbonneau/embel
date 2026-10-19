import type { Metadata } from "next";
import { LogoCreationPage } from "@/components/logo-creation/logo-creation-page";
export const metadata: Metadata = { title: "Logo concepts" };
export default async function SavedLogoPage({ params }: { params: Promise<{ projectId: string }> }) {
  const projectId = (await params).projectId.toLowerCase();
  return <LogoCreationPage key={projectId} projectId={projectId} />;
}
