# Embel design audit: start here

This folder prepares a **read-only design audit** of Embel on the **local development stack**. It holds
the test accounts, a reset script and recipes for states the seed data cannot show on its own. Every
audit session reads this file first.

Nothing here touches production (embel.xyz), Stripe, real email or real AI, except the one-time,
owner-approved showcase images described below.

## Direction

- Audience: solo founders and startups, small local businesses, and freelancers or agencies who create brands for clients. Most are not designers. Freelancers and agencies expect professional control and polished exports.
- Target feel: minimal and premium. Calm, precise, generous white space. The interface stays quiet so that the user's own generated brand is the most colourful thing on the screen.

## Scope

- **Always:** the logged-in app, sign-up, login and password reset, error pages (404 and the error
  screens), and the billing and upgrade screens (`/plans`, the plan card in Settings, and the
  out-of-credits prompt).
- **Marketing pages:** not in this repository. There is no landing page. `/` is the app's Home
  (the brief prompt) for everyone; signed out, it shows Sign in and Create account in the navigation.
  Review signed-out Home as the closest thing to a landing page.
- **Exported brand files** (reviewed as designed objects). They are built in the browser from saved
  data, with no AI, on a brand's Assets page (`/brands/account/<id>/logo/deliverables`):
  - the brand board PNG ("Download brand board as PNG");
  - the brand kit ZIP ("Download brand kit"): logo PNG/SVG, the chosen direction board, social profile
    image, post templates and banners (PNG and SVG), `guides/colors.json`, `guides/colors.css`,
    `guides/brand-guide.html` (the brand guidelines; HTML, not PDF) and `README.txt`;
  - the design system tokens, copied or downloaded as `design-tokens.css` / `.json` (Assets → Design system).
- **Emails:** the templates are in this repository (`supabase/templates/confirmation.html` and
  `recovery.html`), so review them as rendered previews only. Run `node design-audit/seed/email-previews.mjs`,
  then open the files it writes to `design-audit/.logs/email-previews/`. Never send one. The local stack does
  **not** use these templates: emails caught by the local inbox (Mailpit) show Supabase's default
  text, not the production design.
- **Dark mode:** none. The app is light only (`color-scheme: light`; there is no theme toggle). Skip it.

## The app in one paragraph

Embel turns a product idea into a usable brand. The person types a brief on Home. Competitor research
starts by itself, and a guided conversation walks through four steps:

1. **Strategy:** Competitors, Audience, Positioning.
2. **Voice:** Personality, Name (up to 100 generated names, or type your own), Slogan (optional).
3. **Identity:** Inspiration (like whole brands in a gallery, or add your own images), Logo (six black
   and white raster concepts, refinable by describing a change), Creative direction (three full-colour
   direction boards built around the chosen logo).
4. **Assets:** Brand images, Brand guidelines, Design system, with downloads.

AI work runs on the generation engine inside the app and costs credits. Plans are Free / Pro / Studio
with 30 / 150 / 500 credits a month. The code is the source of truth; the flow above was checked
against it on November 11, 2026.

## Running the app locally

You need the local Supabase stack (Docker via Colima) and Node.

```bash
colima start embel          # Docker for the local database (once per boot)
npm run dev:up              # local Supabase: database, sign-in, files, email inbox
node design-audit/seed/serve.mjs
```

`serve.mjs` starts the app on **http://127.0.0.1:3105** together with the **stand-in AI** on
http://127.0.0.1:3186, wired to the local generation engine. Every AI click is answered locally, for free.
Use it instead of `npm run dev`: `npm run dev` has no AI wiring, so AI steps fail there.

| What | Address |
| --- | --- |
| App | http://127.0.0.1:3105 |
| Sign in | http://127.0.0.1:3105/sign-in |
| Stand-in AI (recipes) | http://127.0.0.1:3186 (`/__stats`, `/__mode`) |
| Local email inbox (Mailpit) | http://127.0.0.1:54324 |
| Local Supabase API | http://127.0.0.1:54321 |

Logs: `design-audit/.logs/next.log` (app) and `design-audit/.logs/stand-in-ai.log`.

`node design-audit/seed/verify.mjs` (with the server up) re-checks every account and seeded state
without changing anything. It saves a screenshot of each screen to `design-audit/.logs/verify/`.

Runtime note: the project pins Node 24 (`.nvmrc`). This machine's shell has Node 22.22.2, which
everything here was run with.

### Production build (for performance passes)

```bash
node design-audit/seed/serve.mjs --prod
```

This runs `next build --webpack` (about 2 to 3 minutes; it writes the repository's normal `.next/` build
output, as `npm run build` does), then `next start` on http://127.0.0.1:3105 with the same local
wiring and stand-in AI. A plain `npm run build && npm run start` does not work locally because it does
not load the local environment.

**Known limit (verified November 11):** in production mode the server refuses a plain-http Supabase
address (`src/server/config.ts`). Locally, `GET /api/session` and `GET /api/account/profile` therefore
answer 503 `integration_unavailable`. Everything else verified works: all three accounts sign in,
every main page opens and every seeded brand state loads. Expect an empty Full name in Settings and
server error lines in the log. Use the production build for page weight, rendering and Web Vitals.
Use the development server for visual review.

## Accounts

All passwords are in **`design-audit/.audit-credentials`** (JSON; git-ignored, never commit it).
They stay the same across reseeds.

| Account | Plan | Purpose | What it contains |
| --- | --- | --- | --- |
| `audit-fresh@example.test` | Free, 30 credits (granted on first visit) | Onboarding and empty states | No brands, no uploads, no history |
| `audit-free@example.test` | Free, **0 credits left** | Every journey stage, plan limits | 8 brands (below). Any AI button shows the out-of-credits prompt; Plans offers upgrades |
| `audit-pro@example.test` | **Pro**, test-mode subscription (`sub_auditPro0001`, active, renews in about 20 days), 112 credits | Paid account, finished work | 4 complete brands (below) |

**audit-free brands**, one per stage (open them from Projects):

| Brand | Stage | What you see |
| --- | --- | --- |
| Spokesmith (card shows "Untitled brand") | Strategy: research done | Long brief; three researched competitors with sources, none chosen yet |
| Little Lighthouse Dental (card shows "Untitled brand") | Strategy done | Competitors, audience and positioning chosen; the Personality question is open |
| Northern Lights Community Physiotherapy and Sports Rehabilitation Collective | Voice done | 76-character name chosen, slogan skipped ("Skip for now"); Inspiration gallery open |
| Fromagerie Bérénice Côté | Inspiration chosen | One liked brand plus an uploaded image ("2 liked · Next: Logo"). Continue opens the Logo step (logo types and "Explore six concepts"); the app reopens a brand here until logo work starts |
| Quill | Logos generated | Six concepts, none chosen |
| Tidewater Kayak Tours | **Failed generation** | "4 of 6 concepts ready" and "Retry 2 failed concepts" (two images refused) |
| Mosswood Candles | Creative directions | Logo chosen; three direction boards, none chosen |
| ★ Orchard Lane Cider | Complete | Direction chosen; brand board, guidelines, design system ready; brand kit downloaded once |

**audit-pro brands**, all complete (direction chosen, assets ready, kit downloaded once):

| Brand | Notes |
| --- | --- |
| ★ Kestrel Analytics | B2B analytics; the chosen concept was refined once ("Concept 1 · Version 2") |
| Maison Aurélie | French accents; wedding florist for an agency client; refined logo; placeholder images |
| Bright Harbor Learning | Tutoring; placeholder images |
| ★ Tidewild Hot Sauce | Fermented hot sauce from the Nova Scotia coast; the third Home example (approved November 14, 2026) |

**Showcase brands (★): Orchard Lane Cider (audit-free), Kestrel Analytics and Tidewild Hot Sauce (audit-pro).** Their six
logo concepts, the Kestrel refinement and the three creative-direction boards are real images.

They come from the real Embel image model (`gpt-image-2.6-sunburst`, the app's exact requests). The
owner approved them on November 11, 2026: 19 images, about $0.75 estimated from recorded usage. They
are cached in `design-audit/seed/showcase/` (about 15 MB, meant to be kept), so every reseed reuses them
for free. `showcase/real-calls.jsonl` lists every real call ever sent. All other brands use placeholder
images marked **TEST DATA · PLACEHOLDER #n**.

"Past exports": the app builds downloads in the browser and keeps no export history, so there is no
list of past exports to show. Each complete brand had its kit downloaded once during seeding.

Content is deliberately varied to stress layouts: short names (Quill), a 76-character name
(Northern Lights Community Physiotherapy and Sports Rehabilitation Collective), accented French
(Fromagerie Bérénice Côté, Maison Aurélie), long multi-paragraph briefs, and different industries.

## Signing in from a script or a second browser

- Sign-in page: `http://127.0.0.1:3105/sign-in`. The form is named "Sign in"; fields "Email" and
  "Password"; button "Sign in". There is no verification step: the audit accounts are created
  already confirmed, and there is no CAPTCHA locally (Turnstile is off without its key).
- Playwright, as the seed does it (`design-audit/seed/journey.mjs`, `signIn()`):

  ```js
  await page.goto("http://127.0.0.1:3105/sign-in");
  const form = page.getByRole("form", { name: "Sign in", exact: true });
  await form.getByRole("textbox", { name: "Email" }).fill(email);
  await form.getByLabel("Password", { exact: true }).fill(password);
  await form.getByRole("button", { name: "Sign in", exact: true }).click();
  ```

  Save the session with `context.storageState({ path: "design-audit/.auth/audit-free.json" })` and reuse
  it; `.auth/` is git-ignored.
- A failed sign-in clears the password field (by design), so retype it before trying again.
- New sign-ups are possible locally. The confirmation email lands in Mailpit (http://127.0.0.1:54324);
  open its link in the same browser. Use addresses ending in `@example.test`.

## State recipes

Everything below works without a real AI generation: the stand-in AI is told to be slow, to hold or
to fail. Every recipe marked ✓ was tested on November 11, 2026 by
`node design-audit/seed/recipes-check.mjs` (pass a recipe name to run one). That script saves each
state as a screenshot in `design-audit/.logs/recipes/`. Recipes that click AI buttons spend local test
credits and add runs, so **reseed afterwards**.

Two tools do most of the work:

```bash
# Stand-in AI behaviour (lasts until changed or the server restarts):
curl -s -X POST http://127.0.0.1:3186/__mode -d '{"text":"hold"}'                    # text never finishes
curl -s -X POST http://127.0.0.1:3186/__mode -d '{"text":"slow","delayMs":90000}'     # text takes 90 s
curl -s -X POST http://127.0.0.1:3186/__mode -d '{"text":"fail"}'                    # text requests fail
curl -s -X POST http://127.0.0.1:3186/__mode -d '{"images":"slow","delayMs":120000}' # images take 120 s
curl -s -X POST http://127.0.0.1:3186/__mode -d '{"images":"refuse"}'                # images refused
curl -s -X POST http://127.0.0.1:3186/__mode -d '{"images":"hold"}'                  # images never answer
curl -s -X POST http://127.0.0.1:3186/__mode -d '{"text":"normal","images":"normal"}' # back to normal
```

```bash
# Database switches (local only; always end with reset):
node design-audit/seed/switch.mjs kind logo.concepts off       # one AI step unavailable
node design-audit/seed/switch.mjs pause on                     # every AI step unavailable
node design-audit/seed/switch.mjs daily-limit logo.concepts 1  # "today's limit" (minimum is 1)
node design-audit/seed/switch.mjs credits audit-free 30        # give an audit account credits
node design-audit/seed/switch.mjs reset                        # all back to normal
```

A text mode applies to requests started after the change. Text covers research, naming, slogans,
style notes and direction specs; images cover logos, refinements and direction boards.

### Loading and in-progress

- ✓ **Research in progress** ("Researching your competitors…" with Cancel research): set
  `{"text":"hold"}`, then as audit-pro send a new brief on Home.
- ✓ **Logo concepts being drawn** (six "Creating your concept" cards and Stop): set
  `{"images":"slow","delayMs":120000}`. As audit-pro, open Maison Aurélie's Logo section and click
  More concepts.
- **Names, slogans or directions in progress:** same idea. Use `{"text":"slow"}` before Voice steps
  (audit-free Little Lighthouse Dental needs credits first: `switch.mjs credits audit-free 30`).
  Use `{"images":"slow"}` before "Create three directions".
- **Page-level loading** (skeletons, "Loading saved preview…"): delay API responses in Playwright with
  `await context.route("**/api/**", async (r) => { await new Promise((x) => setTimeout(x, 8000)); await r.continue(); });`.
  Or use DevTools → Network → throttling ("Slow 4G").

### Error states

- ✓ **Research failed** ("Research could not produce verified suggestions…" and Retry research): set
  `{"text":"fail"}`, then send a new brief as audit-pro.
- ✓ **Logo concepts failed** ("Retry 6 failed concepts"): set `{"images":"refuse"}`, then click More concepts
  on Bright Harbor Learning (audit-pro). A persistent example is already seeded: audit-free → Tidewater Kayak Tours.
- ✓ **Step unavailable** ("Logo drawing is unavailable right now. Your logos are saved." and "Generation is
  unavailable"): `switch.mjs kind logo.concepts off`, open any Logo section, then `switch.mjs reset`.
  `pause on` makes every step unavailable.
- ✓ **API failing** ("The account could not be reached. Your edits are still in this tab." and Retry loading
  project): in Playwright,
  `context.route("**/api/projects/**", (r) => r.fulfill({ status: 500, body: "{}" }))`, then open a brand.
  In DevTools, use Network → right-click a request → Block request URL.
- ✓ **Offline save** ("Saving could not be confirmed. Your edits are still here…"): in Settings change the
  name, go offline (`context.setOffline(true)` or DevTools → Network → Offline), click Save changes.
- ✓ **Failed upload** ("The reference upload could not be confirmed…" with Check upload and Cancel upload):
  upload a non-image file renamed to `.png` through Inspiration → "Add your own references". The file
  picker only offers PNG, JPEG and WebP; Playwright's `setInputFiles` bypasses that.
- **Stuck generation:** the app ends runs that stop reporting by itself (default 30 minutes; text requests
  stop after about 10). It refunds the credits, so a stuck run cannot be stored in seed data. Use
  `{"text":"hold"}` or `{"images":"hold"}` and watch the state for as long as needed.
- ✓ **404:** any unknown URL (for example `/this-page-does-not-exist`) shows "Page not found". A missing
  project (`/brands/account/00000000-0000-4000-8000-000000000000`) shows "This project is not available to
  this account." with Retry loading project (the pill still says "Loading project…").

### Validation, disabled and destructive confirmation

- ✓ **Wrong password:** sign in with a wrong password (alert, and the password field is cleared).
- ✓ **Sign-up validation:** `/sign-up` with a short password and a different confirmation.
- **Forgot password:** `/forgot-password` → "Send reset link" → "Check your email". The email lands in
  Mailpit only (tested; nothing leaves the machine). Opening its link in the same browser shows `/reset-password`.
- **Disabled controls:** on the Logo step, untick every logo type ("Choose at least one type"; Explore six
  concepts is disabled). Seen during seeding; not scripted.
- ✓ **Delete project dialog:** Projects → "…" (Project options) on any card → Delete. Press Escape to leave
  it. Confirming moves the project to Deleted projects (restorable).
- ✓ **Delete account dialog:** Settings → Your data → Delete account. Do not confirm it on an audit account
  that has chosen a name: it fails because of a known bug (see the last section). Reseed if you do.

### Plan limits and upgrade

- ✓ **Out of credits** ("You're out of credits for this month" with Not now and See plans): any AI button as
  audit-free, for example Fromagerie Bérénice Côté → Continue → Explore six concepts.
- ✓ **Upgrade:** audit-free → `/plans` shows Free as current with "Upgrade to Pro / Studio". Clicking upgrade
  shows "Payments are unavailable right now. Nothing was charged." because no Stripe test key is set
  locally. audit-pro → `/plans` shows Pro with Manage plan and Cancel plan, which fail the same way.
- ✓ **Today's limit** ("You've reached today's limit for this. Your logos are saved. Try again tomorrow."):
  `switch.mjs daily-limit logo.concepts 1`, then More concepts on any audit-pro brand. Reset afterwards.
- The Settings → Account plan card and Settings → Usage tab show credits and history for each account.

### Modals, drawers, toasts

- The sign-in and create-account overlay opens from Home while signed out (Sign in or Create account in
  the navigation, or sending a brief).
- Out-of-credits prompt (above), Delete project and Delete account dialogs (above).
- Logo concepts: each card has "Compare concept n" (not explored). The composer under the grid ("Describe a
  change to this logo" → Refine) and "View refined logo" appear after choosing a concept.
- Name step: each name opens a preview ("Close name preview").
- Strategy: competitor cards link to their sources ("References for …").

## Resetting the data

```bash
node design-audit/seed/seed.mjs
```

This deletes the three audit accounts (only those, matched by their exact addresses) and everything
they own: rows, files and logins. It then rebuilds them by driving the real app with the stand-in AI.
It takes about 3 minutes, needs nothing else serving port 3105 (stop `serve.mjs` first) and ends with a
table of brands and their states. Missing showcase images are **not** generated unless you pass
`--real-images`; that costs money and needs the owner's approval.

What the seed changes beyond the three accounts, all in the local database only:

- All AI kinds are switched on and the engine is unpaused, so screens look like production.
- The local engine login gets the journey test's local password.

Other options: `--headed` (watch it), `--only <brand key>` (rebuild one brand without a reset, for
debugging). Brand content lives in `design-audit/seed/brands.mjs`.

## Notes for the later passes (Prompt 0 onward)

- **Order of operations:** stop `serve.mjs` (Ctrl+C) → `node design-audit/seed/seed.mjs` → start
  `node design-audit/seed/serve.mjs` again. The seed refuses to run while anything serves port 3105.
- **Playwright is already a project dependency** (`@playwright/test` 1.63, in the root
  `node_modules`), so `capture.mjs` can import it directly; nothing needs installing. If Prompt 0
  still installs Playwright into `design-audit/node_modules`, keep it separate: the seed scripts keep
  resolving `@playwright/test` from the repository root.
- **Browser binary:** Playwright 1.63 expects Chromium build 1243, which is not downloaded on this
  machine. `launchBrowser()` in `design-audit/seed/journey.mjs` falls back to the Chrome for Testing
  build already in `~/Library/Caches/ms-playwright/`. Reuse it (or `npx playwright install chromium`
  if a download is acceptable).
- **Reusable helpers for `capture.mjs`:** `signIn(page, email, password)` and `launchBrowser()` in
  `seed/journey.mjs`; project ids per brand in `.logs/last-seed.json` (key `results[].projectId`;
  they change on every reseed, so look brands up by name or read this file after each reset);
  `seed/verify.mjs` as an example of opening every seeded state; `seed/recipes-check.mjs` for scripted
  recipe states.
- **Brand pages:** a brand opens at `/brands/account/<id>?view=strategy`. The Strategy, Voice and
  Identity steps live on that one long conversation page (`#journey-voice`, `#journey-logo`,
  `#journey-directions`). Assets are at `/brands/account/<id>/logo/deliverables`.
- **Exports for Prompt 0, task 6:** audit-pro's Kestrel Analytics (showcase) → Assets → "Download brand
  kit". The guidelines file inside the ZIP is `guides/brand-guide.html`.
- **Browser pane sign-in:** wait until `/sign-in` has finished loading before typing. Text typed in the
  first seconds can be wiped (see issue 2 below), and a failed submit clears the password.
- **Widths:** the seed ran at 1440 wide. Nothing in the data depends on width, so 390 and 768 captures
  work the same way.

## Rules for audit sessions

- Run the seed reset (`node design-audit/seed/seed.mjs`) before starting, so every session sees the same state.
- Local environment and test mode only. Never point anything at embel.xyz or the production database,
  and never use live Stripe keys.
- Never start a real AI generation without the owner's approval. Use the recipes above; the stand-in AI
  answers every AI request for free. Never pass `--real-images` without approval.
- Never send a real email. Local actions that email (sign-up, password reset) are caught by Mailpit and
  leave nothing; never configure real SMTP. Review templates as rendered previews.
- Recipes that click AI buttons or delete things change the seeded data. Reseed afterwards.

## What could not be set up, and why

- **The app's error screens (`error.tsx`, `global-error.tsx`):** I found no way to reach them without
  changing application code. Failing APIs, a malformed page response and a stopped database API all
  produce the app's own handled error messages instead (see recipes). Showing them needs a deliberate
  render failure: a temporary throw in a component, on a throwaway branch, with the owner's approval.
  In development, Next.js shows its own error overlay instead.
- **Stripe Checkout and the customer portal:** no Stripe test key is configured locally, so Upgrade and
  Manage plan stop at "Payments are unavailable right now". Those pages are hosted by Stripe, not
  Embel. Seeing them would need a `sk_test_…` key in the local environment.
- **A brief with no research at all:** this state does not exist. Research starts automatically after the
  first message. Spokesmith shows the earliest saved state (research done, nothing chosen); the
  in-progress recipe shows research running.
- **A permanently stuck generation:** the app ends and refunds stuck runs by itself, so one cannot be
  stored. Use the hold recipes.
- **Email design in the local inbox:** the local Supabase stack uses its default email text, not
  `supabase/templates/`. Review the templates with `email-previews.mjs`.
- **Production build:** session and profile routes answer 503 locally (see "Production build").
- **Dark mode and marketing pages:** not in this repository (see Scope).

### Issues found while seeding (for the owner, not fixed here)

1. **Settings → Delete account fails for any account that has chosen a brand name.**
   `account_deletion_purge` stops with `account_purge_blocked` (detail `public.projects`). Three naming
   tables point at each other in a loop: `name_candidates` → `name_selections` → `naming_sessions.current_selection_id`
   → `name_candidates`. The purge can never delete any of them, and the person sees "Deletion didn't finish".
   The seed's reset works around it by clearing `naming_sessions.current_selection_id` in the same
   transaction before the purge (`design-audit/seed/accounts.mjs`). The app itself needs a fix, for
   example a null-out step like this inside the purge function, or a deferrable foreign key.
2. **Sign-in form clears typed text right after the page loads.** In the Browser pane, an email typed
   within the first seconds after opening `/sign-in` was wiped, and submitting then cleared the
   password too. Playwright's direct `fill` did not hit it. This looks like a hydration reset and is
   worth a look in the audit.
3. **Leaving Inspiration is not remembered.** After Inspiration → Continue, reopening the brand (or the
   Projects card) goes back to Inspiration ("Continue to Inspiration") until logo concepts are started.
   See Fromagerie Bérénice Côté.

### Spend record

- Real AI calls: 43 image requests in total, all on November 11, 2026, all listed in
  `design-audit/seed/showcase/real-calls.jsonl`.
- 24 of them were lost to a bug in the stand-in, which crashed while logging and so never saved the
  images. The bug is fixed: the stand-in now saves first, makes one call per image, and answers
  failures as refusals so the engine does not retry them into new paid calls.
- Estimated cost: about $0.75 for the 19 kept images (from recorded token usage), plus about $0.64
  for the 24 lost logo calls. That is about **$1.39** in all, against an approved ceiling of $3.
- These are estimates, not confirmed charges; check the OpenAI usage page for the actual amount.
  Every other generation ran on the free stand-in.
