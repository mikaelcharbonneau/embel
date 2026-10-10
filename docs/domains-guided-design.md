# Domains Guided Browser design

## Approved references — 2026-10-10

The user requested matching these two Wonder screens in the app:

- [Domains A2 — Guided Browser Results](https://app.wonder.so/fluid/files/01a11dfe-6aa3-7091-98fe-2fad32cf9fc0/branches/main/pages/01a11ed5-9795-737b-b0ba-404021959e88?nodeId=ebc13f7f-e281-5a3b-9a90-d2cdf4213688), artboard `nag`.
- [Domains A1 — Guided Browser Filters](https://app.wonder.so/fluid/files/01a11dfe-6aa3-7091-98fe-2fad32cf9fc0/branches/main/pages/01a11ed5-9795-737b-b0ba-404021959e88?nodeId=c0f09566-2161-5dec-b395-59465b4656e7), artboard `box`.

These supersede the earlier Domains Advanced Search variation for this UI request. The exact linked node identities were resolved from the canvas's rendered DOM and matched against Wonder's current artboard inventory. Full current markup and original PNG captures are in ignored `.references/domains-guided-20261010/`. Wonder was read without changing its designs.

## Implementation

- `/domains` uses the shared approved Concept 22 rail, grid, toolbar and account menu.
- The centered title is 40 px. The search card is 800 px wide; the main filter/results area is 1008 px wide. Desktop filters use 160 px category navigation, a flexible extension browser and 288 px preferences column.
- Search text becomes removable chips. Commas, Enter and multiline paste can commit entries; pending text is retained in the existing manual draft. Loaded account text and explicit imports use that same field. No example names are seeded into production.
- Extension categories, search, selection/removal, selected chips, select-all and reset are interactive. The existing maximum of 10 extensions and 20 search entries remains enforced. A successful preparation collapses filters; Edit filters reopens them.
- Results use the reference's name/registrar, price and circular detail action composition. Opening a row retains the existing check, quote, provenance and explicit brand-creation actions. The Library view and account save/load/recovery controls remain available below the primary design.
- Cloud utilities remain available without changing the compact result layout: selection inside row details and select-visible, clear, sequential checks and CSV export under Result actions. CSV prices require current matching one-year quotes. Selection belongs to one search instance; recreating identical input starts fresh. Each check settles independently at 15 seconds even if the adapter ignores cancellation; a bulk sequence has a 60-second overall bound and stops on cancellation/timeout, retaining completed results.
- From name library opens the existing owner-fenced saved-project selector in a dialog. Selecting a project is separate from the explicit import; source provenance, account saves and conflict/session recovery retain their existing contracts.
- The manual draft/API schema remains version 1 with input, extensions and candidates. Display preferences are local to the mounted view; this increment adds no persistence fields or database changes.

## Evidence boundaries

The mockup's prices, registrars and personal identity are illustrative. Runtime rows show actual supplied evidence, or Unknown / Not quoted. Premium classification is unavailable and its switch is disabled. Hide unavailable removes only rows with current verified taken evidence. Price filters and sorting use current one-year USD quotes; unknown, expired or incomparable prices remain visible. No exchange rates or estimated annual prices are invented.

The registrar adapter remains unavailable by default. No provider activation, purchases, paid calls, migrations or credential transfers are included. The subsequent user-approved reconciliation authorizes preserving both versions, publishing one reviewed PR, merging its verified revision, updating both checkouts and deploying that same revision to the existing protected preview.

## Verification

Verification uses dedicated headless browsers and explicit local fixtures. It does not establish live account or provider acceptance. Captures and measurements are in `output/playwright/domains-guided/`; component and account regression evidence is in `.tmp/domains-preview/` and `.tmp/domains-account-preview/`.

At 1440 × 900, the app's search card starts at x=360/y=204 and is 800 × 139.5 px. The expanded filters start at x=256/y=363.5, with width 1008 px. The collapsed results start at x=256/y=423.5 and use 61 px rows. Both 1440 × 900 and 390 × 844 views have no horizontal overflow, browser errors or unexpected requests in the visual fixture.

Completed checks: full typecheck and production build; lint with zero source errors (two existing warnings in ignored earlier Playwright fixture scripts); 88 focused domain/promotion tests; 18 isolated domain browser checks; 13 isolated account-draft browser checks; and six actual-route desktop/mobile checks for preparation, saved-name import and session/sign-out recovery. Provider, API and account replies in these checks are explicitly synthetic. The new saved-name dialog was exercised with the actual Next.js route and project selector, and no save occurs until the existing explicit save action.

Local interface review: `http://127.0.0.1:3152/domains`. Visual capture names are illustrative test input only and are not inserted into the app's storage.
