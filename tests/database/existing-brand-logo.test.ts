import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { asRole, createTestDatabase, OWNER_A, OWNER_B, resetFixture, type TestDatabase } from "./local-supabase";
import { logoMutationReceiptSchema, logoWorkspaceV2Schema, type LogoExpectedHeads } from "../../src/domain/logo-workspace";
import { seedIdentityRoot } from "./identity-system-database";
import { contextSnapshotSchema } from "../../src/domain/projects";

vi.mock("server-only", () => ({}));
import { initializeExistingBrandLogo } from "../../src/server/data/existing-brand-logo";
import type { AuthenticatedContext } from "../../src/server/auth/context";

const brief = { name: "Élan & Co", activity: "A small design studio", audience: "Founders", personality: "Precise", logoTypes: ["wordmark"] };
const context = contextSnapshotSchema.parse({ description: "Keep my entire Strategy", activity: "Design", offering: "Identity systems", selectedName: brief.name, intake: { suppliedName: brief.name, identityNotes: "Existing notes" } });
describe("explicit existing-brand logo initialization (local PostgreSQL)", () => {
  let db: TestDatabase;
  beforeAll(async () => { db = await createTestDatabase(); }, 40_000);
  afterAll(async () => { await db?.close(); });
  beforeEach(async () => { await resetFixture(db); });
  async function rpc(name: string, args: unknown[], owner = OWNER_A) {
    return asRole(db, "authenticated", owner, async () => (await db.query<{ value: unknown }>(`select public.${name}(${args.map((_, i) => `$${i + 1}`).join(",")}) value`, args)).rows[0]!.value);
  }
  async function brand() {
    const project = await asRole(db, "authenticated", OWNER_A, async () => (await db.query<{ id: string }>("select * from public.create_project('complete_brand','Existing brand',$1,$2)", [context, "a".repeat(64)])).rows[0]!);
    const workspace = logoWorkspaceV2Schema.parse(await rpc("get_logo_workspace", [project.id]));
    return { projectId: project.id, input: { requestKey: randomUUID(), expected: workspace.heads, brief }, workspace };
  }
  const initialize = (projectId: string, input: unknown, owner = OWNER_A) => rpc("initialize_existing_brand_logo", [projectId, input], owner);
  async function counts() { return (await db.query<{ projects: number; contexts: number; stages: number; receipts: number; jobs: number }>("select (select count(*)::int from public.projects) projects,(select count(*)::int from public.project_revisions) contexts,(select count(*)::int from public.logo_stage_revisions) stages,(select count(*)::int from public.logo_workspace_requests) receipts,(select count(*)::int from public.jobs) jobs")).rows[0]; }
  it("appends only the first logo brief on the same saved project without changing exact context/name revision or creating jobs", async () => {
    const f = await brand();
    const before = (await db.query("select to_jsonb(p) project,to_jsonb(r) context from public.projects p join public.project_revisions r on r.project_id=p.id where p.id=$1", [f.projectId])).rows;
    const receipt = logoMutationReceiptSchema.parse(await initialize(f.projectId, f.input));
    expect(receipt.projectId).toBe(f.projectId);
    expect(receipt.workspace.heads).toEqual({ ...f.workspace.heads, workspaceRevision: 1, stageRevisions: { ...f.workspace.heads.stageRevisions, brief_references: 1 } });
    expect(receipt.revision).toMatchObject({ stage: "brief_references", revision: 1, parentRevisionId: null, payload: { ...brief, sourceProjectRevision: f.workspace.heads.projectRevision } });
    expect((await db.query("select to_jsonb(p) project,to_jsonb(r) context from public.projects p join public.project_revisions r on r.project_id=p.id where p.id=$1", [f.projectId])).rows).toEqual(before);
    expect(await counts()).toEqual({ projects: 1, contexts: 1, stages: 1, receipts: 1, jobs: 0 });
  });
  it("recovers the exact request after a lost response and later edits without replacing a newer head", async () => {
    const f = await brand(), first = logoMutationReceiptSchema.parse(await initialize(f.projectId, f.input));
    const next = logoMutationReceiptSchema.parse(await rpc("apply_logo_workspace_command", [f.projectId, { method: "saveLogoBrief", body: { requestKey: randomUUID(), expected: first.workspace.heads, brief: { ...brief, name: "Later logo brief" } } }]));
    expect(await initialize(f.projectId, f.input)).toEqual(first);
    expect(await rpc("read_logo_workspace_record", [f.projectId, "manual_request", f.input.requestKey])).toMatchObject({ status: "succeeded", receipt: first });
    expect(await rpc("get_logo_workspace", [f.projectId])).toEqual(next.workspace);
    expect(await counts()).toEqual({ projects: 1, contexts: 1, stages: 2, receipts: 2, jobs: 0 });
  });
  it("rejects a second initialization even using current heads and never overwrites the first brief", async () => {
    const f = await brand(), first = logoMutationReceiptSchema.parse(await initialize(f.projectId, f.input)), before = await counts();
    expect(await initialize(f.projectId, { ...f.input, requestKey: randomUUID(), expected: first.workspace.heads })).toMatchObject({ kind: "logo_initialization_rejected" });
    await expect(initialize(f.projectId, { ...f.input, brief: { ...brief, name: "Changed key body" } })).rejects.toMatchObject({ code: "PT409" });
    expect(await counts()).toEqual(before);
  });
  it.each(["projectRevision", "referenceRevision", "preferencesRevision", "workspaceRevision", "concepts"])("fences current %s before any writes", async key => {
    const f = await brand(), expected: LogoExpectedHeads = structuredClone(f.input.expected), before = await counts();
    if (key === "concepts") expected.stageRevisions.concepts++; else expected[key as Exclude<keyof LogoExpectedHeads, "stageRevisions">]++;
    expect(await initialize(f.projectId, { ...f.input, expected })).toMatchObject({ kind: "logo_initialization_rejected" });
    expect(await counts()).toEqual(before);
  });
  it("rejects a newer saved Name/Strategy revision and lets an explicit refreshed-head request initialize", async () => {
    const f = await brand();
    await rpc("append_project_revision", [f.projectId, 1, { ...context, selectedName: "New saved name", intake: { ...context.intake, suppliedName: "New saved name" } }, "b".repeat(64)]);
    expect(await initialize(f.projectId, f.input)).toMatchObject({ kind: "logo_initialization_rejected" });
    const latest = logoWorkspaceV2Schema.parse(await rpc("get_logo_workspace", [f.projectId]));
    const receipt = logoMutationReceiptSchema.parse(await initialize(f.projectId, { ...f.input, requestKey: randomUUID(), expected: latest.heads, brief: { ...brief, name: "New saved name" } }));
    expect(receipt.revision.payload).toMatchObject({ name: "New saved name", sourceProjectRevision: 2 });
    expect(await counts()).toEqual({ projects: 1, contexts: 2, stages: 1, receipts: 1, jobs: 0 });
  });
  it("fences foreign/missing ownership and rejects client owner claims", async () => {
    const f = await brand(), before = await counts();
    await expect(initialize(f.projectId, f.input, OWNER_B)).rejects.toMatchObject({ code: "P0002" });
    await expect(initialize(randomUUID(), f.input)).rejects.toMatchObject({ code: "P0002" });
    await expect(initialize(f.projectId, { ...f.input, ownerId: OWNER_B })).rejects.toMatchObject({ code: "22023" });
    expect(await counts()).toEqual(before);
  });
  it("allows only authenticated owner-scoped RPC access", async () => {
    const f = await brand();
    for (const role of ["anon", "service_role"] as const) await expect(asRole(db, role, OWNER_A, () => db.query("select public.initialize_existing_brand_logo($1,$2)", [f.projectId, f.input]))).rejects.toMatchObject({ code: "42501" });
  });
  it("keeps actual legacy V1 systems readable and byte-identical after V2 initialization", async () => {
    const f = await brand();
    const legacy = await seedIdentityRoot(db, f.projectId);
    const before = await rpc("get_project_identity", [f.projectId, {}]);
    const saved = logoWorkspaceV2Schema.parse(await rpc("get_logo_workspace", [f.projectId]));
    const beforeCounts = await counts();
    await initialize(f.projectId, { ...f.input, expected: saved.heads });
    expect(await rpc("get_project_identity", [f.projectId, {}])).toEqual(before);
    expect((await db.query("select source->>'kind' kind from public.identity_system_versions where id=$1", [legacy.system.id])).rows).toEqual([{ kind: "generated" }]);
    expect(await counts()).toEqual({ ...beforeCounts, stages: 1, receipts: 1 });
  });
  it("two different-key attempts cannot overwrite the first initialized brief", async () => {
    const f = await brand();
    const results = await asRole(db, "authenticated", OWNER_A, () => Promise.allSettled([db.query("select public.initialize_existing_brand_logo($1,$2)", [f.projectId, f.input]), db.query("select public.initialize_existing_brand_logo($1,$2)", [f.projectId, { ...f.input, requestKey: randomUUID(), brief: { ...brief, name: "Another draft" } }])]));
    expect(results.map(result => result.status)).toEqual(["fulfilled", "fulfilled"]);
    if (results[1]?.status === "fulfilled") expect(results[1].value.rows[0]).toMatchObject({ initialize_existing_brand_logo: { kind: "logo_initialization_rejected" } });
    expect(await counts()).toEqual({ projects: 1, contexts: 1, stages: 1, receipts: 1, jobs: 0 });
  });
  it("maps real PostgreSQL rejection bytes to an exact-body DAL proof without exposing the brief in the HTTP proof", async () => {
    const f = await brand(), input = { ...f.input, expected: { ...f.input.expected, projectRevision: 2 } };
    const auth = { userId: OWNER_A, client: { rpc: async (name: string, args: Record<string, unknown>) => ({ data: await rpc(name, Object.values(args)), error: null }) } } as unknown as AuthenticatedContext;
    const error = await initializeExistingBrandLogo(auth, f.projectId, input).catch(value => value);
    expect(error).toMatchObject({ name: "LogoInitializationRejectedError", rejection: { ownerId: OWNER_A, projectId: f.projectId, requestKey: input.requestKey, inputHash: expect.stringMatching(/^[0-9a-f]{64}$/) } });
    expect(error.rejection.input).toBeUndefined();
    expect(await initialize(f.projectId, input)).toMatchObject({ kind: "logo_initialization_rejected" });
  });
  it("a committed rejection permanently fences a delayed original even if its expected heads later become current", async () => {
    const f = await brand(), input = { ...f.input, expected: { ...f.input.expected, projectRevision: 2 } };
    const rejected = await initialize(f.projectId, input);
    expect(rejected).toMatchObject({ kind: "logo_initialization_rejected", rejection: { ownerId: OWNER_A, projectId: f.projectId, requestKey: input.requestKey, input } });
    await rpc("append_project_revision", [f.projectId, 1, context, "b".repeat(64)]);
    expect(await initialize(f.projectId, input)).toEqual(rejected);
    await expect(rpc("apply_logo_workspace_command", [f.projectId, { method: "saveLogoBrief", body: input }])).rejects.toMatchObject({ code: "PT409" });
    expect(await rpc("read_logo_request", [f.projectId, input.requestKey])).toMatchObject({ status: "failed", requestKey: input.requestKey, reason: "admission_rejected" });
    expect(await counts()).toEqual({ projects: 1, contexts: 2, stages: 0, receipts: 0, jobs: 0 });
    await expect(asRole(db, "authenticated", OWNER_B, () => db.query("select * from public.logo_operation_rejections"))).rejects.toMatchObject({ code: "42501" });
    await expect(rpc("read_logo_request", [f.projectId, input.requestKey], OWNER_B)).rejects.toMatchObject({ code: "P0002" });
  });
  it("serializes two original-key initializations into one brief", async () => {
    const f = await brand();
    const values = await asRole(db, "authenticated", OWNER_A, () => Promise.all([db.query("select public.initialize_existing_brand_logo($1,$2) value", [f.projectId, f.input]), db.query("select public.initialize_existing_brand_logo($1,$2) value", [f.projectId, f.input])]));
    expect(values[0]!.rows).toEqual(values[1]!.rows);
    expect(await counts()).toEqual({ projects: 1, contexts: 1, stages: 1, receipts: 1, jobs: 0 });
  });
});
