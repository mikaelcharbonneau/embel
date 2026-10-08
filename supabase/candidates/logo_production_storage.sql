-- UNAPPLIED PROPOSAL. Source definitions only, not a migration/provisioning script.
-- Requires the reviewed logo_worker_storage candidate and logo job/export SQL.
-- Creates no login, session, binding, enabled capability, grant, Storage policy,
-- credential, runtime policy or default ACL. Separate activation file is gated.
begin;
create table fluid_private.logo_production_storage_capabilities (
 auth_user_id uuid not null references fluid_private.logo_storage_principals(auth_user_id),
 operation text not null check(operation in('identity.logo_vectorize','identity.logo_export')),
 policy_identity text not null check(policy_identity ~ '^[a-f0-9]{64}$'), enabled boolean not null default false,
 primary key(auth_user_id,operation)
);
create table fluid_private.logo_production_storage_grants (
 session_id uuid not null references auth.sessions(id) on delete cascade,
 auth_user_id uuid not null references fluid_private.logo_storage_principals(auth_user_id),
 job_id uuid not null references public.jobs(id), lease_token uuid not null,
 reservation_id uuid not null references public.logo_asset_publications(id),
 mode text not null check(mode in('read','write')), member text not null,
 created_at timestamptz not null default clock_timestamp(),
 primary key(session_id,job_id,lease_token,reservation_id,mode)
);
alter table fluid_private.logo_production_storage_capabilities enable row level security;
alter table fluid_private.logo_production_storage_capabilities force row level security;
alter table fluid_private.logo_production_storage_grants enable row level security;
alter table fluid_private.logo_production_storage_grants force row level security;

-- Actual Auth context, bound worker, independently enabled storage lane, exact
-- frozen policy and a live uncancelled lease are all required together.
create function fluid_private.logo_production_storage_job(context jsonb,p_job uuid,p_lease uuid)
returns public.jobs language plpgsql volatile set search_path='' as $$
declare j public.jobs; p fluid_private.logo_runtime_policies; q public.logo_cost_quotes; e public.logo_export_inputs;
begin
 if context is null then return null; end if;
 select jobs.* into j from public.jobs jobs
 join fluid_private.logo_production_storage_capabilities c on c.auth_user_id=(context->>'authUserId')::uuid
   and c.operation=jobs.operation and c.policy_identity=jobs.input->>'policyIdentity' and c.enabled
 where jobs.id=p_job and jobs.owner_id::text=context->>'ownerId' and jobs.worker_id=context->>'workerId'
   and jobs.state='running' and jobs.cancel_requested_at is null and jobs.lease_token=p_lease and p_lease is not null
   and jobs.lease_expires_at>clock_timestamp() and jobs.reserved_cost_microusd=0 and jobs.actual_cost_microusd=0
   and jobs.input->>'ownerId'=jobs.owner_id::text and jobs.input->>'projectId'=jobs.project_id::text
   and jobs.input->>'operation'=jobs.operation and jobs.input->>'inputHash'=jobs.input_hash;
 if j.id is null then return null; end if;
 select * into p from fluid_private.logo_runtime_policies where owner_id=j.owner_id and operation=j.operation;
 if p.owner_id is null or fluid_private.logo_job_policy_matches(j,p) is distinct from true
   or p.provider is not null or p.model is not null or p.subscription_policy is not null or p.max_cost_microusd<>0 then return null; end if;
 if j.operation='identity.logo_vectorize' then
   if p.handler_version<>'1' or p.engine is distinct from '{"id":"vtracer","version":"1.0.0-alpha.4","artifactHash":"63716b70497b7468ef97545b50f5f34b8bbb7acde2d7b00deb4eb40781446d45"}'::jsonb or j.input->'engine' is distinct from p.engine then return null; end if;
   select * into q from public.logo_cost_quotes where id=(j.input->>'quoteId')::uuid and owner_id=j.owner_id and project_id=j.project_id and operation=j.operation;
   if q.id is null or j.input->'source' is distinct from q.record#>'{request,source}' or j.input->'settings' is distinct from q.record#>'{request,settings}' then return null; end if;
 elsif j.operation='identity.logo_export' then
   if p.handler_version<>'logo-export-v1' or p.engine is not null or p.policy_identity<>'fa35a3d5e43410d69832d1d0b35f24b8de4f68df8ea4d790e78a2dc06cbe797c' then return null; end if;
   select * into e from public.logo_export_inputs where job_id=j.id and owner_id=j.owner_id and project_id=j.project_id;
   if e.job_id is null or e.source_snapshot_hash is distinct from j.input->>'sourceSnapshotHash'
     or encode(sha256(convert_to((e.source-'sourceSnapshotHash')::text,'UTF8')),'hex') is distinct from e.source_snapshot_hash
     or e.source->>'ownerId' is distinct from j.owner_id::text or e.source->>'projectId' is distinct from j.project_id::text
     or e.source#>'{logoApproval,id}' is distinct from j.input->'approvedLogoId'
     or e.source#>'{directionApproval,id}' is distinct from j.input->'directionApprovalId'
     or e.source#>'{variants,id}' is distinct from j.input->'variantSetId'
     or e.source#>'{variantReview,id}' is distinct from j.input->'variantReviewId' then return null; end if;
   -- Immutable admitted records, not whatever a newer workspace selects.
   if not exists(select 1 from public.logo_approvals a where a.owner_id=j.owner_id and a.project_id=j.project_id and a.id=(j.input->>'approvedLogoId')::uuid and a.record=e.source->'logoApproval')
     or not exists(select 1 from public.logo_vector_revisions v where v.owner_id=j.owner_id and v.project_id=j.project_id and v.record=e.source->'logo')
     or not exists(select 1 from public.logo_direction_records d where d.owner_id=j.owner_id and d.project_id=j.project_id and d.kind='approval' and d.record=e.source->'directionApproval')
     or not exists(select 1 from public.logo_variant_sets v where v.owner_id=j.owner_id and v.project_id=j.project_id and v.record=e.source->'variants')
     or not exists(select 1 from public.logo_variant_reviews v where v.owner_id=j.owner_id and v.project_id=j.project_id and v.record=e.source->'variantReview') then return null; end if;
 else return null; end if;
 return j;
exception when invalid_text_representation or numeric_value_out_of_range then return null;
end $$;

-- Existing publishers' deterministic request IDs. Export names are enumerated
-- from frozen SQL: client filenames/hashes are never RPC authorization inputs.
create function fluid_private.logo_production_storage_member(j public.jobs,r public.logo_asset_publications,p_mode text)
returns text language plpgsql stable set search_path='' as $$
declare ref jsonb; q public.logo_cost_quotes; source jsonb; item jsonb; member text; digest text; expected_key uuid;
begin
 if j.id is null or r.id is null or r.owner_id<>j.owner_id or r.project_id<>j.project_id or r.purpose<>'brand_asset' then return null; end if;
 ref:=fluid_private.logo_asset_reservation(r)->'reference';
 if p_mode='read' then
   if r.state<>'committed' or r.verification is null or not exists(select 1 from public.asset_versions v where v.owner_id=r.owner_id and v.project_id=r.project_id
     and v.asset_id=r.asset_id and v.id=r.version_id and v.content_hash=r.content_hash and v.mime_type=r.mime_type
     and v.storage_path=r.owner_id::text||'/'||r.project_id::text||'/'||r.asset_id::text||'/'||r.version_id::text
     and v.provenance->>'publicationId'=r.id::text) then return null; end if;
   if j.operation='identity.logo_vectorize' then
     select * into q from public.logo_cost_quotes where id=(j.input->>'quoteId')::uuid and owner_id=j.owner_id and project_id=j.project_id;
     if q.source_inputs#>'{raster,preview,reference}'=ref and r.mime_type in('image/png','image/jpeg','image/webp')
       and exists(select 1 from public.logo_raster_results a where a.owner_id=j.owner_id and a.project_id=j.project_id and a.preview->'reference'=ref) then return 'raster-source'; end if;
   elsif j.operation='identity.logo_export' then
     select e.source into source from public.logo_export_inputs e where e.job_id=j.id and e.owner_id=j.owner_id and e.project_id=j.project_id and e.source_snapshot_hash=j.input->>'sourceSnapshotHash';
     if source#>'{logo,documentAsset}'=ref and r.mime_type='application/json' then return 'logo-document'; end if;
     if source#>'{logo,svgAsset}'=ref and r.mime_type='image/svg+xml' then return 'logo-svg'; end if;
     if source#>'{logo,sourcePreview}'=ref and r.mime_type in('image/png','image/jpeg','image/webp') then return 'logo-preview'; end if;
     for item in select value from jsonb_array_elements(source#>'{variants,items}') loop
       if item#>>'{applicability,status}'='applicable' then
         if item->'documentAsset'=ref and r.mime_type='application/json' then return 'variant-document:'||(item->>'id'); end if;
         if item#>'{preview,reference}'=ref and r.mime_type='image/png' then return 'variant-preview:'||(item->>'id'); end if;
       end if;
     end loop;
     -- Fonts require a separate rights/storage capability and remain excluded.
   end if;
   return null;
 elsif p_mode<>'write' then return null; end if;
 if r.job_id is distinct from j.id or r.lease_token is distinct from j.lease_token or r.state not in('reserved','staged')
   or r.rights_evidence_id is not null or r.source_receipt_id<>j.id or r.input_hash<>j.input_hash or r.input_revision<>j.input_revision
   or r.source_kind<>(case j.operation when 'identity.logo_vectorize' then 'vector' when 'identity.logo_export' then 'export' else '' end)
   or r.request->>'kind' is distinct from 'stage' or r.request#>>'{publication,source,kind}' is distinct from r.source_kind
   or r.request#>>'{publication,source,sourceId}' is distinct from j.id::text
   or r.request#>>'{publication,requestKey}' is distinct from r.request_key::text
   or r.request#>>'{publication,contentHash}' is distinct from r.content_hash or r.request#>>'{publication,mimeType}' is distinct from r.mime_type
   or r.request#>'{publication,byteLength}' is distinct from to_jsonb(r.byte_length)
   or r.request#>'{publication,inputRevisions}' is distinct from fluid_private.logo_job_input_revisions(j) then return null; end if;
 if j.operation='identity.logo_vectorize' then
   member:=case r.mime_type when 'application/json' then 'document' when 'image/svg+xml' then 'svg' else null end;
   if member is null then return null; end if;
   digest:=encode(sha256(convert_to('fluid.logo-vector.publication.v1:'||j.id::text||':'||member,'UTF8')),'hex');
   expected_key:=(substr(digest,1,8)||'-'||substr(digest,9,4)||'-5'||substr(digest,14,3)||'-a'||substr(digest,18,3)||'-'||substr(digest,21,12))::uuid;
   if expected_key=r.request_key then return member; end if;
 elsif j.operation='identity.logo_export' then
   select e.source into source from public.logo_export_inputs e where e.job_id=j.id and e.owner_id=j.owner_id and e.project_id=j.project_id and e.source_snapshot_hash=j.input->>'sourceSnapshotHash';
   for item in select value from jsonb_array_elements(fluid_private.logo_export_expected_files(source)) loop
     if item->>'mimeType'=r.mime_type then
       digest:=encode(sha256(convert_to('{"jobId":'||to_json(j.id::text)::text||',"sourceSnapshotHash":'||to_json(j.input->>'sourceSnapshotHash')::text||',"name":'||to_json(item->>'name')::text||',"hash":'||to_json(r.content_hash)::text||'}','UTF8')),'hex');
       expected_key:=(substr(digest,1,8)||'-'||substr(digest,9,4)||'-5'||substr(digest,14,3)||'-8'||substr(digest,18,3)||'-'||substr(digest,21,12))::uuid;
       if expected_key=r.request_key then return item->>'name'; end if;
     end if;
   end loop;
 end if;
 return null;
end $$;

create function public.authorize_logo_production_storage(p_job uuid,p_lease uuid,p_reservation uuid,p_mode text)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare context jsonb:=fluid_private.logo_storage_context(); j public.jobs; r public.logo_asset_publications; member text; p fluid_private.logo_runtime_policies; result jsonb; previous fluid_private.logo_production_storage_grants;
begin
 j:=fluid_private.logo_production_storage_job(context,p_job,p_lease);
 if j.id is null or p_mode not in('probe','read','write','readback') or p_mode is null or (p_mode='probe')<>(p_reservation is null) then raise exception 'logo_production_storage_unavailable' using errcode='42501'; end if;
 select * into p from fluid_private.logo_runtime_policies where owner_id=j.owner_id and operation=j.operation;
 result:=context||jsonb_build_object('capability',fluid_private.logo_policy_descriptor(p),'jobId',j.id,'leaseToken',j.lease_token,'inputRevision',j.input_revision,'jobInput',j.input,'mode',p_mode,'reservation',null,'publication',null);
 if p_mode='probe' then return result; end if;
 select * into r from public.logo_asset_publications where id=p_reservation and owner_id=j.owner_id and project_id=j.project_id;
 -- Readback cannot mint a grant: it reuses only this exact session's prior
 -- admitted write member, after immutable byte observation has staged it.
 if p_mode='readback' then
   member:=fluid_private.logo_production_storage_member(j,r,'write');
   if member is null or r.state<>'staged' or r.verification is null then raise exception 'logo_production_storage_unavailable' using errcode='42501'; end if;
   select * into previous from fluid_private.logo_production_storage_grants where session_id=(context->>'sessionId')::uuid
     and auth_user_id=(context->>'authUserId')::uuid and job_id=j.id and lease_token=j.lease_token and reservation_id=r.id and mode='write';
   if previous.reservation_id is null or previous.member is distinct from member then raise exception 'logo_production_storage_unavailable' using errcode='42501'; end if;
   return result||jsonb_build_object('reservation',fluid_private.logo_asset_reservation(r),'publication',r.request->'publication');
 end if;
 member:=fluid_private.logo_production_storage_member(j,r,p_mode);
 if member is null then raise exception 'logo_production_storage_unavailable' using errcode='42501'; end if;
 insert into fluid_private.logo_production_storage_grants(session_id,auth_user_id,job_id,lease_token,reservation_id,mode,member)
   values((context->>'sessionId')::uuid,(context->>'authUserId')::uuid,j.id,j.lease_token,r.id,p_mode,member)
   on conflict(session_id,job_id,lease_token,reservation_id,mode) do nothing;
 select * into previous from fluid_private.logo_production_storage_grants where session_id=(context->>'sessionId')::uuid and job_id=j.id and lease_token=j.lease_token and reservation_id=r.id and mode=p_mode;
 if previous.auth_user_id is distinct from (context->>'authUserId')::uuid or previous.member is distinct from member then raise exception 'logo_production_storage_unavailable' using errcode='42501'; end if;
 return result||jsonb_build_object('reservation',fluid_private.logo_asset_reservation(r),'publication',case when p_mode='write' then r.request->'publication' else null end);
end $$;

-- Rechecked at each Storage statement. Source ownership derives from immutable
-- owned publication+asset_version AND exact frozen membership. Historical
-- object owner_id can be an older uploader: this is never a path-prefix grant.
-- Write grants require this session's uploader identity, including readback.
create function fluid_private.logo_production_storage_object_allowed(p_bucket text,p_name text,p_owner text,p_access text)
returns boolean language plpgsql volatile security definer set search_path='' as $$
declare context jsonb:=fluid_private.logo_storage_context(); g fluid_private.logo_production_storage_grants; j public.jobs; r public.logo_asset_publications;
begin
 if context is null or p_bucket is distinct from 'fluid-assets' or p_access not in('read','write') or p_access is null then return false; end if;
 for g in select grants.* from fluid_private.logo_production_storage_grants grants join public.logo_asset_publications a on a.id=grants.reservation_id
   where grants.session_id=(context->>'sessionId')::uuid and grants.auth_user_id=(context->>'authUserId')::uuid
     and a.owner_id::text=context->>'ownerId' and p_name=a.owner_id::text||'/'||a.project_id::text||'/'||a.asset_id::text||'/'||a.version_id::text
     and (p_access='read' or grants.mode='write') loop
   if g.mode='write' and p_owner is distinct from context->>'authUserId' then continue; end if;
   j:=fluid_private.logo_production_storage_job(context,g.job_id,g.lease_token);
   if j.id is null then continue; end if;
   select * into r from public.logo_asset_publications where id=g.reservation_id;
   if fluid_private.logo_production_storage_member(j,r,g.mode)=g.member then return true; end if;
 end loop;
 return false;
end $$;

-- Scrub inherited/default ACLs only on this candidate's new objects. No grants.
do $$ declare object_name text; object_id oid; r record; c record; begin
 foreach object_name in array array['fluid_private.logo_production_storage_capabilities','fluid_private.logo_production_storage_grants'] loop
   object_id:=to_regclass(object_name);
   for r in select distinct a.grantee from pg_catalog.pg_class t cross join lateral pg_catalog.aclexplode(coalesce(t.relacl,pg_catalog.acldefault('r',t.relowner))) a where t.oid=object_id and a.grantee<>t.relowner loop
     execute pg_catalog.format('revoke all on table %s from %s cascade',object_id::regclass,case when r.grantee=0 then 'PUBLIC' else pg_catalog.quote_ident(pg_catalog.pg_get_userbyid(r.grantee)) end);
   end loop;
   for c in select at.attname,a.grantee from pg_catalog.pg_attribute at join pg_catalog.pg_class t on t.oid=at.attrelid cross join lateral pg_catalog.aclexplode(at.attacl) a where t.oid=object_id and a.grantee<>t.relowner loop
     execute pg_catalog.format('revoke all (%I) on table %s from %s cascade',c.attname,object_id::regclass,case when c.grantee=0 then 'PUBLIC' else pg_catalog.quote_ident(pg_catalog.pg_get_userbyid(c.grantee)) end);
   end loop;
 end loop;
 foreach object_name in array array['fluid_private.logo_production_storage_job(jsonb,uuid,uuid)','fluid_private.logo_production_storage_member(public.jobs,public.logo_asset_publications,text)',
   'public.authorize_logo_production_storage(uuid,uuid,uuid,text)','fluid_private.logo_production_storage_object_allowed(text,text,text,text)'] loop
   object_id:=to_regprocedure(object_name);
   for r in select distinct a.grantee from pg_catalog.pg_proc p cross join lateral pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a where p.oid=object_id and a.grantee<>p.proowner loop
     execute pg_catalog.format('revoke all on function %s from %s cascade',object_id::regprocedure,case when r.grantee=0 then 'PUBLIC' else pg_catalog.quote_ident(pg_catalog.pg_get_userbyid(r.grantee)) end);
   end loop;
 end loop;
end $$;
commit;
