# Design audit, pass 3b: design-system audit and specification

Status: **complete for pass 3b** (the recap at the end lists the limits).
Environment: code at commit `6afd6ba3` on branch `design-audit`, read on 2026-11-12. No application file was changed, no AI generation was started, and the app was not opened: every interaction state needed here had already been measured by passes 2 and 3.

**What this file is for.** Claude Design will build an improved design system from this file before any screen is redesigned. It describes the system the app needs, not individual screens. Section 3 is the specification; sections 1, 2 and 7 are the evidence for it; section 5 tells implementation how to move the code across.

How to read it.

- **Token:** a named value defined once and reused, such as `--border` for the hairline colour. **Primitive token:** a raw value with a neutral name (`--neutral-200`). **Semantic token:** a role that points at a primitive (`--color-border`). **Component token:** a value that belongs to one component (`--button-height`).
- **Drift:** values written directly in a stylesheet instead of going through a token, so the same idea ends up with many slightly different values.
- **Foundation:** one of the basic layers of a design system: colour, typography, spacing, radius, elevation (shadows), layout, iconography, motion.
- **Contrast ratio:** the measured brightness difference between two colours, from 1:1 to 21:1. WCAG AA (the usual accessibility target) asks 4.5:1 for text, and 3:1 for large text, control outlines, icons that act as controls and focus rings. Every ratio in this file was calculated by `design-audit/tools/ds-contrast.mjs`; none was estimated.
- **"Decide in Claude Design":** a choice that is a matter of taste. This file gives two options that both fit the Direction and does not pick.
- **Finding fields** are the same as in passes 1 to 3: severity P0 to P3, and a tag of *needs redesign* (a visual decision is required) or *execution fix* (the answer is already clear).
- **Evidence** paths are relative to `design-audit/evidence/` unless they start with `src/`. Line numbers are as of the commit above; every reference also names the selector or component so it can be found again after the code is restructured.

The yardstick is the Direction in `README.md`: an audience of founders, small businesses and freelancers or agencies, most of them not designers; a feel that is minimal and premium, calm, precise, with generous white space; and an interface quiet enough that the person's own generated brand is the most colourful thing on screen.

Measurements come from two scripts written for this pass, both read-only:

- `design-audit/tools/ds-drift.mjs` reads all 41 stylesheets (10,050 declarations) and 572 TypeScript files and counts every distinct value per foundation. Output: `design-system/drift.md` (tables) and `design-system/drift.json`.
- `design-audit/tools/ds-components.mjs` lists all 1,267 class selectors, checks which are still mentioned by a component, and groups them into component families. Output: `design-system/components.md` and `components.json`.

## 1. Verdict: rebuild the system's architecture, keep its look

**Recommendation: rebuild.** The prompt defines a rebuild as a new token architecture or a new visual identity. Embel needs the first and not the second. The palette, the floating pill navigation and the rounder corners that the owner confirmed on November 6 stay. What has to be built new is the structure underneath them, because most of it does not exist yet.

**Design-system skill score: 35 out of 100.** The design plugin's design-system skill, run in audit mode on the code, scores three things. The points are this pass's weighting of the skill's three tables (40, 40 and 20).

| Part | Score | Why |
| --- | --- | --- |
| Token coverage | 13.5 / 40 | Colour is tokenised and adopted (88% of colour uses go through a token). Type is one third tokenised. Spacing, shadows, motion, layering and breakpoints have no tokens at all. |
| Component completeness | 14.5 / 40 | 20 components assessed. Behaviour is often good (native dialogs, real labels, 44 px buttons), but almost every component exists in several hand-built versions, no control has a pressed state, and there are no toasts and no shared dialog, menu, message, skeleton or empty state. |
| Naming and documentation | 7 / 20 | Role-style names are a good start. Three tokens share one value, two radius tokens mean the same thing, a second token set lives in another file, and nothing documents when to use what. |

Why this is a rebuild and not a refresh. A refresh keeps the structure and changes values. There is too little structure to keep:

1. **Five of eight foundations have no tokens.** The single token file (`src/styles/tokens.css`, 40 tokens) covers colour, part of type, radius and three page widths. Spacing (2,355 uses of 53 values), shadows (34 different shadows in 41 uses), motion (9 durations, 4 easings), layering (12 z-index values) and breakpoints (21 viewport widths) are written by hand in each file. Evidence: `design-system/drift.md`.
2. **The tokens are one flat layer.** There are no primitives under the roles, so a role cannot be re-pointed without editing a hex value, and the ink colour is defined three times (`--text`, `--accent`, `--accent-ink`, all `#191919`, 305 uses between them). A future accent, a dark mode or a tighter palette each need the two-layer structure in section 3a.
3. **The type scale exists and is not used.** `--text-xs` to `--text-2xl` are referenced 14 times, all in one file (`src/styles/plans.css`); `--text-display` is never referenced. Meanwhile `font-size` is written literally 557 times in 19 values, and 28 line heights and 27 letter-spacings are in use.
4. **There is no component layer.** Components are CSS class conventions, and the conventions have forked. Buttons have four parallel implementations (136 of 338 `<button>` elements do not use the shared classes). There are 10 hand-built dialogs with 7 different backdrops, about 20 message styles, 24 empty-state classes and 8 ways to show "selected". Evidence: `design-system/components.md`.
5. **Two tokens that everything depends on fail accessibility.** `--border` (1.28:1 on white) outlines every field, and `--placeholder` is 3.9:1 (pass 3, A-001 and A-002). Fixing them is a palette decision, not a patch.

Why the look survives. The frontend-design skill was used as a lens (section 7, DS-020). The ink-on-warm-paper palette is restrained and correct for the Direction, the pill navigation is recognisable, and the app is free of the louder generated-page habits (no gradients, no cream-and-terracotta, no acid accent on black). What reads as templated is narrower: one white rounded hairline card for every kind of content, pill shapes on almost every control, a stock typeface at 13 px, and a dot grid behind everything. Those are decisions inside the new system (section 3, "decide in Claude Design"), not a reason to start the identity again.

What the owner is agreeing to. In Claude Design: start a new design system from this specification instead of importing the code with `/design-sync`, because an import would bring in four button versions and ten dialogs. Attach the current screenshots so the confirmed look anchors the result. In implementation: about 3,400 hand-written values are replaced by tokens (section 5), most of them mechanically, and roughly 150 unused selectors are deleted. The risk is visual regression across every screen, which is why `capture.mjs` and the validation set in section 6 exist.

This verdict is separate from pass 1's product-structure verdict (refresh). The two fit together: the pages and navigation keep their shape, and the system that draws them is rebuilt.

## 2. Current state

One table per foundation. "Uses" counts declarations in `src/**/*.css`. Full tables with file and line examples are in `design-system/drift.md`.

### 2.1 Colour

| What exists | Distinct values in use | Problems | Evidence |
| --- | --- | --- | --- |
| 23 colour tokens in `src/styles/tokens.css:2-24, 47`: canvas, paper, surface, text, secondary, placeholder, two borders, accent (three names), selection, and positive, danger and warning in a text / soft / border set. Single light theme; no dark mode. | 23 tokens, 1,357 uses. **90 literal colours, 189 uses** (50 opaque hex values in 129 uses, 40 translucent values in 60 uses). 6 hex values in TypeScript, 23 uses (mostly export artwork and `global-error.tsx`, which is expected there). | (1) 12 literals repeat a token's own value (69 uses): `#ffffff` 18, `#191919` 10, `#696965` 9, `#f1f0ee` 9. (2) **30 near-grey values have no token**, each used once or twice, most of them hover borders one shade apart (`#b9b8b4`, `#bab9b5`, `#afaea9`, `#aaa9a5`, `#aaa9a4`, `#a7a49f`). (3) `#3a3a37` is used 8 times as a second text colour with no token. (4) Danger is spelled five ways: `--danger #a42a2a`, `#a02929`, `#a52b2b`, `#8f4242`, `#b54b4b`; danger-soft three ways: `#faeeee`, `#fff0ee`, `#fff5f3`. (5) `--warning-*` tokens exist but four rules write `#fff8e9` / `#e3ce9c` / `#6b4617` / `#71531f` / `#e6d7b3` directly. (6) One leftover from the retired magenta accent: `#cbacc5`. (7) `--text`, `--accent` and `--accent-ink` are the same colour. (8) `--border` and `--placeholder` fail contrast (pass 3). (9) Tokens are redefined inside a scope (`.concept-project-workspace`). | `design-system/drift.md` "Colour literals in CSS"; `src/styles/journey-conversation.css:134` (`.journey-…` text `#3a3a37`); `src/styles/globals.css:170` (`.form-error`); `src/styles/guided-conversation.css:112` (`.guided-conversation-error`); `src/styles/conversation.css:366` (`.segment-card.is-selected`, `#cbacc5`); `src/styles/strategy.css:56` (`.strategy-review-notice`); `src/styles/project-workspace.css:3-5`; `03_accessibility_technical.md` section 5 |

### 2.2 Typography

| What exists | Distinct values in use | Problems | Evidence |
| --- | --- | --- | --- |
| One family: Geist Sans through `geist/font/sans`, fallback Arial (`src/styles/globals.css:5`). Nine size tokens: `--text-xs` 12 to `--text-2xl` 28, `--text-display`, `--font-ui` 13, `--font-body` 14. Element styles for `h1` 24, `h2` 20, `h3` 15. No mono face in the interface. | **Font size: 19 literal values, 557 uses; 283 token uses, of which 262 are `--font-ui`.** Most used: 13 px (189 literal + 262 token), 12 px (117), 14 px (86), 16 (48), 20 (26), 15 (19), 24 (16), 18 (15), 28 (12), 17 (10), 22 (8), then 32, 11, 10, 30, 34. **Weights: 6** (500 ×145, 400 ×20, 450, 550, 600, 650). **Line heights: 28** (20 px ×83, 1.5 ×35, 18 px ×31, 1.6, 1.65, 22 px, 1.7 …). **Letter-spacing: 27**, in px and em mixed (`-0.4px`, `-.4px`, `-0.02em`, `-0.035em` …). | (1) The scale tokens are unused outside Plans; `--font-ui` is the only adopted one and it has the same value as `--text-sm`. (2) 13 px carries 54% of all sizes and 12 px another 14%, which is what pass 1 called "small type, and grey carries too much" (E-055). (3) Steps one pixel apart (14/15/16/17/18) with no assigned roles. (4) The same heading role has different sizes on different pages (page titles are 24, 28 and 32 px). (5) Line height is unitless in some files and pixels in others, so it does not follow the font size. (6) 8 `font-size … !important` overrides. (7) Weights 450, 550 and 650 are in-between values with no role. | `design-system/drift.md` "Font sizes", "Line heights", "Letter spacing"; `src/styles/tokens.css:26-34`; `src/styles/plans.css:12-142`; `src/styles/globals.css:19-21, 41`; `screens/settings__account-pro__1440.png`, `screens/plans__pro-current-pro__1440.png` |

### 2.3 Spacing

| What exists | Distinct values in use | Problems | Evidence |
| --- | --- | --- | --- |
| No spacing tokens. One layout gutter token (`--page-gutter` 32). | **53 literal values, 2,355 uses** in padding, margin and gap. Top ten: 12 px ×299, 8 ×249, 16 ×237, 20 ×192, 10 ×153, 14 ×151, 24 ×150, 4 ×119, 6 ×118, 18 ×102. | (1) Only 56% of uses (1,319) sit on a ten-step scale of 4, 8, 12, 16, 20, 24, 32, 40, 48, 64. (2) 31 values are off any 4 px grid, including every odd number from 1 to 31: 5 px ×44, 7 ×44, 13 ×41, 9 ×39, 15 ×37, 11 ×29, 17 ×21. (3) 10, 14 and 18 px together are 406 uses: a parallel "in-between" scale. (4) The same component has different padding per page (cards: 8, 16, 20, 22, 24, 28 px). | `design-system/drift.md` "Spacing: literal"; `src/styles/globals.css:108, 164, 191, 215` (`.draft-card`, `.form-panel`, `.segment-card`, `.settings-panel`) |

### 2.4 Radius

| What exists | Distinct values in use | Problems | Evidence |
| --- | --- | --- | --- |
| `--radius-control` 12, `--radius-card` 16, `--radius-panel` 20, `--radius-pill` 999, plus `--panel-radius` (an alias of card). | 211 token uses; **203 literal uses in 18 values**: 50% ×39, 10 px ×29, 7 ×29, 6 ×22, 8 ×19, 5 ×15, 12 ×11, 4 ×8, 20 ×5, 999 ×5, 14, 9, 16, 2, 24, 26, 3. | (1) Half of all radii bypass the tokens. (2) `--panel-radius` (16) and `--radius-panel` (20) are different values with near-identical names. (3) No token below 12, so every small element invents one: 4, 5, 6, 7, 8, 9, 10 px are all in use (126 uses). (4) Two generations side by side: pill buttons next to a square-ish `.icon-button` (6 px) and `.small-badge` (4 px). (5) Menus use 14, 16 and 10 px for the same kind of panel. | `design-system/drift.md` "Radius: literal"; `src/styles/tokens.css:36-41`; `src/styles/globals.css:54, 58` (`.icon-button`, `.small-badge`); `src/components/journey/journey.module.css:93` (`.menu`, 14 px); `src/styles/project-card-actions.css:31` (`.project-card-menu`) |

### 2.5 Elevation (shadows and layering)

| What exists | Distinct values in use | Problems | Evidence |
| --- | --- | --- | --- |
| No shadow tokens and no z-index scale. | **34 distinct shadows in 41 uses.** 12 z-index values in 32 uses (1, 2, 3, 4, 5, 10, 16, 25, 30, 40, 50, 0). 9 dialog backdrops in 7 variants. | (1) Nearly every shadow is unique: the floating pill, the account menu, the composer and the gallery toolbar each use a slightly different "12 to 16 px blur, about 30% ink" shadow. (2) Dialog shadows range from none to `0 24px 100px` at 20% black. (3) Backdrops are ink at 22%, 26%, 33% (three times), 40% (three times, one in a different black) and 53%, two of them with a blur and the rest without. (4) Shadows are used for three unrelated jobs with no naming: lifting a surface, drawing a 1 px selection ring, and drawing a focus ring. (5) The skip link and dialogs share z-index 50; menus are 25 on one page and 40 on another. | `design-system/drift.md` "Box shadows", "z-index"; `src/components/journey/journey.module.css:21, 108`; `src/styles/home-concept.css:57`; `src/styles/auth.css:142-151` (`.auth-signout-dialog`); `src/components/visual-directions/visual-directions-view.module.css:422`; `src/components/naming/naming-inspect.module.css:21` |

### 2.6 Layout, grid and breakpoints

| What exists | Distinct values in use | Problems | Evidence |
| --- | --- | --- | --- |
| `--page-max` 1056, `--conversation-max` 792, `--page-gutter` 32. A second set in another file: `--branding-max-width` 1440, `--branding-gutter` 32 / 24 / 16 (`src/styles/branding-stage.module.css:4-9`). A legacy `.page` class at 1360 px. No column grid. | **21 viewport-width breakpoints** (19 `max-width`, 2 `min-width`), most used 760 px ×22, 540 ×16, 600 ×12, 700 ×8, then 1100, 1150, 1190, 900, 1000, 850, 1050 … down to 340. 4 container-query widths in the gallery. **51 `max-width` values.** | (1) No shared breakpoints: the same layout decision happens at 700, 760 or 850 px depending on the file. (2) Everything is written desktop-down (`max-width`), which is consistent with the owner's desktop-first priority but leaves no defined behaviour between breakpoints. (3) Page widths differ by page: 792, 1056, 1088, 1120, 1160, 1260, 1360, 1440 (pass 1, section 4). (4) Two pages fail at narrow widths: Plans keeps three columns (A-014) and the project bar loses its step names (A-016). (5) The gallery's container queries are the one modern, well-structured piece and should be kept. | `design-system/drift.md` "Breakpoints", "max-width"; `src/styles/tokens.css:43-46`; `src/styles/globals.css:34-40, 211, 405`; `src/components/inspiration/inspiration.css:218-233`; `screens/plans__pro-current-pro__390.png` |

### 2.7 Iconography

| What exists | Distinct values in use | Problems | Evidence |
| --- | --- | --- | --- |
| One `Icon` component with 24 hand-drawn line icons on a 24 px grid, stroke 1.55, default size 20 px (`src/components/ui/icon.tsx`, used 94 times in 37 files). No icon library dependency. | 10 component files draw their own inline SVG outside `Icon`, with strokes of 1.2, 1.4, 1.5, 1.55 and 1.6. **123 static SVG files** in six `public/` folders used as artwork through five `*Artwork` components (`handles/` 34, `projects/` 28, `settings/` 17, `project-workspace/` 16, `auth/` 15, `assets-library/` 13), many of them single arrows, chevrons and sort glyphs loaded as images. | (1) Three ways to draw an icon (the `Icon` component, ad-hoc inline SVG, an `<img>` of an SVG file), so stroke weight and colour differ, and image icons cannot take the text colour. (2) Five stroke weights. (3) The set has gaps that force the ad-hoc icons: no heart, eye, download, copy, expand, external link, info or warning. (4) No size tokens: the component defaults to 20 px and each caller passes its own size. (5) The Embel mark is a 19 KB SVG drawn at 28 px (pass 0). | `src/components/ui/icon.tsx:3-27, 145-162`; `src/components/auth/auth-icons.tsx`; `src/components/ui/projects-artwork.tsx`; `00_inventory.md` section 4; `04_image_needs.md` |

### 2.8 Motion

| What exists | Distinct values in use | Problems | Evidence |
| --- | --- | --- | --- |
| No motion tokens. 6 keyframe animations (`auth-spin`, `embel-flow-enter`, `embel-research-pulse`, `guided-thinking-pulse`, `journey-bar`, `pulse`) and about 15 transition declarations. A global reduced-motion rule (`src/styles/globals.css:332`). | Durations: 120 ms ×12, 150 ×2, 200 ×1 (transitions); 160, 800, 1500, 1600, 2400, 2800 ms (animations). Easings: `ease-in-out` ×4, `ease` ×3, `ease-out` ×1, `linear` ×1. Properties animated: `opacity`, `transform`, `border-color`, `background-color`, `box-shadow`, `fill`. | Pass 2 covers this in full. In system terms: (1) no pressed state on any of 59 kinds of control (M-001); (2) dialogs and menus appear in one frame (M-003); (3) three near-identical pulse loops at 1.5, 1.6 and 2.8 s; (4) the global reduced-motion rule also removes the spinner, the progress bar and the skeleton pulse, so waiting looks frozen (M-004); (5) hover changes are instant on most controls and 120 ms on a few, with no rule. The restraint itself is right and stays. | `design-system/drift.md` "Durations", "Easings", "Keyframes"; `02_motion_interaction.md` sections 5, 8 and 9; `motion/probe-summary.md` |

### 2.9 Components (summary; the full table is in section 3f)

| What exists | Distinct implementations | Problems | Evidence |
| --- | --- | --- | --- |
| No component library. `src/components/ui/` holds only `Icon`, the app mark, the artwork wrappers and one detail sheet. Everything else is a class convention in 41 stylesheets: 25 global files and 16 CSS modules. | 1,267 class selectors. Buttons: 4 implementations. Dialogs: 10, each with its own CSS. Menus and popovers: at least 6. Messages: about 20 classes. Empty states: 24 classes. Selected state: 8 treatments. Focus ring: 11 different offsets, and 14 places that remove the outline. | (1) **157 selectors (12%) are not mentioned by any component**, concentrated in `src/styles/globals.css` (53 of 127), `src/styles/project-naming.css` (35 of 60) and `src/styles/project-workspace.css` (32 of 97): styles for screens that no longer exist. (2) Class prefixes record the product's history, not its structure: `guided-`, `concept-`, `project-`, `sg-`, `identity-`, `conversation-`, `journey-`. (3) 35 `!important` declarations, mostly forcing a font size against a global rule. (4) 43 inline style objects in 16 files; most are legitimate (generated brand colours on Assets, `next/og` images). | `design-system/components.md`; `src/styles/globals.css:41-58`; `src/components/logo-creation/logo-creation.module.css:134-167`; `src/components/visual-directions/visual-directions-view.module.css:113-168`; `src/styles/identity.css:33-57` |

## 3. Target specification

Everything in this section is a specification in words and values. It contains no code and no designs. Where a choice is a matter of taste it is marked **decide in Claude Design** with two options; the full list of those decisions is at the end of the section (3h).

Two rules apply throughout. First, the Direction outranks any preference here. Second, the owner's November 6 decisions stand: a floating pill navigation, rounder corners, a neutral ink emphasis, and no magenta.

### 3a. Token architecture

Three layers. Each layer may only refer to the layer above it.

| Layer | What it holds | Naming | Who uses it |
| --- | --- | --- | --- |
| 1. Primitive | Raw values with neutral names: the grey ramp, the status hues, the spacing steps, the radius steps, the type steps, durations. No meaning. | `--neutral-200`, `--red-700`, `--space-4`, `--radius-3`, `--font-size-3`, `--duration-2` | Only the semantic layer. Stylesheets never use a primitive directly. |
| 2. Semantic | Roles that point at primitives. This is the layer components are written against, and the layer a future accent or dark theme re-points. | `--color-<group>-<role>`, `--text-<role>`, `--space-<role>` where a role helps, `--radius-<role>`, `--shadow-<role>`, `--z-<role>`, `--duration-<role>`, `--ease-<role>` | Every stylesheet. |
| 3. Component | Values that belong to one component and would be wrong as a global role. Added only when two or more places need the same component-specific value. | `--button-height`, `--field-padding-x`, `--dialog-width-md`, `--nav-height`, `--focus-ring-width` | That component's styles, and layouts that must align with it. |

Proposed semantic names. The "today" column shows what each replaces, so nothing existing is lost.

| Group | Token | Points at | Today |
| --- | --- | --- | --- |
| Background | `--color-bg-canvas` | neutral-50 `#f7f7f5` | `--canvas` |
| | `--color-bg-paper` | neutral-0 `#ffffff` | `--paper` |
| | `--color-bg-sunken` | neutral-100 `#f1f0ee` | `--surface`, `--accent-soft` |
| | `--color-bg-hover` | neutral-100 | `--surface` on hover, `--canvas` on secondary-button hover |
| | `--color-bg-selected` | neutral-100 | `--accent-soft`, `--surface` |
| | `--color-bg-disabled` | neutral-100 | `--surface` |
| | `--color-bg-inverse` | neutral-900 `#191919` | `--text` used as a fill, `--accent` |
| | `--color-bg-scrim` | neutral-900 at 40% | 9 backdrop literals |
| | `--color-bg-positive-soft`, `-danger-soft`, `-warning-soft` | green-50, red-50, amber-50 | `--positive-soft`, `--danger-soft`, `--warning-soft` and their literal copies |
| Text | `--color-text` | neutral-900 | `--text`, `--accent-ink` |
| | `--color-text-muted` | neutral-600 `#696965` | `--secondary` |
| | `--color-text-placeholder` | candidate (3b) | `--placeholder` and two literals |
| | `--color-text-disabled` | candidate (3b) | `--secondary` on disabled, `--placeholder` |
| | `--color-text-inverse` | neutral-0 | `--on-accent`, `--paper` used as text |
| | `--color-text-positive`, `-danger`, `-warning` | green-700, red-700, amber-800 | `--positive`, `--danger`, `--warning` and literal copies |
| Border | `--color-border` | neutral-200 `#e4e3df` | `--border` on cards and dividers |
| | `--color-border-strong` | neutral-300 `#c9c8c2` | `--border-strong`, 12 near-grey hover literals |
| | `--color-border-control` | candidate (3b), 3:1 | `--border` on fields, selects, checkboxes (**new role**) |
| | `--color-border-selected` | neutral-900 | `--text`, `--accent-ink` as borders and 1 px rings |
| | `--color-border-danger` | red-500 `#b54b4b` | literal `#b54b4b` |
| | `--color-border-danger-soft`, `-warning-soft` | red-200, amber-200 | `--danger-border`, `--warning-border` |
| Accent | `--color-accent` | neutral-900 (Option A) or the chosen accent (Option B) | `--accent` |
| | `--color-accent-hover` | neutral-800 `#3a3a37` | `--text-strong-hover` `#333`, literal `#3a3a37` |
| | `--color-on-accent` | neutral-0 | `--on-accent` |
| Icon | `--color-icon`, `--color-icon-muted` | neutral-900, neutral-600 | inherited text colour |
| Focus | `--focus-ring-color`, `--focus-ring-halo` | neutral-900, neutral-0 | `outline: 2px solid var(--accent-ink)` |
| | `--focus-ring-width`, `--focus-ring-offset`, `--focus-ring-inset` | 2 px, 2 px, -2 px | 11 different offsets |
| Other | `--color-selection` | neutral-200 | `--selection` |
| | `--pattern-dot-grid` | neutral-300 dots (see 3h, decision 6) | `--dot-grid` and two literal copies |

Rules that keep the system from drifting again:

1. A stylesheet contains no hex value, no pixel font size, no pixel radius and no shadow. The only raw lengths allowed are 1 px borders, percentages, and layout measurements that belong to one component (an image aspect, a grid track).
2. Tokens live in one place. A scope may not redefine a global token (today `.concept-project-workspace` redefines three).
3. One name per value-with-a-role. No aliases kept "for older panels".
4. A new token needs a second use. One-off values stay local as component tokens.
5. Emails and exported files (the brand guide, the kit README) cannot read CSS variables from the app. They take the same primitive values, written out, from one shared source file so they do not drift from the app.

### 3b. Colour

**Light mode only.** The app has no dark mode today and the Direction does not ask for one, so none is specified. The two-layer structure above is what makes one possible later without touching components: a dark theme would re-point the semantic layer only.

**Primitives.** The warm grey ramp is kept, because it is the base of the confirmed look. Three steps are new and one is promoted from a stray literal.

| Primitive | Value | Status |
| --- | --- | --- |
| `--neutral-0` | `#ffffff` | kept (`--paper`) |
| `--neutral-50` | `#f7f7f5` | kept (`--canvas`) |
| `--neutral-100` | `#f1f0ee` | kept (`--surface`) |
| `--neutral-200` | `#e4e3df` | kept (`--border`) |
| `--neutral-300` | `#c9c8c2` | kept (`--border-strong`) |
| `--neutral-400` | candidate `#a3a29d` or `#8f8e89` | **new**: disabled text and icons |
| `--neutral-500` | candidate `#85847f` or `#8a8985` | **new**: control outlines |
| `--neutral-600` | `#696965` | kept (`--secondary`) |
| `--neutral-800` | `#3a3a37` | promoted from a literal used 8 times; replaces `#333333` |
| `--neutral-900` | `#191919` | kept (`--text`) |
| `--green-50`, `--green-700` | `#eef3ef`, `#3d6448` | kept |
| `--red-50`, `--red-200`, `--red-500`, `--red-700` | `#faeeee`, `#e5c4c4`, `#b54b4b`, `#a42a2a` | kept; `--red-500` promoted from a literal |
| `--amber-50`, `--amber-200`, `--amber-600`, `--amber-800` | `#fff8e9`, `#e3ce9c`, candidate `#9a7326`, `#6b4617` | kept; `--amber-600` **new** |

There is no blue "information" colour and none is proposed: neutral messages use the neutral ramp, which keeps the interface quiet.

**Contrast of every pair.** Calculated by `design-audit/tools/ds-contrast.mjs`; the long form, one row per pair, is `design-system/contrast.md`. Ratios are floored, so a failing value is never rounded up. "Min" is the WCAG AA minimum for that role.

Text and icons on each background (minimum 4.5:1 for text, 3:1 for icons):

| Foreground role | Value | on paper `#ffffff` | on canvas `#f7f7f5` | on sunken `#f1f0ee` | on its own soft fill | Result |
| --- | --- | --- | --- | --- | --- | --- |
| `--color-text`, `--color-icon` | `#191919` | 17.58 | 16.39 | 15.43 | positive-soft 15.65, danger-soft 15.51, warning-soft 16.62 | pass |
| `--color-text-muted`, `--color-icon-muted` | `#696965` | 5.51 | 5.13 | 4.84 | positive-soft 4.9, danger-soft 4.86, warning-soft 5.21 | pass (narrowest: 4.84) |
| `--color-text-positive`, positive icon | `#3d6448` | 6.74 | 6.28 | 5.91 | 6.0 | pass |
| `--color-text-danger`, danger icon | `#a42a2a` | 7.13 | 6.65 | 6.26 | 6.29 | pass |
| `--color-text-warning`, warning icon | `#6b4617` | 8.35 | 7.78 | 7.33 | 7.89 | pass |

Text and icons on filled controls (minimum 4.5:1):

| Pair | Foreground | Background | Ratio | Result |
| --- | --- | --- | --- | --- |
| Primary button, current navigation item, checked box, send arrow | `#ffffff` | `--color-accent` `#191919` | 17.58 | pass |
| The same on hover, candidate A | `#ffffff` | `--neutral-800` `#3a3a37` | 11.41 | pass |
| The same on hover, candidate B (today) | `#ffffff` | `#333333` | 12.63 | pass |
| Filled destructive button (new) | `#ffffff` | `--red-700` `#a42a2a` | 7.13 | pass |
| Label on a selected chip or choice card | `#191919` | `--color-bg-selected` `#f1f0ee` | 15.43 | pass |

Candidates still to be chosen. Each row gives every candidate's ratio and the minimum the role must meet.

| Role | Candidate | on paper | on canvas | on sunken | Minimum | Note |
| --- | --- | --- | --- | --- | --- | --- |
| `--color-text-placeholder` | A: `#696965` (same as muted text) | 5.51 | 5.13 | 4.84 | 4.5 on every field background | Passes everywhere; placeholder and hint text look the same, so the field must not rely on the placeholder as its label. |
| | B: `#6f6e69` | 5.1 | 4.76 | **4.48 fail** | | Visibly lighter than hints; allowed only if fields never sit on the sunken fill. |
| | today: `#82817b` | 3.9 | 3.64 | 3.43 | | Fails (A-002). |
| `--color-border-control` | A: `#85847f` | 3.74 | 3.49 | 3.29 | 3 on every background a field sits on | Passes on all three. |
| | B: `#8a8985` | 3.5 | 3.26 | 3.07 | | Lighter; only just passes on the sunken fill. |
| | C: `#696965` (same as muted text) | 5.51 | 5.13 | 4.84 | | Heaviest; one fewer primitive. |
| | today: `#e4e3df` | 1.28 | 1.19 | n/a | | Fails (A-001). |
| `--color-text-disabled` | A: `#a3a29d` | 2.55 | n/a | 2.24 | none required (WCAG exempts disabled controls); house minimum recommended: 3 | Clearly "off", hard to read. |
| | B: `#8f8e89` | 3.28 | n/a | 2.88 | | Readable on paper; just under 3 on the disabled fill, so pair it with a paper background and a hairline. |
| | today, measured: `#b0afac` on `#f1f0ee` | n/a | n/a | 1.92 | | Pass 3. |
| `--color-border-warning` | `#9a7326` | 4.32 | n/a | on warning-soft 4.09 | 3 | New; only needed if a warning ever outlines a control. |

Outlines, rings and marks (minimum 3:1 where the mark identifies a control or a state):

| Role | Value | Against | Ratio | Min | Result |
| --- | --- | --- | --- | --- | --- |
| `--color-border` (card edge, divider) | `#e4e3df` | paper / canvas | 1.28 / 1.19 | none: decorative | kept as a hairline only |
| `--color-border-strong` (card hover) | `#c9c8c2` | paper / canvas | 1.67 / 1.56 | none: decorative | kept |
| `--color-border-control` hover and focus | `#191919` | paper / canvas / sunken | 17.58 / 16.39 / 15.43 | 3 | pass |
| `--color-border-selected`, radio and checkbox fill | `#191919` | paper / canvas / sunken | 17.58 / 16.39 / 15.43 | 3 | pass |
| Checkbox and radio, unchecked outline (candidate A) | `#85847f` | paper / sunken | 3.74 / 3.29 | 3 | pass |
| `--color-border-danger` (invalid field, outlined danger button) | `#b54b4b` | paper / canvas / danger-soft | 5.15 / 4.8 / 4.54 | 3 | pass |
| `--color-border-danger-soft` (edge of a message box) | `#e5c4c4` | danger-soft / paper | 1.42 / 1.61 | none: decorative | must not outline a button (today it does) |
| `--color-border-warning-soft` | `#e3ce9c` | warning-soft | 1.46 | none: decorative | kept |
| Positive outline | `#3d6448` | paper / positive-soft | 6.74 / 6.0 | 3 | pass |
| `--focus-ring-color` (ink) | `#191919` | paper / canvas / sunken | 17.58 / 16.39 / 15.43 | 3 | pass |
| `--focus-ring-color` (ink) alone on artwork | `#191919` | `#121212` / `#030436` / `#7a7a7a` | 1.06 / 1.11 / 4.09 | 3 | **fails on dark artwork**: the reason for the halo |
| `--focus-ring-halo` (paper) on artwork | `#ffffff` | `#121212` / `#030436` / `#7a7a7a` | 18.73 / 19.54 / 4.29 | 3 | pass |
| Ink ring against its own halo | `#191919` | `#ffffff` | 17.58 | 3 | pass |
| Icon on a paper chip (92% opacity) over artwork: heart, expand, close | `#191919` | chip over `#121212` = `rgb(236 236 236)`; over white = `#ffffff` | 14.88 / 17.58 | 3 | pass |
| The chip itself against dark artwork | `rgb(236 236 236)` | `#121212` | 15.85 | 3 | pass |

Colour rules:

1. **Hairline or outline, never both jobs.** `--color-border` draws cards and dividers. `--color-border-control` draws anything a person types into or ticks. Secondary buttons keep the hairline, because their label identifies them, but must be told apart from cards by shape and height.
2. **The focus ring is two-part everywhere:** a 2 px ink ring with a 2 px paper halo outside it, drawn outside free-standing controls and inside controls that fill a clipped box (gallery tiles, image cards).
3. **Status colour is for status.** Green, red and amber never decorate. A message always carries an icon or a word as well as its colour.
4. **Controls drawn on images sit on a chip.** No bare white strokes on artwork (A-020).
5. **Embel's interface stays neutral so the generated brand carries the colour.** A generated brand's colours appear only inside clearly bounded previews, never as interface chrome, and any text the app sets on a brand colour picks black or white by calculated contrast (A-023).

**Accent: decide in Claude Design (decision 1).**

| | Option A: ink only | Option B: one quiet accent |
| --- | --- | --- |
| What it is | `--color-accent` stays `#191919`. Emphasis comes from weight, size, fill and position. | One low-chroma colour used only for selection, links and the focus ring. Buttons stay ink. |
| For | Nothing competes with the person's brand; it is the confirmed November 6 state; no hue to maintain. | Selected and focused things can be told from plain ink text at a glance; gives Embel one recognisable trait. |
| Against | "Selected", "primary" and "plain text" are all the same black, so selection must be carried by shape (a 2 px ring, a tick). | A second colour next to generated palettes can clash with a particular brand; needs discipline to stay in three roles. |
| Candidates and ratios | Rows above. | Ink blue `#24406b`: 10.39 on paper, 9.68 on canvas, 9.12 on sunken, white on it 10.39. Slate `#3d4f63`: 8.41, 7.84, 7.38, white on it 8.41. |
| Minimum for any chosen value | n/a | 4.5:1 as text on paper, canvas and sunken; 4.5:1 for text set on it; 3:1 as a ring. It must not be magenta, and should stay out of green, red and amber, which carry status. Neither candidate differs from ink by lightness (1.69:1 and 2.09:1), so in both options a selected state also needs a non-colour cue. |

### 3c. Typography

**Family.** The interface uses one sans-serif for everything today (Geist Sans). Whether a second face joins it is a taste decision.

**Typeface: decide in Claude Design (decision 2).**

| | Option A: Geist Sans alone | Option B: Geist Sans plus one display face |
| --- | --- | --- |
| What it is | One family for interface and headings. Identity comes from the scale, weight and spacing below. | Geist for interface text. A second face only for the Home headline, page titles and the brand's name on Assets (roles `display`, `title-xl`, `title-lg`). |
| For | Already loaded, no extra download, excellent numerals, neutral next to any generated brand. | Gives Embel a recognisable voice in the three places where it speaks as itself. Addresses E-055 (the stock framework typeface). |
| Against | Geist is the framework's default face, so on its own it reads as "any AI tool". | One more font file on Home, whose phone-condition LCP is already 2.4 s against a 2.5 s limit (pass 3); a face with strong character can compete with the person's logo. |
| Constraints for any choice | n/a | Must not be one of the families offered to generated brands (`public/fonts/brand/`: Fraunces, Lora, Manrope, Noto, Geist), so Embel's own headings are never mistaken for a customer's brand. Open or web licence. Loaded with swap and matched fallback metrics so headings do not shift. Never below 24 px. |

**Type scale.** Ten steps replace 19 sizes, 28 line heights and 27 letter-spacings. Each role fixes size, line height, weight and letter-spacing together, so a component picks one role and nothing else. Line heights are multiples of 4 px. Letter-spacing is in `em`, never px.

| Role token | Size / line height | Weight | Letter-spacing | Serves | Replaces today |
| --- | --- | --- | --- | --- | --- |
| `--text-display` | clamp(32 px, 4vw, 44 px) / 1.1 | 500 | -0.03em | The Home headline only. | `--text-display`, `.home-…` 32 to 44 |
| `--text-title-xl` | 32 / 40 | 500 | -0.02em | A brand's name on Assets and in the exported guide; the name preview. | 28, 30, 32, 34 px |
| `--text-title-lg` | 24 / 32 | 500 | -0.02em | Page titles (Projects, Library, Plans, Settings), prices, error-page titles. | `h1` 24, 28 px titles |
| `--text-title-md` | 20 / 28 | 500 | -0.015em | Section headings, dialog titles, step headings in the conversation. | `h2` 20, 22 px |
| `--text-title-sm` | 16 / 24 | 500 | -0.01em | Card titles, plan names, sub-section headings. | `h3` 15, 16, 17, 18 px headings |
| `--text-body-lg` | 18 / 28 | 400 | 0 | The Home prompt as typed; lead sentences in the conversation. | 17, 18 px |
| `--text-body` | 15 / 24 (density A) or 16 / 24 (density B) | 400 | 0 | Conversation text, descriptions, values typed into fields. | `--font-body` 14, 15, 16 px body |
| `--text-label` | 14 / 20 | 500 | 0 | Buttons, navigation, field labels, tabs, menu rows, table headers. | `--font-ui` 13 px on controls (262 uses), 13 px weight 450 |
| `--text-small` | 13 / 20 | 400 | 0 | Hints, meta lines, secondary text, table cells, badges. | 13 px (189 literal uses), 12 px used for instructions |
| `--text-caption` | 12 / 16 | 400 | 0.01em | Timestamps, counters, legal lines. The smallest size. Never used for an instruction, an error or the only label of a control. | 10, 11, 12 px |

Rules:

1. **Three weights:** 400 (reading), 500 (labels and headings), 600 (the Embel wordmark and emphasised numbers only). 450, 550 and 650 are retired.
2. **Nothing under 12 px.** Status and error text is at least `--text-small`.
3. **Fields use at least 16 px at compact width**, so phones do not zoom on focus (the code already does this below 540 px).
4. **Numbers that line up** (credits, prices, the usage table, dates in lists) use tabular figures.
5. **Reading measure:** running text is capped at about 68 characters per line (`--measure: 68ch`), also inside the 792 px conversation column.
6. **Headings wrap in balance** and generated brand names and the Embel wordmark are marked not to be translated (A-033).
7. **Grey is not a hierarchy tool on its own.** Use `--color-text-muted` for genuinely secondary text; recovery actions, errors and the current status are in `--color-text`.
8. **One punctuation style for titles:** no trailing full stop on page titles (today "Projects." and "Settings." have one and "Plans" does not).

### 3d. Spacing, radius, elevation and layout

**Spacing scale.** A 4 px base with two half steps for fine alignment inside controls. 14 steps replace 53 values.

| Token | Value | Typical use |
| --- | --- | --- |
| `--space-0-5` | 2 px | Optical nudges; gap between a label and its counter. |
| `--space-1` | 4 px | Icon to its own badge; stacked meta lines. |
| `--space-1-5` | 6 px | Padding inside chips and menus. |
| `--space-2` | 8 px | Icon to label; between related buttons; label to field. |
| `--space-3` | 12 px | Padding inside fields and small cards; between list rows. |
| `--space-4` | 16 px | Default gap between items in a group; compact gutter; card padding at compact width. |
| `--space-5` | 20 px | Between form fields. |
| `--space-6` | 24 px | Card padding; gap between cards; medium gutter. |
| `--space-8` | 32 px | Wide gutter; between a heading block and its content. |
| `--space-10` | 40 px | Between groups inside a page. |
| `--space-12` | 48 px | Between page sections. |
| `--space-16` | 64 px | Page-level empty states; top and bottom of long pages. |
| `--space-24` | 96 px | Clearance under the floating composer; the Home hero. |

Today's in-between values map as follows: 5 and 7 go to 4 or 8 (6 inside chips); 9, 10 and 11 go to 8 or 12; 13, 14 and 15 go to 12 or 16; 17, 18 and 19 go to 16 or 20; 22 and 23 go to 24; 26, 28 and 30 go to 24 or 32. The rule for choosing: gaps round down, padding rounds up.

Semantic spacing roles are few, and are where the density decision lives: `--space-card` (card padding), `--space-stack` (between fields), `--space-section` (between page sections), `--space-gutter` (page side padding).

**Density: decide in Claude Design (decision 3).**

| | Option A: comfortable | Option B: roomy |
| --- | --- | --- |
| Values | Body 15 / 24. Controls 44 px tall. Card padding 24. Between sections 48. | Body 16 / 24. Primary buttons and fields 48 px tall, secondary 40. Card padding 32. Between sections 64. |
| For | Closest to today, so the least layout regression. Keeps the long conversation page (5,400 px for a finished brand) from getting longer. | Matches "generous white space" in the Direction most directly; easier for the non-designer audience to read. |
| Against | Less of a visible step up from today; "premium" then depends on type and imagery. | Long pages get about 15% longer; Plans and the project bar, which already fail at narrow widths, get tighter; more scrolling in the logo and direction steps. |

**Radius scale.** Six steps replace 18 literal values and the two confusingly named panel tokens.

| Token | Value | Use | Replaces |
| --- | --- | --- | --- |
| `--radius-inset` | 4 px | Checkboxes, tags inside a control, thumbnails up to 40 px, the tick mark's box. | 2, 3, 4, 5 px |
| `--radius-small` | 8 px | Menu rows, inline messages, small tiles, tooltips, code blocks. | 6, 7, 8, 9, 10 px |
| `--radius-control` | 12 px | Fields, selects, textareas (and buttons under decision 4, option B). | `--radius-control`, literal 12 |
| `--radius-card` | 16 px | Cards, menus, popovers, image frames. | `--radius-card`, `--panel-radius`, 14, 16 px |
| `--radius-panel` | 20 px | Dialogs, sheets, the composer, large panels. | `--radius-panel`, 20, 24, 26 px |
| `--radius-pill` | 999 px | The floating navigation, chips, badges, avatars and round icon buttons (and buttons under decision 4, option A). | `--radius-pill`, 999 px, `50%` on non-circles |

Nested corners follow one rule: inner radius = outer radius minus the padding between them, rounded to the nearest step, never below `--radius-inset`.

**Control shape: decide in Claude Design (decision 4).**

| | Option A: pill buttons (today) | Option B: pill for navigation and chips only |
| --- | --- | --- |
| What it is | Buttons, chips, search fields and the navigation are all pills; fields are 12 px. | The navigation, chips, badges and the round send button stay pills. Buttons take the 12 px control radius, like fields. |
| For | The confirmed November 6 look; soft and friendly for non-designers. | A button and a filter chip no longer look alike; forms line up (field and button share a corner); reads as more precise. Addresses E-055 ("pill shapes for everything"). |
| Against | Pills on every control flatten hierarchy; wide pill buttons in full-width cards look heavy. | A visible change from the confirmed look; needs the owner's agreement. Still "rounder corners". |

**Elevation.** Four levels. Cards do not have shadows: a card is a hairline on paper, and its hover is a stronger hairline, not a lift (pass 2: no hover lifts).

| Token | Value | Use | Replaces |
| --- | --- | --- | --- |
| `--shadow-none` | none | Cards, panels, fields. | 7 small card and tile shadows (1 to 7 px offsets) |
| `--shadow-raised` | `0 12px 32px -16px rgb(25 25 25 / 0.28)` | Things that float over the page permanently: the navigation pill, the composer, the gallery toolbar. | 8 floating-surface shadows, each slightly different |
| `--shadow-overlay` | `0 16px 40px -16px rgb(25 25 25 / 0.30)` | Menus and popovers. | 4 menu and popover shadows |
| `--shadow-modal` | `0 24px 80px rgb(25 25 25 / 0.15)` | Dialogs and sheets. | 6 dialog shadows, and the 4 dialogs that have none |
| `--color-bg-scrim` | ink at 40%, no blur | Behind every dialog and sheet. | 9 backdrops in 7 variants; two blurred |

The first two values are the app's own most-used shadows, kept. Selection rings and focus rings are not shadows in this system; they are the border and focus tokens in 3a.

**Layering.**

| Token | Value | Use |
| --- | --- | --- |
| `--z-base` | 0 | Page content. |
| `--z-raised` | 1 | Overlap inside one component (a badge on a card). |
| `--z-sticky` | 10 | Sticky headers, the docked composer. |
| `--z-nav` | 30 | The floating navigation. |
| `--z-popover` | 40 | Menus and popovers. |
| `--z-toast` | 60 | Toasts. |
| `--z-skip-link` | 70 | The skip link. |
| (none) | browser top layer | Dialogs and sheets stay native `<dialog>` elements, which need no z-index. |

**Layout.**

| Token | Value | Use | Replaces |
| --- | --- | --- | --- |
| `--container-reading` | 792 px | The project conversation. | `--conversation-max`, 760, 780, 808 |
| `--container-page` | 1056 px | Projects, Library, Assets, Plans, Settings, Home's lower section. | `--page-max`, 1040, 1088, 1120, 1160, 1260, 1360, 1440 |
| `--space-gutter` | 16 / 24 / 32 px at compact / medium / wide | Page side padding. | `--page-gutter`, `--branding-gutter`, 20 to 52 px paddings |
| `--nav-height`, `--nav-offset` | 56 px, 16 px | The floating pill; page content starts 40 px below it. | Literals in `journey.module.css` |
| `--target-min` | 44 px | Minimum height and width of any control on touch widths; standalone text links get at least a 24 px tall box with 8 px around it (A-021). | 28 to 46 px control heights |

Breakpoints. Three named ranges replace 21 widths. CSS variables cannot be used inside media queries, so these are documented constants enforced by review, not tokens.

| Name | Range | Audit width inside it | Replaces |
| --- | --- | --- | --- |
| compact | below 640 px | 390 | 340, 360, 400, 440, 480, 540, 600 |
| medium | 640 to 1023 px | 768 | 640, 650, 700, 760, 761, 850, 900, 950, 1000 |
| wide | 1024 px and up | 1440 | 1050, 1100, 1150, 1190, 1500 |

Component-level container queries stay allowed where a component's own width matters more than the window's (the inspiration gallery already does this well).

Grid and behaviour at the three audit widths:

| | 390 (compact) | 768 (medium) | 1440 (wide) |
| --- | --- | --- | --- |
| Columns, gap | 4, 16 px | 8, 20 px | 12, 24 px |
| Gutter | 16 px | 24 px | 32 px; content centred in its container |
| Card grids (projects, library, plans) | 1 across | 2 across | 3 across in the 1056 px container |
| Logo concepts, direction boards | 1 or 2 across, never smaller than 160 px | 2 or 3 across | 3 across, large enough to judge (E-033) |
| Forms | Label above field, full width; buttons full width | Label above field; two fields side by side only when related | Same as medium; maximum field width 480 px |
| Navigation pill | Brand mark, the three destinations as icons with names available to assistive technology, account | Full labels | Full labels |
| Project bar | Step names must stay visible or reachable (A-016) | Full | Full |
| Dialogs | Bottom sheet, full width, up to 90% of the height | Centred, fixed width | Centred, fixed width |
| Tables | Each row becomes a stacked card | Table | Table |

Two constraints from pass 3 apply at every width: no page scrolls sideways or clips at 320 px or at 200% zoom, and fixed chrome takes at most a quarter of a 450 px tall window. The owner's priority is desktop first; the compact column is specified so that the system is complete and nothing breaks, not as a request for phone-specific polish now.

### 3e. Motion

Taken from `02_motion_interaction.md` section 8 without change, and named to match this system.

| Token | Value | Use |
| --- | --- | --- |
| `--duration-fast` | 120 ms | Hover and selection colour, border, small fades. |
| `--duration-press` | 160 ms | Press scale; a tick or ring appearing. |
| `--duration-base` | 200 ms | Dialogs, content entering, thumbnails fading in. Menus use 150 ms (component token `--menu-duration`). |
| `--duration-slow` | 300 ms | A drawer or bottom sheet sliding; a finished result appearing. The ceiling for anything a person triggers. |
| `--duration-loop-pulse`, `-spin`, `-sweep` | 1.6 s, 0.8 s, 2.4 s | The three waiting patterns only. |
| `--ease-out` | `cubic-bezier(0.23, 1, 0.32, 1)` | Anything entering, and press. The default. |
| `--ease-in-out` | `cubic-bezier(0.77, 0, 0.175, 1)` | Something moving from one place to another. Rare here. |
| `--ease-drawer` | `cubic-bezier(0.32, 0.72, 0, 1)` | A panel or sheet sliding from an edge. |
| keywords | `ease`, `linear`, `ease-in-out` | Hover and colour changes; the spinner; the opacity pulse. Never `ease-in`. |
| `--press-scale` | 0.97 | Pressed buttons and cards. |
| `--enter-scale` | 0.97 | Dialogs and menus start here. Never from 0. |
| `--enter-shift` | 4 px | Content entering the conversation. |
| `--stagger` | 40 ms | Between the six concepts or three directions, for results only. |

When to animate (pass 2's nine rules, shortened): frequency decides, so route changes, tabs, typing and Escape do not animate; only opacity and transform move, while colour, border and background may fade; entrances are animated and exits are instant; every action shows a change within 100 ms on the control that was pressed; nothing already on screen moves because something else loaded; hover effects exist only where a pointer can hover (`hover: hover` and `pointer: fine`), and nothing is reachable by hover alone.

**Reduced motion.** The rule is "remove movement, keep feedback", which replaces today's global switch that removes everything (M-004):

- `--press-scale` and `--enter-scale` become 1, `--enter-shift` becomes 0, `--stagger` becomes 0, and smooth scrolling is off.
- Opacity fades stay, at `--duration-fast`.
- The skeleton keeps its 1.6 s opacity pulse; the spinner pulses instead of turning; the progress bar shows a static filled track with its status sentence.
- The logo "drawing" texture is replaced by its caption, as it is today.

### 3f. Components

One row per shared component. "States" lists the states that component must define, from the full set: default, hover, focus-visible, active (pressed), disabled, loading, error, selected. "Status" describes the code today: **exists** (one implementation), **duplicated** (several), **missing**. Evidence for each status is in `design-system/components.md`; the migration map in section 5 names the classes.

| # | Component | Variants | Sizes | Required states | Status today |
| --- | --- | --- | --- | --- | --- |
| 1 | **Button** | Primary (ink fill), secondary (paper, hairline), quiet (no border), danger (outlined), danger-filled (final step of a destructive confirmation only). Optional leading icon. A trailing arrow only on buttons that navigate to another page. | Medium 44 px; small 36 px for dense rows on pointer devices, with a 44 px touch target | default, hover, focus-visible, active, disabled, loading. Loading keeps the label, adds a spinner, stays focusable (`aria-disabled`, not `disabled`: A-003). | **Duplicated**: 4 implementations (`.button`, two module copies of `primaryButton` / `secondaryButton`, `.identity-*-button`) plus 37 unstyled `<button>` elements. No pressed state anywhere (M-001). Full width on some cards, hugging on others. |
| 2 | **Icon button** | Outlined, quiet, on-artwork (paper chip). Toggle form (heart, show password). | 44 px; 36 px on pointer devices | default, hover, focus-visible, active, disabled, loading, selected (pressed toggle). Always has an accessible name and a tooltip. | **Duplicated**: at least 7 (`.icon-button` square 6 px, `.assets-close` round, `.assets-open-detail`, `.project-card-menu-trigger` 36 px, `.inspiration-icon-button`, module `iconButton`, `.auth-password-toggle`). |
| 3 | **Link** | Inline (underlined, inside text), standalone (label, optional arrow), danger. | Inherits text size; standalone has a 24 px minimum box | default, hover, focus-visible, active, disabled. Visited is not styled. | **Duplicated**: `.text-link` (108 uses), module `textButton`, 20 link classes. Links already in ink show no hover (pass 2). Recovery actions styled as faint grey links. |
| 4 | **Text field** | Text, email, password (with show toggle), search (leading icon, clear button), number. Parts: label, optional hint, field, error text. | 44 px (48 under density B) | default, hover, focus-visible, disabled, read-only, error. Loading is shown as a status line under the field, never as a value in it (A-030). | **Exists** as `.field-label`, with variants built separately (`.search-field` pill, auth fields, gallery search). No hover state. Outline fails contrast (A-001). Three placeholder colours. |
| 5 | **Textarea and composer** | Plain textarea; composer (text area plus an actions row: attach, voice, send) used for the Home prompt, the reply box and "describe a change". | Auto-growing between a minimum and a maximum | default, hover, focus-within (standard ring on the frame), disabled, loading (request running: send becomes stop), error | **Duplicated**: Home composer, floating reply composer, logo refine box, slogan field, and a dead `.brief-composer`. Three focus treatments, one with none (A-012). |
| 6 | **Select** | Form select (native control, system-styled trigger and chevron); menu select for sort and filters (uses Menu). | 44 px | default, hover, focus-visible, disabled, error | **Exists** as native `<select>` with an overlaid chevron (8 uses, 6 files); the logo version drop-down shows the bare browser control. |
| 7 | **Checkbox, radio, switch** | Checkbox, radio, switch (for on/off settings; none today). Used alone with a label or inside a choice card. | 20 px box in a 44 px target | default, hover, focus-visible, active, disabled, error, selected (checked), and indeterminate for the checkbox | **Exists** as native inputs coloured with `accent-color` (12 checkboxes, 3 radios), 16 to 18 px, plus hand-drawn radios in the Name step. Outline contrast not controlled. |
| 8 | **Choice card** | Single choice (radio), multiple choice (checkbox), image choice (logo concept, direction board, inspiration tile). The control sits in one fixed position; for image choices the choice is a visible labelled button ("Choose"), with compare and enlarge as secondary actions (E-051). | Text card; image card at 1:1 and 4:5 | default, hover, focus-visible, active, disabled, loading (saving the choice), error, selected | **Duplicated**: 8 different selected treatments (ink fill, ink border with soft fill, 1 px ring, 0.5 px inset ring with shadow, 5 px radio border, left bar, green "Chosen" badge, underline). Logo and direction cards are not real radio controls (A-006, A-007). |
| 9 | **Range slider** | Single value with a labelled scale. | 44 px target, 4 px track | default, hover, focus-visible, active, disabled | **Exists** twice (`naming-length-range.module.css`, strategy review). |
| 10 | **Dialog** | Standard (title, body, actions), confirmation (see patterns), media (large image or brand view). Parts: header with title and one close button style, scrolling body, footer with actions right-aligned and the primary last. | Small 440, medium 560, large 860, extra large 1100 px; bottom sheet at compact width | Opening uses `--enter-scale` and `--duration-base`; closing is instant. Content states: loading, error. Focus moves in, is trapped, and returns to the opener. | **Duplicated**: 10 hand-built dialogs with widths of 450, 460, 480, 502, 520, 620, 680, 860 and 1100, radii of 16 and 20, shadows from none to 100 px blur, 7 backdrop variants, two close-button styles. Behaviour is good (native `<dialog>`). |
| 11 | **Drawer / sheet** | Right-edge drawer for a detail view next to a list; bottom sheet as the compact form of any dialog. | 480 and 860 px wide; full width at compact | Slides with `--ease-drawer` and `--duration-slow`; same focus rules as Dialog | **Exists** once each (`.assets-detail`, `context-details` sheet), unrelated to each other. Sticky headers can hide focus (A-032). |
| 12 | **Menu and popover** | Menu (a list of actions or choices), popover (a small non-modal panel: attach files, voice input). | Minimum 200 px wide; rows 40 px (44 at compact) | Row: default, hover, focus-visible, active, disabled, selected (tick), and a danger row. Opens with `--menu-duration`; closes on Escape, outside click and when focus leaves (A-011). | **Duplicated**: at least 6 menus and popovers, 5 of them built on `<details>`, with three radii and four shadows; only Library's closes when focus leaves. |
| 13 | **Toast** | Neutral confirmation, with an optional single action (Undo). | One size, bottom centre, above the composer | Appears with `--enter-shift`; leaves after 5 s or on dismiss; pauses on hover and focus; announced politely. | **Missing.** Confirmations are inline text in 119 `role="status"` regions; "Copied", "Downloaded" and "Moved to Deleted" have no common place. |
| 14 | **Inline message** | Neutral, positive, warning, danger. Forms: field-level (text under a field), block (in a card or section, with an optional action), page banner (full width under the navigation). Always an icon plus text. | Field, block, banner | Static; a block message may be dismissible. Danger and warning are announced assertively, the rest politely. | **Duplicated**: about 20 classes with 7 distinct looks (pass 1, section 4), five reds and three pink fills. |
| 15 | **Table** | Data table with a caption, header row, text and numeric columns. Stacks into cards at compact width. | Row 48 px | Row hover (pointer only), sorted column, loading (skeleton rows), empty | **Exists** once (Settings, Usage), without a caption (A-030). The colour-token list on Assets is a table built from `div`s (A-029). |
| 16 | **Card** | Static (a bounded group of content), interactive (the whole card is one link: project card), media (image with caption and actions: asset, concept, board), summary (a few labelled numbers: plan and credits). See decision 5 for when content is a card at all. | Padding from `--space-card` | Interactive and media cards: default, hover (stronger hairline), focus-visible, active, selected, disabled, loading (skeleton). Static cards have no states. | **Duplicated**: 48 card classes in 21 stylesheets; padding from 8 to 28 px; one look for every level of importance. |
| 17 | **Navigation: floating pill and project bar** | App navigation (brand mark, destinations, account); project bar (project switcher, four journey steps, save status). | 56 px tall | Item: default, hover, focus-visible, active, selected (current page or step), disabled (step not reached), complete. Loading: the account area reserves its width while the session is checked (E-008). | **Exists** (`floating-nav.tsx`, `project-capsule.tsx`, `journey.module.css`). Distinctive and kept. Changes width on load; loses step names when zoomed (A-016). |
| 18 | **Tabs and segmented control** | Underline tabs for page sections (Settings, Library); segmented control for switching a view in place (gallery categories, name availability). | 44 px | default, hover, focus-visible, active, selected, disabled. Arrow keys move between tabs. | **Duplicated**: 5 looks (`.sg-tabs`, `.assets-tabs`, module `tabs`, `.inspiration-views`, `.inspiration-categories`), plus dead `.step-navigation`. Settings and Library keyboard behaviour is correct and is the model. No hover state. |
| 19 | **Badge and chip** | Badge (not interactive: status in neutral, positive, warning, danger; "Current plan", "Chosen", "No logo yet"); chip (interactive: starter prompt, filter, removable); counter. | 24 px badge; 36 px chip with a 44 px target | Badge: static. Chip: default, hover, focus-visible, active, selected, disabled. | **Duplicated**: 45 classes; radii of 4, 5 and pill; `.small-badge`, `.preview-badge`, `.draft-stage`, `.selected-count` and module badges. |
| 20 | **Avatar** | Initials; image when one exists. | 32 and 40 px | Static; as the account button it takes Icon button states. | **Exists** (account circle), plus monogram variants on legacy cards. |
| 21 | **Empty state** | Page (visual slot, title, one sentence, one primary action); section (one sentence and a link, inside a card); no results (what was searched, and a clear-search action). | Page, section | Static | **Duplicated**: 24 classes in 14 stylesheets; three visual styles (icon in a grey square, bare icon, text only); two with dashed borders. |
| 22 | **Skeleton** | Text line, block, image frame, card (matching the real card's shape). | Matches the content it stands in for | 1.6 s opacity pulse; static under reduced motion with the pulse kept (3e) | **Missing** as a shared piece. Project cards have their own; other pages show "Loading…" text or nothing, which is what makes Assets and brand pages jump (A-024, A-025, M-019). |
| 23 | **Spinner, progress bar, thinking indicator** | Spinner (inside a pressed button); progress bar (AI work, with one status sentence and a stop control); thinking indicator (the assistant is composing). | Spinner 16 and 20 px; bar 4 px | Running, stopping, done, failed | **Duplicated**: three pulse loops at 1.5, 1.6 and 2.8 s, one spinner used only on auth buttons, one bar. |
| 24 | **Tooltip** | Name of an icon-only control; full value of truncated text; a formatted date for a relative time. | One size | Appears after 500 ms on hover and at once on keyboard focus; never holds essential information | **Missing.** Native `title` attributes show raw machine timestamps (A-028). |
| 25 | **Disclosure** | Folded answer in the conversation; "more details" inside a card. | Row 44 px | default, hover, focus-visible, expanded | **Exists** as 11 native `<details>` elements with individual styling. The folded-answer pattern works and is kept. |
| 26 | **Media frame** | A box with a fixed aspect ratio that holds a generated or uploaded image. | 1:1, 4:5, 16:9, and the brand board's 8:11 | loading (skeleton at the final size), loaded (fade in at `--duration-base`), failed (message and retry beside it, not inside a button: A-029), private or expired | **Missing** as a shared piece. Images arrive at unknown sizes and move the page (CLS 0.18 to 0.75, pass 3). "Loading preview", "Private board preview" and "Checking private preview…" are three wordings of one state. |
| 27 | **Icon** | One family, line style, drawn on a 24 px grid with one stroke weight. | 16, 20, 24 px | Takes the text colour; `--color-icon-muted` when secondary | **Exists** (`Icon`, 24 icons) but bypassed by 10 files of ad-hoc SVG and 123 image files (section 2.7). |

Components specific to Embel are assembled from the rows above and must not introduce new foundations: the conversation message (assistant text, the person's answer, a folded answer), the journey step header, the generation panel (progress bar, status sentence, stop), the out-of-credits prompt (a block message with two actions, not a floating card), the credit balance, the plan card, the colour swatch with copy, and the code block for exported tokens.

### 3g. Patterns

| Pattern | Rule | Today |
| --- | --- | --- |
| **Empty** | One Empty state per empty page: a visual slot (see `04_image_needs.md` for what fills it), a title that says what will appear here, one sentence, and the one action that fills it. Inside a card, a single sentence with a link. A search with no match names the search and offers to clear it. Never a dashed box. | Three styles and 24 classes; "Deleted projects" and "no match" are text only. |
| **Loading** | Three patterns and no others (pass 2, M-006). (1) Content loading: a Skeleton in the final shape and size, so nothing moves when content arrives. (2) An action the person just took: a spinner inside the pressed button, label kept, within 100 ms. (3) AI work that takes seconds or minutes: the progress bar with one plain sentence and a stop control, in the place the result will appear. A screen never shows instructions for an empty state while it is loading saved work (M-014). | "Loading…" text, blank pages, per-page skeletons, three pulses; wrong-state instructions for about two seconds on the Logo step. |
| **Error** | Always an Inline message with an icon, what happened in the person's terms, and what to do next, with the recovery action as a real button. Field errors sit under the field. Section errors replace the content that failed, at the same size. Page errors (404, crashes, unavailable project) use the page Empty state layout with a danger icon. Errors are never toasts and never bare coloured text. Focus moves to the message or the first field that needs attention (A-003). | Seven looks; bare red text on Plans; recovery actions as faint grey links; three crash screens with their own inline styles. |
| **Success feedback** | The change itself is the first confirmation (the tick appears, the item moves). Where the result is not visible where the person is looking (copied, downloaded, saved in the background, moved to Deleted), a Toast confirms it, with Undo when the action can be reversed. A positive Inline message is used only for outcomes that matter after the moment, such as "Payment confirmed". "Saved" is shown only after the server confirms. | Green strips, grey paragraphs and a save label in the project bar; nothing for copy or download. |
| **Form validation** | Labels are always visible; placeholders give an example, never the label. Validate a field when the person leaves it, and all fields on submit. The message sits under its field in `--color-text-danger` with an icon, the field takes `--color-border-danger`, and the field is linked to its message for assistive technology. On submit, focus moves to the first invalid field. The app's own messages replace the browser's validation bubble. Buttons are not disabled to signal an incomplete form; they explain on press. Passwords are not cleared after a failed sign-in unless security requires it (A-013). | Browser bubble on sign-up; a pink box under the button on sign-in; fields disabled during a request, which drops focus. |
| **Destructive confirmation** | A small Dialog. The title names the action and the object ("Delete Kestrel Analytics?"). The body says what is lost and whether it can be undone. Focus starts on Cancel. The confirming button is the only danger-filled button in the product and repeats the verb ("Delete project"). Reversible actions (project delete) skip heavy confirmation in favour of a Toast with Undo where possible; irreversible ones (account delete) ask the person to type a word. While the action runs, the button shows the loading state and the dialog stays open; a failure appears inside the dialog. | Two dialogs of 460 and 480 px with different padding; the danger button is outlined with a 1.61:1 border; focus is lost after one of them. |
| **Long lists** | Grids and lists show a first page and a "Show more" button that says how many remain; no infinite scroll. Images in lists are lazy below the first screen and sit in Media frames. A list longer than two screens gets a search or a filter. Finished steps of the conversation fold, so their controls leave the keyboard order until reopened (A-010, E-032). A gallery is one keyboard stop with arrow keys inside it. | A finished brand is 5,400 px and 141 keyboard stops; Library reaches about 10,000 px at phone width; the gallery has "Show more brands" already. |

### 3h. Decisions for Claude Design

Each is a matter of taste. Both options fit the Direction. This file does not choose.

| # | Decision | Option A | Option B | Where specified |
| --- | --- | --- | --- | --- |
| 1 | Accent colour | Ink only | One quiet accent for selection, links and focus (candidates: ink blue `#24406b`, slate `#3d4f63`) | 3b |
| 2 | Typeface | Geist Sans alone | Geist Sans plus one display face for three heading roles | 3c |
| 3 | Density | Comfortable: body 15, controls 44, card padding 24 | Roomy: body 16, controls 48 and 40, card padding 32 | 3d |
| 4 | Control shape | Pill buttons (today) | Pills for navigation and chips only; buttons at 12 px | 3d |
| 5 | When content is a card | Cards only for things that are objects (a project, an asset, a plan, a choice). Page sections such as Settings groups sit directly on the canvas, separated by space and a heading. | Keep sections as cards, and give object cards a distinct treatment (a larger radius, a media area, or a stronger edge) so the two levels differ. | Card row in 3f; E-055 |
| 6 | The dot-grid canvas | Keep it only where work is made (Home and the project conversation); plain canvas on list, settings and delivery pages. | Remove it everywhere and let white space and type carry the calm. (Keeping it on every page is not offered: it is the most generic element in the current look, and it is already missing on Assets.) | `--pattern-dot-grid` in 3a; DS-020 |
| 7 | Selected state of a choice card | A 2 px ink ring with a filled tick badge in a fixed corner. | An ink ring plus a soft fill and a text label ("Chosen"). In both, the mark must reach 3:1 and must not rely on colour alone. | Choice card row in 3f |

Three further choices are not taste but still open, because they depend on the options above: the placeholder colour, the control-outline grey and the disabled-text grey. Their candidates and required minimums are in 3b.

## 4. Keep, change, remove

**Keep.** These already work and must survive the rebuild. Claude Design should treat them as fixed inputs.

| What | Why it stays | Where it is today |
| --- | --- | --- |
| The warm neutral palette: canvas `#f7f7f5`, paper `#ffffff`, sunken `#f1f0ee`, ink `#191919`, muted text `#696965`, the two hairlines, and the green, red and amber status sets | Quiet, warm, and it passes contrast for all text (4.84:1 to 17.58:1). It is what lets the generated brand be the colour on screen. | `src/styles/tokens.css:2-24` |
| The floating pill navigation and the project bar with four journey steps | The one recognisable piece of Embel's interface; confirmed by the owner on November 6; works at all three widths. | `FloatingNav`, `ProjectCapsule`, `src/components/journey/journey.module.css` |
| Rounder corners: 12 px controls, 16 px cards, 20 px panels | Confirmed on November 6; the three steps are the right ones and become the middle of the radius scale. | `src/styles/tokens.css:36-39` |
| 44 px controls | Already met by 125 height declarations; passes WCAG 2.5.8 with room. | `.button`, `.icon-button`, `.text-link` in `src/styles/globals.css:41-58` |
| Ink primary button with white label; secondary button on paper | Clear, 17.58:1, no accent needed. | `.button.primary`, `.button.secondary` |
| Native `<dialog>` for every modal, with focus trapped and returned to the opener | Correct behaviour for free; only the look needs unifying. | 11 components, for example `ProjectCardActions`, `SignInDialog` |
| The skip link and the 2 px ink focus ring | Instant, visible on every light surface; the system adds the halo and fixes the offsets. | `src/styles/globals.css:22-28` |
| Settings and Library tabs | One tab stop, arrow keys, labelled panels: the model for all tabs. | `SettingsWorkspace`, `AssetsWorkspace` |
| Restraint in motion: no page transitions, no hover lifts, only opacity and transform move, 120 ms as the common duration | Pass 2's main conclusion; calm is the Direction. | `02_motion_interaction.md` section 3 |
| The logo "drawing" texture and its reduced-motion caption | The one place a richer animation is earned. | `generation-animation.tsx` |
| The `Icon` component's contract: one component, 24 px grid, line style, takes the text colour | Right idea; the system extends the set and removes the bypasses. | `src/components/ui/icon.tsx` |
| The two content widths, 792 and 1056 px | They fit the conversation and the list pages; the other six widths go. | `--conversation-max`, `--page-max` |
| Container queries in the inspiration gallery | The cleanest responsive code in the app. | `src/components/inspiration/inspiration.css:218-233` |
| Folded answers, the Strategy summary card, "Retry 2 failed concepts", reversible delete | Good patterns named by pass 1; they become the Disclosure, Card and Error patterns. | project conversation |
| Readable disabled buttons (a muted fill, not a faded control) | Better than opacity; needs its own text colour so it differs from muted text. | `.button:disabled` in `src/styles/globals.css:50` |
| Semantic status regions and alt text | 119 status regions, 66 alerts, no image without alt text. The new message components keep these roles. | throughout |
| The Embel pixel-ring mark | The only distinctive graphic; it should appear larger than 28 px somewhere. | `public/embel-mark.svg` |
| The large inspiration brand view | Pass 1's quality bar for presenting work (E-054). | `BrandOverlay` in `inspiration-brands.tsx` |

**Change.**

| What | From | To | Section |
| --- | --- | --- | --- |
| Token structure | One flat file of 40 tokens covering three foundations | Primitive, semantic and component layers covering all eight | 3a |
| Field outlines and placeholders | `--border` 1.28:1, `--placeholder` 3.9:1 | A control-outline role at 3:1 or better; a placeholder at 4.5:1 or better | 3b |
| Focus ring | One colour, 11 offsets, clipped on tiles, removed in 14 places | Two-part ring, two offsets, never clipped, never removed without a replacement | 3a, 3b |
| Type | 13 px for most things; 19 sizes | Ten roles; 14 px labels, 15 or 16 px body, nothing under 12 | 3c |
| Spacing | 53 values | 14 steps | 3d |
| Radius | 18 literal values, two generations | Six steps | 3d |
| Shadows and backdrops | 34 shadows, 7 backdrop variants | Four levels, one scrim | 3d |
| Breakpoints | 21 widths | Three named ranges | 3d |
| Buttons | Four implementations, no pressed or shared loading state | One component, six states | 3f |
| Selection | Eight treatments; logo and direction cards without a visible control | One Choice card | 3f, decision 7 |
| Messages | About 20 classes, seven looks, no toast | One Inline message in four tones and three forms, plus a Toast | 3f, 3g |
| Dialogs and menus | 10 and at least 6 hand-built | One Dialog in four widths, one Drawer, one Menu | 3f |
| Loading | Text, blanks, three pulses | Skeleton, button spinner, progress bar; Media frame reserves image space | 3f, 3g |
| Empty states | 24 classes, three styles | One Empty state in three sizes | 3f, 3g |
| Disabled and busy | Two disabled looks; `disabled` used while a request runs | One disabled look; busy is a loading state that keeps focus | 3f |
| Icons | Three ways to draw them, five stroke weights | One family through one component (pass 1b, IMG-004) | 3f |
| Reduced motion | Removes all animation | Removes movement, keeps feedback | 3e |
| Cards and canvas | One card for everything; dot grid on most pages | Decided in Claude Design | decisions 5 and 6 |

**Remove.**

| What | Why | Where |
| --- | --- | --- |
| 157 selectors no component mentions | Styles for screens that no longer exist; they make every measurement and every search worse. Check each before deleting (a class built from a string at run time would not be detected). | `src/styles/globals.css` (53, for example `.draft-card`, `.search-field`, `.step-navigation`, `.editor-grid`, `.settings-section`, `.storage-alert`), `src/styles/project-naming.css` (35), `src/styles/project-workspace.css` (32); full list in `design-system/components.json` |
| Alias and duplicate tokens | `--accent-ink` and `--accent` equal `--text`; `--panel-radius` duplicates `--radius-card`; `--font-ui` equals `--text-sm`; `--text-strong-hover` | `src/styles/tokens.css` |
| The second token set | `--branding-gutter`, `--branding-max-width`, `--branding-title-size`, `--branding-section-size`, `--branding-subheading-size`, `--branding-action-height`, declared in two files | `src/styles/branding-stage.module.css:4-9`, `src/styles/journey-conversation.css:1535-1540` |
| Tokens redefined inside a scope | `--canvas`, `--paper`, `--border` under `.concept-project-workspace` | `src/styles/project-workspace.css:3-5` |
| The leftover of the magenta accent | `#cbacc5` | `.conversation-widget-body .segment-card.is-selected`, `src/styles/conversation.css:366` |
| The square generation of controls | `.icon-button` (6 px), `.small-badge` (4 px), `.preview-badge` (5 px) | `src/styles/globals.css:30, 54, 58` |
| Backdrop blur | Two of nine backdrops blur the page; blur is costly to paint and inconsistent | `naming-inspect.module.css:21`, `src/styles/auth-guided.css:150` |
| Dashed empty boxes | Two legacy empty states | `.audience-empty`, `.strategy-empty` |
| 35 `!important` declarations | Mostly forcing a font size against a global rule; unnecessary once components own their type role | `design-system/drift.json`, category `important` |
| 14 `outline: none` declarations without the standard replacement | Each is a place the focus ring can disappear | `design-system/drift.md`, "outline: none" |
| The global rule that fades every disabled button to 48% | Conflicts with the readable disabled style | `button:disabled` in `src/styles/globals.css:9` |
| Inline styles and literal colours on the crash screens | `global-error.tsx` cannot load the stylesheet, so it should carry the primitive values from the shared source, not its own | `src/app/global-error.tsx` |

## 5. Migration map

Old value or component to new token or component. Every row names the selector or component as well as the file, because the code will be restructured before implementation. Counts are uses in `src/**/*.css` unless stated. Under "decide" rows, the new value depends on a decision in 3h.

### 5.1 Colour tokens

| Old | Uses | New | Note |
| --- | --- | --- | --- |
| `--canvas` | 46 | `--color-bg-canvas` | |
| `--paper` as a background | 211 (most) | `--color-bg-paper` | Where `--paper` colours text on ink, use `--color-text-inverse`. |
| `--surface` | 75 | `--color-bg-sunken`; on hover rules `--color-bg-hover`; on selected rules `--color-bg-selected`; on disabled rules `--color-bg-disabled` | Read each rule's selector to choose. |
| `--text` as text colour | 219 (most) | `--color-text` | As a border or ring on a selected item: `--color-border-selected`. As a fill: `--color-bg-inverse`. |
| `--secondary` | 358 | `--color-text-muted` | Review recovery actions and errors that use it: they move to `--color-text` (3c, rule 7). |
| `--placeholder` | 8 | `--color-text-placeholder` | Where it colours disabled text (`.textButton:disabled`): `--color-text-disabled`. |
| `--border` | 253 | `--color-border` on cards, dividers, buttons; **`--color-border-control` on every input, textarea, select, checkbox, radio and search field** | The one mapping that changes how things look. Selectors: `.field-label input, .field-label textarea`, auth fields, `.search-field input`, `select`. |
| `--border-strong` | 25 | `--color-border-strong` | |
| `--accent`, `--accent-ink` | 23, 63 | `--color-accent` when a fill; `--color-text` when text; `--color-border-selected` when a selected border; `--focus-ring-color` in `outline` | `--accent-ink` is mostly used in `outline: 2px solid var(--accent-ink)`: those rules are deleted in favour of the shared focus ring. |
| `--accent-soft` | 23 | `--color-bg-selected` | |
| `--on-accent` | 8 | `--color-on-accent` | |
| `--text-strong-hover` | 4 | `--color-accent-hover` | |
| `--selection` | 1 | `--color-selection` | |
| `--positive`, `--positive-soft` | 9, 1 | `--color-text-positive`, `--color-bg-positive-soft` | |
| `--danger`, `--danger-soft`, `--danger-border` | 13, 6, 5 | `--color-text-danger`, `--color-bg-danger-soft`, `--color-border-danger-soft` | On `.button.danger`, the border becomes `--color-border-danger`. |
| `--warning`, `--warning-soft`, `--warning-border` | 3, 2, 2 | `--color-text-warning`, `--color-bg-warning-soft`, `--color-border-warning-soft` | |
| `--dot-grid` | 2 | `--pattern-dot-grid` | decide (6) |

### 5.2 Colour literals

| Old literal | Uses | New | Where (selector, file) |
| --- | --- | --- | --- |
| `#ffffff`, `#fff`, `white` | 18 + 2 | `--color-bg-paper` or `--color-text-inverse` | `inspiration.css` (hearts and overlays), `journey-conversation.css:646, 965` |
| `#191919` | 10 | `--color-text` / `--color-accent` | `logo-creation.module.css` (fallbacks inside `var(--accent-ink, #191919)`: drop the fallback) |
| `#696965`, `#f1f0ee`, `#e4e3df`, `#c9c8c2`, `#f7f7f5`, `#82817b` | 9, 9, 5, 5, 3, 3 | The token of the same value | `logo-creation.module.css`, `journey.module.css:209`, `naming-chat.module.css:680` |
| `#3a3a37` | 8 | `--color-text` for text; `--color-accent-hover` on hover | `journey-conversation.css:134, 138, 346, 377, 501, 534, 1251`; `.navLink` area in `journey.module.css:71` |
| `#333333` (through `--text-strong-hover`) | 4 | `--color-accent-hover` | `.button.primary:hover`, module `primaryButton:hover` |
| `#b54b4b` | 5 | `--color-border-danger` | `.brief-composer.has-error`, `competitors.css:53`, `conversation.css:22`, `strategy.css:229`, `home-concept.css:65` |
| `#a02929`, `#a52b2b`, `#8f4242` | 2, 1, 2 | `--color-text-danger` | `.form-error`, `.competitor-field-error`, `.guided-conversation-error`, `.text-link.danger-text`, `journey.module.css:234` |
| `#fff0ee`, `#fff5f3` | 1, 1 | `--color-bg-danger-soft` | `.form-error`, `.guided-conversation-error` |
| `#edf3eb` | 2 | `--color-bg-positive-soft` | `.form-success`, `.review-complete` |
| `#fff8e9`, `#e3ce9c`, `#e6d7b3`, `#6b4617`, `#71531f` | 3, 2, 1, 1, 1 | `--color-bg-warning-soft`, `--color-border-warning-soft`, `--color-text-warning` | `.storage-alert`, `.account-conflict`, `.strategy-review-notice` |
| Hover-border greys: `#b9b8b4`, `#bab9b5`, `#afaea9`, `#aaa9a5`, `#aaa9a4`, `#a7a49f`, `#93928c`, `#d2d1cc`, `#c8c7c1`, `#c9c8c3`, `#d8d7d3`, `#d9d8d4`, `#cbc9c5` | 1 or 2 each | `--color-border-strong`; on a field's focus `--color-border-control` hover value | `.preview-badge:hover`, `.scope-option:hover`, `.draft-card:hover`, `.brief-composer`, `.example-card:hover`, `.add-audience`, `.segment-card.is-selected`, `.audience-empty`, Home composer focus in `home-concept.css:61` |
| Fill greys: `#eeede8`, `#eae9e5`, `#e9e8e4`, `#ecece8`, `#eeedea`, `#e7e7e4`, `#fafaf9` | 1 each | `--color-bg-sunken` | `.draft-preview`, `.example-card:hover`, `.step-number`, `generation-animation.module.css` |
| Text greys: `#7e7d77`, `#8a8a85`, `#8d8c88`, `#43453f`, `#5e6056`, `#555555` | 1 to 3 each | `--color-text-placeholder`, `--color-border-control` or `--color-text-muted` by role | `.brief-composer textarea::placeholder`, `conversation.css:18-19` (reply box ring), `.draft-preview` |
| `#dad9d4` (dot grid, written out) | 4 | `--pattern-dot-grid` | `journey-conversation.css:204, 1061` |
| `#cbacc5` | 1 | Delete (see section 4) | `conversation.css:366` |
| Translucent ink for scrims: `#19191955` ×3, `#19191966`, `#19191942`, `#17171766`, `rgb(25 25 25 / 22%)`, `/ 40%`, `/ 53%` | 9 | `--color-bg-scrim` | `::backdrop` of `.auth-overlay`, `.auth-signout-dialog`, `.sheet`, `.project-lifecycle-dialog`, `.assets-detail`, `.generation-activity-dialog`, module `dialog` (two files), `.inspiration-detail` |
| The remaining translucent ink and black values (about 40 uses) | about 40 | Part of the shadow tokens (5.5) | see 5.5 |
| `rgb(255 255 255 / 92%)`, `/ 94%`, `/ 80%`, `/ 75%`, `#ffffffd9`, `#ffffff70`, `#fffffff0` | 11 | Component token `--chip-on-artwork-bg` (paper at 92%) or `--color-bg-paper` | `inspiration.css:834, 901, 917`, `journey-conversation.css:164, 389, 666, 806`, `.draft-card-top .small-badge` |
| Hex values in TypeScript: `src/app/_brand/brand.ts:8`, `src/app/layout.tsx:32`, `src/app/global-error.tsx` | 10 | Read from the shared primitive source | Export artwork colours in `src/features/brand-assets/model/artwork.ts` and `src/features/logo-vector/model/svg.ts` are generated-brand output and stay. |

### 5.3 Typography

| Old | Uses | New role | Note |
| --- | --- | --- | --- |
| `var(--font-ui)` (13 px) on buttons, navigation, labels, tabs, menu rows | most of 262 | `--text-label` (14 px, 500) | `.button`, `.text-link`, `.field-label`, `.step-navigation button` and their module copies |
| `var(--font-ui)` or `13px` on hints, meta and secondary text | rest of 262, plus 189 | `--text-small` | `.secondary-text`, `.field-hint`, `.draft-excerpt`, `.context-panel dd` … |
| `12px` | 117 | `--text-caption` for timestamps and counters; `--text-small` when it is an instruction, a status or an error | Read each: 12 px status text is finding E-055. |
| `10px`, `11px` | 3 | `--text-caption` | `journey.module.css:211`, `project-workspace.css:230, 1048` |
| `14px`, `15px`, `var(--font-body)`, body `16px` | 86, 19, 1, part of 48 | `--text-body` | `body` in `globals.css:5`, `.field-label input`, `.route-state p` |
| `16px`, `17px`, `18px` as headings | part of 48, 10, 15 | `--text-title-sm` | `h3`, `.draft-card h3`, `.settings-section h2`, `.audience-empty h2` |
| `17px`, `18px` as large body | part | `--text-body-lg` | `.brief-composer textarea`, Home prompt in `home-concept.css:75` |
| `20px`, `22px` | 26, 8 | `--text-title-md` | `h2`, `.empty-panel h2`, `--branding-section-size` |
| `24px`, `28px` as page titles | 16, part of 12 | `--text-title-lg` | `h1`, `.home-title`, `.route-state h1` |
| `28px`, `30px`, `32px`, `34px`, `clamp(26px, 4vw, 32px)` | part of 12, 1, 3, 1, 1 | `--text-title-xl` | `--branding-title-size`, `naming-inspect.module.css:51`, `journey-conversation.css:1315` |
| `clamp(32px, 4vw, 44px)` | 1 | `--text-display` | `home-concept.css:37` |
| `--text-xs` … `--text-2xl` | 14 | The role tokens above | All in `src/styles/plans.css` (`PlansWorkspace`) |
| `font-weight: 450`, `550`, `650` | 6, 6, 1 | 500, 500 (or 600 on a number), 600 | `.button`, `logo-creation.module.css:19, 25, 40` |
| Every `line-height` and `letter-spacing` declaration | 343, 77 | Deleted: the role sets both | Exceptions: single-line controls may set `line-height: 1`. |

### 5.4 Spacing and radius

| Old | Uses | New |
| --- | --- | --- |
| 4, 8, 12, 16, 20, 24, 32, 40, 48, 64 px | 1,319 | `--space-1`, `-2`, `-3`, `-4`, `-5`, `-6`, `-8`, `-10`, `-12`, `-16` (same values: a mechanical replacement) |
| 2, 6 px | 59, 118 | `--space-0-5`, `--space-1-5` |
| 96 px | 2 | `--space-24` |
| 10, 14, 18 px | 153, 151, 102 | 8 or 12; 12 or 16; 16 or 20. Gaps round down, padding rounds up. |
| 5, 7, 9, 11, 13, 15, 17, 19 px | 44, 44, 39, 29, 41, 37, 21, 10 | Nearest step by the same rule |
| 1, 3 px | 9, 36 | 0 or 2; 2 or 4 (most are optical nudges that the type roles make unnecessary) |
| 22, 23, 25, 26, 27, 28, 29, 30, 31 px | 25, 7, 8, 9, 2, 28, 1, 12, 1 | `--space-6` or `--space-8` |
| 36, 38, 42, 44, 45, 52, 55, 56, 60, 72, 80, 100, 104, 120 px | 1 to 8 each | `--space-10`, `-12`, `-16` or `-24`; page top paddings become `--nav-offset` + `--nav-height` + `--space-10` |
| `--page-gutter`, `--branding-gutter`, `.page` side padding 48 / 32 / 24 / 20 | 8, 4, 4 rules | `--space-gutter` |
| `--radius-control` | 40 | `--radius-control` (unchanged) |
| `--radius-card`, `--panel-radius` | 52, 20 | `--radius-card` |
| `--radius-panel` | 17 | `--radius-panel` (unchanged) |
| `--radius-pill`, `999px` | 81, 5 | `--radius-pill` (buttons follow decision 4) |
| `50%` | 39 | `--radius-pill` for round controls and avatars; `50%` stays only for true circles such as status dots |
| 2, 3, 4, 5 px | 3, 1, 8, 15 | `--radius-inset` |
| 6, 7, 8, 9, 10 px | 22, 29, 19, 4, 29 | `--radius-small` (for a field or a button that used 10 px: `--radius-control`) |
| 12 px | 11 | `--radius-control` |
| 14, 16 px | 4, 3 | `--radius-card` |
| 20, 24, 26 px | 5, 1, 1 | `--radius-panel` |

### 5.5 Elevation, layering, breakpoints and motion

| Old | New | Where (selector, file) |
| --- | --- | --- |
| `0 12px 32px -16px rgb(25 25 25 / 28%)` and seven similar floating shadows | `--shadow-raised` | `.capsule` (the navigation pill) in `journey.module.css:21`; `.progress` (the progress card) in `journey.module.css:263`; Home composer in `home-concept.css:57, 62`; `floating-composer.module.css:53`; `inspiration.css:180, 731`; `journey-conversation.css:1464`; `plans.css:173` |
| `0 16px 40px -16px rgb(25 25 25 / 30%)`, `0 8px 24px #19191920`, `0 8px 24px #19191914`, `0 8px 30px #19191912` | `--shadow-overlay` | `.menu` in `journey.module.css:108`; `concept-shell.css:96`; `.project-card-menu`; `.projects-control-panel` in `projects.css:101`; `.assets-card-options-panel` in `assets-guided.css:192`; `.home-input-popover-panel` |
| Six dialog shadows | `--shadow-modal` | `.auth-signout-dialog`, `.auth-overlay`, `.project-lifecycle-dialog`, `.sheet`, module `dialog` in `naming-inspect.module.css:14`, `.inspiration-detail` |
| Seven small card and tile shadows | `--shadow-none` | `project-card-actions.css:18`; `inspiration.css:919`; `guided-conversation.css:110`; `conversation.css:15`; `project-naming.css:470, 1100`; `identity-references.css:94` |
| `0 0 0 1px var(--text)`, `inset 0 0 0 1px var(--text)`, `inset 0 0 0 0.5px var(--text)` (with or without a second shadow) | The Choice card's selected state (`--color-border-selected`, decision 7) | `.galleryCard[data-selected]` in `logo-creation.module.css:509`; `.card[data-selected]` in `visual-directions-view.module.css:214`; `naming-chat.module.css:107, 715`; `guided-interview.css:58`; `journey-conversation.css:112, 568, 654, 960` |
| `0 0 0 1px #8d8c88` | The shared focus ring on the composer frame | `conversation.css:19` |
| z-index 1, 2, 3, 4, 5 | `--z-raised` | 20 rules |
| z-index 10, 16 | `--z-sticky`; `--z-popover` where the rule is an open menu | `home-concept.css:5`, `project-naming.css:460`; `.assets-card-options[open]` in `assets-guided.css:181` |
| z-index 30 | `--z-nav` | `journey.module.css:5` |
| z-index 25, 40 | `--z-popover` | `.home-input-popover-panel`, `projects.css:92`, `.menu`, `home-concept.css:148` |
| z-index 50 | `--z-skip-link` for `.skip-link`; delete on dialogs (top layer) | `globals.css:27`, `concept-shell.css:87` |
| `max-width` 340 to 600 px | compact (below 640) | 33 media queries |
| `max-width` 640 to 1000 px, `min-width: 761px` | medium (640 to 1023) | 45 media queries |
| `max-width` 1050 to 1190 px, `min-width: 1500px` | wide (1024 and up); the 1500 px rules are deleted | 17 media queries |
| `120ms` | `--duration-fast` | 12 transitions in `inspiration.css`, `logo-creation.module.css`, `visual-directions-view.module.css`, `guided-interview.css` |
| `150ms`, `0.15s` | `--menu-duration` or `--duration-fast` | `inspiration.css:295`, `naming-inspect.module.css:146` |
| `160ms`, `200ms` | `--duration-press`, `--duration-base` | `embel-flow-enter` in `guided-conversation.css:176`; `inspiration.css:818` |
| `1.5s`, `1.6s`, `2.8s` pulses | `--duration-loop-pulse` (one keyframe animation) | `guided-thinking-pulse`, `pulse` in `project-card.module.css`, `embel-research-pulse` |
| `0.8s` spin, `2.4s` bar | `--duration-loop-spin`, `--duration-loop-sweep` | `auth-spin`, `journey-bar` |
| `ease-out` on entrances; `ease` on hover | `--ease-out`; keyword `ease` stays | as above |
| `@media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important } }` | The reduced-motion rules in 3e | `globals.css:332` and six files |
| `:focus-visible` with offsets 4, 3, 2, 1, 0, -1, -2, -3, -4, -5, -6 px | `--focus-ring-offset` (outside) or `--focus-ring-inset` (inside clipped boxes) | 59 `:focus-visible` rules in 25 files |

### 5.6 Components

| Old (class or module class) | Used by (component, file) | New component and variant |
| --- | --- | --- |
| `.button.primary`, `.button.secondary`, `.button.danger`, `.button.small` | 151 uses in 47 files | Button: primary, secondary, danger; `small` becomes the 36 px size or is dropped (today it is also 44 px tall) |
| `primaryButton`, `secondaryButton` in `logo-creation.module.css:134-167` | `LogoConceptGridView` (`concept-grid.tsx`), `candidate-comparison.tsx`, `generation-action.tsx`, `logo-types-question.tsx`, `concepts-composer.tsx`, `saved-inputs-status.tsx`, `logo-creation-workspace.tsx` | Button |
| `primaryButton`, `secondaryButton`, `textButton` in `visual-directions-view.module.css:113-168` | `VisualDirectionsView` | Button; Link (standalone) |
| `.identity-primary-button`, `.identity-secondary-button` in `src/styles/identity.css:33-57` | `identity-components.tsx`, `project-identity.tsx`, `identity-generation.tsx`, `identity-history.tsx`, `visual-directions-page.tsx` | Button |
| `pillButton` in `journey.module.css:237` | `ProgressCard` | Button (secondary) |
| `.guided-pill-button` in `journey-conversation.css:756` | `project-naming-workspace.tsx` | Button (secondary) or Chip |
| `.inspiration-continue`, `.inspiration-more` | `inspiration-workspace.tsx` | Button (primary); Button (secondary) |
| `.auth-submit` | `sign-in-form.tsx`, `reset-password-form.tsx`, `forgot-password-form.tsx` | Button (primary, full width, loading state) |
| 37 `<button>` elements with no class | starter chips on Home and others | Chip, Button or Menu row by role |
| `.text-link`, `.text-link.danger-text` | 108 uses in 40 files | Link (standalone; danger). Recovery actions ("Retry research", "Check status") become Button (secondary). |
| `.icon-button`, `.icon-button.subtle` | `SignInDialog`, `AccountAccess`, `GenerationActivity`, `project-editor.tsx`, `competitor-review.tsx` | Icon button: outlined, quiet |
| `.assets-close`, `.assets-open`, `.assets-open-detail`, `.assets-retain` | `AssetsWorkspace`, `AssetDetailDialog` | Icon button (quiet, toggle); the dialog's standard close button |
| `.project-card-menu-trigger` | `ProjectCardActions` | Icon button (on-artwork) opening a Menu |
| `.inspiration-icon-button`, `.inspiration-heart`, `.inspiration-part-like` | `Heart`, `BrandCard`, `PartCard`, `BrandOverlay` | Icon button (on-artwork, toggle) |
| module `iconButton`, `heart` | `NamingInspect`, `naming-chat` | Icon button (quiet, toggle) |
| `.auth-password-toggle` | `sign-in-form.tsx`, `reset-password-form.tsx` | Text field (password) with its built-in toggle |
| `.field-label` with `input` or `textarea`; `.field-hint`; `.optional` | `AccountBriefEditor`, `AccountDataControls`, `strategy-review.tsx`, `conversation-widgets.tsx`, `competitor-widget-controls.tsx` | Text field, Textarea (label, hint, error parts) |
| Auth field styles in `src/styles/auth.css`, `auth-guided.css` | `sign-in-form.tsx`, sign-up and reset forms | Text field |
| Search inputs in `projects.css`, `assets.css`, `inspiration.css:133-160` | `ProjectsWorkspace`, `AssetsWorkspace`, `inspiration-workspace.tsx` | Text field (search) |
| Home composer (`home-concept.css:50-120`), `floating-composer.module.css`, refine box (`.field textarea` and the `composer*` classes in `logo-creation.module.css:77, 616-633`), own-slogan field in `journey-conversation.css:581-590` | `HomeWorkspace`, `FloatingComposer`, `concepts-composer.tsx` | Composer; Textarea |
| Native `select` with overlay chevron | `account-profile-editor.tsx`, `AssetsWorkspace`, `ProjectsWorkspace`, `LogoConceptGridView` (version drop-down) | Select (form) or Menu select (sort, filter, version) |
| `.target-toggle input`, `.choice` in `logo-creation.module.css:100-116, 400-405`, checkboxes with `accent-color` | `logo-types-question.tsx`, `competitor-review.tsx`, strategy steps | Checkbox; Choice card (multiple) |
| `.scope-option`, `.segment-card.is-selected`, `.guided-choice-card` in `guided-interview.css:42-58`, `.naming-approach-option`, `nameRadio` in `naming-chat.module.css:684` | `unsaved-project-recovery.tsx`, `conversation-widgets.tsx`, guided interview, `naming-chat` | Choice card (single or multiple) |
| `.galleryCard[data-selected]`, `.conceptCard` in `logo-creation.module.css:292-295, 506-509` | `LogoConceptGridView` | Choice card (image, single) with a visible Choose button |
| `.card[data-selected]`, `selectedBadge` in `visual-directions-view.module.css:195-238` | `VisualDirectionsView` | Choice card (image, single); Badge (positive) |
| `.inspiration-brand-tile`, `.inspiration-overall`, `.inspiration-elements button` | `BrandCard`, `PartCard` | Choice card (image, multiple) or Card (media) with a toggle Icon button |
| `naming-length-range.module.css`; the strategy range | `naming-length-range.tsx`, `strategy-review.tsx` | Range slider |
| `.project-lifecycle-dialog` (460), `.auth-signout-dialog` (450), `.account-delete-dialog` (480) | `ProjectCardActions`, `AccountAccess`, `AccountDataControls` | Dialog (small, confirmation) |
| `.auth-overlay` (502), module `dialog` in `naming-inspect.module.css` (520), `.generation-activity-dialog` (620), `.sheet` in `context-details.module.css` (680), brief editor dialog | `SignInDialog`, `NamingInspect`, `GenerationActivity`, `ContextDetails`, `AccountBriefEditor` | Dialog (medium) |
| module `dialog` in `visual-directions-view.module.css:409` (860) | `VisualDirectionsView` | Dialog (large, media) |
| `.inspiration-detail` (1100) | `BrandOverlay` | Dialog (extra large, media) |
| `.assets-detail` (860, right edge) | `AssetDetailDialog` | Drawer |
| `.menu` in `journey.module.css:93`, `.workspace-account-menu`, `.project-card-menu`, `.projects-control-panel` (the Sort menu) in `projects.css:90`, `.assets-card-options-panel` in `assets-guided.css:183`, Library filter menus | `ProjectMenu`, `AppShell`, `ProjectCardActions`, `ProjectsWorkspace`, `AssetsWorkspace` | Menu |
| `.home-input-popover`, `.home-input-popover-panel` | `attachment-picker.tsx`, `home-voice-control.tsx` | Popover |
| `.form-error`, `.competitor-field-error`, module `error` (two files), `.plans-error`, `.guided-conversation-error`, `.project-lifecycle-error`, `.generation-activity-error`, `.account-delete-error` | `sign-in-form.tsx` and the other auth forms, `PlansWorkspace`, `VisualDirectionsView`, `AssetsJourney`, `GenerationActivity`, `ProjectCardActions` | Inline message (danger): field form under a field, block form elsewhere |
| `.form-success`, `.review-complete`, `.plans-notice-positive` | `account-project-editor.tsx`, `PlansWorkspace` | Inline message (positive) or Toast |
| `.storage-alert`, `.account-conflict`, `.strategy-review-notice`, `.auth-session-notice`, module `warning` | `account-project-editor.tsx`, `strategy-review.tsx`, auth | Inline message (warning): banner or block |
| `.plans-notice`, `.assets-notice`, `.inspiration-notice`, `.project-change-notice`, `.project-naming-notice`, `.prompt-recovery-notice`, `.account-notice`, `.project-read-notice` | `PlansWorkspace`, `AssetsWorkspace`, `inspiration-workspace.tsx`, `ProjectsWorkspace` | Inline message (neutral) |
| `OutOfCreditsPrompt` (a floating card) | `out-of-credits-prompt.tsx` | Inline message (neutral, block, two actions) at the control that was pressed; closes on Escape (A-017) |
| Inline "Copied", "Saved", "Moved to Deleted" status text | Assets copy buttons, project bar save label, `ProjectCardActions` | Toast (the save label in the project bar stays) |
| The usage `<table>`; the `div` table of colour tokens | `RecordedUsageSection`, `AssetsJourney` (`assets-journey.tsx:470-475`) | Table |
| module classes in `project-card.module.css`; `.draft-card` (unused) | `ProjectCard`, `ProjectCardSkeletons` | Card (interactive); Skeleton (card) |
| Plan cards in `plans.css`, `.sg-card` in `settings-guided.css`, `.form-panel`, `.settings-panel`, `.context-panel`, `.recent-empty` | `PlansWorkspace`, `SettingsWorkspace` | Card (summary, static) or plain page section (decision 5) |
| Asset cards in `assets.css`, concept and board cards | `AssetsWorkspace`, `LogoConceptGridView`, `VisualDirectionsView` | Card (media) with a Media frame |
| `.sg-tabs`, `.assets-tabs` | `SettingsWorkspace`, `AssetsWorkspace` | Tabs (underline) |
| `.inspiration-views`, `.inspiration-categories`, module `tabs` in `candidate-availability.module.css` | `inspiration-workspace.tsx`, naming availability | Segmented control |
| `.small-badge`, `.preview-badge`, `.draft-stage`, `.selected-count`, "Current plan" pill, `selectedBadge`, `staleBadge`, "No logo yet" chip | `strategy-review.tsx`, `AccountAccess`, `PlansWorkspace`, `VisualDirectionsView`, `ProjectCard` | Badge (neutral, positive, warning) |
| Starter chips on Home, `.guided-summary-pill`, gallery filter buttons | `HomeWorkspace`, guided conversation, `inspiration-workspace.tsx` | Chip |
| `.projects-empty-panel`, `.assets-empty`, `.home-brands-empty`, `.empty-panel`, `.inspiration-empty`, `.identity-reference-empty`, `.project-naming-empty`, `.identity-empty` | `ProjectsWorkspace`, `AssetsWorkspace`, `home-recent-brands.tsx`, `account-project-editor.tsx` | Empty state (page) |
| `.quiet-empty`, `.projects-deleted-empty`, `.conversation-widget-empty`, `.recent-empty`, module `emptyCaption` | `home-recent-brands.tsx`, `ProjectsWorkspace`, `conversation-widgets.tsx` | Empty state (section or no results) |
| `.page.route-state` | `src/app/not-found.tsx`, `src/app/error.tsx`, the project-level `error.tsx` | Error pattern, page form |
| module `skeleton` in `project-card.module.css`; "Loading…" text in `.assets-loading`, `.identity-reference-loading`, `.guided-interview-loading` | `ProjectCardSkeletons`, `AssetsWorkspace`, guided interview | Skeleton |
| `auth-spin` spinner | auth buttons | Spinner, inside any loading Button |
| `journey-bar`, `GuidedThinking`, `embel-research-pulse` | `ProgressCard`, guided conversation | Progress bar; Thinking indicator |
| Generated and uploaded `<img>` elements without reserved space; "Loading preview", "Private board preview", "Checking private preview…" | `LogoConceptGridView`, `VisualDirectionsView`, `AssetsWorkspace`, `AssetsJourney`, `BrandCard` | Media frame |
| 11 `<details>` elements styled per file | folded answers, `.optional-details`, `.name-origin-panel details` | Disclosure |
| `title` attributes carrying timestamps | `ProjectCard` (`project-card.tsx:152, 168`) | Tooltip with a formatted date |
| `Icon`; inline `<svg>` in 10 files (`auth-icons.tsx`, `floating-composer.tsx` …); arrows, chevrons and sort glyphs loaded as images by `ProjectsArtwork`, `AssetsArtwork`, `AuthArtwork`, `SettingsArtwork`, `ProjectArtwork` | 37 files and 5 artwork wrappers | Icon (one family; pass 1b, IMG-004) |

## 6. Validation set

Five real screens that Claude Design must rebuild with the new system, using only the system, to prove it works. Each keeps the same data, actions and states as the real screen. Together they exercise every foundation, 22 of the 27 components and all seven patterns. Files are in `screens/`, at 390 and 1440 unless noted.

| # | Screen | Role in the set | Current evidence | What it proves |
| --- | --- | --- | --- | --- |
| 1 | **Projects, eight brands** (audit-free), with the card menu open and the Delete project dialog | The busiest data screen | `projects__eight-brands-free`, `projects__options-menu-open-free`, `projects__delete-dialog-free`, `projects__loading-skeleton-free` | Card (interactive) with a 76-character name, an accented name and a card with no logo; Badge; Text field (search); Menu select (sort); Icon button on a card; Menu; Dialog (confirmation) and the destructive pattern; Skeleton cards; the grid at 1, 2 and 3 across; the navigation pill. |
| 2 | **Settings, Account tab** (audit-pro), including the offline save error | A main form | `settings__account-pro`, `settings__save-error-offline-free` | Tabs; Text field in default, disabled and error states; Select; Button in primary, secondary, danger and disabled states; Inline message (danger, block) and the confirmation after a successful save; the form-validation and success-feedback patterns; decision 5 (sections as cards or not); the type roles for labels, hints and section headings. |
| 3 | **Library, empty** (audit-fresh) | An empty state | `library__empty-fresh` | Empty state (page) with its visual slot; Tabs with nothing behind them; the canvas with almost no content (decision 6); spacing roles at page level. |
| 4 | **Project conversation, Tidewater Kayak Tours: logo concepts partly failed** (audit-free), with the out-of-credits prompt | An error state, inside the main journey | `brand-conversation__tidewater-logos-partly-failed-free`, `brand-conversation__out-of-credits-prompt-free`; also `brand-conversation__logos-drawing-aurelie-pro__1440` for the in-progress state | The project bar with complete, current and unreached steps; conversation messages and Disclosure (folded answers); Media frame in loaded, loading and failed states; Inline message with a retry Button; Progress bar with stop; the out-of-credits message; Composer; the reading container at 792 px. |
| 5 | **Project conversation, Kestrel Analytics: the Logo and Creative direction steps** (audit-pro, real images) | A screen that shows a generated brand | `brand-conversation__kestrel-complete-showcase-pro` (the Logo and Creative direction parts of the page) | Choice card (image, single) with selected, hover and focus states and a visible Choose control (decision 7); logo and board images at a size that can be judged; Dialog (large, media); Select or Menu for the logo version; the two-part focus ring on dark artwork; and the test that matters most for the Direction: the interface is quiet enough that Kestrel's colours are the loudest thing on screen (decision 1). |

If time allows, a sixth screen is worth adding because it is where the brand is delivered and where layout shift is worst: Assets for Kestrel Analytics (`brand-assets__kestrel-ready-pro`), for Table, colour swatches with copy, the code block, Toast and Media frames that reserve their space. Five components are not covered by the five screens: Table and Toast, which the sixth screen covers, and Range slider, Tooltip and Drawer, which should be shown on the system's own component page.

## 7. Findings

IDs DS-001 to DS-024, with the same fields as passes 1 to 3. "Related" lists findings from other passes that describe the same cause from a screen's point of view, to help the merge. Evidence paths are under `design-audit/evidence/` unless they start with `src/`.

**DS-001. The system has one flat layer of tokens, and five foundations have none**
- Screen: all routes, all widths.
- Category: consistency (token architecture)
- Severity: P1
- Tag: needs redesign
- What's wrong: `src/styles/tokens.css` holds 40 tokens for colour, part of type, radius and three widths. There are no primitives under the roles and no component tokens. Spacing (2,355 uses of 53 values), shadows (34 values), layering (12 values), breakpoints (21 widths) and motion (9 durations) are written by hand in each of 41 stylesheets.
- Why it matters: every inconsistency pass 1 listed as a "design-system symptom" follows from this. Without a semantic layer, the two failing colours cannot be fixed in one place per role, and no later change (an accent, a denser layout, a dark theme) can be made without editing hundreds of rules. Principle: a single source of truth.
- Suggested direction: the three-layer architecture in section 3a, built first in Claude Design, before any screen.
- Evidence: `design-system/drift.md`; `src/styles/tokens.css`
- Systemic? Yes. Related: pass 1 section 4; all of the findings below.

**DS-002. Two tokens that every form depends on fail contrast**
- Screen: every field, search box, select and checkbox, 390 and 1440.
- Category: color
- Severity: P1
- Tag: needs redesign
- WCAG criterion: 1.4.11 Non-text Contrast (AA); 1.4.3 Contrast (Minimum) (AA)
- What's wrong: `--border` (`#e4e3df`) is both the decorative hairline and the outline of every control, at 1.28:1 on paper and 1.19:1 on the canvas (minimum 3:1). `--placeholder` (`#82817b`) is 3.9:1, 3.64:1 and 3.43:1 on the three surfaces (minimum 4.5:1). Three placeholder colours are in use.
- Why it matters: people cannot see where to type, and the "precise" feel in the Direction is undercut by faint boxes.
- Suggested direction: split the role. Keep the hairline for cards; add `--color-border-control` (candidates at 3.07:1 to 5.51:1 in section 3b) and one `--color-text-placeholder` (candidates at 4.48:1 to 5.51:1). The grey values are chosen in Claude Design within those minimums.
- Evidence: `design-system/contrast.md`; `src/styles/tokens.css:8-10`; `.field-label input` in `src/styles/globals.css:140-142`
- Systemic? Yes: 253 uses of `--border`. Related: A-001, A-002.

**DS-003. Ninety colours are written by hand, including 30 stray greys and five reds**
- Screen: all; most visible on hover and error states.
- Category: color
- Severity: P2
- Tag: execution fix
- What's wrong: 189 colour literals in 90 values bypass the 23 tokens. 69 of them repeat a token's own value. 30 near-grey values exist once or twice each, mostly hover borders a shade apart. Danger text has five spellings and danger backgrounds three; warning has literal copies beside its tokens. One literal, `#cbacc5`, survives from the retired magenta accent.
- Why it matters: hover and error states look slightly different on every screen, and the owner's "no magenta" decision is not fully applied.
- Suggested direction: replace by the map in section 5.2; no design decision is needed.
- Evidence: `design-system/drift.md` "Colour literals in CSS"; `.form-error` in `src/styles/globals.css:170`; `src/styles/conversation.css:366`
- Systemic? Yes: 26 of 41 stylesheets.

**DS-004. One colour has three token names, and two radius tokens are easy to confuse**
- Screen: code only.
- Category: consistency (naming)
- Severity: P3
- Tag: execution fix
- What's wrong: `--text`, `--accent` and `--accent-ink` are all `#191919` (219, 23 and 63 uses). `--panel-radius` is 16 px and `--radius-panel` is 20 px. `--font-ui` and `--text-sm` are both 13 px. A second token set (`--branding-*`) is declared in two other files, and one scope redefines three global tokens.
- Why it matters: nobody can tell which name to use, so the next person writes a literal instead.
- Suggested direction: one name per role (section 3a); remove the aliases and the second set (section 4).
- Evidence: `src/styles/tokens.css:11-13, 33-41`; `src/styles/branding-stage.module.css:4-9`; `src/styles/project-workspace.css:3-5`
- Systemic? Yes.

**DS-005. The type scale exists but is not used, and most text is 13 px**
- Screen: all routes, all widths.
- Category: typography
- Severity: P2
- Tag: needs redesign
- What's wrong: the `--text-*` scale is referenced 14 times, all in Plans. Font size is written literally 557 times in 19 values; 13 px accounts for 54% of all sizes and 12 px for 14%. There are 28 line heights, 27 letter-spacings in mixed units, six weights including 450, 550 and 650, and page titles of 24, 28 and 32 px.
- Why it matters: small grey text carries instructions, status and errors, which works against a non-designer audience and a premium feel. Hierarchy is flat because steps are one pixel apart. Principle: a type scale with assigned roles.
- Suggested direction: the ten roles in section 3c, with labels at 14 px and body at 15 or 16 px. The typeface (decision 2) and the body size (decision 3) are chosen in Claude Design.
- Evidence: `design-system/drift.md` "Font sizes"; `screens/settings__account-pro__1440.png`; `screens/plans__pro-current-pro__1440.png`
- Systemic? Yes. Related: E-055.

**DS-006. Spacing has no scale: 53 values, every odd number included**
- Screen: all.
- Category: spacing
- Severity: P2
- Tag: execution fix
- What's wrong: padding, margin and gap use 53 distinct values in 2,355 declarations. 56% sit on a ten-step 4 px scale; the rest include 5, 7, 9, 11, 13, 15, 17 and 19 px and a parallel 10 / 14 / 18 set (406 uses). Card padding ranges from 8 to 28 px.
- Why it matters: alignment between neighbouring elements is off by one to three pixels throughout, which is exactly what reads as "not quite precise".
- Suggested direction: the 14-step scale and the rounding rule in sections 3d and 5.4. Layouts should be re-checked with `capture.mjs` after the replacement.
- Evidence: `design-system/drift.md` "Spacing: literal"
- Systemic? Yes: 36 of 41 stylesheets.

**DS-007. Half of all corner radii bypass the tokens, and two generations of shape coexist**
- Screen: all; clearest where a pill button sits next to a square icon button (sign-in overlay, activity dialog).
- Category: components (shape)
- Severity: P2
- Tag: execution fix
- What's wrong: 203 of 414 radius declarations are literal, in 18 values. Every size from 4 to 10 px is in use because no token exists below 12. `.icon-button` (6 px), `.small-badge` (4 px) and `.preview-badge` (5 px) are from an older, squarer look.
- Why it matters: the November 6 direction is "rounder corners"; the leftovers contradict it on the same screen.
- Suggested direction: the six-step scale and the nested-corner rule in section 3d; map in 5.4. Whether buttons are pills is decision 4 and does not block this.
- Evidence: `design-system/drift.md` "Radius: literal"; `src/styles/globals.css:30, 54, 58`
- Systemic? Yes.

**DS-008. Thirty-four shadows, seven backdrops and twelve layer values**
- Screen: the navigation pill, composer, menus, every dialog.
- Category: components (elevation)
- Severity: P2
- Tag: execution fix
- What's wrong: 41 shadow declarations use 34 different values. Dialogs have six different shadows and four have none. Nine backdrops come in seven variants from 22% to 53% ink, two with blur. z-index uses 12 values, and menus sit at 25 on one page and 40 on another.
- Why it matters: surfaces that are the same kind of thing float at visibly different heights; a dialog on one page feels heavier than on the next.
- Suggested direction: four shadow levels, one scrim without blur, and the layer scale in section 3d; map in 5.5.
- Evidence: `design-system/drift.md` "Box shadows", "z-index"
- Systemic? Yes.

**DS-009. Twenty-one breakpoints and eight page widths**
- Screen: all, most visible at 390 and 768.
- Category: responsiveness
- Severity: P2
- Tag: execution fix
- What's wrong: media queries use 21 different viewport widths, so one layout changes at 700 px and its neighbour at 760 or 850. Page containers are 792, 1056, 1088, 1120, 1160, 1260, 1360 and 1440 px. There is no column grid.
- Why it matters: between 600 and 900 px, parts of a page are in their narrow layout while others are still wide; page edges do not line up when moving between pages.
- Suggested direction: three named ranges, two containers and the grid in section 3d. Plans (A-014) and the project bar (A-016) need layout work beyond the replacement and stay with their own findings.
- Evidence: `design-system/drift.md` "Breakpoints", "max-width"; `screens/plans__pro-current-pro__390.png`
- Systemic? Yes. Related: A-014, A-016, pass 1 section 4 ("page widths differ").

**DS-010. Buttons exist in four implementations and none has a pressed state**
- Screen: all; the copies are on the Logo and Creative direction steps and the legacy identity page.
- Category: components
- Severity: P1
- Tag: needs redesign
- What's wrong: besides `.button`, there are two CSS-module copies (`primaryButton`, `secondaryButton`) and an `.identity-*-button` family; 136 of 338 `<button>` elements use no shared class. No button changes while pressed. Loading is a spinner on auth, a label change on four screens and nothing elsewhere. Primary buttons are full width on some cards and hug their label on others, and an arrow is appended to some labels. Disabled appears two ways (a 48% fade and a muted fill).
- Why it matters: the button is the most used control on the paid journey, and its states are how the app answers a click. Heuristic: *visibility of system status*; *consistency and standards*.
- Suggested direction: one Button with the variants, sizes and six states in section 3f, designed once in Claude Design, including width rules and the arrow rule.
- Evidence: `design-system/components.md` ("Building blocks", "non-shared button classes"); `motion/probe-summary.md`; `src/components/logo-creation/logo-creation.module.css:134-167`
- Systemic? Yes. Related: M-001, M-015, M-016, A-003, pass 1 section 4 ("actions have no fixed shape").

**DS-011. "Selected" has eight looks, and the two most important choices have no visible control**
- Screen: project conversation (Strategy, Personality, Name, Inspiration, Logo, Creative direction), 390 and 1440.
- Category: components
- Severity: P1
- Tag: needs redesign
- What's wrong: a chosen item is shown by an ink fill, an ink border with a soft fill, a 1 px ring, a 0.5 px inset ring with a shadow, a 5 px radio border, a left bar, a green "Chosen" label or an underline, depending on the step. The checkbox or radio moves between the left and the far right. Logo concepts and direction boards have no visible choose control at all, and are not built as real radio controls.
- Why it matters: choosing is the product. A person should learn once what "this is my choice" looks like. Heuristic: *consistency and standards*; WCAG 4.1.2.
- Suggested direction: one Choice card (section 3f) with one selected treatment (decision 7), a fixed control position and a labelled Choose button on image choices.
- Evidence: `src/components/logo-creation/logo-creation.module.css:509`; `src/components/visual-directions/visual-directions-view.module.css:214`; `src/components/naming/naming-chat.module.css:684, 715`; `screens/brand-conversation__kestrel-complete-showcase-pro__1440.png`
- Systemic? Yes: six steps. Related: E-051, A-006, A-007, M-015.

**DS-012. Messages have about twenty implementations and there is no toast**
- Screen: Sign in, Projects, Settings, Plans, Home, project conversation, Assets.
- Category: components (feedback)
- Severity: P1
- Tag: needs redesign
- What's wrong: errors, warnings, successes and notices are styled by about 20 separate classes with seven distinct looks, including bare red text and plain grey paragraphs used for both success and failure. There is no component for a brief confirmation, so "copied", "downloaded" and "moved to Deleted" have no consistent place; the out-of-credits prompt is a one-off floating card.
- Why it matters: when something goes wrong, the person has to work out each time whether what they are looking at is an error. Heuristic: *help users recognise, diagnose and recover from errors*.
- Suggested direction: one Inline message in four tones and three forms, plus a narrow Toast (section 3f), and the error and success patterns in 3g.
- Evidence: pass 1 section 4 (seven screenshots); `.form-error`, `.form-success` in `src/styles/globals.css:170-171`; `src/styles/plans.css:145-156`; `src/styles/guided-conversation.css:112`
- Systemic? Yes. Related: E-009, E-012, E-036, E-037, E-040, A-017.

**DS-013. Ten dialogs and at least six menus are each built by hand**
- Screen: Projects (delete), Settings (delete account, sign out), Home (sign-in overlay, activity), project conversation (name preview, direction view, brand view, details), Library (detail).
- Category: components
- Severity: P2
- Tag: needs redesign
- What's wrong: dialog widths are 450, 460, 480, 502, 520, 620, 680, 860 and 1100 px, with two radii, six shadows, seven backdrops, two close-button styles and different header layouts. None has an opening transition. There are at least six menus and popovers with three radii and four shadows; five of them are `<details>` elements that stay open when focus leaves (pass 3, A-011).
- Why it matters: the behaviour underneath is good, so the inconsistency is purely visible. It also means every fix (focus return, sticky headers) has to be made ten times.
- Suggested direction: one Dialog in four widths with fixed parts, one Drawer and one Menu (section 3f).
- Evidence: `src/styles/project-card-actions.css:82-96`; `src/styles/auth.css:142-151`; `src/components/naming/naming-inspect.module.css:1-21`; `src/components/journey/journey.module.css:93`
- Systemic? Yes. Related: pass 1 section 4, M-003, A-011, A-032.

**DS-014. The focus ring is not a system: eleven offsets, fourteen removals, one colour**
- Screen: all; worst on the inspiration gallery.
- Category: components (keyboard)
- Severity: P1
- Tag: needs redesign
- WCAG criterion: 2.4.7 Focus Visible (AA); 1.4.11 Non-text Contrast (AA)
- What's wrong: the global ring is a 2 px ink outline, but 59 `:focus-visible` rules in 25 files override it with offsets from -6 to 4 px, 14 declarations remove the outline, and on dark artwork ink measures 1.06:1 to 1.11:1. On gallery tiles the ring is clipped away entirely.
- Why it matters: a keyboard user loses their place exactly where the page has the most controls.
- Suggested direction: the two-part ring as tokens (sections 3a and 3b), two offsets, and a rule that no component removes it without the standard replacement.
- Evidence: `design-system/drift.md` "Outline offsets", "outline: none"; `design-system/contrast.md` "Focus ring"; `annotated/A-kbd-tile-focused.png`
- Systemic? Yes. Related: A-004, A-005, A-012.

**DS-015. There is no shared way to hold space while something loads**
- Screen: project conversation, Assets, Library, Projects.
- Category: components (loading)
- Severity: P1
- Tag: needs redesign
- Lighthouse/trace metric: CLS 0.18 (desktop) and 0.75 (phone conditions) on the conversation; 0.55 on Assets (pass 3).
- What's wrong: only the project card has a skeleton. Elsewhere, loading is a line of text, a blank area or a "Preparing…" box of a different size from the result. Images have no reserved frame. Three separate pulse animations and one spinner exist, each tied to one screen.
- Why it matters: the pages people work on, and the page where they collect the result, jump as content arrives.
- Suggested direction: Skeleton, Media frame, and the three waiting patterns (sections 3f and 3g). The components are designed in Claude Design; reserving the space is then an execution fix on each screen.
- Evidence: `screens/projects__loading-skeleton-free__1440.png`; `03_accessibility_technical.md` section 7; `annotated/M-019.png`
- Systemic? Yes. Related: M-006, M-013, M-014, M-019, A-024, A-025, E-052.

**DS-016. Empty states come in three styles and 24 classes**
- Screen: Home, Projects, Deleted projects, Library, search with no match, legacy pages.
- Category: components
- Severity: P2
- Tag: needs redesign
- What's wrong: an icon in a grey rounded square with a button, a bare line icon, or text alone, each with its own spacing; two legacy versions use dashed borders.
- Why it matters: an empty screen is a new account's first impression of each page. Heuristic: *aesthetic and minimalist design*; an empty screen should invite the next action.
- Suggested direction: one Empty state in three sizes (section 3f) and the empty pattern (3g). What fills the visual slot is pass 1b's decision (IMG-010).
- Evidence: `screens/library__empty-fresh__1440.png`; `screens/projects__empty-fresh__1440.png`; `screens/home__empty-fresh__1440.png`; `design-system/components.md` "empty state"
- Systemic? Yes. Related: pass 1 section 4, IMG-010.

**DS-017. Icons are drawn three ways with five stroke weights**
- Screen: all.
- Category: components (iconography)
- Severity: P2
- Tag: execution fix
- What's wrong: 94 uses go through the `Icon` component (24 icons, stroke 1.55). Ten component files draw their own inline SVG at strokes of 1.2 to 1.6. Arrows, chevrons and sort glyphs are loaded as image files from six folders, so they cannot follow the text colour or its hover and disabled states. There are no icon size tokens.
- Why it matters: small inconsistencies in line weight are visible at a glance in a line-icon interface, and image icons break state styling.
- Suggested direction: one icon family through one component with three sizes (section 3f), as pass 1b already recommends.
- Evidence: `src/components/ui/icon.tsx:145-162`; `src/components/auth/auth-icons.tsx`; `src/components/ui/projects-artwork.tsx`
- Systemic? Yes. Related: IMG-004.

**DS-018. About one selector in eight is dead, and the stylesheet names record history, not structure**
- Screen: code only.
- Category: consistency (code)
- Severity: P2
- Tag: execution fix
- What's wrong: 157 of 1,267 class selectors are not mentioned by any component: 53 in `src/styles/globals.css`, 35 in `project-naming.css` and 32 in `project-workspace.css`. Prefixes such as `guided-`, `concept-`, `project-`, `sg-` and `identity-` come from successive redesigns. 35 declarations use `!important`.
- Why it matters: dead styles make every later change riskier and inflate every measurement in this file. The code cleanup planned before implementation should take them out first.
- Suggested direction: delete after checking each (section 4); organise styles by component once the component layer exists.
- Evidence: `design-system/components.md` "Unreferenced selectors per stylesheet"; `design-system/components.json`
- Systemic? Yes.

**DS-019. Motion has no tokens, and reduced motion removes feedback as well as movement**
- Screen: all.
- Category: motion
- Severity: P2
- Tag: execution fix
- What's wrong: nine durations and four easing keywords are written per file; hover is instant on most controls and 120 ms on a few; three pulse loops differ slightly. One global rule switches off every animation and transition under reduced motion, including the spinner, the progress bar and the skeleton pulse.
- Why it matters: a one-minute wait looks like a frozen page for the people who use that setting, and small timing differences read as imprecision.
- Suggested direction: the tokens and the reduced-motion rules in section 3e, which are pass 2's proposal unchanged. Pass 2's five plans in `animation-plans/` cover the application.
- Evidence: `design-system/drift.md` "Durations", "Easings"; `src/styles/globals.css:332`; `02_motion_interaction.md` section 8
- Systemic? Yes. Related: M-001, M-003, M-004, E-056.

**DS-020. The look is restrained but generic in four specific ways**
- Screen: all; see Home, Plans and Settings.
- Category: consistency (visual identity)
- Severity: P2
- Tag: needs redesign
- What's wrong: judged with the frontend-design skill's list of templated looks, Embel avoids the loud ones (no gradient washes, no cream with a terracotta accent, no acid colour on black) and its ink-on-warm-paper palette suits the brief. Four habits still mark it as a default kit. (1) One white, rounded, hairline card holds every kind of content at every level of importance: a plan, a settings group, an error, an empty state. (2) Pill shapes are used for navigation, buttons, chips and search alike. (3) The framework's stock typeface at 13 px does all the talking, and the one distinctive graphic, the pixel-ring mark, appears only at 28 px. (4) A dot grid sits behind most pages as decoration, and is missing on Assets. Smaller tells from the same list: meta lines joined with middle dots, and arrows appended to some labels.
- Why it matters: the Direction asks for "minimal and premium". Minimal is achieved. Premium needs deliberate choices in a few places; the skill's rule is to spend boldness in one place and keep the rest quiet. Today nothing is the memorable thing, and the sameness of surfaces also flattens hierarchy.
- Suggested direction: keep the restraint and the palette. Decide, in Claude Design, the typeface (decision 2), control shape (4), when content is a card (5) and the canvas (6). Each has two options that fit the Direction. No new decoration is proposed.
- Evidence: `screens/home__recent-brands-pro__1440.png`; `screens/plans__pro-current-pro__1440.png`; `screens/settings__account-pro__1440.png`
- Systemic? Yes. Related: E-055.

**DS-021. Form controls have no hover or error style of their own, and browser defaults show through**
- Screen: Sign in, Sign up, Settings, Projects and Library search, the logo version drop-down, the refine box.
- Category: components (forms)
- Severity: P2
- Tag: needs redesign
- What's wrong: text fields do not change on hover. An invalid field has no standard look: sign-in shows a pink box under the button, sign-up shows the browser's own validation bubble, the legacy composer turns its border red. Selects are native controls with an overlaid chevron in some places and the bare browser control in others; the refine box shows the browser's resize handle. Checkboxes and radios are native, 16 to 18 px, with uncontrolled outline contrast.
- Why it matters: forms are where non-designers need the clearest signals. Heuristic: *error prevention*; *consistency and standards*.
- Suggested direction: Text field, Textarea, Select, Checkbox and Radio with the states in section 3f, and the form-validation pattern in 3g.
- Evidence: `screens/sign-up__validation-password-mismatch__1440.png`; `screens/sign-in__error-wrong-password__1440.png`; `screens/settings__account-pro__1440.png`; `motion/probe-summary.md` (fields: hover "nothing")
- Systemic? Yes. Related: A-013, A-030, pass 1 section 4 ("browser-native controls show through").

**DS-022. "Disabled" has two looks and is also used to mean "busy"**
- Screen: Sign in, Settings, Plans, project conversation.
- Category: components (states)
- Severity: P2
- Tag: needs redesign
- What's wrong: a global rule fades any disabled button to 48%, while `.button:disabled` sets a muted fill with `--secondary` text, which is the same colour as ordinary muted text (4.84:1), so a disabled label does not look disabled; measured disabled text elsewhere is 1.92:1. Forms set `disabled` on fields and buttons while a request runs, which drops keyboard focus. Disabled buttons give no reason.
- Why it matters: people cannot tell "not available", "working" and "secondary" apart, and keyboard users lose their place on the main journey.
- Suggested direction: one disabled treatment with its own text colour (candidates in section 3b), a separate loading state that keeps focus, and a visible reason next to any disabled control.
- Evidence: `button:disabled` and `.button:disabled` in `src/styles/globals.css:9, 50`; `design-system/contrast.md` "Disabled text and icons"; `screens/settings__account-pro__1440.png` (Cancel and Save changes)
- Systemic? Yes. Related: A-003, A-030.

**DS-023. Control heights and text-link targets vary from 28 to 48 px**
- Screen: Assets, Library, auth pages, gallery.
- Category: components (targets)
- Severity: P3
- Tag: execution fix
- WCAG criterion: 2.5.8 Target Size (Minimum) (AA) passes through its spacing exception.
- What's wrong: 125 declarations set 44 px, but 32 set 40 px, 24 set 36 px, and others 28, 30, 32, 34, 42, 46 and 48 px. Standalone text links are 19.5 to 23 px tall next to 44 px buttons.
- Why it matters: rows of controls do not line up, and small links are hard to hit on touch screens.
- Suggested direction: `--target-min` and the two control sizes in section 3d and 3f; a minimum box for standalone links.
- Evidence: `design-system/drift.md` "Fixed heights"; `03_accessibility_technical.md` A-021
- Systemic? Yes. Related: A-021.

**DS-024. Emails, exported files and crash screens sit outside the system, and nothing documents it**
- Screen: the two emails, `guides/brand-guide.html` in the kit, `global-error.tsx`; documentation.
- Category: consistency
- Severity: P3
- Tag: execution fix
- What's wrong: the emails and the global crash screen carry their own literal colours and a system font, because they cannot load the app's stylesheet; the exported brand guide is unstyled. The only description of the system is a few comments in `tokens.css` and the November 6 plan.
- Why it matters: the files customers keep and the screens they see when something breaks are where drift is least noticed and most embarrassing. Without documentation the rebuilt system will drift the same way.
- Suggested direction: one shared source for primitive values that the app, the emails and the export templates all read; the published Claude Design system becomes the documentation, and `/design-sync` keeps the code in step. The redesign of the exported guide itself is pass 1's finding, not this one.
- Evidence: `src/app/global-error.tsx`; `supabase/templates/confirmation.html`; `exports/rendered/kestrel__guides--brand-guide.html.png`; `emails/confirmation__600.png`
- Systemic? Yes. Related: E-046.

## Recap

**Verdict.** Rebuild the design system's architecture and keep its look. Skill score 35 out of 100: token coverage 13.5 of 40, component completeness 14.5 of 40, naming and documentation 7 of 20.

**Findings: 24.**

| Severity | Needs redesign | Execution fix | Total |
| --- | --- | --- | --- |
| P0 | 0 | 0 | 0 |
| P1 | 7 (DS-001, 002, 010, 011, 012, 014, 015) | 0 | 7 |
| P2 | 6 (DS-005, 013, 016, 020, 021, 022) | 8 (DS-003, 006, 007, 008, 009, 017, 018, 019) | 14 |
| P3 | 0 | 3 (DS-004, 023, 024) | 3 |
| **Total** | **13** | **11** | **24** |

**What was assessed.** All eight foundations (colour, typography, spacing, radius, elevation, layout and breakpoints, iconography, motion) and 27 components, each marked exists, duplicated or missing: 4 are missing as shared pieces (Toast, Tooltip, Skeleton, Media frame), 13 are duplicated, and 10 exist once. Seven patterns are specified. Seven taste decisions are left to Claude Design, each with two options, plus three colour candidates with their required minimums.

**Measured, not estimated.** 41 stylesheets and 10,050 declarations for drift; 1,267 selectors for components; 116 colour pairs for contrast. To repeat any of it: `node design-audit/tools/ds-drift.mjs`, `ds-components.mjs`, `ds-contrast.mjs`.

**Files written.** `design-audit/05_design_system.md` (this file); `design-audit/tools/ds-drift.mjs`, `ds-components.mjs`, `ds-contrast.mjs`; `design-audit/evidence/design-system/` (`drift.md`, `drift.json`, `components.md`, `components.json`, `contrast.md`). No application code, configuration or dependency was changed. No AI generation was started and the app was not run, so the seed data is untouched.

**Limits.**

- **The Browser pane was not opened.** The prompt allows it only where code is ambiguous. Hover, press, focus and disabled styles of every control kind were already measured in the running app by pass 2 (`motion/probe-summary.md`) and pass 3 (`a11y/`), and those measurements were used.
- **"Unreferenced" selectors are a strong hint, not proof.** A class name assembled at run time would be missed. Each should be checked before deletion.
- **Usage counts are of declarations, not of what a person sees.** A value used once on the project conversation matters more than one used ten times on a legacy page. The validation set in section 6 is the check on that.
- **The component score is a judgement.** The skill gives the table and asks for a score; the 0 to 10 marks per component behind the 14.5 are this pass's reading of states, variants, duplication and documentation.
- **Accent and typeface candidates are illustrations of the constraints, not recommendations.** Their ratios are calculated; their suitability is for Claude Design and the owner.
- **Not assessed:** the three crash screens in a browser (source only), the Stripe-hosted pages, dark mode (none exists), and how the system should style the exported brand guide (pass 1, E-046).
- **Line numbers are as of commit `6afd6ba3`.** Prompt 7b refreshes them after the code cleanup; every reference carries a selector or component name for that purpose.
