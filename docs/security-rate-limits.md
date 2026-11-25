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
every other engine kind), `.../naming/feed/ensure`, `.../naming/steering` and `.../identity/batches`
(Creative directions). `logo/engine` is read-only (GET) and starts nothing. `/api/billing/checkout`
(starting a paid Stripe checkout, [payments.md](payments.md)) is in the same list. The older
`.../logo/requests` and `.../strategy` paths no longer accept `POST`; the firewall rule still names
them, which is harmless.

**Account forms (November 23, 2026).** `/api/auth/sign-in`, `/api/auth/sign-up`,
`/api/auth/password-reset` and `/api/auth/resend-confirmation` are in the same list and call
`assertNotBot()` first, before the body is read or Supabase is called. They are what a script would
hammer to guess passwords, create accounts in bulk or send confirmation and reset emails, and until
the Turnstile CAPTCHA is keyed ([auth-captcha.md](auth-captcha.md)) nothing else stood in front of
them. A blocked request answers 403, and the forms already say "This request couldn't be verified.
Refresh the page and try again." Tests: `tests/server/bot-protection-auth.test.ts`.

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

_Status, read from the project on November 23, 2026: all four rules below are live and enforcing
(`rate_limit`): the two "Paid AI starts" rules since November 10, the two "Account forms" rules since
November 23._

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

### Account forms: two more rules (live since November 23, 2026)

The same two windows for the four account-form routes. BotID stops scripted browsers; these stop a
plain script that sends correct headers. Sign-in at Supabase is also limited per IP, but Supabase sees
Vercel's addresses, not the visitor's, so its limit does not tell visitors apart.

| Rule | Window / limit | Count by |
|---|---|---|
| `Account forms: burst per IP` | 60 seconds / 10 requests | `ip` |
| `Account forms: hourly per IP` | 3600 seconds / 60 requests | `ip` |

Conditions for both: `method` equals `POST`; `path` matches
`^/api/auth/(sign-in|sign-up|password-reset|resend-confirmation)$`.

```bash
vercel firewall rules add "Account forms: burst per IP" \
  --condition '{"type":"method","op":"eq","value":"POST"}' \
  --condition '{"type":"path","op":"re","value":"^/api/auth/(sign-in|sign-up|password-reset|resend-confirmation)$"}' \
  --action rate_limit --rate-limit-window 60 --rate-limit-requests 10 \
  --rate-limit-keys ip --rate-limit-action rate_limit --yes

vercel firewall rules add "Account forms: hourly per IP" \
  --condition '{"type":"method","op":"eq","value":"POST"}' \
  --condition '{"type":"path","op":"re","value":"^/api/auth/(sign-in|sign-up|password-reset|resend-confirmation)$"}' \
  --action rate_limit --rate-limit-window 3600 --rate-limit-requests 60 \
  --rate-limit-keys ip --rate-limit-action rate_limit --yes

vercel firewall publish --yes
```

The forms already show "Too many sign-in attempts. Wait a little before trying again." on 429. Both
rules were added through the Vercel API (`PATCH /v1/security/firewall/config`, action `rules.insert`)
with a Vercel access token; the Vercel connector can read the firewall but not change it. Rollback:
`vercel firewall rules disable "<name>"`, then `vercel firewall publish --yes`.

### Provider sign-in start (November 25, 2026)

`POST /api/auth/oauth/{google,apple,chatgpt}` ([provider-sign-in.md](provider-sign-in.md)) is not in the
BotID list: it is a plain form post, which cannot carry BotID's challenge. It starts no paid work, sends
no email and creates no account, so a rate limit is not required for safety. To keep all account routes
under the same two limits, the path of both "Account forms" rules was widened to

```
^/api/auth/(sign-in|sign-up|password-reset|resend-confirmation|oauth/[^/]+)$
```

_Status: live since November 25, 2026 (firewall config version 4), with the same windows and limits
as above. It was changed with `vercel firewall rules edit "<rule>" --condition ... --condition ...`
and `vercel firewall publish`; the Vercel connector answered 403. Rollback: edit both rules back to
the path without `oauth`, then publish._ `/auth/callback` is a `GET` and is not counted by these rules.

## Verification in this PR

`tests/server/bot-protection.test.ts`: bot verdict gives 403 and starts no generation; human verdict
starts it; a BotID error and a BotID timeout both fail open and log; the check is skipped off Vercel;
and every route in the shared list really calls `assertNotBot()` first in its `POST`.
