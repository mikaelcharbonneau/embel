"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { z } from "zod";
import { accountProjectResponseSchema } from "@/domain/project-api";
import { getNamingReadiness } from "@/domain/project-naming";
import type { ProjectScope } from "@/domain/projects";
import { accountRequest, AccountRequestError } from "./account-api";
import { AccountStatus, useAccountSession, type VerifiedAccount } from "./account-session";
import { accountDraftChanged } from "./account-draft-memory";
import { accountProjectDraft } from "./project-draft-adapter";
import { ProjectArtwork } from "@/components/ui/project-artwork";

type Stage = "strategy" | "naming" | "identity" | "files";
type IdentityEvidence = { ownerId: string; projectId: string; projectRevision: number; approved: boolean };
const IdentityEvidenceContext = createContext<((value: IdentityEvidence) => void) | null>(null);
export function useProjectIdentityEvidence(value: IdentityEvidence | null) {
  const report = useContext(IdentityEvidenceContext);
  const ownerId = value?.ownerId, projectId = value?.projectId, projectRevision = value?.projectRevision, approved = value?.approved;
  useEffect(() => {
    if (!ownerId || !projectId || !projectRevision) return;
    report?.({ ownerId, projectId, projectRevision, approved: Boolean(approved) });
    return () => report?.({ ownerId, projectId, projectRevision, approved: false });
  }, [report, ownerId, projectId, projectRevision, approved]);
}
export function ProjectStageNavigation({ base, stage, scope, strategyReady, nameSelected, identityReady = false, namingReady = strategyReady, dirty = false }: {
  base: string; stage: Stage; scope: ProjectScope; strategyReady: boolean; nameSelected: boolean; identityReady?: boolean; namingReady?: boolean; dirty?: boolean;
}) {
  const stages = [
    { key: "strategy", label: "Strategy", href: base, approved: strategyReady, locked: false },
    { key: "naming", label: "Naming", href: `${base}/naming`, approved: nameSelected, locked: dirty || scope === "visual_identity_only" || !namingReady },
    // References can be explored before approval; the saved generation gates still apply.
    { key: "identity", label: "Identity", href: `${base}/identity`, approved: identityReady, locked: dirty || scope === "naming_only" },
    { key: "files", label: "Files", href: `${base}/logo/deliverables`, approved: false, locked: dirty || scope === "naming_only" },
  ];
  return <nav className="project-stage-navigation" aria-label="Project stages">{stages.map(item => item.locked
    ? <button key={item.key} type="button" disabled title={dirty ? "Save or resolve your project edits first" : item.key === "naming" ? "Complete Strategy review first" : "Expand the project scope first"}><ProjectArtwork name="lock" />{item.label}</button>
    : <Link key={item.key} href={item.href} aria-current={stage === item.key ? "page" : undefined}>{item.approved && <ProjectArtwork name="check" />}{item.label}</Link>)}<span className="project-stage-progress">{Number(strategyReady) + Number(nameSelected) + Number(identityReady)} verified approvals<span className="sr-only">. Identity approval is checked in its saved workspace.</span></span></nav>;
}

export function AccountProjectWorkspaceShell({ projectId, children }: { projectId: string; children: ReactNode }) {
  const { session } = useAccountSession();
  if (!z.uuid().safeParse(projectId).success) return <div className="page"><h1>Project not found</h1><Link href="/brands">Back to Projects</Link></div>;
  if (session.status !== "ready") return <div className="project-access-state"><h1>Project workspace</h1><AccountStatus /><Link href="/brands">Back to Projects</Link></div>;
  return <OwnedProjectShell key={`${session.userId}:${session.generation}:${projectId}`} projectId={projectId} account={session}>{children}</OwnedProjectShell>;
}

const empty = () => null;
function OwnedProjectShell({ projectId, account, children }: { projectId: string; account: VerifiedAccount; children: ReactNode }) {
  const { drafts, isCurrent, expire } = useAccountSession();
  const pathname = usePathname();
  const workspace = useSyncExternalStore(drafts.subscribe, () => drafts.get(projectId), empty);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [identityEvidence, setIdentityEvidence] = useState<IdentityEvidence | null>(null);
  const reportIdentity = useCallback((value: IdentityEvidence) => {
    if (!isCurrent(account) || value.ownerId !== account.userId || value.projectId !== projectId) return;
    setIdentityEvidence(previous => previous?.projectRevision === value.projectRevision && previous.approved === value.approved ? previous : value);
  }, [account, projectId, isCurrent]);
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("timeout")), 15000);
    void accountRequest(`/api/projects/${projectId}`, accountProjectResponseSchema, { signal: controller.signal }).then(({ project }) => {
      if (controller.signal.aborted || !isCurrent(account)) return;
      if (project.owner_id !== account.userId || project.id !== projectId) { expire(account); return; }
      const previous = drafts.get(projectId);
      if (!previous || previous.ownerId !== account.userId || previous.generation !== account.generation || !accountDraftChanged(previous) && project.current_revision > previous.saved.current_revision) {
        drafts.set({ ownerId: account.userId, generation: account.generation, saved: project, draft: accountProjectDraft(project), conflict: false });
      }
      setError(null);
    }).catch(error => {
      if (!isCurrent(account) || controller.signal.aborted && controller.signal.reason?.message !== "timeout") return;
      if (error instanceof AccountRequestError && error.status === 401) expire(account);
      else setError("The saved project could not be verified. Your existing work is kept.");
    }).finally(() => clearTimeout(timer));
    return () => { clearTimeout(timer); controller.abort(); };
  }, [account, projectId, pathname, attempt, drafts, isCurrent, expire]);
  if (!isCurrent(account)) return null;
  const current = workspace?.ownerId === account.userId && workspace.generation === account.generation && workspace.saved.id === projectId ? workspace : null;
  const stage = pathname.endsWith("/deliverables") ? "files" : pathname.endsWith("/naming") ? "naming" : /\/identity|\/logo/.test(pathname) ? "identity" : "strategy";
  const project = current?.saved;
  const dirty = Boolean(current && (accountDraftChanged(current) || current.conflict));
  return <IdentityEvidenceContext.Provider value={reportIdentity}><section className={`project-workspace project-stage-${stage}`}>
    <header className="project-workspace-header"><div><Link href="/brands">Projects</Link><ProjectArtwork name="chevron" /><span className="project-workspace-title">{project?.title ?? "Project"}</span></div><span className="project-workspace-save">{project && !dirty && <ProjectArtwork name="check" />}{dirty ? "Unsaved project edits" : project ? `Saved project · v${project.current_revision}` : "Checking project…"}</span></header>
    <ProjectStageNavigation base={`/brands/account/${projectId}`} stage={stage} scope={project?.scope ?? "complete_brand"} strategyReady={Boolean(project && getNamingReadiness(project.context, "complete_brand").ready)} namingReady={Boolean(project && getNamingReadiness(project.context, project.scope).ready)} nameSelected={Boolean(project?.context.selectedName)} identityReady={Boolean(identityEvidence?.approved && identityEvidence.projectRevision === project?.current_revision)} dirty={dirty || !project} />
    {error && <div className="project-read-notice" role="alert">{error}<button type="button" className="text-link" onClick={() => setAttempt(value => value + 1)}>Check saved project</button></div>}
    <div className="project-workspace-content">{children}</div>
  </section></IdentityEvidenceContext.Provider>;
}

/** Collapsing retains mounted editors and their pending/recovery state. */
export function ProjectDock({ title, context, children }: { title: string; context?: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(true);
  const [tab, setTab] = useState<"chat" | "controls">("controls");
  return <aside className={`project-dock ${open ? "is-open" : "is-collapsed"}`} aria-label={`${title} panel`}>
    <div className="project-dock-tabs">{open && <><button type="button" aria-pressed={tab === "chat"} onClick={() => setTab("chat")}>Chat</button><button type="button" aria-pressed={tab === "controls"} onClick={() => setTab("controls")}>Controls</button></>}<button type="button" className="project-dock-toggle" aria-label={open ? `Collapse ${title} panel` : `Open ${title} panel`} aria-expanded={open} onClick={() => setOpen(value => !value)}><ProjectArtwork name="collapse" /></button></div>
    <div hidden={!open} className="project-dock-content"><div className="project-dock-heading"><strong>{title}</strong>{context}</div><div hidden={tab !== "controls"}>{children}</div><div hidden={tab !== "chat"} className="project-dock-chat"><p>Project context and saved results stay with this workspace.</p><p>Use the Strategy conversation to send a message. This panel does not start an AI request.</p></div></div>
  </aside>;
}
