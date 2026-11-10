-- Finish interrupted raster delivery from the original provider receipt and
-- already issued Storage bytes. This never authorizes another provider call.
-- Install after shared_logo_raster_uncapped.sql with shared lanes drained.
begin;
do $$begin
 if session_user<>'postgres' or current_user<>session_user then raise exception 'raster_recovery_installer_denied' using errcode='42501';end if;
 if not exists(select 1 from pg_proc where oid='fluid_private.shared_identity_previous_logo_gateway(jsonb,jsonb,text,jsonb)'::regprocedure
  and proowner='postgres'::regrole and proconfig=array['search_path=""'] and not proleakproof
  and encode(sha256(convert_to(prosrc,'UTF8')),'hex')='585fa162edfd0263c6399017232c7373cb108a7f079434db35c8ba888ac1ac18')
  or to_regprocedure('fluid_private.shared_logo_raster_job_matches(public.jobs,jsonb)') is null
 then raise exception 'raster_recovery_predecessor_mismatch' using errcode='55000';end if;
end $$;

-- Keep recovery evidence separate: older readers hash complete job row JSON.
-- Adding even a nullable column there would invalidate their saved receipts.
create table fluid_private.shared_logo_raster_recoveries(
 job_id uuid primary key references public.jobs(id),
 execution_id uuid not null unique references fluid_private.shared_worker_executions(execution_id),
 evidence jsonb not null check(jsonb_typeof(evidence)='object' and octet_length(evidence::text)<=1048576)
);
alter table fluid_private.shared_logo_raster_recoveries enable row level security;
alter table fluid_private.shared_logo_raster_recoveries force row level security;
create trigger shared_logo_raster_recoveries_immutable before update or delete on fluid_private.shared_logo_raster_recoveries
 for each row execute function fluid_private.prevent_history_change();

create function fluid_private.shared_logo_resolve_raster() returns jsonb
language plpgsql volatile set search_path='' as $$
<<resolution>>
declare e fluid_private.shared_worker_executions;j public.jobs;validation_job public.jobs;s public.job_steps;
 a fluid_private.shared_job_admissions;q public.logo_cost_quotes;policy fluid_private.logo_runtime_policies;
 provider public.logo_provider_responses;p public.logo_asset_publications;usage public.usage_reservations;
 project_json jsonb;verification jsonb;output jsonb;receipt jsonb;previous jsonb;reason text;step_key text;
 cost bigint;state text:='succeeded';prior_timeout text;
begin
 if fluid_private.shared_worker_context_mode('logo') is distinct from 'observe' then return null;end if;
 e:=fluid_private.shared_worker_context_execution('logo');
 if e.execution_id is null or e.state<>'observing' or e.operation not in('identity.logo_concept','identity.logo_refine') then return null;end if;
 -- The gateway owns slot/execution/job locks. Project edits use the reverse
 -- project/job order; never wait on another transaction while holding these.
 select * into j from public.jobs where id=e.job_id;
 if j.state<>'needs_reconciliation' or j.lease_token is not null or j.lease_expires_at is not null
  or j.cancel_requested_at is not null or to_jsonb(j)->>'project_deletion_requested_at' is not null
  or exists(select 1 from fluid_private.shared_logo_raster_recoveries where job_id=j.id) or j.billing_mode<>'openai_api' or j.attempts<>1
  or j.error_code is null or j.error_code not in('publication_unknown','provider_evidence_unconfirmed') then return null;end if;
 perform 1 from auth.users where id=e.owner_id for share nowait;if not found then return null;end if;
 perform 1 from fluid_private.shared_accounts where owner_id=e.owner_id for share nowait;if not found then return null;end if;
 select to_jsonb(project) into project_json from public.projects project where id=e.project_id and owner_id=e.owner_id for update nowait;
 if not found or fluid_private.shared_account_customer_active(e.owner_id) is distinct from true
  or project_json->>'deleted_at' is not null or project_json->>'deletion_requested_at' is not null then return null;end if;
 select * into a from fluid_private.shared_job_admissions where job_id=j.id;
 select * into q from public.logo_cost_quotes where id=(j.input->>'quoteId')::uuid and(owner_id,project_id,operation)=(e.owner_id,e.project_id,e.operation);
 if q.id is null or (a.owner_id,a.project_id,a.operation,a.input_hash,a.policy_identity,a.deployment_id,a.lane)
  is distinct from(e.owner_id,e.project_id,e.operation,j.input_hash,e.policy_identity,e.deployment_id,'logo'::text)
  or j.input->>'policyIdentity' is distinct from e.policy_identity or fluid_private.shared_logo_policy_valid(j.operation,a.policy) is distinct from true
  or q.record->>'inputHash' is distinct from j.input_hash then return null;end if;
 -- Qualify the frozen policy, never the current roster/model. Historical v2
 -- receipts remain recoverable after a deployment or uncapped-policy change.
 if j.input->'version'='3'::jsonb then
  if fluid_private.shared_logo_raster_job_matches(j,a.policy) is distinct from true then return null;end if;
 elsif j.input->'version'='2'::jsonb then
  policy.owner_id:=j.owner_id;policy.operation:=j.operation;policy.enabled:=true;
  policy.policy_identity:=a.policy->>'policyIdentity';policy.handler_version:=a.policy->>'handlerVersion';
  policy.provider:=a.policy->>'provider';policy.model:=a.policy->>'model';policy.engine:=nullif(a.policy->'engine','null');
  policy.max_cost_microusd:=(a.policy->>'maxCostMicrousd')::bigint;
  if fluid_private.logo_job_policy_matches(j,policy) is distinct from true then return null;end if;
 else return null;end if;
 if j.operation='identity.logo_refine' and (j.input#>>'{source,kind}' is distinct from 'preview'
  or q.record#>>'{request,operation}' is distinct from 'refine_preview') then return null;end if;
 step_key:=case j.operation when 'identity.logo_concept' then 'logo-preview-v1:'||(j.input->>'slotId')||':'||(j.input->>'attemptId') else 'generate-refinement' end;
 if j.plan_registered_at is null or j.plan_manifest is distinct from jsonb_build_array(jsonb_build_object('key',step_key,'maximumCostMicrousd',j.reserved_cost_microusd))
  or (select count(*) from public.job_steps where job_id=j.id)<>1
  or exists(select 1 from public.logo_raster_results where job_id=j.id) then return null;end if;
 select * into s from public.job_steps where job_id=j.id for update nowait;
 select * into provider from public.logo_provider_responses where job_id=j.id and(owner_id,project_id,lease_token)=(e.owner_id,e.project_id,e.lease_token);
 if (s.owner_id,s.project_id,s.step_key,s.state,s.reserved_cost_microusd) is distinct from(e.owner_id,e.project_id,step_key,'ambiguous'::text,j.reserved_cost_microusd)
  or s.completed_at is null or s.output is distinct from jsonb_build_object('error',j.error_code)
  or provider.id is null or fluid_private.shared_logo_raster_observation_valid(provider.observation) is distinct from true
  or provider.observation#>>'{billing,status}' is distinct from 'recorded'
  or provider.observation->>'providerRequestId' is null or provider.observation->>'responseHash' is null
  or provider.observation->>'artifactHash' is null or provider.observation->>'normalizedPixelHash' is null
  or s.provider_request_id is distinct from provider.observation->>'providerRequestId' then return null;end if;
 cost:=(provider.observation#>>'{billing,confirmedMicrousd}')::bigint;
 select * into usage from public.usage_reservations where job_id=j.id for update nowait;
 perform 1 from public.usage_accounts where owner_id=e.owner_id for update nowait;
 if not found or (j.actual_cost_microusd,s.actual_cost_microusd,usage.actual_microusd) is distinct from(cost,cost,cost)
  or (usage.owner_id,usage.project_id,usage.reserved_microusd,usage.state) is distinct from(e.owner_id,e.project_id,j.reserved_cost_microusd,'active'::text)
  or usage.captured_microusd is distinct from least(cost,j.reserved_cost_microusd) then return null;end if;
 previous:=jsonb_build_object('version',1,'executionId',e.execution_id,'providerResponseReceiptId',provider.id,
  'originalJob',jsonb_build_object('state',j.state,'reason',j.error_code),
  'originalStep',jsonb_build_object('state',s.state,'output',s.output,'completedAt',s.completed_at));
 select * into p from public.logo_asset_publications where job_id=j.id for update nowait;
 if not found then
  -- No publication or issued upload exists, and the original execution has
  -- lost all active/write authority. Delivery failed; the known charge remains.
  -- A later deliberate Generate may create new work, never an automatic retry.
  if exists(select 1 from fluid_private.shared_storage_grants where execution_id=e.execution_id and mode='write') then return null;end if;
  state:='failed';reason:='logo_image_unavailable';output:=jsonb_build_object('error',reason);
 else
  if (select count(*) from public.logo_asset_publications where job_id=j.id)<>1 then return null;end if;
  validation_job:=j;validation_job.lease_token:=e.lease_token;
  select o.verification into verification from fluid_private.shared_logo_output_observations o where o.execution_id=e.execution_id and o.reservation_id=p.id;
  if (p.owner_id,p.project_id,p.lease_token,p.state,p.content_hash) is distinct from(e.owner_id,e.project_id,e.lease_token,'staged'::text,provider.observation->>'artifactHash')
   or fluid_private.logo_generative_storage_member(validation_job,p,'write') is distinct from 'output'
   or verification is null or verification->>'status' is distinct from 'verified'
   or verification->>'contentHash' is distinct from p.content_hash or verification->>'mimeType' is distinct from p.mime_type
   or verification->'byteLength' is distinct from to_jsonb(p.byte_length)
   or verification-'checkedAt' is distinct from p.verification-'checkedAt'
   or not exists(select 1 from fluid_private.shared_storage_grants g where g.execution_id=e.execution_id and g.reservation_id=p.id and g.mode='write'
    and g.binding->'execution'=fluid_private.shared_worker_execution_json(e)) then return null;end if;
  previous:=previous||jsonb_build_object('publicationId',p.id,'readback',verification);
  if j.operation='identity.logo_concept' and exists(select 1 from public.logo_concept_attempts attempt
   join public.logo_concept_slots slot on slot.id=attempt.slot_id join public.logo_raster_results result on result.job_id=attempt.job_id
   join public.logo_provider_responses response on response.id=result.provider_response_receipt_id
   where slot.batch_id=(j.input->>'batchId')::uuid and attempt.owner_id=e.owner_id and attempt.project_id=e.project_id
    and response.observation->>'normalizedPixelHash'=provider.observation->>'normalizedPixelHash') then
   state:='failed';reason:='duplicate_preview';output:=jsonb_build_object('error',reason);
  else
   perform 1 from public.assets where id=p.asset_id for update nowait;if found then return null;end if;
   perform 1 from public.asset_versions where id=p.version_id for update nowait;if found then return null;end if;
   -- Bound unique/FK races too. Any lock contention rolls back every write.
   prior_timeout:=current_setting('lock_timeout');perform set_config('lock_timeout','1ms',true);
   receipt:=fluid_private.logo_commit_asset(p);
   insert into public.logo_raster_results(job_id,owner_id,project_id,preview,provider_response_receipt_id) values(j.id,e.owner_id,e.project_id,receipt,provider.id);
   output:=jsonb_build_object('version',2,'publicationId',p.id,'providerResponseReceiptId',provider.id)||case j.operation
    when 'identity.logo_concept' then jsonb_build_object('kind','logo_concept','batchId',j.input->'batchId','slotId',j.input->'slotId','attemptId',j.input->'attemptId')
    else jsonb_build_object('kind','logo_refinement_raster','rasterRevisionId',j.input->'rasterRevisionId') end;
  end if;
 end if;
 -- Usage was recorded before the interruption. Settle the original reservation
 -- without charging again or changing the provider's confirmed amount.
 perform fluid_private.settle_reservation(j.id);
 insert into fluid_private.shared_logo_raster_recoveries(job_id,execution_id,evidence)
  values(j.id,e.execution_id,previous||jsonb_build_object('stepId',s.id,'state',resolution.state,'reason',reason,'resolvedAt',clock_timestamp()));
 update public.job_steps set state=resolution.state,output=resolution.output,completed_at=clock_timestamp() where id=s.id;
 update public.jobs set state=resolution.state,error_code=reason,progress=case when resolution.state='succeeded' then 100 else progress end,
  finished_at=clock_timestamp() where id=j.id;
 if prior_timeout is not null then perform set_config('lock_timeout',prior_timeout,true);end if;
 return jsonb_build_object('status','terminal','state',state);
exception when lock_not_available then return null;
end $$;

-- Keep the gateway's existing authorization and response contract. The helper
-- runs only after its exact original execution enters observation context.
do $$declare definition text;body text;original text;replacement text;begin
 select prosrc into body from pg_proc where oid='fluid_private.shared_identity_previous_logo_gateway(jsonb,jsonb,text,jsonb)'::regprocedure;
 definition:=pg_get_functiondef('fluid_private.shared_identity_previous_logo_gateway(jsonb,jsonb,text,jsonb)'::regprocedure);
 original:=$needle$  if known_state='succeeded' and j.state='succeeded' then null;$needle$;
 replacement:=$replacement$  if e.operation in('identity.logo_concept','identity.logo_refine') then
   result:=fluid_private.shared_logo_resolve_raster();
   if result is not null then select * into j from public.jobs where id=e.job_id;known_state:=result->>'state';end if;
  end if;
  if known_state is not null and j.state=known_state then null;$replacement$;
 if (length(body)-length(replace(body,original,'')))/length(original)<>1 then raise exception 'raster_recovery_gateway_mismatch' using errcode='55000';end if;
 execute replace(definition,body,replace(body,original,replacement));
end $$;
do $$declare a record;begin
 revoke all on table fluid_private.shared_logo_raster_recoveries from public,anon,authenticated,service_role;
 for a in select distinct grantee from aclexplode((select relacl from pg_class where oid='fluid_private.shared_logo_raster_recoveries'::regclass)) where grantee not in(0,'postgres'::regrole::oid) loop
  execute format('revoke all on table fluid_private.shared_logo_raster_recoveries from %I',pg_get_userbyid(a.grantee));
 end loop;
 revoke all on function fluid_private.shared_logo_resolve_raster() from public,anon,authenticated,service_role;
 for a in select distinct grantee from aclexplode((select proacl from pg_proc where oid='fluid_private.shared_logo_resolve_raster()'::regprocedure)) where grantee not in(0,'postgres'::regrole::oid) loop
  execute format('revoke all on function fluid_private.shared_logo_resolve_raster() from %I',pg_get_userbyid(a.grantee));
 end loop;
end $$;
commit;
