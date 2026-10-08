-- Local-only candidate. No roles, credentials, hosted activation or broad grants.
begin;
-- This is the authoritative activation order, allocated under the project lock.
-- Older rows remain NULL rather than inventing their global publication order.
alter table public.logo_stage_revisions add column workspace_revision bigint check(workspace_revision between 1 and 9007199254740991);
create unique index logo_stage_workspace_activation on public.logo_stage_revisions(owner_id,project_id,workspace_revision) where workspace_revision is not null;
create table fluid_private.logo_asset_web_principals(role_name name primary key,role_oid oid not null unique,owner_id uuid not null);
revoke all on fluid_private.logo_asset_web_principals from public,anon,authenticated,service_role;
create function fluid_private.logo_asset_web_owner() returns uuid language plpgsql stable security definer set search_path='' as $$
declare r pg_catalog.pg_roles; result uuid;
begin
 select * into r from pg_catalog.pg_roles where rolname=session_user;
 if r.oid is null or not r.rolcanlogin or r.rolsuper or r.rolinherit or r.rolcreatedb or r.rolcreaterole or r.rolreplication or r.rolbypassrls or exists(select 1 from pg_catalog.pg_auth_members where member=r.oid) then raise exception 'logo_web_principal_invalid' using errcode='42501';end if;
 select owner_id into result from fluid_private.logo_asset_web_principals where role_name=session_user and role_oid=r.oid;
 if result is null then raise exception 'logo_web_principal_unbound' using errcode='42501';end if;return result;
end $$;
create table public.logo_asset_publications(
 id uuid primary key default gen_random_uuid(),owner_id uuid not null,project_id uuid not null,request_key uuid not null,request jsonb not null,
 asset_id uuid not null default gen_random_uuid(),version_id uuid not null default gen_random_uuid(),content_hash text not null check(content_hash~'^[0-9a-f]{64}$'),mime_type text not null,byte_length bigint not null check(byte_length between 1 and 52428800),
 purpose text not null check(purpose in('brand_asset','reference_media','input_attachment')),source_receipt_id uuid not null,rights_evidence_id uuid,source_kind text not null,
 state text not null default 'reserved' check(state in('reserved','staged','committed')),verification jsonb,job_id uuid,lease_token uuid,input_revision integer not null,input_hash text not null,
 created_at timestamptz not null default clock_timestamp(),unique(owner_id,project_id,request_key),unique(version_id),
 foreign key(project_id,owner_id) references public.projects(id,owner_id),foreign key(job_id,owner_id,project_id) references public.jobs(id,owner_id,project_id),
 foreign key(project_id,owner_id,input_revision) references public.project_revisions(project_id,owner_id,revision),
 check((job_id is null)=(lease_token is null)),check((state='reserved')=(verification is null)),check(octet_length(request::text)<=32768)
);
create table public.logo_vector_revisions(
 id uuid primary key,owner_id uuid not null,project_id uuid not null,record jsonb not null,unique(id,owner_id,project_id),
 foreign key(project_id,owner_id) references public.projects(id,owner_id),
 check(record->>'id'=id::text and record->>'ownerId'=owner_id::text and record->>'projectId'=project_id::text and record->>'reviewStatus'='review_required' and octet_length(record::text)<=65536)
);
create table public.logo_approvals(
 id uuid primary key,owner_id uuid not null,project_id uuid not null,vector_revision_id uuid not null,stage_revision_id uuid not null,record jsonb not null,
 unique(id,owner_id,project_id),foreign key(vector_revision_id,owner_id,project_id) references public.logo_vector_revisions(id,owner_id,project_id),
 check(record->>'id'=id::text and record->>'ownerId'=owner_id::text and record->>'projectId'=project_id::text and record->>'vectorRevisionId'=vector_revision_id::text and record->>'stageRevisionId'=stage_revision_id::text)
);
create table public.logo_font_records(
 record_id uuid primary key,version_id uuid not null unique,owner_id uuid not null,project_id uuid not null,record jsonb not null,
 foreign key(project_id,owner_id) references public.projects(id,owner_id),check(record->>'id'=record_id::text and record#>>'{asset,versionId}'=version_id::text and record#>>'{asset,ownerId}'=owner_id::text and record#>>'{asset,projectId}'=project_id::text)
);
-- Default ACLs may name arbitrary roles, including grant-option holders. Scrub
-- only these exact newly created relations before granting any public reads.
do $$declare object_name text;object_id oid;r record;c record;begin
 foreach object_name in array array['fluid_private.logo_asset_web_principals','public.logo_asset_publications','public.logo_vector_revisions','public.logo_approvals','public.logo_font_records'] loop
  object_id:=to_regclass(object_name);
  for r in select distinct a.grantee from pg_class t cross join lateral aclexplode(coalesce(t.relacl,acldefault('r',t.relowner))) a where t.oid=object_id and a.grantee<>t.relowner loop
   execute format('revoke all on table %s from %s cascade',object_id::regclass,case when r.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(r.grantee)) end);
  end loop;
  for c in select at.attname,a.grantee from pg_attribute at join pg_class t on t.oid=at.attrelid cross join lateral aclexplode(at.attacl) a where t.oid=object_id and a.grantee<>t.relowner loop
   execute format('revoke all (%I) on table %s from %s cascade',c.attname,object_id::regclass,case when c.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(c.grantee)) end);
  end loop;
 end loop;
end $$;
create trigger logo_vector_revisions_immutable before update or delete on public.logo_vector_revisions for each row execute function fluid_private.prevent_history_change();
create trigger logo_approvals_immutable before update or delete on public.logo_approvals for each row execute function fluid_private.prevent_history_change();
create trigger logo_font_records_immutable before update or delete on public.logo_font_records for each row execute function fluid_private.prevent_history_change();
create function fluid_private.logo_asset_reservation(r public.logo_asset_publications) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('id',r.id,'requestKey',r.request_key,'reference',jsonb_build_object('ownerId',r.owner_id,'projectId',r.project_id,'assetId',r.asset_id,'versionId',r.version_id,'contentHash',r.content_hash),
 'storagePath',r.owner_id::text||'/'||r.project_id::text||'/'||r.asset_id::text||'/'||r.version_id::text,'mimeType',r.mime_type,'byteLength',r.byte_length,'purpose',r.purpose,'sourceReceiptId',r.source_receipt_id,'rightsEvidenceId',r.rights_evidence_id,'publicationState',case when r.state='committed' then 'committed' else 'staged' end)
$$;
create function fluid_private.logo_asset_receipt(r public.logo_asset_publications) returns jsonb language plpgsql stable set search_path='' as $$
begin
 if r.verification is null or r.state='reserved' then raise exception 'logo_asset_not_verified' using errcode='55000';end if;
 return (fluid_private.logo_asset_reservation(r)-array['requestKey','storagePath','mimeType','byteLength'])||jsonb_build_object('verification',r.verification);
end $$;
create function fluid_private.logo_asset_job(p_owner uuid,p_project uuid,p_job uuid,p_lease uuid) returns public.jobs language plpgsql set search_path='' as $$
declare j public.jobs;
begin
 select * into j from public.jobs where id=p_job and owner_id=p_owner and project_id=p_project for update;
 if not found or j.lease_token is distinct from p_lease or j.lease_expires_at<=clock_timestamp() or j.state not in('running','cancel_requested') or j.operation not in('identity.logo_concept','identity.logo_refine','identity.logo_vectorize','identity.logo_directions','identity.logo_export') then raise exception 'logo_lease_invalid' using errcode='55000';end if;return j;
end $$;
create function fluid_private.prepare_logo_asset(p_project uuid,p_write jsonb,p_job uuid,p_lease uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare owner uuid;project public.projects;j public.jobs;b jsonb;k text;sid uuid;purpose text;rights uuid;existing public.logo_asset_publications;result public.logo_asset_publications;length bigint;input_revision integer;input_hash text;item jsonb;
begin
 if (p_job is null)<>(p_lease is null) then raise exception 'invalid_logo_asset_access' using errcode='22023';end if;
 if p_job is null then owner:=fluid_private.logo_asset_web_owner();else owner:=fluid_private.logo_worker_owner();end if;
 select * into project from public.projects where id=p_project and owner_id=owner for update;
 if not found then raise exception 'logo_project_not_found' using errcode='P0002';end if;
 if p_job is not null then j:=fluid_private.logo_asset_job(owner,p_project,p_job,p_lease);end if;
 if octet_length(p_write::text)>32768 or jsonb_typeof(p_write) is distinct from 'object' then raise exception 'invalid_logo_asset_request' using errcode='22023';end if;
 if p_write->>'kind'='stage' then
  if not fluid_private.standalone_keys(p_write,array['kind','publication']) then raise exception 'invalid_logo_asset_request' using errcode='22023';end if;
  b:=p_write->'publication';
  if jsonb_typeof(b->'byteLength') is distinct from 'number' then raise exception 'invalid_logo_asset_length' using errcode='22023';end if;
  if not fluid_private.standalone_keys(b,array['requestKey','inputRevisions','mimeType','contentHash','byteLength','source']) or not fluid_private.standalone_keys(b->'source',array['kind','sourceId']) or not fluid_private.logo_uuid(b#>'{source,sourceId}') or b#>>'{source,kind}' not in('concept','vector','direction','variant','export') or jsonb_typeof(b->'inputRevisions') is distinct from 'array' then raise exception 'invalid_logo_publication' using errcode='22023';end if;
  k:=b#>>'{source,kind}';sid:=(b#>>'{source,sourceId}')::uuid;purpose:='brand_asset';length:=(b->>'byteLength')::bigint;
  if p_job is not null then
   if (j.operation='identity.logo_concept' and (k<>'concept' or sid::text<>j.input->>'attemptId'))
    or (j.operation='identity.logo_refine' and not((k='concept' and sid::text=j.input->>'rasterRevisionId') or(k='vector' and sid=j.id)))
    or(j.operation='identity.logo_vectorize' and (k<>'vector' or sid<>j.id))
    or(j.operation='identity.logo_directions' and (k<>'direction' or sid<>j.id))
    or(j.operation='identity.logo_export' and (k<>'export' or sid<>j.id))
    or b->'inputRevisions' is distinct from fluid_private.logo_job_input_revisions(j) then raise exception 'logo_unlisted_source' using errcode='42501';end if;
  else
   if k='vector' then
    if not exists(select 1 from public.logo_vector_revisions where id=sid and owner_id=owner and project_id=p_project and record->'inputRevisions'=b->'inputRevisions') then raise exception 'logo_vector_source_not_found' using errcode='P0002';end if;
   elsif k='variant' then
    if not exists(select 1 from public.logo_approvals where id=sid and owner_id=owner and project_id=p_project) then raise exception 'logo_approval_not_found' using errcode='P0002';end if;
   else raise exception 'logo_manual_source_unavailable' using errcode='55000';end if;
  end if;
 else
  if p_write->>'kind'<>'upload' or p_job is not null or not fluid_private.standalone_keys(p_write,array['kind','intent','byteLength']) then raise exception 'invalid_logo_upload' using errcode='22023';end if;
  b:=p_write->'intent';
  if jsonb_typeof(p_write->'byteLength') is distinct from 'number' then raise exception 'invalid_logo_asset_length' using errcode='22023';end if;
  if not fluid_private.standalone_keys(b,array['requestKey','usage','mimeType','contentHash','rightsDeclaration']) or b->>'usage' not in('logo_reference','font') or not fluid_private.standalone_text(b->'rightsDeclaration',2000,1) then raise exception 'invalid_logo_upload' using errcode='22023';end if;
  if (b->>'usage'='logo_reference' and b->>'mimeType' not in('image/png','image/jpeg','image/webp')) or (b->>'usage'='font' and b->>'mimeType' not in('font/ttf','font/otf','font/woff','font/woff2')) then raise exception 'invalid_logo_upload_mime' using errcode='22023';end if;
  k:=b->>'usage';sid:=gen_random_uuid();rights:=gen_random_uuid();purpose:=case when k='logo_reference' then 'reference_media' else 'brand_asset' end;length:=(p_write->>'byteLength')::bigint;
 end if;
 if not fluid_private.logo_uuid(b->'requestKey') or jsonb_typeof(b->'contentHash') is distinct from 'string' or b->>'contentHash' !~ '^[0-9a-f]{64}$' or jsonb_typeof(b->'mimeType') is distinct from 'string' or b->>'mimeType' !~ '^[a-z0-9.+-]+/[a-z0-9.+-]+$' or length(b->>'mimeType')>150 or length not between 1 and 52428800 then raise exception 'invalid_logo_asset_metadata' using errcode='22023';end if;
 select * into existing from public.logo_asset_publications where owner_id=owner and project_id=p_project and request_key=(b->>'requestKey')::uuid;
 if found then
  if existing.request is distinct from p_write or existing.job_id is distinct from p_job then raise exception 'logo_asset_request_conflict' using errcode='PT409';end if;
  return fluid_private.logo_asset_reservation(existing);
 end if;
 input_revision:=case when p_job is null then project.current_revision else j.input_revision end;input_hash:=case when p_job is null then encode(sha256(convert_to(p_write::text,'UTF8')),'hex') else j.input_hash end;
 insert into public.logo_asset_publications(owner_id,project_id,request_key,request,content_hash,mime_type,byte_length,purpose,source_receipt_id,rights_evidence_id,source_kind,job_id,lease_token,input_revision,input_hash)
 values(owner,p_project,(b->>'requestKey')::uuid,p_write,b->>'contentHash',b->>'mimeType',length,purpose,sid,rights,k,p_job,p_lease,input_revision,input_hash) returning * into result;
 return fluid_private.logo_asset_reservation(result);
exception when invalid_text_representation or numeric_value_out_of_range then raise exception 'invalid_logo_asset_request' using errcode='22023';
end $$;
create function fluid_private.logo_commit_asset(r public.logo_asset_publications) returns jsonb language plpgsql set search_path='' as $$
begin
 if r.state='reserved' or r.verification is null then raise exception 'logo_asset_not_verified' using errcode='55000';end if;
 if r.state<>'committed' then
  insert into public.assets(id,owner_id,project_id,kind,purpose) values(r.asset_id,r.owner_id,r.project_id,'logo_'||r.source_kind,r.purpose);
  insert into public.asset_versions(id,owner_id,project_id,asset_id,version,input_revision,input_hash,content_hash,mime_type,storage_path,provenance)
   values(r.version_id,r.owner_id,r.project_id,r.asset_id,1,r.input_revision,r.input_hash,r.content_hash,r.mime_type,r.owner_id::text||'/'||r.project_id::text||'/'||r.asset_id::text||'/'||r.version_id::text,jsonb_build_object('version',2,'publicationId',r.id,'sourceReceiptId',r.source_receipt_id));
  update public.logo_asset_publications set state='committed' where id=r.id returning * into r;
 end if;
 return fluid_private.logo_asset_receipt(r);
end $$;
create function fluid_private.commit_logo_asset_publication(p_job public.jobs,p_publication uuid) returns jsonb language plpgsql set search_path='' as $$
declare j public.jobs;r public.logo_asset_publications;
begin
 j:=fluid_private.logo_asset_job(p_job.owner_id,p_job.project_id,p_job.id,p_job.lease_token);
 select * into r from public.logo_asset_publications where id=p_publication and owner_id=j.owner_id and project_id=j.project_id and job_id=j.id and lease_token=j.lease_token for update;
 if not found then raise exception 'logo_publication_not_found' using errcode='P0002';end if;
 return fluid_private.logo_commit_asset(r);
end $$;
create function fluid_private.observe_logo_asset(p_id uuid,p_observation jsonb,p_job uuid,p_lease uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare owner uuid;r public.logo_asset_publications;j public.jobs;
begin
 if p_job is null then owner:=fluid_private.logo_asset_web_owner();else owner:=fluid_private.logo_worker_owner();end if;
 select * into r from public.logo_asset_publications where id=p_id and owner_id=owner;
 if not found then raise exception 'logo_publication_not_found' using errcode='P0002';end if;
 perform 1 from public.projects where id=r.project_id and owner_id=owner for update;
 if p_job is not null then j:=fluid_private.logo_asset_job(owner,r.project_id,p_job,p_lease);end if;
 select * into r from public.logo_asset_publications where id=p_id for update;
 if r.job_id is distinct from p_job or (p_job is not null and r.lease_token is distinct from p_lease) then raise exception 'logo_lease_invalid' using errcode='55000';end if;
 if not fluid_private.standalone_keys(p_observation,array['status','checkedAt','contentHash','mimeType','byteLength']) or p_observation->>'status'<>'verified' or not fluid_private.standalone_timestamp(p_observation->'checkedAt') or length(p_observation->>'checkedAt')>64 or p_observation->>'contentHash' is distinct from r.content_hash or p_observation->>'mimeType' is distinct from r.mime_type or p_observation->'byteLength' is distinct from to_jsonb(r.byte_length) then raise exception 'invalid_logo_verification' using errcode='22023';end if;
 if r.state='reserved' then update public.logo_asset_publications set state='staged',verification=p_observation where id=r.id returning * into r;end if;
 if p_job is null and r.request->>'kind'='upload' then return fluid_private.logo_commit_asset(r);end if;
 return fluid_private.logo_asset_receipt(r);
end $$;
create function fluid_private.read_logo_asset_publication(p_project uuid,p_reference jsonb,p_job uuid,p_lease uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare owner uuid;r public.logo_asset_publications;j public.jobs;allowed boolean;
begin
 if p_job is null then owner:=fluid_private.logo_asset_web_owner();else owner:=fluid_private.logo_worker_owner();end if;
 if p_job is not null then j:=fluid_private.logo_asset_job(owner,p_project,p_job,p_lease);end if;
 select * into r from public.logo_asset_publications where owner_id=owner and project_id=p_project and version_id=(p_reference->>'versionId')::uuid;
 if not found or (fluid_private.logo_asset_reservation(r)->'reference') is distinct from p_reference then raise exception 'logo_asset_not_found' using errcode='P0002';end if;
 if p_job is null and r.state<>'committed' then raise exception 'logo_asset_not_committed' using errcode='P0002';end if;
 if p_job is not null then
  allowed:=(r.job_id=j.id and r.lease_token=j.lease_token) or fluid_private.logo_job_can_read_asset(j,p_reference);
  if not coalesce(allowed,false) then raise exception 'logo_unlisted_source' using errcode='42501';end if;
 end if;
 return fluid_private.logo_asset_reservation(r);
end $$;
create function public.read_logo_asset(p_reference jsonb) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare r public.logo_asset_publications;owner uuid:=auth.uid();
begin
 if owner is null then raise exception 'unauthenticated' using errcode='42501';end if;
 select * into r from public.logo_asset_publications where owner_id=owner and version_id=(p_reference->>'versionId')::uuid and state='committed';
 if not found or fluid_private.logo_asset_reservation(r)->'reference' is distinct from p_reference then raise exception 'logo_asset_not_found' using errcode='P0002';end if;return fluid_private.logo_asset_reservation(r);
end $$;
create function public.read_logo_font_record(p_font_version_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
 if auth.uid() is null then raise exception 'unauthenticated' using errcode='42501';end if;
 select record into result from public.logo_font_records where record_id=p_font_version_id and owner_id=auth.uid();
 if result is null then raise exception 'logo_font_not_found' using errcode='P0002';end if;return result;
end $$;
-- Narrow cleanup of privileges on these exact new signatures only.
do $$declare t text;s text;r record;begin
 foreach t in array array['logo_asset_publications','logo_vector_revisions','logo_approvals','logo_font_records'] loop
  execute format('revoke all on table public.%I from public,anon,authenticated,service_role',t);
  execute format('alter table public.%I enable row level security',t);execute format('alter table public.%I force row level security',t);
  execute format('create policy logo_source_owned_read on public.%I for select to authenticated using(owner_id=auth.uid()%s)',t,case when t='logo_asset_publications' then ' and state=''committed''' else '' end);
  execute format('grant select on table public.%I to authenticated',t);
 end loop;
 foreach s in array array['fluid_private.logo_asset_web_owner()','fluid_private.logo_asset_reservation(public.logo_asset_publications)','fluid_private.logo_asset_receipt(public.logo_asset_publications)','fluid_private.logo_asset_job(uuid,uuid,uuid,uuid)','fluid_private.prepare_logo_asset(uuid,jsonb,uuid,uuid)','fluid_private.logo_commit_asset(public.logo_asset_publications)','fluid_private.commit_logo_asset_publication(public.jobs,uuid)','fluid_private.observe_logo_asset(uuid,jsonb,uuid,uuid)','fluid_private.read_logo_asset_publication(uuid,jsonb,uuid,uuid)','public.read_logo_asset(jsonb)','public.read_logo_font_record(uuid)'] loop
  for r in select distinct a.grantee from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where p.oid=to_regprocedure(s) and a.grantee<>p.proowner loop execute format('revoke all on function %s from %s',s,case when r.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(r.grantee)) end);end loop;
 end loop;
end $$;
grant execute on function public.read_logo_asset(jsonb),public.read_logo_font_record(uuid) to authenticated;
create function fluid_private.logo_stage_payload_valid(p_stage text,p jsonb) returns boolean language plpgsql immutable set search_path='' as $$
declare key text;item jsonb;items jsonb;
begin
 case p_stage
 when 'concepts' then
  if not fluid_private.standalone_keys(p,array['batchIds','selected']) or jsonb_typeof(p->'batchIds') is distinct from 'array' then return false;end if;
  items:=p->'batchIds';
  if p->'selected'<>'null'::jsonb then
   if p#>>'{selected,kind}'='concept' then
    if not fluid_private.standalone_keys(p->'selected',array['kind','batchId','slotId','attemptId']) or not fluid_private.logo_uuid(p#>'{selected,batchId}') or not fluid_private.logo_uuid(p#>'{selected,slotId}') or not fluid_private.logo_uuid(p#>'{selected,attemptId}') or not(items ? (p#>>'{selected,batchId}')) then return false;end if;
   elsif p#>>'{selected,kind}'='refinement' then
    if not fluid_private.standalone_keys(p->'selected',array['kind','rasterRevisionId']) or not fluid_private.logo_uuid(p#>'{selected,rasterRevisionId}') then return false;end if;
   else return false;end if;
  end if;
 when 'vector' then
  return fluid_private.standalone_keys(p,array['vectorRevisionId','approvalId']) and fluid_private.logo_uuid(p->'vectorRevisionId') and(p->'approvalId'='null'::jsonb or fluid_private.logo_uuid(p->'approvalId'));
 when 'refinements' then
  if not fluid_private.standalone_keys(p,array['rasterRevisionIds','vectorRevisionId','approvalId','sourceRequestKey']) or jsonb_typeof(p->'rasterRevisionIds') is distinct from 'array' then return false;end if;
  foreach key in array array['vectorRevisionId','approvalId','sourceRequestKey'] loop if p->key<>'null'::jsonb and not fluid_private.logo_uuid(p->key) then return false;end if;end loop;
  if p->'approvalId'<>'null'::jsonb and p->'vectorRevisionId'='null'::jsonb then return false;end if;items:=p->'rasterRevisionIds';
 when 'directions' then
  if not fluid_private.standalone_keys(p,array['directionIds','selectionId','approvalId']) or jsonb_typeof(p->'directionIds') is distinct from 'array' or jsonb_array_length(p->'directionIds')<>3 then return false;end if;
  foreach key in array array['selectionId','approvalId'] loop if p->key<>'null'::jsonb and not fluid_private.logo_uuid(p->key) then return false;end if;end loop;
  if p->'approvalId'<>'null'::jsonb and p->'selectionId'='null'::jsonb then return false;end if;items:=p->'directionIds';
 when 'deliverables' then
  if not fluid_private.standalone_keys(p,array['variantSetId','exportManifestIds']) or jsonb_typeof(p->'exportManifestIds') is distinct from 'array' or(p->'variantSetId'<>'null'::jsonb and not fluid_private.logo_uuid(p->'variantSetId')) then return false;end if;items:=p->'exportManifestIds';
 else return false;
 end case;
 if jsonb_array_length(items)>1000 or(select count(*)<>count(distinct value) from jsonb_array_elements(items)) then return false;end if;
 for item in select value from jsonb_array_elements(items) loop if not fluid_private.logo_uuid(item) then return false;end if;end loop;return true;
exception when others then return false;
end $$;
create function fluid_private.logo_append_stage(p_owner uuid,p_project uuid,p_stage text,p_payload jsonb,p_inputs jsonb) returns jsonb language plpgsql set search_path='' as $$
declare prior public.logo_stage_revisions;new_id uuid:=gen_random_uuid();result jsonb;item jsonb;next_workspace_revision bigint;
begin
 if not fluid_private.logo_stage_payload_valid(p_stage,p_payload) or jsonb_typeof(p_inputs) is distinct from 'array' or jsonb_array_length(p_inputs)>100 then raise exception 'invalid_logo_stage_payload' using errcode='22023';end if;
 perform 1 from public.projects where id=p_project and owner_id=p_owner for update;
 if not found then raise exception 'logo_project_not_found' using errcode='P0002';end if;
 select coalesce(max(w.revision),0)+1 into next_workspace_revision from public.logo_workspaces w where w.owner_id=p_owner and w.project_id=p_project;
 for item in select value from jsonb_array_elements(p_inputs) loop
  if not fluid_private.standalone_keys(item,array['stage','id','revision']) or not exists(select 1 from public.logo_stage_revisions r where r.owner_id=p_owner and r.project_id=p_project and r.id::text=item->>'id' and r.stage=item->>'stage' and to_jsonb(r.revision)=item->'revision') then raise exception 'invalid_logo_input_source' using errcode='55000';end if;
 end loop;
 if(select count(*)<>count(distinct value->>'id') from jsonb_array_elements(p_inputs)) then raise exception 'duplicate_logo_input' using errcode='55000';end if;
 select r.* into prior from public.logo_stage_heads h join public.logo_stage_revisions r on r.id=h.revision_id and r.owner_id=h.owner_id and r.project_id=h.project_id where h.owner_id=p_owner and h.project_id=p_project and h.stage=p_stage;
 result:=jsonb_build_object('version',2,'id',new_id,'ownerId',p_owner,'projectId',p_project,'stage',p_stage,'revision',coalesce(prior.revision,0)+1,'parentRevisionId',prior.id,'inputRevisions',p_inputs,'inputHash',encode(sha256(convert_to(jsonb_build_object('payload',p_payload,'inputs',p_inputs)::text,'UTF8')),'hex'),'payload',p_payload,'createdAt',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
 insert into public.logo_stage_revisions(id,project_id,owner_id,stage,revision,parent_revision_id,record,workspace_revision) values(new_id,p_project,p_owner,p_stage,coalesce(prior.revision,0)+1,prior.id,result,next_workspace_revision);
 insert into public.logo_workspaces(project_id,owner_id,revision) values(p_project,p_owner,1) on conflict(project_id) do update set revision=public.logo_workspaces.revision+1;
 insert into public.logo_stage_heads(project_id,owner_id,stage,revision_id) values(p_project,p_owner,p_stage,new_id) on conflict(project_id,stage) do update set revision_id=excluded.revision_id;
 return result;
end $$;
alter function fluid_private.logo_workspace_json(uuid,uuid) rename to logo_workspace_base_json;
create function fluid_private.logo_workspace_json(p_owner uuid,p_project uuid) returns jsonb language plpgsql stable set search_path='' as $$
declare result jsonb;approval jsonb;
begin
 result:=fluid_private.logo_workspace_base_json(p_owner,p_project);
 select a.record into approval from public.logo_stage_heads h join public.logo_stage_revisions r on r.id=h.revision_id and r.owner_id=h.owner_id and r.project_id=h.project_id join public.logo_approvals a on a.id::text=r.record#>>'{payload,approvalId}' and a.owner_id=h.owner_id and a.project_id=h.project_id where h.owner_id=p_owner and h.project_id=p_project and h.stage='vector';
 return result||jsonb_build_object('approvedLogo',approval);
end $$;
alter function fluid_private.logo_command_valid(jsonb) rename to logo_base_command_valid;
create function fluid_private.logo_command_valid(v jsonb) returns boolean language plpgsql immutable set search_path='' as $$
declare b jsonb:=v->'body';method text:=v->>'method';source jsonb;check_command jsonb;
begin
 if method in('saveLogoBrief','saveLogoReferences','restoreLogoStage') then return fluid_private.logo_base_command_valid(v);end if;
 -- Reuse exact existing key/head/number validation without widening that codec.
 check_command:=jsonb_build_object('method','restoreLogoStage','body',jsonb_build_object('requestKey',b->'requestKey','expected',b->'expected','stage','concepts','revisionId','00000000-0000-4000-8000-000000000001','acceptEarlierBasis',false));
 if not fluid_private.standalone_keys(v,array['method','body']) or octet_length(v::text)>32768 or not fluid_private.logo_base_command_valid(check_command) then return false;end if;
 case method
 when 'selectLogoConcept' then return fluid_private.standalone_keys(b,array['requestKey','expected','batchId','slotId','attemptId']) and fluid_private.logo_uuid(b->'batchId') and fluid_private.logo_uuid(b->'slotId') and fluid_private.logo_uuid(b->'attemptId');
 when 'selectLogoRaster' then
  source:=b->'source';
  if not fluid_private.standalone_keys(b,array['requestKey','expected','source']) then return false;end if;
  return case when source->>'kind'='concept' then fluid_private.standalone_keys(source,array['kind','batchId','slotId','attemptId']) and fluid_private.logo_uuid(source->'batchId') and fluid_private.logo_uuid(source->'slotId') and fluid_private.logo_uuid(source->'attemptId')
   when source->>'kind'='refinement' then fluid_private.standalone_keys(source,array['kind','rasterRevisionId']) and fluid_private.logo_uuid(source->'rasterRevisionId') else false end;
 when 'acceptLogoVector' then return fluid_private.standalone_keys(b,array['requestKey','expected','vectorRevisionId','acceptEarlierBasis']) and fluid_private.logo_uuid(b->'vectorRevisionId') and jsonb_typeof(b->'acceptEarlierBasis')='boolean';
 else return false;
 end case;
exception when others then return false;
end $$;
alter table public.logo_workspace_requests drop constraint logo_workspace_requests_method_check;
alter table public.logo_workspace_requests add constraint logo_workspace_requests_method_check check(method in('startLogoProject','saveLogoBrief','saveLogoReferences','restoreLogoStage','selectLogoConcept','selectLogoRaster','saveLogoEdit','acceptLogoVector','selectIdentityDirectionComponents','approveIdentityDirection','prepareLogoVariants','reviewLogoVariants'));
create function fluid_private.logo_current_vector_id(p_owner uuid,p_project uuid) returns uuid language plpgsql stable set search_path='' as $$
declare result uuid;
begin
 -- Only appended stage revisions are activations. Raw/stale worker candidates
 -- remain separate source records and cannot become current. Later raster-only
 -- revisions must not erase the prior non-null vector activation in this history.
 if exists(select 1 from public.logo_stage_revisions r
  where r.owner_id=p_owner and r.project_id=p_project and r.stage in('refinements','vector') and r.record#>>'{payload,vectorRevisionId}' is not null and r.workspace_revision is null) then
  raise exception 'logo_activation_order_unavailable' using errcode='55000';
 end if;
 select (r.record#>>'{payload,vectorRevisionId}')::uuid into result from public.logo_stage_revisions r
 where r.owner_id=p_owner and r.project_id=p_project and r.stage in('refinements','vector') and r.record#>>'{payload,vectorRevisionId}' is not null
 order by r.workspace_revision desc limit 1;
 if result is not null and not exists(select 1 from public.logo_vector_revisions v where v.id=result and v.owner_id=p_owner and v.project_id=p_project) then raise exception 'logo_current_vector_unavailable' using errcode='55000';end if;
 return result;
end $$;
create function public.read_logo_current_vector(p_project_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare owner uuid:=auth.uid();
begin
 if owner is null then raise exception 'unauthenticated' using errcode='42501';end if;
 if not exists(select 1 from public.projects where id=p_project_id and owner_id=owner) then raise exception 'logo_project_not_found' using errcode='P0002';end if;
 return jsonb_build_object('ownerId',owner,'projectId',p_project_id,'vectorRevisionId',fluid_private.logo_current_vector_id(owner,p_project_id));
end $$;
alter function fluid_private.logo_apply(uuid,uuid,jsonb) rename to logo_apply_brief;
create function fluid_private.logo_apply(p_owner uuid,p_project uuid,p_command jsonb) returns jsonb language plpgsql set search_path='' as $$
declare b jsonb:=p_command->'body';method text:=p_command->>'method';existing public.logo_workspace_requests;workspace jsonb;target public.logo_stage_revisions;prior public.logo_stage_revisions;payload jsonb;inputs jsonb;revision jsonb;result jsonb;source jsonb;resolved jsonb;batches jsonb;vector jsonb;current_vector jsonb;approval_id uuid;approval jsonb;item jsonb;
begin
 -- Integration delta: serialize the cross-operation key guard with admission.
 if fluid_private.logo_uuid(b->'requestKey') then
  perform 1 from public.projects where id=p_project and owner_id=p_owner for update;
  if not found then raise exception 'logo_project_not_found' using errcode='P0002';end if;
  if to_regclass('public.logo_operation_rejections') is not null then
   if not exists(select 1 from public.logo_workspace_requests req where req.owner_id=p_owner and req.project_id=p_project and req.request_key=(b->>'requestKey')::uuid and req.method<>'startLogoProject') and exists(select 1 from public.logo_operation_rejections req where req.owner_id=p_owner and req.project_id=p_project and req.request_key=(b->>'requestKey')::uuid) then raise exception 'logo_request_conflict' using errcode='PT409';end if;
  end if;
 end if;
 if fluid_private.logo_uuid(b->'requestKey') and to_regclass('public.logo_operation_requests') is not null then
  if not exists(select 1 from public.logo_workspace_requests req where req.owner_id=p_owner and req.project_id=p_project and req.request_key=(b->>'requestKey')::uuid and req.method<>'startLogoProject') and exists(select 1 from public.logo_operation_requests req where req.owner_id=p_owner and req.project_id=p_project and req.request_key=(b->>'requestKey')::uuid) then raise exception 'logo_request_conflict' using errcode='PT409';end if;
 end if;
 if method in('saveLogoBrief','saveLogoReferences') or(method='restoreLogoStage' and b->>'stage'='brief_references') then return fluid_private.logo_apply_brief(p_owner,p_project,p_command);end if;
 if not fluid_private.logo_command_valid(p_command) then raise exception 'invalid_logo_command' using errcode='22023';end if;
 perform 1 from public.projects where id=p_project and owner_id=p_owner for update;
 if not found then raise exception 'logo_project_not_found' using errcode='P0002';end if;
 select * into existing from public.logo_workspace_requests req where req.owner_id=p_owner and req.project_id=p_project and req.request_key=(b->>'requestKey')::uuid and req.method<>'startLogoProject';
 if found then if existing.input is distinct from p_command then raise exception 'logo_request_conflict' using errcode='PT409';end if;return existing.receipt;end if;
 perform 1 from public.identity_reference_heads where owner_id=p_owner and project_id=p_project for update;
 perform 1 from public.identity_sessions where owner_id=p_owner and project_id=p_project for update;
 workspace:=fluid_private.logo_workspace_json(p_owner,p_project);
 if workspace->'heads' is distinct from b->'expected' then raise exception 'logo_head_conflict' using errcode='PT409';end if;
 if method in('selectLogoConcept','selectLogoRaster') then
  source:=case when method='selectLogoConcept' then jsonb_build_object('kind','concept','batchId',b->'batchId','slotId',b->'slotId','attemptId',b->'attemptId') else b->'source' end;
  resolved:=fluid_private.resolve_logo_raster_source(p_owner,p_project,source);
  if resolved->'source' is distinct from source or resolved#>>'{preview,publicationState}'<>'committed' then raise exception 'logo_raster_unavailable' using errcode='55000';end if;
  select r.* into prior from public.logo_stage_heads h join public.logo_stage_revisions r on r.id=h.revision_id where h.owner_id=p_owner and h.project_id=p_project and h.stage='concepts';
  batches:=coalesce(prior.record#>'{payload,batchIds}','[]'::jsonb);
  if source->>'kind'='concept' and not(batches ? (source->>'batchId')) then batches:=batches||jsonb_build_array(source->'batchId');end if;
  revision:=fluid_private.logo_append_stage(p_owner,p_project,'concepts',jsonb_build_object('batchIds',batches,'selected',source),resolved->'inputRevisions');
 elsif method='restoreLogoStage' then
  if b->>'stage' in('vector','refinements') and fluid_private.logo_asset_web_owner()<>p_owner then raise exception 'logo_principal_mismatch' using errcode='42501';end if;
  select * into target from public.logo_stage_revisions where id=(b->>'revisionId')::uuid and owner_id=p_owner and project_id=p_project and stage=b->>'stage';
  if not found then raise exception 'logo_revision_not_found' using errcode='P0002';end if;
  inputs:=target.record->'inputRevisions';payload:=target.record->'payload';
  if exists(select 1 from jsonb_array_elements(inputs) i left join public.logo_stage_heads h on h.owner_id=p_owner and h.project_id=p_project and h.stage=i->>'stage' where h.revision_id::text is distinct from i->>'id') and b->'acceptEarlierBasis'<>'true'::jsonb then raise exception 'logo_earlier_basis_requires_acknowledgement' using errcode='PT409';end if;
  if target.stage in('vector','refinements','directions') then payload:=jsonb_set(payload,'{approvalId}','null');end if;
  if target.stage='directions' then payload:=jsonb_set(payload,'{selectionId}','null');end if;
  if target.stage in('vector','refinements') and payload->'vectorRevisionId'<>'null'::jsonb then
   select record into vector from public.logo_vector_revisions where id=(payload->>'vectorRevisionId')::uuid and owner_id=p_owner and project_id=p_project;
   if vector is null then raise exception 'logo_vector_not_found' using errcode='P0002';end if;
   select v.record into current_vector from public.logo_vector_revisions v where v.owner_id=p_owner and v.project_id=p_project and v.id=fluid_private.logo_current_vector_id(p_owner,p_project);
   for item in select value from jsonb_array_elements(coalesce(current_vector->'locks','[]')) loop
    if not exists(select 1 from jsonb_array_elements(vector->'locks') target_lock where target_lock=item) then raise exception 'logo_restore_lock_conflict' using errcode='PT409';end if;
   end loop;
  end if;
  revision:=fluid_private.logo_append_stage(p_owner,p_project,target.stage,payload,inputs);
 elsif method='acceptLogoVector' then
  if fluid_private.logo_asset_web_owner()<>p_owner then raise exception 'logo_principal_mismatch' using errcode='42501';end if;
  select record into vector from public.logo_vector_revisions where id=(b->>'vectorRevisionId')::uuid and owner_id=p_owner and project_id=p_project;
  if vector is null then raise exception 'logo_vector_not_found' using errcode='P0002';end if;
  inputs:=vector->'inputRevisions';
  if exists(select 1 from jsonb_array_elements(inputs) i left join public.logo_stage_heads h on h.owner_id=p_owner and h.project_id=p_project and h.stage=i->>'stage' where h.revision_id::text is distinct from i->>'id') and b->'acceptEarlierBasis'<>'true'::jsonb then raise exception 'logo_earlier_basis_requires_acknowledgement' using errcode='PT409';end if;
  approval_id:=gen_random_uuid();revision:=fluid_private.logo_append_stage(p_owner,p_project,'vector',jsonb_build_object('vectorRevisionId',b->'vectorRevisionId','approvalId',approval_id),inputs);
  approval:=jsonb_build_object('id',approval_id,'ownerId',p_owner,'projectId',p_project,'vectorRevisionId',b->'vectorRevisionId','stageRevisionId',revision->'id','approvedAt',revision->'createdAt');
  insert into public.logo_approvals(id,owner_id,project_id,vector_revision_id,stage_revision_id,record) values(approval_id,p_owner,p_project,(b->>'vectorRevisionId')::uuid,(revision->>'id')::uuid,approval);
 else raise exception 'logo_producer_unavailable' using errcode='55000';end if;
 result:=jsonb_build_object('ownerId',p_owner,'projectId',p_project,'requestKey',b->'requestKey','revision',revision,'workspace',fluid_private.logo_workspace_json(p_owner,p_project));
 insert into public.logo_workspace_requests(project_id,owner_id,request_key,method,input,receipt) values(p_project,p_owner,(b->>'requestKey')::uuid,method,p_command,result);return result;
end $$;
revoke all on function fluid_private.logo_stage_payload_valid(text,jsonb),fluid_private.logo_append_stage(uuid,uuid,text,jsonb,jsonb),fluid_private.logo_workspace_json(uuid,uuid),fluid_private.logo_command_valid(jsonb),fluid_private.logo_apply(uuid,uuid,jsonb) from public,anon,authenticated,service_role;
alter function public.read_logo_workspace_record(uuid,text,uuid) rename to read_logo_workspace_base_record;
create function public.read_logo_workspace_record(p_project_id uuid,p_kind text,p_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare owner uuid:=auth.uid();result jsonb;vector jsonb;
begin
 if owner is null then raise exception 'unauthenticated' using errcode='42501';end if;
 if not exists(select 1 from public.projects where id=p_project_id and owner_id=owner) then raise exception 'logo_project_not_found' using errcode='P0002';end if;
 if p_kind in('stage','reference_snapshot','manual_request') then return public.read_logo_workspace_base_record(p_project_id,p_kind,p_id);end if;
 if p_kind='vector' then select record into result from public.logo_vector_revisions where id=p_id and owner_id=owner and project_id=p_project_id;
 elsif p_kind='vector_source_preview' then
  select record into vector from public.logo_vector_revisions where id=p_id and owner_id=owner and project_id=p_project_id;
  if vector is not null then
   select fluid_private.logo_asset_receipt(r) into result from public.logo_asset_publications r where r.owner_id=owner and r.project_id=p_project_id and r.version_id::text=vector#>>'{sourcePreview,versionId}' and r.state='committed' and fluid_private.logo_asset_reservation(r)->'reference'=vector->'sourcePreview';
  end if;
 elsif p_kind in('concept_batch','raster_refinement') then return fluid_private.logo_job_record(owner,p_project_id,p_kind,p_id);
 else raise exception 'invalid_logo_read_kind' using errcode='22023';end if;
 if result is null then raise exception 'logo_record_not_found' using errcode='P0002';end if;return result;
end $$;
alter function public.list_logo_workspace_records(uuid,text,jsonb) rename to list_logo_workspace_base_records;
create function public.list_logo_workspace_records(p_project_id uuid,p_kind text,p_query jsonb) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare owner uuid:=auth.uid();
begin
 if owner is null then raise exception 'unauthenticated' using errcode='42501';end if;
 if not exists(select 1 from public.projects where id=p_project_id and owner_id=owner) then raise exception 'logo_project_not_found' using errcode='P0002';end if;
 if p_kind in('brief_references','concepts','vector','refinements','directions','deliverables') then return public.list_logo_workspace_base_records(p_project_id,p_kind,p_query);end if;
 if p_kind in('raster_refinement','concept_batch') then return fluid_private.logo_job_records(owner,p_project_id,p_kind,p_query);end if;
 if p_kind='directions_overview' then return fluid_private.logo_direction_overview(owner,p_project_id,p_query);end if;
 raise exception 'invalid_logo_read_kind' using errcode='22023';
end $$;
revoke all on function public.read_logo_workspace_record(uuid,text,uuid),public.list_logo_workspace_records(uuid,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.read_logo_workspace_record(uuid,text,uuid),public.list_logo_workspace_records(uuid,text,jsonb) to authenticated;
create function fluid_private.read_logo_trusted_request(p_project uuid,p_command jsonb) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare owner uuid:=fluid_private.logo_asset_web_owner();existing public.logo_workspace_requests;
begin
 if not exists(select 1 from public.projects where id=p_project and owner_id=owner) then raise exception 'logo_project_not_found' using errcode='P0002';end if;
 if not fluid_private.logo_uuid(p_command#>'{body,requestKey}') then raise exception 'invalid_logo_request' using errcode='22023';end if;
 select * into existing from public.logo_workspace_requests where owner_id=owner and project_id=p_project and request_key=(p_command#>>'{body,requestKey}')::uuid and method<>'startLogoProject';
 if not found then return null;end if;
 if existing.input is distinct from p_command then raise exception 'logo_request_conflict' using errcode='PT409';end if;return existing.receipt;
end $$;
create function fluid_private.apply_logo_trusted_command(p_project uuid,p_command jsonb,p_evidence jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare owner uuid:=fluid_private.logo_asset_web_owner();b jsonb:=p_command->'body';method text:=p_command->>'method';existing public.logo_workspace_requests;workspace jsonb;revision jsonb;result jsonb;produced jsonb;check_command jsonb;target_stage jsonb;target_id uuid;current_id uuid;target_vector jsonb;current_vector jsonb;item jsonb;
begin
 if method not in('saveLogoEdit','acceptLogoVector','selectIdentityDirectionComponents','approveIdentityDirection','prepareLogoVariants','reviewLogoVariants','restoreLogoStage') or not fluid_private.standalone_keys(p_command,array['method','body']) or octet_length(p_command::text)>32768 or octet_length(p_evidence::text)>2097152 then raise exception 'invalid_logo_trusted_command' using errcode='22023';end if;
 check_command:=jsonb_build_object('method','restoreLogoStage','body',jsonb_build_object('requestKey',b->'requestKey','expected',b->'expected','stage','concepts','revisionId','00000000-0000-4000-8000-000000000001','acceptEarlierBasis',false));
 if not fluid_private.logo_base_command_valid(check_command) then raise exception 'invalid_logo_trusted_command' using errcode='22023';end if;
 perform 1 from public.projects where id=p_project and owner_id=owner for update;
 if not found then raise exception 'logo_project_not_found' using errcode='P0002';end if;
 select * into existing from public.logo_workspace_requests req where req.owner_id=owner and req.project_id=p_project and req.request_key=(b->>'requestKey')::uuid and req.method<>'startLogoProject';
 if found then if existing.input is distinct from p_command then raise exception 'logo_request_conflict' using errcode='PT409';end if;return existing.receipt;end if;
 if to_regclass('public.logo_operation_rejections') is not null then
  if exists(select 1 from public.logo_operation_rejections req where req.owner_id=owner and req.project_id=p_project and req.request_key=(b->>'requestKey')::uuid) then raise exception 'logo_request_conflict' using errcode='PT409';end if;
 end if;
 if to_regclass('public.logo_operation_requests') is not null then
  if exists(select 1 from public.logo_operation_requests req where req.owner_id=owner and req.project_id=p_project and req.request_key=(b->>'requestKey')::uuid) then raise exception 'logo_request_conflict' using errcode='PT409';end if;
 end if;
 perform 1 from public.identity_reference_heads where owner_id=owner and project_id=p_project for update;
 perform 1 from public.identity_sessions where owner_id=owner and project_id=p_project for update;
 workspace:=fluid_private.logo_workspace_json(owner,p_project);
 if workspace->'heads' is distinct from b->'expected' then raise exception 'logo_head_conflict' using errcode='PT409';end if;
 if method in('acceptLogoVector','restoreLogoStage') then
  -- Only the trusted server producer may supply this evidence, after loading
  -- actual canonical/SVG bytes and validating complete geometry/occlusion locks.
  -- The commit rechecks the exact IDs that were checked outside the transaction.
  if not fluid_private.logo_command_valid(p_command) then raise exception 'invalid_logo_command' using errcode='22023';end if;
  current_id:=fluid_private.logo_current_vector_id(owner,p_project);
  if method='restoreLogoStage' then
   if b->>'stage' not in('vector','refinements') or not fluid_private.standalone_keys(p_evidence,array['targetStageRevisionId','currentVectorRevisionId','targetVectorRevisionId','expected']) or p_evidence->'targetStageRevisionId' is distinct from b->'revisionId' then raise exception 'invalid_logo_verified_restore' using errcode='22023';end if;
   select r.record into target_stage from public.logo_stage_revisions r where r.id=(b->>'revisionId')::uuid and r.owner_id=owner and r.project_id=p_project and r.stage=b->>'stage';
   if target_stage is null then raise exception 'logo_revision_not_found' using errcode='P0002';end if;
   target_id:=(target_stage#>>'{payload,vectorRevisionId}')::uuid;
   if p_evidence->'targetVectorRevisionId' is distinct from coalesce(to_jsonb(target_id),'null'::jsonb) then raise exception 'logo_verified_source_changed' using errcode='PT409';end if;
  else
   if not fluid_private.standalone_keys(p_evidence,array['vectorRevisionId','currentVectorRevisionId','expected']) or p_evidence->'vectorRevisionId' is distinct from b->'vectorRevisionId' then raise exception 'invalid_logo_verified_candidate' using errcode='22023';end if;
   target_id:=(b->>'vectorRevisionId')::uuid;
  end if;
  if p_evidence->'expected' is distinct from b->'expected' or p_evidence->'currentVectorRevisionId' is distinct from coalesce(to_jsonb(current_id),'null'::jsonb) then raise exception 'logo_verified_source_changed' using errcode='PT409';end if;
  if current_id is not null then
   select v.record into current_vector from public.logo_vector_revisions v where v.id=current_id and v.owner_id=owner and v.project_id=p_project;
   if current_vector is null then raise exception 'logo_vector_not_found' using errcode='P0002';end if;
  end if;
  if target_id is not null then
   select v.record into target_vector from public.logo_vector_revisions v where v.id=target_id and v.owner_id=owner and v.project_id=p_project;
   if target_vector is null then raise exception 'logo_vector_not_found' using errcode='P0002';end if;
  end if;
  -- Restoring/accepting another revision must not implicitly unlock a component.
  for item in select value from jsonb_array_elements(coalesce(current_vector->'locks','[]'::jsonb)) loop
   if not exists(select 1 from jsonb_array_elements(coalesce(target_vector->'locks','[]'::jsonb)) held where held=item) then raise exception 'logo_saved_lock_conflict' using errcode='PT409';end if;
  end loop;
  return fluid_private.logo_apply(owner,p_project,p_command);
 elsif method='saveLogoEdit' then revision:=fluid_private.commit_logo_vector_edit(owner,p_project,p_command,p_evidence);
 elsif method in('selectIdentityDirectionComponents','approveIdentityDirection') then revision:=fluid_private.commit_logo_direction_command(owner,p_project,p_command,p_evidence);
 else
  produced:=fluid_private.commit_logo_deliverable_command(owner,p_project,p_command,p_evidence);revision:=produced->'revision';
 end if;
 if revision->>'ownerId' is distinct from owner::text or revision->>'projectId' is distinct from p_project::text or not exists(select 1 from public.logo_stage_heads h where h.owner_id=owner and h.project_id=p_project and h.stage=revision->>'stage' and h.revision_id::text=revision->>'id') then raise exception 'invalid_logo_producer_stage' using errcode='55000';end if;
 if method='prepareLogoVariants' then
  result:=produced->'variantSet';
  if result->>'ownerId' is distinct from owner::text or result->>'projectId' is distinct from p_project::text or result->'approvedLogoId' is distinct from b->'approvedLogoId' or result->'directionApprovalId' is distinct from b->'directionApprovalId' then raise exception 'invalid_logo_variant_receipt' using errcode='55000';end if;
 else result:=jsonb_build_object('ownerId',owner,'projectId',p_project,'requestKey',b->'requestKey','revision',revision,'workspace',fluid_private.logo_workspace_json(owner,p_project));end if;
 insert into public.logo_workspace_requests(project_id,owner_id,request_key,method,input,receipt) values(p_project,owner,(b->>'requestKey')::uuid,method,p_command,result);return result;
end $$;
revoke all on function fluid_private.read_logo_trusted_request(uuid,jsonb),fluid_private.apply_logo_trusted_command(uuid,jsonb,jsonb) from public,anon,authenticated,service_role;

do $$declare signature text;r record;begin
 foreach signature in array array['fluid_private.logo_asset_web_owner()','fluid_private.logo_asset_reservation(public.logo_asset_publications)','fluid_private.logo_asset_receipt(public.logo_asset_publications)','fluid_private.logo_asset_job(uuid,uuid,uuid,uuid)','fluid_private.prepare_logo_asset(uuid,jsonb,uuid,uuid)','fluid_private.logo_commit_asset(public.logo_asset_publications)','fluid_private.commit_logo_asset_publication(public.jobs,uuid)','fluid_private.observe_logo_asset(uuid,jsonb,uuid,uuid)','fluid_private.read_logo_asset_publication(uuid,jsonb,uuid,uuid)','public.read_logo_asset(jsonb)','public.read_logo_font_record(uuid)','public.read_logo_current_vector(uuid)','fluid_private.logo_current_vector_id(uuid,uuid)','fluid_private.logo_stage_payload_valid(text,jsonb)','fluid_private.logo_append_stage(uuid,uuid,text,jsonb,jsonb)','fluid_private.logo_workspace_json(uuid,uuid)','fluid_private.logo_command_valid(jsonb)','fluid_private.logo_apply(uuid,uuid,jsonb)','public.read_logo_workspace_base_record(uuid,text,uuid)','public.list_logo_workspace_base_records(uuid,text,jsonb)','public.read_logo_workspace_record(uuid,text,uuid)','public.list_logo_workspace_records(uuid,text,jsonb)','fluid_private.read_logo_trusted_request(uuid,jsonb)','fluid_private.apply_logo_trusted_command(uuid,jsonb,jsonb)'] loop
  for r in select distinct a.grantee from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where p.oid=to_regprocedure(signature) and a.grantee<>p.proowner loop
   execute format('revoke all on function %s from %s',signature,case when r.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(r.grantee)) end);
  end loop;
 end loop;
end $$;
grant execute on function public.read_logo_asset(jsonb),public.read_logo_font_record(uuid),public.read_logo_workspace_record(uuid,text,uuid),public.list_logo_workspace_records(uuid,text,jsonb),public.read_logo_current_vector(uuid) to authenticated;
commit;
