# Local preview with the existing research backend

## Requested scope

On 2026-10-15, the user requested a local preview with working competitor
research and asked Codex to locate its existing configuration. The preview
continues to use Supabase account authentication and the existing owned,
durable API jobs. The request does not create a new account allowance or
authorize an automatic paid research request.

The current guided interview uses API research. The older `npm run local`
command launches the separate ChatGPT subscription runtime on ports 3106/3107;
its subscription database login cannot claim the current API jobs. The original
protected subscription configuration was found on the Mac, but it is not copied
into this checkout or used as an API-worker credential.

## Connection

The ordinary development web server runs at `http://127.0.0.1:3105` and calls the
existing protected API worker. OpenAI and worker database secrets remain in the
worker's production environment. The local web process obtains a genuine,
short-lived development workload token through the installed `@vercel/oidc`
SDK and the existing Vercel CLI sign-in. Tokens never enter browser responses
or application logs. The SDK manages its standard local token cache.

Local publication requires all of:

- `FLUID_LOCAL_API_TEXT_ENABLED=true` and `NODE_ENV=development`.
- `APP_ORIGIN=http://127.0.0.1:3105`.
- The existing web project ID, `prj_WKrFUPy3wptZ3qI9l1hTuqPmzkDt`.
- `FLUID_API_TEXT_WORKER_ORIGIN` identifying the qualified HTTPS worker.
- No `VERCEL`, `VERCEL_ENV`, `VERCEL_TARGET_ENV` or `VERCEL_DEPLOYMENT_ID`.

The local flag is server configuration, not an account entitlement or paid-call
switch. The web still intersects caller-specific SQL availability with the
protected worker's readiness response before presenting a research action.
Admission, exact policy acceptance, ownership, cancellation, leases, usage and
uncertain-outcome handling are unchanged.

The worker separately requires `FLUID_LOCAL_API_TEXT_PUBLISHER_ENABLED=true`
before accepting development publishers. Signature, issuer, audience, team,
immutable web project, subject and two-hour token-age verification still apply.
The SDK's local refresh buffer renews twelve-hour development tokens after an
hour, before they exceed that age bound. Hosted callers continue to use their
request-context identity.

## Activation and verification

Source support alone does not establish live readiness. Activation must preserve
the worker's existing All Deployments protection and all current Trusted Sources
rules while adding only development from the existing web project to worker
production. A newly built worker must use its real immutable deployment ID in
the existing cohort and matching bindings; preserve other owners, policies,
grants, budgets, retained jobs and financial holds.

After deployment, verify signed, body-free readiness and its deployment ID before
enabling the local configuration. Readiness does not enqueue a job or call the
AI provider. Actual account eligibility remains determined by SQL, and successful
paid research is a separate verification result.

## Verified runtime — 2026-10-15

The local preview is connected to protected worker deployment
`dpl_UGPxDW1XC2Lo573Vb5hzChxaH4id`, at
`https://fluid-api-text-worker-43mbe31ub-embel.vercel.app`. The actual local
server helper obtained a genuine development token through the installed SDK
and verified that exact deployment with all four guided operations:
`strategy.competitors`, `strategy.audience`, `strategy.personality` and
`strategy.reformulate`. An anonymous readiness request received HTTP 302;
All Deployments authentication remains enabled.

The original Trusted Sources rules were preserved and only the existing web
project's development → worker production rule was added. The existing testing
cohort and its four matching owner bindings were qualified to the worker's real
deployment ID under role, policy, prior-deployment and concurrent-work guards.
Other owners, operation policies, grants, account allowances and budgets were
preserved. Provider and worker database secrets stayed on Vercel.

The hosted web application was redeployed as
`dpl_fQk7D9S8neTixdpPmkVAxPABhAHX` from its unchanged original source commit
`ba085aec66c54d42a26cc3040d3ed27ee23afa3a` to pick up the matching worker origin.
This did not upload the local checkout's other pending interface changes.
The local preview continues to use `http://127.0.0.1:3105` and its ignored
runtime configuration.

## Exact failed-request recovery

Request `beb22588-79a8-4f59-a403-5d540e811315` had paused the existing testing
account. Its retained diagnostics recorded a completed envelope, two completed
searches and bounded validated usage, but one proposed website was absent from
the observed sources. The answer was correctly rejected; classifying that known
source-validation failure as an unknown execution outcome caused the pause.

The parser now treats this narrow completed, bounded source rejection as a
terminal unusable result. It still rejects the unsupported answer, retains
partial evidence and sends no automatic replacement request. Incomplete tools,
truncated evidence, invalid schemas, accounting overruns and genuinely unknown
outcomes continue to require reconciliation.

The independently reviewed
[exact-request migration](../supabase/migrations/20261016020816_third_terminal_research_operator_adjudication.sql)
was installed as hosted version `20261016023224`. Its source SHA-256 is
`e868e44e3453d6473800ff8d80ad00d297bdb57494a523380ae6e4eb4eea2b03`.
Installation added no receipt or privilege. The separate
[apply-packet template](../supabase/candidates/research_operator_abandonment_beb22588_apply.sql),
SHA-256 `c18469a42d55bfb386f7831c6c7a00246a3bb4c0406f26f4743ccdac09ea5336`,
was instantiated with the deliberate lead operator decision
`operator-decision:lead-local-preview-repair-20261015-beb22588` under the user's
testing-account repair request. This is not a claim of separate human approval
or a verified provider invoice. The checked-in template retains its invalid
placeholder so it cannot be reused without another explicit operator decision.

At 22:36 America/Toronto, the exact job was marked failed and an immutable
receipt was appended. Its original ambiguous step, output, provider identifiers,
dispatch, admissions, project history and financial records were preserved.
The recorded 70,038 microUSD and the entire 15,822,842 microUSD outstanding hold
remained unchanged and active. Recovery readback matched the original account
ledger SHA-256
`b8a103280f61e6bb333b998b475627aefa934bb85a1562a23e05a1e2fed3aedf`;
all three incident receipts matched, both pauses cleared and all four operations
became available to the existing testing owner. No settlement, refund, new
account allowance or replacement inference was performed.

## Verification evidence

The combined frozen source qualification passed **8,187 tests, zero failures and
23 existing gated skips**, plus typecheck, ESLint, the production web build,
worker packaging and ten desktop/mobile browser checks. Its
[verification report](regression-verification-20261015.md) distinguishes local
fixtures from this chat's hosted runtime actions. Fourteen disposable SQL tests
and independent review qualified the exact recovery packet; focused connection
and parser counts overlap the combined suite and are not added to its total.

The deployed worker reuses that qualification's seven-file bundle. Its canonical
sorted file-manifest SHA-256 is
`41b31ae5d8ce33113f4ab71dafba1eb6ccf79142167f4c4ee81de913b715783e`;
every file and the seven-file inventory were rechecked unchanged after upload.
The ignored local runtime receipt is
`.tmp/local-research-activation/receipt.json`.

Signed runtime readiness and owner-specific SQL availability were verified
separately from the source tests. No new paid research was dispatched during
setup; a successful replacement answer still requires an explicit user request.
The source qualification preceded this documentation-only completion. This
checkout has no Git metadata, so it is not reported as a merged checkpoint.

## Sources

- [Vercel OIDC federation](https://vercel.com/docs/oidc) and the installed
  `@vercel/oidc` 4.0.0 source: local development identities and token refresh.
- [Vercel Trusted Sources](https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/trusted-sources):
  explicit source/target environment rules while preserving deployment protection.
- [Guided interview runtime](guided-interview-runtime.md): exact account,
  policy, role and deployment qualification.

## Subsequent source reconciliation — 2026-10-16

This record describes the earlier source qualification and its then-current Git
and composer limitations. The separately authorized repository reconnection
preserves that evidence, includes the completed composer follow-up, and records
fresh checks of the reconciled candidate in
[repository reconnection](repository-reconnection-20261016.md). Hosted runtime
results above remain separate from that source-only PR preparation.
