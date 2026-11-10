> **Archived November 9, 2026.** Historical record; it may not match the current code. Current architecture and plan: [architecture-review.md](architecture-review.md).

# Naming generation rebuild — plan for review

November 8, 2026. Status: approved; steps 1–5 implemented (step 6, production, waits on the database decision). Replaces the
current Naming generation backend. Approved in chat: "Yes, rebuild it."

## In one paragraph

Naming keeps breaking because the system behind it is far bigger than the job
it does. It is one AI request that returns about 100 names, but it runs on
about 220 database functions and about 40 tables, all built up through
successive fixes. Each fix added a safety layer, and each layer became one
more place where a small surprise turns into "stop everything". The rebuild
replaces it with one ordinary background job:

1. ask the AI;
2. clean and check the names in code;
3. save them in one step.

Any single failure ends only that job, never the worker. The Naming screens
stay the same for you.

## What caused today's failure

1. The AI wrote a name explanation containing an invisible "null" character.
2. The worker accepted the reply. The database refused to store it, because
   the database re-reads OpenAI's whole raw reply instead of storing the
   cleaned names.
3. Any failure after a paid request counts as "outcome unknown", and the
   worker stopped.
4. On restart, recovery fetched the same reply and failed the same way. This
   happened five times, then the worker gave up.
5. Naming, Strategy and Logo share one worker process, so all AI stopped.

## What you will notice

- **Same Naming screens and features:**
  - the choices questions;
  - the first 100 names and More names;
  - hearts and Saved;
  - "More like this" and typed guidance;
  - Stop;
  - adding your own name;
  - the name details with domain checks;
  - choosing a name, then Slogan.
- **Fewer, clearer status messages.** You will see "Generating names… 40 of
  100", "Stopped", or "Something went wrong — Try again". The dozen technical
  states disappear, such as "dispatch unresolved", "prepared set available"
  and "completion unresolved".
- **Names appear as each AI request finishes.** You won't wait for the whole
  set.
- **When something fails, you see why.** Names already saved stay, and Try
  again is one click. Nothing is ever stuck "waiting for reconciliation".
- **Strategy and Logo keep working** when Naming has a problem, and the
  reverse is true too.
- **Usage gets better.** Settings → Usage shows the real token counts for
  naming. Today it shows them as unknown.

## The new design in plain words

**A naming run** is one row with a few key fields:

- what it was asked: your choices, liked names and guidance, frozen at the
  start;
- how many names it needs;
- its state: queued, running, done, stopped or failed.

**The worker** picks up a run and works in rounds. In each round it does six
things:

1. Builds the request. The creative instructions are kept as they are,
   because they are the part that works.
2. Sends it to OpenAI in "background" mode. OpenAI answers at once with a
   receipt number, and the worker saves it before anything else.
3. Checks back with OpenAI using that number until the names are ready.
   Checking back is free and safe to repeat, so a restart simply continues
   checking. It never sends the request twice.
4. Cleans every name and explanation. It removes invisible characters and
   applies the existing checks for approaches, duplicates and length.
5. Saves the clean names and the usage in one database step.
6. Stops once 100 names are saved, after three rounds, or when you press
   Stop.

**If something goes wrong:**

- **A save fails:** retry a few times, then end the run as "failed" and keep
  every name saved so far. The worker carries on with other work.
- **The worker restarts mid-run:** it continues from the saved receipt
  number.
- **The worker crashed in the instant between sending and receiving the
  receipt number:** this window is less than a second and cannot be removed
  entirely. The run ends as "interrupted" and the app shows Try again. It
  never retries on its own, so it can never pay twice without your click.
- **Every run has a deadline:** 10 minutes. A run past its deadline is
  closed, never left hanging.

**The database stores clean data.** It checks simple things: you own the
project, only one run is active per project, and names have sensible sizes.
It no longer re-reads OpenAI's raw reply.

## What gets removed

- About 200 database functions and about 34 tables of naming machinery:
  pilots, intents, prepared sets, feed entries, receipts, artifacts,
  microbatches, brainstorm calls, events and publications, delivery
  recoveries, hosted, local and legacy paths, and the unused ledger.
- The old ChatGPT-subscription "batches" path, which nothing on screen can
  start any more.
- The legacy per-owner, local, cloud and hosted naming workers.
- About 180 naming test files. About 15 focused files replace them (see
  Verification).
- **Existing naming test data.** Generated names, likes and runs in local
  and production projects are disposable test data, so they are reset.
  Projects and their other steps are kept. A project that already has a
  chosen name keeps it, because it is saved in the project itself.

**Kept:**

- your saved choices (preferences);
- likes and saves;
- your own names;
- name selection;
- the domain, handle and trademark checks;
- the separate Names tool (standalone names).

## Steps

Each step is its own pull request, tested on the local app before the next.

1. **Keep one failure from stopping all AI.** When one lane cannot shut down
   cleanly, the worker stops only that lane and carries on with the others.
   The database already revokes a stopped lane's authority, so its late
   writes are refused. This protects Strategy and Logo on its own, so it
   ships first.
2. **The new naming job.**
   - Database: the run table, plus one function each to start, claim, save
     a round and finish.
   - Worker: the round loop described above.
   - Both keep the lane name "naming", so the slot, role and secret wiring
     stay the same.
3. **The screens use the new job.**
   - Same addresses (feed, ensure, stop, steering).
   - Simpler data, and fewer states to show.
   - Likes and guidance are read when a run starts. No more database
     triggers for them.
4. **Remove the old machinery and reset naming test data.**
   - Rebuild the worker's permission list. It currently lists 271 functions
     and blocks every lane whenever one changes.
   - Rebuild the local install. Remove old docs, or mark them historical.
5. **Verify on the local app.** See below.
6. **Production.** This waits for your choice between one Logo slot and a
   database upgrade, because the production worker is stopped until then. It
   uses the same reviewed, locked procedure as before.

## Verification

- **Automatic tests** for the six crash points: before sending, just after
  sending, after the receipt number is saved, after the reply, during the
  save, and a save that keeps failing. Each must end in a clear state, with
  no double payment, the worker still running, and Strategy and Logo
  unaffected.
- **Tests for the cleanup:** a reply containing invisible characters, broken
  JSON, too many names, duplicate names, or the wrong model.
- **Database tests:**
  - only one active run per project;
  - a repeated click starts nothing new;
  - Stop;
  - expiry;
  - you can't reach another account's project.
- **One real run on the local app, through the screens:** the first 100
  names, More names, "More like this", and Stop. It costs a few cents of
  OpenAI usage; the exact amount is reported afterwards.
- **A forced failure during a real run.** The run fails cleanly, and Strategy
  and Logo jobs still work at the same time.

## Decisions for you

1. **The separate Naming page.** Projects now always open Naming inside the
   conversation; the separate page only redirects there. It still carries
   extras nobody reaches:
   - batch history with search;
   - "workshop" transforms;
   - a screening pane;
   - an approach coverage table.

   *Recommendation: remove the page and those extras.* The name details
   overlay keeps the checks.
2. **"Explore variations" in the name details.** Inside the conversation it
   currently makes the names list disappear (a bug).
   *Recommendation: remove it, together with the workshop.*
3. **Fewer than 100 good names after three rounds.**
   *Recommendation: show what was found, with More names available.* No
   error, no warning.

## Technical appendix

**Tables (public; owner-read RLS; writes only through definer functions):**

- **Kept:**
  - `naming_sessions`: adds `steering_instruction`, `steering_seed_ids` and
    `steering_revision`, absorbing `naming_brain_heads`.
  - `naming_preferences`, `name_candidates`, `name_retention`,
    `name_selections`, `name_transforms` (or removed with decision 2).
- **New `naming_runs`:**
  - `id`, `owner_id`, `project_id`, `job_id` → `jobs`;
  - `kind` (initial | more | steer), `brief` (jsonb, frozen), `target`,
    `saved_count`, `created_at`;
  - one active run per project, through a partial unique index on active job
    states.
- **New `naming_run_rounds`:**
  - `(run_id, round)` primary key;
  - `request_hash`, `response_id` (saved before polling), `state`
    (sent | done | failed);
  - `usage` (jsonb), `saved_count`, `attempts`.
- **`name_candidates`:**
  - `batch_id` is replaced by `run_id`;
  - new per-project `position`, which gives the feed order and replaces
    `naming_brain_feed_entries`;
  - `origin` becomes `generated` | `custom`.

**Functions (about 8):**

| Function | Who calls it | What it does |
|---|---|---|
| `start_naming_run` | web | idempotency key; one active run per project; freezes the brief; inserts the job and the run; shared admission |
| `get_naming_feed` | web | candidates by position, plus the current run's state, count and failure reason |
| `stop_naming_run` | web | — |
| `steer_naming` | web | saves the guidance, then starts a run |
| `claim` | naming lane worker action | — |
| `round_sent` | naming lane worker action | saves the response id |
| `round_saved` | naming lane worker action | candidates plus usage, in one transaction |
| `finish` | naming lane worker action | — |
| `expire` | naming lane worker action | — |

The shared job functions lose their naming branches:

- `claim_job`, `expire_job_leases`, `request_job_cancel`, `begin_job_step`;
- `complete_job_step_core`, `lock_leased_job`, `settle_reservation`;
- `project_deletion_worker`.

**Worker:**

- **Provider calls:** `create` with `background: true, store: true`, then
  `retrieve` until a terminal state, and `cancel` on Stop.
- **Validation:** zod plus a sanitizer. The sanitizer strips C0 and C1
  control characters and lone surrogates, applies NFC, and enforces length
  limits. The existing `filterNamingBrainstormCandidates` and the
  approach-allocation logic are reused.
- **Errors:** every error is classified per run. None sets the engine's
  "drain unconfirmed" flag.
- **Background mode needs checking** before building: retention and the
  polling limits under `store: true`.

**Pool:**

- In `controller.ts`, an unconfirmed drain fences that slot, marks it
  unavailable and lets the other slots continue. The process exits only for
  process-level faults.

**Usage:**

- Each finished round records `response.usage` in the job's usage fields.
- The reservation always settles when the job ends. It settles with recorded
  usage when that is known, and is marked "usage unknown" for an interrupted
  send.
- No fixed monetary caps.

**Rollout:**

- Hash-pinned packets, the authority manifest and the local install are
  regenerated in step 4.
- Production runs through the locked owner procedure.
- Internal holds on removed test jobs are released as part of the test-data
  reset. OpenAI's own billing records are unaffected.
