# Repository reconnection and PR qualification — October 16, 2026

## Historical scope

This workstream concerned reconnecting the checkout to the existing Embel
repository and preparing verified fixes while preserving local changes. Its
branch and PR evidence below is historical, not permission for another task,
publication, merge, deployment, live migration, provider request, provisioning
or credential change.

## Repository and preservation

GitHub confirmed the existing private `mikaelcharbonneau/embel` repository,
immutable repository ID `1410624483`; its earlier `emble` URL redirects there.
The fetched shared `main` was
`ba085aec66c54d42a26cc3040d3ed27ee23afa3a`. The original checkout had no Git
metadata, so no historical local HEAD was assumed or invented.

Before reconnection, all 1,813 non-private local source/configuration files were
archived and hashed. The archive was read back against the manifest with zero
mismatches, and independent review confirmed the same bytes. Existing ignored
runtime configuration, private references, caches and evidence remain local.

- Source archive: `.tmp/repository-reconnect-20261016/initial-source.tar.gz`.
- Archive SHA-256:
  `52885362d58884e8a9c341f1bc127a73cb0f2ce0dca1d4ef70624563d9bb2d33`.
- Source manifest SHA-256:
  `69efb2d8468e02cb88618a3936641689b0c3ea74b9d73dce4f33a5864c064f0f`.

All 1,799 files tracked on current main were present locally: 1,736 matched,
63 were modified and 14 were additional local files. There were no missing
remote-only files or deletions. Integration used a genuine isolated clone and a
feature branch based on that main revision. Metadata is attached without a
checkout or reset of the original files; the exact committed tree and index are
compared with the original checkout separately from generated Next references.
The ignored runtime configuration is compared by digest and permissions without
printing its contents.

## Combined changes

The candidate preserves the account-switch fences, same-owner draft recovery,
unsent interview memory and exact lost-acknowledgement save reconciliation from
[the regression correction](regression-verification-20261015.md). It also retains
the independently authored protected-worker local connection, source-rejection
handling and exact operator-recovery packet described in
[local research preview](local-research-preview.md). This reconnection performs
no hosted action described by that separate record.

The completed composer follow-up automatically expands Home and keeps long
conversation input scrollable while Send remains in the viewport. The broader
46-check guided browser run exposed one interaction: capping notices at 30% of
the composer clipped an ordinary research-status recovery action. A one-line
correction caps notices at `30dvh`; the existing parent flex bounds continue to
reserve composer and history space. Original full-visibility assertions remain
unchanged. The original 44-pass/two-failure log is preserved as
`headless-before-notice-correction.log`.

## Fresh local qualification

| Check | Final local result |
| --- | --- |
| Full unit/database suite | 8,187 passed, zero failed, 23 existing gated skips; 555 passing and two skipped files |
| Typecheck | Passed |
| Full ESLint | Passed with no warnings |
| Production Next.js build | Passed |
| API-text worker packaging | Passed |
| Guided desktop/mobile browser suite | 46 passed, zero failed |
| Additional composer qualification | 20 layout checks across four viewports, plus four Home expansion checks; passed |

The complete unit/database rerun took 401.66 seconds. Raw logs and command
receipts remain in the ignored task directory. The first runner retained its
initial manifest label in the build/test receipt after the one-line CSS change;
raw receipts are preserved alongside an explicit association correction to the
final manifest below. The CSS write preceded both commands, the final inventory
was materialized during that run, and subsequent drift checks matched all inputs.

The final application/test/static/config inventory contains 1,751 inputs with
canonical manifest SHA-256
`d1c56dfce89c4c4607c1142a6f9bc2937d42608cfbdd6d0d973abea0fc5e1fda`.
Documentation and Next-managed `next-env.d.ts` are recorded separately. Final
source-to-commit and source-to-original comparisons are saved with the ignored
machine receipt under `.tmp/repository-reconnect-20261016/`.

The isolated checks use Node.js 22.22.2 and the installed dependencies. No local
`.env` or privileged runtime files were copied into the candidate; inherited
external PostgreSQL and provider configuration were removed. The full suite uses
three workers. The two existing external PostgreSQL suites remain credential
gated, and no skip, timeout or failing assertion was added or relaxed.

The browser suite runs this candidate's production build on a dedicated port,
intercepts all APIs and blocks external requests. It covers the interview,
choices, autosave/lost acknowledgements, account fencing, cancellation, status
recovery and legacy compatibility. The separate composer check covers four
viewports (1440×900, 390×844, 320×600 and 844×390), short/12,000-character input,
typing, resizing, start/end input scrolling, Send hit testing without automatic
scrolling, keyboard access to a tall recovery notice, and Home expansion. It
records zero account writes, provider requests and page errors. These are local
fixtures, not new live provider or hosted database acceptance.

The user's original preview on port 3105 stays running. Dedicated test servers
and the isolated test browser are separate. The draft PR is the review checkpoint;
no merge or deployment is performed by this task.
