-- Local maintenance shares the owner's ordinary job lock. A second expiry
-- invocation skips a busy owner instead of occupying another connection while
-- waiting. The worker also applies a server deadline before invoking these RPCs
-- in a pinned transaction; setting a deadline inside this function is too late.
-- Hosted Naming expiry and every existing settlement/lease branch are retained.
begin;
do $$
declare signature text; expected_md5 text; expected_definer boolean; expected_volatility text; definition text; original text;
begin
 for signature,expected_md5,expected_definer,expected_volatility in values
  ('public.expire_naming_brain_leases(text,text)','19dcebe0e591e564eada26eb2366cfcb',true,'v'),
  ('fluid_private.expire_local_strategy_leases()','bd0f726cef67fbcd8fb337f436a23bf2',false,'v'),
  ('fluid_private.naming_brain_preparation_pending(fluid_private.naming_brain_runs)','c8f52eafc991080503a356f96e605882',false,'s')
 loop
  if not exists(select 1 from pg_proc p where p.oid=signature::regprocedure
   and md5(p.prosrc)=expected_md5 and p.prosecdef=expected_definer and p.provolatile::text=expected_volatility
   and p.proconfig=array['search_path=""'] and not p.proleakproof
   and p.proowner=(select oid from pg_roles where rolname=current_user)) then
   raise exception 'unexpected_local_expiry_predecessor: %',signature;
  end if;
 end loop;

 original:=$old$ perform fluid_private.lock_strategy_owner(o);$old$;
 definition:=pg_get_functiondef('public.expire_naming_brain_leases(text,text)'::regprocedure);
 if(length(definition)-length(replace(definition,original,'')))/length(original)<>1 then
  raise exception 'unexpected_local_naming_expiry_lock_fragment';
 end if;
 execute replace(definition,original,$new$ if fluid_private.local_strategy_worker_owner()=o
 and not pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended(o::text,723902)) then return 0; end if;
 perform fluid_private.lock_strategy_owner(o);$new$);

 definition:=pg_get_functiondef('fluid_private.expire_local_strategy_leases()'::regprocedure);
 if(length(definition)-length(replace(definition,original,'')))/length(original)<>1 then
  raise exception 'unexpected_local_strategy_expiry_lock_fragment';
 end if;
 execute replace(definition,original,$new$ if not pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended(o::text,723902)) then return 0; end if;
 perform fluid_private.lock_strategy_owner(o);$new$);

 -- A partial progressive run cannot be preparation-pending. Force these two
 -- cheap necessary conditions before the existing current/research/terminal
 -- predicates; ordinary AND evaluation does not guarantee that ordering.
 definition:=pg_get_functiondef('fluid_private.naming_brain_preparation_pending(fluid_private.naming_brain_runs)'::regprocedure);
 original:=$old$ select case when not fluid_private.local_naming_progressive_job(r.job_id) then fluid_private.local_naming_previous_preparation_pending(r) else
$old$;
 if(length(definition)-length(replace(definition,original,'')))/length(original)<>1 then
  raise exception 'unexpected_local_preparation_pending_fragment';
 end if;
 execute replace(definition,original,$new$ select case when not fluid_private.local_naming_progressive_job(r.job_id) then fluid_private.local_naming_previous_preparation_pending(r)
 when (select count(*) from fluid_private.naming_brain_feed_entries where run_id=r.id)<>100 then false
 when not exists(select 1 from public.job_steps where job_id=r.job_id and owner_id=r.owner_id and project_id=r.project_id and step_key='creation' and state='succeeded') then false
 else
$new$);
end $$;
commit;
