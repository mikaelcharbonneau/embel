"use client";
import Link from "next/link";
import { projectStrategyHref } from "@/domain/project-handoff";
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { z } from "zod";
import { AccountStatus, useAccountSession, type VerifiedAccount } from "@/components/workspace/account-session";
import { createReferenceIntentMemory, useIdentityReferences, type ReferenceIntentMemory } from "./use-identity-references";
import { IdentityReferenceUpload } from "./identity-reference-upload";
import { ReferenceGrid } from "./reference-grid";
import { ProjectDock } from "@/components/workspace/project-workspace";

export type ReferenceStateHint = { ownerId: string; projectId: string; generation: number; referenceRevision: number | null; pending: boolean };
type ReferenceStateListener = (hint: ReferenceStateHint) => void;
export function ProjectReferencesWorkspace({ projectId: routeProjectId, children, onReferenceStateChange }: { projectId: string; children?: ReactNode; onReferenceStateChange?: ReferenceStateListener }) {
  const { session } = useAccountSession();
  const [memory] = useState(createReferenceIntentMemory);
  useEffect(() => { if (session.status === "ready") memory.bind(session.userId); else if (session.status === "signed_out") memory.clear(); }, [memory, session]);
  const parsed = z.uuid().safeParse(routeProjectId);
  if (!parsed.success) return <div className="page identity-references-page"><h1>Identity workspace not found</h1><Link className="text-link" href="/brands">Back to brands</Link></div>;
  if (session.status !== "ready") return <div className="page identity-references-page"><h1>Identity</h1><AccountStatus /></div>;
  const projectId = parsed.data.toLowerCase();
  return <OwnedProjectReferences key={`${session.userId}:${session.generation}:${projectId}`} account={session} projectId={projectId} memory={memory} onReferenceStateChange={onReferenceStateChange}>{children}</OwnedProjectReferences>;
}
function OwnedProjectReferences({ account, projectId, memory, children, onReferenceStateChange }: { account: VerifiedAccount; projectId: string; memory: ReferenceIntentMemory; children?: ReactNode; onReferenceStateChange?: ReferenceStateListener }) {
  const reference = useIdentityReferences(account, projectId, memory);
  const { identityDrafts } = useAccountSession();
  const uploading = useSyncExternalStore(identityDrafts.subscribe, () => identityDrafts.referenceUpload(account.userId, projectId), () => null);
  const [view, setView] = useState<"moodboard" | "saved">("moodboard");
  const revision = reference.page?.referenceRevision ?? null;
  const pending = Boolean(uploading) || reference.loading || reference.loadingMore || reference.pending.size > 0 || reference.intents.size > 0;
  useEffect(() => { onReferenceStateChange?.({ ownerId: account.userId, projectId, generation: account.generation, referenceRevision: revision, pending }); }, [account.userId, account.generation, projectId, revision, pending, onReferenceStateChange]);
  return <div className={`page identity-references-page project-workbench ${view === "saved" ? "project-references-saved" : ""}`}><div className="project-workbench-canvas"><header className="identity-references-heading"><div>{reference.project && <span>{reference.project.title}</span>}<h1 tabIndex={-1}>{view === "moodboard" ? "Build a visual starting point" : "Review your identity"}</h1><p>{view === "moodboard" ? "Collect references for saved identity systems. Inspiration likes guide logo previews separately." : "Saved systems, components and version history."}</p></div><Link className="text-link" href={projectStrategyHref(projectId)}>Back to project</Link></header>
    <div className="project-workbench-tabs" aria-label="Identity views"><button type="button" aria-pressed={view === "moodboard"} onClick={() => setView("moodboard")}>Moodboard</button>{children && <button type="button" aria-pressed={view === "saved"} onClick={() => setView("saved")}>Saved systems</button>}</div>
    {reference.projectError ? <div className="identity-reference-notice" role="alert"><p>{reference.projectError}</p><button className="button secondary small" type="button" onClick={reference.checkProject}>Check project</button></div> : !reference.project ? <p className="identity-reference-muted" role="status">Loading your saved project…</p> : reference.project.scope === "naming_only" ? <div className="identity-reference-notice"><h2>Expand this project to start Identity</h2><p>This project is set up for Naming. Open the project and choose Expand to complete brand to keep its context and add Identity.</p><Link className="button secondary small" href={projectStrategyHref(projectId)}>Open project</Link></div> : reference.blocked ? <div className="identity-reference-notice" role="status"><h2>Save project changes first</h2><p>Save or resolve your account project edits before changing reference choices.</p><Link className="button secondary small" href={projectStrategyHref(projectId)}>Return to project</Link></div> : <><div hidden={view !== "moodboard"}><IdentityReferenceUpload account={account} projectId={projectId} blocked={reference.blocked || reference.loading || reference.pending.size > 0 || reference.intents.size > 0} onSaved={reference.refresh} /><ReferenceGrid reference={reference} /></div><div hidden={view !== "saved"}>{children}</div></>}
  </div><ProjectDock title="Identity references" context={<p>{reference.project?.title || "Checking saved project"}</p>}><p className="project-dock-note">Choose Ensemble or individual elements on a reference. Your saved choices guide the next direction.</p><p className="project-dock-note">External reference discovery is not connected. Your own saved references remain available.</p>{reference.project && reference.project.scope !== "naming_only" && !reference.blocked ? <Link className="button secondary small" href={`/brands/account/${projectId}/logo`}>Open logo setup</Link> : <button type="button" className="button secondary small" disabled>Open logo setup</button>}</ProjectDock></div>;
}
