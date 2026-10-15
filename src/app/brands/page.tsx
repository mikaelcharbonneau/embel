import type { Metadata } from "next";
import { ProjectsWorkspace } from "@/components/workspace/projects-workspace";

export const metadata: Metadata = { title: "Projects" };
export default async function BrandsPage({ searchParams }: { searchParams: Promise<{ state?: string | string[] }> }) {
  const { state } = await searchParams;
  return <ProjectsWorkspace state={state === "deleted" ? "deleted" : "active"} />;
}
