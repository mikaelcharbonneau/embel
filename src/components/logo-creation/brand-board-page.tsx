"use client";
import Link from "next/link";
import { useInspiration } from "@/components/inspiration/use-inspiration";
import { BrandBoardSystem } from "./brand-board-system";
import { AccountStatus, useAccountSession, type VerifiedAccount } from "@/components/workspace/account-session";
import { useLogoDraftMemory } from "@/components/identity/logo-draft-memory-context";
import { useLogoWorkspace } from "@/components/identity/use-logo-workspace";
import { useLogoCandidate } from "./use-logo-candidate";
import { LogoVerifiedPreview } from "./verified-preview";
import styles from "./logo-creation.module.css";

export function BrandBoardPage({ projectId }: { projectId: string }) {
  const { session } = useAccountSession();
  return <div className={styles.brandBoard}>
    <header className={styles.brandBoardHeader}><div><h1>Brand board</h1><p>Your brand, at a glance.</p></div><Link className={styles.backToInspiration} href={`/brands/account/${projectId}/logo`}>← Back to logo concepts</Link></header>
    <AccountStatus retainedEdits={false} />
    {session.status === "ready" && <SavedBrandBoard key={`${session.userId}:${session.generation}:${projectId}`} account={session} projectId={projectId} />}
  </div>;
}
function SavedBrandBoard({ account, projectId }: { account: VerifiedAccount; projectId: string }) {
  const { isCurrent } = useAccountSession();
  const memory = useLogoDraftMemory();
  const inspiration = useInspiration(account, projectId);
  const state = useLogoWorkspace({ projectId, memory });
  const owned = isCurrent(account) && state.workspace?.ownerId === account.userId && state.workspace.projectId === projectId;
  const selected = owned ? state.stagePayloads?.concepts?.payload.selected ?? null : null;
  const candidate = useLogoCandidate(owned ? state.client : null, account, projectId, selected);
  if (!owned || !state.client) return <p role="status">{state.error ?? "Loading your saved brand…"}</p>;
  const brief = state.stagePayloads?.brief_references?.payload;
  return <>
    {state.error && <p role="alert">{state.error}</p>}
    {!candidate.item && <section className={styles.brandBoardLogo} aria-label="Selected brand logo"><p role="status">{candidate.error ? "Your selected logo could not be loaded." : candidate.loading || state.status === "loading" ? "Loading your selected logo…" : "Select a logo to start your brand board."}</p>{candidate.error && <button className={styles.secondaryButton} onClick={candidate.refresh}>Try again</button>}</section>}
    {inspiration.error && <p role="alert">{inspiration.error} <button className={styles.secondaryButton} onClick={() => void inspiration.refresh()}>Retry inspiration</button></p>}
    {candidate.item && inspiration.overview && !inspiration.error ? <BrandBoardSystem name={brief?.name || "Your brand"} activity={brief?.activity || ""} logoType={candidate.item.logoType} choices={inspiration.overview.choices} logo={<LogoVerifiedPreview client={state.client} receipt={candidate.item.preview} alt="Selected logo in application preview" />} /> : inspiration.loading && <p role="status">Loading your saved inspiration…</p>}
  </>;
}
