# Environment variables

This is the complete list of environment variables the application reads (`src/`, `scripts/`,
`next.config.ts`). Anything not listed here is not read. Never put a secret in a `NEXT_PUBLIC_*`
variable or in the repository. Keep this file in step with the code when a variable is added or removed.

Runtime: Node 24 (`.nvmrc`, `package.json` engines, CI). The Vercel project's Node.js version setting must
also be 24.x.

## Production (Vercel project settings)

| Variable | What it does | Where it is set |
|---|---|---|
| `APP_ORIGIN` | The site's public address, for example `https://embel.example`. Used for origin checks and links. Must be `https`. | Vercel, Production |
| `NEXT_PUBLIC_SUPABASE_URL` | The Supabase project URL. Public. | Vercel, all environments |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | The Supabase publishable key (`sb_publishable_...`). Public. | Vercel, all environments |
| `EMBEL_ENGINE_DATABASE_URL` | Server-only Postgres connection string used by the generation engine (durable jobs, usage records). | Vercel, Production (secret) |
| `EMBEL_ENGINE_SUPABASE_SECRET_KEY` | Server-only Supabase secret key (`sb_secret_...`). Used by the engine for private file storage and by account deletion, export and the cleanup job. | Vercel, Production (secret) |
| `EMBEL_SHARED_ACCOUNT_HTTP_ENABLED` | `true` turns on the restricted Identity, Home attachment and Logo database lanes. Without it those lanes stay unavailable. | Vercel, Production |
| `EMBEL_SHARED_ACCOUNT_HTTP_CONFIG` | Server-only JSON with the restricted database logins for the Identity and Home lanes (`identity`, `homeVerifier`). See `src/server/shared-account/README.md`. | Vercel, Production (secret) |
| `EMBEL_SHARED_LOGO_HTTP_CONFIG` | Server-only JSON (`roleName`, `roleOid`, `databaseUrl`) for the Logo lane's restricted login. | Vercel, Production (secret) |
| `OPENAI_API_KEY` | OpenAI key for all text and image generation. A missing key is a configuration error, never a fake result. | Vercel, Production (secret) |
| `CRON_SECRET` | Bearer secret that Vercel Cron sends to `/api/maintenance/account-cleanup`. | Vercel, Production (secret) |
| `FLUID_NAMECOM_API_TOKEN` | Name.com API token for live domain availability checks. | Vercel, Production (secret) |
| `FLUID_NAMECOM_USERNAME` | Name.com API username. | Vercel, Production |
| `FLUID_NAMECOM_CHECKS_ENABLED` | `true` turns on the Name.com domain checks. | Vercel, Production |
| `STRIPE_SECRET_KEY` | Server-only Stripe secret key (`sk_test_…` / `rk_test_…`; live keys are refused unless `VERCEL_ENV=production`). Checkout, customer portal, webhook re-reads and subscription cancellation on account deletion ([payments.md](payments.md)). | Vercel (secret) |
| `STRIPE_WEBHOOK_SECRET` | Server-only signing secret (`whsec_…`) of the Stripe webhook endpoint `/api/billing/stripe-webhook`. Without it the endpoint answers 503 and Stripe retries. | Vercel, Production (secret) |

## Optional (off or defaulted when unset)

| Variable | What it does | Default |
|---|---|---|
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | Turns on the Turnstile captcha widget on the sign-in forms. | Off |
| `FLUID_NAMECOM_ENVIRONMENT` | Name.com environment; live checks only run for `production`. | Not production |
| `FLUID_RDAP_CHECKS_ENABLED` | Set `false` to turn off the RDAP domain check. | On |
| `FLUID_VERCEL_DOMAIN_CHECKS_ENABLED` | Set `false` to turn off the Vercel domain check. | On |
| `FLUID_CLOUDFLARE_CHECKS_ENABLED`, `FLUID_CLOUDFLARE_ACCOUNT_ID`, `FLUID_CLOUDFLARE_API_TOKEN` | Cloudflare registrar check. Needs all three. | Off |
| `FLUID_YOUTUBE_CHECKS_ENABLED`, `FLUID_YOUTUBE_API_KEY` | YouTube handle check. Needs both. | Off |
| `FLUID_EUIPO_CHECKS_ENABLED`, `FLUID_EUIPO_CLIENT_ID`, `FLUID_EUIPO_CLIENT_SECRET` | EUIPO trademark search. Needs all three. | Off |
| `EMBEL_SOURCE_REVISION` | A 40-character git commit hash, reported by the health endpoint when `VERCEL_GIT_COMMIT_SHA` is not available. | `unknown` |

## Set by the platform (do not set by hand)

`VERCEL`, `VERCEL_ENV`, `VERCEL_URL`, `VERCEL_BRANCH_URL`, `VERCEL_PROJECT_PRODUCTION_URL`,
`VERCEL_GIT_COMMIT_SHA`, `NODE_ENV`, `NEXT_RUNTIME`, `NEXT_TELEMETRY_DISABLED` (optional).

## Local development and tests only

| Variable | What it does | Where it is set |
|---|---|---|
| `EMBEL_DEVELOPMENT_ENABLED` | `true` allows local loopback targets (`127.0.0.1`). Refused on Vercel. | `.embel-dev/web.env`, written by `npm run dev:up` |
| `EMBEL_DEVELOPMENT_DATABASE_PORT` | The local database port for the restricted lanes. | `.embel-dev/shared-web.env`, written by `npm run dev:up` |
| `EMBEL_DEVELOPMENT_PROVIDER_API_KEY` | OpenAI key for local scripts such as `scripts/build-inspiration-logo-styles.mts`. | `.env.development.local` or `npm run dev:secrets` |
| `EMBEL_OPENAI_BASE_URL` | Points the engine at a stand-in provider for the browser journey test. Ignored when `VERCEL_ENV=production`. | `tests/journey` |
| `EMBEL_SHARED_*` | Local versions of the three shared-lane variables above. | `.embel-dev/shared-web.env`, written by `npm run dev:up` |
| `JOURNEY_REUSE_SERVERS`, `FLUID_E2E_PORT`, `FLUID_E2E_BROWSER_EXECUTABLE`, `FLUID_E2E_BROWSER_CHANNEL` | Playwright and journey test settings. | Shell or CI |
| `DOCKER_HOST`, `DOCKER_CONTEXT`, `CI`, `TMPDIR`, `PATH` | Standard variables read by the local launcher and test tooling. | Shell |

Local development always runs the shared lanes (`dev:up` sets `EMBEL_SHARED_ACCOUNT_HTTP_ENABLED=true`).

## Present in Vercel but not read

`STRIPE_PUBLISHABLE_KEY` and `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`: Stripe Checkout and the customer portal are
hosted pages the app redirects to, so no browser key is needed. They are public values and harmless to keep.

## Removed

These are no longer read anywhere: `EMBEL_SHARED_WORKERS_ENABLED` (old name of
`EMBEL_SHARED_ACCOUNT_HTTP_ENABLED`), `EMBEL_ACCOUNT_HTTP_ENABLED`, `EMBEL_ACCOUNT_HTTP_BINDINGS`,
`EMBEL_DEVELOPMENT_IDENTITY_*`, `EMBEL_DEVELOPMENT_ATTACHMENTS_*`, `FLUID_LOGO_WEB_*`,
`EMBEL_ACCOUNT_ADMIN_SECRET_KEY`, `FLUID_PAID_CALLS_APPROVED`. Unsetting them in Vercel is safe.
