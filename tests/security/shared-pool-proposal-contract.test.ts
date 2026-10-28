import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { logoVectorProposalRequestStateSchema } from "../../src/features/logo-vector/model/proposal-session";
import { proposalRecord } from "../server/logo-vector-proposal-fixtures";

describe("independent retained historical proposal contract", () => {
 it("preserves a historically allowed accepted amount above the frozen quote maximum", () => {
  const proposal = proposalRecord(), policy = proposal.providerReceipt.observation.textPolicy;
  if (policy.version !== 1) throw Error("Historical proposal fixture required");
  const input = { requestKey: proposal.requestKey, quoteId: proposal.quoteId, expected: proposal.expected,
   acceptedMaxCostMicrousd: policy.maximumCostMicrousd + 1 };
  const receipt = { ownerId: proposal.ownerId, projectId: proposal.projectId, requestKey: input.requestKey,
   operation: "identity.logo_vector_propose", batchId: null, jobIds: [proposal.jobId], inputHash: "a".repeat(64) };
  const value = { ownerId: proposal.ownerId, projectId: proposal.projectId, input, proposal,
   state: { status: "succeeded", requestKey: input.requestKey, receipt, outputs: [],
    billing: { status: "recorded", confirmedMicrousd: proposal.actualCostMicrousd }, reason: null } };
  expect(logoVectorProposalRequestStateSchema.parse(value).input).toEqual(input);
  expect(logoVectorProposalRequestStateSchema.safeParse({ ...value, input: { ...input, acceptedMaxCostMicrousd: policy.maximumCostMicrousd - 1 } }).success).toBe(false);
 });
});
