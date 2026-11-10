> Archived November 10, 2026: describes the system before the generation engine.

> **Archived November 9, 2026.** Historical record; it may not match the current code. Current architecture and plan: [architecture-review.md](../architecture-review.md).

# Complete local source synchronization — 2026-10-18

## Historical scope and preservation

This workstream concerned reconciling the complete local source with shared
`main` and aligning `/Users/mikael/embel` to the reviewed revision. The results
below are historical evidence, not permission for another publication, merge,
checkout update or process restart.

The complete non-ignored source was preserved before reconciliation: 2,025 files
from local HEAD `b2ff6ce8bbc2f176625bf4b4bff6132eb5e4bf75`, including all
uncommitted and untracked source. The private source archive, status, patch and
SHA-256 manifest are under `/private/tmp/embel-all-source-sync-20261018/`.
Protected runtime configuration has a separate private preservation check;
credentials and generated output are excluded from Git.

Branch `codex/sync-local-app-20261018` preserves the complete source in commit
`19a25f8` and reconciles it cleanly with remote main
`a26a30f631eb22f631f0a05d90c30d3998a2cd1b` in `c7260f5`. This includes the
previously unpublished Naming history, progressive generation and scrolling,
Luna Strategy/Naming policies, local supervisor/recovery/maintenance, Home and
auth fixes, tests and SQL source, alongside the already merged Inspiration,
logo generation/refinement and brand board work. No legitimate local source was
excluded because it was considered a separate task.

The installed Next.js TypeScript guide requires generated `next-env.d.ts` to be
ignored. Its local file is retained, while Git tracks the ignore rule rather
than development/production-specific generated type paths.

## Review corrections

Independent review found that the new Earlier AI requests presentation had lost
the existing Cancel request action. It is restored for queued/running legacy
requests, with verified-account fencing, exact-job response validation, safe
retry and late-account-response rejection. New generation continues through
project Naming. All 13 focused legacy UI tests pass, including four added cases.

Two browser assertions now match the approved prompt-retention/unavailable copy.
The native callback browser test explicitly requires its configured trusted
application origin to match the browser server. Isolated production port 3117
has no approved HTTP callback origin; the browser case is skipped there rather
than relaxing the production origin policy. Actual redirect/header/cookie
security remains covered by the passing API and SSR suites.

## Final verification

| Check | Result |
| --- | --- |
| Whole-project TypeScript/type generation | Passed after final test corrections |
| Whole-project ESLint | Passed after final test corrections |
| Production build | Passed with final application code |
| Complete Vitest suite, `--maxWorkers=2` | 9,297 passed in 652 files; 23 optional native-PostgreSQL tests skipped in two files; zero failures |
| Changed-flow browser qualification | 260 distinct desktop/mobile cases passed across the complete selected run and focused corrections; two callback-origin browser cases skipped |
| Dedicated logo/brand board browser suite | All 38 passed |
| Initially intermittent saved-refinement case | Six isolated desktop/mobile repetitions passed, followed by the complete 38-case passing suite |
| Independent runtime/security and UI review | No remaining evidenced blocker in reviewed changes |
| Source preservation, whitespace and credential-pattern checks | Passed |

Browser qualification uses dedicated headless Chrome and intercepted synthetic
account/provider responses, without the shared browser or existing tabs. The
12 changed-flow files cover account creation, auth/overlay, Home recovery,
guided Strategy, Inspiration, current Names entry, Naming brain/chat/layout,
progressive scrolling and project Naming. The initial 262-case run passed 256;
two obsolete signup-copy assertions and two absent-origin callback cases failed.
After the corrections, account creation passed 12 with two explicit origin
skips, and unconfigured sign-in passed both desktop/mobile cases. Combined with
the unchanged passing cases, that establishes the 260 distinct passed cases.

Evidence logs are private local files:

- `/private/tmp/embel-all-sync-tests.log`
- `/private/tmp/embel-all-sync-typecheck-publish.log`
- `/private/tmp/embel-all-sync-lint-publish.log`
- `/private/tmp/embel-all-sync-build-final.log`
- `/private/tmp/embel-all-sync-browser-final.log`
- `/private/tmp/embel-all-sync-signup-browser.log`
- `/private/tmp/embel-all-sync-unconfigured-auth.log`
- `/private/tmp/embel-all-sync-logo-browser-final.log`

An earlier broader 872-case historical browser run was stopped after discovering
retired anonymous-project/composer assumptions, incomplete project lifecycle
fixtures, a baseline Assets geometry assertion and bundled-browser renderer
crashes. It is not claimed as a pass. Current Home/auth cases then passed in
serial installed Chrome. Historical unrelated browser fixtures still require
maintenance; this source synchronization does not claim all 872 cases pass.

No new paid inference, live migration, credential provisioning or hosted
deployment was performed for publication. Prior real local Luna and logo
acceptance remains separately documented in `local-prototype.md` and
`logo-local-activation-20261018.md`.

## Local alignment after merge

Preserve the original checkout's dirty state as recovery, fast-forward its local
`main` to the verified merged revision, retain protected ignored configuration,
and restart the current port-3105 preview from that checkout. Completion requires
identical local HEAD and remote main, a clean tracked/untracked source status,
and successful local route smoke checks. The separately retained production
preview and dedicated workers keep their existing configuration.
