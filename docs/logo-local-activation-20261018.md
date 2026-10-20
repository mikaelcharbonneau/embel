# Local logo concepts: setup and verification

Setup checkpoint on 2026-10-18: the restricted database and Storage identities were created, all four matching concept capabilities were enabled, and the dedicated worker reported readiness. Live Auth and `logo_storage_session()` checks passed without image inference during setup validation. Later live generation is recorded below; this history does not grant new provisioning, credential retention, key use or activation permission.

### Installed checkpoint

The connected Supabase migration API installed the worker Storage, generative Storage, concept permissions, local execution and restricted principal migrations. The principal is `fluid_logo_worker`, OID `25288`, with a dedicated SCRAM password, no inheritance, superuser, RLS bypass or outgoing memberships, and exactly 14 direct worker function grants. A temporary administrator-only password installation RPC was removed after use.

The separate confirmed Auth identity is `853fa383-9606-4577-924f-966194dc2f67`, created through the normal Auth Admin API without sending an invitation. Worker `embel-logo-local-20261018` is bound to this identity and the verified owner of project `e849c14f-06b6-46a3-8e3a-bdb7693345dd`. Only concept generation is enabled in the four matching policy/binding rows. The setup policy recorded `gpt-image-2.5-sunburst-2026-09-08`.

The ignored `.local-fluid/logo-worker.json` and `.local-fluid/logo-storage-identity.json` are owner-only 0600 files inside a 0700 directory. The web process receives no worker or Storage credentials. Existing administrator credentials were used only transiently for provisioning and were removed from temporary storage. A portion of the existing administrator key appeared in a tool result during dashboard inspection; the user was informed and rotation is required. Restricted runtime identities do not depend on that key.

Local web flags were enabled and Next acknowledged reloading `.env.local`; the existing preview was preserved. The actual restricted database connection passed `--check`. Live Storage Auth and the exact owner/user/session/role/OID/worker binding passed, and an owner-scoped capabilities query reported concepts available. These checks do not establish successful image generation.

## Initial missing setup (historical)

Read-only inspection of the existing `fluid-platform-dev` project
(`fricsfwqibyhemknqgyf`) on 2026-10-18 confirmed the core logo workspace, quote,
six-slot admission, claim and readiness SQL is installed. There are no logo
database roles, worker principal bindings, runtime policies, storage identities
or logo storage policies. `authorize_logo_generative_storage` is absent.

The existing local prototype account also has historical reservations exceeding
its legacy allowance. Those records must remain intact. The local concepts
candidate removes the aggregate allowance gate only for newly admitted, privately
marked local concept jobs. It retains exact per-call policy/reservation matching,
actual usage accounting, unknown-outcome protection for the same project,
cancellation, leases, idempotency and immutable output. No allowance is reset or
increased. The runtime exception is not permission for new spending.

## Provisioning boundaries

The installed design separates the restricted `fluid_logo_worker` database login
from the non-anonymous background Storage Auth identity and binds both to the
verified project owner. Privileged provisioning is separate from runtime access.
Storage identities use normal Auth administration, not forged Auth rows or an
owner JWT. Administrator credentials must remain transient and must never enter
the web or worker configuration. Database passwords belong in native psql hidden
prompts, not chat, command arguments or SQL tool text.

## Historical database sequence

The sequence below documents source dependencies and restricted bindings. It is
not a request to recreate identities, retain credentials, enable operations or
reapply installed migrations. Any new setup requires current authorization and
target read-back. The launcher does not apply these files automatically.

1. `supabase/candidates/logo_worker_storage.sql`: the existing disabled Storage
   identity/session broker and restrictive object policies.
2. `supabase/candidates/logo_generative_storage.sql`: exact frozen-reference and
   output-reservation authorization for image jobs.
3. `supabase/activation/logo_concepts_20_storage.sql`: minimal generative Storage
   grants/policies, with no vector, export or directions activation. It rejects a
   different previously installed production Storage policy set.
4. `supabase/candidates/logo_local_concepts.sql`: disabled local owner capability,
   private transaction witness, immutable future-job markers, one authenticated
   local RPC and exact predecessor-checked allowance changes.
5. Set the non-secret `embel.logo_owner_id` and `embel.logo_project_id` connection
   settings from the verified signed-in project, then execute
   `supabase/activation/logo_concepts_10_principals.sql`. It derives ownership from
   the saved project, refuses collisions, creates the passwordless restricted
   login and emits only role metadata for its configuration binding.
6. Set its password with native psql `\password fluid_logo_worker`. The existing
   project administrator password is entered only in psql's hidden connection
   prompt and is not changed or saved.
7. Create the dedicated Storage Auth identity through the normal Auth management
   action, then sign it in through Supabase Auth to obtain its own verified
   session. It must differ from the brand owner. Do not use a service-role token
   or the owner's browser session as worker credentials.
8. Supply the reviewed non-secret owner, Storage user ID, worker ID, exact image
   policy identity and internal per-call accounting reservation as documented at
   the top of `logo_concepts_30_bind_disabled.sql`. Execute that file. All four
   records start disabled; it changes no allowance and creates no job.

The worker has CONNECT, schema USAGE and exactly 14 direct EXECUTE grants:
`logo_worker_owner`, `report_logo_worker_ready`, `claim_logo_job`,
`heartbeat_logo_job`, `register_logo_job_plan`, `begin_logo_job_step`,
`complete_logo_job_step`, `finish_logo_job`, `expire_logo_job_leases`,
`read_leased_logo_record`, `record_logo_provider_response`, `prepare_logo_asset`,
`read_logo_asset_publication`, and `observe_logo_asset`. The source file specifies
every exact schema and signature. There are no direct table grants, memberships,
generic Strategy/Naming grants, web role, vector or export grants.

## Local configuration and startup

The protected-file schema in `worker/logo-dedicated-config.ts` describes an
owner-only 0600 regular file inside a 0700 directory. The recorded local path was
`/Users/mikael/embel/.local-fluid/logo-worker.json`. The binding includes the exact
restricted role OID, verified owner and dedicated database credential; Storage
uses its separate Auth user. The initial configuration contained only
`operations.concepts`. Its model, handler, price version and policy must match
the corresponding SQL policy. No refresh token or credential is sent to the web
process, and this schema description does not authorize reading or reusing a key.

Run this non-dispatch check from the repository:

```sh
node --conditions=react-server --import tsx scripts/logo-worker.mjs --check --config /Users/mikael/embel/.local-fluid/logo-worker.json --storage-identity /Users/mikael/embel/.local-fluid/logo-storage-identity.json
```

`logo_worker_qualified` means the actual database principal and configured
runtime composition passed and resources drained. It does **not** prove live
Storage Auth, enabled operation policy, image-model access or successful image
generation. The check never calls the host run loop, advertises readiness,
claims a job or dispatches an image. It can therefore run before policy enablement.

After native database authentication and the protected configuration are verified,
enable only the matching rows in `logo_runtime_policies`,
`logo_storage_principals`, `logo_generative_storage_capabilities` and
`logo_local_capabilities`. Verify the dedicated Storage session with Auth
`GET /auth/v1/user` and the authenticated `logo_storage_session()` RPC, comparing
the owner, Auth user, current session, role name/OID and worker ID exactly.
These checks make no image request and create no asset grant.

Set `FLUID_LOCAL_LOGO_ENABLED=true` and `FLUID_RUNTIME=local` in the local web
process only. The routing accepts exactly development at `127.0.0.1:3105` or
production at `127.0.0.1:3106`, and rejects hosted runtime markers. Next acknowledged the local environment reload without restarting the preview.
Start the same dedicated worker command without `--check`. Its existing run loop
reports fresh readiness, claims bounded durable jobs and checks live Storage
authorization against each exact lease before dispatch. The explicit `--storage-identity` option signs in using the protected restricted identity and renews the same Auth session with standard refresh-token rotation before expiry. Refresh tokens remain in process memory. Neither protected file is rewritten, no password fallback occurs during renewal, and mismatched user/session claims fail closed.

## Acceptance and stopping

Check that the signed-in project reports the exact concept capability, create one
six-slot request through the UI, observe six real persisted results (or explicit
partial/error states), reload and verify that the same saved outputs remain.
Inspect actual provider and accounting receipts separately. No synthetic artwork
counts as live acceptance.

To disable, stop the dedicated worker, set all four matching enabled fields to
false, and revoke its dedicated Auth session. Retain the principal rows and all
job/asset/accounting history. In particular, do not delete
`logo_storage_principals`: its presence keeps the identity in the restrictive
Storage-policy class after disablement.

The disposable rehearsal checks exact grants, forbidden table/export access,
cross-owner denial, six independent jobs, idempotent replay, local routing with
an exhausted legacy allowance, unchanged accounting, private marker protection,
same-owner wrong-principal/worker denial and same-project unknown-outcome stops.
Worker lifecycle tests separately verify check-mode drain and failure handling.
These are local synthetic checks, not live provider acceptance.

## Final independent audit

At approximately 21:05 UTC the independent read-only audit confirmed all four exact enabled bindings, fresh readiness, the absent temporary setup RPC, and unchanged least-privilege grants. All nine saved-project/Inspiration/Naming preservation hashes and historical usage-account totals remained unchanged. There were zero logo jobs, provider receipts, generated assets or Storage grants. Local synthetic activation, launcher, renewal and runtime tests passed (36 tests); TypeScript passed. This is activation evidence, not live image-generation acceptance.

The renewal-enabled `--check` subsequently passed live Auth, exact Storage-session binding and restricted database qualification. The previous idle worker acknowledged stop and drain; the replacement reported `logo_worker_running` with the explicit protected Storage identity option. Renewal/config/launcher/broker coverage passed 105 tests, ESLint and TypeScript. The standard refresh branch is simulated in tests; no hour-long live expiry wait or paid image inference was performed.

## Generation repair (2026-10-18)

The first user-path batch was admitted but all six jobs failed before provider dispatch (`not_dispatched`, no provider receipts). The per-job Storage broker rejected Supabase gzip responses because Fetch returns decoded bytes with original wire headers. The broker now accepts standard decoded compression, bounds decoded bytes and compares content length only for identity responses. 101 broker/renewal/asset/handler/adapter tests, ESLint and TypeScript passed. Original failed attempts are retained.

Client polling also cleared valid readiness every ten seconds, flashing unavailable and interrupting preparation/confirmation. Refresh now preserves the existing deadline until the response arrives; failure or original expiry still disables the operation. Confirmation progress no longer reports generation unavailable while admission is busy. Targeted client tests passed.

The first retry cleared Storage preflight and reached the image provider for all six concepts. Each was rejected by the exact monochrome validator; six recorded provider receipts total 90,605 micro-USD. No images from those attempts were published. Concept-only deterministic grayscale processing passed 89 targeted and shared-process regression tests, ESLint and TypeScript before a further normal UI retry; strict publication validation and immutable failed attempts remain intact. Retry display refresh now follows the new request identity even when the batch ID stays unchanged; desktop and mobile regressions passed.

The next retry produced a strictly grayscale PNG and uploaded it, then readback failed: Supabase's authenticated download performs `object.get_authenticated_info`, which the restricted policy had excluded. That one job recorded `publication_unknown` after charging 15,100 micro-USD; the exact reserved object remains stored and its publication is uncommitted. Five sibling jobs remain queued behind uncertainty protection. The policy repair and an audited, accounting-preserving terminal publication adjudication are in progress; do not replay or overwrite the ambiguous step, claim generation success or charge the same receipt again.

## Completed live acceptance

The restricted metadata-download policy repair passed its ownership/session/expiry checks. Migration `logo_concepts_50_publication_adjudication` installed the private, exact-incident witness and one operator adjudication was inserted after independent review and 16 disposable database tests. The ambiguous step, original provider receipt, reserved object and uncommitted publication remain unchanged. Only its mutable job outcome was adjudicated `publication_not_committed`; 15,100 micro-USD remains recorded and only the unused 1,984,900 reservation was released. No new worker grant was added. The independent post-apply audit confirmed all nine project/Inspiration/Naming hashes unchanged.

Five queued concepts then generated, published and displayed successfully (75,505 micro-USD); a normal new retry generated the remaining slot (15,100 micro-USD). All six cards reached Ready with actual image previews. The live batch API leaves `acceptedPreview` null; the display now derives only succeeded, recorded-billing, committed previews from retained attempts. No success, image or billing is fabricated. The retry display was verified on desktop/mobile, and its new request identity restarts polling for the same batch.

A full page reload independently reloaded all six committed image previews and displayed “6 of 6 concepts ready.” Screenshot proof: `/private/tmp/embel-six-logo-concepts-20261018.png`. Final frontend checks: 50 client tests, two dedicated headless desktop/mobile retry regressions, ESLint and TypeScript passed. The dedicated worker remains running with protected identity renewal.

Final read-only aggregate: six verified committed results with exact owner/project/hash/Storage bindings, zero active/queued/uncertain logo jobs and zero active logo reservations. Across all 25 retained logo attempts, 19 provider receipts total 286,915 micro-USD ($0.286915): six successful outputs cost 90,605; twelve historical chromatic failures cost 181,210; the one uncommitted publication cost 15,100; six pre-dispatch failures cost zero. A separate six-job chromatic batch at 21:24:50 is included, avoiding an understated total. Unrelated active Naming work is unchanged.
