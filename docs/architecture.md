# Embel architecture

_Rewritten November 10, 2026, after the old worker system was removed (PR #231)._

This is a short map. For depth, read [generation-engine.md](generation-engine.md) (how AI runs) and
[architecture-review.md](architecture-review.md) (why it is built this way, and the plan).

## The pieces

| Piece | What it is | Where |
| --- | --- | --- |
| Web app | Next.js 16.4.4 (webpack build) on Vercel, team `embel`, project `embel`. Screens, authenticated APIs, private download checks | `src/app`, `src/components`, `src/features`, `src/server` |
| Database and files | Supabase Pro: Postgres 17, Auth, private Storage bucket `fluid-assets`. Accounts, projects, credits, run records, results | `supabase` |
| Generation engine | Vercel Workflow 5.2.3 runs inside the web app. One workflow per AI step | `src/workflows`, `src/server/engine` |
| AI provider | OpenAI: text through the Responses API (background mode), logos through the Images API (`gpt-image-2.6-sunburst`, low quality, low complexity, transparent background) | `src/server/engine` |

There is nothing else to deploy: no worker programs, no daemon, no queue project, and no laptop
runtimes.

## How one AI request flows

1. The person clicks once. The browser calls an authenticated API route. Routes that start paid work
   are protected by BotID.
2. The route calls the SQL function `start_generation` with the person's own login. It checks
   ownership, credits, daily limits, that the kind is enabled and that nothing else is running for
   that project and kind. It also refuses everything while `engine_settings.paused` is set.
3. The route starts the workflow. The workflow calls OpenAI, retries temporary failures a few times,
   and can be cancelled between steps.
4. Results are saved by the `embel_engine` database login, which can only run the engine's own
   functions. A failed or cancelled run refunds its credits.
5. The screen polls the run's status every few seconds and shows the saved result.

A request whose outcome is uncertain is looked up again by its original identity. It is never sent
a second time blindly.

## The AI steps

| Journey step | Engine kinds |
| --- | --- |
| Strategy | `strategy.*` |
| Naming | `naming.generate` |
| Logos | `logo.concepts`, `logo.refine`, `logo.style_note` |
| Creative directions | `identity.directions` |

## Controls

- **Stop one step:** set `enabled = false` for its kind in `fluid_private.generation_kinds`.
- **Stop everything:** set `fluid_private.engine_settings.paused = true`. See
  [emergency-stop.md](emergency-stop.md).
- **Abuse protection:** BotID, a Turnstile CAPTCHA (ready, off until a Cloudflare key is set;
  [auth-captcha.md](auth-captcha.md)) and WAF rate limits
  ([security-rate-limits.md](security-rate-limits.md)).
- **Database:** every user-facing table is limited to its owner by row-level security. New database
  functions are private by default.

## Releases

CI runs on every pull request, including the full-journey browser test with a stand-in AI
(`npm run test:journey`). Production deploys are manual from a clean clone with
`vercel deploy --prod --scope embel`; skew protection is on. The release lead applies database
changes. See [retire-old-worker-release.md](retire-old-worker-release.md) for the latest example.

## Older records

Everything written before the engine (workers, slots, API-text, the ChatGPT bridge, old release
runbooks, per-screen design notes) is in [archive](archive/). Treat it as history.
