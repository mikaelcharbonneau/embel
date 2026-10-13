# Fluid foundation architecture

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

## Draft persistence increment

Browser drafts remain independent local copies. Saving to an account uses the existing project creation API after a verified `/api/session` response; a separate account route edits the stored project. Both routes share the intake editor. Account updates send an expected revision and optional title, which commit atomically with the new immutable context revision. Expansion to a complete brand is a dedicated owner-checked database operation that copies the current saved context and hash into a new revision. Already complete projects are idempotent only at the current expected revision.

The shared context includes intake notes, supplied name, editor position, audience review time and example provenance. Editing visible intake fields preserves downstream strategy and research sources. Optional intake defaults let earlier snapshots be read without rewriting historical rows.

Project mutations share a 32,768-byte UTF-8 JSON request limit in addition to individual field limits. The client checks the complete serialized payload before sending it and retains oversized drafts with a size-specific error; the server independently enforces the streamed byte limit even when Content-Length is false or absent.

Account views are hidden whenever identity is unverified. Requests are aborted and fenced by a session generation; results must match the verified owner before entering client state. Unsaved account edits stay in memory for that owner through a conflict or expired session. Recovery requires an explicit choice to load the latest revision or save a new browser copy, and browser export is available only to the matching verified owner. A changed account cannot see or save the previous account's buffered edits. Email/password sign-in and signup use same-origin server routes, with HTTP-only session cookies and generic authentication errors. Signup stages cookies until its provider result is validated; pending email confirmation is never represented as a verified session. No account linking is enabled. The shared account provider serializes authentication and sign-out, fences private responses immediately, and prevents refresh from exposing an account while authentication is pending. An authentication request retains that guard across internal navigation; a delayed response cannot follow a confirmed logout in the same provider. Failed authentication keeps private views hidden until explicit recovery. Confirmed sign-out clears private buffers only after unsaved-edit confirmation; browser drafts remain independent.

Live integration tests have a separate command, explicit opt-in, and an explicit approved development project allowlist. They accept only a publishable key and temporary access tokens for two prepared test identities. The suite reads real Auth/PostgREST/Storage fixtures but does not provision users, write data or run jobs. Until secure setup is complete, browser API fixtures and PGlite checks are local evidence only.

## Projects collection

The Projects collection (formerly Brands) keeps `/brands` and existing browser/account destinations while adopting the approved unified grid. Its account page hook retains validated cursor merging and bounded, owner/generation-fenced reads. Collection controls stay outside the private listing remount boundary. Account summaries deliberately expose unavailable stage/update metadata rather than inventing details. See [Projects design and behavior](projects-guided-design.md).

## Names provenance and browser persistence

Standalone Names has a separate versioned browser store. Captured candidates, context and runs are immutable; preferences and current workshop controls remain editable. Stored input is fully validated, including replay of bounded transformation history and cross-record references. Version 1 pins transformation semantics and history explanations: future algorithm or wording changes must retain a compatible reader or explicitly migrate old records rather than invalidate them silently.

The store freezes its snapshot and graph. Internal UI-only updates reuse the unchanged validated graph and validate the new controls and references; untrusted loads and new result graphs still take the full validation path. Every write applies the same byte limit and compares current durable storage to detect competing tab edits. Failed or conflicting writes retain the current tab's branch and expose a downloadable backup and explicit recovery. LocalStorage is not a transactional multi-tab database; the interface does not promise automatic merging.

Promotion copies a name's context and validated provenance into a new browser brand. Account persistence then uses the existing explicit authenticated copy flow. The selected name may later change while its original provenance remains immutable. No availability, trademark, AI or provider result is inferred from a deterministic transformation.

## Security foundation

Authenticated identities come from verified Supabase claims/user validation, never request JSON. Privileged credentials stay server-only. Ownership is checked for projects, cross-row links, jobs, all versions, source promotion, and signed download URLs. Private Storage object paths include owner/project/asset version. Service role bypass is isolated to the worker and requires explicit tenant constraints and lease fencing.

Routes return 401 for missing authentication, 404 for inaccessible resources, 409 for conflicts, 422 for invalid input, and 503 for unconfigured integrations without leaking internals. Mutation origin checks and body limits apply. No production demo auth, local fixture fallback, automatic paid calls, or public upload buckets.

## Execution plan

1. Create private repository, record decisions and scaffolding; pin current supported dependencies.
2. In parallel: frontend shell/intake (max) and backend auth/RLS/data scaffolding (xhigh). Lead owns contracts, provider/job invariants, integration, and verification.
3. Incorporate original tokens after inspecting supplied Pen. Reconcile later decisions as additive revisions.
4. Verify unit contracts, two-user database isolation, cancellation/idempotency/partial results/cost guard, types/lint/build, mobile/keyboard and negative flows. Record unavailable live checks honestly.
5. Push verified milestones. Present concrete service provisioning choices and costs only after capability checks; parent owns user delivery and approval conversation.

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

The local strategy API prepares durable enqueue, polling, cancellation and explicit proposal acceptance. Admission derives ownership from authentication and requires a saved project revision, an enabled policy, fresh worker readiness and an approved budget. Applying a result checks its input revision against the current project; stale output cannot overwrite intervening edits. The strategy and subscription migrations are now applied to the approved development database; runtime policies, worker identity and provider credentials remain unconfigured. Standard API configuration and paid calls are paused under D029; the ChatGPT plan assessment does not itself enable subscription inference.

The 2026-10-13 readiness record supersedes the historical runtime-status statements above: [brand creation readiness](brand-creation-readiness.md). Production API publication now has the same validated transport configuration boundary as preview, while execution still requires the existing owner policy, budget and qualified worker deployment. Account/project HTTP waits are bounded independently of durable job lifetimes. Manual project copies and Home share owner-scoped recovery receipts to prevent blind duplicate creation after a lost acknowledgement.

## Approved local subscription runtime

D030 approves a local Mac execution option. Supabase Auth, owned projects, immutable revisions and durable Postgres jobs remain authoritative. Subscription access does not require a different data store, so no embedded database, data migration or new hosted service is introduced. The protected Vercel preview remains available for interface review and cannot expose the local connection endpoints.

The local web process binds to `127.0.0.1:3106`; the dedicated Node worker and OAuth callback bind to `127.0.0.1:3107`. A fresh in-memory capability connects these two processes. Browser requests go through a same-origin, host-checked Next.js route that verifies the Supabase user before forwarding a server-derived owner ID. Tokens and worker database access never enter browser bundles. Each ChatGPT registration is bound to its verified Supabase owner; signing into ChatGPT does not silently create or replace a Fluid account.

The local worker alone owns protected OAuth records, refresh rotation, account-specific model discovery and streaming Responses calls. Subscription jobs have quota/deadline/size admission limits and explicit subscription billing metadata, without invented API dollar estimates. The standard API text path remains disabled for this local mode; image execution remains unavailable until a separate API connection and spending limit are approved.

Preparing code does not authorize grants or token persistence. First-time connection still requires the specific consent flow and a protected credential destination. Runtime activation additionally needs an existing verified Supabase user and the dedicated worker database connection. All independent fixture checks precede those steps; real prompt-to-chat verification remains unrun until they are complete.

## Local worker login boundary correction

The local subscription worker uses a dedicated direct database login administratively bound to exactly one Fluid owner. The binding uses both role name and OID and validates the actual `session_user`, with no privileged flags or role memberships. A request parameter, JWT claim or custom session setting cannot choose the owner. Subscription functions, bindings reads and shared lease operations enforce that mapping; subscription workers cannot operate API-mode jobs, and API workers cannot operate subscription jobs. The only direct table read is seven job-step recovery metadata columns, filtered to owned subscription jobs by RLS. The migration creates no login, password or owner mapping.

The launcher reads a separately approved `.local-fluid/worker.env` (0600, under a 0700 directory), rejects worker credentials in Next.js environment files, and passes the connection only to the Node worker. Connections use the approved development endpoint with certificate-verified TLS. OAuth records remain separately protected under `.local-fluid/credentials`. These boundaries are checked before any live credential setup.

## Incomplete subscription model catalogs

Live evidence under D034 shows that the account-specific model list can omit models that successfully complete Responses requests with the same OAuth session. A protected, read-only `.local-fluid/verified-models.json` supplements discovery with exact owner/registration/model records and matching `response.completed` evidence. Records are historical proof, not permanent access guarantees; active session validation and provider authorization still apply on every inference. A successful current provider catalog remains required, and every explicit provider entry—including hidden models—takes precedence. The same merged model list governs the picker, explicit selection, readiness and dispatch. The supplement neither chooses a model for the user nor performs automatic model probes, and is never accepted from browser request bodies.

## Explicit strategy application receipts

Applying a completed strategy proposal appends a project revision and an immutable owner-scoped application receipt in one transaction under the project row lock. The receipt binds the exact job, step, input revision and applied revision. A repeated request returns that same revision only while it remains current; later edits still conflict. The application never infers historical acceptance from matching revision contents.

The new `apply_strategy_job_result_v2` RPC returns both project and receipt. The original RPC keeps its existing response for the protected preview. New clients display applied proposals across reload and continue competitor research only from the exact reformulation receipt, with the originally accepted policy and strict revision checks.

## Frozen assistant history for follow-ups

Subscription input version 2 carries up to five validated completed proposals from the same owner and project. Admission reads these sources in the database and freezes their job/step/revision provenance and complete typed output into the immutable job input; clients cannot supply assistant messages. The byte bound accounts for JSON escaping in the provider request and omits whole entries with an explicit truncation marker. Partial text and reasoning are excluded. Saved selections remain authoritative, and omitted context calls for clarification rather than guessing.

The worker accepts both legacy v1 inputs and v2, revalidates history ownership/provenance before dispatch, and includes normalized v2 input in its step fingerprint. Old v1 plans remain compatible. Rollout must replace every old local worker before applying the v2 enqueue migration; no worker table-read grant is expanded.

## Project Naming increment under local integration

Naming has its own session, preference versions, batches, candidates, retention flags and immutable selections. It reads the saved project context without changing the Strategy conversation. Complete-brand generation requires reviewed Strategy; naming-only can start from a saved description while showing missing strategy. Unsaved or conflicted account edits block context-dependent Naming actions.

Each explicit batch freezes the project revision, relevant strategy content, preferences, favorite values, existing-name identities and accepted operation policy. New first batches target 250 unique names with visible explanations under the 2026-10-05 approval; immutable historical first batches retain their 100-name target. Subsequent 50-name batches require an explicit action. Batch reads use stable 100-row pages, with exact published membership verified across all pages. A completed provider response and fulfillment are separate: rejected or missing names produce partial/none fulfillment with actual counts, never invented replacements or an automatic second request. Browser closure does not own the durable job. Raw streamed JSON is retained for recovery and never becomes selectable candidates.

Generated candidates acquire provider provenance only through atomic leased worker completion. Deterministic transformations use the existing pinned V1 algorithms. Their text is classified as user-supplied; generated ancestry does not turn a derivative into provider-authored output. SQL derives owned parent/root links and stores unverified transformation claims. Before returning, selecting, transforming or promoting candidates, the server must resolve those immutable owned references and replay the exact bounded history. SQL does not approximate JavaScript Unicode/grapheme behavior.

Selecting a candidate appends a project revision and selection record, mirrors the name into both saved name fields, and preserves previous results. An earlier strategy basis requires explicit acknowledgement. Likes and saves remain independent from selection. Account Names stays separate from the existing browser library; importing is an explicit copy and never writes private account data into browser storage. Domains, Handles and Trademarks remain visibly unchecked until real providers exist.

The shared local runtime preserves the selected model and registration across operation-specific policies. Naming uses zero web tools. Reading configuration or restarting the worker never silently enables Naming. The original Naming migration and its two exact existing-worker EXECUTE grants were applied under the 2026-10-04 approval. The bounded 250-name correction has separate approval for a target-only forward migration and one first-batch/one-append acceptance run, without new grants. Its verification and rollout evidence are recorded in naming-250-rollout.md.

### Global generation activity (local integration)

The authenticated header opens a read-only Activity dialog on demand. `GET /api/jobs` reads only existing owner-filtered job metadata and owned project titles under RLS; it never returns prompts, result payloads, provider identifiers, lease details or signed URLs. Active requests include unresolved outcomes; terminal partial results remain recent. A bounded union uses the later read when a request finishes between observations. Polling runs only while the dialog is open, with account-generation fencing and cancellation of the read on close. Opening or closing Activity neither admits nor retries nor cancels a durable job. This increment adds no database privilege or provider call.

## Owned Assets and reference-first Identity foundations

The locally verified Assets library reads across owned projects with explicit selected/all-generation views. Retention changes and global version restoration use independent revision checks through narrow authenticated RPCs; direct browser writes to used flags or selection history are revoked. Restoration appends an immutable receipt and advances a head without changing an Identity system's fixed file references. Historical used flags remain separately labeled legacy use. Purpose is assigned once, so reference media cannot be silently reclassified into brand files.

Raster previews and downloads share owner/path/hash/MIME validation. Inline previews allow only PNG, JPEG and WebP with private no-store responses; downloads require actual verified bytes before a short-lived signed URL. Metadata alone establishes neither file availability nor provider authorship, vector validity or font licensing. The browser bounds and cancels private reads, validates returned bytes and releases object URLs on account changes and unmount.

Reference selection is a separate domain: Ensemble and relevant element likes are independent. Immutable reference metadata binds exact owned raster versions and attribution; selected snapshots preserve the complete owned set. Project-level aggregate revisions and per-reference reaction revisions prevent silent concurrent overwrites. Source discovery remains unavailable, and persisted selections do not depend on discovery availability. The reference grid precedes generation readiness; unsaved account edits must be resolved before navigating into saved-context Identity work.

Reference attribution text is trimmed consistently before immutable insertion. The initial database/application URL validator deliberately supports a shared conservative subset: HTTP(S), ASCII DNS names or canonical dotted IPv4, valid optional ports and ASCII/percent-encoded path/query/fragment. IPv6, raw international hostnames and ACE/punycode host labels are currently rejected; international path text can be percent-encoded. Source URLs may be null, and invalid attribution is rejected rather than silently removed. This is an implementation restriction while ingestion is absent, not verification of source rights or a URL-fetching feature.

Identity's pure contracts bind six component specifications, a coordinated board and separately declared production files to immutable saved inputs. Current material freshness excludes incidental revision/view metadata but compares saved strategy, resolved name, selected reference material and preferences. Selection/refinement checks all four observed heads: project, references, preferences and Identity selection. Manual colors/typography edits preserve original generation inputs, create a new version and mark inherited board components stale; they never invent replacement file bytes. The saved-system editor, guarded persistence foundation and injected transaction service are now locally integrated and verified; see [the Identity checkpoint](identity-systems-integration.md). The image admission boundary stays unavailable and creates no job until a real producer, access and spending policy are separately implemented and authorized.

The trusted save service accepts only fixed select/refine operations on an injected owner-bound connection. One checked-out connection owns BEGIN, locked preparation, shared context/WHATWG/Naming replay, source graph validation, four-head checks, immutable writes and COMMIT. Every error or precommit cancellation rolls back; uncertain commit/release delivery preserves the original canonical request without automatic retries. Exact refinement replay binds the complete original system/change/selection and original revision fences, without comparing to or restoring a later head. Private SQL helpers remain an unimplemented proposal; actual local tests use an explicitly synthetic PGlite adapter, not deployed permissions. Production has no connection factory and reports saveAvailability unavailable. Public select/refine RPCs remain unconditional guards after owner/project lookup. Separate narrow preference CAS and read-only history are independent.

The proposed personal login, nonlogin helper owner, two fixed helper signatures, owner-bound FORCE-RLS policies and secure user-completed credential route are recorded separately in [the unexecuted provisioning proposal](proposals/identity-trusted-provisioning-request.md). Real helper code, internal function/trigger dependencies, exact role privileges, source-writer locks and live pooler/session_user behavior require further review before that proposal can become execution-ready. Existing Naming permissions are separate; no worker/admin/service-role connection is reused.


## Approved manual account Ideas — 2026-10-05

Manual Ideas uses its own owner-scoped head, immutable revision and immutable brand-link tables with bounded authenticated RPCs. Web requests perform bounded manual persistence; no generation job is introduced. Shared contracts are src/domain/ideas.ts, server access is src/server/data/ideas.ts, and private API routes are /api/ideas and /api/projects/[projectId]/idea-source. Client edits remain in owner-bound provider memory, fenced by verified account generation, cleared on verified owner change/confirmed logout and included in unsaved-exit confirmation. Explicit conversion derives normalized complete-brand context/hash server-side and retains a frozen source outside Strategy; review flags remain unset. Live SQL role-probe and local fixture evidence differ from the outstanding signed-in browser acceptance. See [manual-ideas-rollout.md](manual-ideas-rollout.md).


## Names Assistant route bridge — 2026-10-05

Standalone Names Assistant consumes the existing verified account session, reads strict /api/projects/page summaries, and links explicitly to saved-project Naming. It introduces no generation, server API, schema or persistence operation. Browser and account Name state remain separate; the active runtime includes prior Brands controls and manual Ideas. New independent Domains/Handles/Trademarks modules remain staged until their review corrections and shared route checks complete. See [names-assistant-rollout.md](names-assistant-rollout.md).

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
