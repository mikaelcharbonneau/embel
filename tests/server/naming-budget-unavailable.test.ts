import { afterAll, beforeAll, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { ensureNextNamingRun, getNamingFeed } from "../../src/server/data/naming-brain";
import type { AuthenticatedContext } from "../../src/server/auth/context";
import { createTestDatabase, OWNER_A, OWNER_B, type TestDatabase } from "../database/local-supabase";
import { brainAction, brainRpc, brainWorker, initialIntent, installBrainFixture, prepareBrainFixture, seedBrainFixture } from "../database/naming-brain-fixture";

let db: TestDatabase;
beforeAll(async () => { db = await createTestDatabase(); await installBrainFixture(db); }, 30_000);
afterAll(async () => { await db?.close(); });

function reader(owner = OWNER_A) {
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (name !== "get_naming_feed") throw Error("Admission must not run while the provider cap is unavailable");
    try { return { data: await brainRpc(db, name, [args.p_project_id, args.p_query], owner), error: null }; }
    catch { return { data: null, error: { code: "P0002" } }; }
  });
  return { auth: { userId: owner, client: { rpc } } as unknown as AuthenticatedContext, rpc };
}

it("blocks before admission, leaving no job, run or new US$5 reservation across repeated starts", async () => {
  const project = await seedBrainFixture(db), { auth, rpc } = reader();
  const before = (await db.query("select count(*)::integer n from public.jobs")).rows;
  const heldBefore = (await db.query("select count(*)::integer n from fluid_private.naming_brain_runs")).rows;
  const reservationsBefore = (await db.query("select * from public.usage_reservations order by job_id")).rows;
  const feed = await getNamingFeed(auth, project);
  expect(feed.availability).toEqual({ status: "unavailable", code: "provider_budget_control_unavailable" });
  for (let i = 0; i < 2; i++) expect(await ensureNextNamingRun(auth, project, initialIntent())).toMatchObject({ status: "blocked", code: "provider_budget_control_unavailable", action: "configure" });
  expect((await db.query("select count(*)::integer n from public.jobs")).rows).toEqual(before);
  expect((await db.query("select count(*)::integer n from fluid_private.naming_brain_runs")).rows).toEqual(heldBefore);
  expect((await db.query("select * from public.usage_reservations order by job_id")).rows).toEqual(reservationsBefore);
  expect(rpc.mock.calls.every(([name]) => name === "get_naming_feed")).toBe(true);
  expect(feed.canResumeOnScroll).toBeUndefined(); expect(feed.canPrefetchOnScroll).toBeUndefined();
});

it("retains the owned read boundary even when generation is disabled", async () => {
  const project = await seedBrainFixture(db);
  await expect(ensureNextNamingRun(reader(OWNER_B).auth, project, initialIntent())).rejects.toMatchObject({ code: "not_found" });
});

it("continues exact saved membership without a new job or reservation while new generation is blocked", async () => {
  const project = await seedBrainFixture(db), { job } = await prepareBrainFixture(db, project);
  await brainRpc(db, "stop_naming_feed", [project, { version: 1, expectedDemandSequence: 0, pendingEnsureIdempotencyKey: null, idempotencyKey: "synthetic-budget-free-stop" }]);
  await brainWorker(db, () => db.query("select public.complete_naming_brain_stage($1,$2,'prepare','succeeded','{\"artifactIds\":[]}')", [job.id, job.lease_token]));
  await brainAction(db, job, "finish", { state: "cancelled", errorCode: null });
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => ({ data: await brainRpc(db, name, Object.values(args)), error: null }));
  const auth = { userId: OWNER_A, client: { rpc, from: (table: string) => {
    expect(table).toBe("naming_preferences");
    const filters = new Map<string, unknown>();
    const query = { select: () => query, eq: (field: string, value: unknown) => { filters.set(field, value); return query; },
      maybeSingle: async () => ({ data: (await db.query("select owner_id,project_id,version,preferences from public.naming_preferences where owner_id=$1 and project_id=$2 and version=$3", [filters.get("owner_id"), filters.get("project_id"), filters.get("version")])).rows[0] ?? null, error: null }) };
    return query;
  } } } as unknown as AuthenticatedContext;
  const feed = await getNamingFeed(auth, project);
  expect(feed.activeRun?.canResumeSaved).toBe(true);
  const jobs = (await db.query("select count(*)::integer n from public.jobs")).rows;
  const reservations = (await db.query("select * from public.usage_reservations order by job_id")).rows;
  const run = feed.activeRun!;
  expect(await ensureNextNamingRun(auth, project, { ...initialIntent("synthetic-budget-free-resume"), reason: "resume", expectedDemandSequence: feed.demandSequence, resumeOfRunId: run.runId, expectedRunRevision: run.revision })).toMatchObject({ status: "appended" });
  expect((await db.query("select count(*)::integer n from public.jobs")).rows).toEqual(jobs);
  expect((await db.query("select * from public.usage_reservations order by job_id")).rows).toEqual(reservations);
  expect((await getNamingFeed(auth, project)).entries).toHaveLength(100);
});
