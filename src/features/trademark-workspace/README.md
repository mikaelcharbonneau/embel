# Trademark draft workspace — independent handoff

Scope: `src/features/trademark-workspace/**` and `tests/features/trademark-workspace/**`. No route, schema, persistence, auth, provider, package/config, or main-checkout changes. This is the current Embel source baseline copied into a separate checkout; credentials, private runtime state and old application sources were excluded.

## Public interface

Import `TrademarkWorkspace` and `TrademarkWorkspaceProps` from this module's index. Mount inside a client host using controlled `draft: TrademarkDraft` and `onChange(next)`. Start with `createTrademarkDraft(optionalName)`. The host owns storage; the default notice accurately describes tab-only memory. Supply `storageNotice` only for implemented behavior. Remount with a unique `key` on draft/account identity changes to clear local view/error state. No storage or network calls occur inside the module.

Optional `onExportPreview(preview: TrademarkDraftPreview): void` receives a bounded structured draft preview, including missing intake sections, unavailable dependencies and limitations. `serializeTrademarkDraftPreview` creates JSON for a host-owned export. This is a draft transport format, not an official territory format or filing dossier. The module does not promise downloads. Without the callback, export is visibly disabled. The host handles async export and exposes `exportState` (`idle`, `pending`, `failed`, optional error); the callback must handle its own promises rather than returning a rejecting promise to the synchronous handler. Synchronous exceptions are caught, with input retained. There is no success/filing state invented by the module.

Optional `onCreateBrand(seed: TrademarkBrandSeed): void` receives known mark name, user goods/services description and research notes with `trademarkResearch: unavailable`. It intentionally omits owner personal information, strategy approvals, legal conclusions and registry results. The integration lead maps this into the approved source-association/project intake flow, preserving the source draft separately. No project is created internally.

Pure public helpers: `validateTrademarkDraft` (strict Zod shape and product-size limits), `assessTrademarkDossier`, `confirmTrademarkReview`, `trademarkReviewKey`, `buildTrademarkDraftPreview`, `serializeTrademarkDraftPreview`, `trademarkBrandSeed`. Product intake has six sections: mark representation, requested territories, proposed owner, goods/services, classification notes and document plan. Notes/classification/document plans are user proposals, not jurisdiction-specific requirements. Review confirmation binds the exact draft content; later edits invalidate it. Output stages are only `draft`, `intake-complete`, `reviewed-draft`. These do not mean legally complete or ready to file. Preview/export remains possible for incomplete drafts, explicitly marked incomplete.

## Outstanding integration dependencies

- Integration lead mounts this component in the shared `/trademarks` route and defines persistence and source-promotion contracts. No library or account save is claimed here.
- Approved supported territories, licensed/permitted registry data access and registry adapters remain unavailable. Requested territories are free text, not a coverage catalogue. Source results stay empty; user notes are displayed separately.
- Territory-versioned filing rules, verified document/classification requirements, official portal links, real files and an official export format still need definition and validation. No upload is performed. General fields here are a preparatory intake, not legal filing validation.
- No filing, filed/registered transitions, registry requests, legal clearance, definitive registrability or new backend is implemented.

The roadmap's proposed Bibliothèque/Recherche/Dépôt labels are open decisions. This independent surface uses Dossier/Research/Draft preview and leaves a persistent library and official filing handoff to integration. Current delegated instructions override older no-specialist-commit text in the baseline; no nested agents were used.

## Verification commands

From the isolated repository root, with its existing dependencies available:

```
node_modules/.bin/vitest run tests/features/trademark-workspace/domain.test.ts
node_modules/.bin/eslint src/features/trademark-workspace tests/features/trademark-workspace
node_modules/.bin/tsc -p tests/features/trademark-workspace/tsconfig.json --noEmit
node_modules/.bin/playwright test --config tests/features/trademark-workspace/playwright.config.ts
```

The standalone fixture uses the installed esbuild tooling only for tests, serves on loopback port 3186, and launches dedicated headless Chromium desktop/mobile contexts. It mounts the actual component with a synthetic controlled host, imports Embel's existing global tokens/styles, and records screenshots under `.tmp/trademark-playwright`. It has no account session or provider connection and does not occupy the shared browser. This is module/fixture verification, not full integrated application acceptance or live provider validation. Final observed results are recorded in `tests/features/trademark-workspace/verification.md`.

## Current integrated presentation

The approved Figma Search/Fill presentation supersedes the earlier independent Dossier/Research navigation proposal. The host now supplies `draftControls`, `saveControl`, `disabled` and optional latest `savedDraft` metadata. These do not change the persisted draft or review/export schemas. Search is the initial tab; Fill retains additional dossier fields in a disclosure, Library represents one working draft and History only the latest verified account save. See `docs/trademarks-guided-design.md` for current behavior and verification boundaries.
