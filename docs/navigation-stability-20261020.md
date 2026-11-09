> **Archived November 9, 2026.** Historical record; it may not match the current code. Current architecture and plan: [architecture-review.md](architecture-review.md).

# App-wide navigation and refresh stability

## Approved scope

On 2026-10-20 the user requested fixing flashing and disappearing interface
components, then clarified that the sidebar was only one example and the problem
appeared across the application. This increment addresses shared shell/session
causes and unnecessary refresh replacement in Ideas, Assets, reference media,
Identity boards and saved Logo previews. It does not redesign the pages or relax
account verification, and it is not a claim that all visible loading is removed.

## Findings and implementation

### Persistent shell and honest account states

- The root layout already owns a persistent `AppShell` and account providers, and
  sidebar navigation already uses Next.js `Link`. No router/provider restructuring
  or cross-route page cache was added.
- Sidebar links previously selected different artwork components and image URLs
  by route. They now consistently use the existing inline `Icon` set and approved
  `AppMark`; the expand toggle also keeps one icon. Active-link styling, labels,
  `aria-current`, expanded state and keyboard focus remain intact. `/brands/new`
  now uses the same concept shell rather than dropping to a different shell.
- Projects no longer changes sidebar artwork when its collection becomes empty;
  the obsolete empty/populated shell selectors have been removed.
- The account header reserves a stable responsive label width and displays a
  nonanimated neutral placeholder during session verification and the first
  profile load. Only a confirmed signed-out session receives the header label
  “Sign in”. Verification failures use “Account”; a verified account without an
  available profile uses “My account”. The account-action panel also avoids a
  transient sign-in action while verification is pending.

### Activation-aware account verification

- Automatic focus/visibility events share an existing in-flight session read
  within the same activation instead of repeatedly aborting and restarting it.
  The first required check still immediately publishes `checking`, invalidates
  the previous account generation and hides private consumers.
- A blur or hidden-document event aborts the pending read and records that the
  next activation requires a new check. A real later return therefore supersedes
  an unresolved earlier read rather than allowing a pre-departure account result
  to reappear. A startup read in a hidden document, or an explicit refresh while
  inactive, cannot consume this return fence.
- Explicit refresh still supersedes an earlier read. Sign-in/out serialization,
  authentication suppression, owner/generation fencing and draft recovery remain
  in force. Cleanup only clears its own request, not a newer replacement.
- Session HTTP acknowledgement now uses the existing 30-second bounded request
  helper. A stalled or non-abortable response cannot hold automatic checks open
  indefinitely or publish after its timeout. This is not a durable-job timeout,
  request cache or suppression window after a completed check.

### Owned preview continuity

- Asset, reference-media, Identity-board and saved-Logo preview effects use a
  semantic key rather than the identity of a freshly parsed metadata object.
  The key binds owner, project, asset, version and content hash, plus the relevant
  MIME/purpose/file-state/publication/verification evidence. State and effects
  also bind the exact verified client instance, so a new account generation does
  not reuse an earlier client's blob.
- Equivalent metadata refreshes retain the existing image node and checked blob.
  Changed identity or read eligibility immediately hides the old image, aborts
  the old request and releases its blob. Late responses are discarded/released;
  switching away and back cannot resurrect a released URL. Removed,
  metadata-only or invalid Asset versions no longer retain an old preview.
- Observation-only verification timestamps and project freshness do not change
  the underlying immutable bytes and therefore do not cause a new preview read.
  Existing authenticated byte/hash/MIME checks, private no-store transport,
  account fences and object-URL cleanup remain authoritative. No public image
  optimizer, shared preview cache or cross-route blob cache is introduced.

### Ideas and Assets refresh layout

- Ideas keeps the current verified grid while a changed filter loads instead of
  remounting the listing. A stable status slot explicitly says that previous
  results remain visible. Query identity, captured page/cursor, active request,
  account and generation fences prevent old pagination or A-to-B-to-A responses
  from entering the new listing. Every changed query starts at its first page.
- On a filter failure, previous results remain labelled as such and only the new
  query can be retried; the old query's pagination is not offered. Verification,
  generation and owner changes still remove the entire private listing.
- Assets always reserves one status slot rather than inserting/removing a loading
  paragraph above an already loaded grid. Background refresh says “Checking
  assets…” and leaves retained grid/image nodes in place under the existing
  library's account checks.

## Independent verification

The final source was checked with synthetic local Vitest/jsdom responses on
2026-10-20. All 21 selected suites passed: 334 distinct tests, zero failures.
Two runs executed 267 and 145 tests respectively; the 78 focused tests were
included in both and are counted only once in the distinct total.

The five new focused suites contain 78 tests:

- `tests/client/account-session-refresh-stability.test.tsx`: 9 tests for
  same-activation coalescing, later blur/hidden activation supersession, inactive
  explicit reads, initially hidden startup, explicit refresh, authentication,
  sign-out, timeout and stale-completion fences.
- `tests/client/app-shell-stability.test.tsx`: 6 tests for DOM continuity across
  13 routes, keyboard focus and expanded state, no route-driven session restart,
  Projects empty/auth-overlay transitions and honest private account labels.
- `tests/client/private-preview-stability.test.tsx`: 57 tests across all four
  preview consumers for equivalent-snapshot retention, all owned identity fields,
  client changes, late results/errors, unmount, return-to-key safety and changed
  MIME, file-state, publication and verification evidence.
- `tests/client/assets-refresh-stability.test.tsx`: 1 test for a stable status
  slot and retained grid/image nodes during an existing library refresh.
- `tests/client/ideas-refresh-stability.test.tsx`: 5 tests for retained filtered
  results, cursor isolation, late pagination/query responses, error recovery,
  account-generation changes and mismatched response ownership.

Sixteen existing suites contributed 256 additional passing tests:

- Client account/profile/auth: `account-profile-provider`,
  `account-project-session-recovery`, `account-signup-session`,
  `sign-in-transient-password`.
- Client library/preview/Logo: `asset-library`, `identity-references`,
  `logo-creation-client`, `logo-creation-refresh`, `logo-refinement-gallery`,
  `ideas-client`, `account-logo-client`, `project-identity`,
  `use-logo-workspace`, `logo-refinement-workspace`.
- API and server: `tests/api/asset-previews.test.ts` and
  `tests/server/asset-previews.test.ts`.

These checks include the existing actual-workspace regression that removes Logo
comparison metadata and private image URLs when the verified account changes.
Independent source/test review found no remaining blocker in this increment.
The lead's final production build passed, including its TypeScript check, and
final changed-file lint passed; the reviewer checked both successful exit records
and logs. The lead also reported a passing earlier full lint run. Publication and
live deployment verification remain separate from these local results.

## Remaining limits and privacy boundary

No browser visual acceptance, screenshots or live production interaction were
performed for this increment. DOM continuity and fixture tests establish the
specific state/lifetime behavior above, not production visual acceptance across
every screen, viewport, network condition or route transition.

Private content still hides during a genuine account recheck; keeping a previous
private account visible while identity is unverified is not an acceptable flicker
fix. Initial page loads, genuine account/client/version changes, unavailable
files, and route-specific content can still show loading states. There is no new
cross-route cache. Existing owner and generation fences, sign-in/out ordering,
unsaved-edit recovery and private preview verification remain intact.

This increment changes no database schema, grants, provider policy, credentials
or saved user content. Separate SQL/AI-availability work is not part of this
20-file presentation/session patch.

## Change inventory

Fourteen application files:

- `src/components/workspace/app-shell.tsx`
- `src/components/workspace/account-access.tsx`
- `src/components/workspace/account-session.tsx`
- `src/components/ideas/ideas-workspace.tsx`
- `src/components/assets/private-preview-identity.ts`
- `src/components/assets/asset-preview.tsx`
- `src/components/assets/assets-workspace.tsx`
- `src/components/identity/reference-preview.tsx`
- `src/components/identity/identity-system-board.tsx`
- `src/components/logo-creation/verified-preview.tsx`
- `src/styles/concept-shell.css`
- `src/styles/projects.css`
- `src/styles/ideas.css`
- `src/styles/assets.css`

The five focused test files listed above and this document complete the 20-file
inventory. The bounded HTTP helper is pre-existing and unchanged.
