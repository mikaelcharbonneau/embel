-- UNAPPLIED. Style notes for liked uploads (November 9, 2026).
-- Requires shared_logo_types_keep_concepts.sql and every earlier shared Logo packet.
--
-- A liked upload guides logo concepts through a short style note, written by
-- the logo text model from the upload placed on white, never by sending the
-- upload to the image model. Each note is one admitted, recorded job of the new
-- operation identity.logo_style_note on the shared Logo lane, quoted and admitted
-- like Creative direction: exact text policy, one zero-reservation step, actual
-- usage recorded once from the provider response, and the result stored only
-- after that evidence. A possibly completed request is never repeated: while a
-- note job for the same upload is unfinished or awaiting review, no new one is
-- admitted. Existing operations, rows and receipts are unchanged.
begin;
set local lock_timeout='2s';
set local statement_timeout='60s';
do $guard$
begin
 if current_user<>'postgres' or session_user<>current_user
  or to_regprocedure('fluid_private.logo_brief_same_except_types(uuid,uuid,uuid,uuid)') is null
  or to_regprocedure('fluid_private.shared_logo_directions_observation_valid(jsonb,jsonb)') is null
  or to_regclass('public.logo_style_notes') is not null
  or to_regprocedure('fluid_private.shared_logo_quote_style_note(uuid,jsonb)') is not null
 then raise exception 'shared_logo_style_notes_prerequisite' using errcode='55000'; end if;
 if (select pg_get_constraintdef(oid) from pg_constraint where conrelid='fluid_private.shared_logo_vector_proposal_dispatches'::regclass
   and conname='shared_logo_vector_proposal_dispatches_step_key_check') is distinct from
   'CHECK (((step_key = ANY (ARRAY[''propose-directions''::text, ''propose-vector-edit''::text, ''generate-refinement''::text])) OR (step_key ~ ''^logo-preview-v1:[0-9a-f-]{36}:[0-9a-f-]{36}$''::text)))'
 then raise exception 'shared_logo_style_notes_step_constraint_mismatch' using errcode='55000'; end if;
end $guard$;

-- Notes: one per upload version and note version; written only by the staging
-- step below, readable by their owner, never changed or removed.
create table public.logo_style_notes(
 id uuid primary key default gen_random_uuid(),
 owner_id uuid not null, project_id uuid not null,
 reference_id uuid not null, content_hash text not null check(content_hash~'^[a-f0-9]{64}$'),
 note_version text not null check(note_version='logo-style-note-v1'),
 symbol text check(symbol is null or length(symbol) between 1 and 600),
 lettering text check(lettering is null or length(lettering) between 1 and 300),
 job_id uuid not null unique, provider_receipt_id uuid not null unique,
 created_at timestamptz not null default clock_timestamp(),
 check(symbol is not null or lettering is not null),
 unique(owner_id,project_id,reference_id,content_hash,note_version),
 foreign key(job_id,owner_id,project_id) references public.jobs(id,owner_id,project_id)
);
create trigger logo_style_notes_immutable before update or delete on public.logo_style_notes for each row execute function fluid_private.prevent_history_change();
create trigger project_content_lifecycle before insert or update or delete on public.logo_style_notes for each row execute function fluid_private.guard_project_content_lifecycle();
alter table public.logo_style_notes enable row level security;
alter table public.logo_style_notes force row level security;
revoke all on table public.logo_style_notes from public,anon,authenticated,service_role;
create policy owned_read on public.logo_style_notes for select to authenticated using (owner_id=(select auth.uid()));
grant select on table public.logo_style_notes to authenticated;

-- The text policy and its observation follow Creative direction's exact rules
-- (model, prices, limits, usage arithmetic) under this operation's own versions.
create function fluid_private.shared_logo_style_note_text_policy_valid(p jsonb) returns boolean
language sql immutable set search_path='' as $$
 select coalesce(p->>'handlerVersion'='logo-style-note-v1' and p->>'adapterVersion'='logo-style-note-openai-v1'
  and fluid_private.shared_logo_text_policy_valid(p||'{"handlerVersion":"logo-directions-api-v1","adapterVersion":"logo-directions-openai-v1"}'::jsonb,'directions'),false)
$$;
create function fluid_private.shared_logo_style_note_observation_valid(o jsonb,p jsonb) returns boolean
language sql stable set search_path='' as $$
 select coalesce(fluid_private.shared_logo_style_note_text_policy_valid(p) and jsonb_typeof(o)='object'
  and o->>'kind'='logo_style_note_text' and o->'apiPolicy'=p
  and fluid_private.shared_logo_directions_observation_valid(
   o||jsonb_build_object('kind','logo_directions_text','apiPolicy',p||'{"handlerVersion":"logo-directions-api-v1","adapterVersion":"logo-directions-openai-v1"}'::jsonb),
   p||'{"handlerVersion":"logo-directions-api-v1","adapterVersion":"logo-directions-openai-v1"}'::jsonb),false)
$$;

-- The one owned upload a note describes, in the frozen reference shape the
-- existing leased read checks already accept.
create function fluid_private.shared_logo_style_note_source(p_owner uuid,p_project uuid,p_reference uuid) returns jsonb
language sql stable set search_path='' as $$
 select jsonb_build_object('referenceId',s.reference_id,'asset',jsonb_build_object('ownerId',s.owner_id,'projectId',s.project_id,
   'assetId',s.asset_id,'versionId',s.version_id,'contentHash',s.content_hash),'sourceKind','upload','rightsEvidenceId',s.rights_evidence_id)
 from public.logo_reference_sources s
 join public.asset_versions v on v.id=s.version_id and v.asset_id=s.asset_id and v.owner_id=s.owner_id and v.project_id=s.project_id and v.content_hash=s.content_hash
 where s.reference_id=p_reference and s.owner_id=p_owner and s.project_id=p_project and s.source_kind='upload'
  and v.mime_type in('image/png','image/jpeg','image/webp')
$$;
create function fluid_private.shared_logo_style_note_exists(p_owner uuid,p_project uuid,p_reference jsonb) returns boolean
language sql stable set search_path='' as $$
 select exists(select 1 from public.logo_style_notes n where n.owner_id=p_owner and n.project_id=p_project
  and n.reference_id::text=p_reference->>'referenceId' and n.content_hash=p_reference#>>'{asset,contentHash}' and n.note_version='logo-style-note-v1')
$$;

create function fluid_private.shared_logo_quote_style_note(p_project uuid,p_input jsonb) returns jsonb
language plpgsql set search_path='' as $$declare owner uuid:=auth.uid(); profile jsonb; policy jsonb; ref jsonb; sources jsonb;
 id uuid:=gen_random_uuid(); result jsonb; input_hash text; expires timestamptz:=clock_timestamp()+interval '5 minutes'; begin
 if owner is null or not fluid_private.shared_account_customer_active(owner) then raise exception 'unauthenticated' using errcode='42501'; end if;
 if not fluid_private.standalone_keys(p_input,array['operation','expected','referenceId']) or p_input->>'operation' is distinct from 'style_note'
  or not fluid_private.logo_uuid(p_input->'referenceId') then raise exception 'invalid_logo_style_note' using errcode='22023';end if;
 perform pg_advisory_xact_lock(hashtextextended(owner::text,723902));
 perform 1 from public.projects where projects.id=p_project and owner_id=owner for update;if not found then raise exception 'logo_project_not_found' using errcode='P0002';end if;
 if fluid_private.logo_workspace_json(owner,p_project)->'heads' is distinct from p_input->'expected' then raise exception 'logo_head_conflict' using errcode='PT409';end if;
 profile:=fluid_private.shared_logo_policy(owner,'identity.logo_style_note');policy:=profile->'policy';
 if policy is null or not fluid_private.shared_logo_advanced_policy_valid('identity.logo_style_note',policy) then raise exception 'shared_logo_policy_unavailable' using errcode='55000';end if;
 ref:=fluid_private.shared_logo_style_note_source(owner,p_project,(p_input->>'referenceId')::uuid);
 if ref is null then raise exception 'logo_reference_not_found' using errcode='P0002';end if;
 if fluid_private.shared_logo_style_note_exists(owner,p_project,ref) then raise exception 'logo_style_note_exists' using errcode='PT409';end if;
 sources:=jsonb_build_object('reference',ref,'referenceSnapshot',jsonb_build_object('references',jsonb_build_array(ref)),'noteVersion','logo-style-note-v1');
 input_hash:=encode(sha256(convert_to(jsonb_build_object('request',p_input,'sources',sources,'policy',policy)::text,'UTF8')),'hex');
 result:=jsonb_build_object('version',3,'billingMode','openai_api','spendControl','uncapped','id',id,'ownerId',owner,'projectId',p_project,'request',p_input,
  'inputHash',input_hash,'expected',p_input->'expected','policyIdentity',policy->'policyIdentity','handlerVersion',policy->'handlerVersion','provider','openai','model',policy->'model',
  'engine',null,'apiPolicy',policy->'apiPolicy','expiresAt',to_char(expires at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'conceptPlan',null,'targetSlotIds','[]'::jsonb);
 insert into public.logo_cost_quotes(id,owner_id,project_id,operation,record,input_revisions,source_inputs,expires_at)
  values(id,owner,p_project,'identity.logo_style_note',result,'[]'::jsonb,sources,expires);
 insert into fluid_private.shared_logo_advanced_quotes(quote_id,owner_id,project_id,operation,policy,deployment_id)
  values(id,owner,p_project,'identity.logo_style_note',policy,profile->>'deploymentId');return result;
end $$;

-- A note job may read exactly its one frozen, committed, rights-declared upload.
create function fluid_private.shared_logo_style_note_storage_member(j public.jobs,r public.logo_asset_publications) returns jsonb
language plpgsql stable set search_path='' as $$declare ref jsonb; begin
 ref:=fluid_private.logo_asset_reservation(r)->'reference';
 if j.id is null or r.id is null or j.operation is distinct from 'identity.logo_style_note' or ref is distinct from j.input->'asset'
  or r.owner_id is distinct from j.owner_id or r.project_id is distinct from j.project_id or r.state is distinct from 'committed'
  or r.purpose is distinct from 'reference_media' or r.source_kind is distinct from 'logo_reference' or r.job_id is not null or r.rights_evidence_id is null
  or r.mime_type not in('image/png','image/jpeg','image/webp') or r.byte_length not between 1 and 20971520
  or r.verification->>'status' is distinct from 'verified' or r.verification->>'contentHash' is distinct from r.content_hash
  or r.verification->>'mimeType' is distinct from r.mime_type or r.verification->'byteLength' is distinct from to_jsonb(r.byte_length)
  or r.source_receipt_id::text is distinct from j.input->>'referenceId' or fluid_private.logo_job_can_read_asset(j,ref) is distinct from true
  or not exists(select 1 from public.logo_reference_sources s where s.reference_id=r.source_receipt_id and s.source_kind='upload'
   and(s.owner_id,s.project_id,s.asset_id,s.version_id,s.content_hash,s.rights_evidence_id)=(r.owner_id,r.project_id,r.asset_id,r.version_id,r.content_hash,r.rights_evidence_id))
 then return null; end if;
 return jsonb_build_object('member','reference');
exception when others then return null;
end $$;

-- Stores the note only after its recorded, complete and billed provider response.
create function fluid_private.shared_logo_stage_style_note(p_job uuid,p_lease uuid,p_note jsonb,p_receipt uuid) returns jsonb
language plpgsql set search_path='' as $$declare j public.jobs; r public.logo_provider_responses; s public.job_steps; n public.logo_style_notes; symbol text; lettering text; begin
 j:=fluid_private.shared_logo_lock_issued_job(p_job,p_lease);
 if j.operation is distinct from 'identity.logo_style_note' then raise exception 'shared_logo_style_note_required' using errcode='42501'; end if;
 if not fluid_private.standalone_keys(p_note,array['symbol','lettering'])
  or not(p_note->'symbol'='null'::jsonb or fluid_private.standalone_text(p_note->'symbol',600,1))
  or not(p_note->'lettering'='null'::jsonb or fluid_private.standalone_text(p_note->'lettering',300,1))
  or p_note->'symbol'='null'::jsonb and p_note->'lettering'='null'::jsonb then raise exception 'invalid_logo_style_note' using errcode='22023'; end if;
 symbol:=p_note->>'symbol'; lettering:=p_note->>'lettering';
 select * into n from public.logo_style_notes where job_id=j.id;
 if found then
  if(n.symbol,n.lettering,n.provider_receipt_id) is distinct from(symbol,lettering,p_receipt) then raise exception 'logo_style_note_immutable' using errcode='PT409'; end if;
 else
  select * into s from public.job_steps where job_id=j.id and step_key='write-style-note';
  if j.state not in('running','cancel_requested') or s.state is distinct from 'in_flight' then raise exception 'logo_style_note_window_closed' using errcode='55000'; end if;
  select * into r from public.logo_provider_responses where id=p_receipt and job_id=j.id and owner_id=j.owner_id and project_id=j.project_id and lease_token=p_lease;
  if r.id is null or fluid_private.shared_logo_style_note_observation_valid(r.observation,j.input->'apiPolicy') is distinct from true
   or r.observation#>>'{billing,status}' is distinct from 'recorded' or r.observation->'responseComplete' is distinct from 'true'::jsonb then
   raise exception 'logo_style_note_evidence_required' using errcode='55000'; end if;
  insert into public.logo_style_notes(owner_id,project_id,reference_id,content_hash,note_version,symbol,lettering,job_id,provider_receipt_id)
   values(j.owner_id,j.project_id,(j.input->>'referenceId')::uuid,j.input#>>'{asset,contentHash}',j.input->>'noteVersion',symbol,lettering,j.id,r.id) returning * into n;
 end if;
 return jsonb_build_object('version',1,'kind','logo_style_note_staged','noteId',n.id,'providerResponseReceiptId',n.provider_receipt_id);
end $$;

-- The one step's outcome. Observation is the only usage capture point; this
-- never adds cost. Success requires the staged note for this exact response.
create function fluid_private.shared_logo_complete_style_note(p_job uuid,p_lease uuid,p_step text,p_state text,p_cost bigint,p_output jsonb,p_provider_request_id text) returns public.job_steps
language plpgsql set search_path='' as $$declare j public.jobs; s public.job_steps; r public.logo_provider_responses; n public.logo_style_notes; bare boolean; free boolean; cost bigint; reason text; begin
 j:=fluid_private.shared_logo_lock_issued_job(p_job,p_lease);
 if j.operation is distinct from 'identity.logo_style_note' or p_step is distinct from 'write-style-note' or p_state is null or p_state not in('succeeded','failed','ambiguous')
  or p_cost is null or p_cost not between 0 and 9007199254740991 or jsonb_typeof(p_output) is distinct from 'object' or octet_length(p_output::text)>8192
  or(p_provider_request_id is not null and length(p_provider_request_id) not between 1 and 200) then raise exception 'invalid_logo_style_note_completion' using errcode='22023'; end if;
 select * into s from public.job_steps where job_id=j.id and step_key=p_step for update;
 if s.id is null then raise exception 'logo_style_note_step_missing' using errcode='55000'; end if;
 bare:=p_state='ambiguous' and p_cost=0 and p_provider_request_id is null and p_output='{"error":"provider_outcome_unknown"}'::jsonb;
 if s.state<>'in_flight' then
  if(s.state,s.actual_cost_microusd,s.output,s.provider_request_id) is not distinct from(p_state,p_cost,p_output,p_provider_request_id) then return s; end if;
  if bare and s.state='ambiguous' and s.output='{"error":"provider_outcome_unknown"}'::jsonb and s.provider_request_id is null then return s; end if;
  raise exception 'logo_style_note_outcome_immutable' using errcode='PT409';
 end if;
 if j.state not in('running','cancel_requested','needs_reconciliation') then raise exception 'logo_style_note_evidence_window_closed' using errcode='55000'; end if;
 select * into r from public.logo_provider_responses where job_id=j.id and owner_id=j.owner_id and project_id=j.project_id;
 free:=p_state='failed' and p_cost=0 and p_provider_request_id is null and p_output='{"error":"not_dispatched"}'::jsonb;
 if free then
  if r.id is not null or j.actual_cost_microusd<>0 or s.actual_cost_microusd<>0 or j.state='needs_reconciliation' then raise exception 'logo_style_note_nondispatch_conflict' using errcode='55000'; end if;
 elsif bare then reason:='provider_outcome_unknown';
 else
  if r.id is null or r.observation->>'providerRequestId' is distinct from p_provider_request_id then raise exception 'logo_style_note_receipt_mismatch' using errcode='22023'; end if;
  cost:=case when r.observation#>>'{billing,status}'='recorded' then(r.observation#>>'{billing,confirmedMicrousd}')::bigint else 0 end;
  if cost<>p_cost then raise exception 'logo_style_note_cost_mismatch' using errcode='22023'; end if;
  if p_state='succeeded' then
   if not fluid_private.standalone_keys(p_output,array['version','kind','noteId','providerResponseReceiptId']) or p_output->'version' is distinct from '1'::jsonb
    or p_output->>'kind' is distinct from 'logo_style_note' or p_output->>'providerResponseReceiptId' is distinct from r.id::text or not fluid_private.logo_uuid(p_output->'noteId') then
    raise exception 'invalid_logo_style_note_output' using errcode='22023'; end if;
   select * into n from public.logo_style_notes where id=(p_output->>'noteId')::uuid and job_id=j.id and provider_receipt_id=r.id;
   if n.id is null or j.state='needs_reconciliation' then raise exception 'logo_style_note_not_staged' using errcode='55000'; end if;
  else
   if not fluid_private.standalone_keys(p_output,array['error']) or not fluid_private.standalone_text(p_output->'error',100,1) then raise exception 'invalid_logo_style_note_output' using errcode='22023'; end if;
   if exists(select 1 from public.logo_style_notes where job_id=j.id) then raise exception 'logo_style_note_already_staged' using errcode='55000'; end if;
   reason:=p_output->>'error';
  end if;
 end if;
 update public.job_steps set state=p_state,output=p_output,provider_request_id=p_provider_request_id,completed_at=clock_timestamp() where id=s.id returning * into s;
 if p_state='ambiguous' then update public.jobs set state='needs_reconciliation',lease_token=null,lease_expires_at=null,error_code=reason where id=j.id; end if;
 return s;
end $$;

-- The owner's note requests for one project: which upload version each is for
-- and its state, without exposing the rest of the frozen job input.
create function public.read_logo_style_note_jobs(p_project_id uuid) returns jsonb
language sql stable security definer set search_path='' as $$
 select coalesce(jsonb_agg(jsonb_build_object('referenceId',j.input->>'referenceId','contentHash',j.input#>>'{asset,contentHash}','state',j.state) order by j.created_at,j.id),'[]'::jsonb)
 from public.jobs j where j.owner_id=(select auth.uid()) and j.project_id=p_project_id and j.operation='identity.logo_style_note'
$$;
revoke all on function public.read_logo_style_note_jobs(uuid) from public,anon,service_role;
grant execute on function public.read_logo_style_note_jobs(uuid) to authenticated;

do $acl$
declare item record;
begin
 for item in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='fluid_private' and p.proname in('shared_logo_style_note_text_policy_valid','shared_logo_style_note_observation_valid','shared_logo_style_note_source',
   'shared_logo_style_note_exists','shared_logo_quote_style_note','shared_logo_style_note_storage_member','shared_logo_stage_style_note','shared_logo_complete_style_note') loop
  execute format('revoke all on function %s from public,anon,authenticated,service_role',item.signature);
 end loop;
end $acl$;

alter table fluid_private.shared_logo_vector_proposal_dispatches drop constraint shared_logo_vector_proposal_dispatches_step_key_check;
alter table fluid_private.shared_logo_vector_proposal_dispatches add constraint shared_logo_vector_proposal_dispatches_step_key_check
 check(step_key in('propose-directions','propose-vector-edit','generate-refinement','write-style-note') or step_key~'^logo-preview-v1:[0-9a-f-]{36}:[0-9a-f-]{36}$');

-- Guarded edits: each function must have its exact reviewed body, and every
-- fragment must occur exactly as often as listed.
create function pg_temp.style_note_edit(p_target regprocedure,p_hash text,p_needles text[],p_replacements text[],p_counts integer[]) returns void
language plpgsql set search_path='' as $$declare body text; original text; definition text; i integer; n integer; begin
 select prosrc into body from pg_catalog.pg_proc where oid=p_target; original:=body;
 if encode(sha256(convert_to(body,'UTF8')),'hex') is distinct from p_hash then raise exception 'shared_logo_style_notes_predecessor_mismatch: %',p_target; end if;
 definition:=pg_get_functiondef(p_target);
 for i in 1..array_length(p_needles,1) loop
  n:=(length(body)-length(replace(body,p_needles[i],'')))/length(p_needles[i]);
  if n<>p_counts[i] then raise exception 'shared_logo_style_notes_fragment_mismatch: % (%: % found)',p_target,i,n; end if;
  body:=replace(body,p_needles[i],p_replacements[i]);
 end loop;
 execute replace(definition,original,body);
end $$;

do $edits$
declare six text:=$f$'identity.logo_concept','identity.logo_refine','identity.logo_vectorize','identity.logo_directions','identity.logo_export','identity.logo_vector_propose'$f$;
 seven text:=$f$'identity.logo_concept','identity.logo_refine','identity.logo_vectorize','identity.logo_directions','identity.logo_export','identity.logo_vector_propose','identity.logo_style_note'$f$;
 note_input text:=$f$jsonb_build_object('referenceId',q.record#>'{request,referenceId}','asset',q.source_inputs#>'{reference,asset}','noteVersion',q.source_inputs->'noteVersion'$f$;
begin
 perform pg_temp.style_note_edit('fluid_private.shared_logo_advanced_policy_valid(text,jsonb)','545e1f0a82fa1f1f9f777f5e99dd6382d2c522f2d2866f2f9b48468748524f1f',
  array[$f$fluid_private.shared_logo_text_policy_valid(p->'textPolicy','proposal')),false);$f$],
  array[$f$fluid_private.shared_logo_text_policy_valid(p->'textPolicy','proposal')
   or p_operation='identity.logo_style_note' and fluid_private.standalone_keys(p,array['operation','policyIdentity','handlerVersion','provider','model','engine','spendControl','apiPolicy'])
    and p->>'handlerVersion'='logo-style-note-v1' and fluid_private.shared_logo_style_note_text_policy_valid(p->'apiPolicy')),false);$f$],array[1]);

 perform pg_temp.style_note_edit('fluid_private.shared_logo_advanced_quote_binding(public.logo_cost_quotes,jsonb)','d689be65064c7530ad3149eb8006a6c1732a7137673d9b97d0f1dc985a34210a',
  array[$f$when 'identity.logo_vector_propose' then 'textPolicy' end;$f$],
  array[$f$when 'identity.logo_vector_propose' then 'textPolicy' when 'identity.logo_style_note' then 'apiPolicy' end;$f$],array[1]);

 perform pg_temp.style_note_edit('fluid_private.shared_logo_advanced_quote_current(public.logo_cost_quotes,jsonb)','65092001a2d8d8e28629e813d981fd0e45c7d952afdba43174ea2f13fe78dba9',
  array[$f$ if q.operation='identity.logo_directions' then$f$],
  array[$f$ if q.operation='identity.logo_style_note' then
  return fluid_private.shared_logo_style_note_source(q.owner_id,q.project_id,(q.record#>>'{request,referenceId}')::uuid)=q.source_inputs->'reference'
   and not fluid_private.shared_logo_style_note_exists(q.owner_id,q.project_id,q.source_inputs->'reference');
 end if;
 if q.operation='identity.logo_directions' then$f$],array[1]);

 perform pg_temp.style_note_edit('fluid_private.shared_logo_admit_advanced(uuid,jsonb)','97e0edbdeea8c5480c262ede4ac83ab60e4a73741196e4b15bf5c5f866178a0d',
  array[$f$  else raise exception 'wrong_logo_operation' using errcode='22023';end if;$f$],
  array[$f$  elsif q.operation='identity.logo_style_note' then
   -- Never admit a second request while one may still complete or awaits review.
   if exists(select 1 from public.jobs x where x.owner_id=owner and x.project_id=p_project and x.operation='identity.logo_style_note'
    and x.input->>'referenceId'=q.record#>>'{request,referenceId}' and x.input#>>'{asset,contentHash}'=q.source_inputs#>>'{reference,asset,contentHash}'
    and x.state in('queued','running','cancel_requested','needs_reconciliation')) then raise exception 'logo_style_note_in_progress' using errcode='PT409';end if;
   input:=input||$f$||note_input||$f$,'apiPolicy',policy->'apiPolicy');
   manifest:='[{"key":"write-style-note","maximumCostMicrousd":0}]'::jsonb;
  else raise exception 'wrong_logo_operation' using errcode='22023';end if;$f$],array[1]);

 perform pg_temp.style_note_edit('fluid_private.shared_logo_advanced_job_matches(public.jobs,jsonb)','bf90c71cc681da5c3cb4eaeb3ff01d6e40658aad694d384faa340411981c44f6',
  array[$f$j.operation not in('identity.logo_directions','identity.logo_vector_propose')$f$,$f$
 else
  input:=input||jsonb_build_object('baseVectorRevisionId'$f$],
  array[$f$j.operation not in('identity.logo_directions','identity.logo_vector_propose','identity.logo_style_note')$f$,$f$
 elsif j.operation='identity.logo_style_note' then
  input:=input||$f$||note_input||$f$,'apiPolicy',approved->'apiPolicy');
  manifest:=jsonb_build_array(jsonb_build_object('key','write-style-note','maximumCostMicrousd',0));
 else
  input:=input||jsonb_build_object('baseVectorRevisionId'$f$],array[1,1]);

 perform pg_temp.style_note_edit('fluid_private.shared_logo_record_response(uuid,uuid,jsonb)','e31cc9e1656ba41a1927438a0ce18a7fdeb4d3f41324543add61517396eb8c14',
  array[$f$p:=case j.operation when 'identity.logo_directions' then j.input->'apiPolicy' else$f$,$f$
    when 'identity.logo_vector_propose' then fluid_private.shared_logo_valid_vector_proposal_observation(o,p)$f$],
  array[$f$p:=case j.operation when 'identity.logo_directions' then j.input->'apiPolicy' when 'identity.logo_style_note' then j.input->'apiPolicy' else$f$,$f$
    when 'identity.logo_vector_propose' then fluid_private.shared_logo_valid_vector_proposal_observation(o,p)
    when 'identity.logo_style_note' then fluid_private.shared_logo_style_note_observation_valid(o,p)$f$],array[1,1]);

 perform pg_temp.style_note_edit('fluid_private.shared_logo_advanced_action(uuid,uuid,text,jsonb)','f0d6fee018d3d936b8aed3f99d399332ea984f71aba40d2bdff606a944fc701b',
  array[$f$  if j.operation='identity.logo_vector_propose' then perform fluid_private.shared_logo_complete_proposal($f$,$f$  elsif p_args->>2='step_output' then$f$,$f$ elsif p_action='read' and jsonb_array_length(p_args)=4 then$f$],
  array[$f$  if j.operation='identity.logo_style_note' then perform fluid_private.shared_logo_complete_style_note(p_job,p_lease,p_args->>2,p_args->>3,(p_args->>4)::bigint,fluid_private.shared_logo_json_arg(p_args,5),p_args->>6);
  elsif j.operation='identity.logo_vector_propose' then perform fluid_private.shared_logo_complete_proposal($f$,$f$  elsif p_args->>2='style_note_input' and j.operation='identity.logo_style_note' and fluid_private.shared_logo_json_arg(p_args,3) in('null'::jsonb) then
   return jsonb_build_object('input',j.input,'reference',q.source_inputs->'reference');
  elsif p_args->>2='step_output' then$f$,$f$ elsif p_action='stage_style_note' and jsonb_array_length(p_args)=4 and j.operation='identity.logo_style_note' then
  return fluid_private.shared_logo_stage_style_note(p_job,p_lease,fluid_private.shared_logo_json_arg(p_args,2),(p_args->>3)::uuid);
 elsif p_action='read' and jsonb_array_length(p_args)=4 then$f$],array[1,1,1]);

 perform pg_temp.style_note_edit('fluid_private.shared_identity_previous_logo_gateway(jsonb,jsonb,text,jsonb)','c35e73ddf19625d529680543c40f577066521134f0f96533c9c05df2d98d66f3',
  array[six,$f$'stage_proposal','stage_directions') then 'observe'$f$,$f$
  or p_action='stage_proposal' and e.operation<>'identity.logo_vector_propose' then$f$,
   $f$'runtime_readiness','step_output','step_asset','has_results')$f$,$f$
  or p_args->>2 in('vector_proposal_inputs','vector_proposal_evidence_inputs') and e.operation<>'identity.logo_vector_propose') then$f$],
  array[seven,$f$'stage_proposal','stage_directions','stage_style_note') then 'observe'$f$,$f$
  or p_action='stage_proposal' and e.operation<>'identity.logo_vector_propose'
  or p_action='stage_style_note' and e.operation<>'identity.logo_style_note' then$f$,
   $f$'runtime_readiness','step_output','step_asset','has_results','style_note_input')$f$,$f$
  or p_args->>2 in('vector_proposal_inputs','vector_proposal_evidence_inputs') and e.operation<>'identity.logo_vector_propose'
  or p_args->>2='style_note_input' and e.operation<>'identity.logo_style_note') then$f$],array[2,1,1,1,1]);

 perform pg_temp.style_note_edit('fluid_private.shared_logo_policy(uuid,text)','9c0dd0d0ddfeffb192f29b0ebfca1bbd744516e16b9e1564eacdbe70b68eae4c',array[six],array[seven],array[1]);
 perform pg_temp.style_note_edit('fluid_private.shared_logo_job_context(uuid)','fca1329ccfa071cd0e2ffa8afa320879dfee70342af0ee3d9dba17ed68e56091',array[six],array[seven],array[1]);
 -- shared_logo_project_clear stays as it is: an uncertain note blocks only a new
 -- request for that same upload, never the project's other Logo work.
 perform pg_temp.style_note_edit('fluid_private.logo_lock_job(uuid,uuid)','34aea4a2356cd84c529d1ac7df563afa3011b42c20cce7cb13f62bc8345f8c20',array[six],array[seven],array[1]);
 perform pg_temp.style_note_edit('fluid_private.logo_asset_job(uuid,uuid,uuid,uuid)','d14f131fd296dc36deda5ac9b28470b1c2fbd061ef2b59ef04e78eec86e61177',
  array[$f$'identity.logo_directions','identity.logo_export')$f$],array[$f$'identity.logo_directions','identity.logo_export','identity.logo_style_note')$f$],array[1]);

 perform pg_temp.style_note_edit('public.shared_logo_operation(uuid,text,jsonb)','0183629f82bba164dc5f2f20d764853631ae1e08516cbf8767923d2a507fbab7',
  array[six,$f$'refine_preview','vectorize','directions') then raise exception$f$,$f$  elsif p_input->>'operation'='directions' then$f$,
   $f$q.operation in('identity.logo_concept','identity.logo_vectorize','identity.logo_directions','identity.logo_vector_propose')$f$],
  array[seven,$f$'refine_preview','vectorize','directions','style_note') then raise exception$f$,$f$  elsif p_input->>'operation'='style_note' then
   result:=fluid_private.shared_logo_quote_style_note(p_project_id,p_input);
  elsif p_input->>'operation'='directions' then$f$,
   $f$q.operation in('identity.logo_concept','identity.logo_vectorize','identity.logo_directions','identity.logo_vector_propose','identity.logo_style_note')$f$],array[2,1,1,1]);

 perform pg_temp.style_note_edit('fluid_private.shared_logo_storage_member(public.jobs,public.logo_asset_publications,text)','c5cabfc78c2c0e30561d62e1098ae45cc9ed39f7dc352ced8f88ad99c8c66fe4',
  array[$f$ elsif j.operation='identity.logo_vector_propose' and p_mode='read' then$f$],
  array[$f$ elsif j.operation='identity.logo_style_note' and p_mode='read' then
  return fluid_private.shared_logo_style_note_storage_member(j,r);
 elsif j.operation='identity.logo_vector_propose' and p_mode='read' then$f$],array[1]);
end $edits$;
drop function pg_temp.style_note_edit(regprocedure,text,text[],text[],integer[]);
commit;
