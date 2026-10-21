"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { z } from "zod";
import { accountProjectResponseSchema } from "@/domain/project-api";
import { getNamingReadiness } from "@/domain/project-naming";
import { getProjectHandoff, projectEvidenceStatus, type ProjectStageEvidence } from "@/domain/project-handoff";
import type { ProjectScope } from "@/domain/projects";
import { AccountRequestError } from "./account-api";
import { boundedAccountRequest } from "./bounded-account-request";
import { AccountStatus, useAccountSession, type VerifiedAccount } from "./account-session";
import { accountDraftChanged, reconcileAccountWorkspace } from "./account-draft-memory";
import { ProjectArtwork } from "@/components/ui/project-artwork";
import { LogoJourneyNavigation, visualProjectNavigationLock, type LogoJourneyStage } from "@/components/identity/logo-journey-navigation";

type Stage = "strategy" | "naming" | "identity" | "files";
type EvidenceReporter = (value: ProjectStageEvidence) => void;
const IdentityEvidenceContext = createContext<EvidenceReporter | null>(null);
const LogoEvidenceContext = createContext<EvidenceReporter | null>(null);
function useProjectEvidence(value: ProjectStageEvidence | null, report: EvidenceReporter | null) {
  const ownerId = value?.ownerId, projectId = value?.projectId, projectRevision = value?.projectRevision, approved = value?.approved, needsReview = value?.needsReview;
  useEffect(() => {
    if (!ownerId || !projectId || !projectRevision) return;
    report?.({ ownerId, projectId, projectRevision, approved: Boolean(approved), needsReview: Boolean(needsReview) });
    // Leaving a verified surface cannot keep asserting approval. Known stale
    // work stays visible until a later verified snapshot clears that evidence.
    return () => report?.({ ownerId, projectId, projectRevision, approved: false, needsReview: Boolean(needsReview) });
  }, [report, ownerId, projectId, projectRevision, approved, needsReview]);
}
export function useProjectIdentityEvidence(value: ProjectStageEvidence | null) {
  useProjectEvidence(value, useContext(IdentityEvidenceContext));
}
export function useProjectLogoEvidence(value: ProjectStageEvidence | null) {
  useProjectEvidence(value, useContext(LogoEvidenceContext));
}
export function ProjectStageNavigation({ base, stage, scope, strategyReady, nameSelected, identityReady = false, namingReady = strategyReady, dirty = false, checking = false, checkingReason = "Checking saved project…" }: {
  base: string; stage: Stage; scope: ProjectScope; strategyReady: boolean; nameSelected: boolean; identityReady?: boolean; namingReady?: boolean; dirty?: boolean; checking?: boolean; checkingReason?: string;
}) {
  const visualLock = visualProjectNavigationLock({ checking, checkingReason, dirty, scope });
  const stages = [
    { key: "strategy", label: "Strategy", href: base, approved: strategyReady, locked: false },
    { key: "naming", label: "Naming", href: `${base}/naming`, approved: nameSelected, locked: checking || dirty || scope === "visual_identity_only" || !namingReady },
    // References can be explored before approval; the saved generation gates still apply.
    { key: "identity", label: "Logo & identity", href: `${base}/inspiration`, approved: identityReady, locked: Boolean(visualLock) },
    { key: "files", label: "Files", href: `${base}/logo/deliverables`, approved: false, locked: Boolean(visualLock) },
  ];
  const decisions = Number(strategyReady) + Number(nameSelected) + Number(identityReady);
  return <nav className="project-stage-navigation" aria-label="Project stages">{stages.map(item => item.locked
    ? <button key={item.key} type="button" disabled aria-current={stage === item.key ? "page" : undefined} title={checking ? checkingReason : dirty ? "Save or resolve your project edits first" : item.key === "naming" && scope !== "visual_identity_only" ? "Complete Strategy review first" : "Expand the project scope first"}><ProjectArtwork name="lock" />{item.label}</button>
    : <Link key={item.key} href={item.href} aria-current={stage === item.key ? "page" : undefined}>{item.approved && <ProjectArtwork name="check" />}{item.label}</Link>)}<span className="project-stage-progress">{checking ? "Saved decisions not confirmed" : `${decisions} saved ${decisions === 1 ? "decision" : "decisions"}`}<span className="sr-only">. A saved name is a project choice. Identity approval is checked in its saved workspace.</span></span></nav>;
}

function projectRoute(projectId: string, pathname: string) {
  const inspiration = pathname.endsWith("/inspiration"), brandBoard = pathname === `/brands/account/${projectId}/brand-board`;
  const stage: Stage = pathname.endsWith("/deliverables") ? "files" : pathname.endsWith("/naming") ? "naming" : /\/identity|\/logo|\/inspiration|\/brand-board/.test(pathname) ? "identity" : "strategy";
  const identityStage: LogoJourneyStage = inspiration ? "inspiration" : brandBoard ? "board" : pathname.endsWith("/identity") ? "systems" : pathname.endsWith("/directions") ? "directions" : pathname.endsWith("/vector") || pathname.endsWith("/editor") ? "vector" : "concepts";
  return { inspiration, brandBoard, stage, identityStage };
}

export function AccountProjectWorkspaceShell({ projectId, children }: { projectId: string; children: ReactNode }) {
  const { session } = useAccountSession();
  const pathname = usePathname();
  if (!z.uuid().safeParse(projectId).success) return <div className="page"><h1>Project not found</h1><Link href="/brands">Back to Projects</Link></div>;
  if (session.status !== "ready") {
    const { stage, identityStage } = projectRoute(projectId, pathname), checkingReason = session.status === "checking" ? "Checking your account…" : "Verify your account before continuing";
    return <section className={`project-workspace project-stage-${stage}`}>
      <header className="project-workspace-header"><div><Link href="/brands">Projects</Link><ProjectArtwork name="chevron" /><span className="project-workspace-title">Project</span></div><span className="project-workspace-save" role="status" data-project-status={session.status === "checking" ? "checking" : "unverified"}>{session.status === "checking" ? "Checking account…" : "Account not verified"}</span></header>
      <ProjectStageNavigation base={`/brands/account/${projectId}`} stage={stage} scope="complete_brand" strategyReady={false} nameSelected={false} checking checkingReason={checkingReason} />
      {stage === "identity" && <LogoJourneyNavigation projectId={projectId} current={identityStage} checking checkingReason={checkingReason} />}
      <div className="project-workspace-content"><div className="project-access-state"><h1>Project workspace</h1><AccountStatus /><Link href="/brands">Back to Projects</Link></div></div>
    </section>;
  }
  return <OwnedProjectShell key={`${session.userId}:${session.generation}:${projectId}`} projectId={projectId} account={session}>{children}</OwnedProjectShell>;
}

const empty = () => null;
function OwnedProjectShell({ projectId, account, children }: { projectId: string; account: VerifiedAccount; children: ReactNode }) {
  const { drafts, isCurrent, expire } = useAccountSession();
  const pathname = usePathname();
  const workspace = useSyncExternalStore(drafts.subscribe, () => drafts.get(projectId), empty);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [identityEvidence, setIdentityEvidence] = useState<ProjectStageEvidence | null>(null);
  const [logoEvidence, setLogoEvidence] = useState<ProjectStageEvidence | null>(null);
  const reportIdentity = useCallback((value: ProjectStageEvidence) => {
    if (!isCurrent(account) || value.ownerId !== account.userId || value.projectId !== projectId) return;
    setIdentityEvidence(previous => sameEvidence(previous, value) ? previous : value);
  }, [account, projectId, isCurrent]);
  const reportLogo = useCallback((value: ProjectStageEvidence) => {
    if (!isCurrent(account) || value.ownerId !== account.userId || value.projectId !== projectId) return;
    setLogoEvidence(previous => sameEvidence(previous, value) ? previous : value);
  }, [account, projectId, isCurrent]);
  useEffect(() => {
    const controller = new AbortController();
    void boundedAccountRequest(`/api/projects/${projectId}`, accountProjectResponseSchema, { signal: controller.signal }).then(({ project }) => {
      if (controller.signal.aborted || !isCurrent(account)) return;
      if (project.owner_id !== account.userId || project.id !== projectId) { expire(account); return; }
      drafts.set(reconcileAccountWorkspace(drafts.get(projectId), project, account.generation));
      setError(null);
    }).catch(error => {
      if (!isCurrent(account) || controller.signal.aborted) return;
      if (error instanceof AccountRequestError && error.status === 401) expire(account);
      else setError("The saved project could not be verified. Your existing work is kept.");
    });
    return () => controller.abort();
  }, [account, projectId, pathname, attempt, drafts, isCurrent, expire]);
  if (!isCurrent(account)) return null;
  const current = workspace?.ownerId === account.userId && workspace.generation === account.generation && workspace.saved.id === projectId ? workspace : null;
  const { inspiration, brandBoard, stage, identityStage } = projectRoute(projectId, pathname);
  const project = current?.saved;
  const dirty = Boolean(current && (accountDraftChanged(current) || current.conflict));
  const handoff = project && getProjectHandoff(project);
  const identityStatus = projectEvidenceStatus(identityEvidence, project?.current_revision);
  const logoStatus = projectEvidenceStatus(logoEvidence, project?.current_revision);
  return <IdentityEvidenceContext.Provider value={reportIdentity}><LogoEvidenceContext.Provider value={reportLogo}><section className={`project-workspace project-stage-${stage}`}>
    <header className="project-workspace-header"><div><Link href="/brands">Projects</Link><ProjectArtwork name="chevron" /><span className="project-workspace-title">{project?.title ?? "Project"}</span></div><span className="project-workspace-save" role="status" data-project-status={dirty ? "unsaved" : project ? error ? "last-confirmed" : "saved" : error ? "unverified" : "checking"}>{project && !dirty && !error && <ProjectArtwork name="check" />}{dirty ? "Unsaved project edits" : project ? `${error ? "Last confirmed project" : "Saved project"} · v${project.current_revision}` : error ? "Project not verified" : "Checking project…"}</span></header>
    <ProjectStageNavigation base={`/brands/account/${projectId}`} stage={stage} scope={project?.scope ?? "complete_brand"} strategyReady={Boolean(handoff?.strategyReady)} namingReady={Boolean(project && getNamingReadiness(project.context, project.scope).ready)} nameSelected={Boolean(project?.context.selectedName)} identityReady={!dirty && !error && identityStatus === "approved"} dirty={dirty} checking={!project} checkingReason={error ? "Check saved project before continuing" : undefined} />
    {stage === "identity" && <LogoJourneyNavigation projectId={projectId} current={identityStage} scope={project?.scope ?? "complete_brand"} dirty={dirty} checking={!project} checkingReason={error ? "Check saved project before continuing" : undefined} />}
    {error && <div className="project-read-notice" role="alert">{error}<button type="button" className="text-link" onClick={() => setAttempt(value => value + 1)}>Check saved project</button></div>}
    {current?.conflict && <div className="project-read-notice" role="alert">A newer project version is saved. Your edits are kept in this tab. <Link className="text-link" href={`/brands/account/${projectId}`}>Resolve in Strategy</Link></div>}
    {!inspiration && !brandBoard && handoff?.savedName && !handoff.strategyReady && project?.scope === "complete_brand" && <div className="project-read-notice" role="status">Strategy needs review. Your saved name, {handoff.savedName}, is kept for review against the updated context. <Link className="text-link" href={handoff.next.href}>Continue Strategy review</Link></div>}
    {([['Logo', logoStatus, `/brands/account/${projectId}/logo`], ['Identity', identityStatus, `/brands/account/${projectId}/logo/directions`]] as const).map(([label, status, href]) => status === "needs_review" || status === "recheck" ? <div className="project-read-notice" role="status" key={label}>{status === "needs_review" ? `${label} needs review. Earlier work is kept.` : `Check ${label} against the current project version. Earlier work is kept.`} <Link className="text-link" href={href}>Review {label}</Link></div> : null)}
    <div className="project-workspace-content">{children}</div>
  </section></LogoEvidenceContext.Provider></IdentityEvidenceContext.Provider>;
}

function sameEvidence(previous: ProjectStageEvidence | null, value: ProjectStageEvidence) {
  return previous?.projectRevision === value.projectRevision && previous.approved === value.approved && Boolean(previous.needsReview) === Boolean(value.needsReview);
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
