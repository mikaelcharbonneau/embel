-- ISOLATED LOCAL DEVELOPMENT ONLY. Not a production migration or activation.
-- Prerequisite: the exact reviewed logo_worker_storage candidate is installed.
-- After independently verifying the Docker embel-local-dev target on loopback
-- port 54322, a local operator must explicitly mark THIS database:
--   ALTER DATABASE postgres SET embel.development_target = 'embel-local-dev';
-- The catalog marker is a deliberate operator assertion, not cryptographic
-- proof of physical location. Never mark a hosted database to pass this guard.
-- A session/role GUC cannot satisfy the database-level marker check below.
-- No account, role, credential, binding, grant, policy, bucket or provider change.
begin;

do $local_issuer$
declare previous pg_catalog.pg_proc%rowtype; changed pg_catalog.pg_proc%rowtype; definition text;
 hosted_issuer constant text:='https://fricsfwqibyhemknqgyf.supabase.co/auth/v1';
 local_issuer constant text:='http://127.0.0.1:54321/auth/v1';
begin
 if current_database()<>'postgres' or not exists(
  select 1 from pg_catalog.pg_db_role_setting setting
  join pg_catalog.pg_database database on database.oid=setting.setdatabase
  where database.datname=current_database() and setting.setrole=0
   and setting.setconfig @> array['embel.development_target=embel-local-dev']
 ) then raise exception 'isolated_development_target_not_confirmed' using errcode='55000'; end if;

 select * into previous from pg_catalog.pg_proc
 where oid=pg_catalog.to_regprocedure('fluid_private.logo_storage_context()');
 if not found or previous.proowner<>(select oid from pg_catalog.pg_roles where rolname=current_user)
 or previous.prolang<>(select oid from pg_catalog.pg_language where lanname='plpgsql')
 or previous.prokind<>'f' or previous.prorettype<>'jsonb'::regtype or previous.pronargs<>0
 or not previous.prosecdef or previous.provolatile<>'v' or previous.proparallel<>'u' or previous.proleakproof
 or previous.proconfig is distinct from array['search_path=""']
 or pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(previous.prosrc,'UTF8')),'hex')
   <>'190f5ba2cc1372e88f5577f47ad3fa0a0dd90169785a5732dd7edcd323f8f001'
 or exists(select 1 from pg_catalog.aclexplode(coalesce(previous.proacl,pg_catalog.acldefault('f',previous.proowner))) acl
  where acl.grantee<>previous.proowner and acl.privilege_type='EXECUTE')
 then raise exception 'unexpected_logo_storage_context_predecessor' using errcode='55000'; end if;

 -- The reviewed body has exactly one issuer literal. Reconstructing the
 -- existing definition preserves its OID, owner, ACL and every other predicate.
 definition:=pg_catalog.pg_get_functiondef(previous.oid);
 if pg_catalog.length(previous.prosrc)-pg_catalog.length(pg_catalog.replace(previous.prosrc,hosted_issuer,''))
   <>pg_catalog.length(hosted_issuer) then
  raise exception 'unexpected_logo_storage_context_issuer' using errcode='55000';
 end if;
 execute pg_catalog.replace(definition,hosted_issuer,local_issuer);
 select * into strict changed from pg_catalog.pg_proc where oid=previous.oid;
 if changed.prosrc is distinct from pg_catalog.replace(previous.prosrc,hosted_issuer,local_issuer)
 or (to_jsonb(changed)-'prosrc') is distinct from (to_jsonb(previous)-'prosrc') then
  raise exception 'logo_storage_context_metadata_changed' using errcode='55000';
 end if;
end $local_issuer$;
commit;
