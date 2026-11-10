> Archived November 10, 2026: describes the system before the generation engine.

# Selected-logo brand boards

The `identity.image` lane now creates three raster brand boards around the saved
selected logo. Each board has a complete color/type specification and explicit
application-design fields for the final asset renderer. The chosen logo is the
first private image supplied to the existing Images edit transport. Uploaded
inspiration is optional, with at most three supplementary images.

Standalone Logo projects use their actual saved logo brief. Their empty Strategy
context remains empty; generation does not invent a name, strategy, review or
approval. New admission availability is authoritative for this flow. The older
generic Identity readiness result still describes the historical Strategy flow.

## Contracts

- New intent/job version: `3`; input/basis version: `2` with `logoBrief` equal to
  the exact owned saved `sourceLogo.brief`.
- Availability includes `sourceLogo`, `expectedLogoRevision`, the four existing
  project/reference/preference/selection revisions, and nullable
  `estimatedCostMicrousd`. The estimate is the owner's last ten successful v3
  batches under the same provider policy; no observations means no estimate.
- Intent contains `sourceLogo: availability.sourceLogo.source` and the observed
  `expectedLogoRevision`. Admission freezes the full saved source, including the
  verified committed raster receipt, and rejects a changed selection head.
- Batch `usage` is `{ status, knownCostMicrousd }`. Actual owned call receipts
  supply the recorded amount; an issued call without known billing remains
  `unknown`. Active work with no missing evidence is `pending`.
- Batch and system-detail/selection reads expose `sourceLogoCurrent`. Matching
  uses the exact source, brief, type and preview, ignoring only the selection
  counter. Choosing A, then B, then the original A makes A's saved boards usable
  again without another generation request.
- `system.applicationDesign` stores the explicit layout, graphic treatment,
  palette roles and heading/body style keys. Keys must reference saved components;
  text/background contrast must be at least 4.5. New provider specifications use
  the verified bundled Geist, Geist Mono, Lora, Fraunces and Manrope font catalog.
  Historical systems can omit this rendering specification.

An independent database guard also rejects saving a board when its generated
source logo is no longer selected. This is checked inside the selection write,
including manual versions of a generated board; a client freshness label is not
the authorization boundary.

## Forward database packet and worker proof

Apply `supabase/candidates/shared_identity_selected_logo_boards.sql` once, after
the existing shared packets and raster recovery packet. Drain the old workers
before applying it. The packet's SHA-256 is:

`45ec832fda4d5ed44f5c18ee270b73ce8def68553cb610880e7498076173495b`

It adds one immutable private metadata table, owned source-read helpers and
selection guards; updates admission, leased source membership, input validation,
publication and selection projections; and widens the existing input version
constraint. It adds no columns to `public.jobs` or other existing tables, rewrites
no history, and preserves the shape of full-row hashes used by old jobs.

Queued shared Identity cancellation now skips legacy reservation settlement:
uncapped Identity jobs have no such reservation. Other operations keep their
existing cancellation path. Cancellation during an issued call preserves its
uncertainty and every earlier completed board.

New objects strip inherited/default ACL grants before allowing only the owned
authenticated source read and the existing isolated Identity writer capabilities.
The source installer temporarily obtains the existing writer role only while
replacing its two helpers, then removes that membership in the same transaction.

There are still ten service bindings and no provider-policy or handler-version
change (`identity-image-v1`). Rebuild the shared worker and qualify its new
source/authority proof before promotion. The checked-in roster has 15 packets,
291 functions and 269 worker functions. Native PG17 compilation produced
authority manifest SHA-256:

`9212afb1aedbc3fbf009c18175890a969928ba2f2505087dfe5188765d8bf049`

The build source list adds only the shared board design, font metadata and logo
source domain modules. No browser code or new provider transport enters the worker.

## Recovery and validation

The existing three sequential steps remain: one specification call and one image
call per board. Earlier completed boards survive later failures. Staged output
recovery reuses exact saved bytes and receipts; no recovery path repeats a paid
call. Historical v2 jobs/v1 inputs remain readable, and the exact v2 specification
request bytes remain unchanged so issued-call recovery can still match its hash.

Local tests cover real SQL admission/private Storage authorization, standalone
brief capture, all three publications, real shared selection transactions,
changed/restored source selection, hostile default ACLs, historical reads,
takeover recovery, unknown billing and partial results. Provider transports in
these tests are synthetic. The native installer check uses isolated PostgreSQL
17 with a NOSUPER CREATEROLE installer; it makes no hosted or provider calls.
