# 005 — Let loaded content fade in instead of popping in

- **Status**: TODO
- **Commit**: 06ba8a7
- **Severity**: LOW
- **Category**: Missed opportunities (teleporting state)
- **Estimated scope**: 3 CSS files, about 25 lines
- **Depends on**: plan 001 (tokens)
- **Audit findings**: M-009, M-017 in `design-audit/02_motion_interaction.md`

## Problem

When a list loads, each project card fills in three separate steps with no bridge: the title appears,
then the thumbnail replaces a grey block, then the "next step" line appears (measured at about 100,
300 and 800 ms on Projects). The same happens to logo concepts and direction boards: the picture
replaces the placeholder in a single frame. On the screens where the person waits for a result,
this makes the arrival of the work, which is the best moment in the product, look like a flicker.

```css
/* src/components/workspace/project-card.module.css:45-53 — current: no entrance for the thumbnail */
.preview img {
  display: block;
  width: 100%;
  height: 100%;
  min-height: 0;
  object-fit: contain;
  mix-blend-mode: multiply;
  filter: contrast(1.08);
}

/* src/components/logo-creation/logo-creation.module.css:545-550 — current */
.galleryPreview img {
  width: 100%;
  height: 100%;
  object-fit: contain;
  min-height: 0;
}
```

## Target

A short fade when an image element is inserted. `@starting-style` applies on insertion, so no
JavaScript is needed. Opacity only: no slide, no scale, no stagger on lists the person opens many
times a day.

```css
/* target: add after .preview img in src/components/workspace/project-card.module.css */
.preview img {
  transition: opacity var(--duration-base) var(--ease-out);
}
@starting-style {
  .preview img {
    opacity: 0;
  }
}

/* target: add after .galleryPreview img in src/components/logo-creation/logo-creation.module.css.
   A finished concept is a rare, wanted moment, so it may take the slow duration. */
.galleryPreview img {
  transition: opacity var(--duration-slow) var(--ease-out);
}
@starting-style {
  .galleryPreview img {
    opacity: 0;
  }
}
```

Apply the same block to the direction board image in
`src/components/visual-directions/visual-directions-view.module.css` (find the rule that sizes the
board `img` inside `.card`; use `--duration-slow`).

## Repo conventions to follow

- These previews are private files shown through `blob:` URLs: the `<img>` is only inserted once its bytes are ready, so a fade on insertion is a fade on arrival.
- Tokens from plan 001: `--duration-base` (200ms), `--duration-slow` (300ms), `--ease-out`.
- Reduced motion (plan 003) leaves opacity fades on. That is intended.

## Steps

1. Confirm plan 001 is applied. If not, STOP.
2. Add the two blocks shown above.
3. Add the matching block for the direction board image.
4. Run `npm run format`.

## Boundaries

- Do NOT add a fade to text, to the skeleton blocks, or to whole cards.
- Do NOT add stagger delays to Projects, Home or Library.
- Do NOT change `mix-blend-mode` or `filter` on the images.
- Do NOT touch `.tsx` files. If an image turns out to be mounted before its bytes are ready (it fades in empty, then pops), STOP and report: that case needs an `onLoad` handler, which is outside this plan.

## Verification

- **Mechanical**: `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run build` pass.
- **Feel check**:
  - Projects with DevTools network throttling ("Fast 4G"): each thumbnail fades in over 200 ms; titles are unchanged.
  - A brand at the Logo step: reload; the six concepts fade in over 300 ms and do not all flash at once in one frame.
  - DevTools → Animations at 10%: opacity runs 0 → 1 with a fast start; nothing moves.
  - Navigate Home → Projects → Home five times: the fade never makes the page feel slower. If it does, shorten `--duration-base` use here to `--duration-fast`.
- **Done when**: thumbnails, logo concepts and direction boards fade in on arrival, and nothing else changed.
