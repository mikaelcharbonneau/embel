# Embel architecture review

_November 9, 2026 · Claude (Opus 5.5) · Read-only review. No code, data or settings were changed._

## How this review was done

- **Code:** the whole repository on branch `logo/image-model-2-6` (`main` plus 9 unmerged
  commits): about 62,000 lines of TypeScript, about 39,000 lines of SQL (migrations plus
  hand-applied scripts), about 840 test files and 153 documents.
- **Production, read-only:** the Supabase database catalog and 30-day job statistics (totals only,
  no customer content), Supabase's security advisor, Vercel projects and deployments, and the live
  site's response headers.
- **Current official documentation** for every tool recommended here (Appendix B).

## 1. Summary for a non-technical reader

**Bottom line.** The screens, sign-in and file privacy are in decent shape, and much of the work can
be kept. The background machinery that runs the AI work is far more complicated than an app this size
needs, and that complexity is the main reason generations are slow and unreliable. Embel isn't ready
for paying customers or 10,000 users yet.

I don't recommend starting over:

- **Keep** Next.js, Supabase, OpenAI and the screens.
- **Replace** the background machinery one journey step at a time.
- **Keep the app working** after every step.

**What's already good**

- Sign-up, sign-in and sessions follow good practice: email confirmation, 12-character passwords, and
  protection against cross-site requests.
- Every table users can reach checks that the data belongs to the signed-in user.
- Uploaded and generated files are private, stored per account, and downloaded through links that
  expire after 60 seconds.
- No secret keys are in the code or its history.
- About 840 automated tests run on every change.
- Brand guidelines, design-system files and downloads are produced by regular code, not AI, so they
  are fast and predictable.

**What's wrong, most serious first**

1. **A hard speed limit.** In production, the worker handles one research job and one naming job at a
   time *for all users combined*. It handles only 2 logo images at a time: 6 slots exist, but 4 were
   switched off on November 9 because the free-plan database ran out of memory. In the last 30 days:
   - logo concepts took 14 minutes on average, and 28% failed or never finished;
   - naming failed 57% of the time (all before the November 9 naming rebuild, which hasn't been used
     in production yet);
   - some research jobs have been stuck for 2–3 weeks waiting for someone to repair them by hand.
2. **Too many moving parts.** There are 5 separately deployed programs and about 10 job systems doing
   similar work. Competitor research can run 6 different ways. The app has over 100 configuration
   switches, 15 special database logins and 672 database functions. Every change has to thread through
   all of it, which explains why changes are slow and buggy.
3. **Nothing limits AI spending.** Anyone with a confirmed email can generate unlimited logos at the
   most expensive quality setting. There are no plans, credits or rate limits, and the logo workers
   ignore the "stop paid calls" switch.
4. **No payments.** There's no Stripe or other payment code, and no plans or credits.
5. **Your data is at risk.**
   - Production, preview sites, tests and laptop development all share one database.
   - That database is on Supabase's free plan, which has no automatic backups and pauses after a week
     without activity.
   - The database change history in the repository no longer matches production, so production
     couldn't be rebuilt from the code.
6. **Failures are invisible.** Unexpected server errors aren't recorded anywhere. There's no error
   tracking and no alerting.
7. **Launch gaps.** There's no way to delete an account. An OpenAI key sits in a plain-text file in the
   project folder.

**What I recommend.** Six phases, roughly 9–12 weeks for one developer working with an AI coding agent.
The part you need before launch takes about 8–9 weeks.

1. Protect data, money and visibility: backups, error tracking, a documented emergency stop, an
   OpenAI budget, and a rotated key.
2. Separate test and production databases, and make the database rebuildable from the code.
3. Add spending limits and anti-abuse checks.
4. Add payments with Stripe.
5. Move each AI step onto one standard background-job service, then delete the old machinery.
6. Add account deletion, clean up data, and tidy the code and docs.

---

## 2. Architecture: current vs recommended

### 2.1 Current architecture (what the code and production actually do)

```
Browser
  │  checks job status every 1–3 s per open tab
  ▼
Next.js 16 web app on Vercel (embel.xyz) · 135 API routes · no AI calls inside web requests
  │  calls ~140 database functions with the user's login; some modes also open
  │  direct Postgres connections when a server instance starts
  ▼
Supabase Postgres · FREE plan · one project ("fluid-platform-dev") shared by production,
previews, tests and laptops · 174 tables · 672 functions · 214 triggers · 15 custom logins
  │  jobs are rows; workers claim them
  ├─► Shared worker: Vercel Daemon container (public beta), pinned to Node 22.22.2
  │     fixed slots: research 1 · naming 1 · logo 6 registered / 2 switched on
  ├─► API-text worker: separate Vercel project (Functions + Vercel Queue + every-minute cron),
  │     which the README calls historical
  ├─► Laptop-only runtimes (local worker, ChatGPT-plan bridge) connected to the production database
  └─► Dormant: legacy logo-worker project (0 instances), account-enrollment worker (never deployed),
      worker/index.ts (no production host)
  ▼
OpenAI: gpt-6.1-sol (text, plus web search for competitors) · gpt-image-2.6-sunburst at "max"
quality (logos, on this branch) · results stored in one private Supabase Storage bucket
```

Key facts:

- **AI work runs outside web requests**, which is good. But it runs through fixed slots:
  - the code sets `PRODUCTION_SLOTS_PER_LANE={strategy:1,naming:1,logo:6}` in
    `worker/shared-pool/configuration.ts`;
  - the production slot table has only 2 of the 6 logo slots switched on.
- **Most business rules live in SQL.** That's about 39,000 lines including hand-applied scripts. They
  are guarded by TypeScript "proofs" that pin SHA-256 hashes of:
  - SQL function bodies;
  - a database certificate;
  - individual `node_modules` files.
- **Releases are manual.**
  - The web app is deployed from a clean clone.
  - SQL changes are "rehearsed, then applied" by hand from `supabase/candidates/` and
    `supabase/activation/`.
- **Several generations of the same feature coexist:**
  - three naming schemas;
  - six ways to run strategy and research;
  - three logo lanes with six storage-authorization variants.

### 2.2 Recommended architecture

```
Browser
  │  live status through Supabase Realtime (or one status endpoint checked every 3–5 s)
  ▼
Next.js web app on Vercel (same screens, same codebase)
  │  1. checks login and plan credits in ONE database admission function (cannot be bypassed)
  │  2. starts a workflow run and returns its id
  ▼
Vercel Workflow (inside the same app; generally available since April 2026)
  │  each AI call is a durable step: automatic retries, resumes after crashes,
  │  runs in parallel, can be cancelled; results saved after every step
  ▼
OpenAI (same models) ──► Supabase Pro: Postgres with daily backups · private Storage · Auth
                          separate staging project · database changes applied by CI
Stripe Checkout + Billing + Customer Portal ──webhooks──► subscriptions + credit ledger
Sentry (errors, alerts) · Vercel WAF rate limit + BotID on generation routes ·
CAPTCHA on sign-up and sign-in (Supabase Auth) · OpenAI project budget alerts
```

### 2.3 Why this design

| Concern | Today | Recommended | What it fixes |
|---|---|---|---|
| Speed under load | Fixed slots shared by all users (1 research, 1 naming, 2 active logo) | Each run gets its own function invocation, limited only by OpenAI rate limits and per-user caps | The main cause of slowness |
| Failures | Uncertain outcomes park jobs in `needs_reconciliation` until someone runs SQL; logo calls are never retried | Bounded automatic retries per step; OpenAI background mode lets a step look up whether a request finished instead of guessing | Jobs finish or fail clearly within minutes |
| Programs to deploy | 5, including a beta container pinned to one Node release and to file hashes | 1 (the web app) | Fewer things to break, deploy and pay for |
| Cost control | No per-user limit; logo lanes ignore the kill switch | Credits checked in the database before every paid step; global daily cap; OpenAI budget alerts | Predictable spend; abuse contained |
| Data safety | One free-plan database for everything | Pro plan with backups; separate staging | Recoverable after mistakes |
| Visibility | Unexpected errors are thrown away | Sentry, plus alerts on error rate, job failure rate and spend | You hear about problems before users do |

**Why Vercel Workflow rather than Inngest or Trigger.dev.**

- It runs inside the existing Next.js app on Vercel, so there's no new vendor, deploy target or worker
  to look after.
- It has been generally available since April 16, 2026. Vercel reports over 100 million runs across
  more than 1,500 customers.
- The trade-off: built-in per-user concurrency controls are still on its roadmap. Per-user limits will
  therefore live in our admission function, which we need anyway for credits.
- If you'd rather have a longer track record and built-in per-user throttling, Inngest is the
  alternative, at the cost of one more vendor.

**Why this isn't a rewrite.** These parts carry over:

- the screens (`src/components`, `src/features`);
- sign-in (`src/server/auth`);
- private-file handling;
- the project and asset data model;
- the exports;
- most tests.

Only the background job layer is replaced: `worker/`, `services/`, about 80 job, dispatch and receipt
tables, and the per-worker database logins. It's replaced one journey step at a time behind a switch,
so the old path stays available until the new one proves itself.


### 2.4 Database provider: stay on Supabase (checked November 9, 2026)

Before paying for Supabase Pro, I compared the main alternatives. The deciding factor isn't price,
since every option costs roughly $20–60 a month at Embel's size. It's how much of Embel is built on
Supabase:

- the database code checks Supabase's signed-in user about 370 times (`auth.uid()`) and links to its
  user table about 100 times;
- 56 rules govern Supabase file storage;
- the app makes 54 Supabase function calls and 10 Supabase sign-in calls.

| Option | What it is | Monthly cost at launch size | Moving Embel there | Verdict |
|---|---|---|---|---|
| **Supabase Pro** (current provider) | Postgres + sign-in + file storage + realtime + daily backups (7 days) | $25 with the included Micro size (1 GB memory); $30 with Small (2 GB) | None | **Recommended** |
| Neon (Launch plan) | Serverless Postgres, now with managed sign-in (Better Auth), object storage and realtime (beta) | About $20–40: always-on compute at $0.106 per compute-unit hour, plus storage | XL: rewrite every sign-in check and storage rule, move user accounts and files, replace the Supabase calls | Good product. Its edge is cheap per-preview database copies, but that doesn't justify weeks of migration. |
| Firebase | Firestore document database (or Data Connect on Cloud SQL Postgres), Firebase Auth, Cloud Storage | Usage-based; Cloud SQL from about $9.37 a month after the trial | Effectively a backend rewrite: 174 relational tables don't map to documents, and Data Connect needs a new query layer | Not a fit |
| MongoDB Atlas | Document database | Dedicated clusters from about $57 a month; Flex up to about $30 | Full data-layer rewrite, plus separate sign-in and file storage | Not a fit |
| Prisma Postgres, Amazon Aurora, Nile (Vercel Marketplace) | Postgres only | Varies | Same rewrite as Neon, plus two more vendors for sign-in and files | No advantage |
| Convex (Vercel Marketplace) | Reactive TypeScript database | Varies | Full rewrite | Not a fit |

None of the alternatives fixes the review's main problems: fixed worker slots, no spending limits, no
payments, and database drift. Those live in Embel's own code. Moving later is also easier: once Phase
5 moves business rules out of SQL, the app is much less tied to any one provider. If a revisit ever
makes sense, the trigger would be Supabase's limits or cost becoming a real problem.

Supabase details that shape the plan:

- Upgrading leaves the database on the free "Nano" size, billed at the Micro price, until you resize
  it. Resizing takes under 2 minutes of downtime.
- Daily backups don't include stored files, or the passwords of the 15 custom database logins.
- A paused project costs nothing, so the inactive `source-atlas` project won't be billed while
  paused.

---

## 3. Issues by priority

**Effort scale** (one developer working with an AI coding agent, tests included): **S** under 1 day ·
**M** 2–5 days · **L** 1–2 weeks · **XL** 3–6 weeks.

### 3.1 Must fix before launch

| # | Issue | Effort | If we leave it | Evidence |
|---|---|---|---|---|
| M1 | **Generation speed is capped for all users combined.** Only 1 research job, 1 naming job and 2 logo images run at a time. | Stopgap S, after the Pro upgrade (M5): switch the 4 idle logo slots back on. Real fix XL (Phase 4). | At launch, a few dozen people starting at once wait tens of minutes, and many leave. | `worker/shared-pool/configuration.ts` (`PRODUCTION_SLOTS_PER_LANE`); production `fluid_private.shared_worker_slots`: logo has 6 registered, 2 switched on. The November 9 release turned 4 off because eight slots overloaded the free-plan database (`docs/release-20261109-naming-rebuild.md`). |
| M2 | **Generations are unreliable, and some jobs need manual repair.** | XL (Phase 4) | The core journey fails for about 1 in 4 logo attempts and more than half of naming runs. | Last 30 days: 92 logo-concept jobs, 28% failed or unresolved, 14 minutes on average to succeed; 44 naming jobs, 57% failed (all before the November 9 naming rebuild); research jobs stuck in `needs_reconciliation` for 14–20 days; 3 ended as `operator_abandoned_billing_unresolved`. Logo lanes never retry provider errors (`worker/shared-lanes/logo-style-notes-api.ts:30`). On November 9, one unexpected character in a single AI reply made recovery repeat on every restart until the worker stopped, taking research and logos down with naming (`docs/release-20261109-naming-rebuild.md`). |
| M3 | **No per-user spending limit, rate limit or bot protection.** | M (Phase 2) | A bot, or one user clicking Generate in a loop, runs up an unlimited OpenAI bill. | See the note below the table. |
| M4 | **No payments, plans or credits.** | L (Phase 3) | You can't charge anyone or limit free usage. | No payment SDK in `package.json`; no plan or credit tables. The existing "subscription" fields mean a ChatGPT plan, not an Embel plan. |
| M5 | **The production database is unprotected and shared with everything.** | S for Pro plus backups; M to separate staging | Permanent data loss with no backup. A preview, test or laptop run can damage customer data. A quiet week pauses the database. | Supabase organization plan is free: no daily backups, pauses after 7 inactive days. `vercel.json` hard-codes one database for every environment, and `scripts/preview-preflight.mjs` enforces it. `scripts/local-environment.mjs` points laptop workers at the production host. Live tests target the same project. 33 of 60 connections were in use after the last release. On November 9 the 0.5 GB database was overloaded by eight worker slots and sign-in timed out. Staying on Free was your choice then; this review recommends revisiting it. |
| M6 | **Production can't be rebuilt from the repository.** | M (Phase 1) | No reliable recovery after an incident. A staging copy can't be created. The next database change may fail or be silently skipped. | See the note below the table. |
| M7 | **No error tracking or alerting.** | S–M (Phase 0) | Paying users hit failures you never see. | No Sentry or similar. `src/server/http/errors.ts:49-52` turns unexpected errors into a 500 without logging them; 84 routes use it. `src/app/error.tsx` and `global-error.tsx` discard errors. Vercel shows zero runtime errors in 7 days because nothing is logged. |
| M8 | **An OpenAI key sits in a plain-text file in the project folder.** | S (15 minutes) | Anyone, or any tool, that reads the folder can spend on your OpenAI account. | `design-lab/openai-key.txt` is readable by every local user. Only `.git/info/exclude` keeps it out of git; it was never committed. |
| M9 | **No account deletion, and deleting a user who has projects fails.** | M (Phase 5) | You can't honor deletion requests, which GDPR and similar laws require, or clean up abusive accounts. | No route exists. `projects.owner_id` references `auth.users` with no `on delete` rule (`supabase/migrations/20261002003028_foundation.sql:9`). Triggers that keep history unchangeable block deletes on 50+ tables. Nothing ever purges data or files. |
| M10 | **No "forgot password" flow.** | M | Users who forget their password are locked out, and support has no self-service fix. | `src/app/api/auth/` has only sign-in, sign-up, sign-out and resend-confirmation; nothing calls Supabase's password reset; `src/server/auth/failure.ts` turns every other sign-in error into `invalid_credentials`. |
| M11 | **Account emails may not reach real users.** | S (set up an email service) | Sign-up confirmations and reset links silently fail for anyone outside your Supabase team. | Supabase's built-in sender only delivers to team members, at most 2 emails an hour, and isn't meant for production ([Supabase SMTP docs](https://supabase.com/docs/guides/auth/auth-smtp)). Whether production has its own email service (custom SMTP) set up is unverified; the available tools can't read that setting. |

**M3 evidence.**

- A trigger on `auth.users` (`embel_shared_account_auth_changed`, live in production) automatically
  puts every confirmed user into the uncapped pool.
- Logo jobs reserve a cost of 0.
- `paidCallsApproved:true` is hard-coded in `worker/shared-lanes/logo.ts:117` and in
  `logo-advanced.ts:44,78`.
- The app has no rate limiting and no CAPTCHA.
- Users can also call the database functions directly through Supabase's API. Limits must therefore
  be enforced inside the database admission function, not only in the web app.

**M6 evidence.**

- Production has 127 applied database changes; the repository has 91 migration files.
- 38 of the applied changes exist only as hand-run scripts in `supabase/candidates/` and
  `supabase/activation/`, and the app calls functions defined only there.
- Version `20261109100000` means different changes in the repository and in production.
- Two files with a `local` prefix are skipped by the Supabase CLI, so a fresh `supabase db push` fails
  at `20261015232500`.
- There is no `supabase/config.toml`.

### 3.2 Should fix

| # | Issue | Effort | If we leave it | Evidence |
|---|---|---|---|---|
| S1 | **Too many moving parts and duplicate implementations.** | L, spread over Phases 4–6 | Every change stays slow and risky. Agents and developers misread the system, which causes bugs. | See the note below the table. |
| S2 | **ChatGPT-plan mode and laptop runtimes are wired into production.** | M | Jobs silently wait for a laptop. Offering it to customers would break OpenAI's terms. | `src/server/local-chatgpt/`, `worker/local-chatgpt.ts` and `billing_mode='chatgpt_subscription'`; the hosted app can queue jobs that only a laptop runs. OpenAI's Sign in with ChatGPT terms (effective Nov 4, 2026) allow plan usage only for that same user, from a runtime only they control, at no charge to them. |
| S3 | **Production identities and hash pins are hard-coded.** | M | Staging needs code edits, and routine dependency updates break the "qualification" checks. | The production project ID appears in 129 files. Vercel project IDs are in `src/server/api-text/config.ts` and `src/server/logo-creation/operation-routing.ts`. SQL body hashes are in `worker/shared-pool/proofs`, file hashes in `worker/logo-production-runtime-pins.json`. The sign-in issuer URL is hard-coded inside SQL functions. |
| S4 | **The database API surface is large.** | M | Any future function shipped without an owner check is exposed to every user. | Supabase advisor: 142 privileged functions callable by signed-in users (my spot checks show they verify the user) and 4 callable without signing in (they return nothing useful). Leaked-password protection is off. `public.set_project_deleted` is still granted although unused. Supabase recommends keeping internal functions out of the schemas its API exposes. |
| S5 | **Releases are manual, and the full journey isn't tested before deploys.** | M | A broken release reaches users, and the database and code drift apart again. | No deploy or migration step in `.github/workflows/ci.yml`. The 44 Playwright browser specs don't run in CI. Releases are done "from a clean clone" (`docs/release-20261109-naming-rebuild.md`). Production is 3 merges behind `main`. |
| S6 | **Each open tab checks status every 1–3 seconds.** | S–M | Idle tabs add steady load and cost at 10,000 users. | `use-logo-creation.ts` (3 s), `use-strategy-jobs.ts` (1.5 s), naming (1 s) |
| S7 | **Serverless functions open direct Postgres connections.** | S–M | Connections run out under load. | `src/instrumentation.ts` opens pools per server instance, without `attachDatabasePool`. Supabase advises its transaction pooler for serverless. |
| S8 | **You have no spend or failure dashboard.** | M | You can't see cost per user or failure trends. | `/api/usage` shows only the last 20 research and naming jobs; logo and identity spend never appear (`src/server/data/recorded-usage.ts`). |
| S9 | **Docs and agent instructions are out of date.** | M | AI agents follow stale docs and bring back designs that were removed. | 153 docs, 52 of them marked historical; 22% of file references are broken. The README describes naming-only projects, a cost estimate beside Generate and a removed naming runtime. `docs/architecture.md` describes machinery that no longer exists. |
| S10 | **Dead code.** | M | Confusion and wasted maintenance. | See the note below the table. |
| S11 | **No content security policy, and no file-type allowlist on the storage bucket.** | S | Weaker defense against injected scripts and unexpected uploads. | The headers in `next.config.ts` have no CSP (Vercel already adds HSTS). Bucket `fluid-assets` has a 50 MiB size cap but no file-type allowlist (`foundation.sql:516-517`); app-level checks do exist. |
| S12 | **Malformed AI output isn't retried, and some results are dropped silently.** | S–M (in Phase 4) | Users see empty or partial steps. | A malformed strategy result goes to `needs_reconciliation`. A malformed naming round saves nothing. Competitors without verified sources are dropped silently (`src/server/ai/strategy-response.ts`). |

**S1 evidence.**

- 5 separately deployed programs.
- Strategy and research can run 6 different ways.
- 3 logo lanes with 6 storage-authorization variants.
- About 80 job, dispatch and receipt tables.
- 3 naming schemas.
- Over 100 `FLUID_*` and `EMBEL_*` switches.
- 15 custom database logins.
- A per-owner database-login design capped at 100 owners
  (`src/server/runtime/account-http-configuration.ts`).

**S10 evidence.**

- 21 modules nothing reaches, such as `src/features/{domain,handles,trademark}-workspace/index.ts`, and
  `src/components/journey/*`, which only tests import.
- About 4,700 lines of worker code that no production path reaches.
- A dormant logo-worker Vercel project and a leftover `services/naming-worker/dist`.
- The logo quote route still returns `estimatedCostMicrousd`.
- The standalone names assistant only works on a laptop.

### 3.3 Nice to have

| # | Idea | Effort | Benefit |
|---|---|---|---|
| N1 | Run a code formatter | S | 2,795 lines are longer than 200 characters (the longest is 2,540), which makes reviews hard. |
| N2 | Keep prompts in versioned files with a small evaluation set | M | Safer model and prompt changes |
| N3 | Route OpenAI calls through Vercel AI Gateway | S–M | Spend tracking, budgets, and a fallback when a provider has an outage |
| N4 | Cache competitor research for identical briefs | S | Lower cost and faster restarts |
| N5 | Use Vercel Rolling Releases | S | Each release reaches users gradually, so a bad one affects fewer people |
| N6 | Use OpenAI Batch or Flex pricing for steps that aren't urgent | S | Up to half the cost on background work |

### 3.4 Scalability at 10,000 users

Once the fixed slots are gone, 10,000 users a year is modest for Vercel and Supabase Pro. The limits
that will matter are:

- OpenAI's per-minute rate limits for `gpt-image-2.6-sunburst` and `gpt-6.1-sol`. Check them and ask
  for increases before launch (step 4.1).
- Image cost at "max" quality, which credit prices must cover.
- Database connections. Use the pooler (S7).

Storage growth is small: about 20 MB per user who reaches the logo step. It's still worth setting a
retention policy (question 9).

---

## 4. Step-by-step plan (the app keeps working between steps)

**How every step runs**

- It is built and tested on staging first.
- Production changes need your go-ahead.
- Every step has a way back: a backup, a feature switch, or redeploying the previous version.
- Old and new generation paths run side by side behind a per-step switch until the new one meets its
  targets.

### Phase 0: Protect data, money and visibility (week 1)

- **0.1** Save this review as `docs/architecture-review.md`, and mark old plans and handoffs as
  archived in their first line.
- **0.2** Rotate the OpenAI key in `design-lab/openai-key.txt` and delete the file. Set a monthly
  budget with alerts on the OpenAI project. *You do the rotation in the OpenAI dashboard; I guide you.*
- **0.3** Upgrade Supabase to Pro, resize the database from Nano to Micro or Small, and take a
  manual backup. Turn on leaked-password protection. It doesn't lock anyone out: a sign-in with a
  breached password still succeeds with a warning, and only new or changed passwords are checked.
- **0.4** Add Sentry (`@sentry/nextjs`) to the web app and the shared worker. Make `errorResponse` and
  both error pages report errors. Alert on new errors.
- **0.5** Emergency stop: document the one-command stop that already exists for the shared worker
  (`docs/emergency-stop.md`). A code switch in the old worker would still need a restart and a full
  worker release, so the real "stop paid calls" switch is built into the new engine in step 4.1.
- **0.6** Speed stopgap: after the Pro upgrade (0.3), switch the 4 idle logo slots back on, using the
  credential-rotation window described in `docs/release-20261109-naming-rebuild.md`. They were turned
  off on November 9 because eight slots overloaded the free-plan database.

**Done when:**

- a backup exists;
- a test error shows up in Sentry;
- the emergency stop is documented and the OpenAI budget is set;
- logo jobs run 6 at a time.

### Phase 1: Separate environments and make the database rebuildable (weeks 1–2)

- **1.1** Create a staging Supabase project.
  - Move the Supabase settings out of `vercel.json` into per-environment Vercel variables.
  - Point previews at staging, and update `scripts/preview-preflight.mjs` to match.
- **1.2** Create a baseline from production.
  - Export the production schema into one baseline migration, and mark it as applied in production
    (`supabase migration repair`).
  - Move `supabase/candidates`, `supabase/activation`, `supabase/operator` and the old migrations to
    `supabase/archive/`.
  - Add a standard `supabase/config.toml`.
- **1.3** Make CI handle the database. Reuse the test database harness in
  `tests/database/local-supabase.ts` and the pinned Postgres 17 image.
  - Every pull request builds a fresh database from the migrations.
  - Merges apply the migrations to staging.
  - A manual release workflow applies them to production.
- **1.4** Laptop development uses only the local stack (`npm run dev:up`). Turn off the laptop worker's
  login on production.

**Done when:**

- a database built from the repository matches production (the schema comparison shows no
  differences);
- previews no longer touch production.

### Phase 2: Spending and abuse protection (week 3)

- **2.1** Add a credit ledger and one database admission function that every paid operation must pass.
  - It reserves credits when a run starts, settles them on success and releases them on failure.
  - It builds on the existing reservation pattern in `usage_accounts`/`usage_reservations`
    (`foundation.sql`).
  - It includes a free allowance, a per-user daily cap and a global daily cap.
- **2.2** Add CAPTCHA (Cloudflare Turnstile) to sign-up and sign-in through Supabase Auth. Add a Vercel
  WAF rate-limit rule and BotID on the generation routes.
- **2.3** Harden the database API.
  - Stop anonymous visitors from running the 4 exposed functions.
  - Make new functions private by default.
  - Remove unused grants such as `set_project_deleted`.

**Done when:** a script can't go over the caps, even by calling Supabase directly.

### Phase 3: Payments (weeks 3–5, can overlap Phase 4)

- **3.1** Add Stripe:
  - Stripe Checkout for subscriptions, plus the Customer Portal;
  - a webhook route that verifies Stripe's signature, records event IDs so repeats are ignored, and
    re-reads the subscription from Stripe;
  - a `subscriptions` table and monthly credit grants into the ledger.
- **3.2** Add a plan page and an "out of credits" upgrade prompt, with no cost estimates.

**Done when**, in Stripe test mode:

- a purchase makes credits appear and lets generation run;
- cancelling ends access at the end of the period;
- replaying a webhook changes nothing.

### Phase 4: Move AI generation to Vercel Workflow, one step at a time (weeks 4–9)

- **4.1** Lay the foundation.
  - Add Vercel Workflow.
  - Keep a run record. Reuse `public.jobs`/`public.job_steps` if their history triggers accept
    workflow writes; otherwise add a slim `generation_runs` table.
  - Add one status endpoint plus Supabase Realtime, and Sentry.
  - Add a per-step switch between the old and new paths, and one "stop paid calls" switch that the
    admission function checks before every paid step.
  - Confirm OpenAI's rate limits for both models and request increases.
- **4.2** Move research and strategy: competitors with web search, audience, positioning, personality
  and slogan.
  - Use OpenAI background mode with webhooks or polling, bounded retries, and saved partial results.
  - Reuse the prompts and schemas in `src/server/ai/strategy-response.ts`.
  - Then retire the API-text worker project, its queue topic and cron, and the strategy lane.
- **4.3** Move naming the same way, then retire the naming lane and the older naming schemas.
- **4.4** Move logo concepts (6 in parallel), refinements and style notes.
  - Reuse `src/server/logo-creation/openai-logo-provider.ts`, `openai-image-transport.ts` and
    `openai-image-pricing.ts`.
  - Then retire the logo lanes.
- **4.5** Move creative directions and exports.
  - The 3 direction boards reuse `worker/identity/producer.ts`.
  - The exports keep `worker/handlers/logo-exports.ts`,
    `src/features/identity-deliverables/server/guidelines.ts` and
    `src/features/brand-assets/client/build-pack.ts`.
- **4.6** Turn off the shared-worker daemon. Delete:
  - `services/` and the unreachable `worker/` code;
  - the per-worker database logins;
  - ChatGPT-plan mode and the laptop runtimes.

**Done when (for each step):**

- on staging, at least 95% of 30 test runs succeed;
- research finishes in under 2 minutes and six logo concepts in under 3 minutes (proposed targets);
- the production failure rate is watched for 48 hours before the old path is deleted.

### Phase 5: Data lifecycle and compliance (weeks 8–10)

- **5.1** Add account deletion, data export and a "forgot password" flow (M10; can be done earlier).
  - Fix the foreign keys and history triggers so deletion works.
  - Add a purge job for deleted accounts, deleted projects and orphaned files.
- **5.2** Drop the tables, functions and triggers retired in Phase 4. The target is roughly 30 core
  tables instead of 174.
- **5.3** Privacy policy and terms. This is outside the code and needs your input or a lawyer's.

### Phase 6: Code and docs health (weeks 9–12, can continue after launch)

- **6.1** Delete dead modules and stubs, cut the switches down to a short documented list, use one Node
  version (24), and run a formatter.
- **6.2** Rewrite `README.md` and `AGENTS.md` to match reality, and archive historical docs.
- **6.3** Run the full-journey browser test in CI against staging with a stand-in AI provider. Add a
  nightly test with real AI and a small budget.

**Launch gate:** Phases 0–3, steps 4.1–4.5 and step 5.1. Steps 5.2 and Phase 6 can finish after launch.

### Progress

- **November 9, 2026, step 0.1:** this review was saved, and 66 dated docs were marked archived.
- **November 9, 2026, step 0.3 (part):** the organization moved to Supabase Pro. The project was resized
  from Nano (0.5 GB) to Micro (1 GB), which the Pro plan's included credit covers, so the total is $25
  a month. Verified from the database:
  - it restarted at 19:05 UTC;
  - its memory settings doubled (cache estimate from 384 MB to 768 MB);
  - the connection limit stayed at 60, as expected for Micro;
  - every worker login reconnected.
- **Still open in 0.3:**
  - confirm the first daily backup under Database → Backups;
  - take a manual backup;
  - turn on leaked-password protection after M10.
- **M10, live since November 9, 2026 (release 1 below):**
  - a "Forgot password?" link, plus "Reset your password" and "Choose a new password" screens;
  - the reset email reuses the existing `/auth/callback`, so Supabase's allowed-address list needs no
    change;
  - a new password is accepted only within one hour of opening a reset link;
  - saving it signs the account out on its other devices (checked against the local Supabase copy);
  - tested against the local Supabase copy and its test inbox: the email link works, the old password
    stops working, an ordinary signed-in session can't change the password, and all 5,044 API, server
    and client tests pass.
- **M7, partly addressed while Sentry waits (live since November 9, 2026):**
  - unexpected server errors, and API failures caused on the server side, now write one line to
    Vercel's runtime logs: the error type, a short code and the code locations;
  - errors Next.js catches while showing pages are logged by route pattern;
  - messages, real paths, headers and request bodies are never logged;
  - Sentry is still needed for alerts and for errors in the browser.
- **Step 0.4 (Sentry):** postponed by the owner on November 9, 2026; still needed before launch (M7).
- **Step 0.6, decided against:** the live worker's configuration carries only two logo slots. Switching on
  the other four would mean regenerating every worker password and rebuilding the pinned worker program.
  That effort goes into moving logos to the engine instead (step 4.4).
- **Observed:** the API-text worker, which the README calls historical, still holds a database
  connection and runs its every-minute repair job. It will be retired in step 4.2.
- **November 9, 2026, release 1 (live):** production now runs `main` at 7ca1193
  (deployment `dpl_GuVVJ7eByWqKTqJJxbW6Fmjz7rLC`). It includes #200, #204, #206, #213, #214 and #215:
  - the password reset (M10) and server error logging (M7, partly);
  - the generation engine's foundation: credits, runs and the `embel_engine` database login, which
    connects through Supabase's transaction pooler with a pinned certificate;
  - the standalone tools, Ideas and the vector logo editor are removed.

  Database changes `20261109110000` (repo file `20261109100000_retire_logo_only_creation`) and
  `20261110090000_generation_engine` were applied first and checked against the local copy.

  Checked after the deploy:
  - `/api/health` reports the new release;
  - the main pages answer, and the removed pages answer 404;
  - the new engine routes refuse anyone who isn't signed in;
  - Vercel shows no runtime errors.

  Rollback, if ever needed:
  1. redeploy `dpl_F79SgeeDVVQMvbvJtrYSUMLDJcS5` (commit 6bb2d36);
  2. drop the engine objects with the saved rollback script;
  3. re-grant the logo-only functions.
- **Step 4.2, Strategy (#216, merged):** the six Strategy operations run on the engine with OpenAI
  background mode, behind one switch. The switch turns on only when all six kinds are enabled.
  - Local real-AI check: 6 of 6 runs succeeded and one deliberate cancel was refunded. Research took
    about 26 s, the other steps 16–23 s.
  - It needs an OpenAI key in the web app's production settings before it can be switched on.
- **Engine safety net (#217):** a run whose workflow stops reporting ends after its kind's time limit
  (30 minutes by default) and its credits come back. Cancelling a stuck run ends it at once.

- **November 9, 2026, release 2 (live):** production runs `main` at 1a9035d
  (deployment `dpl_6adobHBkefLbA5sBu6eA4Sre3GPd`, a redeploy so it includes the web app's new
  `OPENAI_API_KEY`).
  - Database changes `20261110120000_strategy_engine_kinds` and `20261110130000_engine_running_time_limit`
    were applied first. The three changed functions match the repository exactly, and their access
    rights were checked.
  - The six `strategy.*` kinds were then enabled, so Strategy now runs on the engine.
  - To roll back Strategy, run
    `update fluid_private.generation_kinds set enabled = false where kind like 'strategy.%';`.
    To stop every engine run at once, set `fluid_private.engine_settings.paused = true`.
  - Watch for 48 hours:
    - success rate and error codes in `generation_runs`;
    - research finishing in under 2 minutes;
    - no runs ending as `run_timed_out`;
    - daily `cost_microusd` against the $50 cap;
    - Vercel Workflow failures.
  - The old Strategy slot, the API-text worker, its queue and its cron stay until a cleanup after that.

#### November 10, 2026: every AI step on the engine, plus fixes and safety

**Engine steps (all live)**

- **Strategy on the engine (#216):** live and verified. Four live runs succeeded in 20–29 s, against an
  86 s average before.
- **Safety net (#217):** a run that stops reporting ends after its kind's time limit, and its credits come
  back.
- **Naming on the engine (#220):** live. 100 names in 38 s, against 57% failures and about 20 minutes
  before. Each round sends three requests at once, of about 40 names each, and saves each reply's names as
  soon as it arrives. One slow or broken request no longer loses the others' names.
- **Logos on the engine (#222):** live. It replaced the four unreleased logo PRs #209–#212.
- **Image-checker fix (#223):** the first live logo rounds drew all six images, then rejected them, because
  a file was missing from the helper's packaged files and the image check crashed on Vercel. The bug dated
  from October 18. A new test guards the list, so a missing file now fails CI instead of production.
- **Low-quality logos (#227):** logos now use quality low and complexity low, at about $0.025 per image and
  about $0.15 per round of 6, against $1.27 at max. The owner chose this after a side-by-side test of
  medium ($0.27 per round), high ($0.32) and max ($1.27). These are internal measurements, not shown in
  the app.
- **Creative directions on the engine (#228):** live. 3 of 3 boards in 182 s, about $0.29 per round, and 1
  credit per delivered board.

**Fixes and safety**

- **Home receipts (#219):** old browser save receipts in a retired format no longer block Home. Before
  this, one outdated receipt stopped every new prompt.
- **Skew protection (#221):** on, with a 12-hour maximum age, so a tab opened before a release keeps
  working. #221 fixed a build-cache bug in `next/font` that made pages render in Times.
- **Bot protection (#224):** BotID guards every route that starts paid AI work (`botid` 1.5.12, pinned). It
  fails open if BotID can't be reached, and the credit and daily checks still apply.
  - **Owner to do:** apply the WAF rate-limit rules in `docs/security-rate-limits.md`.
- **Database hardening (#225):** anonymous visitors can call no SECURITY DEFINER function,
  `set_project_deleted` is closed, and new functions are private by default.
- **Turnstile CAPTCHA (#226):** shipped switched off.
  - **Owner to do:** open a Cloudflare account, then follow `docs/auth-captcha.md`.

**Decisions**

- **No observation periods:** the owner rejected waiting periods between a verified release and the next
  step. This replaces the "watch for 48 hours" lines above and in "Done when". Each release is verified
  when it goes live, and the next step starts at once.
- **Step 0.6 (idle logo slots):** already recorded above as decided against, because logos moved to the
  engine. Nothing new.
- **Deploys stay pinned:** production deployments pin pages to their own deployment, so a tab opened
  before a release keeps working.

**In progress (not done)**

- **A6, full-journey browser test in CI:** a helper is building it on branch `ci/journey-e2e`.
- **B1, retiring the old worker code:** a helper is working on it on branch `retire/old-worker`.

The plan for the rest of the work is in `docs/execution-plan.md`.

### Files that change most

- **New:**
  - `supabase/config.toml`;
  - a baseline migration, and credit and subscription migrations;
  - workflow definitions such as `src/workflows/*`;
  - a Stripe webhook route;
  - Sentry config files.
- **Changed:**
  - `vercel.json` and `scripts/preview-preflight.mjs`;
  - `src/instrumentation.ts` and `src/server/http/errors.ts`;
  - `src/app/error.tsx` and `src/app/global-error.tsx`;
  - the generation routes under `src/app/api/projects/[projectId]/…`;
  - client hooks such as `use-logo-creation.ts` and `use-strategy-jobs.ts`;
  - `.github/workflows/ci.yml`, `README.md` and `AGENTS.md`.
- **Removed after the move:**
  - `services/` and most of `worker/`;
  - `src/server/local-chatgpt/`;
  - the connection-pool code in `src/server/shared-account/` and `src/server/runtime/`;
  - `supabase/candidates`, `supabase/activation` and `supabase/operator`.

### How we'll verify the whole thing

- **Every pull request:** type check, lint, unit tests, a rebuild of the database from migrations, and
  the journey browser test against staging with a stand-in AI provider.
- **Before each production switch:** 30 real runs on staging per step, with a success-rate and timing
  report, and spend checked against the ledger.
- **After each switch:**
  - for 48 hours, watch the Sentry error rate, the job failure rate and daily spend;
  - to roll back, flip that step's switch back.
- **Before launch:**
  - an abuse test: scripted generation beyond the caps, including direct Supabase calls;
  - the Stripe test-mode lifecycle;
  - a drill restoring a backup into staging.

---

## 5. Questions for you

1. **Pricing.** Monthly subscription with credits, one price per brand, or credit packs? Is there a
   free tier, and how much can a free user generate?
2. **Sales tax.** Should Stripe take payments directly, or should a "merchant of record" sell on your
   behalf?
   - Stripe directly has the lowest fees, but you register for sales tax or VAT where required.
   - A merchant of record (Stripe Managed Payments or Paddle) handles tax for you, for higher fees.
   - Where will most of your customers be?
3. **Showing credits.** May the app show remaining credits or generations? These are not dollar
   estimates, but the "no cost estimates" rule touches them.
4. **Scope for launch.** Which extras stay?
   - the standalone tools: domain, social handle and trademark checks, the names assistant, ideas;
   - the vector logo editor;
   - the brand board.

   Anything not kept gets removed in Phase 6.
5. **ChatGPT-plan mode.** May I remove it, and all laptop-only runtimes, entirely?
6. **Services and costs.**
   - Are you OK adding Supabase Pro (from about $25 a month), Sentry (free tier to start) and Stripe
     fees?
   - Is the Vercel team on Pro? WAF rate limiting and 800-second functions need it.
7. **Launch date.** When do you want to launch? That decides whether we do the full plan or only the
   launch gate first.
8. **Test data.** All current data is test data. May I reset the production database during the
   Phase 1 baseline if that's simpler, keeping user accounts?
9. **Retention.** How long should generated images be kept for inactive or cancelled accounts?

---

## 6. What the repository's own documents claim vs what the code does

| Claim (source) | Verdict | Evidence |
|---|---|---|
| Competitor research starts automatically after the first Home message (`AGENTS.md`) | True | `project-editor.tsx` → `guided-interview-client.ts` → `account-strategy-start.tsx` |
| Four steps: Strategy, Voice, Identity, Assets (`AGENTS.md`) | True | `src/domain/journey.ts` |
| No cost estimates anywhere in the app (`AGENTS.md`) | True for the screens, not the API | The logo quote route still returns `estimatedCostMicrousd`, and unused USD formatters remain. |
| Durable jobs with cancellation and bounded retries (`AGENTS.md`) | Partly | Cancel works. Shared-slot retries have no count limit, logo provider calls are never retried, and some jobs wait weeks for manual repair. |
| No fixed monetary caps that stop generation (`AGENTS.md`) | True, and that is the abuse risk | The shared path has no cap, and nothing else limits spend (M3). |
| Account ownership and private files enforced on the server (`AGENTS.md`) | True | Row-level security on every user table, owner checks in functions, a private bucket, 60-second signed links |
| Secrets kept out of source (`AGENTS.md`) | True for git, but a plain-text key sits in `design-lab/` | M8 |
| Naming-only and identity-only projects can be started (`README.md`) | Out of date | Only complete brands can be created (`src/server/data/projects.ts`). |
| An estimate appears beside Generate, and a dedicated naming runtime exists (`README.md`) | Out of date | Both were removed. |
| Old naming machinery is still installed, and `worker/index.ts` runs naming (`docs/architecture.md`) | Out of date | The old machinery was removed. `worker/index.ts` runs strategy only and has no production host. |

---

## Appendix A: Production evidence (read-only, November 9, 2026)

**Deployments.** embel.xyz serves commit `6bb2d36`. `main` is 3 merges ahead (#200, #206, #204). This
branch is 9 commits ahead of `main`.

**Database objects.**

- 174 tables: 85 in `public`, 89 in `fluid_private`.
- 672 functions. 211 of the 214 `public` functions are SECURITY DEFINER, and all have a fixed search
  path.
- 214 triggers and 126 policies.
- 15 custom login roles.
- 48 MB of data, about 10 accounts, 1 private bucket.

**Security advisor.**

- 142 privileged functions callable by signed-in users.
- 4 callable by anonymous visitors.
- Leaked-password protection off.
- 98 tables with row-level security and no policies. That's expected for tables only the server uses.

**Jobs, last 30 days.**

| Operation | Jobs | Succeeded | Failed or unresolved | Average time to succeed | Average recorded cost |
|---|---|---|---|---|---|
| strategy.competitors | 40 | 30 | 10 | 86 s | $0.054 |
| strategy.audience | 20 | 18 | 2 | 27 s | $0.017 |
| strategy.personality | 17 | 17 | 0 | 25 s | $0.024 |
| identity.logo_concept | 92 | 66 | 26 | 865 s | $0.015 |
| identity.logo_refine | 6 | 6 | 0 | 34 s | $0.023 |
| identity.image (directions) | 5 | 2 | 3 | 248 s | $0.19 |
| naming.generate | 44 | 13 | 25 | 1,204 s | not recorded |

**Failure reasons.**

- Logo concepts: mostly `operation_incomplete` (18), plus 5 jobs cancelled after waiting about 2
  hours.
- Naming: mostly `naming_incomplete` (18), all before the November 9 naming rebuild.
- No jobs have run in production since the November 9 release, so the rebuilt naming engine and the
  two-slot logo setup are untested there.
- Research: jobs left in `needs_reconciliation` with `provider_outcome_unknown` for 14–20 days.

Logo costs above were recorded under the settings production used at the time. This branch moves to
`gpt-image-2.6-sunburst` at "max" quality, which is likely to cost much more per image. Measure it on
staging before setting credit prices.

## Appendix B: Sources

† = read directly. The others were confirmed through search results for the official page.

**Platform and background jobs**

- † Vercel Workflow docs: https://vercel.com/docs/workflow
- Vercel blog, Workflow generally available April 16, 2026:
  https://vercel.com/blog/a-new-programming-model-for-durable-execution
- † Vercel Daemons (public beta, production only, instance counts): https://vercel.com/docs/daemons
- Vercel Functions limits (Pro: 300 s default, 800 s maximum): https://vercel.com/docs/functions/limitations
- Vercel Queues (at-least-once delivery, so consumers must tolerate repeats):
  https://vercel.com/docs/queues/concepts
- † Next.js instrumentation guide, bundled with Next 16.4.4. `register` runs once per new server
  instance: `node_modules/next/dist/docs/01-app/02-guides/instrumentation.md`
- Inngest flow control (per-user concurrency and throttling): https://inngest.com/docs/guides/flow-control

**AI provider**

- † OpenAI Sign in with ChatGPT Terms (effective November 4, 2026):
  https://openai.com/policies/sign-in-with-chatgpt-terms/
- OpenAI background mode: https://developers.openai.com/api/docs/guides/background
- OpenAI webhooks: https://developers.openai.com/api/docs/guides/webhooks
- OpenAI pricing: https://developers.openai.com/api/docs/pricing
- gpt-image-2.6-sunburst listing (third party, released November 4, 2026):
  https://openrouter.ai/openai/gpt-image-2.6-sunburst

**Database, auth and storage**

- † Supabase, hardening the Data API: https://supabase.com/docs/guides/database/hardening-data-api
- Supabase database functions (revoking execute): https://supabase.com/docs/guides/database/functions
- Supabase linter rules 0028/0029:
  https://supabase.com/docs/guides/database/database-linter?lint=0028_anon_security_definer_function_executable
- Supabase, managing environments (separate staging project, CI `db push`):
  https://supabase.com/docs/guides/deployment/managing-environments
- Supabase pricing (free projects pause after 1 week; backups on paid plans): https://supabase.com/pricing
- Supabase password security: https://supabase.com/docs/guides/auth/password-security
- Supabase CAPTCHA: https://supabase.com/docs/guides/auth/auth-captcha
- Supabase, connecting from serverless (transaction pooler):
  https://supabase.com/docs/guides/database/connecting-to-postgres
- Supabase Realtime: https://supabase.com/docs/guides/realtime

**Database providers (section 2.4)**

- † Supabase pricing: https://supabase.com/pricing
- † Supabase compute sizes and upgrade downtime: https://supabase.com/docs/guides/platform/compute-and-disk
- † Supabase compute billing (paused projects aren't billed): https://supabase.com/docs/guides/platform/manage-your-usage/compute
- † Supabase backups (files and custom-role passwords not included): https://supabase.com/docs/guides/platform/backups
- † Neon pricing (updated November 4, 2026): https://neon.com/pricing
- Firebase Data Connect pricing: https://firebase.google.com/docs/data-connect/pricing
- MongoDB Atlas pricing: https://www.mongodb.com/pricing
- Vercel Marketplace database list (read with `vercel integration discover --category storage`)

**Payments**

- Stripe subscription webhooks: https://docs.stripe.com/billing/subscriptions/webhooks
- Stripe billing credits (public preview):
  https://docs.stripe.com/billing/subscriptions/usage-based/billing-credits/implementation-guide
- Stripe Managed Payments (merchant of record): https://docs.stripe.com/changelog/dahlia/2026-04-22/managed-payments

**Security and monitoring**

- Vercel WAF rate limiting: https://vercel.com/docs/vercel-waf/rate-limiting
- Vercel bot management and BotID:
  https://vercel.com/kb/guide/how-to-utilize-vercels-bot-management-features
- Sentry for Next.js: https://docs.sentry.io/platforms/javascript/guides/nextjs

**Legal**

- GDPR, Article 17 (right to erasure): https://eur-lex.europa.eu/eli/reg/2016/679/oj
