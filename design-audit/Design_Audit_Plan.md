# Design Audit Plan — Updated Prompts

Nov 11, 2026 · @Mikaël Charbonneau · updated Nov 13, 2026 after Prompt 6

## Overview

**Where things stand (Nov 13):** Setup through Prompt 6 are done. The design system and the screens live in Claude Design: the design system "Embel Design System" (https://claude.ai/artifact/NrcVPniQFUPdtrBBtY9V8J) and the canvas "Embel screens" (https://claude.ai/artifact/M4MG9CqZoWu2KeWb1u8wca), including a clickable prototype of the desktop journey on page 9. Prompt 6's outputs are in the repo: `design-assets/handoff.md` (decisions made in Claude Design, D- IDs per screen, open items, final image slot sizes) and `design-audit/approved/` (213 approved screens rendered from the canvas). The next step is Prompt 7. Prompts 7 onward below are updated for what Prompt 6 decided.

Run each prompt in a **new session**, in the order below. Every change discussed in the conversation is already applied: Sonnet for capture, the imagery inventory, the dedicated design-system pass, the merge changes, and the design-system-first flow in Claude Design. No advisor is used anywhere except, optionally, in implementation. Run Setup through Prompt 4 without changing any application code in between. The code cleanup comes after Prompt 4, and Prompt 7b then brings the audit's file references up to date before implementation.

| Order | Prompt | Where | Model | Writes |
| --- | --- | --- | --- | --- |
| 0 | Setup prompt: test accounts and README | Claude Code | Opus 5.5, high | README.md, seed/, test accounts |
| 1 | Prompt 0: inventory and capture, then you check the route list | Claude Code | Sonnet 5.5, high | 00\_inventory.md, evidence/screens/, capture.mjs |
| 2 | Prompt 1: experience review | Claude Code | Fable 5.2, high | 01\_experience\_review.md |
| 3 | Prompt 1b: imagery | Claude Code | Fable 5.2, high | 04\_image\_needs.md |
| 4 | Prompt 2: motion and interaction | Claude Code | Fable 5.2, high | 02\_motion\_interaction.md |
| 5 | Prompt 3: accessibility and technical | Claude Code | Fable 5.2, high | 03\_accessibility\_technical.md |
| 6 | Prompt 3b: design system | Claude Code | Fable 5.2, high | 05\_design\_system.md |
| 7 | Prompt 4: merge, then you approve the two verdicts | Claude Code | Fable 5.2, high | Design\_AUDIT.md |
| 8 | Prompt 5: build the design system | Claude Design | Fable 5.2 | Published design system |
| 9 | Prompt 6: redesign screens (done Nov 13) | Claude Design | Fable 5.2 | Screen designs, design-assets/handoff.md, approved/ |
| 10 | Prompt 7: image assets (no generation needed) | Claude Code | Sonnet 5.5, high | design-assets/ |
| 11 | Code cleanup (separate work, any time after Prompt 4) | Claude Code | Your choice | App code |
| 12 | Prompt 7b: refresh file references | Claude Code | Sonnet 5.5, high | 07\_reference\_refresh.md |
| 13 | Implementation prompt | Claude Code | Fable 5.2, or Opus 5.5 high + /advisor fable to save usage | App code, 08\_implementation\_log.md |
| 14 | Prompt 8: re-capture | Claude Code | Sonnet 5.5 | evidence/after/ |
| 15 | Prompt 9: review | Claude Code, fresh session | Fable 5.2, high | 06\_review.md |

**File map** (all paths are in your project folder):

```plain
design-audit/
  README.md                      # Setup prompt writes this: direction, scope, URLs, test accounts, how to reach each state
  seed/                          # Setup prompt: the script that resets the test accounts
  package.json  node_modules/    # Prompt 0: Playwright, installed here and not in the app
  capture.mjs                    # reusable screenshot script (Prompt 0)
  00_inventory.md                # routes, flows, states, token map, visual assets
  01_experience_review.md        # Prompt 1
  02_motion_interaction.md       # Prompt 2
  03_accessibility_technical.md  # Prompt 3
  04_image_needs.md              # Prompt 1b (imagery)
  05_design_system.md            # Prompt 3b
  Design_AUDIT.md                # Prompt 4: the brief for Claude Design
  06_review.md                   # Prompt 9
  07_reference_refresh.md        # Prompt 7b
  08_implementation_log.md       # Implementation prompt
  animation-plans/               # Prompt 2
  tools/                         # small helper scripts, e.g. the contrast calculator (Prompt 3b)
  approved/                      # approved screens rendered from the Claude Design canvas: <route>__<state>__<width>.png
  evidence/
    screens/<route-slug>__<state>__<width>.png   # "before"
    after/<same names>.png                       # "after"
    post-cleanup/   phase-1/ ... phase-4/        # captures after the cleanup and after each implementation phase
    exports/   emails/                           # sample exported brand files and email previews
    annotated/<finding-id>.png
    lighthouse/   traces/
design-assets/
  handoff.md                     # Prompt 6: decisions, D- IDs per screen, open items, final image slot sizes
  source/  optimized/  manifest.md  # Prompt 7: captured and optimized images, and their manifest
```

Widths are always 390 (mobile), 768 (tablet) and 1440 (desktop). If a session's context passes about 60% (check with /context), ask it to save its file so far and continue in a new session. Every audit prompt already saves its findings after each route, so little is lost.

## Setup before you start

Do this once, from a clean git state (git status shows nothing). First ask Claude Code to "create and switch to a new git branch called design-audit". The whole audit runs on that branch, so anything that changes by accident stays away from your main code. Install commands come from third-party guides; check them against each repo's README if one fails.

1. **Test data and README:** do steps 3 and 4 first, then run the Setup prompt below (Opus 5.5) to create test accounts and write design-audit/README.md.
2. **Skills and tools** (type in a Code session, or use + > Plugins):
   - Design plugin: /plugin marketplace add anthropics/knowledge-work-plugins, then /plugin install design@knowledge-work-plugins (skip if it already shows under + > Plugins)
   - frontend-design: npx skills add anthropics/skills --skill frontend-design --agent claude-code
   - Emil Kowalski's free animation skills: npx skills@latest add emilkowalski/skills
   - Chrome DevTools MCP: /plugin marketplace add ChromeDevTools/chrome-devtools-mcp, then /plugin install chrome-devtools-mcp. It opens its own Chrome window, separate from the Browser pane and not signed in; Prompts 3 and 9 sign in there themselves
   - Vercel guidelines: npx skills add https://github.com/vercel-labs/agent-skills --skill web-design-guidelines
   - Playwright (screenshots to disk): nothing to install by hand. Prompt 0 installs it inside design-audit/, so your app's own dependency files stay untouched
   - ~~For Prompt 7 only: fal.ai MCP and Iconify MCP~~ No longer needed: the imagery pass found no image to generate, and the design system already defines one icon set (Lucide).

### Setup prompt: test accounts and README

**Model:** Opus 5.5, high effort, new session, Manual permission mode (you approve each command). Opus rather than Sonnet because this session writes to a database and has to notice if anything points at production; it runs once, so the extra cost is small. Before pasting, fill in the two lines marked \[OWNER\] in the Direction block; any you leave as they are get skipped.

```plain
You are preparing test data for a read-only design audit of Embel, this repository's web app (production: embel.xyz). Your outputs are test accounts with realistic data in the LOCAL development environment, a reusable seed script, and design-audit/README.md, which every later audit session reads first.

About the app
Embel is an AI-powered branding app with user accounts, paid plans and brand-file export. The main flow is: business brief -> competitor/audience research for positioning -> brand voice (personality, name, optional slogan) -> inspiration images (likes and own uploads) -> 6 logo concepts, refinable -> 3 creative directions shown on product images -> brand guidelines and a design system to export. Confirm all of this against the code; the code wins where they differ.

Direction from the owner (copy into README.md under "Direction", word for word; later passes judge the app against it. Leave out any line that still contains "[OWNER")
- Audience: solo founders and startups, small local businesses, and freelancers or agencies who create brands for clients. Most are not designers. Freelancers and agencies expect professional control and polished exports.
- Target feel: minimal and premium. Calm, precise, generous white space. The interface stays quiet so that the user's own generated brand is the most colourful thing on the screen.
- Products whose look the owner admires: [OWNER: add 3-5 names]
- Things that already work and must stay: [OWNER: add them]

Scope of the audit (copy into README.md under "Scope", adjusted to what you find)
- Always: the logged-in app, sign-up, login and password reset, error pages (404, 500), and the billing and upgrade screens.
- Marketing and landing pages, if they live in this repository. If they live elsewhere, say so.
- Exported brand files (the brand guidelines and design-system export). They are what customers keep, so they are reviewed as designed objects.
- Emails, only if their templates live in this repository, and only as rendered previews. Never send one.
- Dark mode, only if the app already has one.

Safety rules (these override everything else)
- Work only against the local development environment. Before writing any data, find out which database, auth, storage, payment, email and AI providers the local environment points to (env files, config), and tell me. If anything points to production (embel.xyz, a production database or project, live payment keys), stop and ask me before going further. If there is no separate development database or project at all, explain my options in plain language (for example a second project, a database branch, or a local database), with the effort and cost of each, and wait for my choice.
- Never read, copy or modify real users' data.
- Payments: test mode only. Do not send real emails.
- AI generations cost money and are slow. Prefer inserting seed records and files directly. If some data can only be created by running real generations, tell me how many and the likely cost, and wait for my approval.
- Only create or change files inside design-audit/. Do not change application code, config, migrations or dependencies. If seeding seems to require a code change (for example, no way to skip email verification locally), stop and explain the options.
- Give me a one-line update every few tool calls.

Tasks
1. Investigate (read-only): the stack; how to start the app locally (command, URL, port) and how to run a production build locally; how sign-up and login work; the data model for brands and each step of the flow; where generated images and uploads are stored; how exports are produced; how plans and limits work; any feature flags; whether marketing pages and email templates live in this repository; and whether the app has a dark mode.

2. Propose a seed plan and WAIT for my approval. Default plan:
   - audit-fresh: new free account with no brands (onboarding and empty states).
   - audit-free: free account with several brands, one stopped at each step of the flow (brief only, research done, voice done, inspiration chosen, logos generated, creative directions chosen, complete with guidelines and export). If the free plan has limits, put this account at its limit so upgrade prompts appear.
   - audit-pro: paid account (test-mode subscription) with 2-3 complete brands, including refined logos and past exports.
   - If the data model can represent them: a brand with a failed or stuck generation, to show error and retry states.
   - Showcase brands with real images: the logo, creative-direction and guidelines screens are made mostly of generated images, so they cannot be judged on grey placeholders. At least two complete brands (one in audit-free, one in audit-pro) must use real generated images. First look for brands already generated in the local environment and reuse their images. If there are none, tell me how many generations two showcase brands need and the likely cost, and wait for my approval.
   Use realistic, varied content: a mix of short and very long brand names, long briefs, a name with accents (e.g. French), and different industries, so layouts are stress-tested. For every brand other than the showcase brands, use simple local placeholder images clearly marked as test data.

3. After approval, write an idempotent seed script in design-audit/seed/ (running it again resets the accounts to the same state), using only dependencies the project already has, and run it. Store the test passwords in design-audit/.audit-credentials, and create design-audit/.gitignore containing ".audit-credentials", ".auth/" and "node_modules/" so they are never committed.

4. Verify in the Browser pane: log in as each account, open every main screen, and confirm each planned state is reachable. Leave the Browser signed in as audit-free.

5. Work out how to trigger the states that seed data alone can't show, and write a recipe for each:
   - loading and in-progress generation states (e.g. Playwright route delays or DevTools network throttling)
   - error states (blocked or failing API routes, offline, invalid form input, failed upload)
   - validation, disabled and destructive-confirmation states
   - plan-limit and upgrade prompts
   - any modal, drawer or toast worth seeing
   Every recipe must work without a real, paid AI generation (delay or mock the request instead). If a state can only be reached with a real generation, say so.

6. Write design-audit/README.md with:
   - "Direction" and "Scope", from the blocks above
   - a short description of the app and its flow
   - how to start the dev server, how to run a production build locally (later passes use it for performance tests), and the URLs
   - an accounts table: account, plan, purpose, what it contains, which brands are showcase brands, and where the password is (design-audit/.audit-credentials)
   - how a script or a second browser can sign in as each account (login URL, fields, any verification step and how to pass it locally)
   - the state-trigger recipes from task 5
   - how to reset the data (the seed command)
   - "Rules for audit sessions": run the seed reset before starting; local environment and test mode only; never start a real AI generation without the owner's approval, use the recipes instead; never send an email
   - anything you could not set up, and why

Do not stop while planned accounts or states remain unverified, except to wait for my approval in task 2 or to ask about a safety issue. Close with a short recap: accounts created, states verified, and gaps.
```

## Prompt 0: Inventory and capture

**Model:** Sonnet 5.5, high effort. Select it with /model sonnet before pasting.

```plain
You are running step 0 of a read-only design audit of this web app. Your outputs are design-audit/00_inventory.md, a set of screenshots, and a reusable capture script. Read design-audit/README.md first, including its Scope and its "Rules for audit sessions".

Rules for this session
- Only create or change files inside design-audit/. Reading any source file is fine and encouraged. Do not modify application code, config, dependencies, or git state.
- Start by running the seed reset command from README.md. Never start a real AI generation (they cost money). To see loading, generation and error states, use the recipes in README.md. If a state can only be shown by a real generation, list it under "Could not reach".
- Playwright: if it is not already one of the project's dependencies, install it inside design-audit/ with its own package.json (for example: npm install --prefix design-audit playwright, then npx playwright install chromium). Never add it to the app's package.json or lockfile.
- Save your work as you go: update 00_inventory.md after each route, so nothing is lost if this session ends early.
- Before you start, say in one line what you are about to do. Every few tool calls, give me a one-line update.

Tasks
1. From the code (router files, pages, layouts), list every route and every main user flow that is in Scope. Note auth-gated routes and how to reach each one.

2. Map the current design system from code: color tokens, type scale and font families, spacing scale, radii, shadows, breakpoints, motion durations and easings, and the shared component library (buttons, inputs, modals, toasts, tables, nav). Note where values are hardcoded instead of tokenized, with file:line examples.

3. Start the dev server and open the app in the Browser pane. Click through every route and flow once to confirm the inventory is complete, and add anything the code missed. Use the seeded brands to see each step of the flow instead of generating new ones.

4. Capture evidence to disk with the Playwright CLI through Bash, not by pasting screenshots into this conversation. For every route, capture widths 390, 768 and 1440, and capture each reachable state: default/populated, empty, loading, error, and any modal or drawer states. Name files design-audit/evidence/screens/<route-slug>__<state>__<width>.png. Put the account in <state> when it matters (e.g. empty-fresh, limit-free), and add "-dark" for dark mode if the app has one (key screens only). For states that need interaction (hover, focus, disabled, validation errors), use the Browser pane and record in the inventory exactly how to trigger each one. Capture them with Playwright if you can script it.
   Save the capture as a reusable script, design-audit/capture.mjs. The script must:
   - take an output folder as an argument (default design-audit/evidence/screens/) and recapture every route, state and width with the same file names;
   - sign in by itself with the test accounts from design-audit/.audit-credentials (keep any saved login state in design-audit/.auth/), using the account that README.md says holds each state;
   - take full-page screenshots after fonts and images have loaded, with animations disabled, so two runs of the same screen look identical;
   - find elements by role, label, visible text or URL, not by CSS class names, so it keeps working after a redesign;
   - fail loudly if a page that should be signed in shows the login screen instead.
   Document how to run it, and any manual steps, in 00_inventory.md. Open at least one screenshot per route yourself and confirm it shows the intended screen and state.

5. Inventory the visual assets. For every route, list every visual asset you find: <img>/<picture>, CSS background-image, inline <svg>, icon components (name the library), <video>/Lottie, favicon/app icons, and og:image/twitter:image meta tags. For each, record: route, component/selector, file path or URL, format, intrinsic size vs rendered size at 390, 768 and 1440, file weight (KB), alt attribute (quote it, or write "missing", or alt=""), loading/fetchpriority attributes, and the screenshot file where it appears. Also list obvious empty slots: empty states with no visual, blank hero areas, a missing OG image. Do not change or optimize anything.

6. Exports and emails. Download one complete export from a showcase brand in audit-pro and save it under design-audit/evidence/exports/, with each page or file also rendered as a PNG so later passes can look at it. If email templates are in Scope, render each one to design-audit/evidence/emails/ as a PNG. Never send an email.

7. Write 00_inventory.md with:
   - a route table (route, purpose, auth, account used, states found, evidence files)
   - a flow list (steps, entry and exit)
   - the design-system map from task 2
   - a "Visual assets" section from task 5
   - the exported files and email previews from task 6
   - how to run capture.mjs, including manual steps
   - a "Could not reach" list with the reason for each

Finishing
Do not stop while inventory or capture work remains. Diagnose ordinary obstacles (timeouts, login walls, missing seed data) and work around them. Only stop for a real blocker, and list it under "Could not reach." Close with a short recap: counts of routes, flows, screenshots and visual assets, and the gaps.
```

**Checkpoint (you):** open 00\_inventory.md and read the route table and the "Could not reach" list. If a screen you know about is missing, tell the session before you close it. The later passes only review what is listed here.

## Prompt 1: Experience review

**Model:** Fable 5.2, high effort, new session.

```plain
You are running pass 1 of a read-only design audit. Read design-audit/README.md (including Direction, Scope and "Rules for audit sessions") and design-audit/00_inventory.md first. Output: design-audit/01_experience_review.md.

Goal: this product must feel top-tier and be ready for thousands of users. "Top-tier" means the Direction in README.md: judge every screen for that audience and that target feel. Features are done; judge layout, visual design, hierarchy, consistency, UX flows and copy. Imagery gets its own pass (1b); here, note an image problem only when it damages a screen. The design system is NOT locked; you may recommend changing any part of it.

Step 0: check the inventory
00_inventory.md was produced by a faster model. Before reviewing, check it for completeness against the router code and the running app. If routes, flows or states are missing, capture them (with design-audit/capture.mjs or the Playwright CLI) and list them under "Gaps found in inventory" at the top of 01_experience_review.md.

Skills, in this order
1. Use the design plugin's design-critique skill as the review framework for every route and flow.
2. Use the design plugin's ux-copy skill for buttons, labels, empty states, errors, confirmations and loading text.
3. Use the frontend-design skill only as an aesthetic lens: check the UI against its list of templated "AI default" looks and its standard for a distinctive, intentional visual identity. Do not write any code or new designs.
Also check each flow against Nielsen's 10 usability heuristics and cite the heuristic by name.
The full design-system audit happens in a later pass (3b). Here, only note systemic symptoms.

How to look
- Run the seed reset from README.md before you start, and again if you change or delete test data. Never start a real AI generation; use the seeded brands and the recipes in README.md.
- Use the saved screenshots in design-audit/evidence/screens/ as your primary evidence. Open the Browser pane only to check hover, focus, transitions, scrolling, sticky elements and anything a still image can't show. Walk each main flow end to end at 390 and 1440 at least once, using the seeded brand that sits at each step.
- Judge the logo, creative-direction and guidelines screens on the showcase brands (real images), not on the placeholder brands.
- Review the exported brand files in design-audit/evidence/exports/, and the email previews in design-audit/evidence/emails/ if there are any, as designed objects: hierarchy, typography, consistency with the app, and whether a customer would be proud to share them.
- Only create or change files inside design-audit/. Save any new evidence to design-audit/evidence/annotated/<finding-id>.png.
- Save as you go: add each route's findings to 01_experience_review.md as soon as you finish that route.
- Give me a one-line update every few tool calls.

Finding format (one block per finding, IDs E-001, E-002, ...)
- Screen/route, state and width
- Category: layout | spacing | typography | color | hierarchy | components | consistency | navigation/IA | flow | copy | responsiveness | imagery | exports
- Severity: P0 (blocks or breaks a task) | P1 (hurts trust or completion) | P2 (noticeable polish) | P3 (nice to have)
- Tag: needs redesign (requires a new visual or interaction decision; goes to Claude Design) OR execution fix (the right answer is already clear; goes straight to implementation)
- What's wrong (specific, observable)
- Why it matters (heuristic or principle)
- Suggested direction (what good looks like; not code)
- Evidence: file paths
- Systemic? yes/no; if yes, list the other screens affected

Required sections of 01_experience_review.md
1. Gaps found in inventory (if any).
2. Executive summary: the 5 issues that most hold back a top-tier feel.
3. Findings, grouped by route, then exported files and emails.
4. Design-system symptoms: briefly list problems that look systemic (e.g. spacing or button styles differ across screens), with evidence paths. Do not write a token spec here.
5. Product-structure recommendation: "refresh" (keep the information architecture, navigation and page layouts; improve how they look and behave) or "full redesign" (rethink IA, navigation or layouts), with the evidence for your choice. Choose full redesign only if structural problems exist across multiple flows or breakpoints. The design system is judged separately in pass 3b.

Write for a reader who has not seen your tool calls. Put key points first, use plain words and full sentences, and define any term you introduce. Do not stop while routes in the inventory remain unreviewed. Close with a recap: counts by severity and tag, and anything you could not review.
```

## Prompt 1b: Imagery

**Model:** Fable 5.2, high effort, new session. Split from Prompt 1 so that neither session runs out of context.

```plain
You are running pass 1b of a read-only design audit: imagery. Read design-audit/README.md (including Direction, Scope and "Rules for audit sessions"), the "Visual assets" section of design-audit/00_inventory.md, and the executive summary of design-audit/01_experience_review.md. Output: design-audit/04_image_needs.md.

Rules
- Use the saved screenshots in design-audit/evidence/screens/ as your primary evidence. Open the Browser pane only when a still image is not enough. Never start a real AI generation.
- Only create or change files inside design-audit/. Do not change or optimize any asset.
- Save as you go: write each part of 04_image_needs.md as soon as it is ready.
- Give me a one-line update every few tool calls.

Evaluate the current imagery against the Direction in README.md: consistency of style (one icon family? one illustration style?), relevance (does each image explain something, or is it decoration?), quality (blurry, stretched, wrong crop, dated stock), and whether real product screenshots would serve better than illustration. Prefer restraint: for a SaaS, the product UI itself is usually the best image, and for this app the brands it generates are the strongest imagery it has.

04_image_needs.md must contain:
1. Verdict (one paragraph): how much imagery this app needs, and where (marketing pages / onboarding / empty states / app screens / exported files / social sharing).
2. Draft ART DIRECTION block, to be reused word for word in every image-generation prompt later: 3 brand adjectives that fit the Direction; medium/style (e.g. "flat vector, 2px rounded strokes"); palette as hex values (use the current tokens for now and mark them "to be replaced by the new design system"); lighting/texture; composition rules (negative space for text, subject placement); what to avoid (text in images, real brands, real people's likeness, stock-photo cliches); and 1-3 reference images if any exist.
3. IMAGE NEEDS table, one row per slot, with these columns:
   ID (IMG-001...) | Route / component | Purpose: informative / decorative / functional | Current state: missing / placeholder / weak / OK / remove | Recommended source: KEEP / REMOVE / REAL SCREENSHOT / ICON LIBRARY / CLAUDE SVG-CSS / AI RASTER / AI VECTOR / STOCK / ILLUSTRATOR | Subject brief (1-2 sentences) | Aspect ratio + rendered CSS width at 390 / 768 / 1440 | Export sizes (1x and 2x px) | Format (SVG / AVIF+WebP / PNG with transparency) | Weight budget (KB) | LCP candidate (yes/no) | Alt text draft, or alt="" if decorative | Priority P1-P3 | Tag: needs redesign / execution fix
   Rules: icons come from ONE library unless none fits; abstract backgrounds, patterns, dividers and simple empty-state art default to CLAUDE SVG-CSS; photos and complex illustration default to AI RASTER; anything showing the product or a brand it generated defaults to REAL SCREENSHOT. Tag "execution fix" for problems fixable without design decisions (missing alt, oversized file, missing width/height, wrong format, no srcset, lazy-loaded hero); tag "needs redesign" for new or replaced imagery.
4. Totals: slots per source type, and an estimated generation count (AI slots x 3 candidates).

Write for a reader who has not seen your tool calls. Put key points first, use plain words and full sentences, and define any term you introduce. Do not stop while routes in the inventory remain unreviewed. Close with a recap: image slots by source and priority, and anything you could not review.
```

## Prompt 2: Motion and interaction

**Model:** Fable 5.2, high effort, new session.

```plain
You are running pass 2 of a read-only design audit. Read design-audit/README.md (including Direction and "Rules for audit sessions") and design-audit/00_inventory.md first. Skim the executive summary of design-audit/01_experience_review.md only to avoid duplicating it. Output: design-audit/02_motion_interaction.md.

Scope: animation, transitions, micro-interactions, feedback timing, hover/press/focus/disabled behaviour, loading and skeleton behaviour, optimistic UI, scroll behaviour, gestures on touch widths, and perceived performance. Do not re-review static visual design. Judge how much motion is right against the Direction in README.md.

Skills and tools, in this order
1. Use Emil Kowalski's review-animations skill to review existing animations against his rules (easing, duration, which properties animate, origin, interruptibility).
2. Use improve-animations to produce prioritized improvement plans, and find-animation-opportunities to identify where motion would help and where it should NOT be added. Both are read-only here: have improve-animations write its plans into design-audit/animation-plans/ (not into plans/ at the project root), never use its "execute" mode, and do not use the animate skill.
3. Use animation-performance on any animation that janks or animates layout properties. Diagnose only; do not apply fixes.
4. Verify in the running app: in the Browser pane, trigger every interaction listed in 00_inventory.md at 390 and 1440 widths, including hover, keyboard focus, press, disabled, form validation, modal/drawer open and close, toasts, route changes and loading. Read the related component code for exact durations and easings.
5. Check that every animation respects prefers-reduced-motion.

Rules
- Run the seed reset from README.md before you start, and again after you test anything destructive (delete, cancel, downgrade). Never start a real AI generation: to see generation and loading behaviour, use the delay and mock recipes in README.md.
- Only create or change files inside design-audit/. Save evidence (screenshots, or short descriptions of what you observed) under design-audit/evidence/annotated/<finding-id>.png.
- Save as you go: add findings to 02_motion_interaction.md after each route or component.
- Give me a one-line update every few tool calls.

Findings use IDs M-001, M-002, ... and these fields: screen/route, state and width; category (motion | feedback | interaction state | performance); severity P0-P3; tag (needs redesign | execution fix); what's wrong; why it matters; suggested direction (give concrete values where you can, e.g. duration, easing curve, which property); evidence; systemic yes/no.

Add a section "Proposed motion tokens": duration scale, easing set, and rules for when to animate. Pass 3b will use it for the design-system spec.

Write for a reader who has not seen your tool calls. Put key points first, in plain full sentences. Do not stop while interactions in the inventory remain untested. Close with a recap of counts and gaps.
```

## Prompt 3: Accessibility and technical quality

**Model:** Fable 5.2, high effort, new session.

```plain
You are running pass 3 of a read-only design audit. Read design-audit/README.md (including Scope and "Rules for audit sessions") and design-audit/00_inventory.md first. Output: design-audit/03_accessibility_technical.md.

Signing in (do this first)
Chrome DevTools MCP drives its own Chrome window. It is separate from the Browser pane and starts signed out. Sign in there with the test accounts (README.md says how; the passwords are in design-audit/.audit-credentials) before you audit any signed-in route. After every Lighthouse run and every trace, check which page was actually measured. If it was the login screen or a redirect, discard that result, sign in again and retry. If a route still cannot be measured while signed in, list it under gaps. Never report a login-page score as that route's score.

Skills and tools, in this order
1. Chrome DevTools MCP: for every route at mobile and desktop emulation, run lighthouse_audit (accessibility, best practices). For the 3 most important routes, record a performance trace against the production build described in README.md (not the dev server, whose numbers are misleading) and report LCP, INP and CLS with the insights. Save reports to design-audit/evidence/lighthouse/ and design-audit/evidence/traces/.
2. Use the design plugin's accessibility-review skill to audit each route. It targets WCAG 2.1 AA, so also check these WCAG 2.2 AA criteria explicitly: 2.4.11 Focus Not Obscured, 2.5.7 Dragging Movements, 2.5.8 Target Size (Minimum), 3.2.6 Consistent Help, 3.3.7 Redundant Entry, 3.3.8 Accessible Authentication.
3. Do the manual checks that automated tools miss, in the Browser pane: a keyboard-only walk of every main flow (tab order, visible focus, focus traps in modals, Escape to close), focus moving to errors and new content, 200% zoom and 320px reflow, and color contrast of text, icons and focus rings in every state, including hover and disabled (and in dark mode, if the app has one). Measure contrast: read the computed colors and calculate the ratio. Do not estimate it by eye.
4. Use the web-design-guidelines skill on the shared component files and the main page files, and report code-level issues as file:line plus the component name.
(If the axe MCP server is connected, you may use its analyze tool. Do not run any axe command that remediates or edits files.)

Rules
- Run the seed reset from README.md before you start. Never start a real AI generation.
- Only create or change files inside design-audit/.
- Save as you go: add each route's results to 03_accessibility_technical.md when that route is done.
- Give me a one-line update every few tool calls.

Findings use IDs A-001, A-002, ... with the same fields as pass 1, plus "WCAG criterion" (number and level) or "Lighthouse/trace metric" where relevant. Severity: any WCAG AA failure on a primary flow is at least P1. Most findings here will be execution fix; tag needs redesign when the fix changes visual design (e.g. the palette fails contrast, or targets need a new layout).

Write for a reader who has not seen your tool calls. Put key points first, in plain full sentences. Do not stop while routes remain unchecked. Close with a recap: counts by severity, Lighthouse scores per route, and gaps.
```

## Prompt 3b: Design-system audit and spec

**Model:** Fable 5.2, high effort, new session. This pass mostly reads code and earlier files, so it uses little context.

```plain
You are running pass 3b of a read-only design audit: the design-system audit and specification. Read design-audit/README.md (including Direction), 00_inventory.md (design-system map), 01_experience_review.md (design-system symptoms), 02_motion_interaction.md (proposed motion tokens) and 03_accessibility_technical.md (contrast and target-size findings). Output: design-audit/05_design_system.md.

Purpose: Claude Design will build an improved design system from this file BEFORE any screen is redesigned. Describe the system the app needs, not individual screens.

Skills and tools, in this order
1. Use the design plugin's design-system skill in audit mode on the codebase, and include its score.
2. Measure drift from code: count the distinct values actually used for color, font size, weight, line height, spacing, radius, shadow, z-index, breakpoints, durations and easings. List hardcoded values that bypass tokens, with counts and file:line examples. List duplicated components (e.g. several button implementations).
3. Use the existing screenshots in design-audit/evidence/screens/ as visual evidence. Open the Browser pane only to confirm computed styles where code is ambiguous (e.g. a button's padding and colors in each state).
4. Use the frontend-design skill as a lens on whether the visual identity is distinctive or templated. Do not write code or produce designs.

Rules
- Only create or change files inside design-audit/. Never start a real AI generation.
- Save as you go: write each required section to 05_design_system.md as soon as it is ready.
- Give me a one-line update every few tool calls.

Required sections
1. Verdict: "refresh" (keep the structure, change values and components) or "rebuild" (new token architecture or new visual identity), with evidence and the skill score.

2. Current state: one table per foundation (color, typography, spacing, radius, elevation, layout/grid/breakpoints, iconography, motion): what exists, distinct values in use, problems, evidence.

3. Target specification:
   a. Token architecture: primitive tokens (raw values) -> semantic tokens (roles such as surface, text-muted, border, accent, danger) -> component tokens where needed. Propose names.
   b. Color: semantic roles for light mode, and dark mode if the app has or needs it. List every text/background and icon/background pair with its WCAG AA contrast ratio. Calculate the ratios with a small script saved in design-audit/tools/; never estimate them. Where a value is still a candidate, give the ratio for each candidate and the minimum that role must meet.
   c. Typography: families, and a type scale (size, line height, weight, letter spacing per step) with the UI role each step serves.
   d. Spacing, radius and elevation scales; layout grid and behaviour at 390 / 768 / 1440.
   e. Motion tokens from 02_motion_interaction.md, plus reduced-motion rules.
   f. Components: one row per shared component (button, input, select, checkbox, modal, drawer, toast, table, card, nav, tabs, badge, avatar, empty state, skeleton, etc.) with variants, sizes, and required states: default, hover, focus-visible, active, disabled, loading, error, selected. Mark each as exists / missing / duplicated.
   g. Patterns: empty, loading, error, success feedback, form validation, destructive confirmation, long lists.
   For choices that are a matter of taste (accent color, typeface, density), give two options with trade-offs and mark them "decide in Claude Design". Both options must fit the Direction in README.md. Do not pick a final brand look.

4. Keep / change / remove: what already works and must survive.

5. Migration map: old value or component -> new token or component, so implementation can replace them systematically. Name the component or function as well as the file, because the code will be restructured before implementation.

6. Validation set: 4-5 real screens (the busiest data screen, a main form, one empty state, one error state, and one screen that shows a generated brand) that Claude Design must rebuild with the new system to prove it works.

7. Findings with IDs DS-001..., same fields as the other passes. Tag "execution fix" when the answer is already clear (e.g. replace 14 hardcoded grays with existing tokens) and "needs redesign" when a visual decision is needed.

Write for a reader who has not seen your tool calls. Key points first, plain full sentences. Do not stop while foundations or components remain unassessed. Close with a recap.
```

## Prompt 4: Merge into Design\_AUDIT.md

**Model:** Fable 5.2, high effort, new session.

```plain
You are merging a design audit into one brief. Read these files in design-audit/: README.md (Direction and Scope), 00_inventory.md, 01_experience_review.md, 02_motion_interaction.md, 03_accessibility_technical.md, 04_image_needs.md and 05_design_system.md. Output: design-audit/Design_AUDIT.md. Only create or change files inside design-audit/. Do not open the app unless you must verify a disputed finding.

This document is the brief for Claude Design (design system first, then screens) and later the checklist for reviewing the implementation, so it must stand alone.

Steps
1. Deduplicate: merge findings that describe the same problem on the same screen. Merge screen-level findings that share a root cause into one systemic finding, and list the affected screens. Keep every source ID (E-, M-, A-, DS-, IMG-) in a "Sources" field so nothing is lost.

2. Link screens to the system: for every screen-level finding that a design-system change will fix, add "Fixed by DS-xxx" and list it under that DS item instead of as separate screen work.

3. Resolve conflicts with these rules, in order:
   a. WCAG AA requirements and measured data (Lighthouse, traces) win over taste.
   b. A design-system-level fix wins over screen-level patches.
   c. Primary-flow screens win over secondary screens.
   d. Motion must respect prefers-reduced-motion and must not slow down a primary task.
   e. If two passes disagree on a matter of taste, do not pick: record both options with their trade-offs, and tag the item needs redesign so Claude Design decides. The Direction in README.md is the owner's and outranks any pass's taste.
   The two verdicts answer different questions (pass 1: product structure; pass 3b: design system), so report them separately and let them differ. Only if the pair makes no sense together (for example, a full structural redesign on top of an untouched design system) say so and recommend a consistent pair.
   Record each resolution in a "Conflicts resolved" table (items, decision, rule used).

4. Rank by: severity first (P0 to P3), then reach (systemic and primary flow before isolated), then effort (low effort first within a tier).

5. Give each merged finding a new ID (D-001, ...), keeping the same fields as the passes, including the tag and evidence paths.

Structure of Design_AUDIT.md
1. Summary for a non-designer: overall verdict, the top 10 issues, and two recommendations with reasons and evidence: (a) product structure: refresh or full redesign; (b) design system: refresh or rebuild. Say in one or two sentences each what the owner is agreeing to in time and risk.

2. Design direction brief for Claude Design: start with the Direction from README.md, unchanged. Then add what the product is, what must feel different, what must stay (things that already work), and the target qualities. Do not prescribe a final visual style; give constraints and goals.

3. Design system: summarize 05_design_system.md (verdict, top changes, decisions marked "decide in Claude Design") and link it as the source of truth. Do not copy the full spec.

4. Imagery: the imagery verdict from 04_image_needs.md in 3-5 sentences; the ART DIRECTION block, unchanged; and a summary table of the P1 and P2 image slots (ID, route, source, purpose, priority, tag). Link 04_image_needs.md as the source of truth; do not copy the full table. Add this note for Claude Design: "Use labelled placeholders for every AI RASTER, AI VECTOR and ILLUSTRATOR slot, keep the IMG-ID in the placeholder label, and report final slot dimensions per breakpoint in the handoff."

5. Claude Design worklist, Part A: design system (do first). The DS-level needs-redesign items, ranked, each with the screen findings it fixes.

6. Claude Design worklist, Part B: screens and exported files (do after the design system is published). Remaining needs-redesign findings, ranked, grouped by screen and flow, with evidence paths.

7. Execution-fix findings, ranked, with file:line and the component or function name where known, including imagery fixes (alt text, image weight, LCP image, layout shift from missing dimensions). This is the implementation worklist. The code will be restructured before implementation, and a later pass uses the names to find each item again.

8. Accessibility and performance acceptance criteria that the redesign and implementation must meet (WCAG 2.2 AA items, Lighthouse and Core Web Vitals targets).

9. Review checklist for the final review: one line per finding, with ID, what "fixed" looks like, and which evidence screenshot to compare against.

10. Conflicts resolved table, and an appendix mapping each D- ID to its source IDs.

Write for an intelligent but low-context reader. Put the key points first, use plain words and full sentences, and define any term. Close with a recap: counts by tag and severity, and anything left unresolved.
```

**Checkpoint (you):** read section 1 of Design\_AUDIT.md before you close the session. If you agree with the two verdicts (product structure, design system), go on to Prompt 5. If not, say what you disagree with and let the session revise the file. This is also the moment to remove the deny rules from .claude/settings.local.json and start the code cleanup; it can run while you work in Claude Design.

## Prompt 5: Build the design system (Claude Design)

**Where:** Claude Design, inside Claude, not the standalone claude.ai/design (it closes December 14, 2026). Build it as a design system so later projects, and Claude Code, can use it.

**How to start, depending on the verdict in Design\_AUDIT.md section 1(b):**

- **Refresh:** in Claude Code, run /design-login once to connect your account, then /design-sync to import your current system from the codebase (the first sync checks every component, so it can take a while), then open it and use Remix to change it with the prompt below.
- **Rebuild:** start a new design system without importing current values, so the old look doesn't anchor it. Attach the files below, plus 3-5 reference screens (from Mobbin or Refero) if you have them.

**Attach:** 05\_design\_system.md, Design\_AUDIT.md sections 1-3, and a handful of current screenshots from evidence/screens/.

```text
I'm improving my web app's design system before redesigning any screens. Attached: 05_design_system.md (the audit and target spec; it is the source of truth), Design_AUDIT.md sections 1-3, and screenshots of the current app [plus reference screens].

1. Read the spec. List every decision marked "decide in Claude Design", recommend one option for each that fits the design direction in Design_AUDIT.md section 2, with a one-line reason, and wait for my answers.

2. Build the design system to the spec: primitive and semantic tokens; color roles for light [and dark] mode; type scale; spacing, radius and elevation; grid and breakpoints; motion tokens with reduced-motion rules; every component in the spec with all its variants and states (default, hover, focus-visible, active, disabled, loading, error, selected); and the patterns (empty, loading, error, validation, destructive confirmation).

3. Verify that every text/background and icon/background pair meets WCAG AA contrast, and list the ratios. Calculate each ratio from the actual color values; do not estimate it.

4. Prove it works: rebuild the validation screens from section 6 of the spec at 390 and 1440 wide, using only the system. Keep the same data, actions and states as the real screens; do not invent features. Wherever a screen needs something the system lacks, add it to the system rather than making a one-off, and list what you added.

5. Finish with a change log mapping each change to its DS- ID.
```

When you're happy with the validation screens, publish the system (or set it as the default) so every later project uses it. Then save an image of each approved validation screen into design-audit/approved/ in your project folder (export it from Claude Design, or ask Claude Code to bring the design in with /design).

## Prompt 6: Redesign the screens (Claude Design)

**Where:** a new Claude Design project with your published design system attached. **Attach:** Design\_AUDIT.md (sections 1, 2, 4, 6 and 8) and the screenshots listed under the Part B items.

```text
Redesign the screens of my web app using the Embel Design System (https://claude.ai/artifact/NrcVPniQFUPdtrBBtY9V8J). Attached: Design_AUDIT.md and the current screenshots for each Part B item.

Rules
- Use only the Embel Design System (https://claude.ai/artifact/NrcVPniQFUPdtrBBtY9V8J). If a screen needs something new, add it to the system first and tell me.
- Work through the Part B worklist (section 6) in ranked order, and say which D- IDs each screen addresses.
- Keep the same data, actions and states as the real screens; do not invent features.
- For every screen, show the states that apply: default/populated, empty, loading, error, and key modals or drawers, at 390 and 1440 wide, and at 768 where the layout changes.
- For image slots, use labelled placeholders that keep the IMG-ID in the label. Use real product screenshots where the Imagery section says REAL SCREENSHOT.
- Meet the acceptance criteria in section 8.

When done, list for each screen: the D- IDs addressed, anything left unresolved, and the final image slot dimensions at each breakpoint (for the asset step).
```

**Done (Nov 13).** `design-assets/handoff.md` and `design-audit/approved/` are in the repo. Approved screens are named `<route>__<state>__<width>.png` with the same route names as `evidence/screens/`; most states changed in the redesign, so compare by route and width rather than by identical file name.

**If you change the designs again** in Claude Design, ask Claude Code to "re-export the approved screens from the Claude Design canvas into design-audit/approved/ and update design-assets/handoff.md", before running the next prompt.

**What Prompt 6 decided** (recorded in handoff.md and the design system; later prompts must treat these as approved):
- At 1024 px and up, every project-conversation screen is a side chat: the chat in a floating panel on the left (resizable 320 to 560 px, can be hidden), the work on the right, filling the window. Below 1024 px the conversation stays one column.
- Send in the reply box is the one way forward: chosen options sit in the reply box as chips, Send starts the work or moves to the next step, and Stop replaces Send while Embel works. No Continue or Explore buttons.
- Logo concepts are chosen by clicking the picture (no label row or Choose button); six concepts or three directions fit the window; a chosen result keeps its size and shows the ring only.
- Name step: compact name cards, 40 per batch; name details open over the work area with Domains (extensions, tweaks, filters, sort, registrar prices), Handles and Trademarks tabs.
- The current journey step has no fill. Domain prices are an exception to "credits, never money".
- Also decided Nov 13: results shrink while the chat is widened (chat 320 to 560 px); the fuller transitions.dev drawing effect is used for logo concepts; Stop is in the reply box at every width; direction cards stay as designed.
- Open for the owner: D-024, D-036, the third Home example image, and whether text choice cards keep their tick.

## Prompt 7: Image asset production

**Model:** Sonnet 5.5, high effort, new session in Claude Code on the design-audit branch, after Claude Design and before implementation. No MCPs needed: the imagery pass found no AI RASTER or AI VECTOR slot (0 images to generate), and icons come from the design system's Lucide set. Assets are saved in design-assets/ only; implementation moves them into the app.

```text
You are the asset producer for this app. Inputs: design-assets/handoff.md (final slot sizes, decisions and open items from Claude Design; read it first), design-audit/Design_AUDIT.md (Imagery section), design-audit/04_image_needs.md, the approved screens in design-audit/approved/, and the published Embel design system (https://claude.ai/artifact/NrcVPniQFUPdtrBBtY9V8J; its README and components/MediaFrame, ChoiceCard and NameList pages). No image generation is needed: 04_image_needs.md has no AI RASTER or AI VECTOR slots.

Rules
- Only create or change files inside design-assets/ and design-audit/. Do not copy assets into the app or wire them into components; that happens in implementation.
- Run the seed reset from design-audit/README.md before you open the app. Never start a real AI generation, and never generate images with any tool.
- Give me a one-line update every few tool calls.

Steps
1. Update 04_image_needs.md from handoff.md: copy in the final slot sizes at 390, 768 and 1440; list every slot whose size, source or purpose changed since the audit; and mark the slots now covered in code ("covered by the design system, built in implementation", naming the class or canvas board): IMG-006 dot background, IMG-018/019 logo tiles and the drawing state (e-media--inset, e-media--drawing, e-media--reveal), IMG-022 to IMG-025 brand board and social templates (canvas page 5), IMG-004/010 icons (Lucide set in the design system). Stop and ask me if a P1 slot is ambiguous.
2. REAL SCREENSHOT slots that need a static file:
   - IMG-007 and IMG-008 (Home examples, 4:3): crop direction boards of the showcase brands in the local app (Kestrel Analytics and Orchard Lane Cider) with Playwright at 2x. The third example is a placeholder awaiting my approval: list it as open, do not fill it with a test brand.
   - IMG-003 (share image, 1200 x 630): build it to match design-audit/approved/share-image__*.png, using real showcase images, and render it at 1200 x 630 and 2400 x 1260.
   Check every crop at 390, 768 and 1440 against the approved screens, and show me the candidates before optimizing.
3. Save originals to design-assets/source/IMG-###_<slug>_v<n>.png, and optimized files to design-assets/optimized/IMG-###_<slug>-<width>.avif and .webp, at the 1x and 2x widths from handoff.md, within each slot's weight budget in 04_image_needs.md.
4. Icons: confirm every icon the approved screens use exists in the design system's Lucide set (the icons it defines in components/bundle.css), and list any that are missing. Record the licence (ISC).
5. Write design-assets/manifest.md: ID, files, source, capture date, alt text (or alt=""), LCP flag, and for each slot covered in code, the design-system class or canvas board that defines it. Add a contact sheet of the captured assets.
6. Add an "Implementation notes" section to manifest.md:
   - The logo "drawing" effect (approved): the frame, handles and labels are CSS in the design system; the reveal uses the script from transitions.dev's Generative effect skill ("image" variant). Record its source, version and licence (use in the product is allowed; do not redistribute the library).
   - Domain prices in name details: the registrar's price in USD, per year, comes from the domain provider at check time and is not a static asset.

Close with a recap: slots done, slots covered by code, and anything left open (at least the third Home example, and D-024 and D-036 from handoff.md).
```

## Implementation, re-capture and review

**Before you start.** Four things must be true. The deny rules are removed from .claude/settings.local.json. The code cleanup is finished. The cleaned-up code sits on the same git branch as the design-audit/ and design-assets/ folders; ask Claude Code to "bring the design-audit branch and the cleaned-up code together on one branch, and tell me if anything conflicts". And you have decided the open items listed in design-assets/handoff.md (D-024, D-036, the third Home example, and the text choice cards' tick), or you are happy for implementation to skip them.

### Prompt 7b: Refresh file references

**Model:** Sonnet 5.5, high effort, new session. Run it after the code cleanup and before implementation. The audit recorded where things were in the old code; this pass points it at the new code. If it reports that many screens look different after the cleanup, tell Prompt 9 to use evidence/post-cleanup/ as its "before" set.

```text
You are updating a finished design audit after the application code was restructured. The audit's findings are still valid; only their file references may be out of date. Read design-audit/README.md, design-audit/Design_AUDIT.md (sections 7 and 9), design-audit/05_design_system.md (migration map), design-audit/00_inventory.md (design-system map) and design-assets/handoff.md. Output: design-audit/07_reference_refresh.md, plus corrected references inside Design_AUDIT.md and 05_design_system.md.

Rules
- Only create or change files inside design-audit/. Do not change application code.
- Change references only. Do not rewrite, re-rank, add or remove findings.
- Run the seed reset from README.md before you open the app. Never start a real AI generation.
- Give me a one-line update every few tool calls.

Steps
1. Check that README.md still works: the commands to start the app, build it and reset the seed data. Correct the README where they changed.

2. For every file:line reference in Design_AUDIT.md section 7 and in the migration map of 05_design_system.md, find where that component, function or value lives now (use the names recorded next to each reference) and correct it. Mark an item "already fixed by the cleanup" if the problem is gone, and "not found" if you cannot locate it.

3. Run design-audit/capture.mjs into design-audit/evidence/post-cleanup/. If the cleanup broke the script (changed routes or labels), fix the script and keep the same file names. Compare at least one screenshot per route with design-audit/evidence/screens/ and list every screen that looks different.

4. Map the code to the redesign: for each "decision" in design-assets/handoff.md (side chat at 1024 px and up, Send as the only way forward, chips and Stop in the reply box, click-to-choose logo concepts, results fitted to the window, compact name cards, name details with Domains/Handles/Trademarks), name the components, routes and API calls it touches now, and say whether today's API already supports it (for example: domain checks across many extensions, tweaks and prices; YouTube-only handle checks; EU-only trademark search).

5. Write 07_reference_refresh.md with: counts (references updated, already fixed, not found); the screens whose look changed, and what changed; new components or duplicates the cleanup introduced that the design system must cover; the map from step 4; and anything the owner must decide.

Close with a short recap.
```

### Implementation prompt

**Model:** Fable 5.2 at high effort, or Opus 5.5 at high effort with /advisor fable to save Fable usage. New session. The session stops after each of the five phases so that you can look at the app before it goes on.

```text
You are implementing an approved redesign of this web app. Read, in this order: design-audit/README.md; design-assets/handoff.md (the decisions made in Claude Design after the audit, the D- IDs per screen and the open items: these decisions are approved and override older wording in the audit); design-audit/Design_AUDIT.md (sections 3, 7, 8 and 9); design-audit/05_design_system.md (target specification and migration map); design-audit/07_reference_refresh.md; design-assets/manifest.md; and the approved screens in design-audit/approved/. The design system is "Embel Design System" (https://claude.ai/artifact/NrcVPniQFUPdtrBBtY9V8J): its README, component pages and changelog are the reference for every class, token and state. Bring it into this project with /design-sync, and ask me if you cannot reach it. The clickable prototype of the desktop journey is page 9 of https://claude.ai/artifact/M4MG9CqZoWu2KeWb1u8wca.

Rules
- Work on a new git branch called redesign, created from the branch that holds the cleaned-up code and the design-audit/ folder. Commit after each phase. Never push or deploy; I do that.
- Change how the app looks and responds, not what it does. Do not change features, data, routes, API calls, authentication, payments or legal text. If a design seems to need a change in behaviour, stop and ask me.
- These interaction changes are already approved (handoff.md, "Decisions"), so build them without asking: the side chat at 1024 px and up (resizable and hideable, width and hidden state remembered for the person); Send as the one way forward, with chosen options as chips in the reply box and Stop replacing Send while Embel works (remove the Continue and Explore buttons); click-to-choose logo concepts; results sized to fit the window; compact name cards with 40 names per batch; name details opening over the work area; the current step with no fill.
- These need my go-ahead because they need new data or provider work: domain search across many extensions, tweaks, filters, sort and registrar prices; handle checks beyond YouTube; trademark search beyond the EU; and any open item in handoff.md. The fuller drawing effect is approved: add the transitions.dev Generative effect script for it (record its licence), and ask me only if it needs a new dependency. Build their screens with what the API supports today, and list the rest.
- Build what the approved screens show. Where they are silent (a state or screen that was not designed), apply the design system and list the gap. Do not invent a new look.
- Do not add a dependency without asking me first.
- Run the seed reset from design-audit/README.md before you start. Never start a real AI generation; use the recipes in README.md.
- Keep design-audit/08_implementation_log.md up to date: one line per D- ID and per handoff decision with its status (done / partly / skipped, and why) and the files touched.
- Give me a one-line update every few tool calls.

Phases (in this order; stop after each one and wait for my go-ahead)
1. Tokens: add the new primitive and semantic tokens, and replace old values using the migration map. No component or layout changes yet.
2. Shared components, with every state in the spec (default, hover, focus-visible, active, disabled, loading, error, selected), replacing duplicates as the migration map says. Include the components added in Claude Design: Workspace (side chat, resize handle, hide and show, work-area overlay), Name list, the artwork-only choice tile, the Drawing media state, and chips and Stop in the reply box.
3. The conversation layout: the side chat at 1024 px and up and the Send-only flow, across every journey step (Competitors, Audience, Positioning, Personality, Name, Slogan, Inspiration, Logo, Creative direction, the finished brand). Check it against the prototype.
4. Screens: the Part B worklist of Design_AUDIT.md in ranked order (using handoff.md's D- IDs per screen), then the execution-fix list in section 7.
5. Images: move the assets from design-assets/optimized/ into the app as the manifest describes (picture elements with AVIF/WebP and srcset, explicit width and height, no lazy-loading on the LCP image, alt text from the manifest).

At the end of every phase
- Run the project's build, type check, lint and tests, and fix anything you broke.
- Run design-audit/capture.mjs into design-audit/evidence/phase-<n>/. If the new interface breaks the script (for example the Continue buttons it clicks are gone), fix the script (same file names); never bend the interface to fit the script. Look at the screenshots of the screens you touched at 390 and 1440, compare them with design-audit/approved/ (by route and width; the side-chat screens there show one 1440 x 900 window), and fix visible differences.
- Commit. Then tell me in plain words what changed, which D- IDs and decisions are done, what you skipped and why, and what I should look at in the app.

Do not stop inside a phase while its work remains, except to ask about a behaviour change or a new dependency. Close with a recap: D- IDs by status, and open questions.
```

### Prompt 8: Re-capture the "after" screenshots

**Model:** Sonnet 5.5, new session. The implementation already kept capture.mjs working, so this is one clean final run.

```text
Run the seed reset from design-audit/README.md, then run design-audit/capture.mjs with the output folder design-audit/evidence/after/. For states that can't be scripted, follow the manual steps documented in design-audit/00_inventory.md and save those screenshots with the same file names. If the script fails because the interface changed, you may fix design-audit/capture.mjs (keep the same file names, and list what you changed). Never change the app or any other file, and never start a real AI generation. If a route or state no longer exists, list it and continue. Open a sample of the new screenshots and confirm that none shows the login screen by mistake. The desktop conversation is now a side chat whose panes scroll on their own: for those screens, also save a 1440 x 900 window capture (not full page) named with "-window" before ".png", to match design-audit/approved/. When done, list every screenshot in evidence/screens/ that has no matching file in evidence/after/, and why.
```

### Prompt 9: Review

**Model:** Fable 5.2, high effort, a fresh session (not the implementation session, so the check is independent).

```text
You are reviewing the implemented redesign against the plan. Read design-assets/handoff.md (the decisions made in Claude Design after the audit; they are approved and override older wording in the audit), design-audit/Design_AUDIT.md (especially section 9, the review checklist, and section 8, the acceptance criteria), design-audit/05_design_system.md, design-audit/07_reference_refresh.md, design-audit/08_implementation_log.md and design-assets/manifest.md. The design system is https://claude.ai/artifact/NrcVPniQFUPdtrBBtY9V8J and the clickable prototype of the desktop journey is page 9 of https://claude.ai/artifact/M4MG9CqZoWu2KeWb1u8wca. Output: design-audit/06_review.md. Only create or change files inside design-audit/; do not fix anything. Run the seed reset from design-audit/README.md first, and never start a real AI generation.

1. For every line of the review checklist, and for every decision in handoff.md, compare the "before" screenshot in evidence/screens/ with the "after" screenshot in evidence/after/ and the approved design in design-audit/approved/. Approved files are named by route, state and width; match them by route and width, not by identical file name. Mark each D- ID as fixed, partly fixed, not fixed or regressed, with one line of evidence. Check each item yourself; do not rely on the implementation log's status.
2. Check the design system was applied: search the code for hardcoded colors, font sizes, spacing, radii and shadows that bypass tokens, and confirm every component state in the spec exists. Report file:line.
3. Check images against the manifest: right asset in each slot, crops at 390, 768 and 1440, alt text, and consistent style.
4. Re-run Chrome DevTools lighthouse_audit and the performance traces from pass 3 on the same routes, and compare scores and LCP, INP and CLS with the earlier reports. Chrome DevTools MCP uses its own Chrome window, which starts signed out: sign in there with the test accounts first, and discard any result that measured the login screen.
5. Walk the main flows in the Browser pane with the keyboard only, and check focus, reduced motion and contrast against section 8. Calculate contrast from the computed colors; do not estimate it.
6. Behaviour check: the redesign was meant to change how the app looks, not what it does, apart from the interaction changes approved in handoff.md (side chat, Send as the one way forward, chips and Stop in the reply box, click-to-choose logo concepts, 40 names per batch, name details over the work area). Confirm that the main flows, routes and features work as they did before, walk the desktop journey against the prototype, and list anything that behaves differently beyond those approved changes.

Put a short verdict first: is it ready to ship, and what must be fixed first. Then a ranked fix list, tagged "implementation fix" or "needs design decision". Close with counts by status.
```
