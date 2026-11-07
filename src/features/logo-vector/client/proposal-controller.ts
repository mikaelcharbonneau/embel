import type { VerifiedAccount } from "@/components/workspace/account-session";
import { AccountRequestError } from "@/components/workspace/account-api";
import type { AccountLogoClient } from "@/components/identity/account-logo-client";
import type { LogoDraftMemory } from "@/components/identity/logo-draft-memory";
import type { LogoWorkspaceV2 } from "@/domain/logo-workspace";
import type { LogoVectorDetail } from "@/domain/logo-deliverables";
import { logoVectorProposalRequestSchema } from "@/domain/logo-vector-proposals";
import type { LogoVectorProposalPage } from "@/domain/logo-vector-proposal-jobs";
import { logoGenerationIntentSchema, type LogoCostQuote, type LogoGenerationIntent } from "@/domain/logo-jobs";
import { LOGO_CAPABILITIES_MAX_AGE_MS, type LogoCapabilities } from "@/domain/logo-capabilities";
import { canonicalIdentityInput } from "@/features/identity-directions/model/font-check-binding";
import { validateLogoVectorProposal } from "../model/proposal";
import type { LogoVectorProposalApplication } from "../model/proposal-materialization";
import type { LogoVectorProposalRequestPage, LogoVectorProposalRequestState, LogoVectorProposalSession } from "../model/proposal-session";
import type { createLogoVectorProposalApplicationClient, LogoVectorProposalApplicationResult } from "./proposal-application";

type Client = Pick<AccountLogoClient, "getLogoCapabilities" | "listPendingVectorProposalRequests" | "listLogoVectorProposals" | "readVectorProposalRequest" | "closeVectorProposalRequest" | "quoteLogoOperation" | "admitLogoOperation">;
type ApplicationClient = ReturnType<typeof createLogoVectorProposalApplicationClient>;
export type ProposalEditorContext = { workspace: LogoWorkspaceV2; detail: LogoVectorDetail; ready: boolean; targetId: string } | null;
export type ProposalControllerState = {
  phase: "idle" | "checking" | "quoting" | "review" | "admitting" | "applying" | "stopping";
  session: LogoVectorProposalSession | null; capabilities: LogoCapabilities | null; discovery: LogoVectorProposalRequestPage | null; discoveryClear: boolean; discoveryCursor: string | null;
  history: LogoVectorProposalPage | null; request: LogoVectorProposalRequestState | null; application: LogoVectorProposalApplication | null;
  quote: LogoCostQuote | null; error: string | null; notice: string | null; stopAcknowledged: readonly string[];
};
export const EMPTY_PROPOSALS: ProposalControllerState = Object.freeze({ phase: "idle", session: null, capabilities: null, discovery: null, discoveryClear: false, discoveryCursor: null,
  history: null, request: null, application: null, quote: null, error: null, notice: null, stopAcknowledged: [] });
const same = (a: unknown, b: unknown) => canonicalIdentityInput(a) === canonicalIdentityInput(b);
const terminal = (value: LogoVectorProposalRequestState) => value.state.status !== "not_found" && ["succeeded", "failed", "cancelled", "partial"].includes(value.state.status) && value.state.billing.status === "recorded";

/** Only confirm admits AI. Reads, Stop and explicit application never generate. */
export function createVectorProposalController(input: { account: VerifiedAccount; projectId: string; memory: LogoDraftMemory; client: Client; applicationClient: ApplicationClient;
  isCurrent(): boolean; now(): number; newKey(): string; onApplied(result: Extract<LogoVectorProposalApplicationResult, { status: "succeeded" }>): Promise<void> }) {
  let closed = false, context: ProposalEditorContext = null, contextKey = "", operation: AbortController | null = null;
  let state: ProposalControllerState = { ...EMPTY_PROPOSALS, session: input.memory.getVectorProposal(input.projectId) };
  const listeners = new Set<() => void>(), current = () => !closed && input.isCurrent();
  const session = () => input.memory.getVectorProposal(input.projectId);
  function emit(value: Partial<ProposalControllerState>) { if (current()) { state = { ...state, ...value, session: session() }; listeners.forEach(fn => fn()); } }
  const release = input.memory.subscribe(() => emit({}));
  function save(value: LogoVectorProposalSession) { if (current()) input.memory.setVectorProposal(input.projectId, value); }
  function freshCapability(value = state.capabilities) {
    const readiness = value?.operations["identity.logo_vector_propose"], now = input.now();
    return Boolean(value && value.ownerId === input.account.userId && value.projectId === input.projectId && readiness?.status === "available"
      && Number.isFinite(now) && now >= Date.parse(value.observedAt) && now - Date.parse(value.observedAt) < LOGO_CAPABILITIES_MAX_AGE_MS && now < Date.parse(readiness.expiresAt));
  }
  const ownedContext = () => Boolean(context && context.workspace.ownerId === input.account.userId && context.workspace.projectId === input.projectId && context.detail.revision.ownerId === input.account.userId && context.detail.revision.projectId === input.projectId);
  const free = () => !session()?.pendingGeneration && !session()?.pendingApplication;
  function quoteValid(quote: LogoCostQuote) {
    const form = session();
    return Boolean(current() && ownedContext() && context?.ready && form && free() && state.discoveryClear && quote.ownerId === input.account.userId && quote.projectId === input.projectId
      && quote.request.operation === "propose_vector_edit" && quote.request.baseVectorRevisionId === context.detail.revision.id && quote.request.baseVectorRevisionId === form.baseVectorRevisionId
      && same(quote.expected, context.workspace.heads) && same(quote.request.targetComponentIds, form.targetComponentIds) && quote.request.instruction === form.instruction && Date.parse(quote.expiresAt) > input.now());
  }
  function cancelEstimate() {
    if (state.phase === "quoting" && operation) { operation.abort(); operation = null; }
    emit({ quote: null, ...(["idle", "review", "quoting"].includes(state.phase) ? { phase: "idle" as const } : {}) });
  }
  async function run(phase: Exclude<ProposalControllerState["phase"], "idle" | "review">, work: (signal: AbortSignal) => Promise<void>) {
    if (!current() || operation) return;
    const controller = new AbortController(); operation = controller; const timer = setTimeout(() => controller.abort(), 30_000);
    emit({ phase, error: null, notice: null });
    try { await work(controller.signal); }
    catch { if (current() && operation === controller) emit({ error: phase === "quoting"
      ? "This suggestion could not be prepared. Check the saved vector and availability, then try again. Your changes are kept."
      : "This action could not be confirmed. Your original request, saved versions and any pending edit are kept. Check the original before retrying." }); }
    finally { clearTimeout(timer); if (operation === controller) { operation = null; emit({ phase: state.quote ? "review" : "idle" }); } }
  }
  function checked<T>(value: T | null, signal: AbortSignal): T { if (!value || !current() || signal.aborted) throw new AccountRequestError(503); return value; }
  async function pending(signal: AbortSignal, cursor?: string) {
    const page = checked(await input.client.listPendingVectorProposalRequests({ cursor, limit: 10 }, signal), signal);
    emit({ discovery: page, discoveryCursor: cursor ?? null, discoveryClear: !cursor && page.items.length === 0 && page.nextCursor === null });
  }
  async function select(proposalId: string, signal: AbortSignal) {
    const value = checked(await input.applicationClient.readApplication(proposalId, signal), signal);
    if (value.proposal.payload) validateLogoVectorProposal(value.proposal.payload, value.proposal.context);
    const form = session(); if (form && form.selectedProposalId !== proposalId && !form.pendingApplication) save({ ...form, selectedProposalId: proposalId });
    emit({ application: value });
  }
  async function adopt(value: LogoVectorProposalRequestState, original: LogoGenerationIntent, signal: AbortSignal) {
    if (value.ownerId !== input.account.userId || value.projectId !== input.projectId || !same(value.input, original)) throw new AccountRequestError(502);
    const local = session(), frozen = local?.pendingGeneration;
    if (frozen && same(frozen.input, original) && value.state.status !== "not_found" && value.state.receipt && "jobIds" in value.state.receipt && value.state.receipt.inputHash !== frozen.quote.inputHash) throw new AccountRequestError(502);
    emit({ request: value });
    if (terminal(value) && (value.state.status !== "succeeded" || value.proposal)) {
      if (frozen && same(frozen.input, original)) save({ ...local, pendingGeneration: null, dirty: false, selectedProposalId: value.proposal?.id ?? local.selectedProposalId });
    }
    if (value.proposal) await select(value.proposal.id, signal);
  }
  async function check(original: LogoGenerationIntent, signal: AbortSignal) { await adopt(checked(await input.client.readVectorProposalRequest(original, signal), signal), original, signal); }
  async function dispatch(original: LogoGenerationIntent, quote: LogoCostQuote, signal: AbortSignal) {
    const receipt = checked(await input.client.admitLogoOperation(original, signal), signal);
    if (receipt.operation !== "identity.logo_vector_propose" || receipt.jobIds.length !== 1 || receipt.requestKey !== original.requestKey || receipt.ownerId !== input.account.userId || receipt.projectId !== input.projectId || receipt.inputHash !== quote.inputHash) throw new AccountRequestError(502);
    await check(original, signal); await pending(signal);
  }
  async function settleApplication(result: LogoVectorProposalApplicationResult | null, original: NonNullable<LogoVectorProposalSession["pendingApplication"]>, signal: AbortSignal) {
    const value = checked(result, signal), form = session();
    if (!form?.pendingApplication || !same(form.pendingApplication, original)) throw new AccountRequestError(409);
    if (value.status === "cancelled") { save({ ...form, pendingApplication: null }); emit({ notice: "The original application was cancelled. The saved logo and proposal remain available." }); return; }
    const record = input.memory.get(input.projectId);
    if (!record || record.dirty || record.vectorDraft || record.directionDraft || record.pendingIntent || record.pendingMutation || record.pendingExport) throw new AccountRequestError(409);
    input.memory.set(input.projectId, { ...record, workspace: value.workspace, base: value.workspace.heads });
    save({ ...form, pendingApplication: null, dirty: false });
    emit({ notice: "An unapproved vector candidate is saved. Review it in the editor; accepting it is a separate action." });
    await input.onApplied(value);
  }
  function canApply() {
    return Boolean(current() && ownedContext() && context?.ready && free() && !session()?.dirty && state.application?.eligible && state.application.proposal.payload?.status === "proposed"
      && state.application.proposal.baseVectorRevisionId === context.detail.revision.id && state.application.proposal.context.documentHash === context.detail.revision.documentHash
      && same(state.application.proposal.context.source, context.detail.revision.source) && same(state.application.proposal.expected, context.workspace.heads));
  }
  const canRefreshEstimate = () => Boolean(current() && ownedContext() && context?.ready && free() && state.discoveryClear);
  return {
    getSnapshot: () => current() ? state : EMPTY_PROPOSALS, getServerSnapshot: () => EMPTY_PROPOSALS,
    subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    updateContext(value: ProposalEditorContext) { context = value; const key = value ? `${value.detail.revision.id}:${value.detail.revision.documentHash}:${canonicalIdentityInput(value.workspace.heads)}:${value.ready}` : ""; if (contextKey !== key) { contextKey = key; cancelEstimate(); emit({}); } },
    canConfirm: () => Boolean(state.quote && quoteValid(state.quote) && freshCapability()),
    canPrepare: () => canRefreshEstimate() && freshCapability(),
    canRefreshEstimate,
    canApply,
    setForm(instruction: string, targets: string[]) {
      if (current() && state.phase === "quoting") cancelEstimate();
      if (!current() || operation || !free() || !context || !ownedContext()) return;
      const old = session(); if (old && old.baseVectorRevisionId !== context.detail.revision.id) { emit({ error: "This draft uses an earlier saved vector. Discard the draft before editing the current vector." }); return; }
      save({ baseVectorRevisionId: context.detail.revision.id, instruction, targetComponentIds: targets, dirty: true, pendingGeneration: null, pendingApplication: null, selectedProposalId: old?.selectedProposalId ?? null }); emit({ quote: null, error: null, notice: null });
    },
    discardDraft() { if (current() && state.phase === "quoting") cancelEstimate(); if (current() && !operation && free()) { input.memory.setVectorProposal(input.projectId, null); emit({ quote: null, error: null, notice: null }); } },
    cancelQuote() { if (current() && free() && (!operation || state.phase === "quoting")) cancelEstimate(); },
    expireQuote() { if (state.quote && Date.parse(state.quote.expiresAt) <= input.now() && free() && !operation && ["idle", "review"].includes(state.phase)) { cancelEstimate(); emit({ notice: "This request expired. Try again before generating." }); } },
    async refresh() { await run("checking", async signal => {
      const results = await Promise.allSettled([input.client.getLogoCapabilities(signal), input.client.listPendingVectorProposalRequests({ limit: 10 }, signal), input.client.listLogoVectorProposals({ limit: 20 }, signal)]);
      if (!current() || signal.aborted) return;
      const [caps, requests, history] = results;
      emit({ capabilities: caps.status === "fulfilled" ? caps.value : null, discovery: requests.status === "fulfilled" ? requests.value : null, discoveryCursor: null,
        discoveryClear: requests.status === "fulfilled" && Boolean(requests.value && !requests.value.items.length && !requests.value.nextCursor), history: history.status === "fulfilled" ? history.value : null });
      if (requests.status !== "fulfilled" || !requests.value) throw new AccountRequestError(503);
      const form = session();
      if (form?.pendingGeneration) await check(form.pendingGeneration.input, signal);
      else if (form?.selectedProposalId) await select(form.selectedProposalId, signal);
    }); },
    expireAvailability() { emit({}); },
    async morePending() { const cursor = state.discovery?.nextCursor; if (cursor) await run("checking", signal => pending(signal, cursor)); },
    async moreHistory() { const cursor = state.history?.nextCursor; if (!cursor) return; await run("checking", async signal => { const page = checked(await input.client.listLogoVectorProposals({ cursor, limit: 20 }, signal), signal); emit({ history: page }); }); },
    async prepare() { if (!operation && free()) emit({ quote: null }); await run("quoting", async signal => {
      const form = session(); if (!form || !context?.ready || !ownedContext() || !free()) throw new AccountRequestError(409);
      await pending(signal); const caps = checked(await input.client.getLogoCapabilities(signal), signal); emit({ capabilities: caps });
      if (!state.discoveryClear || !freshCapability(caps) || form.baseVectorRevisionId !== context.detail.revision.id) throw new AccountRequestError(409);
      if (form.targetComponentIds.some(id => !context!.detail.document.components.some(c => c.id === id) || context!.detail.revision.locks.some(lock => lock.componentId === id))) throw new AccountRequestError(422);
      const request = logoVectorProposalRequestSchema.parse({ operation: "propose_vector_edit", expected: context.workspace.heads, baseVectorRevisionId: form.baseVectorRevisionId, instruction: form.instruction, targetComponentIds: form.targetComponentIds });
      const quote = checked(await input.client.quoteLogoOperation(request, signal), signal);
      if (!quoteValid(quote)) throw new AccountRequestError(409); emit({ quote });
    }); },
    async confirm() { const quote = state.quote; if (!quote) return; if (!quoteValid(quote)) { if (free() && !operation) { cancelEstimate(); emit({ notice: "The estimate or saved inputs changed. Refresh the estimate before generating." }); } return; } await run("admitting", async signal => {
      await pending(signal); const caps = checked(await input.client.getLogoCapabilities(signal), signal); emit({ capabilities: caps });
      if (!quoteValid(quote) || !freshCapability(caps)) throw new AccountRequestError(409);
      const original = logoGenerationIntentSchema.parse({ requestKey: input.newKey(), quoteId: quote.id, expected: quote.expected, ...("spendControl" in quote ? {} : { acceptedMaxCostMicrousd: quote.maxCostMicrousd }) });
      const form = session()!; save({ ...form, pendingGeneration: { quote, input: original }, dirty: false, selectedProposalId: null }); emit({ quote: null, application: null, request: null });
      await dispatch(original, quote, signal);
    }); },
    async checkRequest(original = session()?.pendingGeneration?.input) { if (original) await run("checking", async signal => { await check(original, signal); await pending(signal); }); },
    async retryOriginal() { const frozen = session()?.pendingGeneration; if (!frozen) return; await run("admitting", async signal => {
      try { const read = checked(await input.client.readVectorProposalRequest(frozen.input, signal), signal); if (read.state.status !== "not_found") { await adopt(read, frozen.input, signal); return; } }
      catch (error) { if (!(error instanceof AccountRequestError) || error.status !== 404) throw error; }
      // This explicit replay keeps the original body/key. A missing read never clears it.
      await dispatch(frozen.input, frozen.quote, signal);
    }); },
    async stopRequest(original = session()?.pendingGeneration?.input) { if (!original) return; await run("stopping", async signal => {
      const result = checked(await input.client.closeVectorProposalRequest(original, signal), signal);
      if (result.status === "not_admitted") {
        const form = session(); if (form?.pendingGeneration && same(form.pendingGeneration.input, original)) save({ ...form, pendingGeneration: null });
        emit({ notice: "The original request was closed before admission. It cannot start later." });
      } else { await adopt(result.request, original, signal); emit({ stopAcknowledged: [...new Set([...state.stopAcknowledged, original.requestKey])], notice: "Stop is requested. Provider outcomes and charges remain unresolved until the saved request confirms them." }); }
      await pending(signal);
    }); },
    async selectProposal(id: string) { if (!session()?.pendingApplication) await run("checking", signal => select(id, signal)); },
    async apply() { if (!canApply() || !state.application || !context) return; const proposal = state.application.proposal; await run("applying", async signal => {
      const latest = checked(await input.applicationClient.readApplication(proposal.id, signal), signal); emit({ application: latest }); if (!canApply()) throw new AccountRequestError(409);
      const old = session(), original = { requestKey: input.newKey(), expected: proposal.expected, baseVectorRevisionId: proposal.baseVectorRevisionId, proposalId: proposal.id };
      save({ baseVectorRevisionId: proposal.baseVectorRevisionId, instruction: old?.instruction ?? "", targetComponentIds: old?.targetComponentIds ?? proposal.context.targetComponentIds,
        dirty: false, pendingGeneration: null, pendingApplication: original, selectedProposalId: proposal.id });
      await settleApplication(await input.applicationClient.submit(original, signal), original, signal);
    }); },
    async recoverApplication(retry = false) { const original = session()?.pendingApplication; if (!original) return; await run("applying", async signal => { input.applicationClient.retain(original); const result = await input.applicationClient.recover(retry, signal); if (result) await settleApplication(result, original, signal); else emit({ notice: "The original application is not confirmed. Its exact request is kept; checking has not generated or applied another edit." }); }); },
    async cancelApplication() { const original = session()?.pendingApplication; if (!original) return; await run("stopping", async signal => { input.applicationClient.retain(original); await settleApplication(await input.applicationClient.cancel(signal), original, signal); }); },
    dispose() { closed = true; operation?.abort(); operation = null; release(); input.applicationClient.dispose(); listeners.clear(); },
  };
}
export type VectorProposalController = ReturnType<typeof createVectorProposalController>;
