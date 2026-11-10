import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, resetFixture, asRole, OWNER_A, OWNER_B, HASH, type TestDatabase } from "./local-supabase";

// Execute actual SQL and restricted authenticated role, not a mocked PostgREST
// projection. Native PG17.11 qualification independently exercises this boundary.
describe("Strategy metadata reader without raw input privileges", () => {
  let db: TestDatabase, project: string, empty: string;
  const ids: string[] = [];
  const owner = <T>(run: () => Promise<T>, id: string | null = OWNER_A) => asRole(db, "authenticated", id, run);
  const read = (job: string | null = null, id: string | null = OWNER_A, p = project) =>
    owner(
      async () =>
        (
          await db.query<{ value: Record<string, unknown> }>(
            "select x as value from public.get_strategy_job_summaries($1,$2) x",
            [p, job],
          )
        ).rows.map((r) => r.value),
      id,
    );
  beforeAll(async () => {
    db = await createTestDatabase();
    await resetFixture(db);
    const create = () =>
      owner(
        async () =>
          (
            await db.query<{ id: string }>(
              "select id from public.create_project('complete_brand','Metadata fixture',$1,$2)",
              [JSON.stringify({ description: "Synthetic" }), HASH],
            )
          ).rows[0]!.id,
      );
    project = await create();
    empty = await create();
    for (const [index, input] of [
      {},
      { version: 1 },
      { version: 2 },
      { version: 3, spendControl: "uncapped", policyIdentity: "e".repeat(64) },
    ].entries()) {
      const result = await db.query<{ id: string }>(
        `insert into public.jobs(owner_id,project_id,operation,input_revision,input_hash,input,idempotency_key,reserved_cost_microusd,state)
        values($1,$2,'strategy.reformulate',1,$3,$4,$5,0,'needs_reconciliation') returning id`,
        [
          OWNER_A,
          project,
          HASH,
          {
            ...input,
            context: "PRIVATE_CONTEXT_CANARY",
            policy: { private: "PRIVATE_POLICY_CANARY" },
            assistantHistory: "PRIVATE_HISTORY_CANARY",
          },
          `metadata-fixture-${index}`,
        ],
      );
      ids.push(result.rows[0]!.id);
    }
  }, 30_000);
  afterAll(async () => {
    await db?.close();
  });

  it("preserves the original raw-input denial even for empty selects", async () => {
    expect(
      (
        await db.query<{ allowed: boolean }>(
          "select has_column_privilege('authenticated','public.jobs','input','SELECT') allowed",
        )
      ).rows[0]!.allowed,
    ).toBe(false);
    await expect(
      owner(() => db.query("select input->'version' from public.jobs where project_id=$1 limit 0", [empty])),
    ).rejects.toMatchObject({ code: "42501" });
    expect(await read(null, OWNER_A, empty)).toEqual([]);
  });
  it("returns only metadata for legacy, bounded and uncapped rows", async () => {
    const rows = await read();
    expect(rows).toHaveLength(4);
    expect(JSON.stringify(rows)).not.toContain("CANARY");
    for (const row of rows) {
      expect(row).not.toHaveProperty("input");
      expect(row).not.toHaveProperty("lease_token");
      expect(row).not.toHaveProperty("input_hash");
      expect(row.owner_id).toBe(OWNER_A);
    }
    expect((await read(ids[0]!))[0]!.input_version).toBeNull();
    expect((await read(ids[1]!))[0]!.input_version).toBe(1);
    expect((await read(ids[2]!))[0]!.input_version).toBe(2);
    expect((await read(ids[3]!))[0]).toMatchObject({
      input_version: 3,
      input_spend_control: "uncapped",
      input_policy_identity: "e".repeat(64),
    });
  });
  it("denies another owner and missing authentication", async () => {
    await expect(read(null, OWNER_B)).rejects.toMatchObject({ code: "P0002" });
    await expect(read(null, null)).rejects.toMatchObject({ code: "42501" });
  });
  it("grants only authenticated execution", async () => {
    for (const role of ["anon", "service_role"]) {
      expect(
        (
          await db.query<{ allowed: boolean }>(
            "select has_function_privilege($1,'public.get_strategy_job_summaries(uuid,uuid)','EXECUTE') allowed",
            [role],
          )
        ).rows[0]!.allowed,
      ).toBe(false);
    }
    await expect(
      asRole(db, "anon", OWNER_A, () =>
        db.query("select * from public.get_strategy_job_summaries($1,null)", [project]),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });
  it("reads without changing retained jobs or their uncertainty", async () => {
    const snapshot = () => db.query("select to_jsonb(j) value from public.jobs j order by id");
    const before = await snapshot();
    await read();
    await read(ids[3]!);
    expect(await snapshot()).toEqual(before);
  });
});
