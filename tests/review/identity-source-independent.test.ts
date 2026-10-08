import { randomUUID, createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { getIdentitySystem, getProjectIdentity, listIdentitySystems } from "../../src/server/data/identity";
import { identitySystemVersionSchema, validateIdentityRefinement } from "../../src/domain/project-identity";
import { asRole, createTestDatabase, HASH, OWNER_A, resetFixture, seedProject, type TestDatabase } from "../database/local-supabase";
import { seedIdentityRoot, identityDalAuth } from "../database/identity-system-database";
import { readReferences, react, seedReference } from "../database/identity-reference-database";
import { createIdentityTransactionService } from "../../src/server/data/identity-transaction";
import { createIdentityTransactionFixture } from "../server/fixtures/identity-transaction";

type Root = Awaited<ReturnType<typeof seedIdentityRoot>>;
describe("independent Identity completed-source and replay review", () => {
  let db: TestDatabase, project: string;
  beforeAll(async () => { db = await createTestDatabase(); }, 30_000);
  afterAll(async () => { await db?.close(); });
  beforeEach(async () => { await resetFixture(db); project = (await seedProject(db)).id; });
  // Enabled semantics use the actual injected local transaction; production is gated.
  const selectIdentitySystem = (auth: {userId:string}, id:string, request:unknown) => createIdentityTransactionService(createIdentityTransactionFixture(db,auth.userId).factory).select(auth,id,request);
  const refineIdentityComponent = (auth: {userId:string}, id:string, request:unknown) => createIdentityTransactionService(createIdentityTransactionFixture(db,auth.userId).factory).refine(auth,id,request);
  const selection = (root: Root, expectedIdentityRevision = 0) => ({ systemVersionId: root.system.id, expectedProjectRevision: root.input.projectRevision, expectedReferenceRevision: root.input.referenceSnapshot.referenceRevision, expectedPreferencesRevision: 0, expectedIdentityRevision, acceptEarlierBasis: false });
  const selectionCount = async () => (await db.query<{ count: number }>("select count(*)::int count from public.identity_selections")).rows[0]!.count;
  const raw = async (name: "get_identity_system" | "get_project_identity", args: unknown[]) => asRole(db, "authenticated", OWNER_A, async () => (await db.query<{ value: unknown }>(`select public.${name}($1,$2) value`, args)).rows[0]!.value);
  // Rewrite only administrative fixture INSERT parameters, before immutable rows exist.
  // This never disables guards, edits implementation or adds a production constructor.
  function fixtureWrites(rewrite: (sql: string, args: unknown[]) => unknown[]): TestDatabase {
    return new Proxy(db, { get(target, key) {
      if (key === "query") return (sql: string, args: unknown[] = []) => target.query(sql, rewrite(sql, [...args]));
      const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
    } });
  }

  it("retains exact completed evidence after the enclosing job later fails", async () => {
    const root = await seedIdentityRoot(db, project);
    await db.query("update public.jobs set state='failed' where id=$1", [root.jobId]);
    expect((await getIdentitySystem(identityDalAuth(db), project, root.system.id)).system).toEqual(root.system);
    expect((await selectIdentitySystem(identityDalAuth(db), project, selection(root))).currentSelection.system.id).toBe(root.system.id);
  });

  it.each(["failed", "ambiguous", "in_flight"])("rejects actual %s step evidence before selecting", async state => {
    const root = await seedIdentityRoot(db, project);
    await db.query("update public.job_steps set state=$1 where job_id=$2", [state, root.jobId]);
    await expect(getIdentitySystem(identityDalAuth(db), project, root.system.id)).rejects.toMatchObject({ code: "integration_unavailable" });
    await expect(selectIdentitySystem(identityDalAuth(db), project, selection(root))).rejects.toMatchObject({ code: "integration_unavailable" });
    expect(await selectionCount()).toBe(0);
  });

  it("rejects changed full output input even when its material basis remains identical", async () => {
    const root = await seedIdentityRoot(db, project), output = structuredClone(root.output);
    output.identity.input.capturedAt = "2026-01-01T00:00:00Z";
    expect(output.identity.input.basis).toEqual(root.input.basis);
    await db.query("update public.job_steps set output=$1::jsonb where job_id=$2", [JSON.stringify(output), root.jobId]);
    await expect(selectIdentitySystem(identityDalAuth(db), project, selection(root))).rejects.toMatchObject({ code: "integration_unavailable" });
    expect(await selectionCount()).toBe(0);
  });

  it("keeps generated manifest timestamp spelling usable at a paginated history boundary", async () => {
    await seedIdentityRoot(db, project); await seedIdentityRoot(db, project);
    const page = await listIdentitySystems(identityDalAuth(db), project, { limit: 1 });
    expect(page.items).toHaveLength(1); expect(page.nextCursor).not.toBeNull();
    expect(page.nextCursor!.createdAt).toBe(page.items[0]!.createdAt);
    const next = await listIdentitySystems(identityDalAuth(db), project, { limit: 1, cursor: page.nextCursor! });
    expect(next.items).toHaveLength(1); expect(next.items[0]!.id).not.toBe(page.items[0]!.id);
  });

  it.each(["board extra", "production extra", "production blank role", "input extra", "input scope", "input capturedAt", "system createdAt"])("rejects malformed stored %s before any selection or usage publication", async kind => {
    const mutateInput = (input: Record<string, unknown>) => {
      if (kind === "input extra") input.extraClaim = true;
      if (kind === "input scope") input.scope = "unknown_scope";
      if (kind === "input capturedAt") input.capturedAt = "not-a-date";
    };
    const mutateSystem = (system: { input: Record<string, unknown>; board: Record<string, unknown>; productionFiles: Array<Record<string, unknown>>; createdAt: string }) => {
      mutateInput(system.input);
      if (kind === "board extra") system.board.extraClaim = true;
      if (kind === "production extra") system.productionFiles[0]!.extraClaim = true;
      if (kind === "production blank role") system.productionFiles[0]!.role = " ";
      if (kind === "system createdAt") system.createdAt = "2000-01-01 00:00:00+00";
    };
    const fixture = fixtureWrites((sql, args) => {
      if (sql.startsWith("insert into public.identity_input_snapshots")) { const input = JSON.parse(String(args[5])); mutateInput(input); args[5] = JSON.stringify(input); }
      if (sql.startsWith("insert into public.job_steps")) { const output = JSON.parse(String(args[5])); mutateInput(output.identity.input); mutateSystem(output.identity.systems[0]); args[5] = JSON.stringify(output); }
      if (sql.startsWith("insert into public.identity_system_versions")) {
        const system = { input: {}, board: JSON.parse(String(args[6])), productionFiles: JSON.parse(String(args[7])), createdAt: String(args[8]) }; mutateSystem(system);
        args[6] = JSON.stringify(system.board); args[7] = JSON.stringify(system.productionFiles); args[8] = system.createdAt;
      }
      if (sql.startsWith("insert into public.identity_system_files") && args[1] === 1 && kind === "production blank role") args[5] = " ";
      return args;
    });
    if (kind === "system createdAt") {
      await expect(seedIdentityRoot(fixture, project)).rejects.toMatchObject({ code: "22023" });
      expect(await selectionCount()).toBe(0);
      return;
    }
    const root = await seedIdentityRoot(fixture, project);
    await expect(getIdentitySystem(identityDalAuth(db), project, root.system.id)).rejects.toMatchObject({ code: "integration_unavailable" });
    await expect(selectIdentitySystem(identityDalAuth(db), project, selection(root))).rejects.toMatchObject({ code: "integration_unavailable" });
    expect(await selectionCount()).toBe(0);
    expect((await db.query<{ count: number }>("select count(*)::int count from public.asset_usages")).rows[0]!.count).toBe(0);
  });

  it("rejects malformed authoritative source URLs before committing a selection receipt", async () => {
    const root = await seedIdentityRoot(db, project);
    const context = { ...structuredClone(root.input.context), competitors: [{ id: randomUUID(), name: "Local invalid source", relevance: "Fixture", origin: "user", selected: true, url: "https://[broken", sources: [] }] };
    await asRole(db, "authenticated", OWNER_A, () => db.query("select public.append_project_revision($1,$2,$3::jsonb,$4)", [project, root.input.projectRevision, JSON.stringify(context), HASH]));
    await expect(selectIdentitySystem(identityDalAuth(db), project, { ...selection(root), expectedProjectRevision: root.input.projectRevision + 1, acceptEarlierBasis: true })).rejects.toBeDefined();
    expect(await selectionCount()).toBe(0);
  });

  it("preserves an exact two-edit manual chain and replays an old intent without restoring its head", async () => {
    const root = await seedIdentityRoot(db, project), auth = identityDalAuth(db), { systemVersionId, ...fences } = selection(root);
    const firstRequest = { ...fences, baseSystemVersionId: systemVersionId, component: "colors", input: { swatches: [{ key: "primary", name: "Changed", hex: "#AABBCC" }], usageNotes: "User palette" }, idempotencyKey: "independent-colors-first-0001" };
    const first = await refineIdentityComponent(auth, project, firstRequest);
    const second = await refineIdentityComponent(auth, project, { ...fences, expectedIdentityRevision: 1, baseSystemVersionId: first.system.id, component: "typography", input: { styles: [{ key: "body", role: "Body", family: "User family", weight: 500, style: "normal" }], usageNotes: "User specification" }, idempotencyKey: "independent-typography-second-0002" });
    validateIdentityRefinement({ base: root.system, ...first }); validateIdentityRefinement({ base: first.system, ...second });
    expect(second.system.input).toEqual(root.input); expect(second.system.board.staleComponents).toEqual(["colors", "typography"]);
    expect((await getIdentitySystem(auth, project, second.system.id)).system).toEqual(second.system);
    expect(await refineIdentityComponent(auth, project, firstRequest)).toEqual(first);
    expect((await getProjectIdentity(auth, project)).currentSelection!.system.id).toBe(second.system.id);
  });

  it("uses all currently selected references independently of a filtered page and never captures on GET", async () => {
    const root = await seedIdentityRoot(db, project), extra = await seedReference(db, project, { tags: ["exclude-this"] });
    await react(db, project, extra.reference, { expectedRevision: 0, ensemble: false, elements: ["colors"] });
    const page = await readReferences(db, project, { excludedTags: ["exclude-this"], limit: 1 });
    expect(page.references.items).toHaveLength(1); expect(page.selectedReferenceCount).toBe(2);
    const before = (await db.query("select snapshot from public.identity_reference_snapshots order by reference_revision")).rows;
    const overview = await getProjectIdentity(identityDalAuth(db), project);
    expect(overview.referenceSnapshot.selectedReferenceCount).toBe(2); expect(overview.referenceSnapshot.selected).toHaveLength(2);
    expect((await db.query("select snapshot from public.identity_reference_snapshots order by reference_revision")).rows).toEqual(before);
    await selectIdentitySystem(identityDalAuth(db), project, { ...selection(root), expectedReferenceRevision: 2, acceptEarlierBasis: true });
    const after = (await db.query<{ snapshot: unknown }>("select snapshot from public.identity_reference_snapshots order by reference_revision")).rows;
    expect(after).toHaveLength(2); expect(after[0]).toEqual(before[0]); expect(after[1]!.snapshot).toMatchObject({ selectedReferenceCount: 2, selected: overview.referenceSnapshot.selected });
  });

  it("rejects reusing another completed step's coordinated board as a production file", async () => {
    const root = await seedIdentityRoot(db, project, { productionFiles: false }), auth = identityDalAuth(db);
    const systemId = randomUUID(), assetId = randomUUID(), versionId = randomUUID(), stepKey = "identity.synthetic.second";
    const board = { ownerId: OWNER_A, projectId: project, assetId, versionId, contentHash: createHash("sha256").update(versionId).digest("hex"), purpose: "brand_asset", mimeType: "image/png" };
    const system = identitySystemVersionSchema.parse({ ...structuredClone(root.system), id: systemId, source: { ...root.system.source, stepKey }, board: { asset: board, depictsSystemVersionId: systemId, staleComponents: [] }, productionFiles: [{ component: "logo", role: "Reused board", asset: root.system.board.asset }] });
    await db.query("insert into public.assets(id,owner_id,project_id,kind,purpose) values($1,$2,$3,'Explicit review board','brand_asset')", [assetId, OWNER_A, project]);
    await db.query("insert into public.asset_versions(id,owner_id,project_id,asset_id,version,input_revision,input_hash,content_hash,mime_type,provenance) values($1,$2,$3,$4,1,$5,$6,$7,'image/png','{}')", [versionId, OWNER_A, project, assetId, root.input.projectRevision, HASH, board.contentHash]);
    const output = { identity: { ...structuredClone(root.output.identity), stepKey, systems: [system] } };
    await db.query("insert into public.job_steps(job_id,owner_id,project_id,step_key,request_key,state,reserved_cost_microusd,output,completed_at) values($1,$2,$3,$4,$5,'succeeded',0,$6::jsonb,clock_timestamp())", [root.jobId, OWNER_A, project, stepKey, `review-${systemId}`, JSON.stringify(output)]);
    await db.query("insert into public.identity_system_versions(id,project_id,owner_id,input_id,source,components,board,production_files,created_at,root_system_id,created_at_text) values($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb,$9::text::timestamptz,$1,$9::text)", [systemId, project, OWNER_A, root.inputId, JSON.stringify(system.source), JSON.stringify(system.components), JSON.stringify(system.board), JSON.stringify(system.productionFiles), system.createdAt]);
    for (const [slot, file] of [{ component: null, role: "board", asset: system.board.asset }, ...system.productionFiles].entries()) await db.query("insert into public.identity_system_files(system_id,slot,project_id,owner_id,component,role,asset_id,version_id) values($1,$2,$3,$4,$5,$6,$7,$8)", [systemId, slot, project, OWNER_A, file.component, file.role, file.asset.assetId, file.asset.versionId]);
    await db.query("insert into public.identity_generated_roots(system_id,project_id,owner_id,batch_id,job_id,step_key,output_index,board) values($1,$2,$3,$4,$5,$6,0,$7::jsonb)", [systemId, project, OWNER_A, root.batchId, root.jobId, stepKey, JSON.stringify(system.board.asset)]);
    await expect(raw("get_project_identity", [project, "{}"])).rejects.toMatchObject({ code: "55000" });
    await expect(getIdentitySystem(auth, project, systemId)).rejects.toMatchObject({ code: "integration_unavailable" });
    await expect(selectIdentitySystem(auth, project, { ...selection(root), systemVersionId: systemId })).rejects.toMatchObject({ code: "integration_unavailable" });
    expect(await selectionCount()).toBe(0);
  });
});
