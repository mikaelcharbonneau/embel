"use client";

import { Fragment, useEffect, useEffectEvent, useId, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { AccountBriefEditor } from "./account-brief-editor";
import { ProjectNamingWorkspace } from "@/components/naming/project-naming-workspace";
import { getNamingReadiness } from "@/domain/project-naming";
import { appendGuidedTurn, confirmGuidedSelection, guidedTurnOperation, revisitGuidedStage, type GuidedReply, type GuidedStage } from "@/domain/guided-interview";
import { competitorSchema, contextSnapshotSchema, type ContextSnapshot } from "@/domain/projects";
import { CompetitorWidgetControls } from "./competitor-widget-controls";
import { EmbelIdentity, guidedStageLabel } from "./embel-identity";
import { useConversationStep } from "@/components/journey/project-header";
import { accountDraftChanged, type AccountWorkspace, type GuidedInterviewInput } from "./account-draft-memory";
import { strategyAvailabilityMessage, strategyCanRetryDelivery, strategyJobActive } from "./account-strategy-client";
import type { VerifiedAccount } from "./account-session";
import { ConversationComposer } from "./conversation-composer";
import { FloatingComposer } from "./floating-composer";
import { GuidedChoiceWidget } from "./guided-interview-widgets";
import { GuidedThinking } from "./guided-thinking";
import { guidedAllowance, guidedMessageContext, guidedTimeline, guidedTurnResult, nextGuidedProposal, recordGuidedChoice, retainedAnswerNames } from "./guided-interview-client";
import type { ProjectEditorForm } from "./project-editor";
import { useStrategyJobs } from "./use-strategy-jobs";
import { useConversationFollow } from "./use-conversation-follow";
import "@/styles/conversation.css";

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
  const [working, setWorking] = useState(false);
  const [briefOpen, setBriefOpen] = useState(false);
  const [briefFromNaming, setBriefFromNaming] = useState(false);
  const [namingMessages, setNamingMessages] = useState<HTMLDivElement | null>(null);
  const [namingComposer, setNamingComposer] = useState<HTMLDivElement | null>(null);
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
    if (reply?.kind === "answer" && ["competitors", "audience", "personality"].every(stage => state?.answers.some(answer => answer.stage === stage))) {
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
  // Report a genuine failed write to the external admission-recovery receipt.
  // eslint-disable-next-line react-hooks/set-state-in-effect
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
    try {
      const next = contextSnapshotSchema.parse({ ...saved.context, competitors: [...saved.context.competitors, parsed.data] });
      const result = await persist(next, { competitorDraft: draft });
      if (!result || !mounted.current) return false;
      changeInput(previous => ({ ...previous, competitorDraft: JSON.stringify(previous.competitorDraft) === JSON.stringify(draft) ? undefined : previous.competitorDraft, selection: { turnId: answer.turnId, ids: [...selected, parsed.data.id] } }));
      return true;
    } catch { if (mounted.current) setError("The competitor could not be confirmed as saved. Your entry is kept; check the saved project before retrying."); return false; }
    finally { lock.current = false; if (mounted.current) setWorking(false); }
  }
  async function moreCompetitors(answer: Extract<GuidedReply, { kind: "choices" }>) {
    if (lock.current || blocked || requestBlocked || answer.stage !== "competitors" || !guidedAllowance(availability, "strategy.competitors")) return;
    lock.current = true; setWorking(true); setError(null);
    try {
      const ids = selectedCompetitors(answer), rows = new Map(saved.context.competitors.map(item => [item.name.trim().toLowerCase(), { ...item, selected: ids.includes(item.id) }]));
      for (const option of answer.options) if (option.stage === "competitors") {
        const key = option.payload.name.trim().toLowerCase();
        if (!rows.has(key)) rows.set(key, { ...option.payload, selected: ids.includes(option.id) });
        else if (ids.includes(option.id)) rows.set(key, { ...rows.get(key)!, selected: true });
      }
      const retained = contextSnapshotSchema.parse({ ...saved.context, competitors: [...rows.values()] });
      const next = guidedMessageContext(retained, "Suggest more relevant competitors, different from the competitors already saved in this project. Keep my existing selections.", saved.current_revision + 1);
      next.intake.guidedInterview!.turns.at(-1)!.purpose = "research";
      const result = await persist(next);
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
  const namingReady = state?.stage === "complete" && !dirty && !workspace.conflict && !busy && !workspace.pendingGuidedContext && saved.scope === "complete_brand" && getNamingReadiness(saved.context, saved.scope).ready;
  // On a cold reopen, let the saved Strategy cards take their place before
  // positioning the first Naming question. A failed history read keeps its retry.
  const historyChecked = Boolean(strategy.overview || strategy.readError);
  const showNaming = (briefOpen ? briefFromNaming : namingReady) && historyChecked;
  useConversationStep(showNaming ? "voice" : "strategy");
  // Once Strategy is complete its saved replies are history. They can load
  // after the Naming checkpoint and must not take the reader to an old turn.
  const responseIds = showNaming ? (namingQuestionId && !namingCanvas ? [namingQuestionId] : []) : [
    ...legacyJobs.flatMap(job => job.results.map(result => `guided-result-${job.id}-${result.stepKey}`)),
    ...timeline.flatMap(item => {
      if (item.kind !== "turn") return [];
      const output = guidedTurnResult(jobs, item.turn, account.userId, saved.id)?.reply;
      return output && output.kind !== "accepted" && output.kind !== "redirect" ? [`guided-turn-${item.turn.id}`] : [];
    }),
  ];
  const { transcript, onScroll, hasNewResponse, revealNewResponse } = useConversationFollow({
    conversationKey: `${account.userId}:${account.generation}:${saved.id}`,
    contentKey: JSON.stringify([timeline.map(item => item.kind === "user" ? item.event.id : item.turn.id), state?.answers.map(answer => answer.turnId), Boolean(active || checkingResearch), state?.stage, showNaming]),
    responseIds,
  });
  const legacyReplies = legacyJobs.map(job => <Fragment key={job.id}>{job.results.map(result => <article key={result.stepKey} id={`guided-result-${job.id}-${result.stepKey}`} tabIndex={-1} className="guided-assistant-message flow-enter" aria-label="Earlier Embel response"><EmbelIdentity /><p className="guided-assistant-copy">{result.output.proposal.message}</p></article>)}</Fragment>);

  const briefEditor = <AccountBriefEditor workspace={workspace} open={briefOpen} onOpen={() => { setBriefFromNaming(Boolean(namingReady)); setBriefOpen(true); }} onClose={() => setBriefOpen(false)} readOnly={Boolean(pending || workspace.conflict || workspace.pendingDraftSave || workspace.pendingGuidedContext)} saveLabel={storage.saveLabel} onUpdate={storage.onUpdate} navigation={navigation} />;
  const firstMessage = timeline.find(item => item.kind === "user");
  const conversationHistory = timeline.map(item => {
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
          <p className="guided-assistant-copy">{output.message}</p>
          {output.kind === "choices" ? <GuidedChoiceWidget reply={output} selectedIds={answer?.optionIds ?? selectedCompetitors(output)} additionalControls={current && output.stage === "competitors" ? <CompetitorWidgetControls draft={competitorDraft} onDraft={value => changeInput(previous => ({ ...previous, competitorDraft: value }))} onAdd={() => addCompetitor(output)} onMore={() => void moreCompetitors(output)} disabled={Boolean(blocked)} canGenerate={!requestBlocked && Boolean(guidedAllowance(availability, "strategy.competitors"))} generating={active} /> : undefined} retainedOptions={current && output.stage === "competitors" ? retainedOptions(output) : undefined} onSelectionChange={ids => setSelection({ turnId: output.turnId, ids })} onContinue={() => void confirm(output)} disabled={blocked} answered={!current || Boolean(answer)} additionalAnswer={answer?.customText} retainedAnswerLabels={output.stage === "competitors" ? retainedAnswerNames(answer?.customText, context.competitors) : undefined} onRevisit={!current ? () => void revisit(item.turn.stage, item.turn.userMessageId) : undefined} />
            : output.kind === "question" ? <p className="guided-assistant-question">{output.question}</p> : null}
        </article></Fragment>;
      });
  const canvasActive = showNaming && namingCanvas;
  const history = <>{!firstMessage && briefEditor}{conversationHistory}</>;
  const completed = !dirty && !workspace.conflict && state?.answers.length === 3 && context.competitorReviewComplete
    && context.intake.audienceReviewedAt && context.intake.personalityReviewedAt
    ? <p className="guided-complete" role="status">Your brand strategy is saved. You can revisit any answer above.</p> : null;

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

  return <><div className="guided-interview" data-composer={hasComposer ? "floating" : undefined} hidden={canvasActive} aria-label="Brand conversation">
    <div ref={transcript} id={transcriptId} onScroll={onScroll} tabIndex={0} className="guided-interview-scroll" role="log" aria-label="Conversation" aria-live="polite">
      {!canvasActive && history}
      {!state?.turns.length && legacyReplies}
      {!state && saved.scope === "complete_brand" && <div className="guided-interview-start"><p>Your brief is saved. Send a message below to begin competitor research when AI is available.</p></div>}
      {!state && saved.scope !== "complete_brand" && <p className="guided-assistant-copy">{saved.context.description}</p>}
      {(active || checkingResearch) && <GuidedThinking label={active ? bound && strategyJobActive(bound.job) ? bound.job.state === "queued" ? "Request queued…" : currentTurn?.stage === "competitors" && currentTurn.purpose === "research" ? "Researching competitors…" : "Thinking…" : "A request is in progress…" : strategy.pending ? currentTurn?.purpose === "research" ? "Starting research…" : "Starting response…" : "Checking research status…"} onStop={bound && strategyJobActive(bound.job) ? () => void strategy.cancel(bound.job) : undefined} stopping={bound?.job.state === "cancel_requested"} stopDisabled={strategy.pending} />}
      {!canvasActive && completed}
      {!hasComposer && notices}
      <div ref={setNamingMessages} className="guided-naming-messages" />
    </div>
    {hasComposer && <FloatingComposer label={showNaming ? "Naming composer" : "Strategy composer"}>
      <div ref={setNamingComposer} className="guided-floating-input">
        {hasNewResponse && <div className="guided-new-response flow-enter"><button type="button" className="button secondary small" aria-controls={transcriptId} onClick={revealNewResponse}>View new response<span aria-hidden="true"> ↓</span></button></div>}
        {notices}
        {(!showNaming || !namingQuestionId) && <ConversationComposer project value={prompt} onChange={setPrompt} onSend={() => void send()} label="Message Embel" placeholder="Reply in your own words, or ask a question…" disabled={showNaming || blocked || !prompt.trim()} readOnly={showNaming || pending} hint={null} sendLabel="Send prompt" />}
      </div>
    </FloatingComposer>}
  </div>
    {showNaming && <ProjectNamingWorkspace projectId={saved.id}
      conversationHistory={<>{history}{completed}</>}
      inline={{ messages: namingMessages, composer: namingComposer, onQuestion: setNamingQuestionId, onCanvas: setNamingCanvas }} />}
  </>;
}
