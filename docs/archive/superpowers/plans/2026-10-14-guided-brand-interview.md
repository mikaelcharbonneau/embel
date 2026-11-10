> Archived November 10, 2026: describes the system before the generation engine.

> **Archived November 9, 2026.** Historical record; it may not match the current code. Current architecture and plan: [architecture-review.md](../../../architecture-review.md).

# Guided Brand Interview Implementation Plan

> **Historical work breakdown:** The ownership below records the implementation split; the lead handled integration and commits. This plan does not assign a new task or authorize additional agents.

**Goal:** Replace the cluttered project conversation with a durable guided interview and real competitor-research loading screen.

**Architecture:** A versioned interview state references actual user turns and immutable owned AI results. Presentational choice widgets are separate from account orchestration. Existing durable jobs admit exact bounded research and text policies.

**Tech Stack:** Next.js 16.3.8, React 19, TypeScript, Zod, Supabase Postgres, OpenAI Responses, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-14-guided-brand-interview-design.md`

## Global Constraints

- Product name Embel; existing FLUID identifiers stay compatible.
- No nested delegation or specialist commits.
- No fake research, generated historical replies, preselected recommendations or forced waiting time.
- Preserve ownership, immutable revisions/results, exact workload identity, cancellation, reservation and uncertainty fences.
- Use the existing checkout; preserve unrelated changes.

## Review Focus

- Custom clarification must stay at the current stage; custom answers must not become generic brief rewrites.
- A late response from an earlier revision or account must not enter the current conversation.
- A lost save/enqueue acknowledgement must retain the original request identity and prevent duplicate paid execution.
- Revisiting an earlier decision must keep history and clear downstream approval.
- A failed/cancelled research job must stop the logo screen and retain the original prompt.

### Task 1: Contracts and provider — guided_contracts_provider

Files: `src/domain/guided-interview.ts`, `src/domain/projects.ts`, `src/domain/strategy-jobs.ts`, `src/server/ai/strategy-response.ts`, focused domain/provider tests.

- [x] Define `GuidedInterviewState`, `GuidedTurn`, `GuidedReply`, typed options, exact turn binding and bounded versioned schemas; retain legacy readers.
- [x] Add pure initialization, turn append and explicit selection/custom acceptance helpers. Verify three-stage order, recommendation non-selection, clarification and upstream invalidation.
- [x] Add version-2 API input with frozen assistant history and guided handler output. Verify source matching, recommendation reasons and custom response interpretation.

### Task 2: Runtime policy and database — guided_research_runtime

Files: worker/runtime and server admission policy files, a forward migration, focused database/runtime tests. Task 1 owns all shared domain/provider files.

- [x] Define exact versioned policies and prove conservative billable search bounds from official documentation.
- [x] Freeze owned assistant history at admission; validate optional interview state at canonical database boundaries.
- [x] Implement per-operation private testing access for the interview, with ownership, immutable admission, role, cost, uncertainty, cancellation and legacy-compatibility checks. This completed source task does not enable new runtime grants.
- [x] Produce a reviewable migration and activation receipt; no model calls during verification.

### Task 3: Presentational widgets — guided_interview_widgets

Files: `src/components/workspace/guided-interview-widgets.tsx`, `src/styles/guided-interview.css`, focused component tests.

- [x] Use the original approved logo for a reduced-motion-aware research screen.
- [x] Render accessible detailed competitor, audience and personality choices from Task 1 contracts; no default selection.
- [x] Verify separate source links, controlled selections, Continue and previous-answer review behavior.

### Task 4: Account and Home integration — lead

Files: account Strategy editor/orchestration, Home start, project draft adapter, account editor save behavior, project/shell chrome, composer and integration tests.

- [x] Start research directly from the initial prompt and preserve recovery receipts; show the logo screen during actual pending work.
- [x] Save turns/choices with revision fencing; bind each trusted result to its originating turn. Drive only the next relevant operation.
- [x] Keep the composer available for custom input and clarification; autosave decisions and restore on reload. Retain conflicts/recovery without legacy clutter.
- [x] Remove superseded conversation chrome and use the approved square send geometry.

### Task 5: Integration verification and review — lead

- [x] Run focused domain/provider/client/database tests and isolated browser checks for the full three-stage flow, reload, custom answers, clarification, stale output and cancellation.
- [x] Review the integrated diff, resolve material findings and run typecheck, lint and production build.
- [x] Record exact source/runtime verification and outstanding live-only limitations outside the checkout; report what is actually ready.

Verification receipts live outside the checkout in `/workspace/scratch/embel-guided-interview-20261014/`. The production build, TypeScript, ESLint, focused domain/provider/client/runtime/database checks, independent frontend/backend reviews and isolated desktop/mobile browser cases passed. Browser fixtures and rollback-only database rehearsals made no provider requests; a live competitor search remains a separate acceptance check.
