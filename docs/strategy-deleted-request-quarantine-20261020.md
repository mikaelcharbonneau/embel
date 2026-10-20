# Deleted-project Strategy request quarantine

## Approved scope

On 2026-10-20 the user approved changing the rule so cancellation-requested jobs
in deleted projects no longer block research in other projects. Their unresolved
records and reserved costs must remain intact, the original job must not retry,
and normal account limits and safety checks remain in place. This is an
admission-policy change, not a provider outcome or billing adjudication.

## Verified cause

A prior hosted audience request lost its worker lease with one durable
`in_flight` step. It has no saved output or provider response identifier. The
project's deletion intent and job's cancellation request are both recorded, but
the job remains `needs_reconciliation` and its reservation remains active.
Neither the saved evidence nor the existing incident-specific reconciliation
helpers establish that the provider call did not run, completed, or was billed.

Project-scoped Strategy availability was correctly receiving the new project ID.
The previous isolation repair intentionally retained account-wide Strategy
uncertainty. An authentic admitted request also activates the rollout-wide
allowance pause, policy checks and same-operation runtime scan. Merely changing
the conversation notice or active-job counter cannot fix this incident.

## Bounded correction

The additive migration introduces one read-only quarantine predicate. It applies
only when the target already has existing operator-granted Strategy testing
authority and is an active owned project different from the original project.
The original request must retain all of the following:

- Current project deletion intent and an explicit cancellation request.
- API Strategy operation, `needs_reconciliation`, and no lease token or expiry,
  including an expired but retained lease.
- Original immutable testing admission, allowance admission and matching
  dispatch ownership.
- An active reservation exactly matching the original admitted amount and
  recorded cost/capture, with the complete remaining hold represented in the
  account's balanced reservation ledger.

The predicate never claims resolution, changes a job state, releases a hold,
creates an allowance or authorizes retrying the original request. Restore
removes the exception immediately for subsequent authorization checks.

Scoped allowance and policy helpers preserve the original rollout-wide scan,
including other owners' uncertain admissions and confirmed overruns. The raw
global allowance-pause and policy functions remain byte-for-byte unchanged.
Owner-wide actual and observed overruns, same-project uncertainty, active or
leased requests, disabled grants and ordinary/null-project behavior remain
blocking. All existing operation policies, account ceilings and permissions
are preserved.

Availability and admission use their authenticated owned target. Descriptors
require an immutable testing marker, and runtime scope is derived only from the
existing exact restricted-worker gateway. Current session-role, deployment and
policy checks remain mandatory. The same predicate covers the same-operation
runtime scan, so progressing from competitors to audience is not a separate
bypass. Claim, step begin and final dispatch independently recheck authority.

Worker readiness retains its original branch and adds a non-authorizing
capability witness for an exact restricted worker/policy/deployment, current
testing owner and active owned target with a qualifying quarantined request.
It does not use the active-request count, admit a job, grant authority, or make
raw runtime checks without a gateway succeed.

## Verification boundary

The migration pins ten predecessor bodies/security descriptors, modifies eight
existing bodies, adds six private non-definer helpers and preserves existing
function identities and grants. Its disposable PostgreSQL tests use real
authenticated admission, restricted-worker claim/step gateways and owner
deletion/Restore RPCs around an explicitly synthetic lost-lease outcome. They
cover full new-request settlement, retained-history digests, raw-global behavior,
role/deployment/tenant isolation, revoked authority, malformed evidence,
overruns and Restore at each execution boundary.

The dedicated regression suite passed all 52 cases. Seven additional database
and worker-readiness suites passed 111 cases; the optional 18-case native
multi-connection PostgreSQL suite was skipped because its disposable loopback
database was not configured. Whole-migration replay and the new test file's
ESLint check also passed. Independent release review and whole-project checks
remain separate from those focused results.

These are synthetic-provider tests, not proof of a live provider response.
Production installation and read-only scoped availability/history verification
are separate release checks. No original request is retried by this change.

## Production verification

Applied the independently reviewed migration on 2026-10-20. All 16 resulting function source fingerprints and security attributes match the disposable replay; all six new helpers have owner-only EXECUTE. The latest active project returned `unavailable/request_unresolved` before and `available` for all four Strategy operations after, under the actual authenticated-role permissions. The old job, steps, reservation, allowance admission, testing admission and dispatch digests were identical before and after; the unresolved job and its USD 0.12288 active reservation remain intact. No provider request or old-job retry was initiated by verification.
