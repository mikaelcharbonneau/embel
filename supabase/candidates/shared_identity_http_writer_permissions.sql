-- Compatible post-install correction. Shared HTTP wrappers run as postgres,
-- which is not a superuser on Supabase. They need explicit permission to call
-- the two separately owned Identity writers. Customer and web-login access
-- remains through the existing ownership-checked wrappers only.
begin;
do $identity_http_writer_precondition$
declare expected record; actual record;
begin
 if current_user<>'postgres' then
  raise exception 'identity_http_writer_installer_required' using errcode='55000';
 end if;
 for expected in select * from (values
  ('public.prepare_shared_identity_request(text,uuid,jsonb,boolean)','postgres','d82c963bb2068853da207515b7cc6324ea2812093a0214598f43b3fc266ddaa2'),
  ('public.commit_shared_identity_request(uuid,jsonb,jsonb)','postgres','13dd220ded08b5f53419a254ab9d4170d40b582744934312363e90a38de7688a'),
  ('fluid_private.prepare_identity_transaction(uuid,jsonb,boolean)','fluid_identity_writer_definer_v1','7eeebe5a9d06a4cf03eb172017b5287f1cfc728e8280aa9468ef1cb01ffa705d'),
  ('fluid_private.commit_identity_transaction(uuid,jsonb,jsonb)','fluid_identity_writer_definer_v1','a71ce5e81b90668260cabf1162abf30c9dc299234ce3e459efc25b511eb5d0a3')
 ) as checked(signature,owner_name,body_hash) loop
  select p.*,l.lanname into actual from pg_proc p join pg_language l on l.oid=p.prolang
   where p.oid=to_regprocedure(expected.signature);
  if not found or actual.proowner<>to_regrole(expected.owner_name)::oid
   or not actual.prosecdef or actual.proleakproof or actual.provolatile<>'v'
   or actual.lanname<>'plpgsql' or actual.proconfig is distinct from array['search_path=""']
   or encode(sha256(convert_to(actual.prosrc,'UTF8')),'hex')<>expected.body_hash
   or exists(select 1 from aclexplode(coalesce(actual.proacl,acldefault('f',actual.proowner))) a
     where a.privilege_type='EXECUTE' and (a.grantee=0 or a.grantee in(
      select oid from pg_roles where rolname in('anon','authenticated','service_role'))))
  then raise exception 'identity_http_writer_predecessor_mismatch' using errcode='55000'; end if;
 end loop;
 if exists(select 1 from pg_auth_members where roleid=to_regrole('fluid_identity_writer_definer_v1')::oid
   and not(member=to_regrole('postgres')::oid and admin_option and not inherit_option and not set_option))
 then raise exception 'identity_http_writer_membership_changed' using errcode='55000'; end if;
end $identity_http_writer_precondition$;

-- Use only a temporary installer SET edge; do not retain writer membership.
grant fluid_identity_writer_definer_v1 to postgres with inherit false,set true;
set local role fluid_identity_writer_definer_v1;
grant execute on function fluid_private.prepare_identity_transaction(uuid,jsonb,boolean),
 fluid_private.commit_identity_transaction(uuid,jsonb,jsonb) to postgres;
reset role;
revoke fluid_identity_writer_definer_v1 from postgres granted by postgres;

do $identity_http_writer_postcondition$
declare signature text;
begin
 foreach signature in array array['fluid_private.prepare_identity_transaction(uuid,jsonb,boolean)',
  'fluid_private.commit_identity_transaction(uuid,jsonb,jsonb)'] loop
  if not has_function_privilege('postgres',to_regprocedure(signature),'EXECUTE') or not exists(
   select 1 from pg_proc p cross join lateral aclexplode(p.proacl) a
   where p.oid=to_regprocedure(signature) and a.grantee=to_regrole('postgres')::oid
    and a.grantor=to_regrole('fluid_identity_writer_definer_v1')::oid
    and a.privilege_type='EXECUTE' and not a.is_grantable)
  then raise exception 'identity_http_writer_grant_missing' using errcode='55000'; end if;
 end loop;
 if exists(select 1 from pg_auth_members where roleid=to_regrole('fluid_identity_writer_definer_v1')::oid
   and not(member=to_regrole('postgres')::oid and admin_option and not inherit_option and not set_option))
 then raise exception 'identity_http_writer_membership_not_restored' using errcode='55000'; end if;
end $identity_http_writer_postcondition$;
commit;
