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
| R3 | Workflow stop check (not running, stop asked, paused) | **Declared** | `runStopDecision` in `src/server/engine/stop-check.ts`, called by every workflow and run module |
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

- **Fixed** (migration `20261114140000_run_lifecycle_gaps`): `cancel_generation` leaves a finished run
  untouched, and a CHECK ties `finished_at` to a finished status.
- **Fixed:** a run that was admitted but whose workflow did not start answers `start_unconfirmed`, and
  the next status read restarts it after 15 seconds (`resumeUnstartedRuns`); `engine_claim` refuses a
  second claim.
- **Fixed** (owner decision, November 14): a Vercel cron calls `/api/maintenance/expire-runs` every 10
  minutes. `fluid_private.engine_expire_overdue_runs` ends every owner's overdue runs through
  `finish_generation_run`, so credits return by the normal rule. It runs while the engine is paused and
  never starts work. Migration `20261114150000_engine_expire_overdue_runs`.

**R2.** One rule: 400, 401, 402, 403, 404, 409, 413, 422 and 429 prove nothing started ("final"), and
so does the error code `generation_unavailable`, which the server sends only when nothing was admitted
(the step is switched off or paused). Everything else, including `start_unconfirmed` and any other 503,
may have admitted a run ("uncertain"): the request keeps its key, the screen says it could not be
confirmed, and Try again repeats the same key. `stepView` turns the run's phase and the last problem
into what the step may offer: progress, Stop, Start, Try again and one message kind. Strategy reads it
too, through `strategyJobsReport`.

**R3.** One function decides continue, quit or cancel. A run that no longer exists (its account was
deleted) ends quietly. Two callers pass `afterPaidCall` and ignore the pause on purpose: the image is
already paid for and only storing it follows.

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

A database test shows the unsettled reading of `partial` blocks nothing the app does (choosing a
direction, a new round, deleting and restoring a project all work after a partial round).

**R6.** The job is created `running` while the run is still `queued`, and a run can end `succeeded`
or `failed` with its job `partial`: two honest views of one round, left as they are. **Fixed:** a round
stopped or timed out after its third board now ends `succeeded`, matching its job and its kept credits.
The closing rule is one tested function. Logo has the same stop-after-every-image case, left because a
Logo run does not record how many images were asked.

**R7.** Checkout is refused with `billing_pending` while an earlier payment is still being confirmed, and
the webhook's sync time is taken before its Stripe read, so an older read cannot overwrite a newer one.
Opening Checkout first expires the account's earlier open Checkout pages
(`expireOpenCheckouts`), so two cannot both be paid. Two requests in the same instant take turns
(November 15): `billing_claim_checkout` gives one of them a 30-second claim on the account's billing row
and the other answers `checkout_opening` (409, Try again); the claim is given back as soon as the page
exists. If two subscriptions ever become live anyway (a page paid outside the app), credits are not
doubled, the person is charged twice, and the webhook logs `billing_second_live_subscription`. Nothing
is cancelled or refunded automatically. A switch to a smaller plan is not a new state of the
subscription: Stripe holds it in a schedule until the renewal, and the row carries it as
`pending_plan_id` (November 23; [payments.md](payments.md)). A plan that drops inside a paid period is
logged as `billing_plan_lowered_mid_period`.

### Journey and workspace

| # | Machine | Status | Where the rules live |
|---|---|---|---|
| J1 | "Is Strategy done?" | Two ledgers that now stay in agreement | `intake.guidedInterview` (`src/domain/guided-interview.ts`) and the `…ReviewedAt` fields; `briefChangedSinceStrategy` |
| J2 | Current step and done steps | **Declared** | `journeyProgress` in `src/domain/journey.ts`, read by the bar, the card, the handoff and the continuation |
| J3 | Save status ("Saving…", "Saved", "Not saved") | **Declared** | `accountSaveStatus` in `src/components/workspace/account-save-status.ts`, read by the bar and the page |
| J4 | Work-area view of the conversation | **Declared** | `workAreaView` and `workAreaReducer` in `src/components/workspace/guided-work-view.ts` |
| J5 | Guided turn coordinator | Decision **declared**; the effect still runs it | `guidedTurnAction` and `guidedActivity` in `src/components/workspace/guided-turn-coordinator.ts` |
| J6 | Session | **Declared** | `sessionView` and `sessionModeReducer` in `src/components/workspace/session-view.ts` |
| J7 | Home prompt start | **Declared** | `homeStartView` (`home-start-permissions.ts`: one rule each for the field, the controls and Send), `homeStartFormReducer`, `homeStartOpeningReducer` |
| J8 | Strategy job polling | **Declared** | `strategyJobsReport` in `src/components/workspace/strategy-jobs-view.ts`, built on `stepView` |
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

**J5.** **Fixed:** a save that is not confirmed releases its request key, so the step is tried again;
every save has error handling; a reply for an older version of the project says so instead of showing
an empty area. A message typed after the interview is complete no longer moves it back to Personality:
the stage stays `complete` and Embel answers in the chat.

**J7.** **Fixed.** One rule answers each question, and a click that would be ignored is a disabled
control. The form and the hook each still hold their own "opening a project" state; the opening screen
offers "Open saved project" if navigation stalls.

**J6.** **Fixed.** A refused sign-in (wrong password, too many attempts) leaves the ordinary signed-out
state; only a real failure to check the account says so. After a sign-up that awaits its email link, the
tab deliberately does not check the account by itself: an earlier account's cookies may still be in the
browser. Do not remove that.

### AI step screens

| # | Machine | Status | Where the rules live |
|---|---|---|---|
| S1 | Naming feed | Flags in shared memory; what it offers comes from `stepView` | `naming-brain-memory.ts`, `naming-feed-controller.ts` (`namingStepView`), `use-naming-feed.ts` |
| S2 | Logo screen | **Declared** (S6 start rule: `savedInputsStart` in `saved-inputs-controller.ts`) | `logoScreenView` (`logo-screen-view.ts`) and `logoScreenReducer` (`logo-screen-mode.ts`); timing refs stay in the component |
| S3 | Logo concept batch polling | Implicit | `logo-creation-workspace.tsx` |
| S4 | Logo workspace saves (one lock for five operations) | Lock kept; a held lock now answers "busy" and a reload waits its turn | `use-logo-workspace.ts` |
| S5 | Creative direction round | Lock plus flags; what it offers comes from `stepView` | `identity-generation-controller.ts` (`identityStepView`), `visual-directions-page.tsx`, `visual-directions-view.tsx` |
| S6 | Refinement follow-up, saved-inputs preparation | Partly explicit | `refinement-history.ts`, `saved-inputs-controller.ts` |
| S7 | Naming choices (heart, save, choose) | Queue instead of a drop | `use-project-naming.ts` |
| S8 | Plans page | **Declared** | `plansModeReducer` in `src/components/billing/plans-mode.ts` |
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

Known limit: the browser knows the credit balance, not what a step costs, so a start refused for
credits at a balance above zero leaves its button enabled on all three screens.

Other reported defects:

- **S2.** **Fixed.** Inside the Workspace a refused Logo request now shows its reason, and a refinement
  or a round that failed, timed out or was stopped says so (`logoRunEndSentence` in
  `src/domain/logo-engine.ts`), outside the Workspace too.
- **S3.** **Fixed.** A failed read while concepts are drawing keeps polling.
- **S1.** **Fixed.** Leaving the Naming step mid-request no longer leaves "Stopping…" or "Generating
  names…" stuck; an unanswered start comes back as "couldn't be confirmed" with Try again, which repeats
  the same request.
- **S5.** **Fixed.** A status check yields to Stop or Start, so neither is dropped; two starts still
  never run at once.
- **S4.** **Fixed.** A reload or save that finds the lock held no longer reports a failure.

## Order of work

Each line is one change: declare the machine and replace its copies first, then fix what it exposes.

Done on November 14: every machine in this file is declared or fixed except where a row says otherwise.
What remains:

1. The Home form and hook each hold "opening a project" (J7): the tests that would prove a merge safe
   replace the hook.
2. The Logo screen's timing refs stay refs; `logo-screen-mode.ts` says why for each (S2).
3. "Continue to Naming" on a brand saved before the guided conversation (no `intake.guidedInterview`)
   leads back to the same page: `src/domain/journey.ts` still points at `/naming`, which only redirects
   to the conversation, and the conversation shows no Voice section for such a brand. Only data older
   than the guided conversation is affected; the parked test in `tests/e2e/project-naming.spec.ts`
   reproduces it.

## Adding or changing a machine

- Find it here first. If it is Declared, change the declaration and its test together.
- If it is stored in the database, change the migration, the declaration and the test in one change.
- If you find a machine that is not listed, add a row before you change it.
