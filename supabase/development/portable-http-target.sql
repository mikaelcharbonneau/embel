-- Development-only transport configuration; no runtime function body changes.
-- The caller has already proved the dedicated, loopback Docker database and
-- holds the installation advisory lock. Production packets remain immutable.
do $$ begin
 if session_user<>'postgres' or current_user<>session_user
  or current_setting('embel.portable_development',true) is distinct from 'true'
  or exists(select 1 from fluid_private.shared_http_target)
 then raise exception 'portable_development_target_denied'; end if;
end $$;
alter table fluid_private.shared_http_target drop constraint shared_http_target_check;
alter table fluid_private.shared_http_target add constraint shared_http_target_check check(
 mode='hosted' and origin~'^https://[a-z0-9]{20}\.supabase\.co$'
 or mode='development' and origin~'^http://127\.0\.0\.1:[0-9]{4,5}$'
 and split_part(origin,':',3)::integer between 1024 and 65535
);
