# State machines

_Written November 14, 2026, from a full read of `src/`, `supabase/migrations/` and the tests._

A state machine is anything with a fixed set of modes and rules about which mode may follow which.
Embel has many. Most were **implicit**: the modes were spread over several flags, and the rules lived in
`if` chains written again on each screen. This file lists every one, says where its rules live, and
records what is known to be wrong with it. Read it before changing how a screen or a run moves from one
mode to the next.

## The rule

1. **A machine that more than one file reads is declared once**, in `src/domain/`, as plain data: the
   list of states, a table of allowed moves, and small functions that answer the questions screens ask
   ("is it working?", "can it be stopped?"). No state machine library.
2. **The database owns every machine it stores.** The TypeScript declaration mirrors it, and a test
   reads `supabase/migrations` to prove the two agree.
3. **Nobody writes a state list by hand.** Not `status === "queued" || status === "running"`, not
   `["queued", "running"].includes(...)`. Import the function. If the question is new, add a function to
   the declaration.
4. **A screen that turns a machine into words does it in one function** that takes the state and
   returns what to show. The order of the checks is the priority, so it is written once and tested.
5. **Making a machine explicit never changes behavior in the same change.** First declare and replace
   the copies with tests proving nothing moved; fix defects in a second change.

The model to copy is `src/domain/generation-run.ts` with `tests/domain/generation-run.test.ts`.

## Status of each machine

- **Declared**: one source, with tests. Follow it.
- **Explicit**: a named union or enum in one place; fine as it is.
- **Implicit**: spread over flags or repeated lists. Known defects are listed.

Defect labels: **verified** means read in the code by the lead; **reported** means found by a read-only
sweep and not yet reproduced. Reproduce a reported defect before fixing it.

### Engine and database

| # | Machine | Status | Where the rules live |
|---|---|---|---|
| R1 | Generation run lifecycle | **Declared** | `src/domain/generation-run.ts`; SQL `start_generation`, `engine_claim`, `finish_generation_run`, `cancel_generation`, `expire_overdue_generation_runs` |
| R2 | Start refusals (what a 402, 409, 429 or 503 means to a screen) | Declared, not yet used | `startRefusal` in `src/domain/generation-run.ts`; the screens still use `naming-feed-controller.ts` (`definitive`), `identity-generation-controller.ts` (`FINAL_REFUSALS`), none for Logo |
| R3 | Workflow stop check (not running, stop asked, paused) | Implicit | about 15 inline copies in `src/workflows/*.ts` and `src/server/engine/*-run.ts` |
| R4 | Project deletion | Implicit, derived | SQL `project_deletion_state`, `request_project_deletion`, `restore_project_deletion`; `src/domain/project-deletion.ts` |
| R5 | Old job state (`jobs.state`, still written for Logo and Creative direction records) | Implicit | `src/domain/jobs.ts`, `job-activity.ts`, `naming-generation.ts`, `account-strategy-client.ts`, SQL guards |
| R6 | Creative direction round (run status + job state + fulfillment) | Implicit | SQL `engine_identity_close_job`, `shared_identity_batch_state`; `src/domain/identity-jobs.ts` |
| R7 | Subscription and plan | Mostly explicit in SQL | `20261111100000_stripe_billing.sql`, `src/server/billing/` |
| R8 | Credit ledger | Explicit kinds, implicit refund rule | `finish_generation_run` |
| R9 | Account deletion receipt | Explicit | `20261110200000_account_deletion_and_export.sql`, `src/server/account/deletion.ts` |
| R10 | Logo workspace stages, style-note status, attempt view state | Derived | `src/domain/logo-workspace.ts`, `src/server/engine/logo.ts`, `src/domain/logo-jobs.ts` |

**R1.** Statuses `queued`, `running`, `succeeded`, `failed`, `cancelled`. A stop request is not a status:
it is `cancel_requested_at` on a run that is still active, which `runPhase` reads as `stopping`. The
allowed moves are in `GENERATION_RUN_TRANSITIONS`. Known gaps, none changed yet:

- `cancel_generation` sets `cancel_requested_at` on a finished run too. Always use `isRunStopping`,
  never the flag alone. (verified)
- The overdue sweep only runs when that owner starts or cancels something; there is no schedule. A
  workflow that dies leaves its run `running` until then. (verified)
- No CHECK ties `finished_at`, `started_at` or `error_code` to the status. (reported)
- "Admitted but the workflow did not start" is answered three ways: `/generations` returns 503 (the same
  code as "switched off"), Naming returns 500, Creative direction restarts it after 15 seconds. (verified)

**R2.** The three lists disagree: Naming treats 401, 403 and 503 as final, Creative direction does not,
Logo has no list and makes a new request key on every click. `startRefusal` in
`src/domain/generation-run.ts` is the decision: 400, 401, 402, 403, 404, 409, 413, 422 and 429 prove
nothing started; everything else, 503 included, may have admitted a run. No screen uses it yet, and
moving Naming to it changes what Naming does on 503.

**R3.** Most copies stop for "not running", "stop asked" and "paused". `logo-run.ts` and
`identity-run.ts` leave out `paused` and tolerate a missing run; the others do not. Whether that
difference is intended is not recorded. Do not merge the copies without deciding.

**R4.** States `active`, `stopping`, `awaiting_resolution`, `deleted`, never stored: derived from two
timestamps and the old `jobs` tables. Neither function reads `generation_runs`, so until November 14 a
project deleted while a run was working kept making paid calls. **Fixed** by migration
`20261114130000_project_deletion_stops_generation_runs`: a trigger on `public.projects` treats every
active run of a project being deleted the way `cancel_generation` does (tests in
`tests/database/generation-engine.test.ts`). Still true: `project_deletion_state` does not wait for
those runs, so the project reads `deleted` a few seconds before its last run ends.

**R5.** `partial` means four things (finished, still busy, failed, its own group) depending on the
reader, and four "active job" lists disagree about `partial` and `needs_reconciliation`. (reported)

**R6.** The job is created `running` while the run is still `queued`. A round stopped after its third
board has run `cancelled` and job `succeeded`. The step's own routes read the job; `/generations` reads
the run. (reported)

**R7.** Nothing in the database stops two live subscriptions for one account; the only guard is a check
in `src/server/billing/sessions.ts`. The plan on the account and the plan on the subscription can differ
between a downgrade and the next invoice. (reported)

### Journey and workspace

| # | Machine | Status | Where the rules live |
|---|---|---|---|
| J1 | "Is Strategy done?" | Implicit, two ledgers | `intake.guidedInterview` (`src/domain/guided-interview.ts`) and the `…ReviewedAt` fields (`projects.ts`, `project-naming.ts`, `project-handoff.ts`, `project-draft-adapter.ts`) |
| J2 | Current step and done steps | Implicit, six derivations, seven vocabularies | `journey.ts`, `project-workspace.tsx`, `account-guided-interview.tsx`, `project-handoff.ts`, `project-continuation.ts` |
| J3 | Save status ("Saving…", "Saved", "Not saved") | **Declared** | `accountSaveStatus` in `src/components/workspace/account-save-status.ts`, read by the bar and the page |
| J4 | Work-area view of the conversation | Implicit, about 14 flags | `account-guided-interview.tsx` |
| J5 | Guided turn coordinator | Implicit, effect order | `account-guided-interview.tsx` |
| J6 | Session | Implicit, overloaded `error` | `account-session.tsx` |
| J7 | Home prompt start | Implicit, about 20 flags | `project-editor.tsx`, `account-strategy-start.tsx` |
| J8 | Strategy job polling | Implicit | `use-strategy-jobs.ts` |
| J9 | Project delete and restore dialog, profile save, home voice, auth forms | Explicit | `project-deletion-client.ts`, `account-profile-editor.tsx`, `use-home-voice.ts` |

Defects below are reported, not yet reproduced, unless marked fixed.

**J1.** Editing the brief clears one ledger and keeps the other; that is still so. Its two visible
results are **fixed**: the endless loading view after a brief edit past Personality now names the step
to review with a button (`GuidedStrategyReview`), and the "Strategy needs review" notice links to
sections that exist (`#journey-strategy`, `#journey-voice`). Open product question: should a brief edit
send the person back to confirm Strategy again, or keep their confirmed answers?
`src/features/brand-lifecycle/continuity-panel.tsx` still builds the old `#strategy-…` links; no page
renders it.

**J2.** Personality is filed under Strategy by the project card and under Voice by the bar. The card
ignores Slogan, so it can say "Continue to Inspiration" while the conversation is still on Slogan.

**J3.** **Fixed.** The bar and the page read one function, so a failed save reads "Not saved" in both.
"Saved" is only shown from a server-confirmed version with nothing pending.

**J4.** A typed message on a finished interview moves it back to Personality and hides the Identity
section. A reload returns to Inspiration until the logo has saved state.

**J6.** A wrong password leaves the account menu saying the account could not be checked, instead of the
signed-out invitation.

### AI step screens

| # | Machine | Status | Where the rules live |
|---|---|---|---|
| S1 | Naming feed | Implicit flags in shared memory | `naming-brain-memory.ts`, `naming-feed-controller.ts`, `use-naming-feed.ts` |
| S2 | Logo screen | Implicit, about 15 flags and 6 refs | `logo-creation-workspace.tsx`, `use-logo-engine.ts` |
| S3 | Logo concept batch polling | Implicit | `logo-creation-workspace.tsx` |
| S4 | Logo workspace saves (one lock for five operations) | Implicit | `use-logo-workspace.ts` |
| S5 | Creative direction round | Implicit lock plus flags | `identity-generation-controller.ts`, `visual-directions-page.tsx`, `visual-directions-view.tsx` |
| S6 | Refinement follow-up, saved-inputs preparation | Partly explicit | `refinement-history.ts`, `saved-inputs-controller.ts` |
| S7 | Naming choices (heart, save, choose) | Implicit lock | `use-project-naming.ts` |
| S8 | Plans page | Implicit | `plans-workspace.tsx` |
| S9 | Asset library, asset detail, downloads, domain and handle checks, media frame, logo reveal | Explicit or well guarded | their own files |

**The same server situation shows three ways** (reported, from reading all three screens):

| Situation | Naming | Logo | Creative direction |
|---|---|---|---|
| Stop asked, still running | "Stopping…", Stop disabled | Reply-box Stop stays clickable | Stop removed only in the tab that pressed it |
| Stop request fails | Message with Try again | Nothing shown | Message |
| A status check fails | Progress and Stop disappear while the run continues | Silent, retries | Message, keeps checking |
| Out of credits | Try again stays enabled and is refused again | Message, Send disabled | Message, Send disabled |
| Daily limit | Try again enabled, refused again | No message inside the Workspace | "Check availability" |
| First load fails | Message with Try again | "Getting ready…" with no end | Message with Check |

Other reported defects:

- **S2.** **Fixed.** Inside the Workspace a refused Logo request now shows its reason, and a refinement
  or a round that failed, timed out or was stopped says so (`logoRunEndSentence` in
  `src/domain/logo-engine.ts`). Still open: outside the Workspace a refused "Retry N failed" shows
  nothing.
- **S3.** **Fixed.** A failed read while concepts are drawing keeps polling.
- **S1.** **Fixed.** Leaving the Naming step mid-request no longer leaves "Stopping…" or "Generating
  names…" stuck; an unanswered start comes back as "couldn't be confirmed" with Try again, which repeats
  the same request.
- **S5.** The status check holds the same lock as Stop and Start, so a Stop pressed during a check is
  dropped without a message.
- **S4.** A second save or reload while one is running returns "could not be loaded", which is false.

## Order of work

Each line is one change: declare the machine and replace its copies first, then fix what it exposes.

Done on November 14: R4 (deletion stops runs), S1, S2 and S3 (the defects above), J3 (one save status),
and the two visible results of J1. What remains, in order:

1. **R2 with S1, S2, S5**: move the three AI screens to `startRefusal` and one "run to words" function,
   so the table above becomes one column.
2. **J1 and J2**: one "which steps are done" function read by the bar, the card and the conversation,
   after the owner answers the brief-edit question.
3. **R5 and R6**: one job-state declaration; decide what `partial` means.
4. The large components (J4, J5, J7, S2) move to a reducer each, after 1 and 2 have removed most of
   their flags.

## Adding or changing a machine

- Find it here first. If it is Declared, change the declaration and its test together.
- If it is stored in the database, change the migration, the declaration and the test in one change.
- If you find a machine that is not listed, add a row before you change it.
