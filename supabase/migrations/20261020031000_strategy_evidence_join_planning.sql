-- Bound exhaustive join-order planning for two primary-key-anchored evidence
-- checks. No SQL body, authorization predicate, data, accounting, ACL, owner,
-- security mode, volatility, search path or global/session setting is changed.
-- Each function restores the caller's planner setting when it returns.
begin;
create temporary table strategy_evidence_planning_before on commit drop as
 select p.oid,to_jsonb(p)-'proconfig' descriptor,p.proconfig,
  current_setting('join_collapse_limit') caller_join_collapse_limit
 from pg_catalog.pg_proc p where p.oid in (
  'fluid_private.research_operator_adjudication_matches(uuid)'::regprocedure,
  'fluid_private.api_text_deleted_strategy_quarantined(uuid,text,uuid,uuid)'::regprocedure);

do $guard$
declare signature text; expected text;
begin
 for signature,expected in values
  ('fluid_private.research_operator_adjudication_matches(uuid)','fc8dae390cae880fb0e20bd1489566e9'),
  ('fluid_private.api_text_deleted_strategy_quarantined(uuid,text,uuid,uuid)','e7f84d185ab6e5d45d04851334d45d3f') loop
  if not exists(select 1 from pg_catalog.pg_proc p
   join pg_catalog.pg_language l on l.oid=p.prolang
   where p.oid=signature::regprocedure and md5(p.prosrc)=expected
    and l.lanname='sql' and not p.prosecdef and p.provolatile='s'
    and p.proconfig=array['search_path=""'] and not p.proleakproof
    and p.prokind='f' and not p.proretset and not p.proisstrict
    and p.proparallel='u' and p.procost=100
    and not exists(select 1 from pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
     where a.grantee<>p.proowner)
    and p.proowner=(select oid from pg_catalog.pg_roles where rolname=current_user)) then
   raise exception 'unexpected_strategy_evidence_planning_predecessor: %',signature;
  end if;
 end loop;
end $guard$;

alter function fluid_private.research_operator_adjudication_matches(uuid)
 set join_collapse_limit=1;
alter function fluid_private.api_text_deleted_strategy_quarantined(uuid,text,uuid,uuid)
 set join_collapse_limit=1;

do $verify$
begin
 if (select count(*) from strategy_evidence_planning_before)<>2
  or exists(select 1 from strategy_evidence_planning_before before
   left join pg_catalog.pg_proc after on after.oid=before.oid
   where after.oid is null
    or (to_jsonb(after)-'proconfig') is distinct from before.descriptor
    or after.proconfig is distinct from array['search_path=""','join_collapse_limit=1']
    or current_setting('join_collapse_limit') is distinct from before.caller_join_collapse_limit) then
  raise exception 'strategy_evidence_planning_changed_unexpected_state';
 end if;
end $verify$;
commit;
