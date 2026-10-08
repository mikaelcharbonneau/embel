-- UNAPPLIED LOCAL PROPOSAL. Source definitions only, never runtime activation.
-- Requires the existing dedicated Storage identity and reviewed logo SQL.
-- Creates no principal, credential, session, enabled capability, grant, policy,
-- default ACL, bucket or runtime-provider setting. Activation is separate.
begin;
create table fluid_private.logo_generative_storage_capabilities (
 auth_user_id uuid not null references fluid_private.logo_storage_principals(auth_user_id),
 operation text not null check(operation in('identity.logo_concept','identity.logo_refine')),
 policy_identity text not null check(policy_identity ~ '^[a-f0-9]{64}$'),
 enabled boolean not null default false, primary key(auth_user_id,operation)
);
create table fluid_private.logo_generative_storage_grants (
 session_id uuid not null references auth.sessions(id) on delete cascade,
 auth_user_id uuid not null references fluid_private.logo_storage_principals(auth_user_id),
 job_id uuid not null references public.jobs(id), lease_token uuid not null,
 reservation_id uuid not null references public.logo_asset_publications(id),
 mode text not null check(mode in('read','write')),
 member text not null check((mode='read' and member in('reference','base')) or (mode='write' and member='output')),
 binding jsonb not null,
 created_at timestamptz not null default clock_timestamp(),
 primary key(session_id,job_id,lease_token,reservation_id,mode)
);
alter table fluid_private.logo_generative_storage_capabilities enable row level security;
alter table fluid_private.logo_generative_storage_capabilities force row level security;
alter table fluid_private.logo_generative_storage_grants enable row level security;
alter table fluid_private.logo_generative_storage_grants force row level security;

-- Context is obtained by the existing actual Auth/session/principal verifier.
-- Reconstruct the exact admitted job from immutable request, quote, brief,
-- snapshot and operation lineage; IDs alone never establish source membership.
create function fluid_private.logo_generative_storage_job(context jsonb,p_job uuid,p_lease uuid)
returns public.jobs language plpgsql volatile set search_path='' as $$
declare j public.jobs; p fluid_private.logo_runtime_policies; q public.logo_cost_quotes;
 admission public.logo_operation_requests; brief public.logo_stage_revisions;
 batch public.logo_concept_batches; slot public.logo_concept_slots; attempt public.logo_concept_attempts;
 refinement public.logo_raster_refinements; snapshot jsonb; expected jsonb; projection jsonb;
begin
 if context is null then return null; end if;
 select jobs.* into j from public.jobs jobs
 join fluid_private.logo_generative_storage_capabilities c on c.auth_user_id=(context->>'authUserId')::uuid
  and c.operation=jobs.operation and c.policy_identity=jobs.input->>'policyIdentity' and c.enabled
 where jobs.id=p_job and jobs.owner_id::text=context->>'ownerId' and jobs.worker_id=context->>'workerId'
  and jobs.operation in('identity.logo_concept','identity.logo_refine') and jobs.state='running'
  and jobs.cancel_requested_at is null and jobs.lease_token=p_lease and p_lease is not null
  and jobs.lease_expires_at>clock_timestamp();
 if j.id is null then return null; end if;
 select * into p from fluid_private.logo_runtime_policies where owner_id=j.owner_id and operation=j.operation;
 if p.owner_id is null or fluid_private.logo_job_policy_matches(j,p) is distinct from true
  or p.handler_version is distinct from 'logo-image-v1' or p.provider is distinct from 'openai'
  or p.model is distinct from 'gpt-image-2.5-sunburst-2026-09-08' or p.engine is not null
  or p.subscription_policy is not null or p.max_cost_microusd<=0
  or j.reserved_cost_microusd is distinct from p.max_cost_microusd then return null; end if;
 select * into q from public.logo_cost_quotes where id=(j.input->>'quoteId')::uuid and owner_id=j.owner_id
  and project_id=j.project_id and operation=j.operation and record->>'inputHash'=j.input_hash;
 if q.id is null or q.record->>'id' is distinct from q.id::text or q.record->>'ownerId' is distinct from j.owner_id::text
  or q.record->>'projectId' is distinct from j.project_id::text then return null; end if;
 select * into admission from public.logo_operation_requests where owner_id=j.owner_id and project_id=j.project_id
  and request_key=(j.input->>'requestKey')::uuid and quote_id=q.id;
 if admission.request_key is null or admission.input->>'requestKey' is distinct from admission.request_key::text
  or admission.input->>'quoteId' is distinct from q.id::text or admission.input->'expected' is distinct from q.record->'expected'
  or admission.receipt->>'ownerId' is distinct from j.owner_id::text or admission.receipt->>'projectId' is distinct from j.project_id::text
  or admission.receipt->>'requestKey' is distinct from admission.request_key::text
  or admission.receipt->>'operation' is distinct from j.operation or admission.receipt->>'inputHash' is distinct from j.input_hash
  or (admission.receipt->'jobIds' @> jsonb_build_array(j.id)) is distinct from true
  or j.input_revision is distinct from (admission.input#>>'{expected,projectRevision}')::integer
  or (admission.input->>'acceptedMaxCostMicrousd')::numeric<(q.record->>'maxCostMicrousd')::numeric then return null; end if;
 select * into brief from public.logo_stage_revisions where id=(q.source_inputs#>>'{brief,id}')::uuid
  and owner_id=j.owner_id and project_id=j.project_id and stage='brief_references';
 if brief.id is null or brief.record is distinct from q.source_inputs->'brief'
  or brief.reference_snapshot_id::text is distinct from q.source_inputs#>>'{referenceSnapshot,id}'
  or brief.record#>>'{payload,referenceSnapshotId}' is distinct from brief.reference_snapshot_id::text then return null; end if;
 snapshot:=fluid_private.logo_snapshot_json(j.owner_id,j.project_id,brief.reference_snapshot_id);
 if snapshot is distinct from q.source_inputs->'referenceSnapshot' or snapshot->>'ownerId' is distinct from j.owner_id::text
  or snapshot->>'projectId' is distinct from j.project_id::text then return null; end if;
 if (q.input_revisions @> jsonb_build_array(jsonb_build_object('stage','brief_references','id',brief.id,'revision',brief.revision))) is distinct from true
  or q.input_revisions is distinct from fluid_private.logo_job_input_revisions(j) then return null; end if;
 expected:=jsonb_build_object('version',2,'ownerId',j.owner_id,'projectId',j.project_id,'requestKey',admission.request_key,
  'quoteId',q.id,'policyIdentity',p.policy_identity,'handlerVersion',p.handler_version,'inputHash',j.input_hash,'operation',j.operation,
  'briefRevisionId',brief.id,'referenceSnapshotId',brief.reference_snapshot_id);
 if j.operation='identity.logo_concept' then
  if q.record#>>'{request,operation}' not in('concepts','more_concepts','retry_failed') or q.source_inputs->'raster' is distinct from 'null'::jsonb then return null; end if;
  select * into attempt from public.logo_concept_attempts where id=(j.input->>'attemptId')::uuid
   and owner_id=j.owner_id and project_id=j.project_id and job_id=j.id and request_key=admission.request_key and input_hash=j.input_hash;
  select * into slot from public.logo_concept_slots where id=attempt.slot_id and owner_id=j.owner_id and project_id=j.project_id;
  select * into batch from public.logo_concept_batches where id=slot.batch_id and owner_id=j.owner_id and project_id=j.project_id;
  if attempt.id is null or slot.id is null or batch.id is null
   or admission.receipt->>'batchId' is distinct from batch.id::text
   or batch.brief_revision_id is distinct from brief.id or batch.reference_snapshot_id is distinct from brief.reference_snapshot_id
   or batch.plan is distinct from q.record->'conceptPlan' or batch.input_revisions is distinct from q.input_revisions
   or q.input_revisions is distinct from jsonb_build_array(jsonb_build_object('stage','brief_references','id',brief.id,'revision',brief.revision))
   or (q.record->'targetSlotIds' @> jsonb_build_array(slot.id)) is distinct from true
   or not exists(select 1 from jsonb_array_elements(batch.plan->'slots') s where s=jsonb_build_object('ordinal',slot.ordinal,'type',slot.logo_type,'directionId',slot.direction_id)) then return null; end if;
  if q.record#>>'{request,operation}'='retry_failed' then
   if q.record#>>'{request,sourceBatchId}' is distinct from batch.id::text
    or q.record#>'{request,failedSlotIds}' is distinct from q.record->'targetSlotIds' then return null; end if;
  elsif batch.request_key is distinct from admission.request_key
   or q.record#>>'{request,briefRevisionId}' is distinct from brief.id::text
   or q.record#>>'{request,referenceSnapshotId}' is distinct from brief.reference_snapshot_id::text then return null; end if;
  select coalesce(jsonb_agg(item->'asset' order by ordinality),'[]') into projection
   from jsonb_array_elements(snapshot->'references') with ordinality refs(item,ordinality);
  expected:=expected||jsonb_build_object('batchId',batch.id,'slotId',slot.id,'attemptId',attempt.id,
   'attemptNumber',attempt.attempt_number,'previousAttemptId',attempt.previous_attempt_id,'directionId',slot.direction_id,
   'plan',batch.plan,'ordinal',slot.ordinal,'references',projection);
 elsif j.operation='identity.logo_refine' then
  if q.record#>>'{request,operation}' is distinct from 'refine_preview' or j.input#>>'{source,kind}' is distinct from 'preview'
   or admission.receipt->'batchId' is distinct from 'null'::jsonb or admission.receipt->'jobIds' is distinct from jsonb_build_array(j.id)
   or q.source_inputs->'raster' is distinct from fluid_private.resolve_logo_raster_source(j.owner_id,j.project_id,q.record#>'{request,source}') then return null; end if;
  select * into refinement from public.logo_raster_refinements where id=(j.input->>'rasterRevisionId')::uuid
   and owner_id=j.owner_id and project_id=j.project_id and job_id=j.id and request_key=admission.request_key;
  if refinement.id is null or refinement.source is distinct from q.record#>'{request,source}'
   or refinement.input_revisions is distinct from q.input_revisions or refinement.logo_type is distinct from q.source_inputs#>>'{raster,logoType}' then return null; end if;
  expected:=expected||jsonb_build_object('rasterRevisionId',refinement.id,'instruction',q.record#>'{request,instruction}',
   'source',jsonb_build_object('kind','preview','raster',refinement.source));
 else return null; end if;
 if j.input is distinct from expected then return null; end if;
 return j;
exception when invalid_text_representation or numeric_value_out_of_range or invalid_parameter_value or sqlstate 'P0002' or sqlstate '55000' then return null;
end $$;

-- Committed references require a complete real upload registration. A UUID or
-- source note is not a license; curated/font/direction authority is unavailable.
-- Raster bases require exact frozen resolved lineage, including prior refinements.
create function fluid_private.logo_generative_storage_member(j public.jobs,r public.logo_asset_publications,p_mode text)
returns text language plpgsql stable set search_path='' as $$
declare ref jsonb; q public.logo_cost_quotes; item jsonb; source_id uuid; resolved jsonb;
begin
 if j.id is null or r.id is null or r.owner_id is distinct from j.owner_id or r.project_id is distinct from j.project_id
  or j.operation not in('identity.logo_concept','identity.logo_refine') then return null; end if;
 ref:=fluid_private.logo_asset_reservation(r)->'reference';
 select * into q from public.logo_cost_quotes where id=(j.input->>'quoteId')::uuid and owner_id=j.owner_id and project_id=j.project_id and operation=j.operation and record->>'inputHash'=j.input_hash;
 if q.id is null then return null; end if;
 if p_mode='read' then
  if r.state is distinct from 'committed' or r.job_id=j.id or r.mime_type not in('image/png','image/jpeg','image/webp')
   or r.byte_length not between 1 and 20971520 or r.verification is null
   or r.verification->>'status' is distinct from 'verified' or r.verification->>'contentHash' is distinct from r.content_hash
   or r.verification->>'mimeType' is distinct from r.mime_type or r.verification->'byteLength' is distinct from to_jsonb(r.byte_length)
   or not exists(select 1 from public.asset_versions v join public.assets a on a.id=v.asset_id and a.owner_id=v.owner_id and a.project_id=v.project_id
    where v.owner_id=r.owner_id and v.project_id=r.project_id and v.id=r.version_id and v.asset_id=r.asset_id
     and v.version=1 and v.input_revision=r.input_revision and v.input_hash=r.input_hash and v.content_hash=r.content_hash and v.mime_type=r.mime_type
     and a.purpose=r.purpose and a.kind='logo_'||r.source_kind
     and v.storage_path=r.owner_id::text||'/'||r.project_id::text||'/'||r.asset_id::text||'/'||r.version_id::text
     and v.provenance=jsonb_build_object('version',2,'publicationId',r.id,'sourceReceiptId',r.source_receipt_id)) then return null; end if;
  if r.purpose='reference_media' and r.source_kind='logo_reference' and r.job_id is null and r.lease_token is null
   and r.request->>'kind'='upload' and r.rights_evidence_id is not null
   and r.request#>>'{intent,requestKey}'=r.request_key::text and r.request#>>'{intent,usage}'='logo_reference'
   and r.request#>>'{intent,contentHash}'=r.content_hash and r.request#>>'{intent,mimeType}'=r.mime_type
   and r.request->'byteLength'=to_jsonb(r.byte_length) then
   for item in select value from jsonb_array_elements(q.source_inputs#>'{referenceSnapshot,references}') loop
    if item->'asset'=ref and item->>'sourceKind'='upload' and item->>'referenceId'=r.source_receipt_id::text
     and item->>'rightsEvidenceId'=r.rights_evidence_id::text and exists(
      select 1 from public.logo_reference_sources s
      join public.logo_input_rights rights on rights.id=s.rights_evidence_id and rights.owner_id=s.owner_id and rights.project_id=s.project_id
      join public.logo_input_requests request on request.owner_id=s.owner_id and request.project_id=s.project_id and request.request_key=r.request_key
      join public.logo_input_receipts receipt on receipt.owner_id=request.owner_id and receipt.project_id=request.project_id and receipt.request_key=request.request_key
      where s.reference_id=r.source_receipt_id and s.owner_id=r.owner_id and s.project_id=r.project_id
       and s.asset_id=r.asset_id and s.version_id=r.version_id and s.content_hash=r.content_hash and s.source_kind='upload'
       and s.rights_evidence_id=r.rights_evidence_id and rights.publication_id=r.id and rights.content_hash=r.content_hash
       and rights.source_kind='user_declaration' and rights.catalog_id is null and rights.license_text is null and rights.license_text_hash is null and rights.source_url is null
       and rights.rights_declaration=r.request#>>'{intent,rightsDeclaration}'
       and request.request->>'kind'='reference_upload' and request.request#>>'{input,requestKey}'=r.request_key::text
       and request.request#>>'{input,rightsDeclaration}'=rights.rights_declaration
       and request.request->'file'=jsonb_build_object('contentHash',r.content_hash,'mimeType',r.mime_type,'byteLength',r.byte_length)
       and receipt.reference_id=s.reference_id and receipt.font_record_id is null
       and receipt.result-'workspace'=jsonb_build_object('referenceId',s.reference_id,'asset',ref,'sourceKind','upload',
         'aspects',request.request#>'{input,aspects}','rightsEvidenceId',rights.id)
       and receipt.result#>>'{workspace,ownerId}'=r.owner_id::text and receipt.result#>>'{workspace,projectId}'=r.project_id::text
       and not exists(select 1 from public.logo_input_rejections rejected where rejected.owner_id=request.owner_id and rejected.project_id=request.project_id and rejected.request_key=request.request_key)
     ) then return 'reference'; end if;
   end loop;
  end if;
  if j.operation='identity.logo_refine' and j.input#>>'{source,kind}'='preview' and r.purpose='brand_asset'
   and r.source_kind='concept' and r.rights_evidence_id is null then
   resolved:=fluid_private.resolve_logo_raster_source(j.owner_id,j.project_id,j.input#>'{source,raster}');
   if resolved=q.source_inputs->'raster' and resolved->'preview'=fluid_private.logo_asset_receipt(r)
    and resolved#>'{preview,reference}'=ref and exists(select 1 from public.logo_raster_results result
     where result.job_id=r.job_id and result.owner_id=r.owner_id and result.project_id=r.project_id and result.preview=resolved->'preview') then return 'base'; end if;
  end if;
  return null;
 elsif p_mode is distinct from 'write' then return null; end if;
 source_id:=(case j.operation when 'identity.logo_concept' then j.input->>'attemptId' when 'identity.logo_refine' then j.input->>'rasterRevisionId' end)::uuid;
 if source_id is null or r.purpose is distinct from 'brand_asset' or r.job_id is distinct from j.id or r.lease_token is distinct from j.lease_token
  or r.state not in('reserved','staged') or r.rights_evidence_id is not null or r.source_kind is distinct from 'concept'
  or r.source_receipt_id is distinct from source_id or r.request_key is distinct from source_id
  or r.input_hash is distinct from j.input_hash or r.input_revision is distinct from j.input_revision
  or r.mime_type is distinct from 'image/png' or r.byte_length not between 1 and 8388608
  or r.request is distinct from jsonb_build_object('kind','stage','publication',jsonb_build_object('requestKey',source_id,
   'inputRevisions',fluid_private.logo_job_input_revisions(j),'mimeType',r.mime_type,'contentHash',r.content_hash,'byteLength',r.byte_length,
   'source',jsonb_build_object('kind','concept','sourceId',source_id))) then return null; end if;
 return 'output';
exception when invalid_text_representation or numeric_value_out_of_range or invalid_parameter_value or sqlstate 'P0002' or sqlstate '55000' then return null;
end $$;

create function public.authorize_logo_generative_storage(p_job uuid,p_lease uuid,p_reservation uuid,p_mode text)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare context jsonb:=fluid_private.logo_storage_context(); j public.jobs; r public.logo_asset_publications;
 p fluid_private.logo_runtime_policies; member text; result jsonb; previous fluid_private.logo_generative_storage_grants;
begin
 j:=fluid_private.logo_generative_storage_job(context,p_job,p_lease);
 if j.id is null or p_mode is null or p_mode not in('probe','read','write') or (p_mode='probe')<>(p_reservation is null) then
  raise exception 'logo_generative_storage_unavailable' using errcode='42501'; end if;
 select * into p from fluid_private.logo_runtime_policies where owner_id=j.owner_id and operation=j.operation;
 result:=context||jsonb_build_object('capability',fluid_private.logo_policy_descriptor(p),'jobId',j.id,'leaseToken',j.lease_token,
  'inputRevision',j.input_revision,'jobInput',j.input,'mode',p_mode,'reservation',null,'publication',null,'member',null);
 if p_mode='probe' then return result; end if;
 select * into r from public.logo_asset_publications where id=p_reservation and owner_id=j.owner_id and project_id=j.project_id;
 member:=fluid_private.logo_generative_storage_member(j,r,p_mode);
 if member is null then raise exception 'logo_generative_storage_unavailable' using errcode='42501'; end if;
 insert into fluid_private.logo_generative_storage_grants(session_id,auth_user_id,job_id,lease_token,reservation_id,mode,member,binding)
  values((context->>'sessionId')::uuid,(context->>'authUserId')::uuid,j.id,j.lease_token,r.id,p_mode,member,context)
  on conflict(session_id,job_id,lease_token,reservation_id,mode) do nothing;
 select * into previous from fluid_private.logo_generative_storage_grants where session_id=(context->>'sessionId')::uuid
  and job_id=j.id and lease_token=j.lease_token and reservation_id=r.id and mode=p_mode;
 if previous.auth_user_id is distinct from (context->>'authUserId')::uuid or previous.member is distinct from member
  or previous.binding is distinct from context then
  raise exception 'logo_generative_storage_unavailable' using errcode='42501'; end if;
 return result||jsonb_build_object('member',member,'reservation',fluid_private.logo_asset_reservation(r),
  'publication',case when p_mode='write' then r.request->'publication' else null end);
end $$;

-- Source reads may retain an older uploader only for exact committed members.
-- Write grants support immediate GET of their same reservation and uploader;
-- there is no general staged read or readback grant. Every statement rechecks.
-- Pin the grant-time role/OID as well as Auth/session/owner/worker identity. This
-- prevents stale grant reuse after rebinding; existing jobs do not record an
-- original claimant-role OID, so it does not establish that separate authority.
create function fluid_private.logo_generative_storage_object_allowed(p_bucket text,p_name text,p_owner text,p_access text)
returns boolean language plpgsql volatile security definer set search_path='' as $$
declare context jsonb:=fluid_private.logo_storage_context(); g fluid_private.logo_generative_storage_grants;
 j public.jobs; r public.logo_asset_publications;
begin
 if context is null or p_bucket is distinct from 'fluid-assets' or p_access is null or p_access not in('read','write') then return false; end if;
 for g in select grants.* from fluid_private.logo_generative_storage_grants grants join public.logo_asset_publications a on a.id=grants.reservation_id
  where grants.session_id=(context->>'sessionId')::uuid and grants.auth_user_id=(context->>'authUserId')::uuid
   and a.owner_id::text=context->>'ownerId' and p_name=a.owner_id::text||'/'||a.project_id::text||'/'||a.asset_id::text||'/'||a.version_id::text
   and (p_access='read' or grants.mode='write') loop
  if g.binding is distinct from context then continue; end if;
  if g.mode='write' and p_owner is distinct from context->>'authUserId' then continue; end if;
  j:=fluid_private.logo_generative_storage_job(context,g.job_id,g.lease_token);
  if j.id is null then continue; end if;
  select * into r from public.logo_asset_publications where id=g.reservation_id;
  if fluid_private.logo_generative_storage_member(j,r,g.mode)=g.member then return true; end if;
 end loop;
 return false;
end $$;

-- Scrub only these new objects, including arbitrary inherited default grantees.
-- Existing relation/function ACLs and default privileges remain unchanged.
do $$ declare object_name text; object_id oid; r record; c record; begin
 foreach object_name in array array['fluid_private.logo_generative_storage_capabilities','fluid_private.logo_generative_storage_grants'] loop
  object_id:=to_regclass(object_name);
  for r in select distinct a.grantee from pg_catalog.pg_class t cross join lateral pg_catalog.aclexplode(coalesce(t.relacl,pg_catalog.acldefault('r',t.relowner))) a where t.oid=object_id and a.grantee<>t.relowner loop
   execute pg_catalog.format('revoke all on table %s from %s cascade',object_id::regclass,case when r.grantee=0 then 'PUBLIC' else pg_catalog.quote_ident(pg_catalog.pg_get_userbyid(r.grantee)) end);
  end loop;
  for c in select at.attname,a.grantee from pg_catalog.pg_attribute at join pg_catalog.pg_class t on t.oid=at.attrelid cross join lateral pg_catalog.aclexplode(at.attacl) a where t.oid=object_id and a.grantee<>t.relowner loop
   execute pg_catalog.format('revoke all (%I) on table %s from %s cascade',c.attname,object_id::regclass,case when c.grantee=0 then 'PUBLIC' else pg_catalog.quote_ident(pg_catalog.pg_get_userbyid(c.grantee)) end);
  end loop;
 end loop;
 foreach object_name in array array['fluid_private.logo_generative_storage_job(jsonb,uuid,uuid)','fluid_private.logo_generative_storage_member(public.jobs,public.logo_asset_publications,text)',
  'public.authorize_logo_generative_storage(uuid,uuid,uuid,text)','fluid_private.logo_generative_storage_object_allowed(text,text,text,text)'] loop
  object_id:=to_regprocedure(object_name);
  for r in select distinct a.grantee from pg_catalog.pg_proc p cross join lateral pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a where p.oid=object_id and a.grantee<>p.proowner loop
   execute pg_catalog.format('revoke all on function %s from %s cascade',object_id::regprocedure,case when r.grantee=0 then 'PUBLIC' else pg_catalog.quote_ident(pg_catalog.pg_get_userbyid(r.grantee)) end);
  end loop;
 end loop;
end $$;
commit;
