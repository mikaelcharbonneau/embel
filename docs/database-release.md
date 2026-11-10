# Database release

How database changes get from a pull request to production, and the checks on the way.
Task B4 of `docs/execution-plan.md`.

## What CI checks (job "Database migrations")

Runs on every pull request and every push to `main`, with no path filter, so it can be a
required check as it is. No production access.

1. **Guards** (`scripts/ci/migration-guard.mjs`, tests in `tests/setup/migration-guard.test.mjs`):
   - File names match `^\d{14}_[a-z0-9_]+\.sql$`, versions are unique and strictly increasing, and a
     new migration is newer than every migration already on the base branch.
   - A pull request may only **add** files to `supabase/migrations`: modifying, renaming or deleting
     one that exists on the base branch fails (it is already applied somewhere).
   - Nothing is added under `supabase/archive`.
   - In an added migration, every `create [or replace] function` has a later `revoke ... on function`
     from `public`, `anon` or `authenticated` and, for schema `public`, a later `grant execute`.
     Functions in `fluid_private` need only the revoke; trigger functions need no grant. Matching is
     by schema-qualified name.
   - No `postgres://user:password@` URL, `sb_secret_` key, `sk-` key or JWT in any migration.
2. **Build**: a fresh local Postgres (the Supabase CLI's image, only the database is started) applies
   `supabase/migrations` from scratch with `supabase start`. Any SQL error fails the job.
3. **History**: `supabase migration list --local` must show every migration applied and none
   missing (`scripts/ci/migration-history.mjs applied`).
4. **Drift fingerprint**: `supabase/tests/baseline-parity.sql` runs against that database. The full
   output is the `schema-fingerprint` artifact (30 days) and the summary rows are on the run page.
   To look for drift, run the same file against production (SQL editor or read-only `execute_sql`)
   and diff the two outputs.

Run the guards locally: `node scripts/ci/migration-guard.mjs --base origin/main`.

## Writing a migration

Add a new file with a timestamp later than the newest one, for example
`20261112090000_short_name.sql`. Never edit one that is on `main`. New functions are private by
default, so each needs, after its `create function`:

```sql
revoke all on function public.my_function(uuid) from public, anon, authenticated;
grant execute on function public.my_function(uuid) to service_role;  -- or authenticated
```

## The release workflow (`.github/workflows/release-database.yml`)

Manual (`workflow_dispatch`), from `main` only, in the `production` environment. It links the
production project (`fricsfwqibyhemknqgyf`), shows its migration history, runs a preflight
(the baseline is recorded, production has nothing the repository lacks, pending migrations are
newer than the newest applied one), runs `supabase db push --linked --dry-run`, and only when
**apply** is ticked runs the real `supabase db push --linked`. It uses the Supabase CLI pinned in
`package-lock.json`.

It does nothing until the owner finishes the setup below: without the two secrets its first step
fails with a message and no later step runs.

### Owner setup (once)

In GitHub, repository **Settings, Environments**:

1. Create the environment `production`.
2. Under **Required reviewers**, add the owner (and nobody who should not approve a release).
3. Under **Deployment branches and tags**, choose **Selected branches** and add `main`.
4. Under **Environment secrets**, add:
   - `SUPABASE_ACCESS_TOKEN`: a personal access token from Supabase, Account, Access Tokens.
   - `SUPABASE_DB_PASSWORD`: the production database password (Supabase, Project Settings, Database).

Add the secrets to the environment, not to the repository: repository secrets would be readable
without the reviewer approval. Rotate both by replacing the values in the same place.

Before the first release, record the baseline in production as `docs/baseline-release.md` describes;
the preflight refuses to run otherwise, because a push would replay the baseline and fail.

### Lead: releasing a migration

1. Merge the pull request that adds the migration (CI is green, including "Database migrations").
2. Actions, **Release database**, Run workflow on `main`, **apply** off. The owner approves the run.
   Read the dry-run step: it must list exactly the migrations you expect and nothing else.
3. Run it again with **apply** on, and have the owner approve. Check the final history listing.
4. Verify the app against production as usual. Rollback is a new migration that undoes the change
   (write it in the original pull request's description beforehand); never edit the applied file.

If the preflight fails, read its message: production has a migration this checkout lacks (fix
`main` first), or a pending migration is older than the newest applied one (re-version it with a
newer timestamp in a new pull request).

### Not verified yet

The workflow could not be run without the secrets, so the CLI calls against the linked project
(`link`, `migration list --linked --output-format json`, `db push --dry-run`) are unexercised. The
first dry run is the test. `link` and `db push` reach the database through Supabase's connection
pooler, which works from GitHub's IPv4 runners; if the first run reports a connection error, send
the log to the lead.
