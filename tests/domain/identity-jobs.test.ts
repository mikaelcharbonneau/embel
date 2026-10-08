import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { identityGenerationIntentSchema, identityAvailabilitySchema, identityStepOutputSchema, identityGeneratedSystemReceiptSchema, identityGeneratedSystemBindingSchema, identityBatchResultSchema, identityFulfillmentSchema, pendingIdentityFulfillment, collectIdentityBatchResult, validateIdentityGeneratedSystemBinding, IDENTITY_STEP_OUTPUT_MAX_BYTES } from "../../src/domain/identity-jobs";
import { IMAGE_MODEL } from "../../src/domain/providers";
import { contextSnapshotSchema } from "../../src/domain/projects";
import { createIdentityInputSnapshot, initialIdentityPreferences, identitySystemVersionSchema } from "../../src/domain/project-identity";
import { createIdentityReferenceSnapshot } from "../../src/domain/identity-references";

export const intent = { expectedProjectRevision: 1, expectedReferenceRevision: 1, expectedPreferencesRevision: 0, idempotencyKey: "identity-local-fixture-001", acceptedPolicyIdentity: "a".repeat(64), acceptedMaxCostMicrousd: 0 };
describe("Identity admission contracts", () => {
  it("accepts only revision-bound consent to an existing server policy", () => {
    expect(identityGenerationIntentSchema.parse(intent)).toEqual(intent);
  });
  it.each(["ownerId", "projectId", "provider", "model", "billingMode", "targetCount", "systems", "paidCallsApproved"])("rejects browser authority over %s", field => {
    expect(identityGenerationIntentSchema.safeParse({ ...intent, [field]: true }).success).toBe(false);
  });
  it.each([{ expectedProjectRevision: 0 }, { expectedReferenceRevision: -1 }, { expectedPreferencesRevision: 0.5 }, { acceptedMaxCostMicrousd: -1 }, { acceptedMaxCostMicrousd: Number.MAX_SAFE_INTEGER + 1 }, { idempotencyKey: "short" }, { acceptedPolicyIdentity: "unknown-policy" }])("rejects invalid bounds", patch => {
    expect(identityGenerationIntentSchema.safeParse({ ...intent, ...patch }).success).toBe(false);
  });
  it("cannot represent available generation before its pipeline is implemented", () => {
    const unavailable = { ownerId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", projectId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", status: "unavailable", operation: "identity.image", requestedModel: IMAGE_MODEL, reason: "pipeline_not_implemented" };
    expect(identityAvailabilitySchema.parse(unavailable)).toEqual(unavailable);
    expect(identityAvailabilitySchema.safeParse({ ...unavailable, status: "available" }).success).toBe(false);
  });
});
// Synthetic immutable records only. No provider, file byte, lease or handler claim.
const ownerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", projectId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const uuid = (n: number) => `cccccccc-cccc-4ccc-8ccc-${String(n).padStart(12, "0")}`;
const timestamp = "2026-10-04T00:00:00Z", batchId = uuid(1), jobId = uuid(2);
const context = contextSnapshotSchema.parse({ description: "Explicit synthetic brand", selectedName: "Fixture", intake: { suppliedName: "Fixture" } });
const references = createIdentityReferenceSnapshot({ ownerId, projectId, referenceRevision: 1, selectedReferenceCount: 1, capturedAt: timestamp, selected: [{
  reference: { id: uuid(900), ownerId, projectId, createdAt: timestamp, media: { assetId: uuid(901), versionId: uuid(902), ownerId, projectId, contentHash: "f".repeat(64), purpose: "reference_media", mimeType: "image/png" }, source: "user_supplied", attribution: { label: "Local reference", creator: null, sourceUrl: null, rightsNote: null }, relevantElements: [], tags: [] },
  reaction: { referenceId: uuid(900), ownerId, projectId, revision: 1, ensemble: true, elements: [], updatedAt: timestamp },
}] });
const frozenInput = createIdentityInputSnapshot({ ownerId, projectId, scope: "visual_identity_only", projectRevision: 1, context, referenceSnapshot: references, preferencesRevision: 0, preferences: initialIdentityPreferences(context), capturedAt: timestamp });
function asset(n: number) { return { assetId: uuid(n + 100), versionId: uuid(n + 200), ownerId, projectId, contentHash: n.toString(16).padStart(64, "0"), purpose: "brand_asset" as const, mimeType: "image/png" }; }
function system(n = 1, stepKey = "identity.fixture.step") {
  const direction = { direction: "Synthetic coordinated direction", usageNotes: "Proposal specification only" };
  return identitySystemVersionSchema.parse({ id: uuid(n + 10), ownerId, projectId, createdAt: timestamp, input: frozenInput,
    source: { kind: "generated", batchId, jobId, stepKey }, components: { logo: direction, colors: { swatches: [{ key: "primary", name: "Primary", hex: "#123456" }], usageNotes: "Synthetic palette" },
      typography: { styles: [{ key: "body", role: "Body", family: "Synthetic family", weight: 400, style: "normal" }], usageNotes: "No font files implied" }, graphics: direction, imagery: direction, composition: direction },
    board: { asset: asset(n), depictsSystemVersionId: uuid(n + 10), staleComponents: [] }, productionFiles: [] });
}
function batch() { return { id: batchId, ownerId, projectId, jobId, targetCount: 3 as const, input: clone(frozenInput) }; }
function output(systems = [system()], stepKey = "identity.fixture.step") { return { identity: { version: 1, operation: "identity.image", ownerId, projectId, batchId, jobId, stepKey, targetCount: 3, input: clone(frozenInput), systems: clone(systems) } }; }
function binding(n = 1, stepKey = "identity.fixture.step") {
  const generated = system(n, stepKey);
  return { batch: batch(), step: { ownerId, projectId, jobId, stepKey, state: "succeeded", completedAt: timestamp, output: output([generated], stepKey) },
    receipt: { version: 1, ownerId, projectId, batchId, jobId, stepKey, outputIndex: 0, systemVersionId: generated.id, board: clone(generated.board.asset) }, system: clone(generated) };
}
const clone = <T>(value: T): T => structuredClone(value);
function reorder(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reorder);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).reverse().map(([key, child]) => [key, reorder(child)]));
  return value;
}

describe("Identity completed-step output and source binding", () => {
  it("binds exact complete generated output to its loaded batch, step, receipt and board", () => {
    const value = binding(), before = clone(value);
    const parsed = validateIdentityGeneratedSystemBinding(value);
    expect(parsed).toEqual(value); expect(value).toEqual(before); expect(Object.isFrozen(value)).toBe(false);
    expect(Object.isFrozen(parsed)).toBe(true); expect(Object.isFrozen(parsed.system.components)).toBe(true);
    expect(parsed.step.output.identity.systems[0]).toEqual(parsed.system); expect(parsed.system.productionFiles).toEqual([]);
    expect(parsed.system).not.toHaveProperty("productionReady"); expect(parsed.receipt.board).not.toHaveProperty("fileState");
  });
  it.each(["logo", "colors", "typography", "graphics", "imagery", "composition"])("rejects a system missing %s", component => {
    const value = clone(output()); delete (value.identity.systems[0]!.components as Record<string, unknown>)[component];
    expect(identityStepOutputSchema.safeParse(value).success).toBe(false);
  });
  it("does not treat a manual refinement as another generated system", () => {
    const value = clone(output()), item = value.identity.systems[0]!;
    item.source = { kind: "manual_edit", baseSystemVersionId: uuid(88), changeId: uuid(89), component: "colors", editedAtProjectRevision: 1, editedAtReferenceRevision: 1, editedAtPreferencesRevision: 0 };
    item.board.depictsSystemVersionId = uuid(88); item.board.staleComponents = ["colors"];
    expect(identitySystemVersionSchema.safeParse(item).success).toBe(true);
    expect(identityStepOutputSchema.safeParse(value).success).toBe(false);
  });
  it.each(["ownerId", "projectId", "batchId", "jobId", "stepKey"])("rejects a mismatched output envelope %s", field => {
    const value = clone(binding()); Object.assign(value.step.output.identity, { [field]: field === "stepKey" ? "other.step" : uuid(90) });
    expect(identityGeneratedSystemBindingSchema.safeParse(value).success).toBe(false);
  });
  it.each(["ownerId", "projectId", "batchId", "jobId", "stepKey", "systemVersionId", "outputIndex", "board"])("rejects a mismatched immutable receipt %s", field => {
    const value = clone(binding()); Object.assign(value.receipt, { [field]: field === "stepKey" ? "other.step" : field === "outputIndex" ? 1 : field === "board" ? asset(90) : uuid(90) });
    expect(identityGeneratedSystemBindingSchema.safeParse(value).success).toBe(false);
  });
  it.each(["in_flight", "failed", "ambiguous", "running", "cancelled", "needs_reconciliation"])("does not promote %s step evidence", state => {
    const value = clone(binding()); value.step.state = state;
    expect(identityGeneratedSystemBindingSchema.safeParse(value).success).toBe(false);
  });
  it("requires the actual completed timestamp and complete output, not generic job success", () => {
    const value = clone(binding());
    expect(identityGeneratedSystemBindingSchema.safeParse({ ...value, step: { ...value.step, completedAt: null } }).success).toBe(false);
    expect(identityGeneratedSystemBindingSchema.safeParse({ ...value, step: { ownerId, projectId, jobId, state: "succeeded" } }).success).toBe(false);
    expect(identityStepOutputSchema.safeParse({ state: "succeeded", targetCount: 3 }).success).toBe(false);
    expect(identityStepOutputSchema.safeParse({ ...output(), provider: "browser-asserted" }).success).toBe(false);
  });
  it("compares complete immutable manifests, not only their IDs or six-key presence", () => {
    const value = clone(binding()); value.system.components.logo.direction = "Different system with the same ID";
    expect(identityGeneratedSystemBindingSchema.safeParse(value).success).toBe(false);
  });
  it.each(["scope", "projectRevision", "referenceRevision", "preferencesRevision", "captureTime", "attribution"])("rejects changed full input even with an unchanged material basis: %s", field => {
    const value = clone(binding()), input = value.step.output.identity.input;
    if (field === "scope") input.scope = "complete_brand";
    if (field === "projectRevision") input.projectRevision = 2;
    if (field === "referenceRevision") input.referenceSnapshot.referenceRevision = 2;
    if (field === "preferencesRevision") input.preferencesRevision = 1;
    if (field === "captureTime") input.capturedAt = "2026-10-04T00:00:01Z";
    if (field === "attribution") input.referenceSnapshot.selected[0]!.reference.attribution.label = "Different attribution";
    expect(input.basis).toEqual(frozenInput.basis);
    expect(identityGeneratedSystemBindingSchema.safeParse(value).success).toBe(false);
  });
  it("accepts canonical structural equality independent of JSON object key insertion order", () => {
    expect(validateIdentityGeneratedSystemBinding(reorder(binding()))).toEqual(binding());
  });
  it.each(["provider", "model", "licenseVerified", "vectorStatus", "downloadUrl"])("does not grant trusted receipt authority to extra %s claims", field => {
    expect(identityGeneratedSystemReceiptSchema.safeParse({ ...binding().receipt, [field]: true }).success).toBe(false);
  });
});

describe("actual target-three fulfillment independent of generic job outcomes", () => {
  it.each([[0, "none"], [1, "partial"], [2, "partial"], [3, "complete"]] as const)("derives %i accepted systems as %s", (count, status) => {
    const rows = Array.from({ length: count }, (_, n) => binding(n + 1, `identity.fixture.${n}`));
    const result = collectIdentityBatchResult(batch(), rows);
    expect(result.fulfillment).toEqual({ targetCount: 3, acceptedCount: count, status }); expect(result.systems).toHaveLength(count);
    expect(Object.isFrozen(result.systems)).toBe(true); expect(result).not.toHaveProperty("jobState");
    expect(result.systems.every(item => item.productionFiles.length === 0)).toBe(true);
  });
  it("represents pending only explicitly before collected results exist", () => {
    expect(pendingIdentityFulfillment()).toEqual({ targetCount: 3, acceptedCount: 0, status: "pending" });
    expect(identityFulfillmentSchema.safeParse({ targetCount: 3, acceptedCount: 1, status: "pending" }).success).toBe(false);
    const result = collectIdentityBatchResult(batch(), []);
    expect(identityBatchResultSchema.safeParse({ ...result, fulfillment: pendingIdentityFulfillment() }).success).toBe(false);
  });
  it.each([{ targetCount: 2, acceptedCount: 2, status: "complete" }, { targetCount: 3, acceptedCount: 0, status: "complete" }, { targetCount: 3, acceptedCount: 3, status: "partial" }, { targetCount: 3, acceptedCount: 4, status: "complete" }])("rejects count/status claims %j", fulfillment => {
    expect(identityFulfillmentSchema.safeParse(fulfillment).success).toBe(false);
  });
  it("does not infer three choices from a success claim or discard retained complete steps", () => {
    const result = collectIdentityBatchResult(batch(), [binding()]);
    expect(result.fulfillment).toMatchObject({ acceptedCount: 1, status: "partial" });
    expect(identityBatchResultSchema.safeParse({ ...result, fulfillment: { targetCount: 3, acceptedCount: 3, status: "complete" } }).success).toBe(false);
    for (const state of ["succeeded", "failed", "cancelled", "needs_reconciliation"]) expect(identityBatchResultSchema.safeParse({ ...result, jobState: state }).success).toBe(false);
  });
  it("rejects duplicate system IDs across distinct completed steps and more than three outputs", () => {
    const first = binding(), second = clone(binding(2, "identity.other"));
    second.system.id = first.system.id; second.system.board.depictsSystemVersionId = first.system.id;
    second.receipt.systemVersionId = first.system.id; second.step.output.identity.systems = [second.system];
    expect(() => collectIdentityBatchResult(batch(), [first, second])).toThrow();
    expect(() => collectIdentityBatchResult(batch(), [binding(1), binding(2), binding(3), binding(4)])).toThrow();
    expect(identityStepOutputSchema.safeParse(output([system(1), system(2), system(3), system(4)])).success).toBe(false);
  });
  it.each(["version", "bytes"])("rejects duplicate board %s across otherwise distinct systems", kind => {
    const first = binding(), second = clone(binding(2, "identity.other"));
    if (kind === "version") second.system.board.asset = clone(first.system.board.asset);
    else second.system.board.asset.contentHash = first.system.board.asset.contentHash;
    second.receipt.board = second.system.board.asset; second.step.output.identity.systems = [second.system];
    expect(() => collectIdentityBatchResult(batch(), [first, second])).toThrow();
  });
  it.each(["version", "bytes"])("rejects a different system's board %s masquerading as a production file", kind => {
    const first = binding(), second = clone(binding(2, "identity.other"));
    const file = kind === "version" ? clone(first.system.board.asset) : { ...asset(80), contentHash: first.system.board.asset.contentHash };
    second.system.productionFiles.push({ component: "logo", role: "logo-file", asset: file }); second.step.output.identity.systems = [second.system];
    expect(() => collectIdentityBatchResult(batch(), [first, second])).toThrow();
  });
  it("allows shared exact production metadata but rejects conflicting claims for an immutable version", () => {
    const first = clone(binding()), second = clone(binding(2, "identity.other")), file = asset(80);
    for (const row of [first, second]) { row.system.productionFiles.push({ component: "graphics", role: "pattern", asset: clone(file) }); row.step.output.identity.systems = [row.system]; }
    expect(collectIdentityBatchResult(batch(), [first, second]).fulfillment.acceptedCount).toBe(2);
    second.system.productionFiles[0]!.asset.contentHash = "e".repeat(64);
    expect(() => collectIdentityBatchResult(batch(), [first, second])).toThrow();
  });
  it("rejects a receipt from a different batch even if its complete system is otherwise valid", () => {
    expect(() => collectIdentityBatchResult({ ...batch(), id: uuid(99) }, [binding()])).toThrow();
  });
  it("requires one immutable completed record per step while accepting distinct positions in that record", () => {
    const first = clone(binding(1)), second = clone(binding(2));
    expect(identityGeneratedSystemBindingSchema.safeParse(first).success).toBe(true);
    expect(identityGeneratedSystemBindingSchema.safeParse(second).success).toBe(true);
    expect(() => collectIdentityBatchResult(batch(), [first, second])).toThrow();
    const shared = output([first.system, second.system]);
    first.step.output = clone(shared); second.step.output = clone(shared); second.receipt.outputIndex = 1;
    expect(collectIdentityBatchResult(batch(), [first, second]).fulfillment.acceptedCount).toBe(2);
    second.step.completedAt = "2026-10-04T00:00:01Z";
    expect(() => collectIdentityBatchResult(batch(), [first, second])).toThrow();
  });
});

describe("bounded immutable step output", () => {
  it("accepts the actual PostgreSQL JSONB ceiling and rejects one extra byte even when compact JSON fits", async () => {
    const db = new PGlite();
    try {
      const byteSize = async (value: unknown) => (await db.query<{ bytes: number }>("select octet_length($1::jsonb::text)::integer as bytes", [JSON.stringify(value)])).rows[0]!.bytes;
      const largeOutput = (length: number) => {
        const value = output([system(1), system(2), system(3)]), entry = clone(frozenInput.referenceSnapshot.selected[0]!);
        const selected = Array.from({ length: 100 }, (_, n) => ({ reference: { ...clone(entry.reference), id: uuid(n + 1000), attribution: { ...clone(entry.reference.attribution), rightsNote: `${"𝄞".repeat(length)}x` } }, reaction: { ...clone(entry.reaction), referenceId: uuid(n + 1000) } }));
        const input = createIdentityInputSnapshot({ ...frozenInput, referenceSnapshot: createIdentityReferenceSnapshot({ ...frozenInput.referenceSnapshot, selectedReferenceCount: 100, selected }) });
        value.identity.input = input; for (const item of value.identity.systems) item.input = input;
        value.identity.systems[0]!.components.logo.usageNotes = "";
        return value;
      };
      const baseBytes = await byteSize(largeOutput(0));
      // A four-byte code point occurs in all 100 references in each of four full inputs.
      const value = largeOutput(Math.floor((IDENTITY_STEP_OUTPUT_MAX_BYTES - baseBytes) / 1600));
      const remaining = IDENTITY_STEP_OUTPUT_MAX_BYTES - await byteSize(value);
      expect(remaining).toBeGreaterThanOrEqual(0); expect(remaining).toBeLessThan(1600);
      value.identity.systems[0]!.components.logo.usageNotes = "x".repeat(remaining);
      expect(await byteSize(value)).toBe(IDENTITY_STEP_OUTPUT_MAX_BYTES);
      expect(identityStepOutputSchema.safeParse(value).success).toBe(true);
      value.identity.systems[0]!.components.logo.usageNotes += "x";
      expect(await byteSize(value)).toBe(IDENTITY_STEP_OUTPUT_MAX_BYTES + 1);
      expect(new TextEncoder().encode(JSON.stringify(value)).byteLength).toBeLessThan(IDENTITY_STEP_OUTPUT_MAX_BYTES);
      expect(identityStepOutputSchema.safeParse(value).success).toBe(false);
    } finally { await db.close(); }
  });
  it("keeps the existing database byte ceiling and rejects oversized complete evidence without truncation", () => {
    expect(IDENTITY_STEP_OUTPUT_MAX_BYTES).toBe(1_048_576);
    const value = clone(output([system(1), system(2), system(3)]));
    const entry = clone(frozenInput.referenceSnapshot.selected[0]!);
    const selected = Array.from({ length: 100 }, (_, n) => ({ reference: { ...clone(entry.reference), id: uuid(n + 1000), attribution: { label: "Fixture", creator: null, sourceUrl: null, rightsNote: "𝄞".repeat(2000) } }, reaction: { ...clone(entry.reaction), referenceId: uuid(n + 1000) } }));
    const largeInput = createIdentityInputSnapshot({ ...frozenInput, referenceSnapshot: createIdentityReferenceSnapshot({ ...frozenInput.referenceSnapshot, selectedReferenceCount: 100, selected }) });
    value.identity.input = largeInput;
    for (const item of value.identity.systems) item.input = largeInput;
    const before = JSON.stringify(value);
    expect(identityStepOutputSchema.safeParse(value).success).toBe(false); expect(JSON.stringify(value)).toBe(before);
  });
  it("rejects strings PostgreSQL JSONB cannot represent before any trusted persistence seam", () => {
    for (const bad of ["\u0000", "\uD800"]) {
      const value = clone(output()); value.identity.systems[0]!.components.logo.usageNotes = bad;
      expect(identityStepOutputSchema.safeParse(value).success).toBe(false);
    }
  });
});
