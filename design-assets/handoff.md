# Handoff from Claude Design (Prompt 6)

November 13, 2026. This file closes Prompt 6 of the design audit plan and is the input for Prompt 7 (assets) and the implementation.

## Sources of truth

- **Screens:** the Claude Design canvas "Embel screens", https://claude.ai/artifact/M4MG9CqZoWu2KeWb1u8wca (version 1794602494-f558).
- **Design system:** "Embel Design System", https://claude.ai/artifact/NrcVPniQFUPdtrBBtY9V8J (version 1794600671-f81e). Its README, component pages and `changelog.md` record every decision below.
- **Approved screens as images:** `design-audit/approved/`, 213 PNGs rendered from the canvas with its own runtime (1×, full page, except the 1440 × 900 side-chat screens, which show one window because their panes scroll).

## Decisions made after the first Prompt 6 report

These change what the screens look like compared with the first round; the canvas and the design system already reflect them.

1. **Desktop conversation = side chat.** At 1024 px and up every project-conversation screen uses the Workspace: the chat in a floating panel 16 px from the window's left, top and bottom edges, the work on the right, filling the window. The chat and the work area scroll separately. The chat can be resized (320 to 560 px) and hidden. Below 1024 px the conversation stays one column.
2. **Send is the one way forward.** No Continue or Explore buttons. Chosen options and results sit in the reply box as chips; Send starts the work or moves to the next step; Stop takes Send's place while Embel works.
3. **Results fit the window.** Six logo concepts (two rows of three) and three direction boards (one row) are fully in view at 1440 × 900. A chosen result keeps its size and place, marked by the ring only; no tick on generated results.
4. **Logo concepts are artwork only.** No label row or Choose button: the whole picture chooses it; Enlarge stays in the corner; the logo sits inset 12% in its tile.
5. **Drawing state.** Concepts being made show a dotted frame and a sweeping grey halftone ("Drawing"), then come in from a blur (after transitions.dev's generative effect, rebuilt in CSS).
6. **Name step.** Compact one-row name cards, four across; 40 names per batch; no radio circle; Details opens the name details over the work area only.
7. **Name details.** Extra-large dialog with Domains (search, Extensions, Tweaks and Filters panels, sort, quick filters, prices), Handles and Trademarks.
8. **Project bar.** The current step has no fill; its ring-and-dot mark and ink text show it.
9. **Domain prices** are an exception to "credits, never money" (owner decision).
10. **Prototype.** Page 9 of the canvas is one clickable prototype of the desktop flow (15 screens, from competitor research to the finished brand).

## Screens and the D- IDs they address

| Canvas page | Row | D- IDs |
| --- | --- | --- |
| 1 Logo and direction | Logo step (desktop side chat; 768 and 390 one column) | D-013, D-069 |
| 1 Logo and direction | Creative direction step | D-013 (D-024 needs the owner) |
| 2 Credits and plans | Out of credits, in place (Logo step, logo types in the reply box) | D-014, D-015 |
| 2 Credits and plans | Account menu with plan and balance | D-015 |
| 2 Credits and plans | Plans | D-031, with D-033, D-066, D-076 |
| 2 Credits and plans | Settings, Usage: credit ledger | D-036 (needs the owner) |
| 3 Brand conversation | Research running, failed, done | D-016 |
| 3 Brand conversation | A finished brand, folded (with Inspiration reopened, brand menu) | D-021, D-054, D-061 |
| 3 Brand conversation | Audience, Positioning, Personality and Slogan (desktop side chat; added November 13) | Strategy and Voice steps; no dedicated D- ID |
| 3 Brand conversation | Name step, including name details | D-070 |
| 4 Home | Home, signed out | D-017 |
| 4 Home | Home, signed in | D-060, D-068, D-074 |
| 4 Home | Activity | D-080 |
| 5 Delivery | Assets, one delivery page | D-071 (previews of D-022, D-023) |
| 5 Delivery | Brand guidelines, on screen and as the file | D-023 |
| 5 Delivery | Brand image templates, two families | D-022 |
| 6 Projects and Library | Projects | D-068, D-074 |
| 6 Projects and Library | Library | D-035 |
| 7 Brand and sharing | Share image | D-075 |
| 8 Settings | Settings, Account | D-081 |

Part B items in `Design_AUDIT.md` section 6 that are not named on any canvas row (D-001 to D-012, D-019, D-025, D-026, D-029, D-030, D-032, D-034, D-037, D-038, D-040 to D-048, D-052, D-058, D-062 to D-065, D-067, D-073, D-077, D-078, D-082, D-085, D-088 to D-091) are either covered through the design system (Part A) or by the screens above without being listed in the row title. Implementation should check each against section 6.

## Naming of the approved images

`design-audit/approved/<route>__<state>__<width>.png`. `<route>` uses the same route names as `design-audit/evidence/screens/` (brand-conversation, home, plans, settings, brand-assets, library, projects), plus `export` (guidelines file and templates) and `share-image`. `<state>` is the canvas board's title. The redesign changed several states, so most names do not match a "before" file one to one; compare by route and width. Desktop side-chat screens carry "side-chat" in their state.

## Left unresolved

- **D-024** (the direction board shows a different logo from the chosen one) and **D-036** (Usage counts tokens, not credits) need the owner's decision; the canvas shows the proposed screens.
- **IMG-007 / IMG-008:** the third Home example brand is a placeholder ("needs owner approval to generate"); the first two use the showcase brands.
- **Audience, Positioning, Personality and Slogan** have desktop side-chat screens only; at 768 and 390 they follow the one-column conversation as in the current app.
- **Drawing effect:** the full transitions.dev reveal (sketch, halftone and colour from the finished picture's pixels) needs that skill's script in the app; the CSS version is in the design system. Its licence allows use in the product, not redistributing the library.
- **Name details checks:** only YouTube handles and the EU trademark register are checked live today; domain search across many extensions needs a bulk check from the domain provider, which also supplies the prices.

## Final image slot sizes (CSS px, as rendered on the canvas)

Export each slot at 1× and 2× of the largest width it appears at. "Side chat" sizes are at a 1440 × 900 window with the chat at its default 400 px; with the chat at 480 px the logo and direction tiles are 275 px, and with the chat hidden 334 px.

| ID | Slot | 390 | 768 | 1440 | Notes |
| --- | --- | --- | --- | --- | --- |
| IMG-003 | Share image (link preview) | — | — | 1200 × 630 file | Board on page 7 |
| IMG-007 | Signed-out Home examples, 4:3 | 358 × 269 | 227 × 170 | 336 × 252 | Same asset as IMG-008; third is a placeholder |
| IMG-008 | New-account Home empty state, 4:3 | 358 × 269 | — | 336 × 252 | Same asset as IMG-007 |
| IMG-011 | Project card logo strip (contain) | 324 × 146 | 316 × 142 | 302 × 135 | Plus three concept thumbs, about 100 × 100 |
| IMG-012 | Library preview, square (contain) | 356 × 356 | 348 × 348 | 334 × 334 | Brand board shown whole in the square |
| IMG-014 | Inspiration tiles (licensed) | 141 × 141 and 290 × 163 | — | 205 × 205 and 418 × 235 | Keep the existing boards |
| IMG-017 | "Your images", 4:3 | 290 × 218 | — | 287 × 215 | Person's uploads |
| IMG-018 | Logo concept tile, 1:1 | 356 (one across) | 348 (two across) | 302–304 (side chat) | Logo inset 12%; enlarged view 16:9: 358 × 201 at 390, 812 × 457 at 1440 |
| IMG-019 | Logo drawing / failed tile | as IMG-018 | as IMG-018 | as IMG-018 | CSS only (`e-media--drawing`) |
| IMG-020 | Chosen-logo thumbnail | 44 × 44 | 44 × 44 | 44 × 44 | Finished brand: 16:9 logo card 356 × 200 / 718 × 404 / 372 × 209 |
| IMG-021 | Direction board tile, 1:1 | 356 | 348 (two across) | 302 (side chat) | Chosen on the finished brand: 356 / 718 / 560; enlarged: up to 62% of the window height |
| IMG-022 | Brand board, 8:11 | 356 × 490 | 718 × 987 | 617 × 849 | File 1600 × 2200 |
| IMG-023 | Profile image | — | — | — | File 1024 × 1024; template board on page 5 |
| IMG-024 | Post templates | portrait preview 356 × 445 | 348 × 435 | 334 × 418 | Files 1080 × 1080 and 1080 × 1350 |
| IMG-025 | Banners | wide 356 × 119, cover 356 × 89 | 718 × 239 / 718 × 180 | 1054 × 351 / 1054 × 264 | Files 1500 × 500 and 1584 × 396 |
| IMG-026 | Guidelines imagery | 308 × 300 | — | 296 × 300 (guidelines file at 1200: 344 × 300) | Crops from the chosen direction board |

Slots not listed (IMG-001, 002, 004 to 006, 009, 010, 013, 015, 016, 027 to 029) are unchanged from `04_image_needs.md`, covered by the design system (icons, dot grid), or removals.
