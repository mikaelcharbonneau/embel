import type { ClaimedJob } from "@/domain/jobs";
import type { LogoDirectionsSubscriptionPolicy, LogoResolvedDirectionInput } from "@/domain/logo-jobs";
import { directionFixture, id } from "./fixtures";
import { separatedLogoDocument } from "../logo-vector/fixtures";
export const subscriptionPolicy = (): LogoDirectionsSubscriptionPolicy => ({
  version: 1,
  billingMode: "chatgpt_subscription",
  handlerVersion: "logo-directions-v1",
  adapterVersion: "logo-directions-chatgpt-v1",
  registrationId: "fixture-account",
  model: "fixture-model",
  apiCharge: "verified_zero",
  limits: {
    maxInputBytes: 131072,
    maxOutputBytes: 262144,
    maxStreamBytes: 2097152,
    deadlineMs: 240000,
    maxObservedWebSearchCalls: 0,
    maxRequestsPerHour: 20,
    maxQueuedJobs: 3,
  },
});
export function subscriptionFixture() {
  const overview = directionFixture(),
    policy = subscriptionPolicy();
  const input: LogoResolvedDirectionInput = {
    approvedLogo: overview.currentApprovedLogo!,
    logo: separatedLogoDocument(),
    brief: {
      version: 2,
      id: id(70),
      ownerId: overview.ownerId,
      projectId: overview.projectId,
      stage: "brief_references",
      revision: 1,
      parentRevisionId: null,
      inputRevisions: [],
      inputHash: "a".repeat(64),
      payload: {
        name: "Fluid",
        activity: "Design",
        audience: "Teams",
        personality: "Clear",
        logoTypes: ["wordmark"],
        referenceSnapshotId: id(71),
        sourceProjectRevision: 1,
      },
      createdAt: "2026-10-06T00:00:00Z",
    },
    references: {
      version: 2,
      id: id(71),
      ownerId: overview.ownerId,
      projectId: overview.projectId,
      revision: 1,
      references: [],
    },
    permittedFonts: overview.fonts,
    targetCount: 3,
    inputRevisions: [
      { stage: "brief_references", id: id(70), revision: 1 },
      { stage: "vector", id: id(5), revision: 1 },
    ],
  };
  const candidate = {
    directions: [0, 1, 2].map((n) => ({
      name: `Direction ${n}`,
      palette: {
        swatches: [
          { key: "ink", name: "Ink", hex: ["#191919", "#242424", "#333333"][n]! },
          { key: "paper", name: "Paper", hex: "#FFFFFF" },
        ],
        pairings: [{ foregroundKey: "ink", backgroundKey: "paper", role: "body" }],
      },
      typography: { styles: structuredClone(overview.typography[n]!.styles) },
      graphics: { elements: [] },
    })),
  };
  const job: ClaimedJob = {
    id: id(80),
    ownerId: overview.ownerId,
    projectId: overview.projectId,
    operation: "identity.logo_directions",
    input: {
      version: 2,
      ownerId: overview.ownerId,
      projectId: overview.projectId,
      operation: "identity.logo_directions",
      requestKey: id(81),
      quoteId: id(82),
      policyIdentity: "b".repeat(64),
      handlerVersion: "logo-directions-v1",
      inputHash: "a".repeat(64),
      approvedLogoId: id(3),
      briefRevisionId: id(70),
      referenceSnapshotId: id(71),
      fontVersionIds: [id(50)],
      targetCount: 3,
      billingMode: "chatgpt_subscription",
      policy,
    },
    inputRevision: 1,
    leaseToken: id(83),
    status: "running",
    reservedCostMicrousd: 0,
    actualCostMicrousd: 0,
  };
  return { policy, input, candidate, job };
}
