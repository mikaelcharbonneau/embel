# Cloud Naming worker — 2026-10-19

## Approved goal

The user requested that Naming generation run in the cloud and continue when
their Mac is offline. Preserve the live application, saved account data,
generation policy, durable jobs, immutable requests, cancellation and accounting
evidence. The starting shared main revision is
`814c4f866da40e01f59b61b6a9c1b8c265652100`.

## Proposed deployment

One Render background worker named `embel-naming-worker-production` runs the
existing Naming process against the existing Supabase development backend.
The proposed workspace is **Mikaël's workspace** (`tea-db7oe32j9qps73d62j5g`).
The `0.5c-512mb` compute plan is currently US$7/month, plus existing provider
usage and any applicable platform usage charges. No new database, cache, disk
or public HTTP endpoint is needed. Workspace selection, paid provisioning and
transfer of the existing provider/worker credentials await concrete approval.

The worker preserves the existing restricted login, role OID and logical
deployment binding. The historical identifier containing `local` is a database
compatibility identity, not a requirement to execute on the Mac. This login has
existing scoped Naming and local Strategy RPC privileges; the cloud executable
contains only Naming execution. It receives no database administrator or
Supabase service-role credential.

Render secret environment settings hold the existing API key and restricted
database connection. The TLS CA is pinned, with certificate validation enabled.
No Mac credential file is included in the bundle, repository or deployment.
The worker checks its production service identity, exact source revision and
Node/ICU/Unicode fingerprint before beginning work. Its explicit preflight mode
does not attest preferences, report readiness, expire leases, claim jobs or call
the provider. Render runs this qualification as the one-off pre-deploy command;
the long-running start command requires a separate explicit activation setting.

## Controlled cutover

The database's readiness identifies one worker process. Mac and cloud copies
must not publish competing readiness. Render rolling deployments also overlap
old and new instances, so automatic deploys and preview workers remain off.

1. Verify exact main/source, account/pilot binding, policy and runtime fingerprint.
   Capture current jobs, published names, preferences, retention, holds and the
   previous `ready_until` deadline before the freeze clears it.
2. Let current leased work finish. Do not disable readiness during a live run.
3. Under the existing owner lock, assert no running/cancel-requested Naming work
   or unresolved pending create, then temporarily disable this exact pilot.
   Retain queued jobs, failed runs and historical reconciliation evidence.
4. Unload the Mac Naming LaunchAgent and stop any other Naming supervisor. Verify
   its process is gone, wait the captured readiness deadline, and recheck that no
   observation lease was acquired during shutdown.
5. Run cloud preflight with the existing protected credentials; verify native
   restricted identity and authorized TLS, source and runtime pins.
6. Enable the same pilot and activate the single cloud worker. Confirm fresh
   cloud readiness before admitting genuine hosted work.
7. With every Mac Naming process stopped, verify a real 100-name run, progressive
   publication, terminal provider receipts, reload and exact preservation of
   earlier names, preferences, favorites and historical accounting rows.

Subsequent worker updates use this same stop/drain procedure. A worker crash
retains durable leases and issued requests; recovery must observe uncertain
provider outcomes without creating duplicate requests. A rollback never resets
job attempts or deletes provider or cost evidence.

## Verification status

The dedicated worker bundle builds, rejects missing activation before network
access, and excludes local launchers, credential files, web routes and Strategy
handlers. The Render manifest passes the current official JSON schema. Full
TypeScript, ESLint, production build, Naming/provider/runner regressions and
independent packaged-process checks passed. The final combined regression run
passed **164 tests in 10 files**, including 85 runtime/configuration cases and
12 independent artifact/process checks. Independent review also passed its
109-check focused matrix.

The freeze/enable operator packets passed **25 disposable database scenarios**
using the full migration replay. All tables other than the two operational
pilot/capability rows retained their exact row digests. Live read-only inspection
at `2026-10-19T13:16:53.528633Z` found zero active-work or pending-provider
blockers; historical unresolved work remains untouched.

Reviewed operator SHA-256 values:

```text
freeze  18ad9ac3e831a2b1b84903bf474e3126ffa8db9067074861d9852535d1b2c342
enable  6c58efde02b46e1f3043397549126cd848a7a97301c94cd31ea7dec2de540d12
```

No Render worker has been provisioned, no credential has been transferred, and
neither operator packet has been executed. Existing Mac configuration remains
unchanged until the authorized cutover. The read-only cloud qualification must
still run on the actual hosted runtime, followed by genuine generation with all
Mac Naming workers stopped.

## Current official references

- [Background workers](https://render.com/docs/background-workers)
- [Compute plans](https://render.com/docs/compute-plans)
- [Pricing](https://render.com/pricing)
- [Deployment lifecycle](https://render.com/docs/deploys)
- [Blueprint specification](https://render.com/docs/blueprint-spec)
- [Environment variables and secrets](https://render.com/docs/configure-environment-variables)
