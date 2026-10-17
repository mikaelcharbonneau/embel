# Embel engineering

The product is **Embel** (formerly Fluid). Use Embel in new user-facing copy and current documentation. Preserve existing storage keys, protocol/schema identifiers, service names and historical design references unless a separate compatibility migration is explicitly scoped. See docs/embel-branding.md.

Build Embel as a conventional account-based AI SaaS. Prefer established framework and provider patterns over custom infrastructure. For signed-in users, the database is authoritative and meaningful edits save automatically. Show Saving, Saved or an actionable save error based on acknowledged persistence. Browser storage is a recovery buffer, never a separate normal workspace or a silent substitute for a failed account save. Preserve legacy local work through explicit owner-confirmed recovery; never attach unattributed local data to an arbitrary signed-in account. Keep technical storage details out of ordinary product flows.

This is a greenfield external application. Never copy, branch from, import, or modify previous Fluid implementations, migrations, fixtures, services, or export pipelines. All work belongs to this isolated checkout and its new private repository.

All development agents must use GPT-6 Astra. Lead, product/frontend, and identity design use max; backend/security, strategy/naming, and independent QA use at least xhigh. Never fall back to another model. The latest user continuation prioritizes quality and substantive progress and withdraws the earlier two-specialist limit; use appropriate parallelism with disjoint ownership. User updates override earlier working-plan wording.

Naming continuation override, approved 2026-10-16: use GPT-6.1 Sol with `max` reasoning for the remaining local Naming development assignments, including integration, QA fixes, full verification and independent review. This supersedes the Astra staffing rule above for that remaining work. Keep disjoint ownership and no silent model fallback. This is a development-agent choice; Embel's application model and provider policy retain their separately configured identities.

Read docs/decisions.md and docs/architecture.md before changes. The approved app design source is Wonder concept 22; see docs/home-concept-22.md before UI changes. Record approved facts separately from proposals. The user already authorized implementing agreed foundations; do not reopen that approval. No public deployment, paid calls, paid provisioning, persistent credentials, or unrelated permissions without explicit authorization.

Use current official docs and relevant local skills. There was no pre-existing .agents/skills checkout at initialization. Keep external design references in ignored .references; copy only original approved design tokens/assets, never old application code. The original Pen source is materialized and hash verified; see docs/references.md.

One TypeScript repository, two process entrypoints: Next.js web in src/app and a dedicated Node worker in worker. Shared contracts in src/domain. Server modules belong to src/server. UI must never import privileged modules. Default to unavailable integrations rather than invented AI, availability, trademark clearance, purchase, or export success. Clearly label local fixtures.

Every owned row and storage object requires enforced ownership. Never trust owner IDs from clients. Versioned outputs are immutable; restoration creates a new selection/version. Jobs are durable, cancellable, bounded by cost, leased, idempotent, and retain partial results. Do not execute jobs in HTTP request lifetimes.

Run typecheck, lint, relevant tests, and production build before verified pushes. Test actual tenant isolation at database boundaries when possible. Distinguish local tests from live provider validation. No secrets in source, output, logs, fixtures, or commits. Preserve all unrelated changes. Specialists own disjoint paths and do not commit or push; lead integrates.

Local and cloud handoffs use this repository's verified `main` revision as their shared source. Check the actual commit and worktree status before starting. Preserve all uncommitted work before updating; reconcile independent changes on a feature branch and publish the verified checkpoint through one pull request. Report the merged commit when handing work off, and verify the receiving checkout and deployment identify that same revision. Credentials and ignored runtime/reference files require their separately authorized configuration or transfer; they are not synchronized by Git.

Shared browser belongs to multiple tasks. Use a dedicated headless browser for local tests; do not disturb SourceAtlas tabs. Ask through the parent before shared GUI use.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
