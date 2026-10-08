"use client";
import { useCallback } from "react";
import { useRouter } from "next/navigation";
import { logoUuidSchema } from "@/domain/logo-vector";
import { LogoJourneyNavigation } from "@/components/identity/logo-journey-navigation";
import { LogoCreationWorkspace } from "./logo-creation-workspace";

export function LogoCreationPage({ projectId }: { projectId?: string }) {
  const router = useRouter();
  const confirmedCreation = useCallback((id: string) => {
    const parsed = logoUuidSchema.safeParse(id);
    if (parsed.success) router.replace(`/brands/account/${parsed.data}/logo`);
  }, [router]);
  return <div className="page">{projectId && <LogoJourneyNavigation projectId={projectId} current="concepts" />}<LogoCreationWorkspace projectId={projectId} onProjectCreated={projectId ? undefined : confirmedCreation} /></div>;
}
