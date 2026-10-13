import { describe, expect, it } from "vitest";
import { enqueueStandaloneNamesSchema, standaloneNamesJobSchema, standaloneNamesOverviewSchema, standaloneNamesResultSchema, validateStandaloneNames } from "../../src/domain/standalone-names";
import { intent, jobFixture, other, owner, proposal, resultFixture } from "../fixtures/standalone-names";
describe("standalone AI naming contracts", () => {
  it("requires explicit usage acceptance without a client owner or project", () => {
    expect(enqueueStandaloneNamesSchema.safeParse(intent).success).toBe(true);
    for (const patch of [{ ownerId: owner }, { projectId: owner }, { acceptSubscriptionUsage: false }, { acceptedPolicyIdentity: "" }]) expect(enqueueStandaloneNamesSchema.safeParse({ ...intent, ...patch }).success).toBe(false);
  });
  it("rejects duplicate/oversized refinement choices and client source-name claims", () => {
    for (const patch of [{ candidateIndexes: [0, 0] }, { candidateIndexes: [20] }, { candidateIndexes: [0, 1, 2, 3, 4, 5] }, { sourceNames: ["Forged"] }]) expect(enqueueStandaloneNamesSchema.safeParse({ ...intent, refinement: { sourceJobId: owner, candidateIndexes: [0], instruction: "Shorter", ...patch } }).success).toBe(false);
  });
  it("keeps only independently valid distinct proposals without padding", () => {
    const result = validateStandaloneNames([proposal, { ...proposal, value: "FIXTURE-CLAY" }, { ...proposal, value: "\u0000" }, { ...proposal, value: "Old Name" }], ["old name"]);
    expect(result).toEqual({ candidates: [proposal], rejectedCount: 3 });
    expect(validateStandaloneNames(Array.from({ length: 30 }, (_, i) => ({ ...proposal, value: `Fixture ${i}` }))).candidates).toHaveLength(20);
  });
  it("requires a completed job result, valid retained indexes and one owner", () => {
    expect(standaloneNamesJobSchema.safeParse({ ...jobFixture(), state: "succeeded" }).success).toBe(false);
    expect(standaloneNamesJobSchema.safeParse({ ...jobFixture("succeeded"), savedIndexes: [19] }).success).toBe(false);
    expect(standaloneNamesOverviewSchema.safeParse({ ownerId: other, availability: { status: "unavailable", reason: "setup_required" }, jobs: [jobFixture()], hasMore: false }).success).toBe(false);
    expect(standaloneNamesResultSchema.safeParse({ ...resultFixture(), candidates: [proposal, proposal] }).success).toBe(false);
  });
});
