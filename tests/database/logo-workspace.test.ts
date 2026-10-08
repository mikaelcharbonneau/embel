import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { asRole, createTestDatabase, OWNER_A, OWNER_B, resetFixture, type TestDatabase } from "./local-supabase";
import { logoBriefDraftSchema, logoWorkspaceV2Schema, type LogoMutationReceipt, type LogoStageRevision, type LogoExpectedHeads, type LogoStage } from "../../src/domain/logo-workspace";

vi.mock("server-only", () => ({}));
import { createLogoWorkspaceService } from "../../src/server/data/logo-workspace";
import { accountProjectSchema } from "../../src/domain/project-api";
import type { AuthenticatedContext } from "../../src/server/auth/context";
const brief = { name: "  Étoile 👩‍🚀  ", activity: "Design", audience: "Founders", personality: "Precise", logoTypes: ["wordmark"] };
const stages = ["brief_references", "concepts", "vector", "refinements", "directions", "deliverables"];
describe("V2 workspace actual authenticated PostgreSQL persistence", () => {
  let db: TestDatabase;
  beforeAll(async () => { db = await createTestDatabase(); }, 40_000);
  afterAll(async () => { await db?.close(); });
  beforeEach(async () => { await resetFixture(db); });
  async function rpc(name: string, args: unknown[], owner = OWNER_A) {
    return asRole(db, "authenticated", owner, async () => (await db.query<{ value: unknown }>(`select public.${name}(${args.map((_, i) => `$${i + 1}`).join(",")}) value`, args)).rows[0]!.value);
  }
  const start = (input = { requestKey: randomUUID(), brief }, owner = OWNER_A) => rpc("start_logo_project", [input], owner);
  const read = (project: string, owner = OWNER_A) => rpc("get_logo_workspace", [project], owner);
  const mutate = (project: string, method: string, body: unknown, owner = OWNER_A) => rpc("apply_logo_workspace_command", [project, { method, body }], owner);
  async function counts() { return (await db.query<{projects:number;revisions:number;receipts:number;jobs:number}>("select (select count(*)::int from public.projects) projects,(select count(*)::int from public.logo_stage_revisions) revisions,(select count(*)::int from public.logo_workspace_requests) receipts,(select count(*)::int from public.jobs) jobs")).rows[0]; }
  async function created() { return logoWorkspaceV2Schema.parse(await start()); }
  it("creation_recovery_has_no_project_id_and_one_project_under_exact_replay", async () => {
    const input = { requestKey: randomUUID(), brief };
    const first = await start(input);
    expect(await start(input)).toEqual(first);
    expect(await rpc("read_logo_project_creation", [input.requestKey])).toMatchObject({ status: "succeeded", requestKey: input.requestKey, workspace: first });
    expect(await rpc("read_logo_project_creation", [input.requestKey], OWNER_B)).toEqual({ status: "not_found" });
    expect(await counts()).toMatchObject({ projects: 1, revisions: 1, receipts: 1, jobs: 0 });
  });
  it("owner-scoped creation listing only reveals committed owned receipts", async () => {
    const own = await created(); await start({ requestKey: randomUUID(), brief: { ...brief, name: "Other" } }, OWNER_B);
    const page = await rpc("list_logo_project_creations", [{}]);
    expect(page).toMatchObject({ ownerId: OWNER_A, items: [{ projectId: own.projectId, brief }], nextCursor: null });
    expect(await rpc("read_logo_project_creation", [randomUUID()])).toEqual({ status: "not_found" });
  });
  it("rejects changed creation bodies under the same request key atomically", async () => {
    const input = { requestKey: randomUUID(), brief }; await start(input); const before = await counts();
    await expect(start({ ...input, brief: { ...brief, name: "Changed" } })).rejects.toMatchObject({ code: "PT409" });
    expect(await counts()).toEqual(before);
  });
  it("preserves exact brief spelling and starts six distinct zero-or-one stage heads", async () => {
    const workspace = await created();
    expect(workspace.heads.workspaceRevision).toBe(1); expect(Object.keys(workspace.stages).sort()).toEqual([...stages].sort());
    const row = await rpc("read_logo_workspace_record", [workspace.projectId, "stage", workspace.stages.brief_references!.id]);
    expect(row).toMatchObject({ version: 2, parentRevisionId: null, payload: brief });
    expect(workspace.approvedLogo).toBeNull();
  });
  it.each([OWNER_B, "cccccccc-cccc-4ccc-8ccc-cccccccccccc"])("foreign/missing owner %s cannot read or append", async owner => {
    const workspace = await created(); const before = await counts();
    await expect(read(workspace.projectId, owner)).rejects.toMatchObject({ code: "P0002" });
    await expect(mutate(workspace.projectId, "saveLogoBrief", { requestKey: randomUUID(), expected: workspace.heads, brief }, owner)).rejects.toMatchObject({ code: "P0002" });
    expect(await counts()).toEqual(before);
  });
  it("missing projects produce no writes", async () => {
    const workspace = await created(), before = await counts();
    await expect(mutate(randomUUID(), "saveLogoBrief", { requestKey: randomUUID(), expected: workspace.heads, brief })).rejects.toMatchObject({ code: "P0002" });
    expect(await counts()).toEqual(before);
  });
  it.each(["projectRevision", "referenceRevision", "preferencesRevision", "workspaceRevision", ...stages])("fences exact %s without writes", async field => {
    const workspace = await created(), expected = structuredClone(workspace.heads) as LogoExpectedHeads, before = await counts();
    if (stages.includes(field)) expected.stageRevisions[field as LogoStage]++; else expected[field as Exclude<keyof LogoExpectedHeads, "stageRevisions">]++;
    await expect(mutate(workspace.projectId, "saveLogoBrief", { requestKey: randomUUID(), expected, brief })).rejects.toMatchObject({ code: "PT409" });
    expect(await counts()).toEqual(before);
  });
  it("exact replay after lost acknowledgement returns the original receipt without moving a newer head", async () => {
    const workspace = await created(), input = { requestKey: randomUUID(), expected: workspace.heads, brief: { ...brief, activity: "First" } };
    const first = await mutate(workspace.projectId, "saveLogoBrief", input) as LogoMutationReceipt;
    const second = await mutate(workspace.projectId, "saveLogoBrief", { requestKey: randomUUID(), expected: first.workspace.heads, brief: { ...brief, activity: "Second" } }) as LogoMutationReceipt;
    const before = await counts(); expect(await mutate(workspace.projectId, "saveLogoBrief", input)).toEqual(first);
    expect(await read(workspace.projectId)).toEqual(second.workspace); expect(await counts()).toEqual(before);
    await expect(mutate(workspace.projectId, "saveLogoBrief", { ...input, brief })).rejects.toMatchObject({ code: "PT409" });
  });
  it("restoring an earlier brief appends with current parent and preserves historical bytes", async () => {
    const workspace = await created(), original = await rpc("read_logo_workspace_record", [workspace.projectId, "stage", workspace.stages.brief_references!.id]);
    const first = await mutate(workspace.projectId, "saveLogoBrief", { requestKey: randomUUID(), expected: workspace.heads, brief: { ...brief, activity: "New" } }) as LogoMutationReceipt;
    const restore = { requestKey: randomUUID(), expected: first.workspace.heads, stage: "brief_references", revisionId: workspace.stages.brief_references!.id, acceptEarlierBasis: true };
    const result = await mutate(workspace.projectId, "restoreLogoStage", restore) as LogoMutationReceipt;
    expect(result.revision.id).not.toBe(workspace.stages.brief_references!.id); expect(result.revision.parentRevisionId).toBe(first.revision.id); expect(result.revision.revision).toBe(3);
    expect(result.revision.payload).toEqual((original as LogoStageRevision).payload);
    expect(await rpc("read_logo_workspace_record", [workspace.projectId, "stage", workspace.stages.brief_references!.id])).toEqual(original);
    expect((await counts())!.jobs).toBe(0);
  });
  it.each([
    { ...brief, ownerId: OWNER_B }, { ...brief, name: "\uFEFF\u00A0\u2028" }, { ...brief, name: "😀".repeat(201) },
    { ...brief, activity: "😀".repeat(4001) }, { ...brief, logoTypes: ["wordmark", "wordmark"] }, { ...brief, logoTypes: ["WORDMARK"] },
    { ...brief, name: "" }, { ...brief, logoTypes: [] },
  ])("direct RPC rejects the same invalid brief as the strict shared schema", async invalid => {
    expect(logoBriefDraftSchema.safeParse(invalid).success).toBe(false);
    await expect(start({ requestKey: randomUUID(), brief: invalid as typeof brief })).rejects.toMatchObject({ code: "22023" });
    expect((await db.query("select count(*)::int count from public.projects")).rows[0]).toEqual({ count: 0 });
  });
  it.each(["\u0085", "İ", "😀".repeat(100), "\u200B"])("accepts shared-schema valid spelling without SQL trim/case folding: %s", async name => {
    const input = { ...brief, name }; expect(logoBriefDraftSchema.safeParse(input).success).toBe(true);
    const workspace = logoWorkspaceV2Schema.parse(await start({ requestKey: randomUUID(), brief: input }));
    expect(await rpc("read_logo_workspace_record", [workspace.projectId, "stage", workspace.stages.brief_references!.id])).toMatchObject({ payload: { name } });
  });
  it("anonymous/service-role cannot execute public mutations or private helpers", async () => {
    for (const role of ["anon", "service_role"] as const) {
      await expect(asRole(db, role, OWNER_A, () => db.query("select public.start_logo_project($1)", [{ requestKey: randomUUID(), brief }]))).rejects.toMatchObject({ code: "42501" });
      await expect(asRole(db, role, OWNER_A, () => db.query("select fluid_private.logo_workspace_json($1,$2)", [OWNER_A, randomUUID()]))).rejects.toMatchObject({ code: "42501" });
    }
  });
  it("authenticated users have no direct history/head/request writes", async () => {
    const workspace = await created();
    for (const table of ["logo_workspaces", "logo_stage_heads", "logo_stage_revisions", "logo_reference_snapshots", "logo_workspace_requests", "logo_reference_sources"]) {
      await expect(asRole(db, "authenticated", OWNER_A, () => db.query(`delete from public.${table} where project_id=$1`, [workspace.projectId]))).rejects.toMatchObject({ code: "42501" });
    }
  });
  it("saved_reference_snapshot_retains_exact_subset_aspects_versions_and_actual_empty_snapshots", async () => {
    const workspace = await created();
    const referenceId = randomUUID(), assetId = randomUUID(), versionId = randomUUID(), rightsEvidenceId = randomUUID();
    // Explicit local metadata fixture. No upload, provider execution or rights verification is claimed.
    await db.query("insert into public.assets(id,owner_id,project_id,kind,purpose) values($1,$2,$3,'reference','reference_media')", [assetId, OWNER_A, workspace.projectId]);
    await db.query("insert into public.asset_versions(id,owner_id,project_id,asset_id,version,input_revision,input_hash,content_hash,mime_type,provenance) values($1,$2,$3,$4,1,1,$5,$5,'image/png','{}')", [versionId, OWNER_A, workspace.projectId, assetId, "a".repeat(64)]);
    await db.query("insert into public.logo_reference_sources(reference_id,project_id,owner_id,asset_id,version_id,content_hash,source_kind,rights_evidence_id) values($1,$2,$3,$4,$5,$6,'upload',$7)", [referenceId, workspace.projectId, OWNER_A, assetId, versionId, "a".repeat(64), rightsEvidenceId]);
    const facade = createLogoWorkspaceService();
    const context = { userId: OWNER_A, client: { rpc: async (name: string, args: Record<string, unknown>) => {
      try { return { data: await rpc(name, Object.values(args)), error: null }; } catch (error) { return { data: null, error }; }
    } } } as unknown as AuthenticatedContext;
    const firstInput = { requestKey: randomUUID(), expected: workspace.heads, selections: [{ referenceId, aspects: ["composition", "lettering"] }] };
    await mutate(workspace.projectId, "saveLogoReferences", firstInput);
    const first = await facade.saveLogoReferences(context, workspace.projectId, firstInput);
    expect(first.revision.stage).toBe("brief_references");
    const snapshotId = (first.revision as LogoStageRevision<"brief_references">).payload.referenceSnapshotId;
    const snapshot = await facade.readLogoReferenceSnapshot(context, workspace.projectId, snapshotId);
    expect(snapshot.references).toEqual([{ referenceId, asset: { ownerId: OWNER_A, projectId: workspace.projectId, assetId, versionId, contentHash: "a".repeat(64) }, sourceKind: "upload", rightsEvidenceId, aspects: ["composition", "lettering"] }]);
    const empty = await facade.saveLogoReferences(context, workspace.projectId, { requestKey: randomUUID(), expected: first.workspace.heads, selections: [] });
    const emptyId = (empty.revision as LogoStageRevision<"brief_references">).payload.referenceSnapshotId;
    expect(emptyId).not.toBe(snapshotId);
    expect((await facade.readLogoReferenceSnapshot(context, workspace.projectId, emptyId)).references).toEqual([]);
    expect(await facade.readLogoReferenceSnapshot(context, workspace.projectId, snapshotId)).toEqual(snapshot);
    await expect(facade.readLogoReferenceSnapshot(context, workspace.projectId, randomUUID())).rejects.toMatchObject({ code: "not_found" });
  });
  it("missing reference source rolls back snapshot stage and request together", async () => {
    const workspace = await created(), before = await counts();
    await expect(mutate(workspace.projectId, "saveLogoReferences", { requestKey: randomUUID(), expected: workspace.heads, selections: [{ referenceId: randomUUID(), aspects: ["shape"] }] })).rejects.toMatchObject({ code: "P0002" });
    expect(await counts()).toEqual(before); expect(await read(workspace.projectId)).toEqual(workspace);
  });
  it("earlier_project_basis_restore_requires_acknowledgement_and_keeps_source_payload", async () => {
    const workspace = await created(), original = await rpc("read_logo_workspace_record", [workspace.projectId, "stage", workspace.stages.brief_references!.id]) as LogoStageRevision;
    await asRole(db, "authenticated", OWNER_A, () => db.query("select public.append_project_revision($1,1,$2::jsonb,$3)", [workspace.projectId, { description: "New saved Strategy context" }, "b".repeat(64)]));
    const current = logoWorkspaceV2Schema.parse(await read(workspace.projectId));
    const request = { requestKey: randomUUID(), expected: current.heads, stage: "brief_references", revisionId: original.id, acceptEarlierBasis: false };
    const before = await counts();
    await expect(mutate(workspace.projectId, "restoreLogoStage", request)).rejects.toMatchObject({ code: "PT409" });
    expect(await counts()).toEqual(before);
    const restored = await mutate(workspace.projectId, "restoreLogoStage", { ...request, acceptEarlierBasis: true }) as LogoMutationReceipt;
    expect(restored.revision.payload).toEqual(original.payload);
    expect(restored.workspace.staleStages).toContainEqual({ stage: "brief_references", reasons: ["project_revision_changed"] });
  });
  it("manual request lookup returns the original committed receipt after a later save", async () => {
    const workspace = await created(), requestKey = randomUUID();
    const first = await mutate(workspace.projectId, "saveLogoBrief", { requestKey, expected: workspace.heads, brief }) as LogoMutationReceipt;
    await mutate(workspace.projectId, "saveLogoBrief", { requestKey: randomUUID(), expected: first.workspace.heads, brief: { ...brief, name: "Later" } });
    expect(await rpc("read_logo_workspace_record", [workspace.projectId, "manual_request", requestKey])).toMatchObject({ status: "succeeded", requestKey, receipt: first, outputs: [], billing: { status: "recorded", confirmedMicrousd: 0 } });
    expect(await rpc("read_logo_workspace_record", [workspace.projectId, "manual_request", randomUUID()])).toEqual({ status: "not_found" });
  });
  it("queued same-key creation calls serialize to one actual project on the local backend", async () => {
    const input = { requestKey: randomUUID(), brief };
    const outputs = await asRole(db, "authenticated", OWNER_A, () => Promise.all([db.query("select public.start_logo_project($1) value", [input]), db.query("select public.start_logo_project($1) value", [input])]));
    expect(outputs[0]!.rows).toEqual(outputs[1]!.rows); expect(await counts()).toMatchObject({ projects: 1, revisions: 1, receipts: 1 });
  });
  it("history pages retain every immutable revision without duplicate or skipped entries", async () => {
    const workspace = await created();
    const first = await mutate(workspace.projectId, "saveLogoBrief", { requestKey: randomUUID(), expected: workspace.heads, brief }) as LogoMutationReceipt;
    const page = await rpc("list_logo_workspace_records", [workspace.projectId, "brief_references", { limit: 1 }]) as { items: LogoStageRevision[]; nextCursor: unknown };
    expect(page.items.map(i => i.id)).toEqual([first.revision.id]);
    const next = await rpc("list_logo_workspace_records", [workspace.projectId, "brief_references", { limit: 1, cursor: page.nextCursor }]) as { items: LogoStageRevision[]; nextCursor: unknown };
    expect(next.items.map(i => i.id)).toEqual([workspace.stages.brief_references!.id]); expect(next.nextCursor).toBeNull();
  });

  it("a maximum-length brief still creates a project accepted by the existing account reader", async () => {
    const name = "N".repeat(200), workspace = logoWorkspaceV2Schema.parse(await start({ requestKey: randomUUID(), brief: { ...brief, name } }));
    const row = (await db.query<{value:unknown}>("select to_jsonb(p)||jsonb_build_object('context',r.context) value from public.projects p join public.project_revisions r on r.project_id=p.id and r.revision=p.current_revision where p.id=$1", [workspace.projectId])).rows[0]!.value;
    expect(accountProjectSchema.safeParse(row).success).toBe(true);
    expect(await rpc("read_logo_workspace_record", [workspace.projectId, "stage", workspace.stages.brief_references!.id])).toMatchObject({ payload: { name } });
  });
});
