-- UNEXECUTED HOSTED ACTIVATION PROPOSAL. Separate explicit access approval required.
-- Only disposable PGlite tests may apply this file in this implementation slice.
-- Requires reviewed generative candidate plus existing concept/production brokers.
-- No principal/session/credential/capability enablement, table/schema/default ACL.
begin;
grant execute on function public.authorize_logo_generative_storage(uuid,uuid,uuid,text),
 fluid_private.logo_generative_storage_object_allowed(text,text,text,text) to authenticated;
create policy fluid_logo_generative_storage_read on storage.objects as permissive for select to authenticated
 using(storage.allow_only_operation('object.get_authenticated') and fluid_private.logo_generative_storage_object_allowed(bucket_id,name,owner_id,'read'));
create policy fluid_logo_generative_storage_insert on storage.objects as permissive for insert to authenticated
 with check(owner_id=(select auth.uid())::text and storage.allow_only_operation('object.upload') and fluid_private.logo_generative_storage_object_allowed(bucket_id,name,owner_id,'write'));
-- Both existing alternate branches are preserved exactly. Disabled bindings stay
-- fenced, and ordinary Auth users retain their existing baseline tenant rights.
-- Existing restrictive UPDATE/DELETE denials are deliberately untouched.
alter policy fluid_logo_worker_storage_read_fence on storage.objects using(
 not fluid_private.logo_storage_identity_bound() or
 (owner_id=(select auth.uid())::text and storage.allow_only_operation('object.get_authenticated') and fluid_private.logo_storage_object_allowed(bucket_id,name)) or
 (storage.allow_only_operation('object.get_authenticated') and fluid_private.logo_production_storage_object_allowed(bucket_id,name,owner_id,'read')) or
 (storage.allow_only_operation('object.get_authenticated') and fluid_private.logo_generative_storage_object_allowed(bucket_id,name,owner_id,'read')));
alter policy fluid_logo_worker_storage_insert_fence on storage.objects with check(
 not fluid_private.logo_storage_identity_bound() or
 (owner_id=(select auth.uid())::text and storage.allow_only_operation('object.upload') and fluid_private.logo_storage_object_allowed(bucket_id,name)) or
 (owner_id=(select auth.uid())::text and storage.allow_only_operation('object.upload') and fluid_private.logo_production_storage_object_allowed(bucket_id,name,owner_id,'write')) or
 (owner_id=(select auth.uid())::text and storage.allow_only_operation('object.upload') and fluid_private.logo_generative_storage_object_allowed(bucket_id,name,owner_id,'write')));
commit;
