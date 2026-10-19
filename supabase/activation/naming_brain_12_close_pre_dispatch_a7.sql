-- Exact operator-only correction for the 5Ll4XtYLlqxh-eIETl9DN execution.
-- Frozen transport required an acknowledged immutable base receipt before
-- createSession. This call has only its empty UNKNOWN receipt, so that invocation
-- was never reached. Append the corrected evidence; ordinary observation closes
-- the job. No existing rows, allowances, attempts, schedules or timestamps change.
begin;
do $repair$
declare r fluid_private.naming_brain_runs; j public.jobs; s public.job_steps;
 c fluid_private.naming_brain_calls; old fluid_private.naming_brain_receipts; receipt jsonb; output jsonb; proof jsonb;
begin
 perform fluid_private.lock_strategy_owner('6840f4c2-15a6-45a7-97be-41e7e5e37f42');
 if current_user<>'postgres' or to_regprocedure('fluid_private.naming_brain_local_not_dispatched(fluid_private.naming_brain_calls,jsonb)') is null
 or not exists(select 1 from pg_trigger t join pg_proc p on p.oid=t.tgfoid where t.tgrelid='fluid_private.naming_brain_receipts'::regclass
  and t.tgname='naming_brain_history_immutable' and t.tgenabled='O' and md5(p.prosrc)='a9fa5e77cfba0df78b222fdf8c087a54')
 or not exists(select 1 from pg_proc where oid='public.record_naming_brain_provider_receipt(uuid,uuid,jsonb)'::regprocedure
  and md5(prosrc)='6ac7032d233e168d12ebac9f568675e8') then raise exception 'pre_dispatch_repair_prerequisite'; end if;
 select * into strict r from fluid_private.naming_brain_runs where id='91ef5c13-bb82-44a3-945d-f896d7a4642f'
  and job_id='68fd2858-0469-4638-abfc-b48de580f729' and project_id='90d3fda3-de0b-48c2-946e-2200b67a883a'
  and owner_id='6840f4c2-15a6-45a7-97be-41e7e5e37f42' for update;
 select * into strict j from public.jobs where id=r.job_id and owner_id=r.owner_id and project_id=r.project_id for update;
 select * into strict s from public.job_steps where job_id=j.id and step_key='creation' and owner_id=r.owner_id and project_id=r.project_id for update;
 select * into strict c from fluid_private.naming_brain_calls where run_id=r.id and stage_key='creation' and call_key='creation-creator-a7';
 select * into strict old from fluid_private.naming_brain_receipts where run_id=r.id and stage_key=c.stage_key and call_key=c.call_key;
 if not fluid_private.local_prototype_unlimited_job(j.id) or r.recovery_mode<>'observe_only' or r.superseded or r.actual_cost_microusd is not null
  or r.settlement_evidence is not null or r.admitted_role_oid<>23033
  or r.snapshot_hash<>'bf545c3a7d9278a9c012f9a74382475ee4e83e36c3d27f9047369a965847fe71'
  or r.policy_identity<>'274ab21a826621e20109af32c3afd006285cd36a94ebeb35578d1147997e8381'
  or j.operation<>'naming.generate' or j.state<>'needs_reconciliation' or j.lease_token is not null or j.lease_expires_at is not null
  or j.cancel_requested_at is not null or j.actual_cost_microusd<>0 or s.state<>'ambiguous'
  or exists(select 1 from public.projects p where p.id=r.project_id and (p.current_revision<>5 or p.deleted_at is not null or p.deletion_requested_at is not null))
  or md5(to_jsonb(c)::text)<>'046689f3cd721cbdee9c4a1bede19594'
  or c.request->>'requestHash'<>'9af8577fb94525a6b580fb4e13c2dad896276eb7e8fc2f2f59d313a0b0c456d9'
  or c.request->>'requestKey'<>'naming-7a46bc2d76d4bd749b9d8982130128c9760e740e713519ea'
  or c.request#>>'{policy,budgetControl}'<>'local_unlimited_v1'
  or old.id<>'91da4683-adbc-46e9-bdfc-4c1e19895b62' or md5(to_jsonb(old)::text)<>'dfb4abdcbbbdd95f862917cf72268846'
  or old.content_hash<>'5ff3e5d29c9468be373b044d7c513afd09f38791527b6e6d730adc336ea979a3'
  or old.receipt->>'dispatchState'<>'unknown' or old.receipt->>'requestId' is not null or old.receipt->>'sessionId' is not null
  or old.receipt->>'turnId' is not null or old.receipt->>'agentId' is not null or old.receipt->>'responseId' is not null
  or old.receipt->'callIds' is distinct from '[]'::jsonb or old.receipt->'toolCalls' is distinct from '[]'::jsonb
  or old.receipt->'artifactItemIds' is distinct from '[]'::jsonb or old.receipt->'usageObservations' is distinct from '[]'::jsonb
  or old.receipt->'providerCostCounters' is distinct from '[]'::jsonb
  or (select count(*) from fluid_private.naming_brain_calls where run_id=r.id)<>9
  or exists(select 1 from fluid_private.naming_brain_calls other where other.run_id=r.id and other.call_key<>c.call_key and not fluid_private.naming_brain_call_terminal(other))
  or exists(select 1 from fluid_private.naming_brain_provider_records p where p.run_id=r.id and p.stage_key=c.stage_key and p.call_key=c.call_key)
  or exists(select 1 from fluid_private.naming_brain_artifacts a where a.run_id=r.id and a.artifact#>>'{providerReceipt,providerCallKey}'=c.call_key)
  or exists(select 1 from fluid_private.naming_brain_prepared_sets where run_id=r.id)
  or exists(select 1 from fluid_private.naming_brain_feed_entries where run_id=r.id)
  or not exists(select 1 from public.usage_reservations where job_id=j.id and owner_id=r.owner_id and project_id=r.project_id
   and state='active' and reserved_microusd=5000000 and actual_microusd=0 and captured_microusd=0)
  then raise exception 'pre_dispatch_repair_evidence_mismatch'; end if;
 receipt:=old.receipt||jsonb_build_object('dispatchState','not_dispatched','recordedAt',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
 insert into fluid_private.naming_brain_receipts(run_id,owner_id,project_id,stage_key,call_key,receipt,content_hash)
  values(r.id,r.owner_id,r.project_id,c.stage_key,c.call_key,receipt,encode(sha256(convert_to(receipt::text,'UTF8')),'hex'));
 proof:=jsonb_build_object('providerCallKey',c.call_key,'status','rejected_before_dispatch','code','local_dispatch_not_attempted','receipt',receipt);
 output:=jsonb_build_object('artifactIds',s.output->'artifactIds','errorCode','local_dispatch_not_attempted','partialArtifacts',jsonb_build_array(proof));
 if not fluid_private.naming_brain_local_not_dispatched(c,output) then raise exception 'pre_dispatch_repair_proof_mismatch'; end if;
 insert into fluid_private.naming_brain_stage_results(run_id,owner_id,project_id,stage_key,state,output)
  values(r.id,r.owner_id,r.project_id,c.stage_key,'failed',output);
 if not fluid_private.naming_brain_call_terminal(c) then raise exception 'pre_dispatch_repair_terminal_mismatch'; end if;
end $repair$;
commit;
