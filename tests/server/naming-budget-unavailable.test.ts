import { afterAll, beforeAll, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { ensureNextNamingRun, getNamingFeed } from "../../src/server/data/naming-brain";
import type { AuthenticatedContext } from "../../src/server/auth/context";
import { asRole, createTestDatabase, OWNER_A, OWNER_B, type TestDatabase } from "../database/local-supabase";
import { brainAction, brainRpc, brainWorker, initialIntent, installBrainFixture, prepareBrainFixture, seedBrainFixture } from "../database/naming-brain-fixture";

let db: TestDatabase;
beforeAll(async () => { db = await createTestDatabase(); await installBrainFixture(db); }, 30_000);
afterAll(async () => { await db?.close(); });

function reader(owner = OWNER_A) {
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    expect(["get_naming_feed", "get_naming_brain_candidate_sources", "ensure_naming_brain_run"]).toContain(name);
    try { return { data: await brainRpc(db, name, Object.values(args), owner), error: null }; }
    catch { return { data: null, error: { code: "P0002" } }; }
  });
  const from = (table: string) => {
    expect(table).toBe("naming_preferences");
    const filters = new Map<string, unknown>();
    const query = { select: () => query, eq: (field: string, value: unknown) => { filters.set(field, value); return query; },
      maybeSingle: async () => ({ data: (await asRole(db, "authenticated", owner, () => db.query("select owner_id,project_id,version,preferences from public.naming_preferences where owner_id=$1 and project_id=$2 and version=$3", [filters.get("owner_id"), filters.get("project_id"), filters.get("version")]))).rows[0] ?? null, error: null }) };
    return query;
  };
  return { auth: { userId: owner, client: { rpc, from } } as unknown as AuthenticatedContext, rpc };
}

it("delegates repeated starts to exact owner-scoped admission without a provider spending-control prerequisite", async () => {
  const project = await seedBrainFixture(db), { auth, rpc } = reader();
  const feed = await getNamingFeed(auth, project);
  expect(feed.availability.status).toBe("available");
  const first = await ensureNextNamingRun(auth, project, initialIntent());
  expect(first.status).toBe("pending");
  if (first.status !== "pending") throw Error("Synthetic admission was not pending");
  const retained = (await db.query("select input from public.jobs where id=$1", [first.run.jobId])).rows;
  expect(await ensureNextNamingRun(auth, project, initialIntent())).toMatchObject({ status: "pending", run: { runId: first.run.runId, jobId: first.run.jobId } });
  expect((await db.query("select input from public.jobs where id=$1", [first.run.jobId])).rows).toEqual(retained);
  expect((await db.query("select count(*)::integer n from public.jobs where project_id=$1", [project])).rows).toEqual([{ n: 1 }]);
  expect(rpc.mock.calls.filter(([name]) => name === "ensure_naming_brain_run")).toHaveLength(2);
  expect(feed.canResumeOnScroll).toBeUndefined(); expect(feed.canPrefetchOnScroll).toBeUndefined();
});

it("retains owned read and admission boundaries without a cost-based precheck", async () => {
  const project = await seedBrainFixture(db), foreign = reader(OWNER_B);
  await expect(getNamingFeed(foreign.auth, project)).rejects.toMatchObject({ code: "not_found" });
  await expect(ensureNextNamingRun(foreign.auth, project, initialIntent())).rejects.toMatchObject({ code: "conflict" });
  expect(foreign.rpc.mock.calls.some(([name]) => name === "ensure_naming_brain_run")).toBe(false);
});

it("continues exact saved membership without a new job or changing historical reservations", async () => {
  const project = await seedBrainFixture(db), { job } = await prepareBrainFixture(db, project);
  await brainRpc(db, "stop_naming_feed", [project, { version: 1, expectedDemandSequence: 0, pendingEnsureIdempotencyKey: null, idempotencyKey: "synthetic-budget-free-stop" }]);
  await brainWorker(db, () => db.query("select public.complete_naming_brain_stage($1,$2,'prepare','succeeded','{\"artifactIds\":[]}')", [job.id, job.lease_token]));
  await brainAction(db, job, "finish", { state: "cancelled", errorCode: null });
  const { auth } = reader();
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
