-- Known execution rejection is distinct from unknown execution and from final
-- financial settlement. Existing rows and full run allowances are untouched.
begin;
do $guard$
declare signature text; expected text; definer boolean; volatility text;
begin
 for signature,expected,definer,volatility in values
 ('public.complete_naming_brain_stage(uuid,uuid,text,text,jsonb)','6f4d4c12b0742c3f116789f593f3ff8e',true,'v'),
 ('fluid_private.naming_brain_call_terminal(fluid_private.naming_brain_calls)','bd467e1efdd781e5db4a976a018dd531',false,'s') loop
  if not exists(select 1 from pg_proc p where p.oid=signature::regprocedure and md5(p.prosrc)=expected
   and p.prosecdef=definer and p.provolatile::text=volatility and p.proconfig=array['search_path=""']
   and not p.proleakproof and p.proowner=(select oid from pg_roles where rolname=current_user)) then raise exception 'unexpected_naming_rejection_predecessor: %',signature; end if;
 end loop;
end $guard$;

create function fluid_private.naming_brain_rejected_receipt(c fluid_private.naming_brain_calls) returns boolean
language sql stable set search_path='' as $$
 select exists(select 1 from lateral(
  select receipt from fluid_private.naming_brain_receipts receipt
  where receipt.run_id=c.run_id and receipt.stage_key=c.stage_key and receipt.call_key=c.call_key
  order by receipt.created_at desc,receipt.id desc limit 1
 ) latest where latest.receipt->>'dispatchState'='not_dispatched'
 and latest.receipt->>'requestId' ~ '^req_[A-Za-z0-9_-]{1,196}$'
 and latest.receipt->>'requestHash'=c.request->>'requestHash' and latest.receipt->>'requestKey'=c.request->>'requestKey'
 and latest.receipt->>'providerCallKey'=c.call_key
 and latest.receipt->>'sessionId' is null and latest.receipt->>'turnId' is null and latest.receipt->>'agentId' is null and latest.receipt->>'responseId' is null
 and latest.receipt->'callIds'='[]'::jsonb and latest.receipt->'toolCalls'='[]'::jsonb and latest.receipt->'artifactItemIds'='[]'::jsonb
 and latest.receipt->'usageObservations'='[]'::jsonb and latest.receipt->'providerCostCounters'='[]'::jsonb
 and latest.receipt->>'accountingStatus'='provisional' and latest.receipt->>'confirmedActualCostMicrousd' is null
 and not exists(select 1 from fluid_private.naming_brain_receipts other where other.run_id=c.run_id and other.stage_key=c.stage_key and other.call_key=c.call_key
  and (other.receipt->>'dispatchState'<>'not_dispatched' or other.receipt->>'sessionId' is not null or other.receipt->>'turnId' is not null
   or other.receipt->>'responseId' is not null or other.receipt->'usageObservations'<>'[]'::jsonb or other.receipt->'providerCostCounters'<>'[]'::jsonb))
 and not exists(select 1 from fluid_private.naming_brain_provider_records records where records.run_id=c.run_id and records.stage_key=c.stage_key and records.call_key=c.call_key)
 and not exists(select 1 from fluid_private.naming_brain_artifacts a where a.run_id=c.run_id and a.stage_key=c.stage_key and a.artifact#>>'{providerReceipt,providerCallKey}'=c.call_key));
$$;

do $patch$
declare definition text; original text; replacement text;
begin
 definition:=pg_get_functiondef('public.complete_naming_brain_stage(uuid,uuid,text,text,jsonb)'::regprocedure);
 original:=$old$and receipt.receipt->>'sessionId' is not null and receipt.receipt->>'turnId' is not null)) then$old$;
 replacement:=$new$and receipt.receipt->>'sessionId' is not null and receipt.receipt->>'turnId' is not null)
 and not(p_state='failed' and p_output->>'errorCode'='provider_request_rejected' and fluid_private.naming_brain_rejected_receipt(c))) then$new$;
 if (length(definition)-length(replace(definition,original,'')))/length(original)<>1 then raise exception 'unexpected_naming_rejection_identity_guard'; end if;
 definition:=replace(definition,original,replacement);
 original:=$old$(fluid_private.naming_brain_call_failed(c) or fluid_private.naming_brain_invalid_output(c,p_output))$old$;
 replacement:=$new$(fluid_private.naming_brain_call_failed(c) or fluid_private.naming_brain_invalid_output(c,p_output)
 or (p_state='failed' and p_output->>'errorCode'='provider_request_rejected' and fluid_private.naming_brain_rejected_receipt(c)))$new$;
 if (length(definition)-length(replace(definition,original,'')))/length(original)<>1 then raise exception 'unexpected_naming_rejection_terminal_guard'; end if;
 execute replace(definition,original,replacement);
 definition:=pg_get_functiondef('fluid_private.naming_brain_call_terminal(fluid_private.naming_brain_calls)'::regprocedure);
 original:=$old$or exists(select 1 from fluid_private.naming_brain_stage_results result$old$;
 replacement:=$new$or (fluid_private.naming_brain_rejected_receipt(c) and exists(select 1 from fluid_private.naming_brain_stage_results rejected
  where rejected.run_id=c.run_id and rejected.stage_key=c.stage_key and rejected.state='failed' and rejected.output->>'errorCode'='provider_request_rejected'))
 or exists(select 1 from fluid_private.naming_brain_stage_results result$new$;
 if (length(definition)-length(replace(definition,original,'')))/length(original)<>1 then raise exception 'unexpected_naming_rejection_terminal_projection'; end if;
 execute replace(definition,original,replacement);
end $patch$;

do $deny$
declare privilege record; object_id oid:='fluid_private.naming_brain_rejected_receipt(fluid_private.naming_brain_calls)'::regprocedure;
begin
 for privilege in select distinct a.grantee from pg_proc p,lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where p.oid=object_id and a.grantee<>p.proowner loop
  execute format('revoke all on function %s from %s cascade',object_id::regprocedure,case when privilege.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(privilege.grantee)) end);
 end loop;
end $deny$;
commit;
