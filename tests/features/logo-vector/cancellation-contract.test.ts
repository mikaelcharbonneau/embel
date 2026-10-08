import { describe, expect, it } from "vitest";
import { logoVectorEditCommandSchema, logoVectorEditRequestStateSchema, sameLogoVectorEditCommand } from "../../../src/features/logo-vector/model/cancellation";
import { syntheticLogoWorkspace, logoFixtureId as id } from "../../fixtures/logo-creation";

const workspace = syntheticLogoWorkspace();
const command = { method: "saveLogoEdit", body: { requestKey: id(800), expected: workspace.heads, baseVectorRevisionId: id(801), edit: { kind: "text", componentId: "lettering", text: "Still editable" } } };
const cancelled = { status: "cancelled", ownerId: workspace.ownerId, projectId: workspace.projectId, requestKey: id(800), command };
describe("exact vector cancellation contract", () => {
  it("freezes a strictly bounded edit command and compares canonical structure", () => {
    const parsed = logoVectorEditCommandSchema.parse(command);
    expect(Object.isFrozen(parsed.body.edit)).toBe(true);
    expect(sameLogoVectorEditCommand(parsed, { body: command.body, method: command.method })).toBe(true);
    expect(sameLogoVectorEditCommand(parsed, { ...command, body: { ...command.body, edit: { ...command.body.edit, text: "Newer" } } })).toBe(false);
    expect(logoVectorEditCommandSchema.safeParse({ ...command, method: "saveLogoBrief" }).success).toBe(false);
    expect(logoVectorEditCommandSchema.safeParse({ ...command, extra: true }).success).toBe(false);
  });
  it("binds a cancellation to its exact key and never accepts not-found as a terminal proof", () => {
    expect(logoVectorEditRequestStateSchema.parse(cancelled)).toEqual(cancelled);
    expect(logoVectorEditRequestStateSchema.safeParse({ ...cancelled, requestKey: id(802) }).success).toBe(false);
    expect(logoVectorEditRequestStateSchema.safeParse({ ...cancelled, receipt: {} }).success).toBe(false);
    expect(logoVectorEditRequestStateSchema.parse({ status: "not_found" })).toEqual({ status: "not_found" });
  });
});
