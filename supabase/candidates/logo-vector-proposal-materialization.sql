-- UNAPPLIED TASK 3 CANDIDATE. No runtime activation, login, worker grant,
-- credentials, deployment or inference. Apply only after the frozen Task 2 chain.
-- Geometry/font bytes are verified by the authenticated producer outside locks;
-- this transaction repeats immutable source/publication and settlement bindings.
begin;

create table fluid_private.logo_vector_proposal_materializations(
 proposal_id uuid primary key, owner_id uuid not null, project_id uuid not null, request_key uuid not null,
 vector_revision_id uuid not null unique, revision_id uuid not null unique, stage text not null default 'refinements' check(stage='refinements'), record jsonb not null,
 unique(owner_id,project_id,request_key),
 foreign key(proposal_id,owner_id,project_id) references fluid_private.logo_vector_proposals(id,owner_id,project_id),
 foreign key(vector_revision_id,owner_id,project_id) references public.logo_vector_revisions(id,owner_id,project_id),
 foreign key(revision_id,project_id,owner_id,stage) references public.logo_stage_revisions(id,project_id,owner_id,stage),
 check((fluid_private.standalone_keys(record,array['version','ownerId','projectId','proposalId','requestKey','vectorRevisionId','revisionId','createdAt'])
  and record->'version'='1'::jsonb and record->>'ownerId'=owner_id::text and record->>'projectId'=project_id::text
  and record->>'proposalId'=proposal_id::text and record->>'requestKey'=request_key::text
  and record->>'vectorRevisionId'=vector_revision_id::text and record->>'revisionId'=revision_id::text
  and fluid_private.standalone_timestamp(record->'createdAt') and octet_length(record::text)<=4096) is true)
);
alter table fluid_private.logo_vector_proposal_materializations enable row level security;
alter table fluid_private.logo_vector_proposal_materializations force row level security;
create trigger logo_vector_proposal_materializations_immutable before update or delete on fluid_private.logo_vector_proposal_materializations for each row execute function fluid_private.prevent_history_change();

create function fluid_private.logo_vector_proposal_application_command_valid(v jsonb) returns boolean
language plpgsql immutable set search_path='' as $$
declare b jsonb:=v->'body';check_command jsonb;
begin
 if fluid_private.standalone_keys(v,array['method','body']) is distinct from true or v->>'method' is distinct from 'applyLogoVectorProposal' or octet_length(v::text)>32768
  or fluid_private.standalone_keys(b,array['requestKey','expected','baseVectorRevisionId','proposalId']) is distinct from true
  or fluid_private.logo_uuid(b->'baseVectorRevisionId') is distinct from true or fluid_private.logo_uuid(b->'proposalId') is distinct from true then return false;end if;
 check_command:=jsonb_build_object('method','restoreLogoStage','body',jsonb_build_object('requestKey',b->'requestKey','expected',b->'expected','stage','concepts','revisionId','00000000-0000-4000-8000-000000000001','acceptEarlierBasis',false));
 return fluid_private.logo_base_command_valid(check_command) is true;
exception when others then return false;
end $$;

-- Pure authoritative read. The immutable succeeded proposal may precede job
-- settlement or survive cancellation; neither permits materialization alone.
-- Current policy/readiness and the old lease are intentionally not consulted.
create function fluid_private.logo_vector_proposal_materializable(p fluid_private.logo_vector_proposals) returns boolean
language plpgsql stable set search_path='' as $$
declare j public.jobs;s public.job_steps;q public.logo_cost_quotes;r public.logo_provider_responses;
 a fluid_private.logo_vector_proposal_dispatches;prepared fluid_private.logo_vector_proposal_prepared_results;
 reservation public.usage_reservations;account public.usage_accounts;cost bigint;receipt jsonb;expected jsonb;
begin
 if p.id is null or p.record->>'state' is distinct from 'succeeded' or p.record#>>'{payload,status}' is distinct from 'proposed' then return false;end if;
 select * into j from public.jobs where id=p.job_id and owner_id=p.owner_id and project_id=p.project_id;
 select * into s from public.job_steps where job_id=p.job_id and owner_id=p.owner_id and project_id=p.project_id and step_key='propose-vector-edit';
 select * into q from public.logo_cost_quotes where id=p.quote_id and owner_id=p.owner_id and project_id=p.project_id;
 select * into a from fluid_private.logo_vector_proposal_dispatches where job_id=p.job_id and owner_id=p.owner_id and project_id=p.project_id;
 select * into prepared from fluid_private.logo_vector_proposal_prepared_results where id=p.id and job_id=p.job_id and owner_id=p.owner_id and project_id=p.project_id;
 select * into r from public.logo_provider_responses where id=prepared.provider_receipt_id and job_id=p.job_id and owner_id=p.owner_id and project_id=p.project_id;
 if j.id is null or j.state is distinct from 'succeeded' or j.finished_at is null or j.cancel_requested_at is not null or j.error_code is not null
  or j.lease_token is not null or j.lease_expires_at is not null or j.attempts<>1
  or fluid_private.logo_vector_proposal_job_quote_matches(j,q) is distinct from true
  or a.job_id is null or a.input is distinct from j.input or a.worker_id is distinct from j.worker_id or a.quote_id is distinct from q.id
  or s.id is null or s.state is distinct from 'succeeded' or s.completed_at is null or s.step_key is distinct from a.step_key or s.request_key is distinct from a.step_request_key
  or s.reserved_cost_microusd is distinct from j.reserved_cost_microusd or (select count(*) from public.job_steps where job_id=j.id)<>1
  or prepared.id is null or prepared.quote_id is distinct from q.id or prepared.lease_token is distinct from a.lease_token
  or prepared.input_hash is distinct from j.input_hash or prepared.context_hash is distinct from j.input->>'contextHash'
  or prepared.result->>'status' is distinct from 'valid' or prepared.result#>>'{payload,status}' is distinct from 'proposed'
  or r.id is null or r.lease_token is distinct from a.lease_token or s.provider_request_id is distinct from r.observation->>'providerRequestId'
  or s.output is distinct from jsonb_build_object('version',1,'kind','logo_vector_proposal','preparedId',prepared.id,'providerResponseReceiptId',r.id)
  or fluid_private.valid_logo_vector_proposal_observation(r.observation,j.input->'textPolicy') is distinct from true
  or fluid_private.logo_vector_proposal_result_valid(prepared.result,q.source_inputs->'context',r.observation) is distinct from true
  or r.observation->'responseComplete' is distinct from 'true'::jsonb or r.observation->'responseId'='null'::jsonb or r.observation->'responseHash'='null'::jsonb
  or r.observation#>>'{billing,status}' is distinct from 'recorded'
  or (r.observation#>>'{usage,inputTokens}')::numeric>(j.input#>>'{textPolicy,maxInputTokens}')::numeric
  or (r.observation#>>'{usage,outputTokens}')::numeric>(j.input#>>'{textPolicy,maxOutputTokens}')::numeric then return false;end if;
 cost:=(r.observation#>>'{billing,confirmedMicrousd}')::bigint;
 select * into reservation from public.usage_reservations where job_id=j.id and owner_id=j.owner_id and project_id=j.project_id;
 select * into account from public.usage_accounts where owner_id=j.owner_id;
 if cost>j.reserved_cost_microusd or reservation.job_id is null or account.owner_id is null or reservation.state is distinct from 'settled'
  or reservation.reserved_microusd is distinct from j.reserved_cost_microusd or reservation.actual_microusd is distinct from cost or reservation.captured_microusd is distinct from cost
  or j.actual_cost_microusd is distinct from cost or s.actual_cost_microusd is distinct from cost or account.spent_microusd<cost or account.provider_actual_microusd<cost then return false;end if;
 receipt:=jsonb_build_object('id',r.id,'ownerId',r.owner_id,'projectId',r.project_id,'jobId',r.job_id,'leaseToken',r.lease_token,'observation',r.observation);
 expected:=jsonb_build_object('version',1,'id',prepared.id,'ownerId',j.owner_id,'projectId',j.project_id,'jobId',j.id,'requestKey',j.input->'requestKey','quoteId',q.id,'baseVectorRevisionId',j.input->'baseVectorRevisionId','contextHash',prepared.context_hash,'inputRevisions',q.input_revisions,'expected',q.record->'expected','context',q.source_inputs->'context','state','succeeded','payload',prepared.result->'payload','providerReceipt',receipt,'actualCostMicrousd',cost,'reason',null,'createdAt',to_char(prepared.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'materialization','unavailable');
 return p.record=expected and p.request_key::text=j.input->>'requestKey' and p.base_vector_revision_id::text=j.input->>'baseVectorRevisionId';
exception when others then return false;
end $$;

-- Committed metadata bindings complement (never replace) actual authenticated
-- byte verification in the producer. Both publication and immutable asset row
-- must identify exactly the retained owned reference.
create function fluid_private.logo_vector_proposal_owned_asset_valid(p_owner uuid,p_project uuid,p_reference jsonb,p_kind text) returns boolean
language sql stable set search_path='' as $$
 select exists(select 1 from public.logo_asset_publications r
  join public.asset_versions v on v.id=r.version_id and v.asset_id=r.asset_id and v.owner_id=r.owner_id and v.project_id=r.project_id
  join public.assets a on a.id=v.asset_id and a.owner_id=v.owner_id and a.project_id=v.project_id
  where r.owner_id=p_owner and r.project_id=p_project and r.state='committed' and r.purpose='brand_asset' and a.purpose='brand_asset'
   and fluid_private.logo_asset_reservation(r)->'reference'=p_reference
   and v.content_hash=r.content_hash and v.mime_type=r.mime_type and v.storage_path=r.owner_id::text||'/'||r.project_id::text||'/'||r.asset_id::text||'/'||r.version_id::text
   and r.verification->>'status'='verified' and r.verification->>'contentHash'=r.content_hash and r.verification->>'mimeType'=r.mime_type and r.verification->'byteLength'=to_jsonb(r.byte_length)
   and case p_kind when 'document' then r.mime_type='application/json' when 'svg' then r.mime_type='image/svg+xml'
    when 'raster' then r.mime_type in('image/png','image/jpeg','image/webp') when 'font' then r.mime_type in('font/ttf','font/otf','font/woff','font/woff2') else false end)
$$;
create function fluid_private.logo_vector_proposal_basis_current(p fluid_private.logo_vector_proposals) returns boolean
language plpgsql stable set search_path='' as $$
declare q public.logo_cost_quotes;base jsonb;brief jsonb;f jsonb;stored jsonb;
begin
 select * into q from public.logo_cost_quotes where id=p.quote_id and owner_id=p.owner_id and project_id=p.project_id;
 if q.id is null or fluid_private.logo_vector_proposal_quote_binding(q) is distinct from true
  or fluid_private.logo_workspace_json(p.owner_id,p.project_id)->'heads' is distinct from q.record->'expected'
  or fluid_private.logo_current_vector_id(p.owner_id,p.project_id) is distinct from p.base_vector_revision_id then return false;end if;
 select record into base from public.logo_vector_revisions where id=p.base_vector_revision_id and owner_id=p.owner_id and project_id=p.project_id;
 if base is null or base is distinct from q.source_inputs->'baseRevision'
  or exists(select 1 from jsonb_array_elements(base->'inputRevisions') i left join public.logo_stage_heads h on h.owner_id=p.owner_id and h.project_id=p.project_id and h.stage=i->>'stage' where h.revision_id::text is distinct from i->>'id')
  or fluid_private.logo_vector_proposal_owned_asset_valid(p.owner_id,p.project_id,base->'sourcePreview','raster') is distinct from true
  or fluid_private.logo_vector_proposal_owned_asset_valid(p.owner_id,p.project_id,base->'documentAsset','document') is distinct from true
  or fluid_private.logo_vector_proposal_owned_asset_valid(p.owner_id,p.project_id,base->'svgAsset','svg') is distinct from true then return false;end if;
 select record into brief from public.logo_stage_revisions where id=(q.source_inputs#>>'{brief,id}')::uuid and owner_id=p.owner_id and project_id=p.project_id and stage='brief_references';
 if brief is null or brief is distinct from q.source_inputs->'brief' then return false;end if;
 for f in select value from jsonb_array_elements(q.source_inputs->'fonts') loop
  select record into stored from public.logo_font_records where record_id=(f->>'id')::uuid and owner_id=p.owner_id and project_id=p.project_id;
  if stored is null or stored is distinct from f or f#>>'{rights,commercialUse}' is distinct from 'allowed' or f#>>'{rights,sourceKind}' is distinct from 'reviewed_license'
   or f#>>'{rights,permissions,render}' is distinct from 'allowed' or f#>>'{rights,permissions,outline}' is distinct from 'allowed'
   or f#>'{rights,fontContentHash}' is distinct from f#>'{asset,contentHash}' or fluid_private.standalone_timestamp(f#>'{rights,reviewedAt}') is distinct from true
   or fluid_private.logo_vector_proposal_owned_asset_valid(p.owner_id,p.project_id,f->'asset','font') is distinct from true then return false;end if;
 end loop;
 return true;
exception when others then return false;
end $$;

create function public.read_logo_vector_proposal_application(p_project_id uuid,p_proposal_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare owner uuid:=auth.uid();p fluid_private.logo_vector_proposals;prepared fluid_private.logo_vector_proposal_prepared_results;m jsonb;
begin
 if owner is null then raise exception 'unauthenticated' using errcode='42501';end if;
 if not exists(select 1 from public.projects where id=p_project_id and owner_id=owner) then raise exception 'logo_project_not_found' using errcode='P0002';end if;
 select * into p from fluid_private.logo_vector_proposals where id=p_proposal_id and owner_id=owner and project_id=p_project_id;
 if not found then raise exception 'logo_proposal_not_found' using errcode='P0002';end if;
 select * into prepared from fluid_private.logo_vector_proposal_prepared_results where id=p.id and job_id=p.job_id and owner_id=owner and project_id=p_project_id;
 select record into m from fluid_private.logo_vector_proposal_materializations where proposal_id=p.id and owner_id=owner and project_id=p_project_id;
 return jsonb_build_object('proposal',p.record,'preparedId',prepared.id,'providerResponseReceiptId',prepared.provider_receipt_id,'materialization',m,'eligible',m is null and fluid_private.logo_vector_proposal_materializable(p) and fluid_private.logo_vector_proposal_basis_current(p));
end $$;

-- Deliberately separate from the manual publisher and VTracer publication path.
-- No fake command, synthetic provider receipt or manual provenance is introduced.
create function fluid_private.commit_logo_vector_proposal(p_owner uuid,p_project uuid,p_command jsonb,p_evidence jsonb) returns jsonb
language plpgsql set search_path='' as $$
declare b jsonb:=p_command->'body';p fluid_private.logo_vector_proposals;prepared fluid_private.logo_vector_proposal_prepared_results;q public.logo_cost_quotes;
 base jsonb;brief jsonb;f jsonb;stored jsonb;summary jsonb;c jsonb;d public.logo_asset_publications;s public.logo_asset_publications;
 v jsonb;payload jsonb;revision jsonb;association jsonb;digest text;document_key uuid;svg_key uuid;cancelled public.logo_vector_edit_cancellations;
begin
 if fluid_private.logo_asset_web_owner() is distinct from p_owner then raise exception 'logo_principal_mismatch' using errcode='42501';end if;
 if fluid_private.logo_vector_proposal_application_command_valid(p_command) is distinct from true then raise exception 'invalid_logo_proposal_application' using errcode='22023';end if;
 perform pg_advisory_xact_lock(hashtextextended(p_owner::text,723902));
 perform 1 from public.projects where id=p_project and owner_id=p_owner for update;
 if not found then raise exception 'logo_project_not_found' using errcode='P0002';end if;
 select * into cancelled from public.logo_vector_edit_cancellations where owner_id=p_owner and project_id=p_project and request_key=(b->>'requestKey')::uuid;
 if found then
  if cancelled.command is distinct from p_command then raise exception 'logo_request_conflict' using errcode='PT409';end if;
  raise exception 'logo_edit_cancelled' using errcode='PT409';
 end if;
 select * into p from fluid_private.logo_vector_proposals where id=(b->>'proposalId')::uuid and owner_id=p_owner and project_id=p_project;
 if not found then raise exception 'logo_proposal_not_found' using errcode='P0002';end if;
 if exists(select 1 from fluid_private.logo_vector_proposal_materializations where proposal_id=p.id) then raise exception 'logo_proposal_already_materialized' using errcode='PT409';end if;
 -- Financial rows are held through the CAS; no expense is changed here.
 perform 1 from public.jobs where id=p.job_id for share;
 perform 1 from public.job_steps where job_id=p.job_id for share;
 perform 1 from public.usage_reservations where job_id=p.job_id for share;
 perform 1 from public.usage_accounts where owner_id=p_owner for share;
 if fluid_private.logo_vector_proposal_materializable(p) is distinct from true then raise exception 'logo_proposal_not_materializable' using errcode='PT409';end if;
 select * into prepared from fluid_private.logo_vector_proposal_prepared_results where id=p.id and owner_id=p_owner and project_id=p_project;
 select * into q from public.logo_cost_quotes where id=p.quote_id and owner_id=p_owner and project_id=p_project;
 c:=q.source_inputs->'context';
 if fluid_private.logo_vector_proposal_basis_current(p) is distinct from true then raise exception 'logo_proposal_source_changed' using errcode='PT409';end if;
 if fluid_private.standalone_keys(p_evidence,array['proposalId','preparedId','providerResponseReceiptId','baseVectorRevisionId','contextHash','baseRevision','brief','fonts','documentPublicationId','svgPublicationId','documentHash','proof','locks']) is distinct from true
  or octet_length(p_evidence::text)>2097152 or p_evidence->'proposalId' is distinct from b->'proposalId' or p_evidence->>'preparedId' is distinct from prepared.id::text
  or p_evidence->>'providerResponseReceiptId' is distinct from prepared.provider_receipt_id::text or p_evidence->'baseVectorRevisionId' is distinct from b->'baseVectorRevisionId'
  or b->>'baseVectorRevisionId' is distinct from p.base_vector_revision_id::text or p_evidence->>'contextHash' is distinct from prepared.context_hash
  or fluid_private.logo_uuid(p_evidence->'documentPublicationId') is distinct from true or fluid_private.logo_uuid(p_evidence->'svgPublicationId') is distinct from true
  or fluid_private.logo_vector_proof_valid(p_evidence->'proof') is distinct from true or p_evidence->'documentHash' is distinct from p_evidence#>'{proof,documentHash}'
  or fluid_private.logo_vector_locks_valid(p_evidence->'locks') is distinct from true then raise exception 'invalid_logo_proposal_evidence' using errcode='22023';end if;
 if fluid_private.logo_workspace_json(p_owner,p_project)->'heads' is distinct from b->'expected' or b->'expected' is distinct from q.record->'expected' then raise exception 'logo_head_conflict' using errcode='PT409';end if;
 select record into base from public.logo_vector_revisions where id=p.base_vector_revision_id and owner_id=p_owner and project_id=p_project for share;
 if base is null or fluid_private.logo_current_vector_id(p_owner,p_project) is distinct from p.base_vector_revision_id
  or base is distinct from p_evidence->'baseRevision' or base is distinct from q.source_inputs->'baseRevision'
  or c->'documentHash' is distinct from base->'documentHash' or c->'locks' is distinct from base->'locks' or c->'source' is distinct from base->'source'
  or c->'inputRevisions' is distinct from base->'inputRevisions' or c->'viewBox' is distinct from base#>'{proof,viewBox}'
  or p_evidence->'documentHash' is not distinct from base->'documentHash'
  or p_evidence#>'{proof,viewBox}' is distinct from base#>'{proof,viewBox}' or p_evidence#>'{proof,componentCount}' is distinct from base#>'{proof,componentCount}'
  or p_evidence->'locks' is distinct from base->'locks' or fluid_private.logo_vector_proof_valid(base->'proof') is distinct from true
  or base->'documentHash' is distinct from base#>'{documentAsset,contentHash}' or base->'documentHash' is distinct from base#>'{proof,documentHash}'
  or exists(select 1 from jsonb_array_elements(base->'inputRevisions') i left join public.logo_stage_heads h on h.owner_id=p_owner and h.project_id=p_project and h.stage=i->>'stage' where h.revision_id::text is distinct from i->>'id') then raise exception 'logo_proposal_source_changed' using errcode='PT409';end if;
 select record into brief from public.logo_stage_revisions where id=(c#>>'{brief,id}')::uuid and owner_id=p_owner and project_id=p_project and stage='brief_references' for share;
 if brief is null or brief is distinct from p_evidence->'brief' or brief is distinct from q.source_inputs->'brief'
  or c->'brief' is distinct from jsonb_build_object('id',brief->'id','revision',brief->'revision','inputHash',brief->'inputHash','name',brief#>'{payload,name}')
  or not exists(select 1 from jsonb_array_elements(base->'inputRevisions') i where i->>'stage'='brief_references' and i->'id'=brief->'id' and i->'revision'=brief->'revision') then raise exception 'logo_proposal_source_changed' using errcode='PT409';end if;
 if p_evidence->'fonts' is distinct from q.source_inputs->'fonts' or jsonb_typeof(p_evidence->'fonts') is distinct from 'array'
  or jsonb_array_length(p_evidence->'fonts') is distinct from jsonb_array_length(c->'fonts') then raise exception 'logo_proposal_source_changed' using errcode='PT409';end if;
 for f in select value from jsonb_array_elements(p_evidence->'fonts') loop
  select record into stored from public.logo_font_records where record_id=(f->>'id')::uuid and owner_id=p_owner and project_id=p_project for share;
  select value into summary from jsonb_array_elements(c->'fonts') font where font->'id'=f->'id';
  if stored is null or stored is distinct from f or summary is null
   or summary->'family' is distinct from f->'family' or summary->'source' is distinct from f->'source'
   or summary->'assetVersionId' is distinct from f#>'{asset,versionId}' or summary->'fontContentHash' is distinct from f#>'{asset,contentHash}'
   or summary->'rightsEvidenceId' is distinct from f#>'{rights,id}' or f#>'{rights,fontContentHash}' is distinct from f#>'{asset,contentHash}'
   or f#>>'{rights,commercialUse}' is distinct from 'allowed' or f#>>'{rights,sourceKind}' is distinct from 'reviewed_license'
   or f#>>'{rights,permissions,render}' is distinct from 'allowed' or f#>>'{rights,permissions,outline}' is distinct from 'allowed'
   or fluid_private.standalone_timestamp(f#>'{rights,reviewedAt}') is distinct from true then raise exception 'logo_proposal_source_changed' using errcode='PT409';end if;
 end loop;
 select * into d from public.logo_asset_publications where id=(p_evidence->>'documentPublicationId')::uuid for update;
 select * into s from public.logo_asset_publications where id=(p_evidence->>'svgPublicationId')::uuid for update;
 digest:=encode(sha256(convert_to('fluid.logo-vector.publication.v1:'||(b->>'requestKey')||':document','UTF8')),'hex');
 document_key:=(substr(digest,1,8)||'-'||substr(digest,9,4)||'-5'||substr(digest,14,3)||'-a'||substr(digest,18,3)||'-'||substr(digest,21,12))::uuid;
 digest:=encode(sha256(convert_to('fluid.logo-vector.publication.v1:'||(b->>'requestKey')||':svg','UTF8')),'hex');
 svg_key:=(substr(digest,1,8)||'-'||substr(digest,9,4)||'-5'||substr(digest,14,3)||'-a'||substr(digest,18,3)||'-'||substr(digest,21,12))::uuid;
 if not fluid_private.logo_vector_member_valid(d,p_owner,p_project,p.base_vector_revision_id,base->'inputRevisions','application/json',p_evidence->>'documentHash')
  or not fluid_private.logo_vector_member_valid(s,p_owner,p_project,p.base_vector_revision_id,base->'inputRevisions','image/svg+xml',p_evidence#>>'{proof,svgContentHash}')
  or d.id=s.id or d.asset_id=s.asset_id or d.version_id=s.version_id or d.job_id is not null or s.job_id is not null
  or d.state is distinct from 'staged' or s.state is distinct from 'staged' or d.request_key is distinct from document_key or s.request_key is distinct from svg_key then raise exception 'invalid_logo_vector_members' using errcode='55000';end if;
 perform fluid_private.logo_commit_asset(d);perform fluid_private.logo_commit_asset(s);
 v:=jsonb_build_object('id',gen_random_uuid(),'ownerId',p_owner,'projectId',p_project,'parentRevisionId',base->'id','source',base->'source','sourcePreview',base->'sourcePreview',
  'documentAsset',fluid_private.logo_asset_reservation(d)->'reference','svgAsset',fluid_private.logo_asset_reservation(s)->'reference','documentHash',p_evidence->'documentHash',
  'proof',p_evidence->'proof','locks',p_evidence->'locks','inputRevisions',base->'inputRevisions','reviewStatus','review_required','createdAt',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
 insert into public.logo_vector_revisions(id,owner_id,project_id,record) values((v->>'id')::uuid,p_owner,p_project,v);
 select r.record->'payload' into payload from public.logo_stage_heads h join public.logo_stage_revisions r on r.id=h.revision_id and r.owner_id=h.owner_id and r.project_id=h.project_id where h.owner_id=p_owner and h.project_id=p_project and h.stage='refinements';
 payload:=jsonb_build_object('rasterRevisionIds',coalesce(payload->'rasterRevisionIds','[]'::jsonb),'vectorRevisionId',v->'id','approvalId',null,'sourceRequestKey',b->'requestKey');
 revision:=fluid_private.logo_append_stage(p_owner,p_project,'refinements',payload,base->'inputRevisions');
 association:=jsonb_build_object('version',1,'ownerId',p_owner,'projectId',p_project,'proposalId',p.id,'requestKey',b->'requestKey','vectorRevisionId',v->'id','revisionId',revision->'id','createdAt',v->'createdAt');
 insert into fluid_private.logo_vector_proposal_materializations(proposal_id,owner_id,project_id,request_key,vector_revision_id,revision_id,record)
  values(p.id,p_owner,p_project,(b->>'requestKey')::uuid,(v->>'id')::uuid,(revision->>'id')::uuid,association);
 return revision;
end $$;

-- Exact predecessor patches preserve existing OIDs, owners, ACLs and metadata.
do $patch$ declare body text;definition text;begin
 select prosrc into body from pg_proc where oid='fluid_private.logo_vector_edit_cancel_command_valid(jsonb)'::regprocedure;
 if encode(sha256(convert_to(body,'UTF8')),'hex') is distinct from 'e41c6badbd5cf834bf898eb09e1e795c3702d3aa506901f0f0352700e5777950' then raise exception 'proposal_materialization_predecessor_mismatch: fluid_private.logo_vector_edit_cancel_command_valid(jsonb)' using errcode='55000';end if;
 definition:=pg_get_functiondef('fluid_private.logo_vector_edit_cancel_command_valid(jsonb)'::regprocedure);execute replace(definition,body,$replacement$
declare b jsonb:=v->'body'; e jsonb:=b->'edit'; k text:=e->>'kind'; item jsonb; t jsonb; ids jsonb; check_command jsonb;
begin
 if v->>'method'='applyLogoVectorProposal' then return fluid_private.logo_vector_proposal_application_command_valid(v);end if;
 if not fluid_private.standalone_keys(v,array['method','body']) or v->>'method' is distinct from 'saveLogoEdit' or octet_length(v::text)>32768
  or not fluid_private.standalone_keys(b,array['requestKey','expected','baseVectorRevisionId','edit']) or not fluid_private.logo_uuid(b->'baseVectorRevisionId') then return false;end if;
 check_command:=jsonb_build_object('method','restoreLogoStage','body',jsonb_build_object('requestKey',b->'requestKey','expected',b->'expected','stage','concepts','revisionId','00000000-0000-4000-8000-000000000001','acceptEarlierBasis',false));
 if fluid_private.logo_base_command_valid(check_command) is distinct from true then return false;end if;
 if k in('text','font','spacing','size','rotation','color','replace_outlined_lettering') and
  (jsonb_typeof(e->'componentId') is distinct from 'string' or length(e->>'componentId') not between 1 and 200 or e->>'componentId'!~'^[A-Za-z0-9][A-Za-z0-9._:-]*$') then return false;end if;
 case k
 when 'text' then return fluid_private.standalone_keys(e,array['kind','componentId','text']) and jsonb_typeof(e->'text')='string' and char_length(e->>'text') between 1 and 200;
 when 'font' then return fluid_private.standalone_keys(e,array['kind','componentId','fontVersionId']) and fluid_private.logo_uuid(e->'fontVersionId');
 when 'spacing' then return fluid_private.standalone_keys(e,array['kind','componentId','letterSpacing','lineHeight']) and jsonb_typeof(e->'letterSpacing')='number' and(e->>'letterSpacing')::numeric between -1000000 and 1000000 and jsonb_typeof(e->'lineHeight')='number' and(e->>'lineHeight')::numeric>0 and(e->>'lineHeight')::numeric<=100;
 when 'size' then return fluid_private.standalone_keys(e,array['kind','componentId','scale']) and jsonb_typeof(e->'scale')='number' and(e->>'scale')::numeric between 0.01 and 100;
 when 'rotation' then return fluid_private.standalone_keys(e,array['kind','componentId','degrees']) and jsonb_typeof(e->'degrees')='number' and(e->>'degrees')::numeric between -180 and 180;
 when 'color' then return fluid_private.standalone_keys(e,array['kind','componentId','fill','stroke']) and(e->'fill'='null'::jsonb or(jsonb_typeof(e->'fill')='string' and e->>'fill'~'^#[0-9A-F]{6}$')) and(e->'stroke'='null'::jsonb or(jsonb_typeof(e->'stroke')='string' and e->>'stroke'~'^#[0-9A-F]{6}$'));
 when 'replace_outlined_lettering' then return fluid_private.standalone_keys(e-'contentKind',array['kind','componentId','fontVersionId','text']) and(not(e?'contentKind') or e->>'contentKind' in('brand_name','approved_initials')) and fluid_private.logo_uuid(e->'fontVersionId') and jsonb_typeof(e->'text')='string' and char_length(e->>'text') between 1 and 200;
 when 'locks' then
  if not fluid_private.standalone_keys(e,array['kind','componentIds']) or jsonb_typeof(e->'componentIds') is distinct from 'array' or jsonb_array_length(e->'componentIds')>64 then return false;end if;
  ids:=e->'componentIds';
 when 'arrangement' then
  if not fluid_private.standalone_keys(e,array['kind','placements','order']) or jsonb_typeof(e->'placements') is distinct from 'array' or jsonb_array_length(e->'placements') not between 1 and 64 or jsonb_typeof(e->'order') is distinct from 'array' or jsonb_array_length(e->'order') not between 1 and 64 then return false;end if;
  if(select count(*) from jsonb_array_elements(e->'placements'))<>(select count(distinct value->'componentId') from jsonb_array_elements(e->'placements')) then return false;end if;
  for item in select value from jsonb_array_elements(e->'placements') loop
   t:=item->'transform';
   if not fluid_private.standalone_keys(item,array['componentId','transform']) or not(e->'order'@>jsonb_build_array(item->'componentId')) or not fluid_private.standalone_keys(t,array['x','y','scale','rotation'])
    or jsonb_typeof(t->'x') is distinct from 'number' or(t->>'x')::numeric not between -1000000 and 1000000 or jsonb_typeof(t->'y') is distinct from 'number' or(t->>'y')::numeric not between -1000000 and 1000000
    or jsonb_typeof(t->'scale') is distinct from 'number' or(t->>'scale')::numeric not between 0.01 and 100 or jsonb_typeof(t->'rotation') is distinct from 'number' or(t->>'rotation')::numeric not between -180 and 180 then return false;end if;
  end loop;
  ids:=e->'order';
 when 'group_components' then
  if not fluid_private.standalone_keys(e,array['kind','regions']) or jsonb_typeof(e->'regions') is distinct from 'array' or jsonb_array_length(e->'regions') not between 1 and 64 then return false;end if;
  for item in select value from jsonb_array_elements(e->'regions') loop
   t:=item->'bounds';
   if not fluid_private.standalone_keys(item,array['id','role','bounds']) or jsonb_typeof(item->'role') is distinct from 'string' or item->>'role' not in('symbol','lettering','illustration','border','whole_artwork') or jsonb_typeof(t) is distinct from 'array' or jsonb_array_length(t)<>4
    or jsonb_typeof(t->0) is distinct from 'number' or(t->>0)::numeric not between -1000000 and 1000000 or jsonb_typeof(t->1) is distinct from 'number' or(t->>1)::numeric not between -1000000 and 1000000
    or jsonb_typeof(t->2) is distinct from 'number' or(t->>2)::numeric<=0 or(t->>2)::numeric>16384 or jsonb_typeof(t->3) is distinct from 'number' or(t->>3)::numeric<=0 or(t->>3)::numeric>16384 then return false;end if;
  end loop;
  select jsonb_agg(value->'id') into ids from jsonb_array_elements(e->'regions');
 else return false;
 end case;
 if(select count(*) from jsonb_array_elements(ids))<>(select count(distinct value) from jsonb_array_elements(ids)) then return false;end if;
 for item in select value from jsonb_array_elements(ids) loop
  if jsonb_typeof(item) is distinct from 'string' or length(item#>>'{}') not between 1 and 200 or item#>>'{}'!~'^[A-Za-z0-9][A-Za-z0-9._:-]*$' then return false;end if;
 end loop;
 return true;
exception when others then return false;
end $replacement$);
end $patch$;

do $patch$ declare body text;definition text;begin
 select prosrc into body from pg_proc where oid='fluid_private.logo_vector_edit_request_state(uuid,uuid,uuid)'::regprocedure;
 if encode(sha256(convert_to(body,'UTF8')),'hex') is distinct from '84c8b51929c05790d891cfc42f89ca22c2e9f909cb3961961e1aea67754eca64' then raise exception 'proposal_materialization_predecessor_mismatch: fluid_private.logo_vector_edit_request_state(uuid,uuid,uuid)' using errcode='55000';end if;
 definition:=pg_get_functiondef('fluid_private.logo_vector_edit_request_state(uuid,uuid,uuid)'::regprocedure);execute replace(definition,body,$replacement$
declare prior public.logo_workspace_requests; cancelled public.logo_vector_edit_cancellations;
begin
 select * into prior from public.logo_workspace_requests where owner_id=p_owner and project_id=p_project and request_key=p_key and method<>'startLogoProject';
 if found then
  if prior.method not in('saveLogoEdit','applyLogoVectorProposal') then raise exception 'logo_request_conflict' using errcode='PT409';end if;
  return jsonb_build_object('status','succeeded','ownerId',p_owner,'projectId',p_project,'requestKey',p_key,'command',prior.input,'receipt',prior.receipt);
 end if;
 select * into cancelled from public.logo_vector_edit_cancellations where owner_id=p_owner and project_id=p_project and request_key=p_key;
 if found then return jsonb_build_object('status','cancelled','ownerId',p_owner,'projectId',p_project,'requestKey',p_key,'command',cancelled.command);end if;
 return jsonb_build_object('status','not_found');
end $replacement$);
end $patch$;

do $patch$ declare body text;definition text;begin
 select prosrc into body from pg_proc where oid='fluid_private.read_logo_trusted_request(uuid,jsonb)'::regprocedure;
 if encode(sha256(convert_to(body,'UTF8')),'hex') is distinct from '76711bfe2bc73d344d182f37030301cf2fb97b78245542c42432977db31572fb' then raise exception 'proposal_materialization_predecessor_mismatch: fluid_private.read_logo_trusted_request(uuid,jsonb)' using errcode='55000';end if;
 definition:=pg_get_functiondef('fluid_private.read_logo_trusted_request(uuid,jsonb)'::regprocedure);execute replace(definition,body,$replacement$
declare owner uuid:=fluid_private.logo_asset_web_owner();existing public.logo_workspace_requests;cancelled public.logo_vector_edit_cancellations;
begin
 if not exists(select 1 from public.projects where id=p_project and owner_id=owner) then raise exception 'logo_project_not_found' using errcode='P0002';end if;
 if not fluid_private.logo_uuid(p_command#>'{body,requestKey}') then raise exception 'invalid_logo_request' using errcode='22023';end if;
 select * into existing from public.logo_workspace_requests where owner_id=owner and project_id=p_project and request_key=(p_command#>>'{body,requestKey}')::uuid and method<>'startLogoProject';
 if found then
  if existing.input is distinct from p_command then raise exception 'logo_request_conflict' using errcode='PT409';end if;return existing.receipt;
 end if;
 select * into cancelled from public.logo_vector_edit_cancellations where owner_id=owner and project_id=p_project and request_key=(p_command#>>'{body,requestKey}')::uuid;
 if found then
  if cancelled.command is distinct from p_command then raise exception 'logo_request_conflict' using errcode='PT409';end if;
  raise exception 'logo_edit_cancelled' using errcode='PT409';
 end if;
 if p_command->>'method'='applyLogoVectorProposal' then
  if fluid_private.logo_vector_proposal_application_command_valid(p_command) is distinct from true then raise exception 'invalid_logo_proposal_application' using errcode='22023';end if;
  if exists(select 1 from public.logo_operation_requests where owner_id=owner and project_id=p_project and request_key=(p_command#>>'{body,requestKey}')::uuid)
   or exists(select 1 from public.logo_operation_rejections where owner_id=owner and project_id=p_project and request_key=(p_command#>>'{body,requestKey}')::uuid) then raise exception 'logo_request_conflict' using errcode='PT409';end if;
  if not exists(select 1 from fluid_private.logo_vector_proposals where id=(p_command#>>'{body,proposalId}')::uuid and owner_id=owner and project_id=p_project) then raise exception 'logo_proposal_not_found' using errcode='P0002';end if;
  if exists(select 1 from fluid_private.logo_vector_proposal_materializations where proposal_id=(p_command#>>'{body,proposalId}')::uuid and owner_id=owner and project_id=p_project) then raise exception 'logo_proposal_already_materialized' using errcode='PT409';end if;
  if not exists(select 1 from fluid_private.logo_vector_proposals p where p.id=(p_command#>>'{body,proposalId}')::uuid and p.owner_id=owner and p.project_id=p_project and fluid_private.logo_vector_proposal_materializable(p)) then raise exception 'logo_proposal_not_materializable' using errcode='PT409';end if;
  if not exists(select 1 from fluid_private.logo_vector_proposals p where p.id=(p_command#>>'{body,proposalId}')::uuid and p.owner_id=owner and p.project_id=p_project and p.base_vector_revision_id::text=p_command#>>'{body,baseVectorRevisionId}' and p.record->'expected'=p_command#>'{body,expected}' and fluid_private.logo_vector_proposal_basis_current(p)) then raise exception 'logo_proposal_source_changed' using errcode='PT409';end if;
 end if;
 return null;
end $replacement$);
end $patch$;

do $patch$ declare body text;definition text;begin
 select prosrc into body from pg_proc where oid='fluid_private.apply_logo_trusted_command(uuid,jsonb,jsonb)'::regprocedure;
 if encode(sha256(convert_to(body,'UTF8')),'hex') is distinct from '15f472a5352e6a28eaaac104ab345c93cf0aeb5afee8c43c4ab99c17bcb24fd4' then raise exception 'proposal_materialization_predecessor_mismatch: fluid_private.apply_logo_trusted_command(uuid,jsonb,jsonb)' using errcode='55000';end if;
 definition:=pg_get_functiondef('fluid_private.apply_logo_trusted_command(uuid,jsonb,jsonb)'::regprocedure);execute replace(definition,body,$replacement$
declare owner uuid:=fluid_private.logo_asset_web_owner();b jsonb:=p_command->'body';method text:=p_command->>'method';existing public.logo_workspace_requests;workspace jsonb;revision jsonb;result jsonb;produced jsonb;check_command jsonb;target_stage jsonb;target_id uuid;current_id uuid;target_vector jsonb;current_vector jsonb;item jsonb;cancelled public.logo_vector_edit_cancellations;
begin
 if method not in('applyLogoVectorProposal','saveLogoEdit','acceptLogoVector','selectIdentityDirectionComponents','approveIdentityDirection','prepareLogoVariants','reviewLogoVariants','restoreLogoStage') or not fluid_private.standalone_keys(p_command,array['method','body']) or octet_length(p_command::text)>32768 or octet_length(p_evidence::text)>2097152 then raise exception 'invalid_logo_trusted_command' using errcode='22023';end if;
 check_command:=jsonb_build_object('method','restoreLogoStage','body',jsonb_build_object('requestKey',b->'requestKey','expected',b->'expected','stage','concepts','revisionId','00000000-0000-4000-8000-000000000001','acceptEarlierBasis',false));
 if not fluid_private.logo_base_command_valid(check_command) then raise exception 'invalid_logo_trusted_command' using errcode='22023';end if;
 if method='applyLogoVectorProposal' then
  if fluid_private.logo_vector_proposal_application_command_valid(p_command) is distinct from true then raise exception 'invalid_logo_proposal_application' using errcode='22023';end if;
  perform pg_advisory_xact_lock(hashtextextended(owner::text,723902));
 end if;
 perform 1 from public.projects where id=p_project and owner_id=owner for update;
 if not found then raise exception 'logo_project_not_found' using errcode='P0002';end if;
 select * into existing from public.logo_workspace_requests req where req.owner_id=owner and req.project_id=p_project and req.request_key=(b->>'requestKey')::uuid and req.method<>'startLogoProject';
 if found then if existing.input is distinct from p_command then raise exception 'logo_request_conflict' using errcode='PT409';end if;return existing.receipt;end if;
 -- A different trusted method may have passed preflight before cancellation.
 -- Fence the exact retained key here, under the existing project lock, before
 -- any source/asset commit. Existing immutable success above remains untouched.
 select * into cancelled from public.logo_vector_edit_cancellations where owner_id=owner and project_id=p_project and request_key=(b->>'requestKey')::uuid;
 if found then
  if cancelled.command is distinct from p_command then raise exception 'logo_request_conflict' using errcode='PT409';end if;
  raise exception 'logo_edit_cancelled' using errcode='PT409';
 end if;
 if to_regclass('public.logo_operation_rejections') is not null then
  if exists(select 1 from public.logo_operation_rejections req where req.owner_id=owner and req.project_id=p_project and req.request_key=(b->>'requestKey')::uuid) then raise exception 'logo_request_conflict' using errcode='PT409';end if;
 end if;
 if to_regclass('public.logo_operation_requests') is not null then
  if exists(select 1 from public.logo_operation_requests req where req.owner_id=owner and req.project_id=p_project and req.request_key=(b->>'requestKey')::uuid) then raise exception 'logo_request_conflict' using errcode='PT409';end if;
 end if;
 if method='applyLogoVectorProposal' then perform fluid_private.read_logo_trusted_request(p_project,p_command);end if;
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
 elsif method='applyLogoVectorProposal' then revision:=fluid_private.commit_logo_vector_proposal(owner,p_project,p_command,p_evidence);
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
end $replacement$);
end $patch$;

-- The existing tombstone and receipt namespaces now explicitly admit the new
-- method. Public cancel/read functions and all cross-method guards stay intact.
alter table public.logo_vector_edit_cancellations drop constraint logo_vector_edit_cancellations_check;
alter table public.logo_vector_edit_cancellations add constraint logo_vector_edit_cancellations_check check(command->>'method' in('saveLogoEdit','applyLogoVectorProposal') and command#>>'{body,requestKey}'=request_key::text and octet_length(command::text)<=32768);
alter table public.logo_workspace_requests drop constraint logo_workspace_requests_method_check;
alter table public.logo_workspace_requests add constraint logo_workspace_requests_method_check check(method in('startLogoProject','saveLogoBrief','saveLogoReferences','restoreLogoStage','selectLogoConcept','selectLogoRaster','saveLogoEdit','acceptLogoVector','selectIdentityDirectionComponents','approveIdentityDirection','prepareLogoVariants','reviewLogoVariants','applyLogoVectorProposal'));

-- Scrub only exact new object OIDs including hostile column/default grants.
-- No existing helper grants or global/default privilege settings are changed.
do $$ declare object_id oid:='fluid_private.logo_vector_proposal_materializations'::regclass;signature text;r record;c record;
begin
 for r in select distinct a.grantee from pg_class t cross join lateral aclexplode(coalesce(t.relacl,acldefault('r',t.relowner))) a where t.oid=object_id and a.grantee<>t.relowner loop
  execute format('revoke all on table %s from %s cascade',object_id::regclass,case when r.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(r.grantee)) end);
 end loop;
 for c in select at.attname,a.grantee from pg_attribute at join pg_class t on t.oid=at.attrelid cross join lateral aclexplode(at.attacl) a where t.oid=object_id and a.grantee<>t.relowner loop
  execute format('revoke all (%I) on table %s from %s cascade',c.attname,object_id::regclass,case when c.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(c.grantee)) end);
 end loop;
 foreach signature in array array['fluid_private.logo_vector_proposal_owned_asset_valid(uuid,uuid,jsonb,text)','fluid_private.logo_vector_proposal_basis_current(fluid_private.logo_vector_proposals)','fluid_private.logo_vector_proposal_application_command_valid(jsonb)','fluid_private.logo_vector_proposal_materializable(fluid_private.logo_vector_proposals)','fluid_private.commit_logo_vector_proposal(uuid,uuid,jsonb,jsonb)','public.read_logo_vector_proposal_application(uuid,uuid)'] loop
  object_id:=signature::regprocedure;
  for r in select distinct a.grantee from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where p.oid=object_id and a.grantee<>p.proowner loop
   execute format('revoke all on function %s from %s cascade',object_id::regprocedure,case when r.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(r.grantee)) end);
  end loop;
 end loop;
end $$;
grant execute on function public.read_logo_vector_proposal_application(uuid,uuid) to authenticated;
commit;
