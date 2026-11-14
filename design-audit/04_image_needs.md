# Design audit, pass 1b: image needs

Status: **complete for pass 1b** (see the recap at the end for what could not be reviewed).
Environment: local stack only, read-only. Date: 2026-11-11. No AI generation was started, no asset was changed, and only this file was created.

How this pass was run. The saved screenshots in `evidence/screens/` (390, 768 and 1440 wide), the export renders in `evidence/exports/rendered/`, the email renders in `evidence/emails/` and the asset scan in `evidence/assets/assets.json` were the evidence. Rendered sizes in this file are measurements from that scan unless marked "proposed". The image folders under `public/` and the image-related source files were read, not changed. The Browser pane was not needed; the only live requests were two local fetches of the share image and the Apple icon from `http://127.0.0.1:3105`.

Terms used here.

- **Slot:** one place where an image appears or could appear, for example "the thumbnail on a project card".
- **Rendered width:** the width in CSS pixels at which the browser draws the image. A file much larger than its rendered width wastes download time.
- **1x / 2x:** the file size in pixels for a normal screen (1x) and for a high-density screen such as a recent phone or laptop (2x, twice the rendered width).
- **srcset:** a list of the same image in several sizes, so the browser downloads the smallest one that fits.
- **LCP candidate:** LCP (Largest Contentful Paint) is the moment the largest text or image on the first screen finishes drawing. An image that could be that largest element must load early, never lazily.
- **Real output:** an image Embel itself produced for a brand (a logo concept, a direction board, a brand board). It is the product's own work, shown as it is.

## Update after the redesign (Prompt 7, November 13, 2026)

Source: `design-assets/handoff.md` (final slot sizes, owner decisions of November 13 and 14). The audit tables in section 3 below are kept as written on November 11 and are now the *history*; where they disagree with this update, this update wins. The verdict does not change: still **no AI RASTER or AI VECTOR slot, 0 images to generate**. How this update was made: handoff.md read in full; sizes copied as written; classes checked against the design-system generator sources (see the caveat after table 3).

**Rule used for export sizes.** 1x is the largest width the slot is drawn at (at 390, 768 or 1440), rounded up to the next multiple of 4 where a round number is conventional; 2x is double. Where 2x would be wider than the 1024 px file Embel generates (logo concepts, direction boards), the 1024 file itself is the 2x, and nothing is upscaled.

### U1. Final slot sizes (CSS px, as rendered on the canvas)

"Side chat" means a 1440 × 900 window with the chat at its default 400 px. With the chat at 480 px the logo and direction tiles are 275 px; with the chat hidden, 334 px.

| ID | Slot | 390 | 768 | 1440 | Export 1x / 2x | Format and budget (unchanged from section 3 unless noted) |
| --- | --- | --- | --- | --- | --- | --- |
| IMG-003 | Share image (link preview) | not on a page | not on a page | 1200 × 630 file | 1200 × 630 / 2400 × 1260 (the 2x is new; link previews only read the 1x) | PNG, 200 KB (1x). The 2x file is an extra, budget 600 KB |
| IMG-007 | Signed-out Home examples, 4:3 | 358 × 269 | 227 × 170 | 336 × 252 | 360 × 270 / 720 × 540 | AVIF + WebP, 35 KB each at 720 |
| IMG-008 | New-account Home empty state, 4:3 | 358 × 269 | not shown | 336 × 252 | same files as IMG-007 | same files, 0 extra |
| IMG-011 | Project card logo strip (contain) | 324 × 146 | 316 × 142 | 302 × 135 | 324 × 146 / 648 × 292; concept thumbs about 100 × 100 / 200 × 200 | WebP, 15 KB |
| IMG-012 | Library preview, square (contain) | 356 × 356 | 348 × 348 | 334 × 334 | 360 / 720 | AVIF + WebP, 40 KB; the brand board is shown whole in the square |
| IMG-014 | Inspiration tiles (licensed) | 141 × 141 and 290 × 163 | not shown | 205 × 205 and 418 × 235 | 420 × 236 / 840 × 472 | keep the existing boards |
| IMG-017 | "Your images", 4:3 | 290 × 218 | not shown | 287 × 215 | 290 × 218 / 580 × 436 | WebP, 15 KB |
| IMG-018 | Logo concept tile, 1:1, logo inset 12% | 356 (one across) | 348 (two across) | 302 to 304 (side chat) | 360 / 720; the enlarged view (16:9: 358 × 201 at 390, 812 × 457 at 1440) uses the full 1024 file | WebP lossless or PNG, 30 KB |
| IMG-019 | Logo drawing and failed tile | as IMG-018 | as IMG-018 | as IMG-018 | none (CSS plus the reveal script) | CSS |
| IMG-020 | Chosen-logo thumbnail | 44 × 44 | 44 × 44 | 44 × 44 | 48 / 96. The finished brand also shows the logo on a 16:9 card (356 × 200, 718 × 404, 372 × 209): use the 1024 file there | WebP or PNG, 5 KB (thumbnail) |
| IMG-021 | Direction board tile, 1:1 | 356 | 348 (two across) | 302 (side chat) | 360 / 720. Chosen on the finished brand: 356 / 718 / 560, so use the 1024 file as 2x. Enlarged: up to 62% of the window height, also the 1024 file | AVIF + WebP, 60 KB at 720 |
| IMG-022 | Brand board, 8:11 | 356 × 490 | 718 × 987 | 617 × 849 | page preview 720 × 990 / 1440 × 1980; file 1600 × 2200 | WebP (preview) 80 KB; PNG (file) 400 KB |
| IMG-023 | Profile image | not given | not given | not given | file 1024 × 1024; no page preview width was drawn: see open items | PNG 120 KB (file) |
| IMG-024 | Post templates | portrait preview 356 × 445 | 348 × 435 | 334 × 418 | portrait preview 360 × 450 / 720 × 900; files 1080 × 1080 and 1080 × 1350 | WebP 30 KB (preview); PNG 150 KB and SVG (files) |
| IMG-025 | Banners | wide 356 × 119, cover 356 × 89 | 718 × 239 and 718 × 180 | 1054 × 351 and 1054 × 264 | previews 1056 × 352 / 2112 × 704 (wide) and 1056 × 264 / 2112 × 528 (cover); files 1500 × 500 and 1584 × 396 | WebP 30 KB (preview); PNG 120 KB and SVG (files) |
| IMG-026 | Guidelines imagery (crops from the chosen direction board) | 308 × 300 | not shown | 296 × 300 (the guidelines file at 1200: 344 × 300) | 344 × 300 / 688 × 600 | WebP or JPEG; 300 KB for the whole guide file |

Not listed in handoff.md, so unchanged from section 3, covered by code, or removals: IMG-001, 002, 004 to 006, 009, 010, 013, 015, 016, 027 to 029 (and 005, 016 stay removals).

### U2. Slots whose size, source or purpose changed since the audit

| ID | What changed |
| --- | --- |
| IMG-003 | Purpose and source unchanged (real output). The composition is now fixed by the approved board: mark and "Embel" top left, "Turn a product idea into a brand you can use." bottom left, one Kestrel Analytics board on the right, bleeding off the right edge. A 2x file (2400 × 1260) is added at the owner's request. |
| IMG-007, IMG-008 | Sizes now 358 / 227 / 336 (audit proposed 350 / 224 / 341). The third example is no longer a placeholder: Tidewild Hot Sauce was approved on November 14, made with one ordinary run (6 concepts, 3 boards) and its crop exists. Crop rule fixed by the Tidewild file: the top-left 720 × 540 of the chosen 1024 × 1024 direction board. Brands: Kestrel Analytics, Orchard Lane Cider, Tidewild Hot Sauce. |
| IMG-011 | The strip is bigger (324 × 146 against about 252 × 88) and shows the logo whole (`contain`); the audit's "logo on the direction's background colour" is no longer part of the slot. Three concept thumbs of about 100 × 100 are added. |
| IMG-012 | Shape: a 4:3 frame holding a 1:1 image (348 × 261) became a square (356 / 348 / 334) that shows the whole board. |
| IMG-014 | Rendered sizes re-measured on the canvas (205 / 418 at 1440); the boards themselves are unchanged. |
| IMG-017 | Ratio 3:2 became 4:3 and the slot is much larger (290 × 218 against 280 × 159 and 177 × 118); the audit's 180 and 360 wide exports are too small. |
| IMG-018 | Purpose changed: **artwork only**. No label row or Choose button; the whole picture chooses it; Enlarge stays in the corner. Logo inset 12% in its tile. Size 302 to 304 at 1440 in the side chat (audit proposed 340); 356 and 348 at 390 and 768. |
| IMG-019 | Now the approved drawing effect: dotted frame, corner handles, two mono labels ("Concept 3", "Drawing"), a sweeping grey halftone, then a reveal of about 3 seconds drawn from the picture's own pixels (contour sketch, grey screen, colour dots, picture). Logo concepts only; direction boards keep the simple blur. |
| IMG-020 | Thumbnail 44 × 44 (was 38 to 42). New use: a 16:9 chosen-logo card on the finished brand (356 × 200, 718 × 404, 372 × 209). |
| IMG-021 | Tiles 356 / 348 / 302; chosen board 356 / 718 / 560 on the finished brand; enlarged up to 62% of the window height. The direction cards keep their current design (owner, November 13): they are not artwork-only. |
| IMG-022 to IMG-025 | Previews are larger: brand board 356 × 490 / 718 × 987 / 617 × 849 (audit 274 / 636 / 972); portrait post preview 356 × 445 (audit 82 at 390); banners 1054 wide at 1440. File sizes are unchanged. Template artwork is now defined on canvas page 5 (see U3). |
| IMG-026 | Crops are now about square (308 × 300, 296 × 300) instead of 4:3 crops at 274 / 310 / 480. |
| Direction board source | **D-024 deferred** (owner, November 14): a direction board can show a different logo from the chosen one. It is a generation-engine issue outside this redesign; the crops below use the boards as generated. |

### U3. Slots now covered in code

These need no static file from this pass. They are covered by the design system and built in implementation.

| ID | Covered by | Notes |
| --- | --- | --- |
| IMG-004 | Icon library: Lucide through `.e-icon[data-icon="..."]` | One library, one line weight. 57 icons are defined in the design system (listed in the manifest); every icon the approved screens use is among them. Licence ISC. |
| IMG-006 | `.e-canvas--dots` (token `--pattern-dot-grid`, `--pattern-dot-size`, `--pattern-dot-color`) | CSS only; never an image file. |
| IMG-010 | `.e-empty` with `.e-empty__visual` holding one `.e-icon` | One treatment for every empty state; Lucide icons only. |
| IMG-018 | `.e-media`, `.e-media--inset` | Tile, 12% inset. The 1:1 frame is `.e-media`. |
| IMG-019 | `.e-media--drawing` (frame, handles, labels, halftone) and `.e-media--revealing` with `.e-media__canvas` (the reveal); canvas board "Logo · Drawing (loading)" | The reveal script comes from transitions.dev (see the manifest's Implementation notes). |
| IMG-022 | Canvas page 5 (Delivery), row "Brand image templates, two families" | Brand board template. |
| IMG-023 | Canvas page 5, same row | Profile image template. |
| IMG-024 | Canvas page 5, same row | Post templates, square and portrait. |
| IMG-025 | Canvas page 5, same row | Wide and cover banners. |

**Caveat on the class names.** `design-assets/design-system/` was not in the repository when this pass ran, so the classes could not be checked against the published system (version 1794600671-f81e). Checked against the generator sources in `design-audit/design-system-build/`: `.e-media`, `.e-media--thumb`, `.e-media--contain`, `.e-canvas--dots` and `.e-empty` exist there. `.e-media--inset`, `.e-media--drawing`, `.e-media--revealing` and `.e-media__canvas` do **not**; they come from the November 13 changes, which exist only in the published artifact. They are taken from the Prompt 7 brief and `handoff.md` and must be confirmed against the published `bundle.css` before implementation.

### U4. Open items from this update

- **IMG-023 and the square post template:** handoff.md gives no rendered width for the profile image (shown as "—") and lists only the portrait post preview. Square preview and profile preview widths are therefore assumed equal to the portrait preview's width (360 / 720). Confirm on canvas page 5.
- **Tidewild Hot Sauce naming:** like the other two names, it has to be checked against real companies before it goes public (the audit's rule for IMG-007).
- **Kestrel Analytics board:** the full board includes a photographic face and an invented person's name and phone number (audit E-043). The Home crop uses only the top 53% and left 70% of the board, and the share image shows the left 62% and the top 61% of it; both were viewed and show neither the face (centre-right of the lower half) nor the business card.

## 1. Verdict

Embel needs very little new imagery, and none of it should be illustration, stock photography or AI-made decoration. The interface today contains one 28 px brand mark, line icons and a dot-grid background; everything colourful on screen is either the person's own generated brand or the inspiration gallery, which is exactly what the Direction asks for. The work is therefore about using the product's own output better. **Marketing (signed-out Home):** this is the one real gap; the only landing page shows no example of what Embel makes, and one row of three real finished brands would fix it. **Onboarding (a new account's Home):** reuse that same row instead of an empty card; no new asset. **Empty states, 404 and error screens:** no art; one consistent icon treatment and the existing mark are enough. **App screens:** no new images, but the person's logos and direction boards are shown too small and downloaded far too large (a 1.3 MB board drawn at 237 px), so the needs here are bigger presentation and proper thumbnails. **Exported files:** this is the largest need; every brand's social images and brand board share one fixed decoration of two circles, and the downloadable guidelines contain no logo and no image, so these templates need to be redrawn in code from the chosen direction. **Social sharing:** the share image and the icon set work but are generic and incomplete; replace the share image with real output and add the missing icon sizes. In numbers: 29 slots, of which 9 keep what exists, 9 should show real product output, 6 are drawn in code, 2 come from one icon library, 2 are removals, 1 is licensed third-party work (the inspiration gallery), and **none needs an AI-generated or commissioned image**.

### What the current imagery looks like (the evidence behind the verdict)

**Consistency**

- **One brand mark, used well but served badly.** The pixel-ring mark appears in the navigation (28 px), on the sign-in card (32 px) and as Embel's avatar in the conversation (15 px inside a black circle). The file is 19.8 KB, of which 18.6 KB is an embedded content-credentials record (a signed note, added by the tool that made the file, saying how it was made); the drawing itself is 1.1 KB. Three identical copies exist: `public/embel-mark.svg`, `public/fluid-mark.svg` (the product's old name; no reference found) and `src/app/icon.svg`. In the navigation it is lazy-loaded although it is on the first screen of every page.
- **Icons: one look, three sources.** All icons are thin line icons, so the app looks consistent at a glance. Underneath there are three sources: the `Icon` component (24 hand-written icons, line weight 1.55), about ten components that draw their own icons inline (weights 1.2, 1.4, 1.5 and 1.6), and static files in `public/` (weights 1.29, 1.33 and others). There is no icon library. The static files use Lucide's names (`arrow-left-right`, `case-sensitive`, `columns-2`, `repeat-2`), so a move to that one library would change little visually.
- **No illustration style exists, and none is needed.** There is not one illustration, photo, video or animation in the interface. Empty states use a single small icon in three different treatments (a bare icon on Home and Projects, an icon in a grey circle in Library, text only elsewhere).
- **Leftover files.** `public/` holds 123 small SVG files across `auth/`, `handles/`, `projects/`, `project-workspace/`, `assets-library/`, `settings/`, `names/`, `logo-concepts/` and others; the scan saw 10 of them in use. A search found no reference at all to `handles/` (34 files, including the Facebook, Instagram, LinkedIn, Threads, TikTok, WhatsApp, X and YouTube marks), `names/` (25 files) or `logo-concepts/` (4 files). They appear to belong to tools that were removed.

**Relevance**

- **Nothing on screen is decoration, with two exceptions.** The dot-grid canvas is decorative and applied unevenly (missing on Assets and two older pages). The two overlapping circles on every brand board, social image and banner are decoration that does not come from the person's brand at all.
- **The most relevant image is missing.** Signed-out Home, the only landing page, has a headline, a text box and three chips. It shows no result. The same is true of a new account's Home.
- **The inspiration gallery is relevant but dominates.** It explains the Identity step well, and its large view (`annotated/E-054.png`) is the best-presented image in the app. It is also the loudest area of the product, and it stays open in the middle of every finished brand, where it outshines the person's own work.

**Quality**

- **Nothing is blurry, stretched or wrongly cropped.** The problem is the opposite: full-size files are scaled down in the browser. A direction board is 1024 × 1024 and 1.1 to 1.3 MB, drawn at 237 px. The chosen logo is a 1024 × 1024 file drawn at 38 px. A Library card loads up to 1,280 KB for a 339 px preview. One finished brand page loads about 5.6 MB of images. There are no thumbnails and no `srcset`.
- **The product's best images are shown smallest.** Logo concepts sit in a 205 × 168 px box and direction boards at 237 px, so the text on a board cannot be read and a logo cannot be judged (pass 1 findings E-033 and E-051).
- **The delivered images are the weakest.** The brand images use one template for every brand. On the banners the circles run through the brand name (E-047). The exported guidelines page is unstyled and has no logo or image (E-046).
- **No dated stock.** The app has no stock photography of its own.

**Where the gallery images come from: permission is held, but not recorded in the repository.** `docs/inspiration-brand-boards.md` (November 7) records the decision to show real studio brand boards "with the studio's permission" and to keep, for every image, a credit line and a record of who gave permission. The data file for the 56 brands now in the gallery (`src/domain/inspiration-brands.json`) has no creator, source or permission field on any of the 56 entries, and there is no such record elsewhere in `docs/`. The owner confirmed on November 11, after this pass, that the permission records exist and are kept outside the repository; this pass did not see them. What remains is small: carry the credit line into the data so the large view can show it, and note in `docs/` where the records live. Separately, the earlier 30-image catalogue (agency photographs of Dropbox and Mastercard work, logo studies of Airbnb, Figma, Spotify and others, 1.2 MB) is still in `public/inspiration/` and still imported by the code, although no reviewed screen shows it.

**Would real product screenshots serve better than illustration?** Yes, everywhere the question arises. Embel's strongest imagery is what it makes: the six logo concepts and the three direction boards of the two showcase brands (Kestrel Analytics and Orchard Lane Cider) are more persuasive than any drawing of "branding" could be. Every slot that could have been an illustration (landing page, new-account Home, share image) is better served by real output.

## 2. Draft art direction block

This block is to be pasted, word for word, at the top of every image-generation prompt and every brief for code-drawn artwork. It governs **Embel's own imagery only**. It does not apply to what Embel generates for a person's brand, which follows that brand's chosen direction.

Because this pass recommends no AI-generated slots, the block will mostly guide code-drawn work (the empty-state treatment, the export templates' neutral frame) and any slot a later design pass adds.

```text
ART DIRECTION: EMBEL (draft, 2026-11-11)

Brand adjectives: calm, precise, understated.

Medium and style: flat vector drawing built from the geometry of the Embel
mark: solid square ink blocks on a strict grid, plus thin even lines with
round ends (1.5 px on a 24 px grid). Two-dimensional only. No gradients, no
3D, no perspective, no hand-drawn wobble.

Palette (current tokens, TO BE REPLACED BY THE NEW DESIGN SYSTEM):
  canvas   #F7F7F5   page background, the dominant colour of any image
  paper    #FFFFFF   raised surfaces
  surface  #F1F0EE   quiet fills
  ink      #191919   the only strong colour; marks, blocks, lines
  grey     #696965   secondary lines and details
  hairline #E4E3DF   borders and dividers
  hairline-strong #C9C8C2
  grid dot #DAD9D4
No accent colour. Never magenta. No colour that is not in this list: in the
product, the customer's own brand is the only colourful thing on screen.

Lighting and texture: none. Flat fills, no shadows, no glow, no grain, no
paper texture, no blur. Depth comes only from overlap and hairlines.

Composition: one subject per image. The subject takes at most one third of
the frame and sits at the centre or just left of centre. At least 40% of the
frame stays empty canvas. When text will be placed over or beside the image,
keep one side (the left half, or the lower third) completely clear. Align
everything to an 8 px grid. Square corners on ink blocks, as in the mark.

Avoid: any text, letters, numbers or logos inside the image; real brands or
anything resembling one; real people's likeness, and faces of any kind;
stock-photo cliches (light bulbs, rockets, handshakes, puzzle pieces, robots,
brains, magic wands, sparkles, paint splashes, people pointing at screens);
purple or blue "AI" gradients; glass, clay or isometric 3D; drop shadows;
decorative blobs and floating circles.

References:
  1. public/embel-mark.svg (the pixel ring: the source of the geometry)
  2. the share image at /opengraph-image (mark, type and canvas together)
  3. design-audit/evidence/annotated/E-054.png (not a style reference: the
     standard for how large and how calmly an image should be presented)
```

Notes on the draft. The three adjectives come straight from the Direction ("calm, precise", "minimal and premium", "the interface stays quiet"). The palette is the current token set from `src/styles/tokens.css`. "Decorative blobs and floating circles" is on the avoid list on purpose: it is the exact decoration the export templates use today.

## 3. Image needs

One row per slot, grouped by area. How to read the columns:

- **Route / component** names the page and, where it helps, the file.
- **Purpose:** *informative* (the image explains or shows something), *decorative* (it only sets a mood) or *functional* (it identifies or operates something, like a logo or an icon).
- **Current state:** *missing*, *placeholder*, *weak*, *OK* or *remove*.
- **Source:** KEEP (what exists is right), REMOVE, REAL SCREENSHOT (the product or a brand it generated, shown as it is; for images inside the person's own project this means their own files), ICON LIBRARY, CLAUDE SVG-CSS (drawn in code), AI RASTER, AI VECTOR, STOCK (licensed third-party work) or ILLUSTRATOR.
- **Ratio and width** gives the aspect ratio, then the rendered CSS width at 390 / 768 / 1440. Measured values come from the asset scan; "proposed" marks a recommendation.
- **Tag:** *execution fix* needs no design decision; *needs redesign* means new or replaced imagery, or a new way of presenting it.

Alt text drafts use square brackets for values the app fills in. `alt=""` means the image is decorative or already named by text beside it, so a screen reader should skip it.

### A. Across the whole app

| ID | Route / component | Purpose | Current state | Source | Subject brief | Ratio and width at 390 / 768 / 1440 | Export sizes (1x, 2x) | Format | Budget (KB) | LCP candidate | Alt text draft | Priority | Tag |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| IMG-001 | Brand mark: navigation pill, sign-in card (`public/auth/card-mark.svg`), Embel's avatar in the conversation | functional | OK as a drawing; weak as a file | KEEP | The existing pixel-ring mark, unchanged. Serve one clean copy without the 18.6 KB embedded record, load it eagerly, and delete the two duplicates. Keep the original file in source control, since removing the record removes its proof of origin. | 1:1 · 28 / 28 / 28 (32 on the sign-in card, 15 in the avatar) | Vector, one file | SVG | 2 | No | `alt=""` (the link is already named "Embel home") | P2 | execution fix |
| IMG-002 | Browser and home-screen icons: `/icon.svg`, `/apple-icon`; no web manifest, no PNG fallback | functional | weak (incomplete set) | KEEP | The same mark on the canvas colour. Add the sizes that are missing so bookmarks, Android home screens and older browsers get a sharp icon. | 1:1 · not on the page | SVG; 32×32; 180×180; 192×192; 512×512; 512×512 with the mark inside the central 80% for round masks | SVG + PNG | 2 (SVG), 15 (each PNG) | No | Not applicable | P2 | execution fix |
| IMG-003 | Share image for links: `/opengraph-image` (also used as the Twitter image) | informative | weak: mark, name and a vague sentence; shows nothing Embel makes | REAL SCREENSHOT | Mark and name on the left, one real finished brand board on the right, cropped to its logo and palette. One short line that says what Embel does. | 1.91:1 · not on the page | 1200×630, one size (link previews do not ask for 2x) | PNG | 200 | No | "Embel. A finished brand board with a logo, colour palette and type samples, made from a one-line idea." | P2 | needs redesign |
| IMG-004 | Interface icons, every route (`src/components/ui/icon.tsx`, about ten components with their own inline icons, static files in `public/`) | functional | weak: three sources, at least five line weights | ICON LIBRARY | One library and one line weight for every icon. The static files already use Lucide's names, so Lucide is the natural candidate; confirm the choice in the design-system pass. | 1:1 · 16 to 24 at every width | Vector | SVG, inline through one component | 1 each | No | `alt=""` (the button or link carries the label) | P2 | needs redesign |
| IMG-005 | Unused files in `public/`: `handles/` (34), `names/` (25), `logo-concepts/` (4), `fluid-mark.svg`, the repeated `shell-*` and `empty-shell-*` sets, and four app marks in `settings/` (Figma, Google Drive, Notion, Slack) | none (not shown on any reviewed screen) | remove | REMOVE | Delete after one check that no component builds these paths by name. The search found no reference to the first three folders or to `fluid-mark.svg`. They include other companies' logos. | Not applicable | None | None | 0 | No | Not applicable | P3 | execution fix |
| IMG-006 | Page background: the dot grid (CSS `radial-gradient`, 22 px tile) | decorative | OK, but uneven: absent on Assets below the pill, on the recover page and on the legacy identity page | CLAUDE SVG-CSS | Stays a CSS pattern, never an image file. Whether it stays at all is a design-system decision (pass 1 finding E-055); if it stays, one token, used on every page or only where work happens. | Tile 22×22 · full width at every width | None (CSS) | CSS | 0 | No | Not applicable | P3 | needs redesign |

### B. Home, sign-in and system pages

| ID | Route / component | Purpose | Current state | Source | Subject brief | Ratio and width at 390 / 768 / 1440 | Export sizes (1x, 2x) | Format | Budget (KB) | LCP candidate | Alt text draft | Priority | Tag |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| IMG-007 | Signed-out Home `/`: a new row of example results under the starter chips (three images) | informative | missing | REAL SCREENSHOT | Three finished brands that Embel really made, in different sectors and moods, each shown as its chosen direction board cropped to the logo band and palette, with the brand name as a caption. Use boards without faces, and check each invented name against real companies first. Orchard Lane Cider's three boards are the better existing example: they keep the chosen logo and show no people. | 4:3 crop of a 1:1 board · proposed 350 (stacked or swiped) / 224 × 3 / 341 × 3 | 360×270 and 720×540 each | AVIF + WebP | 35 each at 720 wide | Yes at 768 and 1440 (the row is on the first screen): load the first image eagerly, lazy-load none of the three | "Brand board for [brand name], a [sector]: logo, colours and type made with Embel." | P1 | needs redesign |
| IMG-008 | Home for a new account: the empty "Your first brand starts here" card (24 px icon) | decorative | weak: an empty card where proof could be | REAL SCREENSHOT | Reuse the IMG-007 row with a caption such as "What you will get". No new asset. | Same as IMG-007 | Same files as IMG-007 | AVIF + WebP | 0 extra | Same as IMG-007 | Same as IMG-007 | P2 | needs redesign |
| IMG-009 | Page not found, and the three crash screens (`error.tsx`, `global-error.tsx`, the project-level `error.tsx`) | decorative | missing: no brand element; `global-error` has no navigation at all | KEEP | The existing mark at 32 px above the heading. No illustration, no "lost" joke art. | 1:1 · 32 / 32 / 32 | Vector (the IMG-001 file) | SVG | 0 extra | No | `alt=""` | P3 | execution fix |
| IMG-010 | Empty states with an icon: Projects (bare 28 px icon, `public/projects/empty-projects.svg`), Library kept assets and all generations (icon in a grey circle) | decorative | weak: three treatments for one job | ICON LIBRARY | One treatment everywhere: a library icon in one container, one size. No illustration. Part of the states pattern (pass 1, brief 4). | 1:1 · 24 inside a 56 circle at every width | Vector | SVG, inline | 1 | No | `alt=""` | P3 | needs redesign |

### C. Projects and Library

| ID | Route / component | Purpose | Current state | Source | Subject brief | Ratio and width at 390 / 768 / 1440 | Export sizes (1x, 2x) | Format | Budget (KB) | LCP candidate | Alt text draft | Priority | Tag |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| IMG-011 | Project card thumbnail for a brand with a chosen logo (Home "Pick up where you left off", `/brands`) | functional | weak: the logo is about 90 px wide on a flat grey box, so a finished brand looks like an unfinished one; a 1024×1024 file (23 to 59 KB) for an 88 px image | REAL SCREENSHOT | The person's own logo, larger and centred. Once a direction is chosen, put it on that direction's background colour, so finished brands carry their own colour. | About 2:1 box · image measured 252×88 / 246×88 / 154×88 | Thumbnail 320 and 640 wide | WebP (or PNG with transparency over a CSS colour) | 15 | Possible on `/brands` (first row): do not lazy-load the first row | "[Brand name] logo" | P2 | needs redesign |
| IMG-012 | Library card preview, `/assets` (kept assets, all generations) | informative | weak: files up to 1,280 KB drawn at 339×254; "Loading preview" shows first; every card has the same alt text | REAL SCREENSHOT | The person's own file, served as a small preview made on the server. The full file loads only when it is opened or downloaded. | 4:3 frame holding a 1:1 image · 348×261 / 342×257 / 339×254 (measured) | 360 and 720 wide | AVIF + WebP | 40 | Yes (the first card is the largest thing on the first screen): load the first row eagerly | "[Brand board / Logo concept / Direction board] for [brand name]" in place of "Brand board preview" | P1 | execution fix |

### D. The project conversation (Strategy, Voice, Identity)

| ID | Route / component | Purpose | Current state | Source | Subject brief | Ratio and width at 390 / 768 / 1440 | Export sizes (1x, 2x) | Format | Budget (KB) | LCP candidate | Alt text draft | Priority | Tag |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| IMG-013 | Competitor site icons: research cards (40 px) and the Strategy summary chips (22 px), `competitor-logo.tsx` | informative | weak in what could be seen: letter tiles in the seeded data, and empty circles in Kestrel's summary chips | KEEP | The competitor's own site icon, fetched through Embel's server, with the initial as a fallback (already built). Fix the case where the circle stays empty. | 1:1 · 40 and 22 at every width | 80×80 | PNG or WebP | 3 | No | `alt=""` (the name is beside it) | P3 | execution fix |
| IMG-014 | Inspiration gallery tiles: 56 brands, five parts each (`public/inspiration/brands/`, 23 MB) | informative | weak: the loudest area in the app; the data carries no creator or source for any of the 56 brands (the owner holds the permission records outside the repository) | STOCK (licensed studio work, as decided on November 7; keep the current boards) | No new artwork. Add each board's credit line to the data and show it in the large view, and note in `docs/` where the permission records are kept. A calmer tile layout is a design question (pass 1 finding E-032). | Varies by image · widest tile 280 / 377 / 420 (measured; the small files are 800 wide) | 420 and 840 wide | WebP (as now), AVIF optional | 25 each (small files are 3 to 70 today) | No (lazy-loaded, which is right) | Keep the existing descriptions, which are good, for example "White lowercase wordmark avelo in a rounded…" | P2 | execution fix |
| IMG-015 | Inspiration large view (the brand dialog, `annotated/E-054.png`) | informative | OK: the best-presented image in the app | KEEP | Keep as the standard for image presentation. Add the credit line from IMG-014. | 16:9 · not measured; about 1,070 wide at 1440 in the still | Source files are 1600×900, about 55 KB | WebP | 80 | No | Existing description of the part shown | P3 | execution fix |
| IMG-016 | The earlier inspiration catalogue: 30 files in `public/inspiration/*.jpg` and `*-logo-study.png` (agency photographs of Dropbox and Mastercard work; logo studies of Airbnb, Figma, Spotify and others), 1.2 MB | none (not shown on any reviewed screen) | remove | REMOVE | Delete together with `src/domain/inspiration-catalog.json`, after handling the two code files that still import it. The sourcing brief already says these "will be replaced". | Not applicable | None | None | 0 | No | Not applicable | P2 | execution fix |
| IMG-017 | "Your images": references the person uploaded (Inspiration step) | functional | OK; a 1200×900 file is drawn at 177×118 | KEEP | The person's own upload, served as a small preview. | 3:2 · 280 / 159 / 177 (measured) | 180 and 360 wide | WebP | 15 | No | The name the person gave it, or "Your reference image" | P3 | execution fix |
| IMG-018 | Logo concept cards, six per round (`concept-grid.tsx`) | informative: this is the product | weak on desktop: three across at 1440, each logo in a 205×168 box, too small to judge (E-033, E-051). Better at 768 (two across) and good at 390 (one per row). At every width the file is 1024×1024 and 15 to 276 KB | REAL SCREENSHOT | The person's concepts on white, shown large: two or three per row, each at least 320 px, with the full file on opening. | 1:1 · measured box 264×168 / 296×168 / 205×168; proposed image 320 / 340 / 340 | 360×360 and 720×720 | WebP lossless, or PNG | 30 | No (below the first screen) | "Logo concept [n] for [brand name]" | P1 | needs redesign |
| IMG-019 | Logo placeholders: "Creating your concept" tiles and failed tiles ("No image preview yet", "Failed") | functional | weak: failed tiles are taller than ready ones and their text reads as still loading | CLAUDE SVG-CSS | A tile the same size as a ready concept: a soft pulse while drawing, a still tile with a plain message when a concept could not be drawn. | 1:1 · same as IMG-018 | None (CSS) | CSS | 0 | No | Not applicable (status text) | P2 | execution fix |
| IMG-020 | Chosen-logo thumbnails: "Your logo" (42 px), the refine box (38 px), the Strategy and Assets summaries | functional | weak: a 1024×1024 file (29 to 59 KB) at 38 to 42 px, about 27 times too large; a wordmark is unreadable at this size | REAL SCREENSHOT | The person's logo as a small preview. Where the logo is a wordmark, give the thumbnail more width instead of a square. | 1:1 · 38 to 42 at every width | 96×96 | WebP or PNG | 5 | No | "Your chosen logo" | P2 | execution fix |
| IMG-021 | Creative direction cards, three boards (`visual-directions-view.tsx`) | informative: this is the product | weak at 768 and 1440: three across, boards of 1.1 to 1.3 MB drawn at 214 and 237 px; the text on a board cannot be read; the most colourful and most valuable images are the smallest. Good at 390, where each board has the full width | REAL SCREENSHOT | The board becomes the card: full card width, details under it, the larger view one click away. | 1:1 · measured 296 / 214 / 237; proposed 350 / 340 / 340 or wider | 360×360 and 720×720; the 1024 file on opening | AVIF + WebP | 60 at 720 | No | "Creative direction [n], [direction name], for [brand name]" | P1 | needs redesign |

### E. Assets page and exported files

| ID | Route / component | Purpose | Current state | Source | Subject brief | Ratio and width at 390 / 768 / 1440 | Export sizes (1x, 2x) | Format | Budget (KB) | LCP candidate | Alt text draft | Priority | Tag |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| IMG-022 | Brand board: the preview on Assets and the downloaded `brand-board.png` (1600×2200, 275 KB) | informative | weak: the header and the "In practice" samples use the same two circles for every brand; nothing of the chosen direction arrives except colours and fonts (E-042) | CLAUDE SVG-CSS | Templates drawn in code and fed by the chosen direction: its palette, its type, and a shape family matched to its style (grid and lines, soft shapes, blocks), plus real crops of the chosen direction board in "In practice". | 8:11 · 274 / 636 / 972 (measured) | File: 1600×2200 as now. Page preview: 640 and 1280 wide | PNG (file); WebP (preview) | 400 (file), 80 (preview) | Yes on Assets (the largest element): never lazy-load the preview | "[Brand name] brand board: logo, colour palette, typography and sample uses" | P1 | needs redesign |
| IMG-023 | Social profile image, `social/profile.png` (1024×1024) | functional | weak: logo plus the same two circles. At 390 the profile image and both post templates sit three across at 82 px, too small to check, and their download buttons break mid-word | CLAUDE SVG-CSS | The logo on the direction's background, sized to survive a round crop. No decoration that is not from the direction. | 1:1 · 82 / 203 / 315 (measured) | File 1024×1024; preview 320 and 640 | PNG (file); WebP (preview) | 120 (file), 25 (preview) | No | "[Brand name] profile image" | P1 | needs redesign |
| IMG-024 | Post templates: square 1080×1080 and portrait 1080×1350 (PNG and SVG; each SVG is about 148 KB because the raster logo is embedded) | functional | weak: one layout and one decoration for every brand | CLAUDE SVG-CSS | Two or three layouts per direction, built from the direction's palette, type and shape family, with the slogan as sample text. | 1:1 and 4:5 · 82 / 203 / 315 (measured) | Files as now; previews 320 and 640 wide | PNG + SVG (files); WebP (previews) | 150 (each PNG), 30 (preview) | No | "[Brand name] square post template" / "portrait post template" | P1 | needs redesign |
| IMG-025 | Banners: wide 1500×500 and cover 1584×396 (PNG and SVG) | functional | weak: the circles run through the brand name (E-047); logo and name are both shown, small and far apart | CLAUDE SVG-CSS | Logo and slogan with clear space, decoration kept away from text, the important content inside the central area that platforms do not crop. | 3:1 and 4:1 · 274 / 636 / 972 (measured) | Files as now; previews 640 and 1280 wide | PNG + SVG (files); WebP (previews) | 120 (each PNG), 30 (preview) | No | "[Brand name] wide banner" / "cover banner" | P1 | needs redesign |
| IMG-026 | Brand guidelines: the Logo and Imagery sections on Assets, and the downloaded `guides/brand-guide.html` | informative | missing in the file (no logo, no image, system font); text only in the Imagery section on the page (E-044, E-046) | REAL SCREENSHOT | Put the person's own logo files and chosen direction board into the guidelines, with two or three crops of the board as imagery examples. | Logo tiles 1:1 · 115 / 131 / 201 (measured); proposed board crops 4:3 at 274 / 310 / 480 | Embedded in the file at 800 wide; page previews 480 and 960 | PNG (logo); WebP or JPEG (crops) | 300 for the whole guide file | No | "[Brand name] logo on a light background"; "Imagery example from the [direction name] direction" | P1 | needs redesign |
| IMG-027 | Exported logo files: `logo-original.png`, `logo-transparent.png`, `logo-reversed.png` (1024×1024 each) | functional | weak for print: 1024 px, raster only. The README in the kit says so honestly | KEEP | Keep the files and the honest wording. A larger export (for example 2048 px) is a product decision outside this pass. Never present a raster file as a vector. | 1:1 · not on the page as such | 1024×1024 today | PNG with transparency | 150 each | No | Not applicable (downloads) | P2 | needs redesign |

### F. Email and billing

| ID | Route / component | Purpose | Current state | Source | Subject brief | Ratio and width at 390 / 768 / 1440 | Export sizes (1x, 2x) | Format | Budget (KB) | LCP candidate | Alt text draft | Priority | Tag |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| IMG-028 | Email header: `supabase/templates/confirmation.html` and `recovery.html` | functional | missing: the word "Embel" only, no mark | KEEP | The existing mark beside the name, as a hosted PNG (many email programs do not show SVG). | 1:1 · 28 at 390 and at 600 (emails are 600 wide at most) | 28×28 and 56×56 | PNG with transparency | 3 | No | "Embel" | P3 | execution fix |
| IMG-029 | Stripe's hosted checkout and customer portal: the icon and logo set in the Stripe Dashboard's branding settings | functional | not seen (no Stripe test key locally) | KEEP | The existing mark, exported as a square icon, so the payment page looks like Embel. Check the exact size rules in Stripe's branding settings. | 1:1 · set by Stripe | 512×512 | PNG | 50 | No | Not applicable (set by Stripe) | P2 | execution fix |

### Reviewed, and no image is needed

These places were reviewed and should stay as they are: adding imagery would work against the Direction.

- **Sign in, Create account, Forgot password, Reset password** (pages and the overlay): the mark on the card is enough. No side illustration.
- **Plans, the out-of-credits prompt, Settings (Account, Usage), the delete dialogs, the account menu, the Generation activity panel:** text and controls only.
- **Account avatar:** an initial in a circle. No photo upload is needed for a single-person workspace.
- **Project cards without a logo:** the brief excerpt and "No logo yet" say more than placeholder art would.
- **Text-only empty states** (Deleted projects, search with no match, Usage with no requests) and the **signed-out, loading, missing and failed states** of Projects, Library, the project page and "Recover a project": these need the one message pattern from pass 1, not pictures.
- **Design system preview on Assets:** drawn in CSS from the brand's own tokens, which is the right approach.
- **`direction/selected-direction.png` in the kit:** a reference copy of the chosen board; fine as it is.
- **`/brands/account/<id>/identity`:** the old "Build a visual starting point" page shows only a test upload. The page itself looks orphaned (inventory, section 1); it has no image slot to plan.
- **Share images per project:** there are no public project pages, so there is nothing to share and no slot.

## 4. Totals

**Slots by source (29 in all)**

| Source | Slots | IDs |
| --- | --- | --- |
| KEEP | 9 | IMG-001, 002, 009, 013, 015, 017, 027, 028, 029 |
| REAL SCREENSHOT (real output, or the person's own files) | 9 | IMG-003, 007, 008, 011, 012, 018, 020, 021, 026 |
| CLAUDE SVG-CSS (drawn in code) | 6 | IMG-006, 019, 022, 023, 024, 025 |
| ICON LIBRARY | 2 | IMG-004, 010 |
| REMOVE | 2 | IMG-005, 016 |
| STOCK (licensed third-party work) | 1 | IMG-014 |
| AI RASTER | 0 | |
| AI VECTOR | 0 | |
| ILLUSTRATOR | 0 | |

**Estimated generation count: 0.** There are no AI RASTER or AI VECTOR slots, so 0 slots × 3 candidates = 0 images to generate for Embel's own imagery.

**One related cost that is not art generation.** IMG-007 (and IMG-003 and IMG-008, which reuse it) needs three finished example brands. Two exist already: the showcase brands Kestrel Analytics and Orchard Lane Cider. A third, or a fresh set of three chosen for public display, would each be one ordinary run of the product: 6 logo concepts and 3 direction boards, so 9 images per brand, 9 for one more brand or 27 for a fresh set. From the audit's own spend record (19 kept images for about $0.75, an estimate and not a confirmed charge), that is very roughly $0.35 per brand. It is a real AI generation, so it needs the owner's approval first; none was started in this pass.

**Tags.** 15 slots need redesign (IMG-003, 004, 006, 007, 008, 010, 011, 018, 021, 022, 023, 024, 025, 026, 027). 14 are execution fixes (IMG-001, 002, 005, 009, 012, 013, 014, 015, 016, 017, 019, 020, 028, 029).

**What the execution fixes add up to.** Most of them are one piece of work: serve small previews of private images instead of the full file (IMG-012, 017, 020, and the thumbnail half of IMG-011, 018 and 021). That one change removes most of the 5.6 MB a finished brand page loads today.

## Recap

**Image slots by source and priority**

| Source | P1 | P2 | P3 | Total |
| --- | --- | --- | --- | --- |
| KEEP | 0 | 4 | 5 | 9 |
| REAL SCREENSHOT | 5 | 4 | 0 | 9 |
| CLAUDE SVG-CSS | 4 | 1 | 1 | 6 |
| ICON LIBRARY | 0 | 1 | 1 | 2 |
| REMOVE | 0 | 1 | 1 | 2 |
| STOCK | 0 | 1 | 0 | 1 |
| AI RASTER, AI VECTOR, ILLUSTRATOR | 0 | 0 | 0 | 0 |
| **Total** | **9** | **12** | **8** | **29** |

**The nine P1 slots, in one line each**

1. IMG-007: show three real finished brands on the signed-out Home.
2. IMG-012: Library previews load up to 1.3 MB each; serve small previews and give each card its own alt text.
3. IMG-018 and IMG-021: show logo concepts and direction boards large enough to judge.
4. IMG-022 to IMG-025: redraw the brand board, profile image, post templates and banners from the chosen direction, without the two circles.
5. IMG-026: put the logo and the direction board into the brand guidelines, on the page and in the file.

IMG-014 (the inspiration gallery) was P1 until the owner confirmed on November 11 that permission records exist outside the repository. It is now P2: add the credit lines to the data and note where the records are kept.

**Could not review, or reviewed only in part**

- **The permission records for the gallery brand boards.** The owner confirmed they exist and are kept outside the repository. This pass did not see them, so it cannot say whether they cover all 56 boards or what credit wording they require.
- **Whether the "unused" files are truly unused.** This rests on a text search of `src/`; a component that builds a file path from a variable would not be found that way. Check before deleting (IMG-005, IMG-016).
- **Real competitor site icons.** The seeded competitors have no real websites, so only the letter fallback and the empty circles were seen (IMG-013).
- **The Library detail view.** It does not open (pass 1 finding E-050), so the image inside it is unseen.
- **The three crash screens.** Read in source only; they contain no image.
- **Stripe's checkout and portal pages** (IMG-029): hosted by Stripe; no test key locally. The size rules quoted for Stripe are to be confirmed in its branding settings.
- **The name preview on the Name step, "Compare concept", and the larger view of a direction board.** Not reopened in this pass; the larger view was taken from pass 1's description.
- **Image quality of generated output beyond the two showcase brands.** The other nine brands use "TEST DATA · PLACEHOLDER" images and were not judged. Of the showcase brands, Kestrel Analytics was reviewed at full size (conversation, Assets and the exported kit); for Orchard Lane Cider only the logo concepts and direction cards were reviewed, not its Assets page or kit. Two things noticed on the Kestrel direction board matter if it is used publicly: it includes a photographic-looking face and an invented person's name and phone number on a business card, and it redraws the logo instead of using the chosen one (E-043).
- **Not every saved screenshot was opened.** Every route in the inventory was reviewed, but about 50 of the 277 files were opened. At 1440: every route and the main states. At 390: Home, Projects, Library, Plans, the 404 page, and the finished Kestrel conversation and Assets page. At 768: Home, Projects, and the logo, direction and brand-image areas of Kestrel. The rest (hover and focus states, form errors and notices, dialogs, and the other brands at 390 and 768) are text states or repeats, and were covered by the asset scan's measurements, not by eye. No width was walked live.
- **File weights on a production build.** All weights come from the development server. Private images are served as they are in both, so the sizes should hold, but this was not confirmed.
- **Emails in real mail programs.** Only the rendered previews were reviewed.
- **Marketing pages and dark mode:** not in this repository (see the audit README, Scope).

**How this pass was run.** Saved screenshots, export renders, email renders and the asset scan were the evidence; tall screenshots were cut into slices in a temporary folder outside the repository for reading. The seed reset was not run at the start, because this pass used the saved evidence and changed no data. No AI button was clicked, no email was sent, no asset was changed or optimised, and the only file created in the repository is `design-audit/04_image_needs.md`.
