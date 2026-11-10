import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { asRole, createTestDatabase, OWNER_A, OWNER_B, resetFixture, type TestDatabase } from "./local-supabase";
import { logoWorkspaceV2Schema } from "../../src/domain/logo-workspace";
import { ownerQuery, startLogoFixture } from "./logo-project-fixture";

describe("logo brief freshness compares exact owned saved context", () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await createTestDatabase();
  }, 60000);
  afterAll(async () => {
    await db?.close();
  });
  beforeEach(async () => {
    await resetFixture(db);
  });
  async function start(owner = OWNER_A) {
    return logoWorkspaceV2Schema.parse(
      await startLogoFixture(ownerQuery(db, owner), {
        requestKey: randomUUID(),
        brief: {
          name: "Same context",
          activity: "Studio",
          audience: "Founders",
          personality: "Calm",
          logoTypes: ["wordmark"],
        },
      }),
    );
  }
  async function read(project: string, owner = OWNER_A) {
    return logoWorkspaceV2Schema.parse(
      await asRole(
        db,
        "authenticated",
        owner,
        async () =>
          (await db.query<{ value: unknown }>("select public.get_logo_workspace($1) value", [project])).rows[0]!.value,
      ),
    );
  }
  it.each(["source", "current", "both"] as const)(
    "fails closed when the %s saved revision is missing, including an unchanged revision counter",
    async (missing) => {
      const workspace = await start(),
        project = workspace.projectId;
      // A second owned project's matching revision cannot stand in for a missing source.
      await start(OWNER_B);
      // A second saved version with the same content (for example a retitle) moves the revision counter only.
      if (missing !== "both") {
        const saved = (
          await db.query<{ context: unknown; input_hash: string }>(
            "select context,input_hash from public.project_revisions where project_id=$1 and revision=1",
            [project],
          )
        ).rows[0]!;
        await asRole(db, "authenticated", OWNER_A, () =>
          db.query("select public.append_project_revision($1,1,$2::jsonb,$3)", [
            project,
            JSON.stringify(saved.context),
            saved.input_hash,
          ]),
        );
      }
      await db.exec("begin");
      try {
        // Deliberate LOCAL corruption fixture only; rollback restores the immutable rows and trigger.
        await db.exec(
          "alter table public.project_revisions disable trigger revisions_immutable, disable trigger revisions_immutable_on_delete",
        );
        await db.query("delete from public.project_revisions where owner_id=$1 and project_id=$2 and revision=$3", [
          OWNER_A,
          project,
          missing === "current" ? 2 : 1,
        ]);
        expect((await read(project)).staleStages).toContainEqual({
          stage: "brief_references",
          reasons: ["project_revision_changed"],
        });
      } finally {
        await db.exec("rollback");
      }
      expect((await read(project)).staleStages).toEqual([]);
    },
  );
});
