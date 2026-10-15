import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { asRole, createTestDatabase, OWNER_A, OWNER_B, resetFixture, seedProject, type TestDatabase } from "./local-supabase";
import { inspirationCatalog, INSPIRATION_CATALOG_VERSION } from "@/domain/inspiration";
import { emptyVisualGuidance, visualDirectionOverviewSchema } from "@/domain/visual-direction";
let db: TestDatabase, project: string;
const input = (overrides = {}) => ({ expectedRevision: 0, expectedProjectRevision: 1, expectedSelectionRevision: 0,
  catalogVersion: INSPIRATION_CATALOG_VERSION, guidance: { ...emptyVisualGuidance(), character: "Clear, warm, readable" }, ...overrides });
const rpc = (name: string, args: unknown[], owner = OWNER_A) => asRole(db, "authenticated", owner, async () =>
  (await db.query<{ value: unknown }>(`select public.${name}(${args.map((_, i) => `$${i + 1}`).join(",")}) value`, args)).rows[0]!.value);
const read = (id = project, owner = OWNER_A) => rpc("get_project_visual_direction", [id], owner).then(value => visualDirectionOverviewSchema.parse(value));
const save = (value = input(), id = project, owner = OWNER_A) => rpc("review_project_visual_direction", [id, value], owner).then(result => visualDirectionOverviewSchema.parse(result));
const like = (expectedRevision = 0, elements = ["colors"]) => rpc("set_project_inspiration_reaction", [project, inspirationCatalog[0]!.id, {
  catalogVersion: INSPIRATION_CATALOG_VERSION, expectedProjectRevision: 1, expectedRevision, ensemble: false, elements }]);
beforeAll(async () => { db = await createTestDatabase(); }, 120000);
afterAll(async () => { await db?.close(); });
beforeEach(async () => { await resetFixture(db); project = (await seedProject(db)).id; });
describe("reviewed visual direction PostgreSQL boundary", () => {
  it("never writes or fabricates reviews on read; explicit saves freeze selected aspects and written guidance", async () => {
    expect(await read()).toMatchObject({ current: null, history: [], stale: false });
    expect((await db.query("select * from public.project_visual_directions")).rows).toHaveLength(0);
    await like(); const saved = await save(input({ expectedSelectionRevision: 1 }));
    expect(saved.current).toMatchObject({ ownerId: OWNER_A, projectId: project, revision: 1, selectionRevision: 1,
      references: [{ referenceId: inspirationCatalog[0]!.id, ensemble: false, elements: ["colors"], description: inspirationCatalog[0]!.description }] });
    expect(await read()).toEqual(saved);
    expect((await db.query("select id from public.jobs union all select id from public.assets")).rows).toEqual([]);
  });
  it("preserves immutable earlier versions and marks changed inspiration stale without overwriting guidance", async () => {
    await like(); const first = await save(input({ expectedSelectionRevision: 1 }));
    await like(1, []); expect((await read()).stale).toBe(true);
    await expect(save(input({ expectedRevision: 1, expectedSelectionRevision: 1 }))).rejects.toMatchObject({ code: "PT409" });
    const second = await save(input({ expectedRevision: 1, expectedSelectionRevision: 2, guidance: { ...emptyVisualGuidance(), colors: "Deep blue, high contrast" } }));
    expect(second.current?.revision).toBe(2); expect(second.history).toEqual([first.current]); expect(second.stale).toBe(false);
    await expect(db.query("update public.project_visual_directions set record=record where project_id=$1", [project])).rejects.toThrow(/immutable/i);
    await expect(db.query("delete from public.project_visual_directions where project_id=$1", [project])).rejects.toThrow(/immutable/i);
  });
  it("rejects stale revisions, forged sources, blank or oversized guidance and naming-only scope", async () => {
    await save();
    await expect(save()).rejects.toMatchObject({ code: "PT409" });
    for (const change of [{ ownerId: OWNER_B }, { references: [] }, { expectedRevision: 1.5 }, { guidance: { ...emptyVisualGuidance(), extra: "forged" } }, { guidance: { ...emptyVisualGuidance(), character: "x".repeat(1201) } }, { guidance: { ...emptyVisualGuidance(), character: "🟣".repeat(601) } }, { guidance: { ...emptyVisualGuidance(), character: "\u00a0untrimmed" } }])
      await expect(save(input({ expectedRevision: 1, ...change }))).rejects.toMatchObject({ code: "22023" });
    await expect(save(input({ expectedRevision: 1, guidance: emptyVisualGuidance() }))).rejects.toMatchObject({ code: "22023" });
    const naming = (await asRole(db, "authenticated", OWNER_A, async () => (await db.query<{ id: string }>("select id from public.create_project('naming_only','Local naming','{}',$1)", ["b".repeat(64)])).rows[0]!)).id;
    await expect(save(input(), naming)).rejects.toMatchObject({ code: "22023" });
    expect((await read()).current?.revision).toBe(1);
  });
  it("isolates owners/projects and denies raw writes, helper calls and anonymous or worker RPC access", async () => {
    const second = (await seedProject(db)).id; await save();
    expect((await read(second)).current).toBeNull();
    await expect(read(project, OWNER_B)).rejects.toMatchObject({ code: "P0002" });
    await expect(save(input(), project, OWNER_B)).rejects.toMatchObject({ code: "P0002" });
    await asRole(db, "authenticated", OWNER_B, async () => expect((await db.query("select * from public.project_visual_directions")).rows).toEqual([]));
    for (const role of ["anon", "service_role"] as const) await asRole(db, role, null, async () => {
      await expect(db.query("select public.get_project_visual_direction($1)", [project])).rejects.toMatchObject({ code: "42501" });
      await expect(db.query("select public.review_project_visual_direction($1,$2)", [project, input()])).rejects.toMatchObject({ code: "42501" });
    });
    await asRole(db, "authenticated", OWNER_A, async () => {
      await expect(db.query("insert into public.project_visual_directions(owner_id,project_id,revision,record) values($1,$2,9,'{}')", [OWNER_A, project])).rejects.toMatchObject({ code: "42501" });
      await expect(db.query("select fluid_private.visual_direction_latest($1,$2)", [OWNER_A, project])).rejects.toMatchObject({ code: "42501" });
    });
  });
  it("keeps the prior no-Inspiration generation basis compatible but requires explicit review for new likes", async () => {
    const current = async (snapshot: unknown) => (await db.query<{ valid: boolean }>("select fluid_private.visual_direction_source_current($1,$2,$3) valid", [OWNER_A, project, snapshot])).rows[0]!.valid;
    expect(await current(null)).toBe(true); expect(await current({ forged: true })).toBe(false);
    await like(); expect(await current(null)).toBe(false);
    const review = (await save(input({ expectedSelectionRevision: 1 }))).current!; expect(await current(review)).toBe(true);
    expect(await current({ ...review, guidance: { ...review.guidance, colors: "Forged" } })).toBe(false);
    await like(1, []); expect(await current(review)).toBe(false); expect(await current(null)).toBe(false);
  });
});
