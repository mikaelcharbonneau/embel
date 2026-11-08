"use client";
import { useCallback, useEffect } from "react";
import { useRouter } from "next/navigation";
import { logoUuidSchema } from "@/domain/logo-vector";
import { useProjectProgress } from "@/components/workspace/project-progress";
import stage from "@/styles/branding-stage.module.css";
import { LogoCreationWorkspace } from "./logo-creation-workspace";

export function LogoCreationPage({ projectId }: { projectId?: string }) {
  const router = useRouter();
  const progress = useProjectProgress();
  // A complete brand shows its Logo step in the project conversation, right
  // after Inspiration; this page stays for projects without that conversation.
  const inConversation = Boolean(projectId && progress?.projectId === projectId && progress.scope === "complete_brand");
  useEffect(() => { if (inConversation && projectId) router.replace(`/brands/account/${projectId}?view=strategy#journey-logo`); }, [inConversation, projectId, router]);
  const confirmedCreation = useCallback((id: string) => {
    const parsed = logoUuidSchema.safeParse(id);
    if (parsed.success) router.replace(`/brands/account/${parsed.data}/logo`);
  }, [router]);
  if (inConversation) return null;
  return <div className={projectId ? stage.frame : "page project-logo-page"}><LogoCreationWorkspace projectId={projectId} onProjectCreated={projectId ? undefined : confirmedCreation} /></div>;
}
