# Portable development

The repository contains the setup used on a local computer and in Codex Cloud.
It does not depend on a saved `/workspace/embel-onboarding` directory, an original
Mac checkout, a globally installed Supabase CLI or copied browser sessions.

## Start a checkout

Install Git and Node 24 (24.15.0 or newer within that major). `.nvmrc` selects
Node 24; `nvm install` and `nvm use` are available when using nvm. Docker Desktop
or Docker Engine is needed for local backend services. The Node launchers are
designed for macOS, Linux and native Windows with Docker Desktop's Linux
containers; WSL2 can use the Linux workflow. This setup has been exercised on
Linux/Codex Cloud; macOS, native Windows and WSL2 remain untested. No POSIX shell
assignment is needed in the npm development commands.

```sh
npm ci
npm run dev:setup
npm run dev
```

This starts the interface at `http://127.0.0.1:3105`, with account integrations
unconfigured. For the local account backend, start Docker, then run:

```sh
npm run dev:up
npm run dev
```

`dev:up` includes setup. It starts Auth, PostgreSQL 17, PostgREST, private
Storage, the API gateway and Mailpit, and applies the repository's baseline
migrations. Email confirmation is enabled; local confirmation messages appear
at `http://127.0.0.1:54324`. The app's database API is on port 54321 and PostgreSQL
on 54322. Services bind to loopback on the selected local Docker daemon.
Remote Docker contexts are rejected because the application runs on this machine.

```sh
npm run dev:doctor
npm run dev:down
```

The doctor checks the actual core services, HTTP access and installed migration
versions, and reports worker files separately. It does not change setup files.
Stopping retains database and Storage volumes. Re-running `dev:up` starts the
same checkout's stack and applies any new baseline migrations. It does not reset
the database or apply the production candidates directory.

## What travels with Git

| In the repository | Local to each machine/checkout |
| --- | --- |
| Application, `.nvmrc`, dependency lockfile and pinned Supabase CLI 2.122.0 | Installed dependencies and Docker images |
| `config/development/supabase.toml`, setup code and baseline migrations | `.embel-dev/` settings, public web configuration, service versions and staged migration copies |
| Worker environment template and service documentation | Worker passwords, provider credentials, sessions, database and Storage volumes |
| Browser executable/channel options | Browser installation and temporary test output |

Setup derives paths from the checked-out scripts. A checkout-specific project
ID isolates its containers and volumes from other checkouts. Moving the ignored
state directory is unnecessary; a fresh clone gets a new local stack. Keeping
the same existing checkout retains its stack. Git does not synchronize database
contents, files uploaded to Storage or credentials.

Baseline SQL is copied byte-for-byte, sorted after removing the optional leading
`local` from filenames. The migration count is discovered from the checkout
(currently 87); `.embel-dev/migration-manifest.json` records each original name,
staged name and SHA-256. Changed or removed applied history needs a separate
checkout/database rather than an implicit destructive reset.
`.gitattributes` keeps SQL and container-script line endings consistent across
operating systems, including checkouts that otherwise use Windows line endings.

## Ports and environment settings

To run alongside another checkout, stop this checkout's stack and select unused
ports. All ports must be distinct and above 1023:

```sh
npm run dev:down
npm run dev:setup -- --web-port 3155 --api-port 55421 --db-port 55422 --shadow-port 55420 --mail-port 55424
npm run dev:up
npm run dev
```

On a fresh checkout, omit `dev:down`. Settings are saved in
`.embel-dev/settings.json`. Changing ports invalidates the old public web
configuration until `dev:up` refreshes it. The web launcher uses the configured
port and matching application origin together.

The managed public values in `.embel-dev/web.env` take precedence over inherited
public connection settings, preventing a cloud shell's application origin from
selecting a different backend. They contain only the local publishable key and
public web settings. Raw Supabase CLI output also contains private bootstrap
keys, so the setup reports allowlisted results rather than dumping that output.
Hosted `VERCEL` markers belong to a deployment shell and are reported as a local
configuration conflict.

Existing manual development configuration can still use `.env.development.local`
without running the managed setup. Once `.embel-dev/web.env` exists, it owns the
public target for `npm run dev`. Production builds and deployments continue to
use their own configuration.

## Worker and feature configuration

Core service readiness and worker configuration are separate:

| Feature | Additional setup |
| --- | --- |
| Sign-up, confirmation, sign-in and ordinary projects | Available through the local core stack |
| Home attachments | Owner-bound `embel_dev_attachments_*` login, principal binding and helper grants |
| Identity selections/refinements | Trusted transaction helpers and owner-bound `embel_dev_identity_*` login; see [Identity transactions](development-identity-transactions.md) |
| Strategy and Naming | Restricted text-worker login, actual owner/deployment binding, capabilities and provider settings |
| Local Logo concepts, refinements, vectorization and exports | Restricted Logo login, operation policies and a separate Auth/Storage session; see [Logo Storage](development-logo-storage.md) |
| Current shared-worker visual directions and complete branding generation | Not implemented by the older local worker launcher; the core bootstrap does not claim feature parity with the hosted shared worker |

The previous cloud installer also supplied only the core stack. Copying its
scripts would not enable the remaining capabilities. This portable setup makes
those boundaries visible and provides one place for later provisioning work.

Copy `config/development/worker.env.example` to `.embel-dev/strategy.env`,
`.embel-dev/naming.env` or `.embel-dev/logo.env`, then supply that lane's actual
local bindings. Secrets stay in ignored files or the machine's environment.
The preflight command has no operating-system-specific shell syntax:

```sh
npm run dev:worker -- --lane strategy
npm run dev:worker -- --lane naming
npm run dev:worker -- --lane logo
```

The launcher reads optional `.env.development.local`, then the lane file, then
inherited explicit worker settings. Managed public target values come from
`.embel-dev/web.env`. It sets `NODE_ENV=development` in the child process.
Preflight checks bindings and does not dispatch generation. `--run` selects
execution when the runtime's required bindings and settings are present.

Text lanes use `embel_development_text_worker`; Logo uses
`embel_development_logo_worker`. Each binds to a real owner and a deployment ID
beginning `embel-dev-`. The proof helper is
`supabase/development/worker-preflight.sql`. Provider execution reads the dedicated
`EMBEL_DEVELOPMENT_PROVIDER_API_KEY`, model and verified-model settings plus the
existing dispatch flags. It does not borrow Codex's `OPENAI_API_KEY`.

The existing local Logo issuer SQL uses API port 54321. Other ports are supported
for the core stack; that legacy issuer needs a corresponding reviewed change
when configuring Logo on a different API port. Put worker passwords and provider
credentials in lane files or worker-only environments. The managed web file
contains public values only; the launcher also inherits the invoking shell.

## Codex Cloud and browsers

The same `npm ci`, `dev:setup`, `dev:up` and `dev` commands apply in Cloud. See
[cloud setup](cloud-development.md). In managed proxy environments where the
Auth/Storage BusyBox health probes ignore `NO_PROXY`, use:

```sh
npm run dev:up -- --proxy-health
```

This builds repository-owned helpers for the pinned CLI images. Only the exact
container-loopback health URLs bypass the HTTP proxy; health failures remain
failures and other requests retain their usual proxy behavior. Normal Docker
networking, registry authentication and certificate validation are retained.

For browser tests, install Chromium with `npx playwright install chromium`, or
set `FLUID_E2E_BROWSER_EXECUTABLE` to an existing browser's absolute path. The
alternative `FLUID_E2E_BROWSER_CHANNEL=chrome` uses installed Chrome; choose one
override at a time. No ignored config containing an old checkout path is needed.

`npm run test:setup` covers setup behavior. `npm run typecheck`, `npm run lint`,
`npm test`, `npm run build` and `npm run test:e2e` are available for application
work. Browser journeys use a completed build. The opt-in live suite remains a
separate command because it uses configured real accounts and services.
