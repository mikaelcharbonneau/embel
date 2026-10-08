import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createIdentityTrustedDatabase, bindIdentityFixturePrincipals, asIdentityFixture } from "../database/identity-trusted-database";
import { OWNER_A, resetFixture, seedProject } from "../database/local-supabase";
import { seedIdentityRoot } from "../database/identity-system-database";

// Independent lead probes execute actual private SQL with the restricted local
// login. No helper-call interception, passwords, network or live claims.
describe("trusted Identity preparation capability: independent lead probes", () => {
  let db: Awaited<ReturnType<typeof createIdentityTrustedDatabase>>;
  beforeAll(async () => { db = await createIdentityTrustedDatabase(); }, 30_000);
  afterAll(async () => { await db?.close(); });
  beforeEach(async () => { await resetFixture(db); await bindIdentityFixturePrincipals(db); });

  async function source() {
    const project = await seedProject(db);
    const seeded = await seedIdentityRoot(db, project.id);
    return { project, request: { systemVersionId: seeded.system.id,
      expectedProjectRevision: seeded.input.projectRevision,
      expectedReferenceRevision: seeded.input.referenceSnapshot.referenceRevision,
      expectedPreferencesRevision: 0, expectedIdentityRevision: 0, acceptEarlierBasis: false } };
  }
  const prepare = (project: string, request: unknown) => db.query(
    "select fluid_private.prepare_identity_transaction($1::uuid,$2::jsonb,false) value", [project, JSON.stringify(request)]);
  const commit = (project: string, request: unknown) => db.query(
    "select fluid_private.commit_identity_transaction($1::uuid,$2::jsonb,'{}'::jsonb) value", [project, JSON.stringify(request)]);
  async function ownerClaim() { await db.query("select set_config('request.jwt.claim.sub',$1,false)", [OWNER_A]); }
  async function transaction(run: () => Promise<void>) {
    await db.exec("begin");
    try { await run(); }
    finally { await db.exec("rollback"); }
  }

  it.each(["table", "view"])("rejects a caller-created temporary %s before owned preparation", async kind => {
    const { project, request } = await source();
    await asIdentityFixture(db, OWNER_A, async () => {
      await ownerClaim();
      await transaction(async () => {
        await db.exec(kind === "table"
          ? "create temporary table identity_transaction_preparation(project_id uuid,request jsonb,payload jsonb)"
          : "create temporary view identity_transaction_preparation as select null::uuid project_id");
        await expect(prepare(project.id, request)).rejects.toMatchObject({ code: "42501" });
      });
    });
    expect((await db.query("select * from public.identity_selections")).rows).toEqual([]);
  });

  it("autocommit preparation grants no capability to a later transaction", async () => {
    const { project, request } = await source();
    await asIdentityFixture(db, OWNER_A, async () => {
      await ownerClaim();
      const prepared = await prepare(project.id, request);
      expect(prepared.rows).toHaveLength(1);
      await expect(commit(project.id, request)).rejects.toMatchObject({ code: "55000" });
    });
    expect((await db.query("select * from public.identity_selections")).rows).toEqual([]);
  });

  it("rolling back preparation to a savepoint invalidates its capability", async () => {
    const { project, request } = await source();
    await asIdentityFixture(db, OWNER_A, async () => {
      await ownerClaim();
      await transaction(async () => {
        await db.exec("savepoint before_preparation");
        await prepare(project.id, request);
        await db.exec("rollback to savepoint before_preparation");
        await db.exec("savepoint stale_commit");
        await expect(commit(project.id, request)).rejects.toMatchObject({ code: "55000" });
        await db.exec("rollback to savepoint stale_commit");
        expect((await prepare(project.id, request)).rows).toHaveLength(1);
      });
    });
    expect((await db.query("select * from public.identity_selections")).rows).toEqual([]);
  });

  it("cannot inspect or modify the definer-owned preparation through raw SQL", async () => {
    const { project, request } = await source();
    await asIdentityFixture(db, OWNER_A, async () => {
      await ownerClaim();
      await transaction(async () => {
        await prepare(project.id, request);
        await expect(db.query("select * from pg_temp.identity_transaction_preparation")).rejects.toMatchObject({ code: "42501" });
      });
    });
  });

  it("DISCARD TEMP cannot reopen an earlier lock sequence inside the same transaction", async () => {
    const { project, request } = await source();
    await asIdentityFixture(db, OWNER_A, async () => {
      await ownerClaim();
      await transaction(async () => {
        await prepare(project.id, request);
        await db.exec("discard temp");
        await db.query("select pg_catalog.pg_advisory_unlock_all()");
        await expect(prepare(project.id, request)).rejects.toMatchObject({ code: "PT409" });
      });
    });
    expect((await db.query("select * from public.identity_selections")).rows).toEqual([]);
  });

  it("a forged validation GUC cannot replace preparation or SET ROLE authority", async () => {
    const { project, request } = await source();
    await asIdentityFixture(db, OWNER_A, async () => {
      await ownerClaim();
      await db.query("select set_config('fluid.identity.validated','true',false)");
      await expect(commit(project.id, request)).rejects.toMatchObject({ code: "55000" });
      await expect(db.exec("set role fluid_identity_writer_definer_v1")).rejects.toMatchObject({ code: "42501" });
      await expect(db.query("select fluid_private.identity_web_owner() ")).rejects.toMatchObject({ code: "42501" });
    });
  });
});
