"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useProjectProgress } from "@/components/workspace/project-progress";
import stage from "@/styles/branding-stage.module.css";
import { LogoCreationWorkspace } from "./logo-creation-workspace";

export function LogoCreationPage({ projectId }: { projectId: string }) {
  const router = useRouter();
  const progress = useProjectProgress();
  // A complete brand shows its Logo step in the project conversation, right
  // after Inspiration; this page stays for projects without that conversation.
  const inConversation = progress?.projectId === projectId;
  useEffect(() => { if (inConversation) router.replace(`/brands/account/${projectId}?view=strategy#journey-logo`); }, [inConversation, projectId, router]);
  if (inConversation) return null;
  return <div className={stage.frame}><LogoCreationWorkspace projectId={projectId} /></div>;
}
