import type { Metadata } from "next";
import { NewProjectForm } from "@/components/workspace/project-editor";

export const metadata: Metadata = { title: "New project" };
export default async function NewProjectPage({ searchParams }: { searchParams: Promise<{ scope?: string; example?: string }> }) {
  const query = await searchParams;
  const scope = query.scope === "naming_only" || query.scope === "visual_identity_only" ? query.scope : "complete_brand";
  return <NewProjectForm initialScope={scope} exampleId={query.example} />;
}
