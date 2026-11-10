-- ISOLATED DEVELOPMENT ONLY. Not a production migration or activation script.
-- This read-only seam reveals only whether the caller's already provisioned
-- restricted development login matches its own explicit owner/target binding.
-- It creates no login, credential, policy, capability, heartbeat or access grant.
-- Review/install only on the isolated local stack after baseline migrations.
begin;

create function public.check_development_worker_binding(p_lane text,p_expected_owner uuid,p_deployment_id text)
returns uuid language plpgsql stable security definer set search_path='' as $$
declare login name:=session_user; login_oid oid; expected_login name;
begin
 if p_lane not in ('strategy','naming','logo') or p_lane is null or p_expected_owner is null
 or p_deployment_id is null or p_deployment_id !~ '^embel-dev-[A-Za-z0-9._:-]{1,170}$'
 or current_setting('role',true) is distinct from 'none' then return null; end if;
 expected_login:=case when p_lane='logo' then 'embel_development_logo_worker' else 'embel_development_text_worker' end;
 if login<>expected_login then return null; end if;
 select r.oid into login_oid from pg_catalog.pg_roles r where r.rolname=login;
 if not fluid_private.api_text_restricted_role(login,login_oid) then return null; end if;
 if p_lane='logo' then
  -- Logo admission/leases are bound to the existing principal and stable
  -- worker ID, not a deployment column. No policy readiness is asserted here.
  if exists(select 1 from fluid_private.logo_worker_principals p
   where p.role_name=login and p.role_oid=login_oid and p.owner_id=p_expected_owner)
  then return p_expected_owner; end if;
  return null;
 end if;
 if exists(select 1 from fluid_private.naming_brain_pilots p
  where p.owner_id=p_expected_owner and p.role_name=login and p.role_oid=login_oid and p.deployment_id=p_deployment_id)
 and (select count(*) from fluid_private.local_prototype_strategy_capabilities c
  where c.owner_id=p_expected_owner and c.role_name=login and c.role_oid=login_oid and c.deployment_id=p_deployment_id
  and c.operation in ('strategy.reformulate','strategy.competitors','strategy.audience','strategy.personality'))=4
 then return p_expected_owner; end if;
 return null;
end $$;
revoke all on function public.check_development_worker_binding(text,uuid,text) from public,anon,authenticated,service_role;
commit;

-- Separate reviewed local-principal configuration may grant only this proof:
-- grant execute on function public.check_development_worker_binding(text,uuid,text)
--   to embel_development_text_worker,embel_development_logo_worker;
-- Do not grant SELECT on fluid_private tables or execute on its invoker helpers.
