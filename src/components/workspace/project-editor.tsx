"use client";
import { ContextDetails } from "@/components/ui/context-details";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Fragment,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  useTransition,
  useMemo,
  useCallback,
  useSyncExternalStore,
} from "react";
import type { ContextSnapshot, ProjectScope } from "@/domain/projects";
import type { NamingSource } from "@/domain/naming";
import { getNamingReadiness } from "@/domain/project-naming";
import { initialConversation, type ConversationWidget } from "@/domain/conversation";
import { EmbelMark, Icon } from "@/components/ui/icon";
import { UnsavedProjectRecovery } from "./unsaved-project-recovery";
import { useAccountStrategyStart } from "./account-strategy-start";
import {
  readReceipt,
  rememberReceipt,
  StartReceiptRecoveryError,
  withProjectStartLock,
} from "./account-project-start-recovery";
import { finishLocalDraftRecovery } from "./save-local-draft-to-account";
import { projectStartDraft, projectStartHref, prepareProjectStart } from "./project-start-draft";
import { useAccountSession } from "./account-session";
import {
  beforePromptSignInEvent,
  clearPromptRecovery,
  readPromptRecoveryState,
  rememberPromptForSignIn,
} from "./prompt-recovery";
import { createAccountLifecycleClient } from "./account-lifecycle-client";
import { HomeInputControls } from "@/features/home-inputs/home-input-controls";
import { createOnDeviceVoiceAdapter } from "@/features/home-inputs/on-device-voice-adapter";
import { unavailableHomeVoiceAdapter, type OnDeviceSpeechEnvironment } from "@/features/home-inputs/voice-contract";
import { saveAttachedHomeDraft } from "@/features/home-inputs/home-input-session";
import type { AttachmentPolicy } from "@/domain/attachments";
import { NameOrigin } from "./name-origin";
import { CompetitorReview } from "./competitor-review";
import { PersonalityReview, PositioningReview } from "./strategy-review";
import { ConversationComposer } from "./conversation-composer";
import { OpeningGuidedConversation } from "./guided-thinking";
import { AudienceConversationWidget, WidgetSummary, widgetLabels } from "./conversation-widgets";
import {
  competitorReviewKey,
  conversationContextKey,
  conversationPromptPatch,
  conversationWidgetPatch,
  draftContext,
  draftConversation,
  isAudienceReviewComplete,
  isCompetitorReviewComplete,
  isPersonalityReviewComplete,
  isPositioningReviewComplete,
  personalityReviewKey,
  positioningReviewKey,
} from "./project-draft-adapter";
import {
  briefExamples,
  createLocalDraft,
  draftTitle,
  getLocalDraft,
  updateLocalDraft,
  useLocalDrafts,
  type LocalDraft,
} from "./local-drafts";
import "@/styles/conversation.css";

const homeExamples = [
  {
    title: "A neighborhood coffee shop",
    description:
      "A neighborhood coffee shop serving carefully sourced coffee and simple seasonal food. A welcoming everyday place for people who live and work nearby.",
  },
  {
    title: "A skincare studio",
    description:
      "An independent skincare studio offering thoughtful personal treatments and a small range of gentle products. The brand should feel calm, knowledgeable, and approachable.",
  },
  {
    title: "An independent magazine",
    description:
      "An independent magazine about the people shaping everyday culture, with original photography and long-form stories. It should feel curious, thoughtful, and distinctive.",
  },
];

export function NewProjectForm({ exampleId, home = false }: { exampleId?: string; home?: boolean }) {
  const { session, isCurrent, expire, homeInputSession, drafts: accountDrafts } = useAccountSession();
  const account = session.status === "ready" ? session : null;
  const example = briefExamples.find((item) => item.id === exampleId);
  // Every project is a complete brand.
  const scope: ProjectScope = "complete_brand";
  const [prompt, setPrompt] = useState<string>(example?.description ?? "");
  const [exampleUsed, setExampleUsed] = useState(Boolean(example));
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [navigating, startNavigation] = useTransition();
  const [opening, setOpening] = useState<{ fence: string; href: string } | null>(null);
  const [textDraftId, setTextDraftId] = useState<string | null>(null);
  const [resumedPrompt, setResumedPrompt] = useState(false);
  const [recoveryLoaded, setRecoveryLoaded] = useState(false);
  const [recoveryLocked, setRecoveryLocked] = useState(false);
  const [promptOwner, setPromptOwner] = useState<string | null>(null);
  const textDraft = useRef<string | null>(null);
  const pendingAccountDraft = useRef<LocalDraft | null>(null);
  const recoveryChecked = useRef(false);
  const submittingRef = useRef(false),
    attachedRequest = useRef<AbortController | null>(null);
  const { loaded, drafts } = useLocalDrafts();
  useEffect(() => {
    if (!loaded || session.status === "checking" || recoveryChecked.current) return;
    recoveryChecked.current = true;
    const recovery = readPromptRecoveryState(account?.userId);
    setRecoveryLoaded(true);
    if (!recovery || exampleId) return;
    const retained = recovery.draft;
    textDraft.current = retained.id;
    if (!getLocalDraft(retained.id)) pendingAccountDraft.current = retained;
    // Restore the browser draft after hydration, without touching owner-bound file or request state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTextDraftId(retained.id);
    setRecoveryLocked(recovery.locked);
    setPromptOwner(retained.ownerId ?? null);
    setPrompt(retained.description);
    setExampleUsed(retained.example);
    setResumedPrompt(true);
  }, [loaded, exampleId, account?.userId, session.status]);
  function readTextDraft(id: string) {
    return getLocalDraft(id) ?? (pendingAccountDraft.current?.id === id ? pendingAccountDraft.current : null);
  }
  function keepTextDraft(locked = false) {
    const previous = textDraft.current ? readTextDraft(textDraft.current) : null;
    if (textDraft.current && !previous)
      throw new Error("The original browser draft is unavailable. Check your saved brands before trying again.");
    if (previous) {
      if (previous.ownerId && previous.ownerId !== account?.userId)
        throw new Error("Verify the account that owns this prompt before continuing.");
      if (!locked) {
        const patch = {
          scope,
          description: prompt.trim(),
          example: exampleUsed,
          conversation:
            previous.description === prompt.trim() && previous.conversation
              ? previous.conversation
              : initialConversation(prompt.trim(), previous.createdAt),
          ...(account ? { ownerId: account.userId } : {}),
        };
        if (getLocalDraft(previous.id)) updateLocalDraft(previous.id, patch);
        else {
          pendingAccountDraft.current = { ...previous, ...patch };
          rememberPromptForSignIn(previous.id, false, pendingAccountDraft.current);
        }
      }
      if (account) setPromptOwner(account.userId);
      return previous.id;
    }
    if (account && !homeInputSession.get(account)?.files.length) {
      const draft = projectStartDraft({
        scope,
        description: prompt.trim(),
        example: exampleUsed,
        ownerId: account.userId,
      });
      pendingAccountDraft.current = draft;
      textDraft.current = draft.id;
      setTextDraftId(draft.id);
      setPromptOwner(account.userId);
      rememberPromptForSignIn(draft.id, locked, draft);
      return draft.id;
    }
    const id = createLocalDraft({
      title: "",
      scope,
      description: prompt.trim(),
      suppliedName: "",
      namingNotes: "",
      identityNotes: "",
      example: exampleUsed,
      ...(account ? { ownerId: account.userId } : {}),
    });
    if (id) {
      textDraft.current = id;
      setTextDraftId(id);
      setPromptOwner(account?.userId ?? null);
    }
    return id;
  }
  function beforeSignIn(locked: boolean): boolean {
    if (!loaded || !recoveryLoaded) return false;
    if (!prompt.trim()) return true;
    if (promptOwner && promptOwner !== account?.userId) return true;
    try {
      const id = keepTextDraft(locked);
      if (id) {
        rememberPromptForSignIn(id, locked, pendingAccountDraft.current ?? undefined);
        return true;
      }
      setError(
        "This device has 50 unsaved projects. Copy this prompt before signing in, then recover an unsaved project from Projects to make room.",
      );
    } catch {
      setError("Your prompt could not be kept. Copy it before leaving to sign in.");
    }
    return false;
  }
  const strategy = useAccountStrategyStart({
    beforeSignIn,
    recoveryDraftId: textDraftId,
    recoveryLocked,
    guided: true,
  });
  const preserveBeforeHeaderSignIn = useEffectEvent((event: Event) => {
    if (strategy.checkingRecovery || !beforeSignIn(strategy.locked)) event.preventDefault();
  });
  useEffect(() => {
    const preserve = (event: Event) => preserveBeforeHeaderSignIn(event);
    window.addEventListener(beforePromptSignInEvent, preserve);
    return () => window.removeEventListener(beforePromptSignInEvent, preserve);
  }, []);
  const client = useMemo(
    () => (account ? createAccountLifecycleClient(account, isCurrent, expire) : null),
    [account, isCurrent, expire],
  );
  const sessionFence = `${account?.userId ?? "unverified"}:${session.generation}`;
  const voice = useMemo(
    () =>
      typeof window === "undefined"
        ? unavailableHomeVoiceAdapter
        : createOnDeviceVoiceAdapter(window as unknown as OnDeviceSpeechEnvironment),
    [],
  );
  const readHome = useCallback(() => (account ? homeInputSession.get(account) : null), [account, homeInputSession]);
  const inputIntent = useSyncExternalStore(homeInputSession.subscribe, readHome, () => null);
  const selectingFiles = useSyncExternalStore(homeInputSession.subscribe, homeInputSession.isSelecting, () => false);
  const retainedFiles = useSyncExternalStore(homeInputSession.subscribe, homeInputSession.hasUnsaved, () => false);
  const [capability, setCapability] = useState<{
    fence: string;
    policy: AttachmentPolicy | null;
    reason: string | null;
  } | null>(null);
  const router = useRouter();
  useEffect(() => {
    const controller = new AbortController();
    if (client && account)
      void client
        .getHomeAttachmentCapability(controller.signal)
        .then((result) => {
          if (result && !controller.signal.aborted && isCurrent(account))
            setCapability({ fence: sessionFence, policy: result.policy, reason: result.reason });
        })
        .catch(() => {
          if (!controller.signal.aborted && isCurrent(account))
            setCapability({
              fence: sessionFence,
              policy: null,
              reason: "Verified file storage is unavailable. Your typed prompt stays available.",
            });
        });
    return () => {
      controller.abort();
    };
  }, [account, client, isCurrent, sessionFence]);
  useEffect(
    () => () => {
      attachedRequest.current?.abort();
    },
    [sessionFence],
  );
  const currentCapability = capability?.fence === sessionFence ? capability : null;
  const openingHref = opening?.fence === sessionFence ? opening.href : null;
  const hiddenFiles = retainedFiles && !account;
  const hasFiles = !!inputIntent?.files.length;
  const frozenProject = inputIntent?.saveIntent?.project;
  const frozenBrief = !!frozenProject;
  const hiddenPrompt = Boolean(promptOwner && promptOwner !== account?.userId);
  const displayedPrompt = frozenProject?.context.description ?? (hiddenPrompt ? "" : prompt);
  const displayedExample = frozenProject?.context.intake.example ?? (!hiddenPrompt && exampleUsed);
  const frozenInputs =
    !recoveryLoaded ||
    hiddenPrompt ||
    submitting ||
    strategy.pending ||
    strategy.locked ||
    navigating ||
    Boolean(openingHref) ||
    frozenBrief ||
    hiddenFiles;
  const recoveryFull = drafts.filter((draft) => !draft.accountProjectId).length >= 50;
  const textRecoveryBlocked = strategy.recoveryBlocked && !hasFiles && !frozenBrief;
  const disabled =
    !loaded ||
    !recoveryLoaded ||
    textRecoveryBlocked ||
    (!account && !inputIntent?.browserDraftId && !textDraftId && recoveryFull) ||
    submitting ||
    strategy.pending ||
    navigating ||
    Boolean(openingHref) ||
    hiddenFiles ||
    selectingFiles;

  function canEditInputs() {
    if (hiddenPrompt) return false;
    if (!recoveryLoaded || submittingRef.current || strategy.pending || strategy.locked || navigating || openingHref)
      return false;
    if (homeInputSession.hasUnsaved() && (!account || !isCurrent(account))) return false;
    return !account || !homeInputSession.get(account)?.saveIntent;
  }
  function editPrompt(value: string) {
    if (canEditInputs()) {
      setPrompt(value);
      setPromptOwner(account?.userId ?? null);
      setError("");
    }
  }
  function startNewPrompt() {
    // Detach from another account without discarding its private recovery text.
    if (hiddenPrompt && promptOwner && prompt.trim() && !textDraft.current) {
      const kept = createLocalDraft({
        title: "",
        scope,
        description: prompt.trim(),
        suppliedName: "",
        namingNotes: "",
        identityNotes: "",
        example: exampleUsed,
        ownerId: promptOwner,
      });
      if (!kept) {
        setError(
          "The earlier prompt is still retained. Recover an unsaved project to make room before starting another.",
        );
        return;
      }
    }
    clearPromptRecovery(account?.userId);
    strategy.detachPrompt();
    textDraft.current = null;
    pendingAccountDraft.current = null;
    setTextDraftId(null);
    setPrompt("");
    setPromptOwner(null);
    setExampleUsed(false);
    setResumedPrompt(false);
    setRecoveryLocked(false);
    setError("");
  }

  function openSavedProject(href: string) {
    setOpening({ fence: sessionFence, href });
    try {
      startNavigation(() => router.push(href));
    } catch (cause) {
      setOpening(null);
      throw cause;
    }
  }

  async function sendPrompt(mode: "ai" | "draft" = "ai") {
    if (
      !recoveryLoaded ||
      hiddenPrompt ||
      submittingRef.current ||
      navigating ||
      openingHref ||
      strategy.pending ||
      textRecoveryBlocked
    )
      return;
    if (!account || !isCurrent(account)) {
      if (beforeSignIn(strategy.locked)) router.push("/sign-in");
      return;
    }
    if (homeInputSession.isSelecting()) {
      setError("Finish or explicitly cancel the pending file selection before sending.");
      return;
    }
    // A session fence hides the file body, not the fact that an unsaved file intent must be recovered.
    if (homeInputSession.hasUnsaved() && (!account || !isCurrent(account))) {
      setError(
        "Check the same account before sending this attached brief. Its files are retained privately in this tab.",
      );
      return;
    }
    const original = account ? homeInputSession.get(account) : null;
    if (mode === "draft" && (original?.files.length || original?.saveIntent)) {
      setError("Use Save brief with files to keep the attached brief together.");
      return;
    }
    if (!original?.saveIntent && !prompt.trim()) {
      setError("Write a prompt to start the conversation.");
      return;
    }
    if (!original?.saveIntent && prompt.length > 12000) {
      setError("Keep this prompt within 12,000 characters.");
      return;
    }
    submittingRef.current = true;
    setSubmitting(true);
    setError("");
    const controller = new AbortController();
    attachedRequest.current = controller;
    try {
      if (original?.files.length) {
        if (!account || !client || !isCurrent(account)) return;
        let id = original.browserDraftId;
        if (!id) {
          id = keepTextDraft(strategy.locked);
          if (!id) {
            setError(
              "This device has 50 unsaved projects. Recover one from Projects to make room. Your prompt is still here.",
            );
            return;
          }
          if (!homeInputSession.set(account, { ...original, browserDraftId: id })) return;
        }
        const retained = homeInputSession.get(account);
        const created = readTextDraft(id);
        if (!created && !retained?.saveIntent)
          throw new Error(
            "The original recovery copy is unavailable. Your pending files are retained in this tab; no replacement project was created.",
          );
        // An attached save has its own exact request in HomeInputSession. Fence
        // ordinary text recovery before admission so it cannot create a second
        // project while the attachment result is unknown, including after reload.
        await withProjectStartLock(
          account.userId,
          id,
          controller.signal,
          async () => {
            if (controller.signal.aborted || !isCurrent(account)) return;
            const prior = readReceipt(account.userId, id);
            if (prior?.projectId) {
              openSavedProject(projectStartHref(prior.projectId!));
              finishLocalDraftRecovery(id, account.userId, prior.projectId);
              clearPromptRecovery(account.userId);
              return;
            }
            const receipt = await saveAttachedHomeDraft({
              account,
              draft: created ?? null,
              memory: homeInputSession,
              client,
              signal: controller.signal,
              beforeSave: (input) => {
                const existing = readReceipt(account.userId, id);
                if (
                  existing &&
                  (existing.projectId || existing.request || existing.attachedRequestKey !== input.requestKey)
                )
                  throw new StartReceiptRecoveryError(
                    "This project has another save to check. Open Projects before starting an attached save.",
                  );
                rememberReceipt(
                  { ownerId: account.userId, draftId: id, projectId: null, attachedRequestKey: input.requestKey },
                  true,
                );
                try {
                  rememberPromptForSignIn(id, true, created ?? undefined);
                } catch {
                  /* The retained receipt still fences ordinary recovery. */
                }
              },
            });
            if (receipt && !controller.signal.aborted && isCurrent(account)) {
              rememberReceipt({
                ownerId: account.userId,
                draftId: id,
                projectId: receipt.project.id,
                attachedRequestKey: receipt.requestKey,
              });
              const newProject = !prior && !original.saveIntent && !original.receipt;
              openSavedProject(
                prepareProjectStart(receipt.project.id, newProject ? receipt.project : null, account, accountDrafts),
              );
              finishLocalDraftRecovery(id, account.userId, receipt.project.id);
              clearPromptRecovery(account.userId);
            } else if (!controller.signal.aborted && isCurrent(account))
              setError(
                "The attached brief is not confirmed yet. Its original prompt, files and request are retained for checking.",
              );
          },
          true,
        );
        return; // Files never fall through to implicit Strategy processing.
      }
      const id = keepTextDraft(strategy.locked);
      if (!id) {
        setError(
          "This device has 50 unsaved projects. Recover one from Projects to make room. Your prompt is still here.",
        );
        return;
      }
      const created = readTextDraft(id);
      if (!created) throw new Error("Your draft could not be opened. Check your saved brands before trying again.");
      if (mode === "draft") {
        if (await strategy.save(created)) clearPromptRecovery(account.userId);
      } else if (await strategy.start(created)) clearPromptRecovery(account.userId); // Only confirmed navigation retires the recovery identity; uncertain saves remain fenced.
    } catch (cause) {
      if (!controller.signal.aborted)
        setError(
          cause instanceof StartReceiptRecoveryError
            ? cause.message
            : cause instanceof Error
              ? hasFiles
                ? "The attached brief could not be confirmed. Your typed text, confirmed files and original request remain in this tab. Check and retry the same request."
                : cause.message
              : "This prompt could not be kept. Please try again.",
        );
    } finally {
      if (attachedRequest.current === controller) attachedRequest.current = null;
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  if (openingHref || (strategy.starting && !hasFiles)) {
    const opening = (
      <OpeningGuidedConversation
        prompt={displayedPrompt}
        status={openingHref ? "Project saved. Opening your project…" : strategy.startMessage}
        href={openingHref ?? strategy.openingHref}
      />
    );
    return home ? opening : <div className="page home-page">{opening}</div>;
  }

  const intake = (
    <div className="home-intake conversation-intake">
      <div className="home-introduction">
        <h1 className="text-display">Your next brand starts here.</h1>
        <p>Describe the idea. Embel asks a few questions, then builds the name, logo and look with you.</p>
      </div>
      {resumedPrompt && !hiddenPrompt && (
        <div className="prompt-recovery-notice">
          <p role="status">
            {strategy.locked
              ? "Your original prompt is kept. Check its save status below before continuing."
              : "Your prompt is ready to continue."}
          </p>
          <button
            type="button"
            className="text-link"
            disabled={frozenInputs}
            onClick={() => {
              if (!canEditInputs()) return;
              clearPromptRecovery(account?.userId);
              textDraft.current = null;
              pendingAccountDraft.current = null;
              setTextDraftId(null);
              setPrompt("");
              setPromptOwner(null);
              setExampleUsed(false);
              setResumedPrompt(false);
              setError("");
            }}
          >
            Start a new prompt
          </button>
        </div>
      )}
      {hiddenPrompt && (
        <div>
          <p role="status">
            An unsaved prompt belongs to another account session. Sign in to that account to continue it.
          </p>
          <button type="button" className="text-link" onClick={startNewPrompt}>
            Start a new prompt
          </button>
        </div>
      )}
      {hiddenFiles && (
        <p role="status">
          An attached brief is retained in this tab. Verify the same account before sending so its files stay with it.
        </p>
      )}
      {frozenBrief && (
        <p role="status">
          Your prompt and example selection are locked to the original attached brief while its save is confirmed or
          recovered.
        </p>
      )}
      <ConversationComposer
        home
        value={displayedPrompt}
        onChange={editPrompt}
        readOnly={frozenInputs}
        onSend={sendPrompt}
        label="Your prompt"
        placeholder="An idea you can’t stop thinking about…"
        error={error}
        disabled={disabled}
        initial
        sendLabel={
          inputIntent?.receipt
            ? "Open saved brand"
            : frozenBrief
              ? "Check and retry attached brief"
              : hasFiles
                ? "Save brief with files"
                : strategy.recoveryProjectId
                  ? "Open saved account project"
                  : "Send prompt"
        }
        hint={
          displayedExample ? (
            <>
              <span className="example-dot" />
              {frozenBrief ? "Example prompt · saved basis" : "Example prompt · editable"}
            </>
          ) : (
            "An idea, a product, a place. Start in your own words."
          )
        }
        inputControls={
          <HomeInputControls
            compact
            account={account}
            sessionFence={sessionFence}
            memory={homeInputSession}
            value={displayedPrompt}
            onChange={editPrompt}
            language="en-US"
            voiceAdapter={voice}
            policy={currentCapability?.policy ?? null}
            availability={
              currentCapability?.policy
                ? { status: "available" }
                : {
                    status: "unavailable",
                    reason:
                      currentCapability?.reason ??
                      (account ? "Checking verified file storage…" : "Sign in to save verified input files."),
                  }
            }
            disabled={!recoveryLoaded || submitting || navigating || strategy.pending || strategy.locked}
          />
        }
      />
      {(!home || !!displayedPrompt.trim() || strategy.locked || hiddenFiles) && (
        <div className="conversation-start-notice">
          {hasFiles
            ? "Files are saved as input material with your brief. This action does not start AI processing."
            : strategy.notice}
        </div>
      )}
      {account &&
        (!home || !!displayedPrompt.trim() || textDraftId || resumedPrompt || strategy.locked) &&
        !hasFiles &&
        !hiddenFiles &&
        !hiddenPrompt && (
          <div className="account-recovery-actions home-draft-actions">
            <div>
              <button
                type="button"
                className="button secondary"
                disabled={disabled}
                onClick={() => void sendPrompt("draft")}
              >
                {strategy.locked ? "Check and retry save" : "Save project"}
              </button>
              <span className="field-hint">Saves to your account · does not start AI</span>
            </div>
          </div>
        )}
      {!account && recoveryFull && !inputIntent?.browserDraftId && !textDraftId && (
        <p className="form-error" role="alert">
          This device has 50 unsaved projects. <Link href="/brands?recover=1">Recover a project</Link> before starting
          another.
        </p>
      )}
      {
        <div className="home-examples">
          <h2 className="sr-only">Try an idea</h2>
          <div className="home-example-pills">
            {homeExamples.map((item) => (
              <button
                key={item.title}
                type="button"
                className="e-chip"
                disabled={frozenInputs}
                onClick={() => {
                  if (!canEditInputs()) return;
                  setPrompt(item.description);
                  setExampleUsed(true);
                  setError("");
                }}
              >
                {item.title}
              </button>
            ))}
          </div>
        </div>
      }
    </div>
  );
  return home ? intake : <div className="page home-page">{intake}</div>;
}

export type DraftPatch = Partial<Omit<LocalDraft, "id" | "createdAt" | "updatedAt" | "preservedContext">>;
type EditorStorage = {
  kind: "browser" | "account";
  saveLabel: string;
  onUpdate: (patch: DraftPatch) => boolean;
  onDelete?: () => void;
  actions?: React.ReactNode;
  projectLinks?: React.ReactNode;
  namingSource?: NamingSource;
  savedContext?: ContextSnapshot;
  strategy?: React.ReactNode;
  onPromptSubmitted?: (nextDraft: LocalDraft) => Promise<void>;
  promptPending?: boolean;
  promptNotice?: React.ReactNode;
  promptSendLabel?: string;
  promptPlaceholder?: string;
  promptHint?: React.ReactNode;
  resultNavigation?: React.ReactNode;
  projectContext?: React.ReactNode;
  onStrategyApproved?: (draft: LocalDraft) => Promise<boolean>;
};

/** `/brands/<id>`: an unsaved project kept on this device. What is found (nothing, a project already saved, or
 * the project to recover) is the page's one Empty state or picker; "Back to projects" appears once, in it. */
export function ProjectEditor({ projectId }: { projectId: string }) {
  return (
    <div className="e-container e-page e-stack e-stack--xl recover-page">
      <header className="e-page-header">
        <div className="e-stack e-stack--xs">
          <h1 className="text-title-lg">Recover an unsaved project</h1>
          <p className="e-muted">Work kept on this device can be saved to your account.</p>
        </div>
      </header>
      <UnsavedProjectRecovery draftId={projectId} />
    </div>
  );
}

function savedDetails(draft: LocalDraft) {
  const details: [string, string][] = [
    ["Activity", draft.activity],
    ["Offering", draft.offering],
    ["Known audience", draft.knownAudience],
    ["Existing name", draft.suppliedName],
    ["Naming notes", draft.namingNotes],
    ["Identity notes", draft.identityNotes],
  ];
  return details.filter(([, value]) => value.trim());
}

export function ProjectEditorForm({ draft, storage }: { draft: LocalDraft; storage: EditorStorage }) {
  const conversation = draftConversation(draft);
  const lastWidget = [...conversation].reverse().find((event) => event.kind === "widget");
  const lastPrompt = [...conversation].reverse().find((event) => event.kind === "user_message");
  const latestEvent = conversation[conversation.length - 1];
  const reviewed: Record<ConversationWidget, boolean> = {
    competitors: isCompetitorReviewComplete(draft),
    audience: isAudienceReviewComplete(draft),
    personality: isPersonalityReviewComplete(draft),
    positioning: isPositioningReviewComplete(draft),
  };
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const approvingStrategy = useRef(false);
  const [approvalPending, setApprovalPending] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [briefEditing, setBriefEditing] = useState(false);
  const [briefOpen, setBriefOpen] = useState(false);
  const [opened, setOpened] = useState<{ anchor: string | null; widget: ConversationWidget | null }>({
    anchor: lastWidget?.id ?? null,
    widget: latestEvent?.kind === "widget" && !reviewed[latestEvent.widget] ? latestEvent.widget : null,
  });
  const [strategyNotice, setStrategyNotice] = useState({ personality: "", positioning: "" });
  const focusWidget = useRef<ConversationWidget | null>(null);
  const newMessage = useRef<string | null>(null);
  const account = storage.kind === "account";
  const details = savedDetails(draft);
  const activeWidget =
    opened.anchor === (lastWidget?.id ?? null)
      ? opened.widget
      : latestEvent?.kind === "widget" && !reviewed[latestEvent.widget]
        ? latestEvent.widget
        : null;

  function update(patch: DraftPatch, invalidateAudience = false) {
    const nextDraft = { ...draft, ...patch };
    const personalityChanged = personalityReviewKey(draft) !== personalityReviewKey(nextDraft);
    const positioningChanged = positioningReviewKey(draft) !== positioningReviewKey(nextDraft);
    const applied = {
      ...patch,
      ...(invalidateAudience ? { audienceReviewedAt: null, audienceConversationKey: null } : {}),
      ...(personalityChanged ? { personalityReviewKey: null, personalityReviewedAt: null } : {}),
      ...(positioningChanged ? { positioningReviewKey: null, positioningReviewedAt: null } : {}),
    };
    const persisted = storage.onUpdate(applied);
    if ((personalityChanged && reviewed.personality) || (positioningChanged && reviewed.positioning))
      setStrategyNotice((previous) => ({
        personality:
          personalityChanged && reviewed.personality
            ? "The context changed. Your profile is kept for review."
            : previous.personality,
        positioning:
          positioningChanged && reviewed.positioning
            ? "The context changed. Your statement is kept for review."
            : previous.positioning,
      }));
    setError("");
    setMessage("");
    return { persisted, nextDraft: { ...draft, ...applied } };
  }

  function openWidget(widget: ConversationWidget) {
    try {
      const patch = conversationWidgetPatch(draft, widget);
      const events = draftConversation({ ...draft, ...patch });
      focusWidget.current = widget;
      update(patch);
      setOpened({ anchor: [...events].reverse().find((event) => event.kind === "widget")?.id ?? null, widget });
    } catch (error) {
      setError(error instanceof Error ? error.message : "This tool could not be opened.");
    }
  }

  const continueAtHash = useEffectEvent(() => {
    const target = window.location.hash;
    const widget = (["competitors", "audience", "personality", "positioning"] as const).find(
      (value) => target === `#strategy-${value}`,
    );
    if (widget) openWidget(widget);
    else if (target === "#strategy-brief") {
      setBriefOpen(true);
      setBriefEditing(true);
      requestAnimationFrame(() =>
        document.querySelector<HTMLElement>(".project-brief-widget textarea, .project-brief-widget input")?.focus(),
      );
    }
  });
  useEffect(() => {
    const navigate = () => continueAtHash();
    window.addEventListener("hashchange", navigate);
    // An incoming saved continuation URL opens its review, without an AI request.
    const timer = window.setTimeout(navigate, 0);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("hashchange", navigate);
    };
  }, []);

  function completeWidget(widget: ConversationWidget) {
    if (approvingStrategy.current) return;
    const next: Record<ConversationWidget, ConversationWidget | null> = {
      competitors: "audience",
      audience: "personality",
      personality: "positioning",
      positioning: null,
    };
    const now = new Date().toISOString();
    try {
      const completion: DraftPatch =
        widget === "competitors"
          ? { competitorReviewKey: competitorReviewKey(draft) }
          : widget === "audience"
            ? { audienceReviewedAt: now, audienceConversationKey: conversationContextKey(draft) }
            : widget === "personality"
              ? { personalityReviewKey: personalityReviewKey(draft), personalityReviewedAt: now }
              : { positioningReviewKey: positioningReviewKey(draft), positioningReviewedAt: now };
      const nextWidget = next[widget];
      const patch = { ...completion, ...(nextWidget ? conversationWidgetPatch(draft, nextWidget) : {}) };
      if (widget === "positioning") {
        // Approve strategy is a whole-strategy action. Check the same saved
        // input requirements used by Naming before claiming a full approval.
        const missing = getNamingReadiness(draftContext({ ...draft, ...patch }, storage.savedContext), "complete_brand")
          .missing[0];
        if (missing) {
          const review = missing === "description" || missing === "reformulation" ? "brief" : missing;
          if (review === "brief") {
            setBriefEditing(true);
            requestAnimationFrame(() =>
              document
                .querySelector<HTMLElement>(".project-brief-widget textarea, .project-brief-widget input")
                ?.focus(),
            );
          } else openWidget(review);
          setError(`Review your ${review} before approving Strategy. Your current content is kept.`);
          return;
        }
      }
      const result = update(patch);
      const events = draftConversation(result.nextDraft);
      focusWidget.current = nextWidget;
      setOpened({
        anchor: [...events].reverse().find((event) => event.kind === "widget")?.id ?? null,
        widget: nextWidget,
      });
      if (widget === "positioning" && storage.onStrategyApproved) {
        approvingStrategy.current = true;
        setApprovalPending(true);
        setMessage("Saving your Strategy approval…");
        void storage
          .onStrategyApproved(result.nextDraft)
          .then((saved) => {
            if (saved) setMessage("Strategy approved and saved to your account.");
            else {
              setMessage("");
              setError("Strategy approval could not be saved. Your review is kept here. Use Retry save to try again.");
            }
          })
          .catch(() => {
            setMessage("");
            setError("Strategy approval could not be saved. Your review is kept here. Use Retry save to try again.");
          })
          .finally(() => {
            approvingStrategy.current = false;
            setApprovalPending(false);
          });
      } else
        setMessage(
          account
            ? "Selection kept. Saving to your account…"
            : result.persisted
              ? "Selection saved in this browser."
              : "Selection kept in this tab. Browser storage is unavailable.",
        );
    } catch (error) {
      setError(error instanceof Error ? error.message : "Your selection could not be confirmed.");
    }
  }

  function sendPrompt() {
    if (storage.promptPending) return;
    if (!prompt.trim()) {
      setError("Write a message before sending.");
      return;
    }
    try {
      const result = update(conversationPromptPatch(draft, prompt));
      const events = draftConversation(result.nextDraft);
      newMessage.current = [...events].reverse().find((event) => event.kind === "user_message")?.id ?? null;
      setPrompt("");
      setOpened({ anchor: [...events].reverse().find((event) => event.kind === "widget")?.id ?? null, widget: null });
      setMessage(
        account
          ? "Prompt kept in this conversation."
          : result.persisted
            ? "Prompt saved in this browser."
            : "Prompt kept in this tab. Browser storage is unavailable.",
      );
      if (storage.onPromptSubmitted)
        void storage
          .onPromptSubmitted(result.nextDraft)
          .catch(() => setError("Your prompt is kept here. AI processing could not start."));
    } catch (error) {
      setError(error instanceof Error ? error.message : "Your message could not be kept. Please try again.");
    }
  }

  function renderWidget(widget: ConversationWidget) {
    if (widget === "competitors")
      return (
        <CompetitorReview
          draft={draft}
          inline
          savedContext={storage.savedContext ?? draft.preservedContext}
          onChange={(competitors) => update({ competitors, competitorReviewKey: null }, true)}
          onComplete={() => completeWidget("competitors")}
          onBack={() => openWidget("audience")}
        />
      );
    if (widget === "audience")
      return (
        <AudienceConversationWidget
          draft={draft}
          savedContext={storage.savedContext ?? draft.preservedContext}
          onChange={(segments) => update({ segments }, true)}
          onComplete={() => completeWidget("audience")}
          onContinue={() => openWidget("personality")}
        />
      );
    if (widget === "personality")
      return (
        <PersonalityReview
          draft={draft}
          inline
          notice={strategyNotice.personality}
          onChange={(personality) => update({ personality })}
          onComplete={() => completeWidget("personality")}
          onBack={() => openWidget("audience")}
          onSkip={() => openWidget("positioning")}
        />
      );
    return (
      <PositioningReview
        draft={draft}
        inline
        pending={approvalPending}
        notice={strategyNotice.positioning}
        onChange={(positioning) => update({ positioning })}
        onComplete={() => completeWidget("positioning")}
        onBack={() => openWidget("personality")}
      />
    );
  }

  return (
    <div className={`project-strategy-workspace ${briefOpen ? "has-live-brief" : ""}`}>
      <div className="project-strategy-columns">
        <div className="page conversation-page">
          <div
            className="conversation-scroll-area"
            role="region"
            aria-label="Conversation and project details"
            tabIndex={0}
          >
            <div className="project-conversation-marker">
              <span>STRATEGY / {briefEditing ? "BRIEF" : (activeWidget ?? "brief").toUpperCase()}</span>
              <span>
                {briefEditing || !activeWidget
                  ? 1
                  : ["competitors", "audience", "personality", "positioning"].indexOf(activeWidget) + 2}{" "}
                of 5
              </span>
              <button
                type="button"
                className="text-link"
                aria-expanded={briefOpen}
                onClick={() => setBriefOpen((value) => !value)}
              >
                {briefOpen ? "Close live brief" : "Live brief"}
              </button>
            </div>
            {storage.actions &&
              (account ? (
                <div className="conversation-account-actions">{storage.actions}</div>
              ) : (
                <ContextDetails className="conversation-account-disclosure" title={<>Account saving</>}>
                  <div className="conversation-account-actions">{storage.actions}</div>
                </ContextDetails>
              ))}
            {briefEditing && (
              <section className="conversation-widget project-brief-widget" aria-label="Project brief">
                <h2>Your starting point</h2>
                <p>Keep your own description and offering. No AI response is implied.</p>
                <label className="field-label">
                  Description
                  <textarea
                    aria-label="Brief description"
                    value={draft.description}
                    maxLength={12000}
                    onChange={(event) =>
                      update(
                        { description: event.target.value, confirmedBrief: undefined, competitorReviewKey: null },
                        true,
                      )
                    }
                  />
                </label>
                {(
                  [
                    ["activity", "What the business does"],
                    ["offering", "First products / services"],
                    ["knownAudience", "Known audience"],
                  ] as const
                ).map(([field, label]) => (
                  <label className="field-label" key={field}>
                    {label}
                    <input
                      value={draft[field]}
                      maxLength={2000}
                      onChange={(event) =>
                        update(
                          { [field]: event.target.value, confirmedBrief: undefined, competitorReviewKey: null },
                          true,
                        )
                      }
                    />
                  </label>
                ))}
                <button
                  type="button"
                  className="button primary small"
                  disabled={!draft.description.trim() || !draft.activity.trim() || !draft.offering.trim()}
                  onClick={() => {
                    update({
                      confirmedBrief: {
                        description: draft.description,
                        activity: draft.activity,
                        offering: draft.offering,
                        knownAudience: draft.knownAudience,
                        conversationKey: conversationContextKey(draft, storage.savedContext),
                      },
                    });
                    setBriefEditing(false);
                  }}
                >
                  Keep brief
                </button>
              </section>
            )}
            <ol id="strategy-brief" tabIndex={-1} className="conversation-history" aria-label="Project conversation">
              {conversation.map((event) => (
                <Fragment key={event.id}>
                  {event.kind === "user_message" && (
                    <li
                      className="conversation-user-entry"
                      ref={(node) => {
                        if (node && newMessage.current === event.id) {
                          node.scrollIntoView({ block: "nearest" });
                          newMessage.current = null;
                        }
                      }}
                    >
                      <div className="conversation-message-meta sr-only">
                        <span>You</span>
                        <time dateTime={event.createdAt}>
                          {new Date(event.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                        </time>
                      </div>
                      <p>{event.text}</p>
                    </li>
                  )}
                  {event.kind === "saved_context" && (
                    <li className="conversation-saved-entry">
                      <span className="conversation-entry-label">Saved brief</span>
                      <p>{event.text}</p>
                    </li>
                  )}
                  {event.kind === "widget" && (
                    <li className={`conversation-widget-entry ${activeWidget === event.widget ? "is-open" : ""}`}>
                      <section className="conversation-widget" aria-labelledby={`widget-${event.id}`}>
                        <div className="conversation-widget-heading">
                          <span className="conversation-tool-avatar" aria-hidden="true">
                            <EmbelMark />
                          </span>
                          <h2
                            id={`widget-${event.id}`}
                            tabIndex={-1}
                            ref={(node) => {
                              if (node && focusWidget.current === event.widget) {
                                node.focus();
                                focusWidget.current = null;
                              }
                            }}
                          >
                            {widgetLabels[event.widget]}
                          </h2>
                          <span className={`conversation-review-state ${reviewed[event.widget] ? "is-reviewed" : ""}`}>
                            {reviewed[event.widget] ? (
                              <>
                                <Icon name="check" size={12} />
                                Confirmed
                              </>
                            ) : (
                              "Not reviewed"
                            )}
                          </span>
                          {activeWidget === event.widget ? (
                            <button
                              type="button"
                              className="text-link"
                              aria-label={`Collapse ${event.widget}`}
                              onClick={() => setOpened({ anchor: lastWidget?.id ?? null, widget: null })}
                            >
                              Collapse
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="text-link"
                              aria-label={`Edit ${event.widget}`}
                              onClick={() => openWidget(event.widget)}
                            >
                              <Icon name="pencil" size={13} />
                              Edit
                            </button>
                          )}
                        </div>
                        {activeWidget === event.widget ? (
                          <div className="conversation-widget-body">{renderWidget(event.widget)}</div>
                        ) : (
                          <div className="conversation-widget-summary">
                            <WidgetSummary widget={event.widget} draft={draft} reviewed={reviewed[event.widget]} />
                          </div>
                        )}
                      </section>
                    </li>
                  )}
                  {event.id === lastPrompt?.id && (
                    <li className="conversation-service-entry">
                      {storage.strategy ?? (
                        <p className="conversation-service-note">
                          <Icon name="offline" size={15} />
                          {account
                            ? "AI processing is not connected to this conversation yet."
                            : "AI replies are not available in this browser draft."}
                        </p>
                      )}
                    </li>
                  )}
                </Fragment>
              ))}
            </ol>
            {!lastPrompt && storage.strategy && <div className="conversation-service-entry">{storage.strategy}</div>}
            {storage.projectContext && <div className="conversation-context">{storage.projectContext}</div>}
            <ContextDetails className="project-details-disclosure" title={<>Project details and saving</>}>
              <header className="conversation-project-header">
                <div className="conversation-project-title">
                  <Link href="/brands" className="text-link">
                    Projects
                  </Link>
                  <Icon name="chevron" size={13} />
                  {renaming ? (
                    <input
                      className="conversation-title-input"
                      aria-label="Project label"
                      autoFocus
                      value={draft.title}
                      maxLength={160}
                      placeholder="Untitled brand"
                      onChange={(event) => update({ title: event.target.value })}
                      onBlur={() => setRenaming(false)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === "Escape") {
                          event.preventDefault();
                          setRenaming(false);
                        }
                      }}
                    />
                  ) : (
                    <>
                      <h1>{draftTitle(draft)}</h1>
                      <button
                        className="icon-button subtle"
                        aria-label="Rename project"
                        type="button"
                        onClick={() => setRenaming(true)}
                      >
                        <Icon name="pencil" size={14} />
                      </button>
                    </>
                  )}
                </div>
                <span className="save-label">
                  <Icon name={account ? "brands" : "device"} size={13} />
                  {storage.saveLabel}
                </span>
              </header>
              <div className="conversation-project-meta">
                {draft.example && <span className="small-badge">Example prompt</span>}
                {account ? storage.projectLinks : null}
              </div>
              {storage.namingSource && <NameOrigin source={storage.namingSource} />}
              {details.length > 0 && (
                <ContextDetails className="conversation-saved-details" title={<>Saved project details</>}>
                  <dl>
                    {details.map(([label, value]) => (
                      <div key={label}>
                        <dt>{label}</dt>
                        <dd>{value}</dd>
                      </div>
                    ))}
                  </dl>
                </ContextDetails>
              )}
            </ContextDetails>
            <footer className="conversation-footer">
              <Link href="/brands" className="text-link">
                Back to all projects
              </Link>
              {storage.onDelete &&
                (!confirmDelete ? (
                  <button className="text-link danger-text" type="button" onClick={() => setConfirmDelete(true)}>
                    Delete this draft
                  </button>
                ) : (
                  <div className="inline-confirm">
                    <span>Delete this browser draft?</span>
                    <button className="button secondary small" type="button" onClick={() => setConfirmDelete(false)}>
                      Keep draft
                    </button>
                    <button className="button danger small" type="button" onClick={storage.onDelete}>
                      Delete draft
                    </button>
                  </div>
                ))}
            </footer>
          </div>
          <div className="conversation-compose-area">
            <div className="conversation-compose-notices" role="region" aria-label="Conversation notices" tabIndex={0}>
              {storage.resultNavigation}
              {error && (
                <p className="form-error" role="alert">
                  {error}
                </p>
              )}
              {message && (
                <p className="conversation-feedback" role="status">
                  {message}
                </p>
              )}
              {storage.promptNotice}
            </div>
            <ConversationComposer
              project
              value={prompt}
              onChange={(value) => {
                setPrompt(value);
                setError("");
              }}
              onSend={sendPrompt}
              label="Message Embel"
              placeholder={storage.promptPlaceholder ?? "Reply or ask a question…"}
              sendLabel={storage.promptSendLabel ?? (account ? "Send prompt" : "Save message")}
              disabled={storage.promptPending}
              hint={
                storage.promptHint ??
                (account
                  ? "Project context"
                  : storage.saveLabel === "This tab only"
                    ? "This tab only · browser storage unavailable"
                    : "Saved in this browser · Shift + Enter for a new line")
              }
            />
          </div>
        </div>
        <aside className="project-live-brief" hidden={!briefOpen} aria-label="Live brief">
          <div>
            <h2>Live brief</h2>
            <button
              type="button"
              className="icon-button"
              aria-label="Close live brief"
              onClick={() => {
                setBriefOpen(false);
                requestAnimationFrame(() =>
                  document.querySelector<HTMLButtonElement>(".project-conversation-marker button")?.focus(),
                );
              }}
            >
              ×
            </button>
          </div>
          <span className="small-badge">{account ? "Account project" : "Browser draft"}</span>
          <dl>
            {[
              ["Business", draft.activity || draft.description],
              [
                "Audience",
                draft.segments
                  .filter((segment) => segment.selected)
                  .map((segment) => segment.name)
                  .join(", ") || draft.knownAudience,
              ],
              [
                "Competitors",
                draft.competitors
                  ?.filter((row) => row.selected)
                  .map((row) => row.name)
                  .join(", "),
              ],
              [
                "Personality",
                draft.personality
                  ? Object.entries(draft.personality)
                      .map(([key, value]) => `${key}: ${value}`)
                      .join(" · ")
                  : "",
              ],
              ["Difference", draft.positioning],
            ].map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value || "Not specified"}</dd>
              </div>
            ))}
          </dl>
          <button
            type="button"
            className="button secondary small"
            onClick={() => {
              setBriefEditing(true);
              setBriefOpen(false);
              requestAnimationFrame(() =>
                document
                  .querySelector<HTMLElement>(".project-brief-widget textarea, .project-brief-widget input")
                  ?.focus(),
              );
            }}
          >
            Edit brief
          </button>
        </aside>
      </div>
    </div>
  );
}
