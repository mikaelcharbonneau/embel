"use client";

import {
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentProps,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import { AccountBriefEditor } from "./account-brief-editor";
import { ProjectNamingWorkspace } from "@/components/naming/project-naming-workspace";
import { InspirationWorkspace } from "@/components/inspiration/inspiration-workspace";
import { InspirationLikeCount } from "@/components/inspiration/inspiration-like-count";
import { LogoCreationWorkspace } from "@/components/logo-creation/logo-creation-workspace";
import { VisualDirectionsPage } from "@/components/visual-directions/visual-directions-page";
import { Button, Spinner } from "@/components/ui/button";
import { InlineMessage } from "@/components/ui/message";
import { useProjectProgress } from "./project-progress";
import { getNamingReadiness } from "@/domain/project-naming";
import {
  appendGuidedTurn,
  confirmGuidedSelection,
  guidedTurnOperation,
  revisitGuidedStage,
  skipGuidedSlogan,
  type GuidedReply,
  type GuidedStage,
} from "@/domain/guided-interview";
import { competitorSchema, contextSnapshotSchema, type ContextSnapshot } from "@/domain/projects";
import { CompetitorWidgetControls } from "./competitor-widget-controls";
import { guidedStageLabel } from "./embel-identity";
import {
  JOURNEY_SECTION_EVENT,
  journeySectionId,
  journeySectionOfHash,
  useConversationSteps,
} from "@/components/journey/project-header";
import { journeyPartLabel, type JourneyStepId } from "@/domain/journey";
import { accountDraftChanged, type AccountWorkspace, type GuidedInterviewInput } from "./account-draft-memory";
import { strategyAvailabilityMessage, strategyJobActive } from "./account-strategy-client";
import type { VerifiedAccount } from "./account-session";
import {
  FoldedAnswer,
  FoldedPart,
  GuidedChoices,
  GuidedChoicesEmpty,
  GuidedChoicesLoading,
  selectedOptions,
  stageQuestions,
} from "./guided-interview-widgets";
import {
  GuidedSlogan,
  sloganDecision,
  sloganText,
  type SloganChoice,
  type SloganDecision,
} from "./guided-slogan-widget";
import {
  guidedAllowance,
  guidedMessageContext,
  guidedTimeline,
  guidedTurnResult,
  initialGuidedContext,
  nextGuidedProposal,
  recordGuidedChoice,
  retainedAnswerNames,
  withoutScoreScaleNote,
} from "./guided-interview-client";
import type { ProjectEditorForm } from "./project-editor";
import { useStrategyJobs } from "./use-strategy-jobs";
import { Workspace } from "./workspace-layout";
import {
  useReplyRegistry,
  useWorkspaceReply,
  WorkspaceReplyBox,
  WorkspaceReplyRegistry,
  stepReplyAction,
  type WorkspaceReplyAction,
} from "./workspace-reply";
import { WorkspaceSlotContext, type WorkspaceStepSummary, type WorkspaceSummaryStep } from "./workspace-slots";
import type { StepReply } from "@/features/logo-creation/model/step-reply";
import "@/styles/conversation.css";

function subscribeToHash(onChange: () => void) {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}
const readHash = () => window.location.hash;
const noHash = () => "";

/**
 * The project conversation. At 1024 px and up it is the Workspace (decision 1): Embel's messages, the folded
 * finished steps and the reply box in the side chat, the step's work on the right. Send in the reply box is the one
 * way forward (decision 2): it confirms the chosen options, starts research or moves to the next step, with exactly
 * the same saved changes and requests the step's own button used to make.
 */
export function AccountGuidedInterview({
  account,
  workspace,
  navigation,
  busy,
  saveContext,
  onInputChange,
  storage,
}: {
  account: VerifiedAccount;
  workspace: AccountWorkspace;
  navigation?: ReactNode;
  busy: boolean;
  saveContext: (
    context: ContextSnapshot,
    submittedInput?: Partial<GuidedInterviewInput>,
  ) => Promise<AccountWorkspace | null>;
  onInputChange?: (update: (input: GuidedInterviewInput) => GuidedInterviewInput) => void;
  storage: ComponentProps<typeof ProjectEditorForm>["storage"];
}) {
  const strategy = useStrategyJobs({ account, workspace, blocked: busy, guided: true });
  const [localInput, setLocalInput] = useState<GuidedInterviewInput>(
    () => workspace.guidedInput ?? { prompt: "", selection: null },
  );
  const {
    prompt,
    selection,
    competitorDraft = { name: "", website: "" },
  } = onInputChange ? (workspace.guidedInput ?? { prompt: "", selection: null }) : localInput;
  const changeInput = onInputChange ?? setLocalInput;
  const setPrompt = (update: string | ((previous: string) => string)) =>
    changeInput((previous) => ({
      ...previous,
      prompt: typeof update === "function" ? update(previous.prompt) : update,
    }));
  const setSelection = (selection: GuidedInterviewInput["selection"]) =>
    changeInput((previous) => ({ ...previous, selection }));
  const [error, setError] = useState<string | null>(null);
  const [namingReopened, setNamingReopened] = useState(false);
  const [working, setWorking] = useState(false);
  const [briefOpen, setBriefOpen] = useState(false);
  const [briefFromNaming, setBriefFromNaming] = useState(false);
  const [namingMessages, setNamingMessages] = useState<HTMLDivElement | null>(null);
  const [namingResults, setNamingResults] = useState<HTMLDivElement | null>(null);
  const closeNaming = useCallback(() => {
    setNamingReopened(false);
  }, []);
  // Choosing a different name after Change name closes the names again.
  const [reopenedFor, setReopenedFor] = useState<string | null>(null);
  if (namingReopened && reopenedFor !== null && reopenedFor !== (workspace.saved.context.selectedName ?? "")) {
    setNamingReopened(false);
    setReopenedFor(null);
  }
  const lock = useRef(false),
    mounted = useRef(false);
  const attempts = useRef(new Set<string>());
  const saved = workspace.saved;
  const context = workspace.pendingGuidedContext ?? saved.context;
  const state = context.intake.guidedInterview;
  const turn = state?.turns.at(-1);
  const jobs = strategy.overview?.jobs ?? [];
  const availability = strategy.readError ? null : strategy.overview?.availability;
  const requestBlocked =
    availability?.status === "unavailable" &&
    (availability.reason === "request_unresolved" || availability.reason === "request_active");
  const bound = turn ? guidedTurnResult(jobs, turn, account.userId, saved.id) : null;
  const reply = bound?.reply ?? null;
  const active = jobs.some(strategyJobActive);
  const pending = Boolean(busy || working || strategy.pending || active);
  const dirty = accountDraftChanged(workspace);
  const blocked = pending || dirty || workspace.conflict;
  const currentTurn =
    turn && state?.stage === turn.stage && !state.answers.some((answer) => answer.turnId === turn.id) ? turn : null;
  const operation = currentTurn ? guidedTurnOperation(currentTurn) : null;
  const allowance = operation ? guidedAllowance(availability, operation) : null;
  const turnStarting = Boolean(currentTurn && (strategy.pending || busy || working || workspace.pendingGuidedContext));
  const choiceTurn =
    state?.stage !== "complete"
      ? [...(state?.turns ?? [])]
          .reverse()
          .find(
            (item) =>
              item.stage === state?.stage &&
              guidedTurnResult(jobs, item, account.userId, saved.id)?.reply?.kind === "choices",
          )
      : null;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  function persist(next: ContextSnapshot, submittedInput?: Partial<GuidedInterviewInput>) {
    // The parent owns pending saves, conflicts and their acknowledged recovery.
    return saveContext(next, submittedInput);
  }

  // Persisted turns retain their request identity across a lost acknowledgement.
  // An uncertain enqueue retries the exact key; it never creates a replacement job.
  const coordinate = useEffectEvent(async () => {
    // Voice · Slogan opens once a name is chosen. Choosing the name is the
    // deliberate step; the proposal request keeps one identity per revision.
    if (
      mounted.current &&
      !lock.current &&
      !busy &&
      !strategy.pending &&
      !active &&
      !dirty &&
      !workspace.conflict &&
      strategy.overview &&
      !strategy.readError &&
      state?.stage === "slogan" &&
      saved.context.selectedName &&
      !state.turns.some((item) => item.stage === "slogan") &&
      guidedAllowance(availability, "strategy.slogan")
    ) {
      const key = `slogan-start:${saved.current_revision}`;
      if (attempts.current.has(key)) return;
      attempts.current.add(key);
      lock.current = true;
      setWorking(true);
      try {
        const latest = [...(saved.context.intake.conversation ?? [])]
          .reverse()
          .find((event) => event.kind === "user_message");
        await persist(
          appendGuidedTurn(saved.context, {
            id: crypto.randomUUID(),
            userMessageId: latest?.id ?? null,
            stage: "slogan",
            purpose: "propose",
            inputRevision: saved.current_revision + 1,
          }),
        );
      } catch {
        if (mounted.current) setError("Slogan suggestions could not be started. Your name is saved.");
      } finally {
        lock.current = false;
        if (mounted.current) setWorking(false);
      }
      return;
    }
    if (
      !mounted.current ||
      lock.current ||
      busy ||
      strategy.pending ||
      active ||
      dirty ||
      workspace.conflict ||
      !currentTurn ||
      !strategy.overview ||
      strategy.readError
    )
      return;
    if (currentTurn.inputRevision !== saved.current_revision) return;
    if (reply?.kind === "redirect") {
      const key = `redirect:${bound!.job.id}`;
      if (attempts.current.has(key)) return;
      attempts.current.add(key);
      lock.current = true;
      setWorking(true);
      try {
        const next = revisitGuidedStage(saved.context, reply.targetStage);
        await persist(
          appendGuidedTurn(next, {
            id: crypto.randomUUID(),
            userMessageId: currentTurn.userMessageId,
            stage: reply.targetStage,
            purpose: reply.targetStage === "competitors" ? "research" : "propose",
            inputRevision: saved.current_revision + 1,
          }),
        );
      } catch {
        if (mounted.current) setError("Your change of direction could not be saved. Your message is kept.");
      } finally {
        lock.current = false;
        if (mounted.current) setWorking(false);
      }
      return;
    }
    if (
      reply?.kind === "answer" &&
      ["competitors", "audience", "positioning", "personality"].every((stage) =>
        state?.answers.some((answer) => answer.stage === stage),
      )
    ) {
      const key = `clarification:${bound!.job.id}`;
      if (attempts.current.has(key)) return;
      attempts.current.add(key);
      lock.current = true;
      setWorking(true);
      try {
        await persist({
          ...saved.context,
          intake: {
            ...saved.context.intake,
            guidedInterview: { ...saved.context.intake.guidedInterview!, stage: "complete" },
          },
        });
      } finally {
        lock.current = false;
        if (mounted.current) setWorking(false);
      }
      return;
    }
    if (reply?.kind === "accepted") {
      const key = `accept:${bound!.job.id}`;
      if (attempts.current.has(key)) return;
      attempts.current.add(key);
      lock.current = true;
      setWorking(true);
      try {
        let next = confirmGuidedSelection(saved.context, {
          turnId: currentTurn.id,
          reply,
          now: new Date().toISOString(),
        });
        next = nextGuidedProposal(next, saved.current_revision + 1, currentTurn.userMessageId);
        await persist(next);
      } catch (cause) {
        if (mounted.current) setError(cause instanceof Error ? cause.message : "Your answer could not be saved.");
      } finally {
        lock.current = false;
        if (mounted.current) setWorking(false);
      }
      return;
    }
    if (bound || !allowance || currentTurn.inputRevision !== saved.current_revision) return;
    const key = `request:${currentTurn.id}`;
    if (attempts.current.has(key)) return;
    // The request identity is derived from the project, revision and operation,
    // so a remount or reload resends the same request rather than a new one.
    attempts.current.add(key);
    await strategy.enqueue(guidedTurnOperation(currentTurn), saved.current_revision, allowance);
  });
  useEffect(() => {
    void coordinate();
  }, [
    saved.current_revision,
    state,
    bound,
    reply,
    busy,
    strategy.pending,
    strategy.overview,
    strategy.readError,
    active,
    dirty,
    allowance,
    currentTurn,
  ]);

  async function send() {
    if (lock.current || blocked || !prompt.trim()) return;
    const intendedOperation = state?.turns.length ? "strategy.reformulate" : "strategy.competitors";
    if (!guidedAllowance(availability, intendedOperation)) {
      setError(strategyAvailabilityMessage(availability ?? null));
      return;
    }
    lock.current = true;
    setWorking(true);
    setError(null);
    const text = prompt;
    try {
      const result = await persist(guidedMessageContext(saved.context, text, saved.current_revision + 1), {
        prompt: text,
      });
      if (result && mounted.current) setPrompt((current) => (current === text ? "" : current));
    } catch (cause) {
      if (mounted.current)
        setError(cause instanceof Error ? cause.message : "Your message could not be saved. Your prompt is kept.");
    } finally {
      lock.current = false;
      if (mounted.current) setWorking(false);
    }
  }

  // A brief saved before research could start: one deliberate click submits it,
  // exactly as Home would have. The saved turn keeps the request identity.
  async function startResearch() {
    if (lock.current || blocked || state || saved.scope !== "complete_brand") return;
    if (!guidedAllowance(availability, "strategy.competitors")) {
      setError(strategyAvailabilityMessage(availability ?? null));
      return;
    }
    lock.current = true;
    setWorking(true);
    setError(null);
    try {
      await persist(initialGuidedContext(saved.context, saved.current_revision + 1));
    } catch (cause) {
      if (mounted.current)
        setError(cause instanceof Error ? cause.message : "Research could not be started. Your brief is saved.");
    } finally {
      lock.current = false;
      if (mounted.current) setWorking(false);
    }
  }

  async function confirm(answer: Extract<GuidedReply, { kind: "choices" }>) {
    if (lock.current || blocked || choiceTurn?.id !== answer.turnId || state?.stage !== answer.stage) return;
    const ids = selectedCompetitors(answer);
    if (answer.stage === "competitors" && ids.length > 20) {
      setError("Choose up to 20 competitors before continuing.");
      return;
    }
    const optionIds = ids.filter((id) => answer.options.some((option) => option.id === id));
    const retainedCompetitorIds = answer.stage === "competitors" ? ids.filter((id) => !optionIds.includes(id)) : [];
    lock.current = true;
    setWorking(true);
    setError(null);
    try {
      const now = new Date().toISOString();
      let next = confirmGuidedSelection(saved.context, {
        turnId: answer.turnId,
        reply: answer,
        optionIds,
        retainedCompetitorIds,
        now,
      });
      const chosen = recordGuidedChoice(next, answer, optionIds, now, retainedCompetitorIds);
      next = nextGuidedProposal(chosen.context, saved.current_revision + 1, chosen.messageId);
      const result = await persist(next, { selection: { turnId: answer.turnId, ids } });
      if (result && mounted.current) setSelection(null);
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : "Your selection could not be saved.");
    } finally {
      lock.current = false;
      if (mounted.current) setWorking(false);
    }
  }

  async function confirmSlogan(answer: Extract<GuidedReply, { kind: "choices" }>, decision: SloganDecision) {
    if (lock.current || blocked || choiceTurn?.id !== answer.turnId || state?.stage !== "slogan") return;
    lock.current = true;
    setWorking(true);
    setError(null);
    try {
      const now = new Date().toISOString();
      const next = confirmGuidedSelection(saved.context, {
        turnId: answer.turnId,
        reply: answer,
        optionIds: "optionId" in decision ? [decision.optionId] : [],
        ownSlogan: "own" in decision ? decision.own : undefined,
        now,
      });
      await persist(next);
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : "Your slogan could not be saved.");
    } finally {
      lock.current = false;
      if (mounted.current) setWorking(false);
    }
  }
  async function skipSlogan(turnId: string) {
    if (lock.current || blocked || state?.stage !== "slogan") return;
    lock.current = true;
    setWorking(true);
    setError(null);
    try {
      await persist(skipGuidedSlogan(saved.context, { turnId, now: new Date().toISOString() }));
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : "Your choice could not be saved.");
    } finally {
      lock.current = false;
      if (mounted.current) setWorking(false);
    }
  }
  async function moreSlogans() {
    if (
      lock.current ||
      blocked ||
      requestBlocked ||
      state?.stage !== "slogan" ||
      !guidedAllowance(availability, "strategy.reformulate")
    )
      return;
    lock.current = true;
    setWorking(true);
    setError(null);
    try {
      await persist(
        guidedMessageContext(
          saved.context,
          "Suggest a few more slogans, different from these.",
          saved.current_revision + 1,
        ),
      );
    } catch {
      if (mounted.current) setError("More slogans could not be requested. The current ones are kept.");
    } finally {
      lock.current = false;
      if (mounted.current) setWorking(false);
    }
  }

  function selectedCompetitors(answer: Extract<GuidedReply, { kind: "choices" }>) {
    if (selection?.turnId === answer.turnId) return selection.ids;
    if (answer.stage !== "competitors") return [];
    return context.competitors
      .filter((item) => item.selected)
      .map(
        (item) =>
          answer.options.find(
            (option) =>
              option.stage === "competitors" &&
              option.payload.name.trim().toLowerCase() === item.name.trim().toLowerCase(),
          )?.id ?? item.id,
      );
  }
  function retainedOptions(answer: Extract<GuidedReply, { kind: "choices" }>) {
    const names = new Set(
      answer.options
        .flatMap((option) => (option.stage === "competitors" ? [option.label, option.payload.name] : [option.label]))
        .map((name) => name.trim().toLowerCase()),
    );
    const previous = (state?.turns ?? [])
      .filter((turn) => turn.stage === "competitors" && turn.id !== answer.turnId)
      .flatMap((turn) => {
        const prior = guidedTurnResult(jobs, turn, account.userId, saved.id)?.reply;
        return prior?.kind === "choices" ? prior.options.filter((option) => option.stage === "competitors") : [];
      })
      .reverse();
    return context.competitors
      .filter(
        (item) => !names.has(item.name.trim().toLowerCase()) && !answer.options.some((option) => option.id === item.id),
      )
      .map((item) => {
        const original =
          item.origin === "research"
            ? (previous.find((option) => option.id === item.id) ??
              previous.find((option) => option.payload.name.trim().toLowerCase() === item.name.trim().toLowerCase()))
            : undefined;
        return {
          stage: "competitors" as const,
          id: item.id,
          label: item.name,
          payload: item,
          description: original?.description ?? item.relevance,
          recommended: original?.recommended ?? false,
          recommendationReason: original?.recommendationReason ?? null,
        };
      });
  }
  async function addCompetitor(answer: Extract<GuidedReply, { kind: "choices" }>) {
    if (lock.current || blocked || answer.stage !== "competitors") return false;
    const parsed = competitorSchema.safeParse({
      id: crypto.randomUUID(),
      name: competitorDraft.name,
      ...(competitorDraft.website.trim() ? { url: competitorDraft.website.trim() } : {}),
      relevance: "Added by you",
      origin: "user",
      selected: true,
      sources: [],
    });
    if (!parsed.success) {
      setError("Enter a competitor name and, optionally, a complete https:// website without login details.");
      return false;
    }
    const existingNames = [
      ...context.competitors.map((item) => item.name),
      ...answer.options.map((item) => item.label),
    ];
    if (existingNames.some((name) => name.trim().toLowerCase() === parsed.data.name.toLowerCase())) {
      setError("That competitor is already listed. Select the existing entry instead.");
      return false;
    }
    if (context.competitors.length >= 50) {
      setError("This project already has 50 saved competitors. Review the existing list before adding more.");
      return false;
    }
    lock.current = true;
    setWorking(true);
    setError(null);
    const draft = competitorDraft;
    const selected = selectedCompetitors(answer);
    // Research it like the suggested competitors (website, offer, why it competes,
    // sources) in the same save; without research it is saved as entered.
    const research = !requestBlocked && Boolean(guidedAllowance(availability, "strategy.competitors"));
    try {
      const next = research
        ? researchCompetitorsContext(
            answer,
            `Add ${parsed.data.name}${parsed.data.url ? ` (${parsed.data.url})` : ""} to my competitors and research it like the others: its website, what it offers and why it competes with my brand. Keep my existing selections.`,
            parsed.data,
          )
        : contextSnapshotSchema.parse({ ...saved.context, competitors: [...saved.context.competitors, parsed.data] });
      const result = await persist(next, { competitorDraft: draft });
      if (!result || !mounted.current) return false;
      changeInput((previous) => ({
        ...previous,
        competitorDraft:
          JSON.stringify(previous.competitorDraft) === JSON.stringify(draft) ? undefined : previous.competitorDraft,
        selection: research ? null : { turnId: answer.turnId, ids: [...selected, parsed.data.id] },
      }));
      return true;
    } catch {
      if (mounted.current)
        setError(
          "The competitor could not be confirmed as saved. Your entry is kept; check the saved project before retrying.",
        );
      return false;
    } finally {
      lock.current = false;
      if (mounted.current) setWorking(false);
    }
  }
  /** A competitor research turn on top of this widget's competitors and current
   * selections (plus one just added, selected), as one saved project change. */
  function researchCompetitorsContext(
    answer: Extract<GuidedReply, { kind: "choices" }>,
    request: string,
    added?: ContextSnapshot["competitors"][number],
  ) {
    const ids = selectedCompetitors(answer),
      rows = new Map(
        saved.context.competitors.map((item) => [
          item.name.trim().toLowerCase(),
          { ...item, selected: ids.includes(item.id) },
        ]),
      );
    for (const option of answer.options)
      if (option.stage === "competitors") {
        const key = option.payload.name.trim().toLowerCase();
        if (!rows.has(key)) rows.set(key, { ...option.payload, selected: ids.includes(option.id) });
        else if (ids.includes(option.id)) rows.set(key, { ...rows.get(key)!, selected: true });
      }
    if (added) rows.set(added.name.trim().toLowerCase(), added);
    const retained = contextSnapshotSchema.parse({ ...saved.context, competitors: [...rows.values()] });
    const next = guidedMessageContext(retained, request, saved.current_revision + 1);
    next.intake.guidedInterview!.turns.at(-1)!.purpose = "research";
    return next;
  }
  async function moreCompetitors(answer: Extract<GuidedReply, { kind: "choices" }>) {
    if (
      lock.current ||
      blocked ||
      requestBlocked ||
      answer.stage !== "competitors" ||
      !guidedAllowance(availability, "strategy.competitors")
    )
      return;
    lock.current = true;
    setWorking(true);
    setError(null);
    try {
      const result = await persist(
        researchCompetitorsContext(
          answer,
          "Suggest more relevant competitors, different from the competitors already saved in this project. Keep my existing selections.",
        ),
      );
      if (result && mounted.current) setSelection(null);
    } catch {
      if (mounted.current)
        setError("Additional suggestions could not be requested. Your current competitors and selections are kept.");
    } finally {
      lock.current = false;
      if (mounted.current) setWorking(false);
    }
  }

  async function revisit(stage: GuidedStage, anchor: string | null) {
    if (lock.current || blocked) return;
    lock.current = true;
    setWorking(true);
    setError(null);
    try {
      const next = revisitGuidedStage(saved.context, stage);
      const latestMessage = [...(next.intake.conversation ?? [])]
        .reverse()
        .find((event) => event.kind === "user_message");
      await persist(
        appendGuidedTurn(next, {
          id: crypto.randomUUID(),
          userMessageId: latestMessage?.id ?? anchor,
          stage,
          purpose: "propose",
          inputRevision: saved.current_revision + 1,
        }),
      );
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : "This answer could not be reopened.");
    } finally {
      lock.current = false;
      if (mounted.current) setWorking(false);
    }
  }

  async function retry() {
    if (lock.current || blocked || requestBlocked || !currentTurn) return;
    setError(null);
    if (!bound) {
      if (allowance && strategy.overview && !strategy.readError) {
        attempts.current.add(`request:${currentTurn.id}`);
        await strategy.enqueue(guidedTurnOperation(currentTurn), saved.current_revision, allowance);
      } else strategy.refresh();
      return;
    }
    if (bound.job.state !== "failed" && bound.job.state !== "cancelled") return;
    lock.current = true;
    setWorking(true);
    try {
      await persist(
        appendGuidedTurn(saved.context, {
          ...currentTurn,
          id: crypto.randomUUID(),
          inputRevision: saved.current_revision + 1,
        }),
      );
    } catch {
      if (mounted.current) setError("The retry could not be saved. Your original prompt is kept.");
    } finally {
      lock.current = false;
      if (mounted.current) setWorking(false);
    }
  }

  const checkingResearch =
    currentTurn?.stage === "competitors" &&
    currentTurn.purpose !== "message" &&
    !strategy.readError &&
    (!strategy.overview || (!bound && strategy.pending));

  const statusReadError =
    strategy.readError && active && currentTurn?.stage === "competitors"
      ? "Research status could not be checked. Your prompt is saved."
      : strategy.readError;
  const failed = bound && !strategyJobActive(bound.job) && !reply && bound.job.state !== "succeeded";
  const unverified = bound?.job.state === "succeeded" && !reply;
  const stale =
    currentTurn && !reply && !workspace.pendingGuidedContext && currentTurn.inputRevision !== saved.current_revision;
  const unavailable =
    !turnStarting &&
    !(active && availability?.reason === "request_active") &&
    ((currentTurn && !bound && strategy.overview && !allowance) ||
      (!state &&
        saved.scope === "complete_brand" &&
        strategy.overview &&
        !guidedAllowance(availability, "strategy.competitors")));
  const legacyJobs = [...jobs]
    .filter((job) => job.state === "succeeded" && !job.results.some((result) => result.output.guidance))
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  const timeline = guidedTimeline(context);
  // Selecting a name keeps this workspace open for screening and changing the
  // selection. Strategy readiness and save guards still protect the handoff.
  const namingReady =
    (state?.stage === "complete" || state?.stage === "slogan") &&
    !dirty &&
    !workspace.conflict &&
    !busy &&
    !workspace.pendingGuidedContext &&
    saved.scope === "complete_brand" &&
    getNamingReadiness(saved.context, saved.scope).ready;
  // On a cold reopen, let the saved Strategy answers load before the first Naming question.
  const historyChecked = Boolean(strategy.overview || strategy.readError);
  const showNaming = (briefOpen ? briefFromNaming : namingReady) && historyChecked;
  // Once a name is chosen and the slogan is proposed for it, the names fold into
  // one answer and the conversation continues. Change name reopens them.
  const nameChosen = Boolean(context.selectedName) && Boolean(state?.turns.some((turn) => turn.stage === "slogan"));
  const namingOpen = showNaming && (!nameChosen || namingReopened);
  const reached: JourneyStepId =
    showNaming || state?.stage === "personality" || state?.stage === "slogan" || state?.stage === "complete"
      ? "voice"
      : "strategy";
  const brandName = context.selectedName?.trim() || saved.title;

  // Strategy, then Voice from the first personality question on, then Identity
  // (Inspiration) once Voice is finished: the slogan answered or skipped.
  const voiceShown =
    reached === "voice" ||
    Boolean(state?.answers.some((answer) => answer.stage === "personality")) ||
    timeline.some(
      (item) => item.kind === "turn" && (item.turn.stage === "personality" || item.turn.stage === "slogan"),
    );
  const identityShown = state?.stage === "complete" && nameChosen && saved.scope === "complete_brand";
  // Logo and Creative direction follow Inspiration, each after the previous step's
  // Send, when the project has already reached it, or when a link points at it.
  const progress = useProjectProgress(),
    projectBase = `/brands/account/${saved.id}`;
  const nextPath = progress?.projectId === saved.id ? progress.nextHref?.split(/[?#]/, 1)[0] : undefined;
  const logoReached = Boolean(nextPath?.startsWith(`${projectBase}/logo`));
  const directionsReached = Boolean(
    nextPath?.startsWith(`${projectBase}/logo/directions`) || nextPath?.startsWith(`${projectBase}/logo/deliverables`),
  );
  // A brand whose next step is Assets is finished: its steps fold and the work shows the brand.
  const finished = Boolean(nextPath?.startsWith(`${projectBase}/logo/deliverables`));
  const [logoOpened, setLogoOpened] = useState(false),
    [directionsOpened, setDirectionsOpened] = useState(false);
  // A redirect from an old step page commits its `#journey-…` address with this
  // page's first render; the store reads it again right after that render.
  const hash = useSyncExternalStore(subscribeToHash, readHash, noHash);
  const logoLinked = hash === "#journey-logo",
    directionsLinked = hash === "#journey-directions";
  const logoShown = identityShown && historyChecked && (logoOpened || logoLinked || directionsLinked || logoReached);
  const directionsShown = logoShown && (directionsOpened || directionsLinked || directionsReached);

  // The work area shows one step: the latest one, or a finished one reopened from its folded entry in the chat.
  const latestView: WorkView = namingOpen
    ? "naming"
    : identityShown
      ? directionsShown
        ? "directions"
        : logoShown
          ? "logo"
          : "inspiration"
      : state?.stage === "slogan" || (state?.stage === "complete" && saved.scope === "complete_brand")
        ? "slogan"
        : "choices";
  const [reopened, setReopened] = useState<WorkView | null>(null);
  // A link to the Logo step opens it even when the project has moved past it.
  const [linkedLogo, setLinkedLogo] = useState(logoLinked);
  if (logoLinked && !linkedLogo) setLinkedLogo(true);
  const requested = reopened ?? (linkedLogo && logoShown && !directionsLinked ? "logo" : null);
  const view: WorkView =
    !namingOpen &&
    requested &&
    ((requested === "inspiration" && identityShown) ||
      (requested === "logo" && logoShown) ||
      (requested === "directions" && directionsShown))
      ? requested
      : latestView;
  const viewStep: JourneyStepId =
    view === "choices"
      ? state?.stage === "personality"
        ? "voice"
        : "strategy"
      : view === "naming" || view === "slogan"
        ? "voice"
        : "identity";
  // A finished brand shows the brand itself; Change direction on its folded entry reopens the three boards.
  const brandShown = finished && view === "directions" && reopened !== "directions";
  const continueLatest = () => {
    setReopened(null);
    setLinkedLogo(false);
  };

  const sections: JourneyStepId[] = identityShown
    ? ["strategy", "voice", "identity"]
    : voiceShown
      ? ["strategy", "voice"]
      : ["strategy"];
  const [sectionViewed, setSectionViewed] = useState<JourneyStepId | null>(null);
  useConversationSteps(reached, sectionViewed ?? viewStep, sections);

  // Steps in the work area report their reply box action, result rows and folded summaries here.
  const replyRegistry = useReplyRegistry();
  const [chatSlot, setChatSlot] = useState<HTMLDivElement | null>(null);
  const [overlayHost, setOverlayHost] = useState<HTMLDivElement | null>(null);
  const [rowOwners, setRowOwners] = useState<ReadonlyMap<symbol, 1 | 2>>(new Map());
  const [summaries, setSummaries] = useState<Partial<Record<WorkspaceSummaryStep, WorkspaceStepSummary>>>({});
  const setRows = useCallback((owner: symbol, rows: 1 | 2 | null) => {
    setRowOwners((previous) => {
      if ((previous.get(owner) ?? null) === rows) return previous;
      const next = new Map(previous);
      if (rows) next.set(owner, rows);
      else next.delete(owner);
      return next;
    });
  }, []);
  const setSummary = useCallback((step: WorkspaceSummaryStep, summary: WorkspaceStepSummary | null) => {
    setSummaries((previous) => {
      if (JSON.stringify(previous[step] ?? null) === JSON.stringify(summary)) return previous;
      const next = { ...previous };
      if (summary) next[step] = summary;
      else delete next[step];
      return next;
    });
  }, []);
  // The Logo and Creative direction steps word Embel's message for their state ("I'm drawing six concepts…").
  const [stepMessages, setStepMessages] = useState<Partial<Record<WorkspaceSummaryStep, string>>>({});
  const setMessage = useCallback((step: WorkspaceSummaryStep, text: string | null) => {
    setStepMessages((previous) => {
      if ((previous[step] ?? null) === text) return previous;
      const next = { ...previous };
      if (text === null) delete next[step];
      else next[step] = text;
      return next;
    });
  }, []);
  const slots = useMemo(
    () => ({ chat: chatSlot, overlay: overlayHost, setRows, setSummary, setMessage }),
    [chatSlot, overlayHost, setRows, setSummary, setMessage],
  );
  const rows = [...rowOwners.values()].at(-1);
  const [likes, setLikes] = useState<number | null>(null);
  const [sloganChoice, setSloganChoice] = useState<SloganChoice | null>(null);
  // The Logo and Creative direction steps hand their reply box (chips, Send, Stop) to the conversation.
  const [stepReply, setStepReply] = useState<StepReply | null>(null);

  // The project bar's steps open their part of the chat.
  const root = useRef<HTMLDivElement>(null);
  const showSection = useEffectEvent((step: JourneyStepId) => {
    const section = document.getElementById(journeySectionId(step));
    if (!section || !root.current?.contains(section)) return;
    if (step === "identity") continueLatest();
    setSectionViewed(step === viewStep ? null : step);
    const folded = section.querySelector<HTMLDetailsElement>("details");
    if (folded && step !== viewStep) folded.open = true;
    section.scrollIntoView({ block: "nearest" });
    section.focus({ preventScroll: true });
  });
  useEffect(() => {
    const area = root.current;
    if (!area) return;
    const listener = (event: Event) => {
      const step = (event as CustomEvent<unknown>).detail;
      if (step === "strategy" || step === "voice" || step === "identity") showSection(step);
    };
    area.addEventListener(JOURNEY_SECTION_EVENT, listener);
    return () => area.removeEventListener(JOURNEY_SECTION_EVENT, listener);
  }, []);
  // A `#journey-strategy` or `#journey-voice` link opens that part of the chat once the saved conversation has loaded.
  const linkedSection = useRef<JourneyStepId | null | undefined>(undefined);
  useLayoutEffect(() => {
    if (linkedSection.current === undefined) linkedSection.current = journeySectionOfHash(window.location.hash);
    const step = linkedSection.current;
    if (!step || !historyChecked) return;
    linkedSection.current = null;
    showSection(step);
  }, [historyChecked, voiceShown]);
  // Working on the step on screen again puts the bar back on it.
  if (sectionViewed && sectionViewed === viewStep) setSectionViewed(null);

  const runningJob = bound && strategyJobActive(bound.job) ? bound.job : null;
  const stop = runningJob ? () => void strategy.cancel(runningJob) : undefined;
  const stopping = bound?.job.state === "cancel_requested";
  const researching =
    currentTurn?.stage === "competitors" &&
    currentTurn.purpose === "research" &&
    Boolean(runningJob || (strategy.pending && !bound));
  const thinkingLabel = active
    ? runningJob
      ? runningJob.state === "queued"
        ? "Request queued…"
        : "Thinking…"
      : "A request is in progress…"
    : strategy.pending
      ? currentTurn?.purpose === "research"
        ? "Starting research…"
        : "Starting response…"
      : "Checking research status…";
  const hasComposer = saved.scope === "complete_brand" || Boolean(state);
  const embelWorking = Boolean(active || checkingResearch);
  const researchFailed = Boolean(failed) && currentTurn?.stage === "competitors" && currentTurn.purpose !== "message";
  const canStartResearch = Boolean(
    strategy.overview && !strategy.readError && guidedAllowance(availability, "strategy.competitors"),
  );

  // ----- The chat -----
  const firstMessage = timeline.find((item) => item.kind === "user");
  // Choosing cards records the labels as your message so the next question can
  // refer to it. The folded answer already shows them, so that echo is not repeated.
  const choiceEchoes = new Set(
    (state?.answers ?? []).flatMap((answer) => {
      const labels = answerLabels(answer);
      return labels.length ? [labels.join("; ")] : [];
    }),
  );
  function replyOf(turnId: string) {
    const answeredTurn = state?.turns.find((item) => item.id === turnId);
    return answeredTurn ? guidedTurnResult(jobs, answeredTurn, account.userId, saved.id)?.reply : null;
  }
  function answerLabels(answer: NonNullable<typeof state>["answers"][number]): string[] {
    const answeredReply = replyOf(answer.turnId);
    if (answeredReply?.kind !== "choices") return [];
    return [
      ...answer.optionIds.map((id) => answeredReply.options.find((option) => option.id === id)?.label),
      ...(answer.stage === "competitors" ? (retainedAnswerNames(answer.customText, context.competitors) ?? []) : []),
    ].filter((label): label is string => Boolean(label));
  }
  const answerFor = (stage: GuidedStage) => state?.answers.find((answer) => answer.stage === stage);
  // The question as Embel asked it, for the Edit buttons of folded answers.
  const questionOf = (stage: GuidedStage) => {
    const answer = answerFor(stage),
      asked = answer ? replyOf(answer.turnId) : null;
    return asked?.kind === "choices" ? asked.question : stageQuestions[stage];
  };
  const answeredTurnIds = new Set(state?.answers.map((answer) => answer.turnId));
  let cut = -1;
  timeline.forEach((item, index) => {
    if (item.kind === "turn" && answeredTurnIds.has(item.turn.id)) cut = index;
  });
  // Only what happened since the last finished answer stays open in the chat; earlier steps are folded.
  const liveItems = timeline.slice(cut + 1).filter((item) => {
    if (item === firstMessage) return false;
    if (item.kind === "user") return !choiceEchoes.has(item.event.text.trim());
    const output = guidedTurnResult(jobs, item.turn, account.userId, saved.id)?.reply;
    if (!output || output.kind === "accepted" || output.kind === "redirect") return false;
    // Options that were replaced by newer ones are not offered again.
    return output.kind !== "choices" || item.turn.id === choiceTurn?.id;
  });

  const editDisabled = Boolean(blocked);
  const turnOf = (stage: GuidedStage) => state?.turns.find((item) => item.id === answerFor(stage)?.turnId);
  const competitorsAnswer = answerFor("competitors"),
    audienceAnswer = answerFor("audience"),
    positioningAnswer = answerFor("positioning"),
    personalityAnswer = answerFor("personality"),
    sloganAnswer = answerFor("slogan");
  const competitorNames = competitorsAnswer
    ? answerLabels(competitorsAnswer).length
      ? answerLabels(competitorsAnswer)
      : context.competitors.filter((item) => item.selected).map((item) => item.name)
    : [];
  const strategyFolded = positioningAnswer ? (
    <FoldedAnswer
      label="Strategy"
      answers={[...(audienceAnswer ? answerLabels(audienceAnswer) : []), ...answerLabels(positioningAnswer)].map(
        (text) => ({ text }),
      )}
    >
      <FoldedPart
        label="Competitors"
        answers={competitorNames}
        editName={`Edit your answer: ${questionOf("competitors")}`}
        disabled={editDisabled}
        onEdit={() => void revisit("competitors", turnOf("competitors")?.userMessageId ?? null)}
      />
      <FoldedPart
        label="Audience"
        answers={audienceAnswer ? answerLabels(audienceAnswer) : []}
        editName={`Edit your answer: ${questionOf("audience")}`}
        disabled={editDisabled}
        onEdit={() => void revisit("audience", turnOf("audience")?.userMessageId ?? null)}
      />
      <FoldedPart
        label="Positioning"
        answers={answerLabels(positioningAnswer)}
        editName={`Edit your answer: ${questionOf("positioning")}`}
        disabled={editDisabled}
        onEdit={() => void revisit("positioning", turnOf("positioning")?.userMessageId ?? null)}
      />
    </FoldedAnswer>
  ) : (
    <>
      {competitorsAnswer && (
        <FoldedAnswer
          label="Competitors"
          answers={[{ text: `${competitorNames.length} kept` }]}
          editName={`Edit your answer: ${questionOf("competitors")}`}
          onEdit={() => void revisit("competitors", turnOf("competitors")?.userMessageId ?? null)}
          editDisabled={editDisabled}
        >
          <p>{competitorNames.join(", ") || "None kept"}</p>
        </FoldedAnswer>
      )}
      {audienceAnswer && (
        <FoldedAnswer
          label="Audience"
          answers={answerLabels(audienceAnswer).map((text) => ({ text }))}
          editName={`Edit your answer: ${questionOf("audience")}`}
          onEdit={() => void revisit("audience", turnOf("audience")?.userMessageId ?? null)}
          editDisabled={editDisabled}
        />
      )}
    </>
  );
  const nameFolded = nameChosen && !namingReopened;
  const changeName = () => {
    setNamingReopened(true);
    setReopenedFor(context.selectedName ?? "");
  };
  const voiceDone = state?.stage === "complete" && Boolean(sloganAnswer) && nameFolded;
  const voiceFolded = voiceDone ? (
    <FoldedAnswer
      label="Voice"
      answers={[
        ...(personalityAnswer ? answerLabels(personalityAnswer) : []),
        context.selectedName ?? "",
        ...(sloganAnswer?.customText ? [sloganAnswer.customText] : []),
      ]
        .filter(Boolean)
        .map((text) => ({ text }))}
    >
      {personalityAnswer && (
        <FoldedPart
          label="Personality"
          answers={answerLabels(personalityAnswer)}
          editName={`Edit your answer: ${questionOf("personality")}`}
          disabled={editDisabled}
          onEdit={() => void revisit("personality", turnOf("personality")?.userMessageId ?? null)}
        />
      )}
      <FoldedPart
        label="Name"
        answers={[context.selectedName ?? ""]}
        editLabel="Change name"
        disabled={editDisabled}
        onEdit={changeName}
      />
      <FoldedPart
        label="Slogan"
        answers={sloganAnswer?.customText ? [sloganAnswer.customText] : []}
        editName={`Edit your answer: ${questionOf("slogan")}`}
        disabled={editDisabled}
        onEdit={() => void revisit("slogan", turnOf("slogan")?.userMessageId ?? null)}
      />
    </FoldedAnswer>
  ) : (
    <>
      {personalityAnswer && (
        <FoldedAnswer
          label="Personality"
          answers={answerLabels(personalityAnswer).map((text) => ({ text }))}
          editName={`Edit your answer: ${questionOf("personality")}`}
          onEdit={() => void revisit("personality", turnOf("personality")?.userMessageId ?? null)}
          editDisabled={editDisabled}
        />
      )}
      {nameFolded && (
        <FoldedAnswer
          label="Name"
          answers={[{ text: context.selectedName ?? "" }]}
          editLabel="Change name"
          onEdit={changeName}
          editDisabled={editDisabled}
        />
      )}
    </>
  );
  const thumbnail = (summary?: WorkspaceStepSummary) =>
    summary?.thumbnail ? (
      // A small private preview the step supplies; its size is fixed by the folded entry.
      // eslint-disable-next-line @next/next/no-img-element
      <img className="conversation-folded__thumb" src={summary.thumbnail.src} alt={summary.thumbnail.alt} />
    ) : undefined;
  const identityFolded = identityShown && (
    <>
      {logoShown && view !== "inspiration" && (
        <FoldedAnswer
          label="Inspiration"
          answers={
            likes === null ? [{ text: "Your likes", icon: "heart" }] : [{ text: `${likes} liked`, icon: "heart" }]
          }
          editLabel="Edit inspiration"
          onEdit={() => setReopened("inspiration")}
        />
      )}
      {directionsShown && view !== "logo" && (
        <FoldedAnswer
          label="Logo"
          thumbnail={thumbnail(summaries.logo)}
          answers={[{ text: summaries.logo?.answer ?? "Chosen" }]}
          editLabel="Change logo"
          onEdit={() => setReopened("logo")}
        />
      )}
      {finished && summaries.directions && (view !== "directions" || brandShown) && (
        <FoldedAnswer
          label="Creative direction"
          thumbnail={thumbnail(summaries.directions)}
          answers={[{ text: summaries.directions.answer }]}
          editLabel="Change direction"
          onEdit={() => setReopened("directions")}
        />
      )}
    </>
  );

  const turnMessage = (stage: GuidedStage | null, children: ReactNode, label = "Embel response") => (
    <article className="e-turn e-turn--settled" aria-label={label}>
      <div className="e-turn__main">
        <p className="e-turn__meta">{stage ? `Embel · ${guidedStageLabel(stage)}` : "Embel"}</p>
        {children}
      </div>
    </article>
  );
  const userMessage = (text: string, key: string, extra?: ReactNode) => (
    <div key={key} className="e-turn e-turn--user e-turn--settled">
      <div className="e-turn__bubble">
        <p className="e-turn__text">{text}</p>
        {extra}
      </div>
    </div>
  );
  const briefEditor = (
    <AccountBriefEditor
      workspace={workspace}
      open={briefOpen}
      onOpen={() => {
        setBriefFromNaming(Boolean(namingReady));
        setBriefOpen(true);
      }}
      onClose={() => setBriefOpen(false)}
      readOnly={Boolean(pending || workspace.conflict || workspace.pendingDraftSave || workspace.pendingGuidedContext)}
      saveLabel={storage.saveLabel}
      onUpdate={storage.onUpdate}
      navigation={navigation}
    />
  );
  const legacyReplies = legacyJobs.flatMap((job) =>
    job.results.map((result) => (
      <article
        key={`${job.id}-${result.stepKey}`}
        id={`guided-result-${job.id}-${result.stepKey}`}
        className="e-turn e-turn--settled"
        aria-label="Earlier Embel response"
      >
        <div className="e-turn__main">
          <p className="e-turn__meta">Embel</p>
          <p className="e-turn__text">{result.output.proposal.message}</p>
        </div>
      </article>
    )),
  );
  const liveMessages = liveItems.map((item) => {
    if (item.kind === "user") return userMessage(item.event.text, item.event.id);
    const output = guidedTurnResult(jobs, item.turn, account.userId, saved.id)?.reply;
    if (!output || output.kind === "accepted" || output.kind === "redirect") return null;
    return (
      <article
        key={item.turn.id}
        id={`guided-turn-${item.turn.id}`}
        tabIndex={-1}
        className="e-turn e-turn--settled"
        aria-label="Embel response"
      >
        <div className="e-turn__main">
          <p className="e-turn__meta">Embel · {guidedStageLabel(item.turn.stage)}</p>
          <p className="e-turn__text">
            {item.turn.stage === "personality" ? withoutScoreScaleNote(output.message) : output.message}
          </p>
          {output.kind === "question" && <p className="e-turn__text e-strong">{output.question}</p>}
        </div>
      </article>
    );
  });

  // What Embel is doing for the step that is open, said in the chat; its result appears in the work area.
  const pendingStage = currentTurn && !reply ? currentTurn.stage : null;
  const pendingCopy: Partial<Record<GuidedStage, string>> = {
    competitors: "I’m looking for brands that compete with your idea. They appear on the right when they’re ready.",
    audience: `I’m thinking about who ${brandName} should speak to first. The options appear on the right when they’re ready.`,
    positioning: `I’m working out how ${brandName} could stand apart. The options appear on the right when they’re ready.`,
    personality: `I’m writing three personalities for ${brandName}. They appear on the right when they’re ready.`,
    slogan: `I’m writing a few slogans for ${brandName}. They appear on the right when they’re ready.`,
  };
  const status =
    embelWorking &&
    (researching ? (
      <div
        className="e-stack e-stack--sm conversation-progress"
        role="status"
        aria-label="Researching your competitors"
      >
        <p>{stopping ? "Cancelling research…" : "Researching your competitors and the pages they were found on."}</p>
        <div className="e-progress" data-state={stopping ? "stopping" : "running"} aria-hidden="true">
          <div className="e-progress__track" />
        </div>
        <p className="e-section__hint">Your brief is saved.</p>
      </div>
    ) : (
      <div
        className="e-thinking"
        role="status"
        aria-label={stopping ? "Stopping…" : thinkingLabel === "Thinking…" ? "Embel is thinking" : thinkingLabel}
      >
        <Spinner />
        <span>{stopping ? "Stopping…" : thinkingLabel}</span>
      </div>
    ));
  const problem =
    error || strategy.actionError || strategy.readError || failed || unverified || unavailable || stale
      ? (error ??
        strategy.actionError ??
        statusReadError ??
        (stale
          ? "The project changed after this response was requested. Your conversation is kept. Send a new message to continue from the current version."
          : bound?.job.state === "needs_reconciliation"
            ? "This research outcome needs verification before another request can start. Your prompt is saved."
            : requestBlocked
              ? strategyAvailabilityMessage(availability, "project")
              : failed
                ? bound?.job.state === "cancelled"
                  ? researchFailed
                    ? "Research was cancelled. Your brief is saved."
                    : "Research was cancelled. Your prompt is saved."
                  : researchFailed
                    ? "Research could not produce verified suggestions. Your brief is saved."
                    : "Your prompt is saved."
                : unverified
                  ? "This response could not be matched to your question. Your conversation is kept."
                  : strategyAvailabilityMessage(availability ?? null, "project")))
      : null;
  const canRetry =
    Boolean(currentTurn) &&
    !stale &&
    !requestBlocked &&
    (!bound || bound.job.state === "failed" || bound.job.state === "cancelled");
  const problemMessage = problem && (
    <InlineMessage
      tone="danger"
      className="guided-conversation-error"
      title={
        failed && !error && !strategy.actionError && !strategy.readError
          ? researchFailed
            ? "The competitor research didn’t finish"
            : "This response didn’t finish"
          : undefined
      }
      actions={
        <>
          {canRetry && (
            <Button variant="primary" size="sm" icon="rotate-ccw" disabled={blocked} onClick={() => void retry()}>
              {researchFailed ? "Try again" : "Retry request"}
            </Button>
          )}
          {!(researchFailed && canRetry) && (
            <Button variant="quiet" size="sm" disabled={busy || working || strategy.pending} onClick={strategy.refresh}>
              Check status
            </Button>
          )}
        </>
      }
    >
      <p>{problem}</p>
    </InlineMessage>
  );
  const sloganTurn = choiceTurn?.stage === "slogan" ? choiceTurn : null;
  const sloganReply = sloganTurn ? guidedTurnResult(jobs, sloganTurn, account.userId, saved.id)?.reply : null;
  const choiceReply =
    choiceTurn && choiceTurn.stage !== "slogan"
      ? guidedTurnResult(jobs, choiceTurn, account.userId, saved.id)?.reply
      : null;

  const identityCopy: Record<"inspiration" | "logo" | "directions" | "finished", { label: string; text: string }> = {
    inspiration: {
      label: journeyPartLabel("identity", "Inspiration"),
      text: `${reopened === "inspiration" ? "" : `Your voice is set. Now let’s shape how ${brandName} looks. `}Like the brands you’re drawn to: a whole brand, or just its logo, colors, typefaces, socials or visuals. Your likes guide the logo concepts. When you’re done, press Send to continue.`,
    },
    logo: {
      label: journeyPartLabel("identity", "Logo"),
      text:
        stepMessages.logo ??
        `Let’s draw the logo for ${brandName}. The concepts appear on the right; choose the one you like most, then press Send to continue to Creative direction.`,
    },
    directions: {
      label: journeyPartLabel("identity", "Creative direction"),
      text:
        stepMessages.directions ??
        "Each creative direction uses your chosen logo. Choose one on the right, then press Send to continue.",
    },
    finished: {
      label: "",
      text:
        summaries.logo && summaries.directions
          ? `You chose ${summaries.logo.answer} as your logo and ${summaries.directions.answer} as your direction. Your brand kit is in Assets. Press Send to go there, or describe a change.`
          : "Your logo and creative direction are chosen. Your brand kit is in Assets. Press Send to go there, or describe a change.",
    },
  };
  const identityKey =
    view === "directions"
      ? brandShown
        ? "finished"
        : "directions"
      : view === "logo" || view === "inspiration"
        ? view
        : null;
  const identityMessage =
    identityShown &&
    identityKey &&
    (() => {
      const copy = identityCopy[identityKey];
      return (
        <article className="e-turn e-turn--settled" aria-label="Embel response">
          <div className="e-turn__main">
            <p className="e-turn__meta">{copy.label ? `Embel · ${copy.label}` : "Embel"}</p>
            {copy.text && <p className="e-turn__text">{copy.text}</p>}
          </div>
        </article>
      );
    })();
  const startMessage =
    !state &&
    saved.scope === "complete_brand" &&
    turnMessage(
      "competitors",
      <p className="e-turn__text">
        Your brief is saved. Next, I’ll find the brands you compete with, so you can choose the ones to compare against.
        Press Send to start research.
      </p>,
      "Start research",
    );
  const pendingMessage =
    pendingStage &&
    embelWorking &&
    currentTurn?.purpose !== "message" &&
    !liveItems.some((item) => item.kind === "turn" && item.turn.id === currentTurn?.id)
      ? pendingCopy[pendingStage]
      : null;
  const metaStage: GuidedStage | null = currentTurn?.stage ?? (!state ? "competitors" : null);
  const statusMessage = (status || problemMessage || pendingMessage) && (
    <article className="e-turn e-turn--settled" aria-label="Embel status">
      <div className="e-turn__main">
        <p className="e-turn__meta">{metaStage ? `Embel · ${guidedStageLabel(metaStage)}` : "Embel"}</p>
        {pendingMessage && <p className="e-turn__text">{pendingMessage}</p>}
        {status}
        {problemMessage}
      </div>
    </article>
  );

  const chatLog = (
    <>
      {firstMessage?.kind === "user"
        ? userMessage(firstMessage.event.text, firstMessage.event.id, briefEditor)
        : saved.scope !== "complete_brand"
          ? userMessage(saved.context.description, "description", briefEditor)
          : briefEditor}
      {legacyReplies}
      <section
        id={journeySectionId("strategy")}
        className="e-stack e-stack--sm conversation-section"
        data-journey-section="strategy"
        aria-label="Strategy"
        tabIndex={-1}
      >
        {strategyFolded}
      </section>
      {voiceShown && (
        <section
          id={journeySectionId("voice")}
          className="e-stack e-stack--sm conversation-section"
          data-journey-section="voice"
          aria-label="Voice"
          tabIndex={-1}
        >
          {voiceFolded}
        </section>
      )}
      {identityShown && (
        <section
          id={journeySectionId("identity")}
          className="e-stack e-stack--sm conversation-section"
          data-journey-section="identity"
          aria-label="Identity"
          tabIndex={-1}
        >
          {identityFolded}
        </section>
      )}
      {startMessage}
      {liveMessages}
      {namingOpen && <div ref={setNamingMessages} className="guided-naming-messages" />}
      {identityMessage}
      <div ref={setChatSlot} className="conversation-chat-slot" />
      {statusMessage}
      {storage.actions}
      {storage.resultNavigation}
    </>
  );

  // ----- The work area -----
  const workStage: GuidedStage =
    currentTurn?.stage ?? (state?.stage && state.stage !== "complete" ? state.stage : "competitors");
  const choicesWork = (() => {
    if (choiceReply?.kind === "choices")
      return (
        <GuidedChoices
          projectId={saved.id}
          reply={choiceReply}
          selectedIds={selectedCompetitors(choiceReply)}
          additionalControls={
            choiceReply.stage === "competitors" ? (
              <CompetitorWidgetControls
                draft={competitorDraft}
                onDraft={(value) => changeInput((previous) => ({ ...previous, competitorDraft: value }))}
                onAdd={() => addCompetitor(choiceReply)}
                onMore={() => void moreCompetitors(choiceReply)}
                disabled={Boolean(blocked)}
                canGenerate={!requestBlocked && Boolean(guidedAllowance(availability, "strategy.competitors"))}
                generating={active}
              />
            ) : undefined
          }
          retainedOptions={choiceReply.stage === "competitors" ? retainedOptions(choiceReply) : undefined}
          onSelectionChange={(ids) => setSelection({ turnId: choiceReply.turnId, ids })}
          disabled={Boolean(blocked)}
        />
      );
    const stage = workStage;
    const title = stage === "competitors" ? "Competitors" : undefined;
    if (embelWorking || (state && !problem && pendingStage))
      return <GuidedChoicesLoading stage={stage} title={title} />;
    if (!state && saved.scope !== "complete_brand") return null;
    return <GuidedChoicesEmpty stage={stage} title={title} research={stage === "competitors"} />;
  })();
  const sloganWork =
    sloganReply?.kind === "choices" && sloganTurn ? (
      <GuidedSlogan
        reply={sloganReply}
        brandName={brandName}
        choice={
          sloganChoice?.turnId === sloganTurn.id ? sloganChoice : { turnId: sloganTurn.id, chosen: null, own: "" }
        }
        onChoice={setSloganChoice}
        disabled={Boolean(blocked)}
        onSkip={() => void skipSlogan(sloganTurn.id)}
        onMore={() => void moreSlogans()}
        canMore={!requestBlocked && Boolean(guidedAllowance(availability, "strategy.reformulate"))}
      />
    ) : embelWorking || !problem ? (
      <GuidedChoicesLoading stage="slogan" />
    ) : (
      <GuidedChoicesEmpty stage="slogan" />
    );
  const work =
    view === "naming" ? (
      <div ref={setNamingResults} className="guided-naming-results" />
    ) : view === "slogan" ? (
      sloganWork
    ) : view === "inspiration" ? (
      <InspirationWorkspace projectId={saved.id} variant="workspace" continueHidden onLikes={setLikes} />
    ) : view === "logo" ? (
      <div id="journey-logo" className="conversation-slot" tabIndex={-1}>
        <LogoCreationWorkspace
          projectId={saved.id}
          continueHidden={directionsShown}
          onContinue={() => {
            continueLatest();
            setDirectionsOpened(true);
          }}
          reply="external"
          onReplyChange={setStepReply}
        />
      </div>
    ) : view === "directions" ? (
      <div id="journey-directions" className="conversation-slot" tabIndex={-1}>
        <VisualDirectionsPage
          projectId={saved.id}
          variant="conversation"
          presentation={brandShown ? "brand" : "choose"}
          reply="external"
          onReplyChange={setStepReply}
        />
      </div>
    ) : (
      choicesWork
    );

  // ----- The reply box: Send is the one way forward -----
  const nextStepName: Record<GuidedStage, string> = {
    competitors: "Audience",
    audience: "Positioning",
    positioning: "Voice",
    personality: "Name",
    slogan: "Identity",
  };
  const chipPrefix: Record<GuidedStage, string> = {
    competitors: "Competitors",
    audience: "Audience",
    positioning: "Positioning",
    personality: "Personality",
    slogan: "Slogan",
  };
  const stopControl: WorkspaceReplyAction["working"] = embelWorking
    ? { label: researching ? "Stop research" : "Stop response", onStop: stop, stopping }
    : undefined;
  const ownAction: WorkspaceReplyAction | null = (() => {
    if (stopControl) return { working: stopControl };
    if (view === "choices" && choiceReply?.kind === "choices") {
      const chosen = selectedOptions(
        choiceReply,
        choiceReply.stage === "competitors" ? retainedOptions(choiceReply) : [],
        selectedCompetitors(choiceReply),
      );
      const prefix = chipPrefix[choiceReply.stage];
      const chips =
        choiceReply.stage === "competitors"
          ? chosen.length === 1
            ? [`${prefix}: ${chosen[0]!.label}`]
            : chosen.length
              ? [`${prefix}: ${chosen.length} chosen`]
              : []
          : chosen.map((option) => `${prefix}: ${option.label}`);
      return {
        chips,
        label: `Continue to ${nextStepName[choiceReply.stage]}`,
        onSend: chosen.length && !blocked ? () => void confirm(choiceReply) : undefined,
      };
    }
    if (view === "slogan" && sloganReply?.kind === "choices" && sloganTurn) {
      const choice = sloganChoice?.turnId === sloganTurn.id ? sloganChoice : null;
      const decision = sloganDecision(choice);
      const line = sloganText(sloganReply, choice);
      return {
        chips: line ? [`Slogan: ${line}`] : [],
        label: "Continue to Identity",
        onSend: decision && !blocked ? () => void confirmSlogan(sloganReply, decision) : undefined,
      };
    }
    if (view === "choices" && !state && saved.scope === "complete_brand")
      return {
        label: "Start research",
        onSend: !blocked && canStartResearch ? () => void startResearch() : undefined,
      };
    if (view === "inspiration") {
      const next = !logoShown
        ? "Continue to Logo"
        : latestView === "directions"
          ? finished
            ? "Back to your brand"
            : "Continue to Creative direction"
          : "Continue to Logo";
      return {
        chips: likes === null ? [] : [`Inspiration: ${likes} liked`],
        label: next,
        onSend: () => {
          continueLatest();
          setLogoOpened(true);
        },
      };
    }
    return null;
  })();
  const stepAction =
    stepReply &&
    ((view === "logo" && stepReply.step === "logo") || (view === "directions" && stepReply.step === "direction"))
      ? stepReplyAction(stepReply)
      : null;
  const action = replyRegistry.action ?? stepAction ?? ownAction ?? replyRegistry.fallback;
  // While the names are open, typed text is naming guidance, sent only through the naming step's own handler.
  const namingText = namingOpen && !action?.onSendText;
  const replyBox = (
    <section className="conversation-reply" aria-label={namingOpen ? "Naming composer" : "Strategy composer"}>
      <WorkspaceReplyBox
        value={prompt}
        onChange={setPrompt}
        onSendText={() => void send()}
        action={action}
        label="Message Embel"
        placeholder={
          identityShown
            ? "Describe a change, or press Send to continue…"
            : "Reply in your own words, or ask a question…"
        }
        readOnly={namingText || pending}
        textDisabled={namingOpen ? namingText : Boolean(blocked)}
        notice={busy ? <span role="status">{storage.saveLabel}</span> : undefined}
      />
    </section>
  );

  return (
    <div ref={root} className="guided-interview" data-composer={hasComposer ? "workspace" : undefined}>
      <WorkspaceSlotContext.Provider value={slots}>
        <WorkspaceReplyRegistry.Provider value={replyRegistry.register}>
          <Workspace
            log={chatLog}
            reply={hasComposer ? replyBox : null}
            work={work}
            workLabel={viewStep === "identity" ? "Identity" : viewStep === "voice" ? "Voice" : "Strategy"}
            rows={view === "logo" || view === "directions" ? rows : undefined}
            logKey={JSON.stringify([liveItems.length, Boolean(statusMessage), Boolean(problem), view])}
            overlayHost={setOverlayHost}
          />
          {finished && view === "directions" && <FinishedBrandReply href={`${projectBase}/logo/deliverables`} />}
          {identityShown && likes === null && view !== "inspiration" && (
            <InspirationLikeCount account={account} projectId={saved.id} onCount={setLikes} />
          )}
          {namingOpen && (
            <ProjectNamingWorkspace
              projectId={saved.id}
              inline={{
                messages: namingMessages,
                results: namingResults,
                composer: null,
                reply: "workspace",
                onQuestion: ignoreNamingQuestion,
                onCanvas: ignoreNamingCanvas,
                // Name details open over the work area, not modal, so the chat stays usable.
                overlay: overlayHost,
                onNameConfirmed: closeNaming,
              }}
            />
          )}
        </WorkspaceReplyRegistry.Provider>
      </WorkspaceSlotContext.Provider>
    </div>
  );
}

type WorkView = "choices" | "naming" | "slogan" | "inspiration" | "logo" | "directions";
// The Workspace's reply box serves every naming question, and the names always sit in the work area.
const ignoreNamingQuestion = () => undefined;
const ignoreNamingCanvas = () => undefined;

/** A finished brand's Send goes to Assets, unless the step on screen offers its own. */
function FinishedBrandReply({ href }: { href: string }) {
  const router = useRouter();
  useWorkspaceReply({ label: "Continue to Assets", onSend: () => router.push(href) }, { fallback: true });
  return null;
}
