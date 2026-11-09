> **Archived November 9, 2026.** Historical record; it may not match the current code. Current architecture and plan: [architecture-review.md](architecture-review.md).

# Cloud Logo worker preparation — 2026-10-19

## Historical scope and separate activation

The cloud Logo workstream targeted Vercel so generation could continue with the
Mac offline. PR #23 prepared a dedicated project, separate from Naming's worker,
database connection and Storage identity. This record describes technical
deployment requirements and the completed activation evidence below; it grants
no credential transfer, persistent access, compute/AI spending, browser access,
plan upgrade or activation authority.

Preparation began from clean main
`5507923fd40e458d66f66a42b0085916bed54f91`. The lead created the empty,
protected `embel-logo-worker` project
`prj_QSWj13AkZzw4t8ZOGVzncFczz2gC` on the existing team
`team_0Koie5796IDOraQkDFg6J0AF`. At creation it had no deployment,
credentials, Git attachment or running compute. No live Logo database mutation,
secret read, credential transfer or provider call was performed for this review.
At preparation, the existing team was on a verified Pro trial. The recorded
estimate for one always-running 1 GiB daemon was approximately US$8/month for
memory before credits/taxes, plus CPU and actual image requests. This was an
estimate, not a verified invoice; no paid compute was running at that checkpoint.
Later activation and real-image results are recorded below.

## Existing execution authority

Reuse the installed authenticated `local_logo_operation` RPC and its private
job markers as compatibility identifiers. They bind the account, restricted
database role, image policy and logical worker identity; they do not authenticate
a physical Mac or an HTTP origin. Explicit production routing may choose that
RPC after activation. The web flag is a routing opt-in, not an ownership control.
The RPC derives the owner from Auth, checks the owned project, preserves
idempotent replays and uses private transaction witnesses. Its exception to the
legacy aggregate allowance applies only to concepts and saved-preview raster
refinements. Ordinary operations keep their existing gates.

No new schema, RPC, role, grant, account allowance or execution-authority marker
is needed for the host handoff. Existing immutable job rows and markers retain
the same identity, requests and hashes. Preserve
`embel-logo-local-20261018` exactly: both historical markers and the Storage
principal bind it. A random replacement would strand those jobs. The stable ID
does not distinguish concurrent processes, so operational exclusion of every
old publisher is mandatory.

The web process receives only the hosted routing flag and its existing public
account configuration. The dedicated worker project would receive, after
approval, the existing provider key, dedicated Logo database credential and
dedicated Storage Auth identity credential. Do not use Naming's database login,
the owner's browser session, a Supabase service-role key or an administrator
credential. Existing protected files remain ignored and are not upload inputs.
The Storage session signs in as its own confirmed user and uses normal refresh
token rotation in memory; refresh tokens are not written back to source or
configuration.

## Read-only live inventory

Inspected only `fluid-platform-dev` (`fricsfwqibyhemknqgyf`,
`us-east-1`), at 2026-10-19 14:26–14:35 UTC. No password hash, API key,
access token, refresh token or session identifier was queried.

| Binding | Observed value |
| --- | --- |
| Owner | `6840f4c2-15a6-45a7-97be-41e7e5e37f42` |
| Worker role / OID | `fluid_logo_worker` / `25288` |
| Logical worker | `embel-logo-local-20261018` |
| Storage Auth user | `853fa383-9606-4577-924f-966194dc2f67` |
| Policy identity | `175c12bb65f63fe8839b58323ba6e5bbe605d06062a9a708bfdd23efbb8515d5` |
| Enabled operations | `identity.logo_concept`, `identity.logo_refine` |
| Image model / handler | `gpt-image-2.5-sunburst-2026-09-08` / `logo-image-v1` |
| Existing per-job accounting reservation | 2,000,000 micro-USD |
| Latest readiness deadline | 2026-10-18 23:29:14.444112 UTC, expired |
| Role connection limit | `-1`, preserved |

Both runtime policies, both generative Storage capabilities, the local
capability and the Storage principal are enabled: six operational flags. No
other Logo policy is installed for the owner. The role has exactly the existing
14 worker EXECUTE grants, no direct table/column grant or outgoing membership,
and no inherited, superuser, replication, create-role, create-database or RLS
bypass authority. It owns no relation, function or schema and cannot create in
public/private schemas or create a schema. PostgreSQL's ordinary temporary-table
permission remains unchanged.

The complete observed direct EXECUTE set matches the original activation packet:

```text
fluid_private.logo_worker_owner()
fluid_private.observe_logo_asset(uuid,jsonb,uuid,uuid)
fluid_private.prepare_logo_asset(uuid,jsonb,uuid,uuid)
fluid_private.read_logo_asset_publication(uuid,jsonb,uuid,uuid)
public.begin_logo_job_step(uuid,uuid,text,text,bigint)
public.claim_logo_job(text,integer)
public.complete_logo_job_step(uuid,uuid,text,text,bigint,jsonb,text)
public.expire_logo_job_leases()
public.finish_logo_job(uuid,uuid,text)
public.heartbeat_logo_job(uuid,uuid,integer)
public.read_leased_logo_record(uuid,uuid,text,jsonb)
public.record_logo_provider_response(uuid,uuid,jsonb)
public.register_logo_job_plan(uuid,uuid,jsonb)
public.report_logo_worker_ready(text,jsonb,integer)
```

Six critical authority/readiness/adjudication functions were independently read
from the live catalog. Their owner is `postgres`; full ACLs, empty search paths,
definer/invoker modes, volatility, leakproof flags and source hashes are pinned
by both operator packets. The adjudication matcher additionally pins its UTC
timezone setting. This checks permission/ownership drift even when the function
body is unchanged.

The separate Storage user is confirmed, non-anonymous, not deleted and not
banned. Eight existing Auth sessions were counted without reading their IDs or
tokens; this count does not prove which session a stopped process used or that
a new cloud session has authenticated. Eleven retained generative Storage
grants have zero live matching job leases. No ordinary Logo Storage grant is
present. Keep the Storage principal row when disabling: its presence maintains
the restrictive Storage policy classification.

The 14:32:34.375073 UTC preservation snapshot found:

- 27 terminal Logo jobs: 19 failed concepts, six succeeded concepts and two
  succeeded refinements. Zero queued jobs, active leases or pending-provider
  cutover blockers.
- Eight saved raster results, eight assets/versions, nine publication records,
  nine Storage objects and 21 provider receipts. Recorded image charges total
  333,974 micro-USD ($0.333974); this is historical evidence, not a new quote.
- One historical ambiguous step belongs to the failed, exactly adjudicated
  publication incident. Its existing
  `logo_publication_failure_adjudication_matches` check returned true. The
  original step, receipt, uncommitted object and accounting remain intact.
- The account's historical aggregate reservations exceed its legacy allowance:
  limit 73,212,987; spent/provider actual 1,219,914; reserved 147,452,538
  micro-USD. No balance or reservation is reset. The existing scoped Logo
  authority remains necessary for generation under that account history.

Expired readiness proves unavailable generation, not process exit. The initial
sandbox process inventory failed. A subsequent filtered native process read by
the lead at approximately 14:29 UTC found no Node `scripts/logo-worker.mjs`
process. The LaunchAgents directory contained only
`com.embel.naming-worker.plist`, with no Logo LaunchAgent. Recheck cessation
immediately before enabling the cloud worker. Metadata reads confirmed both
existing Logo credential files are regular, owned by UID 502 and mode 0600,
without reading their values.

## Reviewed operator packets

These are proposed operator transactions, not automatically applied migrations:

The actual 14:32:34 UTC read-only baseline is retained in ignored, owner-only
`/Users/mikael/embel/.local-fluid/cloud-logo-cutover-baseline-20261019.json`.
Its SHA-256 is
`857f1300ac9d06422c6933954096378967bfc3bc5e8418945fbfac0c3f1ecbdb`.
It contains only counts, digests, readiness metadata and blocker counts, and is
not synchronized by Git.
The expanded 14:39:27 UTC snapshot adds Naming preferences/results, candidates,
favorites/selections, standalone Names and Inspiration, covering 39 groups. It
is retained separately at
`/Users/mikael/embel/.local-fluid/cloud-logo-cutover-baseline-complete-20261019.json`,
SHA-256 `4b3b120ff22f688a7acece793d0a5d8c7d55607d979b40e717b1490e93c8e533`.
All original 27 group digests remained identical between these read-only runs.

- `supabase/candidates/cloud_logo_cutover_baseline.sql`: read-only counts and
  SHA-256 row digests for 39 preservation groups, readiness and blockers. It
  returns no saved content, object bytes or credentials.
- `supabase/candidates/cloud_logo_cutover_freeze.sql`: exact role/OID/owner/
  Storage/policy/function/grant validation; locks admission, the readiness
  publisher and policies; refuses active or uncleared leases, unresolved jobs,
  in-flight steps and unadjudicated ambiguous steps. It disables only the six
  existing flags. Existing policy triggers withdraw readiness.
- `supabase/candidates/cloud_logo_cutover_enable.sql`: repeats binding checks,
  requires all six flags frozen and no readiness, and rechecks drain conditions
  before re-enabling them. It creates no heartbeat. If already enabled after a
  lost acknowledgement, it makes no changes and requires process readback; the
  fixed worker ID cannot independently prove cloud execution.

Both mutation packets retain queued work, requests, attempts, partial results,
Storage grants, assets, versions, selections, holds, provider observations and
the existing publication adjudication. The packets never amend a provider
request, release a hold or substitute an age threshold for a terminal receipt.
They fail on unknown privilege/policy/function drift so the operator can review
it. They do not add privileges to the worker.

Reviewed packet SHA-256 values:

```text
baseline 3b7b24deb59a84128d317208347b5147eac99cd85dfcb050b043eb6891c35ac5
freeze   412f74f3fc336e6097c94191966cc6180f9d07944837b8b04032466dcf35d0a5
enable   f0dcfa3852b5342740c190d7d13e6cf9af02a61d279b627df469ce7cfd595e35
```

Capture a fresh baseline before every freeze. Compare the preservation digests
after freeze and enable, before admitting new work. Naming may legitimately
change shared jobs or accounting while this happens; identify and reconcile that
activity rather than declaring those differences to be Logo corruption. Preserve
separate immutable Logo group digests, and capture any already-running Naming
activity before starting. After generation, compare the old IDs/rows separately
from authorized new append-only evidence.

## Cutover without overlapping workers

### Isolated runtime and release

The dedicated project is protected with Vercel Authentication for all
deployments, has no automatic Git attachment, disables previews and exposes
system deployment metadata. `services/logo-worker/vercel.json` defaults to zero
instances in `iad1`; an activated release uses one 1 GiB instance and a
600-second termination grace period. Do not change the web or Naming worker's
project link when operating this project.

`npm run build:logo-worker` emits the cloud main executable, an isolated raster
child and an offline raster-check executable. Separate reviewed first-party
source allowlists bind each graph. Compile-time public metadata pins the Git
revision and exact service project; no environment or credential is embedded.
The existing source-mode raster entrypoint continues to use its original local
path. A compiled child uses its fixed release path and a sanitized environment
without provider, database or Storage credentials.

`npm run package:logo-worker -- --project prj_QSWj13AkZzw4t8ZOGVzncFczz2gC --mode stopped`
requires a clean source revision, matching bundle hashes and unchanged Git
templates. Running `standby` and `active` releases additionally require `main`.
Only the isolated payload under ignored `.tmp/` is deployable. Its Linux Sharp
runtime consists of six exact npm packages, matched to `package-lock.json`,
downloaded from the official registry and SHA-512 verified before a bounded
archive reader copies ordinary files. No npm lifecycle script runs; symlinks,
hardlinks, devices and archive traversal are rejected. The runtime manifest
hashes all 125 extracted files. The native addon and libvips were independently
verified as Linux ELF64 x86-64. Mac native libraries are not uploaded.

The runtime-only Containerfile copies those files and bundles into pinned
Node 22.22.2, runs as `node`, declares no `ARG` and performs no build command.
Vercel still supplies environment settings to image builds as build arguments;
the absence of Docker ARG declarations is not proof of hosted secret safety.
Inspect a stopped synthetic-secret build's logs, image configuration/history and
available provenance before transferring any real credentials.

After explicit transfer approval, only this project's production sensitive
settings receive:

- `EMBEL_LOGO_WORKER_CONFIGURATION_JSON`: the existing dedicated configuration
  with the expiring `storage.accessToken` removed. It retains the existing image
  key and restricted database password; never print it.
- `EMBEL_LOGO_STORAGE_IDENTITY_JSON`: the existing separate protected Storage
  identity, used for its own password sign-in and in-memory refresh rotation.
- `EMBEL_LOGO_DATABASE_CA_PEM`: the public hash-pinned Supabase CA.

Runtime configuration additionally requires `NODE_ENV=production`,
`FLUID_RUNTIME=cloud`, `FLUID_LOCAL_PROTOTYPE=false` and exact production/main
Vercel metadata. The normal run mode also requires
`EMBEL_LOGO_CLOUD_ACTIVATED=true`. The web receives only
`FLUID_HOSTED_LOGO_ENABLED=true`; its provider/worker secrets remain absent.

Before any database, Auth or job activity, the actual bundled child must pass a
fixed 1024-pixel PNG inspection, grayscale normalization and inspection. The
read-only preflight then verifies native TLS, restricted role/OID/owner,
dedicated Auth identity and Storage session binding. `--standby` performs the
same checks, closes host/pool/session resources and waits for shutdown. Neither
mode calls the host run loop, reports readiness, claims or expires work, creates
asset grants or invokes the image provider. Password sign-in creates a normal
dedicated Auth session; it is not a read-only Auth operation.

### Activation sequence

1. Publish and reconcile the verified source through the existing review flow.
   Build an isolated Logo payload from the exact clean merged main revision.
   Verify source, bundle digest, protected project and actual daemon metadata.
   The separate project must remain stopped with no real secrets during the
   synthetic build/secret canary inspection.
2. After Logo transfer/usage approval, install only the reviewed existing worker
   secrets into this worker project's production settings. Qualify a standby
   with the exact restricted database TLS identity and Storage Auth binding.
   Standby must not publish readiness, claim/expire jobs, create Storage grants
   or call the image provider.
3. Let active Logo work settle naturally. Capture the baseline and latest
   readiness deadline before freeze clears it. Execute the freeze packet and
   read back all six disabled flags and absent readiness. A refusal means
   preserve the work and resolve the reported condition; never clear leases or
   resubmit an unknown provider request just to complete a cutover.
4. Stop the Mac Logo command and every supervisor that could restart it. Verify
   actual process exit and wait past the captured readiness deadline. Recheck
   no lease/in-flight request appeared. Database state alone is insufficient
   proof that an external process stopped.
5. Set the Vercel daemon's dashboard scaling override to zero in every region.
   Stop any standby and verify actual exit. Keep that override in place while
   deploying or promoting the active package, then verify its exact revision,
   project and intended single `iad1` instance configuration.
6. Execute enable while the cloud override is still zero. Compare preserved
   rows, then clear the override to allow exactly one cloud process. Confirm
   fresh matching readiness for both operations and actual Vercel process/
   revision evidence. The stable worker ID alone is not a cloud receipt.
7. With all Mac Logo processes stopped, request a real concept batch through the
   signed-in live app, verify six persisted results or explicit partial failures,
   then verify one saved-preview refinement. Reload and confirm prior and new
   images, references, selections and history. Check real provider/accounting
   receipts. Only these observations establish Mac-independent generation.

Every subsequent deploy, promotion and rollback needs the same drain/freeze/
zero-override/stop sequence. Vercel may overlap old and new daemon versions
during a normal rollout, including a rollback; its persistent dashboard override
prevents that overlap here. Restore the same verified source and credentials
only after stopping the other host. Never reset attempts, delete evidence or
replay uncertain work as rollback.

## Local verification and pending evidence

The integrated targeted matrix passes **364 tests in 17 files**, including 90
new cloud configuration/lifecycle checks and 23 independent release checks.
Full TypeScript, ESLint and the production Next.js build pass. These checks
preserve the existing local entrypoint and account routing while adding the
separately enabled cloud path.

Cloud configuration/lifecycle tests cover exact deployment and model identity,
opaque secret handling, actual TLS/role rejection, startup failure propagation,
read-only preflight/standby and shutdown drain ordering. Independent release
tests use synthetic credentials, isolated disposable source and runtime folders,
blocked network and real PNG processing. A simulated parent platform identity
also reaches the blocked database boundary after actual child processing; this
is explicitly **not** execution of the Linux native addon on this Mac.

The new cutover suite passes 27 disposable PostgreSQL scenarios using the actual
migration replay, restricted role, Logo admission and readiness functions.
It checks exact flags, no fabricated readiness, queued-job resumption, replay
safety after a new claim, preservation of every other fixture table and function/
role definitions, cross-owner denial, pending requests and privilege/binding
drift. Together with existing refinement and publication-adjudication suites,
54 tests pass. Targeted ESLint passes. These are local synthetic checks.

### Initial live activation and reliability correction

PR #23 merged as `7618040e6ad3e9ce360444a174383f2bfbf49133`. The approved
credentials were transferred only to sensitive production settings in the
dedicated Logo project. Hosted synthetic secret-canary inspection, actual Linux
PNG processing, native pinned database TLS/role qualification and dedicated
Storage authentication passed. Freeze and enable completed with all 1,527
baseline rows retained. The web and single `iad1` worker used that same revision,
and the Mac Logo process was absent.

The first live six-concept request saved four results. One child remained queued
after an expired claim without a dispatched step. Another retained its confirmed
15,075 micro-USD provider receipt but failed before any publication reservation
or output Storage grant. Its ambiguous step correctly fenced further work in
that project. No provider call was blindly retried. The worker was scaled to zero
after all active leases had ended; the saved results and charge were preserved.

The existing daemon reported one generic restart. Source review found that its
pool error handler stopped the complete host when `pg-pool` had already removed
an errored idle client. The correction consumes that event, lets the pool replace
the idle client, and preserves the existing checked-out identity/lease failures.
Fixed phase/reason events distinguish future startup, run and drain failures
without logging driver errors, credentials or client objects. The old generic
event does not establish the exact cause of the observed restart.

The image handler now replays a failed publication at most once while holding
the original bytes, under the identical immutable request key and content hash.
Every invocation revalidates the current lease and object authority; it never
repeats the image-provider request or receipt recording. Cancellation, permanent
validation/ownership errors, invalid acknowledgements and a second persistence
failure retain the existing fail-closed outcome. This cannot recover bytes that
were already lost from a finished attempt.

Database logs showed SQL cancellation code `57014` across PostgREST, Auth and
management reads during the first test. Two original preservation queries hit
their 30-second read-only deadlines; their resource impact is plausible but not
proven as the cause. The fingerprint query was optimized to about five seconds.
Full preservation audits run after active image work settles. A lightweight
status query is sufficient during generation.

`supabase/activation/logo_cloud_60_absent_publication_adjudication.sql` prepares
an operator-only recovery for the single failed child. Installation records no
decision and grants no client or worker access. Its insertion trigger pins the
job and complete step/provider/reservation/worker-marker hashes, requires a
drained worker, and verifies that no reservation, grant, result, artifact version
or new/unmapped private object exists. The immutable witness retains the original
ambiguous step and confirmed charge. Only the job's terminal status and unused
reservation balance change. A late worker response cannot revive its cleared
lease. The previous uploaded-but-uncommitted witness remains supported; all other
ambiguous outcomes remain blocked. Updated cutover packets pin both the combined
matcher and its new delegated absence matcher, including their existing security
properties.

Six-result, refinement and reload acceptance is verified separately after the
reviewed exact-incident recovery and corrected worker rollout. Deployment IDs
and the final live outcome belong in the release PR and safe operational receipt
in the ignored owner-only `.local-fluid` directory; no credential values are
committed.

### Completed cloud image test and selection check

After the user separately approved the exact database recovery, the reviewed
installation and operator decision completed. An independent before/after check
retained all 1,594 existing rows: only the failed job's terminal fields, its
reservation state and the account's unused hold changed. The original provider
step and confirmed charge remain unchanged, both incident witnesses validate,
and the worker still has exactly its original fourteen EXECUTE grants.

The corrected cloud worker started on main
`13f7fff99008bbc86f756b5843ea17a4d23f864d` at 15:39:27 UTC. Both Logo readiness
lanes were fresh. The never-dispatched queued child resumed normally and saved
its result; normal app retry admitted a separate immutable attempt for the
confirmed publication failure. The live app displayed six ready concepts with
all previews available. One chat refinement of the existing selected Glide
wordmark also completed and saved a new raster while preserving earlier versions.
No Mac Logo or generic worker process was present during these tests.

The eight confirmed image responses total 129,207 micro-USD: 90,605 for six usable
concepts, 23,527 for the refinement and the retained 15,075 failed-publication
charge. All eight reservations settled normally; the pre-existing aggregate hold
and account allowance were preserved. These are recorded image charges, separate
from hosting costs.

The final browser check exposed a client race after refinement completion:
generation returned to idle before the workspace refresh finished, so automatic
selection could submit old expected heads. Two real HTTP 409 responses rejected
that selection without a saved request; the paid refinement itself remained
committed. The selection correction awaits an acknowledged workspace refresh,
rechecks the original source and account, and preserves concurrent user choices.
Recovery of an already-stale manual command requires authoritative absence and a
newer monotonic head, including a second exact-request read to catch a commit
between the first two reads. It must never rebase an uncertain command or repeat
generation. Independent review and 32 focused client tests cover delayed refresh,
concurrent selection, stale commands, late receipts and account changes. Typecheck,
repository lint and the production build pass. Final selection acknowledgement
and reload are recorded with the release evidence.

## Official references checked on 2026-10-19

- [Vercel daemon lifecycle and dashboard scaling](https://vercel.com/docs/daemons/managing-daemons):
  production updates can overlap old/new processes; zero dashboard overrides
  stop instances and persist across deployments.
- [Supabase Auth sessions](https://supabase.com/docs/guides/auth/sessions):
  session expiry and refresh-token rotation apply to the dedicated Storage
  identity; an account or session count alone does not authenticate the worker.
- [Vercel daemon limits](https://vercel.com/docs/daemons/limits): the service is
  in beta and currently runs Linux amd64 in production only.
- [Published compute rates](https://vercel.com/docs/functions/usage-and-pricing):
  the hosting estimate is based on `iad1` memory and Active CPU rates, not an
  actual invoice.
- [node-postgres pool error handling](https://node-postgres.com/apis/pool#events):
  background idle-client errors remove that client from the pool; active
  checked-out operations retain their separate error handling.
