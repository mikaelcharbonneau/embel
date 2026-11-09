"use client";

import { Fragment, useCallback, useEffect, useEffectEvent, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type ComponentProps, type ReactNode, type RefObject } from "react";
import { AccountBriefEditor } from "./account-brief-editor";
import { ProjectNamingWorkspace } from "@/components/naming/project-naming-workspace";
import { InspirationWorkspace } from "@/components/inspiration/inspiration-workspace";
import { LogoCreationWorkspace } from "@/components/logo-creation/logo-creation-workspace";
import { VisualDirectionsPage } from "@/components/visual-directions/visual-directions-page";
import { useProjectProgress } from "./project-progress";
import { getNamingReadiness } from "@/domain/project-naming";
import { appendGuidedTurn, confirmGuidedSelection, guidedTurnOperation, revisitGuidedStage, skipGuidedSlogan, type GuidedReply, type GuidedStage } from "@/domain/guided-interview";
import { competitorSchema, contextSnapshotSchema, type ContextSnapshot } from "@/domain/projects";
import { CompetitorWidgetControls } from "./competitor-widget-controls";
import { EmbelIdentity, guidedStageLabel } from "./embel-identity";
import { JOURNEY_SECTION_EVENT, journeySectionId, journeySectionOfHash, useConversationSteps } from "@/components/journey/project-header";
import { journeyPartLabel, type JourneyStepId } from "@/domain/journey";
import { accountDraftChanged, type AccountWorkspace, type GuidedInterviewInput } from "./account-draft-memory";
import { strategyAvailabilityMessage, strategyCanRetryDelivery, strategyJobActive } from "./account-strategy-client";
import type { VerifiedAccount } from "./account-session";
import { ConversationComposer } from "./conversation-composer";
import { FloatingComposer } from "./floating-composer";
import { GuidedChoiceWidget } from "./guided-interview-widgets";
import { GuidedSloganWidget, type SloganDecision } from "./guided-slogan-widget";
import { StrategySummary } from "./strategy-summary";
import { GuidedThinking } from "./guided-thinking";
import { ProgressCard } from "@/components/journey/progress-card";
import { guidedAllowance, guidedMessageContext, guidedTimeline, guidedTurnResult, initialGuidedContext, nextGuidedProposal, recordGuidedChoice, retainedAnswerNames, withoutScoreScaleNote } from "./guided-interview-client";
import type { ProjectEditorForm } from "./project-editor";
import { useStrategyJobs } from "./use-strategy-jobs";
import { useConversationFollow } from "./use-conversation-follow";
import "@/styles/conversation.css";

function subscribeToHash(onChange: () => void) {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}
const readHash = () => window.location.hash;
const noHash = () => "";

/** Brings a step that opens below into view, once: after its Continue (request()) or
 * when a link points at it. Images above keep loading after the first jump and push
 * the step down; it stays in view while the layout settles, unless the reader takes
 * over (wheel, touch, keys or a click) in the meantime. */
function useStepReveal(anchor: RefObject<HTMLDivElement | null>, shown: boolean, linked: boolean, transcript: RefObject<HTMLDivElement | null>, jumpTo: (target: HTMLElement) => void) {
  const requested = useRef(false), linkPending = useRef(true);
  const jump = useEffectEvent((target: HTMLElement) => jumpTo(target));
  useEffect(() => {
    const target = anchor.current, area = transcript.current;
    if (!shown || !target || !area || !requested.current && !(linked && linkPending.current)) return;
    requested.current = false; linkPending.current = false;
    let reader = false;
    const takeOver = () => { reader = true; };
    const events = ["wheel", "touchstart", "keydown", "pointerdown"] as const;
    events.forEach(name => area.addEventListener(name, takeOver, { passive: true }));
    jump(target);
    const timers = [300, 800, 1600, 3000].map(delay => setTimeout(() => { if (!reader) jump(target); }, delay));
    const release = setTimeout(() => events.forEach(name => area.removeEventListener(name, takeOver)), 3200);
    return () => { timers.forEach(clearTimeout); clearTimeout(release); events.forEach(name => area.removeEventListener(name, takeOver)); };
  }, [anchor, shown, linked, transcript]);
  return () => { requested.current = true; };
}

export function AccountGuidedInterview({ account, workspace, navigation, busy, saveContext, onInputChange, storage }: {
  account: VerifiedAccount; workspace: AccountWorkspace; navigation?: ReactNode; busy: boolean;
  saveContext: (context: ContextSnapshot, submittedInput?: Partial<GuidedInterviewInput>) => Promise<AccountWorkspace | null>;
  onInputChange?: (update: (input: GuidedInterviewInput) => GuidedInterviewInput) => void;
  storage: ComponentProps<typeof ProjectEditorForm>["storage"];
}) {
  const strategy = useStrategyJobs({ account, workspace, blocked: busy, guided: true });
  const [localInput, setLocalInput] = useState<GuidedInterviewInput>(() => workspace.guidedInput ?? { prompt: "", selection: null });
  const { prompt, selection, competitorDraft = { name: "", website: "" } } = onInputChange ? workspace.guidedInput ?? { prompt: "", selection: null } : localInput;
  const changeInput = onInputChange ?? setLocalInput;
  const setPrompt = (update: string | ((previous: string) => string)) => changeInput(previous => ({ ...previous, prompt: typeof update === "function" ? update(previous.prompt) : update }));
  const setSelection = (selection: GuidedInterviewInput["selection"]) => changeInput(previous => ({ ...previous, selection }));
  const [error, setError] = useState<string | null>(null);
  const [strategyExpanded, setStrategyExpanded] = useState(false);
  const [namingReopened, setNamingReopened] = useState(false);
  const [working, setWorking] = useState(false);
  const [briefOpen, setBriefOpen] = useState(false);
  const [briefFromNaming, setBriefFromNaming] = useState(false);
  const [namingMessages, setNamingMessages] = useState<HTMLDivElement | null>(null);
  const [namingComposer, setNamingComposer] = useState<HTMLDivElement | null>(null);
  const [namingResults, setNamingResults] = useState<HTMLDivElement | null>(null);
  const closeNaming = useCallback(() => { setNamingReopened(false); }, []);
  // Choosing a different name after Change name closes the names again.
  const [reopenedFor, setReopenedFor] = useState<string | null>(null);
  if (namingReopened && reopenedFor !== null && reopenedFor !== (workspace.saved.context.selectedName ?? "")) { setNamingReopened(false); setReopenedFor(null); }
  const [namingQuestionId, setNamingQuestionId] = useState<string | null>(null);
  const [namingCanvas, setNamingCanvas] = useState(false);
  const lock = useRef(false), mounted = useRef(false);
  const attempts = useRef(new Set<string>());
  const transcriptId = useId();
  const saved = workspace.saved;
  const context = workspace.pendingGuidedContext ?? saved.context;
  const state = context.intake.guidedInterview;
  const turn = state?.turns.at(-1);
  const jobs = strategy.overview?.jobs ?? [];
  const availability = strategy.readError ? null : strategy.overview?.availability;
  const requestBlocked = availability?.status === "unavailable" && (availability.reason === "request_unresolved" || availability.reason === "request_active");
  const bound = turn ? guidedTurnResult(jobs, turn, account.userId, saved.id) : null;
  const reply = bound?.reply ?? null;
  const active = jobs.some(strategyJobActive);
  const pending = Boolean(busy || working || strategy.pending || active);
  const dirty = accountDraftChanged(workspace);
  const blocked = pending || dirty || workspace.conflict;
  const currentTurn = turn && state?.stage === turn.stage && !state.answers.some(answer => answer.turnId === turn.id) ? turn : null;
  const operation = currentTurn ? guidedTurnOperation(currentTurn) : null;
  const allowance = operation ? guidedAllowance(availability, operation) : null;
  const turnStarting = Boolean(currentTurn && (strategy.pending || busy || working || workspace.pendingGuidedContext));
  const choiceTurn = state?.stage !== "complete" ? [...(state?.turns ?? [])].reverse().find(item => item.stage === state?.stage && guidedTurnResult(jobs, item, account.userId, saved.id)?.reply?.kind === "choices") : null;

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  function persist(next: ContextSnapshot, submittedInput?: Partial<GuidedInterviewInput>) {
    // The parent owns pending saves, conflicts and their acknowledged recovery.
    return saveContext(next, submittedInput);
  }

  // Persisted turns retain their request identity across a lost acknowledgement.
  // An uncertain enqueue retries the exact key; it never creates a replacement job.
  const coordinate = useEffectEvent(async () => {
    // Voice · Slogan opens once a name is chosen. Choosing the name is the
    // deliberate step; the proposal request keeps one identity per revision.
    if (mounted.current && !lock.current && !busy && !strategy.pending && !active && !dirty && !workspace.conflict && strategy.overview && !strategy.readError
      && state?.stage === "slogan" && saved.context.selectedName && !state.turns.some(item => item.stage === "slogan") && guidedAllowance(availability, "strategy.slogan")) {
      const key = `slogan-start:${saved.current_revision}`;
      if (attempts.current.has(key)) return;
      attempts.current.add(key); lock.current = true; setWorking(true);
      try {
        const latest = [...(saved.context.intake.conversation ?? [])].reverse().find(event => event.kind === "user_message");
        await persist(appendGuidedTurn(saved.context, { id: crypto.randomUUID(), userMessageId: latest?.id ?? null, stage: "slogan", purpose: "propose", inputRevision: saved.current_revision + 1 }));
      } catch { if (mounted.current) setError("Slogan suggestions could not be started. Your name is saved."); }
      finally { lock.current = false; if (mounted.current) setWorking(false); }
      return;
    }
    if (!mounted.current || lock.current || busy || strategy.pending || active || dirty || workspace.conflict || !currentTurn || !strategy.overview || strategy.readError) return;
    if (currentTurn.inputRevision !== saved.current_revision) return;
    if (reply?.kind === "redirect") {
      const key = `redirect:${bound!.job.id}`;
      if (attempts.current.has(key)) return;
      attempts.current.add(key); lock.current = true; setWorking(true);
      try {
        const next = revisitGuidedStage(saved.context, reply.targetStage);
        await persist(appendGuidedTurn(next, { id: crypto.randomUUID(), userMessageId: currentTurn.userMessageId, stage: reply.targetStage, purpose: reply.targetStage === "competitors" ? "research" : "propose", inputRevision: saved.current_revision + 1 }));
      } catch { if (mounted.current) setError("Your change of direction could not be saved. Your message is kept."); }
      finally { lock.current = false; if (mounted.current) setWorking(false); }
      return;
    }
    if (reply?.kind === "answer" && ["competitors", "audience", "positioning", "personality"].every(stage => state?.answers.some(answer => answer.stage === stage))) {
      const key = `clarification:${bound!.job.id}`;
      if (attempts.current.has(key)) return;
      attempts.current.add(key); lock.current = true; setWorking(true);
      try { await persist({ ...saved.context, intake: { ...saved.context.intake, guidedInterview: { ...saved.context.intake.guidedInterview!, stage: "complete" } } }); }
      finally { lock.current = false; if (mounted.current) setWorking(false); }
      return;
    }
    if (reply?.kind === "accepted") {
      const key = `accept:${bound!.job.id}`;
      if (attempts.current.has(key)) return;
      attempts.current.add(key); lock.current = true; setWorking(true);
      try {
        let next = confirmGuidedSelection(saved.context, { turnId: currentTurn.id, reply, now: new Date().toISOString() });
        next = nextGuidedProposal(next, saved.current_revision + 1, currentTurn.userMessageId);
        await persist(next);
      } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : "Your answer could not be saved."); }
      finally { lock.current = false; if (mounted.current) setWorking(false); }
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
  useEffect(() => { void coordinate(); }, [saved.current_revision, state, bound, reply, busy, strategy.pending, strategy.overview, strategy.readError, active, dirty, allowance, currentTurn]);

  async function send() {
    if (lock.current || blocked || !prompt.trim()) return;
    const intendedOperation = state?.turns.length ? "strategy.reformulate" : "strategy.competitors";
    if (!guidedAllowance(availability, intendedOperation)) { setError(strategyAvailabilityMessage(availability ?? null)); return; }
    lock.current = true; setWorking(true); setError(null);
    const text = prompt;
    try {
      const result = await persist(guidedMessageContext(saved.context, text, saved.current_revision + 1), { prompt: text });
      if (result && mounted.current) setPrompt(current => current === text ? "" : current);
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : "Your message could not be saved. Your prompt is kept."); }
    finally { lock.current = false; if (mounted.current) setWorking(false); }
  }

  // A brief saved before research could start: one deliberate click submits it,
  // exactly as Home would have. The saved turn keeps the request identity.
  async function startResearch() {
    if (lock.current || blocked || state || saved.scope !== "complete_brand") return;
    if (!guidedAllowance(availability, "strategy.competitors")) { setError(strategyAvailabilityMessage(availability ?? null)); return; }
    lock.current = true; setWorking(true); setError(null);
    try { await persist(initialGuidedContext(saved.context, saved.current_revision + 1)); }
    catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : "Research could not be started. Your brief is saved."); }
    finally { lock.current = false; if (mounted.current) setWorking(false); }
  }

  async function confirm(answer: Extract<GuidedReply, { kind: "choices" }>) {
    if (lock.current || blocked || choiceTurn?.id !== answer.turnId || state?.stage !== answer.stage) return;
    const ids = selectedCompetitors(answer);
    if (answer.stage === "competitors" && ids.length > 20) { setError("Choose up to 20 competitors before continuing."); return; }
    const optionIds = ids.filter(id => answer.options.some(option => option.id === id));
    const retainedCompetitorIds = answer.stage === "competitors" ? ids.filter(id => !optionIds.includes(id)) : [];
    lock.current = true; setWorking(true); setError(null);
    try {
      const now = new Date().toISOString();
      let next = confirmGuidedSelection(saved.context, { turnId: answer.turnId, reply: answer, optionIds, retainedCompetitorIds, now });
      const chosen = recordGuidedChoice(next, answer, optionIds, now, retainedCompetitorIds);
      next = nextGuidedProposal(chosen.context, saved.current_revision + 1, chosen.messageId);
      const result = await persist(next, { selection: { turnId: answer.turnId, ids } });
      if (result && mounted.current) setSelection(null);
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : "Your selection could not be saved."); }
    finally { lock.current = false; if (mounted.current) setWorking(false); }
  }

  async function confirmSlogan(answer: Extract<GuidedReply, { kind: "choices" }>, decision: SloganDecision) {
    if (lock.current || blocked || choiceTurn?.id !== answer.turnId || state?.stage !== "slogan") return;
    lock.current = true; setWorking(true); setError(null);
    try {
      const now = new Date().toISOString();
      const next = confirmGuidedSelection(saved.context, { turnId: answer.turnId, reply: answer, optionIds: "optionId" in decision ? [decision.optionId] : [], ownSlogan: "own" in decision ? decision.own : undefined, now });
      await persist(next);
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : "Your slogan could not be saved."); }
    finally { lock.current = false; if (mounted.current) setWorking(false); }
  }
  async function skipSlogan(turnId: string) {
    if (lock.current || blocked || state?.stage !== "slogan") return;
    lock.current = true; setWorking(true); setError(null);
    try { await persist(skipGuidedSlogan(saved.context, { turnId, now: new Date().toISOString() })); }
    catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : "Your choice could not be saved."); }
    finally { lock.current = false; if (mounted.current) setWorking(false); }
  }
  async function moreSlogans() {
    if (lock.current || blocked || requestBlocked || state?.stage !== "slogan" || !guidedAllowance(availability, "strategy.reformulate")) return;
    lock.current = true; setWorking(true); setError(null);
    try { await persist(guidedMessageContext(saved.context, "Suggest a few more slogans, different from these.", saved.current_revision + 1)); }
    catch { if (mounted.current) setError("More slogans could not be requested. The current ones are kept."); }
    finally { lock.current = false; if (mounted.current) setWorking(false); }
  }

  function selectedCompetitors(answer: Extract<GuidedReply, { kind: "choices" }>) {
    if (selection?.turnId === answer.turnId) return selection.ids;
    if (answer.stage !== "competitors") return [];
    return context.competitors.filter(item => item.selected).map(item => answer.options.find(option => option.stage === "competitors" && option.payload.name.trim().toLowerCase() === item.name.trim().toLowerCase())?.id ?? item.id);
  }
  function retainedOptions(answer: Extract<GuidedReply, { kind: "choices" }>) {
    const names = new Set(answer.options.flatMap(option => option.stage === "competitors" ? [option.label, option.payload.name] : [option.label])
      .map(name => name.trim().toLowerCase()));
    const previous = (state?.turns ?? []).filter(turn => turn.stage === "competitors" && turn.id !== answer.turnId).flatMap(turn => {
      const prior = guidedTurnResult(jobs, turn, account.userId, saved.id)?.reply;
      return prior?.kind === "choices" ? prior.options.filter(option => option.stage === "competitors") : [];
    }).reverse();
    return context.competitors.filter(item => !names.has(item.name.trim().toLowerCase()) && !answer.options.some(option => option.id === item.id)).map(item => {
      const original = item.origin === "research" ? previous.find(option => option.id === item.id)
        ?? previous.find(option => option.payload.name.trim().toLowerCase() === item.name.trim().toLowerCase()) : undefined;
      return {
        stage: "competitors" as const, id: item.id, label: item.name, payload: item,
        description: original?.description ?? item.relevance,
        recommended: original?.recommended ?? false, recommendationReason: original?.recommendationReason ?? null,
      };
    });
  }
  async function addCompetitor(answer: Extract<GuidedReply, { kind: "choices" }>) {
    if (lock.current || blocked || answer.stage !== "competitors") return false;
    const parsed = competitorSchema.safeParse({ id: crypto.randomUUID(), name: competitorDraft.name, ...(competitorDraft.website.trim() ? { url: competitorDraft.website.trim() } : {}), relevance: "Added by you", origin: "user", selected: true, sources: [] });
    if (!parsed.success) { setError("Enter a competitor name and, optionally, a complete https:// website without login details."); return false; }
    const existingNames = [...context.competitors.map(item => item.name), ...answer.options.map(item => item.label)];
    if (existingNames.some(name => name.trim().toLowerCase() === parsed.data.name.toLowerCase())) { setError("That competitor is already listed. Select the existing entry instead."); return false; }
    if (context.competitors.length >= 50) { setError("This project already has 50 saved competitors. Review the existing list before adding more."); return false; }
    lock.current = true; setWorking(true); setError(null);
    const draft = competitorDraft;
    const selected = selectedCompetitors(answer);
    // Research it like the suggested competitors (website, offer, why it competes,
    // sources) in the same save; without research it is saved as entered.
    const research = !requestBlocked && Boolean(guidedAllowance(availability, "strategy.competitors"));
    try {
      const next = research
        ? researchCompetitorsContext(answer, `Add ${parsed.data.name}${parsed.data.url ? ` (${parsed.data.url})` : ""} to my competitors and research it like the others: its website, what it offers and why it competes with my brand. Keep my existing selections.`, parsed.data)
        : contextSnapshotSchema.parse({ ...saved.context, competitors: [...saved.context.competitors, parsed.data] });
      const result = await persist(next, { competitorDraft: draft });
      if (!result || !mounted.current) return false;
      changeInput(previous => ({ ...previous, competitorDraft: JSON.stringify(previous.competitorDraft) === JSON.stringify(draft) ? undefined : previous.competitorDraft,
        selection: research ? null : { turnId: answer.turnId, ids: [...selected, parsed.data.id] } }));
      return true;
    } catch { if (mounted.current) setError("The competitor could not be confirmed as saved. Your entry is kept; check the saved project before retrying."); return false; }
    finally { lock.current = false; if (mounted.current) setWorking(false); }
  }
  /** A competitor research turn on top of this widget's competitors and current
   * selections (plus one just added, selected), as one saved project change. */
  function researchCompetitorsContext(answer: Extract<GuidedReply, { kind: "choices" }>, request: string, added?: ContextSnapshot["competitors"][number]) {
    const ids = selectedCompetitors(answer), rows = new Map(saved.context.competitors.map(item => [item.name.trim().toLowerCase(), { ...item, selected: ids.includes(item.id) }]));
    for (const option of answer.options) if (option.stage === "competitors") {
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
    if (lock.current || blocked || requestBlocked || answer.stage !== "competitors" || !guidedAllowance(availability, "strategy.competitors")) return;
    lock.current = true; setWorking(true); setError(null);
    try {
      const result = await persist(researchCompetitorsContext(answer, "Suggest more relevant competitors, different from the competitors already saved in this project. Keep my existing selections."));
      if (result && mounted.current) setSelection(null);
    } catch { if (mounted.current) setError("Additional suggestions could not be requested. Your current competitors and selections are kept."); }
    finally { lock.current = false; if (mounted.current) setWorking(false); }
  }

  async function revisit(stage: GuidedStage, anchor: string | null) {
    if (lock.current || blocked) return;
    lock.current = true; setWorking(true); setError(null);
    try {
      const next = revisitGuidedStage(saved.context, stage);
      const latestMessage = [...(next.intake.conversation ?? [])].reverse().find(event => event.kind === "user_message");
      await persist(appendGuidedTurn(next, { id: crypto.randomUUID(), userMessageId: latestMessage?.id ?? anchor, stage, purpose: "propose", inputRevision: saved.current_revision + 1 }));
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : "This answer could not be reopened."); }
    finally { lock.current = false; if (mounted.current) setWorking(false); }
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
    lock.current = true; setWorking(true);
    try { await persist(appendGuidedTurn(saved.context, { ...currentTurn, id: crypto.randomUUID(), inputRevision: saved.current_revision + 1 })); }
    catch { if (mounted.current) setError("The retry could not be saved. Your original prompt is kept."); }
    finally { lock.current = false; if (mounted.current) setWorking(false); }
  }

  const checkingResearch = currentTurn?.stage === "competitors" && currentTurn.purpose !== "message" && !strategy.readError && (!strategy.overview || (!bound && strategy.pending));

  const statusReadError = strategy.readError && active && currentTurn?.stage === "competitors" ? "Research status could not be checked. Your prompt is saved." : strategy.readError;
  const failed = bound && !strategyJobActive(bound.job) && !reply && bound.job.state !== "succeeded";
  const unverified = bound?.job.state === "succeeded" && !reply;
  const stale = currentTurn && !reply && !workspace.pendingGuidedContext && currentTurn.inputRevision !== saved.current_revision;
  const deliveryPending = bound && strategyCanRetryDelivery(bound.job, saved.current_revision);
  const workerDelayed = bound?.job.billingMode !== "chatgpt_subscription" && bound?.job.state === "queued"
    && bound.job.input_revision === saved.current_revision && bound.job.workerDelivery === "worker_delayed";
  const unavailable = !turnStarting && !(active && availability?.reason === "request_active")
    && (currentTurn && !bound && strategy.overview && !allowance || !state && saved.scope === "complete_brand" && strategy.overview && !guidedAllowance(availability, "strategy.competitors"));
  const legacyJobs = [...jobs].filter(job => job.state === "succeeded" && !job.results.some(result => result.output.guidance)).sort((a, b) => a.created_at.localeCompare(b.created_at));
  const timeline = guidedTimeline(context);
  // Selecting a name keeps this workspace open for screening and changing the
  // selection. Strategy readiness and save guards still protect the handoff.
  const namingReady = (state?.stage === "complete" || state?.stage === "slogan") && !dirty && !workspace.conflict && !busy && !workspace.pendingGuidedContext && saved.scope === "complete_brand" && getNamingReadiness(saved.context, saved.scope).ready;
  // On a cold reopen, let the saved Strategy cards take their place before
  // positioning the first Naming question. A failed history read keeps its retry.
  const historyChecked = Boolean(strategy.overview || strategy.readError);
  const showNaming = (briefOpen ? briefFromNaming : namingReady) && historyChecked;
  // Once a name is chosen and the slogan is proposed for it, the names collapse
  // into one answer and the conversation continues below. Change name reopens them.
  const nameChosen = Boolean(context.selectedName) && Boolean(state?.turns.some(turn => turn.stage === "slogan"));
  const namingOpen = showNaming && (!nameChosen || namingReopened);
  const reached: JourneyStepId = showNaming || state?.stage === "personality" || state?.stage === "slogan" || state?.stage === "complete" ? "voice" : "strategy";
  // Once Strategy is complete its saved replies are history. They can load
  // after the Naming checkpoint and must not take the reader to an old turn.
  const responseIds = namingOpen ? (namingQuestionId && !namingCanvas ? [namingQuestionId] : []) : [
    ...legacyJobs.flatMap(job => job.results.map(result => `guided-result-${job.id}-${result.stepKey}`)),
    ...timeline.flatMap(item => {
      if (item.kind !== "turn") return [];
      const output = guidedTurnResult(jobs, item.turn, account.userId, saved.id)?.reply;
      return output && output.kind !== "accepted" && output.kind !== "redirect" ? [`guided-turn-${item.turn.id}`] : [];
    }),
  ];
  const { transcript, onScroll, hasNewResponse, revealNewResponse, jumpTo } = useConversationFollow({
    conversationKey: `${account.userId}:${account.generation}:${saved.id}`,
    contentKey: JSON.stringify([timeline.map(item => item.kind === "user" ? item.event.id : item.turn.id), state?.answers.map(answer => answer.turnId), Boolean(active || checkingResearch), state?.stage, showNaming]),
    responseIds,
  });
  const legacyReplies = legacyJobs.map(job => <Fragment key={job.id}>{job.results.map(result => <article key={result.stepKey} id={`guided-result-${job.id}-${result.stepKey}`} tabIndex={-1} className="guided-assistant-message flow-enter" aria-label="Earlier Embel response"><EmbelIdentity /><p className="guided-assistant-copy">{result.output.proposal.message}</p></article>)}</Fragment>);

  const briefEditor = <AccountBriefEditor workspace={workspace} open={briefOpen} onOpen={() => { setBriefFromNaming(Boolean(namingReady)); setBriefOpen(true); }} onClose={() => setBriefOpen(false)} readOnly={Boolean(pending || workspace.conflict || workspace.pendingDraftSave || workspace.pendingGuidedContext)} saveLabel={storage.saveLabel} onUpdate={storage.onUpdate} navigation={navigation} />;
  const firstMessage = timeline.find(item => item.kind === "user");
  // Choosing cards records the labels as your message so the next question can
  // refer to it. The answered card already shows them, so that echo is not repeated.
  const choiceEchoes = new Set((state?.answers ?? []).flatMap(answer => {
    const answeredTurn = state?.turns.find(turn => turn.id === answer.turnId);
    const answeredReply = answeredTurn ? guidedTurnResult(jobs, answeredTurn, account.userId, saved.id)?.reply : null;
    if (answeredReply?.kind !== "choices") return [];
    const labels = [...answer.optionIds.map(id => answeredReply.options.find(option => option.id === id)?.label), ...(retainedAnswerNames(answer.customText, context.competitors) ?? [])].filter(Boolean);
    return labels.length ? [labels.join("; ")] : [];
  }));
  const renderItem = (item: (typeof timeline)[number]) => {
        if (item.kind === "user" && item !== firstMessage && choiceEchoes.has(item.event.text.trim())) return null;
        if (item.kind === "user") {
          const first = item === firstMessage;
          const message = <div className="guided-user-turn">
            <span className="guided-user-label">You</span>
            <div className={first ? "guided-user-message guided-brief-message" : "guided-user-message"}><p>{item.event.text}</p></div>
          </div>;
          return first ? <div key={item.event.id} className="guided-brief-turn">{message}{briefEditor}</div>
            : <Fragment key={item.event.id}>{message}</Fragment>;
        }
        const output = guidedTurnResult(jobs, item.turn, account.userId, saved.id)?.reply;
        if (!output || output.kind === "accepted" || output.kind === "redirect") return item.turn.id === state?.turns[0]?.id ? <Fragment key={item.turn.id}>{legacyReplies}</Fragment> : null;
        const answer = state?.answers.find(answer => answer.turnId === item.turn.id);
        const current = choiceTurn?.id === item.turn.id && !answer;
        return <Fragment key={item.turn.id}>{item.turn.id === state?.turns[0]?.id && legacyReplies}<article id={`guided-turn-${item.turn.id}`} tabIndex={-1} className="guided-assistant-message flow-enter" aria-label="Embel response"><EmbelIdentity label={guidedStageLabel(item.turn.stage)} />
          <p className="guided-assistant-copy">{item.turn.stage === "personality" ? withoutScoreScaleNote(output.message) : output.message}</p>
          {output.kind === "choices" && output.stage === "slogan" ? <GuidedSloganWidget reply={output} brandName={context.selectedName ?? saved.title} disabled={blocked}
            answered={!current || Boolean(answer)} answer={answer ? answer.customText : undefined}
            onContinue={decision => void confirmSlogan(output, decision)} onSkip={() => void skipSlogan(output.turnId)}
            onMore={current ? () => void moreSlogans() : undefined} canMore={!requestBlocked && Boolean(guidedAllowance(availability, "strategy.reformulate"))}
            onRevisit={!current ? () => void revisit("slogan", item.turn.userMessageId) : undefined} />
          : output.kind === "choices" ? <GuidedChoiceWidget projectId={saved.id} reply={output} selectedIds={answer?.optionIds ?? selectedCompetitors(output)} additionalControls={current && output.stage === "competitors" ? <CompetitorWidgetControls draft={competitorDraft} onDraft={value => changeInput(previous => ({ ...previous, competitorDraft: value }))} onAdd={() => addCompetitor(output)} onMore={() => void moreCompetitors(output)} disabled={Boolean(blocked)} canGenerate={!requestBlocked && Boolean(guidedAllowance(availability, "strategy.competitors"))} generating={active} /> : undefined} retainedOptions={current && output.stage === "competitors" ? retainedOptions(output) : undefined} onSelectionChange={ids => setSelection({ turnId: output.turnId, ids })} onContinue={() => void confirm(output)} disabled={blocked} answered={!current || Boolean(answer)} additionalAnswer={answer?.customText} retainedAnswerLabels={output.stage === "competitors" ? retainedAnswerNames(answer?.customText, context.competitors) : undefined} onRevisit={!current ? () => void revisit(item.turn.stage, item.turn.userMessageId) : undefined} />
            : output.kind === "question" ? <p className="guided-assistant-question">{output.question}</p> : null}
        </article></Fragment>;
      };
  // Once Positioning is chosen, Strategy collapses into one summary card;
  // Edit strategy shows its answers again. The slogan follows the name.
  const strategyAnswer = state?.answers.find(answer => answer.stage === "positioning");
  const voiceStart = timeline.findIndex(item => item.kind === "turn" && (item.turn.stage === "personality" || item.turn.stage === "slogan"));
  const sloganStart = timeline.findIndex(item => item.kind === "turn" && item.turn.stage === "slogan");
  const beforeVoice = voiceStart < 0 ? timeline : timeline.slice(0, voiceStart);
  const voiceItems = voiceStart < 0 ? [] : timeline.slice(voiceStart, sloganStart < 0 ? undefined : sloganStart);
  const sloganItems = sloganStart < 0 ? [] : timeline.slice(sloganStart);
  const positioningTurn = strategyAnswer ? state?.turns.find(turn => turn.id === strategyAnswer.turnId) : undefined;
  const positioningReply = positioningTurn ? guidedTurnResult(jobs, positioningTurn, account.userId, saved.id)?.reply : null;
  const positioningChoice = positioningReply?.kind === "choices" ? positioningReply.options.find(option => strategyAnswer?.optionIds.includes(option.id)) : undefined;
  const strategySummary = strategyAnswer ? <StrategySummary projectId={saved.id} context={context}
    angle={positioningChoice?.stage === "positioning" ? positioningChoice.payload.angle : null}
    expanded={strategyExpanded} onToggle={() => setStrategyExpanded(value => !value)} /> : null;
  const strategyHistory = <>
    {!firstMessage && briefEditor}
    {(strategyAnswer && !strategyExpanded ? beforeVoice.filter(item => item === firstMessage) : beforeVoice.slice(0, 1)).map(renderItem)}
    {strategySummary}
    {(strategyAnswer && !strategyExpanded ? [] : beforeVoice.slice(1)).map(renderItem)}
  </>;
  const voiceHistory = voiceItems.map(renderItem);
  const sloganHistory = sloganItems.map(renderItem);
  const canvasActive = namingOpen && namingCanvas;
  const completed = null;

  // The conversation holds Strategy, then Voice from the first personality
  // question on, then Identity (Inspiration) as soon as Voice is finished: the
  // slogan answered or skipped. The project bar highlights the one on screen.
  const voiceShown = reached === "voice" || voiceItems.length > 0 || sloganItems.length > 0 || nameChosen;
  const identityShown = state?.stage === "complete" && nameChosen && saved.scope === "complete_brand";
  // Logo and Creative direction follow Inspiration in the same Identity section,
  // each after the previous step's Continue, when the project has already reached
  // it (its next step is that step or a later one), or when a link points at it.
  const progress = useProjectProgress(), projectBase = `/brands/account/${saved.id}`;
  const nextPath = progress?.projectId === saved.id ? progress.nextHref?.split(/[?#]/, 1)[0] : undefined;
  const logoReached = Boolean(nextPath?.startsWith(`${projectBase}/logo`));
  const directionsReached = Boolean(nextPath?.startsWith(`${projectBase}/logo/directions`) || nextPath?.startsWith(`${projectBase}/logo/deliverables`));
  const [logoOpened, setLogoOpened] = useState(false), [directionsOpened, setDirectionsOpened] = useState(false);
  // A redirect from an old step page commits its `#journey-…` address with this
  // page's first render; the store reads it again right after that render.
  const hash = useSyncExternalStore(subscribeToHash, readHash, noHash);
  const logoLinked = hash === "#journey-logo", directionsLinked = hash === "#journey-directions";
  // Shown once the earlier replies have loaded: their images change the page
  // height, and replies that arrive after that would be announced as new.
  const logoShown = identityShown && historyChecked && (logoOpened || logoLinked || directionsLinked || logoReached);
  const directionsShown = logoShown && (directionsOpened || directionsLinked || directionsReached);
  const [viewed, setViewed] = useState<JourneyStepId | null>(null);
  // Right after showing a step, its scroll position stands until the reader scrolls.
  const jumped = useRef<number | null>(null);
  const sections: JourneyStepId[] = canvasActive ? [] : identityShown ? ["strategy", "voice", "identity"] : voiceShown ? ["strategy", "voice"] : ["strategy"];
  useConversationSteps(reached, viewed, sections);
  // The latest section whose top has reached the middle of the view (or the
  // last one at the very end) is the step on screen.
  function sectionOnScreen(area: HTMLElement): JourneyStepId {
    const atEnd = area.scrollHeight - area.clientHeight - area.scrollTop <= 8;
    const top = area.getBoundingClientRect().top;
    let current: JourneyStepId = "strategy";
    for (const step of ["voice", "identity"] as const) {
      const section = document.getElementById(journeySectionId(step));
      if (!section || !area.contains(section)) break;
      if (atEnd || section.getBoundingClientRect().top - top <= area.clientHeight / 2) current = step; else break;
    }
    return current;
  }
  function scrolled() {
    onScroll();
    const area = transcript.current;
    if (!area) return;
    if (jumped.current !== null && Math.abs(area.scrollTop - jumped.current) < 2) return;
    jumped.current = null;
    setViewed(sectionOnScreen(area));
  }
  const logoAnchor = useRef<HTMLDivElement>(null), directionsAnchor = useRef<HTMLDivElement>(null);
  const requestLogo = useStepReveal(logoAnchor, logoShown, logoLinked, transcript, jumpTo);
  const requestDirections = useStepReveal(directionsAnchor, directionsShown, directionsLinked, transcript, jumpTo);
  const showSection = useEffectEvent((step: JourneyStepId) => {
    const area = transcript.current, section = document.getElementById(journeySectionId(step));
    if (!area || !section || !area.contains(section)) return;
    jumpTo(section);
    jumped.current = area.scrollTop;
    setViewed(step);
    section.focus({ preventScroll: true });
  });
  useEffect(() => {
    const area = transcript.current;
    if (!area) return;
    const listener = (event: Event) => { const step = (event as CustomEvent<unknown>).detail; if (step === "strategy" || step === "voice" || step === "identity") showSection(step); };
    area.addEventListener(JOURNEY_SECTION_EVENT, listener);
    return () => area.removeEventListener(JOURNEY_SECTION_EVENT, listener);
  }, [transcript]);
  // A `#journey-strategy` or `#journey-voice` link opens at that step once the
  // saved conversation has loaded; without one, the latest response is shown.
  const linkedSection = useRef<JourneyStepId | null | undefined>(undefined);
  useLayoutEffect(() => {
    if (linkedSection.current === undefined) linkedSection.current = journeySectionOfHash(window.location.hash);
    const step = linkedSection.current;
    if (!step || !historyChecked) return;
    linkedSection.current = null;
    showSection(step);
  }, [historyChecked, voiceShown]);

  const runningJob = bound && strategyJobActive(bound.job) ? bound.job : null;
  const stop = runningJob ? () => void strategy.cancel(runningJob) : undefined;
  const stopping = bound?.job.state === "cancel_requested";
  const researching = currentTurn?.stage === "competitors" && currentTurn.purpose === "research" && Boolean(runningJob || strategy.pending && !bound);
  const thinkingLabel = active ? runningJob ? runningJob.state === "queued" ? "Request queued…" : "Thinking…" : "A request is in progress…"
    : strategy.pending ? currentTurn?.purpose === "research" ? "Starting research…" : "Starting response…" : "Checking research status…";
  const hasComposer = saved.scope === "complete_brand" || Boolean(state);
  const notices = <div className="conversation-compose-notices" role="region" aria-label="Conversation notices" tabIndex={0}>
    {workerDelayed && <div className="guided-delivery-notice" role="status">
      <p>Your request is still queued. The worker will pick it up when available.</p>
      <button type="button" className="text-link" disabled={busy || working || strategy.pending} onClick={strategy.refresh}>Check status</button>
    </div>}
    {deliveryPending && <div className="guided-delivery-notice" role="status">
      <p>Your request is saved, but delivery to the worker is not confirmed. Retry delivery sends the same request, not a new research request.</p>
      <div className="guided-delivery-actions" role="group" aria-label="Delivery recovery">
        <button type="button" className="text-link" disabled={busy || working || strategy.pending} onClick={strategy.refresh}>Check status</button>
        <button type="button" className="text-link" disabled={busy || working || strategy.pending || dirty || workspace.conflict || Boolean(strategy.readError)} onClick={() => void strategy.retryDelivery(bound.job)}>Retry delivery</button>
      </div>
    </div>}
    {(error || strategy.actionError || strategy.readError || failed || unverified || unavailable || stale) && <div className="guided-conversation-error" role="alert">
      <p>{error || strategy.actionError || statusReadError || (stale ? "The project changed after this response was requested. Your conversation is kept. Send a new message to continue from the current version." : bound?.job.state === "needs_reconciliation" ? "This research outcome needs verification before another request can start. Your prompt is saved." : requestBlocked ? strategyAvailabilityMessage(availability, "project") : failed ? bound?.job.state === "cancelled" ? "Research was cancelled. Your prompt is saved." : currentTurn?.stage === "competitors" && currentTurn.purpose !== "message" ? "Research could not produce verified suggestions. Your prompt is saved. You can retry research." : "This response did not finish. Your prompt is saved." : unverified ? "This response could not be matched to your question. Your conversation is kept." : strategyAvailabilityMessage(availability ?? null, "project"))}</p>
      <button type="button" className="text-link" disabled={busy || working || strategy.pending} onClick={strategy.refresh}>Check status</button>
      {currentTurn && !stale && !requestBlocked && (!bound || bound.job.state === "failed" || bound.job.state === "cancelled") && <button type="button" className="text-link" disabled={blocked} onClick={() => void retry()}>{currentTurn.stage === "competitors" && currentTurn.purpose !== "message" ? "Retry research" : "Retry request"}</button>}
    </div>}
    {busy && <p role="status">{storage.saveLabel}</p>}
    {!busy && storage.actions}
    {storage.resultNavigation}
    </div>;

  const canStartResearch = Boolean(strategy.overview && !strategy.readError && guidedAllowance(availability, "strategy.competitors"));
  const indicator = (active || checkingResearch) && (researching
    ? <article className="guided-assistant-message flow-enter" aria-label="Embel response"><EmbelIdentity label={guidedStageLabel("competitors")} />
      <ProgressCard title={stopping ? "Cancelling research…" : "Researching your competitors"} description={runningJob?.state === "queued" || !runningJob ? "Starting your research. Relevant brands and their sources appear here." : "Finding relevant brands and the sources behind them."}
        note="Your idea is saved. Suggestions appear here when they’re ready." onStop={stop} stopping={stopping} stopDisabled={strategy.pending} stopLabel="Cancel research" />
    </article>
    : <GuidedThinking label={thinkingLabel} onStop={stop} stopping={stopping} stopDisabled={strategy.pending} />);

  return <><div className="guided-interview" data-composer={hasComposer ? "floating" : undefined} hidden={canvasActive} aria-label="Brand conversation">
    <div ref={transcript} id={transcriptId} onScroll={scrolled} tabIndex={0} className="guided-interview-scroll" role="log" aria-label="Conversation" aria-live="polite"
      data-naming-results-scroll={namingOpen ? "" : undefined}>
      <section id={journeySectionId("strategy")} className="guided-journey-section" data-journey-section="strategy" aria-label="Strategy" tabIndex={-1}>
        {!canvasActive && strategyHistory}
        {!state?.turns.length && legacyReplies}
        {!state && saved.scope === "complete_brand" && <article className="guided-assistant-message flow-enter" aria-label="Start research">
          <EmbelIdentity label={guidedStageLabel("competitors")} />
          <p className="guided-assistant-copy">Your brief is saved. Next, I’ll find the brands you compete with, so you can choose the ones to compare against.</p>
          <div className="guided-next-step"><button type="button" className="button primary" disabled={blocked || !canStartResearch} onClick={() => void startResearch()}>{working ? "Starting research…" : "Start research"}</button></div>
        </article>}
        {!state && saved.scope !== "complete_brand" && <p className="guided-assistant-copy">{saved.context.description}</p>}
        {!voiceShown && indicator}
      </section>
      {voiceShown && <section id={journeySectionId("voice")} className="guided-journey-section" data-journey-section="voice" aria-label="Voice" tabIndex={-1}>
        {!canvasActive && voiceHistory}
        {indicator}
        {!canvasActive && completed}
        <div ref={setNamingMessages} className="guided-naming-messages" />
        <div ref={setNamingResults} className="guided-naming-results" />
        {!canvasActive && nameChosen && !namingReopened && <article className="guided-assistant-message flow-enter" aria-label="Your name">
          <EmbelIdentity label={journeyPartLabel("voice", "Name")} />
          <section className="guided-choice-answer" aria-label="Your answer: Which name feels right?">
            <div className="guided-choice-answer-copy"><h3>Which name feels right?</h3><ul aria-label="Your answer"><li><span>{context.selectedName}</span></li></ul></div>
            <button className="button secondary small" type="button" disabled={blocked} onClick={() => { setNamingReopened(true); setReopenedFor(context.selectedName ?? ""); }}>Change name</button>
          </section>
        </article>}
        {!canvasActive && sloganHistory}
      </section>}
      {!canvasActive && identityShown && <section id={journeySectionId("identity")} className="guided-journey-section flow-enter" data-journey-section="identity" aria-label="Identity" tabIndex={-1}>
        <InspirationWorkspace projectId={saved.id} variant="conversation" continueHidden={logoShown}
          onContinue={() => { requestLogo(); setLogoOpened(true); }}
          lead={`Your voice is set. Now let’s shape how ${context.selectedName} looks. Like the brands you’re drawn to: a whole brand, or just its logo, colors, typefaces, socials or visuals. Your likes guide the logo concepts.`} />
        {logoShown && <div ref={logoAnchor} id="journey-logo" className="logo-in-conversation flow-enter" tabIndex={-1}>
          <LogoCreationWorkspace projectId={saved.id} continueHidden={directionsShown}
            onContinue={() => { requestDirections(); setDirectionsOpened(true); }} />
        </div>}
        {directionsShown && <div ref={directionsAnchor} id="journey-directions" className="directions-in-conversation flow-enter" tabIndex={-1}>
          <VisualDirectionsPage projectId={saved.id} variant="conversation" />
        </div>}
      </section>}
      {!hasComposer && notices}
    </div>
    {hasComposer && <FloatingComposer label={namingOpen ? "Naming composer" : "Strategy composer"}>
      <div ref={setNamingComposer} className="guided-floating-input">
        {hasNewResponse && <div className="guided-new-response flow-enter"><button type="button" className="button secondary small" aria-controls={transcriptId} onClick={revealNewResponse}>View new response<span aria-hidden="true"> ↓</span></button></div>}
        {notices}
        {(!namingOpen || !namingQuestionId) && <ConversationComposer project value={prompt} onChange={setPrompt} onSend={() => void send()} label="Message Embel" placeholder="Reply in your own words, or ask a question…" disabled={namingOpen || blocked || !prompt.trim()} readOnly={namingOpen || pending} hint={null} sendLabel="Send prompt" />}
      </div>
    </FloatingComposer>}
  </div>
    {namingOpen && <ProjectNamingWorkspace projectId={saved.id}
      inline={{ messages: namingMessages, results: namingResults, composer: namingComposer, onQuestion: setNamingQuestionId, onCanvas: setNamingCanvas, onNameConfirmed: closeNaming }} />}
  </>;
}
