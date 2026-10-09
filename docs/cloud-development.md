# Codex Cloud development handoff

## Authorized scope — 2026-10-09

The user requested moving this local project into Codex Cloud and approved the proposed private repository, cloud environment setup, verification and new cloud chat handoff. Keep the local checkout available. This is development-environment setup, not a production release, provider activation or approval for additional app inference costs.

The private repository is `mikaelcharbonneau/emble`; the product remains **Fluid**. Its existing checkpoint `b31570281f25e9ae74b3676f480578115a533b1c` was identified by matching 1,230 local file hashes and confirming that it contained no remote-only files. Git metadata was restored in the existing checkout without replacing source files. Do not import other Fluid implementations.

## Environment setup

Use the private **emble** environment for this repository's `main` branch. Node.js 24 (`.nvmrc`) and the committed npm lockfile are required. The project has native dependencies, so install them for the cloud host; do not upload the Mac's `node_modules`.

For a fresh environment, the general installation commands are:

```sh
npm ci
npx playwright install --with-deps chromium
```

The first command is sufficient for ordinary unit tests, type checking and builds. The second installs the headless browser and Linux libraries when the host permits that installation. Neither uses the user's browser profile.

The verified **emble** cloud image already provides `/usr/bin/chromium` and its Linux libraries. Its saved install script runs `npm ci --cache /workspace/.npm-cache`, checks Node 24 and system Chromium, and writes the ignored `.tmp/onboarding.playwright.config.ts` override. That override imports the repository's normal Playwright configuration, sets the test and server working directories to `/workspace/emble`, and selects `/usr/bin/chromium`. Use this tested setup in the existing environment; do not repeat browser downloads or request root installation unnecessarily.

Environment variables:

```text
APP_ORIGIN=http://127.0.0.1:3105
FLUID_PAID_CALLS_APPROVED=false
NEXT_TELEMETRY_DISABLED=1
```

Start the ordinary development interface with `npm run dev` (loopback port 3105). Do not automatically run `npm run local`: that launcher expects the original Mac's protected worker/OAuth configuration. Do not start `npm run worker` during initial cloud setup. The dedicated worker is a separate process and intentionally refuses work without its approved provider policies and database identity.

Account integrations may remain unavailable in the cloud environment. Optional public Supabase configuration uses `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`; obtain it through the authorized environment configuration when needed. Do not copy local environment files, browser cookies, `.local-fluid`, Vercel credentials, privileged database credentials or API keys. A development environment does not inherit the local machine's service permissions.

Allow package registries and Playwright's required official browser-download destinations through the environment's normal network settings. If downloads are blocked, record the exact destination and use the supported settings flow; do not bypass the proxy or certificate checks. No new database, migration, credentials, paid policy or deployment is required for initial setup.

## Verification commands

Run checks sequentially on a memory-constrained VM. The explicit heap allowance avoids the historical 1 GiB TypeScript failure:

```sh
NODE_OPTIONS=--max-old-space-size=4096 npm run typecheck
npm run lint
npm test -- tests/client/home-concept.test.tsx tests/client/home-inputs-integration.test.ts tests/client/home-strategy-session.test.tsx tests/domain/ideas.test.ts tests/server/ideas.test.ts --maxWorkers=1
npm test -- tests/database/logo-five-operation-host.test.ts tests/database/ideas.test.ts tests/api/ideas.test.ts --maxWorkers=2
NODE_OPTIONS=--max-old-space-size=4096 npm run build
FLUID_E2E_PORT=3145 npm run test:e2e -- --config .tmp/onboarding.playwright.config.ts tests/e2e/ideas.spec.ts tests/e2e/home-recovery-lifecycle.spec.ts --workers=1
```

The browser suite starts its own production server after the build. Leave `FLUID_E2E_BROWSER_CHANNEL` unset in cloud. The existing environment uses its saved system-Chromium override; a fresh environment that successfully installed Playwright's bundled Chromium can omit the `--config` argument. The Mac-only fallback used during local verification selects installed Chrome. Do not run development and build commands concurrently against the same `.next` directory.

Fixture tests do not establish live Supabase ownership, provider access or production readiness. The full historical checkpoint status is in `docs/verification-status.md`; more recent Home/Ideas evidence is in the design records. Record new cloud results separately from local results. A broader suite can use `npm test -- --maxWorkers=2` when the task requires it; do not run `test:live` without its explicit opt-in and approved identities.

## Product and design context

Read `AGENTS.md`, `docs/decisions.md`, `docs/architecture.md` and `README.md` before implementation. Home Concept 22 is the approved design source; details and tokens are in `docs/home-concept-22.md`. The implemented Ideas library and detail designs are documented in `docs/ideas-design.md` and `docs/idea-detail-design.md`.

- [Wonder home concepts](https://app.wonder.so/fluid/files/01a11dfe-6aa3-7091-98fe-2fad32cf9fc0/branches/main/pages/01a11dfe-6aa5-743e-bddf-2597d8f3b1ae): Concept 22 artboard `was`.
- [Wonder Workspace screens](https://app.wonder.so/fluid/files/01a11dfe-6aa3-7091-98fe-2fad32cf9fc0/branches/main/pages/01a11ed5-9795-737b-b0ba-404021959e88): Ideas `psp`, Idea Detail `hod`, original Domains `vip`.
- Latest design-only variation: **Page - Domains - Advanced Search**, artboard `sum`, positioned left of `vip`. It includes bulk keywords/domains, CSV/import-from-Names, extension selection, prefix/suffix and transformation controls, budget/premium/availability filters, selectable results, shortlist/export/share actions. Its displayed results are illustrative and marked unchecked. This variation has not been implemented in the app.

Keep the collapsed sidebar, black active-edge marker, Geist typography, neutral/magenta palette, 16 px grid, approved app mark, and restrained corner radii. Preserve manual Ideas persistence, immutable revisions, account-generation fencing, conflict recovery and explicit brand conversion. Other screens in Wonder remain proposals unless subsequently approved. Original design snapshots and screenshots in ignored `.references` and `output/playwright` are local evidence, not available automatically in cloud.

Cloud's documented lack of interactive computer/browser use does not remove the repository's headless automated test commands. Wonder editing and access to the user's signed-in browser remain local tasks unless an authorized cloud connector is actually available. Do not claim visual comparison without the reference.

## First cloud chat

Use GPT-6 Astra with Max reasoning, as required by the current root instructions. Suggested initial request:

> Continue Fluid in this cloud environment. Read AGENTS.md, docs/cloud-development.md, docs/decisions.md, docs/architecture.md, README.md and the Home/Ideas design records. Verify the checked-out revision and report environment readiness and the remaining product gaps. Keep the app's approved design and ownership boundaries. Do not activate paid inference, copy Mac credentials, apply migrations or deploy. Do not begin a new feature until we choose the next task together.

## Setup evidence — 2026-10-09

Local verification on the original Mac, Node.js 22.22.2 (within the package's supported range):

- TypeScript checks passed with the 4 GiB heap allowance.
- Lint exited successfully with no errors; two warnings came from ignored local Playwright fixture scripts, which are not part of the repository upload.
- 145 Home/Ideas client/domain/server checks passed in five files.
- 61 Ideas API/database and logo-host boundary checks passed in three files.
- The production build passed.
- All 50 Home/Ideas browser checks passed across desktop/mobile using the isolated installed-Chrome fallback. The automated browser's fixtures do not represent live account/provider acceptance.
- The Git upload inventory excludes local environment files, runtime credentials, design-reference caches, screenshots and Vercel authentication. Credential-pattern candidates were limited to existing placeholder/test values.

This is a focused local verification, not a new complete suite or Linux/Node 24 cloud verification. It does not erase the older checkpoint's verification limits.

The initial web setup attempt could not load GitHub connections or saved environments. That historical blocker was cleared when the user subsequently created **emble** and completed the setup chat below.

## Cloud setup verification — 2026-10-09

Reviewed the actual command results in [Set up emble](https://chatgpt.com/local/01a12287-cf81-700c-bf28-49c9d041e0f0), rather than treating the local Mac checks as cloud evidence:

- Repository: `mikaelcharbonneau/emble`, branch `main`, containing the latest Home/Ideas and cloud handoff source.
- Linux runtime: Node.js 24.19.0, npm 11.9.0, system Chromium 151.0.7922.173.
- Typecheck, lint and production build passed. The saved install script was rerun successfully.
- The 145-test Home/Ideas group passed with one worker; the 61-test API/database/host group passed with two workers.
- All 50 desktop/mobile browser checks passed with the system-Chromium override.
- Development and production Home responses were checked; production returned HTTP 200 and the expected Fluid HTML. The source checkout remained clean.
- The cancelled-file-selection test failed once with two workers and passed on its one-worker rerun. Its fixed 10 ms wait is timing-sensitive; the test was not changed, and the earlier failure remains part of the evidence.

The setup's install/start instructions were present in its original draft but not yet saved to the reusable environment. They have now been saved, with **Only me** privacy, package-manager network access, no network secrets, and the non-secret variables shown above plus `PLAYWRIGHT_BROWSERS_PATH=/workspace/.cache/ms-playwright`. Account/provider integrations remain unconfigured. The worker, paid calls, live migrations and public deployment were not activated.

Publication completed and the UI confirmed **Environment published** / **Published**. Select **emble** under **Work in → Cloud** for subsequent coding chats. The application revision qualified in setup was `c5f5930e6d8cb445eb6ec8567ce8e5ea4ae33cd1`; this documentation update does not change application code or its dependencies. Saved environment state is a reusable starting point; future chats should verify their checked-out Git revision before making changes.

## Sources

- [Codex Cloud environments](https://learn.chatgpt.com/docs/environments/cloud-environments): repository setup, installation/start instructions, publication, private environment access and current limitations; checked 2026-10-09.
- [Codex environment modes](https://learn.chatgpt.com/docs/environments/modes): local files, running processes and browser sign-ins do not transfer automatically.
