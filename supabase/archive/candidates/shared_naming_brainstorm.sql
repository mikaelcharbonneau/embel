-- UNAPPLIED future-only brainstorm profile. Requires shared_worker_naming.sql.
-- No role, credential, activation, allowance or provider inference is created.
begin;
set local lock_timeout='2s';
set local statement_timeout='30s';
do $guard$ declare signature text;expected text;expected_definer boolean;expected_volatility text;expected_language text;begin
 if current_user<>'postgres' or to_regprocedure('public.shared_naming_worker_action(jsonb,jsonb,text,jsonb)') is null
 or to_regclass('fluid_private.naming_brainstorm_calls') is not null then raise exception 'brainstorm_install_prerequisite'; end if;
 for signature,expected,expected_definer,expected_volatility,expected_language in values
 ('public.shared_naming_worker_action(jsonb,jsonb,text,jsonb)','d7a168d06f92d965d9859fe5f1612dfa',true,'v','plpgsql'),
 ('public.ensure_shared_naming_brain_run(uuid,jsonb)','6e54209f4f230b7f78e44a88273872cd',true,'v','plpgsql'),
 ('fluid_private.shared_naming_ensure_core(uuid,jsonb)','3973db816f5878ca16f978c5caaa6d05',true,'v','plpgsql'),
 ('fluid_private.naming_brain_summary(fluid_private.naming_brain_runs)','0781ee058a051531e2e81f019fd371d9',false,'s','plpgsql'),
 ('fluid_private.naming_brain_ensure_response(fluid_private.naming_brain_runs,boolean)','5e271baffb34697edb1ca8cd976dc5ac',false,'v','plpgsql'),
 ('fluid_private.naming_brain_no_dispatch(uuid)','cd07080fab51d8389aaf441d12a35c39',false,'s','sql'),
 ('public.persist_name_transform(uuid,uuid,uuid,jsonb,jsonb,text)','af7bf1b0e339532ae7541201e4effe5d',true,'v','plpgsql'),
 ('public.create_brand_from_project_name(uuid,uuid,integer,text,boolean,text)','e556801bc0c1a65649b6f2588218d339',true,'v','plpgsql') loop
 if not exists(select 1 from pg_proc where oid=to_regprocedure(signature) and md5(prosrc)=expected and proowner=(select oid from pg_roles where rolname='postgres') and proconfig=array['search_path=""'] and prosecdef=expected_definer and provolatile::text=expected_volatility and not proleakproof and (select lanname from pg_language where oid=prolang)=expected_language) then raise exception 'brainstorm_predecessor_mismatch: %',signature;end if;
 end loop;
 lock table public.name_candidates in access exclusive mode;
 if (select jsonb_build_object('namespace',n.nspname,'relation',r.relname,'name',c.conname,'type',c.contype::text,'deferrable',c.condeferrable,'deferred',c.condeferred,'validated',c.convalidated,'local',c.conislocal,'inheritanceCount',c.coninhcount,'noInherit',c.connoinherit,'keys',c.conkey,'expression',pg_get_expr(c.conbin,c.conrelid),'definition',pg_get_constraintdef(c.oid,true)) from pg_constraint c join pg_class r on r.oid=c.conrelid join pg_namespace n on n.oid=r.relnamespace where c.conrelid='public.name_candidates'::regclass and c.conname='name_candidates_check1') is distinct from '{"deferrable":false,"deferred":false,"definition":"CHECK ((origin ->> ''kind''::text) = ''generated''::text AND batch_id IS NOT NULL AND transform_id IS NULL AND source_candidate_id IS NULL OR (origin ->> ''kind''::text) = ''local_import''::text AND batch_id IS NULL AND transform_id IS NULL AND source_candidate_id IS NULL OR (origin ->> ''kind''::text) = ''transform''::text AND batch_id IS NULL AND transform_id IS NOT NULL AND source_candidate_id IS NULL AND (origin ->> ''authorship''::text) = ''user_supplied''::text OR (origin ->> ''kind''::text) = ''account_copy''::text AND batch_id IS NULL AND transform_id IS NULL AND source_candidate_id IS NOT NULL)","expression":"((((origin ->> ''kind''::text) = ''generated''::text) AND (batch_id IS NOT NULL) AND (transform_id IS NULL) AND (source_candidate_id IS NULL)) OR (((origin ->> ''kind''::text) = ''local_import''::text) AND (batch_id IS NULL) AND (transform_id IS NULL) AND (source_candidate_id IS NULL)) OR (((origin ->> ''kind''::text) = ''transform''::text) AND (batch_id IS NULL) AND (transform_id IS NOT NULL) AND (source_candidate_id IS NULL) AND ((origin ->> ''authorship''::text) = ''user_supplied''::text)) OR (((origin ->> ''kind''::text) = ''account_copy''::text) AND (batch_id IS NULL) AND (transform_id IS NULL) AND (source_candidate_id IS NOT NULL)))","inheritanceCount":0,"keys":[8,11,12,14],"local":true,"name":"name_candidates_check1","namespace":"public","noInherit":false,"relation":"name_candidates","type":"c","validated":true}'::jsonb then raise exception 'brainstorm_root_constraint_predecessor_mismatch';end if;
end $guard$;
-- Extend only the storage root discriminator. Historical branches stay exact.
alter table public.name_candidates drop constraint name_candidates_check1;
alter table public.name_candidates add constraint name_candidates_check1 check(
 (origin->>'kind'='generated' and batch_id is not null and transform_id is null and source_candidate_id is null)
 or(origin->>'kind'='local_import' and batch_id is null and transform_id is null and source_candidate_id is null)
 or(origin->>'kind'='transform' and batch_id is null and transform_id is not null and source_candidate_id is null and origin->>'authorship'='user_supplied')
 or(origin->>'kind'='account_copy' and batch_id is null and transform_id is null and source_candidate_id is not null)
 or(origin->>'kind'='brainstorm' and origin->>'profile'='brainstorm_v1' and origin->'version'='1'::jsonb
  and batch_id is not null and transform_id is null and source_candidate_id is null));
do $roots$ declare d text;sig text;begin
 foreach sig in array array['public.persist_name_transform(uuid,uuid,uuid,jsonb,jsonb,text)','public.create_brand_from_project_name(uuid,uuid,integer,text,boolean,text)'] loop
 d:=pg_get_functiondef(sig::regprocedure);
 if position($needle$in('generated','local_import')$needle$ in d)=0 then raise exception 'brainstorm_root_predecessor';end if;
 d:=replace(d,$needle$in('generated','local_import')$needle$,$needle$in('generated','local_import','brainstorm')$needle$);
 if sig='public.create_brand_from_project_name(uuid,uuid,integer,text,boolean,text)' then
  if (length(d)-length(replace(d,$needle$v_root->>'kind'='generated' and jsonb_array_length(v_history)=0$needle$, '')))/length($needle$v_root->>'kind'='generated' and jsonb_array_length(v_history)=0$needle$)<>1 then raise exception 'brainstorm_copy_authorship_predecessor';end if;
  d:=replace(d,$needle$v_root->>'kind'='generated' and jsonb_array_length(v_history)=0$needle$,
   $patch$(v_root->>'kind'='generated' or (v_root->>'kind'='brainstorm' and v_root->>'profile'='brainstorm_v1' and v_root->'version'='1'::jsonb)) and jsonb_array_length(v_history)=0$patch$);
 end if;
 execute d;
 end loop;end $roots$;
create table fluid_private.naming_brainstorm_calls(
 call_id uuid primary key default gen_random_uuid(),run_id uuid not null,owner_id uuid not null,project_id uuid not null,
 call_index integer not null check(call_index between 1 and 3),candidate_target integer not null check(candidate_target between 1 and 120),
 request jsonb not null check(jsonb_typeof(request)='object' and octet_length(request::text)<=131072),
 created_at timestamptz not null default clock_timestamp(),unique(run_id,call_index),
 foreign key(run_id,owner_id,project_id) references fluid_private.naming_brain_runs(id,owner_id,project_id));
create table fluid_private.naming_brainstorm_events(
 event_id uuid primary key default gen_random_uuid(),call_id uuid not null references fluid_private.naming_brainstorm_calls(call_id),
 kind text not null check(kind in('created','completed','rejected','unknown')),payload jsonb not null check(octet_length(payload::text)<=1048576),
 created_at timestamptz not null default clock_timestamp(),unique(call_id,payload));
create table fluid_private.naming_brainstorm_publications(
 call_id uuid primary key references fluid_private.naming_brainstorm_calls(call_id),run_id uuid not null,
 owner_id uuid not null,project_id uuid not null,candidate_ids jsonb not null,created_at timestamptz not null default clock_timestamp(),
 foreign key(run_id,owner_id,project_id) references fluid_private.naming_brain_runs(id,owner_id,project_id));
create table fluid_private.naming_brainstorm_completions(
 id uuid primary key default gen_random_uuid(),run_id uuid not null unique,owner_id uuid not null,project_id uuid not null,
 published_count integer not null check(published_count between 0 and 100),state text not null check(state in('succeeded','partial','failed','cancelled')),
 created_at timestamptz not null default clock_timestamp(),
 foreign key(run_id,owner_id,project_id) references fluid_private.naming_brain_runs(id,owner_id,project_id),check(state<>'succeeded' or published_count=100));
do $tables$ declare t text;begin
 foreach t in array array['naming_brainstorm_calls','naming_brainstorm_events','naming_brainstorm_publications','naming_brainstorm_completions'] loop
 execute format('alter table fluid_private.%I enable row level security',t);
 execute format('alter table fluid_private.%I force row level security',t);
 execute format('create trigger brainstorm_history_immutable before update or delete on fluid_private.%I for each row execute function fluid_private.prevent_history_change()',t);
 execute format('revoke all on table fluid_private.%I from public,anon,authenticated,service_role',t);
 end loop;end $tables$;
create function fluid_private.naming_brainstorm_job(p_job uuid) returns boolean language sql stable set search_path='' as $$
 select exists(select 1 from public.jobs j where j.id=p_job and j.input->>'generationProfile'='brainstorm_v1' and fluid_private.shared_naming_job(j.id));$$;
-- Clone the verified admission algorithm and add the marker before the frozen
-- jobs INSERT. All owner/head/idempotency/snapshot/policy/admission checks stay.
do $admit$ declare d text;n text:='select batch_sequence+1 into sequence from public.naming_sessions where project_id=p.id;';begin
 d:=pg_get_functiondef('fluid_private.shared_naming_ensure_core(uuid,jsonb)'::regprocedure);
 if (length(d)-length(replace(d,n,'')))/length(n)<>1 then raise exception 'brainstorm_admission_predecessor'; end if;
 d:=replace(d,'FUNCTION fluid_private.shared_naming_ensure_core(','FUNCTION fluid_private.shared_naming_brainstorm_ensure_core(');
 execute replace(d,n,$patch$input:=input||jsonb_build_object('generationProfile','brainstorm_v1');
 $patch$||n);
 d:=pg_get_functiondef('public.ensure_shared_naming_brain_run(uuid,jsonb)'::regprocedure);
 d:=replace(d,'FUNCTION public.ensure_shared_naming_brain_run(','FUNCTION public.ensure_shared_naming_brainstorm_run(');
 if position('fluid_private.shared_naming_ensure_core(p_project_id,p_intent)' in d)=0 then raise exception 'brainstorm_admission_facade_predecessor';end if;
 execute replace(d,'fluid_private.shared_naming_ensure_core(p_project_id,p_intent)','fluid_private.shared_naming_brainstorm_ensure_core(p_project_id,p_intent)');
end $admit$;
create function fluid_private.naming_brainstorm_call_state(c fluid_private.naming_brainstorm_calls) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('callId',c.call_id,'request',c.request,'candidateTarget',c.candidate_target,
 'state',coalesce((select kind from fluid_private.naming_brainstorm_events where call_id=c.call_id order by case when kind in('completed','rejected') then 0 else 1 end,created_at desc,event_id desc limit 1),'prepared'),
 'responseId',(select payload->>'responseId' from fluid_private.naming_brainstorm_events where call_id=c.call_id and payload->>'responseId' is not null order by created_at limit 1),
 'requestId',(select payload->>'requestId' from fluid_private.naming_brainstorm_events where call_id=c.call_id and payload->>'requestId' is not null order by created_at limit 1),
 'candidates',coalesce((select payload->'candidates' from fluid_private.naming_brainstorm_events where call_id=c.call_id and kind='completed' limit 1),'[]'),
 'usage',(select payload->'usage' from fluid_private.naming_brainstorm_events where call_id=c.call_id and kind='completed' limit 1));$$;
create function fluid_private.naming_brainstorm_state(r fluid_private.naming_brain_runs) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('generationProfile','brainstorm_v1','runId',r.id,'brief',r.snapshot,
 'historyEpoch',(select writer_epoch from fluid_private.naming_brain_heads where project_id=r.project_id and owner_id=r.owner_id),
 'history',coalesce((select jsonb_agg(jsonb_build_object('candidateId',id,'value',value) order by id) from public.name_candidates where owner_id=r.owner_id and project_id=r.project_id),'[]'),
 'exclusionIdentities',coalesce((select jsonb_agg(distinct identity_key) from(select identity_key from public.name_candidates where owner_id=r.owner_id and project_id=r.project_id union select identity_key from fluid_private.naming_brain_identity_index where owner_id=r.owner_id and project_id=r.project_id) history),'[]'),
 'publishedCount',(select count(*) from fluid_private.naming_brain_feed_entries where run_id=r.id),
 'calls',coalesce((select jsonb_agg(fluid_private.naming_brainstorm_call_state(c) order by c.call_index) from fluid_private.naming_brainstorm_calls c where c.run_id=r.id),'[]'));$$;
-- Separate witness: no fabricated research/curator artifacts or progressive result.
do $summary$ declare d text;begin
 d:=pg_get_functiondef('fluid_private.naming_brain_summary(fluid_private.naming_brain_runs)'::regprocedure);
 execute replace(d,'FUNCTION fluid_private.naming_brain_summary(','FUNCTION fluid_private.naming_brainstorm_previous_summary(');
 d:=pg_get_functiondef('fluid_private.naming_brain_ensure_response(fluid_private.naming_brain_runs,boolean)'::regprocedure);
 execute replace(d,'FUNCTION fluid_private.naming_brain_ensure_response(','FUNCTION fluid_private.naming_brainstorm_previous_ensure_response(');
 d:=pg_get_functiondef('fluid_private.naming_brain_no_dispatch(uuid)'::regprocedure);
 execute replace(d,'FUNCTION fluid_private.naming_brain_no_dispatch(','FUNCTION fluid_private.naming_brainstorm_previous_no_dispatch(');
end $summary$;
create or replace function fluid_private.naming_brain_no_dispatch(p_job uuid) returns boolean language sql stable set search_path='' as $$
 select fluid_private.naming_brainstorm_previous_no_dispatch(p_job) and not exists(select 1 from fluid_private.naming_brainstorm_calls c join fluid_private.naming_brain_runs r on r.id=c.run_id where r.job_id=p_job);$$;
create or replace function fluid_private.naming_brain_summary(r fluid_private.naming_brain_runs) returns jsonb language plpgsql stable set search_path='' as $$
 declare result jsonb;j public.jobs;total integer;covered boolean;completion fluid_private.naming_brainstorm_completions;begin
 result:=fluid_private.naming_brainstorm_previous_summary(r);
 if not fluid_private.naming_brainstorm_job(r.job_id) then return result;end if;
 select * into strict j from public.jobs where id=r.job_id;
 select count(*) into total from fluid_private.naming_brain_feed_entries where run_id=r.id;
 select * into completion from fluid_private.naming_brainstorm_completions where run_id=r.id;
 covered:=not exists(select 1 from jsonb_array_elements_text(r.snapshot#>'{preferences,approaches}') selected(approach)
  where (select count(*) from fluid_private.naming_brain_feed_entries f where f.run_id=r.id and f.metadata->>'primaryApproach'=selected.approach)<5);
 return (result-'progressiveCompletionId')||jsonb_build_object('generationProfile','brainstorm_v1','canResume',false,'canResumeSaved',false,
 'state',case when r.superseded then 'superseded' else j.state end,'progress',total,'preparedSetId',null,
 'fulfillment',jsonb_build_object('status',case when total=100 and covered then 'complete' when total=0 then 'none' else 'partial' end,
 'targetCount',100,'acceptedCount',total,'missingCount',100-total,'coverageSatisfied',covered,
 'message',case when total=100 and covered then null when total=100 then '100 of 100 unchecked brainstorm names are saved. Some selected approaches have fewer than five names.' else total::text||' of 100 unchecked brainstorm names are saved.' end))
 ||case when completion.id is not null and completion.state='succeeded' and completion.published_count=100 and not r.superseded and j.state='succeeded' then jsonb_build_object('brainstormCompletionId',completion.id) else '{}'::jsonb end;
end $$;
create or replace function fluid_private.naming_brain_ensure_response(r fluid_private.naming_brain_runs,p_reused boolean) returns jsonb language plpgsql set search_path='' as $$
 declare summary jsonb;begin
 if not fluid_private.naming_brainstorm_job(r.job_id) then return fluid_private.naming_brainstorm_previous_ensure_response(r,p_reused);end if;
 summary:=fluid_private.naming_brain_summary(r);
 if summary->>'state' in('queued','running','cancel_requested') then return jsonb_build_object('status','pending','feed',public.get_naming_feed(r.project_id),'run',summary,'reused',p_reused);end if;
 if exists(select 1 from fluid_private.naming_brainstorm_completions where run_id=r.id and state='succeeded') then
 return jsonb_build_object('status','appended','feed',public.get_naming_feed(r.project_id),'runId',r.id,'appendedEntryIds',(select jsonb_agg(id order by position) from fluid_private.naming_brain_feed_entries where run_id=r.id));end if;
 if summary->>'state' in('partial','failed','cancelled') then return jsonb_build_object('status','incomplete','feed',public.get_naming_feed(r.project_id),'run',summary,'fulfillment',summary->'fulfillment','message','Your saved names and unfinished work are retained.','canResume',false);end if;
 return jsonb_build_object('status','blocked','feed',public.get_naming_feed(r.project_id),'code','dispatch_unresolved','message','The current provider outcome is still being resolved.','action','resolve');
end $$;
-- Historical gateway is byte-for-byte cloned; new profile has a finite surface.
do $gateway$ declare d text;begin
 d:=pg_get_functiondef('public.shared_naming_worker_action(jsonb,jsonb,text,jsonb)'::regprocedure);
 execute replace(d,'FUNCTION public.shared_naming_worker_action(','FUNCTION fluid_private.naming_brainstorm_previous_worker_action(');
end $gateway$;
create or replace function public.shared_naming_worker_action(p_slot jsonb,p_execution jsonb,p_action text,p_args jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare e fluid_private.shared_worker_executions;r fluid_private.naming_brain_runs;j public.jobs;h fluid_private.naming_brain_heads;
 c fluid_private.naming_brainstorm_calls;ev fluid_private.naming_brainstorm_events;old jsonb;result jsonb;payload jsonb;raw jsonb;item jsonb;
 total integer;idx integer;target integer;ids jsonb:='[]';candidate uuid;origin jsonb;next_state text;mode text:='active';response_id text;request_id text;
begin
 if p_action not in('brainstorm_state','brainstorm_begin','brainstorm_event','brainstorm_publish','brainstorm_finish') then
  if p_execution is not null and exists(select 1 from public.jobs where id=(p_execution->>'jobId')::uuid and input->>'generationProfile'='brainstorm_v1')
   and p_action not in('recover','assert_continue') and not(p_action='action' and p_args->>2='heartbeat') then raise exception 'brainstorm_profile_action_required' using errcode='42501';end if;
  return fluid_private.naming_brainstorm_previous_worker_action(p_slot,p_execution,p_action,p_args);
 end if;
 if jsonb_typeof(p_args) is distinct from 'object' or octet_length(p_args::text)>1048576 or p_execution is null then raise exception 'invalid_brainstorm_action' using errcode='22023';end if;
 if p_action in('brainstorm_state','brainstorm_event','brainstorm_finish') then mode:='observe';end if;
 e:=fluid_private.shared_worker_execution(p_slot,p_execution,mode);
 if e.lane<>'naming' or not fluid_private.naming_brainstorm_job(e.job_id) then raise exception 'brainstorm_profile_required' using errcode='42501';end if;
 perform fluid_private.enter_shared_worker_context(p_slot,p_execution,mode);
 perform fluid_private.lock_strategy_owner(e.owner_id);
 select * into strict r from fluid_private.naming_brain_runs where job_id=e.job_id for update;
 select * into strict j from public.jobs where id=e.job_id for update;
 select * into strict h from fluid_private.naming_brain_heads where project_id=r.project_id and owner_id=r.owner_id for update;
 select count(*) into total from fluid_private.naming_brain_feed_entries where run_id=r.id;
 if p_action in('brainstorm_begin','brainstorm_publish') and (j.state<>'running' or j.cancel_requested_at is not null or r.recovery_mode<>'execute'
 or r.superseded or h.paused or h.current_run_id is distinct from r.id or not fluid_private.naming_brain_ready(r,j.worker_id)
 or h.steering_revision is distinct from (r.snapshot->>'steeringRevision')::integer
 or (select preferences_version from public.naming_sessions where project_id=r.project_id) is distinct from (r.snapshot->>'preferencesVersion')::integer
 or not exists(select 1 from public.projects p join public.project_revisions rev on rev.project_id=p.id and rev.owner_id=p.owner_id and rev.revision=p.current_revision
 where p.id=r.project_id and p.owner_id=r.owner_id and p.deleted_at is null and p.deletion_requested_at is null and fluid_private.naming_strategy_basis(rev.context)=r.snapshot->'strategyBasis'))
 then raise exception 'brainstorm_dispatch_closed' using errcode='42501';end if;
 if p_action='brainstorm_state' then
  if p_args<>'{}' then raise exception 'invalid_brainstorm_state';end if;
  if (select count(*) from public.name_candidates where owner_id=r.owner_id and project_id=r.project_id)>10000 then raise exception 'naming_history_capacity' using errcode='54000';end if;
  result:=fluid_private.naming_brainstorm_state(r);
 elsif p_action='brainstorm_begin' then
  idx:=(p_args->>'callIndex')::integer;target:=(p_args->>'candidateTarget')::integer;payload:=p_args->'request';
  if not(p_args ?& array['callIndex','candidateTarget','request','historyIdentities','expectedHistoryEpoch']) or p_args-array['callIndex','candidateTarget','request','historyIdentities','expectedHistoryEpoch']<>'{}' or idx not between 1 and 3 or target not between 1 and 120
   or jsonb_typeof(payload) is distinct from 'object' or payload->>'model' is distinct from r.policy->>'model'
   or payload->'store' is distinct from 'true'::jsonb or payload->'stream' is distinct from 'true'::jsonb
   or payload->'reasoning' is distinct from '{"effort":"low"}'::jsonb or coalesce(payload->'tools','[]')<>'[]'
   or payload ? 'previous_response_id' or payload ? 'conversation' or payload ? 'service_tier'
   or payload#>>'{metadata,embel_generation_profile}' is distinct from 'brainstorm_v1'
   or payload#>>'{metadata,embel_job_id}' is distinct from j.id::text or payload#>>'{metadata,embel_run_id}' is distinct from r.id::text
   or payload#>>'{metadata,embel_call_index}' is distinct from idx::text or payload->>'max_output_tokens' is distinct from '16000'
   or payload#>>'{text,format,type}' is distinct from 'json_schema' or payload#>'{text,format,strict}' is distinct from 'true'::jsonb
   or octet_length(payload::text)>131072 then raise exception 'invalid_brainstorm_request' using errcode='22023';end if;
  if jsonb_typeof(p_args->'historyIdentities') is distinct from 'array' or jsonb_array_length(p_args->'historyIdentities')>10000
   or (p_args->>'expectedHistoryEpoch')::bigint is distinct from h.writer_epoch
   or jsonb_array_length(p_args->'historyIdentities')<>(select count(*) from public.name_candidates where owner_id=r.owner_id and project_id=r.project_id)
   or exists(select 1 from jsonb_array_elements(p_args->'historyIdentities') x group by x->>'candidateId' having count(*)>1)
   or exists(select 1 from jsonb_array_elements(p_args->'historyIdentities') x where
    not(x ?& array['candidateId','value','identityKey']) or x-array['candidateId','value','identityKey']<>'{}'
    or jsonb_typeof(x->'identityKey') is distinct from 'string' or length(x->>'identityKey')>320
    or not exists(select 1 from public.name_candidates c0 where c0.id=(x->>'candidateId')::uuid and c0.owner_id=r.owner_id and c0.project_id=r.project_id and c0.value=x->>'value')
    or exists(select 1 from fluid_private.naming_brain_identity_index ix where ix.candidate_id=(x->>'candidateId')::uuid and ix.identity_key<>x->>'identityKey'))
   then raise exception 'brainstorm_history_attestation_required' using errcode='PT409';end if;
  insert into fluid_private.naming_brain_identity_index(candidate_id,owner_id,project_id,value,identity_key)
   select (x->>'candidateId')::uuid,r.owner_id,r.project_id,x->>'value',x->>'identityKey' from jsonb_array_elements(p_args->'historyIdentities') x on conflict(candidate_id) do nothing;
  update fluid_private.naming_brain_heads set coverage_epoch=writer_epoch where project_id=r.project_id;
  select * into c from fluid_private.naming_brainstorm_calls where run_id=r.id and call_index=idx;
  if found then
   if c.request<>payload or c.candidate_target<>target then raise exception 'immutable_brainstorm_request' using errcode='55000';end if;
   old:=fluid_private.naming_brainstorm_call_state(c);
   result:=jsonb_build_object('callId',c.call_id,'request',c.request,'responseId',old->'responseId','dispatch',case when old->>'responseId' is not null then 'retrieve' else 'quarantined' end);
  else
   if total>=100 or exists(select 1 from fluid_private.naming_brainstorm_completions where run_id=r.id)
    or idx<>(select count(*)+1 from fluid_private.naming_brainstorm_calls where run_id=r.id)
    or (idx=1 and target<>120) or (idx>1 and target<>least(60,100-total+20))
    or exists(select 1 from fluid_private.naming_brainstorm_calls prior where prior.run_id=r.id and
     (fluid_private.naming_brainstorm_call_state(prior)->>'state' not in('completed','rejected')
      or not exists(select 1 from fluid_private.naming_brainstorm_publications pub where pub.call_id=prior.call_id) and fluid_private.naming_brainstorm_call_state(prior)->>'state'='completed'))
    then raise exception 'brainstorm_dispatch_not_admissible' using errcode='55000';end if;
   insert into fluid_private.naming_brainstorm_calls(run_id,owner_id,project_id,call_index,candidate_target,request) values(r.id,r.owner_id,r.project_id,idx,target,payload) returning * into c;
   result:=jsonb_build_object('callId',c.call_id,'request',c.request,'responseId',null,'dispatch','create');
  end if;
 elsif p_action='brainstorm_event' then
  select * into strict c from fluid_private.naming_brainstorm_calls where call_id=(p_args->>'callId')::uuid and run_id=r.id;
  if p_args->>'kind' not in('created','completed','rejected','unknown') or p_args->>'kind' is null
   or jsonb_typeof(p_args->'observedAt') is distinct from 'string' or length(p_args->>'observedAt')>64
   or p_args-array['callId','kind','observedAt','responseId','requestId','candidates','usage','response','model','errorCode']<>'{}'
   then raise exception 'invalid_brainstorm_event' using errcode='22023';end if;
  old:=fluid_private.naming_brainstorm_call_state(c);response_id:=p_args->>'responseId';
  if old->>'responseId' is not null and response_id is not null and old->>'responseId'<>response_id then raise exception 'brainstorm_response_identity_conflict';end if;
  if exists(select 1 from fluid_private.naming_brainstorm_events where call_id=c.call_id and kind in('completed','rejected')) then
   if not exists(select 1 from fluid_private.naming_brainstorm_events where call_id=c.call_id and payload=p_args) then raise exception 'immutable_brainstorm_terminal_event';end if;
  else
   if p_args->>'kind' in('created','completed') and (coalesce(length(response_id),0) not between 1 and 300) then raise exception 'brainstorm_response_id_required';end if;
   if p_args->>'kind'='completed' then
    if p_args#>>'{response,id}' is distinct from response_id or p_args#>>'{response,status}' not in('completed','failed','incomplete','cancelled')
     or p_args#>>'{response,model}' is distinct from r.policy->>'model' or jsonb_typeof(p_args->'candidates') is distinct from 'array'
     or jsonb_array_length(p_args->'candidates')>c.candidate_target then raise exception 'invalid_brainstorm_completed_response';end if;
    if jsonb_array_length(p_args->'candidates')>0 then
    if p_args#>>'{response,status}'<>'completed' then raise exception 'brainstorm_noncompleted_candidates';end if;
    select string_agg(content->>'text','' order by oi,ci)::jsonb into raw
     from jsonb_array_elements(p_args#>'{response,output}') with ordinality output(item,oi)
     cross join lateral jsonb_array_elements(output.item->'content') with ordinality parts(content,ci)
     where output.item->>'type'='message' and output.item->>'role'='assistant' and content->>'type'='output_text';
    if jsonb_typeof(raw->'candidates') is distinct from 'array' or jsonb_array_length(raw->'candidates')>c.candidate_target then raise exception 'invalid_brainstorm_structured_output';end if;
    for item in select value from jsonb_array_elements(p_args->'candidates') loop
     if not exists(select 1 from jsonb_array_elements(raw->'candidates') source where normalize(btrim(source->>'value'),NFC)=item->>'value'
       and btrim(source->>'rationale')=item->>'rationale' and source->>'primaryApproach'=item->>'primaryApproach')
      then raise exception 'brainstorm_candidate_source_mismatch';end if;
    end loop;
    end if;
   end if;
   insert into fluid_private.naming_brainstorm_events(call_id,kind,payload) values(c.call_id,p_args->>'kind',p_args) on conflict do nothing;
  end if;
  result:=fluid_private.naming_brainstorm_call_state(c);
 elsif p_action='brainstorm_publish' then
  if p_args-array['callId']<>'{}' then raise exception 'invalid_brainstorm_publication';end if;
  select * into strict c from fluid_private.naming_brainstorm_calls where call_id=(p_args->>'callId')::uuid and run_id=r.id;
  select * into ev from fluid_private.naming_brainstorm_events where call_id=c.call_id and kind='completed';
  if ev.event_id is null then raise exception 'brainstorm_completed_response_required';end if;
  if not exists(select 1 from fluid_private.naming_brainstorm_publications where call_id=c.call_id) then
   if h.coverage_epoch is distinct from h.writer_epoch then raise exception 'identity_coverage_incomplete' using errcode='PT409';end if;
   for item in select value from jsonb_array_elements(ev.payload->'candidates') loop
    exit when total>=100;
    -- ICU grapheme/identity derivations come from the qualified shared runtime;
    -- SQL binds them to actual response text and enforces frozen limits/history.
    if not(item ?& array['value','identityKey','rationale','caution','primaryApproach','graphemeCount']) or item-array['value','identityKey','rationale','caution','primaryApproach','graphemeCount']<>'{}'
     or jsonb_typeof(item->'value') is distinct from 'string' or length(item->>'value') not between 1 and 160
     or normalize(btrim(item->>'value'),NFC)<>item->>'value' or item->>'value' ~ '[[:cntrl:]]'
     or coalesce(length(item->>'identityKey'),0) not between 1 and 320
     or coalesce(length(btrim(item->>'rationale')),0) not between 1 and 600 or item->>'rationale' ~ '[[:cntrl:]]'
     or item->>'caution' is distinct from 'Unchecked brainstorm. Research and screening are needed before use.'
     or jsonb_typeof(item->'primaryApproach') is distinct from 'string' or not(r.snapshot#>'{preferences,approaches}' ? (item->>'primaryApproach'))
     or jsonb_typeof(item->'graphemeCount') is distinct from 'number' or (item->>'graphemeCount')::integer not between 1 and 100
     or (item->>'graphemeCount')::integer<coalesce((r.snapshot#>>'{preferences,minimumGraphemes}')::integer,1)
     or (item->>'graphemeCount')::integer>coalesce((r.snapshot#>>'{preferences,maximumGraphemes}')::integer,100)
     then raise exception 'invalid_brainstorm_candidate';end if;
    if exists(select 1 from jsonb_array_elements_text(r.snapshot#>'{preferences,requiredText}') fragment where position(normalize(lower(normalize(fragment,NFC)),NFC) in normalize(lower(item->>'value'),NFC))=0)
     or exists(select 1 from jsonb_array_elements_text(r.snapshot#>'{preferences,excludedText}') fragment where position(normalize(lower(normalize(fragment,NFC)),NFC) in normalize(lower(item->>'value'),NFC))>0)
     or exists(select 1 from public.name_candidates where owner_id=r.owner_id and project_id=r.project_id and identity_key=item->>'identityKey')
     or exists(select 1 from fluid_private.naming_brain_identity_index where owner_id=r.owner_id and project_id=r.project_id and identity_key=item->>'identityKey') then continue;end if;
    candidate:=gen_random_uuid();
    origin:=jsonb_build_object('kind','brainstorm','version',1,'profile','brainstorm_v1','ownerId',r.owner_id,'projectId',r.project_id,'candidateId',candidate,
     'contextRevision',(r.snapshot->>'contextRevision')::integer,'value',item->>'value','batchId',r.batch_id,'jobId',r.job_id,'runId',r.id,'callId',c.call_id,
     'responseId',ev.payload->>'responseId','requestId',ev.payload->>'requestId','model',r.policy->>'model','generatedAt',ev.payload->>'observedAt');
    insert into public.name_candidates(id,owner_id,project_id,value,identity_key,context_revision,strategy_basis,origin,rationale,caution,batch_id)
     values(candidate,r.owner_id,r.project_id,item->>'value',item->>'identityKey',(r.snapshot->>'contextRevision')::integer,r.snapshot->'strategyBasis',origin,item->>'rationale',item->>'caution',r.batch_id);
    insert into fluid_private.naming_brain_identity_index(candidate_id,owner_id,project_id,value,identity_key) values(candidate,r.owner_id,r.project_id,item->>'value',item->>'identityKey');
    insert into fluid_private.naming_brain_feed_entries(owner_id,project_id,run_id,candidate_id,position,steering_revision,metadata)
     values(r.owner_id,r.project_id,r.id,candidate,h.next_position,h.steering_revision,jsonb_build_object('primaryApproach',item->>'primaryApproach','additionalApproaches','[]'::jsonb,'publishedClaims','[]'::jsonb));
    ids:=ids||to_jsonb(candidate);h.next_position:=h.next_position+1;total:=total+1;
   end loop;
   insert into fluid_private.naming_brainstorm_publications(call_id,run_id,owner_id,project_id,candidate_ids) values(c.call_id,r.id,r.owner_id,r.project_id,ids);
   update fluid_private.naming_brain_heads set next_position=h.next_position,coverage_epoch=writer_epoch where project_id=r.project_id;
   update public.jobs set progress=total where id=j.id;
   update fluid_private.naming_brain_runs set revision=revision+1,updated_at=clock_timestamp() where id=r.id;
  end if;
  result:=jsonb_build_object('publishedCount',total,'insertedCount',jsonb_array_length(ids));
 elsif p_action='brainstorm_finish' then
  if p_args<>'{}' then raise exception 'invalid_brainstorm_finish';end if;
  if exists(select 1 from fluid_private.naming_brainstorm_calls call where call.run_id=r.id and (fluid_private.naming_brainstorm_call_state(call)->>'state' not in('completed','rejected')
    or fluid_private.naming_brainstorm_call_state(call)->>'state'='completed' and jsonb_array_length(fluid_private.naming_brainstorm_call_state(call)->'candidates')>0 and not exists(select 1 from fluid_private.naming_brainstorm_publications pub where pub.call_id=call.call_id))) then
   next_state:='needs_reconciliation';
  elsif j.cancel_requested_at is not null or h.paused then next_state:='cancelled';
  elsif total=100 then next_state:='succeeded';
  elsif (select count(*) from fluid_private.naming_brainstorm_calls where run_id=r.id)<3 and j.state='running' and r.recovery_mode='execute' and not r.superseded and not exists(select 1 from fluid_private.naming_brainstorm_events rejected_event join fluid_private.naming_brainstorm_calls rejected_call using(call_id) where rejected_call.run_id=r.id and rejected_event.kind='rejected') then
   raise exception 'brainstorm_topups_remaining' using errcode='55000';
  elsif total>0 then next_state:='partial';else next_state:='failed';end if;
  if not exists(select 1 from fluid_private.naming_brainstorm_completions where run_id=r.id) then
   if next_state<>'needs_reconciliation' then
    insert into fluid_private.naming_brainstorm_completions(run_id,owner_id,project_id,published_count,state) values(r.id,r.owner_id,r.project_id,total,next_state);
   end if;
   update public.jobs set state=next_state,progress=total,lease_token=null,lease_expires_at=null,
    error_code=case when next_state='needs_reconciliation' then 'provider_outcome_unknown' when next_state='partial' then 'brainstorm_target_shortfall' else null end,
    finished_at=case when next_state='needs_reconciliation' then null else clock_timestamp() end where id=j.id;
   update fluid_private.naming_brain_runs set revision=revision+1,updated_at=clock_timestamp(),recovery_mode='observe_only' where id=r.id;
   -- Cost remains unknown after every possibly dispatched call. Only real
   -- independent financial evidence can settle it; no token-to-dollar fiction.
   if not exists(select 1 from fluid_private.naming_brainstorm_calls where run_id=r.id) then perform fluid_private.settle_reservation(j.id);end if;
  else select state into next_state from fluid_private.naming_brainstorm_completions where run_id=r.id;end if;
  result:=jsonb_build_object('state',next_state,'publishedCount',total);
 end if;
 perform fluid_private.leave_shared_worker_context();
 if p_action='brainstorm_finish' then
  if next_state='needs_reconciliation' then perform fluid_private.park_shared_worker_execution(p_slot,p_execution);
  else perform fluid_private.close_shared_worker_execution(p_slot,p_execution);end if;
 end if;
 return jsonb_build_object('execution',fluid_private.shared_worker_execution_json(e),'result',result);
end $$;
create function public.get_naming_brainstorm_sources(p_project_id uuid,p_candidate_ids uuid[]) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb;begin
 if auth.uid() is null or cardinality(p_candidate_ids)>100 or not exists(select 1 from public.projects where id=p_project_id and owner_id=auth.uid()) then raise exception 'not_found' using errcode='P0002';end if;
 select coalesce(jsonb_agg(jsonb_build_object('ownerId',c.owner_id,'projectId',c.project_id,'candidateId',c.id,'runId',r.id,'jobId',r.job_id,'batchId',r.batch_id,
 'callId',call.call_id,'responseId',ev.payload->>'responseId','requestId',ev.payload->>'requestId','model',r.policy->>'model','generatedAt',ev.payload->>'observedAt',
 'value',c.value,'identityKey',c.identity_key,'rationale',c.rationale,'snapshot',r.snapshot,'profile','brainstorm_v1') order by c.id),'[]') into result
 from public.name_candidates c join fluid_private.naming_brain_runs r on r.id=(c.origin->>'runId')::uuid and (r.owner_id,r.project_id,r.batch_id)=(c.owner_id,c.project_id,c.batch_id)
 join fluid_private.naming_brainstorm_calls call on call.call_id=(c.origin->>'callId')::uuid and call.run_id=r.id
 join fluid_private.naming_brainstorm_events ev on ev.call_id=call.call_id and ev.kind='completed'
 join fluid_private.naming_brainstorm_publications pub on pub.call_id=call.call_id and pub.candidate_ids ? c.id::text
 where c.id=any(p_candidate_ids) and c.owner_id=auth.uid() and c.project_id=p_project_id and c.origin->>'kind'='brainstorm' and fluid_private.naming_brainstorm_job(r.job_id);
 if jsonb_array_length(result)<>(select count(distinct x) from unnest(p_candidate_ids) x) then raise exception 'invalid_brainstorm_source' using errcode='55000';end if;
 return result;
end $$;
-- Clear hostile default ACLs on every newly created private function/table.
do $acl$ declare f record;a record;t record;begin
 for f in select p.oid,p.proowner,p.proacl from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='fluid_private' and (p.proname like 'naming_brainstorm_%' or p.proname='shared_naming_brainstorm_ensure_core')
 or n.nspname='public' and p.proname in('ensure_shared_naming_brainstorm_run','get_naming_brainstorm_sources') loop
 for a in select distinct acl.grantee,r.rolname from aclexplode(coalesce(f.proacl,acldefault('f',f.proowner))) acl left join pg_roles r on r.oid=acl.grantee where acl.grantee<>f.proowner loop
 execute format('revoke all on function %s from %s',f.oid::regprocedure,case when a.grantee=0 then 'PUBLIC' else quote_ident(a.rolname) end);
 end loop;end loop;
 for t in select c.oid,c.relowner,c.relacl from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='fluid_private' and c.relname in('naming_brainstorm_calls','naming_brainstorm_events','naming_brainstorm_publications','naming_brainstorm_completions') loop
  for a in select distinct acl.grantee,r.rolname from aclexplode(coalesce(t.relacl,acldefault('r',t.relowner))) acl left join pg_roles r on r.oid=acl.grantee where acl.grantee<>t.relowner loop
   execute format('revoke all on table %s from %s',t.oid::regclass,case when a.grantee=0 then 'PUBLIC' else quote_ident(a.rolname) end);
  end loop;
 end loop;
end $acl$;
grant execute on function public.ensure_shared_naming_brainstorm_run(uuid,jsonb),public.get_naming_brainstorm_sources(uuid,uuid[]) to authenticated;
commit;
