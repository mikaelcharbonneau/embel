-- Greenfield owned Naming. Additive to the frozen Strategy/v2 receipt boundary.
-- No logins, credentials, owner bindings or live worker grants are provisioned.
begin;

-- Preserve Strategy's revision idempotency while allowing intentional Naming batches.
drop index public.subscription_job_revision_operation;
create unique index subscription_strategy_revision_operation on public.jobs(owner_id,project_id,input_revision,operation)
 where billing_mode='chatgpt_subscription' and operation in ('strategy.reformulate','strategy.competitors','strategy.audience','strategy.personality','strategy.positioning');

alter function fluid_private.valid_subscription_policy(jsonb) rename to valid_strategy_subscription_policy;
create function fluid_private.valid_subscription_policy(p_policy jsonb) returns boolean language plpgsql immutable set search_path='' as $$
begin
 if p_policy->>'handlerVersion'='strategy-chatgpt-v1' then return fluid_private.valid_strategy_subscription_policy(p_policy); end if;
 if p_policy->>'handlerVersion'='naming-chatgpt-v1' then
  return fluid_private.valid_strategy_subscription_policy(jsonb_set(p_policy,'{handlerVersion}','"strategy-chatgpt-v1"'))
   and p_policy#>'{limits,maxObservedWebSearchCalls}'='0'::jsonb;
 end if;
 return false;
end $$;
alter table fluid_private.subscription_runtime_policy drop constraint subscription_runtime_policy_operation_check;
alter table fluid_private.subscription_runtime_policy drop constraint subscription_runtime_policy_policy_check;
alter table fluid_private.subscription_runtime_policy add constraint subscription_runtime_policy_operation_check
 check(operation in ('strategy.reformulate','strategy.competitors','strategy.audience','strategy.personality','strategy.positioning','naming.generate'));
alter table fluid_private.subscription_runtime_policy add constraint subscription_runtime_policy_policy_check
 check(fluid_private.valid_subscription_policy(policy) and policy->>'handlerVersion'=case when operation='naming.generate' then 'naming-chatgpt-v1' else 'strategy-chatgpt-v1' end);

create function fluid_private.valid_naming_preferences(p_value jsonb) returns boolean language plpgsql immutable set search_path='' as $$
begin
 if jsonb_typeof(p_value) is distinct from 'object' or p_value-array['version','creativeLocale','notes','minimumGraphemes','maximumGraphemes']<>'{}'::jsonb
  or p_value->'version' is distinct from '1'::jsonb or jsonb_typeof(p_value->'creativeLocale') is distinct from 'string'
  or length(p_value->>'creativeLocale') not between 2 and 30 or jsonb_typeof(p_value->'notes') is distinct from 'string' or length(p_value->>'notes')>2000
  or not(p_value ?& array['minimumGraphemes','maximumGraphemes']) then return false; end if;
 if p_value->'minimumGraphemes'<>'null'::jsonb and (jsonb_typeof(p_value->'minimumGraphemes')<>'number' or (p_value->>'minimumGraphemes')!~'^[0-9]+$' or (p_value->>'minimumGraphemes')::numeric not between 1 and 160) then return false; end if;
 if p_value->'maximumGraphemes'<>'null'::jsonb and (jsonb_typeof(p_value->'maximumGraphemes')<>'number' or (p_value->>'maximumGraphemes')!~'^[0-9]+$' or (p_value->>'maximumGraphemes')::numeric not between 1 and 160) then return false; end if;
 return coalesce((p_value->>'minimumGraphemes')::integer <= (p_value->>'maximumGraphemes')::integer,true);
end $$;

create table public.naming_sessions (
 project_id uuid primary key, owner_id uuid not null, preferences_version integer check(preferences_version>0),
 batch_sequence integer not null default 0 check(batch_sequence>=0), current_selection_id uuid,
 revision integer not null default 1 check(revision>0), view_revision integer not null default 1 check(view_revision>0), view_state jsonb not null,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique(project_id,owner_id), foreign key(project_id,owner_id) references public.projects(id,owner_id)
);
create table public.naming_preferences (
 project_id uuid not null, owner_id uuid not null, version integer not null check(version>0), preferences jsonb not null check(fluid_private.valid_naming_preferences(preferences)),
 created_at timestamptz not null default now(), primary key(project_id,version), unique(project_id,owner_id,version),
 foreign key(project_id,owner_id) references public.naming_sessions(project_id,owner_id)
);
alter table public.naming_sessions add constraint naming_session_preferences_fk foreign key(project_id,owner_id,preferences_version)
 references public.naming_preferences(project_id,owner_id,version) deferrable initially deferred;

create table public.naming_batches (
 id uuid primary key default gen_random_uuid(), owner_id uuid not null, project_id uuid not null,
 sequence integer not null check(sequence>0), context_revision integer not null, strategy_basis jsonb not null,
 preferences_version integer not null, favorites_snapshot jsonb not null, exclusion_keys jsonb not null,
 policy_identity text not null check(policy_identity~'^[0-9a-f]{64}$'), target_count integer not null check(target_count in(100,50)),
 job_id uuid not null unique, idempotency_key text not null check(idempotency_key~'^[A-Za-z0-9._:-]{16,128}$'), created_at timestamptz not null default now(),
 unique(id,owner_id,project_id), unique(project_id,sequence), unique(owner_id,idempotency_key),
 foreign key(project_id,owner_id) references public.naming_sessions(project_id,owner_id),
 foreign key(project_id,owner_id,context_revision) references public.project_revisions(project_id,owner_id,revision),
 foreign key(project_id,owner_id,preferences_version) references public.naming_preferences(project_id,owner_id,version),
 foreign key(job_id,owner_id,project_id) references public.jobs(id,owner_id,project_id)
);
create table public.naming_batch_results (
 batch_id uuid primary key, owner_id uuid not null, project_id uuid not null, result jsonb not null, completion_input jsonb not null, completed_at timestamptz not null default now(),
 foreign key(batch_id,owner_id,project_id) references public.naming_batches(id,owner_id,project_id)
);
create table public.name_transforms (
 id uuid primary key default gen_random_uuid(), owner_id uuid not null, project_id uuid not null,
 parent_candidate_id uuid not null, secondary_candidate_id uuid, input jsonb not null, outputs jsonb not null, truncated boolean not null, notes jsonb not null, request jsonb not null,
 idempotency_key text not null check(idempotency_key~'^[A-Za-z0-9._:-]{16,128}$'), created_at timestamptz not null default now(),
 unique(id,owner_id,project_id), unique(owner_id,idempotency_key), foreign key(project_id,owner_id) references public.naming_sessions(project_id,owner_id)
);
create table public.name_candidates (
 id uuid primary key default gen_random_uuid(), owner_id uuid not null, project_id uuid not null, value text not null check(length(value) between 1 and 160),
 identity_key text not null check(length(identity_key) between 0 and 320), context_revision integer not null, strategy_basis jsonb not null,
 origin jsonb not null, rationale text not null default '' check(length(rationale)<=2000), caution text check(length(caution)<=2000),
 batch_id uuid, transform_id uuid, source_project_id uuid, source_candidate_id uuid, source_context jsonb,
 idempotency_key text check(idempotency_key~'^[A-Za-z0-9._:-]{16,128}$'), created_at timestamptz not null default now(),
 unique(id,owner_id,project_id), unique(owner_id,idempotency_key),
 foreign key(project_id,owner_id) references public.naming_sessions(project_id,owner_id),
 foreign key(project_id,owner_id,context_revision) references public.project_revisions(project_id,owner_id,revision),
 foreign key(batch_id,owner_id,project_id) references public.naming_batches(id,owner_id,project_id),
 foreign key(transform_id,owner_id,project_id) references public.name_transforms(id,owner_id,project_id),
 foreign key(source_candidate_id,owner_id,source_project_id) references public.name_candidates(id,owner_id,project_id),
 check((source_project_id is null)=(source_candidate_id is null)),
 check((origin->>'kind'='generated' and batch_id is not null and transform_id is null and source_candidate_id is null)
   or(origin->>'kind'='local_import' and batch_id is null and transform_id is null and source_candidate_id is null)
   or(origin->>'kind'='transform' and batch_id is null and transform_id is not null and source_candidate_id is null and origin->>'authorship'='user_supplied')
   or(origin->>'kind'='account_copy' and batch_id is null and transform_id is null and source_candidate_id is not null))
);
create index name_candidates_owner_project_created on public.name_candidates(owner_id,project_id,created_at,id);
create index name_candidates_project_identity on public.name_candidates(project_id,identity_key);
create index naming_batches_owner_project_sequence on public.naming_batches(owner_id,project_id,sequence);
alter table public.name_transforms add foreign key(parent_candidate_id,owner_id,project_id) references public.name_candidates(id,owner_id,project_id);
alter table public.name_transforms add foreign key(secondary_candidate_id,owner_id,project_id) references public.name_candidates(id,owner_id,project_id);
create table public.name_retention (
 candidate_id uuid primary key, owner_id uuid not null, project_id uuid not null, liked boolean not null default false, saved boolean not null default false, revision integer not null default 1 check(revision>0),
 updated_at timestamptz not null default now(), foreign key(candidate_id,owner_id,project_id) references public.name_candidates(id,owner_id,project_id)
);
create index name_retention_owner_project on public.name_retention(owner_id,project_id);
create table public.name_selections (
 id uuid primary key default gen_random_uuid(), owner_id uuid not null, project_id uuid not null, candidate_id uuid not null,
 project_revision integer not null, prior_selection_id uuid, accepted_earlier_context boolean not null default false, created_at timestamptz not null default now(),
 unique(id,owner_id,project_id), unique(project_id,project_revision),
 foreign key(candidate_id,owner_id,project_id) references public.name_candidates(id,owner_id,project_id),
 foreign key(project_id,owner_id,project_revision) references public.project_revisions(project_id,owner_id,revision),
 foreign key(prior_selection_id,owner_id,project_id) references public.name_selections(id,owner_id,project_id)
);
alter table public.naming_sessions add foreign key(current_selection_id,owner_id,project_id) references public.name_selections(id,owner_id,project_id);

-- Read-only RLS plus narrow definer mutations. Composite links also enforce
-- ownership when administrative/worker execution bypasses row policies.
do $$ declare v_table text; begin
 foreach v_table in array array['naming_sessions','naming_preferences','naming_batches','naming_batch_results','name_candidates','name_transforms','name_retention','name_selections'] loop
  execute format('alter table public.%I enable row level security',v_table);
  execute format('alter table public.%I force row level security',v_table);
  execute format('create policy naming_owner_read on public.%I for select to authenticated using ((select auth.uid())=owner_id)',v_table);
  execute format('revoke all on public.%I from public,anon,authenticated,service_role',v_table);
  execute format('grant select on public.%I to authenticated',v_table);
  if v_table not in ('naming_sessions','name_retention') then
   execute format('create trigger naming_immutable before update or delete on public.%I for each row execute function fluid_private.prevent_history_change()',v_table);
  end if;
 end loop;
end $$;

create function fluid_private.naming_strategy_basis(p_context jsonb) returns jsonb language sql immutable set search_path='' as $$
 select jsonb_build_object('version',1,'description',coalesce(p_context->>'description',''),'activity',coalesce(p_context->>'activity',''),
 'offering',coalesce(p_context->>'offering',''),'knownAudience',coalesce(p_context->>'knownAudience',''),
 'competitors',coalesce((select jsonb_agg(jsonb_build_object('id',x->'id','name',x->'name','relevance',x->'relevance','url',x->'url','origin',x->'origin',
  'sources',coalesce((select jsonb_agg(jsonb_build_object('url',s->'url','title',s->'title') order by n) from jsonb_array_elements(coalesce(x->'sources','[]')) with ordinality ss(s,n)),'[]')) order by x->>'id') from jsonb_array_elements(coalesce(p_context->'competitors','[]')) a(x) where x->'selected'='true'),'[]'),
 'audience',coalesce((select jsonb_agg(jsonb_build_object('id',x->'id','label',x->'label','needs',x->'needs','reason',x->'reason','origin',x->'origin',
  'sources',coalesce((select jsonb_agg(jsonb_build_object('url',s->'url','title',s->'title') order by n) from jsonb_array_elements(coalesce(x->'sources','[]')) with ordinality ss(s,n)),'[]')) order by x->>'id') from jsonb_array_elements(coalesce(p_context->'audienceSegments','[]')) a(x) where x->'selected'='true'),'[]'),
 'personality',coalesce(p_context->'personality','null'),'positioning',coalesce(p_context->>'positioning',''));
$$;

create function fluid_private.naming_readiness(p_scope text,p_context jsonb) returns jsonb language plpgsql immutable set search_path='' as $$
declare v_missing jsonb:='[]';
begin
 if p_scope='visual_identity_only' then return '{"ready":false,"missing":["scope"]}'; end if;
 if length(btrim(coalesce(p_context->>'description','')))=0 then v_missing:=v_missing||'"description"'::jsonb; end if;
 if coalesce(p_context->'reformulationConfirmed','false')<>'true' then v_missing:=v_missing||'"reformulation"'::jsonb; end if;
 if coalesce(p_context->'competitorReviewComplete','false')<>'true' then v_missing:=v_missing||'"competitors"'::jsonb; end if;
 if not exists(select 1 from jsonb_array_elements(coalesce(p_context->'audienceSegments','[]')) x where x->'selected'='true')
  or coalesce(p_context#>'{intake,audienceReviewedAt}','null')='null' then v_missing:=v_missing||'"audience"'::jsonb; end if;
 if coalesce(p_context->'personality','null')='null' or coalesce(p_context#>'{intake,personalityReviewedAt}','null')='null' then v_missing:=v_missing||'"personality"'::jsonb; end if;
 if length(btrim(coalesce(p_context->>'positioning','')))=0 or coalesce(p_context#>'{intake,positioningReviewedAt}','null')='null' then v_missing:=v_missing||'"positioning"'::jsonb; end if;
 return jsonb_build_object('ready',case when p_scope='naming_only' then not(v_missing ? 'description') else jsonb_array_length(v_missing)=0 end,'missing',v_missing);
end $$;

create function fluid_private.check_naming_context() returns trigger language plpgsql set search_path='' as $$
declare v_previous jsonb; v_selected text; v_supplied text;
begin
 v_selected:=nullif(btrim(new.context->>'selectedName'),''); v_supplied:=nullif(btrim(new.context#>>'{intake,suppliedName}'),'');
 if new.context ? 'namingSource' and (jsonb_typeof(new.context->'namingSource')<>'object'
  or new.context#>>'{namingSource,origin}' not in('manual','workshop')
  or (new.context->'namingSource')-array['id','value','createdAt','origin','history']<>'{}') then raise exception 'invalid_user_source' using errcode='22023'; end if;
 if new.revision>1 then
  select context into v_previous from public.project_revisions where project_id=new.project_id and owner_id=new.owner_id and revision=new.revision-1;
  if ((v_selected,v_supplied) is distinct from(nullif(btrim(v_previous->>'selectedName'),''),nullif(btrim(v_previous#>>'{intake,suppliedName}'),'')) or exists(select 1 from public.naming_sessions where project_id=new.project_id and owner_id=new.owner_id and current_selection_id is not null)) and v_selected is distinct from v_supplied then raise exception 'inconsistent_selected_name' using errcode='22023'; end if;
  if v_previous ? 'namingSource' and new.context->'namingSource' is distinct from v_previous->'namingSource' then raise exception 'immutable_naming_source' using errcode='22023'; end if;
 end if;
 update public.naming_sessions s set current_selection_id=null,revision=revision+1,updated_at=clock_timestamp()
  where s.project_id=new.project_id and s.owner_id=new.owner_id and s.current_selection_id is not null and not exists(
   select 1 from public.name_selections sel join public.name_candidates c on c.id=sel.candidate_id and c.owner_id=sel.owner_id and c.project_id=sel.project_id
    where sel.id=s.current_selection_id and sel.owner_id=s.owner_id and sel.project_id=s.project_id and c.value=v_selected);
 return new;
end $$;
create trigger naming_project_context before insert on public.project_revisions for each row execute function fluid_private.check_naming_context();

create function fluid_private.ensure_naming_session(p_project_id uuid,p_owner uuid) returns public.naming_sessions language plpgsql set search_path='' as $$
declare v_session public.naming_sessions;
begin
 if p_owner is null then raise exception 'unauthenticated' using errcode='42501'; end if;
 perform 1 from public.projects where id=p_project_id and owner_id=p_owner for update;
 if not found then raise exception 'not_found' using errcode='P0002'; end if;
 insert into public.naming_sessions(project_id,owner_id,view_state) values(p_project_id,p_owner,
  '{"pane":"results","conversationOpen":true,"filter":"all","query":"","visibleBatchId":null,"scrollCandidateId":null,"workshopCandidateId":null}') on conflict(project_id) do nothing;
 select * into strict v_session from public.naming_sessions where project_id=p_project_id and owner_id=p_owner for update;
 return v_session;
end $$;
create function fluid_private.naming_session_dto(p_session public.naming_sessions) returns jsonb language sql stable set search_path='' as $$
 select case when p_session.project_id is null then null else jsonb_build_object('ownerId',p_session.owner_id,'projectId',p_session.project_id,'revision',p_session.revision,
 'currentPreferencesVersion',coalesce(p_session.preferences_version,0),'latestBatchSequence',p_session.batch_sequence,'currentSelectionId',p_session.current_selection_id,
 'viewRevision',p_session.view_revision,'viewState',p_session.view_state,'createdAt',p_session.created_at,'updatedAt',p_session.updated_at) end;
$$;
create function fluid_private.naming_preference_dto(p_preferences public.naming_preferences) returns jsonb language sql stable set search_path='' as $$
 select case when p_preferences.project_id is null then null else jsonb_build_object('ownerId',p_preferences.owner_id,'projectId',p_preferences.project_id,'version',p_preferences.version,'preferences',p_preferences.preferences,'createdAt',p_preferences.created_at) end;
$$;
-- strategyKey is deliberately absent in SQL DTOs. The authenticated DAL and
-- internal worker-input reader derive its display binding from strict JSONB basis.
create function fluid_private.naming_batch_dto(p_batch public.naming_batches) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('id',p_batch.id,'ownerId',p_batch.owner_id,'projectId',p_batch.project_id,'contextRevision',p_batch.context_revision,'strategyBasis',p_batch.strategy_basis,
 'preferencesVersion',p_batch.preferences_version,'preferences',(select preferences from public.naming_preferences where project_id=p_batch.project_id and owner_id=p_batch.owner_id and version=p_batch.preferences_version),
 'favoritesSnapshot',p_batch.favorites_snapshot,'acceptedPolicyIdentity',p_batch.policy_identity,'targetCount',p_batch.target_count,'sequence',p_batch.sequence,'jobId',p_batch.job_id,'createdAt',p_batch.created_at);
$$;
create function fluid_private.naming_candidate_dto(p_candidate public.name_candidates) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('id',p_candidate.id,'ownerId',p_candidate.owner_id,'projectId',p_candidate.project_id,'value',p_candidate.value,'identityKey',p_candidate.identity_key,
 'contextRevision',p_candidate.context_revision,'strategyBasis',p_candidate.strategy_basis,'origin',p_candidate.origin,'rationale',p_candidate.rationale,'createdAt',p_candidate.created_at)
 ||case when p_candidate.caution is not null then jsonb_build_object('caution',p_candidate.caution) else '{}'::jsonb end;
$$;
create function fluid_private.naming_entry(p_candidate public.name_candidates) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('candidate',fluid_private.naming_candidate_dto(p_candidate),'retention',jsonb_build_object('ownerId',p_candidate.owner_id,'projectId',p_candidate.project_id,
 'candidateId',p_candidate.id,'revision',coalesce(r.revision,0),'favorite',coalesce(r.liked,false),'saved',coalesce(r.saved,false),'updatedAt',r.updated_at))
 from (select 1) x left join public.name_retention r on r.candidate_id=p_candidate.id and r.owner_id=p_candidate.owner_id and r.project_id=p_candidate.project_id;
$$;
create function fluid_private.naming_selection_dto(p_selection public.name_selections) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('id',p_selection.id,'ownerId',p_selection.owner_id,'projectId',p_selection.project_id,'candidateId',p_selection.candidate_id,
 'projectRevision',p_selection.project_revision,'previousSelectionId',p_selection.prior_selection_id,'acceptedEarlierContext',p_selection.accepted_earlier_context,'createdAt',p_selection.created_at);
$$;
create function fluid_private.naming_project_dto(p_project public.projects) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('id',p_project.id,'owner_id',p_project.owner_id,'scope',p_project.scope,'title',p_project.title,'current_revision',p_project.current_revision,
 'created_at',p_project.created_at,'context',r.context) from public.project_revisions r where r.project_id=p_project.id and r.owner_id=p_project.owner_id and r.revision=p_project.current_revision;
$$;

create function public.save_naming_preferences(p_project_id uuid,p_expected_version integer,p_preferences jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_owner uuid:=auth.uid(); v_session public.naming_sessions; v_preferences public.naming_preferences;
begin
 if p_expected_version is null or p_expected_version<0 or not fluid_private.valid_naming_preferences(p_preferences) then raise exception 'invalid_preferences' using errcode='22023'; end if;
 v_session:=fluid_private.ensure_naming_session(p_project_id,v_owner);
 if coalesce(v_session.preferences_version,0)<>p_expected_version then raise exception 'preferences_conflict' using errcode='PT409'; end if;
 insert into public.naming_preferences(project_id,owner_id,version,preferences) values(p_project_id,v_owner,p_expected_version+1,p_preferences) returning * into v_preferences;
 update public.naming_sessions set preferences_version=v_preferences.version,revision=revision+1,updated_at=clock_timestamp() where project_id=p_project_id and owner_id=v_owner returning * into v_session;
 return jsonb_build_object('session',fluid_private.naming_session_dto(v_session),'preferences',fluid_private.naming_preference_dto(v_preferences));
end $$;
create function public.save_naming_view(p_project_id uuid,p_expected_revision integer,p_view jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_owner uuid:=auth.uid(); v_session public.naming_sessions; v_key text;
begin
 if p_expected_revision is null or p_expected_revision<1 or jsonb_typeof(p_view) is distinct from 'object'
  or p_view-array['pane','conversationOpen','filter','query','visibleBatchId','scrollCandidateId','workshopCandidateId']<>'{}'
  or not(p_view ?& array['pane','conversationOpen','filter','query','visibleBatchId','scrollCandidateId','workshopCandidateId'])
  or jsonb_typeof(p_view->'pane')<>'string' or jsonb_typeof(p_view->'filter')<>'string' or p_view->>'pane' not in('results','screening','workshop') or jsonb_typeof(p_view->'conversationOpen')<>'boolean'
  or p_view->>'filter' not in('all','retained','favorite','saved') or jsonb_typeof(p_view->'query')<>'string' or length(p_view->>'query')>200 then raise exception 'invalid_view' using errcode='22023'; end if;
 v_session:=fluid_private.ensure_naming_session(p_project_id,v_owner);
 if v_session.view_revision<>p_expected_revision then raise exception 'view_conflict' using errcode='PT409'; end if;
 if p_view->>'visibleBatchId' is not null and not exists(select 1 from public.naming_batches where id=(p_view->>'visibleBatchId')::uuid and project_id=p_project_id and owner_id=v_owner) then raise exception 'not_found' using errcode='P0002'; end if;
 foreach v_key in array array['scrollCandidateId','workshopCandidateId'] loop
  if p_view->>v_key is not null and not exists(select 1 from public.name_candidates where id=(p_view->>v_key)::uuid and project_id=p_project_id and owner_id=v_owner) then raise exception 'not_found' using errcode='P0002'; end if;
 end loop;
 update public.naming_sessions set view_state=p_view,view_revision=view_revision+1,revision=revision+1,updated_at=clock_timestamp() where project_id=p_project_id and owner_id=v_owner returning * into v_session;
 return jsonb_build_object('session',fluid_private.naming_session_dto(v_session));
end $$;
create function public.set_name_retention(p_project_id uuid,p_candidate_id uuid,p_expected_revision integer,p_favorite boolean,p_saved boolean) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_owner uuid:=auth.uid(); v_candidate public.name_candidates; v_retention public.name_retention;
begin
 if p_expected_revision is null or p_expected_revision<0 or p_favorite is null or p_saved is null then raise exception 'invalid_retention' using errcode='22023'; end if;
 perform fluid_private.ensure_naming_session(p_project_id,v_owner);
 select * into v_candidate from public.name_candidates where id=p_candidate_id and project_id=p_project_id and owner_id=v_owner;
 if not found then raise exception 'not_found' using errcode='P0002'; end if;
 select * into v_retention from public.name_retention where candidate_id=p_candidate_id and project_id=p_project_id and owner_id=v_owner;
 if coalesce(v_retention.revision,0)<>p_expected_revision then raise exception 'retention_conflict' using errcode='PT409'; end if;
 insert into public.name_retention(candidate_id,owner_id,project_id,liked,saved,revision) values(p_candidate_id,v_owner,p_project_id,p_favorite,p_saved,p_expected_revision+1)
  on conflict(candidate_id) do update set liked=excluded.liked,saved=excluded.saved,revision=excluded.revision,updated_at=clock_timestamp();
 return jsonb_build_object('entry',fluid_private.naming_entry(v_candidate));
end $$;

create or replace function public.get_strategy_availability(p_project_id uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_owner uuid:=auth.uid(); v_operations jsonb; v_hourly bigint; v_pending bigint;
begin
  if v_owner is null then raise exception 'unauthenticated' using errcode='42501'; end if;
  if p_project_id is not null and not exists(select 1 from public.projects where id=p_project_id and owner_id=v_owner) then raise exception 'not_found' using errcode='P0002'; end if;
  if not exists(select 1 from fluid_private.subscription_runtime_policy where owner_id=v_owner and operation<>'naming.generate') then return public.get_api_strategy_availability(p_project_id); end if;
  if not exists(select 1 from fluid_private.subscription_runtime_policy where owner_id=v_owner and operation<>'naming.generate' and enabled) then
    return jsonb_build_object('status','unavailable','operations','[]'::jsonb,'reason','subscription_unavailable');
  end if;
  if not exists(select 1 from fluid_private.subscription_runtime_policy where owner_id=v_owner and operation<>'naming.generate' and enabled and worker_ready_until>clock_timestamp()) then
    return jsonb_build_object('status','unavailable','operations','[]'::jsonb,'reason','worker_unavailable');
  end if;
  select count(*) filter(where created_at>clock_timestamp()-interval '1 hour'),count(*) filter(where state in ('queued','running','cancel_requested'))
    into v_hourly,v_pending from public.jobs where owner_id=v_owner and billing_mode='chatgpt_subscription';
  select coalesce(jsonb_agg(jsonb_build_object('operation',operation,'billingMode','chatgpt_subscription','policyIdentity',encode(sha256(convert_to(policy::text,'UTF8')),'hex'),'limits',policy->'limits') order by operation),'[]'::jsonb)
    into v_operations from fluid_private.subscription_runtime_policy where owner_id=v_owner and operation<>'naming.generate' and enabled and worker_ready_until>clock_timestamp()
      and v_hourly<(policy->'limits'->>'maxRequestsPerHour')::integer and v_pending<(policy->'limits'->>'maxQueuedJobs')::integer;
  if jsonb_array_length(v_operations)=0 then return jsonb_build_object('status','unavailable','operations','[]'::jsonb,'reason','quota_unavailable'); end if;
  return jsonb_build_object('status','available','operations',v_operations);
end $$;

create function public.get_naming_availability(p_project_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_owner uuid:=auth.uid(); v_policy fluid_private.subscription_runtime_policy; v_reason text;v_project public.projects;v_context jsonb;
begin
 if v_owner is null then raise exception 'unauthenticated' using errcode='42501'; end if;
 select * into v_project from public.projects where id=p_project_id and owner_id=v_owner;
 if not found then raise exception 'not_found' using errcode='P0002'; end if;
 select context into strict v_context from public.project_revisions where project_id=p_project_id and owner_id=v_owner and revision=v_project.current_revision;
 if (fluid_private.naming_readiness(v_project.scope,v_context)->>'ready')::boolean is not true then return jsonb_build_object('status','unavailable','operation','naming.generate','reason',case when v_project.scope='visual_identity_only' then 'scope_unavailable' else 'strategy_incomplete' end); end if;
 select * into v_policy from fluid_private.subscription_runtime_policy where owner_id=v_owner and operation='naming.generate';
 if not found then v_reason:='naming_policy_unavailable';
 elsif not v_policy.enabled then v_reason:='subscription_unavailable';
 elsif v_policy.worker_ready_until is null or v_policy.worker_ready_until<=clock_timestamp() then v_reason:='worker_unavailable';
 elsif (select count(*) from public.jobs where owner_id=v_owner and billing_mode='chatgpt_subscription' and created_at>clock_timestamp()-interval '1 hour') >= (v_policy.policy#>>'{limits,maxRequestsPerHour}')::integer
  or (select count(*) from public.jobs where owner_id=v_owner and billing_mode='chatgpt_subscription' and state in('queued','running','cancel_requested')) >= (v_policy.policy#>>'{limits,maxQueuedJobs}')::integer then v_reason:='quota_unavailable';
 end if;
 if v_reason is not null then return jsonb_build_object('status','unavailable','operation','naming.generate','reason',v_reason); end if;
 return jsonb_build_object('status','available','operation','naming.generate','billingMode','chatgpt_subscription','policyIdentity',encode(sha256(convert_to(v_policy.policy::text,'UTF8')),'hex'),'limits',v_policy.policy->'limits');
end $$;
create function fluid_private.naming_job_dto(p_batch public.naming_batches) returns jsonb language sql stable set search_path='' as $$
 select fluid_private.strategy_job_summary(j)||jsonb_build_object('batchId',p_batch.id,'sequence',p_batch.sequence,'targetCount',p_batch.target_count,
 'results',coalesce((select jsonb_agg(jsonb_build_object('stepKey',step_key,'output',output) order by created_at) from public.job_steps where job_id=j.id and owner_id=j.owner_id and project_id=j.project_id and state='succeeded'),'[]'))
 ||case when p.partial_text is not null then jsonb_build_object('partialText',p.partial_text) else '{}'::jsonb end
 from public.jobs j left join public.subscription_job_partials p on p.job_id=j.id and p.owner_id=j.owner_id and p.project_id=j.project_id
 where j.id=p_batch.job_id and j.owner_id=p_batch.owner_id and j.project_id=p_batch.project_id;
$$;
create function public.get_naming_batch(p_project_id uuid,p_batch_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_owner uuid:=auth.uid(); v_batch public.naming_batches; v_result jsonb;
begin
 select * into v_batch from public.naming_batches where id=p_batch_id and project_id=p_project_id and owner_id=v_owner;
 if not found then raise exception 'not_found' using errcode='P0002'; end if;
 select result into v_result from public.naming_batch_results where batch_id=v_batch.id and owner_id=v_owner and project_id=p_project_id;
 return jsonb_build_object('batch',fluid_private.naming_batch_dto(v_batch),'job',fluid_private.naming_job_dto(v_batch),'result',v_result);
end $$;
create function public.enqueue_subscription_naming_job(p_project_id uuid,p_expected_project_revision integer,p_expected_preferences_version integer,p_expected_batch_sequence integer,p_idempotency_key text,p_accepted_policy_identity text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_owner uuid:=auth.uid(); v_session public.naming_sessions; v_project public.projects; v_revision public.project_revisions;
 v_batch public.naming_batches; v_job public.jobs; v_policy fluid_private.subscription_runtime_policy; v_input jsonb;v_exclusion_snapshot jsonb;
begin
 if v_owner is null then raise exception 'unauthenticated' using errcode='42501'; end if;
 if p_expected_project_revision is null or p_expected_project_revision<1 or p_expected_preferences_version is null or p_expected_preferences_version<1
  or p_expected_batch_sequence is null or p_expected_batch_sequence<0 or p_idempotency_key is null or p_idempotency_key!~'^[A-Za-z0-9._:-]{16,128}$'
  or p_accepted_policy_identity is null or p_accepted_policy_identity!~'^[0-9a-f]{64}$' then raise exception 'invalid_input' using errcode='22023'; end if;
 if not exists(select 1 from public.projects where id=p_project_id and owner_id=v_owner) then raise exception 'not_found' using errcode='P0002'; end if;
 perform pg_advisory_xact_lock(hashtextextended(v_owner::text,723902));
 v_session:=fluid_private.ensure_naming_session(p_project_id,v_owner);
 select * into v_batch from public.naming_batches where owner_id=v_owner and idempotency_key=p_idempotency_key;
 if not found then
  if exists(select 1 from public.jobs where owner_id=v_owner and idempotency_key=p_idempotency_key) then raise exception 'idempotency_conflict' using errcode='23505'; end if;
  select * into v_batch from public.naming_batches where owner_id=v_owner and project_id=p_project_id and sequence=p_expected_batch_sequence+1;
 end if;
 if v_batch.id is not null then
  if (v_batch.project_id,v_batch.context_revision,v_batch.preferences_version,v_batch.sequence,v_batch.policy_identity)
   is distinct from(p_project_id,p_expected_project_revision,p_expected_preferences_version,p_expected_batch_sequence+1,p_accepted_policy_identity) then raise exception 'batch_intent_conflict' using errcode='PT409'; end if;
  return (public.get_naming_batch(p_project_id,v_batch.id)-'result')||jsonb_build_object('session',(select fluid_private.naming_session_dto(s) from public.naming_sessions s where project_id=p_project_id and owner_id=v_owner));
 end if;
 select * into strict v_project from public.projects where id=p_project_id and owner_id=v_owner;
 if v_project.current_revision<>p_expected_project_revision or coalesce(v_session.preferences_version,0)<>p_expected_preferences_version or v_session.batch_sequence<>p_expected_batch_sequence then raise exception 'naming_revision_conflict' using errcode='PT409'; end if;
 if exists(select 1 from public.jobs where owner_id=v_owner and project_id=p_project_id and operation='naming.generate' and state in('queued','running','cancel_requested')) then raise exception 'naming_active' using errcode='PT409'; end if;
 select * into strict v_revision from public.project_revisions where project_id=p_project_id and owner_id=v_owner and revision=p_expected_project_revision;
 if (fluid_private.naming_readiness(v_project.scope,v_revision.context)->>'ready')::boolean is not true then raise exception 'strategy_incomplete' using errcode='PT409'; end if;
 select * into v_policy from fluid_private.subscription_runtime_policy where owner_id=v_owner and operation='naming.generate' and enabled for share;
 if not found or v_policy.worker_ready_until is null or v_policy.worker_ready_until<=clock_timestamp() then raise exception 'runtime_unavailable' using errcode='P0001'; end if;
 if encode(sha256(convert_to(v_policy.policy::text,'UTF8')),'hex')<>p_accepted_policy_identity then raise exception 'policy_identity_conflict' using errcode='PT409'; end if;
 if (public.get_naming_availability(p_project_id)->>'status')<>'available' then raise exception 'quota_unavailable' using errcode='P0001'; end if;
 v_batch.id:=gen_random_uuid();v_batch.job_id:=gen_random_uuid();v_batch.owner_id:=v_owner;v_batch.project_id:=p_project_id;
 v_batch.context_revision:=p_expected_project_revision;v_batch.strategy_basis:=fluid_private.naming_strategy_basis(v_revision.context);v_batch.preferences_version:=p_expected_preferences_version;
 v_batch.sequence:=p_expected_batch_sequence+1;v_batch.target_count:=case when v_batch.sequence=1 then 100 else 50 end;
 v_batch.policy_identity:=p_accepted_policy_identity;v_batch.idempotency_key:=p_idempotency_key;v_batch.created_at:=clock_timestamp();
 select coalesce(jsonb_agg(jsonb_build_object('candidateId',c.id,'value',c.value) order by c.created_at,c.id),'[]') into v_batch.favorites_snapshot
  from public.name_candidates c join public.name_retention r on r.candidate_id=c.id and r.owner_id=c.owner_id and r.project_id=c.project_id where c.project_id=p_project_id and c.owner_id=v_owner and r.liked;
 select coalesce(jsonb_agg(identity_key order by identity_key),'[]') into v_batch.exclusion_keys from(select distinct identity_key from public.name_candidates where project_id=p_project_id and owner_id=v_owner and identity_key<>'') x;
 select coalesce(jsonb_agg(jsonb_build_object('candidateId',id,'value',value,'identityKey',identity_key) order by created_at,id),'[]') into v_exclusion_snapshot from public.name_candidates where project_id=p_project_id and owner_id=v_owner;
 if jsonb_array_length(v_exclusion_snapshot)>10000 or jsonb_array_length(v_batch.favorites_snapshot)>10000 or jsonb_array_length(v_batch.exclusion_keys)>10000 then raise exception 'naming_history_capacity' using errcode='PT409'; end if;
 v_input:=jsonb_build_object('version',1,'billingMode','chatgpt_subscription','context',v_revision.context,'policy',v_policy.policy,'batch',fluid_private.naming_batch_dto(v_batch),'exclusionKeys',v_batch.exclusion_keys,'exclusionSnapshot',v_exclusion_snapshot);
 if octet_length(v_input::text)>131072 or octet_length(to_jsonb(v_input::text)::text)+8192>(v_policy.policy#>>'{limits,maxInputBytes}')::integer then raise exception 'naming_history_capacity' using errcode='PT409'; end if;
 insert into public.jobs(id,owner_id,project_id,operation,input_revision,input_hash,input,idempotency_key,reserved_cost_microusd,max_attempts,billing_mode,policy_identity)
 values(v_batch.job_id,v_owner,p_project_id,'naming.generate',p_expected_project_revision,v_revision.input_hash,v_input,p_idempotency_key,0,1,'chatgpt_subscription',p_accepted_policy_identity) returning * into v_job;
 insert into public.naming_batches select (v_batch).*;
 update public.naming_sessions set batch_sequence=v_batch.sequence,revision=revision+1,updated_at=clock_timestamp() where project_id=p_project_id and owner_id=v_owner;
 return (public.get_naming_batch(p_project_id,v_batch.id)-'result')||jsonb_build_object('session',(select fluid_private.naming_session_dto(s) from public.naming_sessions s where project_id=p_project_id and owner_id=v_owner));
end $$;

create function fluid_private.complete_job_step_core(p_job_id uuid, p_lease_token uuid, p_step_key text, p_state text,
  p_actual_cost_microusd bigint, p_output jsonb default null, p_provider_request_id text default null)
returns public.job_steps language plpgsql security definer set search_path = '' as $$
declare v_job public.jobs; v_step public.job_steps; v_reservation public.usage_reservations;
begin
  v_job := fluid_private.lock_leased_job(p_job_id, p_lease_token);
  select * into v_step from public.job_steps where job_id = p_job_id and step_key = p_step_key for update;
  if not found then raise exception 'step_not_found' using errcode = 'P0002'; end if;
  if p_state is null or p_state not in ('succeeded','failed','ambiguous') or p_actual_cost_microusd is null or p_actual_cost_microusd not between 0 and 9007199254740991 then
    raise exception 'invalid_outcome' using errcode = '22023';
  end if;
  if v_step.state <> 'in_flight' then
    if (v_step.state, v_step.actual_cost_microusd, v_step.output, v_step.provider_request_id)
      is not distinct from (p_state, p_actual_cost_microusd, p_output, p_provider_request_id) then return v_step; end if;
    raise exception 'immutable_result' using errcode = '55000';
  end if;
  if v_job.billing_mode = 'openai_api' then
  select * into strict v_reservation from public.usage_reservations where job_id = p_job_id for update;
  update public.usage_accounts set
    spent_microusd = spent_microusd + least(greatest(v_reservation.reserved_microusd - v_reservation.actual_microusd,0), p_actual_cost_microusd),
    provider_actual_microusd = provider_actual_microusd + p_actual_cost_microusd,
    reserved_microusd = reserved_microusd - least(greatest(v_reservation.reserved_microusd - v_reservation.actual_microusd,0), p_actual_cost_microusd)
    where owner_id = v_job.owner_id;
  update public.usage_reservations set actual_microusd = actual_microusd + p_actual_cost_microusd,
    captured_microusd = captured_microusd + least(greatest(v_reservation.reserved_microusd - v_reservation.actual_microusd,0), p_actual_cost_microusd) where job_id = p_job_id;
  else
    if p_actual_cost_microusd <> 0 then raise exception 'invalid_subscription_cost' using errcode='22023'; end if;
    if p_state='succeeded' and (v_job.state<>'running' or not exists(select 1 from fluid_private.subscription_runtime_policy p where p.owner_id=v_job.owner_id and p.operation=v_job.operation and p.enabled and p.policy=v_job.input->'policy')) then raise exception 'subscription_changed' using errcode='55000'; end if;
    if p_state='succeeded' and (p_output->>'billingMode' is distinct from 'chatgpt_subscription' or p_output->>'provider' is distinct from 'openai' or p_output->>'operation' is distinct from v_job.operation or p_output->>'model' is distinct from v_job.input->'policy'->>'model') then raise exception 'invalid_subscription_result' using errcode='22023'; end if;
  end if;
  update public.job_steps set state = p_state, actual_cost_microusd = p_actual_cost_microusd, output = p_output,
    provider_request_id = p_provider_request_id, completed_at = clock_timestamp() where id = v_step.id returning * into v_step;
  update public.jobs set actual_cost_microusd = actual_cost_microusd + p_actual_cost_microusd where id = p_job_id;
  -- Retain real billing evidence even on an unexpected overrun; stop all further execution.
  if p_state = 'ambiguous' or p_actual_cost_microusd > v_step.reserved_cost_microusd then
    update public.jobs set state = 'needs_reconciliation', lease_token = null, lease_expires_at = null,
      error_code = case when p_state = 'ambiguous' then 'provider_outcome_unknown' else 'cost_overrun' end where id = p_job_id;
  end if;
  return v_step;
end $$;

create or replace function public.complete_job_step(p_job_id uuid,p_lease_token uuid,p_step_key text,p_state text,p_actual_cost_microusd bigint,p_output jsonb default null,p_provider_request_id text default null)
returns public.job_steps language plpgsql security definer set search_path='' as $$
declare v_job public.jobs;
begin
 v_job:=fluid_private.lock_leased_job(p_job_id,p_lease_token);
 if v_job.operation='naming.generate' and p_state='succeeded' then raise exception 'naming_publication_required' using errcode='55000'; end if;
 return fluid_private.complete_job_step_core(p_job_id,p_lease_token,p_step_key,p_state,p_actual_cost_microusd,p_output,p_provider_request_id);
end $$;
create function public.complete_naming_job_step(p_job_id uuid,p_lease_token uuid,p_step_key text,p_state text,p_actual_cost_microusd bigint,p_output jsonb default null,p_provider_request_id text default null)
returns public.job_steps language plpgsql security definer set search_path='' as $$
declare v_job public.jobs; v_batch public.naming_batches; v_step public.job_steps; v_item jsonb; v_candidate public.name_candidates;
 v_accepted jsonb:='[]'; v_ids jsonb:='[]'; v_output jsonb; v_rejections jsonb; v_fulfillment jsonb; v_count integer; v_collisions integer:=0; v_result jsonb; v_existing_result jsonb;
begin
 v_job:=fluid_private.lock_leased_job(p_job_id,p_lease_token);
 if p_actual_cost_microusd is distinct from 0 then raise exception 'invalid_subscription_cost' using errcode='22023'; end if;
 if v_job.operation<>'naming.generate' or v_job.billing_mode<>'chatgpt_subscription' then raise exception 'invalid_naming_job' using errcode='22023'; end if;
 if p_state<>'succeeded' then return fluid_private.complete_job_step_core(p_job_id,p_lease_token,p_step_key,p_state,p_actual_cost_microusd,p_output,p_provider_request_id); end if;
 select * into strict v_batch from public.naming_batches where job_id=v_job.id and owner_id=v_job.owner_id and project_id=v_job.project_id;
 perform 1 from public.naming_sessions where project_id=v_job.project_id and owner_id=v_job.owner_id for update;
 select * into v_step from public.job_steps where job_id=p_job_id and step_key=p_step_key and owner_id=v_job.owner_id and project_id=v_job.project_id;
 if v_step.state='succeeded' then
  select result into v_existing_result from public.naming_batch_results where batch_id=v_batch.id;
  if v_existing_result is not null and v_step.provider_request_id is not distinct from p_provider_request_id
   and exists(select 1 from public.naming_batch_results where batch_id=v_batch.id and completion_input=p_output) then return v_step; end if;
  raise exception 'immutable_result' using errcode='55000';
 end if;
 if p_output is null or jsonb_typeof(p_output) is distinct from 'object' or p_actual_cost_microusd is distinct from 0
  or p_output->'version' is distinct from '1'::jsonb or p_output-array['version','operation','provider','billingMode','model','responseId','requestId','generatedAt','usage','batchId','sequence','targetCount','accepted','fulfillment']<>'{}'
  or not(p_output ?& array['version','operation','provider','billingMode','model','responseId','requestId','generatedAt','usage','batchId','sequence','targetCount','accepted','fulfillment'])
  or p_output->>'operation' is distinct from 'naming.generate' or p_output->>'provider' is distinct from 'openai'
  or p_output->>'billingMode' is distinct from 'chatgpt_subscription' or p_output->>'model' is distinct from v_job.input#>>'{policy,model}'
  or p_output->>'batchId' is distinct from v_batch.id::text or p_output->'sequence' is distinct from to_jsonb(v_batch.sequence)
  or p_output->'targetCount' is distinct from to_jsonb(v_batch.target_count) or jsonb_typeof(p_output->'accepted') is distinct from 'array'
  or jsonb_array_length(p_output->'accepted')>v_batch.target_count or coalesce(length(p_output->>'responseId'),0) not between 1 and 300
  or coalesce(length(p_output->>'generatedAt'),0)=0 or octet_length(p_output::text)>(v_job.input#>>'{policy,limits,maxOutputBytes}')::integer then raise exception 'invalid_naming_result' using errcode='22023'; end if;
 if jsonb_typeof(p_output->'responseId')<>'string' or jsonb_typeof(p_output->'generatedAt')<>'string' or (p_output->>'generatedAt') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.[0-9]+)?(Z|[+-]\d{2}:\d{2})$'
  or(p_output->'requestId'<>'null' and (jsonb_typeof(p_output->'requestId')<>'string' or length(p_output->>'requestId') not between 1 and 300)) then raise exception 'invalid_naming_metadata' using errcode='22023'; end if;
 perform(p_output->>'generatedAt')::timestamptz;
 if p_output->'usage'<>'null' then
  if jsonb_typeof(p_output->'usage')<>'object' or (p_output->'usage')-array['inputTokens','outputTokens','totalTokens']<>'{}'
   or not((p_output->'usage') ?& array['inputTokens','outputTokens','totalTokens']) then raise exception 'invalid_naming_usage' using errcode='22023'; end if;
  for v_item in select value from jsonb_each(p_output->'usage') loop
   if jsonb_typeof(v_item)<>'number' or v_item::text!~'^[0-9]+$' or v_item::text::numeric>9007199254740991 then raise exception 'invalid_naming_usage' using errcode='22023'; end if;
  end loop;
  if (p_output#>>'{usage,inputTokens}')::numeric+(p_output#>>'{usage,outputTokens}')::numeric<>(p_output#>>'{usage,totalTokens}')::numeric then raise exception 'invalid_naming_usage' using errcode='22023'; end if;
 end if;
 v_fulfillment:=p_output->'fulfillment';v_rejections:=v_fulfillment->'rejections';
 if jsonb_typeof(v_fulfillment) is distinct from 'object' or v_fulfillment-array['status','targetCount','acceptedCount','rejections','message']<>'{}'
  or not(v_fulfillment ?& array['status','targetCount','acceptedCount','rejections','message'])
  or v_fulfillment->'targetCount' is distinct from to_jsonb(v_batch.target_count) or v_fulfillment->'acceptedCount' is distinct from to_jsonb(jsonb_array_length(p_output->'accepted'))
  or v_fulfillment->>'status' is distinct from(case when jsonb_array_length(p_output->'accepted')=v_batch.target_count then 'complete' when jsonb_array_length(p_output->'accepted')=0 then 'none' else 'partial' end)
  or (jsonb_array_length(p_output->'accepted')=v_batch.target_count and v_fulfillment->'message'<>'null')
  or (jsonb_array_length(p_output->'accepted')<v_batch.target_count and (jsonb_typeof(v_fulfillment->'message')<>'string' or length(v_fulfillment->>'message') not between 1 and 2000))
  or jsonb_typeof(v_rejections) is distinct from 'object' or v_rejections-array['invalid_candidate','empty_identity','below_minimum','above_maximum','duplicate_response','duplicate_history','over_target']<>'{}'
  or not(v_rejections ?& array['invalid_candidate','empty_identity','below_minimum','above_maximum','duplicate_response','duplicate_history','over_target']) then raise exception 'invalid_naming_fulfillment' using errcode='22023'; end if;
 for v_item in select value from jsonb_each(v_rejections) loop
  if jsonb_typeof(v_item)<>'number' or v_item::text!~'^[0-9]+$' or v_item::text::numeric>9007199254740991 then raise exception 'invalid_naming_fulfillment' using errcode='22023'; end if;
 end loop;
 if (select sum(value::text::numeric) from jsonb_each(v_rejections) where key<>'over_target')+jsonb_array_length(p_output->'accepted')>v_batch.target_count then raise exception 'invalid_naming_fulfillment' using errcode='22023'; end if;
 if exists(select 1 from jsonb_array_elements(p_output->'accepted') x group by x->>'identityKey' having count(*)>1) then raise exception 'duplicate_naming_identity' using errcode='22023'; end if;
 for v_item in select value from jsonb_array_elements(p_output->'accepted') loop
  if jsonb_typeof(v_item) is distinct from 'object' or v_item-array['value','identityKey','rationale','caution']<>'{}' or jsonb_typeof(v_item->'value') is distinct from 'string' or jsonb_typeof(v_item->'identityKey') is distinct from 'string' or jsonb_typeof(v_item->'rationale') is distinct from 'string' or(v_item ? 'caution' and jsonb_typeof(v_item->'caution')<>'string') or coalesce(length(v_item->>'value'),0) not between 1 and 160
   or coalesce(length(v_item->>'identityKey'),0) not between 1 and 320 or coalesce(length(v_item->>'rationale'),0) not between 1 and 2000
   or(v_item ? 'caution' and (length(btrim(v_item->>'caution')) not between 1 and 2000 or btrim(v_item->>'caution')<>v_item->>'caution'))
   or btrim(v_item->>'rationale')='' or btrim(v_item->>'rationale')<>v_item->>'rationale' or btrim(v_item->>'value')='' or btrim(v_item->>'value')<>v_item->>'value'
   or(select sum(case when ascii(x)>65535 then 2 else 1 end) from regexp_split_to_table(v_item->>'value','') x)>160 then raise exception 'invalid_naming_candidate' using errcode='22023'; end if;
  -- Only the worker-validated admission snapshot may exclude generated text.
  -- Later user imports/transforms are distinct captures, never authority to suppress this batch.
  if (v_job.input->'exclusionKeys') ? (v_item->>'identityKey') then
   v_collisions:=v_collisions+1; continue;
  end if;
  v_candidate.id:=gen_random_uuid();v_candidate.owner_id:=v_batch.owner_id;v_candidate.project_id:=v_batch.project_id;v_candidate.value:=v_item->>'value';v_candidate.identity_key:=v_item->>'identityKey';
  v_candidate.context_revision:=v_batch.context_revision;v_candidate.strategy_basis:=v_batch.strategy_basis;v_candidate.batch_id:=v_batch.id;v_candidate.rationale:=v_item->>'rationale';v_candidate.caution:=v_item->>'caution';v_candidate.created_at:=clock_timestamp();
  v_candidate.origin:=jsonb_build_object('kind','generated','ownerId',v_candidate.owner_id,'projectId',v_candidate.project_id,'candidateId',v_candidate.id,'contextRevision',v_candidate.context_revision,'value',v_candidate.value,
   'batchId',v_batch.id,'jobId',v_job.id,'stepKey',p_step_key,'provider','openai','billingMode','chatgpt_subscription','model',v_job.input#>>'{policy,model}','responseId',p_output->'responseId','requestId',p_output->'requestId','generatedAt',p_output->'generatedAt');
  insert into public.name_candidates select(v_candidate).*;
  v_accepted:=v_accepted||jsonb_build_array(v_item);v_ids:=v_ids||to_jsonb(v_candidate.id);
 end loop;
 v_count:=jsonb_array_length(v_accepted);v_rejections:=p_output#>'{fulfillment,rejections}';
 if jsonb_typeof(v_rejections) is distinct from 'object' then raise exception 'invalid_rejections' using errcode='22023'; end if;
 v_rejections:=jsonb_set(v_rejections,'{duplicate_history}',to_jsonb(coalesce((v_rejections->>'duplicate_history')::integer,0)+v_collisions));
 v_fulfillment:=jsonb_build_object('status',case when v_count=v_batch.target_count then 'complete' when v_count=0 then 'none' else 'partial' end,
  'targetCount',v_batch.target_count,'acceptedCount',v_count,'rejections',v_rejections,'message',case when v_count=v_batch.target_count then null else v_count::text||' / '||v_batch.target_count::text||' accepted names. No additional request was made.' end);
 v_output:=p_output||jsonb_build_object('accepted',v_accepted,'fulfillment',v_fulfillment);
 v_step:=fluid_private.complete_job_step_core(p_job_id,p_lease_token,p_step_key,p_state,p_actual_cost_microusd,v_output,p_provider_request_id);
 v_result:=jsonb_build_object('ownerId',v_batch.owner_id,'projectId',v_batch.project_id,'batchId',v_batch.id,'jobId',v_job.id,'stepKey',p_step_key,'candidateIds',v_ids,'fulfillment',v_fulfillment,'completedAt',v_step.completed_at);
 insert into public.naming_batch_results(batch_id,owner_id,project_id,result,completion_input) values(v_batch.id,v_batch.owner_id,v_batch.project_id,v_result,p_output);
 return v_step;
end $$;
create function public.import_local_name(p_project_id uuid,p_expected_revision integer,p_source jsonb,p_context jsonb,p_identity_key text,p_idempotency_key text) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_owner uuid:=auth.uid();v_project public.projects;v_revision public.project_revisions;v_candidate public.name_candidates;
begin
 if p_expected_revision is null or p_expected_revision<1 or p_idempotency_key is null or p_idempotency_key!~'^[A-Za-z0-9._:-]{16,128}$'
  or jsonb_typeof(p_source) is distinct from 'object' or p_source-array['id','value','createdAt','origin','history']<>'{}' or p_source->>'origin' not in('manual','workshop')
  or not(p_source ?& array['id','value','createdAt','origin','history']) or jsonb_typeof(p_source->'history') is distinct from 'array' or jsonb_array_length(p_source->'history')>32
  or coalesce(length(p_source->>'value'),0) not between 1 and 160 or p_identity_key is null or length(p_identity_key)>320 or jsonb_typeof(p_context) is distinct from 'object'
  or octet_length(p_source::text)+octet_length(p_context::text)>32768 then raise exception 'invalid_import' using errcode='22023'; end if;
 if (p_source->>'origin'='manual' and jsonb_array_length(p_source->'history')<>0) or(p_source->>'origin'='workshop' and jsonb_array_length(p_source->'history')=0) then raise exception 'invalid_import_history' using errcode='22023'; end if;
 perform fluid_private.ensure_naming_session(p_project_id,v_owner);
 select * into v_candidate from public.name_candidates where owner_id=v_owner and idempotency_key=p_idempotency_key;
 if found then
  if v_candidate.project_id<>p_project_id or v_candidate.context_revision<>p_expected_revision or v_candidate.origin->>'kind'<>'local_import' or v_candidate.origin->'source'<>p_source
   or v_candidate.origin->'capturedContext'<>p_context or v_candidate.identity_key<>p_identity_key then raise exception 'import_conflict' using errcode='PT409'; end if;
  return jsonb_build_object('entry',fluid_private.naming_entry(v_candidate));
 end if;
 select * into strict v_project from public.projects where id=p_project_id and owner_id=v_owner;
 if v_project.current_revision<>p_expected_revision then raise exception 'revision_conflict' using errcode='PT409'; end if;
 select * into strict v_revision from public.project_revisions where project_id=p_project_id and owner_id=v_owner and revision=p_expected_revision;
 v_candidate.id:=gen_random_uuid();v_candidate.owner_id:=v_owner;v_candidate.project_id:=p_project_id;v_candidate.context_revision:=p_expected_revision;
 v_candidate.value:=p_source->>'value';v_candidate.identity_key:=p_identity_key;v_candidate.strategy_basis:=fluid_private.naming_strategy_basis(p_context);
 v_candidate.origin:=jsonb_build_object('kind','local_import','ownerId',v_owner,'projectId',p_project_id,'candidateId',v_candidate.id,'contextRevision',p_expected_revision,'source',p_source,'capturedContext',p_context);
 v_candidate.source_context:=p_context;v_candidate.idempotency_key:=p_idempotency_key;v_candidate.rationale:='Imported from a user-supplied local name.';v_candidate.created_at:=clock_timestamp();
 insert into public.name_candidates select(v_candidate).*;
 return jsonb_build_object('entry',fluid_private.naming_entry(v_candidate));
end $$;
create function fluid_private.naming_transform_dto(p_transform public.name_transforms) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('id',p_transform.id,'ownerId',p_transform.owner_id,'projectId',p_transform.project_id,'parentCandidateId',p_transform.parent_candidate_id,
 'secondaryCandidateId',p_transform.secondary_candidate_id,'algorithmVersion',1,'input',p_transform.input,'outputs',p_transform.outputs,'truncated',p_transform.truncated,'notes',p_transform.notes,'createdAt',p_transform.created_at);
$$;
create function public.persist_name_transform(p_project_id uuid,p_parent_candidate_id uuid,p_secondary_candidate_id uuid,p_input jsonb,p_result jsonb,p_idempotency_key text) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_owner uuid:=auth.uid();v_parent public.name_candidates;v_secondary public.name_candidates;v_candidate public.name_candidates;v_transform public.name_transforms;
 v_root jsonb;v_history jsonb;v_item jsonb;v_entries jsonb:='[]';v_outputs jsonb:='[]';v_candidates public.name_candidates[]:='{}';v_depth integer;
begin
 if p_idempotency_key is null or p_idempotency_key!~'^[A-Za-z0-9._:-]{16,128}$' or jsonb_typeof(p_input) is distinct from 'object' or p_input->>'kind' not in('affixes','tweaks','blend','swap')
  or jsonb_typeof(p_result) is distinct from 'object' or p_result-array['candidates','truncated','notes']<>'{}' or jsonb_typeof(p_result->'candidates') is distinct from 'array'
  or jsonb_array_length(p_result->'candidates')>64 or jsonb_typeof(p_result->'truncated') is distinct from 'boolean' or jsonb_typeof(p_result->'notes') is distinct from 'array'
  or jsonb_array_length(p_result->'notes')>20 or octet_length(p_input::text)+octet_length(p_result::text)>32768 then raise exception 'invalid_transform' using errcode='22023'; end if;
 perform fluid_private.ensure_naming_session(p_project_id,v_owner);
 select * into v_parent from public.name_candidates where id=p_parent_candidate_id and owner_id=v_owner and project_id=p_project_id;
 if not found then raise exception 'not_found' using errcode='P0002'; end if;
 if (p_input->>'kind'='blend')<>(p_secondary_candidate_id is not null) then raise exception 'invalid_transform_parents' using errcode='22023'; end if;
 if p_secondary_candidate_id is not null then
  select * into v_secondary from public.name_candidates where id=p_secondary_candidate_id and owner_id=v_owner and project_id=p_project_id;
  if not found then raise exception 'not_found' using errcode='P0002'; end if;
  if p_input->>'left' is distinct from v_parent.value or p_input->>'right' is distinct from v_secondary.value then raise exception 'invalid_transform_seed' using errcode='22023'; end if;
 elsif p_input->>'seed' is distinct from v_parent.value then raise exception 'invalid_transform_seed' using errcode='22023'; end if;
 select * into v_transform from public.name_transforms where owner_id=v_owner and idempotency_key=p_idempotency_key;
 if found then
  if (v_transform.project_id,v_transform.parent_candidate_id,v_transform.secondary_candidate_id,v_transform.input,v_transform.request)
   is distinct from(p_project_id,p_parent_candidate_id,p_secondary_candidate_id,p_input,p_result) then raise exception 'transform_conflict' using errcode='PT409'; end if;
  select coalesce(jsonb_agg(fluid_private.naming_entry(c) order by n),'[]') into v_entries from jsonb_array_elements(v_transform.outputs) with ordinality o(x,n)
   join public.name_candidates c on c.id=(x->>'candidateId')::uuid and c.owner_id=v_owner and c.project_id=p_project_id;
  return jsonb_build_object('transform',fluid_private.naming_transform_dto(v_transform),'entries',v_entries);
 end if;
 v_root:=case when v_parent.origin->>'kind' in('generated','local_import') then v_parent.origin else v_parent.origin->'root' end;
 v_history:=coalesce(v_parent.origin->'history','[]');v_depth:=jsonb_array_length(v_history)+case when v_root->>'kind'='local_import' then jsonb_array_length(v_root#>'{source,history}') else 0 end;
 if v_depth>=32 then raise exception 'transform_history_full' using errcode='22023'; end if;
 v_transform.id:=gen_random_uuid();v_transform.owner_id:=v_owner;v_transform.project_id:=p_project_id;v_transform.parent_candidate_id:=p_parent_candidate_id;v_transform.secondary_candidate_id:=p_secondary_candidate_id;
 v_transform.input:=p_input;v_transform.request:=p_result;v_transform.truncated:=(p_result->>'truncated')::boolean;v_transform.notes:=p_result->'notes';v_transform.idempotency_key:=p_idempotency_key;v_transform.created_at:=clock_timestamp();
 -- Output text remains a user-supplied claim. Exact V1 replay occurs at every
 -- application read/use; no caller can manufacture generated authorship here.
 for v_item in select value from jsonb_array_elements(p_result->'candidates') loop
  if v_item-array['value','explanation','identityKey']<>'{}' or coalesce(length(v_item->>'value'),0) not between 1 and 160 or jsonb_typeof(v_item->'identityKey') is distinct from 'string'
   or length(v_item->>'identityKey')>320 or coalesce(length(v_item->>'explanation'),0) not between 1 and 2000 then raise exception 'invalid_transform_output' using errcode='22023'; end if;
  v_candidate:=null;v_candidate.id:=gen_random_uuid();v_candidate.owner_id:=v_owner;v_candidate.project_id:=p_project_id;v_candidate.value:=v_item->>'value';v_candidate.identity_key:=v_item->>'identityKey';
  v_candidate.context_revision:=v_parent.context_revision;v_candidate.strategy_basis:=v_parent.strategy_basis;v_candidate.transform_id:=v_transform.id;v_candidate.rationale:=v_item->>'explanation';v_candidate.created_at:=v_transform.created_at;
  v_candidate.origin:=jsonb_build_object('kind','transform','authorship','user_supplied','algorithmVersion',1,'transformId',v_transform.id,'parentCandidateId',p_parent_candidate_id,'secondaryCandidateId',p_secondary_candidate_id,
   'root',v_root,'history',v_history||jsonb_build_array(jsonb_build_object('transformId',v_transform.id,'projectId',p_project_id,'parentCandidateId',p_parent_candidate_id,'secondaryCandidateId',p_secondary_candidate_id,'input',p_input,'output',v_candidate.value,'createdAt',v_transform.created_at)));
  v_candidates:=array_append(v_candidates,v_candidate);v_outputs:=v_outputs||jsonb_build_array(jsonb_build_object('candidateId',v_candidate.id,'value',v_candidate.value,'explanation',v_item->>'explanation'));
 end loop;
 v_transform.outputs:=v_outputs;insert into public.name_transforms select(v_transform).*;
 foreach v_candidate in array v_candidates loop insert into public.name_candidates select(v_candidate).*;v_entries:=v_entries||jsonb_build_array(fluid_private.naming_entry(v_candidate)); end loop;
 return jsonb_build_object('transform',fluid_private.naming_transform_dto(v_transform),'entries',v_entries);
end $$;
create function public.select_project_name(p_project_id uuid,p_candidate_id uuid,p_expected_revision integer,p_accept_earlier_context boolean) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_owner uuid:=auth.uid();v_session public.naming_sessions;v_candidate public.name_candidates;v_project public.projects;v_revision public.project_revisions;v_context jsonb;v_selection public.name_selections;v_prior uuid;
begin
 if p_expected_revision is null or p_expected_revision<1 or p_accept_earlier_context is null then raise exception 'invalid_selection' using errcode='22023'; end if;
 v_session:=fluid_private.ensure_naming_session(p_project_id,v_owner);v_prior:=v_session.current_selection_id;
 select * into strict v_project from public.projects where id=p_project_id and owner_id=v_owner;
 if v_project.current_revision<>p_expected_revision then raise exception 'revision_conflict' using errcode='PT409'; end if;
 select * into v_candidate from public.name_candidates where id=p_candidate_id and project_id=p_project_id and owner_id=v_owner;
 if not found then raise exception 'not_found' using errcode='P0002'; end if;
 select context into strict v_context from public.project_revisions where project_id=p_project_id and owner_id=v_owner and revision=p_expected_revision;
 if fluid_private.naming_strategy_basis(v_context)<>v_candidate.strategy_basis and not p_accept_earlier_context then raise exception 'earlier_context_requires_acknowledgment' using errcode='PT409'; end if;
 v_context:=v_context||jsonb_build_object('selectedName',v_candidate.value,'intake',coalesce(v_context->'intake','{}')||jsonb_build_object('suppliedName',v_candidate.value));
 v_revision:=public.append_project_revision(p_project_id,p_expected_revision,v_context,encode(sha256(convert_to(v_context::text,'UTF8')),'hex'));
 insert into public.name_selections(owner_id,project_id,candidate_id,project_revision,prior_selection_id,accepted_earlier_context)
  values(v_owner,p_project_id,p_candidate_id,v_revision.revision,v_prior,p_accept_earlier_context) returning * into v_selection;
 update public.naming_sessions set current_selection_id=v_selection.id,revision=revision+1,updated_at=clock_timestamp() where project_id=p_project_id and owner_id=v_owner returning * into v_session;
 select * into strict v_project from public.projects where id=p_project_id and owner_id=v_owner;
 return jsonb_build_object('project',fluid_private.naming_project_dto(v_project),'session',fluid_private.naming_session_dto(v_session),
 'currentSelection',jsonb_build_object('selection',fluid_private.naming_selection_dto(v_selection),'candidate',fluid_private.naming_candidate_dto(v_candidate)));
end $$;
create function public.create_brand_from_project_name(p_project_id uuid,p_candidate_id uuid,p_expected_source_revision integer,p_title text,p_accept_earlier_context boolean,p_idempotency_key text) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_owner uuid:=auth.uid();v_source public.name_candidates;v_source_project public.projects;v_candidate public.name_candidates;v_project public.projects;
 v_context jsonb;v_root jsonb;v_history jsonb;v_session public.naming_sessions;v_selection public.name_selections;
begin
 if p_accept_earlier_context is null or p_expected_source_revision is null or p_expected_source_revision<1 or p_title is null or length(btrim(p_title)) not between 1 and 160
  or p_idempotency_key is null or p_idempotency_key!~'^[A-Za-z0-9._:-]{16,128}$' then raise exception 'invalid_promotion' using errcode='22023'; end if;
 if v_owner is null then raise exception 'unauthenticated' using errcode='42501'; end if;
 perform pg_advisory_xact_lock(hashtextextended(v_owner::text,723903));
 select * into v_source_project from public.projects where id=p_project_id and owner_id=v_owner for update;
 if not found then raise exception 'not_found' using errcode='P0002'; end if;
 select * into v_source from public.name_candidates where id=p_candidate_id and owner_id=v_owner and project_id=p_project_id;
 if not found then raise exception 'not_found' using errcode='P0002'; end if;
 select * into v_candidate from public.name_candidates where owner_id=v_owner and idempotency_key=p_idempotency_key;
 if found then
  if v_candidate.origin->>'kind'<>'account_copy' or (v_candidate.source_project_id,v_candidate.source_candidate_id) is distinct from(p_project_id,p_candidate_id)
   or v_candidate.origin->>'sourceContextRevision'<>p_expected_source_revision::text then raise exception 'promotion_conflict' using errcode='PT409'; end if;
  select * into strict v_project from public.projects where id=v_candidate.project_id and owner_id=v_owner;
  select * into strict v_session from public.naming_sessions where project_id=v_project.id and owner_id=v_owner;
  select * into v_selection from public.name_selections where id=v_session.current_selection_id and owner_id=v_owner and project_id=v_project.id;
  if v_project.title<>btrim(p_title) or v_project.current_revision<>1 or v_selection.candidate_id is distinct from v_candidate.id or v_selection.accepted_earlier_context is distinct from p_accept_earlier_context then raise exception 'promotion_conflict' using errcode='PT409'; end if;
 else
  if v_source_project.current_revision<>p_expected_source_revision then raise exception 'revision_conflict' using errcode='PT409'; end if;
  select context into strict v_context from public.project_revisions where project_id=p_project_id and owner_id=v_owner and revision=p_expected_source_revision;
  if fluid_private.naming_strategy_basis(v_context)<>v_source.strategy_basis and not p_accept_earlier_context then raise exception 'earlier_context_requires_acknowledgment' using errcode='PT409'; end if;
  v_context:=v_context||jsonb_build_object('selectedName',v_source.value,'intake',coalesce(v_context->'intake','{}')||jsonb_build_object('suppliedName',v_source.value));
  v_project:=public.create_project('complete_brand',btrim(p_title),v_context,encode(sha256(convert_to(v_context::text,'UTF8')),'hex'));
  v_session:=fluid_private.ensure_naming_session(v_project.id,v_owner);
  v_root:=case when v_source.origin->>'kind' in('generated','local_import') then v_source.origin else v_source.origin->'root' end;v_history:=coalesce(v_source.origin->'history','[]');
  v_candidate.id:=gen_random_uuid();v_candidate.owner_id:=v_owner;v_candidate.project_id:=v_project.id;v_candidate.value:=v_source.value;v_candidate.identity_key:=v_source.identity_key;
  v_candidate.context_revision:=1;v_candidate.strategy_basis:=v_source.strategy_basis;v_candidate.rationale:=v_source.rationale;v_candidate.caution:=v_source.caution;v_candidate.created_at:=clock_timestamp();
  v_candidate.source_project_id:=p_project_id;v_candidate.source_candidate_id:=p_candidate_id;v_candidate.idempotency_key:=p_idempotency_key;
  v_candidate.origin:=jsonb_build_object('kind','account_copy','authorship',case when v_root->>'kind'='generated' and jsonb_array_length(v_history)=0 then 'generated' else 'user_supplied' end,
   'sourceProjectId',p_project_id,'sourceCandidateId',p_candidate_id,'sourceContextRevision',p_expected_source_revision,'root',v_root,'history',v_history);
  insert into public.name_candidates select(v_candidate).*;
  insert into public.name_selections(owner_id,project_id,candidate_id,project_revision,accepted_earlier_context) values(v_owner,v_project.id,v_candidate.id,1,p_accept_earlier_context) returning * into v_selection;
  update public.naming_sessions set current_selection_id=v_selection.id,revision=revision+1,updated_at=clock_timestamp() where project_id=v_project.id and owner_id=v_owner returning * into v_session;
 end if;
 return jsonb_build_object('project',fluid_private.naming_project_dto(v_project),'session',fluid_private.naming_session_dto(v_session),
  'currentSelection',jsonb_build_object('selection',fluid_private.naming_selection_dto(v_selection),'candidate',fluid_private.naming_candidate_dto(v_candidate)));
end $$;

create function public.get_project_name_transform(p_project_id uuid,p_transform_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_transform public.name_transforms;
begin
 select * into v_transform from public.name_transforms where id=p_transform_id and project_id=p_project_id and owner_id=auth.uid();
 if not found then raise exception 'not_found' using errcode='P0002'; end if;
 return fluid_private.naming_transform_dto(v_transform);
end $$;
create function public.get_project_name(p_project_id uuid,p_candidate_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_candidate public.name_candidates;
begin
 select * into v_candidate from public.name_candidates where id=p_candidate_id and project_id=p_project_id and owner_id=auth.uid();
 if not found then raise exception 'not_found' using errcode='P0002'; end if;
 return jsonb_build_object('entry',fluid_private.naming_entry(v_candidate));
end $$;
create function public.get_naming_batches(p_project_id uuid,p_query jsonb default '{}') returns jsonb language plpgsql security definer set search_path='' as $$
declare v_owner uuid:=auth.uid();v_limit integer:=coalesce((p_query->>'limit')::integer,50);v_items jsonb;v_next jsonb;v_count integer;
begin
 if not exists(select 1 from public.projects where id=p_project_id and owner_id=v_owner) then raise exception 'not_found' using errcode='P0002'; end if;
 if v_limit not between 1 and 100 or p_query-array['limit','cursor']<>'{}' then raise exception 'invalid_query' using errcode='22023'; end if;
 with rows as(select b from public.naming_batches b where owner_id=v_owner and project_id=p_project_id
   and(p_query->>'cursor' is null or (created_at,id)>((p_query#>>'{cursor,createdAt}')::timestamptz,(p_query#>>'{cursor,id}')::uuid)) order by created_at,id limit v_limit+1),
 numbered as(select b,row_number() over(order by(b).created_at,(b).id) n from rows)
 select coalesce(jsonb_agg(jsonb_build_object('batch',fluid_private.naming_batch_dto(b),'result',(select result from public.naming_batch_results where batch_id=(b).id)) order by(b).created_at,(b).id) filter(where n<=v_limit),'[]'),count(*) into v_items,v_count from numbered;
 if v_count>v_limit then v_next:=jsonb_build_object('createdAt',v_items#>>array[(v_limit-1)::text,'batch','createdAt'],'id',v_items#>>array[(v_limit-1)::text,'batch','id']); end if;
 return jsonb_build_object('ownerId',v_owner,'projectId',p_project_id,'items',v_items,'nextCursor',v_next);
end $$;
create function public.get_project_naming(p_project_id uuid,p_query jsonb default '{}') returns jsonb language plpgsql security definer set search_path='' as $$
declare v_owner uuid:=auth.uid();v_project public.projects;v_session public.naming_sessions;v_preferences public.naming_preferences;v_current jsonb;v_context jsonb;
 v_items jsonb;v_jobs jsonb;v_next jsonb;v_count integer;v_limit integer:=coalesce((p_query->>'limit')::integer,100);v_filter text;v_search text;v_batch uuid;v_availability jsonb;v_readiness jsonb;
begin
 select * into v_project from public.projects where id=p_project_id and owner_id=v_owner;
 if not found then raise exception 'not_found' using errcode='P0002'; end if;
 if v_limit not between 1 and 100 or p_query-array['cursor','limit','filter','query','batchId']<>'{}' then raise exception 'invalid_query' using errcode='22023'; end if;
 select * into v_session from public.naming_sessions where project_id=p_project_id and owner_id=v_owner;
 select * into v_preferences from public.naming_preferences where project_id=p_project_id and owner_id=v_owner and version=v_session.preferences_version;
 select context into strict v_context from public.project_revisions where project_id=p_project_id and owner_id=v_owner and revision=v_project.current_revision;
 select jsonb_build_object('selection',fluid_private.naming_selection_dto(s),'candidate',fluid_private.naming_candidate_dto(c)) into v_current
  from public.name_selections s join public.name_candidates c on c.id=s.candidate_id and c.owner_id=s.owner_id and c.project_id=s.project_id where s.id=v_session.current_selection_id and s.owner_id=v_owner and s.project_id=p_project_id;
 v_filter:=coalesce(p_query->>'filter',v_session.view_state->>'filter','all');v_search:=coalesce(p_query->>'query',v_session.view_state->>'query','');
 v_batch:=case when p_query ? 'batchId' then (p_query->>'batchId')::uuid else(v_session.view_state->>'visibleBatchId')::uuid end;
 if v_filter not in('all','retained','favorite','saved') or length(v_search)>200 then raise exception 'invalid_query' using errcode='22023'; end if;
 if v_batch is not null and not exists(select 1 from public.naming_batches where id=v_batch and owner_id=v_owner and project_id=p_project_id) then raise exception 'not_found' using errcode='P0002'; end if;
 with rows as(select c from public.name_candidates c left join public.name_retention r on r.candidate_id=c.id and r.owner_id=c.owner_id and r.project_id=c.project_id
  where c.owner_id=v_owner and c.project_id=p_project_id and(v_batch is null or c.batch_id=v_batch) and strpos(lower(c.value),lower(v_search))>0
   and(v_filter='all' or(v_filter='retained' and(r.liked or r.saved or c.id=(select candidate_id from public.name_selections where id=v_session.current_selection_id and owner_id=v_owner and project_id=p_project_id))) or(v_filter='favorite' and r.liked) or(v_filter='saved' and r.saved))
   and(p_query->>'cursor' is null or(c.created_at,c.id)>((p_query#>>'{cursor,createdAt}')::timestamptz,(p_query#>>'{cursor,id}')::uuid)) order by c.created_at,c.id limit v_limit+1),
 numbered as(select c,row_number() over(order by(c).created_at,(c).id) n from rows)
 select coalesce(jsonb_agg(fluid_private.naming_entry(c) order by(c).created_at,(c).id) filter(where n<=v_limit),'[]'),count(*) into v_items,v_count from numbered;
 if v_count>v_limit then v_next:=jsonb_build_object('createdAt',v_items#>>array[(v_limit-1)::text,'candidate','createdAt'],'id',v_items#>>array[(v_limit-1)::text,'candidate','id']); end if;
 select coalesce(jsonb_agg(fluid_private.naming_job_dto(b) order by(b).created_at desc),'[]') into v_jobs from(select b from public.naming_batches b where owner_id=v_owner and project_id=p_project_id order by created_at desc,id desc limit 20) x;
 v_readiness:=fluid_private.naming_readiness(v_project.scope,v_context);v_availability:=public.get_naming_availability(p_project_id);
 if (v_readiness->>'ready')::boolean is not true then v_availability:=jsonb_build_object('status','unavailable','operation','naming.generate','reason',case when v_project.scope='visual_identity_only' then 'scope_unavailable' else 'strategy_incomplete' end); end if;
 return jsonb_build_object('project',fluid_private.naming_project_dto(v_project),'readiness',v_readiness,'session',fluid_private.naming_session_dto(v_session),'preferences',fluid_private.naming_preference_dto(v_preferences),
  'currentSelection',v_current,'batches',public.get_naming_batches(p_project_id,'{"limit":100}'),'candidates',jsonb_build_object('ownerId',v_owner,'projectId',p_project_id,'items',v_items,'nextCursor',v_next),
  'availability',v_availability,'jobs',v_jobs,'screening','{"domains":{"status":"not_checked","reason":"integration_unavailable"},"handles":{"status":"not_checked","reason":"integration_unavailable"},"trademarks":{"status":"not_checked","reason":"integration_unavailable"}}'::jsonb);
end $$;
create function public.get_account_names(p_query jsonb default '{}') returns jsonb language plpgsql security definer set search_path='' as $$
declare v_owner uuid:=auth.uid();v_items jsonb;v_next jsonb;v_count integer;v_limit integer:=coalesce((p_query->>'limit')::integer,50);v_filter text:=coalesce(p_query->>'filter','all');v_search text:=coalesce(p_query->>'query','');
begin
 if v_owner is null then raise exception 'unauthenticated' using errcode='42501'; end if;
 if v_limit not between 1 and 100 or p_query-array['limit','cursor','filter','query']<>'{}' or v_filter not in('all','retained','favorite','saved') or length(v_search)>200 then raise exception 'invalid_query' using errcode='22023'; end if;
 with rows as(select c,p,coalesce(sel.candidate_id=c.id,false) selected,c.strategy_basis<>fluid_private.naming_strategy_basis(pr.context) earlier_context from public.name_candidates c join public.projects p on p.id=c.project_id and p.owner_id=c.owner_id
  join public.project_revisions pr on pr.project_id=p.id and pr.owner_id=p.owner_id and pr.revision=p.current_revision
  left join public.name_retention r on r.candidate_id=c.id and r.owner_id=c.owner_id and r.project_id=c.project_id
  join public.naming_sessions ns on ns.project_id=c.project_id and ns.owner_id=c.owner_id
  left join public.name_selections sel on sel.id=ns.current_selection_id and sel.owner_id=c.owner_id and sel.project_id=c.project_id
  where c.owner_id=v_owner and(coalesce(r.liked,false) or coalesce(r.saved,false) or sel.candidate_id=c.id)
   and(v_filter='all' or(v_filter='retained' and(r.liked or r.saved or sel.candidate_id=c.id)) or(v_filter='favorite' and r.liked) or(v_filter='saved' and r.saved))
   and strpos(lower(c.value),lower(v_search))>0 and(p_query->>'cursor' is null or(c.created_at,c.id)>((p_query#>>'{cursor,createdAt}')::timestamptz,(p_query#>>'{cursor,id}')::uuid))
   order by c.created_at,c.id limit v_limit+1), numbered as(select c,p,selected,earlier_context,row_number() over(order by(c).created_at,(c).id) n from rows)
 select coalesce(jsonb_agg(fluid_private.naming_entry(c)||jsonb_build_object('project',to_jsonb(p),'currentSelection',selected,'earlierContext',earlier_context) order by(c).created_at,(c).id) filter(where n<=v_limit),'[]'),count(*) into v_items,v_count from numbered;
 if v_count>v_limit then v_next:=jsonb_build_object('createdAt',v_items#>>array[(v_limit-1)::text,'candidate','createdAt'],'id',v_items#>>array[(v_limit-1)::text,'candidate','id']); end if;
 return jsonb_build_object('ownerId',v_owner,'items',v_items,'nextCursor',v_next);
end $$;

create function public.configure_subscription_runtime(p_owner_id uuid,p_entries jsonb) returns boolean language plpgsql security definer set search_path='' as $$
declare v_owner uuid:=public.subscription_worker_owner();v_entry jsonb;v_model text;v_registration text;
begin
 if v_owner is null or p_owner_id is distinct from v_owner then raise exception 'worker_owner_mismatch' using errcode='42501'; end if;
 if jsonb_typeof(p_entries) is distinct from 'array' or jsonb_array_length(p_entries)<>6 then raise exception 'invalid_runtime_bundle' using errcode='22023'; end if;
 if (select count(distinct x->>'operation') from jsonb_array_elements(p_entries) x)<>6 then raise exception 'invalid_runtime_bundle' using errcode='22023'; end if;
 for v_entry in select value from jsonb_array_elements(p_entries) loop
  if jsonb_typeof(v_entry) is distinct from 'object' or v_entry-array['operation','policy']<>'{}' or v_entry->>'operation' not in('strategy.reformulate','strategy.competitors','strategy.audience','strategy.personality','strategy.positioning','naming.generate')
   or not fluid_private.valid_subscription_policy(v_entry->'policy') or (v_entry#>>'{policy,handlerVersion}')<>(case when v_entry->>'operation'='naming.generate' then 'naming-chatgpt-v1' else 'strategy-chatgpt-v1' end) then raise exception 'invalid_runtime_bundle' using errcode='22023'; end if;
  if v_model is null then v_model:=v_entry#>>'{policy,model}';v_registration:=v_entry#>>'{policy,registrationId}'; end if;
  if v_model is distinct from v_entry#>>'{policy,model}' or v_registration is distinct from v_entry#>>'{policy,registrationId}' then raise exception 'invalid_runtime_bundle' using errcode='22023'; end if;
  perform public.configure_subscription_runtime(v_owner,v_entry->>'operation',v_entry->'policy',true);
 end loop;
 return true;
end $$;
revoke all on function public.configure_subscription_runtime(uuid,jsonb) from public,anon,authenticated,service_role;

-- Do not expose any helper by default. Existing generic completion privileges
-- stay attached to its unchanged public signature; new worker RPC is opt-in.
do $$ declare v_function regprocedure;begin
 for v_function in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='fluid_private'
  and (p.proname like '%naming%' or p.proname in('complete_job_step_core','valid_subscription_policy')) loop
  execute format('revoke all on function %s from public,anon,authenticated,service_role',v_function);
 end loop;
 for v_function in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in(
  'save_naming_preferences','save_naming_view','set_name_retention','get_naming_availability','get_naming_batch','enqueue_subscription_naming_job','complete_naming_job_step',
  'import_local_name','persist_name_transform','select_project_name','create_brand_from_project_name','get_project_name','get_project_name_transform','get_naming_batches','get_project_naming','get_account_names') loop
  execute format('revoke all on function %s from public,anon,authenticated,service_role',v_function);
  if v_function::text not like '%complete_naming_job_step%' then execute format('grant execute on function %s to authenticated',v_function); end if;
 end loop;
end $$;
commit;
