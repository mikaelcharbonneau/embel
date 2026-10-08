-- Local candidate only. No hosted changes, storage buckets, roles, credentials,
-- provider calls or activation. Private byte storage is an injected capability.
begin;
create table fluid_private.home_attachment_principals (
 role_name name primary key, role_oid oid not null unique, owner_id uuid not null references auth.users(id)
);
create table public.home_attachments (
 id uuid primary key default gen_random_uuid(), owner_id uuid not null references auth.users(id), request_key uuid not null, input jsonb not null,
 blob_version_id uuid not null unique default gen_random_uuid(), source_receipt_id uuid not null unique default gen_random_uuid(),
 name text not null check(length(name) between 1 and 255), mime_type text not null check(mime_type in('text/plain','application/pdf','image/png','image/jpeg')),
 content_hash text not null check(content_hash~'^[0-9a-f]{64}$'), byte_length bigint not null check(byte_length between 1 and 10485760),
 verified boolean not null default false, project_id uuid, project_revision integer,
 unique(owner_id,request_key), unique(id,owner_id),
 foreign key(project_id,owner_id,project_revision) references public.project_revisions(project_id,owner_id,revision),
 check((project_id is null)=(project_revision is null)), check(project_id is null or (verified and project_revision=1)), check(octet_length(input::text)<=32768)
);
create table public.home_attachment_project_requests (
 owner_id uuid not null references auth.users(id), request_key uuid not null, project_id uuid not null, input jsonb not null, receipt jsonb not null,
 primary key(owner_id,request_key), unique(project_id), foreign key(project_id,owner_id) references public.projects(id,owner_id),
 check(octet_length(input::text)<=32768), check(octet_length(receipt::text)<=65536)
);
create index home_attachments_owned_project on public.home_attachments(owner_id,project_id);
create function fluid_private.home_attachment_owner() returns uuid language plpgsql stable security definer set search_path='' as $$
declare r pg_catalog.pg_roles; result uuid;
begin
 select * into r from pg_catalog.pg_roles where rolname=session_user;
 if r.oid is null or not r.rolcanlogin or r.rolinherit or r.rolsuper or r.rolbypassrls or r.rolcreatedb or r.rolcreaterole or r.rolreplication or exists(select 1 from pg_catalog.pg_auth_members where member=r.oid) then raise exception 'home_principal_invalid' using errcode='42501'; end if;
 select owner_id into result from fluid_private.home_attachment_principals where role_name=session_user and role_oid=r.oid;
 if result is null then raise exception 'home_principal_unbound' using errcode='42501'; end if; return result;
end $$;
create function fluid_private.home_attachment_ref(r public.home_attachments, as_staged boolean default false) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('id',r.id,'ownerId',r.owner_id,'projectId',case when as_staged then null else r.project_id end,'projectRevision',case when as_staged then null else r.project_revision end,
 'blobVersionId',r.blob_version_id,'contentHash',r.content_hash,'mimeType',r.mime_type,'byteLength',r.byte_length,'name',r.name,'sourceReceiptId',r.source_receipt_id,'state',case when as_staged or r.project_id is null then 'staged' else 'linked' end)
$$;
create function fluid_private.home_attachment_reservation(r public.home_attachments) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('requestKey',r.request_key,'storagePath',r.owner_id::text||'/home/'||r.id::text||'/'||r.blob_version_id::text,'ref',fluid_private.home_attachment_ref(r),'verified',r.verified)
$$;
create function fluid_private.home_attachment_immutable() returns trigger language plpgsql set search_path='' as $$
begin
 if tg_op='DELETE' then raise exception 'immutable_home_attachment' using errcode='55000'; end if;
 if (to_jsonb(new)-array['verified','project_id','project_revision']) is distinct from (to_jsonb(old)-array['verified','project_id','project_revision']) or (old.verified and not new.verified) or (old.project_id is not null and (new.project_id is distinct from old.project_id or new.project_revision is distinct from old.project_revision)) then raise exception 'immutable_home_attachment' using errcode='55000'; end if;
 return new;
end $$;
create trigger home_attachments_immutable before update or delete on public.home_attachments for each row execute function fluid_private.home_attachment_immutable();
create trigger home_attachment_requests_immutable before update or delete on public.home_attachment_project_requests for each row execute function fluid_private.prevent_history_change();
create function fluid_private.prepare_home_attachment(p_input jsonb,p_byte_length bigint) returns jsonb language plpgsql security definer set search_path='' as $$
declare owner uuid:=fluid_private.home_attachment_owner(); nonce uuid; row public.home_attachments;
begin
 if not fluid_private.standalone_keys(p_input,array['requestKey','name','mimeType','contentHash']) or not fluid_private.logo_uuid(p_input->'requestKey') or jsonb_typeof(p_input->'name') is distinct from 'string' or length(p_input->>'name') not between 1 and 255 or jsonb_typeof(p_input->'mimeType') is distinct from 'string' or p_input->>'mimeType' not in('text/plain','application/pdf','image/png','image/jpeg') or jsonb_typeof(p_input->'contentHash') is distinct from 'string' or p_input->>'contentHash'!~'^[0-9a-f]{64}$' or p_byte_length is null or p_byte_length not between 1 and 10485760 or octet_length(p_input::text)>32768 then raise exception 'invalid_home_attachment' using errcode='22023'; end if;
 nonce:=(p_input->>'requestKey')::uuid; perform pg_advisory_xact_lock(hashtextextended(owner::text||':home-upload:'||nonce::text,0));
 select * into row from public.home_attachments where owner_id=owner and request_key=nonce for update;
 if found then if row.input<>p_input or row.byte_length<>p_byte_length then raise exception 'home_request_conflict' using errcode='40001'; end if; return fluid_private.home_attachment_reservation(row); end if;
 insert into public.home_attachments(owner_id,request_key,input,name,mime_type,content_hash,byte_length) values(owner,nonce,p_input,p_input->>'name',p_input->>'mimeType',p_input->>'contentHash',p_byte_length) returning * into row;
 return fluid_private.home_attachment_reservation(row);
end $$;
create function fluid_private.observe_home_attachment(p_id uuid,p_observed jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare owner uuid:=fluid_private.home_attachment_owner(); row public.home_attachments;
begin
 select * into row from public.home_attachments where id=p_id and owner_id=owner for update;
 if not found then raise exception 'home_attachment_not_found' using errcode='P0002'; end if;
 if not fluid_private.standalone_keys(p_observed,array['contentHash','mimeType','byteLength']) or p_observed is distinct from jsonb_build_object('contentHash',row.content_hash,'mimeType',row.mime_type,'byteLength',row.byte_length) then raise exception 'invalid_home_observation' using errcode='22023'; end if;
 if not row.verified then update public.home_attachments set verified=true where id=row.id returning * into row; end if;
 return fluid_private.home_attachment_ref(row,true);
end $$;
create function fluid_private.lookup_home_attachment(p_request_key uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare owner uuid:=fluid_private.home_attachment_owner(); row public.home_attachments;
begin select * into row from public.home_attachments where owner_id=owner and request_key=p_request_key;
 if not found then return null; end if; return fluid_private.home_attachment_reservation(row); end $$;
create function fluid_private.resolve_home_attachments(p_ids uuid[]) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare owner uuid:=fluid_private.home_attachment_owner(); v_attachment_id uuid; row public.home_attachments; result jsonb:='[]';
begin
 if p_ids is null or cardinality(p_ids)>5 or array_position(p_ids,null) is not null or cardinality(p_ids)<>(select count(distinct v) from unnest(p_ids) v) then raise exception 'invalid_home_ids' using errcode='22023'; end if;
 foreach v_attachment_id in array p_ids loop select * into row from public.home_attachments where home_attachments.id=v_attachment_id and owner_id=owner; if not found then raise exception 'home_attachment_not_found' using errcode='P0002'; end if; result:=result||jsonb_build_array(fluid_private.home_attachment_reservation(row)); end loop; return result;
end $$;
create function public.read_home_attachment_request(p_request_key uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare owner uuid:=auth.uid(); row public.home_attachments;
begin
 if owner is null then raise exception 'unauthenticated' using errcode='42501'; end if;
 select * into row from public.home_attachments where owner_id=owner and request_key=p_request_key;
 if not found then return jsonb_build_object('status','not_found'); end if;
 if not row.verified then return jsonb_build_object('status','pending','requestKey',p_request_key); end if;
 return jsonb_build_object('status','committed','receipt',fluid_private.home_attachment_ref(row,true));
end $$;
create function public.save_attached_home_project(p_input jsonb,p_context_text text) returns jsonb language plpgsql security definer set search_path='' as $$
declare owner uuid:=auth.uid(); nonce uuid; body jsonb; ids uuid[]; v_attachment_id uuid; row public.home_attachments; previous public.home_attachment_project_requests; total bigint:=0; p public.projects; refs jsonb:='[]'; result jsonb;
begin
 if owner is null then raise exception 'unauthenticated' using errcode='42501'; end if;
 if not fluid_private.standalone_keys(p_input,array['requestKey','project','attachmentIds']) or not fluid_private.logo_uuid(p_input->'requestKey') or octet_length(p_input::text)>32768 or jsonb_typeof(p_input->'attachmentIds') is distinct from 'array' then raise exception 'invalid_home_project' using errcode='22023'; end if;
 if jsonb_array_length(p_input->'attachmentIds')>5 or exists(select 1 from jsonb_array_elements(p_input->'attachmentIds') v where not fluid_private.logo_uuid(v)) then raise exception 'invalid_home_ids' using errcode='22023'; end if;
 select coalesce(array_agg(value::uuid order by n),'{}'::uuid[]) into ids from jsonb_array_elements_text(p_input->'attachmentIds') with ordinality v(value,n);
 if cardinality(ids)<>(select count(distinct v) from unnest(ids) v) then raise exception 'duplicate_home_ids' using errcode='22023'; end if;
 body:=p_input->'project';
 if not fluid_private.standalone_keys(body,array['title','scope','context']) or jsonb_typeof(body->'title') is distinct from 'string' or length(body->>'title') not between 1 and 160 or body->>'title'<>fluid_private.idea_trim(body->>'title') or jsonb_typeof(body->'scope') is distinct from 'string' or body->>'scope' not in('complete_brand','naming_only','visual_identity_only') or jsonb_typeof(body->'context') is distinct from 'object' or p_context_text is null or octet_length(p_context_text)>32768 or p_context_text::jsonb is distinct from body->'context' then raise exception 'invalid_home_context' using errcode='22023'; end if;
 if fluid_private.identity_material_context(body->'context') is distinct from body->'context' then raise exception 'invalid_home_context' using errcode='22023'; end if;
 nonce:=(p_input->>'requestKey')::uuid; perform pg_advisory_xact_lock(hashtextextended(owner::text||':home-project:'||nonce::text,0));
 select * into previous from public.home_attachment_project_requests where owner_id=owner and request_key=nonce;
 if found then if previous.input<>p_input then raise exception 'home_request_conflict' using errcode='40001'; end if; return previous.receipt; end if;
 -- Deterministic row lock order avoids cross-request deadlocks. Every file must
 -- still be verified, owned and unlinked before creating any project rows.
 perform 1 from public.home_attachments where owner_id=owner and home_attachments.id=any(ids) order by home_attachments.id for update;
 foreach v_attachment_id in array ids loop
  select * into row from public.home_attachments where home_attachments.id=v_attachment_id and owner_id=owner;
  if not found then raise exception 'home_attachment_not_found' using errcode='P0002'; end if;
  if not row.verified or row.project_id is not null then raise exception 'home_attachment_conflict' using errcode='40001'; end if;
  total:=total+row.byte_length;
 end loop;
 if total>26214400 then raise exception 'home_aggregate_limit' using errcode='22023'; end if;
 p:=public.create_project(body->>'scope',body->>'title',body->'context',encode(sha256(convert_to(p_context_text,'UTF8')),'hex'));
 foreach v_attachment_id in array ids loop
  update public.home_attachments set project_id=p.id,project_revision=1 where home_attachments.id=v_attachment_id and owner_id=owner and verified and project_id is null returning * into row;
  if not found then raise exception 'home_attachment_conflict' using errcode='40001'; end if;
  refs:=refs||jsonb_build_array(fluid_private.home_attachment_ref(row));
 end loop;
 result:=jsonb_build_object('ownerId',owner,'requestKey',nonce,'project',jsonb_build_object('id',p.id,'owner_id',owner,'title',p.title,'scope',p.scope,'current_revision',1,'created_at',fluid_private.idea_timestamp(p.created_at),'context',body->'context'),'attachments',refs);
 insert into public.home_attachment_project_requests(owner_id,request_key,project_id,input,receipt) values(owner,nonce,p.id,p_input,result);
 return result;
end $$;
create function public.read_attached_home_project_request(p_request_key uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare owner uuid:=auth.uid(); result jsonb;
begin
 if owner is null then raise exception 'unauthenticated' using errcode='42501'; end if;
 select receipt into result from public.home_attachment_project_requests where owner_id=owner and request_key=p_request_key;
 return case when found then jsonb_build_object('status','committed','receipt',result) else jsonb_build_object('status','not_found') end;
end $$;
-- Scrub hostile inherited/default ACLs on the exact new inventory only. Do not
-- change default privileges or overloads belonging to another package.
do $$ declare object_name text; object_id oid; r record; c record; signature text; begin
 foreach object_name in array array['fluid_private.home_attachment_principals','public.home_attachments','public.home_attachment_project_requests'] loop
  object_id:=to_regclass(object_name);
  execute format('alter table %s enable row level security',object_id::regclass); execute format('alter table %s force row level security',object_id::regclass);
  for r in select distinct a.grantee from pg_class t cross join lateral aclexplode(coalesce(t.relacl,acldefault('r',t.relowner))) a where t.oid=object_id and a.grantee<>t.relowner loop execute format('revoke all on table %s from %s cascade',object_id::regclass,case when r.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(r.grantee)) end); end loop;
  for c in select at.attname,a.grantee from pg_attribute at join pg_class t on t.oid=at.attrelid cross join lateral aclexplode(at.attacl) a where t.oid=object_id and a.grantee<>t.relowner loop execute format('revoke all (%I) on table %s from %s cascade',c.attname,object_id::regclass,case when c.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(c.grantee)) end); end loop;
 end loop;
 foreach signature in array array['fluid_private.home_attachment_owner()','fluid_private.home_attachment_ref(public.home_attachments,boolean)','fluid_private.home_attachment_reservation(public.home_attachments)','fluid_private.home_attachment_immutable()','fluid_private.prepare_home_attachment(jsonb,bigint)','fluid_private.observe_home_attachment(uuid,jsonb)','fluid_private.lookup_home_attachment(uuid)','fluid_private.resolve_home_attachments(uuid[])','public.read_home_attachment_request(uuid)','public.save_attached_home_project(jsonb,text)','public.read_attached_home_project_request(uuid)'] loop
  for r in select distinct a.grantee from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where p.oid=to_regprocedure(signature) and a.grantee<>p.proowner loop execute format('revoke all on function %s from %s cascade',signature,case when r.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(r.grantee)) end); end loop;
 end loop;
end $$;
grant select on public.home_attachments,public.home_attachment_project_requests to authenticated;
create policy home_attachment_owner_read on public.home_attachments for select to authenticated using(owner_id=(select auth.uid()));
create policy home_attachment_project_owner_read on public.home_attachment_project_requests for select to authenticated using(owner_id=(select auth.uid()));
grant execute on function public.read_home_attachment_request(uuid),public.save_attached_home_project(jsonb,text),public.read_attached_home_project_request(uuid) to authenticated;
commit;
