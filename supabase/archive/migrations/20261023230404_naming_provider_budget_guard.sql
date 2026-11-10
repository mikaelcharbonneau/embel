-- Deploy compatible web/worker code before applying. Future hosted runs only;
-- historical inputs, requests, provider receipts and accounting remain unchanged.
create function fluid_private.naming_progressive_provider_cap(p_input jsonb,p_request jsonb)
returns integer language plpgsql immutable set search_path='' as $$
declare cap integer;
begin
 if p_input->'providerBudgetVersion' is null then
  if p_request#>'{policy,providerSpendCapCents}' is not null then raise exception 'unexpected_provider_budget' using errcode='22023'; end if;
  return 0;
 end if;
 if p_input->'providerBudgetVersion' is distinct from '1'::jsonb or p_input->'localPipelineVersion' is distinct from '2'::jsonb then
  raise exception 'invalid_provider_budget' using errcode='22023';
 end if;
 cap:=case p_request->>'role' when 'researcher' then 25 when 'director' then 10 when 'creator' then 10 when 'curator' then 5 when 'verifier' then 10 end;
 if cap is null or p_request#>'{policy,providerSpendCapCents}' is distinct from to_jsonb(cap)
 or p_request#>'{policy,sessionLimitCents}' is distinct from to_jsonb(cap)
 or p_request#>'{policy,maximumCostMicrousd}' is distinct from to_jsonb(cap*10000) then
  raise exception 'provider_budget_required' using errcode='22023';
 end if;
 return cap;
end $$;
revoke all on function fluid_private.naming_progressive_provider_cap(jsonb,jsonb) from public,anon,authenticated,service_role;

do $$
declare signature text; original text; replacement text; definition text;
begin
 for signature,original,replacement in values
 ('fluid_private.local_naming_publish_microbatch(fluid_private.naming_brain_runs,jsonb)',
 $old$if j.state<>'running' or j.cancel_requested_at is not null or r.recovery_mode<>'execute' or r.superseded or h.paused$old$,
 $new$if (r.observed_overrun and j.input->'providerBudgetVersion'='1'::jsonb) or j.state<>'running' or j.cancel_requested_at is not null or r.recovery_mode<>'execute' or r.superseded or h.paused$new$),
 ('public.record_naming_brain_provider_receipt(uuid,uuid,jsonb)',
 $old$if not fluid_private.naming_brain_unlimited_job(r.job_id) and exists(select 1 from jsonb_array_elements(coalesce(p_receipt->'providerCostCounters','[]'))$old$,
 $new$if (p_receipt->'providerSpendCapCents' is not null or not fluid_private.naming_brain_unlimited_job(r.job_id)) and exists(select 1 from jsonb_array_elements(coalesce(p_receipt->'providerCostCounters','[]'))$new$),
 ('fluid_private.local_naming_progressive_current(fluid_private.naming_brain_runs)',
 $old$select fluid_private.local_naming_progressive_basis(r) and not exists$old$,
 $new$select fluid_private.local_naming_progressive_basis(r)
 and not (r.observed_overrun and exists(select 1 from public.jobs j where j.id=r.job_id and j.input->'providerBudgetVersion'='1'::jsonb)) and not exists$new$),
 ('public.ensure_naming_brain_run(uuid,jsonb)',
 $old$if fluid_private.hosted_naming_context(o,p.id) then input:=input||jsonb_build_object('executionAuthority','hosted_owner_v1'); end if;$old$,
 $new$if fluid_private.hosted_naming_context(o,p.id) then input:=input||jsonb_build_object('executionAuthority','hosted_owner_v1','providerBudgetVersion',1); end if;$new$),
 ('fluid_private.local_naming_progressive_action(uuid,uuid,text,jsonb)',
 $old$if found then if old is distinct from requests then raise exception 'immutable_call_plan' using errcode='55000'; end if; return old; end if;
 for v_request in select value from jsonb_array_elements(requests) loop$old$,
 $new$if found then if old is distinct from requests then raise exception 'immutable_call_plan' using errcode='55000'; end if; return old; end if;
 -- naming_brain_lock serializes competing plans for this run. Reserve the full
 -- caps at planning, not observed consumption; no refund/re-lending on failure.
 if coalesce((select sum(fluid_private.naming_progressive_provider_cap(j.input,request)) from fluid_private.naming_brain_progressive_plans p cross join lateral jsonb_array_elements(p.requests) request where p.run_id=r.id),0)
  +coalesce((select sum(fluid_private.naming_progressive_provider_cap(j.input,request)) from jsonb_array_elements(requests) request),0)>500 then
  raise exception 'naming_provider_budget_exhausted' using errcode='55000';
 end if;
 for v_request in select value from jsonb_array_elements(requests) loop$new$),
 ('fluid_private.local_naming_progressive_authorize(uuid,uuid,jsonb)',
 $old$insert into fluid_private.naming_brain_calls(run_id,owner_id,project_id,stage_key,phase_key,call_key,request) values(r.id,r.owner_id,r.project_id,'creation',phase,p_request->>'providerCallKey',p_request);$old$,
 $new$if coalesce((select sum(fluid_private.naming_progressive_provider_cap(j.input,c.request)) from fluid_private.naming_brain_calls c where c.run_id=r.id),0)
  +fluid_private.naming_progressive_provider_cap(j.input,p_request)>500 then raise exception 'naming_provider_budget_exhausted' using errcode='55000'; end if;
 insert into fluid_private.naming_brain_calls(run_id,owner_id,project_id,stage_key,phase_key,call_key,request) values(r.id,r.owner_id,r.project_id,'creation',phase,p_request->>'providerCallKey',p_request);$new$),
 ('public.record_naming_brain_provider_receipt(uuid,uuid,jsonb)',
 $old$or p_receipt->'localPipelineVersion' is distinct from c.request#>'{policy,localPipelineVersion}'$old$,
 $new$or p_receipt->'localPipelineVersion' is distinct from c.request#>'{policy,localPipelineVersion}'
 or p_receipt->'providerSpendCapCents' is distinct from c.request#>'{policy,providerSpendCapCents}'$new$)
 loop
  definition:=pg_get_functiondef(signature::regprocedure);
  if (length(definition)-length(replace(definition,original,'')))/length(original)<>1 then raise exception 'unexpected_provider_budget_predecessor: %',signature; end if;
  execute replace(definition,original,replacement);
 end loop;
end $$;
