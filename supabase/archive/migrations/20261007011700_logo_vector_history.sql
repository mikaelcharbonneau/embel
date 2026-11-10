-- Local candidate only. Read-only discovery of immutable, owned vectors,
-- including committed conversions retained without a stage activation.
begin;

-- The trusted vector producers store canonical UTC millisecond timestamps.
-- Include the UUID tie-breaker so simultaneous creations cannot skip a page.
create index logo_vector_history_order on public.logo_vector_revisions(owner_id,project_id,(record->>'createdAt') desc,id desc);
create index logo_vector_history_selections on public.logo_stage_revisions(owner_id,project_id,(record#>>'{payload,vectorRevisionId}'),workspace_revision desc)
 where stage in('vector','refinements') and record#>>'{payload,vectorRevisionId}' is not null;
create index logo_vector_history_publications on fluid_private.logo_vector_publications(owner_id,project_id,(record->>'id')) where state='committed';

create function public.list_logo_vector_history(p_project_id uuid,p_query jsonb) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare
 owner uuid:=auth.uid();workspace jsonb;workspace_revision bigint;current_id uuid;
 n integer;cursor_value jsonb;cursor_id uuid;cursor_time text;
 row public.logo_vector_revisions;stage_ref jsonb;cancellation text;acceptance text;earlier boolean;
 items jsonb:='[]';next_cursor text;seen integer:=0;
begin
 if owner is null then raise exception 'unauthenticated' using errcode='42501';end if;
 if not exists(select 1 from public.projects where id=p_project_id and owner_id=owner) then raise exception 'logo_project_not_found' using errcode='P0002';end if;
 if jsonb_typeof(p_query) is distinct from 'object' or p_query-array['cursor','limit']<>'{}' or octet_length(p_query::text)>4096 then raise exception 'invalid_logo_history_query' using errcode='22023';end if;
 if p_query ? 'limit' and (jsonb_typeof(p_query->'limit') is distinct from 'number' or (p_query->>'limit')::numeric<>trunc((p_query->>'limit')::numeric) or (p_query->>'limit')::numeric not between 1 and 50) then raise exception 'invalid_logo_history_limit' using errcode='22023';end if;
 n:=coalesce((p_query->>'limit')::integer,20);
 workspace:=fluid_private.logo_workspace_json(owner,p_project_id);
 workspace_revision:=(workspace#>>'{heads,workspaceRevision}')::bigint;
 current_id:=fluid_private.logo_current_vector_id(owner,p_project_id);
 if p_query ? 'cursor' then
  if jsonb_typeof(p_query->'cursor') is distinct from 'string' or length(p_query->>'cursor') not between 4 and 2048
   or p_query->>'cursor'!~'^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$' then raise exception 'invalid_logo_history_cursor' using errcode='22023';end if;
  begin cursor_value:=convert_from(decode(p_query->>'cursor','base64'),'UTF8')::jsonb;
  exception when others then raise exception 'invalid_logo_history_cursor' using errcode='22023';end;
  if not coalesce(fluid_private.standalone_keys(cursor_value,array['ownerId','projectId','workspaceRevision','id','createdAt']),false)
   or cursor_value->>'ownerId' is distinct from owner::text or cursor_value->>'projectId' is distinct from p_project_id::text
   or not coalesce(fluid_private.logo_uuid(cursor_value->'id'),false)
   or not coalesce(fluid_private.standalone_timestamp(cursor_value->'createdAt'),false) or length(cursor_value->>'createdAt')>64
   or jsonb_typeof(cursor_value->'workspaceRevision') is distinct from 'number' then raise exception 'invalid_logo_history_cursor' using errcode='22023';end if;
  if (cursor_value->>'workspaceRevision')::numeric<>trunc((cursor_value->>'workspaceRevision')::numeric)
   or (cursor_value->>'workspaceRevision')::numeric not between 0 and 9007199254740991 then raise exception 'invalid_logo_history_cursor' using errcode='22023';end if;
  if (cursor_value->>'workspaceRevision')::bigint<>workspace_revision then raise exception 'logo_history_workspace_changed' using errcode='PT409';end if;
  cursor_id:=(cursor_value->>'id')::uuid;cursor_time:=cursor_value->>'createdAt';
  if not exists(select 1 from public.logo_vector_revisions r where r.id=cursor_id and r.owner_id=owner and r.project_id=p_project_id and r.record->>'createdAt'=cursor_time) then raise exception 'invalid_logo_history_cursor' using errcode='22023';end if;
 end if;
 for row in select * from public.logo_vector_revisions r where r.owner_id=owner and r.project_id=p_project_id
  and (cursor_id is null or (r.record->>'createdAt',r.id)<(cursor_time,cursor_id)) order by r.record->>'createdAt' desc,r.id desc limit n+1 loop
  seen:=seen+1;
  if seen>n then return jsonb_build_object('ownerId',owner,'projectId',p_project_id,'workspaceRevision',workspace_revision,'items',items,'nextCursor',next_cursor);end if;
  -- This is a separately read restore pointer, never an inferred activation.
  select jsonb_build_object('stage',r.stage,'id',r.id,'revision',r.revision) into stage_ref from public.logo_stage_revisions r
   where r.owner_id=owner and r.project_id=p_project_id and r.stage in('vector','refinements') and r.record#>>'{payload,vectorRevisionId}'=row.id::text
   order by r.workspace_revision desc limit 1;
  acceptance:=case when workspace#>>'{approvedLogo,vectorRevisionId}'=row.id::text then 'approved'
   when exists(select 1 from public.logo_approvals a where a.owner_id=owner and a.project_id=p_project_id and a.vector_revision_id=row.id) then 'previously_accepted' else 'unaccepted' end;
  select exists(select 1 from jsonb_array_elements(row.record->'inputRevisions') input
   left join public.logo_stage_heads h on h.owner_id=owner and h.project_id=p_project_id and h.stage=input->>'stage'
   where h.revision_id::text is distinct from input->>'id') into earlier;
  select case when j.state='cancelled' then 'cancelled' when j.cancel_requested_at is not null or j.state='cancel_requested' then 'requested' else 'none' end into cancellation
   from fluid_private.logo_vector_publications g join public.jobs j on j.id=g.job_id and j.owner_id=g.owner_id and j.project_id=g.project_id
   where g.owner_id=owner and g.project_id=p_project_id and g.record->>'id'=row.id::text and g.state='committed' and g.record=row.record;
  items:=items||jsonb_build_array(jsonb_build_object('vectorRevisionId',row.id,'parentRevisionId',row.record->'parentRevisionId','createdAt',row.record->'createdAt',
   'source',row.record->'source','lockCount',jsonb_array_length(row.record->'locks'),'selection',case when current_id=row.id then 'current' else 'retained' end,
   'acceptance',acceptance,'earlierInputs',earlier,'cancellation',coalesce(cancellation,'none'),'stageRevision',stage_ref));
  next_cursor:=replace(encode(convert_to(jsonb_build_object('ownerId',owner,'projectId',p_project_id,'workspaceRevision',workspace_revision,'id',row.id,'createdAt',row.record->'createdAt')::text,'UTF8'),'base64'),E'\n','');
 end loop;
 return jsonb_build_object('ownerId',owner,'projectId',p_project_id,'workspaceRevision',workspace_revision,'items',items,'nextCursor',null);
end $$;

-- Clean only this new signature, including arbitrary inherited default grants.
-- No existing function, role, principal binding or default ACL is changed.
do $$declare grant_row record;begin
 for grant_row in select distinct a.grantee from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
  where p.oid='public.list_logo_vector_history(uuid,jsonb)'::regprocedure and a.grantee<>p.proowner loop
  execute format('revoke all on function public.list_logo_vector_history(uuid,jsonb) from %s cascade',case when grant_row.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(grant_row.grantee)) end);
 end loop;
end $$;
grant execute on function public.list_logo_vector_history(uuid,jsonb) to authenticated;
commit;
