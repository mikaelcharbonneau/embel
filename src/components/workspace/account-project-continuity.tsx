"use client";
import type { AccountProject } from "@/domain/project-api";
import { ProjectContinuityPanel } from "@/features/brand-lifecycle/continuity-panel";
import { useAccountSession, type VerifiedAccount } from "./account-session";

/** Mount with an owner/project/generation key after the project has been verified. */
export function AccountProjectContinuity({
  account,
  project,
  dirty,
  conflicted,
  busy,
}: {
  account: VerifiedAccount;
  project: AccountProject;
  dirty: boolean;
  conflicted: boolean;
  busy: boolean;
}) {
  const { isCurrent } = useAccountSession();
  if (!isCurrent(account) || project.owner_id.toLowerCase() !== account.userId.toLowerCase()) return null;
  return <ProjectContinuityPanel project={project} dirty={dirty} conflicted={conflicted} busy={busy} />;
}
