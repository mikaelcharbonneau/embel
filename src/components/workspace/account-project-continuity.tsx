"use client";
import { useEffect, useMemo, useState } from "react";
import type { AccountProject } from "@/domain/project-api";
import type { StandalonePromotionSource } from "@/domain/standalone-promotion";
import { FrozenStandaloneSource } from "@/features/brand-lifecycle/frozen-source";
import { ProjectContinuityPanel } from "@/features/brand-lifecycle/continuity-panel";
import { ProjectIdeaAttachments } from "@/features/idea-project-attachment/project-attachments";
import { useAccountSession, type VerifiedAccount } from "./account-session";
import { createAccountLifecycleClient } from "./account-lifecycle-client";

/** Mount with an owner/project/generation key after the project has been verified. */
export function AccountProjectContinuity({ account, project, dirty, conflicted, expanding, onExpand }: {
  account: VerifiedAccount; project: AccountProject; dirty: boolean; conflicted: boolean;
  expanding: boolean; onExpand(): Promise<void>;
}) {
  const { isCurrent, expire } = useAccountSession();
  const client = useMemo(() => createAccountLifecycleClient(account, isCurrent, expire), [account, isCurrent, expire]);
  const [result, setResult] = useState<{ source: StandalonePromotionSource | null; unavailable: boolean } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void client.getStandalonePromotionSource(project.id, controller.signal).then(source => {
      if (!controller.signal.aborted && isCurrent(account)) setResult({ source, unavailable: false });
    }).catch(() => {
      if (!controller.signal.aborted && isCurrent(account)) setResult({ source: null, unavailable: true });
    });
    return () => controller.abort();
  }, [client, account, project.id, isCurrent]);
  if (!isCurrent(account) || project.owner_id.toLowerCase() !== account.userId.toLowerCase()) return null;
  return <>
    <ProjectContinuityPanel project={project} source={result?.source ?? null} dirty={dirty} conflicted={conflicted} expanding={expanding} onExpand={onExpand} />
    {result?.source && <FrozenStandaloneSource account={account} projectId={project.id} source={result.source} />}
    {result?.unavailable && <p className="field-hint">The saved tool origin could not be loaded. Your brand context is still available.</p>}
    <ProjectIdeaAttachments account={account} projectId={project.id} />
  </>;
}
