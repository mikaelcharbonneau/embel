-- Progressive runs retain many small, independently acknowledged role calls.
-- Widen only their aggregate observation envelope; preserve historical bounds,
-- per-receipt validation, immutable identities and digest replay before capacity.
begin;
do $$
declare definition text; original text;
begin
 if not exists(select 1 from pg_proc p where p.oid='public.record_naming_brain_provider_receipt(uuid,uuid,jsonb)'::regprocedure
  and md5(p.prosrc)='e61a54bb9fd8aa9434d7112414c811df' and p.prosecdef and p.provolatile='v'
  and p.proconfig=array['search_path=""'] and not p.proleakproof
  and p.proowner=(select oid from pg_roles where rolname=current_user)) then
  raise exception 'unexpected_progressive_receipt_capacity_predecessor';
 end if;
 definition:=pg_get_functiondef('public.record_naming_brain_provider_receipt(uuid,uuid,jsonb)'::regprocedure);
 original:=$old$if (select count(*) from fluid_private.naming_brain_receipts where run_id=r.id)>=500 or (select coalesce(sum(octet_length(receipt::text)),0) from fluid_private.naming_brain_receipts where run_id=r.id)+octet_length(p_receipt::text)>8388608 then$old$;
 if(length(definition)-length(replace(definition,original,'')))/length(original)<>1 then
  raise exception 'unexpected_progressive_receipt_capacity_fragment';
 end if;
 execute replace(definition,original,$new$if (select count(*) from fluid_private.naming_brain_receipts where run_id=r.id)>=(case when fluid_private.local_naming_progressive_job(r.job_id) then 5000 else 500 end)
 or (select coalesce(sum(octet_length(receipt::text)),0) from fluid_private.naming_brain_receipts where run_id=r.id)+octet_length(p_receipt::text)>(case when fluid_private.local_naming_progressive_job(r.job_id) then 67108864 else 8388608 end) then$new$);
end $$;
commit;
