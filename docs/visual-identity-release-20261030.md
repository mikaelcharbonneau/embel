# Visual identity release — October 30, 2026

## Latest published follow-up

[PR #168](https://github.com/mikaelcharbonneau/embel/pull/168) published web source
`5b6e0b3d81b7c07fc4cf45ea1ae732e1bdda319f` in deployment
`dpl_9S7YcRdhmgcGV4JeCV6gdmHWYoME`. Public health confirms that source and reachable
Auth, database and Storage. The shared worker remains on the compatible
`00672941` release below; its authority proof and running instance were unchanged.

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

Authenticated end-to-end provider acceptance is still pending. The owner was asked
to generate three boards in the existing Northline test project. The workspace
has no owner browser session, so it did not impersonate one or bypass admission.
No new provider generation was initiated from the workspace for this release.

Northline: `b0c19fc2-d24b-4b79-8082-40d79fb1ffaa`.
The next check is the real three-board result, recorded usage, saved selection and
final download from the owner's browser. Local checks do not establish model
quality or service capacity for thousands of simultaneous users.

Packet 15 is forward-only. Do not restart the prior `a0e1e16` worker against it.
For recovery, stop the current daemon before incompatible database/worker edits;
use a forward fix or package compatible source with the current authority proof.
Existing request identities, receipts and completed outputs must be retained when
recovering a failed request.
