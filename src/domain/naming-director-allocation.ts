import { z } from "zod";

/** Application-specified counts; the Director supplies directions, never arithmetic. */
export const namingDirectorAllocationSchema = z.strictObject({
  version: z.literal(1), assignmentCount: z.literal(15), targetCountPerAssignment: z.literal(10), totalTargets: z.literal(150),
});
export function createNamingDirectorAllocation() {
  return Object.freeze(namingDirectorAllocationSchema.parse({ version: 1, assignmentCount: 15, targetCountPerAssignment: 10, totalTargets: 150 }));
}
