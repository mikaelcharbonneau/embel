-- Naming Brain source candidate. No login, grant to a live worker, funding,
-- enabled policy, deployment or provider call is provisioned by this migration.
begin;

create function fluid_private.naming_brain_is_job(j public.jobs) returns boolean
language sql immutable set search_path='' as $$
 select j.operation='naming.generate' and j.billing_mode='openai_api'
 and j.input->'version'='2'::jsonb and j.input->>'handlerVersion'='naming-brain-v1';
$$;
create function fluid_private.naming_brain_stages() returns text[] language sql immutable set search_path='' as $$
 select array['research','direction','creation','curation','verification','gap','prepare'];
$$;
create function fluid_private.naming_brain_cap(p_stage text) returns bigint language sql immutable set search_path='' as $$
 select case p_stage when 'research' then 750000 when 'direction' then 250000 when 'creation' then 1500000 when 'curation' then 500000 when 'verification' then 1250000 when 'gap' then 750000 when 'prepare' then 0 end::bigint;
$$;
create function fluid_private.naming_brain_valid_policy(p jsonb) returns boolean language sql immutable set search_path='' as $$
 select coalesce(p->>'model'<>'' and length(p->>'model')<=150 and p = jsonb_build_object(
 'version',1,'handlerVersion','naming-brain-v1','billingMode','openai_api','protocol','openai_agents','model',p->>'model','reasoningEffort','xhigh',
 'runAllowanceMicrousd',5000000,'aggregateAllowanceMicrousd',25000000,'maxUnsettledRuns',5,'maxConcurrentCreators',3,'maxInitialCandidates',150,'maxGapCandidates',50,'maxGapRounds',1,
 'maxInputBytes',131072,'maxOutputBytes',524288,'stageDeadlineMs',240000,'stageLimits',jsonb_build_object(
 'research',jsonb_build_object('maximumCostMicrousd',750000,'maxWebSearchCalls',4),'direction',jsonb_build_object('maximumCostMicrousd',250000,'maxWebSearchCalls',0),
 'creation',jsonb_build_object('maximumCostMicrousd',1500000,'maxWebSearchCalls',0),'curation',jsonb_build_object('maximumCostMicrousd',500000,'maxWebSearchCalls',0),
 'verification',jsonb_build_object('maximumCostMicrousd',1250000,'maxWebSearchCalls',20),'gap',jsonb_build_object('maximumCostMicrousd',750000,'maxWebSearchCalls',8),'prepare',jsonb_build_object('maximumCostMicrousd',0,'maxWebSearchCalls',0))),false);
$$;

create table fluid_private.naming_brain_pilots (
 id uuid primary key default gen_random_uuid(), owner_id uuid not null unique references auth.users(id),
 role_name name not null, role_oid oid not null, deployment_id text not null check(length(deployment_id) between 1 and 200),
 policy jsonb not null check(fluid_private.naming_brain_valid_policy(policy)), enabled boolean not null default false,
 allowance_microusd bigint not null default 25000000 check(allowance_microusd=25000000), worker_id text, ready_until timestamptz
);
create table fluid_private.naming_brain_heads (
 project_id uuid primary key, owner_id uuid not null, feedback_revision integer not null default 0 check(feedback_revision>=0),
 steering_revision integer not null default 0 check(steering_revision>=0), demand_sequence integer not null default 0 check(demand_sequence>=0),
 strong_seed_ids jsonb not null default '[]', steering_instruction text, consumed_through jsonb, paused boolean not null default false, current_run_id uuid,
 writer_epoch bigint not null default 0, coverage_epoch bigint, next_position bigint not null default 1,
 unique(project_id,owner_id), foreign key(project_id,owner_id) references public.naming_sessions(project_id,owner_id)
);
create table fluid_private.naming_brain_runs (
 id uuid primary key default gen_random_uuid(), owner_id uuid not null, project_id uuid not null,
 job_id uuid not null unique, batch_id uuid not null unique, pilot_id uuid not null references fluid_private.naming_brain_pilots(id),
 admitted_role_name name not null, admitted_role_oid oid not null, deployment_id text not null,
 snapshot jsonb not null check(octet_length(snapshot::text)<=110000), snapshot_hash text not null check(snapshot_hash~'^[0-9a-f]{64}$'),
 policy jsonb not null check(fluid_private.naming_brain_valid_policy(policy)), policy_identity text not null check(policy_identity~'^[0-9a-f]{64}$'),
 gap_envelope jsonb not null default '{"version":1,"phases":[{"phase":"direction","cents":10,"searches":0},{"phase":"creation","cents":40,"searches":0},{"phase":"curation","cents":5,"searches":0},{"phase":"verification","cents":20,"searches":8}]}'::jsonb check(gap_envelope='{"version":1,"phases":[{"phase":"direction","cents":10,"searches":0},{"phase":"creation","cents":40,"searches":0},{"phase":"curation","cents":5,"searches":0},{"phase":"verification","cents":20,"searches":8}]}'::jsonb),
 gap_plan_identity text not null default encode(sha256(convert_to('{"version":1,"phases":[{"phase":"direction","cents":10,"searches":0},{"phase":"creation","cents":40,"searches":0},{"phase":"curation","cents":5,"searches":0},{"phase":"verification","cents":20,"searches":8}]}'::jsonb::text,'UTF8')),'hex') check(gap_plan_identity=encode(sha256(convert_to(gap_envelope::text,'UTF8')),'hex')),
 demand jsonb not null, demand_key text not null, demand_sequence integer not null, revision integer not null default 1,
 resumed_from_run_id uuid, resumed_from_revision integer, superseded boolean not null default false,
 recovery_mode text not null default 'execute' check(recovery_mode in('execute','observe_only')),
 observed_overrun boolean not null default false, actual_cost_microusd bigint check(actual_cost_microusd between 0 and 9007199254740991), settlement_evidence jsonb,
 created_at timestamptz not null default clock_timestamp(), updated_at timestamptz not null default clock_timestamp(),
 unique(id,owner_id,project_id), unique(owner_id,project_id,demand_key), unique(resumed_from_run_id,resumed_from_revision),
 foreign key(job_id,owner_id,project_id) references public.jobs(id,owner_id,project_id),
 foreign key(batch_id,owner_id,project_id) references public.naming_batches(id,owner_id,project_id),
 foreign key(resumed_from_run_id,owner_id,project_id) references fluid_private.naming_brain_runs(id,owner_id,project_id),
 check((actual_cost_microusd is null)=(settlement_evidence is null))
);
alter table fluid_private.naming_brain_heads add foreign key(current_run_id,owner_id,project_id) references fluid_private.naming_brain_runs(id,owner_id,project_id);
create index naming_brain_runs_owner_project on fluid_private.naming_brain_runs(owner_id,project_id,created_at desc,id);
create index naming_brain_runs_pilot on fluid_private.naming_brain_runs(pilot_id);
create table fluid_private.naming_brain_intents (
 owner_id uuid not null, project_id uuid not null, request_key text not null, kind text not null check(kind in('ensure','steer','stop')),
 request jsonb not null, run_id uuid, response jsonb, primary key(owner_id,request_key),
 foreign key(project_id,owner_id) references public.naming_sessions(project_id,owner_id),
 foreign key(run_id,owner_id,project_id) references fluid_private.naming_brain_runs(id,owner_id,project_id)
);
create table fluid_private.naming_brain_call_plans (
 run_id uuid not null, owner_id uuid not null, project_id uuid not null, stage_key text not null check(stage_key=any(fluid_private.naming_brain_stages())),
 phase_key text not null check((stage_key='gap' and phase_key in('direction','creation','curation','verification')) or (stage_key<>'gap' and phase_key='main')),
 calls jsonb not null check(jsonb_typeof(calls)='array' and jsonb_array_length(calls)<=60 and octet_length(calls::text)<=65536), primary key(run_id,stage_key,phase_key),
 foreign key(run_id,owner_id,project_id) references fluid_private.naming_brain_runs(id,owner_id,project_id)
);
create table fluid_private.naming_brain_calls (
 run_id uuid not null, owner_id uuid not null, project_id uuid not null, stage_key text not null, phase_key text not null, call_key text not null,
 request jsonb not null check(octet_length(request::text)<=131072), authorized_at timestamptz not null default clock_timestamp(),
 primary key(run_id,stage_key,call_key), foreign key(run_id,stage_key,phase_key) references fluid_private.naming_brain_call_plans(run_id,stage_key,phase_key),
 foreign key(run_id,owner_id,project_id) references fluid_private.naming_brain_runs(id,owner_id,project_id)
);
create table fluid_private.naming_brain_receipts (
 id uuid primary key default gen_random_uuid(), run_id uuid not null, owner_id uuid not null, project_id uuid not null,
 stage_key text not null, call_key text not null, receipt jsonb not null check(octet_length(receipt::text)<=524288),
 content_hash text not null, created_at timestamptz not null default clock_timestamp(), unique(run_id,content_hash),
 foreign key(run_id,stage_key,call_key) references fluid_private.naming_brain_calls(run_id,stage_key,call_key),
 foreign key(run_id,owner_id,project_id) references fluid_private.naming_brain_runs(id,owner_id,project_id)
);
create table fluid_private.naming_brain_artifacts (
 id uuid primary key, run_id uuid not null, owner_id uuid not null, project_id uuid not null,
 stage_key text not null, artifact jsonb not null check(octet_length(artifact::text)<=524288), receipt_id uuid not null references fluid_private.naming_brain_receipts(id),
 unique(id,owner_id,project_id), foreign key(run_id,owner_id,project_id) references fluid_private.naming_brain_runs(id,owner_id,project_id)
);
create table fluid_private.naming_brain_prepared_sets (
 id uuid primary key default gen_random_uuid(), run_id uuid not null unique, owner_id uuid not null, project_id uuid not null,
 prepared jsonb not null, publication jsonb not null, created_at timestamptz not null default clock_timestamp(),
 unique(id,owner_id,project_id), foreign key(run_id,owner_id,project_id) references fluid_private.naming_brain_runs(id,owner_id,project_id)
);
create table fluid_private.naming_brain_feed_entries (
 id uuid primary key default gen_random_uuid(), owner_id uuid not null, project_id uuid not null, run_id uuid, set_id uuid,
 candidate_id uuid not null, position bigint not null check(position>0), steering_revision integer not null, metadata jsonb not null default '{}',
 unique(project_id,position), unique(project_id,candidate_id),
 foreign key(candidate_id,owner_id,project_id) references public.name_candidates(id,owner_id,project_id),
 foreign key(run_id,owner_id,project_id) references fluid_private.naming_brain_runs(id,owner_id,project_id),
 foreign key(set_id,owner_id,project_id) references fluid_private.naming_brain_prepared_sets(id,owner_id,project_id)
);
create table fluid_private.naming_brain_identity_index (
 candidate_id uuid primary key, owner_id uuid not null, project_id uuid not null, value text not null, identity_key text not null check(length(identity_key)<=320),
 normalizer_version integer not null default 1 check(normalizer_version=1),
 foreign key(candidate_id,owner_id,project_id) references public.name_candidates(id,owner_id,project_id)
);
create index naming_brain_candidate_cursor on public.name_candidates(owner_id,project_id,id) include(value);
create index naming_brain_identity_lookup on fluid_private.naming_brain_identity_index(owner_id,project_id,identity_key);
create table fluid_private.naming_brain_financial_evidence (
 id uuid primary key default gen_random_uuid(), run_id uuid not null unique, owner_id uuid not null, project_id uuid not null,
 confirmed_total_microusd bigint not null check(confirmed_total_microusd between 0 and 9007199254740991), evidence jsonb not null check(octet_length(evidence::text)<=65536),
 foreign key(run_id,owner_id,project_id) references fluid_private.naming_brain_runs(id,owner_id,project_id)
);
-- Financial evidence has no worker/browser/model-tool writer. An independently
-- reviewed billing verification path is required; database no-dispatch proof is local.

alter table public.naming_batches add column engine_version integer not null default 1 check(engine_version in(1,2));
-- Legacy whole-row inserts need the new field explicitly; historical records
-- and every original target/count remain unchanged.
do $$ declare d text; needle text:='insert into public.naming_batches select (v_batch).*;'; begin
 d:=pg_get_functiondef('public.enqueue_subscription_naming_job(uuid,integer,integer,integer,text,text)'::regprocedure);
 if position(needle in d)=0 then raise exception 'unexpected_legacy_naming_admission'; end if;
 execute replace(d,needle,'v_batch.engine_version:=1; '||needle);
end $$;


create function fluid_private.naming_brain_worker_owner() returns uuid language sql stable security definer set search_path='' as $$
 select owner_id from fluid_private.naming_brain_pilots where role_name=session_user
 and fluid_private.api_text_restricted_role(role_name,role_oid);
$$;
create function fluid_private.naming_brain_run_worker(r fluid_private.naming_brain_runs) returns boolean language sql stable set search_path='' as $$
 select r.admitted_role_name=session_user and fluid_private.api_text_restricted_role(r.admitted_role_name,r.admitted_role_oid);
$$;
create function fluid_private.naming_brain_head(p_project uuid,p_owner uuid) returns fluid_private.naming_brain_heads language plpgsql set search_path='' as $$
 declare h fluid_private.naming_brain_heads; begin
 perform fluid_private.ensure_naming_session(p_project,p_owner);
 insert into fluid_private.naming_brain_heads(project_id,owner_id) values(p_project,p_owner) on conflict do nothing;
 select * into strict h from fluid_private.naming_brain_heads where project_id=p_project and owner_id=p_owner for update;
 return h; end $$;
create function fluid_private.naming_brain_candidate_epoch() returns trigger language plpgsql security definer set search_path='' as $$
 begin
 perform 1 from public.naming_sessions where project_id=new.project_id and owner_id=new.owner_id for update;
 insert into fluid_private.naming_brain_heads(project_id,owner_id) values(new.project_id,new.owner_id) on conflict do nothing;
 update fluid_private.naming_brain_heads set writer_epoch=writer_epoch+1,coverage_epoch=null where project_id=new.project_id and owner_id=new.owner_id;
 return new; end $$;
create trigger naming_brain_candidate_epoch after insert on public.name_candidates for each row execute function fluid_private.naming_brain_candidate_epoch();
create function fluid_private.naming_brain_feedback() returns trigger language plpgsql security definer set search_path='' as $$
 begin
 if (tg_op='INSERT' and new.liked) or (tg_op='UPDATE' and new.liked is distinct from old.liked) then
 insert into fluid_private.naming_brain_heads(project_id,owner_id) values(new.project_id,new.owner_id) on conflict do nothing;
 update fluid_private.naming_brain_heads set feedback_revision=feedback_revision+1 where project_id=new.project_id and owner_id=new.owner_id;
 end if; return new; end $$;
create trigger naming_brain_feedback after insert or update on public.name_retention for each row execute function fluid_private.naming_brain_feedback();

-- Preserve existing strict preference validation through a private copy.
do $$ declare d text; begin
 d:=pg_get_functiondef('fluid_private.valid_naming_preferences(jsonb)'::regprocedure);
 execute replace(d,'FUNCTION fluid_private.valid_naming_preferences(','FUNCTION fluid_private.naming_brain_legacy_preferences(');
end $$;
create or replace function fluid_private.valid_naming_preferences(p_value jsonb) returns boolean language plpgsql immutable set search_path='' as $$
 declare k text; v jsonb; begin
 if p_value->'version'='1' then return fluid_private.naming_brain_legacy_preferences(p_value); end if;
 if p_value->'version' is distinct from '2'::jsonb or p_value-array['version','creativeLocale','notes','minimumGraphemes','maximumGraphemes','approaches','directness','sourceLanguages','heritageNotes','culturalNotes','requiredText','excludedText']<>'{}'
 or not(p_value ?& array['approaches','directness','sourceLanguages','heritageNotes','culturalNotes','requiredText','excludedText']) then return false; end if;
 if not fluid_private.naming_brain_legacy_preferences((p_value-array['approaches','directness','sourceLanguages','heritageNotes','culturalNotes','requiredText','excludedText'])||'{"version":1}') then return false; end if;
 if p_value->'directness'<>'null' and p_value->>'directness' not in('direct','suggestive','open_ended','all') then return false; end if;
 foreach k in array array['heritageNotes','culturalNotes'] loop if jsonb_typeof(p_value->k)<>'string' or length(p_value->>k)>2000 then return false; end if; end loop;
 foreach k in array array['approaches','sourceLanguages','requiredText','excludedText'] loop
 if jsonb_typeof(p_value->k)<>'array' or jsonb_array_length(p_value->k)>(case k when 'approaches' then 11 when 'sourceLanguages' then 12 else 20 end) then return false; end if;
 if exists(select 1 from jsonb_array_elements(p_value->k) x group by x having count(*)>1) then return false; end if;
 for v in select value from jsonb_array_elements(p_value->k) loop
 if jsonb_typeof(v)<>'string' or length(v#>>'{}') not between 1 and (case k when 'sourceLanguages' then 80 else 160 end) then return false; end if;
 if k='approaches' and v#>>'{}' not in('real_words','compounds','blends','invented','modified','phrases','initials','other_languages','classical_roots','people_places','stories_culture') then return false; end if;
 end loop; end loop;
 return true; end $$;

create function fluid_private.naming_brain_accounting(r fluid_private.naming_brain_runs) returns jsonb language sql stable set search_path='' as $$
 select case when r.actual_cost_microusd is null then '{"status":"held_unsettled","heldAllowanceMicrousd":5000000,"confirmedActualCostMicrousd":null}'::jsonb
 else jsonb_build_object('status','settled','heldAllowanceMicrousd',0,'confirmedActualCostMicrousd',r.actual_cost_microusd) end;
$$;
-- Read-only eligibility is shared by reload projections and the final Resume
-- mutation. Admission still takes locks and repeats the revision/budget checks.
create function fluid_private.naming_brain_paid_resume(r fluid_private.naming_brain_runs) returns boolean language sql stable set search_path='' as $$
 select coalesce(not r.superseded and not r.observed_overrun
 and not fluid_private.api_text_paid_paused(r.owner_id)
 and not exists(select 1 from fluid_private.naming_brain_runs bad where bad.owner_id=r.owner_id and bad.observed_overrun)
 and not exists(select 1 from public.job_steps where job_id=r.job_id and state in('in_flight','ambiguous'))
 and not exists(select 1 from fluid_private.naming_brain_runs child where child.resumed_from_run_id=r.id)
 and not exists(select 1 from fluid_private.naming_brain_runs later where later.owner_id=r.owner_id and later.project_id=r.project_id and not later.superseded and (later.created_at,later.id)>(r.created_at,r.id))
 and exists(select 1 from public.jobs j where j.id=r.job_id and (j.state in('partial','failed','cancelled') or (j.state='succeeded' and exists(select 1 from fluid_private.naming_brain_prepared_sets ps where ps.run_id=r.id and ps.prepared#>>'{fulfillment,status}'<>'complete'))))
 and not exists(select 1 from public.jobs competing where competing.owner_id=r.owner_id and competing.project_id=r.project_id and competing.operation='naming.generate' and competing.state in('queued','running','cancel_requested','needs_reconciliation'))
 and exists(select 1 from public.projects p join public.naming_sessions session on session.project_id=p.id and session.owner_id=p.owner_id
 join fluid_private.naming_brain_heads head on head.project_id=p.id and head.owner_id=p.owner_id
 join public.naming_preferences pref on pref.project_id=p.id and pref.owner_id=p.owner_id and pref.version=session.preferences_version
 join public.project_revisions revision on revision.project_id=p.id and revision.owner_id=p.owner_id and revision.revision=p.current_revision
 join fluid_private.naming_brain_pilots pilot on pilot.owner_id=p.owner_id
 join public.usage_accounts account on account.owner_id=p.owner_id
 where p.id=r.project_id and p.owner_id=r.owner_id and p.deleted_at is null and p.deletion_requested_at is null
 and head.current_run_id=r.id and (fluid_private.naming_readiness(p.scope,revision.context)->>'ready')::boolean
 and pref.preferences->'version'='2'::jsonb and jsonb_array_length(pref.preferences->'approaches')>0 and pref.preferences->'directness'<>'null'::jsonb
 and pilot.enabled and pilot.ready_until>clock_timestamp() and fluid_private.api_text_restricted_role(pilot.role_name,pilot.role_oid)
 and (select coalesce(sum(coalesce(actual_cost_microusd,5000000)),0) from fluid_private.naming_brain_runs where pilot_id=pilot.id)+5000000<=pilot.allowance_microusd
 and account.limit_microusd-greatest(account.spent_microusd,account.provider_actual_microusd)-account.reserved_microusd>=5000000),false);
$$;
-- Saved output can be consumed without provider readiness or a fresh allowance.
-- Its material basis and immutable membership remain authoritative after Stop.
create function fluid_private.naming_brain_saved_usable(r fluid_private.naming_brain_runs) returns boolean language sql stable set search_path='' as $$
 select coalesce(not r.superseded and not r.observed_overrun and exists(select 1 from public.jobs j where j.id=r.job_id and j.state<>'needs_reconciliation') and exists(select 1 from fluid_private.naming_brain_prepared_sets ps
 join public.projects p on p.id=r.project_id and p.owner_id=r.owner_id
 join public.naming_sessions session on session.project_id=p.id and session.owner_id=p.owner_id
 join fluid_private.naming_brain_heads h on h.project_id=p.id and h.owner_id=p.owner_id
 join public.project_revisions rev on rev.project_id=p.id and rev.owner_id=p.owner_id and rev.revision=p.current_revision
 where ps.run_id=r.id and jsonb_array_length(ps.prepared->'candidateIds')>0 and p.deleted_at is null and p.deletion_requested_at is null
 and h.current_run_id=r.id and h.steering_revision=(r.snapshot->>'steeringRevision')::integer
 and session.preferences_version=(r.snapshot->>'preferencesVersion')::integer and fluid_private.naming_strategy_basis(rev.context)=r.snapshot->'strategyBasis'),false);
$$;
create function fluid_private.naming_brain_can_resume(r fluid_private.naming_brain_runs) returns boolean language sql stable set search_path='' as $$
 select fluid_private.naming_brain_paid_resume(r) or (fluid_private.naming_brain_saved_usable(r)
 and exists(select 1 from public.jobs j join fluid_private.naming_brain_prepared_sets ps on ps.run_id=r.id where j.id=r.job_id and (j.state in('succeeded','partial','failed','cancelled') or ps.prepared#>>'{fulfillment,status}'='complete'))
 and (exists(select 1 from fluid_private.naming_brain_heads where project_id=r.project_id and paused)
 or not exists(select 1 from fluid_private.naming_brain_feed_entries where run_id=r.id)));
$$;
create function fluid_private.naming_brain_summary(r fluid_private.naming_brain_runs) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('version',1,'ownerId',r.owner_id,'projectId',r.project_id,'runId',r.id,'jobId',r.job_id,'batchId',r.batch_id,'revision',r.revision,
 'resumedFromRunId',r.resumed_from_run_id,'canResume',fluid_private.naming_brain_can_resume(r),'state',case when r.superseded then 'superseded' when s.prepared#>>'{fulfillment,status}'='complete' and j.state='running' then 'prepared' when s.prepared#>>'{fulfillment,status}'='complete' and j.state in('succeeded','partial','failed','cancelled','cancel_requested') then 'succeeded' when j.state='succeeded' and s.prepared#>>'{fulfillment,status}'<>'complete' then 'partial' else j.state end,
 'projectRevision',(r.snapshot->>'contextRevision')::integer,'preferencesVersion',(r.snapshot->>'preferencesVersion')::integer,
 'feedbackRevision',(r.snapshot->>'feedbackRevision')::integer,'steeringRevision',(r.snapshot->>'steeringRevision')::integer,'demandSequence',r.demand_sequence,
 'snapshotHash',r.snapshot_hash,'acceptedPolicyIdentity',r.policy_identity,'progress',j.progress,'preparedSetId',s.id,'fulfillment',s.prepared->'fulfillment',
 'accounting',fluid_private.naming_brain_accounting(r),'createdAt',r.created_at,'updatedAt',r.updated_at)
 from public.jobs j left join fluid_private.naming_brain_prepared_sets s on s.run_id=r.id where j.id=r.job_id;
$$;
create function fluid_private.naming_brain_available(p_owner uuid) returns jsonb language sql stable set search_path='' as $$
 select coalesce((select jsonb_build_object('status','available','handlerVersion','naming-brain-v1','protocol','openai_agents','acceptedPolicyIdentity',encode(sha256(convert_to(policy::text,'UTF8')),'hex'))
 from fluid_private.naming_brain_pilots where owner_id=p_owner and enabled and ready_until>clock_timestamp() and fluid_private.api_text_restricted_role(role_name,role_oid)),
 '{"status":"unavailable","code":"naming_runtime_unavailable"}'::jsonb);
$$;
create function public.get_naming_feed(p_project_id uuid,p_query jsonb default '{}') returns jsonb language plpgsql security definer set search_path='' as $$
 declare o uuid:=auth.uid(); p public.projects; h fluid_private.naming_brain_heads; s public.naming_sessions; items jsonb; count_rows integer; last_item jsonb; active jsonb; prepared uuid;
 begin
 select * into p from public.projects where id=p_project_id and owner_id=o; if not found then raise exception 'not_found' using errcode='P0002'; end if;
 if jsonb_typeof(p_query)<>'object' or p_query-array['cursor','limit']<>'{}' or coalesce((p_query->>'limit')::integer,100) not between 1 and 100 then raise exception 'invalid_query' using errcode='22023'; end if;
 if p_query->'cursor' is not null and p_query->'cursor'<>'null' and not exists(select 1 from fluid_private.naming_brain_feed_entries where project_id=p.id and owner_id=o and id=(p_query#>>'{cursor,entryId}')::uuid and position=(p_query#>>'{cursor,position}')::bigint) then raise exception 'invalid_cursor' using errcode='22023'; end if;
 select * into h from fluid_private.naming_brain_heads where project_id=p.id and owner_id=o;
 select * into s from public.naming_sessions where project_id=p.id and owner_id=o;
 with page as(select f.*, row_number() over(order by position) n from fluid_private.naming_brain_feed_entries f where f.project_id=p.id and f.owner_id=o and f.position>coalesce((p_query#>>'{cursor,position}')::bigint,0) order by position limit coalesce((p_query->>'limit')::integer,100)+1)
 select coalesce(jsonb_agg(jsonb_build_object('entryId',f.id,'position',f.position,'runId',f.run_id,'steeringRevision',f.steering_revision,'entry',fluid_private.naming_entry(c),
 'primaryApproach',f.metadata->'primaryApproach','additionalApproaches',coalesce(f.metadata->'additionalApproaches','[]'),'publishedClaims',coalesce(f.metadata->'publishedClaims','[]')) order by f.position) filter(where f.n<=coalesce((p_query->>'limit')::integer,100)),'[]'),count(*)
 into items,count_rows from page f join public.name_candidates c on c.id=f.candidate_id and c.owner_id=o and c.project_id=p.id;
 if count_rows>coalesce((p_query->>'limit')::integer,100) then last_item:=items->(jsonb_array_length(items)-1); end if;
 select fluid_private.naming_brain_summary(r) into active from fluid_private.naming_brain_runs r join public.jobs j on j.id=r.job_id where r.project_id=p.id and r.owner_id=o and (j.state in('queued','running','cancel_requested','needs_reconciliation') or (r.id=h.current_run_id and not r.superseded)) order by (j.state in('queued','running','cancel_requested','needs_reconciliation')) desc,r.created_at desc,r.id desc limit 1;
 select ps.id into prepared from fluid_private.naming_brain_prepared_sets ps join fluid_private.naming_brain_runs r on r.id=ps.run_id where r.project_id=p.id and r.owner_id=o and fluid_private.naming_brain_saved_usable(r) and not exists(select 1 from fluid_private.naming_brain_feed_entries where set_id=ps.id) order by ps.created_at limit 1;
 return jsonb_build_object('version',1,'ownerId',o,'projectId',p.id,'projectRevision',p.current_revision,'preferencesVersion',coalesce(s.preferences_version,0),
 'feedbackRevision',coalesce(h.feedback_revision,0),'steeringRevision',coalesce(h.steering_revision,0),'demandSequence',coalesce(h.demand_sequence,0),'entries',items,
 'nextCursor',case when last_item is null then null else jsonb_build_object('entryId',last_item->'entryId','position',last_item->'position') end,'consumedThrough',h.consumed_through,
 'activeRun',active,'preparedSetId',prepared,'paused',coalesce(h.paused,false),'state',case when p.deletion_requested_at is not null or p.deleted_at is not null then 'blocked' when coalesce(h.paused,false) then 'paused' else 'active' end,'availability',fluid_private.naming_brain_available(o));
 end $$;

-- Version-scoped wrappers preserve existing function owners and ACLs.
do $$ declare sig text; old_name text; new_name text; d text; begin
 for sig,old_name,new_name in values
 ('fluid_private.lock_leased_job(uuid,uuid)','fluid_private.lock_leased_job','fluid_private.naming_brain_legacy_lock'),
 ('fluid_private.settle_reservation(uuid)','fluid_private.settle_reservation','fluid_private.naming_brain_legacy_settle') loop
 d:=pg_get_functiondef(sig::regprocedure); execute replace(d,'FUNCTION '||old_name||'(','FUNCTION '||new_name||'('); end loop;
end $$;
create or replace function fluid_private.lock_leased_job(p_job_id uuid,p_lease_token uuid) returns public.jobs language plpgsql set search_path='' as $$
 declare j public.jobs; r fluid_private.naming_brain_runs; begin
 select * into j from public.jobs where id=p_job_id;
 if not found then raise exception 'lease_lost' using errcode='PT409'; end if;
 if not fluid_private.naming_brain_is_job(j) then return fluid_private.naming_brain_legacy_lock(p_job_id,p_lease_token); end if;
 select * into r from fluid_private.naming_brain_runs where job_id=j.id and owner_id=j.owner_id and project_id=j.project_id;
 if not found or not fluid_private.naming_brain_run_worker(r) then raise exception 'worker_owner_mismatch' using errcode='42501'; end if;
 perform fluid_private.lock_strategy_owner(j.owner_id);
 select * into j from public.jobs where id=p_job_id for update;
 if p_lease_token is null or j.lease_token is distinct from p_lease_token or j.lease_expires_at<=clock_timestamp() or j.state not in('running','cancel_requested') then raise exception 'lease_lost' using errcode='PT409'; end if;
 return j; end $$;
create function fluid_private.naming_brain_no_dispatch(p_job uuid) returns boolean language sql stable set search_path='' as $$
 select exists(select 1 from fluid_private.naming_brain_runs r where r.job_id=p_job
 and not exists(select 1 from fluid_private.naming_brain_calls where run_id=r.id)
 and not exists(select 1 from fluid_private.naming_brain_receipts where run_id=r.id));
$$;
create or replace function fluid_private.settle_reservation(p_job_id uuid) returns void language plpgsql set search_path='' as $$
 declare j public.jobs; r fluid_private.naming_brain_runs; proof jsonb; begin
 select * into j from public.jobs where id=p_job_id;
 if fluid_private.naming_brain_is_job(j) then
 select * into r from fluid_private.naming_brain_runs where job_id=j.id for update;
 if not found then raise exception 'naming_accounting_missing' using errcode='55000'; end if;
 if r.actual_cost_microusd is null then
 -- Every provider create requires durable authorization. With execution stopped
 -- and no authorized call/receipt, a begun step alone cannot establish a charge.
 if j.state<>'running' and fluid_private.naming_brain_no_dispatch(j.id) then
 proof:=jsonb_build_object('kind','database_no_dispatch','jobId',j.id);
 insert into fluid_private.naming_brain_financial_evidence(run_id,owner_id,project_id,confirmed_total_microusd,evidence) values(r.id,r.owner_id,r.project_id,0,proof);
 update fluid_private.naming_brain_runs set actual_cost_microusd=0,settlement_evidence=proof,revision=revision+1,updated_at=clock_timestamp() where id=r.id;
 else return; end if;
 end if;
 end if;
 perform fluid_private.naming_brain_legacy_settle(p_job_id); end $$;
-- Generic claim AND expiry must ignore managed Naming even if its run row is malformed.
do $$ declare sig text; d text; needle text; replacement text; begin
 for sig,needle,replacement in values
 ('public.claim_job(text,integer)', 'where not exists(select 1 from fluid_private.api_text_dispatches d where d.job_id=j.id)', 'where not fluid_private.naming_brain_is_job(j) and not exists(select 1 from fluid_private.api_text_dispatches d where d.job_id=j.id)'),
 ('public.expire_job_leases()', 'where not exists(select 1 from fluid_private.api_text_dispatches d where d.job_id=public.jobs.id)', 'where not fluid_private.naming_brain_is_job(jobs) and not exists(select 1 from fluid_private.api_text_dispatches d where d.job_id=public.jobs.id)') loop
 d:=pg_get_functiondef(sig::regprocedure); if position(needle in d)=0 then raise exception 'unexpected_naming_lifecycle_definition'; end if; execute replace(d,needle,replacement); end loop;
end $$;
create or replace function fluid_private.project_deletion_worker(p_owner_id uuid) returns boolean language sql stable security definer set search_path='' as $$
 select coalesce(public.subscription_worker_owner()=p_owner_id,false) or coalesce(public.api_text_worker_owner()=p_owner_id,false)
 or coalesce(fluid_private.logo_worker_owner()=p_owner_id,false) or coalesce(fluid_private.naming_brain_worker_owner()=p_owner_id,false);
$$;

create function public.report_naming_brain_worker_ready(p_policy jsonb,p_deployment_id text,p_worker_id text,p_ready_seconds integer default 60) returns boolean language plpgsql security definer set search_path='' as $$
 declare o uuid:=fluid_private.naming_brain_worker_owner(); begin
 if o is null then raise exception 'worker_owner_mismatch' using errcode='42501'; end if;
 if p_ready_seconds not between 5 and 120 or length(p_worker_id) not between 1 and 100 then raise exception 'invalid_readiness' using errcode='22023'; end if;
 update fluid_private.naming_brain_pilots set ready_until=clock_timestamp()+make_interval(secs=>p_ready_seconds),worker_id=p_worker_id
 where owner_id=o and enabled and policy=p_policy and deployment_id=p_deployment_id;
 return found; end $$;
create function fluid_private.naming_brain_ready(r fluid_private.naming_brain_runs,p_worker text default null) returns boolean language sql stable set search_path='' as $$
 select exists(select 1 from fluid_private.naming_brain_pilots p where p.id=r.pilot_id and p.owner_id=r.owner_id and p.enabled and p.policy=r.policy
 and p.deployment_id=r.deployment_id and p.role_name=r.admitted_role_name and p.role_oid=r.admitted_role_oid and p.ready_until>clock_timestamp()
 and (p_worker is null or p.worker_id=p_worker) and fluid_private.api_text_restricted_role(p.role_name,p.role_oid));
$$;
create function public.claim_naming_brain_job(p_worker_id text,p_deployment_id text,p_lease_seconds integer default 120) returns jsonb language plpgsql security definer set search_path='' as $$
 declare o uuid:=fluid_private.naming_brain_worker_owner(); j public.jobs; r fluid_private.naming_brain_runs; begin
 if o is null then raise exception 'worker_owner_mismatch' using errcode='42501'; end if;
 if p_lease_seconds not between 5 and 300 then raise exception 'invalid_lease' using errcode='22023'; end if;
 perform fluid_private.lock_strategy_owner(o);
 select j0.* into j from public.jobs j0 join fluid_private.naming_brain_runs r0 on r0.job_id=j0.id where r0.owner_id=o and j0.owner_id=o
 and fluid_private.naming_brain_is_job(j0) and r0.deployment_id=p_deployment_id and fluid_private.naming_brain_run_worker(r0)
 and fluid_private.naming_brain_ready(r0,p_worker_id) and j0.state='queued' and j0.attempts<j0.max_attempts and not r0.superseded and not r0.observed_overrun and not exists(select 1 from fluid_private.naming_brain_runs overrun where overrun.owner_id=o and overrun.observed_overrun)
 order by j0.created_at,j0.id for update of j0 skip locked limit 1;
 if not found then return null; end if;
 select * into strict r from fluid_private.naming_brain_runs where job_id=j.id;
 if not exists(select 1 from public.usage_reservations where job_id=j.id and state='active' and reserved_microusd=5000000) then raise exception 'reservation_missing' using errcode='55000'; end if;
 update public.jobs set state='running',worker_id=p_worker_id,lease_token=gen_random_uuid(),lease_expires_at=clock_timestamp()+make_interval(secs=>p_lease_seconds),attempts=attempts+1 where id=j.id returning * into j;
 update fluid_private.naming_brain_runs set revision=revision+1,updated_at=clock_timestamp() where id=r.id;
 return jsonb_build_object('mode',r.recovery_mode,'job',to_jsonb(j)); end $$;
create function public.expire_naming_brain_leases(p_worker_id text,p_deployment_id text) returns integer language plpgsql security definer set search_path='' as $$
 declare o uuid:=fluid_private.naming_brain_worker_owner(); j public.jobs; r fluid_private.naming_brain_runs; n integer:=0; next_state text; known boolean; begin
 if o is null then raise exception 'worker_owner_mismatch' using errcode='42501'; end if;
 perform fluid_private.lock_strategy_owner(o);
 for j in select j0.* from public.jobs j0 join fluid_private.naming_brain_runs r0 on r0.job_id=j0.id where r0.owner_id=o and r0.deployment_id=p_deployment_id
 and fluid_private.naming_brain_run_worker(r0) and j0.state in('running','cancel_requested') and j0.lease_expires_at<=clock_timestamp() order by j0.id for update of j0 skip locked loop
 select * into strict r from fluid_private.naming_brain_runs where job_id=j.id;
 if r.observed_overrun then next_state:='needs_reconciliation';
 elsif exists(select 1 from public.job_steps where job_id=j.id and state in('in_flight','ambiguous')) then
 known:=not exists(
 select 1 from fluid_private.naming_brain_calls c join public.job_steps s on s.job_id=j.id and s.step_key=c.stage_key where c.run_id=r.id and s.state in('in_flight','ambiguous')
 and not exists(select 1 from fluid_private.naming_brain_receipts p where p.run_id=c.run_id and p.stage_key=c.stage_key and p.call_key=c.call_key and p.receipt->>'sessionId' is not null));
 next_state:=case when known and j.cancel_requested_at is null and j.attempts<j.max_attempts and not r.observed_overrun then 'queued' else 'needs_reconciliation' end;
 update fluid_private.naming_brain_runs set recovery_mode=case when exists(select 1 from fluid_private.naming_brain_calls c join public.job_steps st on st.job_id=j.id and st.step_key=c.stage_key where c.run_id=r.id and st.state in('in_flight','ambiguous')) then 'observe_only' else 'execute' end where id=r.id;
 elsif j.cancel_requested_at is not null then next_state:='cancelled';
 elsif j.attempts<j.max_attempts and not r.superseded then next_state:='queued';
 elsif exists(select 1 from public.job_steps where job_id=j.id and state='succeeded') then next_state:='partial'; else next_state:='failed'; end if;
 update public.jobs set state=next_state,lease_token=null,lease_expires_at=null,error_code=case when r.observed_overrun then 'provider_cost_exceeded' else 'lease_expired' end,finished_at=case when next_state in('partial','failed','cancelled') then clock_timestamp() else null end where id=j.id;
 update fluid_private.naming_brain_runs set revision=revision+1,updated_at=clock_timestamp() where id=r.id;
 n:=n+1; end loop; return n; end $$;

create function public.get_naming_brain_run(p_project_id uuid,p_run_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
 declare r fluid_private.naming_brain_runs; stages jsonb; begin
 select * into r from fluid_private.naming_brain_runs where id=p_run_id and project_id=p_project_id and owner_id=auth.uid(); if not found then raise exception 'not_found' using errcode='P0002'; end if;
 select jsonb_agg(jsonb_build_object('stageKey',key,'state',case s.state when 'in_flight' then 'running' when 'ambiguous' then 'unresolved' else coalesce(s.state,'pending') end,
 'artifactIds',coalesce((select jsonb_agg(a.id order by a.id) from fluid_private.naming_brain_artifacts a where a.run_id=r.id and a.stage_key=key),'[]'),'startedAt',s.created_at,'finishedAt',s.completed_at,'errorCode',s.output->'errorCode') order by n)
 into stages from unnest(fluid_private.naming_brain_stages()) with ordinality keys(key,n) left join public.job_steps s on s.job_id=r.job_id and s.step_key=key;
 return fluid_private.naming_brain_summary(r)||jsonb_build_object('snapshot',r.snapshot,'stages',stages); end $$;

create function fluid_private.naming_brain_ensure_response(r fluid_private.naming_brain_runs,p_reused boolean) returns jsonb language plpgsql set search_path='' as $$
 declare summary jsonb:=fluid_private.naming_brain_summary(r); fulfillment jsonb; ready_set uuid; begin
 if exists(select 1 from fluid_private.naming_brain_heads where project_id=r.project_id and paused) then
 return jsonb_build_object('status','paused','feed',public.get_naming_feed(r.project_id),'code','exploration_stopped','message','Exploration is stopped. Your saved work is retained.','action','none'); end if;
 if fluid_private.naming_brain_saved_usable(r) then
 select id into ready_set from fluid_private.naming_brain_prepared_sets where run_id=r.id and jsonb_array_length(prepared->'candidateIds')>0;
 if ready_set is not null then return public.append_prepared_naming_set(r.project_id,ready_set); end if; end if;
 if summary->>'state' in('queued','running','cancel_requested') then return jsonb_build_object('status','pending','feed',public.get_naming_feed(r.project_id),'run',summary,'reused',p_reused); end if;
 if summary->>'state' in('partial','failed','cancelled','succeeded') then
 fulfillment:=coalesce(nullif(summary->'fulfillment','null'),' {"status":"none","targetCount":100,"acceptedCount":0,"missingCount":100,"coverageSatisfied":false,"message":"This exploration stopped before a complete set was prepared."}'::jsonb);
 return jsonb_build_object('status','incomplete','feed',public.get_naming_feed(r.project_id),'run',summary,'fulfillment',fulfillment,'message','Your saved work is retained. Resume starts a new bounded exploration.','canResume',fluid_private.naming_brain_can_resume(r));
 end if;
 return jsonb_build_object('status','paused','feed',public.get_naming_feed(r.project_id),'code',case when summary->>'state'='needs_reconciliation' then 'dispatch_unresolved' else 'saved_exploration' end,
 'message','Saved exploration is retained. Resolve the current request before continuing.','action',case when summary->>'state'='needs_reconciliation' then 'resolve' else 'none' end); end $$;

create function public.ensure_naming_brain_run(p_project_id uuid,p_intent jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
 declare o uuid:=auth.uid(); h fluid_private.naming_brain_heads; p public.projects; pref public.naming_preferences; pilot fluid_private.naming_brain_pilots;
 r fluid_private.naming_brain_runs; source fluid_private.naming_brain_runs; old fluid_private.naming_brain_intents; j public.jobs; account public.usage_accounts;
 snapshot jsonb; context jsonb; basis jsonb; favorites jsonb; recent jsonb; k text; v_demand_key text; allowance bigint; sequence integer; runid uuid:=gen_random_uuid(); jobid uuid:=gen_random_uuid(); batchid uuid:=gen_random_uuid(); input jsonb; prepared uuid;
 begin
 if o is null then raise exception 'unauthenticated' using errcode='42501'; end if;
 if jsonb_typeof(p_intent)<>'object' or p_intent-array['version','expectedProjectRevision','expectedPreferencesVersion','expectedSteeringRevision','expectedDemandSequence','consumedThrough','idempotencyKey','reason','resumeOfRunId','expectedRunRevision']<>'{}'
 or not(p_intent ?& array['version','expectedProjectRevision','expectedPreferencesVersion','expectedSteeringRevision','expectedDemandSequence','consumedThrough','idempotencyKey','reason'])
 or p_intent->'version' is distinct from '1'::jsonb or p_intent->>'reason' not in('initial','scroll','resume') or coalesce(p_intent->>'idempotencyKey','')!~'^[A-Za-z0-9._:-]{16,128}$' then raise exception 'invalid_intent' using errcode='22023'; end if;
 foreach k in array array['expectedProjectRevision','expectedPreferencesVersion','expectedSteeringRevision','expectedDemandSequence'] loop
 if jsonb_typeof(p_intent->k)<>'number' or p_intent->>k!~'^[0-9]+$' then raise exception 'invalid_revision' using errcode='22023'; end if; end loop;
 if (p_intent->>'reason'='resume') is distinct from (p_intent ?& array['resumeOfRunId','expectedRunRevision'])
 or (p_intent->>'reason'<>'resume' and (p_intent ? 'resumeOfRunId' or p_intent ? 'expectedRunRevision'))
 or (p_intent->>'reason'='initial' and p_intent->'consumedThrough'<>'null') or (p_intent->>'reason'='scroll' and p_intent->'consumedThrough'='null') then raise exception 'invalid_intent' using errcode='22023'; end if;
 perform fluid_private.lock_strategy_owner(o); h:=fluid_private.naming_brain_head(p_project_id,o);
 select * into old from fluid_private.naming_brain_intents where owner_id=o and request_key=p_intent->>'idempotencyKey';
 if found then
 if old.kind<>'ensure' or old.project_id<>p_project_id or old.request<>p_intent then raise exception 'idempotency_conflict' using errcode='PT409'; end if;
 select * into strict r from fluid_private.naming_brain_runs where id=old.run_id and owner_id=o; return fluid_private.naming_brain_ensure_response(r,true); end if;
 select * into strict p from public.projects where id=p_project_id and owner_id=o;
 if p.deletion_requested_at is not null or p.deleted_at is not null then raise exception 'project_deleted' using errcode='PT409'; end if;
 if p_intent->'consumedThrough'<>'null' and not exists(select 1 from fluid_private.naming_brain_feed_entries where owner_id=o and project_id=p.id and id=(p_intent#>>'{consumedThrough,entryId}')::uuid and position=(p_intent#>>'{consumedThrough,position}')::bigint) then raise exception 'invalid_cursor' using errcode='22023'; end if;
 select * into pref from public.naming_preferences where project_id=p.id and owner_id=o and version=(select preferences_version from public.naming_sessions where project_id=p.id);
 if p.current_revision<>(p_intent->>'expectedProjectRevision')::integer or pref.version is distinct from (p_intent->>'expectedPreferencesVersion')::integer or h.steering_revision<>(p_intent->>'expectedSteeringRevision')::integer then raise exception 'revision_conflict' using errcode='PT409'; end if;
 -- Resume races coalesce by the frozen source terminal revision, before checking
 -- the already-advanced demand counter. Different canonical intent is a conflict.
 if p_intent->>'reason'='resume' then
 select * into old from fluid_private.naming_brain_intents where owner_id=o and project_id=p.id and kind='ensure'
 and response->'freeContinuation'='true'::jsonb and request-'idempotencyKey'=p_intent-'idempotencyKey';
 if found then
 if h.demand_sequence<>(old.response->>'committedDemandSequence')::integer then raise exception 'resume_conflict' using errcode='PT409'; end if;
 insert into fluid_private.naming_brain_intents values(o,p.id,p_intent->>'idempotencyKey','ensure',p_intent,old.run_id,old.response);
 select * into strict r from fluid_private.naming_brain_runs where id=old.run_id; return fluid_private.naming_brain_ensure_response(r,true); end if;
 select * into r from fluid_private.naming_brain_runs where resumed_from_run_id=(p_intent->>'resumeOfRunId')::uuid and resumed_from_revision=(p_intent->>'expectedRunRevision')::integer and owner_id=o and project_id=p.id;
 if found then
 if r.demand-'idempotencyKey'<>p_intent-'idempotencyKey' then raise exception 'resume_conflict' using errcode='PT409'; end if;
 insert into fluid_private.naming_brain_intents values(o,p.id,p_intent->>'idempotencyKey','ensure',p_intent,r.id,jsonb_build_object('committedDemandSequence',h.demand_sequence)); return fluid_private.naming_brain_ensure_response(r,true); end if;
 select * into source from fluid_private.naming_brain_runs where id=(p_intent->>'resumeOfRunId')::uuid and owner_id=o and project_id=p.id;
 if not found or source.revision<>(p_intent->>'expectedRunRevision')::integer or source.id is distinct from h.current_run_id
 or not fluid_private.naming_brain_can_resume(source)
 then raise exception 'resume_conflict' using errcode='PT409'; end if;
 end if;
 if h.demand_sequence<>(p_intent->>'expectedDemandSequence')::integer then raise exception 'demand_conflict' using errcode='PT409'; end if;
 if p_intent->>'reason'='resume' and fluid_private.naming_brain_saved_usable(source)
 and (h.paused or not exists(select 1 from fluid_private.naming_brain_feed_entries where run_id=source.id)) then
 update fluid_private.naming_brain_heads set paused=false,demand_sequence=demand_sequence+1,consumed_through=p_intent->'consumedThrough' where project_id=p.id returning * into h;
 insert into fluid_private.naming_brain_intents values(o,p.id,p_intent->>'idempotencyKey','ensure',p_intent,source.id,jsonb_build_object('committedDemandSequence',h.demand_sequence,'freeContinuation',true));
 if exists(select 1 from fluid_private.naming_brain_feed_entries where run_id=source.id) and exists(select 1 from fluid_private.naming_brain_prepared_sets saved where saved.run_id=source.id and saved.prepared#>>'{fulfillment,status}'='complete') then
 return jsonb_build_object('status','appended','feed',public.get_naming_feed(p.id),'runId',source.id,'appendedEntryIds','[]'::jsonb); end if;
 select id into prepared from fluid_private.naming_brain_prepared_sets where run_id=source.id;
 return public.append_prepared_naming_set(p.id,prepared); end if;
 if h.paused then
 if p_intent->>'reason'='scroll' or (p_intent->>'reason'='initial' and exists(select 1 from fluid_private.naming_brain_runs rr
 where rr.id=h.current_run_id and (rr.snapshot->>'preferencesVersion')::integer=pref.version and (rr.snapshot->>'steeringRevision')::integer=h.steering_revision
 and rr.snapshot->'strategyBasis'=(select fluid_private.naming_strategy_basis(pr.context) from public.project_revisions pr where pr.project_id=p.id and pr.owner_id=o and pr.revision=p.current_revision))) then
 return jsonb_build_object('status','paused','feed',public.get_naming_feed(p.id),'code','exploration_stopped','message','Continue explicitly from your saved exploration.','action','none'); end if;
 update fluid_private.naming_brain_heads set paused=false where project_id=p.id returning * into h;
 end if;
 v_demand_key:=encode(sha256(convert_to((p_intent-'idempotencyKey')::text,'UTF8')),'hex');
 select rr.* into r from fluid_private.naming_brain_runs rr where rr.owner_id=o and rr.project_id=p.id and rr.demand_key=v_demand_key;
 if found then insert into fluid_private.naming_brain_intents values(o,p.id,p_intent->>'idempotencyKey','ensure',p_intent,r.id,jsonb_build_object('committedDemandSequence',h.demand_sequence)); return fluid_private.naming_brain_ensure_response(r,true); end if;
 select pr.context into strict context from public.project_revisions pr where pr.project_id=p.id and pr.owner_id=o and pr.revision=p.current_revision;
 for source in select rr.* from fluid_private.naming_brain_runs rr where rr.owner_id=o and rr.project_id=p.id and not rr.superseded and rr.id is distinct from (p_intent->>'resumeOfRunId')::uuid and (exists(select 1 from public.jobs where id=rr.job_id and state in('queued','running','cancel_requested','needs_reconciliation')) or exists(select 1 from fluid_private.naming_brain_prepared_sets where run_id=rr.id)) and not exists(select 1 from fluid_private.naming_brain_feed_entries where run_id=rr.id)
 and ((rr.snapshot->>'preferencesVersion')::integer<>pref.version or rr.snapshot->'strategyBasis'<>fluid_private.naming_strategy_basis(context) or (rr.snapshot->>'steeringRevision')::integer<>h.steering_revision) loop
 update fluid_private.naming_brain_runs set superseded=true where id=source.id;
 if exists(select 1 from public.jobs where id=source.job_id and state in('queued','running')) then perform public.request_job_cancel(source.job_id); end if;
 end loop;
 -- Restore the explicit Resume source after the bounded stale-work pass.
 source:=null;
 if p_intent->>'reason'='resume' then select * into source from fluid_private.naming_brain_runs where id=(p_intent->>'resumeOfRunId')::uuid and owner_id=o and project_id=p.id; end if;
 select r0.* into r from fluid_private.naming_brain_runs r0 join public.jobs j0 on j0.id=r0.job_id where r0.owner_id=o and r0.project_id=p.id and j0.state in('queued','running','cancel_requested','needs_reconciliation') order by r0.created_at desc limit 1;
 if found then if not r.superseded then insert into fluid_private.naming_brain_intents values(o,p.id,p_intent->>'idempotencyKey','ensure',p_intent,r.id,jsonb_build_object('committedDemandSequence',h.demand_sequence)); end if; return fluid_private.naming_brain_ensure_response(r,true); end if;
 if exists(select 1 from public.jobs where owner_id=o and project_id=p.id and operation='naming.generate' and state in('queued','running','cancel_requested','needs_reconciliation')) then
 return jsonb_build_object('status','blocked','feed',public.get_naming_feed(p.id),'code','naming_active','message','Resolve the existing Naming request before continuing.','action','resolve'); end if;
 if p_intent->>'reason'<>'resume' and exists(select 1 from fluid_private.naming_brain_runs rr join public.jobs jj on jj.id=rr.job_id where rr.owner_id=o and rr.project_id=p.id and rr.id=h.current_run_id and (rr.snapshot->>'preferencesVersion')::integer=pref.version and rr.snapshot->'strategyBasis'=fluid_private.naming_strategy_basis(context) and (jj.state in('partial','failed','cancelled') or (jj.state='succeeded' and exists(select 1 from fluid_private.naming_brain_prepared_sets ps where ps.run_id=rr.id and ps.prepared#>>'{fulfillment,status}'<>'complete'))) and not rr.superseded) then
 select rr.* into r from fluid_private.naming_brain_runs rr where rr.owner_id=o and rr.project_id=p.id and rr.id=h.current_run_id and (rr.snapshot->>'preferencesVersion')::integer=pref.version and rr.snapshot->'strategyBasis'=fluid_private.naming_strategy_basis(context) and not rr.superseded order by rr.created_at desc limit 1;
 return fluid_private.naming_brain_ensure_response(r,true); end if;
 if pref.preferences->'version'<>'2' or jsonb_array_length(pref.preferences->'approaches')=0 or pref.preferences->'directness'='null' then
 return jsonb_build_object('status','blocked','feed',public.get_naming_feed(p.id),'code','preferences_incomplete','message','Save your naming approaches and directness before continuing.','action','review_preferences'); end if;
 select pr.context into strict context from public.project_revisions pr where pr.project_id=p.id and pr.owner_id=o and pr.revision=p.current_revision;
 if (fluid_private.naming_readiness(p.scope,context)->>'ready')::boolean is not true then raise exception 'strategy_incomplete' using errcode='PT409'; end if;
 select ps.id into prepared from fluid_private.naming_brain_prepared_sets ps join fluid_private.naming_brain_runs rr on rr.id=ps.run_id where rr.project_id=p.id and rr.owner_id=o and not rr.superseded and p_intent->>'reason'<>'resume' and not exists(select 1 from fluid_private.naming_brain_runs child where child.resumed_from_run_id=rr.id) and jsonb_array_length(ps.prepared->'candidateIds')>0 and not exists(select 1 from fluid_private.naming_brain_feed_entries where set_id=ps.id) limit 1;
 if prepared is not null then return public.append_prepared_naming_set(p.id,prepared); end if;
 select * into pilot from fluid_private.naming_brain_pilots where owner_id=o and enabled and ready_until>clock_timestamp() and fluid_private.api_text_restricted_role(role_name,role_oid) for update;
 if not found then return jsonb_build_object('status','blocked','feed',public.get_naming_feed(p.id),'code','naming_runtime_unavailable','message','Naming generation is not configured. Your saved choices are retained.','action','configure'); end if;
 if fluid_private.api_text_paid_paused(o) or exists(select 1 from fluid_private.naming_brain_runs where owner_id=o and observed_overrun) then return jsonb_build_object('status','blocked','feed',public.get_naming_feed(p.id),'code','dispatch_unresolved','message','Resolve the existing provider outcome before continuing.','action','resolve'); end if;
 select coalesce(sum(coalesce(actual_cost_microusd,5000000)),0) into allowance from fluid_private.naming_brain_runs where pilot_id=pilot.id;
 if allowance+5000000>pilot.allowance_microusd then return jsonb_build_object('status','blocked','feed',public.get_naming_feed(p.id),'code','pilot_allowance_held','message','The pilot allowance is committed to saved requests. Confirm their accounting before continuing.','action','resolve'); end if;
 select * into account from public.usage_accounts where owner_id=o for update;
 if not found or account.limit_microusd-greatest(account.spent_microusd,account.provider_actual_microusd)-account.reserved_microusd<5000000 then return jsonb_build_object('status','blocked','feed',public.get_naming_feed(p.id),'code','account_allowance_unavailable','message','An account allowance is required for Naming generation.','action','configure'); end if;
 -- An unexposed prepared set prevents another paid admission; append is a separate
 -- authenticated operation and still checks current saved direction.
 select ps.id into prepared from fluid_private.naming_brain_prepared_sets ps join fluid_private.naming_brain_runs rr on rr.id=ps.run_id where rr.project_id=p.id and rr.owner_id=o and not rr.superseded and rr.id is distinct from source.id and not exists(select 1 from fluid_private.naming_brain_runs child where child.resumed_from_run_id=rr.id) and not exists(select 1 from fluid_private.naming_brain_feed_entries where set_id=ps.id) limit 1;
 if prepared is not null then return jsonb_build_object('status','paused','feed',public.get_naming_feed(p.id),'code','prepared_set_available','message','Saved names are ready to load.','action','retry'); end if;
 basis:=fluid_private.naming_strategy_basis(context);
 select coalesce(jsonb_agg(jsonb_build_object('candidateId',id,'value',value,'primaryApproach',null) order by created_at desc,id desc),'[]') into recent from(select c.id,c.value,c.created_at from public.name_candidates c where c.project_id=p.id and c.owner_id=o order by c.created_at desc,c.id desc limit 50) q;
 select coalesce(jsonb_agg(jsonb_build_object('candidateId',id,'value',value,'primaryApproach',null) order by created_at desc,id desc),'[]') into favorites from(select c.id,c.value,c.created_at from public.name_candidates c join public.name_retention t on t.candidate_id=c.id and t.owner_id=o where c.project_id=p.id and c.owner_id=o and t.liked order by c.created_at desc,c.id desc limit 30) q;
 snapshot:=jsonb_build_object('version',1,'ownerId',o,'projectId',p.id,'contextRevision',p.current_revision,'strategyBasis',basis,'preferencesVersion',pref.version,'preferences',pref.preferences,
 'feedbackRevision',h.feedback_revision,'steeringRevision',h.steering_revision,'strongSeedIds',h.strong_seed_ids,'steeringInstruction',h.steering_instruction,'recentExamples',recent,'likedExamples',favorites,'patternSummaries','[]'::jsonb);
 snapshot:=snapshot||jsonb_build_object('snapshotHash',encode(sha256(convert_to(snapshot::text,'UTF8')),'hex'));
 input:=jsonb_build_object('version',2,'handlerVersion','naming-brain-v1','billingMode','openai_api','runId',runid,'jobId',jobid,'batchId',batchid,'snapshot',snapshot,'acceptedPolicyIdentity',encode(sha256(convert_to(pilot.policy::text,'UTF8')),'hex'),'policy',pilot.policy);
 select batch_sequence+1 into sequence from public.naming_sessions where project_id=p.id;
 insert into public.jobs(id,owner_id,project_id,operation,input_revision,input_hash,input,idempotency_key,reserved_cost_microusd,max_attempts,billing_mode)
 values(jobid,o,p.id,'naming.generate',p.current_revision,snapshot->>'snapshotHash',input,'naming-brain:'||runid,5000000,3,'openai_api');
 insert into public.usage_reservations(job_id,owner_id,project_id,reserved_microusd) values(jobid,o,p.id,5000000);
 update public.usage_accounts set reserved_microusd=reserved_microusd+5000000 where owner_id=o;
 insert into public.naming_batches(id,owner_id,project_id,sequence,context_revision,strategy_basis,preferences_version,favorites_snapshot,exclusion_keys,policy_identity,target_count,job_id,idempotency_key,engine_version)
 values(batchid,o,p.id,sequence,p.current_revision,basis,pref.version,(select coalesce(jsonb_agg(x-'primaryApproach'),'[]') from jsonb_array_elements(favorites) x),'[]',input->>'acceptedPolicyIdentity',100,jobid,'naming-brain:'||runid,2);
 insert into fluid_private.naming_brain_runs(id,owner_id,project_id,job_id,batch_id,pilot_id,admitted_role_name,admitted_role_oid,deployment_id,snapshot,snapshot_hash,policy,policy_identity,demand,demand_key,demand_sequence,resumed_from_run_id,resumed_from_revision)
 values(runid,o,p.id,jobid,batchid,pilot.id,pilot.role_name,pilot.role_oid,pilot.deployment_id,snapshot,snapshot->>'snapshotHash',pilot.policy,input->>'acceptedPolicyIdentity',p_intent,v_demand_key,h.demand_sequence+case when source.id is not null then 1 else 0 end,source.id,source.revision) returning * into r;
 update fluid_private.naming_brain_heads set demand_sequence=r.demand_sequence,paused=false,current_run_id=r.id,consumed_through=p_intent->'consumedThrough' where project_id=p.id returning * into h;
 update public.naming_sessions set batch_sequence=sequence,revision=revision+1,updated_at=clock_timestamp() where project_id=p.id;
 insert into fluid_private.naming_brain_intents values(o,p.id,p_intent->>'idempotencyKey','ensure',p_intent,r.id,jsonb_build_object('committedDemandSequence',h.demand_sequence));
 return fluid_private.naming_brain_ensure_response(r,false); end $$;

create table fluid_private.naming_brain_provider_records (
 id uuid primary key default gen_random_uuid(), run_id uuid not null, owner_id uuid not null, project_id uuid not null, stage_key text not null, call_key text not null,
 kind text not null check(kind in('provider_item','tool_result')), record_key text not null, payload jsonb not null check(octet_length(payload::text)<=524288),
 unique(run_id,stage_key,call_key,kind,record_key), foreign key(run_id,stage_key,call_key) references fluid_private.naming_brain_calls(run_id,stage_key,call_key),
 foreign key(run_id,owner_id,project_id) references fluid_private.naming_brain_runs(id,owner_id,project_id)
);
create function fluid_private.naming_brain_lock(p_job uuid,p_lease uuid) returns fluid_private.naming_brain_runs language plpgsql set search_path='' as $$
 declare j public.jobs; r fluid_private.naming_brain_runs; begin
 j:=fluid_private.lock_leased_job(p_job,p_lease);
 if not fluid_private.naming_brain_is_job(j) then raise exception 'naming_worker_required' using errcode='42501'; end if;
 select * into strict r from fluid_private.naming_brain_runs where job_id=j.id and owner_id=j.owner_id and project_id=j.project_id for update;
 if not fluid_private.naming_brain_run_worker(r) then raise exception 'worker_owner_mismatch' using errcode='42501'; end if; return r; end $$;

create function public.authorize_naming_brain_dispatch(p_job_id uuid,p_lease_token uuid,p_request jsonb) returns boolean language plpgsql security definer set search_path='' as $$
 declare r fluid_private.naming_brain_runs; j public.jobs; plan jsonb; allocation jsonb; stage text:=p_request->>'stageKey'; phase text; begin
 r:=fluid_private.naming_brain_lock(p_job_id,p_lease_token); select * into strict j from public.jobs where id=p_job_id;
 if r.recovery_mode<>'execute' or r.superseded or r.observed_overrun or exists(select 1 from fluid_private.naming_brain_runs where owner_id=r.owner_id and observed_overrun) or j.state<>'running' or j.cancel_requested_at is not null or not fluid_private.naming_brain_ready(r,j.worker_id) or fluid_private.api_text_paid_paused(r.owner_id) then return false; end if;
 if p_request->>'runId' is distinct from r.id::text or p_request->>'snapshotHash' is distinct from r.snapshot_hash or p_request#>>'{policy,model}' is distinct from r.policy->>'model'
 or p_request#>>'{policy,protocol}' is distinct from 'openai_agents' or p_request#>'{policy,nativeDelegation}' is distinct from 'false'::jsonb
 or p_request#>>'{input,snapshot,snapshotHash}' is distinct from r.snapshot_hash or ((p_request#>'{input,snapshot}')-'strategyKey') is distinct from r.snapshot
 or octet_length(p_request::text)>131072 then raise exception 'invalid_dispatch_request' using errcode='22023'; end if;
 if not exists(select 1 from public.job_steps where job_id=j.id and step_key=stage and state='in_flight' and created_at+interval '240 seconds'>clock_timestamp()) then raise exception 'stage_not_started' using errcode='55000'; end if;
 phase:=case when stage<>'gap' then 'main' else case p_request->>'role' when 'director' then 'direction' when 'creator' then 'creation' when 'curator' then 'curation' when 'verifier' then 'verification' end end;
 select calls into plan from fluid_private.naming_brain_call_plans where run_id=r.id and stage_key=stage and phase_key=phase;
 select x into allocation from jsonb_array_elements(plan) x where x->>'providerCallKey'=p_request->>'providerCallKey';
 if allocation is null or allocation->>'role' is distinct from p_request->>'role' or allocation->'assignmentKey' is distinct from p_request->'assignmentKey'
 or allocation->>'requestKey' is distinct from p_request->>'requestKey' or allocation->>'requestHash' is distinct from p_request->>'requestHash'
 or allocation->'maxWebSearchCalls' is distinct from p_request#>'{policy,maxWebSearchCalls}' or allocation->'sessionLimitCents' is distinct from p_request#>'{policy,sessionLimitCents}'
 or (allocation->>'sessionLimitCents')::bigint*10000 is distinct from (p_request#>>'{policy,maximumCostMicrousd}')::bigint then raise exception 'call_plan_mismatch' using errcode='22023'; end if;
 if exists(select 1 from jsonb_array_elements_text(p_request->'dependencyArtifactIds') x where not exists(select 1 from fluid_private.naming_brain_artifacts a where a.id=x::uuid and a.run_id=r.id and a.owner_id=r.owner_id and a.artifact->>'snapshotHash'=r.snapshot_hash)) then raise exception 'dependency_mismatch' using errcode='22023'; end if;
 if exists(select 1 from fluid_private.naming_brain_calls where run_id=r.id and stage_key=stage and call_key=p_request->>'providerCallKey') then return false; end if;
 -- The complete call allocation is persisted before any dispatch. This insert is
 -- the single-use dispatch authorization and must be acknowledged before create.
 insert into fluid_private.naming_brain_calls(run_id,owner_id,project_id,stage_key,phase_key,call_key,request) values(r.id,r.owner_id,r.project_id,stage,phase,p_request->>'providerCallKey',p_request);
 return true; end $$;
create function public.record_naming_brain_provider_receipt(p_job_id uuid,p_lease_token uuid,p_receipt jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
 declare r fluid_private.naming_brain_runs; c fluid_private.naming_brain_calls; previous jsonb; key text; digest text; begin
 r:=fluid_private.naming_brain_lock(p_job_id,p_lease_token);
 select * into c from fluid_private.naming_brain_calls where run_id=r.id and stage_key=p_receipt->>'stageKey' and call_key=p_receipt->>'providerCallKey';
 if not found or p_receipt->>'runId' is distinct from r.id::text or p_receipt->>'snapshotHash' is distinct from r.snapshot_hash
 or p_receipt->>'protocol' is distinct from 'openai_agents' or p_receipt->>'provider' is distinct from 'openai' or p_receipt->>'billingMode' is distinct from 'openai_api'
 or p_receipt->>'requestHash' is distinct from c.request->>'requestHash' or p_receipt->>'requestKey' is distinct from c.request->>'requestKey'
 or p_receipt->'assignmentKey' is distinct from c.request->'assignmentKey' or p_receipt->>'role' is distinct from c.request->>'role'
 or p_receipt->'sessionLimitCents' is distinct from c.request#>'{policy,sessionLimitCents}'
 or p_receipt->>'accountingStatus' is distinct from 'provisional' or p_receipt->'confirmedActualCostMicrousd' is distinct from 'null'::jsonb
 or (p_receipt->>'observedModel' is not null and p_receipt->>'observedModel'<>r.policy->>'model') then raise exception 'receipt_mismatch' using errcode='22023'; end if;
 select receipt into previous from fluid_private.naming_brain_receipts where run_id=r.id and stage_key=c.stage_key and call_key=c.call_key order by created_at desc,id desc limit 1;
 foreach key in array array['sessionId','turnId','agentId','responseId'] loop
 if previous->>key is not null and previous->key is distinct from p_receipt->key then raise exception 'provider_identity_changed' using errcode='55000'; end if; end loop;
 digest:=encode(sha256(convert_to(p_receipt::text,'UTF8')),'hex');
 if exists(select 1 from fluid_private.naming_brain_receipts where run_id=r.id and content_hash=digest) then return p_receipt; end if;
 if (select count(*) from fluid_private.naming_brain_receipts where run_id=r.id)>=500 or (select coalesce(sum(octet_length(receipt::text)),0) from fluid_private.naming_brain_receipts where run_id=r.id)+octet_length(p_receipt::text)>8388608 then raise exception 'receipt_capacity' using errcode='22023'; end if;
 insert into fluid_private.naming_brain_receipts(run_id,owner_id,project_id,stage_key,call_key,receipt,content_hash) values(r.id,r.owner_id,r.project_id,c.stage_key,c.call_key,p_receipt,digest);
 if exists(select 1 from jsonb_array_elements(coalesce(p_receipt->'providerCostCounters','[]')) x where (x->>'value')::bigint>(p_receipt->>'sessionLimitCents')::integer) then update fluid_private.naming_brain_runs set observed_overrun=true where id=r.id; end if;
 return p_receipt; end $$;

create function public.complete_naming_brain_stage(p_job_id uuid,p_lease_token uuid,p_stage_key text,p_state text,p_output jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
 declare r fluid_private.naming_brain_runs; s public.job_steps; begin
 r:=fluid_private.naming_brain_lock(p_job_id,p_lease_token);
 select * into s from public.job_steps where job_id=p_job_id and step_key=p_stage_key for update;
 if not found or p_state not in('succeeded','failed','ambiguous') or jsonb_typeof(p_output)<>'object' or p_output-array['artifactIds','errorCode','partialArtifacts']<>'{}'
 or jsonb_typeof(p_output->'artifactIds') is distinct from 'array' or octet_length(p_output::text)>524288 then raise exception 'invalid_stage_result' using errcode='22023'; end if;
 if s.state<>'in_flight' then if s.state=p_state and s.output=p_output then return to_jsonb(s); end if; raise exception 'immutable_stage_result' using errcode='55000'; end if;
 if exists(select 1 from jsonb_array_elements_text(p_output->'artifactIds') x where not exists(select 1 from fluid_private.naming_brain_artifacts a where a.id=x::uuid and a.run_id=r.id and a.stage_key=p_stage_key))
 or (select count(distinct x) from jsonb_array_elements_text(p_output->'artifactIds') x)<>jsonb_array_length(p_output->'artifactIds') then raise exception 'artifact_mismatch' using errcode='22023'; end if;
 if p_state='succeeded' and p_stage_key not in('gap','prepare') and jsonb_array_length(p_output->'artifactIds')=0 then raise exception 'stage_artifact_required' using errcode='22023'; end if;
 if p_state='succeeded' and p_stage_key='prepare' and not exists(select 1 from fluid_private.naming_brain_prepared_sets where run_id=r.id) then raise exception 'preparation_required' using errcode='22023'; end if;
 if exists(select 1 from fluid_private.naming_brain_calls c where c.run_id=r.id and c.stage_key=p_stage_key
 and not exists(select 1 from fluid_private.naming_brain_receipts receipt where receipt.run_id=c.run_id and receipt.stage_key=c.stage_key and receipt.call_key=c.call_key and receipt.receipt->>'sessionId' is not null and receipt.receipt->>'turnId' is not null)) then
 p_state:='ambiguous';
 end if;
 -- Output completion records only confirmed subtotal (no billing writer exists
 -- on this runtime surface). Pending financial liability remains fully held.
 update public.job_steps set state=p_state,output=p_output,completed_at=clock_timestamp() where id=s.id returning * into s;
 update fluid_private.naming_brain_runs set revision=revision+1,updated_at=clock_timestamp(),recovery_mode=case when p_state='ambiguous' then recovery_mode else 'execute' end where id=r.id;
 if p_state='ambiguous' then update public.jobs set state='needs_reconciliation',lease_token=null,lease_expires_at=null,error_code=coalesce(p_output->>'errorCode','provider_outcome_unknown') where id=p_job_id; end if;
 return to_jsonb(s); end $$;

create function public.naming_brain_worker_action(p_job_id uuid,p_lease_token uuid,p_action text,p_payload jsonb default '{}') returns jsonb language plpgsql security definer set search_path='' as $$
 declare r fluid_private.naming_brain_runs; j public.jobs; s public.job_steps; stage text:=p_payload->>'stageKey'; manifest jsonb; old jsonb; v_artifact jsonb; v_receipt_id uuid;
 h fluid_private.naming_brain_heads; call fluid_private.naming_brain_calls; phase text; previous_phase text; phase_cap integer; phase_searches integer; phase_policy jsonb; v_record_key text; record_count integer;
 begin
 r:=fluid_private.naming_brain_lock(p_job_id,p_lease_token); select * into strict j from public.jobs where id=p_job_id;
 if jsonb_typeof(p_payload)<>'object' or octet_length(p_payload::text)>1048576 then raise exception 'invalid_worker_payload' using errcode='22023'; end if;
 case p_action
 when 'heartbeat' then return to_jsonb(public.heartbeat_job(p_job_id,p_lease_token,(p_payload->>'leaseSeconds')::integer));
 when 'plan' then
 select jsonb_agg(jsonb_build_object('key',key,'maximumCostMicrousd',fluid_private.naming_brain_cap(key)) order by n) into manifest from unnest(fluid_private.naming_brain_stages()) with ordinality ks(key,n);
 if p_payload->'manifest' is distinct from manifest or p_payload->'gapEnvelope' is distinct from r.gap_envelope then raise exception 'plan_conflict' using errcode='PT409'; end if;
 return to_jsonb(public.register_job_plan(p_job_id,p_lease_token,manifest));
 when 'begin' then
 if not(stage=any(fluid_private.naming_brain_stages())) or (p_payload->>'maximumCostMicrousd')::bigint is distinct from fluid_private.naming_brain_cap(stage) then raise exception 'invalid_stage' using errcode='22023'; end if;
 select * into s from public.job_steps where job_id=j.id and step_key=stage;
 if found then
 if s.request_key is distinct from p_payload->>'requestKey' then raise exception 'request_conflict' using errcode='PT409'; end if;
 if s.state='succeeded' then return jsonb_build_object('disposition','already_succeeded','step',to_jsonb(s)); end if;
 if r.recovery_mode='execute' and s.state='in_flight' and not exists(select 1 from fluid_private.naming_brain_calls where run_id=r.id and stage_key=stage) then return jsonb_build_object('disposition','started','step',to_jsonb(s)); end if;
 if r.recovery_mode='observe_only' and s.state='in_flight' then return jsonb_build_object('disposition','resume_observation','step',to_jsonb(s)); end if;
 raise exception 'stage_unresolved' using errcode='55000'; end if;
 if stage='direction' and not exists(select 1 from fluid_private.naming_brain_artifacts a where a.run_id=r.id and a.stage_key='research' and a.artifact->>'readiness'='sourced' and exists(select 1 from jsonb_array_elements(a.artifact->'sources') x where x->>'evidenceStatus'='retrieved')) then raise exception 'sourced_research_required' using errcode='55000'; end if;
 if r.recovery_mode<>'execute' or not fluid_private.naming_brain_ready(r,j.worker_id) or r.superseded or r.observed_overrun then raise exception 'runtime_unavailable' using errcode='55000'; end if;
 if exists(select 1 from unnest(fluid_private.naming_brain_stages()) with ordinality k(key,n) where n<array_position(fluid_private.naming_brain_stages(),stage) and not exists(select 1 from public.job_steps where job_id=j.id and step_key=key and state='succeeded')) then raise exception 'dependency_incomplete' using errcode='55000'; end if;
 s:=public.begin_job_step(j.id,p_lease_token,stage,p_payload->>'requestKey',fluid_private.naming_brain_cap(stage)); return jsonb_build_object('disposition','started','step',to_jsonb(s));
 when 'call_plan' then
 phase:=case when stage='gap' then p_payload->>'phase' else 'main' end;
 if (stage='gap' and (phase is null or phase not in('direction','creation','curation','verification'))) or (stage<>'gap' and p_payload ? 'phase') then raise exception 'invalid_call_phase' using errcode='22023'; end if;
 select value into phase_policy from jsonb_array_elements(r.gap_envelope->'phases') where value->>'phase'=phase;
 phase_cap:=case when stage<>'gap' then fluid_private.naming_brain_cap(stage)/10000 else (phase_policy->>'cents')::integer end;
 phase_searches:=case when stage<>'gap' then (r.policy#>>array['stageLimits',stage,'maxWebSearchCalls'])::integer else (phase_policy->>'searches')::integer end;
 previous_phase:=case phase when 'creation' then 'direction' when 'curation' then 'creation' when 'verification' then 'curation' end;
 -- Gap inputs depend on saved prior outputs. The envelopes are fixed before
 -- dispatch; only canonical request hashes wait for their actual dependencies.
 if stage='gap' and previous_phase is not null and (not exists(select 1 from fluid_private.naming_brain_call_plans where run_id=r.id and stage_key=stage and phase_key=previous_phase)
 or exists(select 1 from fluid_private.naming_brain_call_plans cp cross join lateral jsonb_array_elements(cp.calls) allocation where cp.run_id=r.id and cp.stage_key=stage and cp.phase_key=previous_phase
 and not exists(select 1 from fluid_private.naming_brain_artifacts a where a.run_id=r.id and a.stage_key=stage and a.artifact#>>'{providerReceipt,providerCallKey}'=allocation->>'providerCallKey'))) then raise exception 'gap_phase_dependency_incomplete' using errcode='55000'; end if;
 if not exists(select 1 from public.job_steps where job_id=j.id and step_key=stage and state='in_flight') or jsonb_typeof(p_payload->'calls')<>'array' or jsonb_array_length(p_payload->'calls') not between 1 and 60 then raise exception 'invalid_call_plan' using errcode='22023'; end if;
 if exists(select 1 from jsonb_array_elements(p_payload->'calls') x where x-array['providerCallKey','assignmentKey','requestKey','requestHash','sessionLimitCents','role','maxWebSearchCalls']<>'{}' or not(x ?& array['providerCallKey','assignmentKey','requestKey','requestHash','sessionLimitCents','role','maxWebSearchCalls']) or coalesce(x->>'providerCallKey','')!~'^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$' or coalesce(x->>'requestHash','')!~'^[0-9a-f]{64}$' or coalesce(x->>'requestKey','')!~'^[A-Za-z0-9._:-]{16,128}$' or (x->>'sessionLimitCents')::integer not between 1 and 150 or (jsonb_typeof(x->'sessionLimitCents') is distinct from 'number') or (jsonb_typeof(x->'maxWebSearchCalls') is distinct from 'number') or jsonb_typeof(x->'role') is distinct from 'string' or not(x->>'role'=any(case stage when 'research' then array['researcher'] when 'direction' then array['director'] when 'creation' then array['creator'] when 'curation' then array['curator'] when 'verification' then array['verifier'] when 'gap' then array[case phase when 'direction' then 'director' when 'creation' then 'creator' when 'curation' then 'curator' when 'verification' then 'verifier' end] else array[]::text[] end)) or ((x->>'role'='creator')<>(x->>'assignmentKey' is not null))) then raise exception 'invalid_call_plan' using errcode='22023'; end if;
 if (select sum((x->>'sessionLimitCents')::integer)*10000 from jsonb_array_elements(p_payload->'calls') x)>phase_cap*10000
 or (select sum((x->>'maxWebSearchCalls')::integer) from jsonb_array_elements(p_payload->'calls') x)>phase_searches or exists(select 1 from jsonb_array_elements(p_payload->'calls') x where (x->>'maxWebSearchCalls')::integer<0) or exists(select 1 from jsonb_array_elements(p_payload->'calls') x group by x->>'requestHash' having count(*)>1) or exists(select 1 from jsonb_array_elements(p_payload->'calls') x group by x->>'providerCallKey' having count(*)>1)
 or exists(select 1 from jsonb_array_elements(p_payload->'calls') x where x->>'role'='creator' group by x->>'assignmentKey' having count(*)>1) then raise exception 'call_allocation_exceeded' using errcode='22023'; end if;
 select calls into old from fluid_private.naming_brain_call_plans where run_id=r.id and stage_key=stage and phase_key=phase;
 if found then if old is distinct from p_payload->'calls' then raise exception 'immutable_call_plan' using errcode='55000'; end if; return old; end if;
 if exists(select 1 from fluid_private.naming_brain_call_plans cp cross join lateral jsonb_array_elements(cp.calls) prior join jsonb_array_elements(p_payload->'calls') next on prior->>'providerCallKey'=next->>'providerCallKey' where cp.run_id=r.id) then raise exception 'call_identity_reused' using errcode='22023'; end if;
 insert into fluid_private.naming_brain_call_plans values(r.id,r.owner_id,r.project_id,stage,phase,p_payload->'calls'); return p_payload->'calls';
 when 'stage' then
 if not(stage=any(fluid_private.naming_brain_stages())) then raise exception 'invalid_stage' using errcode='22023'; end if;
 select * into s from public.job_steps where job_id=j.id and step_key=stage;
 return jsonb_build_object('stageKey',stage,'gapEnvelope',r.gap_envelope,'gapPlanIdentity',r.gap_plan_identity,'state',coalesce(s.state,'pending'),'requestKey',s.request_key,'startedAt',s.created_at,'maximumCostMicrousd',fluid_private.naming_brain_cap(stage),'recoveryMode',r.recovery_mode,
 'artifacts',coalesce((select jsonb_agg(artifact order by id) from fluid_private.naming_brain_artifacts where run_id=r.id and stage_key=stage),'[]'),
 'receipts',coalesce((select jsonb_agg(receipt order by created_at,id) from fluid_private.naming_brain_receipts where run_id=r.id and stage_key=stage),'[]'),
 'callPlans',coalesce((select jsonb_agg(jsonb_build_object('phase',phase_key,'calls',calls) order by phase_key) from fluid_private.naming_brain_call_plans where run_id=r.id and stage_key=stage),'[]'),
 'requests',coalesce((select jsonb_agg(request order by authorized_at,call_key) from fluid_private.naming_brain_calls where run_id=r.id and stage_key=stage),'[]'),
 'providerItems',coalesce((select jsonb_agg(payload order by id) from fluid_private.naming_brain_provider_records where run_id=r.id and stage_key=stage and kind='provider_item'),'[]'),
 'toolResults',coalesce((select jsonb_agg(payload order by id) from fluid_private.naming_brain_provider_records where run_id=r.id and stage_key=stage and kind='tool_result'),'[]'));
 when 'provider_item','tool_result' then
 select * into call from fluid_private.naming_brain_calls where run_id=r.id and call_key=p_payload->>'providerCallKey';
 if not found or not exists(select 1 from fluid_private.naming_brain_receipts where run_id=r.id and stage_key=call.stage_key and call_key=call.call_key and receipt->>'sessionId'=p_payload->>'sessionId' and receipt->>'turnId'=p_payload->>'turnId') then raise exception 'provider_item_mismatch' using errcode='22023'; end if;
 v_record_key:=case p_action when 'provider_item' then p_payload->>'itemId' else p_payload->>'callId' end;
 if v_record_key is null or length(v_record_key) not between 1 and 300 or (p_action='tool_result' and p_payload->>'requestHash' is distinct from call.request->>'requestHash') then raise exception 'provider_item_mismatch' using errcode='22023'; end if;
 select payload into old from fluid_private.naming_brain_provider_records where run_id=r.id and stage_key=call.stage_key and call_key=call.call_key and kind=p_action and naming_brain_provider_records.record_key=v_record_key;
 if found then if old<>p_payload then raise exception 'immutable_provider_record' using errcode='55000'; end if; return old; end if;
 if (select count(*) from fluid_private.naming_brain_provider_records where run_id=r.id)>=500 or (select coalesce(sum(octet_length(payload::text)),0) from fluid_private.naming_brain_provider_records where run_id=r.id)+octet_length(p_payload::text)>8388608 then raise exception 'provider_record_capacity' using errcode='22023'; end if;
 insert into fluid_private.naming_brain_provider_records(run_id,owner_id,project_id,stage_key,call_key,kind,record_key,payload) values(r.id,r.owner_id,r.project_id,call.stage_key,call.call_key,p_action,v_record_key,p_payload); return p_payload;
 when 'artifact' then
 v_artifact:=p_payload->'artifact';
 if v_artifact->>'runId' is distinct from r.id::text or v_artifact->>'snapshotHash' is distinct from r.snapshot_hash or v_artifact->'schemaVersion' is distinct from '1'::jsonb or v_artifact->>'promptVersion' is distinct from 'naming-brain-v1' then raise exception 'artifact_mismatch' using errcode='22023'; end if;
 select pr.id into v_receipt_id from fluid_private.naming_brain_receipts pr where pr.run_id=r.id and pr.receipt=v_artifact->'providerReceipt';
 if v_receipt_id is null or not exists(select 1 from public.job_steps where job_id=j.id and step_key=v_artifact->>'stageKey' and state='in_flight') then raise exception 'artifact_receipt_missing' using errcode='22023'; end if;
 if v_artifact->>'stageKey' is distinct from v_artifact#>>'{providerReceipt,stageKey}' or v_artifact#>>'{output,role}' is distinct from v_artifact#>>'{providerReceipt,role}' then raise exception 'artifact_role_mismatch' using errcode='22023'; end if;
 select * into call from fluid_private.naming_brain_calls where run_id=r.id and stage_key=v_artifact->>'stageKey' and call_key=v_artifact#>>'{providerReceipt,providerCallKey}';
 if v_artifact#>>'{providerReceipt,dispatchState}' is distinct from 'dispatched' or v_artifact#>>'{providerReceipt,observedModel}' is distinct from r.policy->>'model' then raise exception 'completed_provider_evidence_required' using errcode='22023'; end if;
 if exists(select 1 from jsonb_array_elements(coalesce(v_artifact->'sourceDependencies','[]')) dependency where
 dependency->>'runId' is distinct from r.id::text or dependency->>'snapshotHash' is distinct from r.snapshot_hash or dependency->>'artifactId'=v_artifact->>'artifactId'
 or not(call.request->'dependencyArtifactIds' ? (dependency->>'artifactId'))
 or not exists(select 1 from fluid_private.naming_brain_artifacts saved where saved.id=(dependency->>'artifactId')::uuid and saved.run_id=r.id
 and saved.artifact->'providerReceipt'=dependency->'providerReceipt' and not exists(
 select 1 from jsonb_array_elements(dependency->'sources') binding where not exists(
 select 1 from jsonb_array_elements(saved.artifact->'sources') original join jsonb_array_elements(v_artifact->'sources') current_source on original=current_source
 where original->>'sourceKey'=binding->>'sourceKey' and original->>'providerItemId'=binding->>'providerItemId' and original->'contentHash'=binding->'contentHash')))) then raise exception 'inherited_source_binding_mismatch' using errcode='22023'; end if;
 if exists(select 1 from jsonb_array_elements(coalesce(v_artifact->'sources','[]')) source where source->>'evidenceStatus'='retrieved'
 and not exists(select 1 from fluid_private.naming_brain_provider_records pr where pr.run_id=r.id and pr.call_key=call.call_key and pr.stage_key=call.stage_key and pr.kind='tool_result' and pr.payload->'sourceEvidence'=source)
 and not exists(select 1 from jsonb_array_elements(coalesce(v_artifact->'sourceDependencies','[]')) dep cross join lateral jsonb_array_elements(dep->'sources') binding where binding->>'sourceKey'=source->>'sourceKey')) then raise exception 'retained_source_evidence_required' using errcode='22023'; end if;
 if v_artifact#>>'{output,role}'='researcher' and v_artifact->>'readiness'='sourced' and not exists(
 select 1 from jsonb_array_elements(v_artifact#>'{output,facts}') fact where jsonb_array_length(fact->'sourceKeys')>0 and not exists(
 select 1 from jsonb_array_elements_text(fact->'sourceKeys') source_key where not exists(select 1 from jsonb_array_elements(v_artifact->'sources') source where source->>'sourceKey'=source_key and source->>'evidenceStatus'='retrieved'))) then raise exception 'sourced_research_required' using errcode='22023'; end if;
 if v_artifact#>>'{output,role}'='creator' then
 if v_artifact#>>'{creatorAttribution,executionKind}' is distinct from 'independent_session'
 or v_artifact#>>'{output,assignmentKey}' is distinct from call.request->>'assignmentKey'
 or v_artifact#>>'{creatorAttribution,assignmentKey}' is distinct from call.request->>'assignmentKey'
 or v_artifact#>>'{creatorAttribution,assignmentInputHash}' is distinct from call.request->>'requestHash'
 or v_artifact#>>'{creatorAttribution,sessionId}' is distinct from v_artifact#>>'{providerReceipt,sessionId}'
 or v_artifact#>>'{creatorAttribution,turnId}' is distinct from v_artifact#>>'{providerReceipt,turnId}'
 or not(v_artifact#>'{providerReceipt,artifactItemIds}' ? (v_artifact#>>'{creatorAttribution,itemId}')) or not exists(
 select 1 from fluid_private.naming_brain_provider_records pr cross join lateral (
 select string_agg(part->>'text','' order by n) text from jsonb_array_elements(pr.payload#>'{item,content}') with ordinality parts(part,n) where part->>'type'='output_text') final
 where pr.run_id=r.id and pr.stage_key=call.stage_key and pr.call_key=call.call_key and pr.kind='provider_item' and pr.payload->>'itemId'=v_artifact#>>'{creatorAttribution,itemId}'
 and pr.payload#>>'{item,id}'=pr.payload->>'itemId' and pr.payload#>>'{item,role}'='assistant' and pr.payload#>>'{item,status}'='completed'
 and coalesce(pr.payload#>>'{item,phase}','')<>'commentary' and pr.payload#>>'{item,turn_id}'=v_artifact#>>'{providerReceipt,turnId}'
 and encode(sha256(convert_to(final.text,'UTF8')),'hex')=v_artifact#>>'{creatorAttribution,itemContentHash}' and final.text::jsonb=v_artifact->'output') then raise exception 'creator_item_proof_required' using errcode='22023'; end if;
 end if;
 select a.artifact into old from fluid_private.naming_brain_artifacts a where a.id=(v_artifact->>'artifactId')::uuid;
 if found then if old<>v_artifact then raise exception 'immutable_artifact' using errcode='55000'; end if; return old; end if;
 insert into fluid_private.naming_brain_artifacts values((v_artifact->>'artifactId')::uuid,r.id,r.owner_id,r.project_id,v_artifact->>'stageKey',v_artifact,v_receipt_id); return v_artifact;
 when 'index_page' then
 select * into h from fluid_private.naming_brain_heads where project_id=r.project_id and owner_id=r.owner_id;
 if coalesce((p_payload->>'limit')::integer,100) not between 1 and 500 then raise exception 'invalid_limit' using errcode='22023'; end if;
 if h.coverage_epoch=h.writer_epoch then return jsonb_build_object('epoch',h.writer_epoch,'entries','[]'::jsonb); end if;
 return jsonb_build_object('epoch',h.writer_epoch,'entries',coalesce((select jsonb_agg(jsonb_build_object('candidateId',id,'value',value) order by id) from(select c.id,c.value from public.name_candidates c where c.owner_id=r.owner_id and c.project_id=r.project_id and not exists(select 1 from fluid_private.naming_brain_identity_index indexed where indexed.candidate_id=c.id and indexed.owner_id=c.owner_id and indexed.project_id=c.project_id and indexed.value=c.value) and (p_payload->>'afterId' is null or c.id>(p_payload->>'afterId')::uuid) order by c.id limit coalesce((p_payload->>'limit')::integer,100)) page),'[]'));
 when 'index_record' then
 perform 1 from public.naming_sessions where project_id=r.project_id and owner_id=r.owner_id for update;
 select * into h from fluid_private.naming_brain_heads where project_id=r.project_id and owner_id=r.owner_id for update;
 if h.writer_epoch<>(p_payload->>'epoch')::bigint then raise exception 'identity_epoch_conflict' using errcode='PT409'; end if;
 if jsonb_typeof(p_payload->'entries')<>'array' or jsonb_array_length(p_payload->'entries')>500 then raise exception 'invalid_index_page' using errcode='22023'; end if;
 -- Validate and persist the bounded page as one relational operation. The
 -- source value remains mandatory; supplied historical identity keys have no authority.
 if exists(select 1 from jsonb_array_elements(p_payload->'entries') entry left join public.name_candidates c
 on c.id=(entry->>'candidateId')::uuid and c.owner_id=r.owner_id and c.project_id=r.project_id
 where c.id is null or entry->>'value' is distinct from c.value or jsonb_typeof(entry->'identityKey') is distinct from 'string') then raise exception 'identity_source_mismatch' using errcode='22023'; end if;
 insert into fluid_private.naming_brain_identity_index(candidate_id,owner_id,project_id,value,identity_key)
 select (entry->>'candidateId')::uuid,r.owner_id,r.project_id,entry->>'value',entry->>'identityKey' from jsonb_array_elements(p_payload->'entries') entry on conflict(candidate_id) do nothing;
 if exists(select 1 from jsonb_array_elements(p_payload->'entries') entry where not exists(select 1 from fluid_private.naming_brain_identity_index ix
 where ix.candidate_id=(entry->>'candidateId')::uuid and ix.owner_id=r.owner_id and ix.project_id=r.project_id and ix.value=entry->>'value' and ix.identity_key=entry->>'identityKey')) then raise exception 'identity_index_conflict' using errcode='55000'; end if;
 return jsonb_build_object('epoch',h.writer_epoch);
 when 'index_finalize' then
 perform 1 from public.naming_sessions where project_id=r.project_id and owner_id=r.owner_id for update;
 select * into h from fluid_private.naming_brain_heads where project_id=r.project_id and owner_id=r.owner_id for update;
 if h.writer_epoch<>(p_payload->>'epoch')::bigint or exists(select c.id,c.value from public.name_candidates c where c.owner_id=r.owner_id and c.project_id=r.project_id except select ix.candidate_id,ix.value from fluid_private.naming_brain_identity_index ix where ix.owner_id=r.owner_id and ix.project_id=r.project_id) then raise exception 'identity_coverage_incomplete' using errcode='PT409'; end if;
 update fluid_private.naming_brain_heads set coverage_epoch=writer_epoch where project_id=r.project_id; return jsonb_build_object('epoch',h.writer_epoch);
 when 'identities' then
 if jsonb_typeof(p_payload->'keys')<>'array' or jsonb_array_length(p_payload->'keys')>200 then raise exception 'invalid_identity_lookup' using errcode='22023'; end if;
 if not exists(select 1 from fluid_private.naming_brain_heads where project_id=r.project_id and coverage_epoch=writer_epoch) then raise exception 'identity_coverage_incomplete' using errcode='PT409'; end if;
 return (select coalesce(jsonb_agg(distinct identity_key),'[]') from fluid_private.naming_brain_identity_index where owner_id=r.owner_id and project_id=r.project_id and (p_payload->'keys') ? identity_key);
 when 'prepare' then return fluid_private.naming_brain_prepare(r,p_payload);
 when 'finish' then
 if p_payload->>'state' not in('succeeded','partial','failed','cancelled') or exists(select 1 from public.job_steps where job_id=j.id and state in('in_flight','ambiguous')) then raise exception 'unresolved_steps' using errcode='55000'; end if;
 if j.state='cancel_requested' and p_payload->>'state'<>'cancelled' then raise exception 'cancel_requested' using errcode='55000'; end if;
 if p_payload->>'state'='succeeded' and (not exists(select 1 from fluid_private.naming_brain_prepared_sets where run_id=r.id) or exists(select 1 from unnest(fluid_private.naming_brain_stages()) key where not exists(select 1 from public.job_steps where job_id=j.id and step_key=key and state='succeeded'))) then raise exception 'plan_incomplete' using errcode='55000'; end if;
 if (p_payload->>'state'='failed') and exists(select 1 from public.job_steps where job_id=j.id and state='succeeded') then raise exception 'invalid_outcome' using errcode='22023'; end if;
 update public.jobs set state=p_payload->>'state',finished_at=clock_timestamp(),lease_token=null,lease_expires_at=null,progress=case when p_payload->>'state'='succeeded' then 100 else progress end,error_code=p_payload->>'errorCode' where id=j.id;
 update fluid_private.naming_brain_runs set revision=revision+1,updated_at=clock_timestamp() where id=r.id;
 -- The scoped settlement guard releases only proven no-dispatch liability;
 -- every dispatched or uncertain managed request remains fully held.
 perform fluid_private.settle_reservation(j.id);
 select * into r from fluid_private.naming_brain_runs where job_id=j.id;
 return jsonb_build_object('state',p_payload->>'state','accounting',fluid_private.naming_brain_accounting(r));
 else raise exception 'unsupported_naming_action' using errcode='22023'; end case; end $$;

create function fluid_private.naming_brain_prepare(r fluid_private.naming_brain_runs,p_payload jsonb) returns jsonb language plpgsql set search_path='' as $$
 declare prepared jsonb:=p_payload->'preparedSet'; c jsonb; source jsonb; proposal jsonb; verified jsonb; finding jsonb; claims jsonb; metadata jsonb; publication jsonb:='[]';
 origin jsonb; v_set fluid_private.naming_brain_prepared_sets; h fluid_private.naming_brain_heads; counts jsonb; key text; count_selected integer; ids jsonb; v_candidate public.name_candidates; attribution jsonb; receipt jsonb;
 begin
 select * into v_set from fluid_private.naming_brain_prepared_sets where run_id=r.id;
 if found then if v_set.prepared<>prepared or v_set.publication->'request'<>p_payload then raise exception 'immutable_preparation' using errcode='55000'; end if; return jsonb_build_object('preparedSetId',v_set.id,'preparedSet',v_set.prepared); end if;
 if not exists(select 1 from public.job_steps where job_id=r.job_id and step_key='prepare' and state='in_flight') then raise exception 'prepare_not_started' using errcode='55000'; end if;
 if prepared->>'runId' is distinct from r.id::text or prepared->>'snapshotHash' is distinct from r.snapshot_hash or prepared->>'stageKey' is distinct from 'prepare'
 or prepared->'targetCount' is distinct from '100'::jsonb or prepared->'minimumPerApproach' is distinct from '5'::jsonb
 or prepared->'schemaVersion' is distinct from '1'::jsonb or prepared->>'promptVersion' is distinct from 'naming-brain-v1'
 or jsonb_typeof(prepared->'candidateIds')<>'array' or jsonb_array_length(prepared->'candidateIds')>100
 or jsonb_typeof(p_payload->'candidates')<>'array' or jsonb_array_length(p_payload->'candidates')>200 then raise exception 'invalid_preparation' using errcode='22023'; end if;
 select artifact into verified from fluid_private.naming_brain_artifacts where id=(prepared->>'verificationArtifactId')::uuid and run_id=r.id and artifact#>>'{output,role}'='verifier';
 if verified is null or p_payload#>'{verification,artifact}' is distinct from verified
 or not exists(select 1 from fluid_private.naming_brain_artifacts where id=(prepared->>'curationArtifactId')::uuid and run_id=r.id and artifact#>>'{output,role}'='curator')
 or exists(select 1 from jsonb_array_elements_text(prepared->'sourceArtifactIds') x where not exists(select 1 from fluid_private.naming_brain_artifacts where id=x::uuid and run_id=r.id)) then raise exception 'preparation_source_mismatch' using errcode='22023'; end if;
 perform 1 from public.naming_sessions where project_id=r.project_id and owner_id=r.owner_id for update;
 select * into h from fluid_private.naming_brain_heads where project_id=r.project_id and owner_id=r.owner_id for update;
 if h.coverage_epoch is distinct from h.writer_epoch then raise exception 'identity_coverage_incomplete' using errcode='PT409'; end if;
 if (select count(distinct x) from jsonb_array_elements_text(prepared->'candidateIds') x)<>jsonb_array_length(prepared->'candidateIds') then raise exception 'duplicate_prepared_identity' using errcode='22023'; end if;
 for key in select value from jsonb_array_elements_text(prepared->'candidateIds') loop
 select x into c from jsonb_array_elements(p_payload->'candidates') x where x->>'candidateId'=key;
 if c is null or c->>'runId' is distinct from r.id::text or c->>'snapshotHash' is distinct from r.snapshot_hash or coalesce(c->>'identityKey','')='' or not(r.snapshot#>'{preferences,approaches}' ? (c->>'primaryApproach')) then raise exception 'invalid_prepared_candidate' using errcode='22023'; end if;
 select artifact into source from fluid_private.naming_brain_artifacts where id=(c->>'sourceArtifactId')::uuid and run_id=r.id and stage_key in('creation','gap');
 select x into proposal from jsonb_array_elements(source#>'{output,candidates}') x where x->>'candidateKey'=c->>'candidateKey';
 if not(c ? 'value') then
 if c-array['candidateId','sourceArtifactId','candidateKey','assignmentKey','identityKey','runId','snapshotHash']<>'{}' then raise exception 'invalid_candidate_reference' using errcode='22023'; end if;
 c:=coalesce(proposal,'{}')||c;
 end if;
 if (r.snapshot#>'{preferences,approaches}' ? (c->>'primaryApproach')) is distinct from true then raise exception 'unselected_primary_approach' using errcode='22023'; end if;
 if source is null or proposal is null or not exists(select 1 from jsonb_array_elements(source->'candidateIds') x where x->>'candidateId'=key and x->>'candidateKey'=c->>'candidateKey')
 or (c-array['candidateId','sourceArtifactId','runId','snapshotHash','assignmentKey','assignmentOrder','generatedOrder','identityKey','sources']) is distinct from proposal
 or source#>>'{output,assignmentKey}' is distinct from c->>'assignmentKey' then raise exception 'candidate_source_mismatch' using errcode='22023'; end if;
 if exists(select 1 from fluid_private.naming_brain_identity_index where owner_id=r.owner_id and project_id=r.project_id and identity_key=c->>'identityKey')
 or exists(select 1 from jsonb_array_elements(publication) x where x->>'identityKey'=c->>'identityKey') then raise exception 'duplicate_history' using errcode='PT409'; end if;
 if exists(select 1 from jsonb_array_elements(proposal->'claims') claim where claim->>'requirement'='primary_approach' and not exists(select 1 from jsonb_array_elements(verified#>'{output,findings}') f where f->>'assignmentKey'=c->>'assignmentKey' and f->>'candidateKey'=c->>'candidateKey' and f->>'claimKey'=claim->>'claimKey' and f->>'status' in('supported','corrected') and f->'supportsPrimaryApproach'='true' and jsonb_array_length(f->'evidence')>0)) then raise exception 'unsupported_primary_approach' using errcode='22023'; end if;
 select coalesce(jsonb_agg(jsonb_build_object('claimKey',f->'claimKey','statement',f->'supportedWording','sourceKeys',f->'sourceKeys','evidence',f->'evidence')),'[]') into claims
 from jsonb_array_elements(verified#>'{output,findings}') f where f->>'assignmentKey'=c->>'assignmentKey' and f->>'candidateKey'=c->>'candidateKey' and f->>'status' in('supported','corrected') and f->>'supportedWording' is not null and jsonb_array_length(f->'evidence')>0;
 receipt:=source->'providerReceipt'; attribution:=source->'creatorAttribution';
 if receipt->>'protocol'<>'openai_agents' or receipt->>'sessionId' is null or receipt->>'turnId' is null or attribution->>'itemId' is null
 or receipt->>'observedModel' is distinct from r.policy->>'model' or attribution->>'sessionId' is distinct from receipt->>'sessionId' or attribution->>'turnId' is distinct from receipt->>'turnId' or not(receipt->'artifactItemIds' ? (attribution->>'itemId')) then raise exception 'creator_attribution_missing' using errcode='22023'; end if;
 origin:=jsonb_build_object('kind','generated','version',2,'handlerVersion','naming-brain-v1','ownerId',r.owner_id,'projectId',r.project_id,'candidateId',key,'contextRevision',r.snapshot->'contextRevision',
 'value',c->'value','batchId',r.batch_id,'jobId',r.job_id,'stepKey','prepare','runId',r.id,'sourceArtifactId',c->'sourceArtifactId','sourceStageKey',source->'stageKey',
 'provider','openai','billingMode','openai_api','model',receipt->'observedModel','requestId',receipt->'requestId','providerItemId',attribution->'itemId','generatedAt',receipt->'recordedAt',
 'protocol','openai_agents','sessionId',receipt->'sessionId','turnId',receipt->'turnId','agentId',receipt->'agentId','responseId',null);
 insert into public.name_candidates(id,owner_id,project_id,value,identity_key,context_revision,strategy_basis,origin,rationale,caution,batch_id)
 values(key::uuid,r.owner_id,r.project_id,c->>'value',c->>'identityKey',(r.snapshot->>'contextRevision')::integer,r.snapshot->'strategyBasis',origin,c->>'rationale',c->>'caution',r.batch_id);
 insert into fluid_private.naming_brain_identity_index(candidate_id,owner_id,project_id,value,identity_key) values(key::uuid,r.owner_id,r.project_id,c->>'value',c->>'identityKey');
 publication:=publication||jsonb_build_array(jsonb_build_object('candidateId',key,'identityKey',c->'identityKey','primaryApproach',c->'primaryApproach','additionalApproaches',c->'additionalApproaches','publishedClaims',claims));
 end loop;
 select jsonb_agg(jsonb_build_object('approach',a,'count',(select count(*) from jsonb_array_elements(publication) x where x->>'primaryApproach'=a)) order by n) into counts from jsonb_array_elements_text(r.snapshot#>'{preferences,approaches}') with ordinality aa(a,n);
 if exists(select 1 from jsonb_array_elements(counts) x where not exists(select 1 from jsonb_array_elements(prepared->'primaryCounts') y where y=x)) or jsonb_array_length(counts)<>jsonb_array_length(prepared->'primaryCounts')
 or prepared#>'{fulfillment,acceptedCount}' is distinct from to_jsonb(jsonb_array_length(publication)) or prepared#>'{fulfillment,coverageSatisfied}' is distinct from to_jsonb(not exists(select 1 from jsonb_array_elements(counts) x where (x->>'count')::integer<5))
 or prepared#>>'{fulfillment,status}' is distinct from (case when jsonb_array_length(publication)=0 then 'none' when jsonb_array_length(publication)=100 and not exists(select 1 from jsonb_array_elements(counts) x where (x->>'count')::integer<5) then 'complete' else 'partial' end) then raise exception 'preparation_coverage_mismatch' using errcode='22023'; end if;
 insert into fluid_private.naming_brain_prepared_sets(run_id,owner_id,project_id,prepared,publication) values(r.id,r.owner_id,r.project_id,prepared,jsonb_build_object('request',p_payload,'entries',publication)) returning * into v_set;
 insert into public.naming_batch_results(batch_id,owner_id,project_id,result,completion_input) values(r.batch_id,r.owner_id,r.project_id,
 jsonb_build_object('version',2,'ownerId',r.owner_id,'projectId',r.project_id,'batchId',r.batch_id,'jobId',r.job_id,'runId',r.id,'preparedSetId',v_set.id,'stepKey','prepare','candidateIds',prepared->'candidateIds','fulfillment',prepared->'fulfillment','completedAt',v_set.created_at),prepared);
 update fluid_private.naming_brain_heads set coverage_epoch=writer_epoch where project_id=r.project_id;
 update fluid_private.naming_brain_runs set revision=revision+1,updated_at=clock_timestamp() where id=r.id;
 return jsonb_build_object('preparedSetId',v_set.id,'preparedSet',prepared); end $$;

create function public.append_prepared_naming_set(p_project_id uuid,p_set_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
 declare o uuid:=auth.uid(); h fluid_private.naming_brain_heads; r fluid_private.naming_brain_runs; ps fluid_private.naming_brain_prepared_sets; p public.projects; item jsonb; v_entry_id uuid; ids jsonb:='[]'; cursor jsonb; begin
 perform fluid_private.lock_strategy_owner(o); h:=fluid_private.naming_brain_head(p_project_id,o);
 if h.paused then raise exception 'feed_paused' using errcode='PT409'; end if;
 select * into ps from fluid_private.naming_brain_prepared_sets where id=p_set_id and project_id=p_project_id and owner_id=o;
 if not found then raise exception 'not_found' using errcode='P0002'; end if;
 select * into strict r from fluid_private.naming_brain_runs where id=ps.run_id;
 select * into strict p from public.projects where id=p_project_id and owner_id=o;
 if p.deletion_requested_at is not null or p.deleted_at is not null then raise exception 'project_deleted' using errcode='PT409'; end if;
 select jsonb_build_object('entryId',f.id,'position',f.position) into cursor from fluid_private.naming_brain_feed_entries f where f.project_id=p_project_id and f.position<(select min(position) from fluid_private.naming_brain_feed_entries where set_id=ps.id) order by f.position desc limit 1;
 select coalesce(jsonb_agg(f.id order by f.position),'[]') into ids from fluid_private.naming_brain_feed_entries f where set_id=ps.id;
 if jsonb_array_length(ids)>0 then return jsonb_build_object('status','appended','feed',public.get_naming_feed(p_project_id,jsonb_build_object('cursor',cursor)),'runId',r.id,'appendedEntryIds',ids); end if;
 if r.superseded or h.steering_revision<>(r.snapshot->>'steeringRevision')::integer or (select preferences_version from public.naming_sessions where project_id=p.id)<>(r.snapshot->>'preferencesVersion')::integer
 or (select fluid_private.naming_strategy_basis(context) from public.project_revisions where project_id=p.id and owner_id=o and revision=p.current_revision)<>r.snapshot->'strategyBasis' then raise exception 'prepared_direction_conflict' using errcode='PT409'; end if;
 if jsonb_array_length(ps.prepared->'candidateIds')=0 then return fluid_private.naming_brain_ensure_response(r,true); end if;
 select jsonb_build_object('entryId',f.id,'position',f.position) into cursor from fluid_private.naming_brain_feed_entries f where f.project_id=p.id order by position desc limit 1;
 for item in select value from jsonb_array_elements(ps.publication->'entries') loop
 insert into fluid_private.naming_brain_feed_entries(owner_id,project_id,run_id,set_id,candidate_id,position,steering_revision,metadata)
 values(o,p.id,r.id,ps.id,(item->>'candidateId')::uuid,h.next_position,h.steering_revision,item-'candidateId'-'identityKey') returning naming_brain_feed_entries.id into v_entry_id;
 ids:=ids||to_jsonb(v_entry_id); h.next_position:=h.next_position+1; end loop;
 update fluid_private.naming_brain_heads set next_position=h.next_position where project_id=p.id;
 return jsonb_build_object('status','appended','feed',public.get_naming_feed(p.id,jsonb_build_object('cursor',cursor)),'runId',r.id,'appendedEntryIds',ids); end $$;

create function public.stop_naming_feed(p_project_id uuid,p_intent jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
 declare o uuid:=auth.uid(); h fluid_private.naming_brain_heads; old fluid_private.naming_brain_intents; pending fluid_private.naming_brain_intents; j public.jobs; begin
 if o is null then raise exception 'unauthenticated' using errcode='42501'; end if;
 if jsonb_typeof(p_intent)<>'object' or p_intent-array['version','expectedDemandSequence','pendingEnsureIdempotencyKey','idempotencyKey']<>'{}'
 or not(p_intent ?& array['version','expectedDemandSequence','pendingEnsureIdempotencyKey','idempotencyKey']) or p_intent->'version' is distinct from '1'::jsonb
 or jsonb_typeof(p_intent->'expectedDemandSequence')<>'number' or p_intent->>'expectedDemandSequence'!~'^[0-9]+$'
 or coalesce(p_intent->>'idempotencyKey','')!~'^[A-Za-z0-9._:-]{16,128}$'
 or (p_intent->'pendingEnsureIdempotencyKey'<>'null'::jsonb and coalesce(p_intent->>'pendingEnsureIdempotencyKey','')!~'^[A-Za-z0-9._:-]{16,128}$') then raise exception 'invalid_stop' using errcode='22023'; end if;
 perform fluid_private.lock_strategy_owner(o); h:=fluid_private.naming_brain_head(p_project_id,o);
 select * into old from fluid_private.naming_brain_intents where owner_id=o and request_key=p_intent->>'idempotencyKey';
 if found then if old.kind<>'stop' or old.project_id<>p_project_id or old.request<>p_intent then raise exception 'idempotency_conflict' using errcode='PT409'; end if;
 return jsonb_build_object('feed',public.get_naming_feed(p_project_id)); end if;
 if h.demand_sequence<>(p_intent->>'expectedDemandSequence')::integer then
 select * into pending from fluid_private.naming_brain_intents where owner_id=o and project_id=p_project_id and kind='ensure' and request_key=p_intent->>'pendingEnsureIdempotencyKey';
 if not found or pending.run_id is distinct from h.current_run_id or pending.request->'expectedDemandSequence' is distinct from p_intent->'expectedDemandSequence'
 or pending.request->>'reason'<>'resume' or (pending.response->>'committedDemandSequence')::integer is distinct from h.demand_sequence then raise exception 'demand_conflict' using errcode='PT409'; end if;
 end if;
 update fluid_private.naming_brain_heads set paused=true,demand_sequence=demand_sequence+1 where project_id=p_project_id;
 for j in select * from public.jobs where owner_id=o and project_id=p_project_id and operation='naming.generate' and state in('queued','running','cancel_requested') loop perform public.request_job_cancel(j.id); end loop;
 insert into fluid_private.naming_brain_intents values(o,p_project_id,p_intent->>'idempotencyKey','stop',p_intent,h.current_run_id,jsonb_build_object('committedDemandSequence',h.demand_sequence+1));
 return jsonb_build_object('feed',public.get_naming_feed(p_project_id)); end $$;

create function public.steer_naming_feed(p_project_id uuid,p_intent jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
 declare o uuid:=auth.uid(); h fluid_private.naming_brain_heads; p public.projects; old fluid_private.naming_brain_intents; r fluid_private.naming_brain_runs; superseded jsonb:='[]'; cancelled jsonb:='[]'; response jsonb; begin
 if o is null then raise exception 'unauthenticated' using errcode='42501'; end if;
 if jsonb_typeof(p_intent)<>'object' or p_intent-array['expectedProjectRevision','expectedPreferencesVersion','expectedSteeringRevision','candidateIds','instruction','idempotencyKey']<>'{}'
 or not(p_intent ?& array['expectedProjectRevision','expectedPreferencesVersion','expectedSteeringRevision','candidateIds','instruction','idempotencyKey'])
 or coalesce(p_intent->>'idempotencyKey','')!~'^[A-Za-z0-9._:-]{16,128}$' or jsonb_typeof(p_intent->'candidateIds')<>'array' or jsonb_array_length(p_intent->'candidateIds') not between 1 and 5 then raise exception 'invalid_steering' using errcode='22023'; end if;
 perform fluid_private.lock_strategy_owner(o); h:=fluid_private.naming_brain_head(p_project_id,o);
 select * into old from fluid_private.naming_brain_intents where owner_id=o and request_key=p_intent->>'idempotencyKey';
 if found then if old.kind<>'steer' or old.project_id<>p_project_id or old.request<>p_intent then raise exception 'steering_conflict' using errcode='PT409'; end if; return old.response||jsonb_build_object('feed',public.get_naming_feed(p_project_id)); end if;
 select * into strict p from public.projects where id=p_project_id and owner_id=o;
 if p.deletion_requested_at is not null or p.deleted_at is not null then raise exception 'project_deleted' using errcode='PT409'; end if;
 if p.current_revision<>(p_intent->>'expectedProjectRevision')::integer or (select preferences_version from public.naming_sessions where project_id=p.id) is distinct from (p_intent->>'expectedPreferencesVersion')::integer or h.steering_revision<>(p_intent->>'expectedSteeringRevision')::integer then raise exception 'revision_conflict' using errcode='PT409'; end if;
 if (select count(distinct x) from jsonb_array_elements_text(p_intent->'candidateIds') x)<>jsonb_array_length(p_intent->'candidateIds')
 or exists(select 1 from jsonb_array_elements_text(p_intent->'candidateIds') x where not exists(select 1 from public.name_candidates where id=x::uuid and owner_id=o and project_id=p.id)) then raise exception 'not_found' using errcode='P0002'; end if;
 update fluid_private.naming_brain_heads set steering_revision=steering_revision+1,demand_sequence=case when paused then demand_sequence else demand_sequence+1 end,current_run_id=null,strong_seed_ids=p_intent->'candidateIds',steering_instruction=p_intent->>'instruction' where project_id=p.id;
 for r in select * from fluid_private.naming_brain_runs rr where rr.owner_id=o and rr.project_id=p.id and not rr.superseded and not exists(select 1 from fluid_private.naming_brain_runs child where child.resumed_from_run_id=rr.id) and not exists(select 1 from fluid_private.naming_brain_feed_entries where run_id=rr.id) and (exists(select 1 from public.jobs where id=rr.job_id and state in('queued','running','cancel_requested','needs_reconciliation')) or exists(select 1 from fluid_private.naming_brain_prepared_sets where run_id=rr.id)) loop
 update fluid_private.naming_brain_runs set superseded=true,revision=revision+1,updated_at=clock_timestamp() where id=r.id; superseded:=superseded||to_jsonb(r.id);
 if exists(select 1 from public.jobs where id=r.job_id and state in('queued','running','cancel_requested')) then perform public.request_job_cancel(r.job_id); cancelled:=cancelled||to_jsonb(r.id); end if; end loop;
 response:=jsonb_build_object('feed',public.get_naming_feed(p.id),'supersededRunIds',superseded,'cancellationRequestedRunIds',cancelled);
 insert into fluid_private.naming_brain_intents values(o,p.id,p_intent->>'idempotencyKey','steer',p_intent,null,response); return response; end $$;

do $$ declare d text; needle text:='select * into v_policy from fluid_private.subscription_runtime_policy where owner_id=v_owner and operation=''naming.generate'';'; begin
 d:=pg_get_functiondef('public.get_naming_availability(uuid)'::regprocedure);
 if position(needle in d)=0 then raise exception 'unexpected_naming_availability_definition'; end if;
 execute replace(d,needle,$patch$if exists(select 1 from public.naming_sessions session join public.naming_preferences pref on pref.project_id=session.project_id and pref.owner_id=session.owner_id and pref.version=session.preferences_version where session.project_id=p_project_id and session.owner_id=v_owner and pref.preferences->'version'='2'::jsonb) then
 return jsonb_build_object('status','unavailable','operation','naming.generate','reason','naming_policy_unavailable'); end if;
 $patch$||needle); end $$;

-- Exact lost-ack replay never rebases against a different preference head.
do $$ declare d text; needle text:='if coalesce(v_session.preferences_version,0)<>p_expected_version then'; begin
 d:=pg_get_functiondef('public.save_naming_preferences(uuid,integer,jsonb)'::regprocedure);
 if position(needle in d)=0 then raise exception 'unexpected_naming_preference_definition'; end if;
 execute replace(d,needle,$patch$if v_session.preferences_version=p_expected_version+1 then
 select * into v_preferences from public.naming_preferences where project_id=p_project_id and owner_id=v_owner and version=v_session.preferences_version and preferences=p_preferences;
 if found then return jsonb_build_object('session',fluid_private.naming_session_dto(v_session),'preferences',fluid_private.naming_preference_dto(v_preferences)); end if;
 end if;
 if coalesce(v_session.preferences_version,0)<>p_expected_version then$patch$); end $$;

create function public.get_naming_brain_job_accounting(p_job_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
 declare r fluid_private.naming_brain_runs; begin
 if not exists(select 1 from public.jobs where id=p_job_id and owner_id=auth.uid()) then raise exception 'not_found' using errcode='P0002'; end if;
 select * into r from fluid_private.naming_brain_runs where job_id=p_job_id and owner_id=auth.uid();
 return case when found then fluid_private.naming_brain_accounting(r) else null end; end $$;
create function public.get_naming_brain_candidate_source(p_project_id uuid,p_candidate_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
 declare c public.name_candidates; r fluid_private.naming_brain_runs; a fluid_private.naming_brain_artifacts; ps fluid_private.naming_brain_prepared_sets; proposal jsonb; begin
 select * into c from public.name_candidates where id=p_candidate_id and project_id=p_project_id and owner_id=auth.uid(); if not found then raise exception 'not_found' using errcode='P0002'; end if;
 select * into r from fluid_private.naming_brain_runs where id=(c.origin->>'runId')::uuid and batch_id=c.batch_id and owner_id=c.owner_id and project_id=c.project_id;
 select * into a from fluid_private.naming_brain_artifacts where id=(c.origin->>'sourceArtifactId')::uuid and run_id=r.id and owner_id=c.owner_id and project_id=c.project_id;
 select * into ps from fluid_private.naming_brain_prepared_sets where run_id=r.id;
 select x into proposal from jsonb_array_elements(a.artifact#>'{output,candidates}') x join jsonb_array_elements(a.artifact->'candidateIds') ids on ids->>'candidateKey'=x->>'candidateKey' where ids->>'candidateId'=c.id::text;
 if r.id is null or a.id is null or proposal is null or not(ps.prepared->'candidateIds' ? c.id::text) then raise exception 'invalid_generated_source' using errcode='55000'; end if;
 return jsonb_build_object('ownerId',c.owner_id,'projectId',c.project_id,'candidateId',c.id,'runId',r.id,'jobId',r.job_id,'batchId',r.batch_id,
 'snapshot',r.snapshot,'sourceArtifactId',a.id,'sourceStageKey',a.stage_key,'sourceCandidate',proposal,'providerReceipt',a.artifact->'providerReceipt','creatorAttribution',a.artifact->'creatorAttribution',
 'preparedSetId',ps.id,'preparedCandidateIds',ps.prepared->'candidateIds'); end $$;

-- Only a separately verified financial writer may insert billing evidence. No
-- live role or model/application function tool receives this private operation.
create function fluid_private.naming_brain_reconcile(p_run_id uuid,p_evidence_id uuid) returns jsonb language plpgsql set search_path='' as $$
 declare r fluid_private.naming_brain_runs; e fluid_private.naming_brain_financial_evidence; reservation public.usage_reservations; delta bigint; captured bigint; begin
 select * into r from fluid_private.naming_brain_runs where id=p_run_id; if not found then raise exception 'not_found' using errcode='P0002'; end if;
 perform fluid_private.lock_strategy_owner(r.owner_id);
 perform 1 from public.jobs where id=r.job_id for update;
 select * into r from fluid_private.naming_brain_runs where id=p_run_id for update;
 select * into e from fluid_private.naming_brain_financial_evidence where id=p_evidence_id and run_id=r.id and owner_id=r.owner_id and project_id=r.project_id;
 if not found or e.evidence->>'kind'<>'confirmed_provider_billing' or coalesce(e.evidence->>'sourceRecordId','')='' or e.evidence->'final' is distinct from 'true'::jsonb
 or jsonb_typeof(e.evidence->'coveredCallKeys') is distinct from 'array' or not exists(select 1 from public.jobs where id=r.job_id and state in('succeeded','partial','failed','cancelled'))
 or exists(select 1 from fluid_private.naming_brain_calls c where c.run_id=r.id and not(e.evidence->'coveredCallKeys' ? c.call_key)) then raise exception 'verified_financial_evidence_required' using errcode='55000'; end if;
 if r.actual_cost_microusd is not null then if r.actual_cost_microusd=e.confirmed_total_microusd and r.settlement_evidence=e.evidence then return fluid_private.naming_brain_accounting(r); end if; raise exception 'immutable_settlement' using errcode='55000'; end if;
 select * into strict reservation from public.usage_reservations where job_id=r.job_id for update;
 delta:=e.confirmed_total_microusd-reservation.actual_microusd; if delta<0 then raise exception 'conflicting_financial_evidence' using errcode='55000'; end if;
 captured:=least(greatest(reservation.reserved_microusd-reservation.captured_microusd,0),delta);
 update public.usage_accounts set spent_microusd=spent_microusd+captured,provider_actual_microusd=provider_actual_microusd+delta,reserved_microusd=reserved_microusd-captured where owner_id=r.owner_id;
 update public.usage_reservations set actual_microusd=e.confirmed_total_microusd,captured_microusd=captured_microusd+captured where job_id=r.job_id;
 update public.jobs set actual_cost_microusd=e.confirmed_total_microusd where id=r.job_id;
 update fluid_private.naming_brain_runs set actual_cost_microusd=e.confirmed_total_microusd,settlement_evidence=e.evidence,observed_overrun=observed_overrun or e.confirmed_total_microusd>5000000,revision=revision+1,updated_at=clock_timestamp() where id=r.id returning * into r;
 perform fluid_private.naming_brain_legacy_settle(r.job_id);
 return fluid_private.naming_brain_accounting(r); end $$;

create function fluid_private.naming_brain_protect_run() returns trigger language plpgsql set search_path='' as $$
 begin
 if tg_op='DELETE' then raise exception 'immutable_naming_run' using errcode='55000'; end if;
 if (to_jsonb(new)-array['revision','updated_at','recovery_mode','observed_overrun','actual_cost_microusd','settlement_evidence','superseded']) is distinct from (to_jsonb(old)-array['revision','updated_at','recovery_mode','observed_overrun','actual_cost_microusd','settlement_evidence','superseded'])
 or (old.actual_cost_microusd is not null and (new.actual_cost_microusd,new.settlement_evidence) is distinct from (old.actual_cost_microusd,old.settlement_evidence))
 or (old.observed_overrun and not new.observed_overrun) or (old.superseded and not new.superseded) then raise exception 'immutable_naming_run' using errcode='55000'; end if;
 new.revision:=old.revision+1;new.updated_at:=clock_timestamp();return new; end $$;
create trigger naming_brain_run_immutable before update or delete on fluid_private.naming_brain_runs for each row execute function fluid_private.naming_brain_protect_run();
do $$ declare t text; begin
 foreach t in array array['naming_brain_intents','naming_brain_call_plans','naming_brain_calls','naming_brain_receipts','naming_brain_artifacts','naming_brain_prepared_sets','naming_brain_feed_entries','naming_brain_identity_index','naming_brain_financial_evidence','naming_brain_provider_records'] loop
 execute format('create trigger naming_brain_history_immutable before update or delete on fluid_private.%I for each row execute function fluid_private.prevent_history_change()',t); end loop;
end $$;

do $$ declare sig text; old_name text; new_name text; d text; begin
 for sig,old_name,new_name in values
 ('fluid_private.naming_batch_dto(public.naming_batches)','fluid_private.naming_batch_dto','fluid_private.naming_brain_legacy_batch_dto'),
 ('fluid_private.naming_job_dto(public.naming_batches)','fluid_private.naming_job_dto','fluid_private.naming_brain_legacy_job_dto') loop
 d:=pg_get_functiondef(sig::regprocedure); execute replace(d,'FUNCTION '||old_name||'(','FUNCTION '||new_name||'('); end loop;
end $$;
create or replace function fluid_private.naming_batch_dto(p_batch public.naming_batches) returns jsonb language sql stable set search_path='' as $$
 select fluid_private.naming_brain_legacy_batch_dto(p_batch)||case when p_batch.engine_version=2 then jsonb_build_object('version',2,'handlerVersion','naming-brain-v1','billingMode','openai_api','runId',(select id from fluid_private.naming_brain_runs where batch_id=p_batch.id)) else '{}'::jsonb end;
$$;
create or replace function fluid_private.naming_job_dto(p_batch public.naming_batches) returns jsonb language plpgsql stable set search_path='' as $$
 declare r fluid_private.naming_brain_runs; j public.jobs; ps fluid_private.naming_brain_prepared_sets; result jsonb; begin
 if p_batch.engine_version=1 then return fluid_private.naming_brain_legacy_job_dto(p_batch); end if;
 select * into strict r from fluid_private.naming_brain_runs where batch_id=p_batch.id and owner_id=p_batch.owner_id and project_id=p_batch.project_id;
 select * into strict j from public.jobs where id=r.job_id;
 select * into ps from fluid_private.naming_brain_prepared_sets where run_id=r.id;
 result:=case when ps.id is null then '[]'::jsonb else jsonb_build_array(jsonb_build_object('stepKey','prepare','output',jsonb_build_object('version',2,'operation','naming.generate','handlerVersion','naming-brain-v1','provider','openai','billingMode','openai_api','runId',r.id,'jobId',j.id,'batchId',p_batch.id,'preparedSet',ps.prepared,'completedAt',ps.created_at))) end;
 return jsonb_build_object('id',j.id,'owner_id',j.owner_id,'project_id',j.project_id,'operation',j.operation,'input_revision',j.input_revision,'state',j.state,'progress',j.progress,
 'error_code',j.error_code,'cancel_requested_at',j.cancel_requested_at,'created_at',j.created_at,'finished_at',j.finished_at,'version',2,'handlerVersion','naming-brain-v1','billingMode','openai_api',
 'policyIdentity',null,'acceptedPolicyIdentity',r.policy_identity,'runId',r.id,'batchId',p_batch.id,'sequence',p_batch.sequence,'targetCount',100,'results',result); end $$;
-- Existing overview retains only legacy transport jobs. V2 run progress lives
-- on its explicit feed/run endpoints; mixed batch/candidate history remains.
do $$ declare d text; needle text:='where owner_id=v_owner and project_id=p_project_id order by created_at desc,id desc limit 20'; begin
 d:=pg_get_functiondef('public.get_project_naming(uuid,jsonb)'::regprocedure);
 if position(needle in d)=0 then raise exception 'unexpected_naming_overview_definition'; end if;
 execute replace(d,needle,'where owner_id=v_owner and project_id=p_project_id and engine_version=1 order by created_at desc,id desc limit 20');
end $$;

-- Preserve legacy cancellation JSON; managed jobs explicitly identify their
-- nullable-accounting projection, including when this endpoint is used by Activity.
do $$ declare d text; needle text:=$needle$'created_at', v_job.created_at, 'finished_at', v_job.finished_at);$needle$; begin
 d:=pg_get_functiondef('public.request_job_cancel(uuid)'::regprocedure);
 if position(needle in d)=0 then raise exception 'unexpected_job_cancel_definition'; end if;
 execute replace(d,needle,$replacement$'created_at', v_job.created_at, 'finished_at', v_job.finished_at)
 ||case when fluid_private.naming_brain_is_job(v_job) then '{"version":2,"billing_mode":"openai_api"}'::jsonb else '{}'::jsonb end;$replacement$);
end $$;

-- Legacy explicit subscription admission must not overlap an unresolved managed
-- run. Keep historical subscription-only uncertainty semantics unchanged.
do $$ declare d text; needle text:=$needle$if exists(select 1 from public.jobs where owner_id=v_owner and project_id=p_project_id and operation='naming.generate' and state in('queued','running','cancel_requested')) then$needle$; begin
 d:=pg_get_functiondef('public.enqueue_subscription_naming_job(uuid,integer,integer,integer,text,text)'::regprocedure);
 if position(needle in d)=0 then raise exception 'unexpected_legacy_naming_activity_guard'; end if;
 execute replace(d,needle,$replacement$if exists(select 1 from public.jobs where owner_id=v_owner and project_id=p_project_id and operation='naming.generate' and state in('queued','running','cancel_requested'))
 or exists(select 1 from fluid_private.naming_brain_runs r join public.jobs j on j.id=r.job_id where r.owner_id=v_owner and r.project_id=p_project_id and j.state='needs_reconciliation') then$replacement$);
end $$;

create function public.get_naming_brain_candidate_sources(p_project_id uuid,p_candidate_ids jsonb) returns jsonb language plpgsql stable security definer set search_path='' as $$
 declare candidate text; proofs jsonb:='[]'; begin
 if jsonb_typeof(p_candidate_ids) is distinct from 'array' or jsonb_array_length(p_candidate_ids) not between 1 and 100
 or (select count(distinct x) from jsonb_array_elements_text(p_candidate_ids) x)<>jsonb_array_length(p_candidate_ids) then raise exception 'invalid_source_page' using errcode='22023'; end if;
 for candidate in select value from jsonb_array_elements_text(p_candidate_ids) loop proofs:=proofs||jsonb_build_array(public.get_naming_brain_candidate_source(p_project_id,candidate::uuid)); end loop;
 return proofs; end $$;

-- A new preference version never silently routes managed choices through the
-- historical single-call subscription handler. Immutable V1 history still reads.
do $$ declare d text; needle text:='select * into strict v_revision from public.project_revisions where project_id=p_project_id and owner_id=v_owner and revision=p_expected_project_revision;'; begin
 d:=pg_get_functiondef('public.enqueue_subscription_naming_job(uuid,integer,integer,integer,text,text)'::regprocedure);
 if position(needle in d)=0 then raise exception 'unexpected_legacy_naming_preference_guard'; end if;
 execute replace(d,needle,$replacement$if exists(select 1 from public.naming_preferences where project_id=p_project_id and owner_id=v_owner and version=p_expected_preferences_version and preferences->'version'<>'1'::jsonb) then raise exception 'naming_preference_version_conflict' using errcode='PT409'; end if;
 $replacement$||needle);
end $$;

-- New private objects are deny-by-default even under hostile provider defaults.
do $$ declare t record; a record; begin
 for t in select c.oid,c.relowner from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='fluid_private' and c.relkind='r' and c.relname like 'naming_brain_%' loop
 execute format('alter table %s enable row level security',t.oid::regclass); execute format('alter table %s force row level security',t.oid::regclass);
 for a in select distinct grantee from aclexplode(coalesce((select relacl from pg_class where oid=t.oid),acldefault('r',t.relowner))) where grantee<>t.relowner loop
 execute format('revoke all on table %s from %s cascade',t.oid::regclass,case when a.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(a.grantee)) end); end loop;
 execute format('revoke all on table %s from public,anon,authenticated,service_role',t.oid::regclass);
 end loop;
 for t in select p.oid,p.proowner from pg_proc p join pg_namespace n on n.oid=p.pronamespace where (n.nspname='fluid_private' and p.proname like 'naming_brain_%') or (n.nspname='public' and p.proname in('get_naming_brain_candidate_sources','get_naming_brain_job_accounting','get_naming_brain_candidate_source','append_prepared_naming_set','stop_naming_feed','steer_naming_feed','naming_brain_worker_action','authorize_naming_brain_dispatch','record_naming_brain_provider_receipt','complete_naming_brain_stage','ensure_naming_brain_run','get_naming_feed','get_naming_brain_run','report_naming_brain_worker_ready','claim_naming_brain_job','expire_naming_brain_leases')) loop
 for a in select distinct grantee from aclexplode(coalesce((select proacl from pg_proc where oid=t.oid),acldefault('f',t.proowner))) where grantee<>t.proowner loop
 execute format('revoke all on function %s from %s cascade',t.oid::regprocedure,case when a.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(a.grantee)) end); end loop;
 execute format('revoke all on function %s from public,anon,authenticated,service_role',t.oid::regprocedure);
 end loop;
end $$;
grant execute on function public.get_naming_feed(uuid,jsonb),public.get_naming_brain_run(uuid,uuid),public.ensure_naming_brain_run(uuid,jsonb),public.append_prepared_naming_set(uuid,uuid),public.steer_naming_feed(uuid,jsonb),public.stop_naming_feed(uuid,jsonb),public.get_naming_brain_job_accounting(uuid),public.get_naming_brain_candidate_source(uuid,uuid),public.get_naming_brain_candidate_sources(uuid,jsonb) to authenticated;
commit;
