> Archived November 10, 2026: describes the system before the generation engine.

# Codex Cloud development

Cloud and local development use the [same repository setup](development-environment.md).
The setup derives its paths from the checkout; no `/workspace/embel-onboarding`
files, original Mac launchers or saved absolute-path browser overrides are needed.

For a saved Cloud environment, select this repository and Node 24. Its install
command can be:

```sh
npm ci
npm run dev:setup
```

The startup command is `npm run dev`. To use the local Auth/database/Storage
stack, make Docker available and run `npm run dev:up` before starting the web
server. The local service and shared schema installation has no provider-key
requirement. Configure the dedicated development provider binding securely, then
run `npm run dev:branding` to package and start the full shared worker in Docker.
The same command is used on a laptop; the Cloud environment is not a different
application edition.

This managed Cloud environment needs the exact-loopback health compatibility
option because BusyBox's health probes ignore the injected `NO_PROXY` setting:

```sh
npm run dev:up -- --proxy-health
npm run dev:doctor
```

Supabase CLI 2.122.0 uses slim images to keep the local database footprint small.
The selected Docker context must point to the local managed daemon. Registry
authentication, proxy settings and CA trust come from the environment. Startup
does not need a second Docker daemon or copied Docker credentials.

For the installed system browser, set `FLUID_E2E_BROWSER_EXECUTABLE` to its
absolute path (in this environment, `/usr/bin/chromium`). On a fresh environment,
`npx playwright install chromium` installs the bundled browser instead.

`npm run dev:doctor` reports actual service state and outstanding worker setup.
Its core-ready result covers Auth, database, private Storage and local email;
worker status is reported separately. The shared worker needs its real model
bindings and a successful preflight, as described in
[complete branding development](development-environment.md#complete-branding-development).

The [local/cloud workflow](local-cloud-sync.md) describes how to move source
changes through GitHub. Environment secrets and database contents are configured
separately on each machine. Product decisions and agent instructions are in
[AGENTS.md](../../AGENTS.md). Older setup records in Git history describe their own
dates and do not supply a fresh checkout's configuration.
