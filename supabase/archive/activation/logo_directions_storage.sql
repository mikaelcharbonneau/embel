-- UNEXECUTED HOSTED ACTIVATION PROPOSAL. Separate explicit access approval.
-- Disposable PGlite tests alone may apply this file in the current source task.
-- Order: concept candidate, production candidate/activation, generative
-- candidate/activation, directions candidate, then this directions activation.
-- Creates no principal, session, binding, credential or enabled capability.
-- Exactly two EXECUTE grants and GET-only SELECT authority. No write changes.
begin;
grant execute on function public.authorize_logo_directions_storage(uuid,uuid,uuid,text),
 fluid_private.logo_directions_storage_object_allowed(text,text) to authenticated;
create policy fluid_logo_directions_storage_read on storage.objects as permissive for select to authenticated
 using(storage.allow_only_operation('object.get_authenticated') and fluid_private.logo_directions_storage_object_allowed(bucket_id,name));
-- Existing concept, production and generative branches preserved verbatim.
-- Never reapply an older activation afterward: it would remove later branches.
-- Existing INSERT/UPDATE/DELETE fences remain completely unchanged.
alter policy fluid_logo_worker_storage_read_fence on storage.objects using(
 not fluid_private.logo_storage_identity_bound() or
 (owner_id=(select auth.uid())::text and storage.allow_only_operation('object.get_authenticated') and fluid_private.logo_storage_object_allowed(bucket_id,name)) or
 (storage.allow_only_operation('object.get_authenticated') and fluid_private.logo_production_storage_object_allowed(bucket_id,name,owner_id,'read')) or
 (storage.allow_only_operation('object.get_authenticated') and fluid_private.logo_generative_storage_object_allowed(bucket_id,name,owner_id,'read')) or
 (storage.allow_only_operation('object.get_authenticated') and fluid_private.logo_directions_storage_object_allowed(bucket_id,name)));
commit;
