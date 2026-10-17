-- UNAPPLIED LOCAL WORK-IN-PROGRESS CANDIDATE. No activation or migration entry.
-- This checkpoint provides private retained evidence/read recovery and exact generic
-- worker isolation only. Quote/admission/provider-completion are not yet wired.
-- No roles, policy seeds, credentials, storage grants or defaults are changed.
begin;

create table fluid_private.logo_vector_proposals (
 id uuid primary key, owner_id uuid not null, project_id uuid not null, job_id uuid not null unique,
 request_key uuid not null, quote_id uuid not null, base_vector_revision_id uuid not null, record jsonb not null,
 created_at timestamptz not null default clock_timestamp(),
 unique(id,owner_id,project_id), unique(owner_id,project_id,request_key),
 foreign key(job_id,owner_id,project_id) references public.jobs(id,owner_id,project_id),
 foreign key(quote_id,owner_id,project_id) references public.logo_cost_quotes(id,owner_id,project_id),
 foreign key(base_vector_revision_id,owner_id,project_id) references public.logo_vector_revisions(id,owner_id,project_id),
 check(octet_length(record::text)<=131072),
 check((record->>'id'=id::text and record->>'ownerId'=owner_id::text and record->>'projectId'=project_id::text
  and record->>'jobId'=job_id::text and record->>'requestKey'=request_key::text and record->>'quoteId'=quote_id::text
  and record->>'baseVectorRevisionId'=base_vector_revision_id::text and record->>'materialization'='unavailable'
  and record->>'state' in('succeeded','failed','needs_reconciliation')) is true)
);
alter table fluid_private.logo_vector_proposals enable row level security;
alter table fluid_private.logo_vector_proposals force row level security;
create index logo_vector_proposals_owned on fluid_private.logo_vector_proposals(owner_id,project_id,created_at desc,id desc);
create trigger logo_vector_proposals_immutable before update or delete on fluid_private.logo_vector_proposals for each row execute function fluid_private.prevent_history_change();

create function public.read_logo_vector_proposal(p_project_id uuid,p_proposal_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare owner uuid:=auth.uid();result jsonb;
begin
 if owner is null then raise exception 'unauthenticated' using errcode='42501';end if;
 if not exists(select 1 from public.projects where id=p_project_id and owner_id=owner) then raise exception 'logo_project_not_found' using errcode='P0002';end if;
 select record into result from fluid_private.logo_vector_proposals where id=p_proposal_id and owner_id=owner and project_id=p_project_id;
 if not found then raise exception 'logo_proposal_not_found' using errcode='P0002';end if;
 return result;
end $$;

create function public.list_logo_vector_proposals(p_project_id uuid,p_query jsonb) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare owner uuid:=auth.uid();n integer;cursor_value jsonb;cursor_id uuid;cursor_time timestamptz;row fluid_private.logo_vector_proposals;
 items jsonb:='[]';next_cursor text;seen integer:=0;
begin
 if owner is null then raise exception 'unauthenticated' using errcode='42501';end if;
 if not exists(select 1 from public.projects where id=p_project_id and owner_id=owner) then raise exception 'logo_project_not_found' using errcode='P0002';end if;
 if jsonb_typeof(p_query) is distinct from 'object' or octet_length(p_query::text)>4096 or exists(select 1 from jsonb_object_keys(p_query) k where k not in('cursor','limit')) then raise exception 'invalid_logo_page' using errcode='22023';end if;
 if p_query?'limit' and (jsonb_typeof(p_query->'limit') is distinct from 'number' or (p_query->>'limit')::numeric not between 1 and 50 or (p_query->>'limit')::numeric<>trunc((p_query->>'limit')::numeric)) then raise exception 'invalid_logo_page' using errcode='22023';end if;
 n:=coalesce((p_query->>'limit')::integer,20);
 if p_query?'cursor' then
  if jsonb_typeof(p_query->'cursor') is distinct from 'string' or length(p_query->>'cursor') not between 4 and 2048 or p_query->>'cursor'!~'^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$' then raise exception 'invalid_logo_cursor' using errcode='22023';end if;
  begin cursor_value:=convert_from(decode(p_query->>'cursor','base64'),'UTF8')::jsonb;
  exception when others then raise exception 'invalid_logo_cursor' using errcode='22023';end;
  if fluid_private.standalone_keys(cursor_value,array['ownerId','projectId','id','createdAt']) is distinct from true
   or cursor_value->>'ownerId' is distinct from owner::text or cursor_value->>'projectId' is distinct from p_project_id::text
   or fluid_private.logo_uuid(cursor_value->'id') is distinct from true or fluid_private.standalone_timestamp(cursor_value->'createdAt') is distinct from true then raise exception 'invalid_logo_cursor' using errcode='22023';end if;
  cursor_id:=(cursor_value->>'id')::uuid;cursor_time:=(cursor_value->>'createdAt')::timestamptz;
  if not exists(select 1 from fluid_private.logo_vector_proposals where id=cursor_id and owner_id=owner and project_id=p_project_id and created_at=cursor_time) then raise exception 'invalid_logo_cursor' using errcode='22023';end if;
 end if;
 for row in select * from fluid_private.logo_vector_proposals r where owner_id=owner and project_id=p_project_id
  and(cursor_id is null or(r.created_at,r.id)<(cursor_time,cursor_id)) order by r.created_at desc,r.id desc limit n+1 loop
  seen:=seen+1;
  if seen>n then return jsonb_build_object('ownerId',owner,'projectId',p_project_id,'items',items,'nextCursor',next_cursor);end if;
  items:=items||jsonb_build_array(jsonb_build_object('id',row.id,'jobId',row.job_id,'requestKey',row.request_key,'baseVectorRevisionId',row.base_vector_revision_id,'state',row.record->'state','createdAt',row.record->'createdAt'));
  next_cursor:=replace(encode(convert_to(jsonb_build_object('ownerId',owner,'projectId',p_project_id,'id',row.id,'createdAt',to_char(row.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))::text,'UTF8'),'base64'),E'\n','');
 end loop;
 return jsonb_build_object('ownerId',owner,'projectId',p_project_id,'items',items,'nextCursor',null);
end $$;

-- Compose with the exact restricted-runtime predecessor, or its exact Naming
-- wrapper plus unchanged delegated predecessor. Preserve both owners and ACLs.
do $patch$ declare body text; definition text; target regprocedure:='fluid_private.lock_leased_job(uuid,uuid)'::regprocedure; begin
 if to_regprocedure('fluid_private.naming_brain_legacy_lock(uuid,uuid)') is not null then
  if (select encode(sha256(convert_to(prosrc,'UTF8')),'hex') from pg_proc where oid=target) is distinct from '0d5efc254366ade737c6a35dcd24132e5e56daef376eee289f55ae6e2c783837' then
   raise exception 'vector_proposal_predecessor_mismatch: Naming lease wrapper' using errcode='55000';end if;
  target:='fluid_private.naming_brain_legacy_lock(uuid,uuid)'::regprocedure;
 end if;
 select prosrc into body from pg_proc where oid=target;
 if encode(sha256(convert_to(body,'UTF8')),'hex') is distinct from '886fd74c67ec8f3a9a252f4e56c870f154baaef29598c800df5ad4481332fbcf' then raise exception 'vector_proposal_predecessor_mismatch: fluid_private.lock_leased_job(uuid,uuid)' using errcode='55000';end if;
 definition:=pg_get_functiondef(target);
 execute replace(definition,body,$replacement$
declare j public.jobs; s_owner uuid:=public.subscription_worker_owner(); a_owner uuid:=public.api_text_worker_owner();
 v_service boolean:=(session_user='service_role' or pg_catalog.current_setting('role',true)='service_role');
begin
 select * into j from public.jobs where id=p_job_id;
 if not found then raise exception 'lease_lost' using errcode='PT409'; end if;
 if j.operation in ('identity.logo_concept','identity.logo_refine','identity.logo_vectorize','identity.logo_directions','identity.logo_export','identity.logo_vector_propose') then raise exception 'logo_worker_required' using errcode='42501'; end if;
 if (j.billing_mode='chatgpt_subscription' and (s_owner is null or j.owner_id is distinct from s_owner))
 or (j.billing_mode='openai_api' and not (
   (a_owner is not null and j.owner_id=a_owner and fluid_private.api_text_operation(j.operation) and exists(select 1 from fluid_private.api_text_dispatches where job_id=j.id and owner_id=a_owner))
   or (s_owner is null and a_owner is null and v_service and not exists(select 1 from fluid_private.api_text_dispatches where job_id=j.id)))) then
   raise exception 'worker_owner_mismatch' using errcode='42501'; end if;
 perform fluid_private.lock_strategy_owner(j.owner_id);
 select * into j from public.jobs where id=p_job_id for update;
 if p_lease_token is null or j.lease_token is distinct from p_lease_token or j.lease_expires_at is null
 or j.lease_expires_at<=clock_timestamp() or j.state not in ('running','cancel_requested') then raise exception 'lease_lost' using errcode='PT409'; end if;
 -- Settlement deliberately does not depend on a still-enabled admission policy.
 return j;
end $replacement$);
end $patch$;

-- Exact successor body from supabase/migrations/20261008010153_restricted_api_text_runtime.sql; preserve owner/ACL/function metadata.
do $patch$ declare body text; definition text; replacement text; naming boolean:=to_regprocedure('fluid_private.naming_brain_legacy_lock(uuid,uuid)') is not null; begin
 select prosrc into body from pg_proc where oid='public.claim_job(text,integer)'::regprocedure;
 if encode(sha256(convert_to(body,'UTF8')),'hex') is distinct from (case when naming then 'c7cdd9c2bba71cb0b60be732ed36e5ced438ef6cbcbeef5cbad502de1aaa1df6' else '4467e8de97feb2ca79feb77519c37e97dfd482f3021660517304581980c583fc' end) then raise exception 'vector_proposal_predecessor_mismatch: public.claim_job(text,integer)' using errcode='55000';end if;
 definition:=pg_get_functiondef('public.claim_job(text,integer)'::regprocedure);
 replacement:=$replacement$
declare v_job public.jobs;
begin
  if public.subscription_worker_owner() is not null or
    not (session_user='service_role' or pg_catalog.current_setting('role',true)='service_role') then
    raise exception 'worker_owner_mismatch' using errcode='42501';
  end if;
  if p_worker_id is null or length(p_worker_id) not between 1 and 100 or p_lease_seconds is null or p_lease_seconds not between 5 and 300 then
    raise exception 'invalid_lease' using errcode = '22023';
  end if;
  select j.* into v_job from public.jobs j join public.usage_accounts a on a.owner_id = j.owner_id
    where not exists(select 1 from fluid_private.api_text_dispatches d where d.job_id=j.id) and j.operation not in ('identity.logo_concept','identity.logo_refine','identity.logo_vectorize','identity.logo_directions','identity.logo_export','identity.logo_vector_propose') and j.billing_mode = 'openai_api' and j.state = 'queued' and j.attempts < j.max_attempts
      and not fluid_private.api_text_paid_paused(j.owner_id) and a.reserved_microusd <= a.limit_microusd - greatest(a.spent_microusd, a.provider_actual_microusd)
    order by j.created_at, j.id for update of j skip locked limit 1;
  if not found then return; end if;
  return query update public.jobs set state = 'running', lease_token = gen_random_uuid(),
    lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds),
    worker_id = p_worker_id, attempts = attempts + 1 where id = v_job.id returning *;
end $replacement$;
 if naming then replacement:=replace(replacement,'where not exists(select 1 from fluid_private.api_text_dispatches d where d.job_id=j.id)','where not fluid_private.naming_brain_is_job(j) and not exists(select 1 from fluid_private.api_text_dispatches d where d.job_id=j.id)');end if;
 execute replace(definition,body,replacement);
end $patch$;

-- Exact successor body from supabase/migrations/20261008010153_restricted_api_text_runtime.sql; preserve owner/ACL/function metadata.
do $patch$ declare body text; definition text; replacement text; naming boolean:=to_regprocedure('fluid_private.naming_brain_legacy_lock(uuid,uuid)') is not null; begin
 select prosrc into body from pg_proc where oid='public.expire_job_leases()'::regprocedure;
 if encode(sha256(convert_to(body,'UTF8')),'hex') is distinct from (case when naming then 'bfd41cbd2bc0af81ed9884184bed02312c657f269388aad5625984e6effa95a2' else '3d7a72265d44f9f15c86f69d72952b4537c0dd19a1f8068a1b2b1dd9b2f60f18' end) then raise exception 'vector_proposal_predecessor_mismatch: public.expire_job_leases()' using errcode='55000';end if;
 definition:=pg_get_functiondef('public.expire_job_leases()'::regprocedure);
 replacement:=$replacement$
declare v_job public.jobs; v_next text; v_count integer:=0; v_owner uuid:=public.subscription_worker_owner();
  v_api_worker boolean:=(session_user='service_role' or pg_catalog.current_setting('role',true)='service_role');
begin
  if v_owner is null and not v_api_worker then raise exception 'worker_owner_mismatch' using errcode='42501'; end if;
  for v_job in select * from public.jobs where not exists(select 1 from fluid_private.api_text_dispatches d where d.job_id=public.jobs.id) and operation not in ('identity.logo_concept','identity.logo_refine','identity.logo_vectorize','identity.logo_directions','identity.logo_export','identity.logo_vector_propose') and lease_expires_at<=clock_timestamp() and state in ('running','cancel_requested')
    and ((billing_mode='chatgpt_subscription' and owner_id=v_owner)
      or (billing_mode='openai_api' and v_owner is null and v_api_worker)) for update skip locked loop
    if exists(select 1 from public.job_steps where job_id=v_job.id and state in ('in_flight','ambiguous')) then
      v_next:='needs_reconciliation';
    elsif v_job.state='cancel_requested' then v_next:='cancelled';
    elsif v_job.attempts<v_job.max_attempts then v_next:='queued';
    elsif exists(select 1 from public.job_steps where job_id=v_job.id and state='succeeded') then v_next:='partial';
    else v_next:='failed'; end if;
    if v_next in ('cancelled','partial','failed') then perform fluid_private.settle_reservation(v_job.id); end if;
    update public.jobs set state=v_next,lease_token=null,lease_expires_at=null,
      error_code=case when v_next='needs_reconciliation' then 'lease_expired_with_unresolved_step' else 'lease_expired' end,
      finished_at=case when v_next in ('cancelled','partial','failed') then clock_timestamp() else null end where id=v_job.id;
    v_count:=v_count+1;
  end loop;
  return v_count;
end $replacement$;
 if naming then replacement:=replace(replacement,'where not exists(select 1 from fluid_private.api_text_dispatches d where d.job_id=public.jobs.id)','where not fluid_private.naming_brain_is_job(jobs) and not exists(select 1 from fluid_private.api_text_dispatches d where d.job_id=public.jobs.id)');end if;
 execute replace(definition,body,replacement);
end $patch$;

-- Exact successor body from supabase/migrations/20261008010153_restricted_api_text_runtime.sql; preserve owner/ACL/function metadata.
do $patch$ declare body text; definition text; begin
 select prosrc into body from pg_proc where oid='public.claim_subscription_job(text,uuid,text,integer)'::regprocedure;
 if encode(sha256(convert_to(body,'UTF8')),'hex') is distinct from '178b2c1a77f5438a098e58d48e5a948d27a48726690e0eaa3c54f0012902eb3b' then raise exception 'vector_proposal_predecessor_mismatch: public.claim_subscription_job(text,uuid,text,integer)' using errcode='55000';end if;
 definition:=pg_get_functiondef('public.claim_subscription_job(text,uuid,text,integer)'::regprocedure);
 execute replace(definition,body,$replacement$
declare v_job public.jobs; v_owner uuid:=public.subscription_worker_owner();
begin
 if v_owner is null or p_owner_id is distinct from v_owner then raise exception 'worker_owner_mismatch' using errcode='42501'; end if;
 if p_worker_id is null or length(p_worker_id) not between 1 and 100 or p_lease_seconds is null or p_lease_seconds not between 5 and 300 then raise exception 'invalid_lease' using errcode='22023'; end if;
 perform fluid_private.lock_strategy_owner(v_owner);
 select j.* into v_job from public.jobs j join fluid_private.subscription_runtime_policy p on p.owner_id=j.owner_id and p.operation=j.operation
   where j.operation not in ('identity.logo_concept','identity.logo_refine','identity.logo_vectorize','identity.logo_directions','identity.logo_export','identity.logo_vector_propose') and j.billing_mode='chatgpt_subscription' and j.state='queued' and j.attempts<j.max_attempts and j.owner_id=p_owner_id
     and fluid_private.subscription_strategy_route(v_owner,j.operation) and p.registration_id=p_registration_id and p.enabled and p.worker_ready_until>clock_timestamp() and p.policy=j.input->'policy'
   order by j.created_at,j.id for update of j skip locked limit 1;
 if not found then return; end if;
 return query update public.jobs set state='running',lease_token=gen_random_uuid(),lease_expires_at=clock_timestamp()+make_interval(secs=>p_lease_seconds),
   worker_id=p_worker_id,attempts=attempts+1 where id=v_job.id returning *;
end $replacement$);
end $patch$;

-- Exact successor body from supabase/migrations/20261007020000_logo_directions_subscription.sql; preserve owner/ACL/function metadata.
do $patch$ declare body text; definition text; begin
 select prosrc into body from pg_proc where oid='public.subscription_worker_can_read_step(uuid,uuid)'::regprocedure;
 if encode(sha256(convert_to(body,'UTF8')),'hex') is distinct from 'ac0412038414c8cb9599e5649a9a59e733e2c7ca4f87670aa406b9fdb3f276d0' then raise exception 'vector_proposal_predecessor_mismatch: public.subscription_worker_can_read_step(uuid,uuid)' using errcode='55000';end if;
 definition:=pg_get_functiondef('public.subscription_worker_can_read_step(uuid,uuid)'::regprocedure);
 execute replace(definition,body,$replacement$
declare v_owner uuid:=public.subscription_worker_owner();
begin
 if v_owner is null or p_owner_id is distinct from v_owner then return false;end if;
 return exists(select 1 from public.jobs j where j.id=p_job_id and j.owner_id=v_owner and j.billing_mode='chatgpt_subscription'
  and j.operation not in ('identity.logo_concept','identity.logo_refine','identity.logo_vectorize','identity.logo_directions','identity.logo_export','identity.logo_vector_propose'));
end $replacement$);
end $patch$;

-- Exact successor body from supabase/migrations/20261007011000_logo_durable_jobs.sql; preserve owner/ACL/function metadata.
do $patch$ declare body text; definition text; begin
 select prosrc into body from pg_proc where oid='fluid_private.logo_job_can_read_asset(public.jobs,jsonb)'::regprocedure;
 if encode(sha256(convert_to(body,'UTF8')),'hex') is distinct from 'df4f38e3ee8130d5b9a7f0e5b1ff57a031f6f10f9fa0ef8bcdcedf5128ac44e3' then raise exception 'vector_proposal_predecessor_mismatch: fluid_private.logo_job_can_read_asset(public.jobs,jsonb)' using errcode='55000';end if;
 definition:=pg_get_functiondef('fluid_private.logo_job_can_read_asset(public.jobs,jsonb)'::regprocedure);
 execute replace(definition,body,$replacement$
declare q public.logo_cost_quotes;item jsonb;
begin
 if p_job.operation='identity.logo_vector_propose' then return false;end if;
 if p_reference->>'ownerId' is distinct from p_job.owner_id::text or p_reference->>'projectId' is distinct from p_job.project_id::text then return false;end if;
 if p_job.operation='identity.logo_export' then return fluid_private.logo_export_can_read_asset(p_job,p_reference);end if;
 select * into q from public.logo_cost_quotes where id=(p_job.input->>'quoteId')::uuid and owner_id=p_job.owner_id and project_id=p_job.project_id;
 if not found then return false;end if;
 if p_job.operation='identity.logo_directions' then
  if p_reference in (q.source_inputs#>'{direction,logoRevision,documentAsset}',q.source_inputs#>'{direction,logoRevision,svgAsset}',q.source_inputs#>'{direction,logoRevision,sourcePreview}') then return true;end if;
  if exists(select 1 from jsonb_array_elements(q.source_inputs#>'{direction,permittedFonts}') f where f->'asset'=p_reference) then return true;end if;
 end if;
 for item in select value from jsonb_array_elements(q.source_inputs#>'{referenceSnapshot,references}') loop
  if item->'asset'=p_reference and exists(select 1 from public.logo_reference_sources s where s.owner_id=p_job.owner_id and s.project_id=p_job.project_id and s.reference_id=(item->>'referenceId')::uuid and s.asset_id=(p_reference->>'assetId')::uuid and s.version_id=(p_reference->>'versionId')::uuid and s.content_hash=p_reference->>'contentHash' and s.rights_evidence_id=(item->>'rightsEvidenceId')::uuid and s.source_kind=item->>'sourceKind') then return true;end if;
 end loop;
 if q.source_inputs#>'{raster,preview,reference}'=p_reference then return exists(select 1 from public.logo_raster_results r where r.owner_id=p_job.owner_id and r.project_id=p_job.project_id and r.preview#>'{reference}'=p_reference);end if;
 return exists(select 1 from public.logo_raster_results r where r.job_id=p_job.id and r.owner_id=p_job.owner_id and r.project_id=p_job.project_id and r.preview->'reference'=p_reference);
end $replacement$);
end $patch$;

-- Scrub every actual grantee on precisely the new OIDs, including hostile defaults.
-- Existing function owners/ACLs, unrelated overloads and default ACLs stay intact.
do $$ declare r record; object_id oid; signature text;
begin
 object_id:='fluid_private.logo_vector_proposals'::regclass;
 for r in select distinct a.grantee from pg_class c cross join lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a where c.oid=object_id and a.grantee<>c.relowner loop
  execute format('revoke all on table %s from %s cascade',object_id::regclass,case when r.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(r.grantee)) end);
 end loop;
 foreach signature in array array['public.read_logo_vector_proposal(uuid,uuid)','public.list_logo_vector_proposals(uuid,jsonb)'] loop
  object_id:=signature::regprocedure;
  for r in select distinct a.grantee from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where p.oid=object_id and a.grantee<>p.proowner loop
   execute format('revoke all on function %s from %s cascade',object_id::regprocedure,case when r.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(r.grantee)) end);
  end loop;
 end loop;
end $$;
grant execute on function public.read_logo_vector_proposal(uuid,uuid),public.list_logo_vector_proposals(uuid,jsonb) to authenticated;
commit;
