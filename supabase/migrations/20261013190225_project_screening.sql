-- Candidate only: durable OWNER-AUTHORED research notes. No provider receipts,
-- credentials, live checks, registrar actions or legal clearance are written here.
create table public.project_screening_records (
 id uuid primary key default gen_random_uuid(), request_id uuid not null,
 owner_id uuid not null, project_id uuid not null, selection_id uuid not null, candidate_id uuid not null,
 project_revision integer not null, context_hash text not null check(context_hash ~ '^[a-f0-9]{64}$'),
 selected_name text not null check(length(selected_name) between 1 and 160),
 criteria jsonb not null, notes text not null check(length(notes) between 1 and 3000),
 source_urls jsonb not null, observed_at timestamptz not null, recorded_at timestamptz not null default clock_timestamp(),
 request_payload jsonb not null check(octet_length(request_payload::text)<=32768),
 unique(owner_id,request_id), check(observed_at<=recorded_at),
 foreign key(selection_id,owner_id,project_id) references public.name_selections(id,owner_id,project_id),
 foreign key(candidate_id,owner_id,project_id) references public.name_candidates(id,owner_id,project_id),
 foreign key(project_id,owner_id,project_revision) references public.project_revisions(project_id,owner_id,revision)
);
create index project_screening_history on public.project_screening_records(owner_id,project_id,recorded_at desc,id desc);
alter table public.project_screening_records enable row level security;
alter table public.project_screening_records force row level security;
create policy project_screening_owner_read on public.project_screening_records for select to authenticated using((select auth.uid())=owner_id);
revoke all on public.project_screening_records from public,anon,authenticated,service_role;
grant select on public.project_screening_records to authenticated;
create trigger screening_immutable before update or delete on public.project_screening_records for each row execute function fluid_private.prevent_history_change();

create function fluid_private.project_screening_basis(p_project_id uuid,p_owner uuid) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('ownerId',p.owner_id,'projectId',p.id,'selectionId',s.id,'candidateId',c.id,
  'projectRevision',p.current_revision,'contextHash',r.input_hash,'name',c.value)
 from public.projects p join public.naming_sessions n on n.project_id=p.id and n.owner_id=p.owner_id
 join public.name_selections s on s.id=n.current_selection_id and s.owner_id=n.owner_id and s.project_id=n.project_id
 join public.name_candidates c on c.id=s.candidate_id and c.owner_id=s.owner_id and c.project_id=s.project_id
 join public.project_revisions r on r.project_id=p.id and r.owner_id=p.owner_id and r.revision=p.current_revision
 where p.id=p_project_id and p.owner_id=p_owner and r.context->>'selectedName'=c.value;
$$;
create function fluid_private.project_screening_record_dto(p_row public.project_screening_records) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('id',p_row.id,'requestId',p_row.request_id,
  'basis',jsonb_build_object('ownerId',p_row.owner_id,'projectId',p_row.project_id,'selectionId',p_row.selection_id,'candidateId',p_row.candidate_id,
   'projectRevision',p_row.project_revision,'contextHash',p_row.context_hash,'name',p_row.selected_name),
  'criteria',p_row.criteria,'provenance','user_recorded','verification','unverified','legalClearance','not_assessed',
  'notes',p_row.notes,'sourceUrls',p_row.source_urls,'observedAt',p_row.observed_at,'recordedAt',p_row.recorded_at);
$$;
create function public.get_project_screening(p_project_id uuid,p_cursor jsonb default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_owner uuid:=auth.uid();v_project public.projects;v_records jsonb;v_more boolean;v_last jsonb;
begin
 if v_owner is null then raise exception 'unauthenticated' using errcode='42501';end if;
 select * into v_project from public.projects where id=p_project_id and owner_id=v_owner for share;
 if not found then raise exception 'not_found' using errcode='P0002';end if;
 if p_cursor is not null and (jsonb_typeof(p_cursor)<>'object' or not(p_cursor ?& array['recordedAt','id']) or p_cursor-array['recordedAt','id']<>'{}'::jsonb
  or jsonb_typeof(p_cursor->'recordedAt')<>'string' or jsonb_typeof(p_cursor->'id')<>'string') then raise exception 'invalid_cursor' using errcode='22023';end if;
 if p_cursor is not null and not exists(select 1 from public.project_screening_records where project_id=p_project_id and owner_id=v_owner and id=(p_cursor->>'id')::uuid and recorded_at=(p_cursor->>'recordedAt')::timestamptz) then raise exception 'invalid_cursor' using errcode='22023';end if;
 with page as (select r as item,row_number() over(order by recorded_at desc,id desc) ordinal from public.project_screening_records r
  where project_id=p_project_id and owner_id=v_owner and (p_cursor is null or (recorded_at,id)<((p_cursor->>'recordedAt')::timestamptz,(p_cursor->>'id')::uuid)) order by recorded_at desc,id desc limit 21)
 select coalesce(jsonb_agg(fluid_private.project_screening_record_dto(item) order by (item).recorded_at desc,(item).id desc) filter(where ordinal<=20),'[]'::jsonb),count(*)>20 into v_records,v_more from page;
 v_last:=v_records->-1;
 return jsonb_build_object('ownerId',v_owner,'projectId',p_project_id,'projectRevision',v_project.current_revision,
  'currentBasis',fluid_private.project_screening_basis(p_project_id,v_owner),'records',v_records,
  'nextCursor',case when v_more then jsonb_build_object('recordedAt',v_last->'recordedAt','id',v_last->'id') else null end);
end $$;

create function public.record_project_screening(p_project_id uuid,p_input jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_owner uuid:=auth.uid();v_basis jsonb;v_record public.project_screening_records;v_criteria jsonb;v_value jsonb;v_item text;v_observed timestamptz;
begin
 if v_owner is null then raise exception 'unauthenticated' using errcode='42501';end if;
 if p_input is null or jsonb_typeof(p_input)<>'object' or octet_length(p_input::text)>32768
  or not(p_input ?& array['requestId','selectionId','expectedProjectRevision','criteria','notes','sourceUrls','observedAt','acknowledged'])
  or p_input-array['requestId','selectionId','expectedProjectRevision','criteria','notes','sourceUrls','observedAt','acknowledged']<>'{}'::jsonb
  or p_input->'acknowledged' is distinct from 'true'::jsonb or jsonb_typeof(p_input->'requestId')<>'string' or jsonb_typeof(p_input->'selectionId')<>'string'
  or jsonb_typeof(p_input->'expectedProjectRevision')<>'number' or (p_input->>'expectedProjectRevision')!~'^[1-9][0-9]*$'
  or jsonb_typeof(p_input->'notes')<>'string' or length(btrim(p_input->>'notes')) not between 1 and 3000
  or jsonb_typeof(p_input->'observedAt')<>'string' or jsonb_typeof(p_input->'sourceUrls')<>'array' then raise exception 'invalid_record' using errcode='22023';end if;
 if jsonb_array_length(p_input->'sourceUrls')>5 then raise exception 'invalid_sources' using errcode='22023';end if;
 for v_value in select value from jsonb_array_elements(p_input->'sourceUrls') loop
  v_item:=v_value#>>'{}';
  if jsonb_typeof(v_value)<>'string' or length(v_item)>2048 or v_item!~'^https://[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:[0-9]{1,5})?([/?#].*)?$' or v_item~'[[:cntrl:][:space:]]'
   or coalesce(substring(v_item from '^https://[^/:?#]+:([0-9]+)')::integer,0)>65535 then raise exception 'invalid_source' using errcode='22023';end if;
 end loop;
 if (select count(*)<>count(distinct value) from jsonb_array_elements(p_input->'sourceUrls')) then raise exception 'duplicate_sources' using errcode='22023';end if;
 v_observed:=(p_input->>'observedAt')::timestamptz;
 if not isfinite(v_observed) or v_observed>clock_timestamp() then raise exception 'invalid_observation_time' using errcode='22023';end if;
 v_criteria:=p_input->'criteria';
 if jsonb_typeof(v_criteria)<>'object' then raise exception 'invalid_criteria' using errcode='22023';end if;
 if v_criteria->>'tool'='domains' then
  if not(v_criteria ?& array['tool','domain']) or v_criteria-array['tool','domain']<>'{}'::jsonb or jsonb_typeof(v_criteria->'domain')<>'string'
   or length(v_criteria->>'domain')>253 or v_criteria->>'domain'!~'^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$' or v_criteria->>'domain'~'(^|\.)xn--' then raise exception 'invalid_domain' using errcode='22023';end if;
 elsif v_criteria->>'tool'='handles' then
  if not(v_criteria ?& array['tool','platform','handle']) or v_criteria-array['tool','platform','handle']<>'{}'::jsonb
   or v_criteria->>'platform' not in ('instagram','tiktok','youtube','x','linkedin') or jsonb_typeof(v_criteria->'platform')<>'string'
   or jsonb_typeof(v_criteria->'handle')<>'string' or v_criteria->>'handle'!~'^[a-zA-Z0-9_.-]{1,64}$' then raise exception 'invalid_handle' using errcode='22023';end if;
 elsif v_criteria->>'tool'='trademarks' then
  if not(v_criteria ?& array['tool','mark','jurisdictions','niceClasses','mode']) or v_criteria-array['tool','mark','jurisdictions','niceClasses','mode']<>'{}'::jsonb
   or v_criteria->'mode' is distinct from '"exact_word"'::jsonb or jsonb_typeof(v_criteria->'mark')<>'string' or length(v_criteria->>'mark') not between 1 and 160
   or jsonb_typeof(v_criteria->'jurisdictions')<>'array' or jsonb_typeof(v_criteria->'niceClasses')<>'array' then raise exception 'invalid_trademark' using errcode='22023';end if;
  if jsonb_array_length(v_criteria->'jurisdictions') not between 1 and 20 or jsonb_array_length(v_criteria->'niceClasses')>45 then raise exception 'invalid_trademark_scope' using errcode='22023';end if;
  for v_value in select value from jsonb_array_elements(v_criteria->'jurisdictions') loop
   if jsonb_typeof(v_value)<>'string' or v_value#>>'{}'!~'^[A-Z0-9-]{2,32}$' then raise exception 'invalid_jurisdiction' using errcode='22023';end if;
  end loop;
  for v_value in select value from jsonb_array_elements(v_criteria->'niceClasses') loop
   if jsonb_typeof(v_value)<>'number' or v_value::text!~'^[0-9]+$' or (v_value::text)::integer not between 1 and 45 then raise exception 'invalid_class' using errcode='22023';end if;
  end loop;
  if (select count(*)<>count(distinct value) from jsonb_array_elements(v_criteria->'jurisdictions')) or (select count(*)<>count(distinct value) from jsonb_array_elements(v_criteria->'niceClasses')) then raise exception 'duplicate_criteria' using errcode='22023';end if;
 else raise exception 'unsupported_tool' using errcode='22023';end if;
 -- Lock order matches Naming: project before session. Context/selection changes
 -- cannot interleave with binding this explicit review to its saved basis.
 perform 1 from public.projects where id=p_project_id and owner_id=v_owner for update;
 if not found then raise exception 'not_found' using errcode='P0002';end if;
 select * into v_record from public.project_screening_records where owner_id=v_owner and request_id=(p_input->>'requestId')::uuid;
 if found then
  if v_record.project_id<>p_project_id or v_record.request_payload<>p_input then raise exception 'intent_conflict' using errcode='PT409';end if;
  return fluid_private.project_screening_record_dto(v_record);
 end if;
 v_basis:=fluid_private.project_screening_basis(p_project_id,v_owner);
 if v_basis is null or (v_basis->>'selectionId')::uuid<>(p_input->>'selectionId')::uuid or (v_basis->>'projectRevision')::integer<>(p_input->>'expectedProjectRevision')::integer then raise exception 'context_conflict' using errcode='PT409';end if;
 if v_criteria->>'tool'='trademarks' and v_criteria->>'mark'<>v_basis->>'name' then raise exception 'name_mismatch' using errcode='22023';end if;
 if (select count(*) from public.project_screening_records where project_id=p_project_id and owner_id=v_owner)>=1000 then raise exception 'history_capacity' using errcode='PT409';end if;
 insert into public.project_screening_records(request_id,owner_id,project_id,selection_id,candidate_id,project_revision,context_hash,selected_name,criteria,notes,source_urls,observed_at,request_payload)
 values((p_input->>'requestId')::uuid,v_owner,p_project_id,(v_basis->>'selectionId')::uuid,(v_basis->>'candidateId')::uuid,(v_basis->>'projectRevision')::integer,v_basis->>'contextHash',v_basis->>'name',v_criteria,btrim(p_input->>'notes'),p_input->'sourceUrls',v_observed,p_input) returning * into v_record;
 return fluid_private.project_screening_record_dto(v_record);
end $$;
revoke all on function fluid_private.project_screening_basis(uuid,uuid),fluid_private.project_screening_record_dto(public.project_screening_records) from public,anon,authenticated,service_role;
revoke all on function public.get_project_screening(uuid,jsonb),public.record_project_screening(uuid,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.get_project_screening(uuid,jsonb),public.record_project_screening(uuid,jsonb) to authenticated;
