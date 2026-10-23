import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { z } from "zod";
import { namingOutputDiagnostic } from "../../src/server/ai/naming-brain/output-diagnostics";
import { ManagedEvidenceError } from "../../src/server/ai/naming-brain/history";

describe("Redacted Naming output diagnostics", () => {
  it("identifies the retained149 versus150 semantic shape without retaining its content", () => {
    const value = { round: "initial", assignments: Array.from({ length: 16 }, (_, index) => ({ targetCount: index < 5 ? 10 : 9, direction: "PRIVATE_SYNTHETIC_TEXT" })) };
    expect(namingOutputDiagnostic(new Error("Assignment targets must respect the admitted initial/gap total"), "director", "creation", value))
      .toEqual({ role: "director", stage: "creation", phase: "semantic", reason: "assignment_total_mismatch", expectedTotal: 150, observedTotal: 149 });
  });
  it("separates schema and extraction failures using fixed classifications", () => {
    const schemaError = z.literal(10).safeParse("PRIVATE_SYNTHETIC_TEXT");
    expect(namingOutputDiagnostic(schemaError.error, "director", "creation", {})).toEqual({ role: "director", stage: "creation", phase: "schema", reason: "schema_invalid" });
    expect(namingOutputDiagnostic(new ManagedEvidenceError("output_limit"), "researcher", "creation", {})).toEqual({ role: "researcher", stage: "creation", phase: "extraction", reason: "output_limit" });
  });
  it("does not copy arbitrary errors, JSON or unbounded counts into diagnostics", () => {
    for (const value of [null, { round: "initial", assignments: [{ targetCount: 1e100, direction: "PRIVATE_SYNTHETIC_TEXT" }] }]) {
      const diagnostic = namingOutputDiagnostic(new Error("PRIVATE_SYNTHETIC_TEXT"), "director", "creation", value);
      expect(diagnostic).toEqual({ role: "director", stage: "creation", phase: "semantic", reason: "semantic_invalid" });
      expect(JSON.stringify(diagnostic)).not.toContain("PRIVATE");
    }
  });
});
