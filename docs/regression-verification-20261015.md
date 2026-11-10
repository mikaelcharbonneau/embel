> **Archived November 9, 2026.** Historical record; it may not match the current code. Current architecture and plan: [architecture-review.md](architecture-review.md).

# Local regression correction — October 15, 2026

This increment repairs the reviewed account-switch and draft-loss defects and
reconciles the full local test suite with the current approved contracts. Work
is local to this checkout. This regression task performed no commit, push,
deployment, hosted schema change, provider inference, provisioning, or private
credential action. Separately authorized concurrent runtime work is distinguished
below and is not evidence supplied by these local checks.

## Behavior corrected

- Logo creation and standalone Names AI admission send the captured account in
  `X-Embel-Account`; each creation route rejects a stale account before reading
  the body or writing. Authenticated identity and RLS still determine ownership.
- The shell and editor share one same-owner reconciliation rule. Re-verification
  preserves pending edits regardless of read order, and a different account
  cannot read or publish the prior owner's draft.
- Unsent interview text and choices stay in owner-bound session memory and
  participate in unsaved-exit protection. They do not change canonical project
  content, trigger autosave, or block Send merely by existing.
- Guided saves use the same frozen intent and exact owned readback as ordinary
  draft saves. A lost acknowledgement can resolve to the exact committed
  revision without another PATCH; different content or revisions still conflict.
  Only acknowledged submitted input clears, preserving newer typing. Rejected
  guided saves retain submission metadata through explicit retry; ordinary
  rejected drafts can still be corrected before saving again.
- Scoped project entry points expose compact continuation and explicit scope
  expansion. Naming-only and identity-only projects can continue without being
  sent through the full Strategy interview. The removed Strategy stage bar,
  step count and dashboard disclosures stay removed.
- The subscription Strategy worker retains known failed partial output without
  classifying its presence alone as an unknown outcome. Actual provider
  uncertainty, failed persistence and conflicting streams still require review.

## Renderer qualification

The renderer's four `Fluid` → `Embel` substitutions are the only changes from
its earlier reviewed bytes: substituting the old name in memory reproduces the
pre-existing SHA-256 exactly. The actual local renderer produced PNG, vector
PDF and guidelines PDF; its independent pixel verifier and ZIP inspection
passed before updating the fixed runtime pin.

- Earlier renderer SHA-256:
  `015bce40c035158bbf030519a266e11612f730e3b22e625d9f62dfd91f709eea`
- Requalified renderer SHA-256:
  `3995854524784ee88896e7ef52e48e376d8dfaf000f4a674313aead7a5fb5820`

The integrity checks, bounded child execution, capability gates and all other
runtime pins remain enforced. This is local non-generative qualification.

## Test evidence maintenance

Security tests retain explicit, reviewed function/table inventories and fixed
definition/ACL pins. The authenticated function inventory adds the exact 21
signatures introduced by the current migrations; it is not derived from the
catalog under test. The updated inherited identity helper pin reflects its
reviewed backend/transaction-bound API gateway context. Private-schema access,
grant-option rejection, role restrictions and adversarial tamper checks remain.

Older export fixtures now create schema-validated owned direction rows for
every referenced current-stage ID. Legacy scope expansion still uses its
documented seven-column RPC projection; tests separately verify unchanged
lifecycle metadata. Other corrections supply current response fields, complete
mocks and browser API fixtures, canonical temporary paths on macOS, and explicit
completion times for ordering tests. No test was skipped to hide a failure.

Two historical adjudication tests now read exact passive source snapshots from
this application's same private repository, verified against their pre-existing
expected hashes. [Their provenance](../tests/fixtures/source-history/README.md)
records repository identity, exact commits and source path. No Git history was
invented, and historical snapshots are never executed as application code.

## Final local verification

The corrected, isolated source snapshot completed the full suite with **8,187
passed, zero failed and 23 skipped**, across **555 passing and two skipped files**
(8,210 tests / 557 files), exit 0. It used three workers and took 313.12 seconds.
The two skipped files are the existing credential-gated external PostgreSQL
suites; no skip directive or timeout was added to hide a failure. The original
review's 87 additional skips came from failed Identity setup prerequisites,
which now execute.

| Check | Final local result |
| --- | --- |
| Original review baseline | 7,822 passed / 116 failed / 110 skipped; 552 files |
| Complete corrected snapshot | 8,187 passed / 0 failed / 23 skipped; 557 files |
| Full typecheck | Passed |
| Full ESLint | Passed |
| Production Next.js build | Passed |
| API-text worker packaging | Passed |
| Focused headless desktop/mobile | 10 passed / 0 failed |
| Restored deployment-config suite | 38 passed / 0 failed; also included in full run |

The headless checks use the snapshot's production build, intercept every API and
block non-local requests. They cover conflict/admission blocking, unsent text
and choice retention without writes, committed-save/lost-acknowledgement
readback into one ensuing request, rejected-save/exact-retry/input clearing,
and account-switch fencing across a delayed response. They do not establish
live inference or completion of the separate long-prompt Send refinement.

The snapshot initially omitted the existing root `vercel.json`, causing one
suite-load failure while 8,149 tests passed. Its exact public deployment
configuration was restored after auditing all non-private root source/config
files; the affected 38 checks and the fresh complete suite passed. The prior
failed log is preserved. The JSON is not consumed by npm's direct Next build or
the four-entry worker bundler, so those already-passing unrelated checks remain
valid; the worker uses its own service configuration.

Other earlier runs are explicitly non-final: one was interrupted after review
found the rejected-guided-save metadata edge; a completed mixed-source run
reported 8,105 passing tests while concurrent API edits arrived; a later run
was interrupted after concurrent parser/recovery/UI edits. These logs are
retained without being relabeled as the final qualification.

Independent review approved the regression source, the concurrent API worker
change, the parser/recovery packet and compatibility with the preserved
composer. Final focused review receipts include 61 regression tests, 169 API
worker tests, 14 actual disposable SQL recovery tests and 43 final UI/recovery
checks; these overlap and are not added to the full-suite total.

Final logs use `.tmp/regression-fixes-20261015/snapshot-*.log`. The exact frozen
application/test/static/config inputs are recorded in
`candidate-qualification-input-manifest.json`; the machine receipt and final
drift check identify the matching live checkout. Generated Next type references
and this post-run verification document are recorded separately.

The reusable worker bundle is
`.tmp/regression-fixes-20261015/source-candidate/.tmp/api-text-worker-BsJwzu`.
Its seven-file canonical SHA-256 manifest is `api-worker-bundle-files.sha256`,
with manifest hash
`41b31ae5d8ce33113f4ab71dafba1eb6ccf79142167f4c4ee81de913b715783e`.
`api-worker-bundle-receipt.json` records file hashes, sizes and the frozen input
identity. This task produced the bundle locally and did not deploy it.

## Preserved concurrent work

The separately authorized “Start the app preview server” chat changed API-text
publisher configuration, token retrieval and worker development-identity trust
while this task's aggregate was running. Its source, tests and local-preview
documentation are preserved. These are separate from this task's eleven authored
production-file changes. The final combined verification must include the new
`publisher-token.ts` source and `api-text-config.test.ts` file, as well as the
existing publisher/readiness/hosting-auth files it updated. Competing writes to
Next's generated output are avoided while the preview chat builds.

Independent compatibility/security review of that concurrent work passed 169
focused tests across four files with token and transport fixtures. It confirmed
strict signed workload identity, explicit development opt-in and the existing
SQL/admission controls remain. The reviewed configuration, token helper and
worker-auth hashes are respectively
`2cd4e04756b48678749eb5781b8e21069c5f2026a9c11d8a5b395819bd7e17cd`,
`f3da852f07f2e48b5de2327415b1a4d578fc14f1338f5305c2e8919ccb7622cf`, and
`63e7762b54c65166d4d73df7cb69a3da4141e7222b4dd8ebc3f77c2ee070349a`.
This regression task did not configure or activate the local provider connection.

That chat also supplied the bounded completed-research source rejection change
and the third exact operator-adjudication packet. This task repaired the new
packet's CASE syntax and its disposable test fixture: explicit UUID/text types,
real revision-four history, correct admission timestamp columns, rollback-first
cleanup, actual pre-installation hostile-security rejection, and immutable-row
protection before synthetic privileged corruption. Fourteen local SQL tests
passed without changing the packet's permissions, exact evidence pins or holds.
Independent review approved those corrections. The parent reports that the
other chat subsequently performed its separately authorized runtime deployment
and migration; this task did not perform or validate those hosted actions.

The “Start Embel dev server” chat supplied composer auto-sizing and three related
stylesheets. They are preserved and independently reviewed for compatibility.
Its remaining **long-prompt Send-button visibility** refinement is explicitly
pending and belongs to that concurrent task. This report does not claim that
separate UX work is complete.

The exact 52 original regression paths, preserved concurrent paths and two shared
packet/test corrections are listed in the ignored machine-readable verification
receipt. Supplemental current public artwork is retained in the isolated snapshot;
those assets were not authored by this correction.

## Source and live-validation limits

This directory has no `.git` metadata, so its current branch, HEAD and remote
relationship cannot be verified or reported as a merged checkpoint. The
provided 1,596-file source baseline and SHA-256 manifest were preserved before
edits; final changes are compared with that baseline. Read-only access to exact
historical objects does not establish this checkout's current revision.

The isolated snapshot excludes runtime `.env` files, private credentials,
local worker state, hosted project links, caches and private design references.
It retains the source `.env.example` and existing `vercel.json` public deployment
configuration. The Next-managed generated `next-env.d.ts` is recorded separately
from frozen application/test/config inputs; no manual edit is used to hide drift.

Disposable PostgreSQL/WASM and intercepted HTTP/browser fixtures exercise the
actual local contracts and ownership boundaries. Live provider, hosted database,
multi-connection PostgreSQL and deployment acceptance remain separate. Existing
live checks stay gated; external PostgreSQL test URLs are explicitly removed
from the local full-suite environment.

## Subsequent source reconciliation — 2026-10-16

This record describes the earlier source qualification and its then-current Git
and composer limitations. The separately authorized repository reconnection
preserves that evidence, includes the completed composer follow-up, and records
fresh checks of the reconciled candidate in
[repository reconnection](repository-reconnection-20261016.md). Hosted runtime
results above remain separate from that source-only PR preparation.
