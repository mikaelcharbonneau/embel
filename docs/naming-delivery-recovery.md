# Naming saved-result recovery

The Naming shared lane now examines one pending execution per cursor step. An
unresolved request therefore cannot keep later pending requests outside the
worker's recovery budget. Other shared lanes retain their existing page size.

For a brainstorm run whose original provider response was saved successfully,
`brainstorm_recover_delivery` can publish verified names into the ordinary owned
feed and source records. The existing known-response observer can first retrieve
the original response ID; neither observation nor delivery creates another paid
request. Replays use immutable call publications, so a lost acknowledgement
cannot insert the same result twice.

Delivery requires the original execution, owner, project, policy, saved request,
terminal response and candidate membership to agree. The project must remain
active, unpaused and on the same preferences, steering and strategy basis. Stop,
deletion, superseding a run, or account suspension prevents new delivery. Row
locks are bounded; a concurrent editor leaves the result available for a later
recovery pass. Already published partial results remain usable.

Delivery does **not** settle billing or close the job. The retained token counts
do not supply an immutable applicable rate, and a default zero job cost is not
proof of a free request. The job stays `needs_reconciliation`, its reservation
and original provider evidence remain unchanged, and the public summary reports
`held_unsettled` with a null confirmed cost. The optional
`activeRun.recoveredNameCount` identifies names delivered by this recovery path.
Those names can be selected and copied through existing owned APIs. A run with
no trustworthy completed response remains unresolved without another create.

## Release

1. Record the current web deployment, shared-worker deployment, enabled slot
   roster and authority manifest. Build the replacement web and shared-worker
   artifacts from the same reviewed revision. The web must accept the optional
   summary field before recovery starts publishing it.
2. Drain every shared lane and confirm no active slot lease or outstanding
   execution before changing the shared authority graph. Preserve historical
   reconciliation rows and their provider/billing evidence.
3. On the existing owner connection, apply
   `supabase/candidates/shared_naming_brainstorm_delivery_recovery.sql`. It is a
   forward transaction with exact source/owner/security/search-path guards. It
   supports the original brainstorm gateway and the exact event-capacity fix;
   production should retain its installed capacity fix. Do not modify or rerun
   historical packets to install this change.
4. Publish the web and the matching shared-worker artifact, then restore the
   recorded slot roster. The new worker's source-owned authority manifest must
   qualify before any provider dispatch. Confirm all enabled lanes become ready.
5. Check recovered feed/source rows and selectable names. Confirm unchanged
   provider call identities, no repeated creates, and truthful unresolved costs.
   A recovered job remaining `needs_reconciliation` is expected. Historical
   responses rejected by the ownership, context or completion checks stay held.

The forward packet SHA-256 is
`c1bee52bffdcc2ebd26680dfe6b553b00388e63168139ee8cd428efc36d34ab3`.
Its source and function digests are pinned in
`worker/shared-pool/authority-manifest.json`; the production preparation roster
includes it as the final post-install packet. Build output is local until an
operator explicitly deploys it.

## Rollback

Drain the new shared worker, then apply
`supabase/operator/rollback_naming_brainstorm_delivery_recovery.sql` through the
same owner connection. Its exact guards reject source drift before changing
anything. It restores the previous gateway and summary bodies, preserving the
event-capacity fix when installed. Then restore the recorded compatible worker
artifact and slot roster. The prior web may be restored after the summary loses
the optional field.

Rollback deliberately keeps delivered candidates, source/feed membership,
private delivery receipts, unknown costs and original provider events. The
remaining helper stays owner-only and has no shared-worker entry point. The old
worker's catalog verification ignores this unused helper. Never delete recovered
names or settle reservations to make rollback appear complete.

The forward installer intentionally rejects already-created recovery objects.
After rollback, roll forward with an explicitly reviewed restoration of the
guarded function bodies, rather than rerunning the fresh installer or deleting
the retained evidence table.

## Verification

The focused Vitest tests use actual restricted SQL in disposable PGlite with
inert provider ports. They cover fair traversal, immutable scope, response/model
mismatches, cancellation, deletion, changed preferences/steering, suspended
accounts, public source validation and selection, retained partial results,
full100 delivery, and committed acknowledgements lost in transit.

`node scripts/verify-naming-brainstorm-native.mjs` uses a cached PostgreSQL17
image with no network, ports or host mounts and an ordinary `postgres NOSUPER
CREATEROLE` installer. It additionally verifies hostile default ACL removal,
source guards, concurrent editor locks, replay, unchanged billing evidence and
the rollback packet. It makes no provider calls or live-service mutations.

Run the focused suite with `--maxWorkers=2 --reporter=verbose`, compile the native
authority manifest with
`node scripts/verify-shared-worker-native.mjs --compile-authority-only`, and run
`npm run build:shared-worker` after source/manifest changes. Local fixture success
does not establish production provider availability or reconcile unknown costs.
