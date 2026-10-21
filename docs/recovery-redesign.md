# Recovery redesign

## Approved direction (21 October 2026)

Separate application failure, provider execution evidence and accounting. A local
failure is not evidence of an uncertain provider request. Recovery must preserve
ownership, immutable inputs/results, cancellation and genuine financial evidence.
Never restart a cancelled request or replay an unknown provider side effect.

## First implementation increment

- Progressive planning errors are rejected-before-dispatch outcomes for that
  unissued branch, not invented provider uncertainty. Already issued siblings
  drain and the database retains final authority over unsettled calls.
- Idempotent plan, artifact and microbatch persistence retries selected transient
  database errors, at most twice, with the exact identity/payload. Validation,
  permissions, unknown errors and cancellation do not trigger replay.
- Redacted phase/error diagnostics never serialize exception messages or prompts.
- An explicit Home submission can save the project, check its project-scoped
  eligibility, then persist the initial research turn at the next revision.
  Account-level pending requests no longer conclusively describe a new project.
  Unknown write acknowledgements do not bind automatic admission. Existing
  attempted receipts and idempotency keys remain fenced across remounts.
- Existing restricted Naming maintenance can close a specific unleased local
  failure only when there are no authorized calls, receipts, provider records,
  artifacts, prepared sets, observed overruns or recorded spend. It appends a
  corrected stage result and uses the existing database_no_dispatch settlement
  mechanism. Requested cancellation stays cancelled; no inference is restarted.
  The migration preserves the entrypoint's owner, security mode and ACLs and
  requires its exact audited predecessor.

## Remaining architectural increments

This increment does not turn foreground Strategy calls into retrievable provider
jobs, settle real unknown provider outcomes, replace all admission policies, or
simplify the Naming quality pipeline. Those require separate reviewed changes:

1. Persist provider handles as early as possible, with a durable observation
   schedule and a separate publication-retry state. Review the provider's current
   retention and cancellation semantics before changing the request contract.
2. Centralize account-wide versus project-local admission reasons, keeping real
   reserved exposure and hard account limits authoritative.
3. Treat browser disconnects solely as observer lifecycle events. Regression-test
   tab return, worker restarts, duplicates, lost acknowledgements and explicit Stop.
4. Benchmark fewer, larger Naming batches against the existing quality criteria
   before replacing the multi-role pipeline. Do not fake successful results or
   reduce factual verification simply to make the flow appear complete.

## Verification

Use the dedicated no-dispatch database tests, local-persistence tests, progressive
worker tests, project-admission tests and guided-consent tests. Test a held unknown
create and a real observed overrun as negative controls. Deployment of the web app
alone does not update the separately packaged Naming daemon.
