import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { accountProjectSchema } from "../../src/domain/project-api";
import { accountProjectDraft, draftContext } from "../../src/components/workspace/project-draft-adapter";
import {
  asRole,
  createTestDatabase,
  OWNER_A,
  OWNER_B,
  resetFixture,
  type TestDatabase,
} from "../database/local-supabase";

// Independent, synthetic local fixtures. No hosted identity, database, or provider calls.
describe("draft review invalidation", () => {
  it("requires a new brief confirmation after the known audience changes", () => {
    const project = accountProjectSchema.parse({
      id: "aaaaaaaa-1111-4111-8111-111111111111",
      owner_id: OWNER_A,
      title: "QA fixture",
      scope: "complete_brand",
      current_revision: 1,
      created_at: "2026-10-02T00:00:00Z",
      context: {
        description: "Synthetic audience correction fixture.",
        activity: "A learning program",
        offering: "Public workshops",
        knownAudience: "Local families",
        reformulationConfirmed: true,
        intake: { step: "audience" },
      },
    });
    const edited = { ...accountProjectDraft(project), knownAudience: "Professional educators" };
    expect(draftContext(edited, project.context).reformulationConfirmed).toBe(false);
    expect(project.context.knownAudience).toBe("Local families");
    expect(project.context.reformulationConfirmed).toBe(true);
  });
});

describe("independent draft database attacks (local PostgreSQL only)", () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await createTestDatabase();
  }, 30_000);
  beforeEach(async () => {
    await resetFixture(db);
  });
  afterAll(async () => {
    await db?.close();
  });

  async function create(context: Record<string, unknown>, hash: string) {
    return asRole(
      db,
      "authenticated",
      OWNER_A,
      async () =>
        (
          await db.query<{ id: string }>(
            "select id from public.create_project('naming_only','Independent QA fixture',$1::jsonb,$2)",
            [context, hash],
          )
        ).rows[0]!,
    );
  }

  it("copies the authoritative opaque JSON and hash without reinterpreting newer context fields", async () => {
    // Storage deliberately accepts versioned context as opaque JSON. A saved revision must
    // preserve it even if an older application client cannot render every field.
    const context = {
      description: "Local forward compatibility fixture",
      intake: { suppliedName: "École 🪁", namingNotes: "Preserve\nline breaks", example: true },
      futureResearch: {
        empty: [],
        falseValue: false,
        absent: null,
        nested: [{ source: "qa_local_fixture", text: "x".repeat(40_000) }],
      },
    };
    const hash = createHash("sha256").update(JSON.stringify(context)).digest("hex");
    const project = await create(context, hash);
    const original = (await db.query("select * from public.project_revisions where project_id=$1", [project.id])).rows;
    await asRole(db, "authenticated", OWNER_A, async () => {
      const result = await db.query<{ context: unknown; revision: number }>(
        "select * from public.append_project_revision($1,1,$2::jsonb,$3)",
        [project.id, context, hash],
      );
      expect(result.rows[0]).toMatchObject({ context, revision: 2 });
    });
    const history = (
      await db.query<{ revision: number; context: unknown; input_hash: string }>(
        "select revision,context,input_hash from public.project_revisions where project_id=$1 order by revision",
        [project.id],
      )
    ).rows;
    expect(history).toEqual([
      { revision: 1, context, input_hash: hash },
      { revision: 2, context, input_hash: hash },
    ]);
    expect(
      (await db.query("select * from public.project_revisions where project_id=$1 and revision=1", [project.id])).rows,
    ).toEqual(original);
  });

  it("makes missing and foreign projects indistinguishable even with stale or invalid update parameters", async () => {
    const context = { description: "Local ownership oracle fixture" };
    const hash = createHash("sha256").update(JSON.stringify(context)).digest("hex");
    const project = await create(context, hash);
    await asRole(db, "authenticated", OWNER_B, async () => {
      for (const id of [project.id, randomUUID()]) {
        for (const revision of [null, -1, 1, 99]) {
          await expect(
            db.query("select * from public.append_project_revision($1,$2,'{}','invalid','   ')", [id, revision]),
          ).rejects.toMatchObject({ code: "P0002" });
        }
      }
    });
    expect(
      (await db.query("select scope,title,current_revision from public.projects where id=$1", [project.id])).rows,
    ).toEqual([{ scope: "naming_only", title: "Independent QA fixture", current_revision: 1 }]);
    expect(
      (await db.query("select context,input_hash from public.project_revisions where project_id=$1", [project.id]))
        .rows,
    ).toEqual([{ context, input_hash: hash }]);
  });
});
