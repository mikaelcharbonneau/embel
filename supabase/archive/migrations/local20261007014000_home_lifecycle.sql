-- LOCAL CANDIDATE ONLY. Owner-bound manual associations and promotions.
-- No storage capability, provider job, credentials, hosted activation or grants to runtime workers.
begin;
create table public.idea_project_attachments (
 id uuid primary key default gen_random_uuid(), owner_id uuid not null references auth.users(id), request_key uuid not null,
 idea_id uuid not null, idea_revision integer not null, project_id uuid not null, project_revision integer not null,
 input jsonb not null, receipt jsonb not null, created_at timestamptz not null default clock_timestamp(),
 unique(id,owner_id), unique(owner_id,request_key), unique(owner_id,idea_id,idea_revision,project_id),
 foreign key(idea_id,owner_id,idea_revision) references public.idea_revisions(idea_id,owner_id,revision),
 foreign key(project_id,owner_id,project_revision) references public.project_revisions(project_id,owner_id,revision)
);
create index idea_project_attachments_page on public.idea_project_attachments(owner_id,project_id,created_at desc,id desc);
create table public.idea_project_attachment_requests (
 owner_id uuid not null references auth.users(id), request_key uuid not null,
 association_id uuid not null, input jsonb not null check(jsonb_typeof(input)='object' and octet_length(input::text)<=32768),
 disposition text not null check(disposition in ('attached','already_attached')),
 receipt jsonb not null check(jsonb_typeof(receipt)='object' and octet_length(receipt::text)<=131072),
 created_at timestamptz not null default clock_timestamp(), primary key(owner_id,request_key),
 foreign key(association_id,owner_id) references public.idea_project_attachments(id,owner_id)
);
create trigger idea_project_attachment_requests_immutable before update or delete on public.idea_project_attachment_requests for each row execute function fluid_private.prevent_history_change();

create table public.standalone_promotions (
 id uuid primary key default gen_random_uuid(), owner_id uuid not null references auth.users(id), request_key uuid not null,
 workspace_id uuid not null, workspace_revision integer not null, project_id uuid not null,
 input jsonb not null, receipt jsonb not null, created_at timestamptz not null default clock_timestamp(),
 unique(owner_id,request_key), unique(project_id),
 foreign key(workspace_id,owner_id,workspace_revision) references public.standalone_workspace_revisions(workspace_id,owner_id,revision),
 foreign key(project_id,owner_id) references public.projects(id,owner_id)
);
create trigger idea_project_attachments_immutable before update or delete on public.idea_project_attachments for each row execute function fluid_private.prevent_history_change();
create trigger standalone_promotions_immutable before update or delete on public.standalone_promotions for each row execute function fluid_private.prevent_history_change();

create function fluid_private.lifecycle_uuid(v jsonb) returns boolean language sql immutable set search_path='' as $$
 select coalesce(jsonb_typeof(v)='string' and (v#>>'{}')~'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',false)
$$;
create function fluid_private.lifecycle_revision(v jsonb) returns boolean language sql immutable set search_path='' as $$
 select coalesce(jsonb_typeof(v)='number' and (v#>>'{}')~'^[0-9]{1,10}$' and (v#>>'{}')::numeric between 1 and 2147483647,false)
$$;
create function public.attach_idea_to_project(p_input jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare owner uuid:=auth.uid(); i public.ideas; p public.projects; previous public.idea_project_attachment_requests; a public.idea_project_attachments;
 content jsonb; attachment jsonb; result jsonb; nonce uuid; disposition text; now_at timestamptz:=clock_timestamp();
begin
 if owner is null then raise exception 'unauthenticated' using errcode='42501'; end if;
 if not fluid_private.standalone_keys(p_input,array['requestKey','ideaId','expectedIdeaRevision','projectId','expectedProjectRevision']) or octet_length(p_input::text)>32768 or
  not fluid_private.lifecycle_uuid(p_input->'requestKey') or not fluid_private.lifecycle_uuid(p_input->'ideaId') or not fluid_private.lifecycle_uuid(p_input->'projectId') or
  not fluid_private.lifecycle_revision(p_input->'expectedIdeaRevision') or not fluid_private.lifecycle_revision(p_input->'expectedProjectRevision') then raise exception 'invalid_input' using errcode='22023'; end if;
 nonce:=(p_input->>'requestKey')::uuid;
 perform pg_advisory_xact_lock(hashtextextended(owner::text||':idea-attachment:'||nonce::text,0));
 select * into previous from public.idea_project_attachment_requests where owner_id=owner and request_key=nonce;
 if found then if previous.input<>p_input then raise exception 'request_conflict' using errcode='40001'; end if; return previous.receipt; end if;
 -- Independent keys for the same source/target share one admission lock. The
 -- unique association constraint remains a second guard against duplicate links.
 perform pg_advisory_xact_lock(hashtextextended(owner::text||':idea-attachment-pair:'||(p_input->>'ideaId')||':'||(p_input->>'expectedIdeaRevision')||':'||(p_input->>'projectId'),0));
 select * into i from public.ideas where id=(p_input->>'ideaId')::uuid and owner_id=owner for share;
 if not found then raise exception 'not_found' using errcode='P0002'; end if;
 select * into p from public.projects where id=(p_input->>'projectId')::uuid and owner_id=owner for share;
 if not found then raise exception 'not_found' using errcode='P0002'; end if;
 select * into a from public.idea_project_attachments where owner_id=owner and idea_id=i.id and idea_revision=(p_input->>'expectedIdeaRevision')::integer and project_id=p.id;
 if found then
  -- This proves the exact frozen source is already linked. Do not substitute the
  -- latest source content or the caller's expected target revision into history.
  disposition:='already_attached'; attachment:=a.receipt;
 else
  if i.current_revision<>(p_input->>'expectedIdeaRevision')::integer or p.current_revision<>(p_input->>'expectedProjectRevision')::integer then raise exception 'revision_conflict' using errcode='40001'; end if;
  select r.content into content from public.idea_revisions r where r.idea_id=i.id and r.owner_id=owner and r.revision=i.current_revision;
  a.id:=gen_random_uuid(); disposition:='attached';
  attachment:=jsonb_build_object('ownerId',owner,'requestKey',nonce,'association',jsonb_build_object('id',a.id,'ideaId',i.id,'ideaRevision',i.current_revision,'projectId',p.id,'projectRevision',p.current_revision,'createdAt',fluid_private.idea_timestamp(now_at)),'source',jsonb_build_object('content',content));
  insert into public.idea_project_attachments(id,owner_id,request_key,idea_id,idea_revision,project_id,project_revision,input,receipt,created_at)
   values(a.id,owner,nonce,i.id,i.current_revision,p.id,p.current_revision,p_input,attachment,now_at);
 end if;
 result:=jsonb_build_object('ownerId',owner,'requestKey',nonce,'status',disposition,'input',p_input,'attachment',attachment);
 insert into public.idea_project_attachment_requests(owner_id,request_key,association_id,input,disposition,receipt,created_at)
  values(owner,nonce,a.id,p_input,disposition,result,now_at);
 return result;
end $$;
create function public.read_idea_project_attachment_request(p_request_key uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare owner uuid:=auth.uid(); result jsonb;
begin
 if owner is null then raise exception 'unauthenticated' using errcode='42501'; end if;
 select receipt into result from public.idea_project_attachment_requests where owner_id=owner and request_key=p_request_key;
 return case when found then jsonb_build_object('status','committed','receipt',result) else jsonb_build_object('status','not_found') end;
end $$;
create function public.get_project_idea_attachments(p_project_id uuid,p_cursor uuid default null,p_limit integer default 20) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare owner uuid:=auth.uid(); at_cursor public.idea_project_attachments; row public.idea_project_attachments; items jsonb:='[]'; last_id uuid; more boolean:=false; count integer:=0;
begin
 if owner is null then raise exception 'unauthenticated' using errcode='42501'; end if;
 if p_limit is null or p_limit not between 1 and 50 then raise exception 'invalid_limit' using errcode='22023'; end if;
 perform 1 from public.projects where id=p_project_id and owner_id=owner; if not found then raise exception 'not_found' using errcode='P0002'; end if;
 if p_cursor is not null then
  select * into at_cursor from public.idea_project_attachments where id=p_cursor and owner_id=owner and project_id=p_project_id;
  if not found then raise exception 'invalid_cursor' using errcode='22023'; end if;
 end if;
 for row in select * from public.idea_project_attachments where owner_id=owner and project_id=p_project_id and (p_cursor is null or (created_at,id)<(at_cursor.created_at,at_cursor.id)) order by created_at desc,id desc limit p_limit+1 loop
  count:=count+1; if count>p_limit then more:=true; exit; end if;
  items:=items||jsonb_build_array(row.receipt); last_id:=row.id;
 end loop;
 return jsonb_build_object('ownerId',owner,'projectId',p_project_id,'items',items,'nextCursor',case when more then last_id else null end);
end $$;

create function public.promote_standalone_workspace(p_input jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare owner uuid:=auth.uid(); w public.standalone_workspaces; r public.standalone_workspace_revisions; previous public.standalone_promotions; p public.projects;
 imported public.project_revisions; chosen jsonb; source jsonb; selected jsonb; bundle jsonb; context jsonb; context_text text; context_hash text; content jsonb; name text;
 nonce uuid; source_id uuid:=gen_random_uuid(); now_at timestamptz:=clock_timestamp(); result jsonb; title text;
begin
 if owner is null then raise exception 'unauthenticated' using errcode='42501'; end if;
 if not fluid_private.standalone_keys(p_input,array['requestKey','workspaceId','expectedWorkspaceRevision','selection','contextSource','title']) or octet_length(p_input::text)>32768 or
  not fluid_private.lifecycle_uuid(p_input->'requestKey') or not fluid_private.lifecycle_uuid(p_input->'workspaceId') or not fluid_private.lifecycle_revision(p_input->'expectedWorkspaceRevision') or
  not fluid_private.standalone_text(p_input->'title',160,1) or (fluid_private.idea_trim(p_input->>'title')='' or fluid_private.idea_trim(p_input->>'title')<>p_input->>'title') then raise exception 'invalid_input' using errcode='22023'; end if;
 selected:=p_input->'selection'; chosen:=p_input->'contextSource'; title:=p_input->>'title';
 if selected->>'tool'='domains' then
  if not fluid_private.standalone_keys(selected,array['tool','domain']) or not fluid_private.standalone_domain(selected->>'domain') then raise exception 'invalid_selection' using errcode='22023'; end if;
 elsif selected->>'tool'='handles' then
  if not fluid_private.standalone_keys(selected,array['tool','bundleId']) or not fluid_private.standalone_text(selected->'bundleId',160,1) then raise exception 'invalid_selection' using errcode='22023'; end if;
 elsif selected->>'tool'='trademarks' then
  if not fluid_private.standalone_keys(selected,array['tool']) then raise exception 'invalid_selection' using errcode='22023'; end if;
 else raise exception 'invalid_selection' using errcode='22023'; end if;
 if chosen<>'null'::jsonb and (not fluid_private.standalone_keys(chosen,array['projectId','projectRevision','selectionId']) or not fluid_private.lifecycle_uuid(chosen->'projectId') or not fluid_private.lifecycle_revision(chosen->'projectRevision') or (chosen->'selectionId'<>'null'::jsonb and not fluid_private.lifecycle_uuid(chosen->'selectionId'))) then raise exception 'invalid_context_source' using errcode='22023'; end if;
 nonce:=(p_input->>'requestKey')::uuid;
 perform pg_advisory_xact_lock(hashtextextended(owner::text||':standalone-promotion:'||nonce::text,0));
 select * into previous from public.standalone_promotions where owner_id=owner and request_key=nonce;
 if found then if previous.input<>p_input then raise exception 'request_conflict' using errcode='40001'; end if; return previous.receipt; end if;
 select * into w from public.standalone_workspaces where id=(p_input->>'workspaceId')::uuid and owner_id=owner for share;
 if not found then raise exception 'not_found' using errcode='P0002'; end if;
 if w.current_revision<>(p_input->>'expectedWorkspaceRevision')::integer then raise exception 'revision_conflict' using errcode='40001'; end if;
 if w.tool<>selected->>'tool' then raise exception 'not_found' using errcode='P0002'; end if;
 select * into r from public.standalone_workspace_revisions where workspace_id=w.id and owner_id=owner and revision=w.current_revision;
 if w.tool='domains' then
  if not(r.payload->'candidates' @> jsonb_build_array(selected->>'domain')) then raise exception 'not_found' using errcode='P0002'; end if;
 elsif w.tool='handles' then
  select value into bundle from jsonb_array_elements(r.payload->'bundles') where value->>'id'=selected->>'bundleId';
  if not found then raise exception 'not_found' using errcode='P0002'; end if;
 elsif fluid_private.idea_trim(r.payload->>'markName')='' then raise exception 'invalid_mark_name' using errcode='22023'; end if;
 if chosen<>'null'::jsonb then
  select value into source from jsonb_array_elements(r.imports) where value->'projectId'=chosen->'projectId' and value->'projectRevision'=chosen->'projectRevision' and value->'selectionId'=chosen->'selectionId';
  if not found then raise exception 'not_found' using errcode='P0002'; end if;
  select pr.* into imported from public.project_revisions pr join public.projects owned on (owned.id,owned.owner_id)=(pr.project_id,pr.owner_id)
   where pr.project_id=(source->>'projectId')::uuid and pr.owner_id=owner and pr.revision=(source->>'projectRevision')::integer;
  if not found then raise exception 'not_found' using errcode='P0002'; end if;
  context:=imported.context; context_hash:=imported.input_hash;
 else
  -- These are saved input notes only. No availability, provider observations, clearance or review marker is inferred.
  if w.tool='trademarks' then
   name:=fluid_private.idea_trim(r.payload->>'markName');
   content:=jsonb_build_object('title',title,'description',concat_ws(E'\n\n',nullif(fluid_private.idea_trim(r.payload->>'goodsServices'),''),nullif(fluid_private.idea_trim(r.payload->>'userNotes'),'')),'details',jsonb_build_object('solution','','audience',''));
  elsif w.tool='handles' then
   name:=bundle#>>'{source,name}'; content:=jsonb_build_object('title',title,'description',bundle->>'title','details',jsonb_build_object('solution','','audience',''));
  else content:=jsonb_build_object('title',title,'description','Domain candidate: '||(selected->>'domain'),'details',jsonb_build_object('solution','','audience','')); end if;
  context_text:=fluid_private.idea_project_context_text(content);
  if name is not null then context_text:=replace(replace(context_text,'"selectedName":null,','"selectedName":'||to_json(name)::text||','),'"suppliedName":"",','"suppliedName":'||to_json(name)::text||','); end if;
  context:=context_text::jsonb; context_hash:=encode(sha256(convert_to(context_text,'UTF8')),'hex');
 end if;
 p:=public.create_project('complete_brand',title,context,context_hash);
 result:=jsonb_build_object('ownerId',owner,'requestKey',nonce,'project',jsonb_build_object('id',p.id,'owner_id',owner,'scope',p.scope,'title',p.title,'current_revision',p.current_revision,'created_at',fluid_private.idea_timestamp(p.created_at),'context',context),
  'source',jsonb_build_object('id',source_id,'ownerId',owner,'workspaceId',w.id,'workspaceRevision',r.revision,'selection',selected,'payloadHash',encode(sha256(convert_to(fluid_private.standalone_compact(r.payload),'UTF8')),'hex'),'contextSource',source,'createdAt',fluid_private.idea_timestamp(now_at)));
 insert into public.standalone_promotions(id,owner_id,request_key,workspace_id,workspace_revision,project_id,input,receipt,created_at) values(source_id,owner,nonce,w.id,r.revision,p.id,p_input,result,now_at);
 return result;
end $$;
create function public.read_standalone_promotion_request(p_request_key uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare owner uuid:=auth.uid(); result jsonb;
begin
 if owner is null then raise exception 'unauthenticated' using errcode='42501'; end if;
 select receipt into result from public.standalone_promotions where owner_id=owner and request_key=p_request_key;
 return case when found then jsonb_build_object('status','committed','receipt',result) else jsonb_build_object('status','not_found') end;
end $$;
create function public.get_standalone_promotion_source(p_project_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare owner uuid:=auth.uid(); result jsonb;
begin
 if owner is null then raise exception 'unauthenticated' using errcode='42501'; end if;
 perform 1 from public.projects where id=p_project_id and owner_id=owner; if not found then raise exception 'not_found' using errcode='P0002'; end if;
 select receipt->'source' into result from public.standalone_promotions where owner_id=owner and project_id=p_project_id;
 return jsonb_build_object('ownerId',owner,'projectId',p_project_id,'source',result);
end $$;

create function public.get_standalone_promotion_snapshot(p_project_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare owner uuid:=auth.uid(); promoted public.standalone_promotions; frozen public.standalone_workspace_revisions; tool text; source jsonb;
begin
 if owner is null then raise exception 'unauthenticated' using errcode='42501'; end if;
 perform 1 from public.projects where id=p_project_id and owner_id=owner;
 if not found then raise exception 'not_found' using errcode='P0002'; end if;
 select * into promoted from public.standalone_promotions where owner_id=owner and project_id=p_project_id;
 if not found then return jsonb_build_object('ownerId',owner,'projectId',p_project_id,'source',null,'snapshot',null); end if;
 -- The saved revision is the authority. The mutable workspace head is never read.
 select r.* into frozen from public.standalone_workspace_revisions r where r.workspace_id=promoted.workspace_id and r.owner_id=owner and r.revision=promoted.workspace_revision;
 if not found then raise exception 'snapshot_unavailable' using errcode='XX000'; end if;
 select w.tool into tool from public.standalone_workspaces w where w.id=frozen.workspace_id and w.owner_id=owner;
 source:=promoted.receipt->'source';
 if source->>'id' is distinct from promoted.id::text or source->>'ownerId' is distinct from owner::text or source->>'workspaceId' is distinct from frozen.workspace_id::text or source->>'workspaceRevision' is distinct from frozen.revision::text or source#>>'{selection,tool}' is distinct from tool or
  source->>'payloadHash' is distinct from encode(sha256(convert_to(fluid_private.standalone_compact(frozen.payload),'UTF8')),'hex') or not fluid_private.standalone_payload(tool,frozen.payload) then raise exception 'snapshot_unavailable' using errcode='XX000'; end if;
 return jsonb_build_object('ownerId',owner,'projectId',p_project_id,'source',source,'snapshot',jsonb_build_object('workspaceId',frozen.workspace_id,'workspaceRevision',frozen.revision,'payload',jsonb_build_object('tool',tool,'data',frozen.payload)));
end $$;

-- Strip inherited/default grants on these exact new objects only. In particular,
-- RLS does not protect TRUNCATE or privileged SECURITY DEFINER execution.
do $$ declare table_name text; fn record; grantee record; column_grant record; object_name text; role_name text; begin
 foreach table_name in array array['idea_project_attachments','idea_project_attachment_requests','standalone_promotions'] loop
  execute format('alter table public.%I enable row level security',table_name);
  execute format('alter table public.%I force row level security',table_name);
  execute format('revoke all on table public.%I from public,anon,authenticated,service_role cascade',table_name);
  for grantee in select distinct r.rolname from pg_class c cross join lateral aclexplode(c.relacl) a join pg_roles r on r.oid=a.grantee
   where c.oid=format('public.%I',table_name)::regclass and a.grantee<>c.relowner loop
   execute format('revoke all on table public.%I from %I cascade',table_name,grantee.rolname);
  end loop;
  -- Table-level REVOKE is not a substitute for independently granted column ACLs.
  for column_grant in select distinct a.attname,x.grantee,r.rolname from pg_attribute a join pg_class c on c.oid=a.attrelid
   cross join lateral aclexplode(a.attacl) x left join pg_roles r on r.oid=x.grantee
   where c.oid=format('public.%I',table_name)::regclass and a.attnum>0 and not a.attisdropped and x.grantee<>c.relowner loop
   role_name:=case when column_grant.grantee=0 then 'PUBLIC' else quote_ident(column_grant.rolname) end;
   execute format('revoke all (%I) on table public.%I from %s cascade',column_grant.attname,table_name,role_name);
  end loop;
  execute format('grant select on table public.%I to authenticated',table_name);
  execute format('create policy owned_read on public.%I for select to authenticated using(owner_id=(select auth.uid()))',table_name);
 end loop;
 -- Exact OIDs avoid changing matching prefixes and unrelated same-name overloads.
 for fn in select p.oid,p.proowner from pg_proc p where p.oid in (
  'public.attach_idea_to_project(jsonb)'::regprocedure,
  'public.read_idea_project_attachment_request(uuid)'::regprocedure,
  'public.get_project_idea_attachments(uuid,uuid,integer)'::regprocedure,
  'public.promote_standalone_workspace(jsonb)'::regprocedure,
  'public.read_standalone_promotion_request(uuid)'::regprocedure,
  'public.get_standalone_promotion_source(uuid)'::regprocedure,
  'public.get_standalone_promotion_snapshot(uuid)'::regprocedure,
  'fluid_private.lifecycle_uuid(jsonb)'::regprocedure,
  'fluid_private.lifecycle_revision(jsonb)'::regprocedure
 ) loop
  object_name:=fn.oid::regprocedure::text;
  execute 'revoke all on function '||object_name||' from public,anon,authenticated,service_role cascade';
  for grantee in select distinct r.rolname from pg_proc p cross join lateral aclexplode(p.proacl) a join pg_roles r on r.oid=a.grantee
   where p.oid=fn.oid and a.grantee<>fn.proowner loop
   execute 'revoke all on function '||object_name||' from '||quote_ident(grantee.rolname)||' cascade';
  end loop;
  if fn.oid in (
   'public.attach_idea_to_project(jsonb)'::regprocedure,
   'public.read_idea_project_attachment_request(uuid)'::regprocedure,
   'public.get_project_idea_attachments(uuid,uuid,integer)'::regprocedure,
   'public.promote_standalone_workspace(jsonb)'::regprocedure,
   'public.read_standalone_promotion_request(uuid)'::regprocedure,
   'public.get_standalone_promotion_source(uuid)'::regprocedure,
   'public.get_standalone_promotion_snapshot(uuid)'::regprocedure
  ) then execute 'grant execute on function '||object_name||' to authenticated'; end if;
 end loop;
end $$;
commit;
