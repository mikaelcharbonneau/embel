# Home attachment backend (local candidate)

## Integration

Import the thin route-facing defaults from `@/server/home-attachments`:

- `stageHomeAttachment(auth, input, bytes, signal?)`
- `readHomeAttachmentRequest(auth, requestKey, signal?)`
- `saveAttachedProjectDraft(auth, input, signal?)`
- `readAttachedProjectDraftRequest(auth, requestKey, signal?)`
- `resolveOwnedAttachments(auth, projectId, refs, signal?)`
- `getHomeAttachmentCapability()`

The default service has **no configuration** and returns a null policy; mutations/read operations fail with `integration_unavailable`. It never creates a storage bucket, login, project, provider connection or fallback.

To supply a reviewed runtime, instantiate `createHomeAttachmentService({backend, storage, policy})`. `createPostgresHomeAttachmentBackend(ownedConnectionFactory)` in `postgres.ts` implements all metadata operations. `HomeAttachmentStorage` is a required server-only private-object capability, not a browser SDK. It must implement immutable `putIfAbsent` (never overwrite), bounded `read` and confirmed absence as `null`; transport/permission errors must throw. There is no delete operation or public URL. The owner/id/version path is independently validated by the service.

The injected connection factory may use the existing pooled connection port. It must supply one dedicated non-inheriting, unprivileged direct login per owner with its verified OID. The candidate migration creates only an empty private principal mapping table. It provisions **no role or mapping**. Any later approved runtime configuration must bind the real role name/OID/owner and grant only schema usage and these exact private function signatures:

- `fluid_private.home_attachment_owner()`
- `fluid_private.prepare_home_attachment(jsonb,bigint)`
- `fluid_private.observe_home_attachment(uuid,jsonb)`
- `fluid_private.lookup_home_attachment(uuid)`
- `fluid_private.resolve_home_attachments(uuid[])`

The connection adapter verifies actual session user, OID and bound owner before issuing a parameterized operation; every private SQL function independently verifies the actual session login. Auth GUCs, caller owner fields, service-role/admin sessions and principal names with changed OIDs cannot certify bytes. No direct table grants belong to this login. The ordinary authenticated client performs only final save and final-request recovery.

## Route boundaries

Routes must retain verified non-anonymous authentication, same-origin checks, private/no-store responses, a streamed 10,485,760-byte binary bound and 32,768-byte JSON bound. Intended upload envelope: raw bytes, MIME in `Content-Type`, request key in `X-Fluid-Request-Key`, URI-encoded filename in `X-Fluid-Attachment-Name`, SHA-256 in `X-Fluid-Content-Hash`. Decode metadata exactly once, reject malformed headers and call the shared input schema. Do not use JSON/base64 file bodies or trust browser owner IDs.

A capability response may wrap the getter as `{ownerId,policy,reason}`; policy must remain null until a real storage capability and owner-bound metadata configuration are available. The default reason can state that private attachment storage is not configured.

PDF admission is currently unavailable. The capability getter removes `application/pdf` from a configured proposed policy; a PDF-only proposal yields a null capability. The shared approved proposal is unchanged. Previously staged or linked PDF receipts cannot bypass the disabled validator through recovery/finalization paths.

## Validation and immutability

Currently available byte validators support UTF-8 plain text and actual decoded PNG/JPEG. HTML/SVG/archive/binary content masquerading as text is rejected. Image inspection reuses the existing bounded isolated raster decoder.

PDF support is blocked until an enforceably bounded decoder exists. PDF.js can allocate external decoded buffers that are not bounded by the JavaScript heap ceiling or per-image limits, so this package does not run PDF.js, any PDF decompressor, or a PDF parsing subprocess. Direct PDF byte validation performs only a bounded static envelope/prohibited-name screening, then fails unavailable. That screening is explicitly not proof of PDF validity or safe decoded resource use. No PDF is admitted, including ordinary passive PDFs. No content is silently rewritten.


Every upload snapshots the caller's bytes, checks the exact SHA-256, validates the original supported content, reserves one immutable owner/key/body, writes with put-if-absent, reads bytes back and only then asks the trusted backend to mark the receipt verified. Storage or acknowledgement failure is an uncertain outcome, not a successful upload. Exact-key recovery verifies an existing private object and can finish the observation; confirmed missing reserved objects remain pending. The same upload key always recovers the original staged receipt, even after linkage.

After all selected receipts are verified, final save rereads their actual immutable bytes. One database transaction locks all selected rows in deterministic order, requires exact ownership and still-unlinked state, enforces five files / 10 MiB each / 25 MiB combined, creates the real project at revision 1, links every selected file, and stores the immutable request receipt. A failed final insert rolls everything back. A changed request body conflicts; unchanged replay returns the original receipt even after later project revisions. Input order, source receipt/version/hash, full frozen context and its canonical JSON hash are retained. Staging never creates a placeholder project and never uses `IdentityAssetStore` as a fake parent.

There is no background orphan deletion. Local failures retain valid staged files for the exact-request retry. A future retention/cleanup policy needs its own scoped implementation; linked files cannot be deleted by this package.

## Local verification

- `npx vitest run tests/server/home-attachments tests/database/home-attachments.test.ts --maxWorkers=1`
- `npx eslint src/server/home-attachments tests/server/home-attachments tests/database/home-attachments.test.ts`
- Scoped TypeScript check including the owned source/tests and their transitive imports.

Tests include real PGlite RLS and private-principal boundaries, hostile default ACL scrubbing with unaffected overload/default controls, immutable metadata/receipts, exact replay, stale-link CAS, rollback after final receipt failure, exact aggregate ceiling, actual text/image decoding, fail-closed PDF capability and stored-proof paths, prohibited PDF-name screening inside a valid final-EOF envelope, corrupt object detection, uncertainty recovery, and an end-to-end service/storage-fixture/SQL-adapter flow. They do not establish live Supabase/storage activation or true multi-connection PostgreSQL concurrency. No production build, browser acceptance or hosted migration was run by this package.
