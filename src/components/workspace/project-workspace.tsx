"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { z } from "zod";
import { accountProjectResponseSchema } from "@/domain/project-api";
import {
  getProjectHandoff,
  projectEvidenceStatus,
  projectStrategyHref,
  type ProjectStageEvidence,
} from "@/domain/project-handoff";
import { AccountRequestError } from "./account-api";
import { boundedAccountRequest } from "./bounded-account-request";
import { AccountStatus, useAccountSession, type VerifiedAccount } from "./account-session";
import { accountDraftChanged, reconcileAccountWorkspace } from "./account-draft-memory";
import { useProjectNextStep } from "./use-project-next-step";
import { ProjectProgressContext, type ProjectProgress } from "./project-progress";
import {
  ConversationStepContext,
  journeySectionId,
  useProjectHeader,
  type ConversationSteps,
} from "@/components/journey/project-header";
import type { SaveState } from "@/components/journey/project-capsule";
import { projectJourney, type JourneyStepView } from "@/domain/journey";
import { ProjectArtwork } from "@/components/ui/project-artwork";

type Stage = "strategy" | "naming" | "identity" | "files";
type EvidenceReporter = (value: ProjectStageEvidence) => void;
const IdentityEvidenceContext = createContext<EvidenceReporter | null>(null);
const LogoEvidenceContext = createContext<EvidenceReporter | null>(null);

function useProjectEvidence(value: ProjectStageEvidence | null, report: EvidenceReporter | null) {
  const ownerId = value?.ownerId,
    projectId = value?.projectId,
    projectRevision = value?.projectRevision,
    approved = value?.approved,
    needsReview = value?.needsReview;
  useEffect(() => {
    if (!ownerId || !projectId || !projectRevision) return;
    report?.({ ownerId, projectId, projectRevision, approved: Boolean(approved), needsReview: Boolean(needsReview) });
    // Leaving a verified surface cannot keep asserting approval. Known stale
    // work stays visible until a later verified snapshot clears that evidence.
    return () => report?.({ ownerId, projectId, projectRevision, approved: false, needsReview: Boolean(needsReview) });
  }, [report, ownerId, projectId, projectRevision, approved, needsReview]);
}
export function useProjectLogoEvidence(value: ProjectStageEvidence | null) {
  useProjectEvidence(value, useContext(LogoEvidenceContext));
}
function projectRoute(projectId: string, pathname: string) {
  const inspiration = pathname.endsWith("/inspiration"),
    brandBoard = pathname === `/brands/account/${projectId}/brand-board`;
  const stage: Stage = pathname.endsWith("/deliverables")
    ? "files"
    : pathname.endsWith("/naming")
      ? "naming"
      : /\/identity|\/logo|\/inspiration|\/brand-board/.test(pathname)
        ? "identity"
        : "strategy";
  return { inspiration, brandBoard, stage };
}

export function AccountProjectWorkspaceShell({ projectId, children }: { projectId: string; children: ReactNode }) {
  const { session } = useAccountSession();
  const pathname = usePathname();
  if (!z.uuid().safeParse(projectId).success)
    return (
      <div className="page">
        <h1>Project not found</h1>
        <Link href="/brands">Back to Projects</Link>
      </div>
    );
  if (session.status !== "ready") {
    const { stage } = projectRoute(projectId, pathname);
    return (
      <section className={`project-workspace project-stage-${stage}`}>
        <div className="project-workspace-content">
          <div className="project-access-state">
            <h1>Project workspace</h1>
            <AccountStatus />
            <Link href="/brands">Back to Projects</Link>
          </div>
        </div>
      </section>
    );
  }
  return (
    <OwnedProjectShell
      key={`${session.userId}:${session.generation}:${projectId}`}
      projectId={projectId}
      account={session}
    >
      {children}
    </OwnedProjectShell>
  );
}

const empty = () => null;
function OwnedProjectShell({
  projectId,
  account,
  children,
}: {
  projectId: string;
  account: VerifiedAccount;
  children: ReactNode;
}) {
  const { drafts, isCurrent, expire } = useAccountSession();
  const pathname = usePathname();
  const workspace = useSyncExternalStore(drafts.subscribe, () => drafts.get(projectId), empty);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [identityEvidence, setIdentityEvidence] = useState<ProjectStageEvidence | null>(null);
  const [logoEvidence, setLogoEvidence] = useState<ProjectStageEvidence | null>(null);
  const [conversation, setConversation] = useState<ConversationSteps | null>(null);
  const reportIdentity = useCallback(
    (value: ProjectStageEvidence) => {
      if (!isCurrent(account) || value.ownerId !== account.userId || value.projectId !== projectId) return;
      setIdentityEvidence((previous) => (sameEvidence(previous, value) ? previous : value));
    },
    [account, projectId, isCurrent],
  );
  const reportLogo = useCallback(
    (value: ProjectStageEvidence) => {
      if (!isCurrent(account) || value.ownerId !== account.userId || value.projectId !== projectId) return;
      setLogoEvidence((previous) => (sameEvidence(previous, value) ? previous : value));
    },
    [account, projectId, isCurrent],
  );
  useEffect(() => {
    const controller = new AbortController();
    void boundedAccountRequest(`/api/projects/${projectId}`, accountProjectResponseSchema, {
      signal: controller.signal,
    })
      .then(({ project }) => {
        if (controller.signal.aborted || !isCurrent(account)) return;
        if (project.owner_id !== account.userId || project.id !== projectId) {
          expire(account);
          return;
        }
        drafts.set(reconcileAccountWorkspace(drafts.get(projectId), project, account.generation));
        setError(null);
      })
      .catch((error) => {
        if (!isCurrent(account) || controller.signal.aborted) return;
        if (error instanceof AccountRequestError && error.status === 401) expire(account);
        else setError("The saved project could not be verified. Your existing work is kept.");
      });
    return () => controller.abort();
  }, [account, projectId, pathname, attempt, drafts, isCurrent, expire]);
  const live = isCurrent(account);
  const current =
    live &&
    workspace?.ownerId === account.userId &&
    workspace.generation === account.generation &&
    workspace.saved.id === projectId
      ? workspace
      : null;
  const project = current?.saved ?? null;
  const nextHref = useProjectNextStep(account, project);
  // "Saved" only reflects a project head confirmed by the server with no
  // pending edits; read failures and conflicts are reported, not hidden.
  const saveState: SaveState | null =
    error || current?.conflict
      ? "error"
      : current
        ? accountDraftChanged(current)
          ? current.pendingDraftSave
            ? "saving"
            : "unsaved"
          : "saved"
        : null;
  useProjectHeader(
    project
      ? {
          projectId,
          projectName: project.context.selectedName?.trim() || project.title,
          steps: conversationJourney(
            projectJourney({ projectId, pathname, nextHref, shown: conversation?.reached ?? null }),
            conversation,
            projectId,
          ),
          saveState,
        }
      : null,
  );
  if (!live) return null;
  const { inspiration, brandBoard, stage } = projectRoute(projectId, pathname);
  const handoff = project && getProjectHandoff(project);
  const identityStatus = projectEvidenceStatus(identityEvidence, project?.current_revision);
  const logoStatus = projectEvidenceStatus(logoEvidence, project?.current_revision);
  const progress: ProjectProgress | null = project ? { projectId, nextHref } : null;
  return (
    <ProjectProgressContext.Provider value={progress}>
      <ConversationStepContext.Provider value={setConversation}>
        <IdentityEvidenceContext.Provider value={reportIdentity}>
          <LogoEvidenceContext.Provider value={reportLogo}>
            <section className={`project-workspace project-stage-${stage}`}>
              {error && (
                <div className="project-read-notice" role="alert">
                  {error}
                  <button type="button" className="text-link" onClick={() => setAttempt((value) => value + 1)}>
                    Check saved project
                  </button>
                </div>
              )}
              {current?.conflict && (
                <div className="project-read-notice" role="alert">
                  A newer project version is saved. Your edits are kept in this tab.{" "}
                  <Link className="text-link" href={projectStrategyHref(projectId)}>
                    Resolve in Strategy
                  </Link>
                </div>
              )}
              {!inspiration && !brandBoard && handoff?.savedName && !handoff.strategyReady && (
                <div className="project-read-notice" role="status">
                  Strategy needs review. Your saved name, {handoff.savedName}, is kept for review against the updated
                  context.{" "}
                  <Link className="text-link" href={handoff.next.href}>
                    Continue Strategy review
                  </Link>
                </div>
              )}
              {(
                [
                  ["Logo", logoStatus, `/brands/account/${projectId}/logo`],
                  ["Identity", identityStatus, `/brands/account/${projectId}/logo/directions`],
                ] as const
              ).map(([label, status, href]) =>
                status === "needs_review" || status === "recheck" ? (
                  <div className="project-read-notice" role="status" key={label}>
                    {status === "needs_review"
                      ? `${label} needs review. Earlier work is kept.`
                      : `Check ${label} against the current project version. Earlier work is kept.`}{" "}
                    <Link className="text-link" href={href}>
                      Review {label}
                    </Link>
                  </div>
                ) : null,
              )}
              <div className="project-workspace-content">{children}</div>
            </section>
          </LogoEvidenceContext.Provider>
        </IdentityEvidenceContext.Provider>
      </ConversationStepContext.Provider>
    </ProjectProgressContext.Provider>
  );
}

/** Strategy links open the conversation at its Strategy section. While the
 * conversation is open, the step on screen is highlighted and the other steps
 * it holds link to their sections; done and upcoming steps keep their state. */
function conversationJourney(
  steps: JourneyStepView[],
  conversation: ConversationSteps | null,
  projectId: string,
): JourneyStepView[] {
  const conversationHref = projectStrategyHref(projectId);
  return steps.map((step) => {
    if (conversation?.sections.includes(step.id))
      return {
        ...step,
        href: `${conversationHref}#${journeySectionId(step.id)}`,
        status:
          step.id === conversation.viewed
            ? "current"
            : step.status === "current"
              ? step.complete
                ? "done"
                : "upcoming"
              : step.status,
      };
    return step.href === conversationHref
      ? { ...step, href: `${conversationHref}#${journeySectionId(step.id)}` }
      : step;
  });
}

function sameEvidence(previous: ProjectStageEvidence | null, value: ProjectStageEvidence) {
  return (
    previous?.projectRevision === value.projectRevision &&
    previous.approved === value.approved &&
    Boolean(previous.needsReview) === Boolean(value.needsReview)
  );
}

/** Collapsing retains mounted editors and their pending/recovery state. */
export function ProjectDock({ title, context, children }: { title: string; context?: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(true);
  const [tab, setTab] = useState<"chat" | "controls">("controls");
  return (
    <aside className={`project-dock ${open ? "is-open" : "is-collapsed"}`} aria-label={`${title} panel`}>
      <div className="project-dock-tabs">
        {open && (
          <>
            <button type="button" aria-pressed={tab === "chat"} onClick={() => setTab("chat")}>
              Chat
            </button>
            <button type="button" aria-pressed={tab === "controls"} onClick={() => setTab("controls")}>
              Controls
            </button>
          </>
        )}
        <button
          type="button"
          className="project-dock-toggle"
          aria-label={open ? `Collapse ${title} panel` : `Open ${title} panel`}
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <ProjectArtwork name="collapse" />
        </button>
      </div>
      <div hidden={!open} className="project-dock-content">
        <div className="project-dock-heading">
          <strong>{title}</strong>
          {context}
        </div>
        <div hidden={tab !== "controls"}>{children}</div>
        <div hidden={tab !== "chat"} className="project-dock-chat">
          <p>Project context and saved results stay with this workspace.</p>
          <p>Use the Strategy conversation to send a message. This panel does not start an AI request.</p>
        </div>
      </div>
    </aside>
  );
}
