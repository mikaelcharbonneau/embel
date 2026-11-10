-- Local owner-bound activation using the existing restricted image worker and
-- Storage identity. No new credentials, role privileges or monetary allowance.
-- Concepts and saved-preview refinements use the same exact image contract;
-- operation remains separately bound in every policy, job and Storage grant.
begin;
do $activate$
declare c fluid_private.logo_local_capabilities; p fluid_private.logo_runtime_policies;
 s fluid_private.logo_storage_principals; configured fluid_private.logo_runtime_policies;
begin
 select * into strict c from fluid_private.logo_local_capabilities where role_name='fluid_logo_worker' and enabled for share;
 if not fluid_private.logo_local_enabled(c.owner_id) then raise exception 'reviewed_local_logo_binding_required'; end if;
 select * into strict p from fluid_private.logo_runtime_policies where owner_id=c.owner_id and operation='identity.logo_concept' for share;
 select * into strict s from fluid_private.logo_storage_principals where owner_id=c.owner_id and role_name=c.role_name
  and role_oid=c.role_oid and worker_id=c.worker_id and enabled for share;
 if p.policy_identity is distinct from c.policy_identity or not p.enabled or p.handler_version is distinct from 'logo-image-v1'
  or p.provider is distinct from 'openai' or p.model is distinct from 'gpt-image-2.5-sunburst-2026-09-08'
  or p.engine is not null or p.subscription_policy is not null or p.max_cost_microusd<=0
  or not exists(select 1 from fluid_private.logo_generative_storage_capabilities where auth_user_id=s.auth_user_id
   and operation='identity.logo_concept' and policy_identity=c.policy_identity and enabled) then
  raise exception 'reviewed_local_logo_image_policy_required'; end if;
 insert into fluid_private.logo_runtime_policies(owner_id,operation,policy_identity,handler_version,provider,model,engine,max_cost_microusd,enabled)
  values(c.owner_id,'identity.logo_refine',p.policy_identity,p.handler_version,p.provider,p.model,p.engine,p.max_cost_microusd,true)
  on conflict(owner_id,operation) do nothing;
 select * into strict configured from fluid_private.logo_runtime_policies where owner_id=c.owner_id and operation='identity.logo_refine';
 if to_jsonb(configured) is distinct from (to_jsonb(p)||'{"operation":"identity.logo_refine"}'::jsonb) then
  raise exception 'local_refinement_policy_conflict'; end if;
 insert into fluid_private.logo_generative_storage_capabilities(auth_user_id,operation,policy_identity,enabled)
  values(s.auth_user_id,'identity.logo_refine',p.policy_identity,true) on conflict(auth_user_id,operation) do nothing;
 if not exists(select 1 from fluid_private.logo_generative_storage_capabilities where auth_user_id=s.auth_user_id
  and operation='identity.logo_refine' and policy_identity=p.policy_identity and enabled) then
  raise exception 'local_refinement_storage_conflict'; end if;
end $activate$;
commit;
