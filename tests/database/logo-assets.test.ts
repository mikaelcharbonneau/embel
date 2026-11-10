import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  asRole,
  createTestDatabase,
  OWNER_A,
  OWNER_B,
  resetFixture,
  seedProject,
  type TestDatabase,
} from "./local-supabase";
const bytes = new Uint8Array(
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDfsAAAAASUVORK5CYII=",
      "base64",
    ),
  ),
  hash = createHash("sha256").update(bytes).digest("hex");
describe("local private asset publication SQL", () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await createTestDatabase();
    await db.exec(
      `create role fixture_logo_assets_a login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;grant usage on schema public,fluid_private to fixture_logo_assets_a;grant execute on function fluid_private.prepare_logo_asset(uuid,jsonb,uuid,uuid),fluid_private.observe_logo_asset(uuid,jsonb,uuid,uuid),fluid_private.read_logo_asset_publication(uuid,jsonb,uuid,uuid) to fixture_logo_assets_a;`,
    );
    await db.query(
      "insert into fluid_private.logo_asset_web_principals(role_name,role_oid,owner_id) select rolname,oid,$1 from pg_roles where rolname='fixture_logo_assets_a'",
      [OWNER_A],
    );
  }, 40_000);
  afterAll(async () => {
    await db?.close();
  });
  beforeEach(async () => {
    await resetFixture(db);
  });
  async function trusted<T>(run: () => Promise<T>) {
    await db.exec("set session authorization fixture_logo_assets_a");
    try {
      return await run();
    } finally {
      await db.exec("set session authorization postgres");
    }
  }
  const write = (key = randomUUID()) => ({
    kind: "upload",
    intent: {
      requestKey: key,
      usage: "logo_reference",
      mimeType: "image/png",
      contentHash: hash,
      rightsDeclaration: "My own fixture",
    },
    byteLength: bytes.length,
  });
  async function prepare(project: string, input = write()) {
    return trusted(
      async () =>
        (
          await db.query<{ value: Record<string, unknown> }>(
            "select fluid_private.prepare_logo_asset($1,$2,null,null) value",
            [project, input],
          )
        ).rows[0]!.value,
    );
  }
  async function observe(id: unknown, contentHash = hash) {
    return trusted(
      async () =>
        (
          await db.query<{ value: Record<string, unknown> }>(
            "select fluid_private.observe_logo_asset($1,$2,null,null) value",
            [
              id,
              {
                status: "verified",
                checkedAt: "2026-10-07T00:00:00Z",
                contentHash,
                mimeType: "image/png",
                byteLength: bytes.length,
              },
            ],
          )
        ).rows[0]!.value,
    );
  }
  it("reserves exact replay once and commits an upload only after trusted byte observation", async () => {
    const project = await seedProject(db),
      input = write(),
      first = await prepare(project.id, input);
    expect(await prepare(project.id, input)).toEqual(first);
    expect((await db.query("select count(*)::int count from public.asset_versions")).rows[0]).toEqual({ count: 0 });
    const receipt = await observe(first.id);
    expect(receipt).toMatchObject({
      publicationState: "committed",
      purpose: "reference_media",
      verification: { contentHash: hash, byteLength: bytes.length },
    });
    expect(await observe(first.id)).toEqual(receipt);
    expect((await db.query("select count(*)::int count from public.asset_versions")).rows[0]).toEqual({ count: 1 });
  });
  it("changed body under same request key conflicts without another version", async () => {
    const project = await seedProject(db),
      input = write();
    await prepare(project.id, input);
    await expect(
      prepare(project.id, { ...input, intent: { ...input.intent, rightsDeclaration: "Different" } }),
    ).rejects.toMatchObject({ code: "PT409" });
    expect((await db.query("select count(*)::int count from public.logo_asset_publications")).rows[0]).toEqual({
      count: 1,
    });
  });
  it("foreign project cannot reserve or observe owned bytes", async () => {
    const project = await seedProject(db, OWNER_B);
    await expect(prepare(project.id)).rejects.toMatchObject({ code: "P0002" });
  });
  it("authenticated metadata forgery cannot call trusted byte observation", async () => {
    const project = await seedProject(db),
      row = await prepare(project.id);
    await expect(
      asRole(db, "authenticated", OWNER_A, () =>
        db.query("select fluid_private.observe_logo_asset($1,$2,null,null)", [row.id, {}]),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(observe(row.id, "b".repeat(64))).rejects.toMatchObject({ code: "22023" });
    expect((await db.query("select count(*)::int count from public.asset_versions")).rows[0]).toEqual({ count: 0 });
  });
  it("administrator or a forged auth GUC is not the bound web writer", async () => {
    const project = await seedProject(db);
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [OWNER_A]);
    await expect(
      db.query("select fluid_private.prepare_logo_asset($1,$2,null,null)", [project.id, write()]),
    ).rejects.toMatchObject({ code: "42501" });
  });
});
