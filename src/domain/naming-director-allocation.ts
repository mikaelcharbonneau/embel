import { z } from "zod";

/** Application-specified counts; the Director supplies directions, never arithmetic. */
export const namingDirectorAllocationSchema = z.strictObject({
  version: z.literal(1), assignmentCount: z.literal(15), targetCountPerAssignment: z.literal(10), totalTargets: z.literal(150),
});
export function createNamingDirectorAllocation() {
  return Object.freeze(namingDirectorAllocationSchema.parse({ version: 1, assignmentCount: 15, targetCountPerAssignment: 10, totalTargets: 150 }));
}

/** Evidence-aware future requests do not require invented unsupported directions. */
export const namingEvidenceDirectorAllocationSchema = z.strictObject({
  version: z.literal(2), maximumAssignmentCount: z.literal(15), targetCountPerAssignment: z.literal(10), maximumTotalTargets: z.literal(150),
  unavailableApproaches: z.literal("retain_original_coverage_deficit"),
});
export function createNamingEvidenceDirectorAllocation() {
  return Object.freeze(namingEvidenceDirectorAllocationSchema.parse({ version: 2, maximumAssignmentCount: 15, targetCountPerAssignment: 10, maximumTotalTargets: 150, unavailableApproaches: "retain_original_coverage_deficit" }));
}
