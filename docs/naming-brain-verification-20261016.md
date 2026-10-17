# Naming brain verification — 2026-10-16, updated 2026-10-17

This is **source-specific local evidence**, not final Task 6 qualification or
activation. The QA checkout is
`/Users/mikael/.codex/worktrees/naming-contracts/embel`, isolated from preview port
3105 and shared browser tabs. It has its own APFS dependency clone and no copied
credentials/runtime files. The reviewed backend/runtime and independently approved
R1–R3 safeguards are integrated at `069b8be4efa7fc00d7267e064d102c6daa11dc1f`.
That checkout was clean before the activation/architecture documentation update.
D071's chat-first/left-chat/right-grid implementation, remaining actual SQL
recovery cases and the final frozen integrated matrix are still pending. No final
whole-branch verification or live validation is claimed.

## Current reviewed checkpoint and remaining work

- The independent R1–R3 re-review approved the bounded fix delta at
  `669d201c1b629c153342d19959ca415ba6101359`; it was then integrated at `069b8be`.
  Recorded author/coordinator evidence at that earlier frozen source is 23/23 inert
  pilot checks and 6/6 affected desktop/mobile checks, direct TypeScript, scoped
  lint, production build and diff check. The reviewer independently ran eight
  additional inert receipt probes. These do not replace the final full matrix.
- The reviewed migration `20261016180000_naming_brain.sql` hashes to
  `b55c29851e1d11efdb00eb8d2831f256884e31501beab98c178c8b7220da1d8f` at `069b8be`.
  The shared preference implementation hashes to
  `7108319323898692a388fcf17cb542509583288b0d4b05d7384f8c5b707aeb01`.
- Separate actual SQL/store/pinned-SDK qualification in the `naming-runtime`
  worktree has passed its initial 150-to-100 and four gap/terminal-partial cases
  using migrated disposable PGlite and inert transports. The gap phase records
  29/29 focused tests: five actual SQL/SDK cases plus 24 existing handler/codec
  cases, with direct TypeScript, two-file ESLint and diff checks passing. Its source
  is `fd3939401412afe4b3b8fc79203f54a86851fa9d` plus the two uncommitted test files,
  SHA-256 `dbbeb7e23c5872b18de22b4dc7d6dd4fbb855acd031174fb378f2f0539ece246`
  (`naming-brain-sql-runtime.test.ts`) and
  `f89fef1d81b5320935531993340530349334fb0284ba2d61ee32aa4b44305a16`
  (`naming-brain-sql-runtime-fixture.ts`). These are source-specific reported
  results, not a rerun on `069b8be` or the final D071 source. Lost-acknowledgement /
  recovery and foreign-proof cases, combined review and final integration remain
  pending. The canonical phase report is the ignored
  `.superpowers/sdd/2026-10-16-naming-brain/sql-coupling-report.md`; logs are in
  runtime `.tmp/naming-brain-sql-gap-*.log`.
- The exact seven worker environment keys, nine scoped worker RPC signatures,
  actual Node entrypoint and unverified live requirements are recorded in the
  [activation packet](naming-brain-activation-20261016.md). Local key-presence
  inspection found no Naming credentials/configuration in the QA checkout; it did
  not read secret values, connect to services or activate a worker.

## Historical partial-source QA at `3abfa65`

The following commands and artifacts belong to the original QA base
`3abfa6571087a518e013bb88b7d7acb4ab302064` plus its then-owned QA files. They remain
useful historical evidence; they do not qualify the later integrated backend,
R1–R3 fixes or D071 chat correction.

## Evidence and exact scope

- `tests/e2e/naming-brain.spec.ts` drives the real production Next UI through
  explicitly intercepted, schema-checked synthetic routes. Fixtures never call
  providers, SQL, SDKs or DNS. It checks saved choices and initial100, scroll append,
  immutable anchors, likes during work, steering races, unsent direction retention,
  real history/filter Continue, inactive/hidden/stopped/non-exploration admission
  gates, terminal partial/unknown results, explicit linked Resume, same-owner exact
  replay, changed-owner late responses and one explicit standalone project creation.
- `tests/e2e/project-naming.spec.ts` uses saved V1 fixtures and explicit Saved names
  & history navigation. Immutable 250/50 history, selection, library and
  Workshop ancestry remain covered. Obsolete V1 preference-form assertions become
  preservation / explicit V2 upgrade checks: saved locale/notes/length bounds carry,
  approaches/directness stay unselected, mount/navigation does not upgrade or admit,
  and an explicit meaningful edit creates the next preferences version.
- `scripts/naming-brain-pilot.mjs` is opt-in source only. Its normal tests use inert
  fetch, a `.invalid` origin and synthetic session data. They verify default
  refusal, precise authority/origin, owner checks, redirects, held liabilities,
  aggregate/unknown blockers, receipt fences and one stable admission without retry.
  The runner does not establish deployment revision or complete pilot inventory;
  those are required operator read-backs described in the activation packet.

## Commands and interim results

| Command | Partial-source result |
| --- | --- |
| `./node_modules/.bin/eslint tests/e2e/naming-brain-fixture.ts tests/e2e/naming-brain.spec.ts tests/e2e/project-naming.spec.ts` | Passed; final scoped lint also includes the runner and its inert test. |
| `npm run build` | Passed again on partial3abfa65 plus all five final QA source/test files. Exit0. Prebuild seven-path hashes are recorded in `.tmp/naming-qa/prebuild-owned-manifest.json`; only this evidence document changed afterward. No credentials or runtime files copied. |
| `./node_modules/.bin/vitest run tests/qa/naming-brain-pilot.test.ts --configLoader runner --no-cache --no-fsModuleCache --maxWorkers=1` | 15/15 passed, one file, no skips. |
| `FLUID_E2E_PORT=3131 FLUID_E2E_BROWSER_CHANNEL=chrome npm run test:e2e -- tests/e2e/naming-brain.spec.ts --workers=1 --project=desktop` | Initial fixture pass:6 passed/4 failed; failures were selectors and incomplete synthetic history metadata, corrected before rerun. |
| Two-file desktop / desktop+mobile reruns | **116 passed (2.4m), zero failed/skipped:58 desktop +58 mobile.** Exact command: `FLUID_E2E_PORT=3131 FLUID_E2E_BROWSER_CHANNEL=chrome npm run test:e2e -- tests/e2e/naming-brain.spec.ts tests/e2e/project-naming.spec.ts --workers=1`. |
| Typecheck / full lint / full suite / final production+worker builds | Direct `tsc --noEmit --incremental false`, scoped ESLint of all five QA source/test files and `git diff --check` exit0. Whole-repository/final integrated matrix still pending lead freeze. |

The optional installed-Chrome override uses a **dedicated headless context**. The
repository Playwright server starts `next start` on3131 and refuses a reused
server. No SourceAtlas tabs or shared GUI are touched. Evidence lives under
`test-results/` and the QA report's ignored artifact directory; screenshots contain
synthetic records only. Failed preparation runs are retained as diagnostic history,
not reported as successful acceptance.

The Git base tree is `d87cc26e31503178dea3094ea9889235e060e97b`.
That historical frozen QA checkpoint comprises that base plus the seven owned files in
`.tmp/naming-qa/final-owned-manifest.json`. The complete tracked-source-plus-owned
content manifest is `.tmp/naming-qa/source-tree.sha256`. The lead handoff report
records every owned SHA-256 and the composite source digest.

Logs are in `.tmp/naming-qa/`: `naming-both.log` (116 checks),
`pilot-tests-final.log` (15 checks), `owned-tsc.log`, `owned-lint.log`, and
`partial-production-build-final.log`. The final browser run produced18 synthetic
PNG captures in `test-results/`; `.last-run.json` says passed with no failed tests.
Representative captures are `naming-brain-Naming-V2-exp-b2b6a-never-on-mount-then-restore-{desktop,mobile}/synthetic-initial100.png`
and `project-naming-project-des-759ed-ns-the-Naming-choices-draft-{desktop,mobile}/project-naming-controls.png`.
No current product-source defect was established. Preparation failures were
corrected fixture/selectors: accessible labels, explicit V1 history navigation,
ascending legacy cursors, missing synthetic origin fields and saved-history
metadata. The remaining native database/provider gates were not executed.

## Required final integration matrix

After the lead advances and explicitly freezes the integrated source, record the
full commit/tree and every owned-file SHA-256, then run typecheck, lint, `npm test`,
production build, `build:api-text-worker`, a separate inert build of the dedicated
Node `worker/index.ts` graph, and both Naming E2E files on desktop/mobile. Record
commands, exit status, counts/skips, artifact paths and any source edit after each
broad run. Do not mix output from a moving tree or infer graph equivalence from the
hosted Strategy build.

The runtime owner separately completes and integrates the self-contained
SDK/scoped-store/SQL coupling tests against repository-local migration/fixtures:
initial100 publication, actual rendered request hashes and Creator provenance,
the gap/terminal-partial paths already qualified on their recorded source, and the
remaining lost-acknowledgement/observation-only and foreign-proof cases. Run their
final integrated form after review. Local client/domain/component results and PGlite
role/RLS tests are distinct evidence classes. None proves native process login,
pooler `session_user`, concurrent advisory locks, live model access, provider
retrieval, account funding or final invoiced charges. Those remain separately gated
in [the activation packet](naming-brain-activation-20261016.md).
