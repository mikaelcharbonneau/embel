# Naming brain verification — 2026-10-16

This is **partial-source local QA**, not final Task 6 qualification or activation.
The QA checkout is `/Users/mikael/.codex/worktrees/naming-contracts/embel`, isolated
from preview port 3105 and shared browser tabs. Its starting Git revision is
`3abfa6571087a518e013bb88b7d7acb4ab302064`; it has its own APFS dependency clone and
no copied credentials/runtime files. Reviewed backend/runtime source is still
pending integration. No full-suite/final matrix is claimed on this checkpoint.

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
The final frozen QA checkpoint comprises that base plus the seven owned files in
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

The runtime owner separately supplies the self-contained SDK/scoped-store/SQL
coupling test against repository-local migration/fixtures: initial100 publication,
actual rendered request hashes and Creator provenance, gap phases where feasible,
and observation-only recovery. Local client/domain/component results and PGlite
role/RLS tests are distinct evidence classes. None proves native process login,
pooler `session_user`, concurrent advisory locks, live model access, provider
retrieval, account funding or final invoiced charges. Those remain separately gated
in [the activation packet](naming-brain-activation-20261016.md).
