# 004 — One hover timing everywhere, and no hover-only controls on touch

- **Status**: TODO
- **Commit**: 06ba8a7
- **Severity**: MEDIUM
- **Category**: Easing & duration; Accessibility (hover gating); Cohesion
- **Estimated scope**: 4 CSS files, about 50 lines
- **Depends on**: plan 001 (tokens)
- **Audit findings**: M-002, M-005 in `design-audit/02_motion_interaction.md`

## Problem

1. **Hover is instant on some surfaces and eased on others.** The navigation, project cards, menu
   rows and plan buttons snap between colours (`transition-duration: 0s`, measured). The Inspiration
   gallery and the guided choice cards ease over 120 ms, images zoom over 200 ms.

```css
/* src/components/journey/journey.module.css:76-78 — current: no transition on .navLink */
.navLink:hover {
  background: var(--surface);
}

/* src/components/workspace/project-card.module.css:12-14 — current: no transition on .card */
.card.card:hover {
  border-color: var(--border-strong);
}
```

2. **Hover movement is not limited to devices that can hover.** The stylesheet has 85 `:hover`
   rules and no `@media (hover: hover)` query. On a phone a tap leaves the hover style stuck.

```css
/* src/components/inspiration/inspiration.css:296-298 — current */
.inspiration-heart:hover:not(:disabled) {
  transform: scale(1.12);
}

/* src/components/inspiration/inspiration.css:820-822 — current */
.inspiration-brand-tile:hover .inspiration-brand-open img {
  transform: scale(1.03);
}
```

3. **Three controls exist only on hover.** At 390 px with touch, measured `opacity: 0` on all of
   them: the heart that likes one part of a brand, the label that names the part, and the "Open
   brand" hint. A phone user cannot see that parts can be liked.

```css
/* src/components/inspiration/inspiration.css:847-865 — current */
.inspiration-workspace .inspiration-heart.inspiration-part-like {
  right: 4px;
  top: 4px;
  width: 30px;
  height: 30px;
  opacity: 0;
  transition:
    opacity 120ms,
    transform 120ms;
}
.inspiration-brand-tile:hover .inspiration-part-like,
.inspiration-brand-tile:focus-within .inspiration-part-like,
.inspiration-workspace .inspiration-part-like[aria-pressed="true"] {
  opacity: 1;
}
```

## Target

**Hover colour changes take `var(--duration-fast)` (120 ms) with `ease`, everywhere.**

```css
/* target: src/components/journey/journey.module.css — add to the existing .navLink rule (line 62) and to .step (line ~178) */
  transition:
    background-color var(--duration-fast) ease,
    color var(--duration-fast) ease;

/* target: src/components/workspace/project-card.module.css — add to the .card rule */
  transition: border-color var(--duration-fast) ease;
```

**Hover movement only where a pointer can hover**, with the token durations:

```css
/* target: src/components/inspiration/inspiration.css:296-298 */
@media (hover: hover) and (pointer: fine) {
  .inspiration-heart:hover:not(:disabled) {
    transform: scale(1.12);
  }
}

/* target: src/components/inspiration/inspiration.css:820-822 */
@media (hover: hover) and (pointer: fine) {
  .inspiration-brand-tile:hover .inspiration-brand-open img {
    transform: scale(1.03);
  }
}
```

Replace the literal durations in the same file with tokens, value for value:
`120ms` → `var(--duration-fast) ease`, `150ms` → `var(--duration-fast) ease`, `200ms` → `var(--duration-base) var(--ease-out)`
(lines 285-287, 295, 725-727, 771, 818, 839, 852-854).

**On touch, show what hover would have revealed** (default proposal; the look is a design decision,
see Boundaries):

```css
/* target: add at the end of src/components/inspiration/inspiration.css */
@media (hover: none) {
  .inspiration-workspace .inspiration-heart.inspiration-part-like {
    opacity: 1;
  }
}
```

## Repo conventions to follow

- Width-specific rules sit at the end of each file in `@media` blocks (see `inspiration.css` container queries at lines 218-233).
- `(pointer: coarse)` is already used twice for touch target sizes (`src/styles/project-card-actions.css:166`, `src/styles/guided-conversation.css:271`).
- Tokens from plan 001: `--duration-fast` (120ms), `--duration-base` (200ms), `--ease-out`.

## Steps

1. Confirm plan 001 is applied. If not, STOP.
2. Add the `transition` lines to `.navLink` and `.step` in `journey.module.css` and to `.card` in `project-card.module.css`.
3. Wrap the two hover transforms in `inspiration.css` in `@media (hover: hover) and (pointer: fine)`.
4. Replace the literal durations in `inspiration.css` with tokens.
5. Add the `@media (hover: none)` block.
6. Run `npm run format`.

## Boundaries

- Do NOT add hover lifts, shadows or scale to cards, buttons or navigation. Colour and border only.
- Do NOT change what hover looks like (colours stay as they are); only how fast it changes.
- The touch rule above only makes the existing heart visible. Whether part labels and the "Open brand" hint should also show on touch, and how, is a design decision (finding M-005): do NOT invent a layout for them.
- Do NOT touch `.tsx` files.
- If the line numbers have drifted, find the rule by its selector; if a selector is missing, STOP and report.

## Verification

- **Mechanical**: `npm run typecheck`, `npm run lint`, `npm run format:check` pass. `grep -n "hover: hover" src/components/inspiration/inspiration.css` shows two blocks.
- **Feel check**:
  - Desktop: move the pointer along Home / Projects / Library in the pill: each background fades in and out in 120 ms; sweeping quickly across all three never leaves two highlighted.
  - Desktop: hover a project card: the border darkens smoothly. Hover an Inspiration tile: image zoom is unchanged.
  - DevTools device toolbar, iPhone, touch on: open a brand at the Inspiration step. Each tile shows its heart. Tap a tile: the image does not stay zoomed and the heart does not stay enlarged after the tap.
- **Done when**: no measured `transition-duration: 0s` remains on `.navLink`, `.step` and the project card; hover transforms sit inside the hover media query; part hearts are visible at 390 px with touch.
