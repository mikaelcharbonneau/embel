# Shared Storage authenticated download metadata

The shared private-download boundary permits only the two documented read
operations, `object.get_authenticated_info` and `object.get_authenticated`,
inside the existing `shared_storage_object_allowed` check. The additive
`shared_storage_download_metadata.sql` packet changes only the USING expression
of `embel_shared_storage_read` and `embel_shared_storage_read_fence` on
`storage.objects`. It preserves their roles, permissiveness, command and other
metadata. Every helper body/ACL, actor/session/object/execution check, write
policy and all other policies remain unchanged. No raw or service-role read,
list permission, worker URL change or inference request is introduced.

Supabase documents the paired read operations at
https://supabase.com/docs/guides/storage/security/access-control . Both the
metadata and private-download routes must satisfy the same exact object grant.

For a fresh shared production install, the offline
`scripts/prepare-shared-production-migration.mjs` compiler appends this exact
hash-pinned packet after all ten historical packets and before the final guard
and COMMIT. The ten predecessor source bytes and SHA256 pins are unchanged.
The post-install packet remains in the same atomic transaction: any failure
rolls back the complete fresh installation. Non-shared installers do not import
this compiler or apply this packet.

For an already installed shared environment, use only the separately reviewed
finite operational compiler's `prepare`, `apply` and read-only `resume` output.
Do not rerun the fresh-install compiler or replay apply after an uncertain ACK.
The packet refuses an unexpected target, helper/security metadata or predecessor
policy expression. A successful read-only resume establishes the paired policy
post-state. It does not establish a hosted Storage HTTP read or settle a job.

This correction does not require replacing the current worker. Live readback
and any separately guarded same-artifact completion remain release-coordinator
operations. Do not regenerate provider output or manually mark a job successful.
