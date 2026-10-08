import { logoCostQuoteSchema, logoGenerationIntentSchema, logoQuoteRequestSchema,
  type LogoCostQuote, type LogoGenerationIntent, type LogoQuoteRequest, type LogoRequestState, type LogoOperation,
} from "../../domain/logo-jobs";
import type { LogoWorkspaceReloadResult } from "../identity/use-logo-workspace";
import type { LogoWorkspaceV2 } from "../../domain/logo-workspace";
import { AccountLogoAdmissionRejectedError, type AccountLogoClient } from "../identity/account-logo-client";
import { AccountRequestError, accountErrorMessage } from "../workspace/account-api";

export type LogoCreationState = {
  phase: "idle" | "quoting" | "awaiting_confirmation" | "admitting" | "active" | "needs_reconciliation" | "rejected" | "refreshing_workspace" | "resolve_draft";
  quote: LogoCostQuote | null; request: LogoRequestState | null; error: string | null;
};
export type LogoCreationControllerInput = {
  client: AccountLogoClient; projectId: string; getWorkspace(): LogoWorkspaceV2 | null; hasUnsavedInputs(): boolean;
  getPendingIntent(): LogoGenerationIntent | null; retainIntent(intent: LogoGenerationIntent): void; clearIntent(requestKey: string): void;
  refreshWorkspace(): Promise<LogoWorkspaceReloadResult>;
  isCurrent(): boolean; now(): number; createRequestKey(): string;
  /** Live UI always supplies this; omitted only by legacy injected fixtures. */
  isOperationAvailable?(operation: LogoOperation): boolean;
};
export type LogoCreationController = {
  prepare(request: LogoQuoteRequest): Promise<void>; confirmQuote(quoteId: string): Promise<void>; checkRequest(): Promise<void>;
  retryOriginalIntent(): Promise<void>; cancelQuote(): void; returnToCostReview(): Promise<void>; refreshInputs(): void;
  canConfirmQuote(): boolean;
  getSnapshot(): LogoCreationState; subscribe(listener: () => void): () => void; dispose(): void;
};
const empty: LogoCreationState = Object.freeze({ phase: "idle", quote: null, request: null, error: null });
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const recoveryMessage = "The outcome is not confirmed. Your original request is kept. Check it before trying again.";
const rejectedMessage = "This request was not admitted. Return to cost review for a new estimate before starting any generation.";
const readinessMessage = "This operation is currently unavailable. Your estimate is kept; check availability again before confirming.";
export function logoOperationForQuote(request: LogoQuoteRequest): LogoOperation {
  switch (request.operation) {
    case "vectorize": return "identity.logo_vectorize";
    case "directions": return "identity.logo_directions";
    case "refine_preview": case "refine_vector": return "identity.logo_refine";
    default: return "identity.logo_concept";
  }
}
const staleMessage = "Saved inputs or the estimate changed. Save your edits and review a new estimate.";

/** Only confirmQuote and explicit unchanged-key replay may admit work. Checking,
 * preparing, mounting, editing and changing accounts never dispatch generation. */
export function createLogoCreationController(input: LogoCreationControllerInput): LogoCreationController {
  const initial = input.getWorkspace();
  const ownerId = initial?.ownerId;
  let disposed = false, busy = false, serial = 0, controller: AbortController | null = null;
  let state: LogoCreationState = input.getPendingIntent() ? { ...empty, phase: "needs_reconciliation" } : empty;
  const listeners = new Set<() => void>();
  const current = () => !disposed && input.isCurrent() && input.getWorkspace()?.ownerId === ownerId && input.getWorkspace()?.projectId === input.projectId;
  const emit = (next: LogoCreationState) => { if (!current()) return; state = next; for (const listener of listeners) listener(); };
  const available = (request: LogoQuoteRequest) => input.isOperationAvailable
    ? input.isOperationAvailable(logoOperationForQuote(request))
    : (request.operation === "vectorize" ? input.getWorkspace()?.capabilities.convert.status : input.getWorkspace()?.capabilities.generate.status) === "available";
  const quoteValid = (quote: LogoCostQuote) => current() && !input.hasUnsavedInputs() && quote.ownerId === ownerId && quote.projectId === input.projectId
    && Number.isFinite(input.now()) && Date.parse(quote.expiresAt) > input.now() && same(quote.expected, input.getWorkspace()?.heads);
  function begin() {
    if (!current() || busy) return null;
    busy = true; controller = new AbortController(); const token = ++serial, signal = controller.signal;
    return { signal, current: () => current() && serial === token && !signal.aborted, end() { if (serial === token) { busy = false; controller = null; } } };
  }
  function adopt(request: LogoRequestState) {
    if (request.status === "not_found") {
      const retained = state.request && state.request.status !== "not_found" && state.request.requestKey === input.getPendingIntent()?.requestKey ? state.request : request;
      emit({ ...state, phase: "needs_reconciliation", request: retained, quote: null, error: recoveryMessage }); return;
    }
    const rejected = request.status === "failed" && request.reason === "admission_rejected" && request.receipt === null && request.outputs.length === 0 && request.billing.status === "recorded" && request.billing.confirmedMicrousd === 0;
    const terminal = ["succeeded", "failed", "cancelled", "partial"].includes(request.status) && request.billing.status === "recorded";
    const uncertain = request.status === "needs_reconciliation" || !terminal && ["succeeded", "failed", "cancelled", "partial"].includes(request.status);
    emit({ phase: rejected ? "rejected" : uncertain ? "needs_reconciliation" : terminal ? "idle" : "active", quote: null, request, error: rejected ? rejectedMessage : uncertain ? recoveryMessage : null });
    if (terminal) input.clearIntent(request.requestKey);
  }
  async function submit(intent: LogoGenerationIntent, token: NonNullable<ReturnType<typeof begin>>) {
    try {
      const receipt = await input.client.admitLogoOperation(intent, token.signal);
      if (!token.current() || !same(input.getPendingIntent(), intent)) return;
      if (!receipt) { emit({ ...state, phase: "needs_reconciliation", quote: null, error: recoveryMessage }); return; }
      adopt({ status: "admitted", requestKey: intent.requestKey, receipt, outputs: [], billing: { status: "unknown", confirmedMicrousd: null }, reason: null });
    } catch (error) {
      if (!token.current() || !same(input.getPendingIntent(), intent)) return;
      if (error instanceof AccountLogoAdmissionRejectedError && error.rejection.ownerId === ownerId && error.rejection.projectId === input.projectId
        && error.rejection.requestKey === intent.requestKey && error.rejection.quoteId === intent.quoteId) {
        // This marker is emitted only for a committed durable rejection of the
        // exact body/key. It prohibits a delayed original from later admitting.
        adopt({ status: "failed", requestKey: intent.requestKey, receipt: null, outputs: [], reason: "admission_rejected", billing: { status: "recorded", confirmedMicrousd: 0 } });
      } else emit({ ...state, phase: "needs_reconciliation", quote: null, error: `${accountErrorMessage(error)} ${recoveryMessage}` });
    } finally { token.end(); }
  }
  return {
    getSnapshot: () => current() ? state : empty,
    canConfirmQuote: () => !!(state.quote && state.phase === "awaiting_confirmation" && quoteValid(state.quote) && available(state.quote.request)),
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    dispose() { disposed = true; serial++; busy = false; controller?.abort(); controller = null; state = empty; listeners.clear(); },
    cancelQuote() {
      if (!current() || input.getPendingIntent() || !["quoting", "awaiting_confirmation"].includes(state.phase)) return;
      serial++; controller?.abort(); controller = null; busy = false; emit({ ...state, phase: "idle", quote: null, error: null });
    },
    async returnToCostReview() {
      if (!current() || busy || !["rejected", "resolve_draft"].includes(state.phase) || input.getPendingIntent()) return;
      const token = begin(); if (!token) return;
      emit({ ...state, phase: "refreshing_workspace", quote: null, error: null });
      try {
        const result = await input.refreshWorkspace();
        if (!token.current()) return;
        emit({ ...state, phase: result === "reloaded" ? "idle" : result === "draft_blocked" ? "resolve_draft" : "rejected", quote: null,
          error: result === "reloaded" ? null : result === "draft_blocked"
            ? "Save or resolve your unsaved brief, vector or identity-direction edits before returning to cost review. Your edits are kept."
            : "Current saved inputs could not be refreshed. Your edits are kept. Try returning to cost review again." });
      } catch {
        if (token.current()) emit({ ...state, phase: "rejected", quote: null, error: "Current saved inputs could not be refreshed. Your edits are kept. Try returning to cost review again." });
      } finally { token.end(); }
    },
    refreshInputs() {
      if (!current() || !state.quote) return;
      if (quoteValid(state.quote)) {
        if (state.error === readinessMessage && available(state.quote.request)) emit({ ...state, error: null });
        return;
      }
      if (state.phase === "awaiting_confirmation") emit({ ...state, phase: "idle", quote: null, error: staleMessage });
    },
    async prepare(request) {
      if (["rejected", "refreshing_workspace", "resolve_draft"].includes(state.phase)) return;
      const token = begin(); if (!token) return;
      try {
        if (input.getPendingIntent()) { emit({ ...state, phase: state.phase === "active" ? "active" : "needs_reconciliation", quote: null, error: recoveryMessage }); return; }
        const parsed = logoQuoteRequestSchema.parse(request), workspace = input.getWorkspace();
        if (!workspace || input.hasUnsavedInputs() || !same(parsed.expected, workspace.heads)) throw new AccountRequestError(409);
        if (!available(parsed)) throw new AccountRequestError(503);
        emit({ phase: "quoting", quote: null, request: null, error: null });
        const value = await input.client.quoteLogoOperation(parsed, token.signal);
        if (!token.current()) return;
        if (!value) throw new AccountRequestError(503);
        const quote = logoCostQuoteSchema.parse(value);
        if (!same(quote.request, parsed) || !quoteValid(quote)) throw new AccountRequestError(409);
        emit({ ...state, phase: "awaiting_confirmation", quote, error: null });
      } catch (error) {
        if (token.current()) {
          const conflict = error instanceof AccountRequestError && error.status === 409;
          emit({ ...state, phase: conflict ? input.hasUnsavedInputs() ? "resolve_draft" : "rejected" : "idle", quote: null, error: conflict ? staleMessage : accountErrorMessage(error) });
        }
      } finally { token.end(); }
    },
    async confirmQuote(quoteId) {
      const token = begin(); if (!token) return;
      const quote = state.quote;
      if (!quote || state.phase !== "awaiting_confirmation" || quote.id !== quoteId || input.getPendingIntent()) { token.end(); return; }
      if (!quoteValid(quote)) { emit({ ...state, phase: "idle", quote: null, error: staleMessage }); token.end(); return; }
      if (!available(quote.request)) { emit({ ...state, error: readinessMessage }); token.end(); return; }
      try {
        const intent = logoGenerationIntentSchema.parse({ requestKey: input.createRequestKey(), quoteId: quote.id, acceptedMaxCostMicrousd: quote.maxCostMicrousd, expected: quote.expected });
        // Retain before the first network byte, then verify that shared memory
        // accepted exactly this intent (its setter may be account-fenced).
        input.retainIntent(intent);
        if (!token.current() || !same(input.getPendingIntent(), intent)) { token.end(); return; }
        emit({ ...state, phase: "admitting", error: null });
        await submit(intent, token);
      } catch (error) {
        if (token.current()) emit({ ...state, phase: input.getPendingIntent() ? "needs_reconciliation" : "idle", quote: null, error: accountErrorMessage(error) });
        token.end();
      }
    },
    async checkRequest() {
      const token = begin(); if (!token) return;
      const intent = input.getPendingIntent();
      if (!intent) { token.end(); return; }
      try {
        let request = await input.client.readLogoRequest(intent.requestKey, token.signal);
        if (!token.current() || !same(input.getPendingIntent(), intent)) return;
        if (!request) throw new AccountRequestError(503);
        if (request.status === "needs_reconciliation") {
          // This endpoint reconciles the saved request; it cannot dispatch it.
          adopt(request);
          const reconciled = await input.client.reconcileLogoRequest(intent.requestKey, token.signal);
          if (!token.current() || !same(input.getPendingIntent(), intent)) return;
          if (reconciled && reconciled.status !== "not_found") request = reconciled;
        }
        adopt(request);
      } catch (error) { if (token.current()) emit({ ...state, error: `${accountErrorMessage(error)} ${recoveryMessage}` }); }
      finally { token.end(); }
    },
    async retryOriginalIntent() {
      const token = begin(); if (!token) return;
      const original = input.getPendingIntent();
      if (!original || state.request && state.request.status !== "not_found" || state.phase === "active") { token.end(); return; }
      try {
        const request = await input.client.readLogoRequest(original.requestKey, token.signal);
        if (!token.current() || !same(input.getPendingIntent(), original)) { token.end(); return; }
        if (!request) throw new AccountRequestError(503);
        if (request.status !== "not_found") { adopt(request); token.end(); return; }
        // No new quote, cap, heads or key. Server enforces current policy/expiry
        // atomically if the original transaction truly did not exist.
        const intent = logoGenerationIntentSchema.parse(original);
        emit({ ...state, phase: "admitting", quote: null, error: null });
        await submit(intent, token);
      } catch (error) {
        if (token.current()) emit({ ...state, phase: "needs_reconciliation", error: `${accountErrorMessage(error)} ${recoveryMessage}` });
        token.end();
      }
    },
  };
}
