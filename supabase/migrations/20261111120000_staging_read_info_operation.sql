-- Own references and Home attachments are staged before any saved asset exists,
-- so only fluid_owner_staging_read can admit the upload read-back. Hosted
-- Supabase Storage serves a private download after an object-info lookup that
-- runs as `object.get_authenticated_info`; the policy admitted only
-- `object.get_authenticated`, so every staged read-back was denied (HTTP 400)
-- and each upload ended as an uncertain publication.
--
-- Supabase documents both operations as the authenticated download pair
-- (https://supabase.com/docs/guides/storage/security/access-control). Only that
-- pair is admitted: signing, listing, public and other routes stay denied for
-- staged objects, and the owner and exact-object checks are unchanged.
alter policy fluid_owner_staging_read on storage.objects
  using (
    (bucket_id = 'fluid-assets'::text)
    and (owner_id = ((select auth.uid()))::text)
    and (
      storage.allow_only_operation('object.get_authenticated'::text)
      or storage.allow_only_operation('object.get_authenticated_info'::text)
    )
    and fluid_private.owner_staging_object_allowed(bucket_id, name)
  );
