import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { asRole, OWNER_A, OWNER_B, resetFixture, seedProject, type TestDatabase } from "./local-supabase";
import {
  inspirationBrands,
  inspirationCatalog,
  inspirationOverviewSchema,
  INSPIRATION_CATALOG_VERSION,
} from "@/domain/inspiration";
import { createVisualDirectionTestDatabase, VISUAL_DATABASE_SETUP_TIMEOUT_MS } from "./visual-direction-fixture";
let db: TestDatabase, project: string;
const design = inspirationCatalog[0]!;
const input = (overrides = {}) => ({
  catalogVersion: INSPIRATION_CATALOG_VERSION,
  expectedProjectRevision: 1,
  expectedRevision: 0,
  ensemble: true,
  elements: [],
  ...overrides,
});
const read = (id = project, owner = OWNER_A) =>
  asRole(db, "authenticated", owner, async () =>
    inspirationOverviewSchema.parse(
      (await db.query<{ value: unknown }>("select public.get_project_inspiration($1) value", [id])).rows[0]!.value,
    ),
  );
const save = (value = input(), id = project, owner = OWNER_A, reference = design.id) =>
  asRole(db, "authenticated", owner, async () =>
    inspirationOverviewSchema.parse(
      (
        await db.query<{ value: unknown }>("select public.set_project_inspiration_reaction($1,$2,$3) value", [
          id,
          reference,
          value,
        ])
      ).rows[0]!.value,
    ),
  );
beforeAll(async () => {
  db = await createVisualDirectionTestDatabase("project inspiration");
}, VISUAL_DATABASE_SETUP_TIMEOUT_MS);
afterAll(async () => {
  await db?.close();
});
beforeEach(async () => {
  await resetFixture(db);
  project = (await seedProject(db)).id;
});
describe("project inspiration database boundary", () => {
  it("starts empty without inventing likes or writing on read; catalog matches the shipped artwork descriptors", async () => {
    expect(await read()).toMatchObject({ ownerId: OWNER_A, projectId: project, selectionRevision: 0, choices: [] });
    expect((await db.query("select * from public.project_inspiration_heads")).rows).toEqual([]);
    const rows = await db.query<{ descriptor: unknown }>(
      "select descriptor from fluid_private.inspiration_catalog order by id",
    );
    expect(rows.rows.map((row) => row.descriptor)).toEqual(
      [...inspirationCatalog].sort((a, b) => a.id.localeCompare(b.id)),
    );
  });
  it("persists independent overall and component likes, supports unliking, and reloads the same values", async () => {
    expect((await save()).choices[0]).toMatchObject({ ensemble: true, elements: [], revision: 1 });
    await save(input({ expectedRevision: 1, ensemble: false, elements: ["colors"] }));
    expect((await read()).choices[0]).toMatchObject({ ensemble: false, elements: ["colors"], revision: 2 });
    await save(input({ expectedRevision: 2, ensemble: false }));
    expect(await read()).toMatchObject({
      selectionRevision: 3,
      choices: [{ ensemble: false, elements: [], revision: 3 }],
    });
    expect((await db.query("select id from public.jobs union all select id from public.assets")).rows).toEqual([]);
  });
  it("saves a whole brand and its parts as one choice, and refuses a part brands don't have", async () => {
    const brand = inspirationBrands[0]!;
    await save(input({ ensemble: true, elements: ["images", "colors", "composition"] }), project, OWNER_A, brand.id);
    expect((await read()).choices).toEqual([
      expect.objectContaining({
        referenceId: brand.id,
        ensemble: true,
        elements: ["colors", "images", "composition"],
        revision: 1,
      }),
    ]);
    await expect(
      save(input({ expectedRevision: 1, elements: ["graphics"] }), project, OWNER_A, brand.id),
    ).rejects.toMatchObject({ code: "22023" });
    expect((await read()).choices[0]).toMatchObject({ elements: ["colors", "images", "composition"], revision: 1 });
  });
  it("isolates different owners and different projects, including direct RLS reads", async () => {
    const other = (await seedProject(db)).id;
    await save();
    expect((await read(other)).choices).toEqual([]);
    await expect(read(project, OWNER_B)).rejects.toMatchObject({ code: "P0002" });
    await expect(save(input(), project, OWNER_B)).rejects.toMatchObject({ code: "P0002" });
    await asRole(db, "authenticated", OWNER_B, async () =>
      expect((await db.query("select * from public.project_inspiration_choices")).rows).toEqual([]),
    );
    expect((await read()).choices).toHaveLength(1);
  });
  it("rejects stale first writes, stale updates, and stale project context without overwriting saved choices", async () => {
    await save();
    await expect(save(input({ ensemble: false }))).rejects.toMatchObject({ code: "PT409" });
    await expect(save(input({ expectedRevision: 1, expectedProjectRevision: 2 }))).rejects.toMatchObject({
      code: "PT409",
    });
    expect((await read()).choices[0]).toMatchObject({ ensemble: true, revision: 1 });
    await save(input({ expectedRevision: 1, elements: ["colors"] }));
    await expect(save(input({ expectedRevision: 1 }))).rejects.toMatchObject({ code: "PT409" });
  });
  it("rejects forged fields, invalid elements, repeated elements, malformed versions and unknown artwork", async () => {
    for (const invalid of [
      { ownerId: OWNER_B },
      { elements: ["typography"] },
      { elements: ["colors", "colors"] },
      { expectedRevision: -1 },
      { expectedProjectRevision: 1.5 },
      { ensemble: "yes" },
      { elements: null },
    ])
      await expect(save(input(invalid))).rejects.toMatchObject({ code: "22023" });
    await expect(save(input({ catalogVersion: "future" }))).rejects.toMatchObject({ code: "PT409" });
    await expect(save(input(), project, OWNER_A, OWNER_B)).rejects.toMatchObject({ code: "P0002" });
    expect((await read()).choices).toEqual([]);
  });
  it("requires a complete or visual scope and authenticated RPC access; blocks raw writes", async () => {
    const row = await asRole(
      db,
      "authenticated",
      OWNER_A,
      async () =>
        (
          await db.query<{ id: string }>(
            "select id from public.create_project('naming_only','Naming','{\"description\":\"Fixture\"}', $1)",
            ["b".repeat(64)],
          )
        ).rows[0]!,
    );
    await expect(save(input(), row.id)).rejects.toMatchObject({ code: "22023" });
    for (const role of ["anon", "service_role"] as const)
      await asRole(db, role, null, async () => {
        await expect(db.query("select public.get_project_inspiration($1)", [project])).rejects.toMatchObject({
          code: "42501",
        });
        await expect(
          db.query("select public.set_project_inspiration_reaction($1,$2,$3)", [project, design.id, input()]),
        ).rejects.toMatchObject({ code: "42501" });
      });
    await asRole(db, "authenticated", OWNER_A, async () => {
      await expect(
        db.query("insert into public.project_inspiration_heads values($1,$2,99)", [project, OWNER_A]),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(db.query("select * from fluid_private.inspiration_catalog")).rejects.toMatchObject({
        code: "42501",
      });
    });
    await expect(db.query("update fluid_private.inspiration_catalog set descriptor='{}'")).rejects.toThrow();
  });
});

it("discovers only installed catalog identifiers without creating state or granting anonymous access", async () => {
  const ids = await asRole(
    db,
    "authenticated",
    OWNER_A,
    async () =>
      (await db.query<{ value: string[] }>("select public.get_inspiration_reference_ids() value")).rows[0]!.value,
  );
  expect(ids).toEqual(inspirationCatalog.map((item) => item.id).sort());
  expect((await db.query("select * from public.project_inspiration_heads")).rows).toEqual([]);
  for (const role of ["anon", "service_role"] as const)
    await asRole(db, role, null, async () => {
      await expect(db.query("select public.get_inspiration_reference_ids()")).rejects.toMatchObject({ code: "42501" });
    });
  await asRole(db, "authenticated", null, async () => {
    await expect(db.query("select public.get_inspiration_reference_ids()")).rejects.toMatchObject({ code: "28000" });
  });
});
