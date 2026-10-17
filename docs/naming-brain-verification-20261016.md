# Naming brain verification — 2026-10-16, updated 2026-10-17

## Final measured code checkpoint

The complete local matrix passed on frozen code `d654d62fcbaaddad0002eff088bbf0983d97d6c9`,
tree `483278cbdc0ce6f6d9100b53cdf122a5dc075b59`. All 1,907 tracked-file hashes were
unchanged before/after; full manifest SHA-256:
`ba317ea3b0a61046da8564b14ee740f4bf1a072f0a7e58f48d7b69af301c800a`.

Independent scoped repair review approved F1–F7: **7 addressed / 0 open / 0 new**.
[Final frozen-run report](/Users/mikael/embel/.superpowers/sdd/2026-10-16-naming-brain/final-checks-sol-report-d654d62.md) and [scoped review](/Users/mikael/embel/.superpowers/sdd/2026-10-16-naming-brain/final-fix-scoped-review.md)
retain exact commands, counts, manifests and artifacts. QA remains the clean tested
checkout; this later four-file documentation-only follow-up is recorded separately
from the measured code and any eventual documentation commit. No tests or builds
were rerun for this status update.

| Final check on d654d62 | Result |
| --- | --- |
| Nonincremental typecheck / full lint | Exit 0 / exit 0 |
| Full unfiltered Vitest | 599 files: 597 passed, 2 intentional native gates. 8,659 tests: 8,636 passed, 23 gated, 0 failed. |
| Former setup-blocked vector coverage | All 232 bodies executed and passed; original 19 files have 233 passing cases total. |
| Exact ACL inventory | Full 13-test adversarial file passed, including every downstream signature/private-role assertion. |
| Production web build | Exit 0; QA build `pol5CmjC_PjOxdAunCA2f`. |
| Hosted API-text / dedicated Node worker builds | Both exit 0; separate graphs. Dedicated graph has 427 inputs and remains inert. |
| Seven browser specs | 172/172 passed (86 desktop + 86 mobile); zero failures/skips/retries. |
| Diff / source identity | Exit 0; clean d654d62 and unchanged full manifest. |

The only 23 gates are 18 `api-text-multi-account-postgres` cases and 5
`standalone-ai-names-postgres` cases. Their native PostgreSQL URLs were absent;
`test:live` was not run. Local PGlite/inert SDK/intercepted browser evidence does not
establish native login/pooler/concurrency, hosted tenant acceptance, live provider
access, creative quality, final billing, deployment or activation. Worker bundles
were built, not executed; the Node 24 target is not Node 24 runtime qualification.
All 13 [engineering rulings](naming-brain-engineering-decisions-20261016.md) and
[separate activation requirements](naming-brain-activation-20261016.md) remain.

The [verified local sample preview](http://127.0.0.1:3137/__preview) is an isolated
Git archive of d654d62, build `EjbFioaYQxauMXsNryONs`. Both actual-wrapper headless
flows pass, including refresh recovery, the same composer, 100→200 sample names,
favorite, steering, selection, reset and cookie/host/origin checks. It contains
synthetic names and simulated saves, with no live generation. Historical 3135/a13e94c
preview evidence remains preserved.

## Preserved failed matrix

The earlier frozen head
`72a1ea948b01342af958d12c476263ce538917cf` completed the full local matrix and
failed acceptance: 575 Vitest files passed, 20 failed,2 intentionally gated;232
vector test bodies were setup-blocked and one exact ACL assertion failed.
Browser results were165 passed/7 failed, including six Names bridge cases and one
mobile keyboard case. The whole-branch review requested F1–F6 corrections; the
keyboard result added F7. These results are preserved as failed evidence.

The complete red report remains preserved in
`final-checks-sol-report-72a1ea9.md` and its original ignored artifact directory;
the canonical report appends the new run rather than replacing that evidence.

## Historical source-scoped reviews and live limits

- The independent R1–R3 re-review approved the bounded fix delta at
  `669d201c1b629c153342d19959ca415ba6101359`; it was then integrated at `069b8be`.
  Recorded author/coordinator evidence at that earlier frozen source is 23/23 inert
  pilot checks and 6/6 affected desktop/mobile checks, direct TypeScript, scoped
  lint, production build and diff check. The reviewer independently ran eight
  additional inert receipt probes. These do not replace the final full matrix.
- The current local repair migration `20261016180000_naming_brain.sql` hashes to
  `f6ccb8ff3b5a8fd280defa311ec045d51fc18ae5d708e94a30b0f8d93a46044f`, independently confirmed at
  `d654d62fcbaaddad0002eff088bbf0983d97d6c9`. The local matrix and scoped re-review passed;
  this migration remains unapplied and live installation is separately gated.
  The earlier reviewed digest `b55c29851e1d11efdb00eb8d2831f256884e31501beab98c178c8b7220da1d8f`
  is historical and must not be used as the activation digest.
  The shared preference implementation hashes to
  `7108319323898692a388fcf17cb542509583288b0d4b05d7384f8c5b707aeb01`.
- The historical actual SQL/store/pinned-SDK gap phase in `naming-runtime`
  passed its initial 150-to-100 and four gap/terminal-partial cases
  using migrated disposable PGlite and inert transports. That phase records
  29/29 focused tests: five actual SQL/SDK cases plus 24 existing handler/codec
  cases, with direct TypeScript, two-file ESLint and diff checks passing. Its source
  is `fd3939401412afe4b3b8fc79203f54a86851fa9d` plus the two uncommitted test files,
  SHA-256 `dbbeb7e23c5872b18de22b4dc7d6dd4fbb855acd031174fb378f2f0539ece246`
  (`naming-brain-sql-runtime.test.ts`) and
  `f89fef1d81b5320935531993340530349334fb0284ba2d61ee32aa4b44305a16`
  (`naming-brain-sql-runtime-fixture.ts`). These are source-specific reported
  results, not the final integrated matrix. The later complete phase below
  supersedes its then-pending recovery/foreign-proof and scoped-review status.
  The canonical phase report is the ignored
  `.superpowers/sdd/2026-10-16-naming-brain/sql-coupling-report.md`; logs are in
  runtime `.tmp/naming-brain-sql-gap-*.log`.
- Complete SQL coupling now has **7/7 actual SQL/store/SDK cases**, plus 24 existing
  handler/store-codec cases: **31/31**, no skips in the final combined command.
  The final two cases cover genuine committed prepare/lost acknowledgement with
  both paid-readiness seams disabled and no replacement inference, and foreign /
  forged proof rejection through the real migrated scoped RPCs. All cases preserve
  the full unsettled US$5 hold and nullable confirmed actual charges. Fresh direct
  TypeScript, scoped lint and diff checks passed. Recorded test source is runtime
  base `0fe37e71eb910d9c0e906d51fd04c229fb903fb5` plus final test hash
  `bb5195bb98d85908534dc7a3a2119cde8b857ea96b8ccdabdefc0cc134c21e34`
  and unchanged helper hash `f89fef1d81b5320935531993340530349334fb0284ba2d61ee32aa4b44305a16`.
  The bounded combined review approved these tests/helper; they are integrated in
  the current pre-verification base. Logs are runtime
  `.tmp/naming-brain-sql-complete-*.log`. This remains local PGlite/inert SDK evidence.
- D071's corrected chat-left/results-right source is
  `a13e94c34d8d67d52fb6dc23415f5be679f823d6`. Independent re-review approved F1
  (truthful interrupted question progress) and F2 (action-key exclusion from
  exploration). Author evidence is **142 client checks / 13 files** and **46/46
  final affected desktop/mobile checks** (16 review-fix and 30 preserved V2/layout
  cases), with fresh nonincremental TypeScript, scoped lint, production build and
  diff check. These scoped checks are not the combined-branch matrix. The canonical
  correction/review reports are ignored
  `.superpowers/sdd/2026-10-16-naming-brain/naming-chat-{correction-report,review}.md`.
- The lead's corrected independent preview at `http://127.0.0.1:3135/__preview`
  identifies source `a13e94c` and build `gfuuPIn1v7wdAnbMseDvK`. Its desktop/mobile
  wrapper smoke passes, including interrupted questions. It contains sample data
  only; neither its build nor its smoke checks prove live name generation.
- The exact seven worker environment keys, nine scoped worker RPC signatures,
  actual Node entrypoint and unverified live requirements are recorded in the
  [activation packet](naming-brain-activation-20261016.md). Local key-presence
  inspection found no Naming credentials/configuration in the QA checkout without
  reading secret values. A later separately authorized connector-only metadata
  pass confirmed configured `fluid-platform-dev`, ref `fricsfwqibyhemknqgyf`,
  `us-east-1`; migration `20261016180000` and all nine Naming RPCs are absent.
  Restricted role `fluid_api_text_worker` exists at OID `21484`; owner binding,
  native authentication and future Naming ACLs remain unverified. No user/auth /
  balance rows, direct/pooler login, live test, worker start or mutation was used.

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
| `npm run build` | Passed again on partial3abfa65 plus all five final QA source/test files. Exit 0. Prebuild seven-path hashes are recorded in `.tmp/naming-qa/prebuild-owned-manifest.json`; only this evidence document changed afterward. No credentials or runtime files copied. |
| `./node_modules/.bin/vitest run tests/qa/naming-brain-pilot.test.ts --configLoader runner --no-cache --no-fsModuleCache --maxWorkers=1` | 15/15 passed, one file, no skips. |
| `FLUID_E2E_PORT=3131 FLUID_E2E_BROWSER_CHANNEL=chrome npm run test:e2e -- tests/e2e/naming-brain.spec.ts --workers=1 --project=desktop` | Initial fixture pass:6 passed/4 failed; failures were selectors and incomplete synthetic history metadata, corrected before rerun. |
| Two-file desktop / desktop+mobile reruns | **116 passed (2.4m), zero failed/skipped:58 desktop +58 mobile.** Exact command: `FLUID_E2E_PORT=3131 FLUID_E2E_BROWSER_CHANNEL=chrome npm run test:e2e -- tests/e2e/naming-brain.spec.ts tests/e2e/project-naming.spec.ts --workers=1`. |
| Typecheck / full lint / full suite / final production+worker builds | Direct `tsc --noEmit --incremental false`, scoped ESLint of all five QA source/test files and `git diff --check` exit 0. Whole-repository/final integrated matrix still pending lead freeze. |

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

## Historical integration checklist (completed at d654d62)

After the lead advances and explicitly freezes the integrated source, record the
full commit/tree and every owned-file SHA-256, then run typecheck, lint, `npm test`,
production build, `build:api-text-worker`, a separate inert build of the dedicated
Node `worker/index.ts` graph, and both Naming E2E files on desktop/mobile. Record
commands, exit status, counts/skips, artifact paths and any source edit after each
broad run. Do not mix output from a moving tree or infer graph equivalence from the
hosted Strategy build.

Include the reviewed seven-case SDK/scoped-store/SQL coupling test in its final
integrated form, together with the corrected D071 and preserved legacy browser
coverage. After the full matrix, obtain whole-branch review of the same frozen
source. Those local gates are complete at d654d62; this later documentation-only
follow-up records their measured results above, without changing that code identity.
Local client/domain/component results and PGlite
role/RLS tests are distinct evidence classes. None proves native process login,
pooler `session_user`, concurrent advisory locks, live model access, provider
retrieval, account funding or final invoiced charges. Those remain separately gated
in [the activation packet](naming-brain-activation-20261016.md).
