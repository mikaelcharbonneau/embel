# Continuous integration

[Checks](workflows/ci.yml) runs on pull requests, pushes to `main`, and manual
workflow dispatch. The final `CI` job succeeds only when every required job and
all four test shards succeed. Repository branch protection can require this
single stable check; adding the workflow does not change branch protection.

The web job uses Node 24 from `.nvmrc` and runs the existing typecheck, lint,
production build, production dependency audit and `test:setup` portability checks.
The setup checks use disposable directories and need no Docker or credentials.
Unit/integration tests and
worker bundle builds use Node **22.22.2**, matching the dedicated workers'
runtime qualification and Containerfiles. Each job installs `package-lock.json`
with `npm ci`; only the npm download cache is shared.

The ordinary Vitest suite is split into four shards with two workers per shard.
It includes disposable PGlite database tests, native rendering tests, API tests,
and browser-component tests. The migration composer test also starts a disposable
native PostgreSQL 17 container. Each shard fetches its exact public image digest
before running tests, so changing shard assignments does not depend on a cached
image. That fixture has no network, exposed ports, or application credentials.
Each shard retains its JUnit report for seven days.
To reproduce a shard locally with Node 22.22.2, start your local Docker engine
(Docker Desktop, Colima or OrbStack; the test uses the active local Docker
context) and pull the fixture image once:

```sh
npm ci
docker pull ghcr.io/supabase/cli/postgres:17.11.0.006-r0@sha256:ee0f2d9747fb9d3c0a29703684ec718f070384ad05bf0d92823ed02cabde8e5a
npm test -- --shard=1/4 --maxWorkers=2
```

Outside CI, the native PostgreSQL suite is skipped, with the reason in its name,
when no local engine is running or the image has not been pulled.

No application credentials or GitHub environment are attached to these jobs.
The workflow has only read access to repository contents, does not persist the
checkout token, disables the opt-in live suite, and never invokes deployment,
provider generation, or `npm run test:live`. Tests requiring explicitly configured
native PostgreSQL connection URLs remain skipped; CI does not substitute PGlite for native
concurrency acceptance. Playwright browser journeys and hosted acceptance remain
separate checks.

`npm audit --omit=dev` blocks the web job on any reported production advisory.
The full development audit currently reports the legacy minimatch 3.x advisory
through ESLint and its plugins. Those callers use an API removed by minimatch 11;
forcing a global override would break linting. The compatible Queue and
TypeScript-parser callers use narrow patched overrides. Review the full audit
when updating the lint toolchain instead of downgrading dependencies or disabling
the production audit.

Official actions are pinned to verified commit SHAs. Update their pins when
adopting a new action release, and keep the test runtime synchronized with the
worker runtime declarations.
