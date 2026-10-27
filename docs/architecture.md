# Embel foundation architecture

## Shared account and worker candidate

The October 27 source candidate replaces per-customer database-password and
resident-process provisioning with fixed restricted worker slots and finite
server credentials. Confirmed signup creates account metadata. Each execution
derives its tenant from an immutable database admission, job lease, slot
generation and policy. Home, Identity and Logo web operations use verified
session-bound request capabilities; customer JWTs still govern web Storage.

The worker uses outbound Vercel Queue polling and a durable Strategy outbox.
Unknown outcomes retain observation authority and receipts without reserving
every execution slot or creating another provider request. New target setup,
credentials, real acceptance and release remain separate from source validation.
See [shared worker setup and security boundaries](shared-worker-pool.md) and
[shared web authority](../src/server/shared-account/README.md).

The earlier account-enrollment/Vault candidates remain historical review and
compatibility evidence. The shared configuration selects the new facades and
prevents fallback to their per-customer runtime. No hosted migration or
production deployment is implied by these source changes.

## Hosted Naming execution

Verifier quote positions can be bound to exact retained source text with a
separate immutable raw-item witness. Inaccurate positions require a unique
literal match; existing exact spans remain unchanged. Strict evidence, source
ownership, provider history and database completion proof remain mandatory.
See [quote binding and guarded release plan](naming-quote-binding-20261026.md).

The October 25 user correction rejects monetary limits. Future hosted Naming
uses the existing uncapped native Agents profile with `providerBudgetVersion: 2`,
without `spend_control`. Historical capped requests, holds and unknown costs stay
exact. The [native restoration record](naming-native-restoration-20261025.md)
describes the complete mocked flow and coordinated migration/activation sequence.
Original research, Luna/xhigh, cancellation, ownership and recovery are retained;
the inactive Responses candidate is not needed for native activation.

Future progressive role requests can carry a separate immutable
`progressiveContractVersion: 2` marker without changing the existing run profile.
It freezes an application-specified fifteen-by-ten Director allocation and a
distinct required-action reference witness. Saved requests retain their original
wire bodies and hashes; actual retrieved excerpts and factual-route verification
remain mandatory. See [generation contract corrections](naming-generation-contracts-20261023.md).

D083 extends the existing owner's progressive Naming flow to the production
application. A production routing opt-in selects account-scoped hosted RPCs;
private database capabilities bind the exact owner, pilot, policy, restricted
worker role and deployment. Future hosted jobs carry a distinct immutable
authority, and worker claims independently project the trusted execution scope.
Historical local and normal jobs retain their existing requests and hashes.

The web keeps account persistence and authenticated ownership. The existing
restricted Mac worker performs provider work outside HTTP lifetimes and retains
the provider key locally. Its heartbeat gates hosted generation. Deployment of
the web alone does not keep the Mac worker online. See
[hosted Naming activation](hosted-naming-generation-20261018.md).

D084 prepares a dedicated Vercel Daemon for moving that same Naming execution off
the Mac. The user selected Vercel after declining the Render proposal. The
separate protected `embel-naming-worker` project receives only an isolated,
verified Naming bundle and a runtime-only container. The web project receives no
worker credentials. Runtime gates bind the exact Vercel project, main/source
revision, Node/ICU/Unicode fingerprint and native restricted TLS login. Read-only
preflight and standby modes precede any worker mutation. Existing job-derived
authority and immutable database/deployment bindings remain authoritative.
The committed manifest has zero instances; activation requires an explicit
release mode and environment flag. Cutover and subsequent Vercel rollouts require
no overlapping readiness publishers, with dashboard scaling overrides used when
stopping a deployed worker. The migration design separates credential configuration from the guarded
cutover and requires verified worker identity before execution. See
[cloud Naming worker](cloud-naming-worker-20261019.md).

## Cloud Logo execution preparation

D085 prepares the existing concepts and saved-preview refinement lanes for a
separate Vercel Daemon. The production web opt-in checks the exact canonical
project, origin and production environment before choosing the existing
authenticated `local_logo_operation` RPC. Its historical name and the fixed
worker ID remain compatibility identifiers; Postgres still enforces the exact
owner, policy, worker, request and lease. This does not grant a client-selected
owner or change generic admission for other accounts or operations.

The worker reuses the restricted Logo database principal and the separate Storage
Auth identity. Provider and Storage credentials belong only to its production
environment. A renewable in-memory Storage session retains the existing
job-bound grants and immutable private object publication. The cloud image must
include the isolated raster child and verified Linux native image dependencies;
bundling the JavaScript alone is insufficient. Mac/cloud and cloud/cloud
readiness publishers must not overlap. Activation follows the reviewed drain,
freeze, stopped deployment, identity qualification and re-enable sequence. See
[cloud Logo worker](cloud-logo-worker-20261019.md) for verification and the
remaining transfer/activation boundary.

## Local prototype execution

The local simplification recorded in D077 preserves the account database,
current UI and saved work. Its explicit `npm run local -- --prototype` entrypoint
builds this checkout and supervises Next.js and the existing Strategy/Naming
worker at `http://127.0.0.1:3106`. The local opt-in is bounded to that origin and
cannot activate on a hosted deployment. The default legacy launcher is separate.

Home saves the project before AI admission. Name enters project Naming directly;
Brand uses the existing competitors → audience → personality interview. New work
in Names uses the same project Naming path, with earlier standalone requests
retained as history. Signed-in creation no longer depends on space in the legacy
browser-draft collection; recovery remains explicit and owner-bound.

Local Strategy uses the database worker heartbeat and existing durable job,
provider and result-save contracts. Additive scoped capabilities replace local
hosted queue publication and rollout/subscription prerequisites. Only newly
admitted local jobs receive this authority. Unknown outcomes block their own
project, while unrelated projects can proceed. The local prototype implementation
has no monetary or quota admission gates; historical jobs and holds remain unchanged.
The web receives
no provider or worker database credentials. This implementation remains subject
to the real acceptance recorded in [local prototype](local-prototype.md).

Local Naming recovery revalidates retained genuine completed responses. When
both Research and Director receipts identify the explicit local execution mode,
the Director's self-reported novelty flag is advisory for initial and subsequent
batches. Actual normalized-name deduplication, selected-approach coverage and
factual-source validation remain mandatory. Native/default validation is
unchanged. Successful recovered completion and the existing continuation gate
run atomically; a new stage receives its own execution deadline. Every issued
sibling is observed before classifying a failed or unresolved set. This does not
permit continuation around an unknown issued call, cancellation or deletion.

New trusted local Naming jobs record `localTimingVersion: 2` in their immutable
input. Those jobs give each provider call up to 15 minutes from its database
authorization time, bounded by a 20-minute single-role stage envelope or the
existing one-hour Creation/Gap envelope. Earlier jobs without that witness retain
their four-minute request reconstruction and saved hashes. Earlier queued work
does not consume another call's own window, and recovery cannot reset either
clock. The local stream permits normal high-volume
SSE framing while retaining final-output, schema, source, identity and time
bounds. See the live evidence in [local prototype](local-prototype.md).

The server derives an optional local scroll-resume capability for a current,
safely resumable failed or partial run. A fresh native result-grid interaction
may then invoke the existing idempotent Resume action. Saved pages load first;
polling, remounts, synthetic events, paused work, unknown outcomes and stale
account/context cannot create that resume request. This changes behavior plumbing,
not the approved chat and grid layout.

Durable authorization and provider create invocation are separate boundaries.
Local failures before create can close only with an acknowledged exact per-call
`local_dispatch_not_attempted` proof. A pre-create base receipt alone is not
terminal evidence, and any attempted create with an unknown outcome remains
unresolved. Ordinary local Creator failure stops new assignments while already
started calls settle within their own bounds; explicit cancellation still aborts
them. Stage reads are sequential within each load to avoid flooding the small
connection pool and delaying heartbeats.

The local prototype supervisor keeps the web available when its worker exits and
attempts at most three worker replacements with one-, two- and four-second
backoff. Explicit shutdown cancels backoff and bounds termination of its own
children. Fixed operational events record child role, exit code and signal.
Transient local Strategy readiness failures retry without stopping Naming;
Strategy claims and provider dispatch still require an acknowledged readiness
check. These supervision and readiness changes do not change hosted behavior.

## Account-first persistence

D065 supersedes the historical local draft and Names persistence sections below.
The database is authoritative for signed-in project and standalone-tool work.
Projects and tool libraries expose one account workspace; local device copies
are recovery material, not a second source of ordinary content. Home may accept
an initial prompt before sign-in, but saving work requires a verified account.

Changes use the existing authenticated APIs, server-derived ownership and RLS.
Debounced, serialized writes acknowledge Saving/Saved states, preserve edits
entered during a write, and use expected revisions to detect conflicting changes.
A failed save retains the draft and exact pending request; a retry never silently
changes its identity or falls back to a claimed local success. Names persists its
existing validated workshop graph and history without changing transformation
semantics. Its account memory is hidden during session re-verification and fenced
against a different owner or a late response.

Account-scoped creation, upload and singleton saves send the captured account ID
in `X-Embel-Account`. The API compares it with its authenticated identity before
writing, rejecting a stale tab after another tab changes the shared session.
This is an expected-account fence, never a client-selected owner; RLS and all
ownership decisions still derive from the authenticated session.

Account project creation accepts an optional stable request key. An owned exact
replay returns the existing project rather than creating a duplicate; conflicting
reuse is rejected. Legacy local data remains unchanged until an explicit recovery
selection and account confirmation. Recovery and ordinary creation do not start AI
unless the user separately sends a prompt under the existing admission contract.

## Guided brand interview

D063 supersedes the earlier Strategy conversation presentation below. The account workspace now uses a focused interview in the order competitors, target audience and brand personality, with real competitor research shown by the same inline animated Embel thinking mark as later replies. Detailed choice cards explain recommendations without preselecting them; the normal composer accepts custom answers, clarifications and explicit requests to revisit a stage. Positioning is not appended to this interview.

Optional versioned `intake.guidedInterview` metadata stores actual user-message references, exact saved input revisions and explicit decisions. Assistant content remains exclusively in immutable owned job results. API input v2 freezes bounded owned assistant history at admission; guided output binds its turn/stage and distinguishes choices, question, answer, accepted custom decision and requested redirect. The browser never supplies assistant history. Account orchestration saves canonical selections before requesting the next widget; old snapshots and results remain readable. Completed decisions remain valid during clarification, and explicit revisits clear the affected review facts.

Automatic saves retain a pending context in owner/generation-fenced session memory until acknowledged. Conflicts and lost acknowledgements keep that branch available for retry, latest-version recovery or a browser backup. A persisted turn retains its revision-derived request identity across reload; unknown provider outcomes remain reserved and cannot be replaced by an automatic retry. New guided runtime policies and private operation grants preserve existing lease, source, usage, cancellation and restricted worker boundaries. See [guided runtime](guided-interview-runtime.md).

D086 isolates the existing operator-granted hosted Strategy testing lane from
unrelated Naming and Logo requests. An owned target project and the exact
existing per-operation testing authority are required. Unresolved Strategy work
across the account and uncertain work in that target project still block new
requests. Account-wide confirmed or observed overruns remain blocking. Exact
research and Logo adjudication witnesses can establish a resolved outcome
without rewriting its retained ambiguous step or accounting. Ordinary accounts
and reads without a target project retain their global guards.

Availability, admission and execution use the same scoped predicates. Paid
execution derives its project from the existing restricted worker gateway and
immutable job descriptor; a caller flag cannot establish that context. The
testing account's single active Strategy slot counts Strategy work and work in
the target project. All historical rows and grants are retained. Initial
conversation errors show the actual request blocker and do not claim that
pending edits are saved. See [Strategy request isolation](strategy-request-isolation-20261019.md).

Sign-in and account creation support intercepted native dialogs alongside direct-page fallbacks. Both render the same server-configured form inside the existing account-session provider; dismissal preserves drafts and the pending authentication fence. Email confirmation uses a bounded PKCE exchange and a configured-origin redirect. See [Sign-in overlay](auth-overlay-design.md) and [account creation](account-creation.md).

Settings follows the seven approved Figma categories. The presentation composes existing account, local drafts, text readiness, local ChatGPT and recorded usage components; no new settings API or persistence contract is added. Unsupported preferences and integrations are disabled rather than represented as saved settings. See [Settings design and behavior](settings-guided-design.md).

## Scope and intent

Build an external brand workspace that starts from any useful idea or result, preserves context, and guides missing strategy. The initial deliverable is a runnable local foundation with validated contracts, honest integration states, tenant-safe persistence design, and durable job semantics. It is not a claim that live AI, purchasing, trademark clearance, or vector production already works.

## Processes and boundaries

- Next.js web: accessible shell, project intake, review and editing, authenticated APIs, job status, private download authorization. All write requests validate shape and authenticated ownership.
- Postgres: authoritative projects, context, selected audience/competitors, immutable asset versions, operation jobs, partial outputs, budget reservations, idempotency keys, leases, and audit provenance. Supabase RLS enforces ownership even when application checks fail.
- Dedicated Node worker: claims queued work with leases, persists partial results, checks cancellation between units, records provider request IDs and usage, and reconciles uncertain outcomes. Browser closure never owns worker lifetime.
- Provider adapters: configurable text operation routing and separately gated image model. Unconfigured providers return explicit blocked errors. Domains, handles, trademarks, and vector exports have distinct evidence-bearing contracts.

Code layout: src/app + src/components (frontend), src/domain (shared Zod contracts/pure behavior), src/server (server-only auth/data boundaries), supabase/migrations (new SQL), worker (Node process), tests (unit/integration), docs (decision/evidence records).

## Key contracts

Project scopes: complete_brand | naming_only | visual_identity_only. A ContextSnapshot contains description, activity, offering, known audience, selected segments, retained competitors, supplied name, and provenance. Promotion copies known context and source references; never invents approvals, audience, or positioning. Revision numbers invalidate downstream selections without deleting history.

Assets use immutable version IDs, input revision/hash, MIME type, storage path, content hash, generation provenance, likes/saves/usage. Default inclusion is liked OR saved OR used. A new selection records restore history; original versions remain addressable. Vector readiness requires actual path geometry and license provenance, not an SVG extension.

Jobs use operation, owner, project, input revision/hash, idempotency key, queued/running/partial/cancel_requested/cancelled/succeeded/failed/needs_reconciliation states, progress, partial outputs, lease token/expiry, attempt count, maximum attempts, cancellation time, and reserved/actual cost. Mutations require current lease fencing. An immutable ordered step plan is registered before dispatch; SQL prevents incomplete success or changed recovery plans. The fingerprint covers step keys and cost bounds; a future live handler must also define its implementation/version compatibility policy.

Each provider wait has a five-minute default deadline, configurable per step up to one hour. Cancellation permits a five-second default grace (maximum thirty seconds) for cooperative settlement. Ignored cancellation or a deadline quarantines the job with its remaining reservation intact; a lost lease cannot publish late output. Cost overruns retain generated content and actual provider expense separately from the capped customer reservation. Retry ambiguous provider requests only with a reconciliation policy; never assume exactly-once external execution. No provider-specific reconciliation or manual retry endpoint is enabled yet.

## Historical draft persistence increment (superseded by D065)

Browser drafts remain independent local copies. Saving to an account uses the existing project creation API after a verified `/api/session` response; a separate account route edits the stored project. Both routes share the intake editor. Account updates send an expected revision and optional title, which commit atomically with the new immutable context revision. Expansion to a complete brand is a dedicated owner-checked database operation that copies the current saved context and hash into a new revision. Already complete projects are idempotent only at the current expected revision.

The shared context includes intake notes, supplied name, editor position, audience review time and example provenance. Editing visible intake fields preserves downstream strategy and research sources. Optional intake defaults let earlier snapshots be read without rewriting historical rows.

Project mutations share a 32,768-byte UTF-8 JSON request limit in addition to individual field limits. The client checks the complete serialized payload before sending it and retains oversized drafts with a size-specific error; the server independently enforces the streamed byte limit even when Content-Length is false or absent.

Account views are hidden whenever identity is unverified. Requests are aborted and fenced by a session generation; results must match the verified owner before entering client state. Unsaved account edits stay in memory for that owner through a conflict or expired session. Recovery requires an explicit choice to load the latest revision or save a new browser copy, and browser export is available only to the matching verified owner. A changed account cannot see or save the previous account's buffered edits. Email/password sign-in and signup use same-origin server routes, with HTTP-only session cookies and generic authentication errors. Signup stages cookies until its provider result is validated; pending email confirmation is never represented as a verified session. No account linking is enabled. The shared account provider serializes authentication and sign-out, fences private responses immediately, and prevents refresh from exposing an account while authentication is pending. An authentication request retains that guard across internal navigation; a delayed response cannot follow a confirmed logout in the same provider. Failed authentication keeps private views hidden until explicit recovery. Confirmed sign-out clears private buffers only after unsaved-edit confirmation; browser drafts remain independent.

Live integration tests have a separate command, explicit opt-in, and an explicit approved development project allowlist. They accept only a publishable key and temporary access tokens for two prepared test identities. The suite reads real Auth/PostgREST/Storage fixtures but does not provision users, write data or run jobs. Until secure setup is complete, browser API fixtures and PGlite checks are local evidence only.

## Projects collection

The Projects collection (formerly Brands) keeps `/brands` and existing browser/account destinations while adopting the approved unified grid. Its account page hook retains validated cursor merging and bounded, owner/generation-fenced reads. Collection controls stay outside the private listing remount boundary. Account summaries deliberately expose unavailable stage/update metadata rather than inventing details. See [Projects design and behavior](projects-guided-design.md).

## Historical Names browser persistence (superseded by D065)

Standalone Names has a separate versioned browser store. Captured candidates, context and runs are immutable; preferences and current workshop controls remain editable. Stored input is fully validated, including replay of bounded transformation history and cross-record references. Version 1 pins transformation semantics and history explanations: future algorithm or wording changes must retain a compatible reader or explicitly migrate old records rather than invalidate them silently.

The store freezes its snapshot and graph. Internal UI-only updates reuse the unchanged validated graph and validate the new controls and references; untrusted loads and new result graphs still take the full validation path. Every write applies the same byte limit and compares current durable storage to detect competing tab edits. Failed or conflicting writes retain the current tab's branch and expose a downloadable backup and explicit recovery. LocalStorage is not a transactional multi-tab database; the interface does not promise automatic merging.

Promotion copies a name's context and validated provenance into a new browser brand. Account persistence then uses the existing explicit authenticated copy flow. The selected name may later change while its original provenance remains immutable. No availability, trademark, AI or provider result is inferred from a deterministic transformation.

## Security foundation

Authenticated identities come from verified Supabase claims/user validation, never request JSON. Privileged credentials stay server-only. Ownership is checked for projects, cross-row links, jobs, all versions, source promotion, and signed download URLs. Private Storage object paths include owner/project/asset version. Service role bypass is isolated to the worker and requires explicit tenant constraints and lease fencing.

Routes return 401 for missing authentication, 404 for inaccessible resources, 409 for conflicts, 422 for invalid input, and 503 for unconfigured integrations without leaking internals. Mutation origin checks and body limits apply. No production demo auth, local fixture fallback, automatic paid calls, or public upload buckets.

## Verification responsibilities

Frontend and backend ownership remain disjoint; integration covers shared contracts and provider/job invariants. Verification covers unit contracts, two-user database isolation, cancellation/idempotency/partial results/cost guards, types/lint/build, mobile/keyboard and negative flows. Unavailable live checks must be reported honestly. Source verification does not imply service provisioning, provider use or deployment authority.

## Sources checked 2026-10-02

- https://nextjs.org/docs/app/getting-started/installation — current App Router setup; separate lint step.
- https://vercel.com/docs/plans/hobby — plan suitability must be checked before commercial hosting.
- https://render.com/docs/background-workers — dedicated worker process model.

Additional implementation-specific official sources belong in the specialist evidence notes.

## Competitor review increment

The existing shared browser/account intake editor gains a Competitors step between brief review and Audience, matching the source plan’s conceptual order. User-entered rows remain editable; retained competitors are explicit selections. Research is unavailable until its actual sourced provider integration exists. Website fields are never fetched by this increment.

Editable competitor fields and a review binding remain local draft state; the existing context persists canonical competitors, source provenance and review completion through owner-scoped versioned APIs. The binding covers the upstream brief and competitors, so later audience edits do not undo earlier competitor review. Competitor edits invalidate downstream audience completion. Existing version-1 drafts and preserved snapshots remain readable. The implementation and verification evidence are recorded in competitor-review.md.

## Personality and positioning review increment

Personality and positioning remain structured context, with explicit review tracked separately from presence of values. The shared editor exposes independent Aaker-dimension emphasis controls only after the user explicitly initializes a manual profile, or when a stored profile already exists. Positioning is editable prose, never a fabricated proposal.

Local review bindings cover the brief, retained competitors, selected audience segments and relevant strategy values. Unselected alternatives do not invalidate downstream reviews. Personality changes require positioning review again; upstream changes retain both outputs while clearing their current approval. Current review timestamps persist in intake metadata; exact local bindings are excluded from account API bodies. Older contexts receive null review markers, keeping their content without inventing approval. Prior immutable revisions retain historical selections.

## Conversation correction

D026 supersedes the earlier brief-form and step-navigation presentation above. Sending a nonempty prompt records the actual user message and opens Competitors in a conversation. Competitors, Audience, Personality and Positioning are interactive widgets in that history. Follow-up messages preserve existing strategy content while invalidating its review bindings. Existing briefs appear as saved context, without fabricated assistant messages or historical timestamps. Names promotion carries the existing conversation and its event IDs into the new brand.

The shared transcript allows only user messages, saved context and ordered unique widget references. It is bounded by event count, text length and UTF-8 bytes; the account request limit remains independently enforced. Provider results are separate owner-checked immutable job outputs, never trusted from client-supplied transcript events. A browser draft explicitly reports that AI replies are unavailable.

The local strategy API prepares durable enqueue, polling, cancellation and explicit proposal acceptance. Admission derives ownership from authentication and requires a saved project revision, an enabled policy, fresh worker readiness and an approved budget. Applying a result checks its input revision against the current project; stale output cannot overwrite intervening edits. At the initial integration checkpoint, strategy and subscription migrations had been applied to the development database, while runtime policies, worker identity and provider credentials were still unconfigured. The D029 assessment did not itself enable subscription inference.

The 2026-10-13 readiness record supersedes the historical runtime-status statements above: [brand creation readiness](brand-creation-readiness.md). Production API publication now has the same validated transport configuration boundary as preview, while execution still requires the existing owner policy, budget and qualified worker deployment. Account/project HTTP waits are bounded independently of durable job lifetimes. Manual project copies and Home share owner-scoped recovery receipts to prevent blind duplicate creation after a lost acknowledgement.

## Local subscription runtime

The local subscription implementation uses a Mac execution option. Supabase Auth, owned projects, immutable revisions and durable Postgres jobs remain authoritative. Subscription access does not require a different data store, so no embedded database, data migration or new hosted service is introduced. The protected Vercel preview remains available for interface review and cannot expose the local connection endpoints.

The local web process binds to `127.0.0.1:3106`; the dedicated Node worker and OAuth callback bind to `127.0.0.1:3107`. A fresh in-memory capability connects these two processes. Browser requests go through a same-origin, host-checked Next.js route that verifies the Supabase user before forwarding a server-derived owner ID. Tokens and worker database access never enter browser bundles. Each ChatGPT registration is bound to its verified Supabase owner; signing into ChatGPT does not silently create or replace an Embel account.

The local worker alone owns protected OAuth records, refresh rotation, account-specific model discovery and streaming Responses calls. Subscription jobs have quota/deadline/size admission limits and explicit subscription billing metadata, without invented API dollar estimates. The local subscription mode and image/API execution have separate configuration and admission boundaries.

Preparing code does not authorize grants or token persistence. First-time connection still requires the specific consent flow and a protected credential destination. Runtime activation additionally needs an existing verified Supabase user and the dedicated worker database connection. All independent fixture checks precede those steps; real prompt-to-chat verification remains unrun until they are complete.

## Local worker login boundary correction

The local subscription worker uses a dedicated direct database login administratively bound to exactly one Embel owner. The binding uses both role name and OID and validates the actual `session_user`, with no privileged flags or role memberships. A request parameter, JWT claim or custom session setting cannot choose the owner. Subscription functions, bindings reads and shared lease operations enforce that mapping; subscription workers cannot operate API-mode jobs, and API workers cannot operate subscription jobs. The only direct table read is seven job-step recovery metadata columns, filtered to owned subscription jobs by RLS. The migration creates no login, password or owner mapping.

The launcher reads a protected `.local-fluid/worker.env` (0600, under a 0700 directory), rejects worker credentials in Next.js environment files, and passes the connection only to the Node worker. Connections use the configured development endpoint with certificate-verified TLS. OAuth records remain separately protected under `.local-fluid/credentials`. These boundaries are checked before any live credential setup.

## Incomplete subscription model catalogs

Live evidence under D034 shows that the account-specific model list can omit models that successfully complete Responses requests with the same OAuth session. A protected, read-only `.local-fluid/verified-models.json` supplements discovery with exact owner/registration/model records and matching `response.completed` evidence. Records are historical proof, not permanent access guarantees; active session validation and provider authorization still apply on every inference. A successful current provider catalog remains required, and every explicit provider entry—including hidden models—takes precedence. The same merged model list governs the picker, explicit selection, readiness and dispatch. The supplement neither chooses a model for the user nor performs automatic model probes, and is never accepted from browser request bodies.

## Explicit strategy application receipts

Applying a completed strategy proposal appends a project revision and an immutable owner-scoped application receipt in one transaction under the project row lock. The receipt binds the exact job, step, input revision and applied revision. A repeated request returns that same revision only while it remains current; later edits still conflict. The application never infers historical acceptance from matching revision contents.

The new `apply_strategy_job_result_v2` RPC returns both project and receipt. The original RPC keeps its existing response for the protected preview. New clients display applied proposals across reload and continue competitor research only from the exact reformulation receipt, with the originally accepted policy and strict revision checks.

## Frozen assistant history for follow-ups

Subscription input version 2 carries up to five validated completed proposals from the same owner and project. Admission reads these sources in the database and freezes their job/step/revision provenance and complete typed output into the immutable job input; clients cannot supply assistant messages. The byte bound accounts for JSON escaping in the provider request and omits whole entries with an explicit truncation marker. Partial text and reasoning are excluded. Saved selections remain authoritative, and omitted context calls for clarification rather than guessing.

The worker accepts both legacy v1 inputs and v2, revalidates history ownership/provenance before dispatch, and includes normalized v2 input in its step fingerprint. Old v1 plans remain compatible. Rollout must replace every old local worker before applying the v2 enqueue migration; no worker table-read grant is expanded.

## Naming brain V2 (locally verified, 2026-10-17)

Naming V2 uses saved preferences, immutable run snapshots and a continuous owned
feed, separate from the historical 250-name subscription path below. Measured code
is `d654d62fcbaaddad0002eff088bbf0983d97d6c9`, tree `483278cbdc0ce6f6d9100b53cdf122a5dc075b59`;
all 1,907 source hashes match manifest
`ba317ea3b0a61046da8564b14ee740f4bf1a072f0a7e58f48d7b69af301c800a`. The final eight-command matrix
passed: 8,636 tests, 23 intentional native-PostgreSQL gates, 0 failures; 172 browser
checks (86+86, zero skips/retries); types, full lint, web/both worker builds and diff.
Independent scoped repair review closed 7 addressed / 0 open / 0 new findings. See the
[verification record](naming-brain-verification-20261016.md) for preserved red
history and evidence. This later four-file update is documentation-only; the tested
code identity remains d654d62. Local checks do not establish native PostgreSQL
qualification, live installation, model access, funding or paid activation.

D071 requires Naming decisions as widgets in the same chat used to answer them.
After those decisions, the chat occupies a smaller left panel and generated names
occupy a larger right-hand grid. The reviewed correction retains unfinished
questions through interruption and excludes action-key activation from exploration
demand. The [verified local sample preview](http://127.0.0.1:3137/__preview) uses
d654d62 / build `EjbFioaYQxauMXsNryONs`; both full wrapper smoke flows pass, including
interrupted questions, 100→200 names, feedback, selection and reset. Its names and
saves are simulated; no live generation. The earlier 3135/a13e94c preview remains
historical evidence.
Account saves/recovery, historical batches and Workshop remain part of
the account workspace; opening or navigating to Naming does not upgrade saved
choices or admit paid work. Approaches and directness require explicit answers.

The database freezes the owned project/Strategy basis, exact saved preference
version/hash, steering/demand sequence and accepted policy in each run. A restricted
Node worker validates preferences with the shared JavaScript normalizer and
attests that exact version/hash and its Node/ICU/Unicode implementation fingerprint.
Browser flags and SQL case conversion cannot stand in for this readiness evidence.
Account verification/generation fences and stable request identities preserve
unsaved edits and uncertain acknowledgements without silently attaching them to a
different account or creating another paid request.

The Naming adapter implements the managed Agents protocol with an explicit
operation policy; it does not implement a Responses or alternate-model fallback. The seven durable stages are research,
direction, creation, curation, verification, gap and prepare. Independent Creator
sessions run at most three concurrently; the initial target is 150 raw candidates
and 100 published names. Research and Verification have their own bounded search
and reference-reader capabilities; other roles cannot inherit those tools. One
optional ordered gap has fixed 10/40/5/20-cent phase envelopes and 0/0/0/8 searches.
Complete Creator provenance, retained source text/hashes and quote bindings must
survive review before publication. A known failed/invalid gap may preserve the
earlier reviewed pool as truthful partial fulfillment; unknown execution does not
produce invented names or a replacement call.

Scrolling may consume saved prepared output and request bounded continuation only
with qualifying recent interaction; 60 seconds without interaction pauses demand.
Stop advances a persisted sequence and fences late ensure requests. An explicit
terminal Resume may consume eligible saved output for free or create a linked run
with its own allowance; ordinary scrolling does not perform terminal paid Resume.
Known-session recovery retains the original identity and full allowance, with
observation bounded to 12 claims / one hour and persisted backoff. Disabling paid
readiness prevents new dispatch while retaining scoped observation.

The initial pilot accounting design used US$5 per-run holds and a US$25
commitment ceiling. Those figures describe the original pilot; applicable
execution policy is determined by runtime configuration. Completion, session
caps, provisional counters and estimates do not establish final charges or
release unsettled historical reservations. Unknown execution remains distinct
from successful settlement.
The dedicated graph is `worker/index.ts` (`npm run worker`), with its own Naming
connection/deployment, both paid environment gates, private pilot policy and nine
scoped RPC capabilities. The hosted `build:api-text-worker` graph and the existing
`npm run local` subscription launcher do not activate it. See the exact source
hashes, environment names, grant signatures and separate authorization requirements
in the [activation packet](naming-brain-activation-20261016.md) and the
[source-specific verification record](naming-brain-verification-20261016.md).

The 2026-10-17 connector-only metadata snapshot identifies the configured target as
`fluid-platform-dev`, ref `fricsfwqibyhemknqgyf`, `us-east-1`. Migration
`20261016180000` and all nine Naming RPCs are absent there. Catalog role
`fluid_api_text_worker` exists at OID `21484`; its actual owner binding, direct/pooler
authentication, new Naming grants and deployment/policy remain unverified. No live
Naming installation, credentials, funding or inference was performed.

## Historical project Naming subscription path (V1)

Naming has its own session, preference versions, batches, candidates, retention flags and immutable selections. It reads the saved project context without changing the Strategy conversation. Complete-brand generation requires reviewed Strategy; naming-only can start from a saved description while showing missing strategy. Unsaved or conflicted account edits block context-dependent Naming actions.

In this earlier subscription path, each explicit batch freezes the project revision, relevant strategy content, preferences, favorite values, existing-name identities and accepted operation policy. First batches admitted under the 2026-10-05 correction target 250 unique names with visible explanations; earlier immutable first batches retain their 100-name target. Subsequent 50-name batches require an explicit action. These historical targets do not define V2 managed runs. Batch reads use stable 100-row pages, with exact published membership verified across all pages. A completed provider response and fulfillment are separate: rejected or missing names produce partial/none fulfillment with actual counts, never invented replacements or an automatic second request. Browser closure does not own the durable job. Raw streamed JSON is retained for recovery and never becomes selectable candidates.

Generated candidates acquire provider provenance only through atomic leased worker completion. Deterministic transformations use the existing pinned V1 algorithms. Their text is classified as user-supplied; generated ancestry does not turn a derivative into provider-authored output. SQL derives owned parent/root links and stores unverified transformation claims. Before returning, selecting, transforming or promoting candidates, the server must resolve those immutable owned references and replay the exact bounded history. SQL does not approximate JavaScript Unicode/grapheme behavior.

Selecting a candidate appends a project revision and selection record, mirrors the name into both saved name fields, and preserves previous results. An earlier strategy basis requires explicit acknowledgement. Likes and saves remain independent from selection. Account Names stays separate from the existing browser library; importing is an explicit copy and never writes private account data into browser storage. Domains, Handles and Trademarks remain visibly unchecked until real providers exist.

The historical subscription runtime preserves the selected model and registration across operation-specific policies and uses zero web tools for V1 Naming. Reading configuration or restarting that worker never silently enables Naming. The original Naming migration and two existing-worker EXECUTE grants were applied in October 2026. The later 250-name correction was a target-only forward migration, with no new grants; its historical acceptance design used one first batch and one append. Its source-specific verification and rollout evidence are recorded in naming-250-rollout.md. Historical migration and acceptance records do not activate the V2 managed graph.

### Global generation activity (local integration)

The authenticated header opens a read-only Activity dialog on demand. `GET /api/jobs` reads only existing owner-filtered job metadata and owned project titles under RLS; it never returns prompts, result payloads, provider identifiers, lease details or signed URLs. Active requests include unresolved outcomes; terminal partial results remain recent. A bounded union uses the later read when a request finishes between observations. Polling runs only while the dialog is open, with account-generation fencing and cancellation of the read on close. Opening or closing Activity neither admits nor retries nor cancels a durable job. This increment adds no database privilege or provider call.

## Owned Assets and reference-first Identity foundations

The locally verified Assets library reads across owned projects with explicit selected/all-generation views. Retention changes and global version restoration use independent revision checks through narrow authenticated RPCs; direct browser writes to used flags or selection history are revoked. Restoration appends an immutable receipt and advances a head without changing an Identity system's fixed file references. Historical used flags remain separately labeled legacy use. Purpose is assigned once, so reference media cannot be silently reclassified into brand files.

Raster previews and downloads share owner/path/hash/MIME validation. Inline previews allow only PNG, JPEG and WebP with private no-store responses; downloads require actual verified bytes before a short-lived signed URL. Metadata alone establishes neither file availability nor provider authorship, vector validity or font licensing. The browser bounds and cancels private reads, validates returned bytes and releases object URLs on account changes and unmount.

Reference selection is a separate domain: Ensemble and relevant element likes are independent. Immutable reference metadata binds exact owned raster versions and attribution; selected snapshots preserve the complete owned set. Project-level aggregate revisions and per-reference reaction revisions prevent silent concurrent overwrites. Source discovery remains unavailable, and persisted selections do not depend on discovery availability. The reference grid precedes generation readiness; unsaved account edits must be resolved before navigating into saved-context Identity work.

Reference attribution text is trimmed consistently before immutable insertion. The initial database/application URL validator deliberately supports a shared conservative subset: HTTP(S), ASCII DNS names or canonical dotted IPv4, valid optional ports and ASCII/percent-encoded path/query/fragment. IPv6, raw international hostnames and ACE/punycode host labels are currently rejected; international path text can be percent-encoded. Source URLs may be null, and invalid attribution is rejected rather than silently removed. This is an implementation restriction while ingestion is absent, not verification of source rights or a URL-fetching feature.

Identity's pure contracts bind six component specifications, a coordinated board and separately declared production files to immutable saved inputs. Current material freshness excludes incidental revision/view metadata but compares saved strategy, resolved name, selected reference material and preferences. Selection/refinement checks all four observed heads: project, references, preferences and Identity selection. Manual colors/typography edits preserve original generation inputs, create a new version and mark inherited board components stale; they never invent replacement file bytes. The saved-system editor, guarded persistence foundation and injected transaction service are now locally integrated and verified; the historical Identity checkpoint record (`identity-systems-integration.md`) is absent from this source snapshot. The image admission boundary stays unavailable and creates no job until a real producer, access and spending policy are separately implemented and authorized.

The trusted save service accepts only fixed select/refine operations on an injected owner-bound connection. One checked-out connection owns BEGIN, locked preparation, shared context/WHATWG/Naming replay, source graph validation, four-head checks, immutable writes and COMMIT. Every error or precommit cancellation rolls back; uncertain commit/release delivery preserves the original canonical request without automatic retries. Exact refinement replay binds the complete original system/change/selection and original revision fences, without comparing to or restoring a later head. Private SQL helpers remain an unimplemented proposal; actual local tests use an explicitly synthetic PGlite adapter, not deployed permissions. Production has no connection factory and reports saveAvailability unavailable. Public select/refine RPCs remain unconditional guards after owner/project lookup. Separate narrow preference CAS and read-only history are independent.

The proposed personal login, nonlogin helper owner, two fixed helper signatures, owner-bound FORCE-RLS policies and secure user-completed credential route are recorded separately in [the unexecuted provisioning proposal](proposals/identity-trusted-provisioning-request.md). Real helper code, internal function/trigger dependencies, exact role privileges, source-writer locks and live pooler/session_user behavior require further review before that proposal can become execution-ready. Existing Naming permissions are separate; no worker/admin/service-role connection is reused.


## Manual account Ideas — 2026-10-05

Manual Ideas uses its own owner-scoped head, immutable revision and immutable brand-link tables with bounded authenticated RPCs. Web requests perform bounded manual persistence; no generation job is introduced. Shared contracts are src/domain/ideas.ts, server access is src/server/data/ideas.ts, and private API routes are /api/ideas and /api/projects/[projectId]/idea-source. Client edits remain in owner-bound provider memory, fenced by verified account generation, cleared on verified owner change/confirmed logout and included in unsaved-exit confirmation. Explicit conversion derives normalized complete-brand context/hash server-side and retains a frozen source outside Strategy; review flags remain unset. Live SQL role-probe and local fixture evidence differ from the outstanding signed-in browser acceptance. The historical `manual-ideas-rollout.md` evidence record is absent from this source snapshot; its hosted acceptance must be re-established separately.


## Names Assistant route bridge — 2026-10-05

Standalone Names Assistant consumes the existing verified account session, reads strict /api/projects/page summaries, and links explicitly to saved-project Naming. It introduces no generation, server API, schema or persistence operation. Browser and account Name state remain separate; the active runtime includes prior Brands controls and manual Ideas. New independent Domains/Handles/Trademarks modules remain staged until their review corrections and shared route checks complete. The historical `names-assistant-rollout.md` evidence record is absent from this source snapshot; this paragraph describes the earlier route-bridge milestone.

## Assets approved library presentation

The Assets collection uses the shared concept shell and compact Figma library layout. UI search is scoped to loaded owner-verified rows, with explicit pagination limits. Account generation remounts the entire library and its search/menu/detail state; private previews retain cancellation and URL revocation. Server filtering, revision-checked retention/restoration and file evidence contracts are unchanged. See assets-guided-design.md.

## Trademarks approved Search and Fill presentation

The Trademarks route shares the concept shell and original static Figma artwork. Search and Fill edit the same controlled draft; registry research remains explicitly unavailable. Library exposes the current working draft and History the latest verified save receipt only. Existing review/export/source-promotion and account owner/generation fences are retained. Recovery controls stay usable outside disabled edit fields. See trademarks-guided-design.md.

## Curated Inspiration (2026-10-13)

The current Figma Inspiration gallery uses immutable public reference artwork with separate project-owned catalog preferences, rather than inventing private asset versions for global images. Authenticated narrow RPCs enforce project ownership, scope and revision fences; the client verifies receipts and retains uncertain intent in owner-fenced tab memory. Original uploaded-reference snapshots remain separate. Users can now review catalog attribution and character/color/type/graphics guidance into an immutable visual-direction record. Post-logo Identity direction inputs bind that exact review; changed likes or guidance invalidate new quotes and retain late results as history instead of replacing current selections. Initial logo concepts still use their existing saved brief and owned reference images. See [Inspiration workspace](inspiration-workspace.md) and [reviewed visual direction](visual-direction-review.md) for the precise supported behavior and activation boundaries.

## Integrated creation workflow (2026-10-13 source checkpoint)

The continuation resolver derives navigation from saved Strategy reviews, project scope and the selected name. It does not approve work by navigating. Naming now leads to Inspiration; logo and Identity status is published only from an owned, revision-matched workspace observation. A bounded project-shell reload preserves dirty edits and exposes newer saved revisions as conflicts.

Project Naming mounts [screening research](project-screening.md) for the exact saved name selection and project context. Explicitly recorded observations are immutable owner-authored notes with unverified provenance. Authenticated live lookups are bounded, cancellable and recheck the saved basis after completion; they do not become trusted database receipts supplied by a browser.

Strategy availability reads the caller's SQL authorization first and intersects eligible API operations with a protected worker readiness response. It never adds operations or credits. Subscription readiness and reading, replaying, cancelling or applying an existing request remain independent of a new availability probe. The [multi-account API candidate](production-ai-dispatch.md) and standalone Names candidate require their separately configured runtime and allowance policies; local implementation does not imply live activation.

Visual-direction and screening drafts join the existing account-scoped in-memory lifecycle: verification hides private data, same-account recovery retains edits, confirmed logout or a different owner clears them, and old-generation callbacks cannot publish into the next session. Signup and Settings implementation, manual standalone tools and logo comparison/refinement are included in the same integration checkpoint. Hosted database state, email delivery and protected worker trust must be reported separately from source verification.

## Domains live prices and saved shortlist (2026-10-15 candidate)

The authenticated standalone lookup route adds credential-free Vercel exact-domain checks with term-aware registration/renewal prices, preserving configured Cloudflare and RDAP boundaries. Ambiguous provider negatives stay Unknown. Transient prices remain owner/generation-fenced and cannot be written into account drafts. A bounded optional `shortlistedDomains` field preserves legacy version-1 payloads and the existing CAS/idempotency workflow; the guarded validator migration changes no grants or ownership rules. See [implementation, rollout requirements and verification boundaries](domains-live-shortlists.md). Source implementation is separate from hosted activation.

## Optional Name.com CORE lookup (2026-10-15 candidate)

Name.com adds an explicitly enabled, server-credential-gated alternative to the existing registrar reads. Exact discovery separates new registration from aftermarket/expiring/backorder offers; only matching authoritative registration-term pricing can produce a registration quote. Acquisition offers stay Unknown for new registration and disclose their flat fee separately. The current Vercel/Cloudflare/RDAP path is unchanged while Name.com is disabled, and sandbox configuration cannot establish live evidence. No schema, worker, purchase, credential or deployment change is included. See [Name.com implementation and secure rollout gates](namecom-domain-lookup.md).


## Recoverable project deletion

The project-card confirmation requests cancellation and records a recoverable deletion intent
in one owner-scoped transaction. Acknowledged intent removes the project from the
active collection and fences admissions and stale owner edits. Every acknowledged
deletion immediately shows Deleted, with a secondary Cancellation requested line
only while work is stopping. Internal job and accounting status remains separate
from visible deletion and Restore availability. Already-started provider work may
still finish; existing workers may retain authorized evidence and cost settlement.
Queued cancellation uses proven no-dispatch evidence, existing settlement rules,
and nonblocking lock acquisition so contention retries the request without
changing worker lock behavior. Derived completion needs no finalizer or cron.
Restore withdraws pending deletion without restarting canceled work. Revision and
lifecycle CAS retain history and reject stale delete-after-restore requests. See
[the exact contract and qualification](project-deletion.md).
## Local progressive Naming continuation — D079, acceptance pending

The current performance implementation is under verification; the earlier
functional checkpoint remains the last accepted runtime. Future trusted local
jobs use immutable `localPipelineVersion: 2` alongside the existing timing
witness. Historical and hosted jobs keep their original seven-step pipeline.

The new orchestration uses two durable steps, Creation and Prepare. Within
Creation, small independent Creator → Curator chains publish committed groups
while genuine Research and Director guidance run alongside them. Required
factual claims and routes also require Verifier evidence with retained quotes.
Brief-seeded assignments identify their application origin honestly. Guidance
can shape only unissued assignments; acknowledged requests remain exact restart
authority. Route allocation stays flexible, reserves five genuine credits for
each selected approach, and retains unusual but valid names.

Each immutable microbatch binds real source/review artifacts and feed positions.
Final membership references those publications through an explicit progressive
completion record, with no invented global Curator, Verifier or prepared set.
Visible saved names and execution closure are separate facts: unknown issued
work remains quarantined even when 100 names are already readable. Stop and
direction changes fence future dispatch/publication while preserving history.

The existing grid observes actually visible saved cards after deliberate native
scroll input, prefetches at a bounded low-water mark, and polls committed deltas.
Saved pages take priority over a new run. Mounting, restored scroll, observers,
idle/hidden views and unknown outcomes cannot admit another exploration. The
approved widgets, chat/grid layout, account persistence and recovery buffers
remain unchanged. See [the measured acceptance record](local-prototype.md).

The local worker uses two Naming database connections and one Strategy
connection, leaving one slot under the existing restricted login's four-slot
limit. Three Creator chains can still await the provider concurrently. Only
acknowledged server capacity/cancellation errors or proven pre-query connection
failures in maintenance retry with abortable capped backoff. A raw client query
read timeout does not prove cancellation and is not replayed. Local expiry uses
one checked-out transaction with server statement/lock bounds, shared process
serialization and cooldown, nonblocking owner locks and ordered eligibility
checks. Leased execution and provider observation retain their existing outcome
rules. Strategy rechecks fresh readiness before every initial or retried claim.
Hosted pools and database grants are unchanged.

An acknowledged generation request remains available in memory for polling but
does not create a browser draft-recovery prompt: the account feed already owns
that durable run. Owner-verified legacy recovery entries discard only those
acknowledged intents. Unsaved preferences, uncertain admissions, Stop, steering
and project-creation work retain explicit recovery and their account fences.

Progressive receipt history has its own aggregate observation envelope of 5,000
receipts/64 MiB, matching the progressive provider-record envelope. Historical
jobs keep 500 receipts/8 MiB. Digest replay is acknowledged before capacity;
individual receipt size, provider identities, ownership and terminal-proof gates
are unchanged. The additive follow-up preserves existing calls and publications.
Funded acceptance observed first names in 27.587 seconds and retained 94 before
this missed historical count limit surfaced. Database maintenance corrections
are installed and the worker has recovered; actual full-run completion remains
pending. See the current local-prototype record.

Local Strategy and Naming execution are governed by the application's configured
runtime policies. Admission retains the shared enabled-operation switch and
existing owner, role, saved-policy, readiness and lease checks. Local policy
qualification is separate from hosted bindings. Previously admitted requests
retain their original model identifiers, service tiers and request hashes.
