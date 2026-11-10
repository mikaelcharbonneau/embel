-- Review candidate only. No project, role, credential, policy, budget or live grant
-- is created. Worker RPC execute grants and an enabled owner runtime row require
-- separately reviewed activation. Depends on the installed subscription/Naming core.
begin;

create table fluid_private.standalone_names_runtime (
  owner_id uuid primary key references auth.users(id) on delete cascade,
  enabled boolean not null default false,
  ready_policy jsonb,
  worker_ready_until timestamptz
);
create table public.standalone_name_jobs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  request_key text not null,
  intent jsonb not null,
  brief jsonb not null,
  refinement jsonb,
  depth integer not null check(depth between 0 and 5),
  policy jsonb not null,
  state text not null default 'queued' check(state in('queued','running','cancel_requested','cancelled','succeeded','failed','needs_reconciliation')),
  error_code text,
  created_at timestamptz not null default clock_timestamp(),
  finished_at timestamptz,
  lease_token uuid,
  lease_expires_at timestamptz,
  dispatched_at timestamptz,
  partial_text text not null default '',
  result jsonb,
  liked_indexes jsonb not null default '[]',
  saved_indexes jsonb not null default '[]',
  unique(owner_id,request_key),
  check((state='succeeded')=(result is not null))
);
create index standalone_name_jobs_owner_order on public.standalone_name_jobs(owner_id,created_at desc,id desc);

create function fluid_private.standalone_names_keys(p_value jsonb,p_keys text[]) returns boolean
language sql immutable set search_path='' as $$
 select p_value is not null and jsonb_typeof(p_value)='object' and p_value-array(select unnest(p_keys))='{}'::jsonb
   and (select count(*) from jsonb_object_keys(p_value))=cardinality(p_keys);
$$;
create function fluid_private.standalone_names_text(p_value jsonb,p_min integer,p_max integer) returns boolean
language sql immutable set search_path='' as $$
 select p_value is not null and jsonb_typeof(p_value)='string' and length(btrim(p_value#>>'{}')) between p_min and p_max;
$$;
create function fluid_private.standalone_names_dto(j public.standalone_name_jobs) returns jsonb
language sql stable set search_path='' as $$
 select jsonb_build_object('id',j.id,'ownerId',j.owner_id,'brief',j.brief,'refinement',j.refinement,'depth',j.depth,'state',j.state,
  'errorCode',j.error_code,'createdAt',j.created_at,'finishedAt',j.finished_at,'result',j.result,'likedIndexes',j.liked_indexes,'savedIndexes',j.saved_indexes);
$$;
create function fluid_private.standalone_names_immutable() returns trigger
language plpgsql set search_path='' as $$
begin
 if (new.id,new.owner_id,new.request_key,new.intent,new.brief,new.refinement,new.depth,new.policy,new.created_at)
  is distinct from(old.id,old.owner_id,old.request_key,old.intent,old.brief,old.refinement,old.depth,old.policy,old.created_at)
  or (old.result is not null and new.result is distinct from old.result)
  or (old.state in('succeeded','failed','cancelled','needs_reconciliation') and (new.state,new.finished_at,new.error_code,new.partial_text) is distinct from(old.state,old.finished_at,old.error_code,old.partial_text)) then
  raise exception 'immutable_standalone_names' using errcode='55000';
 end if;
 return new;
end $$;
create trigger standalone_names_immutable before update on public.standalone_name_jobs for each row execute function fluid_private.standalone_names_immutable();

create function fluid_private.standalone_names_availability(p_owner uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare p fluid_private.subscription_runtime_policy; r fluid_private.standalone_names_runtime; hourly bigint; pending bigint;
begin
 select * into r from fluid_private.standalone_names_runtime where owner_id=p_owner and enabled;
 select * into p from fluid_private.subscription_runtime_policy where owner_id=p_owner and operation='naming.generate' and enabled;
 if r.owner_id is null or p.owner_id is null then return jsonb_build_object('status','unavailable','reason','setup_required');end if;
 if p.worker_ready_until is null or p.worker_ready_until<=clock_timestamp() or r.worker_ready_until is null or r.worker_ready_until<=clock_timestamp() or r.ready_policy is distinct from p.policy then
  return jsonb_build_object('status','unavailable','reason','worker_unavailable');end if;
 select count(*) filter(where created_at>clock_timestamp()-interval '1 hour'),count(*) filter(where state in('queued','running','cancel_requested')) into hourly,pending
 from(select created_at,state from public.jobs where owner_id=p_owner and billing_mode='chatgpt_subscription'
  union all select created_at,state from public.standalone_name_jobs where owner_id=p_owner) all_jobs;
 if hourly>=(p.policy#>>'{limits,maxRequestsPerHour}')::integer or pending>=(p.policy#>>'{limits,maxQueuedJobs}')::integer then
  return jsonb_build_object('status','unavailable','reason','quota_unavailable');end if;
 return jsonb_build_object('status','available','billingMode','chatgpt_subscription','policyIdentity',encode(sha256(convert_to(p.policy::text,'UTF8')),'hex'),
  'model',p.policy->>'model','maxNames',20,'maxRequestsPerHour',(p.policy#>>'{limits,maxRequestsPerHour}')::integer,'deadlineMs',(p.policy#>>'{limits,deadlineMs}')::integer);
end $$;

-- Existing subscription admissions use this same owner lock. The additive
-- trigger prevents later project admissions bypassing standalone usage counts.
create function fluid_private.standalone_names_shared_quota() returns trigger
language plpgsql security definer set search_path='' as $$
declare hourly bigint; pending bigint;
begin
 if new.billing_mode<>'chatgpt_subscription' then return new;end if;
 perform pg_advisory_xact_lock(hashtextextended(new.owner_id::text,723902));
 if not exists(select 1 from public.standalone_name_jobs where owner_id=new.owner_id) then return new;end if;
 select count(*) filter(where created_at>clock_timestamp()-interval '1 hour'),count(*) filter(where state in('queued','running','cancel_requested')) into hourly,pending
 from(select created_at,state from public.jobs where owner_id=new.owner_id and billing_mode='chatgpt_subscription'
  union all select created_at,state from public.standalone_name_jobs where owner_id=new.owner_id) all_jobs;
 if hourly>=(new.input#>>'{policy,limits,maxRequestsPerHour}')::integer or pending>=(new.input#>>'{policy,limits,maxQueuedJobs}')::integer then
  raise exception 'quota_unavailable' using errcode='P0001';end if;
 return new;
end $$;
create trigger standalone_names_shared_quota before insert on public.jobs for each row execute function fluid_private.standalone_names_shared_quota();

create function public.get_standalone_names(p_before timestamptz default null,p_before_id uuid default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare owner uuid:=auth.uid(); entries jsonb; more boolean;
begin
 if owner is null then raise exception 'unauthenticated' using errcode='42501';end if;
 if (p_before is null)<>(p_before_id is null) then raise exception 'invalid_cursor' using errcode='22023';end if;
 select coalesce(jsonb_agg(fluid_private.standalone_names_dto(j) order by j.created_at desc,j.id desc),'[]') into entries
 from(select * from public.standalone_name_jobs where owner_id=owner and(p_before is null or(created_at,id)<(p_before,p_before_id)) order by created_at desc,id desc limit 50) j;
 select count(*)>50 into more from(select id from public.standalone_name_jobs where owner_id=owner and(p_before is null or(created_at,id)<(p_before,p_before_id)) limit 51) x;
 return jsonb_build_object('ownerId',owner,'availability',fluid_private.standalone_names_availability(owner),'jobs',entries,'hasMore',more);
end $$;
create function public.get_standalone_name_job(p_job uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare j public.standalone_name_jobs;
begin
 if auth.uid() is null then raise exception 'unauthenticated' using errcode='42501';end if;
 select * into j from public.standalone_name_jobs where id=p_job and owner_id=auth.uid();
 if not found then raise exception 'not_found' using errcode='P0002';end if;
 return jsonb_build_object('job',fluid_private.standalone_names_dto(j));
end $$;

create function public.enqueue_standalone_names(p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare owner uuid:=auth.uid(); j public.standalone_name_jobs; source public.standalone_name_jobs; p fluid_private.subscription_runtime_policy;
 brief jsonb; refinement jsonb; source_names jsonb:='[]'; choice jsonb; i integer; depth integer:=0; availability jsonb;
begin
 if owner is null then raise exception 'unauthenticated' using errcode='42501';end if;
 if not fluid_private.standalone_names_keys(p_input,array['brief','refinement','idempotencyKey','acceptedPolicyIdentity','acceptSubscriptionUsage'])
  or octet_length(p_input::text)>24576 or p_input->'acceptSubscriptionUsage' is distinct from 'true'::jsonb
  or not fluid_private.standalone_names_text(p_input->'idempotencyKey',16,128) or p_input->>'idempotencyKey'!~'^[A-Za-z0-9._:-]{16,128}$'
  or not fluid_private.standalone_names_text(p_input->'acceptedPolicyIdentity',64,64) or p_input->>'acceptedPolicyIdentity'!~'^[0-9a-f]{64}$' then raise exception 'invalid_input' using errcode='22023';end if;
 brief:=p_input->'brief';refinement:=nullif(p_input->'refinement','null'::jsonb);
 if not fluid_private.standalone_names_keys(brief,array['description','direction','language'])
  or not fluid_private.standalone_names_text(brief->'description',1,3000) or not fluid_private.standalone_names_text(brief->'direction',0,1000)
  or not fluid_private.standalone_names_text(brief->'language',1,80) then raise exception 'invalid_brief' using errcode='22023';end if;
 perform pg_advisory_xact_lock(hashtextextended(owner::text,723902));
 select * into j from public.standalone_name_jobs where owner_id=owner and request_key=p_input->>'idempotencyKey';
 if found then
  if j.intent<>p_input then raise exception 'idempotency_conflict' using errcode='PT409';end if;
  return jsonb_build_object('job',fluid_private.standalone_names_dto(j));
 end if;
 if exists(select 1 from public.standalone_name_jobs where owner_id=owner and state in('queued','running','cancel_requested')) then raise exception 'standalone_names_active' using errcode='PT409';end if;
 if refinement is not null then
  if not fluid_private.standalone_names_keys(refinement,array['sourceJobId','candidateIndexes','instruction'])
   or not fluid_private.standalone_names_text(refinement->'instruction',1,1000) or jsonb_typeof(refinement->'candidateIndexes') is distinct from 'array'
   or jsonb_array_length(refinement->'candidateIndexes') not between 1 and 5 or not fluid_private.standalone_names_text(refinement->'sourceJobId',36,36) then raise exception 'invalid_refinement' using errcode='22023';end if;
  select * into source from public.standalone_name_jobs where id=(p_input->'refinement'->>'sourceJobId')::uuid and owner_id=owner and state='succeeded';
  if not found then raise exception 'not_found' using errcode='P0002';end if;
  if source.depth>=5 then raise exception 'refinement_limit' using errcode='PT409';end if;
  if source.brief<>brief then raise exception 'refinement_brief_changed' using errcode='PT409';end if;
  if(select count(*)<>count(distinct value) from jsonb_array_elements(refinement->'candidateIndexes')) then raise exception 'invalid_refinement' using errcode='22023';end if;
  for choice in select value from jsonb_array_elements(refinement->'candidateIndexes') loop
   if jsonb_typeof(choice)<>'number' or choice::text!~'^[0-9]+$' or choice::numeric not between 0 and 19 then raise exception 'invalid_refinement' using errcode='22023';end if;
   i:=choice::integer;
   if source.result->'candidates'->i is null then raise exception 'invalid_refinement' using errcode='22023';end if;
   source_names:=source_names||jsonb_build_array(source.result->'candidates'->i->>'value');
  end loop;
  refinement:=refinement||jsonb_build_object('sourceNames',source_names);depth:=source.depth+1;
 end if;
 -- Freeze the policy before checking consent: a concurrent model change must
 -- never replace the policy the user accepted between validation and insertion.
 select * into p from fluid_private.subscription_runtime_policy where owner_id=owner and operation='naming.generate' for share;
 if not found then raise exception 'runtime_unavailable' using errcode='P0001';end if;
 availability:=fluid_private.standalone_names_availability(owner);
 if availability->>'status'<>'available' then raise exception 'runtime_unavailable' using errcode='P0001';end if;
 if encode(sha256(convert_to(p.policy::text,'UTF8')),'hex')<>p_input->>'acceptedPolicyIdentity' then raise exception 'policy_changed' using errcode='PT409';end if;
 -- Account history is bounded without deleting earlier work.
 if(select count(*) from public.standalone_name_jobs where owner_id=owner)>=500 then raise exception 'history_capacity' using errcode='PT409';end if;
 insert into public.standalone_name_jobs(owner_id,request_key,intent,brief,refinement,depth,policy)
 values(owner,p_input->>'idempotencyKey',p_input,brief,refinement,depth,p.policy) returning * into j;
 return jsonb_build_object('job',fluid_private.standalone_names_dto(j));
end $$;

create function public.cancel_standalone_names(p_job uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare j public.standalone_name_jobs;
begin
 if auth.uid() is null then raise exception 'unauthenticated' using errcode='42501';end if;
 select * into j from public.standalone_name_jobs where id=p_job and owner_id=auth.uid() for update;
 if not found then raise exception 'not_found' using errcode='P0002';end if;
 if j.state in('queued','running') then
  update public.standalone_name_jobs set state=case when state='queued' then 'cancelled' else 'cancel_requested' end,
   finished_at=case when state='queued' then clock_timestamp() else null end where id=j.id returning * into j;
 end if;
 return jsonb_build_object('job',fluid_private.standalone_names_dto(j));
end $$;
create function public.retain_standalone_name(p_job uuid,p_index integer,p_liked boolean,p_saved boolean) returns jsonb
language plpgsql security definer set search_path='' as $$
declare j public.standalone_name_jobs;
begin
 if auth.uid() is null then raise exception 'unauthenticated' using errcode='42501';end if;
 select * into j from public.standalone_name_jobs where id=p_job and owner_id=auth.uid() for update;
 if not found then raise exception 'not_found' using errcode='P0002';end if;
 if p_index is null or p_index not between 0 and 19 or p_liked is null or p_saved is null or j.result->'candidates'->p_index is null then raise exception 'invalid_name' using errcode='22023';end if;
 select coalesce(jsonb_agg(value order by value),'[]') into j.liked_indexes from(select value from jsonb_array_elements(j.liked_indexes) where value<>to_jsonb(p_index) union select to_jsonb(p_index) where p_liked) x;
 select coalesce(jsonb_agg(value order by value),'[]') into j.saved_indexes from(select value from jsonb_array_elements(j.saved_indexes) where value<>to_jsonb(p_index) union select to_jsonb(p_index) where p_saved) x;
 update public.standalone_name_jobs set liked_indexes=j.liked_indexes,saved_indexes=j.saved_indexes where id=j.id returning * into j;
 return jsonb_build_object('job',fluid_private.standalone_names_dto(j));
end $$;

create function public.report_standalone_names_ready(p_policy jsonb) returns boolean
language plpgsql security definer set search_path='' as $$
declare owner uuid:=public.subscription_worker_owner();
begin
 if owner is null then raise exception 'worker_owner_mismatch' using errcode='42501';end if;
 if not exists(select 1 from fluid_private.subscription_runtime_policy where owner_id=owner and operation='naming.generate' and enabled and policy=p_policy and worker_ready_until>clock_timestamp())
  or(p_policy#>>'{limits,maxInputBytes}')::integer>131072 or(p_policy#>>'{limits,maxOutputBytes}')::integer>262144 or(p_policy#>>'{limits,deadlineMs}')::integer>240000 then return false;end if;
 update fluid_private.standalone_names_runtime set ready_policy=p_policy,worker_ready_until=clock_timestamp()+interval '60 seconds' where owner_id=owner and enabled;
 return found;
end $$;
create function public.claim_standalone_names(p_policy jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare owner uuid:=public.subscription_worker_owner(); j public.standalone_name_jobs;
begin
 if owner is null then raise exception 'worker_owner_mismatch' using errcode='42501';end if;
 perform pg_advisory_xact_lock(hashtextextended(owner::text,723902));
 update public.standalone_name_jobs set state=case when dispatched_at is null then 'failed' else 'needs_reconciliation' end,error_code='lease_expired',finished_at=clock_timestamp(),lease_token=null,lease_expires_at=null
  where owner_id=owner and state in('running','cancel_requested') and lease_expires_at<=clock_timestamp();
 -- Null policy is maintenance only: disconnected workers can quarantine an
 -- expired attempt without selecting, cancelling or dispatching queued work.
 if p_policy is null then return null;end if;
 update public.standalone_name_jobs set state='cancelled',error_code='policy_changed',finished_at=clock_timestamp()
  where owner_id=owner and state='queued' and policy<>p_policy;
 if not public.report_standalone_names_ready(p_policy) then return null;end if;
 select * into j from public.standalone_name_jobs where owner_id=owner and state='queued' and policy=p_policy order by created_at,id for update skip locked limit 1;
 if not found then return null;end if;
 update public.standalone_name_jobs set state='running',lease_token=gen_random_uuid(),lease_expires_at=clock_timestamp()+interval '60 seconds' where id=j.id returning * into j;
 return jsonb_build_object('job',fluid_private.standalone_names_dto(j),'leaseToken',j.lease_token,'policy',j.policy);
end $$;
create function public.pulse_standalone_names(p_job uuid,p_lease uuid,p_begin boolean,p_partial text default null) returns text
language plpgsql security definer set search_path='' as $$
declare owner uuid:=public.subscription_worker_owner(); j public.standalone_name_jobs;
begin
 if owner is null then raise exception 'worker_owner_mismatch' using errcode='42501';end if;
 select * into j from public.standalone_name_jobs where id=p_job and owner_id=owner for update;
 if not found or j.lease_token is distinct from p_lease or j.lease_expires_at<=clock_timestamp() or j.state not in('running','cancel_requested') then raise exception 'lease_lost' using errcode='PT409';end if;
 if not public.report_standalone_names_ready(j.policy) then j.state:='cancel_requested';end if;
 if p_begin is null or(p_begin and j.dispatched_at is not null) then raise exception 'dispatch_already_started' using errcode='PT409';end if;
 if p_partial is not null and(octet_length(p_partial)>(j.policy#>>'{limits,maxOutputBytes}')::integer or left(p_partial,length(j.partial_text))<>j.partial_text) then raise exception 'invalid_partial' using errcode='22023';end if;
 update public.standalone_name_jobs set state=j.state,lease_expires_at=clock_timestamp()+interval '60 seconds',
  dispatched_at=case when p_begin and j.state='running' then clock_timestamp() else dispatched_at end,partial_text=coalesce(p_partial,partial_text) where id=j.id;
 return j.state;
end $$;
create function public.finish_standalone_names(p_job uuid,p_lease uuid,p_state text,p_result jsonb,p_partial text,p_error text) returns boolean
language plpgsql security definer set search_path='' as $$
declare owner uuid:=public.subscription_worker_owner(); j public.standalone_name_jobs; item jsonb;
begin
 if owner is null then raise exception 'worker_owner_mismatch' using errcode='42501';end if;
 select * into j from public.standalone_name_jobs where id=p_job and owner_id=owner for update;
 if not found or j.lease_token is distinct from p_lease or j.lease_expires_at<=clock_timestamp() or j.state not in('running','cancel_requested') then raise exception 'lease_lost' using errcode='PT409';end if;
 if p_state is null or p_state not in('succeeded','failed','cancelled','needs_reconciliation') or p_partial is null
  or octet_length(p_partial)>(j.policy#>>'{limits,maxOutputBytes}')::integer or left(p_partial,length(j.partial_text))<>j.partial_text
  or(p_error is not null and p_error!~'^[a-z][a-z0-9_]{0,79}$') then raise exception 'invalid_outcome' using errcode='22023';end if;
 if p_state='succeeded' then
  if not fluid_private.standalone_names_keys(p_result,array['version','provider','billingMode','model','responseId','requestId','generatedAt','usage','candidates','rejectedCount'])
   or p_result->'version' is distinct from '1'::jsonb or p_result->>'provider' is distinct from 'openai' or p_result->>'billingMode' is distinct from 'chatgpt_subscription'
   or p_result->>'model' is distinct from j.policy->>'model' or j.dispatched_at is null or p_error is not null
   or not fluid_private.standalone_names_text(p_result->'responseId',1,300) or jsonb_typeof(p_result->'candidates') is distinct from 'array'
   or jsonb_array_length(p_result->'candidates')>20 then raise exception 'invalid_result' using errcode='22023';end if;
  for item in select value from jsonb_array_elements(p_result->'candidates') loop
   if not fluid_private.standalone_names_keys(item,array['value','rationale','caution']) or not fluid_private.standalone_names_text(item->'value',1,160)
    or not fluid_private.standalone_names_text(item->'rationale',1,800) or(item->'caution'<>'null'::jsonb and not fluid_private.standalone_names_text(item->'caution',1,400)) then raise exception 'invalid_result' using errcode='22023';end if;
  end loop;
  if j.state='cancel_requested' or not public.report_standalone_names_ready(j.policy) then p_state:='needs_reconciliation';p_result:=null;p_error:='cancelled_after_dispatch';end if;
 elsif p_result is not null then raise exception 'invalid_outcome' using errcode='22023';end if;
 update public.standalone_name_jobs set state=p_state,result=p_result,partial_text=p_partial,error_code=p_error,finished_at=clock_timestamp(),lease_token=null,lease_expires_at=null where id=j.id;
 return true;
end $$;

-- Remove inherited default grants on only these new exact objects. No existing
-- helper/function/role ACL is changed. The worker receives no grants here.
do $$ declare object_name text; obj record; grantee record; begin
 foreach object_name in array array['fluid_private.standalone_names_runtime','public.standalone_name_jobs'] loop
  execute 'alter table '||object_name||' enable row level security';execute 'alter table '||object_name||' force row level security';
  execute 'revoke all on table '||object_name||' from public,anon,authenticated,service_role';
  for grantee in select distinct r.rolname from pg_class c cross join lateral aclexplode(c.relacl) a join pg_roles r on r.oid=a.grantee where c.oid=object_name::regclass and a.grantee<>c.relowner loop
   execute 'revoke all on table '||object_name||' from '||quote_ident(grantee.rolname);
  end loop;
 end loop;
 for obj in select p.oid,p.proowner from pg_proc p where p.oid in(
  'fluid_private.standalone_names_keys(jsonb,text[])'::regprocedure,'fluid_private.standalone_names_text(jsonb,integer,integer)'::regprocedure,
  'fluid_private.standalone_names_dto(public.standalone_name_jobs)'::regprocedure,'fluid_private.standalone_names_immutable()'::regprocedure,
  'fluid_private.standalone_names_availability(uuid)'::regprocedure,'fluid_private.standalone_names_shared_quota()'::regprocedure,
  'public.get_standalone_names(timestamptz,uuid)'::regprocedure,'public.get_standalone_name_job(uuid)'::regprocedure,'public.enqueue_standalone_names(jsonb)'::regprocedure,
  'public.cancel_standalone_names(uuid)'::regprocedure,'public.retain_standalone_name(uuid,integer,boolean,boolean)'::regprocedure,
  'public.report_standalone_names_ready(jsonb)'::regprocedure,'public.claim_standalone_names(jsonb)'::regprocedure,
  'public.pulse_standalone_names(uuid,uuid,boolean,text)'::regprocedure,'public.finish_standalone_names(uuid,uuid,text,jsonb,text,text)'::regprocedure) loop
  object_name:=obj.oid::regprocedure::text;
  execute 'revoke all on function '||object_name||' from public,anon,authenticated,service_role';
  for grantee in select distinct r.rolname from pg_proc p cross join lateral aclexplode(p.proacl) a join pg_roles r on r.oid=a.grantee where p.oid=obj.oid and a.grantee<>obj.proowner loop
   execute 'revoke all on function '||object_name||' from '||quote_ident(grantee.rolname);
  end loop;
  if obj.oid in('public.get_standalone_names(timestamptz,uuid)'::regprocedure,'public.get_standalone_name_job(uuid)'::regprocedure,'public.enqueue_standalone_names(jsonb)'::regprocedure,
   'public.cancel_standalone_names(uuid)'::regprocedure,'public.retain_standalone_name(uuid,integer,boolean,boolean)'::regprocedure) then execute 'grant execute on function '||object_name||' to authenticated';end if;
 end loop;
end $$;
-- No direct table grant: private recovery text/policy/lease fields stay private.
commit;
