# Naming maintenance and paid authority repair

> Historical: retired by the November 2026 Naming generation rebuild (docs/naming-generation-contract.md).

This local phase-two change starts from remote main `56efd115c67baab57c478c60cb186e2bd7e321f6` plus the independently frozen phase-one receipt and index repairs. The full 2,329-file shared baseline identity is `521690e742b3bf6a2b9429f3ee733f87e0ea2fcacc1affb1e14fa8da9627f233`. No production connection, migration application, provider call, deployment, worker resume, or repository publication is part of this work.

## Problem and resulting behavior

Previously every empty Naming claim and expiry call took the account/owner lock. Independent PostgreSQL 18 baseline probes returned null/zero but changed the billing-route tuple's `xmax`; a second session holding that lock made both calls time out. This is a proven local locking defect. It does not establish the cause of Supabase resource pressure. Naming's production pause did not establish systemic recovery, and resource time series were stale.

The additive migration `20261026161000_naming_worker_authority.sql` first checks for eligible work using read-only predicates. Empty claim and expiry probes return before taking any owner, leadership, job, or context-table mutation lock. Existing original implementations still repeat their eligibility, ownership, cancellation, accounting, and recovery proofs after the owner lock for positive work. The expiry implementation processes at most twenty rows across its original two recovery loops. Its no-dispatch settlement proof remains intact.

Maintenance leadership is separate from paid readiness. A disabled policy can leave one maintenance leader able to observe old known sessions, attest preferences, and settle proven no-dispatch failures. It cannot authorize new paid inference. Healthy publishers cannot replace one another. Expired leadership is acquired with an incremented generation, including reuse of the same process ID string. Renewing with an old generation cannot reacquire leadership.

## SQL and runtime contract

`report_naming_brain_worker_status(policy,deploymentId,workerId,generation|null,leaseSeconds)` returns version 1, boolean `leader` and `ready`, `generation`, `expiresAt`, `serverTime`, and a reason (`leader`, `held`, `expired`, `fenced`, or `binding_mismatch`). Followers have null generation and expiry and false readiness. A null-generation replay of the live owner's lost acquisition acknowledgement returns the original expiry without extending it. Only an exact, unexpired generation renewal extends the lease. `serverTime` is constructed after mutation/lock waits; runtime derives a conservative monotonic deadline from the server interval, not local wall-clock agreement. A cleared readiness timestamp always produces boolean false until a valid renewal.

`naming_brain_worker_maintenance_v2(workerId,deploymentId,generation,action,payload)` accepts only:

- `preference_work {limit:20}`: read the existing preference work list.
- `attest_preferences {projectId,preferencesVersion,preferencesHash,fingerprint,readiness}`: invoke the existing attestation contract under the fence.
- `expire_leases {limit:20}`: process at most twenty original recoverable rows.
- `claim {leaseSeconds:120}`: return the existing claim envelope and bind its new job lease to this exact leadership generation.
- `assert_continue {jobId,leaseToken}`: recheck paid continuation authority under mutation locks. Runtime must apply this to required-action/tool-result POSTs as well as new creates.

A successful v2 claim alone writes `naming_worker_job_authority`. Heartbeat and `resume_execution` cannot update that binding. Reacquiring leadership with the same worker ID does not upgrade an older job lease. The shared paid-readiness helper requires the exact job lease, worker, deployment and generation binding for leased paid work. Its established local/hosted unlimited predicate remains in force: retained `observed_overrun=true` evidence is not a new monetary stop. Historical capped profiles keep their original gates.

Existing leased evidence operations retain their original owner, role OID, job lease, request identity, Stop, and accounting checks. This migration does not add a blanket leadership check to receipts, tools, original provider items, terminal evidence, or settlement. Uncertain authorized creates without a known provider identity remain unresolved; the repair cannot infer they never happened. New paid work is refused after leadership loss; known-session GET-only recovery belongs to the coordinated runtime adapter. An authorization fence cannot retract a request already accepted by a provider.

## Locks and security

Positive maintenance order is owner/account → leadership → existing job/run/step/receipt locks. Acquisition/takeover follows owner/account → leadership → pilot. Healthy renewal takes leadership → pilot only and never then seeks owner/account. Read-only preference work and empty advisory probes take none of these mutation locks. Followers return before locking. Authority and business predicates are checked again after the actual owner wait, not only before it.

The original public RPC OIDs and ACLs stay in place. Existing function bodies are pinned by MD5 plus owner/language/volatility/security/search-path checks before private verified cores are cloned. The migration adds three private forced-RLS tables and tightly scoped helpers. It revokes hostile default grants from every new object, including unknown default-privilege grantees. Only already bound restricted Naming worker roles that already have claim permission receive the two new public RPC grants. A newly provisioned role needs explicit operator grants using the existing provisioning/release process; this change does not create login roles or credentials.

The context table is a trusted transaction-local capability keyed by backend and transaction, inaccessible to the restricted login. It is inserted/deleted only around positive gateway mutations. A caller-controlled GUC could be forged, so it is not used for authority. Positive context writes are an explicit remaining cost; empty probes do not shift their previous writes into that table.

## Compatibility and rollout limits

Use a stopped, coordinated release. Old signatures remain callable before v2 enrollment. Once a deployment has a leadership row, unversioned claim/expiry and readiness publication fail closed; unversioned preference attestation fails closed for an enrolled owner. Old binaries cannot silently become leaders. The new hosted runtime must not fall back to the legacy gateway on missing v2 SQL or schema errors. Callback-omitted historical/local adapters retain legacy behavior until their scope is enrolled; they are not evidence of hosted v2 qualification.

Known historical deployments are recognized only from current pilot binding or an actual owned historical run with the original restricted role/OID proof. No arbitrary deployment enrollment is allowed. Enabling v2 can require an existing leased job to be safely re-claimed before paid continuation; it does not erase its observations. A stopped release must inspect those jobs and unresolved outcomes. No deployment or restart is authorized here.

The migration is transactional, additive, non-concurrent DDL. It aborts on predecessor drift or object collisions and does not repair them automatically. Production lock duration, relation size, catalog permissions and provider-specific migration ordering still need a bounded operator preflight. No performance result here is permission to apply it live. The repository's historical `local` migration filenames require the established chronological migration sorter; a generic filename-order replay is not an equivalent rehearsal.

## Evidence and remaining gates

The dedicated PGlite suite executes the full 85-migration history and restricted-login RPCs. It covers healthy/follower/lost-ack status, disabled-policy transitions, expiry/takeover, stale job binding, explicit Stop/policy/owner gates, capped versus local/hosted unlimited overrun behavior, no-dispatch settlement, bounded 20+5 expiry, unknown/future/exhausted records, deterministic preparation and terminal recovery, bootstrap attestation, historical rows/ACLs, predecessor drift, and hostile default privileges. PGlite is not native concurrency or WAL evidence.

Six native cases ran on reviewer-provisioned PostgreSQL 18.6 with exact loopback/server/cluster/data-directory identity and `fsync`, `full_page_writes`, `synchronous_commit` enabled, `wal_level=replica`. The retained disposable database is `receipt_75201_1793032649172`; its four generated fixture roles are recorded in the sanitized retention manifest. All clients closed and the exclusive slot was released. The reviewer retains server lifecycle ownership.

Five empty probes completed in 1.04–4.50 ms while another backend held the owner lock, with 150 ms lock timeout. Full tuple `xmin`, `xmax`, `ctid`, business values and recorded evidence stayed unchanged. Healthy renewal also completed under the account lock; only its expected control rows changed. Two simultaneous acquisition backends (75216, 75217) yielded exactly one generation-2 leader. Tests observed actual lock waits before policy and generation changes: claim returned null after policy withdrawal; continuation raised `PT409` after the committed generation change. A real public takeover queued before old dispatch; stale dispatch returned false while the still-leased job remained readable.

Contextual WAL during the bounded legacy/v2 empty-probe intervals was 144/56 bytes. These are small disposable-cluster observations, not zero-WAL or production-I/O claims; background or transaction records can contribute. The generation visibility isolation case uses an explicit disposable owner-locked generation update; the separate overlapping acquisition and takeover-before-dispatch cases exercise the real public CAS path. Native tests do not model production dataset scale, network faults, provider billing, or every possible interleaving.

Executed native SQL SHA-256: `d872af297f27e6b577a25e479838f762d0d2cce441d40910a519ca5ada459c19`. Before/after hashes were unchanged. Sanitized evidence is in the task workspace `phase-two-db-evidence`, including `naming-worker-authority-native-result.json`, native test log, source manifests and retained fixture metadata. The independent reviewer owns the final combined aggregate and composed runtime/provider-stub acceptance. No test count alone establishes architectural correctness.

Local verification completed: 165 distinct focused PGlite/database contract tests across thirteen files, plus six native concurrency cases. Typecheck, full repository lint, production build and patch whitespace checks pass on the database specialist snapshot. The full application aggregate and final combined runtime snapshot remain the independent reviewer’s gate.
