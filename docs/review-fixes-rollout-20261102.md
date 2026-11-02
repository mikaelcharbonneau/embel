# November 2 review-fix rollout preparation

This is a coordinated web, shared-worker and forward-SQL release procedure for
the existing Embel services. It records read-only preparation; it does not claim
that the changes have been deployed. Runtime validation and the eventual live
release record belong to the exact final committed revision.

## Verified starting point

Read-only checks on November 2, 2026 confirmed:

| Resource | Current production value |
| --- | --- |
| Vercel team | `team_0Koie5796IDOraQkDFg6J0AF` / `embel` |
| Web project | `prj_WKrFUPy3wptZ3qI9l1hTuqPmzkDt` |
| Web deployment | `dpl_5e4FL1oNzhJnjJot8KhkKwhwrNDD` |
| Web source | `e7e51e63f9c3e33d090d6b5a03293ed53c9519ed` |
| Web alias | `https://www.embel.xyz` |
| Shared-worker project | `prj_vTOc6Kf8th7tXK2cOVwWTTaR20yx` / `embel-naming-worker` |
| Shared-worker deployment | `dpl_C1fd6MAvpd1eVu52TBTwtMzukbPT` |
| Shared-worker source | `47e9ef78942a7998b27715988fc60f63fbf503c7` |
| Supabase project | `fricsfwqibyhemknqgyf` / historical name `fluid-platform-dev` |
| Database | PostgreSQL 17.11, database `postgres`, OID `5` |

At `2026-11-02T17:05:43Z`, all three slots were enabled with current leases on
the worker deployment above. There were zero queued/running/cancel-requested
jobs, zero job leases, and zero shared executions outside `closed`. Nine
historical jobs remained `needs_reconciliation`: four Naming, one audience, one
competitor and three reformulation jobs. Keep these rows and their accounting
evidence. Their presence is not proof that a worker is still executing them.
An additional read-only classification found no shared admission, shared
execution, brainstorm call or completed brainstorm event for any of these nine
jobs. They are legacy records outside this new shared delivery-recovery path;
this rollout is not expected to recover them or settle their costs.

| Lane | Slot | Fixed role / OID |
| --- | --- | --- |
| Strategy | `e1d62ccc-f8e9-4a30-b751-9935e60f2fa1` | `embel_shared_strategy_prod_v1` / `30936` |
| Naming | `ee17c8b3-325f-4c75-b083-76f7f754d7ec` | `embel_shared_naming_prod_v1` / `30939` |
| Logo / Identity | `b775e7b1-444b-43d3-b44d-c6e193db8562` | `embel_shared_logo_prod_v1` / `30942` |

The latest Naming owner binding is revision `9`, ID
`7651f6c5-8da9-4c88-9429-f29b002faa08`. Its owner is
`6840f4c2-15a6-45a7-97be-41e7e5e37f42`. A deployment change appends an approved
successor through `fluid_private.shared_naming_adopt_existing(uuid)` after the
new slot advertises readiness. It must not update an existing binding in place.

All 291 catalog entries in the deployed worker's source authority manifest
matched live body hashes, ownership, language, volatility, definer/leakproof
flags, search paths and broad EXECUTE exposure. This was a read-only catalog
check, not a provider test. Refresh these facts immediately before cutover.

## Access recovered during preparation

The connected Vercel tools support source upload, deployments, environment edits
and production rollback, but expose no daemon listing/scaling tools. The
alternate connected API gateway returned `UNAUTHORIZED`. The user subsequently
completed the official Vercel CLI device login. Authenticated CLI 65.9.0 read-only
requests resolved the daemon/configuration access gaps at approximately 17:11
UTC. No production mutation was made during this preparation.

Both `vercel_get_project_env` and
`vercel_filter_project_envs(decrypt="true")` return the plain
`EMBEL_SHARED_WORKER_POOL_CONFIGURATION` value truncated inside the tool result:
2,014 characters ending in literal `[truncated]`, with `structuredContent: null`.
The environment variable ID is `ULqwKsbPZazBaTF2`. This is not a complete
configuration backup. Do not reconstruct its remaining fields from defaults or
overwrite it with the truncated value.

The authenticated raw API returned the complete 9,795-byte configuration value,
SHA-256 `66478ff26b8f4f8a95952491b20c3cc54a15e6c55814045214522647298ec168`.
Its current artifact hash is
`0cd1b4f7d6dd9a8097cd294fdc41932e5a10b94ba316408ed5f2588becb8d9b8`.
A private local backup is retained under the ignored rollout directory. Use the
raw API for complete configuration readback; the connector truncation still
applies. Preserve credentials without displaying or copying them into source.

The daemon API reported one ready `shared-worker` instance in `iad1`, on the
current deployment listed above, with a 600-second termination grace period.
Effective instances were `{"iad1":1}` while the deployed configuration remained
`{"iad1":0}`. This confirms an active persistent scaling override. The alternate
API-text project `prj_waP1hoGVtBiqJCTqTWKHfRy8iLMk` reported no daemons.
The legacy Logo project `prj_QSWj13AkZzw4t8ZOGVzncFczz2gC` reported its
`logo-worker` with zero desired, total and ready instances. Refresh both
readbacks at handover; these observations do not authorize another publisher.

## Build and upload the final source

Use a clean committed source revision for both releases. Complete typecheck,
lint, relevant tests, production web build, native SQL checks and the affected
desktop/mobile journeys. The source-upload web staging directory must contain
exactly the application inputs allowed by [`.vercelignore`](../.vercelignore).
Build that staging directory too: a successful full-checkout build does not
prove that omitted upload inputs are available on Vercel.

The existing worker scripts are reusable:

```sh
npm run build:shared-worker
node scripts/package-shared-worker.mjs \
  --project prj_vTOc6Kf8th7tXK2cOVwWTTaR20yx --mode stopped
```

The packager prints its isolated release directory and source/artifact identity.
It requires clean committed source, validates the manifest and runtime pins,
and writes `shared-worker.instances.iad1 = 0`. Run the credential-free
`node dist/index.js --native-smoke` from its `shared-worker` directory using the
pinned Linux x64 Node `22.22.2` runtime. Retain its evidence and the package
manifest. See [worker packaging](../services/shared-worker/README.md).

Use `mcp__codex_apps__vercel_upload_file` with each file's base64 bytes, SHA-1
digest and byte count. Then use `mcp__codex_apps__vercel_create_deployment` with
the reviewed `{file, sha, size}` list, the exact existing project ID,
`target: "production"`, `forceNew: "1"`, and the final commit in both
`gitMetadata.commitSha` and `meta.githubCommitSha`. Record the worker artifact
SHA-256 in metadata too. The worker package uses framework `null`, empty install
and build commands, and output directory `static`. The web retains its existing
Next.js project settings. Inspect READY status and the resulting immutable
deployment IDs; a request acknowledgement is not successful publication.

Production worker uploads must follow the scaling stop below. A project-level
scaling override survives deployments and can override the package's zero
instances. A stopped `vercel.json` alone is not evidence of a stopped runtime.

## Stop, drain and apply the forward SQL

The documented daemon API is:

```text
GET /v1/projects/prj_vTOc6Kf8th7tXK2cOVwWTTaR20yx/daemons
PUT /v1/projects/prj_vTOc6Kf8th7tXK2cOVwWTTaR20yx/daemons/shared-worker/instances
    ?target=production&teamId=team_0Koie5796IDOraQkDFg6J0AF
Body: {"iad1":0}
```

Read back actual instance state and every configured region. The PUT replaces
only named region overrides. Stop any additional active region explicitly.
With authenticated Vercel CLI 64.3.0 or later, equivalent commands are:

```sh
vercel daemons scale shared-worker iad1=0 \
  --project prj_vTOc6Kf8th7tXK2cOVwWTTaR20yx --scope embel
vercel daemons instances ls shared-worker \
  --project prj_vTOc6Kf8th7tXK2cOVwWTTaR20yx --scope embel --json
```

Wait for the actual daemon to stop and for SQL leases to release or expire;
preserve the configured 600-second graceful shutdown. Re-run this read-only
drain query through `mcp__codex_apps__supabase_execute_sql` on
`fricsfwqibyhemknqgyf`:

```sql
select jsonb_build_object(
  'observed_at', clock_timestamp(),
  'live_slot_leases', (select count(*)
    from fluid_private.shared_worker_slots where expires_at > clock_timestamp()),
  'unfinished_executions', (select count(*)
    from fluid_private.shared_worker_executions where state <> 'closed'),
  'active_or_leased_jobs', (select count(*) from public.jobs
    where state in ('queued','running','cancel_requested')
      or lease_token is not null or lease_expires_at is not null),
  'historical_reconciliation', (select count(*) from public.jobs
    where state = 'needs_reconciliation')
) as drain;
```

Require the first three counts to be zero. Do not clear leases, close unknown
executions or settle reservations to satisfy the guard. Capture fresh hashes
of jobs, job steps, admissions, executions, usage accounts/reservations, saved
names, Naming runs/feed, and brainstorm calls/events/publications/completions.
Also capture the exact slot identities, policies, current bindings and pilot
authority. These are before/after preservation witnesses, not new authority.

The only new forward packet is
[`shared_naming_brainstorm_delivery_recovery.sql`](../supabase/candidates/shared_naming_brainstorm_delivery_recovery.sql),
SHA-256 `c1bee52bffdcc2ebd26680dfe6b553b00388e63168139ee8cd428efc36d34ab3`.
Its [source authority manifest](../worker/shared-pool/authority-manifest.json)
contains 292 functions, 270 required by workers. The prepared manifest hash is
`79cbaeab6aabcba62248666617fb97dac14d2a7bee9b90c511b36ea26cb55869`.

Use the `postgres` owner connection and a named forward migration through
`mcp__codex_apps__supabase_apply_migration`. The guarded transaction must confirm
the exact target, stopped old slots, fresh drain witnesses and unchanged
protected data under locks before executing the packet's statements. Preserve
its empty search path, two-second lock timeout, 30-second statement timeout and
exact predecessor checks. The live gateway predecessor is the event-capacity
version, `5b9e16f786364d7cb5e58a5b9380a1da3490f5c950f8dfb7f47fde435518d7f9`.
Confirm the final catalog matches the new source manifest and protected data
hashes are unchanged before committing. Do not run the initial-install
`prepare-shared-production-migration.mjs` composer against this existing database.

## Configure, register and activate the replacement

1. Keep the worker scaling override at zero. From the complete saved worker
   configuration, change only the new artifact's source revision/hash and
   source-derived changed RPC proof. Preserve the fixed roles, policies,
   provider bindings, capacity, queue, runtime fingerprint and secrets. Both
   target and queue deployment selectors remain `"platform"`. The new Naming
   gateway proof is
   `1a044e660bde27bf2d16cb3acce55fbe3e4f6bb88ada104ef354cc9b39c58d4f`.
   Edit only the production configuration variable, then read its complete
   value back and compare it to the prepared JSON before creating the worker
   deployment. Existing deployments retain their captured environment.
2. Upload the stopped worker package. Read back its READY production deployment,
   source/artifact metadata and zero actual instances. Publish the matching web
   before starting the new worker: the web must understand the optional
   `recoveredNameCount` summary before recovery can emit it. Verify
   `/api/health` reports the final web source and the canonical alias resolves to
   the new deployment.
3. With both worker generations stopped, perform an owner transaction that
   locks the slot registry and protected job/accounting/history tables, checks
   fresh unchanged witnesses and final source authority, and updates **only**
   `shared_worker_slots.deployment_id` from the recorded old deployment to the
   exact new one. Require exactly three rows. Keep role/OID, policies, enabled
   state, generation, instance and lease fields unchanged. Append a uniquely
   identified receipt to the existing `shared_stopped_rollovers_v1` table.
   Read that receipt after an uncertain acknowledgement; do not replay blindly.
4. Set the reviewed daemon override to `{"iad1":1}` and read back one actual
   new-deployment instance. Confirm all three new-generation leases and runtime
   readiness. Startup's source-owned catalog verification must pass before
   provider dispatch. No other worker project or old daemon should publish.
5. Once Naming reports a current matching readiness fingerprint, append an
   owner-authored `shared_naming_adoption_approvals` row with the exact prior
   binding ID/revision, existing pilot authority, new slot/deployment, unchanged
   policy and readiness fingerprint, a unique approval ID, and a short expiry.
   Call `fluid_private.shared_naming_adopt_existing(approval_id)` in the same
   transaction. Verify revision `10`, the revision-9 predecessor, and the new
   deployment. Preserve every old binding and job/admission row.
6. Check the main branding journey and existing saved outputs. For Naming
   recovery, verify retained names become usable without another provider
   create and with unchanged original call identities and unknown accounting.
   A historical job remaining `needs_reconciliation` is expected. Report any
   actual paid verification separately from local fixtures and read-only checks.

## Rollback

Retain the original web and worker deployments, full original worker
configuration, original authority manifest, and immutable rollover/adoption
receipts. Rollback requires fresh hosting and SQL drain witnesses, unchanged
fixed identities/policies, the exact known successor, and no active execution or
lease. Stop the replacement and preserve any work that occurred after release;
do not compare current data to a stale pre-release snapshot and rewind it.

Apply
[`rollback_naming_brainstorm_delivery_recovery.sql`](../supabase/operator/rollback_naming_brainstorm_delivery_recovery.sql)
under the same stopped/locked owner procedure. Its SHA-256 is
`06ed2a031493db1b52dea0fe40c22d8b49f823ac8ae5705478c51919e75a0aaa`.
It restores the previous gateway and summary with exact source guards, preserving
the event-capacity fix. It retains delivered names, recovery receipts, provider
evidence and financial uncertainty. Verify the prior 291-function source
manifest and unchanged current protected data before continuing.

Restore the original full project configuration for future deployments. While
scaling remains zero, return the three slot deployment IDs to the recorded old
worker through a separately guarded, receipted transaction. Use
`mcp__codex_apps__vercel_request_rollback` with the worker project and
`dpl_C1fd6MAvpd1eVu52TBTwtMzukbPT`, read back its production status, and then
restore its one-instance override. After actual old-worker readiness, append a
new Naming binding successor to that deployment; if revision 10 was installed,
rollback appends revision 11. If adoption had not happened, retain the still
valid revision 9. Never delete the successor history to simulate a rewind.

Restore web traffic with `vercel_request_rollback` targeting web project
`prj_WKrFUPy3wptZ3qI9l1hTuqPmzkDt` and
`dpl_5e4FL1oNzhJnjJot8KhkKwhwrNDD` after the old summary contract is restored.
Read back the alias and health release. Keep the October 30 Identity writer
permission correction installed; it is unrelated to this rollback.

The fresh forward installer intentionally rejects retained recovery objects.
After rollback, a later roll-forward needs a reviewed function restoration;
do not delete evidence tables or rerun the fresh installer to bypass its guard.

## Local preparation convenience

This workspace contains an ignored, offline-only compiler at
`.tmp/review-rollout-20261102/prepare.py`. It emits inventory/authority queries,
configuration and stopped-worker upload payloads, forward SQL, receipted slot
registration, Naming adoption, and corresponding rollback SQL. It opens no
network connections and has no execution mode. It requires clean final source,
matching build hashes, complete configuration and fresh actual hosting/SQL
readbacks. Its files are a local convenience; the invariants and ordering above
remain the release requirements.

Nine offline compiler checks passed, including stale/live baselines, changed
policies, incomplete configuration, immutable registration/adoption and rollback
composition. Only its inventory and prior-authority queries were run against
production; generated mutation transactions have not been executed there.

Platform references: [daemon management](https://vercel.com/docs/daemons/managing-daemons),
[instance override API](https://vercel.com/docs/rest-api/daemons/override-a-project-daemon-s-instance-counts),
[prior live release](visual-identity-release-20261030.md), and
[Naming delivery semantics and native verification](naming-delivery-recovery.md).
