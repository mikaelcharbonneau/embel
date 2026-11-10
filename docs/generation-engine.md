# Generation engine (Phase 4 design)

_November 9, 2026. This implements Phase 4 and step 2.1 of [architecture-review.md](architecture-review.md)._

## Goal

AI generation runs as Vercel Workflow runs inside the web app. That replaces:

- the shared worker daemon and its fixed slots (research 1, naming 1, logo 6/2);
- the API-text worker project;
- the Vercel Queue outbox;
- the per-slot database logins.

Each journey step moves over on its own, behind a switch, and the old path is deleted once the new one is proven.

## Decisions

| Topic | Decision | Why |
|---|---|---|
| Orchestrator | `workflow` 5.2.3 + `@workflow/next` (Vercel Workflow, generally available April 2026) | Durable steps, retries and cancellation, inside the existing app; no extra deploy target |
| Run records | New tables `generation_runs` and `generation_outputs`. The old `jobs`/`job_steps` stay read-only until they're dropped in Phase 5.2 | The old tables carry lease fences, plan manifests and immutable-history triggers built for the slot worker |
| Who may start a run | `public.start_generation(...)`, a SECURITY DEFINER function using `auth.uid()`. Calling it directly through the Data API is the same as clicking in the app: credits and limits apply either way | Limits live where every path meets (review M3) |
| Who writes results | Only the `embel_engine` database login, which can only execute `fluid_private.engine_*` functions. Its password is set in production outside migrations and stored as a Vercel secret (`EMBEL_ENGINE_DATABASE_URL`) | Least privilege; no secret key in the web bundle |
| Text providers | OpenAI Responses in background mode. A step creates the response and stores its id; the workflow sleeps and polls; a step retrieves the result | An uncertain outcome is looked up by response id, never blindly re-sent (AGENTS.md); no function holds a long connection |
| Image providers | Decided in step 4.4. Prefer the Responses `image_generation` tool in background mode for the same lookup-by-id recovery | Same reason |
| Retries | Steps retry transient failures (429, 5xx, network) with backoff, at most 3 attempts. Bad output gets one corrective re-prompt, then fails. Validation and permission errors fail immediately (`FatalError`) | Bounded, automatic, no operator adjudication |
| Cancellation | `cancel_generation(run_id)` marks the run. The workflow checks between steps and cancels open OpenAI background responses | Users can stop work, and no paid call starts after a cancel |
| Concurrency | No global slots. One active run per project and kind, a per-owner daily run limit, and a global daily cost cap, all enforced in `start_generation`. OpenAI rate limits are handled as retries | Throughput grows with demand (review M1) |
| Credits | Ledger `credit_entries` (grant, charge, refund) plus a `plans` table (monthly allowance) and a `generation_kinds` table (credits per kind, enabled flag). `start_generation` charges; a failed or cancelled run is refunded | Monthly plans with credits (owner decision, November 9) |
| Stop switch | `fluid_private.engine_settings.paused`, checked by `start_generation` and before every paid step | Stops paid work within seconds, no redeploy |
| Status to the browser | Each step's existing screen polls its own status route every 3 s (Supabase Realtime later) | Smallest change per screen |
| Costs | Each provider call records `cost_microusd` on its output row. Not shown to users | Admin visibility (S8); [no cost estimates in the UI] |

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
  4. checks the owner's daily limit and the global cost cap;
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
4. **Logo concepts** (6 in parallel), refinements and style notes. Needs file storage writes; the engine gets a Storage service key for that step.
5. **Creative directions and exports.**
6. **Retirement:** turn off the shared worker daemon; delete `services/`, `worker/`, slot logins, ChatGPT-plan mode and laptop runtimes; drop the old tables (Phase 5.2); make a clean baseline migration (Phase 1.2).

## Strategy on the engine (step 2)

- **Kinds:** `strategy.reformulate`, `strategy.competitors`, `strategy.audience`, `strategy.positioning`, `strategy.personality` and `strategy.slogan`, one credit each, added disabled by migration `20261110120000_strategy_engine_kinds`.
- **Switch:** the Strategy screens use the engine only when all six kinds are enabled (`src/server/engine/strategy.ts`). Then `/api/projects/[id]/strategy` reports `engine: true` and the engine's operations, and the screens start, poll (3 s) and cancel runs through `/generations`. Turning any kind off returns the whole step to the old path.
- **Input:** the route freezes each run's input with the person's own login: the context of the requested revision (whose latest guided turn must ask for that operation), the hosted guided policy, and up to five earlier replies from old jobs and engine runs. The browser only sends `expectedRevision`. A replayed key never rebuilds its input.
- **Workflow (`src/workflows/strategy.ts`):** claim, prepare the exact request once, then per attempt: check cancel and pause, create a background response, sleep and poll by id (at most 10 minutes), validate with the existing schemas. An unusable reply gets one corrective re-prompt. A cancel or pause cancels the open response at OpenAI. Each finished response is saved with its response id and `cost_microusd`: the result as `result`, an unusable or stopped attempt as `attempt.N`.
- **Applying results:** the guided interview already saves the person's choices into the project itself; nothing applies results on the server, as before (`apply_strategy_job_result_v2` serves only the older, unmounted non-guided screen).

## Naming on the engine (step 3)

- **Kind:** `naming.generate`, one credit per generation round (the first names, More names or a steered set; one round asks for up to 100 names), 30 per person per day. Added disabled by migration `20261110140000_naming_engine`.
- **Switch:** while the kind is enabled, the Naming routes (`naming/feed`, `feed/ensure`, `steering`, `feed/stop`) use the engine (`src/server/engine/naming.ts`, `src/server/data/naming-engine.ts`); otherwise they run the old path exactly as before. The screens are unchanged: the feed reports `engine: true` and is checked every 3 s while a run works.
- **Input:** the server freezes each run's input with the person's own login, as `start_naming_run` does: the saved choices of the named version, the strategy basis of the named project revision, up to 20 liked names, the steering seeds and instruction, the 50 newest names, and up to 1,000 newest name identities to avoid. The browser only names the kind, the versions and the seed names. An old-path run still working refuses a new run (`generation_active`).
- **Workflow (`src/workflows/naming.ts`):** at most three rounds. A round sends up to three OpenAI background requests side by side (about 40 names each; the first round asks for 120 names in all, later rounds for what is missing plus 20). Each reply is checked with the existing Naming filters and its names are saved as soon as it finishes. A request is polled for about 4 minutes, then cancelled. Same model and policy as the Naming lane: `gpt-6-luna`, low reasoning. Prompts are shared with the lane (`src/server/ai/naming-prompt.ts`).
- **Why the old rounds came up short:** one request asked for 120 names, so a reply that hit the output limit (`incomplete`) or the 3-minute round limit saved nothing. Smaller parallel requests finish well inside both, and one failed request no longer costs the others' names.
- **Saving names:** `fluid_private.engine_save_names` (engine login only) saves one reply as an output (`round.N.M`, with its response id and `cost_microusd`) and adds its checked names to `name_candidates` in the same transaction: brainstorm origin version 2 (`runId`, `outputKey`, `primaryApproach`), no `naming_batches` row, names already in the project skipped, at most 100 per run. Likes, Saved, steering, selection and domain checks work on them as on any name. `public.get_name_feed` lists old-run and engine names together with the latest run of either path.
- **Outcome:** a run that saved names succeeds, even short of 100. One that saved none fails (`no_names`, `provider_rejected`, …) and returns its credit. Stop cancels the run: the open OpenAI responses are cancelled, a reply that finished first keeps its names, and the credit is returned. A create whose outcome is unknown is never re-sent (`send_interrupted`).
- **Usage:** each saved reply records its tokens and `cost_microusd` on its output. Settings → Usage lists engine Naming runs with their tokens; costs are never shown.

## Release and rollback

- Each step ships behind a per-kind switch: `generation_kinds.enabled` plus the screen's route choice. The old path stays until the new one has at least 95% successful runs on 30 local or staging runs and 48 quiet hours in production.
- Rollback means disabling the kind and pointing the screen back.
- Database migrations only add things until step 6.
