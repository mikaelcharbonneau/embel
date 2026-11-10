-- Greenfield Assets library. Preserve existing immutable versions and selections.
begin;

alter table public.assets add column retention_revision integer not null default 0 check(retention_revision>=0);
alter table public.assets add column legacy_used boolean not null default false;
alter table public.assets add column purpose text not null default 'legacy_unknown' check(purpose in('legacy_unknown','brand_asset','reference_media'));
update public.assets set legacy_used=used;
-- Purpose is an insertion-time classification, including for privileged producers.
-- Historical unknown assets stay unknown; reference bindings can rely on this value.
create function fluid_private.asset_library_protect_purpose() returns trigger language plpgsql set search_path='' as $$
begin
 if new.purpose is distinct from old.purpose then raise exception 'immutable_asset_purpose' using errcode='55000';end if;
 return new;
end $$;
create trigger asset_library_purpose_immutable before update of purpose on public.assets for each row execute function fluid_private.asset_library_protect_purpose();
revoke update(liked,saved,used) on public.assets from authenticated;
revoke insert(project_id,asset_id,version_id,reason) on public.asset_selections from authenticated;
drop policy owned_asset_update on public.assets;
drop policy owned_selection_insert on public.asset_selections;

alter table public.asset_selections add constraint asset_selection_owned_event unique(id,asset_id,project_id,owner_id);
alter table public.asset_selections add constraint asset_selection_owned_version unique(id,version_id,asset_id,project_id,owner_id);
create table public.asset_heads (
 asset_id uuid primary key,project_id uuid not null,owner_id uuid not null,
 current_selection_id uuid,current_version_id uuid,selection_revision integer not null default 0 check(selection_revision>=0),
 initialization text not null check(initialization in('empty','legacy_selection')),
 updated_at timestamptz not null default clock_timestamp(),
 unique(asset_id,project_id,owner_id),
 check((current_selection_id is null and current_version_id is null and selection_revision=0) or(current_selection_id is not null and current_version_id is not null and selection_revision>0)),
 foreign key(asset_id,project_id,owner_id) references public.assets(id,project_id,owner_id),
 foreign key(current_version_id,asset_id,project_id,owner_id) references public.asset_versions(id,asset_id,project_id,owner_id),
 foreign key(current_selection_id,current_version_id,asset_id,project_id,owner_id) references public.asset_selections(id,version_id,asset_id,project_id,owner_id)
);
create table public.asset_selection_receipts (
 selection_id uuid primary key,version_id uuid not null,asset_id uuid not null,project_id uuid not null,owner_id uuid not null,
 project_revision integer not null,accepted_stale_basis boolean not null,previous_selection_id uuid,
 check(previous_selection_id is distinct from selection_id),
 foreign key(selection_id,version_id,asset_id,project_id,owner_id) references public.asset_selections(id,version_id,asset_id,project_id,owner_id),
 foreign key(previous_selection_id,asset_id,project_id,owner_id) references public.asset_selections(id,asset_id,project_id,owner_id),
 foreign key(project_id,owner_id,project_revision) references public.project_revisions(project_id,owner_id,revision)
);
create trigger asset_selection_receipts_immutable before update or delete on public.asset_selection_receipts for each row execute function fluid_private.prevent_history_change();
create index asset_heads_owner on public.asset_heads(owner_id,project_id,asset_id);
create index asset_selection_receipts_owner on public.asset_selection_receipts(owner_id,project_id,asset_id);
create index assets_owner_created_id on public.assets(owner_id,created_at desc,id desc);
create index asset_versions_asset_created_id on public.asset_versions(asset_id,created_at desc,id desc);

-- An actual latest event, including a deterministic ID tie-break, initializes the head.
-- No old event is rewritten or manufactured, and no legacy use becomes active use.
insert into public.asset_heads(asset_id,project_id,owner_id,current_selection_id,current_version_id,selection_revision,initialization)
 select a.id,a.project_id,a.owner_id,s.id,s.version_id,case when s.id is null then 0 else 1 end,case when s.id is null then 'empty' else 'legacy_selection' end
 from public.assets a left join lateral(select s.id,s.version_id from public.asset_selections s where s.asset_id=a.id and s.project_id=a.project_id and s.owner_id=a.owner_id order by s.created_at desc,s.id desc limit 1) s on true;
create function fluid_private.initialize_asset_library_head() returns trigger language plpgsql security definer set search_path='' as $$
begin
 insert into public.asset_heads(asset_id,project_id,owner_id,initialization) values(new.id,new.project_id,new.owner_id,'empty');
 return new;
end $$;
create trigger asset_library_head_insert after insert on public.assets for each row execute function fluid_private.initialize_asset_library_head();
do $$declare t text;begin
 foreach t in array array['asset_heads','asset_selection_receipts'] loop
  execute format('alter table public.%I enable row level security',t);execute format('alter table public.%I force row level security',t);
  execute format('revoke all on public.%I from public,anon,authenticated,service_role',t);
  execute format('grant select on public.%I to authenticated,service_role',t);
  execute format('create policy owned_read on public.%I for select to authenticated using(owner_id=(select auth.uid()))',t);
 end loop;
end $$;

create function fluid_private.asset_library_format(p_mime text) returns text language sql immutable set search_path='' as $$
 -- Match ECMAScript trim exactly; known MIME names use ASCII case folding only.
 select case translate(btrim(split_part(p_mime,';',1),U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz') when 'image/svg+xml' then 'svg' when 'image/png' then 'png' when 'image/webp' then 'webp'
 when 'image/jpeg' then 'jpeg' when 'application/pdf' then 'pdf' when 'application/zip' then 'zip' when 'application/json' then 'json' else 'other' end;
$$;
create function fluid_private.asset_library_query(p_query jsonb,p_detail boolean) returns jsonb language plpgsql immutable set search_path='' as $$
declare v_cursor jsonb:=p_query->'cursor';v_limit integer;
begin
 if p_query is null or jsonb_typeof(p_query)<>'object' or p_query-(case when p_detail then array['format','cursor','limit'] else array['tab','projectId','format','cursor','limit'] end)<>'{}' then raise exception 'invalid_asset_query' using errcode='22023';end if;
 if p_query ? 'limit' then
  if jsonb_typeof(p_query->'limit')<>'number' or (p_query->>'limit')!~'^[0-9]+$' or (p_query->>'limit')::numeric not between 1 and 100 then raise exception 'invalid_asset_query' using errcode='22023';end if;
 end if;
 if p_query ? 'tab' and(jsonb_typeof(p_query->'tab')<>'string' or p_query->>'tab' not in('my_selection','all_generations')) then raise exception 'invalid_asset_query' using errcode='22023';end if;
 if p_query ? 'format' and(jsonb_typeof(p_query->'format')<>'string' or p_query->>'format' not in('svg','png','webp','jpeg','pdf','zip','json','other')) then raise exception 'invalid_asset_query' using errcode='22023';end if;
 if p_query ? 'projectId' then
  if jsonb_typeof(p_query->'projectId')<>'string' then raise exception 'invalid_asset_query' using errcode='22023';end if;perform(p_query->>'projectId')::uuid;
  p_query:=jsonb_set(p_query,'{projectId}',to_jsonb((p_query->>'projectId')::uuid));
 end if;
 if p_query ? 'cursor' then
  if jsonb_typeof(v_cursor)<>'object' or v_cursor-(case when p_detail then array['createdAt','versionId','assetId','projectId','format'] else array['createdAt','assetId','tab','projectId','format'] end)<>'{}'
   or not(v_cursor ?& (case when p_detail then array['createdAt','versionId','assetId','projectId','format'] else array['createdAt','assetId','tab','projectId','format'] end))
   or jsonb_typeof(v_cursor->'createdAt')<>'string' or jsonb_typeof(v_cursor->'assetId')<>'string'
   or(v_cursor->'format' is distinct from coalesce(p_query->'format','null'::jsonb)) then raise exception 'invalid_asset_cursor' using errcode='22023';end if;
  perform(v_cursor->>'createdAt')::timestamptz;perform(v_cursor->>'assetId')::uuid;
  v_cursor:=jsonb_set(v_cursor,'{assetId}',to_jsonb((v_cursor->>'assetId')::uuid));
  if jsonb_typeof(v_cursor->'projectId')='string' then v_cursor:=jsonb_set(v_cursor,'{projectId}',to_jsonb((v_cursor->>'projectId')::uuid));end if;
  if p_detail then
   if jsonb_typeof(v_cursor->'versionId')<>'string' or jsonb_typeof(v_cursor->'projectId')<>'string' then raise exception 'invalid_asset_cursor' using errcode='22023';end if;
   perform(v_cursor->>'versionId')::uuid;perform(v_cursor->>'projectId')::uuid;
   v_cursor:=jsonb_set(v_cursor,'{versionId}',to_jsonb((v_cursor->>'versionId')::uuid));
  elsif v_cursor->'tab' is distinct from coalesce(p_query->'tab','"my_selection"'::jsonb) or v_cursor->'projectId' is distinct from coalesce(p_query->'projectId','null'::jsonb) then raise exception 'invalid_asset_cursor' using errcode='22023';
  end if;
  p_query:=jsonb_set(p_query,'{cursor}',v_cursor);
 end if;
 v_limit:=coalesce((p_query->>'limit')::integer,40);
 return(case when p_detail then '{}'::jsonb else jsonb_build_object('tab',coalesce(p_query->>'tab','my_selection')) end)||p_query||jsonb_build_object('limit',v_limit);
end $$;
create function fluid_private.asset_library_project(p_project public.projects) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('id',p_project.id,'owner_id',p_project.owner_id,'title',p_project.title,'scope',p_project.scope,'current_revision',p_project.current_revision,'created_at',p_project.created_at);
$$;
create function fluid_private.asset_library_selection(p_selection public.asset_selections) returns jsonb language sql stable set search_path='' as $$
 select case when p_selection.id is null then null else jsonb_build_object('id',p_selection.id,'ownerId',p_selection.owner_id,'projectId',p_selection.project_id,'assetId',p_selection.asset_id,'versionId',p_selection.version_id,'reason',p_selection.reason,'createdAt',p_selection.created_at,
 'receipt',coalesce((select jsonb_build_object('status','recorded','projectRevision',r.project_revision,'acceptedStaleBasis',r.accepted_stale_basis,'previousSelectionId',r.previous_selection_id) from public.asset_selection_receipts r where r.selection_id=p_selection.id and r.version_id=p_selection.version_id and r.asset_id=p_selection.asset_id and r.project_id=p_selection.project_id and r.owner_id=p_selection.owner_id),' {"status":"legacy_unverified"}'::jsonb)) end;
$$;
create function fluid_private.asset_library_record(p_asset public.assets) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('id',p_asset.id,'ownerId',p_asset.owner_id,'projectId',p_asset.project_id,'kind',p_asset.kind,'purpose',p_asset.purpose,'createdAt',p_asset.created_at,
 'versionCount',(select count(*) from public.asset_versions v where v.asset_id=p_asset.id and v.project_id=p_asset.project_id and v.owner_id=p_asset.owner_id),
 'retentionRevision',p_asset.retention_revision,'liked',p_asset.liked,'saved',p_asset.saved,'usage',jsonb_build_object('active',false,'legacy',p_asset.legacy_used),
 'selectionRevision',h.selection_revision,'currentSelection',fluid_private.asset_library_selection(s))
 from public.asset_heads h left join public.asset_selections s on s.id=h.current_selection_id and s.version_id=h.current_version_id and s.asset_id=h.asset_id and s.project_id=h.project_id and s.owner_id=h.owner_id
 where h.asset_id=p_asset.id and h.project_id=p_asset.project_id and h.owner_id=p_asset.owner_id;
$$;
create function fluid_private.asset_library_version(p_version public.asset_versions,p_project_revision integer) returns jsonb language sql stable set search_path='' as $$
 select case when p_version.id is null then null else jsonb_build_object('versionId',p_version.id,'ownerId',p_version.owner_id,'projectId',p_version.project_id,'assetId',p_version.asset_id,
 'versionNumber',p_version.version,'inputRevision',p_version.input_revision,'inputHash',p_version.input_hash,'contentHash',p_version.content_hash,'createdAt',p_version.created_at,'mimeType',p_version.mime_type,'format',fluid_private.asset_library_format(p_version.mime_type),
 'provenance','{"status":"legacy_unverified"}'::jsonb,'vectorStatus','unverified','licenseStatus','unverified','fileState',case when p_version.storage_path is null then 'metadata_only' else 'unverified' end,'fileVerification',null,
 'freshness',jsonb_build_object('basis','revision_only','status',case when p_version.input_revision=p_project_revision then 'unknown' else 'stale' end,'inputRevision',p_version.input_revision,'currentProjectRevision',p_project_revision,
 'reasons',case when p_version.input_revision=p_project_revision then '["material_basis_unavailable"]'::jsonb else '["project_revision_changed","material_basis_unavailable"]'::jsonb end)) end;
$$;
create function fluid_private.asset_library_versions(p_asset public.assets,p_project_revision integer,p_format text,p_limit integer,p_cursor jsonb default null) returns jsonb language plpgsql stable set search_path='' as $$
declare v_items jsonb:='[]';v_total bigint;v_row public.asset_versions;v_count integer:=0;v_last public.asset_versions;v_next jsonb;
begin
 if p_cursor is not null then
  if (p_cursor->>'assetId')::uuid<>p_asset.id or(p_cursor->>'projectId')::uuid<>p_asset.project_id or p_cursor->'format' is distinct from coalesce(to_jsonb(p_format),'null'::jsonb) then raise exception 'invalid_asset_cursor' using errcode='22023';end if;
  if not exists(select 1 from public.asset_versions where id=(p_cursor->>'versionId')::uuid and asset_id=p_asset.id and project_id=p_asset.project_id and owner_id=p_asset.owner_id and created_at=(p_cursor->>'createdAt')::timestamptz and(p_format is null or fluid_private.asset_library_format(mime_type)=p_format)) then raise exception 'not_found' using errcode='P0002';end if;
 end if;
 select count(*) into v_total from public.asset_versions where asset_id=p_asset.id and project_id=p_asset.project_id and owner_id=p_asset.owner_id and(p_format is null or fluid_private.asset_library_format(mime_type)=p_format);
 for v_row in select v.* from public.asset_versions v where v.asset_id=p_asset.id and v.project_id=p_asset.project_id and v.owner_id=p_asset.owner_id and(p_format is null or fluid_private.asset_library_format(v.mime_type)=p_format)
  and(p_cursor is null or(v.created_at,v.id)<((p_cursor->>'createdAt')::timestamptz,(p_cursor->>'versionId')::uuid)) order by v.created_at desc,v.id desc limit p_limit+1 loop
  v_count:=v_count+1;if v_count>p_limit then
   v_next:=jsonb_build_object('createdAt',v_last.created_at,'versionId',v_last.id,'assetId',p_asset.id,'projectId',p_asset.project_id,'format',p_format);exit;
  end if;
  v_items:=v_items||jsonb_build_array(fluid_private.asset_library_version(v_row,p_project_revision));v_last:=v_row;
 end loop;
 return jsonb_build_object('ownerId',p_asset.owner_id,'projectId',p_asset.project_id,'assetId',p_asset.id,'format',p_format,'items',v_items,'totalCount',v_total,'nextCursor',v_next);
end $$;
create function fluid_private.asset_library_selected_version(p_asset public.assets,p_project_revision integer) returns jsonb language sql stable set search_path='' as $$
 select fluid_private.asset_library_version(v,p_project_revision) from public.asset_heads h join public.asset_versions v on v.id=h.current_version_id and v.asset_id=h.asset_id and v.project_id=h.project_id and v.owner_id=h.owner_id
 where h.asset_id=p_asset.id and h.project_id=p_asset.project_id and h.owner_id=p_asset.owner_id;
$$;
create function fluid_private.asset_library_item(p_asset public.assets,p_project public.projects,p_format text) returns jsonb language plpgsql stable set search_path='' as $$
declare v_selected jsonb:=fluid_private.asset_library_selected_version(p_asset,p_project.current_revision);v_page jsonb;v_display jsonb;
begin
 v_page:=fluid_private.asset_library_versions(p_asset,p_project.current_revision,p_format,4);
 v_display:=case when v_selected is not null and(p_format is null or v_selected->>'format'=p_format) then v_selected else v_page#>'{items,0}' end;
 return jsonb_build_object('asset',fluid_private.asset_library_record(p_asset),'project',fluid_private.asset_library_project(p_project),'selectedVersion',v_selected,'displayedVersion',v_display,'matchingVersions',v_page);
end $$;

create function public.list_account_assets(p_query jsonb default '{}') returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_owner uuid:=auth.uid();v_query jsonb;v_asset public.assets;v_project public.projects;v_items jsonb:='[]';v_count integer:=0;v_last public.assets;v_next jsonb;v_cursor jsonb;
begin
 if v_owner is null then raise exception 'unauthenticated' using errcode='42501';end if;v_query:=fluid_private.asset_library_query(p_query,false);v_cursor:=v_query->'cursor';
 if v_query ? 'projectId' and not exists(select 1 from public.projects where id=(v_query->>'projectId')::uuid and owner_id=v_owner) then raise exception 'not_found' using errcode='P0002';end if;
 if v_cursor is not null and not exists(select 1 from public.assets where id=(v_cursor->>'assetId')::uuid and owner_id=v_owner and purpose<>'reference_media' and created_at=(v_cursor->>'createdAt')::timestamptz and(not(v_query ? 'projectId') or project_id=(v_query->>'projectId')::uuid)) then raise exception 'not_found' using errcode='P0002';end if;
 for v_asset in select a.* from public.assets a where a.owner_id=v_owner and a.purpose<>'reference_media'
  and(v_query->>'tab'='all_generations' or a.liked or a.saved or a.legacy_used)
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
create function public.get_asset_detail(p_asset_id uuid,p_query jsonb default '{}') returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_owner uuid:=auth.uid();v_query jsonb;v_asset public.assets;v_project public.projects;
begin
 if v_owner is null then raise exception 'unauthenticated' using errcode='42501';end if;v_query:=fluid_private.asset_library_query(p_query,true);
 select * into v_asset from public.assets where id=p_asset_id and owner_id=v_owner and purpose<>'reference_media';if not found then raise exception 'not_found' using errcode='P0002';end if;
 select * into strict v_project from public.projects where id=v_asset.project_id and owner_id=v_owner;
 return jsonb_build_object('asset',fluid_private.asset_library_record(v_asset),'project',fluid_private.asset_library_project(v_project),'selectedVersion',fluid_private.asset_library_selected_version(v_asset,v_project.current_revision),
 'versions',fluid_private.asset_library_versions(v_asset,v_project.current_revision,v_query->>'format',(v_query->>'limit')::integer,v_query->'cursor'));
end $$;
create function public.set_asset_retention(p_asset_id uuid,p_expected_retention_revision integer,p_liked boolean,p_saved boolean) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_owner uuid:=auth.uid();v_asset public.assets;v_project public.projects;
begin
 if v_owner is null then raise exception 'unauthenticated' using errcode='42501';end if;
 if p_expected_retention_revision is null or p_expected_retention_revision<0 or p_liked is null or p_saved is null then raise exception 'invalid_asset_retention' using errcode='22023';end if;
 select * into v_asset from public.assets where id=p_asset_id and owner_id=v_owner and purpose<>'reference_media' for update;if not found then raise exception 'not_found' using errcode='P0002';end if;
 if v_asset.retention_revision<>p_expected_retention_revision then raise exception 'asset_retention_conflict' using errcode='PT409';end if;
 update public.assets set liked=p_liked,saved=p_saved,retention_revision=retention_revision+1 where id=p_asset_id and owner_id=v_owner returning * into v_asset;
 select * into strict v_project from public.projects where id=v_asset.project_id and owner_id=v_owner;
 return jsonb_build_object('asset',fluid_private.asset_library_record(v_asset),'project',fluid_private.asset_library_project(v_project));
end $$;
create function public.select_asset_version(p_asset_id uuid,p_version_id uuid,p_expected_project_revision integer,p_expected_selection_revision integer,p_accept_stale_basis boolean) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_owner uuid:=auth.uid();v_asset public.assets;v_project public.projects;v_head public.asset_heads;v_version public.asset_versions;v_selection public.asset_selections;v_reason text;
begin
 if v_owner is null then raise exception 'unauthenticated' using errcode='42501';end if;
 if p_expected_project_revision is null or p_expected_project_revision<1 or p_expected_selection_revision is null or p_expected_selection_revision<0 or p_accept_stale_basis is null then raise exception 'invalid_asset_selection' using errcode='22023';end if;
 select * into v_asset from public.assets where id=p_asset_id and owner_id=v_owner and purpose<>'reference_media';if not found then raise exception 'not_found' using errcode='P0002';end if;
 select * into strict v_project from public.projects where id=v_asset.project_id and owner_id=v_owner for update;
 perform 1 from public.assets where id=p_asset_id and owner_id=v_owner for update;
 select * into strict v_head from public.asset_heads where asset_id=p_asset_id and project_id=v_project.id and owner_id=v_owner for update;
 select * into v_version from public.asset_versions where id=p_version_id and asset_id=p_asset_id and project_id=v_project.id and owner_id=v_owner;if not found then raise exception 'not_found' using errcode='P0002';end if;
 if v_project.current_revision<>p_expected_project_revision or v_head.selection_revision<>p_expected_selection_revision then raise exception 'asset_selection_conflict' using errcode='PT409';end if;
 if v_version.input_revision<>v_project.current_revision and not p_accept_stale_basis then raise exception 'stale_asset_requires_acknowledgment' using errcode='PT409';end if;
 v_reason:=case when exists(select 1 from public.asset_selections where version_id=p_version_id and asset_id=p_asset_id and project_id=v_project.id and owner_id=v_owner) then 'restored' else 'selected' end;
 insert into public.asset_selections(owner_id,project_id,asset_id,version_id,reason) values(v_owner,v_project.id,p_asset_id,p_version_id,v_reason) returning * into v_selection;
 insert into public.asset_selection_receipts(selection_id,version_id,asset_id,project_id,owner_id,project_revision,accepted_stale_basis,previous_selection_id)
 values(v_selection.id,p_version_id,p_asset_id,v_project.id,v_owner,v_project.current_revision,p_accept_stale_basis,v_head.current_selection_id);
 update public.asset_heads set current_selection_id=v_selection.id,current_version_id=p_version_id,selection_revision=selection_revision+1,updated_at=clock_timestamp() where asset_id=p_asset_id and project_id=v_project.id and owner_id=v_owner;
 return public.get_asset_detail(p_asset_id,'{}');
end $$;

do $$declare f record;begin
 for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='fluid_private' and(p.proname like 'asset_library_%' or p.proname='initialize_asset_library_head') loop
  execute format('revoke all on function %s from public,anon,authenticated,service_role',f.signature);
 end loop;
 for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in('list_account_assets','get_asset_detail','set_asset_retention','select_asset_version') loop
  execute format('revoke all on function %s from public,anon,authenticated,service_role',f.signature);execute format('grant execute on function %s to authenticated',f.signature);
 end loop;
end $$;
commit;
