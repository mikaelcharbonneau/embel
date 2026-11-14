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
| R2 | Start refusals and what a step may offer | **Declared** | `startRefusal` and `stepView` in `src/domain/generation-run.ts`, read by Naming, Logo and Creative direction; shared sentences in `src/domain/generation-words.ts` |
| R3 | Workflow stop check (not running, stop asked, paused) | Implicit | about 15 inline copies in `src/workflows/*.ts` and `src/server/engine/*-run.ts` |
| R4 | Project deletion | Implicit, derived | SQL `project_deletion_state`, `request_project_deletion`, `restore_project_deletion`; `src/domain/project-deletion.ts` |
| R5 | Old job state (`jobs.state`, still written for Logo and Creative direction records) | **Declared** | `src/domain/jobs.ts` (named sets, allowed moves); SQL guards |
| R6 | Creative direction round (run status + job state + fulfillment) | Rule declared, three records remain | `identityRoundJobState` in `src/domain/identity-jobs.ts` mirrors SQL `engine_identity_close_job` |
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

**R2.** One rule: 400, 401, 402, 403, 404, 409, 413, 422 and 429 prove nothing started ("final");
everything else, 503 included, may have admitted a run ("uncertain"). An uncertain start keeps its
request key, says it could not be confirmed, and Try again repeats the same key. `stepView` turns the
run's phase and the last problem into what the step may offer: progress, Stop, Start, Try again and one
message kind. Known cost: a step that is switched off also answers 503, so it reads "couldn't be
confirmed" rather than "unavailable". The cure is for the start route to stop answering 503 for an
admitted run whose workflow did not start (it does today; Naming answers 500 for the same case).

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

**R5.** `partial` means a finished job that delivered some but not all of its results. Three readers
treat it otherwise (still unsettled in the SQL guards, failed in `logo_job_observation`, its own group
in the Activity list); that is unchanged and now written next to the declaration. The differing "active"
lists are named sets (`isJobWorking`, `isJobWorkingOrUnconfirmed`, `isJobWorkingOrPartial`,
`isJobUnsettled`), each proven equal to the list it replaced. Why Strategy alone counts `partial` as
working is not recorded. Two hand-written lists remain outside the declaration:
`src/server/data/identity-asset-store.ts` and `src/features/identity-directions/server/fonts.ts`.

**R6.** The job is created `running` while the run is still `queued`. A round stopped after its third
board has run `cancelled` and job `succeeded`. The step's own routes read the job; `/generations` reads
the run. The closing rule is one tested function: three boards succeeded; else a cancelled run
cancelled; else some boards partial; else failed.

**R7.** Nothing in the database stops two live subscriptions for one account; the only guard is a check
in `src/server/billing/sessions.ts`. The plan on the account and the plan on the subscription can differ
between a downgrade and the next invoice. (reported)

### Journey and workspace

| # | Machine | Status | Where the rules live |
|---|---|---|---|
| J1 | "Is Strategy done?" | Two ledgers that now stay in agreement | `intake.guidedInterview` (`src/domain/guided-interview.ts`) and the `…ReviewedAt` fields; `briefChangedSinceStrategy` |
| J2 | Current step and done steps | **Declared** | `journeyProgress` in `src/domain/journey.ts`, read by the bar, the card, the handoff and the continuation |
| J3 | Save status ("Saving…", "Saved", "Not saved") | **Declared** | `accountSaveStatus` in `src/components/workspace/account-save-status.ts`, read by the bar and the page |
| J4 | Work-area view of the conversation | **Declared** | `workAreaView` and `workAreaReducer` in `src/components/workspace/guided-work-view.ts` |
| J5 | Guided turn coordinator | Decision **declared**; the effect still runs it | `guidedTurnAction` and `guidedActivity` in `src/components/workspace/guided-turn-coordinator.ts` |
| J6 | Session | Implicit, overloaded `error` | `account-session.tsx` |
| J7 | Home prompt start | **Declared**, with its disagreements kept | `homeStartView` (`home-start-permissions.ts`), `homeStartFormReducer`, `homeStartOpeningReducer` |
| J8 | Strategy job polling | Implicit | `use-strategy-jobs.ts` |
| J9 | Project delete and restore dialog, profile save, home voice, auth forms | Explicit | `project-deletion-client.ts`, `account-profile-editor.tsx`, `use-home-voice.ts` |

Defects below are reported, not yet reproduced, unless marked fixed.

**J1.** Owner decision, November 14: a brief edit keeps confirmed Strategy answers and progress, and
nothing is locked. The edit no longer clears anything, so the two ledgers agree. A notice, "Your brief
changed", offers "Redo Strategy" (the normal revisit from Competitors, at its normal credits).
`briefChangedSinceStrategy` compares the description with the brief Strategy was made from, which the
conversation already records; no new saved key. Projects whose confirmations an earlier edit cleared are
not migrated: they show "Your strategy needs another look" with a button for the step to review. The
unsaved browser-draft editor (`project-editor.tsx`) still clears confirmations on a brief edit.

**J2.** One function returns the four steps and their parts as done, current or upcoming, plus the next
action. Personality is under Voice everywhere; an open Slogan is the next step; a skipped Slogan counts
as done. The conversation still derives its own open and closed sections from its stage and local flags
(J4).

**J3.** **Fixed.** The bar and the page read one function, so a failed save reads "Not saved" in both.
"Saved" is only shown from a server-confirmed version with nothing pending.

**J4.** A typed message on a finished interview moves it back to Personality and hides the Identity
section. A reload returns to Inspiration until the logo has saved state.

**J5.** The decision function records what it found and did not change: a request key is marked as
tried before its save is confirmed; three error messages cannot be reached; the clarification save has
no error handling. (verified while extracting)

**J7.** `homeStartView` returns five separately named answers because the old checks disagree, and the
disagreements are kept and named in `tests/client/home-start-permissions.test.ts`: the prompt can look
editable while edits are ignored; a prompt hidden because it belongs to another account leaves Send
enabled but the click does nothing; a locked Strategy makes the field read-only but not Send. Each is a
candidate fix. The form and the hook each still hold their own "opening a project" state.

**J6.** A wrong password leaves the account menu saying the account could not be checked, instead of the
signed-out invitation.

### AI step screens

| # | Machine | Status | Where the rules live |
|---|---|---|---|
| S1 | Naming feed | Flags in shared memory; what it offers comes from `stepView` | `naming-brain-memory.ts`, `naming-feed-controller.ts` (`namingStepView`), `use-naming-feed.ts` |
| S2 | Logo screen | **Declared** | `logoScreenView` (`logo-screen-view.ts`) and `logoScreenReducer` (`logo-screen-mode.ts`); timing refs stay in the component |
| S3 | Logo concept batch polling | Implicit | `logo-creation-workspace.tsx` |
| S4 | Logo workspace saves (one lock for five operations) | Implicit | `use-logo-workspace.ts` |
| S5 | Creative direction round | Lock plus flags; what it offers comes from `stepView` | `identity-generation-controller.ts` (`identityStepView`), `visual-directions-page.tsx`, `visual-directions-view.tsx` |
| S6 | Refinement follow-up, saved-inputs preparation | Partly explicit | `refinement-history.ts`, `saved-inputs-controller.ts` |
| S7 | Naming choices (heart, save, choose) | Implicit lock | `use-project-naming.ts` |
| S8 | Plans page | Implicit | `plans-workspace.tsx` |
| S9 | Asset library, asset detail, downloads, domain and handle checks, media frame, logo reveal | Explicit or well guarded | their own files |

**The same server situation now shows one way** on Naming, Logo and Creative direction (`stepView`):

| Situation | What every AI screen does |
|---|---|
| Stop asked, still running | Says it is stopping; Stop is not offered again, in any tab |
| Stop request fails | "Stop couldn't be confirmed." with Try again |
| A status check fails | Progress and Stop stay; a quiet note says updates are delayed; it keeps checking |
| Out of credits | The out-of-credits message; no Try again that would be refused |
| Daily limit | The today's-limit message; no Try again that would be refused |
| First load fails | A message with Try again |
| Start may have been admitted | "Couldn't be confirmed"; Try again repeats the same request |

Remaining differences: Logo still offers Send after an unconfirmed start once it finds no working run
(Naming and Creative direction wait for the kept request); Naming cannot disable "Suggest more names"
at zero credits because it reads no balance; Creative direction's delayed-status message is still a
warning with "Check availability" rather than a quiet note.

Other reported defects:

- **S2.** **Fixed.** Inside the Workspace a refused Logo request now shows its reason, and a refinement
  or a round that failed, timed out or was stopped says so (`logoRunEndSentence` in
  `src/domain/logo-engine.ts`). Still open: outside the Workspace a refused "Retry N failed" shows
  nothing.
- **S3.** **Fixed.** A failed read while concepts are drawing keeps polling.
- **S1.** **Fixed.** Leaving the Naming step mid-request no longer leaves "Stopping…" or "Generating
  names…" stuck; an unanswered start comes back as "couldn't be confirmed" with Try again, which repeats
  the same request.
- **S5.** **Fixed.** A status check yields to Stop or Start, so neither is dropped; two starts still
  never run at once.
- **S4.** A second save or reload while one is running returns "could not be loaded", which is false.

## Order of work

Each line is one change: declare the machine and replace its copies first, then fix what it exposes.

Done on November 14: R4 (deletion stops runs), R2 with S1, S2, S3 and S5 (one refusal rule and one
step view), J4, J5, J7 and S2 (the four large screens, no behavior change), J1 and J2 (one journey progress, brief edits keep answers), J3 (one save status), R5 and R6
(job state declared). What remains:

1. The start route answers 503 both for "switched off" and for "admitted, workflow did not start" (R2).
2. The three records of a Creative direction round (R6) and the three readings of `partial` (R5).
3. The remaining differences listed under the table above.
4. R3, the workflow stop check, about 15 inline copies with two that leave out `paused`.
5. The disagreements and oddities that the J5 and J7 declarations preserved.
6. J6 (session), J8 (Strategy polling), S4, S7 and S8 are still implicit.

## Adding or changing a machine

- Find it here first. If it is Declared, change the declaration and its test together.
- If it is stored in the database, change the migration, the declaration and the test in one change.
- If you find a machine that is not listed, add a row before you change it.
