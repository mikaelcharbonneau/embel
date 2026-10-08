-- Owned, immutable reference metadata and independent reactions. No source import,
-- URL fetching, media constructor, generation route or worker capability.
begin;

create function fluid_private.reference_trim(p_value text) returns text
language sql immutable set search_path='' as $$
 select btrim(p_value,U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF');
$$;

create function fluid_private.reference_elements(p_value jsonb) returns text[]
language plpgsql immutable set search_path='' as $$
declare v_result text[]; v_order constant text[]:=array['logo','typography','colors','graphics','images','composition'];
begin
 if jsonb_typeof(p_value) is distinct from 'array' then raise exception 'invalid_reference_elements' using errcode='22023';end if;
 if jsonb_array_length(p_value)>6 or exists(select 1 from jsonb_array_elements(p_value) x where jsonb_typeof(x)<>'string' or not((x#>>'{}')=any(v_order))) then raise exception 'invalid_reference_elements' using errcode='22023';end if;
 select coalesce(array_agg(x order by array_position(v_order,x)),array[]::text[]) into v_result from jsonb_array_elements_text(p_value) x;
 if cardinality(v_result)<>(select count(distinct x) from unnest(v_result) x) then raise exception 'duplicate_reference_elements' using errcode='22023';end if;
 return v_result;
end $$;
create function fluid_private.reference_tags(p_value jsonb) returns text[]
language plpgsql immutable set search_path='' as $$
declare v_result text[];
begin
 if jsonb_typeof(p_value) is distinct from 'array' then raise exception 'invalid_reference_tags' using errcode='22023';end if;
 if jsonb_array_length(p_value)>50 or exists(select 1 from jsonb_array_elements(p_value) x where jsonb_typeof(x)<>'string') then raise exception 'invalid_reference_tags' using errcode='22023';end if;
 select coalesce(array_agg(t order by t collate "C"),array[]::text[]) into v_result from
  (select fluid_private.reference_trim(x) t from jsonb_array_elements_text(p_value) x) s;
 if exists(select 1 from unnest(v_result) t where length(t) not between 1 and 80) or cardinality(v_result)<>(select count(distinct t) from unnest(v_result) t) then raise exception 'invalid_reference_tags' using errcode='22023';end if;
 return v_result;
end $$;
-- Deliberately bounded URL grammar shared with the domain contract. This is not
-- a WHATWG/IDNA parser: international hosts (including ACE/punycode), IPv6 and
-- noncanonical numeric hosts are unsupported. International path/query text can
-- be percent encoded. Unsupported values fail validation; no URL is fetched.
create function fluid_private.reference_attribution_url(p_value text) returns boolean
language plpgsql immutable set search_path='' as $$
declare v_parts text[];v_authority text[];v_host text;v_labels text[];v_label text;
begin
 if p_value is null or length(p_value)>2048 or p_value collate "C" !~ '^[!-~]+$' or position(chr(92) in p_value)>0
  or position('%' in regexp_replace(p_value,'%[0-9A-Fa-f]{2}','','g'))>0 then return false;end if;
 v_parts:=regexp_match(p_value,'^(https?)://([^/?#]+)([/?#].*)?$','i');
 if v_parts is null then return false;end if;
 v_authority:=regexp_match(v_parts[2],'^([^:]+)(:([1-9][0-9]{0,4}))?$');
 if v_authority is null or (v_authority[3] is not null and v_authority[3]::integer>65535) then return false;end if;
 v_host:=v_authority[1];v_labels:=string_to_array(v_host,'.');
 if length(v_host)>253 then return false;end if;
 if v_host ~ '^[0-9.]+$' then
  if cardinality(v_labels)<>4 then return false;end if;
  foreach v_label in array v_labels loop
   if v_label !~ '^(0|[1-9][0-9]{0,2})$' then return false;end if;
   if v_label::integer>255 then return false;end if;
  end loop;
 else
  if v_labels[cardinality(v_labels)] collate "C" !~ '^[A-Za-z]' then return false;end if;
  foreach v_label in array v_labels loop
   if length(v_label)>63 or left(translate(v_label,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),4)='xn--' or v_label collate "C" !~ '^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?$' then return false;end if;
  end loop;
 end if;
 return true;
end $$;
create function fluid_private.reference_attribution(p_value jsonb) returns boolean
language plpgsql immutable set search_path='' as $$
declare v_key text;
begin
 if jsonb_typeof(p_value) is distinct from 'object' then return false;end if;
 if p_value-array['label','creator','sourceUrl','rightsNote']<>'{}' or not(p_value ?& array['label','creator','sourceUrl','rightsNote']) then return false;end if;
 if jsonb_typeof(p_value->'label')<>'string' or length(p_value->>'label') not between 1 and 240 then return false;end if;
 foreach v_key in array array['creator','rightsNote','sourceUrl'] loop
  if jsonb_typeof(p_value->v_key) not in('string','null') then return false;end if;
  if jsonb_typeof(p_value->v_key)='string' and length(p_value->>v_key) not between 1 and (case v_key when 'creator' then 240 when 'rightsNote' then 2000 else 2048 end) then return false;end if;
 end loop;
 foreach v_key in array array['label','creator','sourceUrl','rightsNote'] loop
  if jsonb_typeof(p_value->v_key)='string' and (p_value->>v_key)<>fluid_private.reference_trim(p_value->>v_key) then return false;end if;
 end loop;
 if jsonb_typeof(p_value->'sourceUrl')='string' and not fluid_private.reference_attribution_url(p_value->>'sourceUrl') then return false;end if;
 return true;
end $$;

create table public.identity_reference_heads (
 project_id uuid not null,owner_id uuid not null,
 reference_revision bigint not null default 0 check(reference_revision between 0 and 9007199254740991),
 selected_reference_count integer not null default 0 check(selected_reference_count between 0 and 100),
 primary key(project_id,owner_id),foreign key(project_id,owner_id) references public.projects(id,owner_id)
);
create table public.identity_references (
 id uuid primary key default gen_random_uuid(),project_id uuid not null,owner_id uuid not null,
 asset_id uuid not null,media_version_id uuid not null,
 source text not null check(source in('user_supplied','attributed_catalog')),
 attribution jsonb not null check(fluid_private.reference_attribution(attribution)),
 relevant_elements text[] not null check(relevant_elements=fluid_private.reference_elements(to_jsonb(relevant_elements))),
 tags text[] not null check(tags=fluid_private.reference_tags(to_jsonb(tags))),
 created_at timestamptz not null default clock_timestamp() check(isfinite(created_at)),
 unique(id,project_id,owner_id),
 foreign key(project_id,owner_id) references public.projects(id,owner_id),
 foreign key(asset_id,project_id,owner_id) references public.assets(id,project_id,owner_id),
 foreign key(media_version_id,asset_id,project_id,owner_id) references public.asset_versions(id,asset_id,project_id,owner_id)
);
create index identity_references_owned_page on public.identity_references(owner_id,project_id,created_at desc,id desc);
create table public.identity_reference_reactions (
 reference_id uuid primary key,project_id uuid not null,owner_id uuid not null,
 revision bigint not null check(revision between 1 and 9007199254740991),ensemble boolean not null,
 elements text[] not null check(elements=fluid_private.reference_elements(to_jsonb(elements))),
 updated_at timestamptz not null default clock_timestamp() check(isfinite(updated_at)),
 foreign key(reference_id,project_id,owner_id) references public.identity_references(id,project_id,owner_id)
);
create index identity_reference_reactions_owned on public.identity_reference_reactions(owner_id,project_id,reference_id);
create table public.identity_reference_snapshots (
 project_id uuid not null,owner_id uuid not null,reference_revision bigint not null check(reference_revision between 0 and 9007199254740991),
 snapshot jsonb not null check((jsonb_typeof(snapshot)='object' and snapshot->>'version'='1' and snapshot->>'ownerId'=owner_id::text and snapshot->>'projectId'=project_id::text and snapshot->>'referenceRevision'=reference_revision::text) is true),
 primary key(project_id,owner_id,reference_revision),foreign key(project_id,owner_id) references public.projects(id,owner_id)
);
create trigger identity_references_immutable before update or delete on public.identity_references for each row execute function fluid_private.prevent_history_change();
create trigger identity_reference_snapshots_immutable before update or delete on public.identity_reference_snapshots for each row execute function fluid_private.prevent_history_change();

create function fluid_private.validate_identity_reference_media() returns trigger
language plpgsql security definer set search_path='' as $$
declare v_field text;
begin
 -- Normalize whitespace only on actual string fields; preserve nulls, unknown
 -- keys and invalid types so the strict constraint can reject them unchanged.
 foreach v_field in array array['label','creator','sourceUrl','rightsNote'] loop
  if jsonb_typeof(new.attribution->v_field)='string' then
   new.attribution:=jsonb_set(new.attribution,array[v_field],to_jsonb(fluid_private.reference_trim(new.attribution->>v_field)),false);
  end if;
 end loop;
 -- Future trusted constructors must take this same project lock before selection/capture.
 perform 1 from public.projects p where p.id=new.project_id and p.owner_id=new.owner_id for update;
 if not exists(select 1 from public.assets a join public.asset_versions v on v.asset_id=a.id and v.project_id=a.project_id and v.owner_id=a.owner_id
  where a.id=new.asset_id and a.project_id=new.project_id and a.owner_id=new.owner_id and a.purpose='reference_media'
   and v.id=new.media_version_id and v.mime_type in('image/png','image/jpeg','image/webp')
   and v.storage_path=new.owner_id::text||'/'||new.project_id::text||'/'||new.asset_id::text||'/'||new.media_version_id::text)
 then raise exception 'invalid_reference_media' using errcode='23514';end if;
 -- Purpose is insertion-time immutable in the Assets migration, and versions are immutable.
 -- This binding does not establish that Storage bytes exist or match their metadata hash.
 return new;
end $$;
create trigger identity_reference_media_insert before insert on public.identity_references for each row execute function fluid_private.validate_identity_reference_media();
create function fluid_private.validate_identity_reference_reaction() returns trigger
language plpgsql security definer set search_path='' as $$
declare v_relevant text[];
begin
 select r.relevant_elements into v_relevant from public.identity_references r where r.id=new.reference_id and r.project_id=new.project_id and r.owner_id=new.owner_id;
 if found and not(new.elements<@v_relevant) then raise exception 'irrelevant_reference_element' using errcode='22023';end if;
 return new;
end $$;
create trigger identity_reference_reaction_validate before insert or update on public.identity_reference_reactions for each row execute function fluid_private.validate_identity_reference_reaction();
do $$declare t text;begin
 foreach t in array array['identity_reference_heads','identity_references','identity_reference_reactions','identity_reference_snapshots'] loop
  execute format('alter table public.%I enable row level security',t);execute format('alter table public.%I force row level security',t);
  execute format('revoke all on public.%I from public,anon,authenticated,service_role',t);
  execute format('grant select on public.%I to authenticated',t);
  execute format('create policy owned_read on public.%I for select to authenticated using(owner_id=(select auth.uid()))',t);
 end loop;
end $$;

-- Internal DTO projection. Caller must supply the authoritative owner/project tuple.
create function fluid_private.identity_reference_entry(p_reference_id uuid,p_project_id uuid,p_owner_id uuid) returns jsonb
language sql stable set search_path='' as $$
 select jsonb_build_object('reference',jsonb_build_object('id',r.id,'ownerId',r.owner_id,'projectId',r.project_id,'createdAt',r.created_at,
  'media',jsonb_build_object('assetId',r.asset_id,'versionId',v.id,'ownerId',v.owner_id,'projectId',v.project_id,'contentHash',v.content_hash,'purpose','reference_media','mimeType',v.mime_type),
  'source',r.source,'attribution',r.attribution,'relevantElements',r.relevant_elements,'tags',r.tags),
  'reaction',jsonb_build_object('referenceId',r.id,'ownerId',r.owner_id,'projectId',r.project_id,'revision',coalesce(c.revision,0),'ensemble',coalesce(c.ensemble,false),'elements',coalesce(c.elements,array[]::text[]),'updatedAt',c.updated_at))
 from public.identity_references r join public.asset_versions v on v.id=r.media_version_id and v.asset_id=r.asset_id and v.project_id=r.project_id and v.owner_id=r.owner_id
 left join public.identity_reference_reactions c on c.reference_id=r.id and c.project_id=r.project_id and c.owner_id=r.owner_id
 where r.id=p_reference_id and r.project_id=p_project_id and r.owner_id=p_owner_id;
$$;

create function fluid_private.identity_reference_query(p_query jsonb,p_project_id uuid) returns jsonb
language plpgsql stable set search_path='' as $$
declare v_excluded text[];v_cursor jsonb;v_limit numeric;v_date timestamptz;
begin
 if jsonb_typeof(p_query) is distinct from 'object' then raise exception 'invalid_reference_query' using errcode='22023';end if;
 if p_query-array['limit','cursor','excludedTags']<>'{}' then raise exception 'invalid_reference_query' using errcode='22023';end if;
 v_excluded:=fluid_private.reference_tags(coalesce(p_query->'excludedTags','[]'::jsonb));v_limit:=40;
 if p_query ? 'limit' then
  if jsonb_typeof(p_query->'limit')<>'number' then raise exception 'invalid_reference_limit' using errcode='22023';end if;
  v_limit:=(p_query->>'limit')::numeric;
  if v_limit not between 1 and 100 or v_limit<>trunc(v_limit) then raise exception 'invalid_reference_limit' using errcode='22023';end if;
 end if;
 if p_query ? 'cursor' then
  v_cursor:=p_query->'cursor';
  if jsonb_typeof(v_cursor) is distinct from 'object' then raise exception 'invalid_reference_cursor' using errcode='22023';end if;
  if v_cursor-array['projectId','referenceId','createdAt','excludedTags']<>'{}' or not(v_cursor ?& array['projectId','referenceId','createdAt','excludedTags'])
   or jsonb_typeof(v_cursor->'projectId')<>'string' or jsonb_typeof(v_cursor->'referenceId')<>'string' or jsonb_typeof(v_cursor->'createdAt')<>'string' then raise exception 'invalid_reference_cursor' using errcode='22023';end if;
  if (v_cursor->>'projectId')::uuid<>p_project_id or fluid_private.reference_tags(v_cursor->'excludedTags')<>v_excluded then raise exception 'invalid_reference_cursor' using errcode='22023';end if;
  perform(v_cursor->>'referenceId')::uuid;
  if v_cursor->>'createdAt'!~'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$' then raise exception 'invalid_reference_cursor' using errcode='22023';end if;
  v_date:=(v_cursor->>'createdAt')::timestamptz;
  if not isfinite(v_date) then raise exception 'invalid_reference_cursor' using errcode='22023';end if;
  v_cursor:=v_cursor||jsonb_build_object('excludedTags',v_excluded,'projectId',(v_cursor->>'projectId')::uuid,'referenceId',(v_cursor->>'referenceId')::uuid);
 end if;
 return jsonb_build_object('limit',v_limit::integer,'excludedTags',v_excluded)||(case when v_cursor is null then '{}'::jsonb else jsonb_build_object('cursor',v_cursor) end);
exception when invalid_text_representation or invalid_datetime_format or datetime_field_overflow then raise exception 'invalid_reference_cursor' using errcode='22023';
end $$;

-- STABLE keeps authorization, tags, aggregate and page on the calling statement's
-- snapshot. GET never initializes rows or ingests a source response.
create function public.get_identity_references(p_project_id uuid,p_query jsonb) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare v_owner uuid:=auth.uid();v_query jsonb;v_excluded text[];v_limit integer;v_cursor jsonb;v_anchor public.identity_references;v_result jsonb;
begin
 if v_owner is null or not exists(select 1 from public.projects p where p.id=p_project_id and p.owner_id=v_owner) then raise exception 'reference_project_not_found' using errcode='P0002';end if;
 v_query:=fluid_private.identity_reference_query(p_query,p_project_id);v_excluded:=fluid_private.reference_tags(v_query->'excludedTags');v_limit:=(v_query->>'limit')::integer;v_cursor:=v_query->'cursor';
 if exists(select 1 from unnest(v_excluded) t where not exists(select 1 from public.identity_references r where r.project_id=p_project_id and r.owner_id=v_owner and t=any(r.tags))) then raise exception 'unknown_reference_tag' using errcode='22023';end if;
 if v_cursor is not null then
  select * into v_anchor from public.identity_references r where r.id=(v_cursor->>'referenceId')::uuid and r.project_id=p_project_id and r.owner_id=v_owner;
  if not found then raise exception 'reference_cursor_not_found' using errcode='P0002';end if;
  if v_anchor.created_at<>(v_cursor->>'createdAt')::timestamptz or v_anchor.tags && v_excluded then raise exception 'invalid_reference_cursor' using errcode='22023';end if;
 end if;
 with candidates as materialized (
  select r.* from public.identity_references r where r.project_id=p_project_id and r.owner_id=v_owner and not(r.tags && v_excluded)
   and(v_cursor is null or(r.created_at,r.id)<(v_anchor.created_at,v_anchor.id)) order by r.created_at desc,r.id desc limit v_limit+1
 ), page as materialized(select * from candidates order by created_at desc,id desc limit v_limit),
 suggestions as (select distinct t collate "C" as tag from public.identity_references r cross join lateral unnest(r.tags) t where r.project_id=p_project_id and r.owner_id=v_owner order by tag limit 50),
 metadata as materialized(select tag from suggestions union select unnest(tags) from page union select unnest(v_excluded)),
 last_row as(select * from page order by created_at,id limit 1)
 select jsonb_build_object('ownerId',v_owner,'projectId',p_project_id,'query',v_query,
  'referenceRevision',coalesce((select h.reference_revision from public.identity_reference_heads h where h.project_id=p_project_id and h.owner_id=v_owner),0),
  'selectedReferenceCount',coalesce((select h.selected_reference_count from public.identity_reference_heads h where h.project_id=p_project_id and h.owner_id=v_owner),0),
  'feed',jsonb_build_object('status','unavailable','reason','reference_source_unconfigured'),
  'availableTags',coalesce((select jsonb_agg(tag order by tag collate "C") from metadata),'[]'::jsonb),
  'tagsComplete',not exists(select 1 from public.identity_references r cross join lateral unnest(r.tags) t where r.project_id=p_project_id and r.owner_id=v_owner and not exists(select 1 from metadata m where m.tag=t)),
  'references',jsonb_build_object('items',coalesce((select jsonb_agg(fluid_private.identity_reference_entry(p.id,p_project_id,v_owner) order by p.created_at desc,p.id desc) from page p),'[]'::jsonb),
   'nextCursor',case when(select count(*) from candidates)>v_limit then(select jsonb_build_object('projectId',p_project_id,'referenceId',r.id,'createdAt',r.created_at,'excludedTags',v_excluded) from last_row r) else null end)) into v_result;
 return v_result;
end $$;

create function public.set_identity_reference_reaction(p_project_id uuid,p_reference_id uuid,p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_owner uuid:=auth.uid();v_expected numeric;v_elements text[];v_ensemble boolean;v_reference public.identity_references;
 v_head public.identity_reference_heads;v_current public.identity_reference_reactions;v_revision bigint;v_delta integer;v_count integer;
begin
 perform 1 from public.projects p where p.id=p_project_id and p.owner_id=v_owner for update;
 if not found then raise exception 'reference_project_not_found' using errcode='P0002';end if;
 select * into v_reference from public.identity_references r where r.id=p_reference_id and r.project_id=p_project_id and r.owner_id=v_owner;
 if not found then raise exception 'reference_not_found' using errcode='P0002';end if;
 if jsonb_typeof(p_input) is distinct from 'object' then raise exception 'invalid_reference_reaction' using errcode='22023';end if;
 if p_input-array['expectedRevision','ensemble','elements']<>'{}' or not(p_input ?& array['expectedRevision','ensemble','elements'])
  or jsonb_typeof(p_input->'expectedRevision')<>'number' or jsonb_typeof(p_input->'ensemble')<>'boolean' then raise exception 'invalid_reference_reaction' using errcode='22023';end if;
 v_expected:=(p_input->>'expectedRevision')::numeric;
 if v_expected not between 0 and 9007199254740991 or v_expected<>trunc(v_expected) then raise exception 'invalid_reference_revision' using errcode='22023';end if;
 v_elements:=fluid_private.reference_elements(p_input->'elements');v_ensemble:=(p_input->>'ensemble')::boolean;
 if not(v_elements<@v_reference.relevant_elements) then raise exception 'irrelevant_reference_element' using errcode='22023';end if;
 insert into public.identity_reference_heads(project_id,owner_id) values(p_project_id,v_owner) on conflict do nothing;
 select * into v_head from public.identity_reference_heads h where h.project_id=p_project_id and h.owner_id=v_owner for update;
 select * into v_current from public.identity_reference_reactions r where r.reference_id=p_reference_id and r.project_id=p_project_id and r.owner_id=v_owner for update;
 v_revision:=coalesce(v_current.revision,0);
 if v_revision<>v_expected then raise exception 'reference_reaction_conflict' using errcode='PT409';end if;
 if v_revision=9007199254740991 or v_head.reference_revision=9007199254740991 then raise exception 'reference_revision_exhausted' using errcode='PT409';end if;
 v_delta:=(case when v_ensemble or cardinality(v_elements)>0 then 1 else 0 end)-(case when coalesce(v_current.ensemble,false) or coalesce(cardinality(v_current.elements),0)>0 then 1 else 0 end);
 v_count:=v_head.selected_reference_count+v_delta;
 if v_count>100 then raise exception 'reference_selection_capacity' using errcode='PT409';end if;
 if v_count<0 then raise exception 'invalid_reference_count' using errcode='55000';end if;
 insert into public.identity_reference_reactions(reference_id,project_id,owner_id,revision,ensemble,elements,updated_at)
  values(p_reference_id,p_project_id,v_owner,v_revision+1,v_ensemble,v_elements,clock_timestamp())
  on conflict(reference_id) do update set revision=excluded.revision,ensemble=excluded.ensemble,elements=excluded.elements,updated_at=excluded.updated_at;
 update public.identity_reference_heads set reference_revision=reference_revision+1,selected_reference_count=v_count where project_id=p_project_id and owner_id=v_owner returning * into v_head;
 return jsonb_build_object('ownerId',v_owner,'projectId',p_project_id,'referenceRevision',v_head.reference_revision,'selectedReferenceCount',v_head.selected_reference_count,
  'entry',fluid_private.identity_reference_entry(p_reference_id,p_project_id,v_owner));
end $$;

-- Private future admission seam. No HTTP wrapper, public EXECUTE or worker grant.
create function fluid_private.capture_identity_reference_snapshot(p_project_id uuid,p_expected_reference_revision bigint) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_owner uuid:=auth.uid();v_revision bigint;v_count integer;v_selected jsonb;v_result jsonb;
begin
 perform 1 from public.projects p where p.id=p_project_id and p.owner_id=v_owner for update;
 if not found then raise exception 'reference_project_not_found' using errcode='P0002';end if;
 select h.reference_revision,h.selected_reference_count into v_revision,v_count from public.identity_reference_heads h where h.project_id=p_project_id and h.owner_id=v_owner for update;
 v_revision:=coalesce(v_revision,0);v_count:=coalesce(v_count,0);
 if p_expected_reference_revision is null or p_expected_reference_revision<>v_revision then raise exception 'reference_snapshot_conflict' using errcode='PT409';end if;
 select coalesce(jsonb_agg(fluid_private.identity_reference_entry(r.reference_id,p_project_id,v_owner) order by r.reference_id),'[]'::jsonb) into v_selected
 from public.identity_reference_reactions r where r.project_id=p_project_id and r.owner_id=v_owner and(r.ensemble or cardinality(r.elements)>0);
 if jsonb_array_length(v_selected)<>v_count or v_count>100 or exists(select 1 from public.identity_reference_reactions r where r.project_id=p_project_id and r.owner_id=v_owner and r.revision>v_revision) then raise exception 'invalid_reference_snapshot_state' using errcode='55000';end if;
 select s.snapshot into v_result from public.identity_reference_snapshots s where s.project_id=p_project_id and s.owner_id=v_owner and s.reference_revision=v_revision;
 if found then return v_result;end if;
 v_result:=jsonb_build_object('version',1,'ownerId',v_owner,'projectId',p_project_id,'referenceRevision',v_revision,'selectedReferenceCount',v_count,'capturedAt',clock_timestamp(),'selected',v_selected);
 insert into public.identity_reference_snapshots(project_id,owner_id,reference_revision,snapshot) values(p_project_id,v_owner,v_revision,v_result);
 return v_result;
end $$;

revoke all on function fluid_private.reference_trim(text),fluid_private.reference_attribution_url(text),fluid_private.reference_elements(jsonb),fluid_private.reference_tags(jsonb),fluid_private.reference_attribution(jsonb),
 fluid_private.validate_identity_reference_media(),fluid_private.validate_identity_reference_reaction(),
 fluid_private.identity_reference_entry(uuid,uuid,uuid),fluid_private.identity_reference_query(jsonb,uuid),fluid_private.capture_identity_reference_snapshot(uuid,bigint)
 from public,anon,authenticated,service_role;
revoke all on function public.get_identity_references(uuid,jsonb),public.set_identity_reference_reaction(uuid,uuid,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.get_identity_references(uuid,jsonb),public.set_identity_reference_reaction(uuid,uuid,jsonb) to authenticated;
commit;
