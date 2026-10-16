import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { namingStageRequestSchema, namingBriefSnapshotSchema, validateNamingAssignmentPlan } from "../../src/domain/naming-brain";
import { factualReviewRequest, managedReviewWireBody } from "../domain/naming-brain-review-fixtures";
import { id, snapshot, research, plan, proposal } from "../domain/naming-brain-fixtures";
import { buildNamingManagedRequest, createNamingRoleRequest, namingRequestHash } from "../../src/server/ai/naming-brain/prompts";
import { createNamingBrainPolicy, createNamingRolePolicy } from "../../src/server/ai/naming-brain/policy";

describe("Naming role policy and actual provider body", () => {
  it.each([150, 200] as const)("renders the pinned complete %s-candidate review fixture without truncation", count => {
    for (const role of ["curator", "verifier"] as const) {
      const fixture = factualReviewRequest(role, count, 4000);
      const request = namingStageRequestSchema.parse(fixture.request);
      const body = buildNamingManagedRequest(request);
      expect(body).toEqual(managedReviewWireBody(fixture.request));
      expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThanOrEqual(131_072);
      expect(JSON.parse(body.input as string).review.candidates).toHaveLength(count);
    }
  });

  it("freezes a finite policy and divides creator allowance without multiplying cents", () => {
    const policy = createNamingBrainPolicy("fixture-selected-model");
    expect(Object.values(policy.stageLimits).reduce((sum, stage) => sum + stage.maximumCostMicrousd, 0)).toBe(5_000_000);
    expect(policy.aggregateAllowanceMicrousd).toBe(25_000_000);
    expect(createNamingRolePolicy(policy, "creation", "creator", 50)).toMatchObject({ sessionLimitCents: 50, maximumCostMicrousd: 500_000, allowedTools: [], nativeDelegation: false });
    expect(() => createNamingRolePolicy(policy, "gap", "verifier", 76, 1)).toThrow();
  });

  it("binds stable request hashes to the full model input and provider instructions", () => {
    const policy = createNamingBrainPolicy("fixture-selected-model");
    const request = createNamingRoleRequest({ runId: id(3), stageKey: "research", providerCallKey: "research", input: { role: "researcher", snapshot: namingBriefSnapshotSchema.parse(snapshot()) }, dependencyArtifactIds: [], policy: createNamingRolePolicy(policy, "research", "researcher") });
    expect(request.requestHash).toBe(namingRequestHash(request));
    expect(namingRequestHash({ ...request, policy: { ...request.policy, model: "changed" } })).not.toBe(request.requestHash);
  });

  it("keeps independent Creator attribution inputs and refuses an oversized complete wire before dispatch", () => {
    const policy = createNamingBrainPolicy("fixture-selected-model");
    const brief = namingBriefSnapshotSchema.parse(snapshot());
    const assignment = validateNamingAssignmentPlan(brief, research(), plan())[0]!;
    const request = createNamingRoleRequest({ runId: id(3), stageKey: "creation", providerCallKey: "creation.real", input: { role: "creator", snapshot: brief, assignment }, dependencyArtifactIds: [assignment.planArtifactId], policy: createNamingRolePolicy(policy, "creation", "creator", assignment.targetCount) });
    expect(buildNamingManagedRequest(request).agent?.multi_agent).toEqual({ enabled: false });
    expect(request.assignmentKey).toBe("real");
    expect(proposal().value).toBe("Quorv");
    const oversized = factualReviewRequest("verifier", 200, 4000, 2000);
    expect(() => buildNamingManagedRequest(oversized.request)).toThrow();
  });
});
