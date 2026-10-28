import { afterAll,beforeAll,describe,expect,it,vi } from "vitest";
vi.mock("server-only",()=>({}));
import { createSharedAdvancedLogoFixture,type SharedAdvancedLogoFixture } from "./shared-advanced-logo-fixture";
import { prepareAmbiguousSharedExport } from "./shared-advanced-logo-resolution-fixture";

describe("observation-only lost export-stage acknowledgement resolution (synthetic bytes; actual restricted SQL)",()=>{
 let f:SharedAdvancedLogoFixture;
 beforeAll(async()=>{f=await createSharedAdvancedLogoFixture();},90_000);
 afterAll(async()=>{await f?.close();});
 async function setup(){await f.resetLease();await f.runtimeReady();return prepareAmbiguousSharedExport(f);}
 it("requires all issued immutable readbacks, preserves the ambiguity and resolves once without a lease or current policy",async()=>{
  await f.db.exec("begin");
  try{
   const t=await setup(),e=t.execution;
   expect((await f.action(e,"finish_known",[])).result).toEqual({status:"retained_unknown"});
   const before=(await f.db.query<{job:unknown;step:unknown}>("select to_jsonb(j) job,to_jsonb(s) step from public.jobs j join public.job_steps s on s.job_id=j.id where j.id=$1",[e.jobId])).rows[0]!;
   const heads=(await f.db.query("select * from public.logo_stage_heads where project_id=$1 order by stage",[e.projectId])).rows;
   await t.observeAll();
   await f.db.query("delete from fluid_private.shared_worker_policies where slot_id=$1 and operation='identity.logo_export'",[f.slotId]);
   expect((await f.action(e,"finish_known",[])).result).toEqual({status:"terminal",state:"succeeded"});
   const witnesses=(await f.db.query<{original_job:unknown;original_step:unknown;receipt:unknown}>("select * from fluid_private.shared_logo_export_resolutions where execution_id=$1",[e.executionId])).rows;
   expect(witnesses).toHaveLength(1);expect(witnesses[0]!.original_job).toEqual(before.job);expect(witnesses[0]!.original_step).toEqual(before.step);
   expect((await f.rawJob(e.jobId))).toMatchObject({state:"succeeded",lease_token:null});
   expect((await f.db.query("select state,reserved_microusd,actual_microusd,captured_microusd from public.usage_reservations where job_id=$1",[e.jobId])).rows).toEqual([{state:"settled",reserved_microusd:0,actual_microusd:0,captured_microusd:0}]);
   expect((await f.db.query("select * from public.logo_stage_heads where project_id=$1 order by stage",[e.projectId])).rows).toEqual(heads);
   const replay=(await f.action(e,"recovery",[])).result as {executionClosed:boolean;outputs:unknown[]};expect(replay.executionClosed).toBe(true);expect(replay.outputs).toEqual([]);
   expect((await f.db.query("select * from fluid_private.shared_logo_export_resolutions where execution_id=$1",[e.executionId])).rows).toEqual(witnesses);
   expect((await f.db.query("select count(*)::int n from public.logo_export_manifests where job_id=$1",[e.jobId])).rows).toEqual([{n:1}]);
   await expect(f.db.query("update fluid_private.shared_logo_export_resolutions set receipt='{}' where execution_id=$1",[e.executionId])).rejects.toMatchObject({code:"42501"});
  }finally{await f.db.exec("rollback;set session authorization postgres");}
 },90_000);
 it.each(["cancel","delete","ban","foreign","missing_grant","missing_observation","tampered_group"] as const)("retains %s evidence without committing artifacts",async mode=>{
  await f.db.exec("begin");
  try{
   const t=await setup(),e=t.execution;await t.observeAll();
   if(mode==="cancel")await f.db.query("update public.jobs set cancel_requested_at=clock_timestamp() where id=$1",[e.jobId]);
   if(mode==="delete")await f.db.query("update public.projects set deletion_requested_at=clock_timestamp(),lifecycle_version=lifecycle_version+1 where id=$1",[e.projectId]);
   if(mode==="ban")await f.db.query("update auth.users set banned_until=clock_timestamp()+interval '1 hour' where id=$1",[e.ownerId]);
   if(mode==="foreign"){
    await expect(f.action({...e,ownerId:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"},"finish_known",[])).rejects.toMatchObject({code:"42501"});return;
   }
   // Deliberate fixture-only corruption models an absent or mismatched durable
   // witness. Runtime principals have no UPDATE/DELETE on these private rows.
   if(mode==="missing_grant")await f.db.query("delete from fluid_private.shared_storage_grants where execution_id=$1 and reservation_id=$2",[e.executionId,t.reservations[0]!.id]);
   if(mode==="missing_observation"){
    await f.db.exec("alter table fluid_private.shared_logo_output_observations disable trigger shared_logo_output_observation_immutable");
    await f.db.query("delete from fluid_private.shared_logo_output_observations where execution_id=$1 and reservation_id=$2",[e.executionId,t.reservations[0]!.id]);
   }
   if(mode==="tampered_group"){
    await f.db.exec("alter table public.logo_export_publications disable trigger logo_export_publications_immutable");
    await f.db.query("update public.logo_export_publications set source_snapshot_hash=repeat('f',64) where job_id=$1",[e.jobId]);
   }
   expect((await f.action(e,"finish_known",[])).result).toEqual({status:"retained_unknown"});
   expect((await f.db.query("select count(*)::int n from fluid_private.shared_logo_export_resolutions where job_id=$1",[e.jobId])).rows).toEqual([{n:0}]);
   expect((await f.db.query("select count(*)::int n from public.asset_versions where id in(select version_id from public.logo_asset_publications where job_id=$1)",[e.jobId])).rows).toEqual([{n:0}]);
  }finally{await f.db.exec("rollback;set session authorization postgres");}
 },90_000);
 it("rolls back witness, assets, manifest and settlement if the final job write fails",async()=>{
  await f.db.exec("begin");
  try{
   const t=await setup(),e=t.execution;await t.observeAll();
   const before=(await f.db.query("select to_jsonb(j) job,to_jsonb(s) step from public.jobs j join public.job_steps s on s.job_id=j.id where j.id=$1",[e.jobId])).rows;
   await f.db.exec("create function public.synthetic_export_resolution_fault() returns trigger language plpgsql as $$begin if new.operation='identity.logo_export' and new.state='succeeded' then raise exception 'synthetic_final_write_fault' using errcode='P0001';end if;return new;end$$;create trigger synthetic_export_resolution_fault before update on public.jobs for each row execute function public.synthetic_export_resolution_fault()");
   await expect(f.action(e,"finish_known",[])).rejects.toMatchObject({code:"P0001"});
   expect((await f.db.query("select to_jsonb(j) job,to_jsonb(s) step from public.jobs j join public.job_steps s on s.job_id=j.id where j.id=$1",[e.jobId])).rows).toEqual(before);
   for(const table of ["fluid_private.shared_logo_export_resolutions","public.logo_export_manifests"])expect((await f.db.query(`select count(*)::int n from ${table} where job_id=$1`,[e.jobId])).rows).toEqual([{n:0}]);
   expect((await f.db.query("select count(*)::int n from public.asset_versions where id in(select version_id from public.logo_asset_publications where job_id=$1)",[e.jobId])).rows).toEqual([{n:0}]);
   expect((await f.db.query("select distinct state from public.logo_asset_publications where job_id=$1",[e.jobId])).rows).toEqual([{state:"staged"}]);
   expect((await f.db.query("select state from public.usage_reservations where job_id=$1",[e.jobId])).rows).toEqual([{state:"active"}]);
   expect((await f.db.query("select * from fluid_private.shared_worker_gateway_context")).rows).toEqual([]);
  }finally{await f.db.exec("rollback;set session authorization postgres");}
 },90_000);
});
