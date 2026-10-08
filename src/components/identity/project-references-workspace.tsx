"use client";
import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { z } from "zod";
import { AccountStatus, useAccountSession, type VerifiedAccount } from "@/components/workspace/account-session";
import { createReferenceIntentMemory, useIdentityReferences, type ReferenceIntentMemory } from "./use-identity-references";
import { ReferenceGrid } from "./reference-grid";

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
  const revision = reference.page?.referenceRevision ?? null;
  const pending = reference.loading || reference.loadingMore || reference.pending.size > 0 || reference.intents.size > 0;
  useEffect(() => { onReferenceStateChange?.({ ownerId: account.userId, projectId, generation: account.generation, referenceRevision: revision, pending }); }, [account.userId, account.generation, projectId, revision, pending, onReferenceStateChange]);
  return <div className="page identity-references-page"><header className="identity-references-heading"><div>{reference.project && <span>{reference.project.title}</span>}<h1 tabIndex={-1}>Identity</h1></div><Link className="text-link" href={`/brands/account/${projectId}`}>Back to project</Link></header>
    {reference.projectError ? <div className="identity-reference-notice" role="alert"><p>{reference.projectError}</p><button className="button secondary small" type="button" onClick={reference.checkProject}>Check project</button></div> : !reference.project ? <p className="identity-reference-muted" role="status">Loading your saved project…</p> : reference.project.scope === "naming_only" ? <div className="identity-reference-notice"><h2>Expand this project to start Identity</h2><p>This project is set up for Naming. Open the project and choose Expand to complete brand to keep its context and add Identity.</p><Link className="button secondary small" href={`/brands/account/${projectId}`}>Open project</Link></div> : reference.blocked ? <div className="identity-reference-notice" role="status"><h2>Save project changes first</h2><p>Save or resolve your account project edits before changing reference choices.</p><Link className="button secondary small" href={`/brands/account/${projectId}`}>Return to project</Link></div> : <><ReferenceGrid reference={reference} />{children}</>}
  </div>;
}
