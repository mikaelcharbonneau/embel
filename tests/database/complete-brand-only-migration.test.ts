import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asRole, createTestDatabase, HASH, OWNER_A, resetFixture, type TestDatabase } from "./local-supabase";

const MIGRATION = "20261109090000_complete_brand_only.sql";
type Row = { id: string; scope: string; current_revision: number; deleted_at: string | null; lifecycle_version: number };

describe("retiring Name only and Visual identity projects", () => {
  let db: TestDatabase;
  beforeAll(async () => { db = await createTestDatabase({ before: MIGRATION }); await resetFixture(db); }, 60_000);
  afterAll(async () => { await db?.close(); });
  const create = (scope: string, title: string) => asRole(db, "authenticated", OWNER_A, async () =>
    (await db.query<{ id: string }>("select * from public.create_project($1,$2,$3::jsonb,$4)", [scope, title, { description: `${title} brief` }, HASH])).rows[0]!.id);
  const project = async (id: string) => (await db.query<Row>("select id,scope,current_revision,deleted_at,lifecycle_version from public.projects where id=$1", [id])).rows[0]!;
  const revisions = async (id: string) => (await db.query<{ revision: number; context: unknown; input_hash: string }>(
    "select revision,context,input_hash from public.project_revisions where project_id=$1 order by revision", [id])).rows;
  const migrate = async () => db.exec(await readFile(new URL(`../../supabase/migrations/${MIGRATION}`, import.meta.url), "utf8"));

  it("turns every project into a complete brand, live ones through a copied revision", async () => {
    const naming = await create("naming_only", "Naming fixture"), visual = await create("visual_identity_only", "Visual fixture");
    const brand = await create("complete_brand", "Brand fixture"), deleted = await create("naming_only", "Deleted fixture");
    await db.query("update public.projects set deleted_at=clock_timestamp(), lifecycle_version=lifecycle_version+1 where id=$1", [deleted]);
    const deletedBefore = await project(deleted), historyBefore = await revisions(naming);

    await migrate();

    for (const id of [naming, visual]) {
      expect(await project(id)).toMatchObject({ scope: "complete_brand", current_revision: 2 });
      const [first, second] = await revisions(id);
      expect(second).toEqual({ ...first, revision: 2 });
    }
    expect((await revisions(naming))[0]).toEqual(historyBefore[0]);
    expect(await project(brand)).toMatchObject({ scope: "complete_brand", current_revision: 1 });
    expect(await revisions(brand)).toHaveLength(1);
    // A deleted project changes type only; it stays deleted with its history.
    expect(await project(deleted)).toEqual({ ...deletedBefore, scope: "complete_brand" });
    expect(await revisions(deleted)).toHaveLength(1);
    // The lifecycle guard is back on for deleted projects.
    await expect(db.query("update public.projects set title='Changed' where id=$1", [deleted])).rejects.toThrow(/project_deleted/);

    // Running it again changes nothing.
    const after = await Promise.all([naming, visual, brand, deleted].map(project));
    await migrate();
    expect(await Promise.all([naming, visual, brand, deleted].map(project))).toEqual(after);
    expect(await revisions(naming)).toHaveLength(2);
  });
});
