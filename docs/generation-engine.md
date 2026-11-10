# Generation engine

_Designed November 9, 2026; all four journey steps run on it since November 10, 2026. Implements Phase 4
and step 2.1 of [architecture-review.md](architecture-review.md)._

The design decisions, data model and functions below describe the running system. The per-step sections
("Strategy on the engine" onward) record how each step was moved and what it relies on; where they
mention the "shared worker", "worker lane" or old `jobs` tables, that is the retired system they were
ported from. Prompt and request details are in `src/server/ai/` and `src/server/engine/`; if this file
and the code disagree, the code is right.

## Goal

AI generation runs as Vercel Workflow runs inside the web app. That replaces:

- the shared worker daemon and its fixed slots (research 1, naming 1, logo 6/2);
- the API-text worker project;
- the Vercel Queue outbox;
- the per-slot database logins.

Each journey step moved over on its own, behind a switch. All four steps now run on the engine, and the old path is deleted from the code (step 6, November 10, 2026).

## Decisions

| Topic | Decision | Why |
|---|---|---|
| Orchestrator | `workflow` 5.2.3 + `@workflow/next` (Vercel Workflow, generally available April 2026) | Durable steps, retries and cancellation, inside the existing app; no extra deploy target |
| Run records | New tables `generation_runs` and `generation_outputs`. The old queue, lease, dispatch and receipt tables were dropped in task B2 (65 tables, 502 functions, 10 logins; list in `supabase/retired-objects-20261110.json`). `jobs` and `job_steps` remain only as the finished records the engine's Logo and Creative direction functions write | Nothing is left that a slot worker needed |
| Who may start a run | `public.start_generation(...)`, a SECURITY DEFINER function using `auth.uid()`. Calling it directly through the Data API is the same as clicking in the app: credits and limits apply either way | Limits live where every path meets (review M3) |
| Who writes results | Only the `embel_engine` database login, which can only execute `fluid_private.engine_*` functions. Its password is set in production outside migrations and stored as a Vercel secret (`EMBEL_ENGINE_DATABASE_URL`) | Least privilege; no secret key in the web bundle |
| Text providers | OpenAI Responses in background mode. A step creates the response and stores its id; the workflow sleeps and polls; a step retrieves the result | An uncertain outcome is looked up by response id, never blindly re-sent (AGENTS.md); no function holds a long connection |
| Image providers | The Images API exactly as the Logo step already calls it (`gpt-image-2.6-sunburst`, low quality, low complexity, transparent PNG), one call per image (step 4.4). Each try is marked as sent in the database before it is sent; an unknown outcome fails that image and returns its credit | The Responses `image_generation` tool would put a text model between the prompt and the image model and change the drawings; the Images API has no lookup by id, so the marker is what keeps a paid image from being sent twice |
| Retries | Steps retry transient failures (429, 5xx, network) with backoff, at most 3 attempts. Bad output gets one corrective re-prompt, then fails. Validation and permission errors fail immediately (`FatalError`) | Bounded, automatic, no operator adjudication |
| Cancellation | `cancel_generation(run_id)` marks the run. The workflow checks between steps and cancels open OpenAI background responses | Users can stop work, and no paid call starts after a cancel |
| Concurrency | No global slots. One active run per project and kind, a per-owner daily run limit, and a global daily cost cap, all enforced in `start_generation`. OpenAI rate limits are handled as retries | Throughput grows with demand (review M1) |
| Credits | Ledger `credit_entries` (grant, charge, refund) plus a `plans` table (monthly allowance) and a `generation_kinds` table (credits per kind, enabled flag). `start_generation` charges; a failed or cancelled run is refunded, except for what it delivered: image steps keep one credit per delivered image, and a stopped Naming run that already delivered names keeps its credit (owner decision, November 10) | Monthly plans with credits (owner decision, November 9) |
| Stop switch | `fluid_private.engine_settings.paused`, checked by `start_generation` and before every paid step | Stops paid work within seconds, no redeploy |
| Status to the browser | Each step's existing screen polls its own status route every 3 s (Supabase Realtime later) | Smallest change per screen |
| Costs | Each provider call records `cost_microusd` on its output row. Not shown to users | Admin visibility (S8); no cost estimates in the UI |

## Data model (migration `generation_engine`)

```
plans(id text pk, name, monthly_credits int, active bool)              -- free / pro / studio
credit_accounts(owner_id pk -> auth.users, plan_id, period_start, period_end)
credit_entries(id, owner_id, delta int, kind grant|charge|refund, run_id null, note, created_at)
generation_kinds(kind text pk, credits int, enabled bool, max_per_day int, max_running_minutes int)
generation_runs(id, owner_id, project_id, kind, status queued|running|succeeded|failed|cancelled,
                idempotency_key, input jsonb, workflow_run_id, error_code, cancel_requested_at,
                created_at, started_at, finished_at; unique(owner_id, idempotency_key))
generation_outputs(id, run_id, output_key, output jsonb, provider_response_id, cost_microusd, created_at;
                   unique(run_id, output_key))
fluid_private.engine_settings(id bool pk default true, paused bool, global_daily_cost_cap_microusd bigint)
```

**Who can do what:**

- Row-level security limits every user-facing table to its owner, and users can only read. All writes go through functions.
- `credit_balance(owner)` is the sum of that owner's `credit_entries` deltas.
- `start_generation(project_id, kind, idempotency_key, input)` does this, in order:
  1. takes the owner from `auth.uid()` and checks they own the project;
  2. checks the kind is enabled and the engine isn't paused;
     It then ends the owner's overdue runs with a refund: queued with no workflow after 10 minutes
     (`start_failed`), or running past the kind's `max_running_minutes`, 30 by default (`run_timed_out`).
     `cancel_generation` does the same, so cancelling a run whose workflow stopped reporting ends it at once;
  3. checks there's no active run for the same project and kind;
  4. checks the owner's daily limit and the global cost cap (provider cost of the past day's
     outputs, plus the cost kept for accounts deleted since: `fluid_private.deleted_account_usage`,
     migration `20261110210000`);
  5. grants the monthly allowance lazily when a new period starts;
  6. checks the balance is at least the kind's credits;
  7. inserts the run and the charge.
  
  It's idempotent per (owner, idempotency_key).
- `cancel_generation(run_id)`: owner only.
- **Engine-only functions** (`fluid_private.engine_*`, granted to `embel_engine` and nothing else):
  - `engine_claim(run_id, workflow_run_id)`
  - `engine_check(run_id)`, which returns status, cancel request and pause
  - `engine_save_output(run_id, key, output, response_id, cost)`
  - `engine_finish(run_id, status, error_code)`, which refunds the credits on failure or cancellation

## Code layout

```
src/workflows/<step>.ts                 "use workflow" orchestration only
src/server/engine/database.ts           pg pool for embel_engine (attachDatabasePool, transaction pooler)
src/server/engine/runs.ts               engine_* function calls (step functions)
src/server/engine/openai.ts             background create / retrieve / cancel, cost from usage
src/server/engine/start.ts              route helper: start_generation (user client) + start(workflow)
src/app/api/projects/[projectId]/generations/...   start, status, cancel
```

The workflow file only orchestrates. Every database or provider call is a `"use step"` function.

## Order of work

1. **Foundation:** dependencies, `withWorkflow`, migration, engine module, routes, plus a no-cost "echo" workflow proving the loop locally and in production.
2. **Strategy:** competitors (with web search), audience, positioning, personality, slogan. Reuse the prompts and schemas in `src/server/ai/strategy-response.ts`. Point the strategy screens at the new routes. Results apply to the project the way `apply_strategy_job_result_v2` does today. Then turn off the strategy slot and delete the API-text worker project, queue topic and cron.
3. **Naming.**
4. **Logo concepts** (6 in parallel), refinements and style notes. Needs file storage writes; the engine gets a Supabase secret API key for that step (`EMBEL_ENGINE_SUPABASE_SECRET_KEY`).
5. **Creative directions and exports.**
6. **Retirement:** turn off the shared worker daemon; delete `services/`, `worker/`, slot logins, ChatGPT-plan mode and laptop runtimes; drop the old tables (Phase 5.2); make a clean baseline migration (Phase 1.2). The code part is done (see "Retirement (step 6)" below); the production steps are in [archive/retire-old-worker-release.md](archive/retire-old-worker-release.md).

## Strategy on the engine (step 2)

- **Kinds:** `strategy.reformulate`, `strategy.competitors`, `strategy.audience`, `strategy.positioning`, `strategy.personality` and `strategy.slogan`, one credit each, added disabled by migration `20261110120000_strategy_engine_kinds`.
- **Switch:** the Strategy screens use the engine only when all six kinds are enabled (`src/server/engine/strategy.ts`). Then `/api/projects/[id]/strategy` reports the engine's operations, and the screens start, poll (3 s) and cancel runs through `/generations`. Turning any kind off is a stop switch: the step shows as unavailable (`generation_unavailable`).
- **Input:** the route freezes each run's input with the person's own login: the context of the requested revision (whose latest guided turn must ask for that operation), the hosted guided policy, and up to five earlier replies from old jobs and engine runs. The browser only sends `expectedRevision`. A replayed key never rebuilds its input.
- **Workflow (`src/workflows/strategy.ts`):** claim, prepare the exact request once, then per attempt: check cancel and pause, create a background response, sleep and poll by id (at most 10 minutes), validate with the existing schemas. An unusable reply gets one corrective re-prompt. A cancel or pause cancels the open response at OpenAI. Each finished response is saved with its response id and `cost_microusd`: the result as `result`, an unusable or stopped attempt as `attempt.N`.
- **Applying results:** the guided interview already saves the person's choices into the project itself; nothing applies results on the server, as before (`apply_strategy_job_result_v2` serves only the older, unmounted non-guided screen).

## Naming on the engine (step 3)

- **Kind:** `naming.generate`, one credit per generation round (the first names, More names or a steered set; one round asks for up to 100 names), 30 per person per day. Added disabled by migration `20261110140000_naming_engine`.
- **Switch:** the Naming routes (`naming/feed`, `feed/ensure`, `steering`, `feed/stop`) use the engine (`src/server/engine/naming.ts`, `src/server/data/naming-engine.ts`). While the kind is off the feed reports Naming as unavailable and `start_generation` refuses new rounds (`generation_unavailable`). The screens are unchanged: the feed reports `engine: true` and is checked every 3 s while a run works.
- **Input:** the server freezes each run's input with the person's own login, as `start_naming_run` does: the saved choices of the named version, the strategy basis of the named project revision, up to 20 liked names, the steering seeds and instruction, the 50 newest names, and up to 1,000 newest name identities to avoid. The browser only names the kind, the versions and the seed names. An old-path run still working refuses a new run (`generation_active`).
- **Workflow (`src/workflows/naming.ts`):** at most three rounds. A round sends up to three OpenAI background requests side by side (about 40 names each; the first round asks for 120 names in all, later rounds for what is missing plus 20). Each reply is checked with the existing Naming filters and its names are saved as soon as it finishes. A request is polled for about 4 minutes, then cancelled. Same model and policy as the Naming lane: `gpt-6-luna`, low reasoning. Prompts are shared with the lane (`src/server/ai/naming-prompt.ts`).
- **Why the old rounds came up short:** one request asked for 120 names, so a reply that hit the output limit (`incomplete`) or the 3-minute round limit saved nothing. Smaller parallel requests finish well inside both, and one failed request no longer costs the others' names.
- **Saving names:** `fluid_private.engine_save_names` (engine login only) saves one reply as an output (`round.N.M`, with its response id and `cost_microusd`) and adds its checked names to `name_candidates` in the same transaction: brainstorm origin version 2 (`runId`, `outputKey`, `primaryApproach`), no `naming_batches` row, names already in the project skipped, at most 100 per run. Likes, Saved, steering, selection and domain checks work on them as on any name. `public.get_name_feed` lists old-run and engine names together with the latest run of either path.
- **Outcome:** a run that saved names succeeds, even short of 100. One that saved none fails (`no_names`, `provider_rejected`, …) and returns its credit. Stop cancels the run: the open OpenAI responses are cancelled, a reply that finished first keeps its names, and the credit is returned. A create whose outcome is unknown is never re-sent (`send_interrupted`).
- **Usage:** each saved reply records its tokens and `cost_microusd` on its output. Settings → Usage lists engine Naming runs with their tokens; costs are never shown.

## Logo on the engine (step 4)

- **Kinds:** `logo.concepts` (6 credits: one per image; 20 per person per day; 20 running minutes), `logo.refine` (1 credit; 60 a day; 15 minutes) and `logo.style_note` (free; 30 a day; 10 minutes), added disabled by migration `20261110151000_logo_engine`. Migration `20261110150000_logo_types_keep_concepts` ports the logo-types decision of #209 (the brief's types can change without making earlier concepts outdated).
- **Switch:** the Logo screens use the engine only while all three kinds are enabled (`src/server/engine/logo.ts`). `GET /api/projects/[id]/logo/engine` then reports `engine: true` and the latest Logo runs; Explore, More concepts, Retry failed and Refine start runs through `/generations` with one click (no quote), the screen follows them every 3 s and Stop cancels them. Turning any kind off is a stop switch: drawing shows as unavailable and saved logos stay.
- **Input:** the route freezes each run from the person's own Logo workspace: the heads they asked from, the saved brief (name, activity, audience, personality with its liked-style lines, logo types) and, for a refinement, the chosen image's exact preview and the liked uploads of the saved reference snapshot. The browser only names the operation, the heads, the brief revision, the failed slots or the chosen image and the requested change. Style notes freeze each liked upload's exact version.
- **Records:** `fluid_private.engine_logo_begin` opens a round as a concept batch whose six slots the database plans (`logo_plan`, as before). `fluid_private.engine_logo_save_image` records each image in the same Logo tables the shared worker writes, as finished records only (a `jobs` row with no lease, a concept attempt or raster refinement, provider evidence, a committed asset and its raster result), plus a `generation_outputs` row `image.N` with its `cost_microusd`. So the concept grid, selection, refinement history, downloads and Creative direction read them unchanged. A refinement moves the refinements head when the workspace is still where the person asked from, as before. The database refuses an image whose bytes are not stored at the owner's path.
- **Workflow (`src/workflows/logo.ts`):** every image of a round is drawn at once in its own steps. A try is marked as sent (`sent.image.N.T`, internal) before the one Images API call; a try whose marker already exists is never sent again. Nothing-drawn failures (429, 5xx, no connection) get three tries; a refusal, an unknown outcome or an unusable picture fails that image only, with its usage when known. A drawn image is normalized to black and white, checked (1024 x 1024, no color), stored under `{owner}/{project}/{asset}/{version}` in `fluid-assets`, then recorded. The round checks for Stop every 4 s; an image that finishes after Stop keeps its usage but is not delivered.
- **Credits:** a Logo image run keeps one credit per delivered image however it ends (finished, failed, stopped or timed out) and returns the rest (`finish_generation_run`); a run that delivered nothing fails. Other kinds are unchanged.
- **Style notes (`logoStyleNoteGeneration`):** one background-mode text request per liked upload (the upload placed on white), the worker lane's exact request and policy; a note is saved as output `note.<referenceId>` with its cost. A create whose outcome is unknown fails that note (`send_interrupted`) and is never repeated automatically.
- **Storage:** steps use `EMBEL_ENGINE_SUPABASE_SECRET_KEY` (an `sb_secret_…` key on the `apikey` header) only inside step bodies (`src/server/engine/storage.ts`); every path is checked against the run's owner and project before a request.
- **Vector conversion** was removed with the vector editor (#215) and its last code with the worker (step 6). Saved vectors still verify and download.

## Creative directions on the engine (step 5)

- **Kind:** `identity.directions`: one round of three direction boards around the chosen logo. 3 credits, one per delivered board (like Logo images: a round keeps a credit for each board it delivered however it ends, and returns the rest); 10 rounds per person per day; 35 running minutes. Added disabled by migration `20261110170000_identity_directions_engine`.
- **Switch:** the Creative direction screens keep their routes (`/identity/batches`, its request lookup, Stop and close). Those routes check availability, admit, read and stop rounds through the engine (`src/server/data/identity-jobs.ts`, `src/server/engine/identity.ts`). While the kind is off the step shows as unavailable and new rounds are refused (`generation_unavailable`); saved rounds still display. Stop and close follow the round: an engine round is stopped through its run even after the kind is turned off. The screen itself is unchanged apart from two messages: out of credits (402) and today's limit (429) are final answers, so the request is not kept for recovery.
- **Admission:** `public.start_identity_directions(project, intent)` takes the screen's version 3 request and, in one transaction, calls `start_generation` (kind enabled, not paused, one round at a time, daily limit, credits) and freezes the round exactly as `ensure_shared_identity_batch` does: the input snapshot, the chosen logo, the batch, the request and an `identity.image` job (input version 3) under the engine's policy (`fluid_private.engine_identity_policy`: the shared worker's text policy and board request; its policy identity is checked against `src/server/engine/identity-input.ts`). The job runs under the run's lease and has no shared worker admission, so no worker claims it. A replayed key returns the same round and starts its workflow if it never started; reading a working round does the same after 15 seconds. `get_identity_directions_availability` is the shared availability check without the shared worker's slot, and never carries a cost estimate.
- **Workflow (`src/workflows/identity.ts`):** each direction's specification sees the round's earlier ones, so the three specifications are written in turn; then the three boards are drawn at once, each in its own steps. (A workflow invocation waits for every step it started together, so a board started beside the next specification held that specification back: the first local round, pipelined that way, took 285 s.) The requests are the shared worker's, unchanged (`src/server/ai/identity-direction-requests.ts`, shared with `worker/identity/producer.ts`): the specification on `gpt-6.1-sol` (medium reasoning) in OpenAI background mode, looked up by response id for up to 4 minutes; the board on `gpt-image-2.6-sunburst`, medium quality, opaque, 1024 x 1024, the chosen logo first, then the selected references. Every try is marked as sent (`sent.spec.N.T`, `sent.board.N.T`) before it is sent; a try whose marker exists is never sent again. Nothing-sent failures (429, 5xx, no connection) get three tries; a refusal or an unknown outcome fails that direction only; an unusable specification gets one more paid try. The round checks for Stop every 4 s; Stop cancels open text responses at OpenAI.
- **Records:** `fluid_private.engine_identity_save_board` records each direction once (`board.N`). A delivered board, whose bytes are already stored at `{owner}/{project}/{asset}/{version}`, becomes a committed asset, a system version with its application design, its file, a succeeded job step and a generated root, the same records the shared worker writes; the existing evidence check (`identity_root_evidence`) runs before it is saved. A direction that failed becomes a failed job step. `finish_generation_run` closes the round's job: three boards succeeded, a stop cancelled, some boards partial, none failed. So the batch view, selection, the brand board and downloads read engine rounds unchanged. Specification tries are outputs `spec.N.T` with their response ids and `cost_microusd`; costs are estimates and never shown.
- **Exports:** the Assets step builds every download in the browser from saved files (`src/features/brand-assets/client/build-pack.ts`): the brand board, logo files, palette, font links, social images, post templates and banners. That involves no AI and no worker, so it needs no kind. The older vector-logo export (`POST /api/projects/[id]/logo/exports`, operation `identity.logo_export`) was removed with the worker in step 6; exports it made earlier still read through `GET /logo/exports/[id]`.
- **Depends on the selected-logo board objects** (originally the hand-applied packet `supabase/archive/candidates/shared_identity_selected_logo_boards.sql` and its predecessors). Since the baseline migration (`supabase/migrations/20261110190000_baseline.sql`) they are part of every database built from migrations.

## Retirement (step 6)

_November 10, 2026. All four steps ran with real live runs on the engine; the owner decided on no observation period._

- **Removed from the code:** `worker/` and `services/` (the shared worker daemon, the API-text worker and the dedicated Logo worker), their build, package and verify scripts and `package.json` scripts, the `worker-builds` and `portable-development` CI jobs, the old admission and dispatch paths (`strategy-jobs` enqueue and delivery, `api-text/*`, old Naming run starts, `logo-jobs`, Logo quotes and requests, the shared worker's Creative direction admission), ChatGPT-plan mode and the laptop runtimes (`local-chatgpt`, `npm run local`, port 3106), account enrollment, and the remaining vector conversion code.
- **Moved:** the engine's prompts and image request helpers to `src/server/ai/`; the image check child process to `src/server/image-process/`.
- **Kept:** reads of saved data (old jobs, results, names, logos, directions and boards), `src/domain/jobs.ts`, `request_job_cancel` for old requests that never finished, and the web app's restricted write lanes (`src/server/shared-account`, `src/server/runtime`), which Home attachments, Creative direction choices and Logo uploads still use.
- **Database:** the objects nothing references any more were dropped afterwards in task B2 (migration `20261110180000_retire_old_worker_objects`, applied in production); the baseline migration reproduces the result.

## Release and rollback

- Each kind's `generation_kinds.enabled` is its stop switch. With a kind off, its step shows as unavailable; there is no other path to fall back to.
- `fluid_private.engine_settings.paused` stops every paid step at once.
- There is no old worker to fall back to: its code and database objects are gone. A bad release is rolled back by redeploying an earlier web release, and a misbehaving step is stopped by switching its kind off.
