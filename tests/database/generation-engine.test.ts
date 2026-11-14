import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  asRole,
  createTestDatabase,
  OWNER_A,
  OWNER_B,
  resetFixture,
  seedProject,
  type TestDatabase,
} from "./local-supabase";

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
}, 180_000);
beforeEach(async () => {
  await resetFixture(db);
  await db.exec("update fluid_private.engine_settings set paused = false, global_daily_cost_cap_microusd = 50000000");
  await db.exec("delete from fluid_private.generation_kinds where kind like 'test.%'");
  await db.exec(
    "insert into fluid_private.generation_kinds (kind, credits, enabled, max_per_day) values ('test.paid', 10, true, 50), ('test.expensive', 31, true, 50), ('test.once', 1, true, 1), ('test.off', 1, false, 50)",
  );
});

type Run = { id: string; status: string; credits: number; workflow_run_id: string | null; error_code: string | null };
const key = (n: number) => `generation-key-${String(n).padStart(4, "0")}`;

async function start(owner: string, project: string, kind = "engine.probe", k = key(1), input: object = {}) {
  return asRole(
    db,
    "authenticated",
    owner,
    async () =>
      (await db.query<Run>("select * from public.start_generation($1, $2, $3, $4::jsonb)", [project, kind, k, input]))
        .rows[0]!,
  );
}
async function failure(run: () => Promise<unknown>) {
  try {
    await run();
  } catch (error) {
    return error as { message: string; code?: string };
  }
  throw new Error("Expected a failure");
}
async function balance(owner: string) {
  return asRole(
    db,
    "authenticated",
    owner,
    async () =>
      (
        await db.query<{ summary: { balance: number; planId: string } }>(
          "select public.get_credit_summary() as summary",
        )
      ).rows[0]!.summary,
  );
}
/** Logs in as the engine role the way production does; no passwords in the fixture. */
async function asEngine<T>(run: () => Promise<T>): Promise<T> {
  await db.exec("grant connect on database postgres to embel_engine; set session authorization embel_engine");
  try {
    return await run();
  } finally {
    await db.exec("set session authorization postgres");
  }
}
const engine = {
  claim: (runId: string, workflowRunId = "wrun_fixture_1") =>
    asEngine(
      async () =>
        (
          await db.query<{ r: Record<string, unknown> }>("select fluid_private.engine_claim($1, $2) as r", [
            runId,
            workflowRunId,
          ])
        ).rows[0]!.r,
    ),
  save: (runId: string, outputKey = "echo", cost = 0) =>
    asEngine(
      async () =>
        (
          await db.query<{ saved: boolean }>(
            "select fluid_private.engine_save_output($1, $2, '{\"ok\":true}'::jsonb, null, $3) as saved",
            [runId, outputKey, cost],
          )
        ).rows[0]!.saved,
    ),
  finish: (runId: string, status: string, error: string | null = null) =>
    asEngine(
      async () =>
        (
          await db.query<{ r: { status: string } }>("select fluid_private.engine_finish($1, $2, $3) as r", [
            runId,
            status,
            error,
          ])
        ).rows[0]!.r,
    ),
};

describe("deleting a project with AI work in progress", () => {
  const requestDeletion = (owner: string, project: { id: string; current_revision: number }, lifecycle = 0) =>
    asRole(
      db,
      "authenticated",
      owner,
      async () =>
        (
          await db.query<{ summary: { deletion_state: string } }>(
            "select public.request_project_deletion($1, $2, $3) as summary",
            [project.id, project.current_revision, lifecycle],
          )
        ).rows[0]!.summary,
    );
  const run = async (id: string) =>
    (
      await db.query<Run & { cancel_requested_at: Date | null }>("select * from public.generation_runs where id = $1", [
        id,
      ])
    ).rows[0]!;

  it("ends a run no workflow has picked up and returns its credits", async () => {
    const project = await seedProject(db);
    const queued = await start(OWNER_A, project.id, "test.paid");
    expect(await balance(OWNER_A)).toMatchObject({ balance: 20 });
    expect((await requestDeletion(OWNER_A, project)).deletion_state).toBe("deleted");
    expect(await run(queued.id)).toMatchObject({ status: "cancelled", error_code: "cancelled" });
    expect(await balance(OWNER_A)).toMatchObject({ balance: 30 });
  });

  it("asks a working run to stop, so the workflow ends it and the credits come back", async () => {
    const project = await seedProject(db);
    const working = await start(OWNER_A, project.id, "test.paid");
    await engine.claim(working.id);
    await requestDeletion(OWNER_A, project);
    expect(await run(working.id)).toMatchObject({ status: "running", cancel_requested_at: expect.any(Date) });
    // What every workflow reads between paid steps.
    const check = await asEngine(
      async () =>
        (
          await db.query<{ c: { cancelRequested: boolean } }>("select fluid_private.engine_check($1) as c", [
            working.id,
          ])
        ).rows[0]!.c,
    );
    expect(check.cancelRequested).toBe(true);
    expect((await engine.finish(working.id, "cancelled", "cancelled")).status).toBe("cancelled");
    expect(await balance(OWNER_A)).toMatchObject({ balance: 30 });
  });

  it("leaves finished runs and other projects' runs alone", async () => {
    const deleted = await seedProject(db);
    const kept = await seedProject(db);
    const finished = await start(OWNER_A, deleted.id, "test.paid", key(1));
    await engine.claim(finished.id);
    await engine.finish(finished.id, "succeeded");
    const elsewhere = await start(OWNER_A, kept.id, "test.paid", key(2));
    await engine.claim(elsewhere.id, "wrun_fixture_2");
    await requestDeletion(OWNER_A, deleted);
    expect(await run(finished.id)).toMatchObject({ status: "succeeded", cancel_requested_at: null });
    expect(await run(elsewhere.id)).toMatchObject({ status: "running", cancel_requested_at: null });
  });

  it("does not restart stopped work when the project is restored", async () => {
    const project = await seedProject(db);
    const queued = await start(OWNER_A, project.id, "test.paid");
    await requestDeletion(OWNER_A, project);
    await asRole(db, "authenticated", OWNER_A, () =>
      db.query("select public.restore_project_deletion($1, $2, 1)", [project.id, project.current_revision]),
    );
    expect((await run(queued.id)).status).toBe("cancelled");
    // The restored project can start fresh work.
    expect((await start(OWNER_A, project.id, "test.paid", key(2))).status).toBe("queued");
  });
});

describe("starting a generation", () => {
  it("creates one run per idempotency key and refuses a conflicting replay", async () => {
    const project = await seedProject(db);
    const first = await start(OWNER_A, project.id);
    expect(first).toMatchObject({ status: "queued", credits: 0, workflow_run_id: null });
    expect((await start(OWNER_A, project.id)).id).toBe(first.id);
    expect((await failure(() => start(OWNER_A, project.id, "test.paid"))).message).toContain("idempotency_conflict");
  });
  it("refuses another owner's project, disabled kinds and bad keys", async () => {
    const project = await seedProject(db);
    expect((await failure(() => start(OWNER_B, project.id))).message).toContain("not_found");
    expect((await failure(() => start(OWNER_A, project.id, "test.off"))).message).toContain("generation_unavailable");
    expect((await failure(() => start(OWNER_A, project.id, "engine.probe", "short"))).message).toContain(
      "invalid_input",
    );
  });
  it("grants the monthly allowance, charges credits and refuses an empty balance", async () => {
    const project = await seedProject(db);
    await start(OWNER_A, project.id, "test.paid");
    expect(await balance(OWNER_A)).toMatchObject({ planId: "free", balance: 20 });
    const refused = await failure(() => start(OWNER_A, project.id, "test.expensive", key(2)));
    expect(refused.message).toContain("insufficient_credits");
    expect(refused.code).toBe("PT402");
  });
  it("allows one active run per project and kind, and enforces the daily limit", async () => {
    const project = await seedProject(db);
    const first = await start(OWNER_A, project.id, "test.once");
    expect((await failure(() => start(OWNER_A, project.id, "test.once", key(2)))).message).toContain(
      "generation_active",
    );
    await engine.claim(first.id);
    await engine.finish(first.id, "succeeded");
    expect((await failure(() => start(OWNER_A, project.id, "test.once", key(3)))).message).toContain("daily_limit");
  });
  it("stops new work while paused or over the global daily cost cap", async () => {
    const project = await seedProject(db);
    await db.exec("update fluid_private.engine_settings set paused = true");
    expect((await failure(() => start(OWNER_A, project.id))).message).toContain("generation_paused");
    await db.exec("update fluid_private.engine_settings set paused = false, global_daily_cost_cap_microusd = 1");
    const run = await start(OWNER_A, project.id, "test.paid");
    await engine.claim(run.id);
    await engine.save(run.id, "echo", 5);
    await engine.finish(run.id, "succeeded");
    expect((await failure(() => start(OWNER_A, project.id, "test.paid", key(2)))).message).toContain(
      "generation_paused",
    );
  });
  it("refunds a run whose workflow never started once it is ten minutes old", async () => {
    const project = await seedProject(db);
    const stuck = await start(OWNER_A, project.id, "test.paid");
    await db.query("update public.generation_runs set created_at = now() - interval '11 minutes' where id = $1", [
      stuck.id,
    ]);
    await start(OWNER_A, project.id, "test.paid", key(2));
    const row = (await db.query<Run>("select * from public.generation_runs where id = $1", [stuck.id])).rows[0]!;
    expect(row).toMatchObject({ status: "failed", error_code: "start_failed" });
    expect((await balance(OWNER_A)).balance).toBe(20);
  });
  it("ends a running run past its kind's time limit, refunds it and lets the step start again", async () => {
    const project = await seedProject(db);
    await db.exec("update fluid_private.generation_kinds set max_running_minutes = 30 where kind = 'test.paid'");
    const live = await start(OWNER_A, project.id, "test.paid");
    await engine.claim(live.id);
    await db.query("update public.generation_runs set started_at = now() - interval '29 minutes' where id = $1", [
      live.id,
    ]);
    expect((await failure(() => start(OWNER_A, project.id, "test.paid", key(2)))).message).toContain(
      "generation_active",
    );
    await db.query("update public.generation_runs set started_at = now() - interval '31 minutes' where id = $1", [
      live.id,
    ]);
    expect(await start(OWNER_A, project.id, "test.paid", key(3))).toMatchObject({ status: "queued" });
    const row = (await db.query<Run>("select * from public.generation_runs where id = $1", [live.id])).rows[0]!;
    expect(row).toMatchObject({ status: "failed", error_code: "run_timed_out" });
    expect((await balance(OWNER_A)).balance).toBe(20);
    expect((await failure(() => engine.save(live.id, "late"))).message).toContain("run_not_running");
  });
});

describe("running a generation", () => {
  it("claims once per workflow, saves outputs once and refunds a failure exactly once", async () => {
    const project = await seedProject(db);
    const run = await start(OWNER_A, project.id, "test.paid");
    expect(await engine.claim(run.id)).toMatchObject({ status: "running", kind: "test.paid", cancelRequested: false });
    expect(await engine.claim(run.id)).toMatchObject({ status: "running" });
    expect((await failure(() => engine.claim(run.id, "wrun_other"))).message).toContain("claim_conflict");
    expect(await engine.save(run.id)).toBe(true);
    expect(await engine.save(run.id)).toBe(false);
    expect(await engine.finish(run.id, "failed", "provider_failed")).toMatchObject({ status: "failed" });
    expect(await engine.finish(run.id, "failed", "provider_failed")).toMatchObject({ status: "failed" });
    expect((await balance(OWNER_A)).balance).toBe(30);
    expect((await failure(() => engine.save(run.id, "late"))).message).toContain("run_not_running");
  });
  it("cancels an unstarted run immediately and refunds it", async () => {
    const project = await seedProject(db);
    const run = await start(OWNER_A, project.id, "test.paid");
    const cancelled = await asRole(
      db,
      "authenticated",
      OWNER_A,
      async () => (await db.query<Run>("select * from public.cancel_generation($1)", [run.id])).rows[0]!,
    );
    expect(cancelled.status).toBe("cancelled");
    expect((await balance(OWNER_A)).balance).toBe(30);
    expect(
      (
        await failure(() =>
          asRole(db, "authenticated", OWNER_B, () => db.query("select public.cancel_generation($1)", [run.id])),
        )
      ).message,
    ).toContain("not_found");
  });
  it("flags a live running run on cancel but ends an overdue one at once", async () => {
    const project = await seedProject(db);
    const run = await start(OWNER_A, project.id, "test.paid");
    await engine.claim(run.id);
    const cancel = () =>
      asRole(
        db,
        "authenticated",
        OWNER_A,
        async () =>
          (
            await db.query<Run & { cancel_requested_at: string | null }>("select * from public.cancel_generation($1)", [
              run.id,
            ])
          ).rows[0]!,
      );
    expect(await cancel()).toMatchObject({ status: "running" });
    expect((await balance(OWNER_A)).balance).toBe(20);
    await db.query("update public.generation_runs set started_at = now() - interval '2 hours' where id = $1", [run.id]);
    expect(await cancel()).toMatchObject({ status: "failed", error_code: "run_timed_out" });
    expect((await balance(OWNER_A)).balance).toBe(30);
  });
  it("cancels a queued run at claim time when the engine is paused", async () => {
    const project = await seedProject(db);
    const run = await start(OWNER_A, project.id, "test.paid");
    await db.exec("update fluid_private.engine_settings set paused = true");
    expect(await engine.claim(run.id)).toMatchObject({ status: "cancelled" });
  });
});

describe("access", () => {
  it("lets owners read only their own runs and never write them directly", async () => {
    const project = await seedProject(db);
    await start(OWNER_A, project.id);
    expect(
      (await asRole(db, "authenticated", OWNER_B, () => db.query("select id from public.generation_runs"))).rows,
    ).toHaveLength(0);
    expect(
      (await asRole(db, "authenticated", OWNER_A, () => db.query("select id from public.generation_runs"))).rows,
    ).toHaveLength(1);
    expect(
      (
        await failure(() =>
          asRole(db, "authenticated", OWNER_A, () =>
            db.query("update public.generation_runs set status = 'succeeded'"),
          ),
        )
      ).message,
    ).toContain("permission denied");
    expect(
      (
        await failure(() =>
          asRole(db, "authenticated", OWNER_A, () =>
            db.query("insert into public.credit_entries (owner_id, delta, kind) values ($1, 999, 'grant')", [OWNER_A]),
          ),
        )
      ).message,
    ).toContain("permission denied");
    expect(
      (
        await failure(() =>
          asRole(db, "authenticated", OWNER_A, () =>
            db.query("select fluid_private.engine_finish(gen_random_uuid(), 'succeeded', null)"),
          ),
        )
      ).message,
    ).toContain("permission denied");
  });
  it("shows plans and per-kind credits through the catalog only", async () => {
    const catalog = await asRole(
      db,
      "authenticated",
      OWNER_A,
      async () =>
        (
          await db.query<{ c: { plans: { id: string; monthlyCredits: number }[]; kinds: { kind: string }[] } }>(
            "select public.get_generation_catalog() as c",
          )
        ).rows[0]!.c,
    );
    expect(catalog.plans.map((plan) => [plan.id, plan.monthlyCredits])).toEqual([
      ["free", 30],
      ["pro", 150],
      ["studio", 500],
    ]);
    expect(catalog.kinds.map((kind) => kind.kind)).toContain("engine.probe");
    expect(
      (await failure(() => asRole(db, "authenticated", OWNER_A, () => db.query("select * from fluid_private.plans"))))
        .message,
    ).toContain("permission denied");
  });
  it("gives the engine login its functions and nothing else", async () => {
    expect((await failure(() => asEngine(() => db.query("select id from public.generation_runs")))).message).toContain(
      "permission denied",
    );
    expect(
      (
        await failure(() =>
          asEngine(() =>
            db.query("select public.start_generation(gen_random_uuid(), 'engine.probe', 'generation-key-0001')"),
          ),
        )
      ).message,
    ).toContain("permission denied");
  });
});
