-- Durable background observation, disabled by default and bound to one deployment.
-- Installing this migration does not enable the worker flag or admit any work.
-- Historical synchronous requests and unknown outcomes are never adopted.
begin;
create table fluid_private.api_text_background_rollout (
 singleton boolean primary key default true check(singleton), enabled boolean not null default false,
 deployment_id text check(deployment_id ~ '^dpl_[A-Za-z0-9_-]{1,196}$'),
 check(not enabled or deployment_id is not null)
);
insert into fluid_private.api_text_background_rollout(singleton) values(true);
create table fluid_private.api_text_background_profiles (
 job_id uuid primary key references fluid_private.api_text_dispatches(job_id),
 execution_profile text not null default 'background_v1' check(execution_profile='background_v1')
);
create table fluid_private.api_text_background_responses (
 job_id uuid primary key references fluid_private.api_text_background_profiles(job_id),
 step_key text not null check(step_key ~ '^[A-Za-z0-9._:-]{1,100}$'),
 dispatch_state text not null default 'not_dispatched' check(dispatch_state in ('not_dispatched','dispatching','accepted','rejected')),
 response_id text unique check(response_id ~ '^resp_[A-Za-z0-9_-]{1,194}$'),
 rejection_reason text check(rejection_reason in ('provider_rejected','observer_stopped','cancelled')),
 rejected_request_id text check(rejected_request_id ~ '^[A-Za-z0-9_-]{1,200}$'),
 terminal_response jsonb,
 created_at timestamptz not null default clock_timestamp(),
 execution_deadline_at timestamptz not null,
 observation_deadline_at timestamptz not null,
 check(execution_deadline_at=created_at+interval '240 seconds'),
 check(observation_deadline_at=created_at+interval '540 seconds'),
 check((dispatch_state='accepted')=(response_id is not null)),
 check(terminal_response is null or (response_id is not null and
   terminal_response#>>'{body,id}'=response_id and terminal_response#>>'{body,status}' in ('completed','failed','cancelled','incomplete') and
   octet_length(terminal_response::text)<=1050000))
);
alter table fluid_private.api_text_background_rollout enable row level security;
alter table fluid_private.api_text_background_rollout force row level security;
alter table fluid_private.api_text_background_profiles enable row level security;
alter table fluid_private.api_text_background_profiles force row level security;
alter table fluid_private.api_text_background_responses enable row level security;
alter table fluid_private.api_text_background_responses force row level security;
revoke all on fluid_private.api_text_background_rollout,fluid_private.api_text_background_profiles,fluid_private.api_text_background_responses from public,anon,authenticated,service_role;

create function fluid_private.freeze_api_text_background_profile() returns trigger language plpgsql set search_path='' as $$
begin
 if exists(select 1 from fluid_private.api_text_background_rollout where singleton and enabled and deployment_id=new.deployment_id) then
  insert into fluid_private.api_text_background_profiles(job_id) values(new.job_id);
 end if;
 return new;
end $$;
revoke all on function fluid_private.freeze_api_text_background_profile() from public,anon,authenticated,service_role;
create trigger api_text_background_admission after insert on fluid_private.api_text_dispatches
 for each row execute function fluid_private.freeze_api_text_background_profile();

create function fluid_private.api_text_background_action(p_job uuid,p_lease uuid,p_step text,p_action text,p_payload jsonb)
returns jsonb language plpgsql set search_path='' as $$
declare j public.jobs; r fluid_private.api_text_background_responses; t timestamptz; result jsonb; id text;
begin
 -- The existing public descriptor gateway owns authentication, role and owner
 -- binding. A direct call without its transaction-local context cannot operate.
 if not exists(select 1 from fluid_private.api_text_gateway_context g where g.backend_pid=pg_backend_pid()
  and g.transaction_id=txid_current() and g.job_id=p_job and g.owner_id=public.api_text_worker_owner()) then
  raise exception 'background_gateway_required' using errcode='42501'; end if;
 j:=fluid_private.lock_leased_job(p_job,p_lease);
 if not exists(select 1 from fluid_private.api_text_background_profiles where job_id=j.id)
  or not exists(select 1 from public.job_steps where job_id=j.id and step_key=p_step and state='in_flight') then
  raise exception 'background_profile_missing' using errcode='42501'; end if;
 select * into r from fluid_private.api_text_background_responses where job_id=j.id for update;
 if not found then
  if p_action<>'load' then raise exception 'background_journal_missing'; end if;
  t:=clock_timestamp();
  insert into fluid_private.api_text_background_responses(job_id,step_key,created_at,execution_deadline_at,observation_deadline_at)
   values(j.id,p_step,t,t+interval '240 seconds',t+interval '540 seconds') returning * into r;
 end if;
 if r.step_key is distinct from p_step then raise exception 'background_step_mismatch' using errcode='42501'; end if;
 if p_action='load' then
  if p_payload is distinct from 'null'::jsonb then raise exception 'invalid_background_payload'; end if;
  result:=jsonb_build_object('dispatchState',r.dispatch_state,'responseId',r.response_id,'terminalResponse',r.terminal_response,
   'cancelRequested',j.cancel_requested_at is not null,'executionDeadlineAt',floor(extract(epoch from r.execution_deadline_at)*1000),
   'observationDeadlineAt',floor(extract(epoch from r.observation_deadline_at)*1000));
  if r.rejection_reason is not null then result:=result||jsonb_build_object('rejectionReason',r.rejection_reason); end if;
 elsif p_action='begin' then
  if p_payload is distinct from 'null'::jsonb then raise exception 'invalid_background_payload'; end if;
  result:='false';
  if r.dispatch_state='not_dispatched' and j.cancel_requested_at is null and j.state='running' and clock_timestamp()<r.execution_deadline_at then
   if not exists(select 1 from fluid_private.api_text_dispatches d where d.job_id=j.id and
    public.authorize_api_text_dispatch(j.id,p_lease,p_step,d.policy_identity,d.deployment_id)) then raise exception 'background_dispatch_unavailable'; end if;
   update fluid_private.api_text_background_responses set dispatch_state='dispatching' where job_id=j.id;
   result:='true';
  end if;
 elsif p_action='handle' then
  id:=p_payload#>>'{}';
  if jsonb_typeof(p_payload)<>'string' or id !~ '^resp_[A-Za-z0-9_-]{1,194}$' then raise exception 'invalid_background_identity'; end if;
  if r.dispatch_state='accepted' and r.response_id=id then result:='true';
  elsif r.dispatch_state='dispatching' and r.response_id is null then
   update fluid_private.api_text_background_responses set dispatch_state='accepted',response_id=id where job_id=j.id;
   result:='true';
  else raise exception 'background_identity_conflict'; end if;
 elsif p_action='reject' then
  if jsonb_typeof(p_payload) is distinct from 'object' or (select count(*) from jsonb_object_keys(p_payload))<>2
   or not p_payload ?& array['requestId','reason'] or coalesce(p_payload->>'reason','') not in ('provider_rejected','observer_stopped','cancelled')
   or (p_payload->'requestId'<>'null'::jsonb and (jsonb_typeof(p_payload->'requestId')<>'string' or p_payload->>'requestId' !~ '^[A-Za-z0-9_-]{1,200}$')) then raise exception 'invalid_background_rejection'; end if;
  if r.dispatch_state='rejected' and r.rejection_reason=p_payload->>'reason' and r.rejected_request_id is not distinct from p_payload->>'requestId' then result:='true';
  elsif r.dispatch_state='dispatching' and r.response_id is null then
   update fluid_private.api_text_background_responses set dispatch_state='rejected',rejection_reason=p_payload->>'reason',rejected_request_id=p_payload->>'requestId' where job_id=j.id;
   result:='true';
  else raise exception 'background_rejection_conflict'; end if;
 elsif p_action='terminal' then
  if jsonb_typeof(p_payload) is distinct from 'object' or (select count(*) from jsonb_object_keys(p_payload))<>2
   or not p_payload ?& array['body','requestId'] or jsonb_typeof(p_payload->'body') is distinct from 'object'
   or p_payload#>>'{body,id}' is distinct from r.response_id or r.dispatch_state<>'accepted'
   or coalesce(p_payload#>>'{body,status}','') not in ('completed','failed','cancelled','incomplete') or octet_length(p_payload::text)>1050000
   or (p_payload->'requestId'<>'null'::jsonb and (jsonb_typeof(p_payload->'requestId')<>'string' or p_payload->>'requestId' !~ '^[A-Za-z0-9_-]{1,200}$')) then raise exception 'invalid_background_terminal'; end if;
  if r.terminal_response is null then
   update fluid_private.api_text_background_responses set terminal_response=p_payload where job_id=j.id;
  elsif r.terminal_response->'body' is distinct from p_payload->'body' then raise exception 'background_terminal_conflict'; end if;
  result:='true';
 else raise exception 'invalid_background_action'; end if;
 return jsonb_build_object('jobId',j.id,'stepKey',p_step,'value',result);
end $$;
revoke all on function fluid_private.api_text_background_action(uuid,uuid,text,text,jsonb) from public,anon,authenticated,service_role;

-- Observation ownership changes only leases, never attempts, request keys,
-- stored provider identities, terminal steps or financial amounts.
create function fluid_private.api_text_background_control(p_job uuid,p_action text,p_payload jsonb)
returns jsonb language plpgsql set search_path='' as $$
declare j public.jobs; d fluid_private.api_text_dispatches; o uuid:=public.api_text_worker_owner(); worker text;
begin
 if o is null or not exists(select 1 from fluid_private.api_text_gateway_context g where g.backend_pid=pg_backend_pid()
  and g.transaction_id=txid_current() and g.job_id=p_job and g.owner_id=o) then raise exception 'background_gateway_required' using errcode='42501'; end if;
 if p_action='profile' then return to_jsonb(exists(select 1 from fluid_private.api_text_background_profiles where job_id=p_job)); end if;
 perform fluid_private.lock_strategy_owner(o);
 select * into j from public.jobs where id=p_job and owner_id=o and billing_mode='openai_api' for update;
 if not found or not exists(select 1 from fluid_private.api_text_background_profiles where job_id=p_job) then raise exception 'background_profile_missing'; end if;
 select * into strict d from fluid_private.api_text_dispatches where job_id=j.id and owner_id=o;
 if p_action='claim' then
  worker:=p_payload#>>'{}';
  if jsonb_typeof(p_payload) is distinct from 'string' or length(worker) not between 1 and 100 then raise exception 'invalid_background_worker'; end if;
  if j.state='queued' then return public.claim_api_text_job(j.id,worker,60,d.policy_identity,d.deployment_id); end if;
  if j.state not in ('running','cancel_requested') then return jsonb_build_object('disposition','terminal','state',j.state); end if;
  if j.lease_expires_at>clock_timestamp() then return jsonb_build_object('disposition','busy','state',j.state); end if;
  -- Frozen profiles can only be created at admission. Existing synchronous
  -- requests cannot enter this recovery path, including historical unknowns.
  update public.jobs set lease_token=gen_random_uuid(),lease_expires_at=clock_timestamp()+interval '60 seconds',worker_id=worker where id=j.id returning * into j;
  return jsonb_build_object('disposition','claimed','state',j.state,'job',to_jsonb(j));
 elsif p_action='redrive' then
  if jsonb_typeof(p_payload) is distinct from 'number' or p_payload::text !~ '^[0-9]{1,10}$'
    or p_payload::numeric>2147483646 then raise exception 'invalid_background_generation'; end if;
  if j.state not in ('running','cancel_requested') or j.lease_expires_at>clock_timestamp() then return null; end if;
  select * into strict d from fluid_private.api_text_dispatches where job_id=j.id and owner_id=o for update;
  if d.publication_generation is distinct from p_payload::text::integer
    or d.generation_started_at>clock_timestamp()-interval '30 seconds'
    or not exists(select 1 from fluid_private.api_text_background_responses r
      join public.job_steps s on s.job_id=r.job_id and s.step_key=r.step_key
      where r.job_id=j.id and r.dispatch_state='accepted' and r.response_id is not null and s.state='in_flight'
        and (r.terminal_response is not null or r.observation_deadline_at>clock_timestamp()))
    or exists(select 1 from public.job_steps where job_id=j.id and state='ambiguous') then return null; end if;
  update fluid_private.api_text_dispatches set publication_generation=publication_generation+1,
    generation_started_at=clock_timestamp(),published_at=null,published_message_id=null
    where job_id=j.id returning * into d;
  -- This permission is for observing the frozen response, not inference.
  return fluid_private.api_text_descriptor(j,d)||jsonb_build_object('retryable',true);
 elsif p_action='yield' then
  j:=fluid_private.lock_leased_job(p_job,(p_payload#>>'{}')::uuid);
  update public.jobs set lease_expires_at=clock_timestamp() where id=j.id;
  return 'true';
 else raise exception 'invalid_background_control'; end if;
end $$;
revoke all on function fluid_private.api_text_background_control(uuid,text,jsonb) from public,anon,authenticated,service_role;

-- A known background response remains observable after its observer lease
-- expires. Generic maintenance must not turn that recoverable state into an
-- unknown synchronous outcome. The original observation deadline is unchanged;
-- a persisted terminal body remains locally settleable after that deadline.
do $$
declare original oid:='public.expire_api_text_job(uuid)'::regprocedure; definition text; original_acl aclitem[];
 anchor text:=' if exists(select 1 from public.job_steps where job_id=j.id and state in (''in_flight'',''ambiguous'')) then v_next:=''needs_reconciliation'';';
begin
 select proacl into original_acl from pg_proc where oid=original;
 if not exists(select 1 from pg_proc where oid=original and md5(prosrc)='846443c8769c7a570a0a0f97a06fad03'
  and prosecdef and proconfig=array['search_path=""']) then raise exception 'unexpected_background_expiry_predecessor'; end if;
 definition:=pg_get_functiondef(original);
 if (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 then raise exception 'unexpected_background_expiry_anchor'; end if;
 definition:=replace(definition,anchor,$patch$
 if exists(select 1 from fluid_private.api_text_background_responses r
   join fluid_private.api_text_background_profiles p on p.job_id=r.job_id
   join public.job_steps s on s.job_id=r.job_id and s.step_key=r.step_key
   where r.job_id=j.id and r.dispatch_state='accepted' and r.response_id is not null
     and s.state='in_flight' and (r.terminal_response is not null or r.observation_deadline_at>clock_timestamp()))
   and not exists(select 1 from public.job_steps where job_id=j.id and state='ambiguous') then
  return jsonb_build_object('disposition','available','state',j.state);
 end if;
$patch$||anchor);
 execute definition;
 if not exists(select 1 from pg_proc where oid=original and proacl is not distinct from original_acl
  and prosecdef and proconfig=array['search_path=""']) then raise exception 'background_expiry_security_changed'; end if;
end $$;

-- Extend only the existing authenticated gateway, preserving its OID and ACL.
do $$
declare original oid:='public.api_text_dispatch_action(jsonb,text,jsonb)'::regprocedure; definition text; original_acl aclitem[];
 a text:='when ''has_results'' then 2 else null end;';
 b text:=E'\n case p_action\n';
begin
 select proacl into original_acl from pg_proc where oid=original;
 definition:=pg_get_functiondef(original);
 if (length(definition)-length(replace(definition,a,'')))/length(a)<>1 or (length(definition)-length(replace(definition,b,'')))/length(b)<>1 then raise exception 'unexpected_background_gateway_predecessor'; end if;
 definition:=replace(definition,a,'when ''has_results'' then 2 when ''background'' then 4 when ''background_control'' then 2 else null end;');
 definition:=replace(definition,b,b|| E'\n when ''background_control'' then v_result:=fluid_private.api_text_background_control(v_job,p_arguments->>0,p_arguments->1);\n when ''background'' then v_result:=fluid_private.api_text_background_action(v_job,(p_arguments->>0)::uuid,p_arguments->>1,p_arguments->>2,p_arguments->3);');
 execute definition;
 if not exists(select 1 from pg_proc where oid=original and proacl is not distinct from original_acl and prosecdef and proconfig=array['search_path=""']) then raise exception 'background_gateway_security_changed'; end if;
end $$;
-- Remove inherited defaults from the new private inventory as well as PUBLIC.
-- The existing public gateway keeps its original ACL unchanged.
do $$ declare obj record; access record; begin
 for obj in select oid,proowner from pg_proc where oid in (
  'fluid_private.freeze_api_text_background_profile()'::regprocedure,
  'fluid_private.api_text_background_action(uuid,uuid,text,text,jsonb)'::regprocedure,
  'fluid_private.api_text_background_control(uuid,text,jsonb)'::regprocedure) loop
  for access in select distinct a.grantee,r.rolname from pg_proc p
   cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
   left join pg_roles r on r.oid=a.grantee where p.oid=obj.oid and a.grantee<>obj.proowner loop
   execute 'revoke all on function '||obj.oid::regprocedure::text||' from '||case when access.grantee=0 then 'PUBLIC' else quote_ident(access.rolname) end;
  end loop;
 end loop;
 for obj in select oid,relowner from pg_class where oid in (
  'fluid_private.api_text_background_rollout'::regclass,
  'fluid_private.api_text_background_profiles'::regclass,
  'fluid_private.api_text_background_responses'::regclass) loop
  for access in select distinct a.grantee,r.rolname from pg_class c
   cross join lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
   left join pg_roles r on r.oid=a.grantee where c.oid=obj.oid and a.grantee<>obj.relowner loop
   execute 'revoke all on table '||obj.oid::regclass::text||' from '||case when access.grantee=0 then 'PUBLIC' else quote_ident(access.rolname) end;
  end loop;
 end loop;
end $$;
commit;
