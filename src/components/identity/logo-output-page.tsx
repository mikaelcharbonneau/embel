"use client";
import Link from "next/link";
import { logoUuidSchema } from "@/domain/logo-vector";
import { AccountStatus, useAccountSession, type VerifiedAccount } from "@/components/workspace/account-session";
import { IdentityDirectionsPanel } from "@/features/identity-directions/components/identity-directions-panel";
import { DeliverablesPanel } from "@/features/identity-deliverables/components/deliverables-panel";
import { useLogoDraftMemory } from "./logo-draft-memory-context";
import { useLogoWorkspace } from "./use-logo-workspace";
import { AccountLogoInputs } from "./account-logo-inputs";
import { LogoJourneyNavigation } from "./logo-journey-navigation";
type Stage = "directions" | "deliverables";
export function LogoOutputPage({ projectId, stage }: { projectId: string; stage: Stage }) {
  const { session } = useAccountSession(), memory = useLogoDraftMemory();
  const parsed = logoUuidSchema.safeParse(projectId);
  if (!parsed.success) return <section className={`page project-output-page project-output-${stage}`}><h1>Logo workspace not found</h1><Link href="/brands">Back to brands</Link></section>;
  return <section className={`page project-output-page project-output-${stage}`}>
    <header className="page-heading"><h1>{stage === "directions" ? "Build the whole identity" : "Your brand, ready to use"}</h1><Link href={`/brands/account/${parsed.data}`}>Back to project</Link></header>
    <LogoJourneyNavigation projectId={parsed.data} current={stage} />
    <AccountStatus retainedEdits={memory.hasUnsaved()} />
    {session.status === "ready" && <OwnedLogoOutput key={`${session.userId}:${session.generation}:${parsed.data}:${stage}`} account={session} projectId={parsed.data} stage={stage} />}
  </section>;
}
function OwnedLogoOutput({ account, projectId, stage }: { account: VerifiedAccount; projectId: string; stage: Stage }) {
  const { isCurrent } = useAccountSession(), memory = useLogoDraftMemory();
  const state = useLogoWorkspace({ projectId, memory });
  if (!isCurrent(account)) return null;
  const workspace = state.workspace?.ownerId === account.userId && state.workspace.projectId === projectId ? state.workspace : null;
  if (!workspace || !state.client) return <div role="status">{state.error ?? "Loading your saved logo workspace…"}{state.error && <p><button className="button secondary small" type="button" onClick={() => void state.reload(false)}>Check saved workspace</button></p>}</div>;
  return stage === "directions" ? <IdentityDirectionsPanel workspace={workspace} client={state.client} controls={<AccountLogoInputs account={account} workspace={workspace} client={state.client} mode="fonts" canWrite={Boolean(state.canEdit)} />} /> : <DeliverablesPanel workspace={workspace} client={state.client} />;
}
