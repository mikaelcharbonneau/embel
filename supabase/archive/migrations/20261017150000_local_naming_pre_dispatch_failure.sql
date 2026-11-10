-- A trusted local execution can prove it stopped before invoking the provider.
-- The ordinary pre-create base receipt alone is never terminal proof.
begin;
do $guard$
declare signature text; expected text; definer boolean; volatility text;
begin
 for signature,expected,definer,volatility in values
 ('public.complete_naming_brain_stage(uuid,uuid,text,text,jsonb)','80239a5185d46604c52c92cc46b30ad4',true,'v'),
 ('fluid_private.naming_brain_call_terminal(fluid_private.naming_brain_calls)','5c0e13833a8413c3555c2cd46d764d9c',false,'s') loop
  if not exists(select 1 from pg_proc p where p.oid=signature::regprocedure and md5(p.prosrc)=expected
   and p.prosecdef=definer and p.provolatile::text=volatility and p.proconfig=array['search_path=""']
   and not p.proleakproof and p.proowner=(select oid from pg_roles where rolname=current_user)) then raise exception 'unexpected_local_pre_dispatch_predecessor: %',signature; end if;
 end loop;
end $guard$;

create function fluid_private.naming_brain_local_not_dispatched(c fluid_private.naming_brain_calls,p_output jsonb) returns boolean
language sql stable set search_path='' as $$
 select c.request#>>'{policy,budgetControl}' is not distinct from 'local_unlimited_v1'
 and exists(select 1 from fluid_private.naming_brain_runs r where r.id=c.run_id and r.owner_id=c.owner_id and r.project_id=c.project_id
  and fluid_private.local_prototype_unlimited_job(r.job_id))
 and exists(select 1 from jsonb_array_elements(case when jsonb_typeof(p_output->'partialArtifacts')='array' then p_output->'partialArtifacts' else '[]'::jsonb end) proof
  join fluid_private.naming_brain_receipts saved on saved.run_id=c.run_id and saved.stage_key=c.stage_key and saved.call_key=c.call_key and saved.receipt=proof->'receipt'
  where proof->>'providerCallKey'=c.call_key and proof->>'status'='rejected_before_dispatch' and proof->>'code'='local_dispatch_not_attempted'
  and saved.receipt->>'budgetControl'='local_unlimited_v1' and saved.receipt->>'protocol'='openai_agents'
  and saved.receipt->>'dispatchState'='not_dispatched' and saved.receipt->>'requestId' is null
  and saved.receipt->>'requestHash'=c.request->>'requestHash' and saved.receipt->>'requestKey'=c.request->>'requestKey'
  and saved.receipt->>'providerCallKey'=c.call_key and saved.receipt->>'runId'=c.run_id::text and saved.receipt->>'stageKey'=c.stage_key
  and saved.receipt->>'observedModel' is null and saved.receipt->>'estimatedCostMicrousd' is null
  and saved.receipt->>'accountingStatus'='provisional' and saved.receipt->>'confirmedActualCostMicrousd' is null
  and not exists(select 1 from fluid_private.naming_brain_receipts newer where newer.run_id=c.run_id and newer.stage_key=c.stage_key and newer.call_key=c.call_key
   and (newer.created_at,newer.id)>(saved.created_at,saved.id)))
 and not exists(select 1 from fluid_private.naming_brain_receipts other where other.run_id=c.run_id and other.stage_key=c.stage_key and other.call_key=c.call_key
  and (other.receipt->>'budgetControl' is distinct from 'local_unlimited_v1' or coalesce(other.receipt->>'dispatchState','') not in('not_dispatched','unknown')
   or other.receipt->>'requestId' is not null or other.receipt->>'sessionId' is not null or other.receipt->>'turnId' is not null
   or other.receipt->>'agentId' is not null or other.receipt->>'responseId' is not null or other.receipt->>'observedModel' is not null
   or other.receipt->'callIds' is distinct from '[]'::jsonb or other.receipt->'toolCalls' is distinct from '[]'::jsonb or other.receipt->'artifactItemIds' is distinct from '[]'::jsonb
   or other.receipt->'usageObservations' is distinct from '[]'::jsonb or other.receipt->'providerCostCounters' is distinct from '[]'::jsonb
   or other.receipt->>'estimatedCostMicrousd' is not null or other.receipt->>'confirmedActualCostMicrousd' is not null))
 and not exists(select 1 from fluid_private.naming_brain_provider_records pr where pr.run_id=c.run_id and pr.stage_key=c.stage_key and pr.call_key=c.call_key)
 and not exists(select 1 from fluid_private.naming_brain_artifacts a where a.run_id=c.run_id and a.stage_key=c.stage_key and a.artifact#>>'{providerReceipt,providerCallKey}'=c.call_key);
$$;

do $patch$
declare definition text; original text; replacement text;
begin
 definition:=pg_get_functiondef('public.complete_naming_brain_stage(uuid,uuid,text,text,jsonb)'::regprocedure);
 original:=$old$(p_state='failed' and p_output->>'errorCode'='provider_request_rejected' and fluid_private.naming_brain_rejected_receipt(c))$old$;
 replacement:=$new$(p_state='failed' and ((p_output->>'errorCode'='provider_request_rejected' and fluid_private.naming_brain_rejected_receipt(c))
 or fluid_private.naming_brain_local_not_dispatched(c,p_output)))$new$;
 if (length(definition)-length(replace(definition,original,'')))/length(original)<>2 then raise exception 'unexpected_local_pre_dispatch_completion_guard'; end if;
 execute replace(definition,original,replacement);
 definition:=pg_get_functiondef('fluid_private.naming_brain_call_terminal(fluid_private.naming_brain_calls)'::regprocedure);
 original:=$old$select fluid_private.naming_brain_call_completed(c) or fluid_private.naming_brain_call_failed(c)$old$;
 replacement:=$new$select fluid_private.naming_brain_call_completed(c) or fluid_private.naming_brain_call_failed(c)
 or exists(select 1 from fluid_private.naming_brain_stage_results result where result.run_id=c.run_id and result.stage_key=c.stage_key
  and result.state='failed' and fluid_private.naming_brain_local_not_dispatched(c,result.output))$new$;
 if (length(definition)-length(replace(definition,original,'')))/length(original)<>1 then raise exception 'unexpected_local_pre_dispatch_terminal_guard'; end if;
 execute replace(definition,original,replacement);
end $patch$;

do $deny$
declare privilege record; object_id oid:='fluid_private.naming_brain_local_not_dispatched(fluid_private.naming_brain_calls,jsonb)'::regprocedure;
begin
 for privilege in select distinct a.grantee from pg_proc p,lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where p.oid=object_id and a.grantee<>p.proowner loop
  execute format('revoke all on function %s from %s cascade',object_id::regprocedure,case when privilege.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(privilege.grantee)) end);
 end loop;
end $deny$;
commit;
