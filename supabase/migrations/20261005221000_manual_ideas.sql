-- Manual, user-authored account Ideas. This migration changes only new Ideas objects.
begin;

create table public.ideas (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id),
  create_request_key uuid not null,
  current_revision integer not null default 1 check(current_revision > 0),
  title text not null,
  description text not null,
  theme text not null,
  state text not null check(state in ('to_explore','developing','used')),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique(id,owner_id), unique(owner_id,create_request_key)
);
create index ideas_owner_created on public.ideas(owner_id,created_at desc,id desc);
create index ideas_owner_state_created on public.ideas(owner_id,state,created_at desc,id desc);

create table public.idea_revisions (
  idea_id uuid not null,
  owner_id uuid not null,
  revision integer not null check(revision > 0),
  content jsonb not null check(jsonb_typeof(content)='object' and octet_length(content::text)<=32768),
  operation text not null check(operation in ('create','update','brand')),
  request_key uuid not null,
  expected_revision integer not null check(expected_revision>=0),
  created_at timestamptz not null default clock_timestamp(),
  primary key(idea_id,revision), unique(idea_id,owner_id,revision), unique(owner_id,operation,request_key),
  foreign key(idea_id,owner_id) references public.ideas(id,owner_id),
  check((operation='create' and revision=1 and expected_revision=0) or (operation<>'create' and revision=expected_revision+1))
);
alter table public.ideas add constraint ideas_current_revision_fk
  foreign key(id,owner_id,current_revision) references public.idea_revisions(idea_id,owner_id,revision)
  deferrable initially deferred;
create index idea_revisions_owner on public.idea_revisions(owner_id,idea_id);

create table public.idea_brand_links (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  idea_id uuid not null,
  idea_revision integer not null,
  project_id uuid not null,
  request_key uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  unique(owner_id,request_key), unique(project_id), unique(idea_id,owner_id,idea_revision),
  foreign key(idea_id,owner_id,idea_revision) references public.idea_revisions(idea_id,owner_id,revision),
  foreign key(project_id,owner_id) references public.projects(id,owner_id)
);
create index idea_brand_links_owner_idea on public.idea_brand_links(owner_id,idea_id);

create trigger idea_revisions_immutable before update or delete on public.idea_revisions
  for each row execute function fluid_private.prevent_history_change();
create trigger idea_brand_links_immutable before update or delete on public.idea_brand_links
  for each row execute function fluid_private.prevent_history_change();

-- Match JavaScript string bounds and trim semantics, including astral characters.
create function fluid_private.idea_text_units(p_value text) returns integer language sql immutable set search_path='' as $$
  select coalesce(sum(case when ascii(c)>65535 then 2 else 1 end),0)::integer from regexp_split_to_table(p_value,'') as c where c<>''
$$;
create function fluid_private.idea_trim(p_value text) returns text language sql immutable set search_path='' as $$
  select btrim(p_value, chr(9)||chr(10)||chr(11)||chr(12)||chr(13)||chr(32)||chr(160)||chr(5760)||
    chr(8192)||chr(8193)||chr(8194)||chr(8195)||chr(8196)||chr(8197)||chr(8198)||chr(8199)||chr(8200)||chr(8201)||chr(8202)||
    chr(8232)||chr(8233)||chr(8239)||chr(8287)||chr(12288)||chr(65279))
$$;
create function fluid_private.idea_content(p_content jsonb) returns jsonb language plpgsql immutable set search_path='' as $$
declare v_title text; v_details jsonb; v_key text; v_value text; v_state text; v_result jsonb;
begin
  if p_content is null or jsonb_typeof(p_content)<>'object' or octet_length(p_content::text)>32768 or
    exists(select 1 from jsonb_object_keys(p_content) k where k not in ('title','description','theme','state','details')) or
    jsonb_typeof(p_content->'title') is distinct from 'string' then raise exception 'invalid_idea_content' using errcode='22023'; end if;
  v_title := fluid_private.idea_trim(p_content->>'title');
  if fluid_private.idea_text_units(v_title) not between 1 and 160 then raise exception 'invalid_idea_title' using errcode='22023'; end if;
  foreach v_key in array array['description','theme'] loop
    if p_content ? v_key and jsonb_typeof(p_content->v_key)<>'string' then raise exception 'invalid_idea_content' using errcode='22023'; end if;
    if fluid_private.idea_text_units(coalesce(p_content->>v_key,'')) > (case when v_key='description' then 12000 else 120 end) then
      raise exception 'invalid_idea_content' using errcode='22023'; end if;
  end loop;
  v_state := coalesce(p_content->>'state','to_explore');
  if (p_content ? 'state' and jsonb_typeof(p_content->'state')<>'string') or v_state not in ('to_explore','developing','used') then
    raise exception 'invalid_idea_state' using errcode='22023'; end if;
  v_details := coalesce(p_content->'details','{}'::jsonb);
  if jsonb_typeof(v_details)<>'object' or exists(select 1 from jsonb_object_keys(v_details) k where k not in
    ('problem','audience','solution','differentiation','revenueHypotheses','validationSteps','notes')) then raise exception 'invalid_idea_details' using errcode='22023'; end if;
  v_result := '{}'::jsonb;
  foreach v_key in array array['problem','audience','solution','differentiation','revenueHypotheses','validationSteps','notes'] loop
    if v_details ? v_key and jsonb_typeof(v_details->v_key)<>'string' then raise exception 'invalid_idea_details' using errcode='22023'; end if;
    v_value := coalesce(v_details->>v_key,'');
    if fluid_private.idea_text_units(v_value)>2000 then raise exception 'invalid_idea_details' using errcode='22023'; end if;
    v_result := v_result || jsonb_build_object(v_key,v_value);
  end loop;
  return jsonb_build_object('title',v_title,'description',coalesce(p_content->>'description',''),'theme',coalesce(p_content->>'theme',''),
    'state',v_state,'details',v_result);
end $$;

create function fluid_private.idea_timestamp(p_value timestamptz) returns text language sql stable set search_path='' as $$
  select to_char(p_value at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
$$;
create function fluid_private.idea_link_json(p_link public.idea_brand_links) returns jsonb language sql stable set search_path='' as $$
  select jsonb_build_object('id',p_link.id,'ownerId',p_link.owner_id,'ideaId',p_link.idea_id,'ideaRevision',p_link.idea_revision,
    'projectId',p_link.project_id,'requestKey',p_link.request_key,'createdAt',fluid_private.idea_timestamp(p_link.created_at))
$$;
create function fluid_private.idea_record(p_id uuid,p_owner uuid) returns jsonb language sql stable set search_path='' as $$
  select jsonb_build_object('id',i.id,'ownerId',i.owner_id,'revision',i.current_revision,'content',r.content,
    'createdAt',fluid_private.idea_timestamp(i.created_at),'updatedAt',fluid_private.idea_timestamp(i.updated_at),
    'links',coalesce((select jsonb_agg(fluid_private.idea_link_json(l) order by l.created_at,l.id)
      from public.idea_brand_links l where l.idea_id=i.id and l.owner_id=p_owner),'[]'::jsonb))
  from public.ideas i join public.idea_revisions r on (r.idea_id,r.owner_id,r.revision)=(i.id,i.owner_id,i.current_revision)
  where i.id=p_id and i.owner_id=p_owner
$$;
-- Exact normalized context JSON order mirrors the shared createProjectInputSchema.
-- Besides equality, the digest is independently checked before any project write.
create function fluid_private.idea_project_context_text(p_content jsonb) returns text language sql immutable set search_path='' as $$
  select '{"description":'||to_json(coalesce(nullif(fluid_private.idea_trim(p_content->>'description'),''),p_content->>'title'))::text||
    ',"activity":"","offering":'||to_json(fluid_private.idea_trim(p_content#>>'{details,solution}'))::text||
    ',"knownAudience":'||to_json(fluid_private.idea_trim(p_content#>>'{details,audience}'))::text||
    ',"reformulationConfirmed":false,"audienceSegments":[],"competitors":[],"competitorReviewComplete":false,"personality":null,'||
    '"positioning":"","selectedName":null,"creativeLocale":"en","intake":{"suppliedName":"","namingNotes":"","identityNotes":"",'||
    '"step":"review","audienceReviewedAt":null,"personalityReviewedAt":null,"positioningReviewedAt":null,"example":false}}'
$$;

create function public.create_idea(p_request_key uuid,p_content jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_owner uuid := auth.uid(); v_content jsonb; v_idea public.ideas; v_initial jsonb;
begin
  if v_owner is null then raise exception 'unauthenticated' using errcode='42501'; end if;
  if p_request_key is null then raise exception 'invalid_request_key' using errcode='22023'; end if;
  v_content := fluid_private.idea_content(p_content);
  perform pg_advisory_xact_lock(hashtextextended(v_owner::text||':idea:create:'||p_request_key::text,0));
  select * into v_idea from public.ideas where owner_id=v_owner and create_request_key=p_request_key;
  if found then
    select content into v_initial from public.idea_revisions where idea_id=v_idea.id and owner_id=v_owner and revision=1;
    if v_initial is distinct from v_content then raise exception 'idempotency_conflict' using errcode='23505'; end if;
    return fluid_private.idea_record(v_idea.id,v_owner);
  end if;
  insert into public.ideas(owner_id,create_request_key,title,description,theme,state)
    values(v_owner,p_request_key,v_content->>'title',v_content->>'description',v_content->>'theme',v_content->>'state') returning * into v_idea;
  insert into public.idea_revisions(idea_id,owner_id,revision,content,operation,request_key,expected_revision)
    values(v_idea.id,v_owner,1,v_content,'create',p_request_key,0);
  return fluid_private.idea_record(v_idea.id,v_owner);
end $$;

create function public.update_idea(p_idea_id uuid,p_expected_revision integer,p_request_key uuid,p_content jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_owner uuid := auth.uid(); v_idea public.ideas; v_content jsonb; v_receipt public.idea_revisions;
begin
  if v_owner is null then raise exception 'unauthenticated' using errcode='42501'; end if;
  if p_request_key is null or p_expected_revision is null or p_expected_revision not between 1 and 2147483646 then
    raise exception 'invalid_revision' using errcode='22023'; end if;
  v_content := fluid_private.idea_content(p_content);
  select * into v_idea from public.ideas where id=p_idea_id and owner_id=v_owner for update;
  if not found then raise exception 'not_found' using errcode='P0002'; end if;
  select * into v_receipt from public.idea_revisions where owner_id=v_owner and operation='update' and request_key=p_request_key;
  if found then
    if (v_receipt.idea_id,v_receipt.expected_revision,v_receipt.content) is distinct from (p_idea_id,p_expected_revision,v_content) then
      raise exception 'idempotency_conflict' using errcode='23505'; end if;
    if v_idea.current_revision<>v_receipt.revision then raise exception 'revision_conflict' using errcode='40001'; end if;
    return fluid_private.idea_record(p_idea_id,v_owner);
  end if;
  if v_idea.current_revision<>p_expected_revision then raise exception 'revision_conflict' using errcode='40001'; end if;
  insert into public.idea_revisions(idea_id,owner_id,revision,content,operation,request_key,expected_revision)
    values(p_idea_id,v_owner,p_expected_revision+1,v_content,'update',p_request_key,p_expected_revision);
  update public.ideas set current_revision=p_expected_revision+1,title=v_content->>'title',description=v_content->>'description',
    theme=v_content->>'theme',state=v_content->>'state',updated_at=clock_timestamp() where id=p_idea_id and owner_id=v_owner;
  return fluid_private.idea_record(p_idea_id,v_owner);
end $$;

create function public.get_idea(p_idea_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_owner uuid := auth.uid();
begin
  if v_owner is null then raise exception 'unauthenticated' using errcode='42501'; end if;
  return fluid_private.idea_record(p_idea_id,v_owner);
end $$;

create function public.list_ideas(p_cursor_created_at timestamptz,p_cursor_id uuid,p_limit integer,p_search text,p_state text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_owner uuid := auth.uid(); v_search text; v_items jsonb; v_count integer; v_last jsonb;
begin
  if v_owner is null then raise exception 'unauthenticated' using errcode='42501'; end if;
  if (p_cursor_created_at is null)<>(p_cursor_id is null) or p_limit is null or p_limit not between 1 and 50 or p_search is null or
    fluid_private.idea_text_units(p_search)>200 or (p_state is not null and p_state not in ('to_explore','developing','used')) then
    raise exception 'invalid_idea_query' using errcode='22023'; end if;
  v_search := lower(fluid_private.idea_trim(p_search));
  with page as (
    select * from public.ideas i where i.owner_id=v_owner and (p_state is null or i.state=p_state) and
      (v_search='' or strpos(lower(i.title),v_search)>0 or strpos(lower(i.description),v_search)>0) and
      (p_cursor_created_at is null or (i.created_at,i.id)<(p_cursor_created_at,p_cursor_id))
    order by i.created_at desc,i.id desc limit p_limit+1
  ), numbered as (select *,row_number() over(order by created_at desc,id desc) as n from page)
  select count(*)::integer,coalesce(jsonb_agg(jsonb_build_object('id',id,'ownerId',owner_id,'revision',current_revision,
    'title',title,'description',description,'theme',theme,'state',state,'createdAt',fluid_private.idea_timestamp(created_at),
    'updatedAt',fluid_private.idea_timestamp(updated_at)) order by created_at desc,id desc) filter(where n<=p_limit),'[]'::jsonb)
    into v_count,v_items from numbered;
  v_last := v_items->(jsonb_array_length(v_items)-1);
  return jsonb_build_object('ownerId',v_owner,'items',v_items,'nextCursor',case when v_count>p_limit then
    jsonb_build_object('createdAt',v_last->>'createdAt','id',v_last->>'id') else null end);
end $$;

create function public.create_idea_brand(p_idea_id uuid,p_expected_revision integer,p_request_key uuid,p_context jsonb,p_input_hash text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_owner uuid := auth.uid(); v_idea public.ideas; v_link public.idea_brand_links; v_content jsonb; v_context_text text; v_project public.projects;
begin
  if v_owner is null then raise exception 'unauthenticated' using errcode='42501'; end if;
  if p_request_key is null or p_expected_revision is null or p_expected_revision not between 1 and 2147483646 then
    raise exception 'invalid_revision' using errcode='22023'; end if;
  select * into v_idea from public.ideas where id=p_idea_id and owner_id=v_owner for update;
  if not found then raise exception 'not_found' using errcode='P0002'; end if;
  select * into v_link from public.idea_brand_links where owner_id=v_owner and request_key=p_request_key;
  if found then
    select content into v_content from public.idea_revisions where idea_id=v_link.idea_id and owner_id=v_owner and revision=v_link.idea_revision;
    v_context_text := fluid_private.idea_project_context_text(v_content);
    if (v_link.idea_id,v_link.idea_revision) is distinct from (p_idea_id,p_expected_revision) or p_context is distinct from v_context_text::jsonb or
      p_input_hash is distinct from encode(sha256(convert_to(v_context_text,'UTF8')),'hex') then
      raise exception 'idempotency_conflict' using errcode='23505'; end if;
    return jsonb_build_object('idea',fluid_private.idea_record(p_idea_id,v_owner),'link',fluid_private.idea_link_json(v_link));
  end if;
  if v_idea.current_revision<>p_expected_revision then raise exception 'revision_conflict' using errcode='40001'; end if;
  if exists(select 1 from public.idea_brand_links where idea_id=p_idea_id and owner_id=v_owner and idea_revision=p_expected_revision) then
    raise exception 'source_already_converted' using errcode='23505'; end if;
  if (select count(*) from public.idea_brand_links where idea_id=p_idea_id and owner_id=v_owner)>=100 then
    raise exception 'idea_link_capacity' using errcode='40001'; end if;
  select content into v_content from public.idea_revisions where idea_id=p_idea_id and owner_id=v_owner and revision=p_expected_revision;
  v_context_text := fluid_private.idea_project_context_text(v_content);
  if p_context is distinct from v_context_text::jsonb or p_input_hash is distinct from encode(sha256(convert_to(v_context_text,'UTF8')),'hex') then
    raise exception 'invalid_idea_project_context' using errcode='22023'; end if;
  v_project := public.create_project('complete_brand',v_content->>'title',p_context,p_input_hash);
  insert into public.idea_brand_links(owner_id,idea_id,idea_revision,project_id,request_key)
    values(v_owner,p_idea_id,p_expected_revision,v_project.id,p_request_key) returning * into v_link;
  v_content := jsonb_set(v_content,'{state}','"used"'::jsonb);
  insert into public.idea_revisions(idea_id,owner_id,revision,content,operation,request_key,expected_revision)
    values(p_idea_id,v_owner,p_expected_revision+1,v_content,'brand',p_request_key,p_expected_revision);
  update public.ideas set current_revision=p_expected_revision+1,state='used',updated_at=clock_timestamp() where id=p_idea_id and owner_id=v_owner;
  return jsonb_build_object('idea',fluid_private.idea_record(p_idea_id,v_owner),'link',fluid_private.idea_link_json(v_link));
end $$;

create function public.get_project_idea_source(p_project_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_owner uuid := auth.uid(); v_source jsonb;
begin
  if v_owner is null then raise exception 'unauthenticated' using errcode='42501'; end if;
  perform 1 from public.projects where id=p_project_id and owner_id=v_owner;
  if not found then raise exception 'not_found' using errcode='P0002'; end if;
  select jsonb_build_object('link',fluid_private.idea_link_json(l),'content',r.content) into v_source from public.idea_brand_links l
    join public.idea_revisions r on (r.idea_id,r.owner_id,r.revision)=(l.idea_id,l.owner_id,l.idea_revision)
    where l.project_id=p_project_id and l.owner_id=v_owner;
  return jsonb_build_object('ownerId',v_owner,'projectId',p_project_id,'source',v_source);
end $$;

-- Only new objects are touched. No existing ACL, policy, role, or function changes.
do $$ declare v_table text; v_function text; begin
  foreach v_table in array array['ideas','idea_revisions','idea_brand_links'] loop
    execute format('alter table public.%I enable row level security',v_table);
    execute format('alter table public.%I force row level security',v_table);
    execute format('revoke all on public.%I from public,anon,authenticated,service_role',v_table);
    execute format('grant select on public.%I to authenticated',v_table);
    execute format('create policy owned_read on public.%I for select to authenticated using(owner_id=(select auth.uid()))',v_table);
    if exists(select 1 from pg_roles where rolname='fluid_local_worker') then execute format('revoke all on public.%I from fluid_local_worker',v_table); end if;
  end loop;
  foreach v_function in array array[
    'public.create_idea(uuid,jsonb)','public.update_idea(uuid,integer,uuid,jsonb)','public.get_idea(uuid)',
    'public.list_ideas(timestamptz,uuid,integer,text,text)','public.create_idea_brand(uuid,integer,uuid,jsonb,text)','public.get_project_idea_source(uuid)',
    'fluid_private.idea_text_units(text)','fluid_private.idea_trim(text)','fluid_private.idea_content(jsonb)',
    'fluid_private.idea_timestamp(timestamptz)','fluid_private.idea_link_json(public.idea_brand_links)',
    'fluid_private.idea_record(uuid,uuid)','fluid_private.idea_project_context_text(jsonb)'
  ] loop
    execute 'revoke all on function '||v_function||' from public,anon,authenticated,service_role';
    if left(v_function,7)='public.' then execute 'grant execute on function '||v_function||' to authenticated'; end if;
    if exists(select 1 from pg_roles where rolname='fluid_local_worker') then execute 'revoke all on function '||v_function||' from fluid_local_worker'; end if;
  end loop;
end $$;
commit;
