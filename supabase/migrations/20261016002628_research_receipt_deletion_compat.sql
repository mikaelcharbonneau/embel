-- Preserve immutable pre-deletion receipts after the nullable jobs column was added.
-- No receipt, job, result, hold, grant, or accounting row is rewritten.
-- Compare the current shape first. Legacy shape is accepted ONLY when the new
-- deletion marker is null; every original evidence check remains mandatory.
begin;
create temporary table research_receipt_compat_security on commit drop as
 select oid,proowner,proacl,prosecdef,provolatile,proconfig,proleakproof
 from pg_catalog.pg_proc
 where oid='fluid_private.research_operator_adjudication_matches(uuid)'::regprocedure;
do $guard$
begin
 if not exists(select 1 from pg_catalog.pg_proc p
  where p.oid='fluid_private.research_operator_adjudication_matches(uuid)'::regprocedure
   and md5(p.prosrc)='22d1c318d1bf7b535fb3bdf0ce8d7e66'
   and not p.prosecdef and p.provolatile='s' and not p.proleakproof
   and p.proconfig=array['search_path=""']
   and p.proowner=(select oid from pg_catalog.pg_roles where rolname=current_user)) then
  raise exception 'unexpected_research_receipt_compat_predecessor';
 end if;
 if not exists(select 1 from pg_catalog.pg_attribute
  where attrelid='public.jobs'::regclass and attname='project_deletion_requested_at'
   and atttypid='timestamptz'::regtype and not attnotnull and not attisdropped) then
  raise exception 'missing_nullable_project_deletion_marker';
 end if;
end $guard$;

create or replace function fluid_private.research_operator_adjudication_matches(p_job uuid)
returns boolean language sql stable set search_path='' as $$
 select exists(select 1 from fluid_private.api_text_operator_adjudications x
  join public.jobs j on j.id=x.job_id and j.owner_id=x.owner_id and j.project_id=x.project_id
  join public.job_steps s on s.id=x.step_id and s.job_id=j.id and s.owner_id=j.owner_id and s.project_id=j.project_id
  join public.usage_reservations r on r.job_id=j.id and r.owner_id=j.owner_id and r.project_id=j.project_id
  join fluid_private.api_text_dispatches d on d.job_id=j.id
  join fluid_private.api_text_allowance_admissions a on a.job_id=j.id
  join fluid_private.api_text_testing_admissions t on t.job_id=j.id
  join public.usage_accounts ledger on ledger.owner_id=j.owner_id
  where x.job_id=p_job and j.state='failed' and j.error_code='operator_abandoned_billing_unresolved'
   and j.finished_at=x.recorded_at and j.lease_token is null and j.lease_expires_at is null
   and s.state='ambiguous' and r.state='active'
   and (select count(*) from public.job_steps where job_id=j.id)=1
   and (
    encode(sha256(convert_to((to_jsonb(j)-array['state','error_code','finished_at'])::text,'UTF8')),'hex')=x.job_sha256
    or (j.project_deletion_requested_at is null
     and encode(sha256(convert_to((to_jsonb(j)-array['state','error_code','finished_at','project_deletion_requested_at'])::text,'UTF8')),'hex')=x.job_sha256)
   )
   and encode(sha256(convert_to(to_jsonb(s)::text,'UTF8')),'hex')=x.step_sha256
   and encode(sha256(convert_to(s.output::text,'UTF8')),'hex')=x.output_sha256
   and encode(sha256(convert_to(to_jsonb(r)::text,'UTF8')),'hex')=x.reservation_sha256
   and encode(sha256(convert_to(to_jsonb(d)::text,'UTF8')),'hex')=x.dispatch_sha256
   and encode(sha256(convert_to(to_jsonb(a)::text,'UTF8')),'hex')=x.admission_sha256
   and encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex')=x.testing_marker_sha256
   and ledger.reserved_microusd>=x.retained_microusd
   and ledger.reserved_microusd=(select coalesce(sum(greatest(reserved_microusd-actual_microusd,0)),0)
    from public.usage_reservations where owner_id=j.owner_id and state='active'));
$$;

do $verify$
begin
 if exists(select 1 from research_receipt_compat_security before
  join pg_catalog.pg_proc after on after.oid=before.oid
  where (after.proowner,after.proacl,after.prosecdef,after.provolatile,after.proconfig,after.proleakproof)
   is distinct from (before.proowner,before.proacl,before.prosecdef,before.provolatile,before.proconfig,before.proleakproof)) then
  raise exception 'research_receipt_compat_security_changed';
 end if;
end $verify$;
commit;
