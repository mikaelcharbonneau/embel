# Continuous integration

[Checks](workflows/ci.yml) runs on pull requests, pushes to `main`, and manual
workflow dispatch. The final `CI` job succeeds only when every required job and
all four test shards succeed. Repository branch protection can require this
single stable check; adding the workflow does not change branch protection.

Every job uses Node 24 from `.nvmrc`. The web job runs the existing typecheck, lint,
production build, production dependency audit and `test:setup` portability checks.
The setup checks use disposable directories and need no Docker or credentials.
Each job installs `package-lock.json` with `npm ci`; only the npm download cache is shared.

The ordinary Vitest suite is split into four shards with two workers per shard.
It includes disposable PGlite database tests (they apply the baseline migration from
`supabase/migrations`), native rendering tests, API tests, and browser-component
tests. No Docker engine is needed for this job. Each shard retains its JUnit report
for seven days. To reproduce a shard locally with Node 24:

```sh
npm ci
npm test -- --shard=1/4 --maxWorkers=2
```

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
