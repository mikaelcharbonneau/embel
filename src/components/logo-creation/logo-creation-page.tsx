"use client";
import { useCallback } from "react";
import { useRouter } from "next/navigation";
import { logoUuidSchema } from "@/domain/logo-vector";
import stage from "@/styles/branding-stage.module.css";
import { LogoCreationWorkspace } from "./logo-creation-workspace";

export function LogoCreationPage({ projectId }: { projectId?: string }) {
  const router = useRouter();
  const confirmedCreation = useCallback((id: string) => {
    const parsed = logoUuidSchema.safeParse(id);
    if (parsed.success) router.replace(`/brands/account/${parsed.data}/logo`);
  }, [router]);
  return <div className={projectId ? stage.frame : "page project-logo-page"}><LogoCreationWorkspace projectId={projectId} onProjectCreated={projectId ? undefined : confirmedCreation} /></div>;
}
