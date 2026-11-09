import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createVectorProposalController, type ProposalEditorContext, type VectorProposalController } from "../../../src/features/logo-vector/client/proposal-controller";
import { createLogoVectorProposalApplicationClient } from "../../../src/features/logo-vector/client/proposal-application";
import { createLogoDraftMemory } from "../../../src/components/identity/logo-draft-memory";
import { logoWorkspaceV2Schema } from "../../../src/domain/logo-workspace";
import { legacyLogoCostQuoteSchema, type LogoCostQuote } from "../../../src/domain/logo-jobs";
import { logoCapabilitiesSchema } from "../../../src/domain/logo-capabilities";
import { proposalFixture, proposalHeads, proposalId } from "./proposal-fixtures";
import { proposalPolicy } from "../../server/logo-vector-proposal-fixtures";

type Client = Parameters<typeof createVectorProposalController>[0]["client"];
const controllers: VectorProposalController[] = [];
afterEach(() => { for (const controller of controllers.splice(0)) controller.dispose(); });
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}
async function fixture() {
  const source = proposalFixture(), { ownerId, projectId } = source.revision, scope = { ownerId, projectId };
  let now = Date.parse("2026-10-30T00:00:00Z"), current = true, sequence = 100;
  const account = { status: "ready" as const, userId: ownerId, generation: 1 };
  const memory = createLogoDraftMemory(); memory.bind({ ownerId, generation: 1 });
  const workspace = logoWorkspaceV2Schema.parse({ version: 2, ...scope, heads: proposalHeads,
    stages: { brief_references: { stage: "brief_references", id: source.brief.id, revision: 1 }, concepts: { stage: "concepts", id: proposalId(90), revision: 1 },
      vector: { stage: "vector", id: proposalId(91), revision: 1 }, refinements: null, directions: null, deliverables: null }, approvedLogo: null, staleStages: [],
    capabilities: Object.fromEntries(["save", "upload", "generate", "convert", "export"].map(key => [key, { status: "available" }])) });
  memory.set(projectId, { workspace, base: workspace.heads, brief: { name: "Synthetic", activity: "Fixture", audience: "", personality: "", logoTypes: ["combination"] },
    references: [], dirty: false, conflict: false, pendingIntent: null, pendingMutation: null, pendingExport: null });
  const context: NonNullable<ProposalEditorContext> = { workspace, ready: true, targetId: source.document.components[0]!.id,
    detail: { revision: source.revision, document: source.document, sourcePreview: { id: proposalId(92), reference: source.revision.sourcePreview,
      verification: { status: "verified", contentHash: source.revision.sourcePreview.contentHash, mimeType: "image/png", byteLength: 1, checkedAt: new Date(now).toISOString() },
      purpose: "brand_asset", sourceReceiptId: proposalId(93), rightsEvidenceId: null, publicationState: "committed" } } };
  function quote(request: Parameters<Client["quoteLogoOperation"]>[0]) {
    const policy = proposalPolicy();
    return legacyLogoCostQuoteSchema.parse({ id: proposalId(sequence++), ...scope, request, expected: request.expected, inputHash: "a".repeat(64), policyIdentity: "b".repeat(64),
      handlerVersion: "logo-vector-propose-v1", provider: "openai", model: "gpt-6.1-sol", engine: null, conceptPlan: null, targetSlotIds: [], textPolicy: policy,
      estimatedCostMicrousd: policy.maximumCostMicrousd, maxCostMicrousd: policy.maximumCostMicrousd, externalProviderCostMicrousd: policy.maximumCostMicrousd,
      expiresAt: new Date(now + 10_000).toISOString() });
  }
  const client = {
    getLogoCapabilities: vi.fn<Client["getLogoCapabilities"]>(async () => logoCapabilitiesSchema.parse({ ...scope, observedAt: new Date(now).toISOString(),
      operations: Object.fromEntries(["identity.logo_concept", "identity.logo_refine", "identity.logo_vectorize", "identity.logo_directions", "identity.logo_export", "identity.logo_vector_propose"]
        .map(operation => [operation, { status: "available", expiresAt: new Date(now + 30_000).toISOString() }])) })),
    listPendingVectorProposalRequests: vi.fn<Client["listPendingVectorProposalRequests"]>(async () => ({ ...scope, items: [], nextCursor: null })),
    listLogoVectorProposals: vi.fn<Client["listLogoVectorProposals"]>(async () => ({ ...scope, items: [], nextCursor: null })),
    readVectorProposalRequest: vi.fn<Client["readVectorProposalRequest"]>(async () => null),
    closeVectorProposalRequest: vi.fn<Client["closeVectorProposalRequest"]>(async () => null),
    quoteLogoOperation: vi.fn<Client["quoteLogoOperation"]>(async request => quote(request)),
    admitLogoOperation: vi.fn<Client["admitLogoOperation"]>(async () => { throw Error("Synthetic lost acknowledgement"); }),
  };
  const applicationClient = createLogoVectorProposalApplicationClient(account, projectId, () => current, vi.fn(), vi.fn(async () => { throw Error("Unexpected application"); }));
  const newKey = vi.fn(() => proposalId(sequence++));
  const controller = createVectorProposalController({ account, projectId, memory, client, applicationClient, isCurrent: () => current, now: () => now, newKey, onApplied: vi.fn() });
  controllers.push(controller); controller.updateContext(context); await controller.refresh(); controller.setForm("Make the symbol blue.", [context.targetId]);
  return { controller, context, client, memory, projectId, quote, newKey, advance(ms: number) { now += ms; }, switchOwner() { current = false; } };
}

describe("vector proposal estimate and deliberate generation", () => {
  it("prepares without generation and admits only once when Generate is pressed twice", async () => {
    const f = await fixture(); await f.controller.prepare();
    expect(f.controller.canConfirm()).toBe(true); expect(f.client.admitLogoOperation).not.toHaveBeenCalled(); expect(f.newKey).not.toHaveBeenCalled();
    const quote = f.controller.getSnapshot().quote!;
    await Promise.all([f.controller.confirm(), f.controller.confirm()]);
    expect(f.client.admitLogoOperation).toHaveBeenCalledTimes(1); expect(f.newKey).toHaveBeenCalledTimes(1);
    const pending = f.memory.getVectorProposal(f.projectId)!.pendingGeneration!;
    expect(pending.quote.id).toBe(quote.id); expect(pending.input).toEqual(f.client.admitLogoOperation.mock.calls[0]![0]);
    expect(f.controller.canPrepare()).toBe(false);
    await f.controller.prepare(); expect(f.client.admitLogoOperation).toHaveBeenCalledTimes(1);
    expect(f.memory.getVectorProposal(f.projectId)!.pendingGeneration).toEqual(pending);
    f.advance(10_001); f.controller.expireQuote();
    expect(f.controller.getSnapshot().notice).toBeNull(); expect(f.memory.getVectorProposal(f.projectId)!.pendingGeneration).toEqual(pending);
  });

  it.each(["resolve", "reject"] as const)("keeps typing available and ignores a cancelled estimate's late %s", async outcome => {
    const f = await fixture(), old = deferred<LogoCostQuote>(); let oldSignal: AbortSignal | undefined;
    f.client.quoteLogoOperation.mockImplementationOnce(async (_request, signal) => { oldSignal = signal; return old.promise; });
    const first = f.controller.prepare(); await vi.waitFor(() => expect(f.client.quoteLogoOperation).toHaveBeenCalledTimes(1));
    const oldQuote = f.quote(f.client.quoteLogoOperation.mock.calls[0]![0]);
    f.controller.setForm("Make the symbol green.", [f.context.targetId]);
    expect(oldSignal?.aborted).toBe(true); expect(f.controller.getSnapshot().session?.instruction).toBe("Make the symbol green.");
    await f.controller.prepare(); const currentQuote = f.controller.getSnapshot().quote;
    expect(currentQuote?.request).toMatchObject({ instruction: "Make the symbol green." });
    if (outcome === "resolve") old.resolve(oldQuote); else old.reject(Error("Late estimate failure"));
    await first; expect(f.controller.getSnapshot().quote).toEqual(currentQuote); expect(f.controller.getSnapshot().error).toBeNull();
    expect(f.client.admitLogoOperation).not.toHaveBeenCalled();
  });

  it("rejects expired and changed saved inputs while preserving the requested change", async () => {
    const f = await fixture(); await f.controller.prepare(); f.advance(10_001); f.controller.expireQuote();
    expect(f.controller.getSnapshot().notice).toContain("This request expired"); expect(f.controller.canConfirm()).toBe(false);
    await f.controller.confirm(); expect(f.client.admitLogoOperation).not.toHaveBeenCalled();
    expect(f.controller.getSnapshot().session?.instruction).toBe("Make the symbol blue.");
    await f.controller.prepare(); expect(f.controller.canConfirm()).toBe(true);
    f.controller.updateContext({ ...f.context, workspace: { ...f.context.workspace, heads: { ...f.context.workspace.heads, workspaceRevision: 2 } } });
    expect(f.controller.getSnapshot().quote).toBeNull(); await f.controller.confirm(); expect(f.client.admitLogoOperation).not.toHaveBeenCalled();
    await f.controller.prepare(); expect(f.controller.getSnapshot().quote?.expected.workspaceRevision).toBe(2);
  });

  it("retains the draft after an estimate failure and recovers only on another prepare", async () => {
    const f = await fixture(); f.client.quoteLogoOperation.mockRejectedValueOnce(Error("Synthetic estimate outage"));
    await f.controller.prepare(); expect(f.controller.getSnapshot().error).toContain("then try again");
    expect(f.controller.getSnapshot().session?.instruction).toBe("Make the symbol blue.");
    expect(f.client.quoteLogoOperation).toHaveBeenCalledTimes(1); expect(f.client.admitLogoOperation).not.toHaveBeenCalled();
    await f.controller.prepare(); expect(f.controller.canConfirm()).toBe(true); expect(f.client.quoteLogoOperation).toHaveBeenCalledTimes(2);
    expect(f.client.admitLogoOperation).not.toHaveBeenCalled();
  });

  it("keeps explicit estimate refresh available after capability freshness expires", async () => {
    const f = await fixture(); await f.controller.prepare(); f.advance(30_001); f.controller.expireQuote(); f.controller.expireAvailability();
    expect(f.controller.canPrepare()).toBe(false); expect(f.controller.canRefreshEstimate()).toBe(true); expect(f.controller.canConfirm()).toBe(false);
    await f.controller.prepare(); expect(f.controller.canConfirm()).toBe(true);
    expect(f.client.admitLogoOperation).not.toHaveBeenCalled();
  });

  it("does not replace an active Generate check with an estimate-expiry notice", async () => {
    const f = await fixture(); await f.controller.prepare();
    const capabilities = await f.client.getLogoCapabilities(), response = deferred<typeof capabilities>();
    f.client.getLogoCapabilities.mockImplementationOnce(async () => response.promise);
    const generating = f.controller.confirm(); await vi.waitFor(() => expect(f.client.getLogoCapabilities).toHaveBeenCalledTimes(4));
    f.advance(10_001); f.controller.expireQuote();
    expect(f.controller.getSnapshot().phase).toBe("admitting"); expect(f.controller.getSnapshot().notice).toBeNull();
    response.resolve(capabilities); await generating;
    expect(f.client.admitLogoOperation).not.toHaveBeenCalled(); expect(f.newKey).not.toHaveBeenCalled();
  });

  it("ignores an estimate returned after account ownership changes", async () => {
    const f = await fixture(), estimate = deferred<LogoCostQuote>();
    f.client.quoteLogoOperation.mockImplementationOnce(async () => estimate.promise);
    const pending = f.controller.prepare(); await vi.waitFor(() => expect(f.client.quoteLogoOperation).toHaveBeenCalledTimes(1));
    const quote = f.quote(f.client.quoteLogoOperation.mock.calls[0]![0]); f.switchOwner(); estimate.resolve(quote); await pending;
    expect(f.controller.getSnapshot().quote).toBeNull(); expect(f.controller.canConfirm()).toBe(false);
    await f.controller.confirm(); expect(f.client.admitLogoOperation).not.toHaveBeenCalled();
  });
});
