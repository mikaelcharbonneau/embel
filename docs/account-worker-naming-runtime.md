# Per-owner hosted Naming process

> Historical: retired by the November 2026 Naming generation rebuild (docs/naming-generation-contract.md).

> Historical per-customer candidate. The current shared design is documented in
> [shared-worker-pool.md](shared-worker-pool.md). Keep this packet as review and
> compatibility evidence; use the shared configuration for new deployment planning.

`worker/account-enrollment/naming-runtime.ts` provides the concrete
`runOwnerNamingRuntime({descriptor,secrets,signal,onReady})` child-process entry.
The enrollment controller owns publication, process supervision and credential
resolution. This entry does not create roles, persist secrets, invent platform
metadata or reuse the former fixed-owner cloud launcher.

Startup requires an explicitly approved Naming profile, full matching policy,
dedicated provider key/model verification receipt, dedicated TLS database
credential and a verified artifact attestation. The actual source revision,
clean artifact, hash, deployment, platform and Node/ICU/Unicode runtime must match
the approved configuration and real deployment metadata. The shared database
configuration pins the existing Supabase destination and CA and uses the bounded
JavaScript PostgreSQL driver with certificate verification.

Before readiness, the process independently checks the actual restricted role
name/OID and safety flags, the reviewed managed-principal helper body/metadata,
the exact owner/generation/revision/operation, required RPC execution privileges,
and the approved policy's PostgreSQL JSONB hash. It uses catalog reads and the
narrow own-session proof, without private-table SELECT privileges. Naming does
not require the unrelated Identity helper installation to be qualified.

The runtime reuses `NamingBrainJobStore`, the existing V5 handlers, generation
authority and polling runner. It rejects foreign-owner, local-authority,
unproven and historical capped claims before handler/provider execution. A fresh
successful Naming leadership/readiness report and the separate enrollment
heartbeat precede `onReady`; successful authority renewals refresh that heartbeat.
Deserializing a descriptor or receiving a controller flag never establishes
readiness.

Active enrollment is checked before new paid work and paid continuation. Normal
SQL ownership, lease, generation, Stop, immutable request and duplicate protection
remain authoritative. During revocation, the separately reviewed SQL observation
allowlist retains scoped receipt, provider-item, tool-result, artifact and unknown
outcome persistence, while denying new admission, dispatch and publication.
Cancellation stops scheduling and drains the existing runner/authority before
the controller retires its process credential.

## Offline evidence

Unit tests explicitly isolate Naming configuration checks with stubbed shared
artifact/CA qualification; they do not claim a production-ready process. An
unstubbed test rejects the cloud workspace's unqualified production identity.
Role/scope tests reject foreign, local and capped claims and fenced paid
continuations.

The combined regression uses an actual dedicated per-owner restricted SQL role,
hosted uncapped-v2 admission, the installed native SDK, and the actual reference
reader. Provider HTTP, DNS, reference bytes and model content are explicit inert
fixtures. An observed search and failed allowed read are followed by a second
allowed `read_reference` attempt in the same role call. Useful returned text
produces retained research; both original tool results remain in SQL history.
no factual Creator starts until that research and a valid fifteen-by-ten V5 plan
are durably acknowledged. Every supported selected route has at least five
planned targets. The sourced case reaches 100 across four factual approaches
with independent quoted verification. Missing passages produce zero Creator
calls; a reference declared inapplicable to one selected route retains 95 names,
that route's original deficit, and no additional calls after reaching the honest
available capacity. No arbitrary minimum source count is imposed.

These structural conditions are necessary for supported-route execution; they
are insufficient to establish source quality, attribution truth or live model
acceptance. Live provider quality remains unverified. The ordinary 200-proposal
and 40-part bounds remain unchanged.

The source-only enrollment SQL packets, approved profile/provider registries,
dedicated secret store, reporter, qualified deployment and actual credentials
must be configured through the reviewed enrollment process before this entry
can run. This implementation performed no live provisioning, paid call,
credential operation, worker activation or deployment.
