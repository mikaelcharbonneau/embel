-- One reviewed local publication failure. Installation creates no adjudication,
-- provider request, credential, worker grant, asset, version or successful result.
-- Five full-row hashes pin the only historical incident this trigger may accept.
-- A separate operator INSERT supplies the job and the human decision reference.
begin;
create temporary table logo_adjudication_original_function on commit drop as
 select oid,proowner,proacl,prosecdef,provolatile,proconfig,proleakproof from pg_proc
 where oid='fluid_private.logo_local_project_clear(uuid,uuid)'::regprocedure;
do $guard$ begin
 if not exists(select 1 from pg_proc where oid='fluid_private.logo_local_project_clear(uuid,uuid)'::regprocedure
  and md5(prosrc)='34762c57e181730ca2a8919e4db305e2' and not prosecdef and provolatile='s'
  and proconfig=array['search_path=""'] and not proleakproof
  and proowner=(select oid from pg_roles where rolname=current_user)) then
  raise exception 'unexpected_logo_adjudication_predecessor'; end if;
end $guard$;

create table fluid_private.logo_publication_failure_adjudications (
 job_id uuid primary key references public.jobs(id),
 operator_decision_reference text not null check(operator_decision_reference ~ '^operator-decision:[A-Za-z0-9][A-Za-z0-9._:/-]{7,199}$'),
 reason text not null check(length(reason) between 40 and 2000),
 -- All evidence below is filled by the trigger from locked database rows.
 job_before jsonb not null, step_before jsonb not null, provider_before jsonb not null,
 publication_before jsonb not null, reservation_before jsonb not null, reservation_after jsonb not null,
 local_marker jsonb not null, storage_grant jsonb not null, storage_object jsonb not null,
 account_before jsonb not null, account_after jsonb not null,
 operator_role name not null, operator_session name not null, recorded_at timestamptz not null
);

create function fluid_private.record_logo_publication_failure_adjudication()
returns trigger language plpgsql set search_path='' set timezone='UTC' as $$
declare
 pinned_job_sha256 constant text := 'c7b1ac00aee020e6db578db75f87838baf8c55a6e7130575db1e627d002b585d';
 pinned_step_sha256 constant text := '1fa597253d291b6525698070eb5330d453bd7e5872a8646461e7a0a7ab07f0ac';
 pinned_provider_sha256 constant text := '2672367f36d38be037824734a817f46623f2234d5f67a34dcf40bedb6ef02698';
 pinned_publication_sha256 constant text := '8fa6350214758eb59bdebe19386f618d88fb5a3675833ae84a89d2989946d814';
 pinned_reservation_sha256 constant text := 'c438f1c8d703a12728c9eeea4a173228ae20560f21866e67024df9d91972abd4';
 j public.jobs; s public.job_steps; p public.logo_provider_responses; a public.logo_asset_publications;
 r public.usage_reservations; m fluid_private.logo_local_jobs; g fluid_private.logo_generative_storage_grants;
 o storage.objects; ledger public.usage_accounts; after_ledger public.usage_accounts; project public.projects;
 released bigint;
begin
 if tg_op='TRUNCATE' and not exists(select 1 from fluid_private.logo_publication_failure_adjudications) then return null; end if;
 if tg_op<>'INSERT' then raise exception 'immutable_logo_publication_adjudication' using errcode='55000'; end if;
 if current_user is distinct from pg_get_userbyid((select relowner from pg_class where oid=tg_relid)) then
  raise exception 'operator_required' using errcode='42501'; end if;
 -- Project -> job is the publication lock order. The initial lookup acquires
 -- no authority; every owner, input, lease and receipt is checked below.
 select pr.* into strict project from public.projects pr join public.jobs jj on jj.project_id=pr.id and jj.owner_id=pr.owner_id
  where jj.id=new.job_id for update of pr;
 select * into strict j from public.jobs where id=new.job_id for update;
 select * into strict s from public.job_steps where job_id=j.id for update;
 select * into strict p from public.logo_provider_responses where job_id=j.id for update;
 select * into strict a from public.logo_asset_publications where job_id=j.id for update;
 select * into strict r from public.usage_reservations where job_id=j.id for update;
 select * into strict m from fluid_private.logo_local_jobs where job_id=j.id for share;
 select * into strict g from fluid_private.logo_generative_storage_grants
  where job_id=j.id and lease_token=a.lease_token and reservation_id=a.id and mode='write' for share;
 select * into strict o from storage.objects where bucket_id='fluid-assets'
  and name=a.owner_id::text||'/'||a.project_id::text||'/'||a.asset_id::text||'/'||a.version_id::text for share;
 select * into strict ledger from public.usage_accounts where owner_id=j.owner_id for update;
 if encode(sha256(convert_to(to_jsonb(j)::text,'UTF8')),'hex') is distinct from pinned_job_sha256
  or encode(sha256(convert_to(to_jsonb(s)::text,'UTF8')),'hex') is distinct from pinned_step_sha256
  or encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') is distinct from pinned_provider_sha256
  or encode(sha256(convert_to(to_jsonb(a)::text,'UTF8')),'hex') is distinct from pinned_publication_sha256
  or encode(sha256(convert_to(to_jsonb(r)::text,'UTF8')),'hex') is distinct from pinned_reservation_sha256
  or j.operation is distinct from 'identity.logo_concept' or j.state is distinct from 'needs_reconciliation'
  or j.error_code is distinct from 'publication_unknown' or j.billing_mode is distinct from 'openai_api'
  or j.lease_token is not null or j.lease_expires_at is not null or j.finished_at is not null
  or j.cancel_requested_at is not null or j.project_deletion_requested_at is not null
  or project.deleted_at is not null or project.deletion_requested_at is not null
  or (s.owner_id,s.project_id,s.state,s.output) is distinct from (j.owner_id,j.project_id,'ambiguous','{"error":"publication_unknown"}'::jsonb)
  or s.completed_at is null or s.provider_request_id is null
  or j.plan_manifest is distinct from jsonb_build_array(jsonb_build_object('key',s.step_key,'maximumCostMicrousd',j.reserved_cost_microusd))
  or (p.owner_id,p.project_id,p.lease_token) is distinct from (j.owner_id,j.project_id,a.lease_token)
  or p.observation->>'providerRequestId' is distinct from s.provider_request_id
  or p.observation#>>'{billing,status}' is distinct from 'recorded'
  or (p.observation#>>'{billing,confirmedMicrousd}')::bigint is distinct from j.actual_cost_microusd
  or j.actual_cost_microusd<=0 or j.actual_cost_microusd>j.reserved_cost_microusd
  or s.actual_cost_microusd is distinct from j.actual_cost_microusd
  or (r.owner_id,r.project_id,r.state,r.reserved_microusd,r.actual_microusd,r.captured_microusd)
   is distinct from (j.owner_id,j.project_id,'active',j.reserved_cost_microusd,j.actual_cost_microusd,j.actual_cost_microusd)
  or (a.owner_id,a.project_id,a.state,a.input_revision,a.input_hash)
   is distinct from (j.owner_id,j.project_id,'reserved',j.input_revision,j.input_hash)
  or a.verification is not null or a.lease_token is null or a.mime_type is distinct from 'image/png'
  or a.content_hash is distinct from p.observation->>'artifactHash'
  or a.request_key::text is distinct from j.input->>'attemptId'
  or a.request#>>'{publication,source,sourceId}' is distinct from j.input->>'attemptId'
  or a.request#>>'{publication,source,kind}' is distinct from 'concept'
  or exists(select 1 from public.assets where id=a.asset_id)
  or exists(select 1 from public.asset_versions where id=a.version_id)
  or exists(select 1 from public.logo_raster_results where job_id=j.id)
  or (m.owner_id,m.project_id,m.worker_id,m.policy_identity)
   is distinct from (j.owner_id,j.project_id,j.worker_id,j.input->>'policyIdentity')
  or not exists(select 1 from fluid_private.logo_worker_principals wp join pg_roles role on role.oid=wp.role_oid and role.rolname=wp.role_name
   where wp.owner_id=m.owner_id and wp.role_name=m.role_name and wp.role_oid=m.role_oid
   and role.rolcanlogin and not role.rolinherit and not role.rolsuper and not role.rolbypassrls
   and not role.rolcreatedb and not role.rolcreaterole and not role.rolreplication
   and not exists(select 1 from pg_auth_members where member=role.oid))
  or g.member is distinct from 'output'
  or g.binding is distinct from jsonb_build_object('ownerId',j.owner_id,'workerId',m.worker_id,'sessionId',g.session_id,
   'authUserId',g.auth_user_id,'workerRoleOid',m.role_oid::bigint,'workerRoleName',m.role_name)
  or not exists(select 1 from fluid_private.logo_storage_principals sp where sp.auth_user_id=g.auth_user_id
   and sp.owner_id=j.owner_id and sp.role_name=m.role_name and sp.role_oid=m.role_oid and sp.worker_id=m.worker_id)
  or o.owner_id is distinct from g.auth_user_id::text
  or (to_jsonb(o)#>>'{metadata,size}')::bigint is distinct from a.byte_length
  or (to_jsonb(o)#>>'{metadata,contentLength}')::bigint is distinct from a.byte_length
  or to_jsonb(o)#>>'{metadata,mimetype}' is distinct from a.mime_type then
  raise exception 'logo_publication_adjudication_evidence_mismatch' using errcode='55000';
 end if;
 new.job_before:=to_jsonb(j); new.step_before:=to_jsonb(s); new.provider_before:=to_jsonb(p);
 new.publication_before:=to_jsonb(a); new.reservation_before:=to_jsonb(r); new.local_marker:=to_jsonb(m); new.storage_grant:=to_jsonb(g);
 -- Access timestamps are not object identity. Object version and upload metadata
 -- remain bound without requiring an expired Auth session to exist forever.
 new.storage_object:=to_jsonb(o)-array['last_accessed_at'];
 new.account_before:=to_jsonb(ledger); new.operator_role:=current_user; new.operator_session:=session_user;
 new.recorded_at:=clock_timestamp();
 perform fluid_private.settle_reservation(j.id);
 select to_jsonb(rr) into strict new.reservation_after from public.usage_reservations rr where job_id=j.id;
 select * into strict after_ledger from public.usage_accounts where owner_id=j.owner_id;
 new.account_after:=to_jsonb(after_ledger); released:=greatest(r.reserved_microusd-r.actual_microusd,0);
 if new.reservation_after is distinct from (new.reservation_before||'{"state":"settled"}'::jsonb)
  or new.account_after is distinct from (new.account_before||jsonb_build_object('reserved_microusd',ledger.reserved_microusd-released)) then
  raise exception 'logo_publication_adjudication_accounting_changed' using errcode='55000'; end if;
 update public.jobs set state='failed',error_code='publication_not_committed',finished_at=new.recorded_at where id=j.id;
 return new;
end $$;
create trigger logo_publication_adjudication_insert before insert on fluid_private.logo_publication_failure_adjudications
 for each row execute function fluid_private.record_logo_publication_failure_adjudication();
create trigger logo_publication_adjudication_immutable before update or delete on fluid_private.logo_publication_failure_adjudications
 for each row execute function fluid_private.record_logo_publication_failure_adjudication();
create trigger logo_publication_adjudication_no_truncate before truncate on fluid_private.logo_publication_failure_adjudications
 for each statement execute function fluid_private.record_logo_publication_failure_adjudication();

create function fluid_private.logo_publication_failure_adjudication_matches(p_job uuid)
returns boolean language sql stable set search_path='' set timezone='UTC' as $$
 select exists(select 1 from fluid_private.logo_publication_failure_adjudications x
  join public.jobs j on j.id=x.job_id
  join public.job_steps s on s.job_id=j.id
  join public.logo_provider_responses p on p.job_id=j.id
  join public.logo_asset_publications a on a.job_id=j.id
  join public.usage_reservations r on r.job_id=j.id
  join fluid_private.logo_local_jobs m on m.job_id=j.id
  join storage.objects o on o.bucket_id='fluid-assets' and o.name=a.owner_id::text||'/'||a.project_id::text||'/'||a.asset_id::text||'/'||a.version_id::text
  where j.id=p_job and j.state='failed' and j.error_code='publication_not_committed' and j.finished_at=x.recorded_at
   and to_jsonb(j)-array['state','error_code','finished_at']=x.job_before-array['state','error_code','finished_at']
   and to_jsonb(s)=x.step_before and s.state='ambiguous' and (select count(*) from public.job_steps where job_id=j.id)=1
   and to_jsonb(p)=x.provider_before and to_jsonb(a)=x.publication_before
   and (select count(*) from public.logo_asset_publications where job_id=j.id)=1
   and to_jsonb(r)=x.reservation_after and r.state='settled' and to_jsonb(m)=x.local_marker
   and to_jsonb(o)-array['last_accessed_at']=x.storage_object
   and not exists(select 1 from public.assets where id=a.asset_id)
   and not exists(select 1 from public.asset_versions where id=a.version_id)
   and not exists(select 1 from public.logo_raster_results where job_id=j.id));
$$;

do $patch$
declare definition text; original constant text :=
 $old$and (j.state='needs_reconciliation' or exists(select 1 from public.job_steps s where s.job_id=j.id and s.state='ambiguous'))$old$;
begin
 definition:=pg_get_functiondef('fluid_private.logo_local_project_clear(uuid,uuid)'::regprocedure);
 if (length(definition)-length(replace(definition,original,'')))/length(original)<>1 then
  raise exception 'unexpected_logo_adjudication_fragment'; end if;
 execute replace(definition,original,original||' and not fluid_private.logo_publication_failure_adjudication_matches(j.id)');
end $patch$;

do $acl$
declare object_id oid; recipient record;
begin
 alter table fluid_private.logo_publication_failure_adjudications enable row level security;
 alter table fluid_private.logo_publication_failure_adjudications force row level security;
 object_id:='fluid_private.logo_publication_failure_adjudications'::regclass;
 for recipient in select distinct a.grantee from pg_class c cross join lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
  where c.oid=object_id and a.grantee<>c.relowner loop
  execute format('revoke all on table %s from %s cascade',object_id::regclass,
   case when recipient.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(recipient.grantee)) end);
 end loop;
 foreach object_id in array array['fluid_private.record_logo_publication_failure_adjudication()'::regprocedure,
  'fluid_private.logo_publication_failure_adjudication_matches(uuid)'::regprocedure] loop
  for recipient in select distinct a.grantee from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
   where p.oid=object_id and a.grantee<>p.proowner loop
   execute format('revoke all on function %s from %s cascade',object_id::regprocedure,
    case when recipient.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(recipient.grantee)) end);
  end loop;
 end loop;
 if exists(select 1 from logo_adjudication_original_function old left join pg_proc p on p.oid=old.oid
  where p.oid is null or (p.proowner,p.proacl,p.prosecdef,p.provolatile,p.proconfig,p.proleakproof)
   is distinct from (old.proowner,old.proacl,old.prosecdef,old.provolatile,old.proconfig,old.proleakproof)) then
  raise exception 'logo_adjudication_security_changed'; end if;
end $acl$;
commit;
