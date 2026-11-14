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
import { contextDisplayName } from "@/domain/projects";
import {
  getProjectHandoff,
  projectEvidenceStatus,
  projectStrategyHref,
  type ProjectStageEvidence,
} from "@/domain/project-handoff";
import { AccountRequestError } from "./account-api";
import { boundedAccountRequest } from "./bounded-account-request";
import { useAccountSession, type VerifiedAccount } from "./account-session";
import { ProjectAccountState, ProjectOpening, ProjectPageErrorContext } from "./project-page-state";
import { Button } from "@/components/ui/button";
import { InlineMessage } from "@/components/ui/message";
import { reconcileAccountWorkspace } from "./account-draft-memory";
import { accountBarSaveState, accountSaveStatus } from "./account-save-status";
import { useProjectNextStep } from "./use-project-next-step";
import { ProjectProgressContext, type ProjectProgress } from "./project-progress";
import {
  ConversationStepContext,
  journeySectionId,
  useProjectHeader,
  type ConversationSteps,
} from "@/components/journey/project-header";
import { journeyProgress, projectJourney, type JourneyStepView } from "@/domain/journey";
import { WorkspaceNoticeContext } from "./workspace-layout";
import { Icon } from "@/components/ui/icon";

type Stage = "strategy" | "naming" | "identity" | "files";
type EvidenceReporter = (value: ProjectStageEvidence) => void;
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
    // While the account is checked, a neutral frame: never the signed-out notice a returning person would read as
    // "sign in again" (D-055). Once the check answers, the account notice and the way back.
    return (
      <section className={`project-workspace project-stage-${stage}`}>
        <div className="project-workspace-content">
          <div className="project-access-state">
            {session.status === "checking" ? (
              <ProjectOpening />
            ) : (
              <>
                <ProjectAccountState />
                <p className="app-center">
                  <Link className="e-link e-link--standalone" href="/brands">
                    Back to Projects
                  </Link>
                </p>
              </>
            )}
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
  const activity = useSyncExternalStore(drafts.subscribe, () => drafts.activity(projectId), empty);
  const [error, setError] = useState<string | null>(null);
  // The page below shows its own "We couldn’t open this brand" card; the strip then stays out of the way.
  const [pageError, setPageError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [logoEvidence, setLogoEvidence] = useState<ProjectStageEvidence | null>(null);
  const [conversation, setConversation] = useState<ConversationSteps | null>(null);
  const [noticesHosted, setNoticesHosted] = useState(false);
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
        // A brand that doesn't exist shows its own page error below; a notice strip above it would say it twice (D-030).
        else if (error instanceof AccountRequestError && error.status === 404) setError(null);
        else setError("We couldn’t check this brand’s latest save. Your work is kept.");
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
  const evidence = useProjectNextStep(account, project);
  // One answer for the bar, the notices and the pages below (docs/state-machines.md, J2). The bar follows the
  // conversation's answer the moment it is given, before its save is confirmed.
  const journey = project
    ? journeyProgress({
        project: { ...project, context: current?.pendingGuidedContext ?? project.context },
        evidence,
      })
    : null;
  const nextHref = journey?.next?.href ?? null;
  // The same derivation as the project page (docs/state-machines.md, J3). "Saved" only reflects a project
  // head confirmed by the server with no pending edits; a failed read shows its notice instead of a status.
  const saveState = accountBarSaveState(
    accountSaveStatus({ workspace: current, activity: current ? activity : null, readFailed: Boolean(error) }),
  );
  useProjectHeader(
    project
      ? {
          projectId,
          projectName: contextDisplayName(project.context) || project.title,
          steps: conversationJourney(
            projectJourney({ projectId, pathname, progress: journey, shown: conversation?.reached ?? null }),
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
  const logoStatus = projectEvidenceStatus(logoEvidence, project?.current_revision);
  const progress: ProjectProgress | null = project ? { projectId, nextHref } : null;
  const notices = (
    <>
      {error && !pageError && (
        <InlineMessage
          tone="danger"
          actions={
            <Button size="sm" icon="refresh" onClick={() => setAttempt((value) => value + 1)}>
              Try again
            </Button>
          }
        >
          {error}
        </InlineMessage>
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
          Strategy needs review. Your saved name, {handoff.savedName}, is kept for review against the updated context.{" "}
          <Link className="text-link" href={handoff.next.href}>
            Continue Strategy review
          </Link>
        </div>
      )}
      {(logoStatus === "needs_review" || logoStatus === "recheck") && (
        <div className="project-read-notice" role="status">
          {logoStatus === "needs_review"
            ? "Logo needs review. Earlier work is kept."
            : "Check Logo against the current project version. Earlier work is kept."}{" "}
          <Link className="text-link" href={`/brands/account/${projectId}/logo`}>
            Review Logo
          </Link>
        </div>
      )}
    </>
  );
  return (
    <ProjectProgressContext.Provider value={progress}>
      <ConversationStepContext.Provider value={setConversation}>
        <LogoEvidenceContext.Provider value={reportLogo}>
          <WorkspaceNoticeContext.Provider value={{ notices, host: setNoticesHosted }}>
            <section className={`project-workspace project-stage-${stage}`}>
              {/* Inside the side-chat Workspace the notices sit at the top of the work area instead. */}
              {!noticesHosted && notices}
              <div className="project-workspace-content">
                <ProjectPageErrorContext.Provider value={setPageError}>{children}</ProjectPageErrorContext.Provider>
              </div>
            </section>
          </WorkspaceNoticeContext.Provider>
        </LogoEvidenceContext.Provider>
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
          <Icon name={open ? "chevron-up" : "chevron-down"} size="sm" />
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
