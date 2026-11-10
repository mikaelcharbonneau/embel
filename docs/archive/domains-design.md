> Archived November 10, 2026: describes the system before the generation engine.

# Domains Advanced Search

This is a historical cloud checkpoint. The approved A1/A2 Guided Browser screens now supersede this presentation; see [current design](domains-guided-design.md). Its original implementation is preserved at `a7ee07047db3ba5c7a183408a6f87bd3e389b8b7`. The reconciliation retains CSV export, transient selection and sequential checks with corrected selection/deadline behavior. Verification and deployment below describe that older snapshot only.

## Design authority — 2026-10-09

The user requested updating Fluid's Domains screen to Wonder's **Page - Domains - Advanced Search**, artboard `sum`, then supplied the exact 1440 × 900 PNG and original reference pack. This is distinct from the older Domains artboard `vip`. Other supplied screens remain references, not additional implementation scope.

- File: `01-page-domains-advanced-search.png`
- SHA-256: `658075d14c55e0abeaab6d0d6a81a3432ce8395d9e21c2c6fb5efce2dba2e910`
- Pack SHA-256: `a9b70e90aaf09eb9072584633ed13431d475b938c0eaeb2c1ccc526d143d67ba`
- Original bytes, manifest, tokens and visual index: ignored `.references/wonder-screen-pack/fluid-wonder-reference-pack/`. All 33 PNG checksums, dimensions and integrity were verified.
- [Wonder Workspace](https://app.wonder.so/fluid/files/01a11dfe-6aa3-7091-98fe-2fad32cf9fc0/branches/main/pages/01a11ed5-9795-737b-b0ba-404021959e88)

## Presentation

`/domains` uses the approved Concept 22 shell: 80 px collapsed rail, black active edge, 76 px toolbar, Geist and the 16 px square grid. Its content is 1152 px wide at 1440 px, starts at x=184/y=116, and uses a 300 px filter column, 24 px gap and 828 px results column. The header, Search/Library tabs, keyword card, candidate table and action footer follow the supplied reference.

Mobile is a responsive adaptation because the pack contains no mobile Domains artboard. Candidate rows become compact stacked rows with full-width details; filters follow the search/results area. Account identity remains real session UI, not the mockup's named person/avatar.

## Functional boundaries

- Existing manual candidate preparation and strict version-1 draft contracts are unchanged. Names use selected extensions; full domains retain their extension. No generated transformations or availability are inferred from the sample rows.
- The keyword field exposes existing comma/newline input as removable chips when idle. Focus reveals the full editable input. Extension search/categories and Reset operate on existing draft fields.
- Row selection is transient, bound to the exact current draft and remounted with the existing account/session fence. CSV export downloads actual selected (or visible) candidates with their current evidence state. No price is exported without a current matching one-year quote.
- Existing bounded availability/quote reads and explicit brand actions are available inside row details. Checking selected domains reuses the same timeout, cancellation and generation fencing, sequentially; the default provider remains unavailable. Hide unavailable removes only domains with current confirmed-taken evidence, never unchecked/unknown results.
- Account save/reload/import/conflict/retry and promotion controls remain below the search. From Names takes an authenticated user to those existing source/import controls. No account API or schema changed.
- CSV import, name transformations, budget/premium filtering, persistent shortlists and private search sharing are depicted but disabled and labelled/title-described as unavailable. This visual update does not implement or claim those capabilities. Library purchase/registration evidence and order distinctions are preserved.
- Example data is used only in isolated browser checks and captures. It is not seeded into the application. The visual update does not activate providers, make paid calls, create credentials, apply migrations or push to Git. The user subsequently authorized the protected preview deployment recorded below.

## Verification

- Full typecheck, full lint, and production build passed.
- 110 focused unit/client checks passed, covering Domains contracts/drafts, standalone account/promotion behavior and Home controls.
- 16 dedicated Domains browser checks and 12 account browser checks passed using system Chromium. These cover preparation, evidence expiry, request cancellation/timeouts, quote/registration distinctions, selection/CSV export, extension discovery, mobile/keyboard use, save/reload, imports, conflict/retry recovery and owner changes. All account/provider evidence is synthetic.
- The initial mobile run found page overflow from absolutely positioned screen-reader content in the scrollable table. The table now contains that positioning, and narrow layouts render responsive rows; the mobile checks pass.
- The account browser suite had an obsolete assertion that the existing saved-result brand action was disabled. The same failure was reproduced with unchanged HEAD source before updating that expectation. Production promotion logic was preserved; the dedicated promotion client tests also passed.
- Final production renders were inspected at 1440 × 900 and 390 × 844. Desktop measurements match the reference: heading x=184/y=116, filter panel x=184/y=212 at 300 × 663, keyword card x=508/y=212 at 828 × 214, candidate table inside its border at x=509/y=495, and 80 px rail. Both viewports have no page-level horizontal overflow or browser errors. Mobile collapsed row actions remain hidden; expanding a row reveals the original actions.
- Captures use manually entered reference examples in an isolated browser, without account mutations or provider calls. Differences from the illustration are intentional: real session identity, accurate exact-domain variation labels, and unavailable controls instead of unimplemented actions appearing enabled.
- This is not live provider or real-account acceptance, nor a full-product validation sweep.

## Authorized Vercel preview — READY

- [Open Domains](https://fluid-platform-preview-i54i0edja-mikael-charbonneaus-projects.vercel.app/domains)
- Existing project: `fluid-platform-preview` (`prj_WKrFUPy3wptZ3qI9l1hTuqPmzkDt`), team `team_f2xtDdokmMW21ByVgpJzIDDV`.
- Deployment: `dpl_3GHifc5uD5DnqxMsdxpw4SpZfbbS`; preview environment; Vercel API confirmed `READY`. Remote preview preflight and Next.js production build passed; remote build duration was approximately 143 seconds.
- Uploaded the verified working-tree changes on base `fc27d6f4d120c7789b93426cd44fd464a6c28d89`, including the new Search controls. This is not a deployment of the unchanged base commit. No Git commit or push was required.
- The frozen upload manifest contains 590 application inputs selected by the existing `.vercelignore` allowlist, SHA-256 `97dd7c15bc396d10a8993092edbd617873ba544f1f16e0153d09356ed9a45ef3`. No local credentials, reference PNGs or browser evidence were uploaded. Source files still matched that snapshot after upload.
- Vercel Authentication remains enabled for **all** deployments, verified through the project API before and after deployment. Existing public Supabase configuration and project settings were preserved; no protection bypass, provider activation, migration or credential provisioning occurred.
- Direct unauthenticated HTTP verification was blocked by the cloud network proxy (`CONNECT 403`). Remote readiness and protection are verified through the authenticated Vercel API; this is not a live authenticated browser or account mutation test. Sign in to Vercel when opening the preview.
