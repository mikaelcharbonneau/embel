import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createVectorProposalController } from "../../src/features/logo-vector/client/proposal-controller";
import { createLogoVectorProposalApplicationClient } from "../../src/features/logo-vector/client/proposal-application";
import { createAccountLogoClient } from "../../src/components/identity/account-logo-client";
import { createLogoDraftMemory } from "../../src/components/identity/logo-draft-memory";
import { logoWorkspaceV2Schema } from "../../src/domain/logo-workspace";
import { legacyLogoCostQuoteSchema } from "../../src/domain/logo-jobs";
import { proposalRecord, proposalPolicy } from "../server/logo-vector-proposal-fixtures";
import { proposalId } from "../features/logo-vector/proposal-fixtures";

function fixture() {
 const p = proposalRecord(), account = { status: "ready" as const, userId: p.ownerId, generation: 1 };
 const memory = createLogoDraftMemory(); memory.bind({ ownerId: account.userId, generation: account.generation });
 const workspace = logoWorkspaceV2Schema.parse({ version: 2, ownerId: p.ownerId, projectId: p.projectId, heads: p.expected,
  stages: { brief_references: { stage: "brief_references", id: proposalId(90), revision: 1 }, concepts: { stage: "concepts", id: proposalId(91), revision: 1 },
   vector: { stage: "vector", id: proposalId(92), revision: 1 }, refinements: null, directions: null, deliverables: null }, approvedLogo: null, staleStages: [],
  capabilities: Object.fromEntries(["save", "upload", "generate", "convert", "export"].map(k => [k, { status: "available" }])) });
 memory.set(p.projectId, { workspace, base: workspace.heads, brief: { name: "Synthetic", activity: "Fixture", audience: "", personality: "", logoTypes: ["wordmark"] },
  references: [], dirty: false, conflict: false, pendingCreation: null, pendingIntent: null, pendingMutation: null, pendingExport: null });
 const policy = proposalPolicy(), quote = legacyLogoCostQuoteSchema.parse({ id: p.quoteId, ownerId: p.ownerId, projectId: p.projectId,
  request: { operation: "propose_vector_edit", expected: p.expected, baseVectorRevisionId: p.baseVectorRevisionId, instruction: "Rotate symbol", targetComponentIds: p.context.targetComponentIds },
  inputHash: "a".repeat(64), expected: p.expected, policyIdentity: "b".repeat(64), handlerVersion: "logo-vector-propose-v1", provider: "openai", model: "gpt-6.1-sol", engine: null,
  estimatedCostMicrousd: policy.maximumCostMicrousd, maxCostMicrousd: policy.maximumCostMicrousd, externalProviderCostMicrousd: policy.maximumCostMicrousd,
  expiresAt: "2026-10-28T00:00:00Z", conceptPlan: null, targetSlotIds: [], textPolicy: policy });
 const input = { requestKey: p.requestKey, quoteId: p.quoteId, expected: p.expected, acceptedMaxCostMicrousd: policy.maximumCostMicrousd + 1 };
 memory.setVectorProposal(p.projectId, { baseVectorRevisionId: p.baseVectorRevisionId, instruction: "Rotate symbol", targetComponentIds: p.context.targetComponentIds,
  dirty: false, pendingGeneration: { quote, input }, pendingApplication: null, selectedProposalId: null });
 let closure: unknown = null;
 const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { "content-type": "application/json" } });
 const fetcher = vi.fn<typeof fetch>(async path => {
  const url = String(path);
  if (url.includes("/requests/current?")) return json({ ownerId: p.ownerId, projectId: p.projectId, items: [], nextCursor: null });
  if (url.endsWith("/capabilities")) return json({ ownerId: p.ownerId, projectId: p.projectId, observedAt: "2026-10-27T00:00:00Z",
   operations: Object.fromEntries(["identity.logo_concept", "identity.logo_refine", "identity.logo_vectorize", "identity.logo_directions", "identity.logo_export"].map(k => [k, { status: "unavailable" }])) });
  if (url.includes("/vector-proposals?")) return json({ ownerId: p.ownerId, projectId: p.projectId, items: [], nextCursor: null });
  if (url.endsWith("/lookup")) return new Response(null, { status: 404 });
  if (url.endsWith("/cancel")) return json(closure);
  throw Error("Unexpected synthetic request");
 });
 const client = createAccountLogoClient(account, p.projectId, () => true, vi.fn(), fetcher);
 const applicationClient = createLogoVectorProposalApplicationClient(account, p.projectId, () => true, vi.fn(), fetcher);
 const controller = createVectorProposalController({ account, projectId: p.projectId, memory, client, applicationClient,
  isCurrent: () => true, now: () => Date.parse("2026-10-27T00:00:00Z"), newKey: () => { throw Error("A recovery read cannot create an intent"); }, onApplied: vi.fn() });
 return { p, input, memory, fetcher, controller, close: (value: unknown) => { closure = value; } };
}
describe("independent proposal controller uses actual bounded client contracts", () => {
 it("empty cold discovery and missing lookup retain the exact local uncertain intent without dispatch", async () => {
  const f = fixture(); try {
   await f.controller.refresh();
   expect(f.controller.getSnapshot().discoveryClear).toBe(true);
   expect(f.memory.getVectorProposal(f.p.projectId)?.pendingGeneration?.input).toEqual(f.input);
   expect(f.controller.canPrepare()).toBe(false);
   expect(f.fetcher.mock.calls.filter(c => c[1]?.method === "POST").map(c => String(c[0]))).toEqual([`/api/projects/${f.p.projectId}/logo/vector-proposals/requests/${f.input.requestKey}/lookup`]);
  } finally { f.controller.dispose(); }
 });
 it("only exact durable closure clears the local original; a substituted close reply keeps it", async () => {
  const f = fixture(); try {
   f.close({ status: "not_admitted", ownerId: f.p.ownerId, projectId: f.p.projectId, input: { ...f.input, quoteId: proposalId(999) } });
   await f.controller.stopRequest();
   expect(f.memory.getVectorProposal(f.p.projectId)?.pendingGeneration?.input).toEqual(f.input);
   f.close({ status: "not_admitted", ownerId: f.p.ownerId, projectId: f.p.projectId, input: f.input });
   await f.controller.stopRequest();
   expect(f.memory.getVectorProposal(f.p.projectId)?.pendingGeneration).toBeNull();
   const closes = f.fetcher.mock.calls.filter(c => String(c[0]).endsWith("/cancel"));
   expect(closes).toHaveLength(2);
   for (const call of closes) expect(JSON.parse(String(call[1]?.body))).toEqual(f.input);
   expect(f.fetcher.mock.calls.every(c => !String(c[0]).endsWith("/logo/requests"))).toBe(true);
  } finally { f.controller.dispose(); }
 });
});
