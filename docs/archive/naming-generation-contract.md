> Archived November 10, 2026: describes the system before the generation engine.

# Naming generation contract (November 2026 rebuild)

Technical contract for the rebuild described in
[naming-rebuild-plan-20261108.md](naming-rebuild-plan-20261108.md). Shared
TypeScript schemas live in `src/domain/naming-generation.ts`; this document
names the SQL functions, worker actions and web routes that use them.

## Records

- **Run** = one `public.naming_batches` row with `engine_version = 3` plus its
  `public.jobs` row.
  - The job has `operation = 'naming.generate'`, `input = NamingRunInput`
    (version 3, which carries the frozen brief), `reserved_cost_microusd = 0`,
    `billing_mode = 'openai_api'` and `max_attempts = 3`.
  - `runId` equals the batch id.
  - The job state is the run state.
- **Round** = one row in `fluid_private.naming_rounds`: `round_id`, `batch_id`,
  `job_id`, `round` (1-3), `request` (the exact frozen wire request),
  `response_id`, `request_id`, `state`, `saved_count`, `usage`, `error_code`,
  and timestamps. Its `state` is one of:
  - `sending`: the request is committed but no receipt number is saved yet;
  - `sent`: the response id is saved;
  - `saved`;
  - `failed`;
  - `interrupted`.
- **Names** = `public.name_candidates` rows.
  - Each row has `batch_id = runId` and `caution` set to the shared caution
    text.
  - Each row's `origin` uses the existing brainstorm origin shape:
    `{kind:'brainstorm', version:1, profile:'brainstorm_v1', ownerId, projectId,
    candidateId, contextRevision, value, batchId, jobId, runId, callId: roundId,
    responseId, requestId, model, generatedAt}`.
  - Duplicates within a project, by `identity_key`, are skipped by SQL.
- **The feed is ordered** by `(created_at, id)` over the project's names whose
  batch has `engine_version = 3`.

## Web functions (authenticated, `security definer`, owner-checked)

| Function | Returns | Notes |
|---|---|---|
| `public.get_naming_generation(p_project uuid, p_after_created_at timestamptz default null, p_after_id uuid default null, p_limit int default 100)` | `NamingGenerationFeed` | `run` is the project's latest run. Each entry carries `entry` from `fluid_private.naming_entry(candidate)`. |
| `public.start_naming_run(p_project uuid, p_request jsonb)` | `{run, reused}` | Request = `StartNamingRunRequest`. |
| `public.stop_naming_run(p_project uuid)` | `{run}` | The active job becomes `cancelled` if queued, or `cancel_requested` if running. |
| `public.get_naming_usage(p_jobs uuid[])` | `[{jobId, inputTokens, outputTokens, totalTokens}]` | Sums the saved rounds. Used by Settings → Usage. |

**What `start_naming_run` does:**
- **Idempotency:** a repeat of the same `idempotencyKey` returns the same run
  with `reused = true`.
- **One active run per project.**
- **Checks before it starts:**
  - the project revision and preferences version are current;
  - version-2 preferences exist;
  - an enabled, ready naming slot policy exists.
- **Builds the brief in SQL:**
  - `strategyBasis` comes from `fluid_private.naming_strategy_basis(context)`;
  - the 20 most recent liked names;
  - seed names (steer runs only);
  - the 50 most recent names;
  - the instruction.
- **Admits the job:** `fluid_private.admit_shared_worker_job(job, 'naming', policy_identity, deployment, policy)`.

**Errors** carry their code as the exception message:

| Code | `errcode` | HTTP |
|---|---|---|
| `naming_active`, `project_revision_changed`, `preferences_changed` | `40001` | 409 |
| `preferences_incomplete`, `invalid_naming_request` | `22023` | 422 |
| `naming_unavailable` | `55000` | 503 |
| missing project | `P0002` | 404 |

## Worker actions

All actions go through
`public.shared_naming_worker_action(p_slot jsonb, p_execution jsonb, p_action text, p_args jsonb)`,
which returns `{execution, result}`.

- `p_args` is a JSON object.
- The function is replaced in place (`create or replace`, same signature), so
  existing slot-role grants and the gateway stay valid.

**Without an execution:**

| Action | Arguments | Result |
|---|---|---|
| `qualify` | `{policy}` | `true` once the slot's `naming.generate` policy matches. Sets `ready_until = now + 60 s`. |
| `expire` | `{}` | Number of runs moved (at most 20). See the expiry rules below. |
| `claim` | `{workerId, leaseSeconds}` | The oldest claimable admitted job, set `running` with `attempts + 1`, and an execution bound to it. `result = NamingClaim`, or `null` when idle. |

**With an active execution:**

| Action | Arguments | Result |
|---|---|---|
| `heartbeat` | `{leaseSeconds}` | `{cancelRequested}`. The lease is extended even when a cancel is requested, so the worker can finish cleanly. |
| `round_begin` | `{round, request}` | Inserts a `sending` round. Requires that the previous rounds are terminal, `round` is the next number and at most 3, the job is not cancel-requested, and `savedCount < 100`. Replaying the same request while still `sending` returns the same row. |
| `round_sent` | `{round, responseId, requestId}` | Sets `state = sent` and saves the receipt number. |
| `round_saved` | `{round, responseId, model, usage, candidates: NamingSavedCandidate[] (≤100)}` | Inserts names, skipping project duplicates and stopping at 100 total. Sets the round to `saved` and the job's `progress`. Returns `{inserted, savedCount}`. Replaying an already-saved round returns its saved count. |
| `round_failed` | `{round, code, responseId, usage}` | Sets the round to `failed`. `code` is one of `provider_rejected`, `response_failed`, `response_timeout`, `invalid_output` or `save_failed`; a round cut off by the run deadline is recorded as `response_timeout`. Replaying the same code is harmless. |
| `finish` | `{}` | Sets the terminal job state (rules below), clears the lease and closes the execution. Returns `{state, savedCount}`. Replaying it with the same, now closed, execution returns the same result. |

**With an observing execution** (left over after a takeover):

| Action | Arguments | Result |
|---|---|---|
| `recover` | `{}` | Applies the expiry rules to this job now, without waiting for the lease, and closes the execution. Returns `{action: 'closed'}`. |

### Terminal state rules (`finish`)

1. If a cancel was requested, the job is `cancelled`. Saved names stay.
2. Otherwise, if at least one name was saved, it is `succeeded`. It may hold
   fewer than 100 names.
3. Otherwise it is `failed`, with `error_code` set to the last round's code, or
   `no_names`.

### Expiry rules (`expire` and `recover`)

These apply to jobs that are `running` or `cancel_requested` and whose lease
has expired, or whose execution was fenced:

1. A round still `sending` becomes `interrupted` with `send_interrupted`. It is
   never re-sent.
2. If there is an `interrupted` round, a cancel request, a run older than 20
   minutes, or `attempts = max_attempts`, the job finishes by the terminal
   rules. Error codes, in order:
   - `send_interrupted` for an interrupted round;
   - `deadline` for a run that is too old;
   - `lease_expired` otherwise.
3. Otherwise the job returns to `queued` with its lease cleared. The next claim
   resumes it:
   - a `sent` round is only polled, by its response id;
   - only then may a new round begin.
4. Every non-closed execution of that job is closed.

## Worker loop (one run per claim)

1. Run `qualify`, then `expire`, then `claim`. Start a heartbeat every 20 s;
   when it returns `cancelRequested`, abort the run.
2. **Resume.** Poll each `sent` round (GET by response id). A `sending` round
   cannot be resumed: call `finish`.
3. **New rounds.** While fewer than 100 names are saved, fewer than 3 rounds
   exist and no cancel is requested:
   1. Build the request.
   2. Call `round_begin`.
   3. Create the response with `background: true, store: true`.
   4. Call `round_sent` with the receipt number.
   5. Poll every 2 s, up to 180 s.
4. **Terminal response:**
   - `completed`: parse the single `output_text` JSON, run
     `cleanGeneratedCandidate` on each item, then
     `filterNamingBrainstormCandidates`, then call `round_saved`.
   - `failed`, `incomplete` or `cancelled`: call `round_failed` with
     `response_failed`.
   - No usable JSON: `round_failed` with `invalid_output`.
   - Timeout: cancel by id (best effort), then `round_failed` with
     `response_timeout`.
5. **Retries.** Retry a failing database action 3 times with a short backoff.
   - If `round_saved` keeps failing, call `round_failed` with `save_failed`.
   - If even that or `finish` fails, return and let the lease expire. `expire`
     bounds this through `max_attempts`.
6. **Errors never set "drain unconfirmed".** The engine's `close()` only waits
   for the active run, and the run promise always settles.

## Web routes (`src/app/api/projects/[projectId]/naming/…`)

| Route | Body | Result |
|---|---|---|
| `GET feed?cursorCreatedAt&cursorId&limit` | — | `{feed: NamingGenerationFeed}` |
| `POST feed/ensure` | `StartNamingRunRequest`, with `kind` `initial` or `more` | `{feed, run, reused}` |
| `POST steering` | `StartNamingRunRequest`, with `kind` `steer` | `{feed, run, reused}` |
| `POST feed/stop` | `{}` | `{feed}` |

- **Before calling SQL, the server checks** that the preferences are ready,
  using `getNamingPreferencesReadiness`.
- **Errors map** from the error codes above to `{error:{code,message}}`.
