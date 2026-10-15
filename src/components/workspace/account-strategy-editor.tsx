"use client";

import type { ComponentProps } from "react";
import { ProjectArtwork } from "@/components/ui/project-artwork";
import type { ConversationWidget } from "@/domain/conversation";
import type { StrategyJob, StrategyJobResult, StrategyOperation } from "@/domain/strategy-jobs";
import type { VerifiedAccount } from "./account-session";
import { accountDraftChanged, type AccountWorkspace } from "./account-draft-memory";
import { ProjectEditorForm } from "./project-editor";
import type { LocalDraft } from "./local-drafts";
import { formatStrategyCap, promptStrategyPlan, readStrategyIntent, rememberStrategyPlan, strategyAllowance, strategyAllowanceLabel, strategyAllowanceWithin, strategyAvailabilityMessage, strategyIntentPlan, strategyJobActive, strategyLabels, strategyResultApplication } from "./account-strategy-client";
import { useStrategyJobs } from "./use-strategy-jobs";
import { strategyPartialMessage } from "./strategy-partial-message";
import { BrowserLocalDate } from "./browser-local-date";

const operationForWidget: Record<ConversationWidget, StrategyOperation> = {
  competitors: "strategy.competitors", audience: "strategy.audience", personality: "strategy.personality", positioning: "strategy.positioning",
};
const stateLabels: Record<StrategyJob["state"], string> = {
  queued: "queued", running: "in progress", partial: "in progress · partial result saved", cancel_requested: "cancellation requested",
  cancelled: "cancelled", succeeded: "complete", failed: "failed", needs_reconciliation: "needs status verification",
};
const requestLabels: Record<StrategyOperation, string> = {
  "strategy.reformulate": "Request response", "strategy.competitors": "Research competitors", "strategy.audience": "Propose audiences", "strategy.personality": "Propose personality", "strategy.positioning": "Propose positioning",
};

export function AccountStrategyEditor({ account, workspace, busy, saveDraft, storage }: {
  account: VerifiedAccount; workspace: AccountWorkspace; busy: boolean;
  saveDraft: (draft: LocalDraft) => Promise<AccountWorkspace | null>;
  storage: ComponentProps<typeof ProjectEditorForm>["storage"];
}) {
  const strategy = useStrategyJobs({ account, workspace, blocked: busy });
  const availability = strategy.readError ? null : strategy.overview?.availability ?? null;
  const plan = promptStrategyPlan(availability);
  const revision = workspace.saved.current_revision;
  const savedIntent = readStrategyIntent(account.userId, workspace.saved.id, revision);
  const retryPlan = savedIntent ? strategyIntentPlan(savedIntent) : plan;
  const dirty = accountDraftChanged(workspace);
  const jobs = strategy.overview?.jobs ?? [];
  const orderedJobs = [...jobs].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.input_revision - b.input_revision || a.operation.localeCompare(b.operation));
  const latestJob = orderedJobs.at(-1);
  const latestApplied = latestJob?.results.some(result => strategyResultApplication(latestJob, result.stepKey));
  const resultNavigation = latestJob && (!latestApplied || jobs.length > 1) && <div className="conversation-result-navigation"><span role="status">{strategyJobActive(latestJob) ? `AI request ${stateLabels[latestJob.state]}` : latestApplied ? "Response saved" : latestJob.state === "succeeded" ? "Your response is ready to review" : `${strategyLabels[latestJob.operation]} ${stateLabels[latestJob.state]}`}</span><button type="button" className="text-link" aria-label="View latest AI activity" onClick={() => { const heading = document.getElementById(`strategy-activity-${latestJob.id}`); heading?.focus(); heading?.scrollIntoView?.({ block: "start" }); }}>View response ↑</button></div>;
  const currentJobs = jobs.filter(job => job.input_revision === revision);
  const pending = Boolean(busy || strategy.pending);

  async function sendPrompt(nextDraft: LocalDraft) {
    if (!plan || pending || workspace.conflict) return;
    const saved = await saveDraft(nextDraft);
    if (!saved) return;
    rememberStrategyPlan({ ownerId: account.userId, projectId: saved.saved.id, revision: saved.saved.current_revision }, plan);
    await strategy.enqueue("strategy.reformulate", saved.saved.current_revision, plan.reformulation);
  }
  async function requestOperation(operation: StrategyOperation) {
    if (pending || workspace.conflict || availability?.status !== "available") return;
    const allowance = strategyAllowance(availability.operations.find(item => item.operation === operation));
    if (!allowance) return;
    const current = dirty ? await saveDraft(workspace.draft) : workspace;
    if (!current) return;
    await strategy.enqueue(operation, current.saved.current_revision, allowance);
  }
  async function retryPrompt() {
    if (pending || dirty || workspace.conflict || !plan) return;
    const intent = readStrategyIntent(account.userId, workspace.saved.id, revision);
    if (intent) {
      const accepted = strategyIntentPlan(intent);
      if (!strategyAllowanceWithin(plan.reformulation, accepted.reformulation)
        || (accepted.kind === "response_and_competitors" && (plan.kind !== "response_and_competitors" || !strategyAllowanceWithin(plan.competitors, accepted.competitors)))) { strategy.report("The model, connection, or request limits changed. Send a new message to use the current selection."); return; }
      await strategy.enqueue("strategy.reformulate", revision, accepted.reformulation);
    } else {
      rememberStrategyPlan({ ownerId: account.userId, projectId: workspace.saved.id, revision }, plan);
      await strategy.enqueue("strategy.reformulate", revision, plan.reformulation);
    }
  }

  const strategyActions: NonNullable<ComponentProps<typeof ProjectEditorForm>["storage"]["strategyActions"]> = {};
  if (availability?.status === "available") {
    for (const [widget, operation] of Object.entries(operationForWidget) as [ConversationWidget, StrategyOperation][]) {
      const allowance = strategyAllowance(availability.operations.find(item => item.operation === operation));
      if (allowance) strategyActions[widget] = { label: requestLabels[operation], maximumCostLabel: `${strategyAllowanceLabel(allowance)}${dirty ? " · saves current edits" : ""}`, disabled: workspace.conflict || currentJobs.some(job => job.operation === operation) };
    }
  }
  const promptNotice = <div className="strategy-composer-notice"><p>{plan
    ? plan.billingMode === "chatgpt_subscription"
      ? "Sending uses your ChatGPT plan for a response and saves your message to this account. Competitor research starts after you apply the response. Your plan limits apply."
      : plan.kind === "response_only"
        ? `Sending uses OpenAI for a response, up to ${formatStrategyCap(plan.reformulation.maximumCostMicrousd)}, and saves your message to this account. Competitor research is unavailable.`
      : `Sending uses OpenAI for a response and competitor research, up to ${formatStrategyCap(plan.reformulation.maximumCostMicrousd + plan.competitors.maximumCostMicrousd)} total, and saves your message to this account. Competitor research starts after you apply the response.`
    : strategy.overview || strategy.readError
      ? strategyAvailabilityMessage(availability, "project")
      : "Checking AI availability…"}</p>{!plan && (strategy.overview || strategy.readError) && <button type="button" className="text-link" disabled={pending} onClick={strategy.refresh}>Recheck AI availability</button>}</div>;
  const transcript = <div className="account-strategy-transcript" aria-label="OpenAI strategy activity">
    {strategy.readError && <p className="form-error" role="alert">{strategy.readError}</p>}
    {strategy.actionError && <p className="form-error" role="alert">{strategy.actionError}</p>}
    {strategy.pending && <p className="field-hint" role="status">{strategy.pendingLabel}</p>}
    {jobs.length > 0 && <div className="account-strategy-results">{orderedJobs.map(job => {
      const applied = job.results.map(result => strategyResultApplication(job, result.stepKey)).find(Boolean);
      const partialText = !job.results.length && "partialText" in job && typeof job.partialText === "string" ? job.partialText : "";
      const partialMessage = partialText ? strategyPartialMessage(partialText) : null;
      return <article key={job.id} className="strategy-assistant-message" aria-label={`${strategyLabels[job.operation]} activity`}>
      <div className="strategy-assistant-heading"><ProjectArtwork name="mark" /><h2 id={`strategy-activity-${job.id}`} tabIndex={-1} aria-label={`${strategyLabels[job.operation]} ${stateLabels[job.state]}`}>Embel</h2>{job.state !== "succeeded" && <span className="strategy-response-state">{strategyLabels[job.operation]} {stateLabels[job.state]}</span>}</div>
      <div className="strategy-assistant-body">
        {!applied && job.input_revision !== revision && <p className="field-hint">Earlier version · {job.input_revision}</p>}
        {strategyJobActive(job) && <p className="field-hint" role="status">{job.state === "queued" ? ("dispatchState" in job && job.dispatchState === "dispatch_pending" ? "Request saved. Waiting for dispatch confirmation." : "Request saved. Waiting to start.") : job.state === "cancel_requested" ? "Cancellation is requested. Completed work may still arrive." : "OpenAI is processing this saved version."} {job.billingMode === "chatgpt_subscription" ? "Uses your ChatGPT plan. Your plan limits apply." : `Reserved limit: ${formatStrategyCap(job.reserved_cost_microusd)}.`}</p>}
        {partialText && <div className="account-strategy-result" aria-label="Incomplete response"><p className="field-hint">Incomplete response</p>{partialMessage ? <p style={{ whiteSpace: "pre-wrap" }}>{partialMessage}</p> : <p className="field-hint">A partial response has been saved.</p>}</div>}
        {job.state === "failed" && <p className="form-error">This request did not complete. Any saved partial response is retained.</p>}
        {job.state === "needs_reconciliation" && <p className="account-notice">The provider outcome needs verification. Automatic retry is paused to avoid repeating work.</p>}
        {job.results.map(result => {
          const application = strategyResultApplication(job, result.stepKey);
          return <div key={result.stepKey} className="account-strategy-result">
          <Proposal output={result.output} />
          <div className="strategy-response-actions">{application ? <p className="strategy-response-saved" role="status" aria-label={`Applied to saved version · ${application.appliedRevision}`} title={`Saved in version ${application.appliedRevision}`}><ProjectArtwork name="check" />Added to brief</p> : <><button type="button" className="button primary small" disabled={pending || dirty || workspace.conflict || job.input_revision !== revision} onClick={() => void strategy.apply(job, result.stepKey)}>Apply {strategyLabels[job.operation].toLowerCase()}</button>{(job.input_revision !== revision || dirty || workspace.conflict) && <p className="field-hint">{job.input_revision !== revision ? "This result is preserved from an earlier version." : "Save or resolve your current edits before applying this proposal."}</p>}</>}</div>
        </div>; })}
        {strategyJobActive(job) && <button type="button" className="text-link" disabled={pending || job.state === "cancel_requested"} onClick={() => void strategy.cancel(job)}>Cancel {strategyLabels[job.operation].toLowerCase()}</button>}
      </div>
    </article>; })}</div>}
    {plan && retryPlan && !currentJobs.some(job => job.operation === "strategy.reformulate") && !jobs.some(job => job.operation === "strategy.reformulate" && job.results.some(result => strategyResultApplication(job, result.stepKey)?.appliedRevision === revision)) && <div className="conversation-proposal-action"><span>{retryPlan.billingMode === "chatgpt_subscription" ? "Response and competitor research · ChatGPT plan usage; your plan limits apply." : retryPlan.kind === "response_only" ? `Response only · up to ${formatStrategyCap(retryPlan.reformulation.maximumCostMicrousd)}` : `Response and competitor research · up to ${formatStrategyCap(retryPlan.reformulation.maximumCostMicrousd + retryPlan.competitors.maximumCostMicrousd)}`}</span><button type="button" className="button secondary small" disabled={pending || dirty || workspace.conflict} onClick={() => void retryPrompt()}>Request response</button></div>}
    {strategy.actionError && strategy.continuationAvailable && <button type="button" className="button secondary small" disabled={pending} onClick={() => void strategy.continueResearch()}>Retry competitor research</button>}
    {(strategy.readError || strategy.actionError) && <button type="button" className="text-link" disabled={pending} onClick={strategy.refresh}>Check strategy status</button>}
  </div>;
  return <ProjectEditorForm draft={workspace.draft} storage={{ ...storage, savedContext: workspace.saved.context, onStrategyApproved: async draft => Boolean(await saveDraft(draft)), strategy: transcript, promptNotice, resultNavigation, promptPending: pending, promptSendLabel: plan ? "Send prompt" : "Keep note", promptPlaceholder: plan ? "Reply or ask a question…" : "Add a note to your project…", promptHint: plan ? "Project context" : "Note only · save changes to keep it", onPromptSubmitted: sendPrompt, strategyActions, strategyPending: pending, onStrategyRequested: widget => requestOperation(operationForWidget[widget]) }} />;
}

function Proposal({ output }: { output: StrategyJobResult }) {
  return <>
    <p className="strategy-response-copy">{output.proposal.message}</p>
    {output.operation === "strategy.reformulate" && <>{(output.proposal.activity || output.proposal.offering || output.proposal.knownAudience) && <details className="strategy-proposal-details"><summary>Brief details</summary><dl>{[["Activity", output.proposal.activity], ["Offering", output.proposal.offering], ["Known audience", output.proposal.knownAudience]].filter(([, value]) => value).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl></details>}{output.proposal.questions.length > 0 && <ul className="strategy-response-questions">{output.proposal.questions.map(question => <li key={question}>{question}</li>)}</ul>}</>}
    {output.operation === "strategy.competitors" && <ul>{output.proposal.competitors.map(competitor => <li key={competitor.id}><strong>{competitor.name}</strong><p>{competitor.relevance}</p><ul>{competitor.sources.map((source, index) => <li key={`${source.url}:${index}`}><a href={source.url} target="_blank" rel="noopener noreferrer">{source.title}</a> <BrowserLocalDate dateTime={source.retrievedAt} /></li>)}</ul></li>)}</ul>}
    {output.operation === "strategy.audience" && <ul>{output.proposal.segments.map(segment => <li key={segment.id}><strong>{segment.label}</strong><p>{segment.reason}</p><ul>{segment.needs.map(need => <li key={need}>{need}</li>)}</ul></li>)}</ul>}
    {output.operation === "strategy.personality" && <dl>{Object.entries(output.proposal.personality).map(([dimension, value]) => <div key={dimension}><dt>{dimension[0]!.toUpperCase() + dimension.slice(1)}</dt><dd>{value}/100</dd></div>)}</dl>}
    {output.operation === "strategy.positioning" && <blockquote>{output.proposal.positioning}</blockquote>}
  </>;
}
