> Archived November 10, 2026: describes the system before the generation engine.

# Background Strategy recovery: implementation checkpoint

This is a locally verified release candidate, not an enabled production feature.

The first reliability release is PR #99, merged as
403f51ac6d10d1dbef9a283cac152af8713b6a31. This follow-on work must not change
how historical synchronous or unknown requests are dispatched.

## Implemented locally

- Fixed-origin bounded HTTPS GET and cancellation for a validated response ID.
- One journal-authorized create with background=true, store=false and stream=false.
- Observation reconnects retrieve the same response instead of issuing inference again.
- Explicit user cancellation and the original execution deadline cancel only the saved response.
- Worker shutdown alone does not cancel provider execution.
- Terminal results are journaled before responding to shutdown.
- A lost initial create acknowledgement without an identity remains genuinely unknown.
- A descriptor-bound database adapter with strict response and ownership-binding validation.
- Pure response interpretation shared with the existing synchronous path.

A disabled-by-default, deployment-scoped SQL candidate implements journal/profile
storage and lease-fenced observer handoff. Disposable-database tests include
reconnect and exactly-once spend capture. The candidate is not installed in production.
The runtime option is off unless explicitly supplied; no deployment enables it.
Tests use synthetic data and mocked providers; no live inference was performed.

## Required before activation

1. Finish production-schema compatibility and adversarial tests for the
   restricted journal candidate; no new credentials or worker grants are needed.
2. Freeze the execution profile before dispatch for each newly admitted request.
   Never adopt old synchronous in-flight requests into a retriable create path.
3. Verify the fenced observer claim against crashes before and after every
   journal, result-publication and accounting write.
4. Keep product progress separate from financial uncertainty; do not release a
   hold merely because an observer disconnected or a cancellation was requested.
5. Make terminal publication and cost capture atomic/idempotent, including lost
   database acknowledgements and late stale observers.
6. Keep pending observation deliveries alive with bounded short retry intervals
   inside the original observation deadline, including outbox repair.
7. Verify project retention configuration, failure-injection database tests,
   signed-in browser reconnect/cancel flows, and an approved staged rollout.

## Retention

OpenAI's official background guide, checked 2026-10-21, documents temporary
polling storage of roughly ten minutes with background responses and store=false.
It explicitly permits store=false. Permanent response storage is not enabled
by this implementation. On 2026-10-21, the OpenAI dashboard showed the new
Embel project (proj_s0y4SRn9lrsLQ61XwMSwUgRD) in Personal Organization with
None (Standard retention) and Global residency. This is configuration evidence,
not a live background-response retrieval test. The owner confirmed the new worker credential was saved on 2026-10-21.
Deployment cutover has not occurred, so the running worker does not yet use it.

Reference: https://developers.openai.com/api/docs/guides/background

## Known activation blockers at this checkpoint

- Known-response expiry protection and a 30-second generation-fenced observation
  redrive path are implemented locally. They preserve original deadlines and
  request/accounting identities. The candidate deployment package now schedules repair every minute, while the
  deployed package remains daily. Both worker entrypoints have an exact, default-off
  background flag; database rollout also pins the qualified immutable deployment.
  Hosted scheduler/receipt verification is still required before activation.
- Crashes before a response ID is persisted remain conservative unknowns.
  No inference retry or release of uncertain spend is introduced.
- The candidate entrypoint requires both FLUID_API_TEXT_MULTI_ACCOUNT_ENABLED=true
  and FLUID_API_TEXT_BACKGROUND_RECOVERY_ENABLED=true. No production flag is enabled.
- Database admission-policy withdrawal does not authorize another create and must
  retain observation/settlement of a frozen accepted response. Revoking provider
  credentials or removing all worker model configuration still makes the worker
  unavailable; operators must retain observation credentials until work is drained.
- The new Embel project and standard retention settings are identified. Its
  credential save is owner-confirmed, but deployment cutover and live background
  capability remain unverified; the background feature stays disabled.

These deployment checks are why this candidate remains disabled. The
successful reconnect fixture is not certification of the full production flow.


## Additional cancellation and packaging work

The candidate registers a new plan only when no step exists. Resuming an existing
response after Stop must not call the plan writer, which correctly refuses new
plans after cancellation. A cancellation before any step can finish without a
provider call. Known text-only failed/incomplete/cancelled responses with a valid
price/model/usage envelope and bounded spend are unsuccessful executions rather
than uncertain charges. Tool ambiguity, unexpected modalities, missing usage and
overruns remain unresolved; historical records are never rewritten by this rule.

The existing Vercel team was observed on Pro Trial with five days remaining on
2026-10-21. Minute cron requires a suitable plan after the trial. No billing or
plan change has been made. The original daily repair schedule must be explicitly
restored if rolling back this candidate, because Vercel instant rollback does not
automatically change scheduled cron jobs.


## Local release verification

The core checkpoint passed 146 focused transport, worker and database checks,
including the full current migration chain and the historical adapter. The later
worker/cron wiring passed 62 checks. Verified terminal text failure cases passed
the server adapter suite; the corrected cancellation, pre-step cancellation,
policy withdrawal and reconnect paths passed eight focused cases on both schema
versions. Full TypeScript and the isolated worker build passed. Early fixture
clock setup and timeout failures were corrected or rerun; they are not reported
as passes. No live provider, signed-in browser or production cutover result is
claimed by these local tests.

The versioned migration is byte-identical to the reviewed candidate. Install it
with rollout disabled, qualify the new immutable worker, then enable only that
deployment for future admissions. Withdraw new background admissions by disabling
the SQL rollout while keeping the observer-capable worker and its flag active
until already admitted background jobs are settled. Do not rewrite old dispatch
identities, revoke observation credentials mid-run, or roll back to a synchronous
worker while background work remains in flight.
