-- D080: exact future local Strategy model choice. Canonical validation is not
-- admission authority: hosted/testing requests retain the existing Sol gate.
-- Standard prices: https://developers.openai.com/api/docs/models/gpt-6-luna
-- https://developers.openai.com/api/docs/pricing
-- No runtime/capability is activated and no saved job or policy row is changed.
begin;
do $guard$
declare signature text; expected text; volatility text;
begin
 for signature,expected,volatility in values
  ('fluid_private.api_text_guided_policy(text,jsonb)','eb284f7380f7791087f99e2c8831eab6','i'),
  ('fluid_private.api_text_request_policy(uuid,text,jsonb)','663e25f61b904266085a23482bc8c0ab','s') loop
  if not exists(select 1 from pg_proc p where p.oid=signature::regprocedure and md5(p.prosrc)=expected
   and not p.prosecdef and p.provolatile::text=volatility and p.proconfig=array['search_path=""']
   and not p.proleakproof and p.proowner=(select oid from pg_roles where rolname=current_user)) then
   raise exception 'unexpected_local_luna_strategy_predecessor: %',signature;
  end if;
 end loop;
end $guard$;

do $patch$
declare definition text; original text;
begin
 definition:=pg_get_functiondef('fluid_private.api_text_guided_policy(text,jsonb)'::regprocedure);
 original:=$old$p=jsonb_build_object('version',2,'pricingVersion','2026-10-14','handlerVersion','strategy-openai-guided-v1',
   'model','gpt-6.1-sol','maxInputTokens',case when p_operation='strategy.competitors' then 3150000 else 32768 end,
   'maxOutputTokens',case when p_operation='strategy.competitors' then 8192 else 4096 end,
   'maxWebSearchCalls',case when p_operation='strategy.competitors' then 2 else 0 end,
   'inputMicrousdPerMillionTokens',2000000,'cachedInputMicrousdPerMillionTokens',100000,
   'cacheWriteMicrousdPerMillionTokens',2500000,'outputMicrousdPerMillionTokens',10000000,
   'webSearchMicrousdPerCall',10000,'maximumCostMicrousd',case when p_operation='strategy.competitors' then 15892880 else 122880 end)$old$;
 if(length(definition)-length(replace(definition,original,'')))/length(original)<>1 then raise exception 'unexpected_local_luna_canonical_fragment';end if;
 execute replace(definition,original,'('||original||$new$ or p=jsonb_build_object(
   'version',2,'pricingVersion','2026-10-18','handlerVersion','strategy-openai-guided-v1','model','gpt-6-luna',
   'maxInputTokens',case when p_operation='strategy.competitors' then 3150000 else 32768 end,
   'maxOutputTokens',case when p_operation='strategy.competitors' then 8192 else 4096 end,
   'maxWebSearchCalls',case when p_operation='strategy.competitors' then 2 else 0 end,
   'inputMicrousdPerMillionTokens',100000,'cachedInputMicrousdPerMillionTokens',10000,
   'cacheWriteMicrousdPerMillionTokens',125000,'outputMicrousdPerMillionTokens',500000,
   'webSearchMicrousdPerCall',10000,'maximumCostMicrousd',case when p_operation='strategy.competitors' then 813644 else 6144 end))$new$);

 definition:=pg_get_functiondef('fluid_private.api_text_request_policy(uuid,text,jsonb)'::regprocedure);
 original:=$old$or (fluid_private.api_text_testing_enabled(p_owner,p_operation) and fluid_private.api_text_guided_policy(p_operation,p_policy))$old$;
 if(length(definition)-length(replace(definition,original,'')))/length(original)<>1 then raise exception 'unexpected_local_luna_hosted_fragment';end if;
 execute replace(definition,original,$new$or (p_policy->>'model'='gpt-6.1-sol' and fluid_private.api_text_testing_enabled(p_owner,p_operation) and fluid_private.api_text_guided_policy(p_operation,p_policy))$new$);
end $patch$;
commit;
