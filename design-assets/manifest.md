# Asset manifest (Prompt 7)

Produced November 13, 2026 (local clock, America/Toronto) from `handoff.md`, `design-audit/04_image_needs.md` (see its "Update after the redesign" section), the approved screens in `design-audit/approved/` and the local app after the seed reset. Nothing here is wired into the app. No image was generated with any tool and no real AI request was started: the seed used the stand-in AI and the cached showcase images.

Contact sheet of the captured assets: [`contact-sheet.png`](contact-sheet.png). Candidate comparisons against the approved screens (approved row on the left, candidate row on the right): `candidates/IMG-007_check-390.png`, `-768.png`, `-1440.png`.

## 1. Static assets produced

| ID | Files | Source | Captured | Alt text | LCP |
| --- | --- | --- | --- | --- | --- |
| IMG-003 | Originals: `source/IMG-003_share-image_v1.png` (1200 × 630), `source/IMG-003_share-image_v1@2x.png` (2400 × 1260). Optimized: `optimized/IMG-003_share-image-1200.png` (146 KB), `-2400.png` (420 KB), plus `.webp` (41 KB, 85 KB) and `.avif` (39 KB, 95 KB) at both sizes | REAL SCREENSHOT. Built from `tools/share-image.html` with the real Kestrel Analytics direction board (`design-audit/seed/showcase/kestrel/board-1.png`, the board the app serves for the chosen direction), the Embel mark and Instrument Sans. Built to match `approved/share-image__share-image-by-630-img-003__1200.png`: element positions agree to within 1 px | 2026-11-13 | "Embel. A finished brand board with a logo, colour palette and type samples, made from a one-line idea." | No |
| IMG-007 | Kestrel: `source/IMG-007_kestrel-home_v1.png`; Orchard Lane: `source/IMG-007_orchard-lane-home_v1.png`; Tidewild: `source/IMG-007_tidewild-home_v2.png` (v1 is the owner's `.webp`, kept untouched). Optimized, each brand: `optimized/IMG-007_<brand>-home-360.{webp,avif}` (16 to 24 KB) and `-720.{webp,avif}` (32 to 36 KB), where `<brand>` is `kestrel`, `orchard-lane` or `tidewild` | REAL SCREENSHOT. The chosen direction board (Direction 1, "Editorial Soft Shapes") of each showcase brand, captured in the local app with Playwright at 2x (`tools/capture-home-example.mjs`): the top-left 720 × 540 of the 1024 × 1024 board at native resolution, the same crop as the owner's Tidewild file. The served bytes were checked against the cached showcase file (identical) and the capture against the native crop (pixel difference 0) | 2026-11-13 | Kestrel: "Brand board for Kestrel Analytics, a B2B analytics platform: logo, colours and type made with Embel." Orchard Lane: "Brand board for Orchard Lane Cider, a craft cider maker: logo, colours and type made with Embel." Tidewild: "Brand board for Tidewild Hot Sauce, a small-batch fermented hot sauce: logo, colours and type made with Embel." | Yes at 768 and 1440 (the row is on the first screen). Load the first image eagerly and lazy-load none of the three |
| IMG-008 | Same files as IMG-007 (no extra asset) | Same | Same | Same alt text; the caption on a new account's Home is "What you will get" (audit) | Same as IMG-007 |

Notes for implementation.

- **Sizes.** Slots are 358 × 269 at 390, 227 × 170 at 768 and 336 × 252 at 1440 (`handoff.md`), so the 360 file is the 1x and the 720 file is the 2x. Use `srcset` with AVIF first and WebP second.
- **Share image format.** Link previews should use the PNG. WebP and AVIF versions exist only for completeness. The 1x PNG is a 256-colour version to fit the 200 KB budget (a full-colour PNG is 283 KB); it was checked at 2x zoom. The 2400 × 1260 file is not read by link previews. It upsamples the 1024 px board by 1.6 and is slightly soft.
- **Weights.** Every optimized file fits its budget in `04_image_needs.md` (IMG-007: 35 KB at 720; IMG-003: 200 KB at 1x, 600 KB at 2x).
- **Faces and personal data.** The crops show only the logo band, palette, type and supporting graphics. They show no face and no invented personal details (the Kestrel board's face and business card are in its lower half). The share image shows the left 62% and the top 61% of the Kestrel board.
- **Names.** Kestrel Analytics, Orchard Lane Cider and Tidewild Hot Sauce are invented names. Check each against real companies before public use.
- **D-024.** A direction board can show a different logo from the chosen one (owner, Nov 14: deferred). The boards are used as generated.
- **Third example.** The third Home example is Tidewild Hot Sauce (made with one ordinary run, 6 logo concepts and 3 direction boards, owner-approved Nov 14). `handoff.md` records it as done.

## 2. Slots covered in code (no static file)

| ID | Defined by | Notes |
| --- | --- | --- |
| IMG-004 | Lucide icon set through `.e-icon[data-icon="<name>"]`; see section 3 | One library, one line weight |
| IMG-006 | `.e-canvas--dots` (tokens `--pattern-dot-grid`, `--pattern-dot-size`, `--pattern-dot-color`) | CSS only |
| IMG-010 | `.e-empty` with `.e-empty__visual` holding one `.e-icon` | One treatment for every empty state |
| IMG-018 | `.e-media` with `.e-media--inset` | 1:1 tile, logo inset 12%. Confirmed in the published `bundle.css` (see the note below) |
| IMG-019 | `.e-media--drawing` (dotted frame, corner handles, mono labels, halftone sweep) and `.e-media--revealing` with `.e-media__canvas` (the reveal); canvas board "Logo · Drawing (loading)" | Confirmed in the published `bundle.css` (see the note below). The reveal script is described in section 4 |
| IMG-022 | Canvas page 5 (Delivery), row "Brand image templates, two families" | Brand board, 1600 × 2200 |
| IMG-023 | Canvas page 5, same row | Profile image, 1024 × 1024 |
| IMG-024 | Canvas page 5, same row | Post templates, 1080 × 1080 and 1080 × 1350 |
| IMG-025 | Canvas page 5, same row | Banners, 1500 × 500 and 1584 × 396 |

**Note on class names** (checked November 14 against the design system copy in `design-assets/design-system/`, version 1794614133-df61). Every class named in this section exists in its `components/bundle.css`: `.e-media`, `.e-media--inset`, `.e-media--drawing`, `.e-media--revealing`, `.e-media__canvas`, `.e-media__handles`, `.e-media__label`, `.e-media__status`, `.e-canvas--dots` and `.e-empty`. (When this pass first ran, the copy was not yet in the repository, so it checked only the older generator sources in `design-audit/design-system-build/`, which predate the drawing and inset classes.)

Slots with no change from `04_image_needs.md` and nothing produced here: IMG-001, 002, 005, 009, 013, 014, 015, 016, 017, 027, 028, 029 (kept, removed or execution fixes). IMG-011, 012, 020, 021, 026 are the person's own output served as previews in implementation (sizes in the "Update after the redesign" section of `04_image_needs.md`).

## 3. Icons (Lucide)

- **Library and licence.** Lucide, ISC licence, `lucide-static` 0.460.0 (the version pinned by the design-system generator). 24 px grid, 1.5 stroke, drawn as CSS masks so they take the text colour.
- **Set.** The 57 icon names defined in `design-assets/design-system/components/bundle.css` (the published system, November 14): arrow-down, arrow-left, arrow-right, arrow-up, arrow-up-down, check, chevron-down, chevron-left, chevron-right, chevron-up, circle-alert, circle-check, clock, columns-2, copy, credit-card, download, ellipsis, external-link, eye, eye-off, file-text, folder, heart, house, image, image-off, images, info, layers, library, link, lock, log-out, maximize-2, mic, minus, palette, panel-left-close, panel-left-open, pencil, plus, refresh-cw, rotate-ccw, search, settings, sliders-horizontal, square, trash-2, triangle-alert, type, undo-2, upload, user, wifi-off, x, zap.
- **Check.** Every icon name used by the approved screens (44 names, read from the Claude Design canvas source on November 14) is in the set. Nothing is missing: the chat toggle uses `panel-left-close` (Hide chat) and `panel-left-open` (Show chat), both in the set. The "Running" spinner is CSS (`.e-spinner`), not an icon.
- **Note.** The first run of this pass checked the 55-name `ICONS` list in `design-audit/design-system-build/build.py` and about 10 of the approved images, because the design system copy was not yet in the repository; that older list lacks the two chat-toggle icons, which is why it reported them missing. The check above replaces it.

## 4. Implementation notes

### The logo "drawing" effect (approved November 13)

- **What is CSS.** In the design system: the dotted frame, corner handles and the two mono labels ("Concept 3" and "Drawing") are `.e-media--drawing`; the sweeping grey halftone is also part of the drawing state. The arrival state is `.e-media--revealing` with `.e-media__canvas`.
- **What is the script.** The reveal (about 3 seconds: contour sketch, grey screen, colour dots, then the picture) uses the script from transitions.dev's Generative effect skill, "image" variant. Logo concepts only; direction boards keep the simple blur.
- **Source.** GitHub repository `Jakubantalik/transitions.dev` (website transitions.dev), skill `skills/transitions-ui-generation/` (variant file `05-image.md`; runtime `ui-generation.js`, which hands the image variant to `text-image-generation.js`). Usage: `generate(img, { variant: "image" })` or `data-t-generate-variant="image"`.
- **Version.** The repository has no release tag or package version for the skill. Pin by commit: the skill's last change was commit `54fbee8e9d` (2026-10-23); the repository head when checked on 2026-11-13 was `20d70c1262` (2026-11-08). Copy the files into the project and record that commit in the file header (the licence asks to keep the transitions.dev comment).
- **Licence.** Transitions.dev License (copyright 2026 Jakub Antalik): the skill is "free for personal and commercial use", including companies, with no paid plan needed. You may copy, modify and ship it to users in the product. You may **not** redistribute the library itself or publish it (or a substantial part) as a competing transitions library, motion pack or animation kit. Paid plans cover only the Pro transitions and paid Agent features; use no Pro transition. Tooling in the repository's `cli/`, `agent/` and similar folders is MIT. Full terms: https://transitions.dev/terms.html. Embel ships only the one variant it uses.
- **Image readability.** The reveal draws from the image's own pixels. It needs the image decoded first (`img.decode()`), and an image from another origin without CORS cannot be read: it would show the frame and an even dot screen, with no sketch. Embel's private images come from storage, so serve them same-origin or as blobs (as the app does today), or send CORS headers.
- **Motion preference.** The audit pass ran with reduced motion; the effect needs a reduced-motion fallback (the plain fade the design system already uses).

### Domain prices in name details

The registrar's price (USD, per year) comes from the domain provider at check time. It is not a static asset and is not stored in the design files. The owner decided that domain prices are an exception to "credits, never money" (`handoff.md`, decision 9). A bulk check from the domain provider is needed for search across many extensions; today only YouTube handles and the EU trademark register are checked live.

## 5. Open items

- **IMG-023 and the square post template** have no preview widths in `handoff.md`; 360 / 720 was assumed.
- **Names:** check Kestrel Analytics, Orchard Lane Cider and Tidewild Hot Sauce against real companies before public use.
- **IMG-021 and IMG-020 at large sizes:** 2x would exceed the 1024 px files; the 1024 file itself is the 2x.

## 6. Tools (all in `design-assets/tools/`)

`capture-home-example.mjs` (Home crops from the local app), `compare-home-row.py` (approved against candidate rows), `share-image.html` with `render-share-image.mjs` (share image), `optimize.py` (AVIF and WebP), `probe-boards.mjs` (lists the board images on a brand page), `embel-mark-clean.svg` (the mark without its 18.6 KB embedded record) and `fonts/` (Instrument Sans, SIL Open Font License, copied from `@fontsource-variable/instrument-sans` 5.1.0, used only to render the share image).
