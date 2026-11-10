# Emergency stop: AI generation

Use this when spending looks wrong or generations misbehave. It stops all research, naming and logo
work at once. The website, sign-in and downloads keep working.

## Stop

Needs the Vercel CLI, signed in to the Embel team.

```bash
vercel daemons scale shared-worker iad1=0 --project prj_vTOc6Kf8th7tXK2cOVwWTTaR20yx --scope embel
```

Check that it stopped:

```bash
vercel daemons instances ls shared-worker --project prj_vTOc6Kf8th7tXK2cOVwWTTaR20yx --scope embel --json
```

What happens next:

- The worker gets up to 10 minutes (its 600-second graceful shutdown) to finish what it's doing.
- Jobs cut off mid-run end as `lease_expired` or `send_interrupted` the next time a worker runs.
  They are never sent to OpenAI again automatically.
- New requests wait in the queue until the worker starts again.

## Start again

```bash
vercel daemons scale shared-worker iad1=1 --project prj_vTOc6Kf8th7tXK2cOVwWTTaR20yx --scope embel
```

## Money backstop

In the OpenAI dashboard, set a monthly budget and email alerts for the project that holds the
production key. It caps spending even if nobody runs the stop above.

## Good to know

- `prj_vTOc6Kf8th7tXK2cOVwWTTaR20yx` is the Vercel project named `embel-naming-worker`. It hosts the
  shared worker for research, naming and logos.
- Setting `FLUID_PAID_CALLS_APPROVED=false` does **not** stop the shared worker today. Its logo lanes
  hard-code approval (`worker/shared-lanes/logo.ts:117`). Use the scale command instead.
- A proper "stop paid calls" switch is planned for the new generation engine
  ([architecture review](architecture-review.md), step 4.1).
- Sources: `docs/release-20261109-naming-rebuild.md` (Rollback) and
  `docs/review-fixes-rollout-20261102.md`.
