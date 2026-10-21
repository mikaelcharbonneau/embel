import { readFile } from "node:fs/promises";
import { beforeAll, afterAll, beforeEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createTestDatabase, type TestDatabase } from "./local-supabase";
import { installBrainFixture, brainWorker } from "./naming-brain-fixture";
import { seedProgressiveFixture, progressiveRequest, type ProgressiveFixture } from "./naming-brain-progressive-fixture";
let db: TestDatabase, fixture: ProgressiveFixture;
const migrationName = "20261021162000_naming_no_dispatch_recovery.sql";
beforeAll(async () => {
 db=await createTestDatabase({ before: migrationName }); await installBrainFixture(db);
 await db.exec(await readFile(new URL(`../../supabase/migrations/${migrationName}`, import.meta.url),"utf8"));
},120000);
beforeEach(async () => { fixture=await seedProgressiveFixture(db); },60000);
afterAll(async () => { await db?.close(); });
async function ambiguous(cancelled = false) {
 await db.query("update public.jobs set state='needs_reconciliation',error_code='progressive_execution_unknown',lease_token=null,lease_expires_at=null,cancel_requested_at=case when $2 then clock_timestamp() else null end where id=$1",[fixture.job.id,cancelled]);
 await db.query("update public.job_steps set state='ambiguous',output='{\"artifactIds\":[],\"errorCode\":\"progressive_execution_unknown\"}' where job_id=$1 and step_key='creation'",[fixture.job.id]);
}
const recover=()=>brainWorker(db,()=>fixture.store.expireLeases("fixture-worker"));
it.each([false,true])("settles a proven no-dispatch failure without restarting it (cancelled=%s)",async cancelled=>{
 await ambiguous(cancelled); expect(await recover()).toBe(1);
 expect((await db.query("select state,error_code from public.jobs where id=$1",[fixture.job.id])).rows).toEqual([{state:cancelled?'cancelled':'failed',error_code:'local_planning_failed'}]);
 expect((await db.query("select state,actual_microusd from public.usage_reservations where job_id=$1",[fixture.job.id])).rows).toEqual([{state:'settled',actual_microusd:0}]);
 expect((await db.query("select actual_cost_microusd,settlement_evidence->>'kind' kind from fluid_private.naming_brain_runs where id=$1",[fixture.input.runId])).rows).toEqual([{actual_cost_microusd:0,kind:'database_no_dispatch'}]);
 expect(await recover()).toBe(0);
},30000);
it("never releases an authorized create with an unknown provider identity",async()=>{
 const request=progressiveRequest(fixture,'context.research',{role:'researcher',snapshot:fixture.input.snapshot});
 await brainWorker(db,()=>fixture.store.saveProgressiveCallPlan(fixture.job,'context.research',[request]));
 await brainWorker(db,()=>fixture.store.authorizeDispatch(fixture.job,request));
 await ambiguous(true); expect(await recover()).toBe(0);
 expect((await db.query("select state from public.jobs where id=$1",[fixture.job.id])).rows).toEqual([{state:'needs_reconciliation'}]);
 expect((await db.query("select state from public.usage_reservations where job_id=$1",[fixture.job.id])).rows).toEqual([{state:'active'}]);
},30000);
it("does not touch a still-leased request",async()=>{
 await db.query("update public.jobs set error_code='progressive_execution_unknown' where id=$1",[fixture.job.id]);
 expect(await recover()).toBe(0);
},30000);

it("leaves observed overrun evidence untouched",async()=>{
 await ambiguous(true);
 await db.query("update fluid_private.naming_brain_runs set observed_overrun=true where id=$1",[fixture.input.runId]);
 expect(await recover()).toBe(0);
 expect((await db.query("select state from public.usage_reservations where job_id=$1",[fixture.job.id])).rows).toEqual([{state:'active'}]);
},30000);
it("requires the original worker deployment scope",async()=>{
 await ambiguous(true);
 const count=await brainWorker(db,async()=> (await db.query<{n:number}>("select public.expire_naming_brain_leases('fixture-worker','wrong-deployment') n")).rows[0]!.n);
 expect(count).toBe(0);
},30000);
