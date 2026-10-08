# Fluid

Private source candidate for the Fluid brand workspace, prepared from the verified 2026-10-08 checkpoint. This is a source handover, not a deployment or activation package.

## Start with the interface

Use a Node.js version accepted by `package.json`: `>=22.13.0 <23 || >=24`. Dependencies are pinned in `package-lock.json`.

```sh
npm ci
npm run dev
```

The development interface binds to `http://127.0.0.1:3105`. Browser-only drafting can be explored independently. Account data, AI, storage, provider checks and durable jobs require their separately configured services. Unavailable integrations must remain explicitly unavailable.

The repository does not include `.env` files, passwords, access tokens, OAuth registrations, user sessions or local worker credentials. Never copy someone else's local runtime state into this checkout.

## Local verification

```sh
npm run typecheck
npm run lint
npm test
npm run build
```

`npm run check` runs those four stages. `npm run test:e2e` requires the separately installed Playwright browser runtime. `npm run test:live` is opt-in, target-allowlisted and requires separately approved test identities; a skipped live suite is not evidence that a service works.

No full-suite or build rerun is claimed for this handover candidate. The source checkpoint has earlier verification evidence retained separately. Verify the final Git branch after any merge or functional change.

## Application structure

- `src/app`, `src/components`, `src/features`: Next.js application and feature UI
- `src/domain`: shared contracts and validation
- `src/server`: server-only authentication, data and provider boundaries
- `worker`: durable worker processes and operation handlers
- `services/api-text-worker`: separately hosted API-text entrypoints
- `supabase/migrations`: database schema changes, including explicitly local-only files
- `supabase/candidates`, `supabase/activation`: reviewed source/templates, not automatically approved rollout instructions
- `tests`: local, integration, adversarial, browser and opt-in live tests

Read `AGENTS.md`, `docs/architecture.md` and `docs/decisions.md` before making changes. Decision records are historical context; obtaining this source does not grant the permissions recorded for another operator, account, device or date.

## Configuration and safety boundaries

The core web configuration uses `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` and `APP_ORIGIN`. Keep environment configuration outside source control. Supabase service-role credentials and worker/database credentials must never enter browser configuration or browser bundles.

This private candidate deliberately preserves non-secret, account-specific Supabase and Vercel allowlists, the checked-in Supabase publishable configuration in `vercel.json`, and activation SQL/test anchor identifiers. These are required by existing functional checks and are not a portable deployment configuration. A new host/account needs a separately reviewed configuration change, with tests. Do not loosen an allowlist to make setup pass.

The existing `vercel.json` preview build invokes a strict configuration preflight. A source push does not authorize a Vercel deployment, domain change, public preview, database migration, persistent role/grant, credential creation or paid model call. Review any repository-connected deployment automation before pushing.

`npm run local`, `npm run worker`, the dedicated logo launcher and the hosted API-text worker require their existing, separately approved setup. Do not run provisioning/activation SQL or enable paid calls simply because the files are present. Never reuse another application's or another developer's credentials.

## Design references and fixtures

Approved design tokens and source implementation are preserved. The original `Fluid-Pen-Design.zip`, `Final Fluid.pen`, preview PNGs and review PDF are not included in this source checkpoint. `docs/references.md` records their provenance and SHA-256 hashes. Obtain the original design bundle through an authorized transfer when design work requires it; do not reconstruct it from screenshots or assume it is in Git.

Four synthetic vector/PDF/ZIP fixtures remain under `docs/evidence` because existing tests load them directly. They are test inputs. Other runtime receipts, private deployment records, screenshots, transfer logs and local machine paths are omitted from this candidate.

## Scope of this candidate

Later vector proposal core, quote, admission, observation and provider work is not included. Its integration and end-to-end acceptance are separate work.

This candidate is prepared for the confirmed private repository `mikaelcharbonneau/emble`. It is not reviewed for public release, and no open-source license is granted here. Preserve any applicable licenses already present for bundled third-party fonts and Unicode fixtures.
