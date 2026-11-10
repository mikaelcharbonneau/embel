-- D083: reviewed operator activation for the existing account and restricted
-- Mac worker. Apply only after the hosted execution migration and production
-- web release are verified. No role, credential, allowance or old job changes.
begin;
do $activation$
declare p fluid_private.naming_brain_pilots; c fluid_private.hosted_naming_capabilities;
begin
 perform fluid_private.lock_strategy_owner('6840f4c2-15a6-45a7-97be-41e7e5e37f42');
 select * into strict p from fluid_private.naming_brain_pilots
 where id='742aefc5-b222-48a6-8ee6-668f818d3c2a' and owner_id='6840f4c2-15a6-45a7-97be-41e7e5e37f42'
 and role_name='fluid_naming_brain_worker' and role_oid=23033::oid
 and deployment_id='embel-naming-local-b2ff6ce8bbc2-20261017'
 and encode(sha256(convert_to(policy::text,'UTF8')),'hex')='76ceb803800e70c800d7a352f8cb8bcc1621f691fec21ebb197028fefde53176'
 and policy->>'model'='gpt-6-luna' and policy->>'reasoningEffort'='xhigh' and policy->>'protocol'='openai_agents'
 and enabled and ready_until>clock_timestamp() for update;
 if not fluid_private.api_text_restricted_role(p.role_name,p.role_oid) then raise exception 'unexpected_naming_worker'; end if;
 select * into c from fluid_private.hosted_naming_capabilities where owner_id=p.owner_id for update;
 if found then
  if (c.pilot_id,c.role_name,c.role_oid,c.deployment_id,c.policy_identity,c.execution_authority,c.enabled) is distinct from
   (p.id,p.role_name,p.role_oid,p.deployment_id,encode(sha256(convert_to(p.policy::text,'UTF8')),'hex'),'hosted_owner_v1'::text,true)
  then raise exception 'unexpected_existing_hosted_naming_capability'; end if;
 else
  insert into fluid_private.hosted_naming_capabilities(owner_id,pilot_id,role_name,role_oid,deployment_id,policy_identity,enabled)
  values(p.owner_id,p.id,p.role_name,p.role_oid,p.deployment_id,encode(sha256(convert_to(p.policy::text,'UTF8')),'hex'),true);
 end if;
end $activation$;
commit;

-- Reversible operational stop: disable this exact capability. Issued sessions
-- retain their immutable evidence and permitted observation; no data is deleted.
-- update fluid_private.hosted_naming_capabilities set enabled=false
-- where owner_id='6840f4c2-15a6-45a7-97be-41e7e5e37f42'
-- and pilot_id='742aefc5-b222-48a6-8ee6-668f818d3c2a';
