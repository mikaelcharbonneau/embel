# Bot protection and request rate limits on paid AI routes

_November 9, 2026. Step 2.2 of `docs/architecture-review.md`, without the sign-up CAPTCHA._
The database still enforces credits, per-kind daily limits and the global cost cap. This adds
protection in front of it.

## What ships in code (this PR)

| Layer | What | Where |
|---|---|---|
| Vercel BotID, browser | Attaches BotID's invisible challenge to `POST` calls to the protected routes | `src/instrumentation-client.ts` (`initBotId`, Next.js 15.3+ method) |
| Vercel BotID, server | `assertNotBot()` first in each protected `POST`. A bot verdict answers 403 `bot_detected` (existing `ApiError` format) before anything starts | `src/server/http/bot-protection.ts` |
| BotID challenge proxy | `withBotId()` adds the rewrites that serve the challenge from our own origin | `next.config.ts` |
| Route list | One list shared by browser and tests | `src/domain/bot-protected-routes.ts` |

Protected routes (all `POST`): `/api/projects/{id}/generations` (Strategy, Naming, Logo and
every other engine kind), `.../naming/feed/ensure`, `.../naming/steering`, `.../logo/requests`
(the older Logo admission path), `.../strategy` and `.../identity/batches` (the older Strategy and
Identity paths, which still start paid work). `logo/engine` is read-only (GET) and starts nothing. `/api/billing/checkout` (starting a paid Stripe checkout, [payments.md](payments.md)) is in the same list.

**Fail open.** If BotID errors, is unreachable or takes longer than 3 seconds, the request goes
through and `botid_check_failed` is logged with `logServerError`. Reason: BotID is an extra layer;
an outage there must not stop paying users from generating. The credit, daily and cost-cap checks
in the database still apply to every request, so the worst case is unfiltered bot traffic for the
length of the outage, not unlimited spend. The check is skipped outside Vercel (`VERCEL !== "1"`):
local development and CI have no BotID service.

**Lead actions for BotID** (not done by this PR): in the Vercel dashboard, project `embel`,
Firewall tab, Configure, enable BotID. Optionally enable Deep Analysis (stronger; billed per
check on Pro, so enable after seeing real volume). Without BotID enabled on the project the server
check returns a human verdict, so merging first is safe.

## Rate limits: dashboard or CLI only

Vercel WAF rate-limit rules cannot be shipped in `vercel.json` or `vercel.ts` (project routes
there support only deny and challenge). `@vercel/firewall` `checkRateLimit()` still needs a rule ID created in the dashboard. So the
rules are applied with the Vercel CLI (`vercel firewall`) or in the dashboard. No code change is
needed for the rules below, and they are not applied by this PR.

Plan: Pro supports rate-limit rules with fixed windows, counted per IP (or JA4). Counters are per
region, so the real ceiling can be a few times the number below.

Path regex used by both rules (the six protected routes):

```
^/api/projects/[^/]+/(generations|naming/feed/ensure|naming/steering|logo/requests|strategy|identity/batches)$
```

### Rule 1: burst, per IP

| Setting | Value |
|---|---|
| Name | `Paid AI starts: burst per IP` |
| Conditions (AND) | `method` equals `POST`; `path` matches regex above |
| Action | Rate limit; when exceeded: `rate_limit` (429) |
| Window / limit | 60 seconds / 10 requests |
| Count by | `ip` |

### Rule 2: sustained, per IP

| Setting | Value |
|---|---|
| Name | `Paid AI starts: hourly per IP` |
| Conditions (AND) | same as Rule 1 |
| Action | Rate limit; when exceeded: `rate_limit` (429) |
| Window / limit | 3600 seconds / 120 requests |
| Count by | `ip` |

Why these numbers: a person starts a run per click, and a branding session is a few dozen at most;
10 per minute and 120 per hour leave room for retries and shared office addresses while stopping
scripts. Polling uses GET and is not counted.

### Commands (run from the linked project; drafts are staged until published)

```bash
vercel firewall rules add "Paid AI starts: burst per IP" \
  --condition '{"type":"method","op":"eq","value":"POST"}' \
  --condition '{"type":"path","op":"re","value":"^/api/projects/[^/]+/(generations|naming/feed/ensure|naming/steering|logo/requests|strategy|identity/batches)$"}' \
  --action rate_limit --rate-limit-window 60 --rate-limit-requests 10 \
  --rate-limit-keys ip --rate-limit-action log --yes

vercel firewall rules add "Paid AI starts: hourly per IP" \
  --condition '{"type":"method","op":"eq","value":"POST"}' \
  --condition '{"type":"path","op":"re","value":"^/api/projects/[^/]+/(generations|naming/feed/ensure|naming/steering|logo/requests|strategy|identity/batches)$"}' \
  --action rate_limit --rate-limit-window 3600 --rate-limit-requests 120 \
  --rate-limit-keys ip --rate-limit-action log --yes

vercel firewall diff
vercel firewall publish --yes
```

### Staged rollout (recommended)

1. Publish as above with `--rate-limit-action log`. Review hits in the dashboard Firewall traffic
   view for a day or two of real use.
2. If only scripts or abuse match, switch both rules to enforce:
   `vercel firewall rules edit "<name>" --rate-limit-action rate_limit --yes`, then `publish`.
3. Rollback: `vercel firewall rules disable "<name>"` then `vercel firewall publish --yes`.

The browser should show a clear message on 429; the app already handles non-2xx start responses
with its generic retry message.

## Verification in this PR

`tests/server/bot-protection.test.ts`: bot verdict gives 403 and starts no generation; human verdict
starts it; a BotID error and a BotID timeout both fail open and log; the check is skipped off Vercel;
and every route in the shared list really calls `assertNotBot()` first in its `POST`.
