# Historical per-account worker implementation

The current shared runtime uses the [shared worker entrypoint](../shared-pool/README.md).
`npm run build:shared-worker` and its `npm run build:account-worker` alias build
`.tmp/shared-worker/`. The per-account implementation described below is retained
for compatibility and historical review; it is not the shared deployment path.

These modules prepare isolated per-owner hosted workers. Importing them does not
enroll an account, create a role, enable a policy, launch a process or call a model.

`createOwnerWorkerEnrollmentAdapter` requires an explicit approved profile map,
durable credential reservation store and configured process controller. The
controller uses the lease-derived worker SQL installer, immutable public
descriptor files, a reviewed compiled artifact, a dedicated Vault KV-v2 reader
and a separately registered restricted launcher reporter. Vault is an optional
source adapter; this repository does not configure or create a Vault backend.
Provider/database/Storage credentials remain in process memory and IPC. Public
descriptors, SQL and manifests contain references and public identities only.

When the service host has configured HTTP/HTTPS/ALL proxy variables, start Node
with `NODE_USE_ENV_PROXY=1` so its Vault/SDK fetches use that required network
path. Preserve the managed CA variables. Children inherit only the proxy/CA
allowlist and actual deployment metadata, and enable Node's proxy support when
a proxy is configured. No direct-network or TLS-disable fallback is provided.

The historical `node scripts/build-account-worker.mjs` builds `.tmp/account-worker/index.js` and the
isolated `raster.js`, with a reviewed first-party source allowlist and a composite
artifact digest. The package requires the pinned Sharp 0.35.5 native runtime.
The build targets Node 22.22; executing the inert tests on another supported Node
version does not qualify that production runtime. A dirty checkout is recorded
truthfully and cannot activate a worker through the production controller.
The same command builds `controller.js` with its own reviewed graph and separate
`controller-manifest.json`. Default startup reports disabled. Active startup
requires clean source, real production deployment metadata, explicit
`EMBEL_ACCOUNT_SERVICE_ENABLED=true`, canonical HTTPS
`EMBEL_ACCOUNT_SERVICE_ORIGIN`, and the host's `PORT`. The controller reads only
the explicitly configured `EMBEL_ACCOUNT_SERVICE_CONFIGURATION_REF` through
`EMBEL_ACCOUNT_BOOTSTRAP_VAULT_ORIGIN`, `_MOUNT` and `_TOKEN`. That reference holds
`{version:1,service:ConfiguredAccountEnrollmentServiceInput}`. Bootstrap credentials
must come from separately approved secure injection; no source value is provided.
The only mounted route is the platform-verified queue consumer
`POST /api/account-strategy-consume`.

The child independently checks source/artifact/runtime and actual deployment
metadata. Strategy processes accept only existing admitted dispatch descriptors;
Naming uses its durable hosted-owner executor; Logo reuses owner-bound leased
image handlers and independently checks its real dedicated Storage session and
native raster prerequisite. Neither a prepared descriptor nor a mocked process
proof makes an account ready. SQL verifies the current role, policy, heartbeat,
generation, revision and dedicated launcher report before enrollment succeeds.
`spendControl: "uncapped"` selects the explicit aggregate-allowance exception;
existing immutable Logo quotes, per-operation guards and cost accounting remain.

Ready worker steps receive periodic existing enrollment leases. Maintenance
renews the exact approved Logo actor, checks a fresh independent SQL heartbeat
and actual connected child, and records a fresh launcher observation. A known
exited child can resume only after SQL proves stopped-process/job/leadership
quiescence, using the same generation, operation, role and credential. Failed
maintenance closes new admission while preserving leased observation/accounting
authority. Saved enrollment readiness alone does not prove continuous health.

The configured supervisor must retain ownership of its children and drain them
on shutdown. Parent IPC disconnect aborts the child. After an unobserved
supervisor crash, this controller refuses to invent a stopped-process receipt;
external process recovery/qualified drain is required before revocation can
complete.

`service.ts` composes the concrete SQL operator, durable Vault CAS credential
store, monotonic HTTP publication/read source, HTTP/worker adapters, process
controller and existing verified Queue SDK callback. Strategy routing uses only
the admitted immutable descriptor and launcher's SQL-derived current owner
binding. Missing controller/runtime/route authority requests a retry. The source
does not provide a hosted supervisor deployment, select a durable store, create
approved model/provider/policy records or grant launcher/operator access. The
trusted service host must configure and start this composition and mount its
queue-only consumer under the platform's verified queue trigger.
