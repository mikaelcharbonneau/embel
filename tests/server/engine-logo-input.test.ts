import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const doubles = vi.hoisted(() => ({
  workspace: vi.fn(), stage: vi.fn(), batch: vi.fn(), refinement: vi.fn(), snapshot: vi.fn(), liked: vi.fn(), project: vi.fn(),
}));
vi.mock("@/server/data/logo-workspace", () => ({ getLogoWorkspace: doubles.workspace, getLogoStageRevision: doubles.stage, readLogoConceptBatch: doubles.batch,
  readLogoRasterRefinement: doubles.refinement, readLogoReferenceSnapshot: doubles.snapshot }));
vi.mock("@/server/data/logo-saved-inputs", () => ({ likedUploadReferences: doubles.liked }));
vi.mock("@/server/data/projects", () => ({ getProject: doubles.project }));
import type { AuthenticatedContext } from "@/server/auth/context";
import { ApiError } from "@/server/http/errors";
import { buildLogoConceptsRunInput, buildLogoRefineRunInput, buildLogoStyleNoteRunInput, logoEngineEnabled } from "@/server/engine/logo";

// The server freezes each Logo run from the person's own saved Logo work; the browser only names what to draw.
const owner = "aaaaaaaa-1111-4111-8111-111111111111", project = "bbbbbbbb-2222-4222-8222-222222222222";
const briefId = "eeeeeeee-5555-4555-8555-555555555555", snapshotId = "eeeeeeee-5555-4555-8555-555555555556", batchId = "ffffffff-6666-4666-8666-666666666666";
const heads = { projectRevision: 4, referenceRevision: 1, preferencesRevision: 0, workspaceRevision: 3, stageRevisions: { brief_references: 2, concepts: 1, vector: 0, refinements: 0, directions: 0, deliverables: 0 } };
const payload = { name: "Levain & Co", activity: "Office bread", audience: "Office teams", personality: "Warm\nLiked logo style: rounded monoline", logoTypes: ["wordmark", "pictorial"],
  referenceSnapshotId: snapshotId, sourceProjectRevision: 4 };
const ref = (seed: string) => ({ ownerId: owner, projectId: project, assetId: `11111111-7777-4777-8777-77777777777${seed}`, versionId: `22222222-7777-4777-8777-77777777777${seed}`, contentHash: seed.repeat(64) });
const receipt = (seed: string) => ({ id: `33333333-7777-4777-8777-77777777777${seed}`, reference: ref(seed), purpose: "brand_asset", sourceReceiptId: `44444444-7777-4777-8777-77777777777${seed}`, rightsEvidenceId: null,
  publicationState: "committed", verification: { status: "verified", checkedAt: "2026-11-09T20:00:00.000Z", contentHash: seed.repeat(64), mimeType: "image/png", byteLength: 2048 } });
const attempt = (id: string, state: string, preview: unknown = null) => ({ id, state, preview, billing: { status: "recorded", confirmedMicrousd: 0 }, requestKey: batchId });
const slots = [
  { id: "55555555-8888-4888-8888-000000000000", ordinal: 0, type: "wordmark", attempts: [attempt("66666666-8888-4888-8888-000000000000", "succeeded", receipt("1"))] },
  { id: "55555555-8888-4888-8888-000000000001", ordinal: 1, type: "pictorial", attempts: [attempt("66666666-8888-4888-8888-000000000001", "failed")] },
];

function auth(tables: Record<string, Record<string, unknown>[]> = {}, catalog: { kind: string; enabled: boolean }[] = []) {
  const from = (name: string) => {
    let rows = [...(tables[name] ?? [])];
    const query = { select: () => query, order: () => query, limit: () => query,
      eq: (key: string, value: unknown) => { rows = rows.filter(row => row[key] === undefined || row[key] === value); return query; },
      match: (filter: Record<string, unknown>) => { rows = rows.filter(row => Object.entries(filter).every(([key, value]) => row[key] === undefined || row[key] === value)); return query; },
      in: (key: string, values: unknown[]) => { rows = rows.filter(row => values.includes(row[key])); return query; },
      then: (resolve: (value: { data: unknown[]; error: null }) => unknown) => Promise.resolve({ data: rows, error: null }).then(resolve) };
    return query;
  };
  return { userId: owner, client: { from, rpc: async () => ({ data: { plans: [], kinds: catalog }, error: null }) } } as unknown as AuthenticatedContext;
}
const code = async (run: () => Promise<unknown>) => { try { await run(); } catch (error) { return error instanceof ApiError ? error.code : String(error); } return "ok"; };

beforeEach(() => {
  vi.clearAllMocks();
  doubles.workspace.mockResolvedValue({ ownerId: owner, projectId: project, heads, stages: { brief_references: { id: briefId, revision: 2 } } });
  doubles.stage.mockResolvedValue({ id: briefId, stage: "brief_references", revision: 2, payload });
  doubles.batch.mockResolvedValue({ id: batchId, briefRevisionId: briefId, slots });
  doubles.snapshot.mockResolvedValue({ id: snapshotId, references: [{ referenceId: "77777777-8888-4888-8888-000000000001", asset: ref("2"), aspects: ["overall_feel"], sourceKind: "upload" }] });
  doubles.project.mockResolvedValue({ id: project, current_revision: 4 });
});

describe("the Logo engine switch", () => {
  it("is on only while all three Logo kinds are enabled, and off when the catalog can't be read", async () => {
    const all = ["logo.concepts", "logo.refine", "logo.style_note"];
    expect(await logoEngineEnabled(auth({}, all.map(kind => ({ kind, enabled: true }))))).toBe(true);
    expect(await logoEngineEnabled(auth({}, all.map(kind => ({ kind, enabled: kind !== "logo.style_note" }))))).toBe(false);
    expect(await logoEngineEnabled(auth({}, []))).toBe(false);
    const broken = { userId: owner, client: { rpc: async () => ({ data: null, error: { message: "function does not exist" } }) } } as unknown as AuthenticatedContext;
    expect(await logoEngineEnabled(broken)).toBe(false);
  });
});

describe("a concepts round's frozen input", () => {
  it("freezes the saved brief, its logo types and the heads, with a new batch", async () => {
    const input = await buildLogoConceptsRunInput(auth(), project, { operation: "concepts", expected: heads, briefRevisionId: briefId });
    expect(input).toMatchObject({ version: 1, revision: 4, operation: "concepts", expected: heads,
      brief: { id: briefId, revision: 2, payload: { name: "Levain & Co", logoTypes: ["wordmark", "pictorial"], personality: payload.personality } } });
    expect(input.batchId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(input.brief.payload).not.toHaveProperty("referenceSnapshotId");
  });
  it("refuses changed heads, another brief, an unusable name and anything else the browser adds", async () => {
    expect(await code(() => buildLogoConceptsRunInput(auth(), project, { operation: "concepts", expected: { ...heads, workspaceRevision: 4 }, briefRevisionId: briefId }))).toBe("conflict");
    expect(await code(() => buildLogoConceptsRunInput(auth(), project, { operation: "more_concepts", expected: heads, briefRevisionId: snapshotId }))).toBe("conflict");
    expect(await code(() => buildLogoConceptsRunInput(auth(), project, { operation: "concepts", expected: heads, briefRevisionId: briefId, brief: payload }))).toBe("invalid_input");
    doubles.stage.mockResolvedValueOnce({ id: briefId, stage: "brief_references", revision: 2, payload: { ...payload, name: "   " } });
    expect(await code(() => buildLogoConceptsRunInput(auth(), project, { operation: "concepts", expected: heads, briefRevisionId: briefId }))).toBe("invalid_input");
  });
  it("retries only slots whose last image definitely failed, in the same brief's batch", async () => {
    const input = await buildLogoConceptsRunInput(auth(), project, { operation: "retry_failed", expected: heads, sourceBatchId: batchId, failedSlotIds: [slots[1]!.id] });
    expect(input).toMatchObject({ operation: "retry_failed", batchId, slotIds: [slots[1]!.id] });
    expect(await code(() => buildLogoConceptsRunInput(auth(), project, { operation: "retry_failed", expected: heads, sourceBatchId: batchId, failedSlotIds: [slots[0]!.id] }))).toBe("conflict");
    doubles.batch.mockResolvedValueOnce({ id: batchId, briefRevisionId: snapshotId, slots });
    expect(await code(() => buildLogoConceptsRunInput(auth(), project, { operation: "retry_failed", expected: heads, sourceBatchId: batchId, failedSlotIds: [slots[1]!.id] }))).toBe("conflict");
  });
});

describe("a refinement's frozen input", () => {
  const tables = { asset_versions: [{ id: ref("2").versionId, mime_type: "image/jpeg", owner_id: owner, project_id: project }] };
  it("freezes the chosen image's exact preview, the liked uploads with their file types, and the change", async () => {
    const source = { kind: "concept", batchId, slotId: slots[0]!.id, attemptId: slots[0]!.attempts[0]!.id };
    const input = await buildLogoRefineRunInput(auth(tables), project, { expected: heads, source, instruction: "  Bolder lettering " });
    expect(input).toMatchObject({ source, basePreview: ref("1"), instruction: "Bolder lettering",
      references: [{ asset: ref("2"), mimeType: "image/jpeg", aspects: ["overall_feel"] }], brief: { id: briefId } });
  });
  it("refuses an image that is not a delivered concept", async () => {
    const failed = { kind: "concept", batchId, slotId: slots[1]!.id, attemptId: slots[1]!.attempts[0]!.id };
    expect(await code(() => buildLogoRefineRunInput(auth(tables), project, { expected: heads, source: failed, instruction: "x" }))).toBe("not_found");
    doubles.refinement.mockResolvedValueOnce({ state: "failed", billing: { status: "recorded" }, preview: null });
    expect(await code(() => buildLogoRefineRunInput(auth(tables), project, { expected: heads, source: { kind: "refinement", rasterRevisionId: batchId }, instruction: "x" }))).toBe("not_found");
  });
});

describe("a style-note run's frozen input", () => {
  const referenceId = "77777777-8888-4888-8888-000000000001", hash = "3".repeat(64);
  const sources = [{ reference_id: referenceId, asset_id: ref("3").assetId, version_id: ref("3").versionId, content_hash: hash, owner_id: owner, project_id: project, source_kind: "upload" }];
  const tables = { logo_reference_sources: sources, asset_versions: [{ id: ref("3").versionId, mime_type: "image/webp" }], generation_runs: [], generation_outputs: [] };
  it("freezes each liked upload without a note at its current version", async () => {
    doubles.liked.mockResolvedValue([{ referenceId, aspects: ["overall_feel"] }]);
    expect(await buildLogoStyleNoteRunInput(auth(tables), project, { referenceIds: [referenceId] })).toEqual({ version: 1, revision: 4,
      references: [{ referenceId, mimeType: "image/webp", asset: { ownerId: owner, projectId: project, assetId: ref("3").assetId, versionId: ref("3").versionId, contentHash: hash } }] });
  });
  it("refuses an upload the person doesn't like, and one whose note is already being written", async () => {
    doubles.liked.mockResolvedValue([]);
    expect(await code(() => buildLogoStyleNoteRunInput(auth(tables), project, { referenceIds: [referenceId] }))).toBe("not_found");
    doubles.liked.mockResolvedValue([{ referenceId, aspects: ["overall_feel"] }]);
    const running = { id: "88888888-8888-4888-8888-000000000001", status: "running", owner_id: owner, project_id: project, kind: "logo.style_note",
      input: { version: 1, revision: 4, references: [{ referenceId, mimeType: "image/webp", asset: { ...ref("3"), contentHash: hash } }] } };
    expect(await code(() => buildLogoStyleNoteRunInput(auth({ ...tables, generation_runs: [running] }), project, { referenceIds: [referenceId] }))).toBe("conflict");
  });
});
