> Archived November 10, 2026: describes the system before the generation engine.

# Disabled vector-proposal backend integration candidate

Historical component/integration documentation. See the [current checkpoint verification status](verification-status.md); machine-specific execution evidence is intentionally retained outside this source snapshot.

2026-10-08. Isolated local composition over the verified v22 source. No main tree,
repository-upload candidate, frontend/design work, hosted migration, credential,
provider spending, publication or deployment is changed by this integration.

## Source composition and ownership

The accepted cumulative Task 2 source includes the exact Task 1/shared-contract
and Task 4 provider dependencies. The tests-only reload supplement is included.
Task 3 adds authenticated materialization; Task 6 adds the optional existing-host
lane. Their deltas are disjoint, and no semantic merge or accepted production
source change was needed. One obsolete Task 2 schema test was explicitly
superseded after approval: the now-integrated optional sixth status accepts a
bounded available hint, while absence, unavailable history and all shape/expiry
fences remain covered. Its predecessor and new hash are recorded separately. Existing manual controls remain intact. Task 5 UI is
not implemented here, so this is not a user-facing feature-completion claim.

Exact ownership, predecessor manifests, file SHA-256 and archive identities are
in `docs/evidence/logo-vector-feature-integration/input-inventory.json`. The
original v22 file manifest is alongside it. New integration ownership is limited
to the dedicated two test/fixture files, the explicitly approved schema-test
override, documentation and verification evidence. The override is bound to its
exact predecessor and successor in `integration-overrides.json` alongside the
input inventory.

## Authentic local qualification

The complete successful chain uses the real authenticated `createLogoServices`
composition to import the pinned Geist catalog font and verify the actual owned
canonical document, SVG, raster and font bytes before producing a trusted quote.
The real owner RPC admits the quote once. The checked production host uses its
normal pool identity checks, one production startup/runtime, real JobStore,
reviewed typed provider, actual OpenAI Responses HTTP adapter and restricted SQL
observation/staging/completion ports. Only the HTTP fetch replies are synthetic,
including the token-count response; no external network or credential is used.

The retained owner-scoped proposal is applied through the same production web
composition. Real licensed font verification and HarfBuzz shaping prepare its
spacing edit. The trusted transaction commits one immutable candidate and exact
proposal association; the owned detail reader revalidates the stored candidate
bytes. The exact decomposed brand spelling and locked symbol are preserved, the
working refinements head advances, and the approved-logo selection stays as it
was. Replaying the original body/key causes no byte reads, shaping, write or bill.

A deliberately lost actual COMMIT acknowledgement is recovered with the same
original request, without a second candidate or provider call. A separately lost
paid-observation acknowledgement retains the exact known expense and bounded
output as reconciliation-only evidence, without automatically retrying inference
or making that proposal applicable.

The fast cancellation race is preserved rather than hidden: cancellation may
arrive after the runner's heartbeat and before its next one. SQL rejects the
attempted successful finish with `cancel_requested`, so the runner returns
`lease_lost`, with the paid response safely retained and charged exactly once.
The fixture advances only the disposable lease expiry; the next real runtime tick
then settles the cancellation. It does not claim immediate cooperative abort or
universal provider/network cessation. The cancelled result cannot be materialized.

## Explicit fixture boundaries

All tests are synthetic local qualification. The starting vector/raster lineage
is a seeded historical input with real canonical/SVG/raster bytes; no proposal,
prepared result, output candidate or materialization association is seeded. Font
import and every operation under test execute production code. Authentication is
an explicit fixture owner; PGlite's single session uses a serialized role-switch
adapter and real restricted session_user/role OIDs. Private object storage is an
immutable byte-map adapter. These do not establish hosted Storage/RLS, production
pooler concurrency, actual login, model access/output quality, live rates/billing
or process supervision.

## Unapplied forward SQL packaging gate

Supabase CLI is absent both from PATH and the existing dependency installation.
No CLI was installed and no migration timestamp/history entry was invented. The
exact seven reviewed candidates remain separate, unapplied and unchanged, in
this predecessor order:

1. `logo-vector-proposals.sql`
2. `logo-vector-proposal-quotes.sql`
3. `logo-vector-proposal-admission.sql`
4. `logo-vector-proposal-observations.sql` (accepted v2)
5. `logo-vector-proposal-completion.sql`
6. `logo-vector-proposal-materialization.sql`
7. `logo-vector-proposal-capabilities.sql`

The ordered archive and SHA-256 manifest retain the original files, including
all guarded predecessors and transaction boundaries. Existing historical
migrations remain untouched. Local combined installation qualifies the chain;
it is not a hosted migration. When separately authorized and available, use the
repository's documented `supabase migration new` workflow and reconcile its
recorded source-to-hosted history mapping before considering any hosted push.
See `backend-foundation.md`, `supabase-integration.md` and
`workspace-conflict-hotfix.md`. This bundle grants no worker/login capability,
enables no live policy and supplies no credential.

## Verification status

Exact commands, exit statuses, initial fixture failures, final focused results
and later whole-project checks are retained in the adjacent evidence directory.
The first authentic-chain run passed three of four cases; the cancellation case
incorrectly expected immediate `cancelled` despite the existing between-heartbeat
race. A diagnostic run established the exact persisted state and rejected SQL;
the final assertion verifies conservative lease recovery rather than weakening
production behavior. Two test-only TypeScript unknown-value accesses were
corrected to shape assertions. No production regression-fix claim is made.
