-- UNAPPLIED OBSERVATION-ONLY CONTINUATION. No grants or live activation.
-- Prepared results/completion remain unavailable; observed expense is retained
-- independently because a runner cannot complete after losing its lease.
begin;

create table fluid_private.logo_vector_proposal_dispatches(
 job_id uuid primary key,owner_id uuid not null,project_id uuid not null,quote_id uuid not null,
 role_name name not null,role_oid oid not null,worker_id text not null check(length(worker_id) between 1 and 200),
 lease_token uuid not null,step_key text not null check(step_key='propose-vector-edit'),step_request_key text not null check(length(step_request_key) between 1 and 200),
 input jsonb not null,created_at timestamptz not null default clock_timestamp(),
 foreign key(job_id,owner_id,project_id) references public.jobs(id,owner_id,project_id),
 foreign key(quote_id,owner_id,project_id) references public.logo_cost_quotes(id,owner_id,project_id),
 foreign key(job_id,step_key) references public.job_steps(job_id,step_key),
 check((fluid_private.valid_logo_vector_proposal_job_input(input) and input->>'ownerId'=owner_id::text and input->>'projectId'=project_id::text and input->>'quoteId'=quote_id::text) is true)
);
alter table fluid_private.logo_vector_proposal_dispatches enable row level security;
alter table fluid_private.logo_vector_proposal_dispatches force row level security;
create trigger logo_vector_proposal_dispatches_immutable before update or delete on fluid_private.logo_vector_proposal_dispatches for each row execute function fluid_private.prevent_history_change();

create function fluid_private.valid_logo_vector_proposal_observation(o jsonb,p jsonb) returns boolean
language plpgsql immutable set search_path='' as $$
declare k text;v jsonb;u jsonb:=o->'usage';b jsonb:=o->'billing';cost numeric;
begin
 if fluid_private.standalone_keys(o,array['version','kind','provider','model','responseComplete','toolCalls','serviceTier','responseId','providerRequestId','responseHash','observedAt','textPolicy','usage','billing']) is distinct from true
  or octet_length(o::text)>32768 or o->'version' is distinct from '1'::jsonb or o->>'kind' is distinct from 'logo_vector_proposal_text' or o->>'provider' is distinct from 'openai'
  or jsonb_typeof(o->'responseComplete') is distinct from 'boolean' or o->'textPolicy' is distinct from p
  or fluid_private.valid_logo_vector_proposal_text_policy(p) is distinct from true or fluid_private.standalone_timestamp(o->'observedAt') is distinct from true then return false;end if;
 foreach k in array array['model','serviceTier','responseId','providerRequestId'] loop
  if o->k<>'null'::jsonb and fluid_private.standalone_text(o->k,case k when 'model' then 150 when 'serviceTier' then 100 else 200 end,1) is distinct from true then return false;end if;
 end loop;
 if o->'responseHash'<>'null'::jsonb and (jsonb_typeof(o->'responseHash') is distinct from 'string' or o->>'responseHash'!~'^[0-9a-f]{64}$') then return false;end if;
 v:=o->'toolCalls';if v<>'null'::jsonb and (jsonb_typeof(v) is distinct from 'number' or(v#>>'{}')::numeric not between 0 and 9007199254740991 or trunc((v#>>'{}')::numeric)<>(v#>>'{}')::numeric) then return false;end if;
 if u<>'null'::jsonb then
  if fluid_private.standalone_keys(u,array['inputTokens','cachedInputTokens','cacheWriteInputTokens','outputTokens']) is distinct from true then return false;end if;
  foreach k in array array['inputTokens','cachedInputTokens','cacheWriteInputTokens','outputTokens'] loop
   if jsonb_typeof(u->k) is distinct from 'number' or(u->>k)::numeric not between 0 and 9007199254740991 or trunc((u->>k)::numeric)<>(u->>k)::numeric then return false;end if;
  end loop;
  if(u->>'cachedInputTokens')::numeric+(u->>'cacheWriteInputTokens')::numeric>(u->>'inputTokens')::numeric then return false;end if;
 end if;
 if fluid_private.standalone_keys(b,array['status','confirmedMicrousd']) is distinct from true then return false;end if;
 if b->>'status'='unknown' then return b->'confirmedMicrousd'='null'::jsonb;end if;
 if b->>'status' is distinct from 'recorded' or jsonb_typeof(b->'confirmedMicrousd') is distinct from 'number'
  or(b->>'confirmedMicrousd')::numeric not between 0 and 9007199254740991 or trunc((b->>'confirmedMicrousd')::numeric)<>(b->>'confirmedMicrousd')::numeric
  or u='null'::jsonb or o->'model' is distinct from p->'model' or o->'serviceTier' is distinct from p->'serviceTier' or o->'toolCalls' is distinct from '0'::jsonb
  or(u->>'inputTokens')::numeric>272000 then return false;end if;
 -- This frozen card covers standard-context observed usage only. Larger
 -- anomalous responses retain usage with unknown billing, never a false rate.
 cost:=ceil((((u->>'inputTokens')::numeric-(u->>'cachedInputTokens')::numeric-(u->>'cacheWriteInputTokens')::numeric)*2000000
  +(u->>'cachedInputTokens')::numeric*100000+(u->>'cacheWriteInputTokens')::numeric*2500000+(u->>'outputTokens')::numeric*10000000)/1000000);
 return cost=(b->>'confirmedMicrousd')::numeric;
exception when others then return false;
end $$;

create function fluid_private.lock_logo_vector_proposal_dispatch(p_job uuid,p_lease uuid) returns public.jobs
language plpgsql set search_path='' as $$
declare owner uuid:=fluid_private.logo_worker_owner();j public.jobs;a fluid_private.logo_vector_proposal_dispatches;q public.logo_cost_quotes;s public.job_steps;
begin
 if owner is null then raise exception 'logo_worker_unauthorized' using errcode='42501';end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(owner::text,723902));
 select * into j from public.jobs where id=p_job and owner_id=owner for update;
 if not found or j.operation is distinct from 'identity.logo_vector_propose' then raise exception 'proposal_dispatch_unauthorized' using errcode='42501';end if;
 select * into a from fluid_private.logo_vector_proposal_dispatches where job_id=j.id and owner_id=j.owner_id and project_id=j.project_id;
 if not found then raise exception 'proposal_step_not_started' using errcode='55000';end if;
 if p_lease is null or a.lease_token is distinct from p_lease or a.role_name is distinct from session_user
  or a.role_oid is distinct from (select oid from pg_roles where rolname=session_user) or a.worker_id is distinct from j.worker_id or a.input is distinct from j.input or j.attempts<>1 then
  raise exception 'proposal_dispatch_unauthorized' using errcode='42501';end if;
 select * into q from public.logo_cost_quotes where id=a.quote_id and owner_id=j.owner_id and project_id=j.project_id;
 if fluid_private.logo_vector_proposal_job_quote_matches(j,q) is distinct from true then raise exception 'proposal_dispatch_binding_changed' using errcode='42501';end if;
 select * into s from public.job_steps where job_id=j.id and owner_id=j.owner_id and project_id=j.project_id and step_key=a.step_key;
 if not found or s.request_key is distinct from a.step_request_key or s.reserved_cost_microusd is distinct from j.reserved_cost_microusd then raise exception 'proposal_dispatch_binding_changed' using errcode='42501';end if;
 -- Current principal authority is checked above even for exact replay. Current
 -- lease/readiness/head freshness is not authority to erase a past response.
 return j;
end $$;

create function fluid_private.record_logo_vector_proposal_response(p_job uuid,p_lease uuid,o jsonb) returns jsonb
language plpgsql set search_path='' as $$
declare j public.jobs;r public.logo_provider_responses;s public.job_steps;reservation public.usage_reservations;account public.usage_accounts;
 cost bigint:=0;capture bigint:=0;accountable boolean:=false;reason text;
begin
 j:=fluid_private.lock_logo_vector_proposal_dispatch(p_job,p_lease);
 select * into r from public.logo_provider_responses where job_id=j.id and owner_id=j.owner_id and project_id=j.project_id;
 if found then
  if r.observation is distinct from o or r.lease_token is distinct from p_lease then raise exception 'provider_evidence_immutable' using errcode='PT409';end if;
  return jsonb_build_object('id',r.id,'ownerId',r.owner_id,'projectId',r.project_id,'jobId',r.job_id,'leaseToken',r.lease_token,'observation',r.observation);
 end if;
 select * into s from public.job_steps where job_id=j.id and step_key='propose-vector-edit' for update;
 if j.state not in('running','cancel_requested','needs_reconciliation') or s.state not in('in_flight','ambiguous') then raise exception 'proposal_evidence_window_closed' using errcode='55000';end if;
 if fluid_private.valid_logo_vector_proposal_observation(o,j.input->'textPolicy') is distinct from true or(o->>'observedAt')::timestamptz>clock_timestamp()+interval '1 minute' then raise exception 'invalid_provider_evidence' using errcode='22023';end if;
 insert into public.logo_provider_responses(owner_id,project_id,job_id,lease_token,observation) values(j.owner_id,j.project_id,j.id,p_lease,o) returning * into r;
 if o#>>'{billing,status}'='recorded' then
  cost:=(o#>>'{billing,confirmedMicrousd}')::bigint;
  select * into reservation from public.usage_reservations where job_id=j.id and owner_id=j.owner_id and project_id=j.project_id for update;
  select * into account from public.usage_accounts where owner_id=j.owner_id for update;
  capture:=least(j.reserved_cost_microusd,cost);
  accountable:=reservation.job_id is not null and account.owner_id is not null and reservation.state='active'
   and reservation.reserved_microusd=j.reserved_cost_microusd and reservation.actual_microusd=0 and reservation.captured_microusd=0 and j.actual_cost_microusd=0 and s.actual_cost_microusd=0
   and account.reserved_microusd>=reservation.reserved_microusd and account.spent_microusd::numeric+capture<=9007199254740991 and account.provider_actual_microusd::numeric+cost<=9007199254740991;
  if accountable then
   update public.usage_accounts set spent_microusd=spent_microusd+capture,provider_actual_microusd=provider_actual_microusd+cost,reserved_microusd=reserved_microusd-capture where owner_id=j.owner_id;
   update public.usage_reservations set actual_microusd=cost,captured_microusd=capture where job_id=j.id;
  else
   -- Preserve the independently observed bill even if corrupted/exhausted ledger
   -- capacity cannot be represented safely. Never clip, overflow or release it.
   reason:='provider_accounting_unconfirmed';
  end if;
  update public.jobs set actual_cost_microusd=cost where id=j.id;
  update public.job_steps set actual_cost_microusd=cost where id=s.id;
 else reason:='provider_billing_unknown';end if;
 if reason is null then
  if not(o->>'responseComplete')::boolean or o->'responseId'='null'::jsonb or o->'responseHash'='null'::jsonb then reason:='provider_evidence_incomplete';
  elsif(o#>>'{usage,inputTokens}')::numeric>(j.input#>>'{textPolicy,maxInputTokens}')::numeric or(o#>>'{usage,outputTokens}')::numeric>(j.input#>>'{textPolicy,maxOutputTokens}')::numeric or cost>j.reserved_cost_microusd then reason:='provider_usage_exceeded';
  elsif j.lease_token is distinct from p_lease or j.lease_expires_at is null or j.lease_expires_at<=clock_timestamp() then reason:='provider_response_after_lease';end if;
 end if;
 if reason is not null then update public.jobs set state='needs_reconciliation',lease_token=null,lease_expires_at=null,error_code=reason where id=j.id;end if;
 -- No step completion, settlement, asset, candidate or publication occurs here.
 return jsonb_build_object('id',r.id,'ownerId',r.owner_id,'projectId',r.project_id,'jobId',r.job_id,'leaseToken',r.lease_token,'observation',r.observation);
end $$;

-- Exact admission successor; preserve existing OID/owner/ACL/execution metadata.
do $patch$declare body text;definition text;begin
 select prosrc into body from pg_proc where oid='public.begin_logo_job_step(uuid,uuid,text,text,bigint)'::regprocedure;
 if encode(sha256(convert_to(body,'UTF8')),'hex') is distinct from 'c34641eb334906cc3f7f33cbef2fb5a00045970757c143bbb394d612ebdf43bf' then raise exception 'proposal_observation_predecessor_mismatch: public.begin_logo_job_step(uuid,uuid,text,text,bigint)' using errcode='55000';end if;
 definition:=pg_get_functiondef('public.begin_logo_job_step(uuid,uuid,text,text,bigint)'::regprocedure);execute replace(definition,body,$replacement$
declare j public.jobs;s public.job_steps;account public.usage_accounts;
begin
 if fluid_private.logo_worker_owner() is null then raise exception 'logo_worker_unauthorized' using errcode='42501';end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(fluid_private.logo_worker_owner()::text,723902));
 j:=fluid_private.logo_lock_job(p_job,p_lease);if j.state<>'running' then raise exception 'cancel_requested' using errcode='55000';end if;
 if not exists(select 1 from jsonb_array_elements(j.plan_manifest) m where m->>'key'=p_step and (m->>'maximumCostMicrousd')::bigint=p_cost) then raise exception 'plan_conflict' using errcode='40001';end if;
 select * into s from public.job_steps where job_id=j.id and step_key=p_step;
 if found then if s.state='succeeded' and s.request_key=p_key and s.reserved_cost_microusd=p_cost then return 'already_succeeded';end if;raise exception 'step_requires_reconciliation_or_new_job' using errcode='55000';end if;
 if j.operation='identity.logo_vector_propose' and (p_step is distinct from 'propose-vector-edit' or p_cost is distinct from j.reserved_cost_microusd or j.max_attempts<>1) then raise exception 'invalid_vector_proposal_step' using errcode='22023';end if;
 if j.operation='identity.logo_export' then
  if p_cost is distinct from 0 or j.reserved_cost_microusd<>0 or j.actual_cost_microusd<>0 or j.input ? 'quoteId' or p_step<>'prepare-export' or not exists(
   select 1 from fluid_private.logo_runtime_policies p where p.owner_id=j.owner_id and p.operation=j.operation and p.enabled and p.policy_identity=j.input->>'policyIdentity' and p.handler_version=j.input->>'handlerVersion' and p.handler_version='logo-export-v1' and p.provider is null and p.model is null and p.engine is null and p.max_cost_microusd=0) then raise exception 'logo_export_policy_revoked' using errcode='55000';end if;
  perform fluid_private.logo_export_input_revisions(j);
 elsif not exists(select 1 from public.logo_cost_quotes q join fluid_private.logo_runtime_policies p on p.owner_id=q.owner_id and p.operation=q.operation where q.id=(j.input->>'quoteId')::uuid and q.owner_id=j.owner_id and q.project_id=j.project_id and p.enabled and p.policy_identity=j.input->>'policyIdentity' and p.handler_version=j.input->>'handlerVersion') then raise exception 'logo_policy_revoked' using errcode='55000';end if;
 if not fluid_private.lock_logo_job_readiness(j,j.worker_id) then raise exception 'logo_runtime_unavailable' using errcode='55000';end if;
 if j.billing_mode='chatgpt_subscription' and (p_cost is distinct from 0 or octet_length(j.input::text)+(select octet_length(source::text) from public.logo_direction_inputs where job_id=j.id)>(j.input#>>'{policy,limits,maxInputBytes}')::integer) then raise exception 'invalid_subscription_cost_or_input' using errcode='22023';end if;
 if p_cost<0 or p_cost>j.reserved_cost_microusd-j.actual_cost_microusd or exists(select 1 from public.job_steps where job_id=j.id and state in ('in_flight','ambiguous','failed')) then raise exception 'unsafe_step' using errcode='55000';end if;
 -- Already claimed siblings must recheck the same aggregate reservation
 -- fence immediately before persisting a new paid dispatch boundary.
 if p_cost>0 then
  select * into account from public.usage_accounts where owner_id=j.owner_id for share;
  if not found or account.reserved_microusd>account.limit_microusd-greatest(account.spent_microusd,account.provider_actual_microusd) then raise exception 'budget_exceeded' using errcode='P0001';end if;
 end if;
 insert into public.job_steps(job_id,owner_id,project_id,step_key,request_key,state,reserved_cost_microusd) values(j.id,j.owner_id,j.project_id,p_step,p_key,'in_flight',p_cost);
 if j.operation='identity.logo_vector_propose' then
  insert into fluid_private.logo_vector_proposal_dispatches(job_id,owner_id,project_id,quote_id,role_name,role_oid,worker_id,lease_token,step_key,step_request_key,input)
   values(j.id,j.owner_id,j.project_id,(j.input->>'quoteId')::uuid,session_user,(select oid from pg_roles where rolname=session_user),j.worker_id,p_lease,p_step,p_key,j.input);
 end if;return 'started';
end $replacement$);
end $patch$;

-- Exact admission successor; preserve existing OID/owner/ACL/execution metadata.
do $patch$declare body text;definition text;begin
 select prosrc into body from pg_proc where oid='public.record_logo_provider_response(uuid,uuid,jsonb)'::regprocedure;
 if encode(sha256(convert_to(body,'UTF8')),'hex') is distinct from 'd7e9439a869200eca9a48c970127611b9b991f720520632d391eab9099fe4564' then raise exception 'proposal_observation_predecessor_mismatch: public.record_logo_provider_response(uuid,uuid,jsonb)' using errcode='55000';end if;
 definition:=pg_get_functiondef('public.record_logo_provider_response(uuid,uuid,jsonb)'::regprocedure);execute replace(definition,body,$replacement$
declare j public.jobs;q public.logo_cost_quotes;r public.logo_provider_responses;b jsonb;
begin
 if exists(select 1 from public.jobs where id=p_job and owner_id=fluid_private.logo_worker_owner() and operation='identity.logo_vector_propose') then return fluid_private.record_logo_vector_proposal_response(p_job,p_lease,p_observation);end if;
 j:=fluid_private.logo_lock_job(p_job,p_lease);select * into q from public.logo_cost_quotes where id=(j.input->>'quoteId')::uuid and owner_id=j.owner_id and project_id=j.project_id;
 if j.billing_mode='chatgpt_subscription' then
  if not fluid_private.logo_subscription_observation_valid(j,p_observation) or q.record->>'billingMode' is distinct from 'chatgpt_subscription' or q.record->'policy' is distinct from j.input->'policy' or q.record->>'policyIdentity' is distinct from j.policy_identity or q.record->'model' is distinct from p_observation->'model' or q.record->'provider' is distinct from p_observation->'provider' then raise exception 'invalid_provider_evidence' using errcode='22023';end if;
 else
 if not fluid_private.standalone_keys(p_observation-'normalizedPixelHash',array['provider','model','providerRequestId','responseHash','observedAt','billing','artifactHash']) or octet_length(p_observation::text)>32768 or p_observation->'provider' is distinct from q.record->'provider' or p_observation->'model' is distinct from q.record->'model' or q.record->'provider'='null' or not fluid_private.standalone_timestamp(p_observation->'observedAt') or (p_observation->>'observedAt')::timestamptz>clock_timestamp()+interval '1 minute' then raise exception 'invalid_provider_evidence' using errcode='22023';end if;
 if p_observation ? 'normalizedPixelHash' and (jsonb_typeof(p_observation->'normalizedPixelHash') is distinct from 'string' or p_observation->>'normalizedPixelHash' !~ '^[0-9a-f]{64}$') then raise exception 'invalid_pixel_evidence' using errcode='22023';end if;
 b:=p_observation->'billing';if not fluid_private.standalone_keys(b,array['status','confirmedMicrousd']) or ((b->>'status'='unknown' and b->'confirmedMicrousd'='null') or (b->>'status'='recorded' and jsonb_typeof(b->'confirmedMicrousd')='number' and (b->>'confirmedMicrousd')::numeric between 0 and 9007199254740991 and trunc((b->>'confirmedMicrousd')::numeric)=(b->>'confirmedMicrousd')::numeric)) is not true then raise exception 'invalid_billing_evidence' using errcode='22023';end if;

 if (p_observation->'providerRequestId'<>'null' and (jsonb_typeof(p_observation->'providerRequestId')<>'string' or length(p_observation->>'providerRequestId') not between 1 and 200)) or (p_observation->'artifactHash'<>'null' and (jsonb_typeof(p_observation->'artifactHash') is distinct from 'string' or (p_observation->>'artifactHash') !~ '^[0-9a-f]{64}$')) or (p_observation->'responseHash'<>'null' and (jsonb_typeof(p_observation->'responseHash') is distinct from 'string' or (p_observation->>'responseHash') !~ '^[0-9a-f]{64}$')) then raise exception 'invalid_provider_evidence' using errcode='22023';end if;
 end if;
 if not exists(select 1 from public.job_steps where job_id=j.id and state='in_flight') then raise exception 'provider_step_not_started' using errcode='55000';end if;
 select * into r from public.logo_provider_responses where job_id=j.id;
 if found then if r.observation is distinct from p_observation or r.lease_token<>p_lease then raise exception 'provider_evidence_immutable' using errcode='PT409';end if;
 else insert into public.logo_provider_responses(owner_id,project_id,job_id,lease_token,observation) values(j.owner_id,j.project_id,j.id,p_lease,p_observation) returning * into r;end if;
 return r.observation||jsonb_build_object('id',r.id,'ownerId',r.owner_id,'projectId',r.project_id,'jobId',r.job_id,'leaseToken',r.lease_token);
end $replacement$);
end $patch$;

-- Scrub only new objects, including hostile defaults. No grants are added.
do $$declare signature text;r record;object_id oid;begin
 foreach signature in array array['fluid_private.valid_logo_vector_proposal_observation(jsonb,jsonb)','fluid_private.lock_logo_vector_proposal_dispatch(uuid,uuid)','fluid_private.record_logo_vector_proposal_response(uuid,uuid,jsonb)'] loop
  object_id:=signature::regprocedure;
  for r in select distinct a.grantee from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where p.oid=object_id and a.grantee<>p.proowner loop
   execute format('revoke all on function %s from %s cascade',object_id::regprocedure,case when r.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(r.grantee)) end);
  end loop;
 end loop;
 object_id:='fluid_private.logo_vector_proposal_dispatches'::regclass;
 for r in select distinct a.grantee from pg_class c cross join lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a where c.oid=object_id and a.grantee<>c.relowner loop
  execute format('revoke all on table %s from %s cascade',object_id::regclass,case when r.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(r.grantee)) end);
 end loop;
end $$;
commit;
