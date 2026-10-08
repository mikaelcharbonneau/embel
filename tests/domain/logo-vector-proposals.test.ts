import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { logoVectorProposalRequestSchema, logoVectorProposalPayloadSchema, LOGO_VECTOR_PROPOSAL_MAX_BYTES } from "../../src/domain/logo-vector-proposals";
import { logoJsonBytes, logoManualEditSchema } from "../../src/domain/logo-vector";
import { proposalHeads, proposalId, proposed } from "../features/logo-vector/proposal-fixtures";

const request = () => ({ operation: "propose_vector_edit", expected: proposalHeads, baseVectorRevisionId: proposalId(5), instruction: "Make the selected symbol smaller.", targetComponentIds: ["synthetic-symbol"] });
describe("disconnected bounded vector proposal contracts", () => {
  it("accepts a bounded request with caller heads but no client proof or ownership", () => {
    expect(logoVectorProposalRequestSchema.parse(request())).toEqual(request());
    for (const key of ["ownerId", "document", "locks", "documentHash", "fonts", "model", "provider"]) expect(logoVectorProposalRequestSchema.safeParse({ ...request(), [key]: "forged" }).success).toBe(false);
  });
  it("rejects empty, duplicate, overlong and non-JSONB request values", () => {
    for (const patch of [{ instruction: " " }, { instruction: "x".repeat(4001) }, { instruction: "\0" }, { targetComponentIds: [] }, { targetComponentIds: ["same", "same"] }, { targetComponentIds: Array.from({ length: 65 }, (_, n) => `c${n}`) }]) expect(logoVectorProposalRequestSchema.safeParse({ ...request(), ...patch }).success).toBe(false);
  });
  it.each([
    { kind: "size", componentId: "symbol", scale: 0.7 }, { kind: "rotation", componentId: "symbol", degrees: 20 },
    { kind: "color", componentId: "symbol", fill: "#00AAFF", stroke: null }, { kind: "font", componentId: "lettering", fontVersionId: proposalId(20) },
    { kind: "spacing", componentId: "lettering", letterSpacing: 2, lineHeight: 1 },
    { kind: "arrangement", placements: [{ componentId: "symbol", transform: { x: 5, y: 5, scale: 1, rotation: 0 } }], order: ["symbol", "lettering"] },
  ])("reuses the existing single $kind command contract", edit => {
    expect(logoManualEditSchema.safeParse(edit).success).toBe(true);
    const parsed = logoVectorProposalPayloadSchema.parse(proposed(edit));
    expect(parsed).toEqual(proposed(edit)); expect(Object.isFrozen(parsed)).toBe(true);
  });
  it.each(["text", "locks", "group_components", "replace_outlined_lettering"])("does not admit %s through the manual union", kind => {
    expect(logoVectorProposalPayloadSchema.safeParse(proposed({ kind, componentId: "lettering", text: "Renamed", componentIds: [], regions: [], fontVersionId: proposalId(20) })).success).toBe(false);
  });
  it("rejects geometry, URLs, extra authority, arrays and multi-control batches", () => {
    const edit = { kind: "size", componentId: "symbol", scale: 0.7 };
    for (const key of ["paths", "svg", "url", "fontBytes", "locks", "text", "viewBox", "components", "approved"]) expect(logoVectorProposalPayloadSchema.safeParse(proposed({ ...edit, [key]: "untrusted" })).success).toBe(false);
    for (const value of [[proposed(edit)], { version: 1, status: "proposed", edits: [edit, edit], explanation: "Two edits" }, { ...proposed(edit), candidate: {} }]) expect(logoVectorProposalPayloadSchema.safeParse(value).success).toBe(false);
  });
  it.each([
    ...[NaN, Infinity, -Infinity, 0.009, 100.001].map(value => ({ label: `scale ${value}`, edit: { kind: "size", componentId: "symbol", scale: value } })),
    ...[NaN, Infinity, -Infinity, -180.001, 180.001].map(value => ({ label: `degrees ${value}`, edit: { kind: "rotation", componentId: "symbol", degrees: value } })),
    ...[NaN, Infinity, -Infinity, -1_000_000.01, 1_000_000.01].map(value => ({ label: `letterSpacing ${value}`, edit: { kind: "spacing", componentId: "lettering", letterSpacing: value, lineHeight: 1 } })),
    ...[NaN, Infinity, -Infinity, 0, 100.001].map(value => ({ label: `lineHeight ${value}`, edit: { kind: "spacing", componentId: "lettering", letterSpacing: 1, lineHeight: value } })),
    ...(["x", "y", "scale", "rotation"] as const).flatMap(key => {
      const outside = key === "scale" ? [0.009, 100.001] : key === "rotation" ? [-180.001, 180.001] : [-1_000_000.01, 1_000_000.01];
      return [NaN, Infinity, -Infinity, ...outside].map(value => ({ label: `arrangement ${key} ${value}`, edit: { kind: "arrangement", placements: [{ componentId: "symbol", transform: { x: 0, y: 0, scale: 1, rotation: 0, [key]: value } }], order: ["symbol"] } }));
    }),
  ])("rejects inherited numeric boundary violation: $label", ({ edit }) => {
    expect(logoManualEditSchema.safeParse(edit).success).toBe(false);
    expect(logoVectorProposalPayloadSchema.safeParse(proposed(edit)).success).toBe(false);
  });
  it("keeps exact finite command endpoints without enlarging manual limits", () => {
    for (const edit of [
      { kind: "size", componentId: "symbol", scale: 0.01 }, { kind: "size", componentId: "symbol", scale: 100 },
      { kind: "rotation", componentId: "symbol", degrees: -180 }, { kind: "rotation", componentId: "symbol", degrees: 180 },
      { kind: "spacing", componentId: "lettering", letterSpacing: -1_000_000, lineHeight: 1 }, { kind: "spacing", componentId: "lettering", letterSpacing: 1_000_000, lineHeight: 1 },
      { kind: "arrangement", placements: [{ componentId: "symbol", transform: { x: -1_000_000, y: 1_000_000, scale: 100, rotation: -180 } }], order: ["symbol"] },
    ]) expect(logoVectorProposalPayloadSchema.safeParse(proposed(edit)).success).toBe(true);
  });
  it("admits an explicit unsupported/no-change result without an edit", () => {
    for (const code of ["unsupported_request", "multiple_changes", "unsupported_component", "unsupported_paint", "unsupported_text", "locked_component", "no_change"]) expect(logoVectorProposalPayloadSchema.safeParse({ version: 1, status: "unsupported", code, explanation: "The original remains unchanged." }).success).toBe(true);
    expect(logoVectorProposalPayloadSchema.safeParse({ version: 1, status: "unsupported", code: "no_change", explanation: "No change", edit: { kind: "size", componentId: "symbol", scale: 1 } }).success).toBe(false);
  });
  it("bounds explanations and the entire JSONB command independently", () => {
    expect(LOGO_VECTOR_PROPOSAL_MAX_BYTES).toBe(32768);
    expect(logoVectorProposalPayloadSchema.safeParse({ ...proposed({ kind: "size", componentId: "x", scale: 1 }), explanation: "x".repeat(1001) }).success).toBe(false);
    const ids = Array.from({ length: 64 }, (_, n) => `c${n}${"x".repeat(195)}`);
    const payload = proposed({ kind: "arrangement", placements: ids.map(componentId => ({ componentId, transform: { x: 1e-300, y: 1e-300, scale: 1, rotation: 0 } })), order: ids });
    expect(logoJsonBytes(payload)).toBeGreaterThan(32768);
    expect(logoVectorProposalPayloadSchema.safeParse(payload).success).toBe(false);
  });
});
