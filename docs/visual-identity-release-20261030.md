# Visual identity release — October 30, 2026

## Latest published follow-up

[PR #174](https://github.com/mikaelcharbonneau/embel/pull/174) publishes web source
`0399516ac9a0ba9711670b69d36b2dfe0eaed7d5` in deployment
`dpl_7cwK2zzHcGakACamMXng5MErtc1g`. Public health reports that source and reachable
Auth, database and Storage. The compatible shared worker remains on `47e9ef7`.

After the previous availability repair, choosing a board reached the save but
failed. The actual 17:28:03 UTC database log reports SQLSTATE `42501`, permission
denied for `prepare_identity_transaction` from `prepare_shared_identity_request`.
Both private writers lacked EXECUTE for their public wrappers' owner, `postgres`.
That role is not a superuser on hosted Supabase. The failed request persisted no
selection; the original three generated boards remained intact.

Applied `shared_identity_http_writer_permissions`, source
`supabase/candidates/shared_identity_http_writer_permissions.sql`, SHA-256
`03b7cf1a757b21b5116f9ebcceac370df78f61c7466dde467f732400c238a618`.
The guarded correction adds exactly two nongrantable EXECUTEs to `postgres`,
leaves function bodies and role memberships unchanged, and grants no direct
writer access to web logins, anon, authenticated or service_role. Hosted catalog
readback confirms these properties. Security advisory counts are unchanged.
The web now requires those explicit grants before advertising saving available.

Verification: 43 focused database tests; 16 native PostgreSQL installation tests;
131 native PostgreSQL 17 checks, including 14 new Identity checks. The new native
test reproduces the exact denied call, applies the correction, and uses the real
shared HTTP runtime through prepare/commit/finish to persist one owned choice and
mark its board asset used. It also verifies account isolation and unchanged role
membership. Auth sessions and completed-board metadata are synthetic; this is
not an authenticated hosted-owner test. Integrated typecheck, lint (zero errors,
one existing warning), production build and native-script lint/syntax checks pass.

PGlite's superuser `postgres` masked the absent nested permission in the earlier
tests. The earlier native test covered Home saves but not Identity selection.
Both gaps now have regression coverage. Worker authority manifest SHA-256 remains
`9212afb1aedbc3fbf009c18175890a969928ba2f2505087dfe5188765d8bf049`; no worker rollout,
AI calls, regeneration or customer-choice writes were performed by the workspace.

For a web rollback, `dpl_CK7Ewz9sAHa5qqKJ6HkqnakKV67J` remains compatible with the
corrected database permissions. Keep the permission repair; revoking it would
restore the save failure. Signed-in saved selection and final download remain
the owner's next acceptance check.

## Selection availability follow-up

[PR #172](https://github.com/mikaelcharbonneau/embel/pull/172) publishes web source
`8e7ed90fc876e76e794084412e4eb6248d4e3325` in deployment
`dpl_CK7Ewz9sAHa5qqKJ6HkqnakKV67J`. Public health reports the exact source and
reachable core services. The shared worker remains on the compatible `47e9ef7`
deployment below. No schema, worker configuration or provider policy changed.

Three boards generated successfully, but the web save check still expected the
older Identity transaction writers. That kept every Choose direction button
disabled and the UI incorrectly called the unavailable state "Checking…".
The two expected hashes now match the reviewed packet-15 writers. Reads have a
30-second timeout; unavailable or uncertain choices expose a read-only recovery
action. Existing boards, ownership checks and selection freshness checks remain.

39 database tests and 75 client tests pass. The database selection regression now
passes through the actual web qualification gate. Four production-build browser
checks pass on desktop/mobile: save recovery without regeneration and the full
selection/16-file package journey. Integrated typecheck, lint (zero errors, one
existing warning), build and independent review pass. All 22 expected helper
hashes match the hosted catalog. Browser auth/provider fixtures are synthetic;
the hosted HTTP principal and owner's final selection/download remain unverified.

The user's actual Northline batch `362fe642-da70-487a-9b8f-04ff045cd617` succeeded
with three distinct committed boards, valid publication/source-logo evidence,
six settled provider receipts and 170,487 micro-USD (US$0.170487) recorded usage.
Read-only checks confirmed these outputs remain saved and current. This repair
made no AI calls and did not regenerate or rewrite the batch.

Rollback, if needed, can promote the previous web deployment
`dpl_5nqJSeVJscBgEojgn8jgXhef4kzW`; it retains boards but restores the selection
bug. The compatible worker and database do not need a rollback for this web fix.

## Generation preflight follow-up

[PR #170](https://github.com/mikaelcharbonneau/embel/pull/170) publishes web and
shared worker source `47e9ef78942a7998b27715988fc60f63fbf503c7`. It fixes the
provider preflight failures discovered during the owner's first live direction
requests. Web deployment: `dpl_5nqJSeVJscBgEojgn8jgXhef4kzW`. Worker deployment:
`dpl_C1fd6MAvpd1eVu52TBTwtMzukbPT`, with one ready production daemon and all three
lanes leased. Public health reports the exact source and reachable core services.
No database schema or provider policies changed. Naming binding revision is 9.

149 focused tests, typecheck, lint, production build, packaged native checks and
independent review passed. A real isolated specification call succeeded with
26,956 micro-USD recorded usage; it is not a completed customer board. Three
failed Northline sets contain no provider calls and zero recorded cost. The
owner's subsequent full set succeeded as recorded above. See
[the repair record](identity-generation-preflight-20261030.md).

## Project-entry follow-up

[PR #168](https://github.com/mikaelcharbonneau/embel/pull/168) published web source
`5b6e0b3d81b7c07fc4cf45ea1ae732e1bdda319f` in deployment
`dpl_9S7YcRdhmgcGV4JeCV6gdmHWYoME`. Public health confirms that source and reachable
Auth, database and Storage. At that release, the shared worker remained on the
compatible `00672941` release below; its authority proof and running instance
were unchanged.

Generic project links now resume saved Logo work, including after expanding the
project to a complete brand. Explicit Strategy links, pending edits and recovery
remain available. Generation Activity links open their corresponding workspace.

The compatible `logo_brief_context_freshness` migration was applied once. It keeps
an existing logo current when the original and current owned project contexts
match exactly. Missing or changed context remains stale. No project or output
records were rewritten. Hosted readback confirmed the new helper SHA-256
`a7048b7df7505df2938c03823200a971254dbdedadfb9c2bc34d25376f6cef79`.
See [migration details](logo-brief-context-freshness.md).

Northline had expanded to revision 2 with identical context. After this fix, its
original selected concept is current again and its stale-stage list is empty.
Its project revision and original logo asset/selection records are unchanged.

Follow-up verification: 100 focused integration tests, typecheck, lint and both
the production build and a build from the actual 1,188-file upload payload pass.
Native PostgreSQL installation and 53 SQL regression checks pass; the worker
manifest remains byte-identical. Independent source review is clear. Production
browser acceptance exercised 34 desktop/mobile cases: 32 passed initially; an
obsolete Saved-status selector was corrected and both affected cases passed.
The actual 16-file PNG/ZIP download journey passed on both sizes. These are local
fixtures, not signed-in live provider acceptance. The owner has been asked to
refresh Northline and generate its three directions.

## Published behavior

The main journey is saved logo concept → three generated raster brand boards →
chosen direction → final brand board and downloadable assets. PNG downloads are
available along the way. Vector editing and genuine saved SVG downloads remain
optional. The old component-mixing directions screen and obsolete output page
are retired; 50 obsolete source/test files were removed in this change.

A final package contains the original logo, chosen direction image, final board,
palette files, font links, profile image, square/portrait post templates and two
banner formats. The package has 16 files without an optional verified SVG logo.
Editable social SVGs embed the original raster; they are not presented as vector
logos. Bundled fonts support only their verified glyph coverage.

## Original three-board release

- Integration: [PR #166](https://github.com/mikaelcharbonneau/embel/pull/166).
- Runtime source: `00672941f41c18180e9a78a05d876cfd13910490`.
- Web: `dpl_D9L8TQaKY29YJwNUh4SUdCudY8AA`, promoted to `www.embel.xyz`.
- Shared worker: `dpl_E41ky7yNQBwbVNCHgtTLm3TSaJEq`, one production daemon.
- Worker artifact SHA-256: `6789cc4e288a67cb35e2c03e265783f633b990491e665fed14e45290196a85ad`.
- Supabase packet 15: `shared_identity_selected_logo_boards`, SHA-256
  `45ec832fda4d5ed44f5c18ee270b73ce8def68553cb610880e7498076173495b`.
- Authority roster: 15 packets, 291 functions, 269 worker functions.
- Naming owner binding advanced from revision 7 to 8 after worker readiness.
  Service/provider-policy identities did not change.

The actual Vercel upload list contained 1,187 files. Its separately reconstructed
payload built successfully. The stopped worker package passed native checks on
Node 22.22.2/Linux x64, including shaping, raster/vector processing, PDF and archive
checks. The production configuration was read back and matched the prepared
source/artifact values exactly.

## Verification

- 2,224 relevant automated tests passed across 195 files.
- The worker retry change passed 45 focused tests across 6 files.
- Typecheck and production builds passed. Lint has zero errors and one existing
  unused-variable warning in `tests/worker/naming-worker-authority.test.ts`.
- Final desktop/mobile browser run: 76/78 passed initially. Two synchronization
  failures passed all 12 focused rechecks. The initial failures are retained in
  local evidence; they are not reported as a clean first run.
- Both complete browser journeys generated and downloaded the real 16-file ZIP.
  Tests verified PNG dimensions, exact original-logo and direction bytes, selected
  colors, font links and editable social SVG content. Screenshots were inspected.
- Native PostgreSQL 17 installer checks covered the new schema/ACLs, admission,
  publication, selection, retained partial results and historical compatibility.
  Local provider and authentication fixtures are synthetic.
- After publication, the public health endpoint reported this exact source and
  reachable Auth/database/Storage. All three worker leases renewed under the new
  deployment, with one idle database connection per lane and one physical daemon.

## Incident handled during release

The existing live release lost database/API/Auth responsiveness before the new
source was published. Shared workers were paused to remove reconnection pressure.
SQL access recovered, but Auth and PostgREST still exceeded 15-second timeouts;
Storage and the API gateway responded normally. The initiating cause is unproved.

The user restarted the Supabase project through its dashboard. PostgreSQL
restarted at 2026-10-30 14:01:38 UTC (10:01:38 EDT), and public core readiness recovered.
No database reset, restore, role-password change or paid-plan change was performed.

The new worker independently backs off failed qualification/lease attempts with
jitter, capped at 30 seconds, and emits fixed, sanitized diagnostic codes. Healthy
polling and renewals keep their existing timing. This addresses confirmed retry
amplification; it does not establish the initiating outage's cause.

## Live acceptance and recovery

The owner generated three real boards in Northline using their normal account.
Persisted outputs, publication evidence and recorded usage are verified above.
The workspace has no owner browser session, so it did not impersonate one or
bypass admission. Saved selection and final download from that session remain
the next acceptance check.
The original `00672941` release initiated no provider generation from the workspace;
the later isolated specification verification is recorded in the follow-up above.

Northline: `b0c19fc2-d24b-4b79-8082-40d79fb1ffaa`.
The next check is saved selection and final download from the owner's browser.
Local checks do not establish model
quality or service capacity for thousands of simultaneous users.

Packet 15 is forward-only. Do not restart the prior `a0e1e16` worker against it.
For recovery, stop the current daemon before incompatible database/worker edits;
use a forward fix or package compatible source with the current authority proof.
Existing request identities, receipts and completed outputs must be retained when
recovering a failed request.
