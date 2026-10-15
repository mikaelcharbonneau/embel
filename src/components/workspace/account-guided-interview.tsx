"use client";

import { Fragment, useEffect, useEffectEvent, useRef, useState, type ComponentProps } from "react";
import { ProjectArtwork } from "@/components/ui/project-artwork";
import { appendGuidedTurn, confirmGuidedSelection, guidedTurnOperation, revisitGuidedStage, type GuidedReply, type GuidedStage } from "@/domain/guided-interview";
import type { ContextSnapshot } from "@/domain/projects";
import { accountDraftChanged, type AccountWorkspace } from "./account-draft-memory";
import { strategyAvailabilityMessage, strategyJobActive } from "./account-strategy-client";
import type { VerifiedAccount } from "./account-session";
import { ConversationComposer } from "./conversation-composer";
import { GuidedChoiceWidget, ResearchLoadingScreen } from "./guided-interview-widgets";
import { guidedAllowance, guidedMessageContext, guidedTimeline, guidedTurnResult, initialGuidedContext, nextGuidedProposal, recordGuidedChoice } from "./guided-interview-client";
import type { ProjectEditorForm } from "./project-editor";
import { useStrategyJobs } from "./use-strategy-jobs";
import "@/styles/conversation.css";

export function AccountGuidedInterview({ account, workspace, busy, saveContext, storage }: {
  account: VerifiedAccount; workspace: AccountWorkspace; busy: boolean;
  saveContext: (context: ContextSnapshot) => Promise<AccountWorkspace | null>;
  storage: ComponentProps<typeof ProjectEditorForm>["storage"];
}) {
  const strategy = useStrategyJobs({ account, workspace, blocked: busy, guided: true });
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<{ turnId: string; ids: string[] } | null>(null);
  const [working, setWorking] = useState(false);
  const lock = useRef(false), mounted = useRef(false);
  const attempts = useRef(new Set<string>());
  const transcript = useRef<HTMLDivElement>(null);
  const saved = workspace.saved;
  const context = workspace.pendingGuidedContext ?? saved.context;
  const state = context.intake.guidedInterview;
  const turn = state?.turns.at(-1);
  const jobs = strategy.overview?.jobs ?? [];
  const availability = strategy.readError ? null : strategy.overview?.availability;
  const bound = turn ? guidedTurnResult(jobs, turn, account.userId, saved.id) : null;
  const reply = bound?.reply ?? null;
  const active = jobs.some(strategyJobActive);
  const pending = Boolean(busy || working || strategy.pending || active);
  const dirty = accountDraftChanged(workspace);
  const blocked = pending || dirty || workspace.conflict;
  const currentTurn = turn && state?.stage === turn.stage && !state.answers.some(answer => answer.turnId === turn.id) ? turn : null;
  const operation = currentTurn ? guidedTurnOperation(currentTurn) : null;
  const allowance = operation ? guidedAllowance(availability, operation) : null;
  const choiceTurn = state?.stage !== "complete" ? [...(state?.turns ?? [])].reverse().find(item => item.stage === state?.stage && guidedTurnResult(jobs, item, account.userId, saved.id)?.reply?.kind === "choices") : null;
  const completedJobs = jobs.filter(job => job.state === "succeeded").length;

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { transcript.current?.scrollTo?.({ top: transcript.current.scrollHeight, behavior: "instant" }); }, [state?.turns.length]);
  const revealReply = useEffectEvent(() => {
    const area = transcript.current;
    if (!area) return;
    const message = turn ? document.getElementById(`guided-turn-${turn.id}`) : null;
    const top = message ? area.scrollTop + message.getBoundingClientRect().top - area.getBoundingClientRect().top - 24 : area.scrollHeight;
    area.scrollTo?.({ top: Math.max(0, top), behavior: "instant" });
  });
  useEffect(() => { revealReply(); }, [completedJobs]);

  async function persist(next: ContextSnapshot) {
    const result = await saveContext(next);
    if (!result && mounted.current) setError("Your answer is kept in this tab, but saving was not confirmed. Check the saved project before continuing.");
    return result;
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
    attempts.current.add(key);
    await strategy.enqueue(guidedTurnOperation(currentTurn), saved.current_revision, allowance);
  });
  useEffect(() => { void coordinate(); }, [saved.current_revision, state, bound, reply, busy, strategy.pending, strategy.overview, strategy.readError, active, dirty, allowance, currentTurn]);

  async function startResearch() {
    if (lock.current || blocked) return;
    lock.current = true; setWorking(true); setError(null);
    try { await persist(initialGuidedContext(saved.context, saved.current_revision + 1)); }
    catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : "Research could not be started."); }
    finally { lock.current = false; if (mounted.current) setWorking(false); }
  }

  async function send() {
    if (lock.current || blocked || !prompt.trim()) return;
    const intendedOperation = state?.turns.length ? "strategy.reformulate" : "strategy.competitors";
    if (!guidedAllowance(availability, intendedOperation)) { setError("AI replies are unavailable right now. Your prompt is kept. Please check availability and try again."); return; }
    lock.current = true; setWorking(true); setError(null);
    const text = prompt;
    try {
      const result = await persist(guidedMessageContext(saved.context, text, saved.current_revision + 1));
      if (result && mounted.current) setPrompt(current => current === text ? "" : current);
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : "Your message could not be saved. Your prompt is kept."); }
    finally { lock.current = false; if (mounted.current) setWorking(false); }
  }

  async function confirm(answer: Extract<GuidedReply, { kind: "choices" }>) {
    if (lock.current || blocked || choiceTurn?.id !== answer.turnId || state?.stage !== answer.stage) return;
    const ids = selection?.turnId === answer.turnId ? selection.ids : [];
    lock.current = true; setWorking(true); setError(null);
    try {
      const now = new Date().toISOString();
      let next = confirmGuidedSelection(saved.context, { turnId: answer.turnId, reply: answer, optionIds: ids, now });
      const chosen = recordGuidedChoice(next, answer, ids, now);
      next = nextGuidedProposal(chosen.context, saved.current_revision + 1, chosen.messageId);
      const result = await persist(next);
      if (result && mounted.current) setSelection(null);
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : "Your selection could not be saved."); }
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
    if (lock.current || blocked || !currentTurn) return;
    setError(null);
    if (!bound) {
      if (allowance) {
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

  const researchPending = currentTurn?.stage === "competitors" && currentTurn.purpose !== "message" && bound && strategyJobActive(bound.job);
  if (researchPending) return <div className="guided-interview-loading"><ResearchLoadingScreen cancelPending={bound.job.state === "cancel_requested" || strategy.pending} onCancel={() => void strategy.cancel(bound.job)} /><div className="guided-loading-recovery">{strategy.actionError && <p role="alert">{strategy.actionError}</p>}{strategy.readError && <><p role="alert">Research status could not be checked. Your prompt is saved.</p><button className="text-link" onClick={strategy.refresh}>Check status</button></>}</div></div>;
  if (currentTurn?.stage === "competitors" && currentTurn.purpose !== "message" && !strategy.readError && (!strategy.overview || (!bound && strategy.pending))) return <ResearchLoadingScreen message={strategy.overview ? "Starting your saved research request…" : "Checking your saved research request…"} />;

  const failed = bound && !strategyJobActive(bound.job) && !reply && bound.job.state !== "succeeded";
  const unverified = bound?.job.state === "succeeded" && !reply;
  const stale = currentTurn && !workspace.pendingGuidedContext && currentTurn.inputRevision !== saved.current_revision;
  const unavailable = currentTurn && !bound && strategy.overview && !allowance;
  const legacyJobs = [...jobs].filter(job => job.state === "succeeded" && !job.results.some(result => result.output.guidance)).sort((a, b) => a.created_at.localeCompare(b.created_at));
  const legacyReplies = legacyJobs.map(job => <Fragment key={job.id}>{job.results.map(result => <article key={result.stepKey} className="guided-assistant-message" aria-label="Earlier Embel response"><div className="guided-assistant-identity"><ProjectArtwork name="mark" /><span>Embel</span></div><p className="guided-assistant-copy">{result.output.proposal.message}</p></article>)}</Fragment>);

  return <div className="guided-interview" aria-label="Brand conversation">
    <div ref={transcript} className="guided-interview-scroll" role="log" aria-label="Conversation" aria-live="polite">
      {guidedTimeline(context).map(item => {
        if (item.kind === "user") return <div key={item.event.id} className="guided-user-message"><span className="sr-only">You</span><p>{item.event.text}</p></div>;
        const output = guidedTurnResult(jobs, item.turn, account.userId, saved.id)?.reply;
        if (!output || output.kind === "accepted" || output.kind === "redirect") return item.turn.id === state?.turns[0]?.id ? <Fragment key={item.turn.id}>{legacyReplies}</Fragment> : null;
        const answer = state?.answers.find(answer => answer.turnId === item.turn.id);
        const current = choiceTurn?.id === item.turn.id && !answer;
        return <Fragment key={item.turn.id}>{item.turn.id === state?.turns[0]?.id && legacyReplies}<article id={`guided-turn-${item.turn.id}`} className="guided-assistant-message"><div className="guided-assistant-identity"><ProjectArtwork name="mark" /><span>Embel</span></div>
          <p className="guided-assistant-copy">{output.message}</p>
          {output.kind === "choices" ? <GuidedChoiceWidget reply={output} selectedIds={answer?.optionIds ?? (selection?.turnId === output.turnId ? selection.ids : [])} onSelectionChange={ids => setSelection({ turnId: output.turnId, ids })} onContinue={() => void confirm(output)} disabled={blocked} answered={!current || Boolean(answer)} onRevisit={!current ? () => void revisit(item.turn.stage, item.turn.userMessageId) : undefined} />
            : output.kind === "question" ? <p className="guided-assistant-question">{output.question}</p> : null}
        </article></Fragment>;
      })}
      {!state?.turns.length && legacyReplies}
      {!state && <div className="guided-interview-start"><p>Let’s find the right points of comparison for your brand.</p><button type="button" className="button primary small" disabled={blocked || !guidedAllowance(availability, "strategy.competitors")} onClick={() => void startResearch()}>Start competitor research</button></div>}
      {active && <div className="guided-thinking" role="status"><ProjectArtwork name="mark" /><span>Thinking…</span>{bound && strategyJobActive(bound.job) && <button type="button" className="text-link" disabled={strategy.pending || bound.job.state === "cancel_requested"} onClick={() => void strategy.cancel(bound.job)}>Stop</button>}</div>}
      {state?.answers.length === 3 && context.competitorReviewComplete && context.intake.audienceReviewedAt && context.intake.personalityReviewedAt && <p className="guided-complete" role="status">Your brand strategy is saved. You can revisit any answer above.</p>}
    </div>
    <div className="guided-interview-compose">
      {(error || strategy.actionError || strategy.readError || failed || unverified || unavailable || stale) && <div className="guided-conversation-error" role="alert">
        <p>{error || strategy.actionError || strategy.readError || (stale ? "The project changed after this response was requested. Your conversation is kept. Send a new message to continue from the current version." : bound?.job.state === "needs_reconciliation" ? "This research outcome needs verification before another request can start. Your prompt is saved." : failed ? bound?.job.state === "cancelled" ? "Research was cancelled. Your prompt is saved." : currentTurn?.stage === "competitors" && currentTurn.purpose !== "message" ? "Research could not produce verified suggestions. Your prompt is saved. You can retry research." : "This response did not finish. Your prompt is saved." : unverified ? "This response could not be matched to your question. Your conversation is kept." : strategyAvailabilityMessage(availability ?? null, "project"))}</p>
        <button type="button" className="text-link" disabled={pending} onClick={strategy.refresh}>Check status</button>
        {currentTurn && !stale && (!bound || bound.job.state === "failed" || bound.job.state === "cancelled") && <button type="button" className="text-link" disabled={blocked} onClick={() => void retry()}>{currentTurn.stage === "competitors" && currentTurn.purpose !== "message" ? "Retry research" : "Retry request"}</button>}
      </div>}
      {!busy && (dirty || workspace.conflict || error) && storage.actions}
      <ConversationComposer project value={prompt} onChange={setPrompt} onSend={() => void send()} label="Message Embel" placeholder="Reply in your own words, or ask a question…" disabled={blocked || !prompt.trim()} readOnly={pending} hint={null} sendLabel="Send prompt" />
    </div>
  </div>;
}
