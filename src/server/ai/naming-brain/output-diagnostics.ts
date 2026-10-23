import { z } from "zod";
import { NAMING_BRAIN_INITIAL_RAW_CAP, type NamingRole, type NamingStageKey } from "../../../domain/naming-brain";
import { ManagedEvidenceError } from "./history";

export type NamingOutputDiagnostic = {
  role: NamingRole; stage: NamingStageKey; phase: "extraction" | "schema" | "semantic";
  reason: "final_output_invalid" | "output_limit" | "schema_invalid" | "assignment_total_mismatch" | "semantic_invalid";
  expectedTotal?: number; observedTotal?: number;
};

/** Only fixed classifications and bounded arithmetic leave this boundary. Never
 * include raw errors, validation paths, model JSON or private brief text. */
export function namingOutputDiagnostic(error: unknown, role: NamingRole, stage: NamingStageKey, value: unknown): NamingOutputDiagnostic {
  if (error instanceof ManagedEvidenceError) return { role, stage, phase: "extraction", reason: error.code === "output_limit" ? "output_limit" : "final_output_invalid" };
  if (error instanceof z.ZodError) return { role, stage, phase: "schema", reason: "schema_invalid" };
  if (role === "director" && error instanceof Error && error.message === "Assignment targets must respect the admitted initial/gap total") {
    const result = z.object({ round: z.literal("initial"), assignments: z.array(z.object({ targetCount: z.number().int().min(1).max(150) })).min(1).max(30) }).safeParse(value);
    if (result.success) return { role, stage, phase: "semantic", reason: "assignment_total_mismatch", expectedTotal: NAMING_BRAIN_INITIAL_RAW_CAP,
      observedTotal: result.data.assignments.reduce((sum, row) => sum + row.targetCount, 0) };
  }
  return { role, stage, phase: "semantic", reason: "semantic_invalid" };
}
