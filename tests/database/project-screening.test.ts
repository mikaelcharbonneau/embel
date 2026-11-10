import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { contextSnapshotSchema } from "@/domain/projects";
import { screeningOverviewSchema, screeningRecordFreshness, screeningRecordSchema } from "@/domain/project-screening";
import { asRole, createTestDatabase, HASH, OWNER_A, OWNER_B, resetFixture, type TestDatabase } from "./local-supabase";
import { screeningInput } from "../fixtures/project-screening";

// Actual local PostgreSQL engine (PGlite), synthetic identities/notes only.
describe("owned project screening records in local SQL", () => {
  let db: TestDatabase, project: string, selection: string;
  const context = contextSnapshotSchema.parse({ description: "Explicit local research fixture" });
  const auth = <T>(run: () => Promise<T>, owner = OWNER_A) => asRole(db, "authenticated", owner, run);
  const input = (extra = {}) => ({ ...screeningInput, selectionId: selection, requestId: randomUUID(), ...extra });
  const read = (cursor: unknown = null, owner = OWNER_A, projectId = project) => auth(async () => screeningOverviewSchema.parse((await db.query<{ value: unknown }>("select public.get_project_screening($1,$2) value", [projectId, cursor])).rows[0]!.value), owner);
  const save = (value = input(), owner = OWNER_A, projectId = project) => auth(async () => screeningRecordSchema.parse((await db.query<{ value: unknown }>("select public.record_project_screening($1,$2) value", [projectId, value])).rows[0]!.value), owner);
  async function selectName(value = "Cedar", revision = 1) {
    const result = await auth(async () => (await db.query<{ value: { entry: { candidate: { id: string } } } }>("select public.import_local_name($1,$2,$3,$4,$5,$6) value", [project, revision, { id: randomUUID(), value, createdAt: screeningInput.observedAt, origin: "manual", history: [] }, context, value.toLowerCase(), randomUUID()])).rows[0]!.value);
    return auth(async () => (await db.query<{ value: { currentSelection: { selection: { id: string } } } }>("select public.select_project_name($1,$2,$3,true) value", [project, result.entry.candidate.id, revision])).rows[0]!.value.currentSelection.selection.id);
  }
  beforeAll(async () => { db = await createTestDatabase(); }, 120000);
  afterAll(async () => { await db?.close(); });
  beforeEach(async () => {
    await resetFixture(db);
    project = await auth(async () => (await db.query<{ id: string }>("select id from public.create_project('naming_only','Research fixture',$1,$2)", [context, HASH])).rows[0]!.id);
    selection = await selectName();
  });
  it("persists an explicitly reviewed owner note and reloads exact saved name/context/criteria", async () => {
    expect((await read()).records).toEqual([]);
    const record = await save(); const page = await read();
    expect(page.records).toEqual([record]); expect(record).toMatchObject({ provenance: "user_recorded", verification: "unverified", legalClearance: "not_assessed", basis: { ownerId: OWNER_A, projectId: project, selectionId: selection, name: "Cedar", projectRevision: 2 }, criteria: screeningInput.criteria });
    expect(screeningRecordFreshness(record, page.currentBasis)).toBe("current_context_unverified");
  });
  it("isolates owners and blocks raw mutations, anonymous/service RPCs and historical changes", async () => {
    const record = await save();
    await expect(read(null, OWNER_B)).rejects.toMatchObject({ code: "P0002" });
    await expect(save(input(), OWNER_B)).rejects.toMatchObject({ code: "P0002" });
    expect(await auth(async () => (await db.query("select * from public.project_screening_records")).rows, OWNER_B)).toEqual([]);
    await expect(auth(() => db.query("update public.project_screening_records set notes='forged'"))).rejects.toMatchObject({ code: "42501" });
    await expect(db.query("delete from public.project_screening_records where id=$1", [record.id])).rejects.toMatchObject({ code: "55000" });
    for (const role of ["anon", "service_role"] as const) await asRole(db, role, null, async () => { await expect(db.query("select public.record_project_screening($1,$2)", [project, input()])).rejects.toMatchObject({ code: "42501" }); });
  });
  it("rejects forged authority, consent, context, criteria and source fields at SQL boundary", async () => {
    for (const patch of [{ verification: "verified" }, { ownerId: OWNER_B }, { result: { availability: "available" } }, { acknowledged: false }, { acknowledged: null }, { observedAt: "2099-01-01T00:00:00Z" }, { sourceUrls: ["https://user:secret@example.com"] }, { sourceUrls: ["javascript:alert(1)"] }, { criteria: { tool: "domains", domain: "example.com", verified: true } }, { criteria: { tool: "handles", handle: "cedar", platform: null } }, { criteria: { tool: "trademarks", mark: "Cedar", mode: null, jurisdictions: ["EM"], niceClasses: [] } }, { criteria: { tool: "trademarks", mark: "Other", mode: "exact_word", jurisdictions: ["EM"], niceClasses: [] } }]) await expect(save(input(patch))).rejects.toMatchObject({ code: "22023" });
    await expect(save(input({ selectionId: OWNER_B }))).rejects.toMatchObject({ code: "PT409" });
    await expect(save(input({ expectedProjectRevision: 1 }))).rejects.toMatchObject({ code: "PT409" });
    expect((await read()).records).toEqual([]);
  });
  it("preserves history while new selections and strategy revisions invalidate its basis", async () => {
    const record = await save();
    const stored = (await db.query<{ context: unknown }>("select context from public.project_revisions where project_id=$1 and revision=2", [project])).rows[0]!.context;
    await auth(() => db.query("select public.append_project_revision($1,2,$2,$3)", [project, { ...stored as object, description: "Changed context" }, HASH]));
    expect(screeningRecordFreshness(record, (await read()).currentBasis)).toBe("earlier_context");
    await expect(save()).rejects.toMatchObject({ code: "PT409" });
    selection = await selectName("Cedar", 3);
    expect((await read()).currentBasis?.selectionId).not.toBe(record.basis.selectionId);
    expect((await read()).records).toEqual([record]);
  });
  it("replays one exact uncertain intent after context changes without duplicate records", async () => {
    const intent = input(); const record = await save(intent);
    selection = await selectName("Elm", 2);
    expect(await save(intent)).toEqual(record);
    await expect(save({ ...intent, notes: "Changed same intent" })).rejects.toMatchObject({ code: "PT409" });
    expect((await read()).records).toHaveLength(1);
  });
  it("paginates immutable history without dropping records or accepting an unrelated cursor", async () => {
    for (let index = 0; index < 21; index++) await save(input({ notes: `Explicit local record ${index}` }));
    const first = await read(); expect(first.records).toHaveLength(20); expect(first.nextCursor).not.toBeNull();
    const second = await read(first.nextCursor); expect(second.records).toHaveLength(1); expect(second.nextCursor).toBeNull();
    expect(new Set([...first.records, ...second.records].map(row => row.id)).size).toBe(21);
    await expect(read({ ...first.nextCursor, id: OWNER_B })).rejects.toMatchObject({ code: "22023" });
  });
});
