-- LOCAL REVIEW ONLY. Minimal first installation for concepts with owned
-- references. Apply logo_worker_storage.sql then logo_generative_storage.sql
-- before this file. Existing production/directions activation is deliberately
-- rejected: that installation requires its own preserving policy migration.
-- No Auth user, session, principal binding or enabled capability is created.
begin;
do $guard$
begin
  if to_regclass('fluid_private.logo_production_storage_capabilities') is not null
    or to_regclass('fluid_private.logo_directions_storage_capabilities') is not null
    then raise exception 'existing_logo_storage_activation_requires_review'; end if;
end $guard$;
grant execute on function public.authorize_logo_generative_storage(uuid,uuid,uuid,text),
  fluid_private.logo_generative_storage_object_allowed(text,text,text,text) to authenticated;
create policy fluid_logo_generative_storage_read on storage.objects as permissive for select to authenticated
  using(storage.allow_only_operation('object.get_authenticated') and fluid_private.logo_generative_storage_object_allowed(bucket_id,name,owner_id,'read'));
create policy fluid_logo_generative_storage_insert on storage.objects as permissive for insert to authenticated
  with check(owner_id=(select auth.uid())::text and storage.allow_only_operation('object.upload') and fluid_private.logo_generative_storage_object_allowed(bucket_id,name,owner_id,'write'));
alter policy fluid_logo_worker_storage_read_fence on storage.objects using(
  not fluid_private.logo_storage_identity_bound() or
  (owner_id=(select auth.uid())::text and storage.allow_only_operation('object.get_authenticated') and fluid_private.logo_storage_object_allowed(bucket_id,name)) or
  (storage.allow_only_operation('object.get_authenticated') and fluid_private.logo_generative_storage_object_allowed(bucket_id,name,owner_id,'read')));
alter policy fluid_logo_worker_storage_insert_fence on storage.objects with check(
  not fluid_private.logo_storage_identity_bound() or
  (owner_id=(select auth.uid())::text and storage.allow_only_operation('object.upload') and fluid_private.logo_storage_object_allowed(bucket_id,name)) or
  (owner_id=(select auth.uid())::text and storage.allow_only_operation('object.upload') and fluid_private.logo_generative_storage_object_allowed(bucket_id,name,owner_id,'write')));
commit;
