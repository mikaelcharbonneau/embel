-- UNAPPLIED. Naming generation rebuild (November 2026).
-- Requires shared_naming_brainstorm_continuation.sql. Contract:
-- docs/naming-generation-contract.md.
--
-- One run is one naming.generate job (input version 3) plus its naming_batches
-- row (engine_version 3). A run makes at most three OpenAI rounds and saves at
-- most 100 cleaned names. The database stores clean names, usage and receipt
-- numbers only; it never parses a raw provider reply. Every failure ends one run
-- with a stated reason; nothing waits for reconciliation.
--
-- The lane gateway keeps its name and signature, so slot-role grants, gateway
-- code and admission stay as they are. shared_naming_cleanup.sql later removes
-- the previous Naming machinery.
begin;
set local lock_timeout='5s';

alter table public.naming_batches drop constraint naming_batches_engine_version_check;
alter table public.naming_batches add constraint naming_batches_engine_version_check check(engine_version in(1,2,3));

-- The saved-names overview lists old batches in their own format. A run is not
-- such a batch and has no batch-history screen, so the list leaves runs out.
do $batches$ declare d text; needle text:='with rows as(select b from public.naming_batches b where owner_id=v_owner and project_id=p_project_id';
begin
 d:=pg_get_functiondef('public.get_naming_batches(uuid,jsonb)'::regprocedure);
 if (length(d)-length(replace(d,needle,'')))/length(needle)<>1 then raise exception 'naming_generation_batches_predecessor'; end if;
 execute replace(d,needle,needle||' and engine_version<3');
end $batches$;

-- Feed counters of the previous engine; they write rows the new runs never use.
drop trigger if exists naming_brain_candidate_epoch on public.name_candidates;
drop trigger if exists naming_brain_feedback on public.name_retention;

create table fluid_private.naming_rounds (
 round_id uuid primary key default gen_random_uuid(),
 batch_id uuid not null references public.naming_batches(id) on delete cascade,
 job_id uuid not null references public.jobs(id) on delete cascade,
 owner_id uuid not null, project_id uuid not null,
 round integer not null check(round between 1 and 3),
 request jsonb not null check(jsonb_typeof(request)='object' and octet_length(request::text)<=262144),
 state text not null default 'sending' check(state in('sending','sent','saved','failed','interrupted')),
 response_id text check(response_id ~ '^resp_[A-Za-z0-9_-]{1,194}$'),
 request_id text check(request_id ~ '^[A-Za-z0-9_-]{1,200}$'),
 model text check(length(model) between 1 and 150),
 saved_count integer not null default 0 check(saved_count between 0 and 100),
 usage jsonb check(usage is null or jsonb_typeof(usage)='object'),
 error_code text check(error_code ~ '^[a-z][a-z0-9_]{0,79}$'),
 created_at timestamptz not null default clock_timestamp(),
 updated_at timestamptz not null default clock_timestamp(),
 unique(batch_id,round),
 check(state not in('sent','saved') or response_id is not null)
);
create index naming_rounds_job on fluid_private.naming_rounds(job_id);
create table fluid_private.naming_candidate_approaches (
 candidate_id uuid primary key references public.name_candidates(id) on delete cascade,
 primary_approach text not null check(primary_approach in('real_words','compounds','blends','invented','modified','phrases','initials','other_languages','classical_roots','people_places','stories_culture'))
);
revoke all on table fluid_private.naming_rounds,fluid_private.naming_candidate_approaches from public,anon,authenticated,service_role;

create function fluid_private.naming_generation_policy_valid(p jsonb) returns boolean
language sql immutable set search_path='' as $$
 select coalesce(jsonb_typeof(p)='object' and p->'version'='2'::jsonb and p->>'operation'='naming.generate'
  and length(btrim(coalesce(p->>'model',''))) between 1 and 150 and p->>'model'=btrim(p->>'model')
  and p->>'reasoningEffort' in('low','medium') and (select count(*) from jsonb_object_keys(p))=4,false);
$$;

-- The one ready slot policy new runs are admitted to.
create function fluid_private.naming_generation_policy() returns table(slot_id uuid,deployment_id text,policy jsonb,policy_identity text)
language sql stable security definer set search_path='' as $$
 select s.slot_id,s.deployment_id,p.policy,p.policy_identity from fluid_private.shared_worker_slots s
  join fluid_private.shared_worker_policies p on p.slot_id=s.slot_id and p.operation='naming.generate'
  join fluid_private.shared_naming_slot_configuration cfg on cfg.slot_id=s.slot_id
 where s.lane='naming' and s.enabled and s.expires_at>clock_timestamp() and cfg.ready_until>clock_timestamp()
  and fluid_private.naming_generation_policy_valid(p.policy)
  and p.policy_identity=encode(sha256(convert_to(p.policy::text,'UTF8')),'hex')
 order by s.slot_id limit 1;
$$;

create function fluid_private.naming_run_json(b public.naming_batches,j public.jobs) returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_build_object('runId',b.id,'jobId',j.id,'kind',j.input->>'kind',
  'state',case when j.state='running' and j.cancel_requested_at is not null then 'cancel_requested'
   when j.state in('partial','needs_reconciliation') then 'failed' else j.state end,
  'target',100,
  'savedCount',least(100,(select count(*) from public.name_candidates c where c.batch_id=b.id))::integer,
  'errorCode',j.error_code,
  'usage',(select case when count(r.usage)=0 then null else jsonb_build_object(
    'inputTokens',sum((r.usage->>'inputTokens')::bigint),'outputTokens',sum((r.usage->>'outputTokens')::bigint),
    'totalTokens',sum((r.usage->>'totalTokens')::bigint)) end
   from fluid_private.naming_rounds r where r.batch_id=b.id),
  'createdAt',j.created_at,'finishedAt',j.finished_at);
$$;

create function fluid_private.naming_round_json(r fluid_private.naming_rounds) returns jsonb
language sql immutable set search_path='' as $$
 select jsonb_build_object('roundId',r.round_id,'round',r.round,'state',r.state,'responseId',r.response_id,
  'savedCount',r.saved_count,'errorCode',r.error_code);
$$;

-- Ends a run: cancelled when Stop was requested, succeeded when any name was
-- saved, otherwise failed with the given or last round's reason. Open rounds are
-- closed with an explicit reason and the run's executions are closed.
create function fluid_private.naming_finish_job(p_job uuid,p_code text) returns text
language plpgsql security definer set search_path='' as $$
declare j public.jobs; b public.naming_batches; saved integer; v_state text; v_code text;
begin
 select * into strict j from public.jobs where id=p_job for update;
 select * into strict b from public.naming_batches where job_id=j.id;
 if j.state in('succeeded','failed','cancelled') then
  update fluid_private.shared_worker_executions set state='closed',closed_at=clock_timestamp() where job_id=j.id and state<>'closed';
  return j.state;
 end if;
 update fluid_private.naming_rounds set state='interrupted',error_code='send_interrupted',updated_at=clock_timestamp()
  where batch_id=b.id and state='sending';
 update fluid_private.naming_rounds set state='failed',error_code=coalesce(error_code,'response_timeout'),updated_at=clock_timestamp()
  where batch_id=b.id and state='sent';
 select count(*) into saved from public.name_candidates where batch_id=b.id;
 v_state:=case when j.cancel_requested_at is not null then 'cancelled' when saved>0 then 'succeeded' else 'failed' end;
 if v_state='failed' then
  v_code:=coalesce(p_code,(select error_code from fluid_private.naming_rounds where batch_id=b.id and error_code is not null order by round desc limit 1),'no_names');
 end if;
 update public.jobs set state=v_state,error_code=v_code,progress=least(100,saved),lease_token=null,lease_expires_at=null,
  finished_at=clock_timestamp() where id=j.id;
 update fluid_private.shared_worker_executions set state='closed',closed_at=clock_timestamp() where job_id=j.id and state<>'closed';
 return v_state;
end $$;

-- Applies the expiry rules to one running run whose lease ended (or, with
-- p_force, whose execution was fenced). A request that may have been sent
-- without a saved receipt number is never sent again.
create function fluid_private.naming_expire_job(p_job uuid,p_force boolean) returns boolean
language plpgsql security definer set search_path='' as $$
declare j public.jobs; b public.naming_batches; interrupted integer;
begin
 select * into j from public.jobs where id=p_job for update;
 if not found or j.operation<>'naming.generate' or j.input->'version' is distinct from '3'::jsonb then return false; end if;
 if j.state<>'running' then
  update fluid_private.shared_worker_executions set state='closed',closed_at=clock_timestamp() where job_id=j.id and state<>'closed';
  return false;
 end if;
 if not p_force and j.lease_expires_at>clock_timestamp() then return false; end if;
 select * into strict b from public.naming_batches where job_id=j.id;
 update fluid_private.naming_rounds set state='interrupted',error_code='send_interrupted',updated_at=clock_timestamp()
  where batch_id=b.id and state='sending';
 select count(*) into interrupted from fluid_private.naming_rounds where batch_id=b.id and state='interrupted';
 if interrupted>0 or j.cancel_requested_at is not null or j.created_at<clock_timestamp()-interval '20 minutes' or j.attempts>=j.max_attempts then
  perform fluid_private.naming_finish_job(j.id,case when interrupted>0 then 'send_interrupted'
   when j.created_at<clock_timestamp()-interval '20 minutes' then 'deadline' else 'lease_expired' end);
 else
  update public.jobs set state='queued',lease_token=null,lease_expires_at=null,worker_id=null where id=j.id;
  update fluid_private.shared_worker_executions set state='closed',closed_at=clock_timestamp() where job_id=j.id and state<>'closed';
 end if;
 return true;
end $$;

create function public.get_naming_generation(p_project uuid,p_after_created_at timestamptz default null,p_after_id uuid default null,p_limit integer default 100) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare o uuid:=auth.uid(); p public.projects; b public.naming_batches; j public.jobs; c public.name_candidates;
 run jsonb; entries jsonb:='[]'::jsonb; n integer:=0; more boolean:=false; last_created timestamptz; last_id uuid; pol record;
begin
 if o is null then raise exception 'unauthenticated' using errcode='42501'; end if;
 if p_limit is null or p_limit not between 1 and 100 or (p_after_created_at is null)<>(p_after_id is null) then
  raise exception 'invalid_naming_request' using errcode='22023'; end if;
 select * into p from public.projects where id=p_project and owner_id=o and deleted_at is null and deletion_requested_at is null;
 if not found then raise exception 'not_found' using errcode='P0002'; end if;
 select bb.* into b from public.naming_batches bb where bb.project_id=p.id and bb.owner_id=o and bb.engine_version=3 order by bb.sequence desc limit 1;
 if found then select * into strict j from public.jobs where id=b.job_id; run:=fluid_private.naming_run_json(b,j); end if;
 for c in select cc.* from public.name_candidates cc join public.naming_batches bb on (bb.id,bb.owner_id,bb.project_id)=(cc.batch_id,cc.owner_id,cc.project_id)
  where cc.project_id=p.id and cc.owner_id=o and bb.engine_version=3
   and (p_after_id is null or (cc.created_at,cc.id)>(p_after_created_at,p_after_id))
  order by cc.created_at,cc.id limit p_limit+1 loop
  n:=n+1; if n>p_limit then more:=true; exit; end if;
  entries:=entries||jsonb_build_array(jsonb_build_object('entry',fluid_private.naming_entry(c),'runId',c.batch_id,
   'primaryApproach',(select to_jsonb(a.primary_approach) from fluid_private.naming_candidate_approaches a where a.candidate_id=c.id)));
  last_created:=c.created_at; last_id:=c.id;
 end loop;
 select * into pol from fluid_private.naming_generation_policy();
 return jsonb_build_object('version',2,'projectId',p.id,
  'availability',case when pol.slot_id is null then jsonb_build_object('status','unavailable','code','worker_unavailable') else jsonb_build_object('status','available') end,
  'run',coalesce(run,'null'::jsonb),'entries',entries,
  'nextCursor',case when more then jsonb_build_object('createdAt',last_created,'id',last_id) else 'null'::jsonb end);
end $$;

create function public.start_naming_run(p_project uuid,p_request jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare o uuid:=auth.uid(); p public.projects; s public.naming_sessions; pref public.naming_preferences; ctx jsonb; pol record;
 b public.naming_batches; j public.jobs; v_kind text; v_key text; v_instruction text; v_seeds uuid[]:='{}'; brief jsonb; v_input jsonb;
 v_run uuid:=gen_random_uuid(); v_job uuid:=gen_random_uuid(); seq integer;
begin
 if o is null then raise exception 'unauthenticated' using errcode='42501'; end if;
 if jsonb_typeof(p_request) is distinct from 'object' or octet_length(p_request::text)>16384
  or (select array_agg(k order by k) from jsonb_object_keys(p_request) k) is distinct from
   array['expectedPreferencesVersion','expectedProjectRevision','idempotencyKey','instruction','kind','seedIds','version']
  or p_request->'version' is distinct from '2'::jsonb or coalesce(p_request->>'kind','') not in('initial','more','steer')
  or coalesce(p_request->>'idempotencyKey','') !~ '^[A-Za-z0-9._:-]{16,128}$'
  or jsonb_typeof(p_request->'expectedProjectRevision') is distinct from 'number'
  or jsonb_typeof(p_request->'expectedPreferencesVersion') is distinct from 'number'
  or jsonb_typeof(p_request->'seedIds') is distinct from 'array' or jsonb_array_length(p_request->'seedIds')>5
  or jsonb_typeof(p_request->'instruction') not in('null','string') then
  raise exception 'invalid_naming_request' using errcode='22023'; end if;
 v_kind:=p_request->>'kind'; v_key:='naming-run:'||(p_request->>'idempotencyKey');
 v_instruction:=nullif(btrim(p_request->>'instruction'),'');
 if v_instruction is not null and length(v_instruction)>2000 then raise exception 'invalid_naming_request' using errcode='22023'; end if;
 select coalesce(array_agg(x::uuid),'{}') into v_seeds from jsonb_array_elements_text(p_request->'seedIds') x;
 if cardinality(v_seeds)<>(select count(distinct x) from unnest(v_seeds) x)
  or v_kind='steer' and cardinality(v_seeds)=0 and v_instruction is null
  or v_kind<>'steer' and (cardinality(v_seeds)>0 or p_request->'instruction'<>'null'::jsonb) then
  raise exception 'invalid_naming_request' using errcode='22023'; end if;

 -- A repeated click with the same key returns the run it started.
 select * into j from public.jobs where owner_id=o and idempotency_key=v_key;
 if found then
  if j.project_id<>p_project or j.operation<>'naming.generate' or j.input->>'kind' is distinct from v_kind then
   raise exception 'idempotency_conflict' using errcode='40001'; end if;
  select * into strict b from public.naming_batches where job_id=j.id;
  return jsonb_build_object('run',fluid_private.naming_run_json(b,j),'reused',true);
 end if;

 s:=fluid_private.ensure_naming_session(p_project,o);
 select * into strict p from public.projects where id=p_project and owner_id=o;
 if p.deleted_at is not null or p.deletion_requested_at is not null then raise exception 'not_found' using errcode='P0002'; end if;
 if p.current_revision<>(p_request->>'expectedProjectRevision')::integer then raise exception 'project_revision_changed' using errcode='40001'; end if;
 if s.preferences_version is distinct from (p_request->>'expectedPreferencesVersion')::integer then raise exception 'preferences_changed' using errcode='40001'; end if;
 select * into pref from public.naming_preferences where project_id=p.id and owner_id=o and version=s.preferences_version;
 if not found or pref.preferences->'version' is distinct from '2'::jsonb then raise exception 'preferences_incomplete' using errcode='22023'; end if;
 if exists(select 1 from public.jobs where project_id=p.id and owner_id=o and operation='naming.generate' and state in('queued','running','cancel_requested')) then
  raise exception 'naming_active' using errcode='40001'; end if;
 if (select count(*) from public.name_candidates where id=any(v_seeds) and project_id=p.id and owner_id=o)<>cardinality(v_seeds) then
  raise exception 'invalid_naming_request' using errcode='22023'; end if;
 select * into pol from fluid_private.naming_generation_policy();
 if pol.slot_id is null then raise exception 'naming_unavailable' using errcode='55000'; end if;

 select r.context into strict ctx from public.project_revisions r where r.project_id=p.id and r.owner_id=o and r.revision=p.current_revision;
 brief:=jsonb_build_object('version',1,'contextRevision',p.current_revision,'preferencesVersion',pref.version,'preferences',pref.preferences,
  'strategyBasis',fluid_private.naming_strategy_basis(ctx),
  'likedExamples',coalesce((select jsonb_agg(jsonb_build_object('value',x.value) order by x.updated_at desc,x.id) from (
    select c.value,c.id,r.updated_at from public.name_retention r join public.name_candidates c on c.id=r.candidate_id
    where r.project_id=p.id and r.owner_id=o and r.liked order by r.updated_at desc,c.id limit 20) x),'[]'::jsonb),
  'strongSeeds',coalesce((select jsonb_agg(jsonb_build_object('value',c.value,'rationale',left(c.rationale,2000)) order by c.created_at,c.id)
    from public.name_candidates c where c.id=any(v_seeds) and c.project_id=p.id and c.owner_id=o),'[]'::jsonb),
  'recentExamples',coalesce((select jsonb_agg(jsonb_build_object('value',x.value) order by x.created_at desc,x.id) from (
    select value,created_at,id from public.name_candidates where project_id=p.id and owner_id=o order by created_at desc,id limit 50) x),'[]'::jsonb),
  'steeringInstruction',to_jsonb(v_instruction));
 v_input:=jsonb_build_object('version',3,'kind',v_kind,'runId',v_run,'target',100,'policyIdentity',pol.policy_identity,'brief',brief);
 if octet_length(v_input::text)>131072 then raise exception 'invalid_naming_request' using errcode='22023'; end if;

 insert into public.jobs(id,owner_id,project_id,operation,input_revision,input_hash,input,idempotency_key,reserved_cost_microusd,max_attempts,billing_mode)
 values(v_job,o,p.id,'naming.generate',p.current_revision,encode(sha256(convert_to(v_input::text,'UTF8')),'hex'),v_input,v_key,0,3,'openai_api')
 returning * into j;
 update public.naming_sessions set batch_sequence=batch_sequence+1,updated_at=clock_timestamp()
  where project_id=p.id and owner_id=o returning batch_sequence into seq;
 insert into public.naming_batches(id,owner_id,project_id,sequence,context_revision,strategy_basis,preferences_version,favorites_snapshot,
  exclusion_keys,policy_identity,target_count,job_id,idempotency_key,engine_version)
 values(v_run,o,p.id,seq,p.current_revision,brief->'strategyBasis',pref.version,brief->'likedExamples','[]'::jsonb,pol.policy_identity,100,v_job,
  'naming-run:'||v_run,3) returning * into b;
 perform fluid_private.admit_shared_worker_job(v_job,'naming',pol.policy_identity,pol.deployment_id,pol.policy);
 return jsonb_build_object('run',fluid_private.naming_run_json(b,j),'reused',false);
end $$;

-- Stop: a queued run is cancelled at once; a running run is asked to stop and
-- the worker ends it after the current step. Saved names stay.
create function public.stop_naming_run(p_project uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare o uuid:=auth.uid(); j public.jobs; b public.naming_batches;
begin
 if o is null then raise exception 'unauthenticated' using errcode='42501'; end if;
 perform 1 from public.projects where id=p_project and owner_id=o and deleted_at is null and deletion_requested_at is null;
 if not found then raise exception 'not_found' using errcode='P0002'; end if;
 select * into j from public.jobs where project_id=p_project and owner_id=o and operation='naming.generate' and input->'version'='3'::jsonb
  and state in('queued','running') order by created_at desc,id limit 1 for update;
 if found then
  if j.state='queued' then
   update public.jobs set cancel_requested_at=coalesce(cancel_requested_at,clock_timestamp()) where id=j.id;
   perform fluid_private.naming_finish_job(j.id,null);
  else
   update public.jobs set cancel_requested_at=coalesce(cancel_requested_at,clock_timestamp()) where id=j.id;
  end if;
 end if;
 select bb.* into b from public.naming_batches bb where bb.project_id=p_project and bb.owner_id=o and bb.engine_version=3 order by bb.sequence desc limit 1;
 if not found then return jsonb_build_object('run',null); end if;
 select * into strict j from public.jobs where id=b.job_id;
 return jsonb_build_object('run',fluid_private.naming_run_json(b,j));
end $$;

create function public.get_naming_usage(p_jobs uuid[]) returns jsonb
language sql stable security definer set search_path='' as $$
 select coalesce(jsonb_agg(jsonb_build_object('jobId',x.job_id,'inputTokens',x.i,'outputTokens',x.o,'totalTokens',x.t) order by x.job_id),'[]'::jsonb)
 from (select r.job_id,sum((r.usage->>'inputTokens')::bigint) i,sum((r.usage->>'outputTokens')::bigint) o,sum((r.usage->>'totalTokens')::bigint) t
  from fluid_private.naming_rounds r where r.job_id=any(p_jobs) and r.owner_id=auth.uid() and r.usage is not null
  and cardinality(p_jobs)<=200 group by r.job_id) x;
$$;

create or replace function public.shared_naming_worker_action(p_slot jsonb,p_execution jsonb,p_action text,p_args jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s fluid_private.shared_worker_slots; e fluid_private.shared_worker_executions; cfg fluid_private.shared_naming_slot_configuration;
 j public.jobs; b public.naming_batches; rd fluid_private.naming_rounds; result jsonb; selected uuid; v_round integer; n integer;
 total integer; inserted integer:=0; item jsonb; v_identity text; v_candidate uuid; v_usage jsonb;
begin
 if p_action is null or p_action not in('qualify','expire','claim','heartbeat','round_begin','round_sent','round_saved','round_failed','finish','recover')
  or jsonb_typeof(p_args) is distinct from 'object' or octet_length(p_args::text)>1048576 then
  raise exception 'invalid_shared_naming_action' using errcode='22023'; end if;

 if p_execution is null then
  s:=fluid_private.lock_shared_worker_slot(p_slot,true);
  if s.lane<>'naming' then raise exception 'shared_lane_mismatch' using errcode='42501'; end if;
  select * into cfg from fluid_private.shared_naming_slot_configuration where slot_id=s.slot_id;
  if cfg.slot_id is null then raise exception 'shared_naming_configuration_absent' using errcode='55000'; end if;
  if p_action='qualify' then
   if (select count(*) from jsonb_object_keys(p_args))<>1 or not exists(select 1 from fluid_private.shared_worker_policies
    where slot_id=s.slot_id and operation='naming.generate' and policy=p_args->'policy' and fluid_private.naming_generation_policy_valid(policy)
    and policy_identity=encode(sha256(convert_to((p_args->'policy')::text,'UTF8')),'hex')) then
    raise exception 'shared_naming_runtime_mismatch' using errcode='42501'; end if;
   update fluid_private.shared_naming_slot_configuration set ready_until=clock_timestamp()+interval '60 seconds' where slot_id=s.slot_id;
   return jsonb_build_object('execution',null,'result',true);
  end if;
  if cfg.ready_until is null or cfg.ready_until<=clock_timestamp() then raise exception 'shared_naming_runtime_stale' using errcode='42501'; end if;
  if p_action='expire' then
   if p_args<>'{}'::jsonb then raise exception 'invalid_shared_naming_expiry' using errcode='22023'; end if;
   n:=0;
   for selected in select jj.id from public.jobs jj join fluid_private.shared_job_admissions a on a.job_id=jj.id
    where a.lane='naming' and a.deployment_id=s.deployment_id and jj.operation='naming.generate' and jj.input->'version'='3'::jsonb
     and (jj.state='running' and jj.lease_expires_at<=clock_timestamp()
      or jj.state='queued' and jj.created_at<clock_timestamp()-interval '20 minutes')
    order by jj.created_at,jj.id limit 20 for update of jj skip locked loop
    select * into strict j from public.jobs where id=selected;
    if j.state='queued' then perform fluid_private.naming_finish_job(j.id,'deadline');
    else perform fluid_private.naming_expire_job(j.id,false); end if;
    n:=n+1;
   end loop;
   return jsonb_build_object('execution',null,'result',n);
  end if;
  if p_action<>'claim' then raise exception 'shared_naming_execution_required' using errcode='42501'; end if;
  if (select array_agg(k order by k) from jsonb_object_keys(p_args) k) is distinct from array['leaseSeconds','workerId']
   or length(coalesce(p_args->>'workerId','')) not between 1 and 100 or jsonb_typeof(p_args->'leaseSeconds') is distinct from 'number'
   or (p_args->>'leaseSeconds')::numeric not between 10 and 300 then raise exception 'invalid_shared_naming_claim' using errcode='22023'; end if;
  -- SQL chooses the oldest admitted run; no owner or job selector is accepted.
  select a.job_id into selected from fluid_private.shared_job_admissions a join public.jobs jj on jj.id=a.job_id
   join public.naming_batches bb on bb.job_id=jj.id and bb.engine_version=3
   where a.lane='naming' and a.deployment_id=s.deployment_id and jj.operation='naming.generate' and jj.state='queued'
    and jj.input->'version'='3'::jsonb and jj.attempts<jj.max_attempts and jj.cancel_requested_at is null
    and fluid_private.shared_worker_claimable(p_slot,a.job_id)
   order by jj.created_at,jj.id limit 1;
  if selected is null then return jsonb_build_object('execution',null,'result',null); end if;
  perform fluid_private.enter_shared_worker_claim_context(p_slot,selected);
  update public.jobs set state='running',lease_token=gen_random_uuid(),
   lease_expires_at=clock_timestamp()+make_interval(secs=>(p_args->>'leaseSeconds')::integer),
   worker_id=p_args->>'workerId',attempts=attempts+1 where id=selected and state='queued' returning * into j;
  e:=fluid_private.bind_shared_worker_execution(p_slot,selected);
  perform fluid_private.leave_shared_worker_context();
  select * into strict b from public.naming_batches where job_id=j.id;
  result:=jsonb_build_object(
   'job',jsonb_build_object('id',j.id,'owner_id',j.owner_id,'project_id',j.project_id,'lease_token',j.lease_token,'operation',j.operation,
    'attempts',j.attempts,'max_attempts',j.max_attempts),
   'run',fluid_private.naming_run_json(b,j),'input',j.input,
   'rounds',coalesce((select jsonb_agg(fluid_private.naming_round_json(r) order by r.round) from fluid_private.naming_rounds r where r.batch_id=b.id),'[]'::jsonb),
   'identities',coalesce((select jsonb_agg(x.identity_key order by x.identity_key) from (select distinct c.identity_key from public.name_candidates c
    where c.project_id=j.project_id and c.owner_id=j.owner_id and c.identity_key<>'' limit 5000) x),'[]'::jsonb));
  return jsonb_build_object('execution',fluid_private.shared_worker_execution_json(e),'result',result);
 end if;

 if p_action='recover' then
  -- A run left by a stopped worker is resolved now under the expiry rules.
  e:=fluid_private.shared_worker_execution(p_slot,p_execution,'observe');
  if e.lane<>'naming' then raise exception 'shared_lane_mismatch' using errcode='42501'; end if;
  if p_args<>'{}'::jsonb then raise exception 'invalid_shared_naming_recovery' using errcode='22023'; end if;
  -- Only while this old execution still holds the job: a run that was already
  -- requeued and claimed again belongs to its new execution.
  select * into j from public.jobs where id=e.job_id for update;
  if j.state='running' and j.lease_token=e.lease_token then perform fluid_private.naming_expire_job(e.job_id,true); end if;
  update fluid_private.shared_worker_executions set state='closed',closed_at=clock_timestamp() where execution_id=e.execution_id and state<>'closed';
  return jsonb_build_object('execution',fluid_private.shared_worker_execution_json(e),'result',jsonb_build_object('action','closed'));
 end if;

 if p_action in('qualify','expire','claim') then raise exception 'shared_naming_slot_action' using errcode='42501'; end if;
 if p_action='finish' and p_args='{}'::jsonb then
  -- A finish whose acknowledgement was lost may be replayed: that exact closed
  -- execution of this slot role reports its run's terminal result again.
  select x.* into e from fluid_private.shared_worker_executions x join fluid_private.shared_worker_slots sl on sl.slot_id=x.slot_id
   where x.execution_id=(p_execution->>'executionId')::uuid and x.state='closed' and x.lane='naming' and sl.role_name=session_user
    and fluid_private.shared_worker_execution_json(x)=p_execution;
  if found then
   select * into strict j from public.jobs where id=e.job_id;
   if j.state in('succeeded','failed','cancelled') then
    return jsonb_build_object('execution',p_execution,'result',jsonb_build_object('state',j.state,
     'savedCount',least(100,(select count(*) from public.name_candidates c join public.naming_batches bb on bb.id=c.batch_id where bb.job_id=j.id))));
   end if;
  end if;
 end if;
 e:=fluid_private.shared_worker_execution(p_slot,p_execution,'active');
 if e.lane<>'naming' then raise exception 'shared_lane_mismatch' using errcode='42501'; end if;
 select * into strict j from public.jobs where id=e.job_id for update;
 select * into strict b from public.naming_batches where job_id=j.id and engine_version=3;
 select count(*) into total from public.name_candidates where batch_id=b.id;

 if p_action='heartbeat' then
  if (select array_agg(k) from jsonb_object_keys(p_args) k) is distinct from array['leaseSeconds']
   or jsonb_typeof(p_args->'leaseSeconds') is distinct from 'number' or (p_args->>'leaseSeconds')::numeric not between 10 and 300 then
   raise exception 'invalid_naming_heartbeat' using errcode='22023'; end if;
  update public.jobs set lease_expires_at=clock_timestamp()+make_interval(secs=>(p_args->>'leaseSeconds')::integer) where id=j.id;
  result:=jsonb_build_object('cancelRequested',j.cancel_requested_at is not null);

 elsif p_action='finish' then
  if p_args<>'{}'::jsonb then raise exception 'invalid_naming_finish' using errcode='22023'; end if;
  result:=jsonb_build_object('state',fluid_private.naming_finish_job(j.id,null),'savedCount',least(100,total));

 else
  if jsonb_typeof(p_args->'round') is distinct from 'number' or (p_args->>'round')::numeric not in(1,2,3) then
   raise exception 'invalid_naming_round' using errcode='22023'; end if;
  v_round:=(p_args->>'round')::integer;
  select * into rd from fluid_private.naming_rounds where batch_id=b.id and round=v_round for update;

  if p_action='round_begin' then
   if (select array_agg(k order by k) from jsonb_object_keys(p_args) k) is distinct from array['request','round']
    or jsonb_typeof(p_args->'request') is distinct from 'object' or octet_length((p_args->'request')::text)>262144 then
    raise exception 'invalid_naming_round' using errcode='22023'; end if;
   if rd.round_id is not null then
    if rd.state<>'sending' or rd.request<>p_args->'request' then raise exception 'naming_round_conflict' using errcode='40001'; end if;
   else
    if j.cancel_requested_at is not null then raise exception 'naming_cancel_requested' using errcode='55000'; end if;
    if j.created_at<clock_timestamp()-interval '20 minutes' then raise exception 'naming_deadline' using errcode='55000'; end if;
    if total>=100 then raise exception 'naming_target_reached' using errcode='55000'; end if;
    if v_round<>coalesce((select max(round) from fluid_private.naming_rounds where batch_id=b.id),0)+1 then
     raise exception 'naming_round_out_of_order' using errcode='22023'; end if;
    if exists(select 1 from fluid_private.naming_rounds where batch_id=b.id and state in('sending','sent','interrupted')) then
     raise exception 'naming_round_open' using errcode='55000'; end if;
    insert into fluid_private.naming_rounds(batch_id,job_id,owner_id,project_id,round,request)
     values(b.id,j.id,j.owner_id,j.project_id,v_round,p_args->'request') returning * into rd;
   end if;
   result:=fluid_private.naming_round_json(rd);

  elsif p_action='round_sent' then
   if (select array_agg(k order by k) from jsonb_object_keys(p_args) k) is distinct from array['requestId','responseId','round']
    or coalesce(p_args->>'responseId','') !~ '^resp_[A-Za-z0-9_-]{1,194}$'
    or jsonb_typeof(p_args->'requestId') not in('null','string') or p_args->>'requestId' !~ '^[A-Za-z0-9_-]{1,200}$' then
    raise exception 'invalid_naming_round' using errcode='22023'; end if;
   if rd.round_id is null then raise exception 'naming_round_missing' using errcode='P0002'; end if;
   if rd.state='sending' then
    update fluid_private.naming_rounds set state='sent',response_id=p_args->>'responseId',request_id=p_args->>'requestId',updated_at=clock_timestamp()
     where round_id=rd.round_id returning * into rd;
   elsif rd.state<>'sent' or rd.response_id<>p_args->>'responseId' then raise exception 'naming_round_conflict' using errcode='40001'; end if;
   result:=fluid_private.naming_round_json(rd);

  elsif p_action='round_saved' then
   if (select array_agg(k order by k) from jsonb_object_keys(p_args) k) is distinct from array['candidates','model','responseId','round','usage']
    or jsonb_typeof(p_args->'candidates') is distinct from 'array' or jsonb_array_length(p_args->'candidates')>100
    or length(coalesce(p_args->>'model','')) not between 1 and 150 or coalesce(p_args->>'responseId','') !~ '^resp_[A-Za-z0-9_-]{1,194}$' then
    raise exception 'invalid_naming_round' using errcode='22023'; end if;
   v_usage:=p_args->'usage';
   if jsonb_typeof(v_usage)='object' then
    if (select array_agg(k order by k) from jsonb_object_keys(v_usage) k) is distinct from array['inputTokens','outputTokens','totalTokens']
     or exists(select 1 from jsonb_each(v_usage) u where jsonb_typeof(u.value)<>'number' or (u.value)::text !~ '^[0-9]{1,15}$') then
     raise exception 'invalid_naming_usage' using errcode='22023'; end if;
   elsif jsonb_typeof(v_usage) is distinct from 'null' then raise exception 'invalid_naming_usage' using errcode='22023';
   else v_usage:=null; end if;
   if rd.round_id is null then raise exception 'naming_round_missing' using errcode='P0002'; end if;
   if rd.state='saved' and rd.response_id=p_args->>'responseId' then
    return jsonb_build_object('execution',fluid_private.shared_worker_execution_json(e),'result',jsonb_build_object('inserted',0,'savedCount',least(100,total)));
   end if;
   if rd.state<>'sent' or rd.response_id<>p_args->>'responseId' then raise exception 'naming_round_conflict' using errcode='40001'; end if;
   for item in select value from jsonb_array_elements(p_args->'candidates') loop
    if jsonb_typeof(item) is distinct from 'object'
     or (select array_agg(k order by k) from jsonb_object_keys(item) k) is distinct from array['identityKey','primaryApproach','rationale','value']
     or jsonb_typeof(item->'value') is distinct from 'string' or length(item->>'value') not between 1 and 160 or btrim(item->>'value')=''
     or jsonb_typeof(item->'rationale') is distinct from 'string' or length(item->>'rationale') not between 1 and 600
     or jsonb_typeof(item->'identityKey') is distinct from 'string' or length(item->>'identityKey') not between 1 and 320
     or item->>'primaryApproach' not in('real_words','compounds','blends','invented','modified','phrases','initials','other_languages','classical_roots','people_places','stories_culture') then
     raise exception 'invalid_naming_candidate' using errcode='22023'; end if;
    exit when total>=100;
    v_identity:=item->>'identityKey';
    continue when exists(select 1 from public.name_candidates where project_id=j.project_id and identity_key=v_identity);
    v_candidate:=gen_random_uuid();
    -- clock_timestamp keeps the feed in the order the AI proposed the names.
    insert into public.name_candidates(id,owner_id,project_id,value,identity_key,context_revision,strategy_basis,origin,rationale,caution,batch_id,created_at)
    values(v_candidate,j.owner_id,j.project_id,item->>'value',v_identity,b.context_revision,b.strategy_basis,
     jsonb_build_object('kind','brainstorm','version',1,'profile','brainstorm_v1','ownerId',j.owner_id,'projectId',j.project_id,
      'candidateId',v_candidate,'contextRevision',b.context_revision,'value',item->>'value','batchId',b.id,'jobId',j.id,'runId',b.id,
      'callId',rd.round_id,'responseId',rd.response_id,'requestId',rd.request_id,'model',p_args->>'model','generatedAt',clock_timestamp()),
     item->>'rationale','Unchecked brainstorm. Research and screening are needed before use.',b.id,clock_timestamp());
    insert into fluid_private.naming_candidate_approaches values(v_candidate,item->>'primaryApproach');
    inserted:=inserted+1; total:=total+1;
   end loop;
   update fluid_private.naming_rounds set state='saved',saved_count=inserted,usage=v_usage,model=p_args->>'model',updated_at=clock_timestamp()
    where round_id=rd.round_id;
   update public.jobs set progress=least(100,total) where id=j.id;
   result:=jsonb_build_object('inserted',inserted,'savedCount',least(100,total));

  else -- round_failed
   if (select array_agg(k order by k) from jsonb_object_keys(p_args) k) is distinct from array['code','responseId','round','usage']
    or coalesce(p_args->>'code','') not in('provider_rejected','response_failed','response_timeout','invalid_output','save_failed')
    or jsonb_typeof(p_args->'responseId') not in('null','string') or p_args->>'responseId' !~ '^resp_[A-Za-z0-9_-]{1,194}$'
    or jsonb_typeof(p_args->'usage') not in('null','object') then raise exception 'invalid_naming_round' using errcode='22023'; end if;
   v_usage:=case when jsonb_typeof(p_args->'usage')='object' then p_args->'usage' end;
   if v_usage is not null and ((select array_agg(k order by k) from jsonb_object_keys(v_usage) k) is distinct from array['inputTokens','outputTokens','totalTokens']
    or exists(select 1 from jsonb_each(v_usage) u where jsonb_typeof(u.value)<>'number' or (u.value)::text !~ '^[0-9]{1,15}$')) then
    raise exception 'invalid_naming_usage' using errcode='22023'; end if;
   if rd.round_id is null then raise exception 'naming_round_missing' using errcode='P0002'; end if;
   if rd.state in('sending','sent') then
    update fluid_private.naming_rounds set state='failed',error_code=p_args->>'code',response_id=coalesce(response_id,p_args->>'responseId'),
     usage=coalesce(v_usage,usage),updated_at=clock_timestamp() where round_id=rd.round_id returning * into rd;
   elsif rd.state<>'failed' or rd.error_code<>p_args->>'code' then raise exception 'naming_round_conflict' using errcode='40001'; end if;
   result:=fluid_private.naming_round_json(rd);
  end if;
 end if;
 return jsonb_build_object('execution',fluid_private.shared_worker_execution_json(e),'result',result);
end $$;

do $acl$ declare fn text; begin
 foreach fn in array array['fluid_private.naming_generation_policy_valid(jsonb)','fluid_private.naming_generation_policy()',
  'fluid_private.naming_run_json(public.naming_batches,public.jobs)','fluid_private.naming_round_json(fluid_private.naming_rounds)',
  'fluid_private.naming_finish_job(uuid,text)','fluid_private.naming_expire_job(uuid,boolean)'] loop
  execute format('revoke all on function %s from public,anon,authenticated,service_role',fn);
 end loop;
 foreach fn in array array['public.get_naming_generation(uuid,timestamptz,uuid,integer)','public.start_naming_run(uuid,jsonb)',
  'public.stop_naming_run(uuid)','public.get_naming_usage(uuid[])'] loop
  execute format('revoke all on function %s from public,anon,service_role',fn);
  execute format('grant execute on function %s to authenticated',fn);
 end loop;
end $acl$;
commit;
