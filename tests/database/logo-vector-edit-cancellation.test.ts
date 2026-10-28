import { reportLogoFixtureReady, SYNTHETIC_CONCEPT_READINESS } from './logo-readiness-fixture';
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { asRole, createTestDatabase, OWNER_A, OWNER_B, resetFixture, type TestDatabase } from "./local-supabase";
import { legacyLogoCostQuoteSchema as logoCostQuoteSchema, logoDispatchReceiptSchema } from "../../src/domain/logo-jobs";
import { logoWorkspaceV2Schema } from "../../src/domain/logo-workspace";
import { logoVectorEditCommandSchema, logoVectorEditRequestStateSchema } from "../../src/features/logo-vector/model/cancellation";

// Actual PostgreSQL semantics in disposable PGlite. No hosted database changes.
describe("durable exact manual vector edit cancellation", () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await createTestDatabase();
    await db.exec('create role fixture_edit_cancel_worker login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;grant usage on schema public to fixture_edit_cancel_worker');
    await db.exec(`create role fixture_edit_cancel_web login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
      grant usage on schema public,fluid_private to fixture_edit_cancel_web;
      grant execute on function fluid_private.read_logo_trusted_request(uuid,jsonb),fluid_private.apply_logo_trusted_command(uuid,jsonb,jsonb) to fixture_edit_cancel_web;`);
    await db.query("insert into fluid_private.logo_asset_web_principals(role_name,role_oid,owner_id) select rolname,oid,$1 from pg_roles where rolname='fixture_edit_cancel_web'", [OWNER_A]);
  }, 60_000);
  beforeEach(async () => { await resetFixture(db); });
  afterAll(async () => { await db?.close(); });
  const rpc = (name: string, args: unknown[], owner: string | null = OWNER_A) => asRole(db, owner ? "authenticated" : "anon", owner, async () =>
    (await db.query<{ value: unknown }>(`select public.${name}(${args.map((_, i) => `$${i + 1}`).join(",")}) value`, args)).rows[0]!.value);
  async function fixture() {
    const workspace = logoWorkspaceV2Schema.parse(await rpc("start_logo_project", [{ requestKey: randomUUID(), brief: { name: "Cancellation fixture", activity: "Studio", audience: "Test", personality: "Calm", logoTypes: ["combination"] } }]));
    const command = { method: "saveLogoEdit", body: { requestKey: randomUUID(), expected: workspace.heads, baseVectorRevisionId: randomUUID(), edit: { kind: "text", componentId: "lettering", text: "Unsupported glyph 🐦" } } };
    return { workspace, command, projectId: workspace.projectId, key: command.body.requestKey };
  }
  async function trusted(sql: string, args: unknown[]) {
    await db.exec("set session authorization fixture_edit_cancel_web");
    try { return await db.query(sql, args); } finally { await db.exec("set session authorization postgres"); }
  }
  it("appends an exact tombstone before admission, replays it, and leaves stage heads unchanged", async () => {
    const f = await fixture(), expected = { status: "cancelled", ownerId: OWNER_A, projectId: f.projectId, requestKey: f.key, command: f.command };
    expect(await rpc("read_logo_vector_edit_request", [f.projectId, f.key])).toEqual({ status: "not_found" });
    expect(await rpc("cancel_logo_vector_edit", [f.projectId, f.command])).toEqual(expected);
    expect(await rpc("cancel_logo_vector_edit", [f.projectId, f.command])).toEqual(expected);
    expect(await rpc("read_logo_vector_edit_request", [f.projectId, f.key])).toEqual(expected);
    expect(await rpc("get_logo_workspace", [f.projectId])).toEqual(f.workspace);
    expect((await db.query("select count(*)::int n from public.logo_vector_edit_cancellations")).rows).toEqual([{ n: 1 }]);
    await expect(db.query("update public.logo_vector_edit_cancellations set command=command")).rejects.toMatchObject({ code: "55000" });
    await expect(db.query("delete from public.logo_vector_edit_cancellations")).rejects.toMatchObject({ code: "55000" });
  });
  it("fences preflight and delayed commit with the exact cancellation error before bytes can be committed", async () => {
    const f = await fixture();
    expect((await trusted("select fluid_private.read_logo_trusted_request($1,$2) value", [f.projectId, f.command])).rows).toEqual([{ value: null }]);
    await rpc("cancel_logo_vector_edit", [f.projectId, f.command]);
    await expect(trusted("select fluid_private.read_logo_trusted_request($1,$2)", [f.projectId, f.command])).rejects.toMatchObject({ code: "PT409", message: "logo_edit_cancelled" });
    await expect(trusted("select fluid_private.apply_logo_trusted_command($1,$2,$3)", [f.projectId, f.command, {}])).rejects.toMatchObject({ code: "PT409", message: "logo_edit_cancelled" });
    expect(await rpc("get_logo_workspace", [f.projectId])).toEqual(f.workspace);
  });
  it("rejects changed-body key reuse for cancellation, preflight and delayed commit", async () => {
    const f = await fixture(); await rpc("cancel_logo_vector_edit", [f.projectId, f.command]);
    const changed = structuredClone(f.command); changed.body.edit.text = "Changed";
    await expect(rpc("cancel_logo_vector_edit", [f.projectId, changed])).rejects.toMatchObject({ code: "PT409", message: "logo_request_conflict" });
    await expect(trusted("select fluid_private.read_logo_trusted_request($1,$2)", [f.projectId, changed])).rejects.toMatchObject({ code: "PT409", message: "logo_request_conflict" });
    await expect(trusted("select fluid_private.apply_logo_trusted_command($1,$2,$3)", [f.projectId, changed, {}])).rejects.toMatchObject({ code: "PT409", message: "logo_request_conflict" });
  });
  it("fences changed-method trusted commits that passed preflight before cancellation", async () => {
    const f = await fixture();
    const changed = { method: "acceptLogoVector", body: { requestKey: f.key, expected: f.workspace.heads, vectorRevisionId: randomUUID(), acceptEarlierBasis: false } };
    expect((await trusted("select fluid_private.read_logo_trusted_request($1,$2) value", [f.projectId, changed])).rows).toEqual([{ value: null }]);
    await rpc("cancel_logo_vector_edit", [f.projectId, f.command]);
    await expect(trusted("select fluid_private.apply_logo_trusted_command($1,$2,$3)", [f.projectId, changed, {}])).rejects.toMatchObject({ code: "PT409", message: "logo_request_conflict" });
  });
  it("reserves cancelled keys across legacy brief and reference writes and rolls all stage work back", async () => {
    for (const method of ["saveLogoBrief", "saveLogoReferences"]) {
      const f = await fixture();
      const proof = await rpc("cancel_logo_vector_edit", [f.projectId, f.command]);
      const body = method === "saveLogoBrief"
        ? { requestKey: f.key, expected: f.workspace.heads, brief: { name: "Different command", activity: "Studio", audience: "Test", personality: "Calm", logoTypes: ["combination"] } }
        : { requestKey: f.key, expected: f.workspace.heads, selections: [] };
      const before = (await db.query("select id,record from public.logo_stage_revisions where project_id=$1 order by id", [f.projectId])).rows;
      await expect(rpc("apply_logo_workspace_command", [f.projectId, { method, body }])).rejects.toMatchObject({ code: "PT409", message: "logo_request_conflict" });
      expect(await rpc("get_logo_workspace", [f.projectId])).toEqual(f.workspace);
      expect((await db.query("select id,record from public.logo_stage_revisions where project_id=$1 order by id", [f.projectId])).rows).toEqual(before);
      expect(await rpc("read_logo_vector_edit_request", [f.projectId, f.key])).toEqual(proof);
      expect((await db.query("select count(*)::int n from public.logo_workspace_requests where project_id=$1 and request_key=$2", [f.projectId, f.key])).rows).toEqual([{ n: 0 }]);
    }
  });
  it("leaves unrelated manual keys and the separate creation key namespace unchanged", async () => {
    const f = await fixture(); await rpc("cancel_logo_vector_edit", [f.projectId, f.command]);
    const brief = { name: "Separate namespace", activity: "Studio", audience: "Test", personality: "Calm", logoTypes: ["combination"] };
    expect(await rpc("apply_logo_workspace_command", [f.projectId, { method: "saveLogoBrief", body: { requestKey: randomUUID(), expected: f.workspace.heads, brief } }])).toHaveProperty("revision.stage", "brief_references");
    const created = logoWorkspaceV2Schema.parse(await rpc("start_logo_project", [{ requestKey: f.key, brief }]));
    expect(created.projectId).not.toBe(f.projectId);
    expect(await rpc("read_logo_vector_edit_request", [f.projectId, f.key])).toMatchObject({ status: "cancelled", command: f.command });
  });
  it("fences cancelled-key generation admission and rolls back jobs, child rows and reserved cost", async () => {
    const f = await fixture();
    await db.query("insert into fluid_private.logo_runtime_policies(owner_id,operation,policy_identity,handler_version,provider,model,max_cost_microusd,enabled) values($1,'identity.logo_concept',$2,'logo-image-v1','openai','gpt-image-2.5-sunburst-2026-09-08',100,true) on conflict(owner_id,operation) do update set enabled=true", [OWNER_A, "a".repeat(64)]);
    await db.query("insert into fluid_private.logo_worker_principals(role_name,role_oid,owner_id) select rolname,oid,$1 from pg_roles where rolname='fixture_edit_cancel_worker' on conflict(role_name) do nothing",[OWNER_A]);
    await reportLogoFixtureReady(db,'fixture_edit_cancel_worker',['cancel-test'],[SYNTHETIC_CONCEPT_READINESS]);
    const reference = (await db.query<{ reference_snapshot_id: string }>("select reference_snapshot_id from public.logo_stage_revisions where id=$1", [f.workspace.stages.brief_references!.id])).rows[0]!;
    const quote = logoCostQuoteSchema.parse(await rpc("quote_logo_operation", [f.projectId, { operation: "concepts", expected: f.workspace.heads, briefRevisionId: f.workspace.stages.brief_references!.id, referenceSnapshotId: reference.reference_snapshot_id }]));
    const intent = { requestKey: f.key, quoteId: quote.id, expected: f.workspace.heads, acceptedMaxCostMicrousd: quote.maxCostMicrousd };
    const proof = await rpc("cancel_logo_vector_edit", [f.projectId, f.command]);
    await expect(rpc("admit_logo_operation", [f.projectId, intent])).rejects.toMatchObject({ code: "PT409", message: "logo_request_conflict" });
    for (const table of ["jobs", "usage_reservations", "logo_operation_requests", "logo_operation_rejections", "logo_concept_batches", "logo_concept_slots", "logo_concept_attempts"]) expect((await db.query(`select count(*)::int n from public.${table}`)).rows, table).toEqual([{ n: 0 }]);
    expect((await db.query("select reserved_microusd from public.usage_accounts where owner_id=$1", [OWNER_A])).rows).toEqual([{ reserved_microusd: 0 }]);
    expect(await rpc("get_logo_workspace", [f.projectId])).toEqual(f.workspace);
    expect(await rpc("cancel_logo_vector_edit", [f.projectId, f.command])).toEqual(proof);
    expect(await rpc("read_logo_vector_edit_request", [f.projectId, f.key])).toEqual(proof);
    const unchanged = { ...intent, requestKey: randomUUID() };
    const receipt = logoDispatchReceiptSchema.parse(await rpc("admit_logo_operation", [f.projectId, unchanged]));
    expect(receipt.jobIds).toHaveLength(6); expect(await rpc("admit_logo_operation", [f.projectId, unchanged])).toEqual(receipt);
    const jobs = (await db.query("select * from public.jobs order by id")).rows;
    await expect(rpc("cancel_logo_vector_edit", [f.projectId, { ...f.command, body: { ...f.command.body, requestKey: unchanged.requestKey } }])).rejects.toMatchObject({ code: "PT409" });
    expect((await db.query("select * from public.jobs order by id")).rows).toEqual(jobs);
    expect((await db.query("select reserved_microusd from public.usage_accounts where owner_id=$1", [OWNER_A])).rows).toEqual([{ reserved_microusd: 600 }]);
  });
  it("fences cancelled-key operation rejection without retaining a competing rejection", async () => {
    const f = await fixture(), proof = await rpc("cancel_logo_vector_edit", [f.projectId, f.command]);
    const intent = { requestKey: f.key, quoteId: randomUUID(), expected: f.workspace.heads, acceptedMaxCostMicrousd: 0 };
    await expect(rpc("admit_logo_operation", [f.projectId, intent])).rejects.toMatchObject({ code: "PT409", message: "logo_request_conflict" });
    for (const table of ["jobs", "usage_reservations", "logo_operation_requests", "logo_operation_rejections"]) expect((await db.query(`select count(*)::int n from public.${table}`)).rows, table).toEqual([{ n: 0 }]);
    expect(await rpc("cancel_logo_vector_edit", [f.projectId, f.command])).toEqual(proof);
    const unchanged = { ...intent, requestKey: randomUUID() }, result = await rpc("admit_logo_operation", [f.projectId, unchanged]);
    expect(result).toMatchObject({ kind: "logo_admission_rejected" }); expect(await rpc("admit_logo_operation", [f.projectId, unchanged])).toEqual(result);
  });
  it("preserves an existing exact immutable success and rejects a changed body", async () => {
    const f = await fixture(), receipt = { ownerId: OWNER_A, projectId: f.projectId, requestKey: f.key, fixture: "Exact existing successful receipt" };
    await db.query("insert into public.logo_workspace_requests(project_id,owner_id,request_key,method,input,receipt) values($1,$2,$3,'saveLogoEdit',$4,$5)", [f.projectId, OWNER_A, f.key, f.command, receipt]);
    const state = { status: "succeeded", ownerId: OWNER_A, projectId: f.projectId, requestKey: f.key, command: f.command, receipt };
    expect(await rpc("cancel_logo_vector_edit", [f.projectId, f.command])).toEqual(state);
    expect(await rpc("read_logo_vector_edit_request", [f.projectId, f.key])).toEqual(state);
    expect((await trusted("select fluid_private.read_logo_trusted_request($1,$2) value", [f.projectId, f.command])).rows).toEqual([{ value: receipt }]);
    const changed = structuredClone(f.command); changed.body.edit.text = "Changed";
    await expect(rpc("cancel_logo_vector_edit", [f.projectId, changed])).rejects.toMatchObject({ code: "PT409" });
    expect((await db.query("select count(*)::int n from public.logo_vector_edit_cancellations")).rows).toEqual([{ n: 0 }]);
  });
  it("isolates owners and forbids anonymous access and all direct table access", async () => {
    const f = await fixture(); await rpc("cancel_logo_vector_edit", [f.projectId, f.command]);
    for (const name of ["cancel_logo_vector_edit", "read_logo_vector_edit_request"]) {
      const args = name === "cancel_logo_vector_edit" ? [f.projectId, f.command] : [f.projectId, f.key];
      await expect(rpc(name, args, OWNER_B)).rejects.toMatchObject({ code: "P0002" });
      await expect(rpc(name, args, null)).rejects.toMatchObject({ code: "42501" });
    }
    for (const owner of [OWNER_A, OWNER_B]) await expect(asRole(db, "authenticated", owner, () => db.query("select * from public.logo_vector_edit_cancellations"))).rejects.toMatchObject({ code: "42501" });
    expect(await rpc("read_logo_vector_edit_request", [f.projectId, f.key])).toMatchObject({ status: "cancelled", requestKey: f.key });
    for (const sql of ["delete from public.logo_vector_edit_cancellations", "update public.logo_vector_edit_cancellations set command=command", "truncate public.logo_vector_edit_cancellations"]) await expect(asRole(db, "authenticated", OWNER_A, () => db.exec(sql))).rejects.toMatchObject({ code: "42501" });
  });
  it("rejects null roles and out-of-range geometry while accepting every bounded edit kind", async () => {
    const f = await fixture();
    const edits = [
      { kind: "text", componentId: "lettering", text: "A" },
      { kind: "font", componentId: "lettering", fontVersionId: randomUUID() },
      { kind: "spacing", componentId: "lettering", letterSpacing: -1000000, lineHeight: 0.1 },
      { kind: "size", componentId: "lettering", scale: 100 },
      { kind: "rotation", componentId: "lettering", degrees: -180 },
      { kind: "color", componentId: "lettering", fill: "#ABCDEF", stroke: null },
      { kind: "arrangement", placements: [{ componentId: "lettering", transform: { x: 0, y: 0, scale: 1, rotation: 0 } }], order: ["lettering"] },
      { kind: "group_components", regions: [{ id: "lettering", role: "lettering", bounds: [0, 0, 10, 10] }] },
      { kind: "replace_outlined_lettering", componentId: "lettering", fontVersionId: randomUUID(), text: "New", contentKind: "brand_name" },
      { kind: "locks", componentIds: [] },
    ];
    for (const edit of edits) expect(await rpc("cancel_logo_vector_edit", [f.projectId, { ...f.command, body: { ...f.command.body, requestKey: randomUUID(), edit } }])).toMatchObject({ status: "cancelled" });
    const invalid = [
      { kind: "group_components", regions: [{ id: "lettering", role: null, bounds: [0, 0, 10, 10] }] },
      { kind: "group_components", regions: [{ id: "lettering", role: "lettering", bounds: [0, 0, 0, 10] }] },
      { kind: "size", componentId: "lettering", scale: 101 },
      { kind: "locks", componentIds: ["lettering", "lettering"] },
      { kind: "arrangement", placements: [{ componentId: "lettering", transform: { x: 0, y: 0, scale: 1, rotation: 0 } }], order: ["other"] },
    ];
    for (const edit of invalid) await expect(rpc("cancel_logo_vector_edit", [f.projectId, { ...f.command, body: { ...f.command.body, requestKey: randomUUID(), edit } }])).rejects.toMatchObject({ code: "22023" });
  });
  it.each(["text", "replace_outlined_lettering"])("matches the shared 1–200 Unicode-point text contract for %s", async kind => {
    const f = await fixture(), fontVersionId = randomUUID();
    const samples = [
      { text: "", valid: false },
      { text: " ", valid: true },
      { text: "A".repeat(200), valid: true },
      { text: "A".repeat(201), valid: false },
      { text: "🐦".repeat(200), valid: true },
      { text: "🐦".repeat(201), valid: false },
      { text: "🐦".repeat(199) + "A", valid: true },
    ];
    for (const { text, valid } of samples) {
      const edit = kind === "text" ? { kind, componentId: "lettering", text } : { kind, componentId: "lettering", fontVersionId, text };
      const command = { ...f.command, body: { ...f.command.body, requestKey: randomUUID(), edit } };
      expect(logoVectorEditCommandSchema.safeParse(command).success, `${kind} shared ${[...text].length} points`).toBe(valid);
      const sql = await db.query<{ valid: boolean }>("select fluid_private.logo_vector_edit_cancel_command_valid($1::jsonb) valid", [command]);
      expect(sql.rows[0]!.valid, `${kind} SQL ${[...text].length} points`).toBe(valid);
      if (valid) {
        const proof = await rpc("cancel_logo_vector_edit", [f.projectId, command]);
        expect(logoVectorEditRequestStateSchema.parse(proof)).toEqual({ status: "cancelled", ownerId: OWNER_A, projectId: f.projectId, requestKey: command.body.requestKey, command });
      } else {
        await expect(rpc("cancel_logo_vector_edit", [f.projectId, command])).rejects.toMatchObject({ code: "22023" });
      }
    }
    for (const text of ["\u0000", "\ud800", "\udfff"]) {
      const edit = kind === "text" ? { kind, componentId: "lettering", text } : { kind, componentId: "lettering", fontVersionId, text };
      const command = { ...f.command, body: { ...f.command.body, requestKey: randomUUID(), edit } };
      expect(logoVectorEditCommandSchema.safeParse(command).success).toBe(false);
      // JSONB itself rejects NUL and unpaired surrogate input before the helper.
      await expect(rpc("cancel_logo_vector_edit", [f.projectId, command])).rejects.toBeDefined();
    }
    expect((await db.query("select count(*)::int n from public.logo_vector_edit_cancellations where project_id=$1", [f.projectId])).rows).toEqual([{ n: 4 }]);
  });
  it("accepts cancellation with stale expected heads but rejects non-edit and malformed commands", async () => {
    const f = await fixture();
    await rpc("apply_logo_workspace_command", [f.projectId, { method: "saveLogoBrief", body: { requestKey: randomUUID(), expected: f.workspace.heads, brief: { name: "Newer", activity: "Studio", audience: "Test", personality: "Calm", logoTypes: ["combination"] } } }]);
    const latest = await rpc("get_logo_workspace", [f.projectId]);
    expect(await rpc("cancel_logo_vector_edit", [f.projectId, f.command])).toMatchObject({ status: "cancelled" });
    expect(await rpc("get_logo_workspace", [f.projectId])).toEqual(latest);
    for (const command of [{ ...f.command, method: "saveLogoBrief" }, { ...f.command, unsafe: true }, { ...f.command, body: { ...f.command.body, edit: { kind: "unknown" } } }]) await expect(rpc("cancel_logo_vector_edit", [f.projectId, command])).rejects.toMatchObject({ code: "22023" });
  });
});
