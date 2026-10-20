# Recoverable application rendering errors

Issue: [#42](https://github.com/mikaelcharbonneau/embel/issues/42).

## Boundaries

- `src/app/error.tsx` handles unexpected child-route rendering failures beneath
  the root layout. The existing AppShell, navigation and account providers stay
  mounted. The fallback does not import or modify their state.
- `src/app/brands/account/[projectId]/error.tsx` uses the same fallback beneath
  the project layout, retaining that layout for child-page failures. Failures in
  the project layout itself bubble to the root route boundary.
- `src/app/global-error.tsx` replaces the root document for root-layout failures.
  It has its own HTML, body, title and minimal inline styles. It requires no
  account provider, router hook, font download or shared style sheet.

The installed Next 16.3 error-file reference recommends `retry()` to re-fetch and
re-render the failed segment. Recovery is user initiated only; there is no timer,
automatic reset, full reload or mutation replay. Route Home navigation uses
Next Link without prefetch. The global Home link intentionally navigates a new
document because the root router may have failed; its copy warns about unsaved
changes before that action.

## Data and accessibility guarantees

The fallback never reads, renders or logs the supplied error (including message,
stack or digest). It never clears browser storage or session memory and never
claims that unacknowledged changes are saved. Owner-bound drafts survive a
child-route failure only insofar as they already live above that boundary. Local
component state can be lost when a failed subtree unmounts. Global failures can
unmount the providers themselves, so retry cannot promise to restore unsaved
in-memory data. Existing persistence and recovery contracts remain unchanged.

Each fallback is an announced alert with a named heading. On mount, focus moves
to that heading; retry and Home remain native keyboard-focusable controls. Normal
handled API responses (sign-in-required, not found, save failure) remain the
page's responsibility; these boundaries do not reclassify or retry them.

## Local verification

`tests/client/recoverable-error-boundaries.test.tsx` uses jsdom, the actual Next
ErrorBoundaryHandler, the actual AppShell/account provider and synthetic API
responses. It covers a child render exception, explicit retry after persistent
and resolved failures, stable shell/provider/draft identity, no additional API
requests, safe rendered output, focus/alert semantics, ordinary handled API
states, and the standalone global document and action.

These checks are not a browser, production build, live account, provider, or
full Next router integration acceptance. In particular, production navigation
and global root-failure recovery should receive a browser smoke test before
release; no production fault-injection route was added.

Verification on 2026-10-20: the focused boundary, existing shell-stability and
account-draft-memory suites passed together (3 files, 15 tests, one worker).
Targeted ESLint covers the three boundary files and the new test file.
