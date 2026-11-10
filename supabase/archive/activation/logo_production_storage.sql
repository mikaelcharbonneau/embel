-- UNEXECUTED HOSTED ACTIVATION PROPOSAL. Separate explicit access approval required.
-- LOCAL TESTS ONLY may apply this in the disposable PGlite fixture.
-- Requires reviewed candidate definitions and the existing concept policies.
-- Creates no principal, session, credential, binding or enabled capability.
-- Exactly two new EXECUTE grants; no table/schema/default ACL/worker grants.
begin;
grant execute on function public.authorize_logo_production_storage(uuid,uuid,uuid,text),
 fluid_private.logo_production_storage_object_allowed(text,text,text,text) to authenticated;
create policy fluid_logo_production_storage_read on storage.objects as permissive for select to authenticated
 using(storage.allow_only_operation('object.get_authenticated') and fluid_private.logo_production_storage_object_allowed(bucket_id,name,owner_id,'read'));
create policy fluid_logo_production_storage_insert on storage.objects as permissive for insert to authenticated
 with check(owner_id=(select auth.uid())::text and storage.allow_only_operation('object.upload') and fluid_private.logo_production_storage_object_allowed(bucket_id,name,owner_id,'write'));
-- Preserve old concept branches verbatim. The only alternate is exact frozen
-- membership/reservation, never owner-prefix or uploader identity alone.
-- Existing update/delete fences remain unchanged.
alter policy fluid_logo_worker_storage_read_fence on storage.objects using(
 not fluid_private.logo_storage_identity_bound() or
 (owner_id=(select auth.uid())::text and storage.allow_only_operation('object.get_authenticated') and fluid_private.logo_storage_object_allowed(bucket_id,name)) or
 (storage.allow_only_operation('object.get_authenticated') and fluid_private.logo_production_storage_object_allowed(bucket_id,name,owner_id,'read')));
alter policy fluid_logo_worker_storage_insert_fence on storage.objects with check(
 not fluid_private.logo_storage_identity_bound() or
 (owner_id=(select auth.uid())::text and storage.allow_only_operation('object.upload') and fluid_private.logo_storage_object_allowed(bucket_id,name)) or
 (owner_id=(select auth.uid())::text and storage.allow_only_operation('object.upload') and fluid_private.logo_production_storage_object_allowed(bucket_id,name,owner_id,'write')));
commit;
