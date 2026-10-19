-- Supabase's authenticated download performs an internal authenticated-info
-- lookup before serving bytes. Permit that exact operation only inside the
-- existing generative owner/session/lease/object grant predicates.
begin;
do $policy$
declare policy_name text; predicate text; updated text;
 needle constant text := 'storage.allow_only_operation(''object.get_authenticated''::text) AND fluid_private.logo_generative_storage_object_allowed';
 replacement constant text := '(storage.allow_only_operation(''object.get_authenticated''::text) OR storage.allow_only_operation(''object.get_authenticated_info''::text)) AND fluid_private.logo_generative_storage_object_allowed';
begin
 foreach policy_name in array array['fluid_logo_generative_storage_read','fluid_logo_worker_storage_read_fence'] loop
  select pg_get_expr(polqual,polrelid) into predicate from pg_policy
   where polrelid='storage.objects'::regclass and polname=policy_name and polcmd='r';
  if predicate is null or strpos(predicate,needle)=0 then raise exception 'unexpected_logo_download_policy'; end if;
  updated:=replace(predicate,needle,replacement);
  execute format('alter policy %I on storage.objects using (%s)',policy_name,updated);
 end loop;
end $policy$;
commit;
