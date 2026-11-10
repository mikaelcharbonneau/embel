import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { contextSnapshotSchema } from "../../src/domain/projects";
import {
  nameIdentityKey,
  namingStrategyBasisSchema,
  namingStrategyKeyFromBasis,
  projectNameCandidateSchema,
} from "../../src/domain/project-naming";
import {
  asRole,
  createTestDatabase,
  HASH,
  OWNER_A,
  OWNER_B,
  resetFixture,
  type TestDatabase,
} from "../database/local-supabase";
import { seedGeneratedNames } from "../database/retired-worker-fixture";

// Independent local PGlite fixtures. No live logins, grants, credentials or calls.
// The old Naming worker is retired; finished generated batches are written as it left them.
const context = contextSnapshotSchema.parse({ description: "Synthetic independent naming review" });
const preferences = { version: 1, creativeLocale: "en", notes: "", minimumGraphemes: null, maximumGraphemes: null };
const at = "2026-10-04T12:00:00Z";
type Entry = { candidate: { id: string; value: string; origin: Record<string, unknown>; strategyBasis: unknown } };
type CandidateRow = {
  id: string;
  value: string;
  identity_key: string;
  batch_id: string | null;
  origin: Record<string, unknown>;
};

function candidateDTO(raw: Entry["candidate"]) {
  return { ...raw, strategyKey: namingStrategyKeyFromBasis(namingStrategyBasisSchema.parse(raw.strategyBasis)) };
}

describe("independent Project Naming database adversarial boundaries", () => {
  let db: TestDatabase;
  let projectA: string;
  let projectB: string;
  let serial = 0;
  const key = () => `qa-naming-intent-${String(++serial).padStart(6, "0")}`;
  const auth = <T>(run: () => Promise<T>, owner: string | null = OWNER_A) => asRole(db, "authenticated", owner, run);
  async function rpc<T = unknown>(name: string, args: unknown[] = [], owner: string | null = OWNER_A): Promise<T> {
    return auth(
      async () =>
        (
          await db.query<{ result: T }>(
            `select public.${name}(${args.map((_, index) => `$${index + 1}`).join(",")}) result`,
            args,
          )
        ).rows[0]!.result,
      owner,
    );
  }
  async function create(scope = "naming_only", owner = OWNER_A, value = context) {
    return auth(
      async () =>
        (
          await db.query<{ id: string }>("select * from public.create_project($1,'Independent fixture',$2::jsonb,$3)", [
            scope,
            JSON.stringify(value),
            HASH,
          ])
        ).rows[0]!.id,
      owner,
    );
  }
  const save = (project = projectA, owner = OWNER_A) =>
    rpc("save_naming_preferences", [project, 0, JSON.stringify(preferences)], owner);
  const importName = (value = "Cedar", target = projectA, owner = OWNER_A) =>
    rpc<{ entry: Entry }>(
      "import_local_name",
      [
        target,
        1,
        JSON.stringify({
          id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          value,
          createdAt: at,
          origin: "manual",
          history: [],
        }),
        JSON.stringify(context),
        nameIdentityKey(value),
        key(),
      ],
      owner,
    );
  const candidateRows = () =>
    db.query<CandidateRow>("select id,value,identity_key,batch_id,origin from public.name_candidates order by value");
  beforeAll(async () => {
    db = await createTestDatabase();
  }, 30_000);
  afterAll(async () => {
    await db?.close();
  });
  beforeEach(async () => {
    serial = 0;
    await resetFixture(db);
    projectA = await create();
    projectB = await create("naming_only", OWNER_B);
    await save();
    await save(projectB, OWNER_B);
  });

  it("denies direct row mutation and isolates every owned naming table", async () => {
    const imported = await importName();
    await importName("Private B", projectB, OWNER_B);
    await rpc("set_name_retention", [projectA, imported.entry.candidate.id, 0, true, true]);
    await rpc("select_project_name", [projectA, imported.entry.candidate.id, 1, false]);
    for (const table of [
      "naming_sessions",
      "naming_preferences",
      "naming_batches",
      "naming_batch_results",
      "name_candidates",
      "name_transforms",
      "name_retention",
      "name_selections",
    ]) {
      const rows = await auth(() => db.query<{ owner_id: string }>(`select owner_id from public.${table}`));
      expect(rows.rows.every((row) => row.owner_id === OWNER_A)).toBe(true);
      await expect(auth(() => db.query(`delete from public.${table}`))).rejects.toMatchObject({ code: "42501" });
    }
    await expect(
      db.query("update public.name_candidates set value='Changed' where id=$1", [imported.entry.candidate.id]),
    ).rejects.toMatchObject({ code: "55000" });
    await expect(db.query("delete from public.name_selections")).rejects.toMatchObject({ code: "55000" });
    await expect(rpc("get_project_name", [projectB, imported.entry.candidate.id], OWNER_B)).rejects.toMatchObject({
      code: "P0002",
    });
  });

  it("filters populated batch, result, transform and selection histories for both real database principals", async () => {
    for (const [owner, project] of [
      [OWNER_A, projectA],
      [OWNER_B, projectB],
    ] as const) {
      await seedGeneratedNames(db, owner, project, ["Cedar", "Willow"], "qa-explicit-model");
      const parent = (
        await db.query<{ id: string }>("select id from public.name_candidates where owner_id=$1 and value='Cedar'", [
          owner,
        ])
      ).rows[0]!.id;
      await rpc(
        "persist_name_transform",
        [
          project,
          parent,
          null,
          JSON.stringify({ kind: "tweaks", seed: "Cedar", operations: ["uppercase"] }),
          JSON.stringify({
            candidates: [{ value: "CEDAR", identityKey: "cedar", explanation: "Applied Unicode uppercase mapping." }],
            truncated: false,
            notes: [],
          }),
          key(),
        ],
        owner,
      );
      await rpc("set_name_retention", [project, parent, 0, true, false], owner);
      await rpc("select_project_name", [project, parent, 1, false], owner);
    }
    for (const owner of [OWNER_A, OWNER_B])
      for (const table of [
        "naming_sessions",
        "naming_preferences",
        "naming_batches",
        "naming_batch_results",
        "name_candidates",
        "name_transforms",
        "name_retention",
        "name_selections",
      ]) {
        const rows = await auth(() => db.query<{ owner_id: string }>(`select owner_id from public.${table}`), owner);
        expect(rows.rows.length).toBeGreaterThan(0);
        expect(rows.rows.every((row) => row.owner_id === owner)).toBe(true);
      }
  });

  it("never elevates forged transform content or account copies to generated authorship", async () => {
    await seedGeneratedNames(db, OWNER_A, projectA, ["Cedar", "Willow"], "qa-explicit-model");
    const parent = (await candidateRows()).rows[0]!.id as string;
    const transform = await rpc<{ entries: Entry[] }>("persist_name_transform", [
      projectA,
      parent,
      null,
      JSON.stringify({ kind: "tweaks", seed: "Cedar", operations: ["uppercase"] }),
      JSON.stringify({
        candidates: [{ value: "Fabricated", identityKey: "fabricated", explanation: "False uppercase claim" }],
        truncated: false,
        notes: [],
      }),
      key(),
    ]);
    const forged = transform.entries[0]!.candidate;
    expect(forged.origin).toMatchObject({
      kind: "transform",
      authorship: "user_supplied",
      root: { kind: "generated", candidateId: parent },
    });
    expect(projectNameCandidateSchema.safeParse(candidateDTO(forged)).success).toBe(false);
    const selected = await rpc<{ currentSelection: { candidate: Entry["candidate"] } }>("select_project_name", [
      projectA,
      forged.id,
      1,
      false,
    ]);
    expect(selected.currentSelection.candidate.origin.authorship).toBe("user_supplied");
    const copy = await rpc<{ currentSelection: { candidate: Entry["candidate"] } }>("create_brand_from_project_name", [
      projectA,
      forged.id,
      2,
      "Unverified fixture copy",
      false,
      key(),
    ]);
    expect(copy.currentSelection.candidate.origin).toMatchObject({
      kind: "account_copy",
      authorship: "user_supplied",
      sourceProjectId: projectA,
      sourceCandidateId: forged.id,
    });
    expect(projectNameCandidateSchema.safeParse(candidateDTO(copy.currentSelection.candidate)).success).toBe(false);
  });

  it("rejects forged generated imports and cross-project parents even for one owner", async () => {
    const imported = await importName();
    const second = await create();
    await expect(
      rpc("import_local_name", [
        projectA,
        1,
        JSON.stringify({
          id: imported.entry.candidate.id,
          value: "Fake",
          createdAt: at,
          origin: "generated",
          history: [],
          provider: "openai",
        }),
        JSON.stringify(context),
        "fake",
        key(),
      ]),
    ).rejects.toThrow();
    await expect(
      rpc("persist_name_transform", [
        second,
        imported.entry.candidate.id,
        null,
        JSON.stringify({ kind: "tweaks", seed: "Cedar", operations: ["uppercase"] }),
        JSON.stringify({ candidates: [], truncated: false, notes: [] }),
        key(),
      ]),
    ).rejects.toMatchObject({ code: "P0002" });
    await expect(
      rpc(
        "create_brand_from_project_name",
        [projectA, imported.entry.candidate.id, 1, "Cross-owner copy", false, key()],
        OWNER_B,
      ),
    ).rejects.toMatchObject({ code: "P0002" });
  });

  it("includes a selection-only name in retained views without inventing a favorite", async () => {
    const imported = await importName();
    await rpc("select_project_name", [projectA, imported.entry.candidate.id, 1, false]);
    const overview = await rpc<{ candidates: { items: Entry[] } }>("get_project_naming", [
      projectA,
      JSON.stringify({ filter: "retained" }),
    ]);
    expect(overview.candidates.items.map((row) => row.candidate.id)).toEqual([imported.entry.candidate.id]);
    const account = await rpc<{ items: Entry[] }>("get_account_names", [JSON.stringify({ filter: "retained" })]);
    expect(account.items.map((row) => row.candidate.id)).toEqual([imported.entry.candidate.id]);
    expect((await db.query("select * from public.name_retention")).rows).toEqual([]);
  });
});
