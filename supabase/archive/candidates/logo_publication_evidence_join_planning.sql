-- UNAPPLIED REVIEW CANDIDATE. Bound join-order planning for the existing exact
-- Logo evidence matcher, including its nested absence witness. No SQL body,
-- evidence, accounting, ACL, owner, timeout, security mode or global setting
-- changes. This activation-only helper is not in the ordinary migration chain.
begin;
create temporary table logo_evidence_planning_before on commit drop as
 select p.oid,to_jsonb(p)-'proconfig' descriptor,p.proconfig,
  current_setting('join_collapse_limit') caller_join_collapse_limit
 from pg_catalog.pg_proc p
 where p.oid='fluid_private.logo_publication_failure_adjudication_matches(uuid)'::regprocedure;

do $guard$
declare signature text; expected text;
begin
 for signature,expected in values
  ('fluid_private.logo_publication_failure_adjudication_matches(uuid)','3aefd0303d54cd31382fb7debbaf90e3'),
  ('fluid_private.logo_absent_publication_adjudication_matches(uuid)','b35222e467ee7e74be8b74d91aea1c4b') loop
  if not exists(select 1 from pg_catalog.pg_proc p
   join pg_catalog.pg_language l on l.oid=p.prolang
   where p.oid=signature::regprocedure and md5(p.prosrc)=expected
    and l.lanname='sql' and not p.prosecdef and p.provolatile='s'
    and p.proconfig=array['search_path=""','TimeZone=UTC'] and not p.proleakproof
    and p.prokind='f' and not p.proretset and not p.proisstrict
    and p.proparallel='u' and p.procost=100
    and p.prorettype='boolean'::regtype
    and p.proowner='postgres'::regrole and current_user='postgres'
    and p.proacl=ARRAY['postgres=X/postgres']::aclitem[]) then
   raise exception 'unexpected_logo_evidence_planning_predecessor: %',signature;
  end if;
 end loop;
end $guard$;

alter function fluid_private.logo_publication_failure_adjudication_matches(uuid)
 set join_collapse_limit=1;

do $verify$
begin
 if (select count(*) from logo_evidence_planning_before)<>1
  or exists(select 1 from logo_evidence_planning_before before
   left join pg_catalog.pg_proc after on after.oid=before.oid
   where after.oid is null
    or (to_jsonb(after)-'proconfig') is distinct from before.descriptor
    or after.proconfig is distinct from array['search_path=""','TimeZone=UTC','join_collapse_limit=1']
    or current_setting('join_collapse_limit') is distinct from before.caller_join_collapse_limit) then
  raise exception 'logo_evidence_planning_changed_unexpected_state';
 end if;
end $verify$;
commit;
