import { afterAll, beforeAll, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { guidedStrategyPolicy } from "../../src/server/ai/config";
import { NamingBrainJobStore } from "../../worker/naming-brain-store";
import { runOneJob, type HandlerRegistry } from "../../worker/runner";
import { createTestDatabase, OWNER_A, type TestDatabase } from "../database/local-supabase";
import { brainRpc, brainWorker, initialIntent, installBrainFixture, seedBrainFixture } from "../database/naming-brain-fixture";

let db: TestDatabase;
beforeAll(async () => { db = await createTestDatabase(); await installBrainFixture(db); }, 60_000);
afterAll(async () => { await db?.close(); });

it("fences a committed claim whose client ACK times out until ordinary SQL lease expiry, without provider execution", async () => {
 const project = await seedBrainFixture(db), policy = guidedStrategyPolicy("strategy.reformulate");
 await db.query("insert into fluid_private.strategy_runtime_policy(operation,enabled,policy) values('strategy.reformulate',true,$1) on conflict(operation) do update set enabled=true,policy=excluded.policy", [policy]);
 await db.query("insert into fluid_private.local_prototype_strategy_capabilities(owner_id,operation,role_name,role_oid,deployment_id,policy,enabled,ready_until) select $1,'strategy.reformulate',rolname,oid,'fixture-deployment',$2,true,clock_timestamp()+interval '90 seconds' from pg_roles where rolname='fixture_naming_brain_a'", [OWNER_A, policy]);
 await brainRpc(db, "ensure_local_naming_brain_run", [project, initialIntent("synthetic-lost-claim-ack")]);
 let dropAcknowledgment = true;
 const store = new NamingBrainJobStore({ query: async (sql, values) => {
  const result = await db.query<Record<string, unknown>>(sql, values);
  if (sql.includes("public.claim_naming_brain_job") && dropAcknowledgment) {
   dropAcknowledgment = false;
   // The real restricted SQL claim committed. Only its client acknowledgment
   // is lost; no lease object reaches the runner or any provider adapter.
   throw new Error("Query read timeout");
  }
  return result;
 } }, "fixture-deployment");
 const execute = vi.fn(async () => { throw Error("synthetic_provider_must_not_be_reached"); });
 const steps = vi.fn(() => [{ key: "creation", maximumCostMicrousd: 1_500_000, execute }, { key: "prepare", maximumCostMicrousd: 0, execute }]);
 const handlers: HandlerRegistry = new Map([["naming.generate", { steps }]]);
 const run = () => brainWorker(db, () => runOneJob({ store, handlers, workerId: "fixture-worker", localPrototype: true }));
 await expect(run()).rejects.toThrow("Query read timeout");
 const first = (await db.query<{ id: string; lease_token: string; state: string; attempts: number }>("select id,lease_token,state,attempts from public.jobs where project_id=$1", [project])).rows[0]!;
 expect(first).toMatchObject({ state: "running", attempts: 1 }); expect(first.lease_token).toBeTypeOf("string");
 // This is the exact next pre-lease maintenance retry: the still-owned SQL
 // lease excludes the job even though the client never received its token.
 expect(await run()).toBe("idle");
 expect((await db.query("select lease_token from public.jobs where id=$1", [first.id])).rows).toEqual([{ lease_token: first.lease_token }]);
 expect(steps).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
 expect((await db.query("select count(*)::integer count from fluid_private.naming_brain_calls")).rows).toEqual([{ count: 0 }]);
 // Disposable clock eligibility only. Existing lease maintenance, not a manual
 // state/token reset, performs recovery after the original lease has expired.
 await db.query("update public.jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1", [first.id]);
 expect(await brainWorker(db, () => store.expireLeases("fixture-worker"))).toBe(1);
 const recovered = await brainWorker(db, () => store.claim("fixture-worker", 120));
 expect(recovered?.id).toBe(first.id); expect(recovered?.leaseToken).not.toBe(first.lease_token);
 expect((await db.query("select count(*)::integer count from public.jobs where project_id=$1", [project])).rows).toEqual([{ count: 1 }]);
 expect((await db.query("select attempts from public.jobs where id=$1", [first.id])).rows).toEqual([{ attempts: 2 }]);
 expect((await db.query("select count(*)::integer count from fluid_private.naming_brain_calls")).rows).toEqual([{ count: 0 }]);
 expect(steps).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
}, 30_000);
