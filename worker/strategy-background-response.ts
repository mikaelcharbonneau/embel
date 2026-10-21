import { z } from "zod";
import { OpenAITransportError, type OpenAIResponsesTransport, type OpenAITransportResponse, type ResponsesRequest } from "../src/server/ai/openai-transport";

const responseId = z.string().regex(/^resp_[A-Za-z0-9_-]{1,194}$/u);
const envelope = z.object({ id: responseId, status: z.enum(["queued", "in_progress", "completed", "failed", "cancelled", "incomplete"]) });
const terminal = new Set(["completed", "failed", "cancelled", "incomplete"]);
export type BackgroundResponseState = {
  dispatchState: "not_dispatched" | "dispatching" | "accepted" | "rejected";
  responseId: string | null;
  rejectionReason?: "provider_rejected" | "observer_stopped" | "cancelled";
  terminalResponse: OpenAITransportResponse | null;
  cancelRequested: boolean;
  executionDeadlineAt: number;
  observationDeadlineAt: number;
};
/** The implementation must bind every operation to one owned, leased immutable
 * job/attempt. No caller may select an owner or replace a provider identity. */
export interface BackgroundResponseJournal {
  load(): Promise<BackgroundResponseState>;
  beginDispatch(): Promise<boolean>;
  recordRejection(requestId: string | null, reason?: "provider_rejected" | "observer_stopped" | "cancelled"): Promise<void>;
  recordHandle(id: string): Promise<void>;
  recordTerminal(response: OpenAITransportResponse): Promise<void>;
}
export type BackgroundResponseOutcome =
  | { kind: "terminal"; response: OpenAITransportResponse }
  | { kind: "pending"; responseId: string; reason: "running" | "observer_stopped" | "observation_unavailable" | "persistence_unavailable" }
  | { kind: "not_dispatched"; reason: "cancelled" | "provider_rejected" | "observer_stopped" }
  | { kind: "unresolved"; reason: "provider_identity_unknown" | "provider_identity_mismatch" | "observation_expired"; responseId: string | null };

/** One durable provider create, then observation only. A dropped observer is not
 * user cancellation. Caller owns queue scheduling and authoritative accounting. */
export async function observeBackgroundResponse(options: {
  journal: BackgroundResponseJournal;
  provider: OpenAIResponsesTransport;
  request: ResponsesRequest;
  requestKey: string;
  signal: AbortSignal;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
  pollWindowMs?: number;
}): Promise<BackgroundResponseOutcome> {
  const { journal, provider, signal } = options, now = options.now ?? Date.now;
  const wait = options.wait ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const pollWindowMs = options.pollWindowMs ?? 15_000;
  if (!provider.retrieveResponse || !provider.cancelResponse || !Number.isSafeInteger(pollWindowMs) || pollWindowMs < 0 || pollWindowMs > 30_000) throw new Error("Background response runtime unavailable");
  const stopAt = now() + pollWindowMs;
  let state = await journal.load();
  if (!Number.isSafeInteger(state.executionDeadlineAt) || !Number.isSafeInteger(state.observationDeadlineAt) || state.executionDeadlineAt > state.observationDeadlineAt) throw new Error("Background response deadlines invalid");
  if (state.responseId !== null) responseId.parse(state.responseId);
  if (state.terminalResponse) {
    if (envelope.parse(state.terminalResponse.body).id !== state.responseId) return { kind: "unresolved", reason: "provider_identity_mismatch", responseId: state.responseId };
    if (!terminal.has(envelope.parse(state.terminalResponse.body).status)) throw new Error("Stored response is not terminal");
    return { kind: "terminal", response: state.terminalResponse };
  }
  if (state.dispatchState === "rejected") return { kind: "not_dispatched", reason: state.rejectionReason ?? "provider_rejected" };
  let latest: OpenAITransportResponse | null = null;
  if (state.dispatchState === "not_dispatched") {
    if (state.cancelRequested || now() >= state.executionDeadlineAt) return { kind: "not_dispatched", reason: "cancelled" };
    if (signal.aborted) return { kind: "not_dispatched", reason: "observer_stopped" };
    // The journal atomically checks cancellation, ownership, lease and the
    // original request. A lost acknowledgement is never permission to create.
    if (!await journal.beginDispatch()) {
      state = await journal.load();
    } else {
      // Ownership was durably reserved, but no network request has begun yet.
      // Persist this known no-dispatch outcome rather than manufacturing an
      // ambiguous provider create when shutdown wins the journal-write race.
      if (signal.aborted || now() >= state.executionDeadlineAt) {
        const reason = signal.aborted ? "observer_stopped" : "cancelled";
        await journal.recordRejection(null, reason);
        return { kind: "not_dispatched", reason };
      }
      try {
        latest = await provider.createResponse({ ...options.request, background: true, store: false, stream: false }, options.requestKey, signal);
      } catch (error) {
        if (error instanceof OpenAITransportError && error.code === "request_rejected") {
          await journal.recordRejection(error.requestId);
          return { kind: "not_dispatched", reason: "provider_rejected" };
        }
        return { kind: "unresolved", reason: "provider_identity_unknown", responseId: null };
      }
      const parsed = envelope.safeParse(latest.body);
      if (!parsed.success) return { kind: "unresolved", reason: "provider_identity_unknown", responseId: null };
      const id = parsed.data.id;
      try { await journal.recordHandle(id); }
      catch {
        // An acknowledged read can prove the same write committed. Never infer
        // that a failed save was a failed provider request.
        const stored = await journal.load().catch(() => null);
        if (stored?.responseId !== id) return { kind: "pending", responseId: id, reason: "persistence_unavailable" };
      }
      state = { ...state, responseId: id, dispatchState: "accepted" };
    }
  }
  const id = state.responseId;
  if (!id) return { kind: "unresolved", reason: "provider_identity_unknown", responseId: null };
  for (;;) {
    if (latest) {
      const parsed = envelope.safeParse(latest.body);
      if (!parsed.success || parsed.data.id !== id) return { kind: "unresolved", reason: "provider_identity_mismatch", responseId: id };
      if (terminal.has(parsed.data.status)) {
        // Preserve known terminal output even when shutdown arrives with it.
        try { await journal.recordTerminal(latest); }
        catch { return { kind: "pending", responseId: id, reason: "persistence_unavailable" }; }
        return { kind: "terminal", response: latest };
      }
    }
    if (signal.aborted) return { kind: "pending", responseId: id, reason: "observer_stopped" };
    if (now() >= state.observationDeadlineAt) return { kind: "unresolved", responseId: id, reason: "observation_expired" };
    if (now() >= stopAt) return { kind: "pending", responseId: id, reason: "running" };
    state = await journal.load();
    if (state.responseId !== id) return { kind: "unresolved", responseId: id, reason: "provider_identity_mismatch" };
    try {
      // Explicit Stop and the original execution deadline can cancel only the
      // known response. Provider cancellation is idempotent, not a new inference.
      latest = state.cancelRequested || now() >= state.executionDeadlineAt
        ? await provider.cancelResponse(id, signal)
        : await provider.retrieveResponse(id, signal);
    } catch { return { kind: "pending", responseId: id, reason: "observation_unavailable" }; }
    if (!terminal.has(envelope.safeParse(latest.body).data?.status ?? "")) await wait(Math.min(1_000, Math.max(0, stopAt - now())));
  }
}
