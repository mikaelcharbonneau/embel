import { redirect } from "next/navigation";
import { projectStrategyHref } from "@/domain/project-handoff";

/** Naming lives in the project conversation (Voice · Name); older links land there. */
export default async function ProjectNamingPage({ params }: { params: Promise<{ projectId: string }> }) {
  const projectId = (await params).projectId.toLowerCase();
  redirect(`${projectStrategyHref(projectId)}#journey-voice`);
}
