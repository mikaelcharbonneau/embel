> Archived November 10, 2026: describes the system before the generation engine.

# Portable development

The repository contains the setup used on a local computer and in Codex Cloud.
It does not depend on a saved `/workspace/embel-onboarding` directory, an original
Mac checkout, a globally installed Supabase CLI or copied browser sessions.

## Start a checkout

Install Git and Node 24 (24.15.0 or newer within that major). `.nvmrc` selects
Node 24; `nvm install` and `nvm use` are available when using nvm. Docker Desktop
or Docker Engine is needed for local backend services. On this Apple Silicon Mac,
the dedicated Colima profile provides Docker Engine. To restart it and select
it in the current terminal without changing the default Docker context:

```sh
colima start embel
export DOCKER_CONTEXT=colima-embel
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
docker version
```

For a first installation on another Apple Silicon Mac with Homebrew, install
`colima docker node@24` and create the profile with
`colima start embel --runtime docker --vm-type vz --vz-rosetta --cpu 4 --memory 6 --disk 28 --mount-type virtiofs --activate=false`.
Rosetta must be available for the shared amd64 worker. To shut down, stop the
web process with Ctrl-C, run `npm run dev:down`, then `colima stop embel`.

The Node launchers are
designed for macOS, Linux and native Windows with Docker Desktop's Linux
containers; WSL2 can use the Linux workflow. The local backend and native worker
package have been exercised on Linux/Codex Cloud and Apple Silicon with Colima;
native Windows and WSL2 remain untested. No POSIX shell
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
Storage, the API gateway and Mailpit, applies the repository's baseline
migrations, and installs the shared application schema and restricted local
principals. Email confirmation is enabled; local confirmation messages appear
at `http://127.0.0.1:54324`. The app's database API is on port 54321 and PostgreSQL
on 54322. Services bind to loopback on the selected local Docker daemon.
Remote Docker contexts are rejected because the application runs on this machine.

```sh
npm run dev:doctor
npm run dev:down
```

The doctor checks actual core services, HTTP access, installed migration
versions and shared worker status. It does not change setup files.
Stopping retains database, Storage and shared queue volumes. Re-running
`dev:up` starts the same checkout's stack and applies any new baseline migrations. The shared
installer composes the pinned sources: five reviewed Logo predecessors, the shared
production packets, their post-install corrections and one development target adapter.
The first installation is atomic; repeated installation verifies the source
manifest, target and installed SQL authority. It does not reset the database or
blanket-apply the production candidates directory. The installer itself does not
repair projects or call an AI provider. (The earlier additive brainstorm repair
upgrade was removed with the retired Naming engine in November 2026.) Changed installed shared
authority is rejected instead of silently replacing it; use a separate checkout
for an incompatible schema history.

## What travels with Git

| In the repository | Local to each machine/checkout |
| --- | --- |
| Application, `.nvmrc`, dependency lockfile and pinned Supabase CLI 2.122.0 | Installed dependencies and Docker images |
| `config/development/supabase.toml`, setup code and baseline migrations | `.embel-dev/` settings, public web configuration, service versions and staged migration copies |
| Shared worker packaging, policy composer, service map and documentation | Worker passwords, provider credentials, sessions, database, queue and Storage volumes |
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

To run alongside another checkout, select unused ports before the first
`dev:up`. All ports must be distinct and above 1023:

```sh
npm run dev:setup -- --web-port 3155 --api-port 55421 --db-port 55422 --shadow-port 55420 --mail-port 55424
npm run dev:up
npm run dev
```

Settings are saved in `.embel-dev/settings.json`. Once the shared schema and
principals are installed, their origins and ports are pinned to that checkout's
installation. Use a fresh checkout for different ports; stopping services alone
does not migrate those authority bindings. Changing settings invalidates the
old public web configuration until `dev:up` refreshes it. The web launcher uses
the configured port and matching application origin together.

The managed public values in `.embel-dev/web.env` take precedence over inherited
public connection settings, preventing a cloud shell's application origin from
selecting a different backend. They contain only the local publishable key and
public web settings. Raw Supabase CLI output also contains private bootstrap
keys, so the setup reports allowlisted results rather than dumping that output.
Hosted `VERCEL` markers belong to a deployment shell and are reported as a local
configuration conflict.

Existing manual development configuration can still use `.env.development.local`
without running the managed setup. Once `.embel-dev/web.env` exists, it owns the
public target for `npm run dev`. The generated `.embel-dev/shared-web.env`
separately supplies restricted server-side HTTP principals for the shared application. Production builds and
deployments continue to use their own configuration.

## Complete branding development

The shared development installer uses the same guarded SQL packets and worker
engines as the hosted application. It registers restricted Strategy, Naming and
Logo worker identities, separate Identity/Home/Logo web principals, and an actual
local Auth account for private worker Storage. These credentials are generated
for this checkout and saved under ignored `.embel-dev/`. They do not come from
production.

After starting the local services, configure the dedicated application provider
key securely, then run:

```sh
npm run dev:branding
npm run dev
```

`npm run dev:branding -- --build-only` verifies the package and native tools
without a provider key or paid request.

`dev:branding` packages the shared worker for Linux/amd64 with Node 22.22.2,
checks its real artifact and native dependencies, verifies configured model
access, installs matching operation policies, and starts the three worker lanes
in Docker. Strategy, Naming, Logo concepts/refinements, the three visual identity
directions, identity generation and exports use the shared engine. The web
launcher loads the generated private HTTP principal configuration on the server.
The Docker requirement also applies on macOS and Windows; Docker supplies the
worker's pinned Linux runtime instead of depending on host-native binaries.
Apple Silicon requires Docker's amd64 emulation. Worker proxy settings and
`NODE_EXTRA_CA_CERTS` are passed through explicitly when configured.

Like production, the local worker has one Strategy slot, one Naming slot and six
Logo slots, with a per-person limit of six jobs per lane, so the six concepts of
one batch generate at once. Each Logo slot has its own database role and local
Storage service user; slots 2–6 run concepts and refinements only. `dev:up`
adds the missing Logo slots to an existing three-slot local setup and keeps the
original three; rerun `dev:branding` afterward to restart the worker with them.

The development Strategy queue persists messages and acknowledgements on a
checkout-specific Docker volume. It replaces the hosted Vercel Queue transport
while retaining the same Strategy engine and database outbox. Database jobs,
Storage files and queue state survive ordinary shutdown/restart.

Provider keys are read only from `EMBEL_DEVELOPMENT_PROVIDER_API_KEY` in the
worker's calling environment or ignored `.embel-dev/provider.env`. The launcher
does not borrow Codex's `OPENAI_API_KEY`. Model-access checks establish access to
model IDs; they do not prove successful paid image/text generation. Generation
uses the configured application provider account and its normal billing.

The optional central development-secret source is the existing Vercel web
project's Development environment. Once its dedicated key is configured and
`VERCEL_TOKEN` is supplied securely to the shell:

```sh
npm run dev:secrets -- pull
```

This saves the development key into `.embel-dev/provider.env`. To publish an
already configured dedicated development key to that same secret store:

```sh
npm run dev:secrets -- push
```

Scope VERCEL_TOKEN to the secret-sync command or remove it from the shell afterward.
The local runtime deliberately rejects inherited VERCEL-prefixed deployment markers.

These commands synchronize only the dedicated development provider binding.
They do not synchronize local database passwords, select a production database
or commit credentials. A fresh clone does not receive Vercel access tokens or
API keys. See [source of truth and service connections](source-of-truth.md).

`npm run dev:worker -- --lane strategy` and `--lane logo` remain
available for historical per-lane development contracts (Naming runs only on the
shared worker). Their manual bindings
and `config/development/worker.env.example` belong to that older launcher;
`dev:branding` is the shared application flow.

## Verification limits

Linux/Codex Cloud verification used actual local Auth, PostgreSQL, Storage and
email confirmation. Two new accounts completed sign-up, confirmation, sign-in,
project creation/reload, cross-account denial and restart persistence with shared
HTTP routing enabled. The 25-source installation and all 292 release-authority
functions were verified; repeated provisioning retained the same principals.
All three actual restricted web logins passed their TypeScript SQL qualification.
The packaged Linux worker passed native rendering/vector/export probes.

Type checking, lint, production build and focused setup/HTTP/worker tests passed.
GitHub CI now includes the actual local stack and credential-free native package
checks; its first hosted run is separate from these local results.

On November 2, 2026, a separate Apple Silicon run used the saved dedicated
development key with the local Colima profile. Signup, Mailpit confirmation,
fresh browser sign-in and project persistence passed. The packaged Linux/amd64
worker passed native probes and all three lanes qualified against the local
database. These checks alone do not establish inference or billing.
Central Vercel secret synchronization was not exercised in this run.

The same Mac then ran one real project, Patchpath, using the dedicated key.
The shared worker completed a Strategy personality request, one Naming batch,
six raster logo concepts, and three raster visual directions from the selected
logo. The web app downloaded 16 files in one ZIP. Its original logo and selected
direction matched their saved SHA-256 hashes; the board and social PNGs decoded
at their expected dimensions. The app recorded USD 0.273928 across Strategy,
logos and directions. Naming reported 872 input and 3,242 output tokens with no
settled dollar amount. Those are observations from this run, not pricing
estimates for another project or a provider invoice.

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
