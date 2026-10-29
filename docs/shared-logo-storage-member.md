# Shared Logo Storage member dependency

The shared vector/export authorization path depends on
`fluid_private.logo_production_storage_member(public.jobs,public.logo_asset_publications,text)`.
The helper previously existed only in an optional legacy candidate. Installing
the ten shared packets could succeed without it, leaving the first vector read
authorization to fail with PostgreSQL42883 after a successful Auth probe.

`shared_logo_storage_member.sql` is an additive, bounded helper-only correction.
It installs the exact source-reviewed function when absent, or verifies an
already exact installation without replacing its OID. It checks three fixed
helper dependencies and three shared callers with their source/security/ACL
metadata, refuses conflicting signatures/bodies/ACLs, scrubs non-owner default
EXECUTE grants only on the new function, and verifies unrelated functions,
roles, policies, relations and default ACLs are unchanged. It creates no legacy
Storage tables, public brokers, roles, credentials, customer capability or
provider request. It changes no existing data or Storage RLS expression.

The offline fresh shared compiler appends this hash-pinned correction after the
ten immutable shared packets and the existing two-policy metadata correction.
The original packets and the applied metadata SQL are unchanged. The fresh
composition test deliberately omits the complete legacy production-Storage
candidate and its dependent activation steps. It proves the helper starts
absent and the shared installation supplies only the helper, with no unused
legacy tables or broker. A late failure rolls back the full fresh transaction.
Non-shared installations do not use this compiler or acquire the helper through
this change. The correction remains bound to the qualified production target
and PostgreSQL17.11; unknown metadata or a different server version refuses.

For an existing installation, use only the separately reviewed finite
prepare/apply/read-only-resume operation through the established authorized
connection. Apply once; on an uncertain acknowledgement, inspect the exact
resume proof before any further action. The private function is owner-only and
does not need a worker deployment or new grant. Existing actor/session/path,
owner, quote membership, publication and execution fences remain authoritative.
The failed vector job remains unchanged; any later normal zero-cost attempt is
a deliberate coordinator action, not replay of its old lease or admission.
