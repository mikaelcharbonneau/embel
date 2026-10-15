import { appendGuidedTurn, guidedReplySchema, guidedTurnOperation, initializeGuidedInterview, type GuidedReply, type GuidedStage, type GuidedTurn } from "@/domain/guided-interview";
import { validateConversation, type ConversationEvent } from "@/domain/conversation";
import { contextSnapshotSchema, type ContextSnapshot } from "@/domain/projects";
import type { StrategyJob, StrategyOperation, StrategyOverview } from "@/domain/strategy-jobs";
import { strategyAllowance, type StrategyAllowance } from "./account-strategy-client";

export function guidedAllowance(availability: StrategyOverview["availability"] | null | undefined, operation: StrategyOperation): StrategyAllowance | null {
  if (availability?.status !== "available") return null;
  return strategyAllowance(availability.operations.find(item => item.operation === operation && item.billingMode !== "chatgpt_subscription" && item.interviewVersion === 1));
}

/** A result is displayable only under the exact saved turn it answered. */
export function guidedTurnResult(jobs: readonly StrategyJob[], turn: GuidedTurn, ownerId: string, projectId: string): { job: StrategyJob; reply: GuidedReply | null } | null {
  const job = jobs.find(job => job.owner_id === ownerId && job.project_id === projectId && job.input_revision === turn.inputRevision && job.operation === guidedTurnOperation(turn));
  if (!job) return null;
  const result = job.state === "succeeded" ? job.results.find(result => {
    const reply = result.output.guidance;
    return reply?.turnId === turn.id && reply.stage === turn.stage;
  }) : undefined;
  const parsed = guidedReplySchema.safeParse(result?.output.guidance);
  return { job, reply: parsed.success ? parsed.data : null };
}

function addUserMessage(context: ContextSnapshot, text: string, now: string) {
  const event = { id: crypto.randomUUID(), kind: "user_message" as const, text: text.trim(), createdAt: now };
  return { event, context: contextSnapshotSchema.parse({ ...context, intake: { ...context.intake, conversation: validateConversation([...(context.intake.conversation ?? []), event]) } }) };
}

export function initialGuidedContext(context: ContextSnapshot, revision: number, now = new Date().toISOString()): ContextSnapshot {
  let next = initializeGuidedInterview(context);
  const stage = next.intake.guidedInterview!.stage;
  if (stage === "complete") return next;
  let message = [...(next.intake.conversation ?? [])].reverse().find(event => event.kind === "user_message");
  if (!message) {
    // Clicking Start research explicitly submits this existing brief; it is not
    // fabricated assistant history or a backdated historical user exchange.
    const submitted = addUserMessage(next, next.description, now);
    next = submitted.context; message = submitted.event;
  }
  return appendGuidedTurn(next, { id: crypto.randomUUID(), stage, purpose: stage === "competitors" ? "research" : "propose", userMessageId: message.id, inputRevision: revision });
}

export function guidedMessageContext(context: ContextSnapshot, text: string, revision: number, now = new Date().toISOString()): ContextSnapshot {
  const submitted = addUserMessage(context, text, now);
  let next = initializeGuidedInterview(submitted.context);
  if (next.intake.guidedInterview!.stage === "complete") {
    next = contextSnapshotSchema.parse({ ...next, intake: { ...next.intake, guidedInterview: { ...next.intake.guidedInterview!, stage: "personality" } } });
  }
  const state = next.intake.guidedInterview!;
  const first = state.turns.length === 0;
  return appendGuidedTurn(next, { id: crypto.randomUUID(), userMessageId: submitted.event.id, stage: state.stage as GuidedStage, purpose: first && state.stage === "competitors" ? "research" : "message", inputRevision: revision });
}

export function nextGuidedProposal(context: ContextSnapshot, revision: number, userMessageId: string | null): ContextSnapshot {
  const state = context.intake.guidedInterview;
  if (!state || state.stage === "complete") return context;
  return appendGuidedTurn(context, { id: crypto.randomUUID(), userMessageId, stage: state.stage, purpose: "propose", inputRevision: revision });
}

export function recordGuidedChoice(context: ContextSnapshot, reply: Extract<GuidedReply, { kind: "choices" }>, selectedIds: readonly string[], now: string) {
  const labels = selectedIds.map(id => reply.options.find(option => option.id === id)?.label).filter(Boolean);
  const submitted = addUserMessage(context, labels.join("; "), now);
  return { context: submitted.context, messageId: submitted.event.id };
}

export type GuidedTimelineItem = { kind: "user"; event: Extract<ConversationEvent, { kind: "user_message" }> } | { kind: "turn"; turn: GuidedTurn };
export function guidedTimeline(context: ContextSnapshot): GuidedTimelineItem[] {
  const messages = (context.intake.conversation ?? []).filter(event => event.kind === "user_message");
  const items: GuidedTimelineItem[] = [];
  let cursor = -1;
  for (const turn of context.intake.guidedInterview?.turns ?? []) {
    const anchor = messages.findIndex(message => message.id === turn.userMessageId);
    if (anchor > cursor) {
      for (const event of messages.slice(cursor + 1, anchor + 1)) items.push({ kind: "user", event });
      cursor = anchor;
    }
    items.push({ kind: "turn", turn });
  }
  for (const event of messages.slice(cursor + 1)) items.push({ kind: "user", event });
  return items;
}
