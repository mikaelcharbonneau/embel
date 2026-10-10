# Handles design source and boundaries

On 2026-10-10 the user selected the actual Fluid Handles frame in Figma, replacing the inaccessible Wonder link for this implementation. The unrelated Gleap file was an access test only.

- Source: [Fluid — Screens, Handles](https://www.figma.com/design/HP219GuYbpE8F1wHxj0h6N/Fluid-%E2%80%94-Screens?node-id=7-3850).
- Frame `7:3850`, “Page - Handles Two Column”, 1440 × 1068.
- Retain the 80 px rail, 76 px toolbar, Geist, neutral/magenta tokens, 16 px grid, 1008 px workbench and two equal columns with a 20 px gap.
- Original SVG artwork is exported without edits into `public/handles/`. Reference code is used only to inspect layout; it is not imported as application code.

Search starts empty in production. Business-name tokens, custom prefixes/suffixes and selectable separators create a live local preview. Reference names and the reference's fixed candidate count are not seed data. Local syntax screening excludes individual platform combinations; it never silently rewrites them or establishes platform acceptance or availability. Names retain their source context. Expansion is limited to 30 source names, six affixes of each kind and 120 candidate rows.

The existing platform contract supports Instagram, TikTok, YouTube, X and LinkedIn. Threads, Facebook and WhatsApp remain visible but explicitly unavailable. No provider is activated. “Check handles” requires a ready adapter; users can build an unchecked comparison and save a bundle separately. Retain sequential per-entry deadlines, cancellation, adapter binding fences, partial evidence, one handle per platform, and one source name per bundle. Favorites, selections and user declarations remain independent.

Saved searches and check-attempt history are limited to 20 records each in the current tab. They are explicitly separate from account drafts. History records a start, not inferred completion or availability. Account drafts still persist only the existing bundles, declarations and frozen imports. Save/reload, conflict and uncertain-save recovery remain available outside the disabled editor. Owner/generation changes remount temporary search state.

Verification uses isolated browser fixtures and the local production route, not live platform checks or production account acceptance. No deployment, migration or paid call is part of this screen implementation.

## Results view — 2026-10-10

The user subsequently selected the full Handles page (`3:9`) and authorized implementing, pushing and deploying its remaining Results frame: [Page — Handles Results, `20:2715`](https://www.figma.com/design/HP219GuYbpE8F1wHxj0h6N/Fluid-%E2%80%94-Screens?node-id=20-2715), 1440 × 1190. The existing Search frame remains the preparation step. Original Results SVGs are exported without canvas changes; the existing shell and bookmark artwork are reused.

Build comparison opens the compact Results view. Edit search returns the retained controls, cancels an active check and clears transient results and selection. Platform icons select one variant per platform for the existing mixed bundle workflow. Clicking a handle opens exact source, method and date evidence. A row bookmark copies that row's supported entries and original source into a library bundle without reserving a handle, changing independent favorite/selected/declaration flags, or claiming an account save. A saved identical row cannot be bookmarked again. Account save remains an explicit action.

All handles and Available everywhere use actual counts. The latter requires authoritative, exact available evidence for every selected platform; excluded combinations, failed or missing-profile observations and unchecked cells do not qualify. Black icons mean confirmed available; gray icons mean taken only when authoritative evidence exists. Question marks distinguish Unknown, and dashes distinguish disconnected platforms. Threads, Facebook and WhatsApp retain original artwork but are excluded from selected-platform counts and remain disconnected. No schema or provider is activated.

Refresh reuses the existing bounded sequential checks, partial-evidence retention, cancellation and adapter/owner-generation fencing. Saved bundle evidence is a copied snapshot and does not change on refresh. The table scrolls within its own region on small screens. Reference names, sample availability and fixed counts are never seeded into production.
