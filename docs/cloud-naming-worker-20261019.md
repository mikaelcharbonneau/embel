# Cloud Naming worker — 2026-10-19

## Historical goal and host

The cloud Naming workstream targeted Vercel so generation could continue with
the Mac offline. No Render service or credential transfer was performed.
Saved account data, durable jobs, immutable requests, cancellation and accounting
evidence remain preservation requirements. The starting shared main revision was
`814c4f866da40e01f59b61b6a9c1b8c265652100`.

PR #22 prepared the dedicated worker project. This record describes its technical
deployment and cutover requirements; it grants no credential transfer, persistent
access, compute/AI spending, browser access, plan upgrade or activation authority.

## Prepared Vercel deployment

Vercel Daemons are a public beta for long-running container processes, available
on all plans within their quotas. They fit the existing dedicated Node poll
worker, which executes outside HTTP request lifetimes. No Workflow or queue
replacement is needed. Production instances restart after exit or failure;
preview deployments, inbound networking and persistent disks are unsupported.

An empty protected project has been created in the existing Embel team:

- Team: `team_0Koie5796IDOraQkDFg6J0AF` / `embel`.
- Worker project: `prj_vTOc6Kf8th7tXK2cOVwWTTaR20yx` / `embel-naming-worker`.
- Daemon: `naming-worker`, one instance in `iad1` when activated, 1 GiB, 300-second
  termination grace. The checked-in configuration has **zero instances**.
- Vercel Authentication: all deployments; public source disabled. No Git
  automatic deployment connection is configured for this worker project.
- Existing web project: `prj_WKrFUPy3wptZ3qI9l1hTuqPmzkDt`, unchanged.

At the preparation checkpoint the project had no deployment, worker credentials
or running compute. An authenticated read-only team lookup confirmed
**Pro / trialing**. No billing-plan upgrade or provider-credit purchase was
performed. The recorded Washington D.C. Fluid compute rates were US$0.0106
per GB-hour of provisioned memory and US$0.128 per Active CPU-hour. Assuming
continuous 1 GB allocation for 730 hours, the memory estimate is about US$8 per
month before credits/taxes, plus active CPU, image/build and existing AI usage.
This is an estimate from the published compute rates, not a fixed service price
or a verified future invoice. Applicable trial credits and actual metering must
be checked on activation.

### Release and credential boundaries

`npm run build:naming-worker` builds only the reviewed Naming dependency graph,
binding its public source revision and dedicated worker project. The package
script verifies a clean checkout, source revision, bundle digest and project pin
before staging an isolated release under ignored `.tmp/`. Running modes require
the checkout's `main` branch. The stage contains only three bundle files, a
runtime-only Containerfile, deny-by-default ignore files, a worker configuration
and an inert static page. It contains no source checkout, `.git`, environment
files, Mac launchers or web routes. Deploy this release directory with explicit
worker project and Embel scope; never deploy the repository root to this project.

```sh
EMBEL_NAMING_VERCEL_PROJECT_ID=prj_vTOc6Kf8th7tXK2cOVwWTTaR20yx npm run build:naming-worker
npm run package:naming-worker -- --project prj_vTOc6Kf8th7tXK2cOVwWTTaR20yx --mode stopped
```

`stopped` stages zero instances. `standby` stages one instance that verifies the
actual runtime, authorized TLS socket and restricted role/OID in a read-only
transaction, then waits for shutdown. It never constructs the job store,
publishes readiness, attests preferences, expires leases, claims work or calls
the provider. `--preflight` remains the one-shot equivalent. `active` stages the
normal poll loop and additionally requires `EMBEL_NAMING_CLOUD_ACTIVATED=true`
and the existing provider-dispatch flags.

Vercel passes deployment environment variables to both container runtime and
image-build arguments. Do not claim they bypass Vercel's builder. The
Containerfile declares **no ARG**, runs no build command and copies only the
three bundled files, using nonroot Node `22.22.2-bookworm-slim`. Before real
credential transfer, inspect a hosted synthetic-secret canary build's logs,
image configuration/history and any provenance attestations. Confirm supplied
markers do not enter the image or exposed metadata. Actual hosted Git metadata
and Node/ICU/Unicode must match before activation; missing metadata fails closed.

After explicit approval, only the worker project's production encrypted/sensitive
settings receive the existing API key and restricted database URL, plus the
public hash-pinned CA. No credentials go to the web project or shared environment
groups. The existing login has scoped Naming **and local Strategy RPC** grants;
the cloud executable contains only Naming handlers. No administrator or
Supabase service-role credential is used and no grants are added.

The existing logical deployment ID containing `local` remains unchanged. It is
a compatibility binding, not a requirement to execute on the Mac. Runtime
qualification requires the dedicated Vercel project, production/main Git
metadata, exact compiled revision, `iad1`, Node 22.22.2 / ICU 78.2 / Unicode 17.0,
approved model and native TLS. Job claims and database policy remain the final
execution authority.

## Controlled cutover and future releases

The readiness row identifies one process. Mac/cloud or cloud/cloud readiness
publishers must never overlap. Vercel production deployments and rollbacks can
overlap old/new instances, even when the configuration asks for only one.

1. Publish the verified source through the existing PR and reconcile local main.
   Build from that exact clean main; verify source and bundle digest in the
   release, Vercel deployment metadata and hosted logs. Confirm quotas/charges.
2. With no real secrets installed, deploy the stopped synthetic-canary release,
   inspect its file inventory, image metadata and provenance. After transfer
   approval, deploy standby and verify native TLS, restricted identity and
   runtime without touching jobs or cloud readiness.
3. Capture the account/pilot/policy binding, jobs, names, preferences, favorites,
   holds and current `ready_until` **before** the freeze clears it. Let active
   leased work finish. Do not reset attempts or issued provider requests.
4. Run the reviewed freeze packet under the owner lock. It rejects active
   execution, outstanding leases and ambiguous pending creates, then disables
   only the exact pilot and hosted capability. It preserves historical unknown
   outcomes, queued work, results, held usage and accounting evidence.
5. Unload the Mac Naming LaunchAgent and any other Naming supervisor. Verify
   actual process exit, wait the captured readiness deadline, and recheck that
   no observation lease appeared during shutdown. SQL cannot prove that an
   external process has stopped.
6. Stop the Vercel standby instance using a dashboard scaling override of zero
   in every region. Verify process exit, deploy the active package while that
   override persists, enable the same pilot with the reviewed enable packet,
   and clear the override only after verifying exactly `iad1:1`.
7. Confirm a fresh `naming-cloud-<UUID>` heartbeat, then verify a genuine
   progressive 100-name run with every Mac Naming process stopped. Verify
   terminal receipts, reload and exact preservation of previous names,
   preferences, favorites and historical accounting.

Subsequent releases use the same drain/freeze/stop procedure and persistent
dashboard override before deploying or rolling back. Vercel CLI/API scaling is
not currently supported; do not invent an endpoint. Dashboard use requires its
own shared-browser permission. Rollback never resets attempts, deletes evidence
or resends an uncertain provider request. Process IDs stay unique; a fixed worker
ID is not a substitute for excluding overlapping publishers.

## Verification evidence and pending activation

Runtime/configuration, source/build isolation, transport-denial, restricted TLS
preflight and package tests are local checks. They do not demonstrate actual
Vercel execution or Mac-independent provider generation. The final combined
matrix passed **169 tests in 10 files**, including 97 runtime/configuration and
22 independent artifact/process/packaging checks. Full TypeScript, ESLint and
the production Next.js build passed. Independent QA found no source blockers.
An actual Vercel CLI no-upload dry run exposed a trailing-slash ignore-rule
issue; the corrected rules collect exactly eight payload files: the Containerfile,
Docker ignore file, three bundle files, root package/configuration and inert
static page. No source checkout or credential file is selected for upload.

The provider-neutral freeze/enable packets passed **25 disposable database
scenarios** using full migration replay. All tables other than the two exact
operational pilot/capability rows retained their row digests. Live read-only
inspection at `2026-10-19T13:16:53.528633Z` found zero active-work or
pending-provider blockers. Historical unresolved work remains untouched.

Reviewed operator SHA-256 values:

```text
freeze  18ad9ac3e831a2b1b84903bf474e3126ffa8db9067074861d9852535d1b2c342
enable  6c58efde02b46e1f3043397549126cd848a7a97301c94cd31ea7dec2de540d12
```

Neither operator packet has run against the live database. Existing Mac
configuration remains unchanged. Hosted build/secret-canary inspection,
separately authorized credential transfer, actual standby qualification, controlled cutover
and real cloud generation remain pending. No success or offline availability is
claimed until those checks pass.

## Current official references

- [Vercel Daemons](https://vercel.com/docs/daemons)
- [Daemon configuration](https://vercel.com/docs/daemons/config-reference)
- [Lifecycle, scaling and shutdown](https://vercel.com/docs/daemons/managing-daemons)
- [Beta quotas and unsupported features](https://vercel.com/docs/daemons/limits)
- [Container Registry](https://vercel.com/docs/container-registry)
- [System environment variables](https://vercel.com/docs/environment-variables/system-environment-variables)
- [Fluid compute rates](https://vercel.com/docs/functions/usage-and-pricing)
- [Node 22.22.2 ICU source](https://github.com/nodejs/node/blob/v22.22.2/deps/icu-small/source/common/unicode/uvernum.h)

## Preserve isolated-release Git provenance

An isolated directory can upload successfully while losing automatic Git
metadata. A deployment build marked READY is not evidence that the Naming
runtime qualified. The runtime deliberately refuses missing or mismatched
GitHub owner, repository, main branch and embedded source revision.

The packaging command now returns `deploymentMetadata` and
`deploymentMetadataArgs` alongside its existing release receipt. Save that JSON
receipt locally. Pass the metadata object through the supported deployment API
`meta` field, or pass the returned argument array to `vercel deploy` as separate
arguments (never concatenate untrusted values into a shell command). These
fields come from the same verified clean checkout and bundle, not an arbitrary
revision selected to satisfy a runtime gate. Do not upload secrets or override
system environment variables to bypass qualification.

After upload, retrieve the raw deployment JSON using the existing authorized
Vercel connection. Before enabling any instances, run this read-only check:

    node scripts/verify-naming-deployment.mjs --receipt release-receipt.json --deployment deployment.json

A mismatch exits unsuccessfully and must leave instances stopped. Successful
output explicitly says `workerReadinessVerified: false`: still inspect packaged
artifact identity and complete the restricted-role/TLS/runtime standby check,
then follow the freeze/drain/no-overlap/enable sequence above. The check does
not query Vercel, modify the database, change scaling or start generation.
