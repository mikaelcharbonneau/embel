-- Greenfield Identity persistence. Local draft: generated publication remains unavailable.
begin;

-- Zod4.6.5 min/max string bounds count Unicode code points, as char_length does.
-- ECMAScript trim uses this exact set, not a locale-dependent whitespace regexp.
create function fluid_private.identity_trim(p_value text) returns text
language sql immutable set search_path='' as $$
 select btrim(p_value,U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF');
$$;
create function fluid_private.identity_preferences_value(p_value jsonb) returns jsonb
language plpgsql immutable set search_path='' as $$
declare v_locale text;v_notes text;v_avoidance text;
begin
 if p_value is null or jsonb_typeof(p_value)<>'object' or p_value-array['version','creativeLocale','notes','avoidanceNotes']<>'{}'
  or not(p_value ?& array['version','creativeLocale','notes','avoidanceNotes']) or p_value->'version' is distinct from '1'::jsonb
  or jsonb_typeof(p_value->'creativeLocale')<>'string' or jsonb_typeof(p_value->'notes')<>'string' or jsonb_typeof(p_value->'avoidanceNotes')<>'string'
 then raise exception 'invalid_identity_preferences' using errcode='22023';end if;
 v_locale:=fluid_private.identity_trim(p_value->>'creativeLocale');v_notes:=fluid_private.identity_trim(p_value->>'notes');v_avoidance:=fluid_private.identity_trim(p_value->>'avoidanceNotes');
 if char_length(v_locale) not between 2 and 30 or char_length(v_notes)>2000 or char_length(v_avoidance)>2000 then raise exception 'invalid_identity_preferences' using errcode='22023';end if;
 return jsonb_build_object('version',1,'creativeLocale',v_locale,'notes',v_notes,'avoidanceNotes',v_avoidance);
end $$;
create function fluid_private.identity_counter(p_value jsonb,p_positive boolean default false) returns bigint
language plpgsql immutable set search_path='' as $$
declare v_value numeric;
begin
 if p_value is null or jsonb_typeof(p_value)<>'number' then raise exception 'invalid_identity_revision' using errcode='22023';end if;
 v_value:=(p_value#>>'{}')::numeric;
 if v_value<>trunc(v_value) or v_value<(case when p_positive then 1 else 0 end) or v_value>9007199254740991 then raise exception 'invalid_identity_revision' using errcode='22023';end if;
 return v_value::bigint;
end $$;

-- Preserve the DTO's full decimal timestamp precision for ordering. timestamptz
-- itself rounds beyond microseconds, so it cannot be the history cursor key.
create function fluid_private.identity_time_key(p_value text) returns numeric
language plpgsql immutable set search_path='' as $$
declare m text[];v numeric;
begin
 m:=regexp_match(p_value,'^([0-9]{4}-[0-9]{2}-[0-9]{2}T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9])([.][0-9]+)?(Z|[+-](?:[01][0-9]|2[0-3]):[0-5][0-9])$');
 if m is null or char_length(p_value)>64 then raise exception 'invalid_identity_timestamp' using errcode='22023';end if;
 v:=extract(epoch from (m[1]||'Z')::timestamptz)+coalesce(('0'||m[2])::numeric,0);
 if m[3]<>'Z' then v:=v-(case left(m[3],1) when '+' then 1 else -1 end)*(substring(m[3],2,2)::integer*3600+substring(m[3],5,2)::integer*60);end if;return v;
end $$;
create table public.identity_sessions (
 project_id uuid not null,owner_id uuid not null,identity_revision bigint not null default 0 check(identity_revision between 0 and 9007199254740991),
 current_selection_id uuid,current_preferences_revision bigint,
 created_at timestamptz not null default clock_timestamp() check(isfinite(created_at)),updated_at timestamptz not null default clock_timestamp() check(isfinite(updated_at)),
 primary key(project_id,owner_id),foreign key(project_id,owner_id) references public.projects(id,owner_id),
 check((identity_revision=0)=(current_selection_id is null)),check(current_preferences_revision between 1 and 9007199254740991)
);
create table public.identity_preferences (
 project_id uuid not null,owner_id uuid not null,revision bigint not null check(revision between 1 and 9007199254740991),
 preferences jsonb not null check(preferences=fluid_private.identity_preferences_value(preferences)),
 created_at timestamptz not null default clock_timestamp() check(isfinite(created_at)),
 primary key(project_id,owner_id,revision),foreign key(project_id,owner_id) references public.identity_sessions(project_id,owner_id)
);
alter table public.identity_sessions add foreign key(project_id,owner_id,current_preferences_revision) references public.identity_preferences(project_id,owner_id,revision);

-- Independent immutable input/system storage. Exact generated receipt links and
-- the gated source checker are added only after the Task5 result contract freezes.
create table public.identity_input_snapshots (
 id uuid primary key default gen_random_uuid(),project_id uuid not null,owner_id uuid not null,project_revision integer not null,
 reference_revision bigint not null check(reference_revision between 0 and 9007199254740991),preferences_revision bigint,
 input jsonb not null,created_at timestamptz not null default clock_timestamp() check(isfinite(created_at)),
 unique(id,project_id,owner_id),foreign key(project_id,owner_id,project_revision) references public.project_revisions(project_id,owner_id,revision),
 foreign key(project_id,owner_id,reference_revision) references public.identity_reference_snapshots(project_id,owner_id,reference_revision),
 foreign key(project_id,owner_id,preferences_revision) references public.identity_preferences(project_id,owner_id,revision),
 check(preferences_revision between 1 and 9007199254740991),
 check((jsonb_typeof(input)='object' and input->'version'='1' and input->>'ownerId'=owner_id::text and input->>'projectId'=project_id::text
  and input->'projectRevision'=to_jsonb(project_revision) and input#>'{referenceSnapshot,referenceRevision}'=to_jsonb(reference_revision)
  and input->'preferencesRevision'=to_jsonb(coalesce(preferences_revision,0))) is true)
);
create table public.identity_system_versions (
 id uuid primary key default gen_random_uuid(),project_id uuid not null,owner_id uuid not null,input_id uuid not null,
 source jsonb not null check(jsonb_typeof(source)='object' and source->>'kind' in('generated','manual_edit')),
 components jsonb not null check(jsonb_typeof(components)='object'),board jsonb not null check(jsonb_typeof(board)='object'),
 production_files jsonb not null check(jsonb_typeof(production_files)='array' and jsonb_array_length(production_files)<=48),
 created_at timestamptz not null default clock_timestamp() check(isfinite(created_at)),
 unique(id,project_id,owner_id),foreign key(project_id,owner_id) references public.projects(id,owner_id),
 foreign key(input_id,project_id,owner_id) references public.identity_input_snapshots(id,project_id,owner_id)
);

alter table public.identity_system_versions add column created_at_text text not null;
alter table public.identity_system_versions add check(created_at_text::timestamptz=created_at);
alter table public.identity_system_versions add column created_at_order numeric generated always as(fluid_private.identity_time_key(created_at_text)) stored;
create table public.identity_batches (
 id uuid primary key,project_id uuid not null,owner_id uuid not null,job_id uuid not null,input_id uuid not null,
 target_count integer not null default 3 check(target_count=3),created_at timestamptz not null default clock_timestamp() check(isfinite(created_at)),
 unique(id,job_id,project_id,owner_id),unique(id,project_id,owner_id),unique(job_id),
 foreign key(job_id,owner_id,project_id) references public.jobs(id,owner_id,project_id),
 foreign key(input_id,project_id,owner_id) references public.identity_input_snapshots(id,project_id,owner_id)
);
alter table public.job_steps add constraint identity_step_owned_key unique(job_id,step_key,project_id,owner_id);
create table public.identity_generated_roots (
 system_id uuid primary key,project_id uuid not null,owner_id uuid not null,batch_id uuid not null,job_id uuid not null,step_key text not null,
 output_index integer not null check(output_index between 0 and 2),board jsonb not null,
 unique(system_id,project_id,owner_id),unique(job_id,step_key,output_index),
 foreign key(system_id,project_id,owner_id) references public.identity_system_versions(id,project_id,owner_id),
 foreign key(batch_id,job_id,project_id,owner_id) references public.identity_batches(id,job_id,project_id,owner_id),
 foreign key(job_id,step_key,project_id,owner_id) references public.job_steps(job_id,step_key,project_id,owner_id)
);
alter table public.identity_system_versions add column root_system_id uuid not null;
alter table public.identity_system_versions add column base_system_id uuid;
alter table public.identity_system_versions add column change_id uuid;
alter table public.identity_system_versions add foreign key(root_system_id,project_id,owner_id) references public.identity_system_versions(id,project_id,owner_id) deferrable initially deferred;
alter table public.identity_system_versions add foreign key(base_system_id,project_id,owner_id) references public.identity_system_versions(id,project_id,owner_id);
alter table public.identity_system_versions add check((source->>'kind'='generated' and root_system_id=id and base_system_id is null and change_id is null)
 or(source->>'kind'='manual_edit' and root_system_id<>id and base_system_id is not null and base_system_id<>id and change_id is not null));
create table public.identity_system_files (
 system_id uuid not null,slot integer not null check(slot between 0 and 48),project_id uuid not null,owner_id uuid not null,
 component text,role text not null,asset_id uuid not null,version_id uuid not null,
 primary key(system_id,slot),unique(system_id,slot,asset_id,version_id,project_id,owner_id),
 check(((slot=0 and component is null and role='board') or(slot>0 and component in('logo','colors','typography','graphics','imagery','composition'))) is true),
 foreign key(system_id,project_id,owner_id) references public.identity_system_versions(id,project_id,owner_id),
 foreign key(version_id,asset_id,project_id,owner_id) references public.asset_versions(id,asset_id,project_id,owner_id)
);
create table public.identity_selections (
 id uuid primary key,project_id uuid not null,owner_id uuid not null,system_id uuid not null,identity_revision bigint not null check(identity_revision between 1 and 9007199254740991),
 project_revision integer not null,reference_revision bigint not null check(reference_revision between 0 and 9007199254740991),preferences_revision bigint,
 current_basis jsonb not null,accepted_earlier_basis boolean not null,previous_selection_id uuid,reason text not null check(reason in('selected','restored','refined')),
 created_at timestamptz not null default clock_timestamp() check(isfinite(created_at)),
 unique(id,project_id,owner_id),unique(id,system_id,project_id,owner_id),unique(id,identity_revision,project_id,owner_id),unique(project_id,owner_id,identity_revision),
 check((identity_revision=1)=(previous_selection_id is null)),check(previous_selection_id is distinct from id),check(preferences_revision between 1 and 9007199254740991),
 foreign key(system_id,project_id,owner_id) references public.identity_system_versions(id,project_id,owner_id),
 foreign key(project_id,owner_id,project_revision) references public.project_revisions(project_id,owner_id,revision),
 foreign key(project_id,owner_id,reference_revision) references public.identity_reference_snapshots(project_id,owner_id,reference_revision),
 foreign key(project_id,owner_id,preferences_revision) references public.identity_preferences(project_id,owner_id,revision),
 foreign key(previous_selection_id,project_id,owner_id) references public.identity_selections(id,project_id,owner_id)
);
alter table public.identity_sessions add foreign key(current_selection_id,identity_revision,project_id,owner_id) references public.identity_selections(id,identity_revision,project_id,owner_id);
create table public.identity_component_changes (
 id uuid primary key,project_id uuid not null,owner_id uuid not null,base_system_id uuid not null,result_system_id uuid not null,selection_id uuid not null,
 component text not null check(component in('colors','typography')),before_value jsonb not null,after_value jsonb not null,
 project_revision integer not null,reference_revision bigint not null,preferences_revision bigint,current_basis jsonb not null,accepted_earlier_basis boolean not null,
 idempotency_key text not null check(idempotency_key~'^[A-Za-z0-9._:-]{16,128}$'),intent jsonb not null,
 created_at timestamptz not null default clock_timestamp() check(isfinite(created_at)),
 unique(id,project_id,owner_id),unique(project_id,owner_id,idempotency_key),unique(result_system_id),check(base_system_id<>result_system_id),check(before_value<>after_value),
 foreign key(base_system_id,project_id,owner_id) references public.identity_system_versions(id,project_id,owner_id),
 foreign key(result_system_id,project_id,owner_id) references public.identity_system_versions(id,project_id,owner_id) deferrable initially deferred,
 foreign key(selection_id,result_system_id,project_id,owner_id) references public.identity_selections(id,system_id,project_id,owner_id) deferrable initially deferred,
 foreign key(project_id,owner_id,project_revision) references public.project_revisions(project_id,owner_id,revision),
 foreign key(project_id,owner_id,reference_revision) references public.identity_reference_snapshots(project_id,owner_id,reference_revision),
 foreign key(project_id,owner_id,preferences_revision) references public.identity_preferences(project_id,owner_id,revision)
);
alter table public.identity_system_versions add foreign key(change_id,project_id,owner_id) references public.identity_component_changes(id,project_id,owner_id) deferrable initially deferred;
create table public.asset_usages (
 selection_id uuid not null,system_id uuid not null,slot integer not null,project_id uuid not null,owner_id uuid not null,asset_id uuid not null,version_id uuid not null,
 primary key(selection_id,slot),
 foreign key(selection_id,system_id,project_id,owner_id) references public.identity_selections(id,system_id,project_id,owner_id),
 foreign key(system_id,slot,asset_id,version_id,project_id,owner_id) references public.identity_system_files(system_id,slot,asset_id,version_id,project_id,owner_id)
);
create index asset_usages_active_lookup on public.asset_usages(owner_id,project_id,asset_id,selection_id);
do $$declare t text;begin
 foreach t in array array['identity_batches','identity_generated_roots','identity_system_files','identity_selections','identity_component_changes','asset_usages'] loop
  execute format('create trigger identity_immutable before update or delete on public.%I for each row execute function fluid_private.prevent_history_change()',t);
 end loop;
end $$;
create index identity_system_versions_owned_page on public.identity_system_versions(owner_id,project_id,created_at_order desc,id desc);
create trigger identity_input_snapshots_immutable before update or delete on public.identity_input_snapshots for each row execute function fluid_private.prevent_history_change();
create trigger identity_system_versions_immutable before update or delete on public.identity_system_versions for each row execute function fluid_private.prevent_history_change();

create trigger identity_preferences_immutable before update or delete on public.identity_preferences for each row execute function fluid_private.prevent_history_change();
do $$declare t text;begin
 foreach t in array array['identity_sessions','identity_preferences','identity_input_snapshots','identity_system_versions','identity_batches','identity_generated_roots','identity_system_files','identity_selections','identity_component_changes','asset_usages'] loop
  execute format('alter table public.%I enable row level security',t);execute format('alter table public.%I force row level security',t);
  execute format('revoke all on public.%I from public,anon,authenticated,service_role',t);
  execute format('grant select on public.%I to authenticated',t);
  execute format('create policy owned_read on public.%I for select to authenticated using(owner_id=(select auth.uid()))',t);
 end loop;
end $$;

create function fluid_private.identity_session_json(p_session public.identity_sessions) returns jsonb
language sql stable set search_path='' as $$
 select case when p_session.project_id is null then null else jsonb_build_object('ownerId',p_session.owner_id,'projectId',p_session.project_id,
  'identityRevision',p_session.identity_revision,'currentSelectionId',p_session.current_selection_id,'currentPreferencesRevision',coalesce(p_session.current_preferences_revision,0),
  'createdAt',p_session.created_at,'updatedAt',p_session.updated_at) end;
$$;
create function fluid_private.identity_preferences_json(p_preferences public.identity_preferences) returns jsonb
language sql stable set search_path='' as $$
 select case when p_preferences.project_id is null then null else jsonb_build_object('ownerId',p_preferences.owner_id,'projectId',p_preferences.project_id,
  'revision',p_preferences.revision,'preferences',p_preferences.preferences,'createdAt',p_preferences.created_at) end;
$$;
create function public.set_identity_preferences(p_project_id uuid,p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_owner uuid:=auth.uid();v_expected bigint;v_value jsonb;v_session public.identity_sessions;v_preferences public.identity_preferences;
begin
 if v_owner is null then raise exception 'unauthenticated' using errcode='42501';end if;
 if p_input is null or jsonb_typeof(p_input)<>'object' or p_input-array['expectedPreferencesRevision','preferences']<>'{}' or not(p_input ?& array['expectedPreferencesRevision','preferences']) then raise exception 'invalid_identity_preferences' using errcode='22023';end if;
 v_expected:=fluid_private.identity_counter(p_input->'expectedPreferencesRevision');v_value:=fluid_private.identity_preferences_value(p_input->'preferences');
 perform 1 from public.projects p where p.id=p_project_id and p.owner_id=v_owner for update;if not found then raise exception 'not_found' using errcode='P0002';end if;
 insert into public.identity_sessions(project_id,owner_id) values(p_project_id,v_owner) on conflict do nothing;
 select * into strict v_session from public.identity_sessions where project_id=p_project_id and owner_id=v_owner for update;
 if coalesce(v_session.current_preferences_revision,0)<>v_expected or v_expected>=9007199254740991 then raise exception 'identity_preferences_conflict' using errcode='PT409';end if;
 insert into public.identity_preferences(project_id,owner_id,revision,preferences) values(p_project_id,v_owner,v_expected+1,v_value) returning * into v_preferences;
 update public.identity_sessions set current_preferences_revision=v_preferences.revision,updated_at=clock_timestamp() where project_id=p_project_id and owner_id=v_owner returning * into v_session;
 return jsonb_build_object('session',fluid_private.identity_session_json(v_session),'preferences',fluid_private.identity_preferences_json(v_preferences));
end $$;


create function fluid_private.identity_current_references(p_project_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare v_owner uuid:=auth.uid();v_revision bigint;v_count integer;v_selected jsonb;v_stored jsonb;
begin
 if not exists(select 1 from public.projects where id=p_project_id and owner_id=v_owner) then raise exception 'not_found' using errcode='P0002';end if;
 select reference_revision,selected_reference_count into v_revision,v_count from public.identity_reference_heads where project_id=p_project_id and owner_id=v_owner;
 v_revision:=coalesce(v_revision,0);v_count:=coalesce(v_count,0);
 select coalesce(jsonb_agg(fluid_private.identity_reference_entry(r.reference_id,p_project_id,v_owner) order by r.reference_id),'[]') into v_selected
 from public.identity_reference_reactions r where r.project_id=p_project_id and r.owner_id=v_owner and(r.ensemble or cardinality(r.elements)>0);
 if jsonb_array_length(v_selected)<>v_count or v_count>100 or exists(select 1 from public.identity_reference_reactions where project_id=p_project_id and owner_id=v_owner and revision>v_revision) then raise exception 'invalid_identity_reference_state' using errcode='55000';end if;
 select snapshot into v_stored from public.identity_reference_snapshots where project_id=p_project_id and owner_id=v_owner and reference_revision=v_revision;
 if found then
  if v_stored->'selected' is distinct from v_selected or v_stored->'selectedReferenceCount' is distinct from to_jsonb(v_count) then raise exception 'invalid_identity_reference_snapshot' using errcode='55000';end if;
  return v_stored;
 end if;
 return jsonb_build_object('version',1,'ownerId',v_owner,'projectId',p_project_id,'referenceRevision',v_revision,'selectedReferenceCount',v_count,'capturedAt',statement_timestamp(),'selected',v_selected);
end $$;
create function fluid_private.identity_current_state(p_project_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare v_owner uuid:=auth.uid();v_project public.projects;v_context jsonb;v_session public.identity_sessions;v_preferences public.identity_preferences;
begin
 select * into v_project from public.projects where id=p_project_id and owner_id=v_owner;if not found then raise exception 'not_found' using errcode='P0002';end if;
 select context into strict v_context from public.project_revisions where project_id=p_project_id and owner_id=v_owner and revision=v_project.current_revision;
 select * into v_session from public.identity_sessions where project_id=p_project_id and owner_id=v_owner;
 select * into v_preferences from public.identity_preferences where project_id=p_project_id and owner_id=v_owner and revision=v_session.current_preferences_revision;
 return jsonb_build_object('project',fluid_private.asset_library_project(v_project)||jsonb_build_object('context',v_context),
  'session',fluid_private.identity_session_json(v_session),'preferences',fluid_private.identity_preferences_json(v_preferences),'referenceSnapshot',fluid_private.identity_current_references(p_project_id));
end $$;
create function fluid_private.identity_history_query(p_project_id uuid,p_query jsonb) returns jsonb
language plpgsql immutable set search_path='' as $$
declare v_limit bigint;v_cursor jsonb:=p_query->'cursor';
begin
 if p_query is null or jsonb_typeof(p_query)<>'object' or p_query-array['limit','cursor']<>'{}' then raise exception 'invalid_identity_query' using errcode='22023';end if;
 v_limit:=case when p_query ? 'limit' then fluid_private.identity_counter(p_query->'limit',true) else 20 end;
 if v_limit>50 then raise exception 'invalid_identity_query' using errcode='22023';end if;
 if p_query ? 'cursor' then
  if jsonb_typeof(v_cursor)<>'object' or v_cursor-array['projectId','createdAt','id']<>'{}' or not(v_cursor ?& array['projectId','createdAt','id'])
   or jsonb_typeof(v_cursor->'projectId')<>'string' or jsonb_typeof(v_cursor->'id')<>'string' or jsonb_typeof(v_cursor->'createdAt')<>'string' then raise exception 'invalid_identity_cursor' using errcode='22023';end if;
  if (v_cursor->>'projectId')::uuid<>p_project_id then raise exception 'not_found' using errcode='P0002';end if;
  perform fluid_private.identity_time_key(v_cursor->>'createdAt');
  v_cursor:=v_cursor||jsonb_build_object('projectId',p_project_id,'id',(v_cursor->>'id')::uuid);
  p_query:=jsonb_set(p_query,'{cursor}',v_cursor);
 end if;
 return p_query||jsonb_build_object('limit',v_limit);
end $$;
-- Canonical material strings. PostgreSQL char_length and installed Zod both
-- count Unicode code points; normalization is limited to the contract's fields.
create function fluid_private.identity_text(p_value jsonb,p_min integer,p_max integer,p_trim boolean default true) returns text
language plpgsql immutable set search_path='' as $$
declare v text;
begin
 if jsonb_typeof(p_value) is distinct from 'string' then raise exception 'invalid_identity_text' using errcode='22023';end if;
 v:=p_value#>>'{}';if p_trim then v:=fluid_private.identity_trim(v);end if;
 if char_length(v)<p_min or char_length(v)>p_max then raise exception 'invalid_identity_text' using errcode='22023';end if;return v;
end $$;
create function fluid_private.identity_component(p_component text,p_value jsonb) returns jsonb
language plpgsql immutable set search_path='' as $$
declare v_rows jsonb:='[]';v_row jsonb;v_keys text[]:='{}';v_key text;v_name text;v_weight bigint;v_note text;v_array text;
begin
 if p_component not in('colors','typography') or jsonb_typeof(p_value) is distinct from 'object' then raise exception 'invalid_identity_component' using errcode='22023';end if;
 v_array:=case when p_component='colors' then 'swatches' else 'styles' end;
 if p_value-array[v_array,'usageNotes']<>'{}' or not(p_value ?& array[v_array,'usageNotes']) or jsonb_typeof(p_value->v_array) is distinct from 'array' then raise exception 'invalid_identity_component' using errcode='22023';end if;
 if jsonb_array_length(p_value->v_array) not between 1 and(case when p_component='colors' then 16 else 8 end) then raise exception 'invalid_identity_component' using errcode='22023';end if;
 v_note:=fluid_private.identity_text(p_value->'usageNotes',0,2000);
 for v_row in select value from jsonb_array_elements(p_value->v_array) loop
  if jsonb_typeof(v_row) is distinct from 'object' then raise exception 'invalid_identity_component' using errcode='22023';end if;
  v_key:=fluid_private.identity_text(v_row->'key',1,64,false);
  if v_key!~'^[A-Za-z0-9_-]+$' or v_key=any(v_keys) then raise exception 'invalid_identity_component' using errcode='22023';end if;v_keys:=array_append(v_keys,v_key);
  if p_component='colors' then
   if v_row-array['key','name','hex']<>'{}' or fluid_private.identity_text(v_row->'hex',7,7,false)!~'^#[a-fA-F0-9]{6}$' then raise exception 'invalid_identity_component' using errcode='22023';end if;
   v_rows:=v_rows||jsonb_build_array(jsonb_build_object('key',v_key,'name',fluid_private.identity_text(v_row->'name',1,120),'hex',translate(v_row->>'hex','abcdef','ABCDEF')));
  else
   if v_row-array['key','role','family','weight','style']<>'{}' or v_row->>'style' not in('normal','italic','oblique') or jsonb_typeof(v_row->'style') is distinct from 'string' then raise exception 'invalid_identity_component' using errcode='22023';end if;
   v_weight:=fluid_private.identity_counter(v_row->'weight',true);if v_weight>1000 then raise exception 'invalid_identity_component' using errcode='22023';end if;
   v_rows:=v_rows||jsonb_build_array(jsonb_build_object('key',v_key,'role',fluid_private.identity_text(v_row->'role',1,120),'family',fluid_private.identity_text(v_row->'family',1,160),'weight',v_weight,'style',v_row->'style'));
  end if;
 end loop;
 return jsonb_build_object(v_array,v_rows,'usageNotes',v_note);
end $$;
create function fluid_private.identity_components(p_value jsonb) returns jsonb
language plpgsql immutable set search_path='' as $$
declare v jsonb:='{}';k text;r jsonb;
begin
 if jsonb_typeof(p_value) is distinct from 'object' or p_value-array['logo','colors','typography','graphics','imagery','composition']<>'{}' or not(p_value ?& array['logo','colors','typography','graphics','imagery','composition']) then raise exception 'invalid_identity_components' using errcode='22023';end if;
 foreach k in array array['logo','colors','typography','graphics','imagery','composition'] loop
  r:=p_value->k;
  if k in('colors','typography') then r:=fluid_private.identity_component(k,r);
  else
   if jsonb_typeof(r) is distinct from 'object' or r-array['direction','usageNotes']<>'{}' then raise exception 'invalid_identity_components' using errcode='22023';end if;
   r:=jsonb_build_object('direction',fluid_private.identity_text(r->'direction',1,2000),'usageNotes',fluid_private.identity_text(r->'usageNotes',0,2000));
  end if;v:=v||jsonb_build_object(k,r);
 end loop;return v;
end $$;
-- Only reproduce schema normalization, never Naming's grapheme transforms.
-- Actual NamingSource history validity is still replayed by the shared parser.
create function fluid_private.identity_naming_source(p_source jsonb) returns jsonb
language plpgsql immutable set search_path='' as $$
declare v_source jsonb:=p_source;v_history jsonb:='[]';v_step jsonb;v_input jsonb;k text;v_array jsonb;
begin
 if jsonb_typeof(p_source) is distinct from 'object' or jsonb_typeof(p_source->'history') is distinct from 'array' or jsonb_array_length(p_source->'history')>32 then raise exception 'invalid_identity_naming_source' using errcode='22023';end if;
 v_source:=jsonb_set(v_source,'{value}',to_jsonb(fluid_private.identity_trim(normalize(fluid_private.identity_text(p_source->'value',0,320,false),NFC))));
 for v_step in select value from jsonb_array_elements(p_source->'history') loop
  v_input:=v_step->'input';
  if jsonb_typeof(v_input) is distinct from 'object' then raise exception 'invalid_identity_naming_source' using errcode='22023';end if;
  foreach k in array array['seed','left','right','find','replacement'] loop
   if v_input ? k then
    if k in('find','replacement') then v_input:=jsonb_set(v_input,array[k],to_jsonb(normalize(fluid_private.identity_text(v_input->k,0,320,false),NFC)));
    else v_input:=jsonb_set(v_input,array[k],to_jsonb(fluid_private.identity_trim(normalize(fluid_private.identity_text(v_input->k,0,320,false),NFC))));end if;
   end if;
  end loop;
  foreach k in array array['prefixes','suffixes'] loop
   if v_input ? k then
    select coalesce(jsonb_agg(to_jsonb(fluid_private.identity_trim(normalize(fluid_private.identity_text(value,0,320,false),NFC))) order by n),'[]') into v_array from jsonb_array_elements(v_input->k) with ordinality a(value,n);
    v_input:=jsonb_set(v_input,array[k],v_array);
   end if;
  end loop;
  v_history:=v_history||jsonb_build_array(v_step||jsonb_build_object('input',v_input,'output',fluid_private.identity_trim(normalize(fluid_private.identity_text(v_step->'output',0,320,false),NFC))));
 end loop;return v_source||jsonb_build_object('history',v_history);
end $$;

-- Strict non-material intake provenance still belongs to the canonical input.
create function fluid_private.identity_conversation(p_events jsonb) returns jsonb
language plpgsql immutable set search_path='' as $$
declare e jsonb;ids text[]:='{}';widgets text[]:='{}';saved integer:=0;bytes bigint:=2;id text;k text;allowed text[];expected text[]:=array['competitors','audience','personality','positioning'];
begin
 if jsonb_typeof(p_events) is distinct from 'array' or jsonb_array_length(p_events)>64 then raise exception 'invalid_identity_conversation' using errcode='22023';end if;
 for e in select value from jsonb_array_elements(p_events) loop
  if jsonb_typeof(e) is distinct from 'object' then raise exception 'invalid_identity_conversation' using errcode='22023';end if;
  id:=fluid_private.identity_text(e->'id',1,128,false);
  if id=any(ids) then raise exception 'invalid_identity_conversation' using errcode='22023';end if;ids:=array_append(ids,id);
  if e->>'kind'='user_message' then
   allowed:=array['id','kind','text','createdAt'];perform fluid_private.identity_text(e->'text',1,12000,false);
   if fluid_private.identity_trim(e->>'text')='' then raise exception 'invalid_identity_conversation' using errcode='22023';end if;
   perform fluid_private.identity_time_key(fluid_private.identity_text(e->'createdAt',1,64,false));
  elsif e->>'kind'='saved_context' then
   allowed:=array['id','kind','text'];saved:=saved+1;perform fluid_private.identity_text(e->'text',1,12000,false);
   if saved>1 or fluid_private.identity_trim(e->>'text')='' then raise exception 'invalid_identity_conversation' using errcode='22023';end if;
  elsif e->>'kind'='widget' then
   allowed:=array['id','kind','widget'];
   if e->>'widget' is distinct from expected[cardinality(widgets)+1] then raise exception 'invalid_identity_conversation' using errcode='22023';end if;
   widgets:=array_append(widgets,e->>'widget');
   if e ? 'createdAt' then perform fluid_private.identity_time_key(fluid_private.identity_text(e->'createdAt',1,64,false));allowed:=array_append(allowed,'createdAt');end if;
  else raise exception 'invalid_identity_conversation' using errcode='22023';end if;
  if e-allowed<>'{}' or not(e ?& allowed) then raise exception 'invalid_identity_conversation' using errcode='22023';end if;
  -- Only string fields are admitted. Sum compact JSON punctuation plus encoded
  -- key/value strings, matching TextEncoder(JSON.stringify(events)).
  bytes:=bytes+2+greatest((select count(*) from jsonb_object_keys(e))-1,0);
  for k in select jsonb_object_keys(e) loop bytes:=bytes+octet_length(to_jsonb(k)::text)+1+octet_length((e->k)::text);end loop;
 end loop;
 bytes:=bytes+greatest(jsonb_array_length(p_events)-1,0);
 if bytes>64000 then raise exception 'invalid_identity_conversation' using errcode='22023';end if;
 return p_events;
end $$;

create function fluid_private.identity_material_context(p_context jsonb) returns jsonb
language plpgsql immutable set search_path='' as $$
declare v jsonb:=p_context;k text;r jsonb;s jsonb;rows jsonb;src jsonb;needs jsonb;ids text[];id text;v_intake jsonb;
begin
 if jsonb_typeof(v) is distinct from 'object' or v-array['description','activity','offering','knownAudience','reformulationConfirmed','audienceSegments','competitors','competitorReviewComplete','personality','positioning','selectedName','namingSource','creativeLocale','intake']<>'{}' then raise exception 'invalid_identity_context' using errcode='22023';end if;
 foreach k in array array['description','activity','offering','knownAudience','positioning','creativeLocale'] loop
  v:=jsonb_set(v,array[k],to_jsonb(fluid_private.identity_text(coalesce(v->k,case when k='creativeLocale' then '"en"'::jsonb else '""'::jsonb end),case when k='creativeLocale' then 2 else 0 end,case k when 'description' then 12000 when 'positioning' then 5000 when 'creativeLocale' then 30 else 2000 end)));
 end loop;
 if v ? 'selectedName' and v->'selectedName'<>'null' then v:=jsonb_set(v,'{selectedName}',to_jsonb(fluid_private.identity_text(v->'selectedName',0,200)));end if;
 if v ? 'intake' and jsonb_typeof(v->'intake') is distinct from 'object' then raise exception 'invalid_identity_context' using errcode='22023';end if;
 v_intake:=coalesce(v->'intake','{}');
 if v_intake-array['suppliedName','namingNotes','identityNotes','step','audienceReviewedAt','personalityReviewedAt','positioningReviewedAt','conversation','example']<>'{}' then raise exception 'invalid_identity_context' using errcode='22023';end if;
 perform fluid_private.identity_text(coalesce(v_intake->'namingNotes','""'),0,2000,false);
 if v_intake ? 'step' and (jsonb_typeof(v_intake->'step') is distinct from 'string' or v_intake->>'step' not in('description','review','competitors','audience','personality','positioning')) then raise exception 'invalid_identity_context' using errcode='22023';end if;
 if v_intake ? 'example' and jsonb_typeof(v_intake->'example') is distinct from 'boolean' then raise exception 'invalid_identity_context' using errcode='22023';end if;
 foreach k in array array['audienceReviewedAt','personalityReviewedAt','positioningReviewedAt'] loop
  if v_intake ? k and v_intake->k<>'null' then perform fluid_private.identity_time_key(fluid_private.identity_text(v_intake->k,1,64,false));end if;
 end loop;
 if v_intake ? 'conversation' then perform fluid_private.identity_conversation(v_intake->'conversation');end if;
 v:=jsonb_set(v,'{intake}',coalesce(v->'intake','{}')||jsonb_build_object('suppliedName',fluid_private.identity_text(coalesce(v#>'{intake,suppliedName}','""'),0,180,false),'identityNotes',fluid_private.identity_text(coalesce(v#>'{intake,identityNotes}','""'),0,2000,false)));
 foreach k in array array['competitors','audienceSegments'] loop
  rows:='[]';ids:='{}';
  if jsonb_typeof(coalesce(v->k,'[]'))<>'array' or jsonb_array_length(coalesce(v->k,'[]'))>(case when k='competitors' then 50 else 30 end) then raise exception 'invalid_identity_context' using errcode='22023';end if;
  for r in select value from jsonb_array_elements(coalesce(v->k,'[]')) loop
   if jsonb_typeof(r)<>'object' or jsonb_typeof(r->'id') is distinct from 'string' then raise exception 'invalid_identity_context' using errcode='22023';end if;
   id:=r->>'id';perform id::uuid;if id=any(ids) then raise exception 'invalid_identity_context' using errcode='22023';end if;ids:=array_append(ids,id);
   if jsonb_typeof(coalesce(r->'selected','false'))<>'boolean' then raise exception 'invalid_identity_context' using errcode='22023';end if;r:=r||jsonb_build_object('selected',coalesce(r->'selected','false'));
   if k='competitors' then
    if r-array['id','name','relevance','url','origin','selected','sources']<>'{}' then raise exception 'invalid_identity_context' using errcode='22023';end if;
    if r ? 'url' then perform fluid_private.identity_text(r->'url',0,2048,false);end if;
    if r->>'origin' not in('user','research') or r->>'origin' is null then raise exception 'invalid_identity_context' using errcode='22023';end if;
    r:=r||jsonb_build_object('name',fluid_private.identity_text(r->'name',1,160),'relevance',fluid_private.identity_text(r->'relevance',0,2000));
   else
    if r-array['id','label','needs','reason','selected','origin','sources']<>'{}' then raise exception 'invalid_identity_context' using errcode='22023';end if;
    if r->>'origin' not in('user','proposal') or r->>'origin' is null or jsonb_typeof(r->'needs') is distinct from 'array' or jsonb_array_length(r->'needs')>12 then raise exception 'invalid_identity_context' using errcode='22023';end if;
    select coalesce(jsonb_agg(to_jsonb(fluid_private.identity_text(value,1,2000)) order by n),'[]') into needs from jsonb_array_elements(r->'needs') with ordinality a(value,n);
    r:=r||jsonb_build_object('label',fluid_private.identity_text(r->'label',1,180),'reason',fluid_private.identity_text(r->'reason',0,2000),'needs',needs);
   end if;
   src:='[]';if jsonb_typeof(coalesce(r->'sources','[]'))<>'array' or jsonb_array_length(coalesce(r->'sources','[]'))>20 then raise exception 'invalid_identity_context' using errcode='22023';end if;
   for s in select value from jsonb_array_elements(coalesce(r->'sources','[]')) loop
    if jsonb_typeof(s)<>'object' or s-array['url','title','retrievedAt']<>'{}' or not(s ?& array['url','title','retrievedAt']) or jsonb_typeof(s->'url') is distinct from 'string' or (s->>'url')!~'^https?://' then raise exception 'invalid_identity_context' using errcode='22023';end if;
    perform fluid_private.identity_time_key(fluid_private.identity_text(s->'retrievedAt',1,64,false));
    src:=src||jsonb_build_array(s||jsonb_build_object('title',fluid_private.identity_text(s->'title',1,300)));
   end loop;
   if k='competitors' and r->>'origin'='research' and jsonb_array_length(src)=0 then raise exception 'invalid_identity_context' using errcode='22023';end if;
   rows:=rows||jsonb_build_array(r||jsonb_build_object('sources',src));
  end loop;v:=jsonb_set(v,array[k],rows);
 end loop;
 if coalesce(v->'personality','null')<>'null' then
  r:=v->'personality';if jsonb_typeof(r)<>'object' or r-array['sincerity','excitement','competence','sophistication','ruggedness']<>'{}' then raise exception 'invalid_identity_context' using errcode='22023';end if;
  foreach k in array array['sincerity','excitement','competence','sophistication','ruggedness'] loop if fluid_private.identity_counter(r->k)>100 then raise exception 'invalid_identity_context' using errcode='22023';end if;end loop;
 end if;
 v:=jsonb_build_object('description','','activity','','offering','','knownAudience','','reformulationConfirmed',false,'audienceSegments','[]'::jsonb,'competitors','[]'::jsonb,'competitorReviewComplete',false,'personality',null,'positioning','','selectedName',null,'creativeLocale','en')||v;
 v:=jsonb_set(v,'{intake}',jsonb_build_object('suppliedName','','namingNotes','','identityNotes','','step','review','audienceReviewedAt',null,'personalityReviewedAt',null,'positioningReviewedAt',null,'example',false)||(v->'intake'));
 if v ? 'namingSource' then v:=jsonb_set(v,'{namingSource}',fluid_private.identity_naming_source(v->'namingSource'));end if;
 foreach k in array array['reformulationConfirmed','competitorReviewComplete'] loop if jsonb_typeof(v->k) is distinct from 'boolean' then raise exception 'invalid_identity_context' using errcode='22023';end if;end loop;
 if v->'reformulationConfirmed'='true' and (v->>'activity'='' or v->>'offering'='') then raise exception 'invalid_identity_context' using errcode='22023';end if;
 if v->'competitorReviewComplete'='true' and exists(select 1 from jsonb_array_elements(v->'competitors') x where x->'selected'='true' and x->>'relevance'='') then raise exception 'invalid_identity_context' using errcode='22023';end if;
 if v#>'{intake,personalityReviewedAt}'<>'null' and v->'personality'='null' then raise exception 'invalid_identity_context' using errcode='22023';end if;
 if v#>'{intake,positioningReviewedAt}'<>'null' and(v->>'positioning'='' or v#>'{intake,personalityReviewedAt}'='null') then raise exception 'invalid_identity_context' using errcode='22023';end if;
 return v;
end $$;
create function fluid_private.identity_basis(p_owner uuid,p_project uuid,p_context jsonb,p_references jsonb,p_preferences jsonb) returns jsonb
language plpgsql immutable set search_path='' as $$
declare v_context jsonb:=fluid_private.identity_material_context(p_context);v_selected text;v_supplied text;v_refs jsonb;
begin
 v_selected:=normalize(fluid_private.identity_trim(coalesce(v_context->>'selectedName','')),NFC);v_supplied:=normalize(fluid_private.identity_trim(coalesce(v_context#>>'{intake,suppliedName}','')),NFC);
 if(v_selected='' and v_supplied='') or(v_selected<>'' and v_supplied<>'' and v_selected<>v_supplied) then raise exception 'identity_name_unavailable' using errcode='PT409';end if;
 select coalesce(jsonb_agg(jsonb_build_object('referenceId',value#>'{reference,id}','media',value#>'{reference,media}','ensemble',value#>'{reaction,ensemble}','elements',value#>'{reaction,elements}') order by value#>>'{reference,id}'),'[]') into v_refs from jsonb_array_elements(p_references->'selected');
 return jsonb_build_object('version',1,'ownerId',p_owner,'projectId',p_project,'strategy',fluid_private.naming_strategy_basis(v_context),'name',coalesce(nullif(v_selected,''),v_supplied),
  'referenceBasis',jsonb_build_object('version',1,'ownerId',p_owner,'projectId',p_project,'references',v_refs),'preferences',fluid_private.identity_preferences_value(p_preferences));
end $$;
create function fluid_private.identity_system_json(p_system public.identity_system_versions) returns jsonb
language sql stable set search_path='' as $$
 select jsonb_build_object('id',p_system.id,'ownerId',p_system.owner_id,'projectId',p_system.project_id,'createdAt',p_system.created_at_text,'input',i.input,'source',p_system.source,'components',p_system.components,'board',p_system.board,'productionFiles',p_system.production_files)
 from public.identity_input_snapshots i where i.id=p_system.input_id and i.owner_id=p_system.owner_id and i.project_id=p_system.project_id;
$$;
create function fluid_private.identity_selection_json(p_selection public.identity_selections) returns jsonb
language sql stable set search_path='' as $$
 select case when p_selection.id is null then null else jsonb_build_object('id',p_selection.id,'ownerId',p_selection.owner_id,'projectId',p_selection.project_id,'systemVersionId',p_selection.system_id,'identityRevision',p_selection.identity_revision,
 'projectRevision',p_selection.project_revision,'referenceRevision',p_selection.reference_revision,'preferencesRevision',coalesce(p_selection.preferences_revision,0),'currentBasis',p_selection.current_basis,'acceptedEarlierBasis',p_selection.accepted_earlier_basis,'previousSelectionId',p_selection.previous_selection_id,'reason',p_selection.reason,'createdAt',p_selection.created_at) end;
$$;
create function fluid_private.identity_change_json(p_change public.identity_component_changes) returns jsonb
language sql stable set search_path='' as $$
 select jsonb_build_object('id',p_change.id,'ownerId',p_change.owner_id,'projectId',p_change.project_id,'baseSystemVersionId',p_change.base_system_id,'resultSystemVersionId',p_change.result_system_id,'component',p_change.component,'before',p_change.before_value,'after',p_change.after_value,
 'projectRevision',p_change.project_revision,'referenceRevision',p_change.reference_revision,'preferencesRevision',coalesce(p_change.preferences_revision,0),'currentBasis',p_change.current_basis,'acceptedEarlierBasis',p_change.accepted_earlier_basis,'provenance',jsonb_build_object('kind','user_edit','actorId',p_change.owner_id),'createdAt',p_change.created_at);
$$;
create function fluid_private.identity_asset_shape(p_ref jsonb,p_owner uuid,p_project uuid,p_board boolean) returns void
language plpgsql stable set search_path='' as $$
declare a public.assets;v public.asset_versions;
begin
 if jsonb_typeof(p_ref) is distinct from 'object' or p_ref-array['ownerId','projectId','assetId','versionId','contentHash','purpose','mimeType']<>'{}' or not(p_ref ?& array['ownerId','projectId','assetId','versionId','contentHash','purpose','mimeType'])
  or p_ref->'ownerId' is distinct from to_jsonb(p_owner) or p_ref->'projectId' is distinct from to_jsonb(p_project)
  or jsonb_typeof(p_ref->'assetId') is distinct from 'string' or jsonb_typeof(p_ref->'versionId') is distinct from 'string'
  or jsonb_typeof(p_ref->'contentHash') is distinct from 'string' or p_ref->>'contentHash'!~'^[a-f0-9]{64}$'
  or jsonb_typeof(p_ref->'mimeType') is distinct from 'string' or char_length(p_ref->>'mimeType') not between 1 and 150
  or p_ref->>'purpose' not in('brand_asset','legacy_unknown') then raise exception 'invalid_identity_asset_manifest' using errcode='55000';end if;
 select * into a from public.assets where id=(p_ref->>'assetId')::uuid and project_id=p_project and owner_id=p_owner;if not found then raise exception 'invalid_identity_asset_manifest' using errcode='55000';end if;
 select * into v from public.asset_versions where id=(p_ref->>'versionId')::uuid and asset_id=a.id and project_id=p_project and owner_id=p_owner;if not found then raise exception 'invalid_identity_asset_manifest' using errcode='55000';end if;
 if p_ref is distinct from jsonb_build_object('ownerId',p_owner,'projectId',p_project,'assetId',a.id,'versionId',v.id,'contentHash',v.content_hash,'purpose',a.purpose,'mimeType',v.mime_type)
  or a.purpose not in('brand_asset','legacy_unknown') or(p_board and v.mime_type not in('image/png','image/jpeg','image/webp')) then raise exception 'invalid_identity_asset_manifest' using errcode='55000';end if;
end $$;
-- Validate the complete frozen selection, including non-material attribution.
-- URL parser parity is a separately recorded pending architecture decision.
create function fluid_private.identity_reference_snapshot_shape(p_snapshot jsonb,p_owner uuid,p_project uuid) returns void
language plpgsql stable set search_path='' as $$
declare e jsonb;r jsonb;a jsonb;reaction jsonb;media jsonb;ids text[]:='{}';rid text;ref_revision bigint;reaction_revision bigint;k text;v_asset public.assets;v_version public.asset_versions;
begin
 if jsonb_typeof(p_snapshot) is distinct from 'object' or p_snapshot-array['version','ownerId','projectId','referenceRevision','selectedReferenceCount','capturedAt','selected']<>'{}' or not(p_snapshot ?& array['version','ownerId','projectId','referenceRevision','selectedReferenceCount','capturedAt','selected'])
  or p_snapshot->'version' is distinct from '1'::jsonb or p_snapshot->'ownerId' is distinct from to_jsonb(p_owner) or p_snapshot->'projectId' is distinct from to_jsonb(p_project) or jsonb_typeof(p_snapshot->'selected') is distinct from 'array' or jsonb_array_length(p_snapshot->'selected')>100 then raise exception 'invalid_identity_reference_snapshot' using errcode='22023';end if;
 ref_revision:=fluid_private.identity_counter(p_snapshot->'referenceRevision');
 if fluid_private.identity_counter(p_snapshot->'selectedReferenceCount')<>jsonb_array_length(p_snapshot->'selected') then raise exception 'invalid_identity_reference_snapshot' using errcode='22023';end if;
 perform fluid_private.identity_time_key(fluid_private.identity_text(p_snapshot->'capturedAt',1,64,false));
 for e in select value from jsonb_array_elements(p_snapshot->'selected') loop
  if jsonb_typeof(e) is distinct from 'object' or e-array['reference','reaction']<>'{}' or not(e ?& array['reference','reaction']) then raise exception 'invalid_identity_reference_snapshot' using errcode='22023';end if;
  r:=e->'reference';reaction:=e->'reaction';a:=r->'attribution';media:=r->'media';
  if jsonb_typeof(r) is distinct from 'object' or r-array['id','ownerId','projectId','createdAt','media','source','attribution','relevantElements','tags']<>'{}' or not(r ?& array['id','ownerId','projectId','createdAt','media','source','attribution','relevantElements','tags'])
   or r->'ownerId' is distinct from to_jsonb(p_owner) or r->'projectId' is distinct from to_jsonb(p_project) or r->>'source' not in('user_supplied','attributed_catalog') then raise exception 'invalid_identity_reference_snapshot' using errcode='22023';end if;
  rid:=fluid_private.identity_text(r->'id',36,36,false);perform rid::uuid;
  if rid=any(ids) or (cardinality(ids)>0 and rid<=ids[cardinality(ids)]) then raise exception 'invalid_identity_reference_snapshot' using errcode='22023';end if;ids:=array_append(ids,rid);
  perform fluid_private.identity_time_key(fluid_private.identity_text(r->'createdAt',1,64,false));
  if r->'relevantElements' is distinct from to_jsonb(fluid_private.reference_elements(r->'relevantElements')) or r->'tags' is distinct from to_jsonb(fluid_private.reference_tags(r->'tags')) then raise exception 'invalid_identity_reference_snapshot' using errcode='22023';end if;
  if jsonb_typeof(a) is distinct from 'object' or a-array['label','creator','sourceUrl','rightsNote']<>'{}' or not(a ?& array['label','creator','sourceUrl','rightsNote']) then raise exception 'invalid_identity_reference_snapshot' using errcode='22023';end if;
  if a->>'label' is distinct from fluid_private.identity_text(a->'label',1,240) then raise exception 'invalid_identity_reference_snapshot' using errcode='22023';end if;
  foreach k in array array['creator','rightsNote'] loop
   if a->k<>'null' and a->>k is distinct from fluid_private.identity_text(a->k,1,case k when 'creator' then 240 else 2000 end) then raise exception 'invalid_identity_reference_snapshot' using errcode='22023';end if;
  end loop;
  if a->'sourceUrl'<>'null' then perform fluid_private.identity_text(a->'sourceUrl',1,2048);end if;
  if jsonb_typeof(media) is distinct from 'object' or media-array['ownerId','projectId','assetId','versionId','contentHash','purpose','mimeType']<>'{}' or not(media ?& array['ownerId','projectId','assetId','versionId','contentHash','purpose','mimeType']) then raise exception 'invalid_identity_reference_snapshot' using errcode='22023';end if;
  select * into v_asset from public.assets where id=(media->>'assetId')::uuid and owner_id=p_owner and project_id=p_project;
  if not found then raise exception 'invalid_identity_reference_snapshot' using errcode='22023';end if;
  select * into v_version from public.asset_versions where id=(media->>'versionId')::uuid and asset_id=v_asset.id and owner_id=p_owner and project_id=p_project;
  if not found or v_asset.purpose<>'reference_media' or v_version.mime_type not in('image/png','image/jpeg','image/webp') or media is distinct from jsonb_build_object('ownerId',p_owner,'projectId',p_project,'assetId',v_asset.id,'versionId',v_version.id,'contentHash',v_version.content_hash,'purpose',v_asset.purpose,'mimeType',v_version.mime_type) then raise exception 'invalid_identity_reference_snapshot' using errcode='22023';end if;
  if jsonb_typeof(reaction) is distinct from 'object' or reaction-array['referenceId','ownerId','projectId','revision','ensemble','elements','updatedAt']<>'{}' or not(reaction ?& array['referenceId','ownerId','projectId','revision','ensemble','elements','updatedAt'])
   or reaction->'referenceId' is distinct from r->'id' or reaction->'ownerId' is distinct from to_jsonb(p_owner) or reaction->'projectId' is distinct from to_jsonb(p_project) or jsonb_typeof(reaction->'ensemble') is distinct from 'boolean'
   or reaction->'elements' is distinct from to_jsonb(fluid_private.reference_elements(reaction->'elements')) or not((reaction->'elements')<@(r->'relevantElements')) then raise exception 'invalid_identity_reference_snapshot' using errcode='22023';end if;
  reaction_revision:=fluid_private.identity_counter(reaction->'revision',true);
  if reaction_revision>ref_revision or (reaction->'ensemble'='false' and reaction->'elements'='[]') then raise exception 'invalid_identity_reference_snapshot' using errcode='22023';end if;
  perform fluid_private.identity_time_key(fluid_private.identity_text(reaction->'updatedAt',1,64,false));
 end loop;
end $$;

create function fluid_private.identity_manifest_shape(p_manifest jsonb,p_owner uuid,p_project uuid) returns void
language plpgsql stable set search_path='' as $$
declare v_board jsonb:=p_manifest->'board';v_input jsonb:=p_manifest->'input';v_source jsonb:=p_manifest->'source';f jsonb;k text;v_stale jsonb;
begin
 if jsonb_typeof(p_manifest) is distinct from 'object' or p_manifest-array['id','ownerId','projectId','createdAt','input','source','components','board','productionFiles']<>'{}' or not(p_manifest ?& array['id','ownerId','projectId','createdAt','input','source','components','board','productionFiles'])
  or p_manifest->'ownerId' is distinct from to_jsonb(p_owner) or p_manifest->'projectId' is distinct from to_jsonb(p_project) or jsonb_typeof(p_manifest->'id') is distinct from 'string'
  or jsonb_typeof(p_manifest->'createdAt') is distinct from 'string'
  or jsonb_typeof(v_board) is distinct from 'object' or v_board-array['asset','depictsSystemVersionId','staleComponents']<>'{}' or not(v_board ?& array['asset','depictsSystemVersionId','staleComponents'])
  or jsonb_typeof(v_board->'depictsSystemVersionId') is distinct from 'string' or jsonb_typeof(v_board->'staleComponents') is distinct from 'array'
  or jsonb_typeof(p_manifest->'productionFiles') is distinct from 'array' or jsonb_array_length(p_manifest->'productionFiles')>48
 then raise exception 'invalid_identity_complete_manifest' using errcode='55000';end if;
 perform (p_manifest->>'id')::uuid;perform(v_board->>'depictsSystemVersionId')::uuid;perform fluid_private.identity_time_key(p_manifest->>'createdAt');
 select coalesce(jsonb_agg(to_jsonb(value) order by n),'[]') into v_stale from unnest(array['logo','colors','typography','graphics','imagery','composition']) with ordinality x(value,n) where v_board->'staleComponents' ? value;
 if v_board->'staleComponents'<>v_stale or p_manifest->'components' is distinct from fluid_private.identity_components(p_manifest->'components') then raise exception 'invalid_identity_complete_manifest' using errcode='55000';end if;
 if jsonb_typeof(v_source) is distinct from 'object' or v_source->>'kind' not in('generated','manual_edit') then raise exception 'invalid_identity_complete_manifest' using errcode='55000';end if;
 if v_source->>'kind'='generated' then
  if v_source-array['kind','batchId','jobId','stepKey']<>'{}' or not(v_source ?& array['kind','batchId','jobId','stepKey']) or jsonb_typeof(v_source->'batchId')<>'string' or jsonb_typeof(v_source->'jobId')<>'string' or v_board->'staleComponents'<>'[]' or v_board->'depictsSystemVersionId' is distinct from p_manifest->'id' then raise exception 'invalid_identity_complete_manifest' using errcode='55000';end if;
  perform(v_source->>'batchId')::uuid;perform(v_source->>'jobId')::uuid;perform fluid_private.identity_text(v_source->'stepKey',1,200,false);
 else
  if v_source-array['kind','baseSystemVersionId','changeId','component','editedAtProjectRevision','editedAtReferenceRevision','editedAtPreferencesRevision']<>'{}' or not(v_source ?& array['kind','baseSystemVersionId','changeId','component','editedAtProjectRevision','editedAtReferenceRevision','editedAtPreferencesRevision']) then raise exception 'invalid_identity_complete_manifest' using errcode='55000';end if;
  perform(v_source->>'baseSystemVersionId')::uuid;perform(v_source->>'changeId')::uuid;
  if v_source->>'component' not in('colors','typography') or v_source->'baseSystemVersionId'=p_manifest->'id' or v_board->'depictsSystemVersionId'=p_manifest->'id' or not(v_board->'staleComponents' ? (v_source->>'component')) then raise exception 'invalid_identity_complete_manifest' using errcode='55000';end if;
  perform fluid_private.identity_counter(v_source->'editedAtProjectRevision',true);perform fluid_private.identity_counter(v_source->'editedAtReferenceRevision');perform fluid_private.identity_counter(v_source->'editedAtPreferencesRevision');
 end if;
 if jsonb_typeof(v_input) is distinct from 'object' or v_input-array['version','ownerId','projectId','scope','projectRevision','context','referenceSnapshot','preferencesRevision','preferences','capturedAt','basis']<>'{}' or not(v_input ?& array['version','ownerId','projectId','scope','projectRevision','context','referenceSnapshot','preferencesRevision','preferences','capturedAt','basis'])
  or v_input->'version' is distinct from '1'::jsonb or v_input->'ownerId' is distinct from to_jsonb(p_owner) or v_input->'projectId' is distinct from to_jsonb(p_project) or v_input->>'scope' not in('complete_brand','naming_only','visual_identity_only') or jsonb_typeof(v_input->'capturedAt') is distinct from 'string'
  or v_input->'context' is distinct from fluid_private.identity_material_context(v_input->'context') or v_input->'preferences' is distinct from fluid_private.identity_preferences_value(v_input->'preferences') then raise exception 'invalid_identity_complete_manifest' using errcode='55000';end if;
 perform fluid_private.identity_reference_snapshot_shape(v_input->'referenceSnapshot',p_owner,p_project);
 perform fluid_private.identity_counter(v_input->'projectRevision',true);perform fluid_private.identity_counter(v_input->'preferencesRevision');perform fluid_private.identity_time_key(v_input->>'capturedAt');
 perform fluid_private.identity_asset_shape(v_board->'asset',p_owner,p_project,true);
 for f in select value from jsonb_array_elements(p_manifest->'productionFiles') loop
  if jsonb_typeof(f) is distinct from 'object' or f-array['component','role','asset']<>'{}' or not(f ?& array['component','role','asset']) or f->>'component' not in('logo','colors','typography','graphics','imagery','composition')
   or f->>'role' is distinct from fluid_private.identity_text(f->'role',1,120) or f#>'{asset,versionId}'=v_board#>'{asset,versionId}' or f#>'{asset,contentHash}'=v_board#>'{asset,contentHash}'
   or(v_source->>'kind'='manual_edit' and f->'component'=v_source->'component') then raise exception 'invalid_identity_complete_manifest' using errcode='55000';end if;
  perform fluid_private.identity_asset_shape(f->'asset',p_owner,p_project,false);
 end loop;
 if exists(select 1 from jsonb_array_elements(p_manifest->'productionFiles') as files(value) group by files.value->>'component',files.value->>'role' having count(*)>1) then raise exception 'invalid_identity_complete_manifest' using errcode='55000';end if;
end $$;

create function fluid_private.identity_check_files(p_system public.identity_system_versions) returns void
language plpgsql stable set search_path='' as $$
declare v_ref jsonb;v_manifest jsonb;v_index integer:=0;v_count integer;v_asset public.assets;v_version public.asset_versions;v_file public.identity_system_files;
begin
 perform fluid_private.identity_manifest_shape(fluid_private.identity_system_json(p_system),p_system.owner_id,p_system.project_id);
 if p_system.components is distinct from fluid_private.identity_components(p_system.components) then raise exception 'invalid_identity_components' using errcode='55000';end if;
 select count(*) into v_count from public.identity_system_files where system_id=p_system.id and project_id=p_system.project_id and owner_id=p_system.owner_id;
 if v_count<>1+jsonb_array_length(p_system.production_files) then raise exception 'invalid_identity_file_projection' using errcode='55000';end if;
 for v_manifest in select value from jsonb_array_elements(jsonb_build_array(jsonb_build_object('asset',p_system.board->'asset','role','board','component',null))||p_system.production_files) loop
  v_ref:=v_manifest->'asset';
  select * into v_file from public.identity_system_files where system_id=p_system.id and slot=v_index and project_id=p_system.project_id and owner_id=p_system.owner_id;
  if not found or v_file.component is distinct from v_manifest->>'component' or v_file.role is distinct from v_manifest->>'role' then raise exception 'invalid_identity_file_projection' using errcode='55000';end if;
  select * into strict v_asset from public.assets where id=v_file.asset_id and project_id=p_system.project_id and owner_id=p_system.owner_id;
  select * into strict v_version from public.asset_versions where id=v_file.version_id and asset_id=v_asset.id and project_id=p_system.project_id and owner_id=p_system.owner_id;
  if v_asset.purpose not in('brand_asset','legacy_unknown') or v_ref is distinct from jsonb_build_object('ownerId',p_system.owner_id,'projectId',p_system.project_id,'assetId',v_asset.id,'versionId',v_version.id,'contentHash',v_version.content_hash,'purpose',v_asset.purpose,'mimeType',v_version.mime_type)
   or(v_index=0 and v_version.mime_type not in('image/png','image/jpeg','image/webp'))
   or(v_index>0 and(v_ref->>'versionId'=p_system.board#>>'{asset,versionId}' or v_ref->>'contentHash'=p_system.board#>>'{asset,contentHash}')) then raise exception 'invalid_identity_file_evidence' using errcode='55000';end if;
  v_index:=v_index+1;
 end loop;
 if exists(select 1 from jsonb_array_elements(p_system.production_files) f group by f->>'component',f->>'role' having count(*)>1) then raise exception 'invalid_identity_file_roles' using errcode='55000';end if;
end $$;
create function fluid_private.identity_root_evidence(p_system public.identity_system_versions) returns jsonb
language plpgsql stable set search_path='' as $$
declare r public.identity_generated_roots;b public.identity_batches;j public.jobs;s public.job_steps;i public.identity_input_snapshots;v_system jsonb;v_output jsonb;v_snapshot jsonb;v_context jsonb;v_preferences jsonb;v_root jsonb;
begin
 if p_system.source->>'kind'<>'generated' or p_system.root_system_id<>p_system.id then raise exception 'invalid_identity_root' using errcode='55000';end if;
 select * into r from public.identity_generated_roots where system_id=p_system.id and project_id=p_system.project_id and owner_id=p_system.owner_id;if not found then raise exception 'missing_identity_receipt' using errcode='55000';end if;
 select * into strict b from public.identity_batches where id=r.batch_id and job_id=r.job_id and project_id=r.project_id and owner_id=r.owner_id;
 select * into strict j from public.jobs where id=b.job_id and project_id=b.project_id and owner_id=b.owner_id;
 select * into strict s from public.job_steps where job_id=r.job_id and step_key=r.step_key and project_id=r.project_id and owner_id=r.owner_id;
 select * into strict i from public.identity_input_snapshots where id=b.input_id and project_id=b.project_id and owner_id=b.owner_id;
 v_system:=fluid_private.identity_system_json(p_system);v_output:=s.output->'identity';
 select snapshot into strict v_snapshot from public.identity_reference_snapshots where project_id=i.project_id and owner_id=i.owner_id and reference_revision=i.reference_revision;
 select context into strict v_context from public.project_revisions where project_id=i.project_id and owner_id=i.owner_id and revision=i.project_revision;
 if i.preferences_revision is null then v_preferences:=jsonb_build_object('version',1,'creativeLocale',coalesce(v_context->>'creativeLocale','en'),'notes',coalesce(v_context#>>'{intake,identityNotes}',''),'avoidanceNotes','');
 else select preferences into strict v_preferences from public.identity_preferences where project_id=i.project_id and owner_id=i.owner_id and revision=i.preferences_revision;end if;
 if j.operation<>'identity.image' or j.input_revision<>i.project_revision or s.state<>'succeeded' or s.completed_at is null or i.id<>p_system.input_id
  or p_system.source is distinct from jsonb_build_object('kind','generated','batchId',b.id,'jobId',j.id,'stepKey',s.step_key)
  or s.output-array['identity']<>'{}' or jsonb_typeof(v_output) is distinct from 'object' or v_output-array['version','operation','ownerId','projectId','batchId','jobId','stepKey','targetCount','input','systems']<>'{}'
  or (v_output-'systems') is distinct from jsonb_build_object('version',1,'operation','identity.image','ownerId',r.owner_id,'projectId',r.project_id,'batchId',r.batch_id,'jobId',r.job_id,'stepKey',r.step_key,'targetCount',3,'input',i.input)
  or jsonb_typeof(v_output->'systems') is distinct from 'array' or jsonb_array_length(v_output->'systems')>3
  or v_output#>array['systems',r.output_index::text] is distinct from v_system or r.board is distinct from p_system.board->'asset'
  or i.input->'context' is distinct from fluid_private.identity_material_context(v_context)
  or i.input->'referenceSnapshot' is distinct from v_snapshot or i.input->'preferences' is distinct from fluid_private.identity_preferences_value(v_preferences)
  or i.input->'basis' is distinct from fluid_private.identity_basis(i.owner_id,i.project_id,v_context,v_snapshot,v_preferences)
  or p_system.board->>'depictsSystemVersionId'<>p_system.id::text or p_system.board->'staleComponents' is distinct from '[]'::jsonb
 then raise exception 'invalid_identity_completed_evidence' using errcode='55000';end if;
 -- The exact full frozen input is bound by the immutable input row, output and
 -- receipt. Material equality never substitutes for completed manifest equality.
 for v_root in select value from jsonb_array_elements(v_output->'systems') loop
  perform fluid_private.identity_manifest_shape(v_root,p_system.owner_id,p_system.project_id);
  if v_root->'input' is distinct from i.input or v_root->'source' is distinct from p_system.source or v_root->'ownerId' is distinct from to_jsonb(r.owner_id) or v_root->'projectId' is distinct from to_jsonb(r.project_id)
   or v_root#>'{board,staleComponents}' is distinct from '[]'::jsonb or v_root#>'{board,depictsSystemVersionId}' is distinct from v_root->'id' or v_root->'components' is distinct from fluid_private.identity_components(v_root->'components') then raise exception 'invalid_identity_output' using errcode='55000';end if;
 end loop;
 if exists(select 1 from jsonb_array_elements(v_output->'systems') a group by a->>'id' having count(*)>1)
  or exists(select 1 from jsonb_array_elements(v_output->'systems') a group by a#>>'{board,asset,versionId}' having count(*)>1)
  or exists(select 1 from jsonb_array_elements(v_output->'systems') a group by a#>>'{board,asset,contentHash}' having count(*)>1)
  or exists(select 1 from jsonb_array_elements(v_output->'systems') a,jsonb_array_elements(v_output->'systems') other_system,jsonb_array_elements(other_system->'productionFiles') f where f#>'{asset,versionId}'=a#>'{board,asset,versionId}' or f#>'{asset,contentHash}'=a#>'{board,asset,contentHash}')
  or (select count(*) from public.identity_generated_roots where batch_id=b.id and owner_id=b.owner_id and project_id=b.project_id)>3
  or exists(select 1 from public.identity_generated_roots x where x.batch_id=b.id and x.system_id<>r.system_id and(x.board->>'versionId'=r.board->>'versionId' or x.board->>'contentHash'=r.board->>'contentHash')) or exists(select 1 from public.identity_generated_roots x join public.identity_generated_roots y on y.batch_id=x.batch_id and y.owner_id=x.owner_id and y.project_id=x.project_id join public.identity_system_versions ys on ys.id=y.system_id and ys.owner_id=y.owner_id and ys.project_id=y.project_id cross join lateral jsonb_array_elements(ys.production_files) pf where x.batch_id=b.id and x.owner_id=b.owner_id and x.project_id=b.project_id and(pf#>'{asset,versionId}'=x.board->'versionId' or pf#>'{asset,contentHash}'=x.board->'contentHash')) then raise exception 'invalid_identity_batch_outputs' using errcode='55000';end if;
 perform fluid_private.identity_check_files(p_system);
 return jsonb_build_object('batch',jsonb_build_object('id',b.id,'ownerId',b.owner_id,'projectId',b.project_id,'jobId',b.job_id,'targetCount',b.target_count,'input',i.input),
 'step',jsonb_build_object('ownerId',s.owner_id,'projectId',s.project_id,'jobId',s.job_id,'stepKey',s.step_key,'state',s.state,'completedAt',s.completed_at,'output',s.output),
 'receipt',jsonb_build_object('version',1,'ownerId',r.owner_id,'projectId',r.project_id,'batchId',r.batch_id,'jobId',r.job_id,'stepKey',r.step_key,'outputIndex',r.output_index,'systemVersionId',r.system_id,'board',r.board),'system',v_system);
end $$;

create or replace function fluid_private.identity_verified_system(p_system public.identity_system_versions) returns jsonb
language plpgsql stable set search_path='' as $$
declare b public.identity_system_versions;r public.identity_system_versions;c public.identity_component_changes;s public.identity_selections;v_board jsonb;v_files jsonb;v_components jsonb;v_stale jsonb;
begin
 if p_system.owner_id is distinct from auth.uid() then raise exception 'not_found' using errcode='P0002';end if;
 if p_system.source->>'kind'='generated' then perform fluid_private.identity_root_evidence(p_system);
 else
  select * into strict r from public.identity_system_versions where id=p_system.root_system_id and owner_id=p_system.owner_id and project_id=p_system.project_id;
  perform fluid_private.identity_root_evidence(r);
  select * into strict b from public.identity_system_versions where id=p_system.base_system_id and owner_id=p_system.owner_id and project_id=p_system.project_id;
  select * into strict c from public.identity_component_changes where id=p_system.change_id and owner_id=p_system.owner_id and project_id=p_system.project_id;
  select * into strict s from public.identity_selections where id=c.selection_id and owner_id=p_system.owner_id and project_id=p_system.project_id;
  select coalesce(jsonb_agg(to_jsonb(value) order by n),'[]') into v_stale from unnest(array['logo','colors','typography','graphics','imagery','composition']) with ordinality x(value,n) where value=c.component or b.board->'staleComponents' ? value;
  v_board:=jsonb_set(b.board,'{staleComponents}',v_stale);v_components:=jsonb_set(b.components,array[c.component],c.after_value);
  select coalesce(jsonb_agg(value order by n),'[]') into v_files from jsonb_array_elements(b.production_files) with ordinality x(value,n) where value->>'component'<>c.component;
  if p_system.input_id<>b.input_id or p_system.input_id<>r.input_id or b.root_system_id<>r.id or c.base_system_id<>b.id or c.result_system_id<>p_system.id
   or p_system.source is distinct from jsonb_build_object('kind','manual_edit','baseSystemVersionId',b.id,'changeId',c.id,'component',c.component,'editedAtProjectRevision',c.project_revision,'editedAtReferenceRevision',c.reference_revision,'editedAtPreferencesRevision',coalesce(c.preferences_revision,0))
   or c.before_value is distinct from b.components->c.component or c.after_value is distinct from fluid_private.identity_component(c.component,c.after_value)
   or p_system.components is distinct from v_components or p_system.board is distinct from v_board or p_system.production_files is distinct from v_files
   or s.system_id<>p_system.id or s.reason<>'refined' or s.current_basis<>c.current_basis or s.project_revision<>c.project_revision or s.reference_revision<>c.reference_revision or s.preferences_revision is distinct from c.preferences_revision or s.accepted_earlier_basis<>c.accepted_earlier_basis
   or c.accepted_earlier_basis is distinct from(c.current_basis<>(fluid_private.identity_system_json(b)#>'{input,basis}'))
   or c.project_revision<coalesce((b.source->>'editedAtProjectRevision')::bigint,(fluid_private.identity_system_json(b)#>>'{input,projectRevision}')::bigint)
   or c.reference_revision<coalesce((b.source->>'editedAtReferenceRevision')::bigint,(fluid_private.identity_system_json(b)#>>'{input,referenceSnapshot,referenceRevision}')::bigint)
   or coalesce(c.preferences_revision,0)<coalesce((b.source->>'editedAtPreferencesRevision')::bigint,(fluid_private.identity_system_json(b)#>>'{input,preferencesRevision}')::bigint)
  then raise exception 'invalid_identity_refinement_evidence' using errcode='55000';end if;
  perform fluid_private.identity_check_files(p_system);
 end if;return fluid_private.identity_system_json(p_system);
exception when sqlstate '22023' or sqlstate '22P02' or sqlstate '22007' or sqlstate '22008' then raise exception 'invalid_identity_stored_evidence' using errcode='55000';
end $$;
create function fluid_private.identity_proofs(p_project uuid,p_ids uuid[]) returns jsonb
language plpgsql stable set search_path='' as $$
declare v_queue uuid[]:=p_ids;v_seen uuid[]:='{}';v_roots uuid[]:='{}';v_id uuid;v_index integer:=1;v_system public.identity_system_versions;v_change public.identity_component_changes;v_selection public.identity_selections;v_records jsonb:='[]';v_evidence jsonb:='[]';
begin
 while v_index<=cardinality(v_queue) loop
  v_id:=v_queue[v_index];v_index:=v_index+1;if v_id=any(v_seen) then continue;end if;v_seen:=array_append(v_seen,v_id);
  select * into strict v_system from public.identity_system_versions where id=v_id and project_id=p_project and owner_id=auth.uid();
  perform fluid_private.identity_verified_system(v_system);
  if v_system.source->>'kind'='generated' then
   if not(v_id=any(v_roots)) then v_evidence:=v_evidence||jsonb_build_array(fluid_private.identity_root_evidence(v_system));v_roots:=array_append(v_roots,v_id);end if;
   v_records:=v_records||jsonb_build_array(jsonb_build_object('system',fluid_private.identity_system_json(v_system),'rootSystemId',v_system.root_system_id,'base',null,'change',null,'selection',null));
  else
   select * into strict v_change from public.identity_component_changes where id=v_system.change_id and project_id=p_project and owner_id=auth.uid();
   select * into strict v_selection from public.identity_selections where id=v_change.selection_id and project_id=p_project and owner_id=auth.uid();
   v_queue:=array_append(v_queue,v_system.base_system_id);v_queue:=array_append(v_queue,v_system.root_system_id);
   v_records:=v_records||jsonb_build_array(jsonb_build_object('system',fluid_private.identity_system_json(v_system),'rootSystemId',v_system.root_system_id,'base',v_system.base_system_id,'change',fluid_private.identity_change_json(v_change),'selection',fluid_private.identity_selection_json(v_selection)));
  end if;
 end loop;
 return jsonb_build_object('records',v_records,'roots',v_evidence);
end $$;

create function public.get_project_identity(p_project_id uuid,p_query jsonb default '{}') returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare v_owner uuid:=auth.uid();v_state jsonb;v_query jsonb;v_cursor jsonb;v_row public.identity_system_versions;v_last public.identity_system_versions;v_records jsonb:='[]';v_next jsonb;v_count integer:=0;v_ids uuid[]:='{}';v_selection public.identity_selections;v_selected public.identity_system_versions;v_selected_json jsonb;
begin
 if v_owner is null then raise exception 'unauthenticated' using errcode='42501';end if;
 v_state:=fluid_private.identity_current_state(p_project_id);v_query:=fluid_private.identity_history_query(p_project_id,p_query);v_cursor:=v_query->'cursor';
 if v_state#>>'{session,currentSelectionId}' is not null then
  select * into strict v_selection from public.identity_selections where id=(v_state#>>'{session,currentSelectionId}')::uuid and project_id=p_project_id and owner_id=v_owner;
  select * into strict v_selected from public.identity_system_versions where id=v_selection.system_id and project_id=p_project_id and owner_id=v_owner;
  v_selected_json:=jsonb_build_object('selection',fluid_private.identity_selection_json(v_selection),'system',fluid_private.identity_verified_system(v_selected));v_ids:=array_append(v_ids,v_selected.id);
 end if;
 if v_cursor is not null and not exists(select 1 from public.identity_system_versions where id=(v_cursor->>'id')::uuid and project_id=p_project_id and owner_id=v_owner and created_at_order=fluid_private.identity_time_key(v_cursor->>'createdAt')) then raise exception 'not_found' using errcode='P0002';end if;
 for v_row in select * from public.identity_system_versions where project_id=p_project_id and owner_id=v_owner
  and(v_cursor is null or(created_at_order,id)<(fluid_private.identity_time_key(v_cursor->>'createdAt'),(v_cursor->>'id')::uuid)) order by created_at_order desc,id desc limit(v_query->>'limit')::integer+1 loop
  v_count:=v_count+1;if v_count>(v_query->>'limit')::integer then v_next:=jsonb_build_object('projectId',p_project_id,'createdAt',v_last.created_at_text,'id',v_last.id);exit;end if;
  v_records:=v_records||jsonb_build_array(fluid_private.identity_verified_system(v_row));v_last:=v_row;v_ids:=array_append(v_ids,v_row.id);
 end loop;
 return v_state||jsonb_build_object('history',jsonb_build_object('query',v_query,'records',v_records,'nextCursor',v_next),'selection',v_selected_json,'proofs',fluid_private.identity_proofs(p_project_id,v_ids));
end $$;
create function public.list_identity_systems(p_project_id uuid,p_query jsonb default '{}') returns jsonb
language sql stable security definer set search_path='' as $$ select public.get_project_identity(p_project_id,p_query); $$;
create function public.get_identity_system(p_project_id uuid,p_system_version_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare v_state jsonb;v_system public.identity_system_versions;
begin
 if auth.uid() is null then raise exception 'unauthenticated' using errcode='42501';end if;
 v_state:=fluid_private.identity_current_state(p_project_id);
 select * into v_system from public.identity_system_versions where id=p_system_version_id and project_id=p_project_id and owner_id=auth.uid();if not found then raise exception 'not_found' using errcode='P0002';end if;
 return v_state||jsonb_build_object('system',fluid_private.identity_verified_system(v_system),'proofs',fluid_private.identity_proofs(p_project_id,array[v_system.id]));
end $$;
revoke all on function fluid_private.identity_current_references(uuid),fluid_private.identity_current_state(uuid),fluid_private.identity_history_query(uuid,jsonb),
 fluid_private.identity_verified_system(public.identity_system_versions) from public,anon,authenticated,service_role;
revoke all on function public.get_project_identity(uuid,jsonb),public.list_identity_systems(uuid,jsonb),public.get_identity_system(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.get_project_identity(uuid,jsonb),public.list_identity_systems(uuid,jsonb),public.get_identity_system(uuid,uuid) to authenticated;

revoke all on function fluid_private.identity_trim(text),fluid_private.identity_preferences_value(jsonb),fluid_private.identity_counter(jsonb,boolean),
 fluid_private.identity_session_json(public.identity_sessions),fluid_private.identity_preferences_json(public.identity_preferences) from public,anon,authenticated,service_role;
revoke all on function public.set_identity_preferences(uuid,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.set_identity_preferences(uuid,jsonb) to authenticated;
create function fluid_private.identity_mutation_context(p_project uuid,p_input jsonb) returns jsonb
language plpgsql set search_path='' as $$
declare p public.projects;h public.identity_sessions;r jsonb;v_context jsonb;v_preferences jsonb;v_basis jsonb;v_ref bigint;
begin
 select * into p from public.projects where id=p_project and owner_id=auth.uid() for update;if not found then raise exception 'not_found' using errcode='P0002';end if;
 if p.current_revision<>fluid_private.identity_counter(p_input->'expectedProjectRevision',true) then raise exception 'identity_revision_conflict' using errcode='PT409';end if;
 v_ref:=fluid_private.identity_counter(p_input->'expectedReferenceRevision');r:=fluid_private.capture_identity_reference_snapshot(p_project,v_ref);
 perform fluid_private.identity_reference_snapshot_shape(r,auth.uid(),p_project);
 insert into public.identity_sessions(project_id,owner_id) values(p_project,auth.uid()) on conflict do nothing;
 select * into strict h from public.identity_sessions where project_id=p_project and owner_id=auth.uid() for update;
 if h.identity_revision<>fluid_private.identity_counter(p_input->'expectedIdentityRevision') or coalesce(h.current_preferences_revision,0)<>fluid_private.identity_counter(p_input->'expectedPreferencesRevision') or h.identity_revision>=9007199254740991 then raise exception 'identity_revision_conflict' using errcode='PT409';end if;
 select context into strict v_context from public.project_revisions where project_id=p_project and owner_id=auth.uid() and revision=p.current_revision;
 if h.current_preferences_revision is null then v_preferences:=jsonb_build_object('version',1,'creativeLocale',coalesce(v_context->>'creativeLocale','en'),'notes',coalesce(v_context#>>'{intake,identityNotes}',''),'avoidanceNotes','');
 else select preferences into strict v_preferences from public.identity_preferences where project_id=p_project and owner_id=auth.uid() and revision=h.current_preferences_revision;end if;
 v_basis:=fluid_private.identity_basis(auth.uid(),p_project,v_context,r,v_preferences);
 return jsonb_build_object('projectRevision',p.current_revision,'referenceRevision',v_ref,'preferencesRevision',coalesce(h.current_preferences_revision,0),'identityRevision',h.identity_revision,'currentBasis',v_basis,'previousSelectionId',h.current_selection_id);
end $$;
create function fluid_private.identity_request(p_input jsonb,p_refinement boolean) returns jsonb
language plpgsql immutable set search_path='' as $$
declare keys text[]:=array['expectedProjectRevision','expectedReferenceRevision','expectedPreferencesRevision','expectedIdentityRevision','acceptEarlierBasis'];k text;idkey text;v_id uuid;
begin
 idkey:=case when p_refinement then 'baseSystemVersionId' else 'systemVersionId' end;keys:=keys||array[idkey];if p_refinement then keys:=keys||array['component','input','idempotencyKey'];end if;
 if jsonb_typeof(p_input) is distinct from 'object' or p_input-keys<>'{}' or not(p_input ?& keys) or jsonb_typeof(p_input->'acceptEarlierBasis') is distinct from 'boolean' or jsonb_typeof(p_input->idkey) is distinct from 'string' then raise exception 'invalid_identity_request' using errcode='22023';end if;
 v_id:=(p_input->>idkey)::uuid;p_input:=jsonb_set(p_input,array[idkey],to_jsonb(v_id));
 foreach k in array array['expectedProjectRevision','expectedReferenceRevision','expectedPreferencesRevision','expectedIdentityRevision'] loop perform fluid_private.identity_counter(p_input->k,k='expectedProjectRevision');end loop;
 if p_refinement then
  if jsonb_typeof(p_input->'component') is distinct from 'string' or jsonb_typeof(p_input->'idempotencyKey') is distinct from 'string' or p_input->>'idempotencyKey'!~'^[A-Za-z0-9._:-]{16,128}$' then raise exception 'invalid_identity_request' using errcode='22023';end if;
  p_input:=jsonb_set(p_input,'{input}',fluid_private.identity_component(p_input->>'component',p_input->'input'));
 end if;return p_input;
end $$;
create function fluid_private.identity_write_selection(p_system public.identity_system_versions,p_state jsonb,p_accept boolean,p_reason text,p_id uuid,p_at timestamptz) returns public.identity_selections
language plpgsql set search_path='' as $$
declare v_input jsonb;v_stale boolean;v_previous public.identity_selections;v_selection public.identity_selections;v_asset uuid;
begin
 if p_system.owner_id<>auth.uid() then raise exception 'not_found' using errcode='P0002';end if;
 v_input:=fluid_private.identity_system_json(p_system)->'input';v_stale:=v_input->'basis'<>p_state->'currentBasis';
 if (p_state->>'projectRevision')::bigint<coalesce((p_system.source->>'editedAtProjectRevision')::bigint,(v_input->>'projectRevision')::bigint)
  or(p_state->>'referenceRevision')::bigint<coalesce((p_system.source->>'editedAtReferenceRevision')::bigint,(v_input#>>'{referenceSnapshot,referenceRevision}')::bigint)
  or(p_state->>'preferencesRevision')::bigint<coalesce((p_system.source->>'editedAtPreferencesRevision')::bigint,(v_input->>'preferencesRevision')::bigint) then raise exception 'identity_creation_revision_conflict' using errcode='PT409';end if;
 select * into v_previous from public.identity_selections where id=(p_state->>'previousSelectionId')::uuid and project_id=p_system.project_id and owner_id=p_system.owner_id;
 if v_previous.id is not null and(v_previous.identity_revision<>(p_state->>'identityRevision')::bigint or v_previous.project_revision>(p_state->>'projectRevision')::bigint or v_previous.reference_revision>(p_state->>'referenceRevision')::bigint or coalesce(v_previous.preferences_revision,0)>(p_state->>'preferencesRevision')::bigint) then raise exception 'identity_previous_revision_conflict' using errcode='PT409';end if;
 if v_stale and not p_accept then raise exception 'identity_earlier_basis_requires_acknowledgment' using errcode='PT409';end if;
 for v_asset in select id from public.assets where owner_id=p_system.owner_id and project_id=p_system.project_id and(id in(select asset_id from public.asset_usages where selection_id=v_previous.id) or id in(select asset_id from public.identity_system_files where system_id=p_system.id)) order by id for update loop null;end loop;
 insert into public.identity_selections(id,project_id,owner_id,system_id,identity_revision,project_revision,reference_revision,preferences_revision,current_basis,accepted_earlier_basis,previous_selection_id,reason,created_at)
 values(p_id,p_system.project_id,p_system.owner_id,p_system.id,(p_state->>'identityRevision')::bigint+1,(p_state->>'projectRevision')::integer,(p_state->>'referenceRevision')::bigint,nullif((p_state->>'preferencesRevision')::bigint,0),p_state->'currentBasis',v_stale,v_previous.id,p_reason,p_at) returning * into v_selection;
 insert into public.asset_usages(selection_id,system_id,slot,project_id,owner_id,asset_id,version_id) select p_id,system_id,slot,project_id,owner_id,asset_id,version_id from public.identity_system_files where system_id=p_system.id and project_id=p_system.project_id and owner_id=p_system.owner_id;
 update public.identity_sessions set identity_revision=v_selection.identity_revision,current_selection_id=p_id,updated_at=p_at where project_id=p_system.project_id and owner_id=p_system.owner_id;
 update public.assets a set used=(a.legacy_used or exists(select 1 from public.asset_usages u join public.identity_sessions h on h.current_selection_id=u.selection_id and h.project_id=u.project_id and h.owner_id=u.owner_id where u.asset_id=a.id and u.project_id=a.project_id and u.owner_id=a.owner_id))
 where a.owner_id=p_system.owner_id and a.project_id=p_system.project_id and(a.id in(select asset_id from public.asset_usages where selection_id=v_previous.id) or a.id in(select asset_id from public.asset_usages where selection_id=p_id));
 return v_selection;
end $$;
create function public.select_identity_system(p_project_id uuid,p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_state jsonb;v_system public.identity_system_versions;v_selection public.identity_selections;v_head public.identity_sessions;v_reason text;
begin
 if auth.uid() is null then raise exception 'unauthenticated' using errcode='42501';end if;
 -- Unavailable until the approved trusted server transaction performs shared
 -- schema/WHATWG URL/naming-history validation under every relevant lock.
 -- This local guard closes direct authenticated RPC access as well as the DAL.
 perform 1 from public.projects where id=p_project_id and owner_id=auth.uid();if not found then raise exception 'not_found' using errcode='P0002';end if;
 raise exception 'identity_trusted_transaction_unavailable' using errcode='55000';
p_input:=fluid_private.identity_request(p_input,false);
 v_state:=fluid_private.identity_mutation_context(p_project_id,p_input);
 select * into v_system from public.identity_system_versions where id=(p_input->>'systemVersionId')::uuid and project_id=p_project_id and owner_id=auth.uid();if not found then raise exception 'not_found' using errcode='P0002';end if;
 perform fluid_private.identity_verified_system(v_system);
 v_reason:=case when exists(select 1 from public.identity_selections where system_id=v_system.id and project_id=p_project_id and owner_id=auth.uid()) then 'restored' else 'selected' end;
 v_selection:=fluid_private.identity_write_selection(v_system,v_state,(p_input->>'acceptEarlierBasis')::boolean,v_reason,gen_random_uuid(),clock_timestamp());
 select * into strict v_head from public.identity_sessions where project_id=p_project_id and owner_id=auth.uid();
 return jsonb_build_object('session',fluid_private.identity_session_json(v_head),'currentSelection',jsonb_build_object('selection',fluid_private.identity_selection_json(v_selection),'system',fluid_private.identity_system_json(v_system)),
  'proofs',fluid_private.identity_proofs(p_project_id,array[v_system.id]));
end $$;
create function public.refine_identity_component(p_project_id uuid,p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_state jsonb;b public.identity_system_versions;r public.identity_system_versions;c public.identity_component_changes;s public.identity_selections;v_id uuid:=gen_random_uuid();v_change uuid:=gen_random_uuid();v_selection uuid:=gen_random_uuid();v_at timestamptz:=clock_timestamp();v_component text;v_board jsonb;v_files jsonb;v_stale jsonb;v_item jsonb;v_slot integer:=0;
begin
 if auth.uid() is null then raise exception 'unauthenticated' using errcode='42501';end if;
 -- Unavailable until the approved trusted server transaction performs shared
 -- schema/WHATWG URL/naming-history validation under every relevant lock.
 -- This local guard closes direct authenticated RPC access as well as the DAL.
 perform 1 from public.projects where id=p_project_id and owner_id=auth.uid();if not found then raise exception 'not_found' using errcode='P0002';end if;
 raise exception 'identity_trusted_transaction_unavailable' using errcode='55000';
p_input:=fluid_private.identity_request(p_input,true);
 perform 1 from public.projects where id=p_project_id and owner_id=auth.uid() for update;if not found then raise exception 'not_found' using errcode='P0002';end if;
 select * into c from public.identity_component_changes where project_id=p_project_id and owner_id=auth.uid() and idempotency_key=p_input->>'idempotencyKey';
 if found then
  if c.intent<>p_input then raise exception 'identity_idempotency_conflict' using errcode='PT409';end if;
  select * into strict r from public.identity_system_versions where id=c.result_system_id and project_id=p_project_id and owner_id=auth.uid();
  select * into strict s from public.identity_selections where id=c.selection_id and project_id=p_project_id and owner_id=auth.uid();
  return jsonb_build_object('system',fluid_private.identity_verified_system(r),'change',fluid_private.identity_change_json(c),'selection',fluid_private.identity_selection_json(s),'proofs',fluid_private.identity_proofs(p_project_id,array[r.id]));
 end if;
 v_state:=fluid_private.identity_mutation_context(p_project_id,p_input);
 select * into b from public.identity_system_versions where id=(p_input->>'baseSystemVersionId')::uuid and project_id=p_project_id and owner_id=auth.uid();if not found then raise exception 'not_found' using errcode='P0002';end if;
 perform fluid_private.identity_verified_system(b);v_component:=p_input->>'component';
 if b.components->v_component=p_input->'input' then raise exception 'identity_refinement_no_change' using errcode='22023';end if;
 select coalesce(jsonb_agg(to_jsonb(value) order by n),'[]') into v_stale from unnest(array['logo','colors','typography','graphics','imagery','composition']) with ordinality x(value,n) where value=v_component or b.board->'staleComponents' ? value;
 v_board:=jsonb_set(b.board,'{staleComponents}',v_stale);
 select coalesce(jsonb_agg(value order by n),'[]') into v_files from jsonb_array_elements(b.production_files) with ordinality x(value,n) where value->>'component'<>v_component;
 insert into public.identity_system_versions(id,project_id,owner_id,input_id,root_system_id,base_system_id,change_id,source,components,board,production_files,created_at,created_at_text)
 values(v_id,p_project_id,auth.uid(),b.input_id,b.root_system_id,b.id,v_change,jsonb_build_object('kind','manual_edit','baseSystemVersionId',b.id,'changeId',v_change,'component',v_component,'editedAtProjectRevision',v_state->'projectRevision','editedAtReferenceRevision',v_state->'referenceRevision','editedAtPreferencesRevision',v_state->'preferencesRevision'),jsonb_set(b.components,array[v_component],p_input->'input'),v_board,v_files,v_at,to_jsonb(v_at)#>>'{}') returning * into r;
 for v_item in select value from jsonb_array_elements(jsonb_build_array(jsonb_build_object('asset',r.board->'asset','role','board','component',null))||r.production_files) loop
  insert into public.identity_system_files(system_id,slot,project_id,owner_id,component,role,asset_id,version_id) values(r.id,v_slot,p_project_id,auth.uid(),v_item->>'component',v_item->>'role',(v_item#>>'{asset,assetId}')::uuid,(v_item#>>'{asset,versionId}')::uuid);v_slot:=v_slot+1;
 end loop;
 s:=fluid_private.identity_write_selection(r,v_state,(p_input->>'acceptEarlierBasis')::boolean,'refined',v_selection,v_at);
 insert into public.identity_component_changes(id,project_id,owner_id,base_system_id,result_system_id,selection_id,component,before_value,after_value,project_revision,reference_revision,preferences_revision,current_basis,accepted_earlier_basis,idempotency_key,intent,created_at)
 values(v_change,p_project_id,auth.uid(),b.id,r.id,s.id,v_component,b.components->v_component,p_input->'input',s.project_revision,s.reference_revision,s.preferences_revision,s.current_basis,s.accepted_earlier_basis,p_input->>'idempotencyKey',p_input,v_at) returning * into c;
 return jsonb_build_object('system',fluid_private.identity_verified_system(r),'change',fluid_private.identity_change_json(c),'selection',fluid_private.identity_selection_json(s),'proofs',fluid_private.identity_proofs(p_project_id,array[r.id]));
end $$;
revoke all on function public.select_identity_system(uuid,jsonb),public.refine_identity_component(uuid,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.select_identity_system(uuid,jsonb),public.refine_identity_component(uuid,jsonb) to authenticated;

create or replace function fluid_private.asset_library_record(p_asset public.assets) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('id',p_asset.id,'ownerId',p_asset.owner_id,'projectId',p_asset.project_id,'kind',p_asset.kind,'purpose',p_asset.purpose,'createdAt',p_asset.created_at,
 'versionCount',(select count(*) from public.asset_versions v where v.asset_id=p_asset.id and v.project_id=p_asset.project_id and v.owner_id=p_asset.owner_id),
 'retentionRevision',p_asset.retention_revision,'liked',p_asset.liked,'saved',p_asset.saved,'usage',jsonb_build_object('active',exists(select 1 from public.asset_usages u join public.identity_sessions ih on ih.current_selection_id=u.selection_id and ih.project_id=u.project_id and ih.owner_id=u.owner_id where u.asset_id=p_asset.id and u.project_id=p_asset.project_id and u.owner_id=p_asset.owner_id),'legacy',p_asset.legacy_used),
 'selectionRevision',h.selection_revision,'currentSelection',fluid_private.asset_library_selection(s))
 from public.asset_heads h left join public.asset_selections s on s.id=h.current_selection_id and s.version_id=h.current_version_id and s.asset_id=h.asset_id and s.project_id=h.project_id and s.owner_id=h.owner_id
 where h.asset_id=p_asset.id and h.project_id=p_asset.project_id and h.owner_id=p_asset.owner_id;
$$;
create or replace function public.list_account_assets(p_query jsonb default '{}') returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_owner uuid:=auth.uid();v_query jsonb;v_asset public.assets;v_project public.projects;v_items jsonb:='[]';v_count integer:=0;v_last public.assets;v_next jsonb;v_cursor jsonb;
begin
 if v_owner is null then raise exception 'unauthenticated' using errcode='42501';end if;v_query:=fluid_private.asset_library_query(p_query,false);v_cursor:=v_query->'cursor';
 if v_query ? 'projectId' and not exists(select 1 from public.projects where id=(v_query->>'projectId')::uuid and owner_id=v_owner) then raise exception 'not_found' using errcode='P0002';end if;
 if v_cursor is not null and not exists(select 1 from public.assets where id=(v_cursor->>'assetId')::uuid and owner_id=v_owner and purpose<>'reference_media' and created_at=(v_cursor->>'createdAt')::timestamptz and(not(v_query ? 'projectId') or project_id=(v_query->>'projectId')::uuid)) then raise exception 'not_found' using errcode='P0002';end if;
 for v_asset in select a.* from public.assets a where a.owner_id=v_owner and a.purpose<>'reference_media'
  and(v_query->>'tab'='all_generations' or a.liked or a.saved or a.legacy_used or exists(select 1 from public.asset_usages u join public.identity_sessions ih on ih.current_selection_id=u.selection_id and ih.project_id=u.project_id and ih.owner_id=u.owner_id where u.asset_id=a.id and u.project_id=a.project_id and u.owner_id=a.owner_id))
  and(not(v_query ? 'projectId') or a.project_id=(v_query->>'projectId')::uuid)
  and(not(v_query ? 'format') or exists(select 1 from public.asset_versions v where v.asset_id=a.id and v.project_id=a.project_id and v.owner_id=v_owner and fluid_private.asset_library_format(v.mime_type)=v_query->>'format'))
  and(v_cursor is null or(a.created_at,a.id)<((v_cursor->>'createdAt')::timestamptz,(v_cursor->>'assetId')::uuid))
  order by a.created_at desc,a.id desc limit (v_query->>'limit')::integer+1 loop
  v_count:=v_count+1;if v_count>(v_query->>'limit')::integer then
   v_next:=jsonb_build_object('createdAt',v_last.created_at,'assetId',v_last.id,'tab',v_query->>'tab','projectId',v_query->'projectId','format',v_query->'format');exit;
  end if;
  select * into strict v_project from public.projects where id=v_asset.project_id and owner_id=v_owner;
  v_items:=v_items||jsonb_build_array(fluid_private.asset_library_item(v_asset,v_project,v_query->>'format'));v_last:=v_asset;
 end loop;
 return jsonb_build_object('ownerId',v_owner,'query',v_query,'items',v_items,'nextCursor',v_next);
end $$;
do $$declare r record;begin
 for r in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='fluid_private' and p.proname like 'identity_%' loop
  execute format('revoke all on function %s from public,anon,authenticated,service_role',r.signature);
 end loop;
end $$;
commit;
