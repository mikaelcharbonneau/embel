import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { initialNamingPreferencesV2 } from "../../src/domain/naming-brain-preferences";
import {
  initialNamingChatProgress,
  namingChatCheckpoint,
  namingChatQuestions,
  confirmNamingChatQuestion,
} from "../../src/components/naming/naming-chat-progress";
import { namingViewStateSchema, type NamingSession } from "../../src/domain/project-naming";
import { contextSnapshotSchema } from "../../src/domain/projects";
import { asRole, createTestDatabase, HASH, OWNER_A, OWNER_B, resetFixture, type TestDatabase } from "./local-supabase";

const context = contextSnapshotSchema.parse({ description: "Synthetic Naming progress fixture" });
const preferences = {
  ...initialNamingPreferencesV2(context),
  approaches: ["invented" as const],
  directness: "suggestive" as const,
};
const complete = namingChatQuestions().reduce(
  (progress, question) => confirmNamingChatQuestion(progress, question, preferences),
  initialNamingChatProgress(preferences),
);
const checkpoint = namingChatCheckpoint(complete, preferences, 1);
const view = namingViewStateSchema.parse({
  pane: "results",
  conversationOpen: true,
  filter: "all",
  query: "",
  visibleBatchId: null,
  scrollCandidateId: null,
  workshopCandidateId: null,
});

describe("durable Naming question acknowledgements (disposable database)", () => {
  let db: TestDatabase, projectId: string;
  beforeAll(async () => {
    db = await createTestDatabase();
  }, 30_000);
  afterAll(async () => {
    await db?.close();
  });
  const rpc = <T = unknown>(name: string, args: unknown[], owner = OWNER_A) =>
    asRole(
      db,
      "authenticated",
      owner,
      async () =>
        (
          await db.query<{ result: T }>(
            `select to_jsonb(public.${name}(${args.map((_, i) => `$${i + 1}`).join(",")})) result`,
            args.map((value) => (value && typeof value === "object" ? JSON.stringify(value) : value)),
          )
        ).rows[0]!.result,
    );
  beforeEach(async () => {
    await resetFixture(db);
    projectId = (await rpc<{ id: string }>("create_project", ["naming_only", "Synthetic progress", context, HASH])).id;
    await rpc("save_naming_preferences", [projectId, 0, preferences]);
  });
  const save = (revision = 1, patch: Record<string, unknown> = { namingChat: checkpoint }, owner = OWNER_A) =>
    rpc<{ session: NamingSession }>("save_naming_view", [projectId, revision, { ...view, ...patch }], owner);

  it("persists accepted defaults separately from preferences without a run or project revision", async () => {
    const before = await db.query("select preferences from public.naming_preferences where project_id=$1", [projectId]);
    const result = await save();
    expect(result.session.viewRevision).toBe(2);
    expect(result.session.viewState.namingChat).toEqual(checkpoint);
    expect(initialNamingChatProgress(preferences, result.session.viewState.namingChat, 1).activeStep).toBe("review");
    const read = await rpc<{ session: NamingSession }>("get_project_naming", [projectId]);
    expect(read.session.viewState.namingChat).toEqual(checkpoint);
    expect(
      (await db.query("select preferences from public.naming_preferences where project_id=$1", [projectId])).rows,
    ).toEqual(before.rows);
    expect((await db.query("select current_revision from public.projects where id=$1", [projectId])).rows).toEqual([
      { current_revision: 1 },
    ]);
    expect((await db.query("select count(*)::integer total from public.jobs")).rows).toEqual([{ total: 0 }]);
  });
  it("retains owner isolation, unchanged function grants and view revision conflicts", async () => {
    await save();
    await expect(save(1)).rejects.toMatchObject({ code: "PT409" });
    await expect(save(2, { namingChat: checkpoint }, OWNER_B)).rejects.toMatchObject({ code: "P0002" });
    expect(
      (
        await db.query(
          "select has_function_privilege('authenticated','public.save_naming_view(uuid,integer,jsonb)','execute') authenticated,has_function_privilege('anon','public.save_naming_view(uuid,integer,jsonb)','execute') anon",
        )
      ).rows,
    ).toEqual([{ authenticated: true, anon: false }]);
  });
  it("accepts older view bodies without erasing saved acknowledgements", async () => {
    await save();
    const result = await save(2, { query: "Synthetic filter" });
    expect(result.session.viewState.namingChat).toEqual(checkpoint);
    expect(result.session.viewState.query).toBe("Synthetic filter");
  });
  it("rejects newly written stale/future confirmations and allows unchanged metadata on navigation", async () => {
    await save();
    await rpc("save_naming_preferences", [projectId, 1, { ...preferences, notes: "Unrelated saved guidance" }]);
    const ordinary = await save(2, { namingChat: checkpoint, conversationOpen: false });
    expect(ordinary.session.currentPreferencesVersion).toBe(2);
    for (const version of [1, 3])
      await expect(
        save(3, { namingChat: { ...checkpoint, preferencesVersion: version, confirmed: {} } }),
      ).rejects.toMatchObject({ code: "PT409" });
    const next = await save(3, { namingChat: { ...checkpoint, preferencesVersion: 2 } });
    expect(next.session.viewState.namingChat?.preferencesVersion).toBe(2);
  });
  it.each([
    { version: 2, preferencesVersion: 1, confirmed: {} },
    { version: 1, preferencesVersion: 0, confirmed: {} },
    { version: 1, preferencesVersion: 2147483648, confirmed: {} },
    { version: 1, preferencesVersion: 1, confirmed: { invented: "forged" } },
    { version: 1, preferencesVersion: 1, confirmed: { language: true } },
    { version: 1, preferencesVersion: 1, confirmed: { fragments: "x".repeat(13201) } },
    null,
  ])("rejects malformed progress metadata without a view mutation", async (namingChat) => {
    await expect(save(1, { namingChat })).rejects.toMatchObject({ code: "22023" });
    expect(
      (await db.query("select view_revision from public.naming_sessions where project_id=$1", [projectId])).rows,
    ).toEqual([{ view_revision: 1 }]);
  });
});
