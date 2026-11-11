import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  namingStrategyBasisSchema,
  namingStrategyKeyFromBasis,
  projectNameCandidateSchema,
} from "../../src/domain/project-naming";
import { z } from "zod";
import { projectNamingOverviewSchema } from "../../src/domain/naming-jobs";
import { asRole, createTestDatabase, HASH, OWNER_A, OWNER_B, resetFixture, type TestDatabase } from "./local-supabase";
import { seedGeneratedNames } from "./retired-worker-fixture";
import { reviewedStrategy } from "../fixtures/reviewed-strategy";

// PGlite only. All identities, model names, sources and provider responses are fixtures.
// The old Naming worker is retired; a finished generated batch is written as it left it.
const context = reviewedStrategy({ description: "Explicit local naming fixture" });
const preferences = { version: 1, creativeLocale: "en", notes: "", minimumGraphemes: null, maximumGraphemes: null };
const at = "2026-10-04T12:00:00Z";
// Only the saved candidate ids of a finished old-worker batch are read back from the database.
const batchDetailSchema = z.object({ result: z.object({ candidateIds: z.array(z.uuid()) }).nullable() });
function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (!value || typeof value !== "object") return value;
  const row = Object.fromEntries(Object.entries(value).map(([key, child]) => [key, normalize(child)]));
  if (row.strategyBasis)
    row.strategyKey = namingStrategyKeyFromBasis(namingStrategyBasisSchema.parse(row.strategyBasis));
  return row;
}

describe("project Naming database boundaries (local fixture only)", () => {
  let db: TestDatabase;
  let project: string;
  beforeAll(async () => {
    db = await createTestDatabase();
  }, 30_000);
  afterAll(async () => {
    await db?.close();
  });
  const auth = <T>(run: () => Promise<T>, owner = OWNER_A) => asRole(db, "authenticated", owner, run);
  async function rpc(name: string, args: unknown[] = [], owner = OWNER_A) {
    return auth(
      async () =>
        (
          await db.query<{ result: unknown }>(
            `select public.${name}(${args.map((_, index) => `$${index + 1}`).join(",")}) as result`,
            args,
          )
        ).rows[0]!.result,
      owner,
    );
  }
  async function create(owner = OWNER_A, scope = "complete_brand") {
    return auth(
      async () =>
        (
          await db.query<{ id: string }>("select * from public.create_project($1,'Naming fixture',$2::jsonb,$3)", [
            scope,
            JSON.stringify(context),
            HASH,
          ])
        ).rows[0]!.id,
      owner,
    );
  }
  beforeEach(async () => {
    await resetFixture(db);
    project = await create();
  });
  const save = (version = 0, value = preferences) =>
    rpc("save_naming_preferences", [project, version, JSON.stringify(value)]);
  async function generate() {
    await save();
    const { batchId } = await seedGeneratedNames(db, OWNER_A, project, ["Cedar", "Elm"]);
    const detail = batchDetailSchema.parse(normalize(await rpc("get_naming_batch", [project, batchId])));
    return { ids: detail.result!.candidateIds };
  }
  async function importName(
    value = "User Name",
    key = "fixture-local-import-0001",
    target = project,
    owner = OWNER_A,
    revision = 1,
    captured = context,
  ) {
    return rpc(
      "import_local_name",
      [
        target,
        revision,
        JSON.stringify({
          id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          value,
          createdAt: at,
          origin: "manual",
          history: [],
        }),
        JSON.stringify(captured),
        value.toLowerCase().replace(/\s/g, ""),
        key,
      ],
      owner,
    ) as Promise<{ entry: { candidate: { id: string; origin: unknown } } }>;
  }

  it("reads an unsaved session without invented preferences or provider availability", async () => {
    const overview = projectNamingOverviewSchema.parse(normalize(await rpc("get_project_naming", [project])));
    expect(overview.session).toBeNull();
    expect(overview.preferences).toBeNull();
    expect(overview.availability).toMatchObject({ status: "unavailable", reason: "naming_policy_unavailable" });
    await expect(rpc("get_project_naming", [project], OWNER_B)).rejects.toMatchObject({ code: "P0002" });
  });
  it("appends preferences, conflicts on stale input and leaves project revision unchanged", async () => {
    await save();
    await save(1, { ...preferences, notes: "Second answer" });
    await expect(save(1)).rejects.toMatchObject({ code: "PT409" });
    expect((await db.query("select version from public.naming_preferences order by version")).rows).toEqual([
      { version: 1 },
      { version: 2 },
    ]);
    expect((await db.query("select current_revision from public.projects")).rows[0]).toEqual({ current_revision: 1 });
    await expect(auth(() => db.query("update public.naming_preferences set preferences='{}'"))).rejects.toMatchObject({
      code: "42501",
    });
    await expect(db.query("delete from public.naming_preferences")).rejects.toMatchObject({ code: "55000" });
  });
  it("selects atomically, treats likes separately and preserves earlier selections on edits", async () => {
    const { ids } = await generate();
    await rpc("set_name_retention", [project, ids[0], 0, true, false]);
    expect(((await rpc("get_project_naming", [project])) as { currentSelection: unknown }).currentSelection).toBeNull();
    await rpc("select_project_name", [project, ids[0], 1, false]);
    await rpc("select_project_name", [project, ids[1], 2, false]);
    expect((await db.query("select current_revision from public.projects")).rows).toEqual([{ current_revision: 3 }]);
    await expect(rpc("select_project_name", [project, ids[0], 2, false])).rejects.toMatchObject({ code: "PT409" });
    await expect(
      rpc("append_project_revision", [
        project,
        3,
        JSON.stringify({ ...context, selectedName: "Forgery", intake: { ...context.intake, suppliedName: "Elm" } }),
        HASH,
      ]),
    ).rejects.toMatchObject({ code: "22023" });
    await rpc("append_project_revision", [
      project,
      3,
      JSON.stringify({ ...context, selectedName: "Manual", intake: { ...context.intake, suppliedName: "Manual" } }),
      HASH,
    ]);
    expect((await db.query("select current_selection_id from public.naming_sessions")).rows).toEqual([
      { current_selection_id: null },
    ]);
    expect((await db.query("select * from public.name_selections")).rows).toHaveLength(2);
  });
  it("requires explicit earlier-context acknowledgment but name selections do not stale batches", async () => {
    const { ids } = await generate();
    await rpc("select_project_name", [project, ids[0], 1, false]);
    await rpc("select_project_name", [project, ids[1], 2, false]);
    await rpc("append_project_revision", [
      project,
      3,
      JSON.stringify({
        ...context,
        positioning: "Changed positioning",
        selectedName: "Elm",
        intake: { ...context.intake, suppliedName: "Elm" },
      }),
      HASH,
    ]);
    await expect(rpc("select_project_name", [project, ids[0], 4, false])).rejects.toMatchObject({ code: "PT409" });
    await rpc("select_project_name", [project, ids[0], 4, true]);
  });
  it("imports before preferences without claiming generated ownership and keeps foreign links out", async () => {
    const imported = await importName();
    const value = projectNameCandidateSchema.parse(normalize(imported.entry.candidate));
    expect(value.origin.kind).toBe("local_import");
    const overview = projectNamingOverviewSchema.parse(normalize(await rpc("get_project_naming", [project])));
    expect(overview.session!.currentPreferencesVersion).toBe(0);
    expect(overview.preferences).toBeNull();
    const other = await create(OWNER_B);
    await expect(rpc("select_project_name", [other, value.id, 1, true], OWNER_B)).rejects.toMatchObject({
      code: "P0002",
    });
    await expect(
      rpc("import_local_name", [
        project,
        1,
        JSON.stringify({ id: value.id, value: "Fake", createdAt: at, origin: "generated", history: [] }),
        JSON.stringify(context),
        "fake",
        "fixture-forged-import-001",
      ]),
    ).rejects.toMatchObject({ code: "22023" });
    await expect(
      db.query("insert into public.name_retention(candidate_id,owner_id,project_id) values($1,$2,$3)", [
        value.id,
        OWNER_B,
        other,
      ]),
    ).rejects.toMatchObject({ code: "23503" });
  });
  it("stores only user-supplied transform claims and derives immutable root/parent bindings", async () => {
    const { ids } = await generate();
    const input = { kind: "tweaks", seed: "Cedar", operations: ["uppercase"] };
    const valid = {
      candidates: [{ value: "CEDAR", identityKey: "cedar", explanation: "Applied Unicode uppercase mapping." }],
      truncated: false,
      notes: [],
    };
    const transformed = (await rpc("persist_name_transform", [
      project,
      ids[0],
      null,
      JSON.stringify(input),
      JSON.stringify(valid),
      "fixture-transform-000001",
    ])) as { entries: Array<{ candidate: unknown }> };
    const candidate = projectNameCandidateSchema.parse(normalize(transformed.entries[0]!.candidate));
    expect(candidate.origin).toMatchObject({
      kind: "transform",
      authorship: "user_supplied",
      parentCandidateId: ids[0],
      root: { kind: "generated", candidateId: ids[0] },
    });
    const forged = (await rpc("persist_name_transform", [
      project,
      ids[0],
      null,
      JSON.stringify(input),
      JSON.stringify({ ...valid, candidates: [{ ...valid.candidates[0], value: "Forged", identityKey: "forged" }] }),
      "fixture-transform-forged1",
    ])) as { entries: Array<{ candidate: unknown }> };
    expect(projectNameCandidateSchema.safeParse(normalize(forged.entries[0]!.candidate)).success).toBe(false);
    expect((forged.entries[0]!.candidate as { origin: { authorship: string } }).origin.authorship).toBe(
      "user_supplied",
    );
  });
  it("copies an owned account candidate into a complete brand with separate copied provenance", async () => {
    const imported = await importName();
    const candidateId = imported.entry.candidate.id;
    const promoted = (await rpc("create_brand_from_project_name", [
      project,
      candidateId,
      1,
      "Copied brand",
      false,
      "fixture-account-copy-001",
    ])) as { project: { id: string }; currentSelection: { candidate: unknown } };
    const copy = projectNameCandidateSchema.parse(normalize(promoted.currentSelection.candidate));
    expect(copy.projectId).toBe(promoted.project.id);
    expect(copy.origin).toMatchObject({
      kind: "account_copy",
      authorship: "user_supplied",
      sourceProjectId: project,
      sourceCandidateId: candidateId,
    });
    expect(
      (
        (await rpc("create_brand_from_project_name", [
          project,
          candidateId,
          1,
          "Copied brand",
          false,
          "fixture-account-copy-001",
        ])) as { project: { id: string } }
      ).project.id,
    ).toBe(promoted.project.id);
    await expect(
      rpc(
        "create_brand_from_project_name",
        [project, candidateId, 1, "No access", false, "fixture-foreign-copy-001"],
        OWNER_B,
      ),
    ).rejects.toMatchObject({ code: "P0002" });
  });
  it("requires explicit stale promotion acknowledgement and binds exact replay to it", async () => {
    const imported = await importName();
    const candidateId = imported.entry.candidate.id;
    await rpc("set_name_retention", [project, candidateId, 0, true, false]);
    const changed = { ...context, description: "Changed current source strategy" };
    await rpc("append_project_revision", [project, 1, JSON.stringify(changed), HASH]);
    expect(await rpc("get_account_names")).toMatchObject({ items: [{ earlierContext: true }] });
    await expect(
      rpc("create_brand_from_project_name", [
        project,
        candidateId,
        2,
        "Acknowledged brand",
        false,
        "fixture-stale-promotion01",
      ]),
    ).rejects.toMatchObject({ code: "PT409", message: "earlier_context_requires_acknowledgment" });
    expect((await db.query("select id from public.projects")).rows).toHaveLength(1);
    const promoted = (await rpc("create_brand_from_project_name", [
      project,
      candidateId,
      2,
      "Acknowledged brand",
      true,
      "fixture-stale-promotion01",
    ])) as {
      project: { id: string; context: typeof context };
      currentSelection: {
        selection: { acceptedEarlierContext: boolean };
        candidate: { strategyBasis: { description: string } };
      };
    };
    expect(promoted.project.context.description).toBe(changed.description);
    expect(promoted.currentSelection.candidate.strategyBasis.description).toBe(context.description);
    expect(promoted.currentSelection.selection.acceptedEarlierContext).toBe(true);
    expect(
      await rpc("create_brand_from_project_name", [
        project,
        candidateId,
        2,
        "Acknowledged brand",
        true,
        "fixture-stale-promotion01",
      ]),
    ).toEqual(promoted);
    await expect(
      rpc("create_brand_from_project_name", [
        project,
        candidateId,
        2,
        "Acknowledged brand",
        false,
        "fixture-stale-promotion01",
      ]),
    ).rejects.toMatchObject({ code: "PT409" });
    await expect(
      rpc("create_brand_from_project_name", [
        project,
        candidateId,
        1,
        "Outdated revision",
        true,
        "fixture-stale-source001",
      ]),
    ).rejects.toMatchObject({ code: "PT409" });
  });
});
