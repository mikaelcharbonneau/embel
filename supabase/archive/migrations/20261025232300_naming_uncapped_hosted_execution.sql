-- Future hosted Naming uses the existing uncapped native Agents profile.
-- Historical inputs, requests, caps, receipts, holds and actual costs are not
-- rewritten. No runtime activation, new privilege or provider call is included.
begin;

do $guard$
declare signature text; expected text; definer boolean; volatility text;
begin
 for signature,expected,definer,volatility in values
 ('public.ensure_naming_brain_run(uuid,jsonb)','04e860b58c46a38999afaf2a61e76ca3',true,'v'),
 ('fluid_private.naming_progressive_provider_cap(jsonb,jsonb)','8de0382db01f771b6111eeb52ca79564',false,'i'),
 ('fluid_private.naming_brain_summary(fluid_private.naming_brain_runs)','ceebed2d11c50bde23ec5df3d57afec4',false,'s') loop
  if not exists(select 1 from pg_proc p where p.oid=signature::regprocedure and md5(p.prosrc)=expected
   and p.prosecdef=definer and p.provolatile::text=volatility and p.proconfig=array['search_path=""']
   and not p.proleakproof and p.proowner=(select oid from pg_roles where rolname=current_user)) then
   raise exception 'unexpected_uncapped_naming_predecessor: %',signature;
  end if;
 end loop;
end $guard$;

do $patch$
declare signature text; original text; replacement text; definition text;
begin
 for signature,original,replacement in values
 ('public.ensure_naming_brain_run(uuid,jsonb)',
 $old$if fluid_private.hosted_naming_context(o,p.id) then input:=input||jsonb_build_object('executionAuthority','hosted_owner_v1','providerBudgetVersion',1); end if;$old$,
 $new$if fluid_private.hosted_naming_context(o,p.id) then input:=input||jsonb_build_object('executionAuthority','hosted_owner_v1','providerBudgetVersion',2); end if;$new$),
 ('fluid_private.naming_progressive_provider_cap(jsonb,jsonb)',
 $old$ if p_input->'providerBudgetVersion' is distinct from '1'::jsonb or p_input->'localPipelineVersion' is distinct from '2'::jsonb then$old$,
 $new$ if p_input->'providerBudgetVersion'='2'::jsonb then
  if p_input->>'executionAuthority' is distinct from 'hosted_owner_v1'
   or p_input->'localPipelineVersion' is distinct from '2'::jsonb or p_input->'localTimingVersion' is distinct from '2'::jsonb
   or p_request#>'{policy,localPipelineVersion}' is distinct from '2'::jsonb
   or p_request#>>'{policy,budgetControl}' is distinct from 'local_unlimited_v1'
   or p_request#>'{policy,providerSpendCapCents}' is not null then
   raise exception 'invalid_uncapped_provider_budget' using errcode='22023';
  end if;
  -- Zero is this legacy aggregate's contribution, never a cost observation.
  return 0;
 end if;
 if p_input->'providerBudgetVersion' is distinct from '1'::jsonb or p_input->'localPipelineVersion' is distinct from '2'::jsonb then$new$),
 ('fluid_private.naming_brain_summary(fluid_private.naming_brain_runs)',
 $old$||case when fluid_private.naming_brain_execution_authority(j.id)='hosted_owner_v1' then jsonb_build_object('executionAuthority','hosted_owner_v1') else '{}'::jsonb end;$old$,
 $new$||case when fluid_private.naming_brain_execution_authority(j.id)='hosted_owner_v1' then
 jsonb_build_object('executionAuthority','hosted_owner_v1')
 ||case when j.input->'providerBudgetVersion'='2'::jsonb then jsonb_build_object('providerBudgetVersion',2) else '{}'::jsonb end
 else '{}'::jsonb end;$new$) loop
  definition:=pg_get_functiondef(signature::regprocedure);
  if (length(definition)-length(replace(definition,original,'')))/length(original)<>1 then
   raise exception 'unexpected_uncapped_naming_fragment: %',signature;
  end if;
  execute replace(definition,original,replacement);
 end loop;
end $patch$;
commit;
