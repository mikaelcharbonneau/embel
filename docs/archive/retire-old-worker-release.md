# Releasing the old worker's retirement

_November 10, 2026. For the release lead. Code: the `retire/old-worker` PR
([generation-engine.md](../generation-engine.md), step 6)._

The web release removes the old worker from the code. Production still runs three
old deployment targets until you turn them off. The database is not changed here;
its old tables, functions and logins are dropped later (Phase 5.2, task B2).

Do the steps in order. Each has its own rollback. Steps 1 to 3 are the release;
steps 4 to 7 can follow a day later.

## Before you start

- Vercel CLI signed in to the `embel` team; `psql` or the Supabase SQL editor
  (read-only queries only) for production project `fricsfwqibyhemknqgyf`.
- Every engine kind is enabled. Check (read-only):

  ```sql
  select kind, enabled from public.generation_kinds order by kind;
  ```

  All `strategy.*`, `naming.generate`, `logo.concepts`, `logo.refine`,
  `logo.style_note` and `identity.directions` must be `true`. After this
  release a disabled kind means that step is unavailable to users.

## 1. Let the old queue drain

The current web release starts no old jobs while the engine kinds are on, so the
old queue only drains. Check that nothing old is still working:

```sql
select operation, state, count(*)
from public.jobs
where state in ('queued', 'running', 'cancel_requested')
group by 1, 2 order by 1, 2;
```

- **Expected:** no rows.
- **If rows remain:** wait about 15 minutes with the daemon still running and
  check again. Jobs it has not finished by then stay listed as unfinished in
  their projects. Strategy offers Cancel for them; Naming and Creative direction
  rounds simply stop showing as the latest. Note the job ids in the release log
  for B2.
- **Rollback:** nothing to undo (read-only).

## 2. Deploy the web release

Merge the PR and deploy `main` to the web project `fluid-platform-preview`
(`prj_WKrFUPy3wptZ3qI9l1hTuqPmzkDt`) as usual.

Check on `https://www.embel.xyz` with a test account:

- one Strategy reply, one Naming round and one Logo round finish;
- an older project still shows its names, logos and directions;
- `/api/health/ready` answers `ready`.

**Rollback:** promote the previous production deployment
(`vercel rollback --scope embel`, or Instant Rollback in the dashboard). The old
deployment still has every environment variable it needs, because step 7 comes
later.

## 3. Scale the shared worker daemon to 0

The daemon is the `shared-worker` daemon in project `embel-naming-worker`
(`prj_vTOc6Kf8th7tXK2cOVwWTTaR20yx`). Same commands as
[emergency-stop.md](../emergency-stop.md):

```bash
vercel daemons scale shared-worker iad1=0 --project prj_vTOc6Kf8th7tXK2cOVwWTTaR20yx --scope embel
vercel daemons instances ls shared-worker --project prj_vTOc6Kf8th7tXK2cOVwWTTaR20yx --scope embel --json
```

- **Expected:** no instances after up to 10 minutes (600-second graceful shutdown).
- **Rollback:** `vercel daemons scale shared-worker iad1=1 --project prj_vTOc6Kf8th7tXK2cOVwWTTaR20yx --scope embel`.
  Only useful together with the rollback of step 2; the new web release never
  queues work for it.

## 4. Turn off the API-text worker

Project `fluid-api-text-worker` (`prj_waP1hoGVtBiqJCTqTWKHfRy8iLMk`; the
October 13 inventory placed it in team `mikael-charbonneaus-projects`, so
confirm its team with `vercel project ls` first). It has a cron
(`/api/cron/repair-api-text`, every minute) and a queue consumer (`api/consume`,
topic `fluid-api-text-v1`).

1. **Cron:** Project → Settings → Cron Jobs → Disable Cron Jobs.
2. **Queue consumer and functions:** pause the project (Project → Settings →
   General → Pause Project, or the Vercel API `pause_project`). A paused project
   serves no functions, so the consumer stops taking deliveries.
3. Wait one day, then delete the project (Settings → General → Delete Project).

- **Rollback (1, 2):** unpause the project and re-enable cron jobs.
- **Rollback (3):** none short of redeploying `services/api-text-worker` from
  git tag/commit `e43c9f9` (last `main` with the worker) into a new project and
  re-entering its secrets. Delete only after B2 has dropped the old tables or
  you are sure you will not roll back.

## 5. Remove the daemon project

After step 3 has been quiet for a day:

1. Pause `embel-naming-worker` (`prj_vTOc6Kf8th7tXK2cOVwWTTaR20yx`).
2. After B2, delete the project.

- **Rollback (1):** unpause, then scale as in step 3's rollback.
- **Rollback (2):** redeploy `services/shared-worker` from commit `e43c9f9` into
  a new project with its secrets. As in step 4, delete only when rollback is no
  longer wanted.

## 6. Remove the dormant Logo worker project

Project `embel-logo-worker` (`prj_QSWj13AkZzw4t8ZOGVzncFczz2gC`) already runs
0 instances. Pause it, and delete it with the others after B2.

- **Rollback:** unpause.

## 7. Remove the old environment variables

Do this after the rollback window for step 2 closes (the previous web release
reads some of these). List what each project really has first:

```bash
vercel env ls production --scope embel   # in a checkout linked to each project
```

### Web project `fluid-platform-preview` (`prj_WKrFUPy3wptZ3qI9l1hTuqPmzkDt`)

Remove if present; the new release reads none of them:

`EMBEL_ACCOUNT_ENROLLMENT_ENABLED`, `EMBEL_ACCOUNT_HTTP_SOURCE_ENABLED`,
`EMBEL_ACCOUNT_HTTP_SOURCE_CONFIG`, `EMBEL_MANAGED_LOGO_ENABLED`,
`FLUID_API_TEXT_WORKER_ORIGIN`, `FLUID_LOCAL_API_TEXT_ENABLED`,
`FLUID_HOSTED_LOGO_ENABLED`, `FLUID_HOSTED_NAMING_ENABLED`,
`FLUID_LOCAL_LOGO_ENABLED`, `FLUID_LOCAL_PROTOTYPE`, `FLUID_LOCAL_BRIDGE_TOKEN`,
`FLUID_RUNTIME`, `FLUID_PAID_CALLS_APPROVED`, `FLUID_OPENAI_VERIFIED_MODELS`,
`FLUID_GUIDED_INTERVIEW_ENABLED`, `FLUID_TEXT_MODEL_STRATEGY`,
`FLUID_TEXT_MODEL_REFORMULATE`, `FLUID_TEXT_MODEL_COMPETITORS`,
`FLUID_TEXT_MODEL_AUDIENCE`, `FLUID_TEXT_MODEL_PERSONALITY`,
`FLUID_TEXT_MODEL_POSITIONING`, `FLUID_TEXT_MODEL_SLOGAN`.

**Keep:** `EMBEL_ENGINE_*`, `OPENAI_API_KEY`, `NEXT_PUBLIC_SUPABASE_*`,
`APP_ORIGIN`, `NEXT_PUBLIC_TURNSTILE_SITE_KEY`, the standalone checks
(`FLUID_NAMECOM_*`, `FLUID_RDAP_*`, `FLUID_EUIPO_*`, `FLUID_YOUTUBE_*`,
`FLUID_CLOUDFLARE_*`, `FLUID_VERCEL_DOMAIN_CHECKS_ENABLED`), and the web app's
restricted write lanes: `EMBEL_SHARED_ACCOUNT_HTTP_CONFIG`,
`EMBEL_SHARED_LOGO_HTTP_CONFIG` and the switch that turns them on.

**Careful with `EMBEL_SHARED_WORKERS_ENABLED`:** the old release used it to route AI
to the worker, but it also turns on the write lanes (Home attachments, Creative
direction choices, Logo reference uploads). The new release still accepts it
for that. Before removing it, set `EMBEL_SHARED_ACCOUNT_HTTP_ENABLED=true`,
redeploy, and check that a Home attachment upload and a Creative direction
choice still save. Rollback: set `EMBEL_SHARED_WORKERS_ENABLED=true` again and
redeploy.

### Old worker projects

The variables of `embel-naming-worker`, `fluid-api-text-worker` and
`embel-logo-worker` go away with the projects (steps 4 to 6), so nothing to
remove one by one. For the record, they hold `EMBEL_SHARED_WORKER_POOL_*`,
`FLUID_WORKER_*`, `FLUID_LOGO_*`, `FLUID_WEB_OIDC_*`, `FLUID_API_TEXT_*`,
`EMBEL_LOGO_*` and their own `OPENAI_API_KEY`.

- **Rollback:** re-add a removed variable with `vercel env add` and redeploy.
  Note each value's source (password manager or provider dashboard) before
  removing it; Vercel does not show sensitive values again.

## After the release

- Record the deployment id, the times of each step and the step 1 query result
  in a dated release note.
- Hand the unreferenced database objects listed in the PR to B2.
- Revoke the worker's own OpenAI key if it differs from the web app's.
