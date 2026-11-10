# Baseline migration release

The database history is now one migration, `supabase/migrations/20261110190000_baseline.sql`.
It reproduces production (Supabase project `fricsfwqibyhemknqgyf`) as it stands after
`20261110180000_retire_old_worker_objects`. Every earlier migration and every hand-applied
packet lives under `supabase/archive/` for history only; nothing reads them any more.

Production already has everything the baseline creates, so the baseline must never run
there. The release records it as applied and nothing else.

## Before the release

1. The baseline PR is merged into `main`.
2. Confirm production's migration history still ends where the baseline expects:

   ```sql
   select version from supabase_migrations.schema_migrations order by version desc limit 3;
   -- expected: 20261110180000, 20261110170000, 20261110160000
   ```

   If a later version is listed, stop: a migration was applied to production that the
   baseline does not contain, and the baseline must be regenerated first.
3. Optional but recommended: run `supabase/tests/baseline-parity.sql` against production
   and against a fresh local stack (`npm run dev:up` on a clean checkout, then the SQL
   through `docker exec -i supabase_db_<project> psql -U postgres -d postgres -At`), and
   diff the two outputs. The PR body of the baseline PR lists the expected result (no
   differences other than the documented ones).

## The release (one statement)

In the Supabase SQL editor, or with the Supabase MCP `execute_sql`, as the `postgres` role:

```sql
insert into supabase_migrations.schema_migrations (version, name, statements)
values ('20261110190000', 'baseline', array['-- recorded as applied; production already had this schema'])
on conflict (version) do nothing;
```

That is the whole release. Do not run `supabase db push`, `supabase migration up` or the
baseline file itself against production: the file creates tables that already exist and
would fail on the first `CREATE TABLE`.

Check:

```sql
select version, name from supabase_migrations.schema_migrations order by version desc limit 2;
-- expected: 20261110190000 baseline, 20261110180000 retire_old_worker_objects
```

From here on, new migrations (for example `20261110200000_account_deletion_and_export.sql`)
are applied to production the usual way, and `supabase migration list --linked` shows the
local and remote histories in agreement.

## Rollback

The release changed one row, so the rollback removes that row:

```sql
delete from supabase_migrations.schema_migrations where version = '20261110190000';
```

Nothing else in production changes either way. If the repository has to go back to the old
layout, revert the baseline PR; the archived files are unchanged copies of the old
`supabase/migrations`, `supabase/candidates`, `supabase/activation` and `supabase/operator`
directories, and `git log --follow` shows their history.

## What a fresh database gets that production does not have

Nothing. The differences run the other way, and are deliberate:

- Production's live settings rows (for example `fluid_private.engine_settings.paused`, the
  `generation_kinds` limits, `inspiration_catalog` entries) may have been edited since the
  migrations inserted them. The baseline inserts the values the migrations inserted.
- Role passwords. The baseline creates the login roles (`embel_engine` and the three
  `embel_shared_http_*_prod_v1` web logins) without passwords; `npm run dev:up` sets local
  ones, production keeps its own.
- The local stack widens `fluid_private.shared_http_target`'s check constraint when its API
  port is not 54321, so the development row can name that port (production's check names
  54321 for the development mode). `scripts/development/provision.mjs` does this after the
  migrations; the migration itself matches production.
