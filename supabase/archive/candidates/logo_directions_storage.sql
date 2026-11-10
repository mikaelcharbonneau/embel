-- UNAPPLIED LOCAL PROPOSAL. Source definitions, never access activation.
-- Requires the existing dedicated Auth Storage identity and reviewed logo,
-- input-import, subscription-policy and readiness contracts. No new identity,
-- enabled capability, grant, Storage policy, bucket, credential or default ACL.
begin;

create table fluid_private.logo_directions_storage_capabilities (
 auth_user_id uuid primary key references fluid_private.logo_storage_principals(auth_user_id),
 policy_identity text not null check(policy_identity ~ '^[a-f0-9]{64}$'),
 enabled boolean not null default false
);
create table fluid_private.logo_directions_storage_grants (
 session_id uuid not null references auth.sessions(id) on delete cascade,
 auth_user_id uuid not null references fluid_private.logo_storage_principals(auth_user_id),
 job_id uuid not null references public.jobs(id), lease_token uuid not null,
 reservation_id uuid not null references public.logo_asset_publications(id),
 member jsonb not null check(member->>'kind' in('logo-document','font')),
 binding jsonb not null,
 created_at timestamptz not null default clock_timestamp(),
 primary key(session_id,job_id,lease_token,reservation_id)
);
alter table fluid_private.logo_directions_storage_capabilities enable row level security;
alter table fluid_private.logo_directions_storage_capabilities force row level security;
alter table fluid_private.logo_directions_storage_grants enable row level security;
alter table fluid_private.logo_directions_storage_grants force row level security;

-- Exact immutable publication/version membership, never hash, uploader or path
-- prefix alone. Font authority includes the actual completed import and license.
create function fluid_private.logo_directions_storage_member(j public.jobs,r public.logo_asset_publications)
returns jsonb language plpgsql stable set search_path='' as $$
declare source jsonb; ref jsonb; font jsonb; catalog jsonb;
 request public.logo_input_requests; rights public.logo_input_rights; receipt public.logo_input_receipts;
begin
 if j.id is null or j.operation is distinct from 'identity.logo_directions' or r.id is null
  or r.owner_id is distinct from j.owner_id or r.project_id is distinct from j.project_id
  or r.purpose is distinct from 'brand_asset' or r.state is distinct from 'committed'
  or r.verification->>'status' is distinct from 'verified'
  or r.verification->>'contentHash' is distinct from r.content_hash
  or r.verification->>'mimeType' is distinct from r.mime_type
  or r.verification->'byteLength' is distinct from to_jsonb(r.byte_length) then return null; end if;
 if not exists(select 1 from public.asset_versions v join public.assets a
  on a.id=v.asset_id and a.owner_id=v.owner_id and a.project_id=v.project_id
  where v.owner_id=r.owner_id and v.project_id=r.project_id and v.asset_id=r.asset_id and v.id=r.version_id
   and v.content_hash=r.content_hash and v.mime_type=r.mime_type and v.input_revision=r.input_revision and v.input_hash=r.input_hash
   and v.storage_path=r.owner_id::text||'/'||r.project_id::text||'/'||r.asset_id::text||'/'||r.version_id::text
   and v.provenance->'version'='2'::jsonb and v.provenance->>'publicationId'=r.id::text
   and v.provenance->>'sourceReceiptId'=r.source_receipt_id::text
   and a.purpose=r.purpose and a.kind='logo_'||r.source_kind) then return null; end if;
 select d.source into source from public.logo_direction_inputs d where d.job_id=j.id
  and d.owner_id=j.owner_id and d.project_id=j.project_id and d.input_hash=j.input_hash;
 if source is null then return null; end if;
 ref:=fluid_private.logo_asset_reservation(r)->'reference';
 if source#>'{logoRevision,documentAsset}'=ref then
  if r.mime_type='application/json' and r.byte_length between 1 and 8388608 and r.source_kind='vector'
   and r.rights_evidence_id is null and source#>>'{logoRevision,documentHash}'=r.content_hash
   and source#>>'{logoRevision,proof,documentHash}'=r.content_hash
   and source#>'{logoRevision,svgAsset,contentHash}'=source#>'{logoRevision,proof,svgContentHash}'
   and fluid_private.logo_vector_proof_valid(source#>'{logoRevision,proof}') is true
   and r.request->>'kind'='stage' and r.request#>>'{publication,source,kind}'='vector'
   and r.request#>>'{publication,source,sourceId}'=r.source_receipt_id::text
   and r.request#>'{publication,inputRevisions}'=source#>'{logoRevision,inputRevisions}'
   and r.request#>>'{publication,requestKey}'=r.request_key::text
   and r.request#>>'{publication,contentHash}'=r.content_hash and r.request#>>'{publication,mimeType}'=r.mime_type
   and r.request#>'{publication,byteLength}'=to_jsonb(r.byte_length)
  then return jsonb_build_object('kind','logo-document'); end if;
  return null;
 end if;
 if jsonb_typeof(source->'permittedFonts') is distinct from 'array' or r.mime_type not in('font/ttf','font/otf')
  or r.byte_length not between 12 and 10485760 or r.source_kind is distinct from 'font'
  or r.job_id is not null or r.lease_token is not null or r.rights_evidence_id is null
  or r.request->>'kind' is distinct from 'upload' or r.request#>>'{intent,usage}' is distinct from 'font'
  or r.request#>>'{intent,requestKey}' is distinct from r.request_key::text
  or r.request#>>'{intent,contentHash}' is distinct from r.content_hash
  or r.request#>>'{intent,mimeType}' is distinct from r.mime_type
  or r.request->'byteLength' is distinct from to_jsonb(r.byte_length) then return null; end if;
 select f.record into font from public.logo_font_records f
  join jsonb_array_elements(source->'permittedFonts') frozen on frozen=f.record
  where f.record_id=r.version_id and f.version_id=r.version_id and f.owner_id=j.owner_id and f.project_id=j.project_id
   and f.record->'asset'=ref;
 if font is null or font->>'id' is distinct from r.version_id::text or font->>'source' is distinct from 'free_catalog'
  or font#>>'{rights,id}' is distinct from r.rights_evidence_id::text
  or font#>>'{rights,fontContentHash}' is distinct from r.content_hash
  or font#>>'{rights,sourceKind}' is distinct from 'reviewed_license'
  or font#>>'{rights,commercialUse}' is distinct from 'allowed'
  or font#>>'{rights,permissions,render}' is distinct from 'allowed'
  or jsonb_typeof(font#>'{rights,reviewedAt}') is distinct from 'string'
  or nullif(font#>>'{rights,reviewedAt}','') is null then return null; end if;
 select * into request from public.logo_input_requests where owner_id=r.owner_id and project_id=r.project_id and request_key=r.request_key;
 select * into rights from public.logo_input_rights where id=r.rights_evidence_id and publication_id=r.id and owner_id=r.owner_id and project_id=r.project_id;
 select * into receipt from public.logo_input_receipts where owner_id=r.owner_id and project_id=r.project_id and request_key=r.request_key and font_record_id=r.version_id;
 if request.request_key is null or rights.id is null or receipt.request_key is null or receipt.reference_id is not null
  or receipt.result is distinct from font or request.request->>'kind' is distinct from 'font_catalog'
  or fluid_private.logo_input_request_valid(request.request) is distinct from true
  or request.request#>>'{input,requestKey}' is distinct from r.request_key::text
  or request.request#>>'{file,contentHash}' is distinct from r.content_hash
  or request.request#>>'{file,mimeType}' is distinct from r.mime_type
  or request.request#>'{file,byteLength}' is distinct from to_jsonb(r.byte_length)
  or rights.source_kind is distinct from 'reviewed_license' or rights.catalog_id is null
  or rights.catalog_id is distinct from request.request#>>'{input,catalogFontId}'
  or rights.content_hash is distinct from r.content_hash
  or rights.source_url is distinct from font#>>'{rights,sourceUrl}'
  or rights.license_text is null or octet_length(rights.license_text) not between 1 and 262144
  or nullif(btrim(rights.license_text),'') is null
  or rights.license_text_hash is distinct from encode(sha256(convert_to(rights.license_text,'UTF8')),'hex')
  or rights.license_text_hash is distinct from font#>>'{rights,licenseTextHash}'
  or rights.rights_declaration is distinct from 'Reviewed free-commercial catalog '||rights.catalog_id||'; exact license SHA-256 '||rights.license_text_hash||'.'
  or rights.rights_declaration is distinct from r.request#>>'{intent,rightsDeclaration}'
  or exists(select 1 from public.logo_input_rejections x where x.owner_id=r.owner_id and x.project_id=r.project_id and x.request_key=r.request_key)
 then return null; end if;
 select c.record into catalog from fluid_private.logo_input_font_catalog c where c.id=rights.catalog_id;
 if catalog is null or catalog->>'id' is distinct from rights.catalog_id
  or catalog->>'contentHash' is distinct from r.content_hash or catalog->>'mimeType' is distinct from r.mime_type
  or catalog->'family' is distinct from font->'family'
  or catalog#>>'{rights,sourceUrl}' is distinct from rights.source_url
  or catalog#>>'{rights,licenseTextHash}' is distinct from rights.license_text_hash
  or (catalog->'rights')||jsonb_build_object('id',rights.id) is distinct from font->'rights'
 then return null; end if;
 return jsonb_build_object('kind','font','font',font);
exception when invalid_text_representation or numeric_value_out_of_range then return null;
end $$;

-- Auth's role/session is distinct from the DB login. Resolve readiness against
-- the verified context's exact role/OID/worker, never session_user/Auth or a
-- second readiness publisher. Every read revalidates the entire admitted basis.
create function fluid_private.logo_directions_storage_job(context jsonb,p_job uuid,p_lease uuid)
returns public.jobs language plpgsql volatile set search_path='' as $$
declare j public.jobs; p fluid_private.logo_runtime_policies; q public.logo_cost_quotes;
 d public.logo_direction_inputs; admission public.logo_operation_requests;
 approval public.logo_approvals; vector public.logo_vector_revisions; brief public.logo_stage_revisions;
 r public.logo_asset_publications; source jsonb; snapshot jsonb; projection jsonb; inputs jsonb; expected jsonb; font jsonb;
begin
 if context is null then return null; end if;
 select jobs.* into j from public.jobs jobs
 join fluid_private.logo_directions_storage_capabilities c on c.auth_user_id=(context->>'authUserId')::uuid
  and c.policy_identity=jobs.input->>'policyIdentity' and c.enabled
 where jobs.id=p_job and jobs.owner_id::text=context->>'ownerId' and jobs.worker_id=context->>'workerId'
  and jobs.operation='identity.logo_directions' and jobs.state='running' and jobs.cancel_requested_at is null
  and jobs.lease_token=p_lease and p_lease is not null and jobs.lease_expires_at>clock_timestamp()
  and jobs.billing_mode='chatgpt_subscription' and jobs.reserved_cost_microusd=0 and jobs.actual_cost_microusd=0;
 if j.id is null then return null; end if;
 select * into p from fluid_private.logo_runtime_policies where owner_id=j.owner_id and operation=j.operation;
 if p.owner_id is null or fluid_private.logo_job_policy_matches(j,p) is distinct from true
  or p.provider is distinct from 'openai' or p.model is distinct from p.subscription_policy->>'model'
  or p.handler_version is distinct from 'logo-directions-v1' or p.engine is not null or p.max_cost_microusd<>0
  or fluid_private.valid_logo_directions_subscription_policy(p.subscription_policy) is distinct from true
  or fluid_private.logo_subscription_registration_ready(j.owner_id,p.subscription_policy) is distinct from true
  or fluid_private.logo_subscription_quota_available(j.owner_id,p.subscription_policy,j.id) is distinct from true
  or not exists(select 1 from fluid_private.logo_worker_readiness ready where ready.owner_id=j.owner_id and ready.operation=j.operation
   and ready.worker_id=context->>'workerId' and ready.role_oid=(context->>'workerRoleOid')::oid
   and ready.ready_until>clock_timestamp() and ready.descriptor=fluid_private.logo_policy_descriptor(p)) then return null; end if;
 select * into q from public.logo_cost_quotes where id=(j.input->>'quoteId')::uuid and owner_id=j.owner_id
  and project_id=j.project_id and operation=j.operation and record->>'inputHash'=j.input_hash;
 select * into d from public.logo_direction_inputs where job_id=j.id and owner_id=j.owner_id and project_id=j.project_id and input_hash=j.input_hash;
 if q.id is null or d.job_id is null or d.source is distinct from q.source_inputs->'direction'
  or q.record->>'id' is distinct from q.id::text or q.record->>'ownerId' is distinct from j.owner_id::text
  or q.record->>'projectId' is distinct from j.project_id::text or q.record#>>'{request,operation}' is distinct from 'directions'
  or q.record#>'{request,expected}' is distinct from q.record->'expected' then return null; end if;
 source:=d.source;
 select * into admission from public.logo_operation_requests where owner_id=j.owner_id and project_id=j.project_id
  and request_key=(j.input->>'requestKey')::uuid and quote_id=q.id;
 if admission.request_key is null or admission.input->>'requestKey' is distinct from admission.request_key::text
  or admission.input->>'quoteId' is distinct from q.id::text or admission.input->'expected' is distinct from q.record->'expected'
  or admission.receipt->>'ownerId' is distinct from j.owner_id::text or admission.receipt->>'projectId' is distinct from j.project_id::text
  or admission.receipt->>'requestKey' is distinct from admission.request_key::text
  or admission.receipt->>'operation' is distinct from j.operation or admission.receipt->>'inputHash' is distinct from j.input_hash
  or admission.receipt->'jobIds' is distinct from jsonb_build_array(j.id)
  or j.input_revision is distinct from (admission.input#>>'{expected,projectRevision}')::integer then return null; end if;
 if source->'targetCount' is distinct from '3'::jsonb or source#>'{approvedLogo,id}' is distinct from j.input->'approvedLogoId'
  or source#>'{approvedLogo,id}' is distinct from q.record#>'{request,approvedLogoId}'
  or source#>'{brief,id}' is distinct from j.input->'briefRevisionId'
  or source#>'{references,id}' is distinct from j.input->'referenceSnapshotId'
  or source->'brief' is distinct from q.source_inputs->'brief'
  or source->'references' is distinct from q.source_inputs->'referenceSnapshot'
  or source->'inputRevisions' is distinct from q.input_revisions
  or jsonb_typeof(source->'permittedFonts') is distinct from 'array' then return null; end if;
 if jsonb_array_length(source->'permittedFonts') not between 1 and 100 then return null; end if;
 select jsonb_agg(f->'id' order by ordinal) into projection from jsonb_array_elements(source->'permittedFonts') with ordinality fonts(f,ordinal);
 if projection is distinct from j.input->'fontVersionIds'
  or (select count(*)<>count(distinct f->>'id') from jsonb_array_elements(source->'permittedFonts') f) then return null; end if;
 select * into approval from public.logo_approvals where id=(source#>>'{approvedLogo,id}')::uuid and owner_id=j.owner_id and project_id=j.project_id;
 select * into vector from public.logo_vector_revisions where id=approval.vector_revision_id and owner_id=j.owner_id and project_id=j.project_id;
 select * into brief from public.logo_stage_revisions where id=(source#>>'{brief,id}')::uuid and owner_id=j.owner_id and project_id=j.project_id and stage='brief_references';
 if approval.id is null or vector.id is null or brief.id is null or approval.record is distinct from source->'approvedLogo'
  or vector.record is distinct from source->'logoRevision' or brief.record is distinct from source->'brief'
  or brief.reference_snapshot_id::text is distinct from source#>>'{references,id}'
  or brief.record#>>'{payload,referenceSnapshotId}' is distinct from brief.reference_snapshot_id::text
  or not exists(select 1 from public.logo_stage_revisions stage where stage.id=approval.stage_revision_id
   and stage.owner_id=j.owner_id and stage.project_id=j.project_id and stage.stage='vector'
   and stage.record#>>'{payload,approvalId}'=approval.id::text and stage.record#>>'{payload,vectorRevisionId}'=vector.id::text)
 then return null; end if;
 snapshot:=fluid_private.logo_snapshot_json(j.owner_id,j.project_id,brief.reference_snapshot_id);
 if snapshot is distinct from source->'references' or snapshot->>'ownerId' is distinct from j.owner_id::text
  or snapshot->>'projectId' is distinct from j.project_id::text then return null; end if;
 select jsonb_agg(jsonb_build_object('stage',stage,'id',id,'revision',revision) order by stage) into inputs
  from public.logo_stage_revisions where owner_id=j.owner_id and project_id=j.project_id and id in(brief.id,approval.stage_revision_id);
 if inputs is distinct from source->'inputRevisions' then return null; end if;
 expected:=jsonb_build_object('version',2,'ownerId',j.owner_id,'projectId',j.project_id,'operation',j.operation,
  'requestKey',admission.request_key,'quoteId',q.id,'policyIdentity',p.policy_identity,'handlerVersion',p.handler_version,'inputHash',j.input_hash,
  'approvedLogoId',approval.id,'briefRevisionId',brief.id,'referenceSnapshotId',brief.reference_snapshot_id,
  'fontVersionIds',projection,'targetCount',3,'billingMode','chatgpt_subscription','policy',p.subscription_policy);
 if j.input is distinct from expected then return null; end if;
 -- Probe and every subsequent GET fail if ANY admitted source loses evidence.
 select * into r from public.logo_asset_publications where owner_id=j.owner_id and project_id=j.project_id
  and version_id=(source#>>'{logoRevision,documentAsset,versionId}')::uuid;
 if fluid_private.logo_directions_storage_member(j,r) is distinct from jsonb_build_object('kind','logo-document') then return null; end if;
 for font in select value from jsonb_array_elements(source->'permittedFonts') loop
  select * into r from public.logo_asset_publications where owner_id=j.owner_id and project_id=j.project_id and version_id=(font#>>'{asset,versionId}')::uuid;
  if fluid_private.logo_directions_storage_member(j,r) is distinct from jsonb_build_object('kind','font','font',font) then return null; end if;
 end loop;
 return j;
exception when invalid_text_representation or numeric_value_out_of_range or no_data_found then return null;
end $$;

create function public.authorize_logo_directions_storage(p_job uuid,p_lease uuid,p_reservation uuid,p_mode text)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare context jsonb:=fluid_private.logo_storage_context(); j public.jobs; p fluid_private.logo_runtime_policies;
 r public.logo_asset_publications; member jsonb; result jsonb; previous fluid_private.logo_directions_storage_grants;
begin
 j:=fluid_private.logo_directions_storage_job(context,p_job,p_lease);
 if j.id is null or p_mode is null or p_mode not in('probe','read') or (p_mode='probe')<>(p_reservation is null)
 then raise exception 'logo_directions_storage_unavailable' using errcode='42501'; end if;
 select * into p from fluid_private.logo_runtime_policies where owner_id=j.owner_id and operation=j.operation;
 result:=context||jsonb_build_object('capability',fluid_private.logo_policy_descriptor(p),'jobId',j.id,'leaseToken',j.lease_token,
  'inputRevision',j.input_revision,'jobInput',j.input,'mode',p_mode,'reservation',null,'member',null);
 if p_mode='probe' then return result; end if;
 select * into r from public.logo_asset_publications where id=p_reservation and owner_id=j.owner_id and project_id=j.project_id;
 member:=fluid_private.logo_directions_storage_member(j,r);
 if member is null then raise exception 'logo_directions_storage_unavailable' using errcode='42501'; end if;
 insert into fluid_private.logo_directions_storage_grants(session_id,auth_user_id,job_id,lease_token,reservation_id,member,binding)
  values((context->>'sessionId')::uuid,(context->>'authUserId')::uuid,j.id,j.lease_token,r.id,member,context)
  on conflict(session_id,job_id,lease_token,reservation_id) do nothing;
 select * into previous from fluid_private.logo_directions_storage_grants where session_id=(context->>'sessionId')::uuid
  and job_id=j.id and lease_token=j.lease_token and reservation_id=r.id;
 if previous.auth_user_id is distinct from (context->>'authUserId')::uuid or previous.member is distinct from member
  or previous.binding is distinct from context then raise exception 'logo_directions_storage_unavailable' using errcode='42501'; end if;
 return result||jsonb_build_object('reservation',fluid_private.logo_asset_reservation(r),'member',member);
end $$;

-- This helper itself is GET-only. Authenticated info/list/sign operations cannot
-- use a grant even if a later permissive policy accidentally calls the helper.
-- Historical uploader identity is irrelevant: owned publication/version plus
-- exact frozen membership controls access, with full context pinned at grant.
create function fluid_private.logo_directions_storage_object_allowed(p_bucket text,p_name text)
returns boolean language plpgsql volatile security definer set search_path='' as $$
declare context jsonb:=fluid_private.logo_storage_context(); g fluid_private.logo_directions_storage_grants;
 j public.jobs; r public.logo_asset_publications;
begin
 if context is null or p_bucket is distinct from 'fluid-assets'
  or storage.allow_only_operation('object.get_authenticated') is distinct from true then return false; end if;
 for g in select grants.* from fluid_private.logo_directions_storage_grants grants
  join public.logo_asset_publications a on a.id=grants.reservation_id
  where grants.session_id=(context->>'sessionId')::uuid and grants.auth_user_id=(context->>'authUserId')::uuid
   and grants.binding=context and a.owner_id::text=context->>'ownerId'
   and p_name=a.owner_id::text||'/'||a.project_id::text||'/'||a.asset_id::text||'/'||a.version_id::text loop
  j:=fluid_private.logo_directions_storage_job(context,g.job_id,g.lease_token);
  if j.id is null then continue; end if;
  select * into r from public.logo_asset_publications where id=g.reservation_id;
  if fluid_private.logo_directions_storage_member(j,r)=g.member then return true; end if;
 end loop;
 return false;
end $$;

-- Scrub inherited/default ACLs only on this candidate's exact new objects.
-- No grants or changes to any existing ACL or default privilege configuration.
do $$ declare object_name text; object_id oid; r record; c record; begin
 foreach object_name in array array['fluid_private.logo_directions_storage_capabilities','fluid_private.logo_directions_storage_grants'] loop
  object_id:=to_regclass(object_name);
  for r in select distinct a.grantee from pg_catalog.pg_class t cross join lateral pg_catalog.aclexplode(coalesce(t.relacl,pg_catalog.acldefault('r',t.relowner))) a where t.oid=object_id and a.grantee<>t.relowner loop
   execute pg_catalog.format('revoke all on table %s from %s cascade',object_id::regclass,case when r.grantee=0 then 'PUBLIC' else pg_catalog.quote_ident(pg_catalog.pg_get_userbyid(r.grantee)) end);
  end loop;
  for c in select at.attname,a.grantee from pg_catalog.pg_attribute at join pg_catalog.pg_class t on t.oid=at.attrelid cross join lateral pg_catalog.aclexplode(at.attacl) a where t.oid=object_id and a.grantee<>t.relowner loop
   execute pg_catalog.format('revoke all (%I) on table %s from %s cascade',c.attname,object_id::regclass,case when c.grantee=0 then 'PUBLIC' else pg_catalog.quote_ident(pg_catalog.pg_get_userbyid(c.grantee)) end);
  end loop;
 end loop;
 foreach object_name in array array['fluid_private.logo_directions_storage_member(public.jobs,public.logo_asset_publications)',
  'fluid_private.logo_directions_storage_job(jsonb,uuid,uuid)','public.authorize_logo_directions_storage(uuid,uuid,uuid,text)',
  'fluid_private.logo_directions_storage_object_allowed(text,text)'] loop
  object_id:=to_regprocedure(object_name);
  for r in select distinct a.grantee from pg_catalog.pg_proc p cross join lateral pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a where p.oid=object_id and a.grantee<>p.proowner loop
   execute pg_catalog.format('revoke all on function %s from %s cascade',object_id::regprocedure,case when r.grantee=0 then 'PUBLIC' else pg_catalog.quote_ident(pg_catalog.pg_get_userbyid(r.grantee)) end);
  end loop;
 end loop;
end $$;
commit;
