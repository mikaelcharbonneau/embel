import { randomUUID } from "node:crypto";
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

// Adding files to a brand that already exists (migration 20261124100000_attach_files_to_brand):
// the side chat's attach button. Files are staged and verified by the existing upload path; here they
// are inserted as that path leaves them.
let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
}, 180_000);
beforeEach(async () => resetFixture(db));
afterAll(async () => db?.close());

async function staged(owner = OWNER_A, options: { verified?: boolean; bytes?: number } = {}) {
  const id = randomUUID();
  await db.query(
    `insert into public.home_attachments (id, owner_id, request_key, input, name, mime_type, content_hash, byte_length, verified)
     values ($1, $2, $3, '{}'::jsonb, 'notes.txt', 'text/plain', $4, $5, $6)`,
    [id, owner, randomUUID(), "a".repeat(64), options.bytes ?? 5, options.verified ?? true],
  );
  return id;
}
const attach = (owner: string, projectId: string, attachmentIds: string[]) =>
  asRole(
    db,
    "authenticated",
    owner,
    async () =>
      (
        await db.query<{
          result: { projectId: string; attachments: { id: string; state: string; projectRevision: number }[] };
        }>("select public.attach_home_files_to_project($1::jsonb) as result", [{ projectId, attachmentIds }])
      ).rows[0]!.result,
  );
async function failure(run: () => Promise<unknown>) {
  try {
    await run();
  } catch (error) {
    return (error as { message: string }).message;
  }
  throw new Error("Expected a failure");
}
const linked = async (projectId: string) =>
  (
    await db.query<{ count: number }>(
      "select count(*)::int as count from public.home_attachments where project_id = $1",
      [projectId],
    )
  ).rows[0]!.count;

describe("attach_home_files_to_project", () => {
  it("links the owner's verified files to their brand at its current revision, and a repeat changes nothing", async () => {
    const project = await seedProject(db);
    const ids = [await staged(), await staged()];
    const result = await attach(OWNER_A, project.id, ids);
    expect(result.projectId).toBe(project.id);
    expect(result.attachments.map((file) => file.id).sort()).toEqual([...ids].sort());
    expect(result.attachments.every((file) => file.state === "linked")).toBe(true);
    expect(result.attachments.every((file) => file.projectRevision === project.current_revision)).toBe(true);
    expect(await linked(project.id)).toBe(2);
    const again = await attach(OWNER_A, project.id, ids);
    expect(again.attachments).toHaveLength(2);
    expect(await linked(project.id)).toBe(2);
  });
  it("holds a brand to five files in all, counting the ones it already has, and links none of a batch that does not fit", async () => {
    const project = await seedProject(db);
    await attach(OWNER_A, project.id, [await staged(), await staged(), await staged(), await staged()]);
    expect(await failure(async () => attach(OWNER_A, project.id, [await staged(), await staged()]))).toContain(
      "home_aggregate_limit",
    );
    expect(await linked(project.id)).toBe(4);
    await attach(OWNER_A, project.id, [await staged()]);
    expect(await linked(project.id)).toBe(5);
    expect(await failure(async () => attach(OWNER_A, project.id, [await staged()]))).toContain("home_aggregate_limit");
  });
  it("holds a brand to 25 MiB of files in all", async () => {
    const project = await seedProject(db);
    await attach(OWNER_A, project.id, [
      await staged(OWNER_A, { bytes: 10_485_760 }),
      await staged(OWNER_A, { bytes: 10_485_760 }),
    ]);
    expect(
      await failure(async () => attach(OWNER_A, project.id, [await staged(OWNER_A, { bytes: 10_485_760 })])),
    ).toContain("home_aggregate_limit");
    expect(await linked(project.id)).toBe(2);
  });
  it("refuses another account's brand, another account's files, unverified files and files of another brand", async () => {
    const mine = await seedProject(db),
      other = await seedProject(db),
      theirs = await seedProject(db, OWNER_B);
    expect(await failure(async () => attach(OWNER_A, theirs.id, [await staged()]))).toContain("not_found");
    expect(await failure(async () => attach(OWNER_A, mine.id, [await staged(OWNER_B)]))).toContain(
      "home_attachment_not_found",
    );
    expect(await failure(async () => attach(OWNER_A, mine.id, [await staged(OWNER_A, { verified: false })]))).toContain(
      "home_attachment_conflict",
    );
    const used = await staged();
    await attach(OWNER_A, other.id, [used]);
    expect(await failure(() => attach(OWNER_A, mine.id, [used]))).toContain("home_attachment_conflict");
    expect(await linked(mine.id)).toBe(0);
  });
  it("refuses malformed requests and callers who are not signed in", async () => {
    const project = await seedProject(db);
    const id = await staged();
    for (const input of [
      { projectId: project.id, attachmentIds: [] },
      { projectId: project.id, attachmentIds: [id, id] },
      { projectId: "x", attachmentIds: [id] },
      { projectId: project.id, attachmentIds: [id], extra: 1 },
    ])
      expect(
        await failure(() =>
          asRole(db, "authenticated", OWNER_A, () =>
            db.query("select public.attach_home_files_to_project($1::jsonb)", [input]),
          ),
        ),
      ).toMatch(/invalid_home_ids|duplicate_home_ids/u);
    expect(
      await failure(() =>
        asRole(db, "anon", OWNER_A, () =>
          db.query("select public.attach_home_files_to_project($1::jsonb)", [
            { projectId: project.id, attachmentIds: [id] },
          ]),
        ),
      ),
    ).toMatch(/permission denied|unauthenticated/u);
  });
  it("adds the free file-reading kind, enabled, with a daily limit", async () => {
    const kind = (
      await db.query<{ credits: number; enabled: boolean; max_per_day: number }>(
        "select credits, enabled, max_per_day from fluid_private.generation_kinds where kind = 'brief.read_files'",
      )
    ).rows[0];
    expect(kind).toEqual({ credits: 0, enabled: true, max_per_day: 20 });
  });
});
