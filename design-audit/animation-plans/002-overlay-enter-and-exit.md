# 002 — Give dialogs and menus one quiet entrance

- **Status**: TODO
- **Commit**: 06ba8a7
- **Severity**: MEDIUM
- **Category**: Missed opportunities (teleporting state); Physicality & origin; Cohesion
- **Estimated scope**: 1 new shared CSS block in `src/styles/globals.css`, small edits in 3 CSS files
- **Depends on**: plan 001 (uses its tokens)
- **Audit findings**: M-003 in `design-audit/02_motion_interaction.md`

## Problem

Every dialog and every menu appears and disappears in a single frame. Measured in the running app:
the element is absent in one frame and fully present in the next, with `animation-name: none` and
`transition-duration: 0s` on all of them.

Dialogs (native `<dialog>` opened with `showModal()`), each with its own CSS and its own backdrop:

| Dialog | CSS | Backdrop today |
| --- | --- | --- |
| Sign in / Create account overlay | `src/styles/auth-guided.css:136-153` (`.auth-overlay`) | `#19191955` + `blur(3px)` |
| Sign out, Delete account | `src/styles/auth.css:142-153` (`.auth-signout-dialog`) | `#19191955` |
| Delete project | `src/styles/project-card-actions.css:82-95` (`.project-lifecycle-dialog`) | `#19191966` |
| Generation activity | `src/styles/generation-activity.css:1-13` | `#17171766` |
| Library asset details (side panel) | `src/styles/assets.css:242-259` (`.assets-detail`) | `#19191942` |
| Context details sheet | `src/components/ui/context-details.module.css:29-42` (`.sheet`) | `#19191955` |
| Larger direction board | `src/components/visual-directions/visual-directions-view.module.css:409-424` (`.dialog`) | `rgb(25 25 25 / 53%)` |
| Name preview | `src/components/naming/naming-inspect.module.css:1-24` (`.dialog`) | `rgb(25 25 25 / 22%)` + `blur(2px)` |
| Inspiration brand view | `src/components/inspiration/inspiration.css:436-449` (`.inspiration-detail`) | `rgb(25 25 25 / 40%)` |

Menus (`<details>` popovers): account menu `src/styles/concept-shell.css:85-97` (`.workspace-account-panel`),
project card menu `src/styles/project-card-actions.css:31-41` (`.project-card-menu`), the project
switcher in the pill (`.menu`, `src/components/journey/journey.module.css:93`).

Why it matters: a surface that covers the page with no bridge reads as a glitch, and the user loses
track of where it came from. These are occasional actions (a few times per session), which is the
frequency where a short entrance helps and does not slow anyone down.

## Target

One shared rule for every modal dialog, in `src/styles/globals.css`. Modals stay centred, so they
scale from the centre. Entering uses `@starting-style`; no JavaScript changes.

```css
/* target: add to src/styles/globals.css, before the reduced-motion rule at line 332 */
dialog[open] {
  opacity: 1;
  transform: none;
  transition:
    opacity var(--duration-base) var(--ease-out),
    transform var(--duration-base) var(--ease-out);
}
@starting-style {
  dialog[open] {
    opacity: 0;
    transform: scale(var(--enter-scale));
  }
}
dialog[open]::backdrop {
  opacity: 1;
  transition: opacity var(--duration-base) var(--ease-out);
}
@starting-style {
  dialog[open]::backdrop {
    opacity: 0;
  }
}
```

The Library side panel is not centred, so it slides from its own edge instead of scaling:

```css
/* target: add to src/styles/assets.css after the .assets-detail::backdrop rule */
@starting-style {
  .assets-detail[open] {
    opacity: 1;
    transform: translateX(100%);
  }
}
.assets-detail[open] {
  transition: transform var(--duration-slow) var(--ease-drawer);
}
```

Menus scale from the control that opened them, faster than dialogs:

```css
/* target: add to src/styles/concept-shell.css after the .workspace-account-panel rule */
details[open] > .workspace-account-panel {
  transform-origin: top right;
  transition:
    opacity 150ms var(--ease-out),
    transform 150ms var(--ease-out);
}
@starting-style {
  details[open] > .workspace-account-panel {
    opacity: 0;
    transform: scale(var(--enter-scale));
  }
}

/* target: add to src/styles/project-card-actions.css after the .project-card-menu rule (same values) */
.project-card-menu {
  transform-origin: top right;
  transition:
    opacity 150ms var(--ease-out),
    transform 150ms var(--ease-out);
}
@starting-style {
  .project-card-menu {
    opacity: 0;
    transform: scale(var(--enter-scale));
  }
}
```

Closing stays instant in this plan. That is deliberate: a dismissal should feel immediate, most of
these dialogs are removed from the page by React the moment they close (so a CSS exit cannot play),
and Escape is a keyboard action, which should never wait for an animation.

Never start from `scale(0)`. Do not animate `width`, `height`, `top` or `left`.

## Repo conventions to follow

- Dialogs are native `<dialog>` elements; do not wrap them or add a library.
- Global element rules live in `src/styles/globals.css` (e.g. `:focus-visible` at line 22).
- Tokens from plan 001: `--duration-base` (200ms), `--duration-slow` (300ms), `--ease-out`, `--ease-drawer`, `--enter-scale` (0.97).

## Steps

1. Confirm plan 001 is applied (`grep -n "duration-base" src/styles/tokens.css`). If not, STOP.
2. Add the shared `dialog[open]` block to `src/styles/globals.css` immediately before line 332.
3. Add the `.assets-detail[open]` block to `src/styles/assets.css`.
4. Add the two menu blocks to `src/styles/concept-shell.css` and `src/styles/project-card-actions.css`.
5. Run `npm run format`.

## Boundaries

- Do NOT change any `.tsx` file, any `showModal()` call or any focus handling.
- Do NOT change backdrop colours or blur in this plan. Unifying the nine backdrops is a design-system decision (finding M-003, pass 3b).
- Do NOT add exit animations.
- Do NOT animate the sign-in overlay's `backdrop-filter`; only its opacity.
- If the build rejects `@starting-style`, STOP and report; do not replace it with keyframes.

## Verification

- **Mechanical**: `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run build` pass.
- **Feel check** (`node design-audit/seed/serve.mjs`, sign in as `audit-free`, see `design-audit/README.md`):
  - Projects → "…" on a card: the menu grows from its top-right corner in 150 ms.
  - Menu → Delete: the dialog fades in and grows from 97% to 100% while the page dims. Press Escape: it disappears at once and focus returns to the "…" button.
  - Signed out, Home → Sign in: the overlay fades in; the blur behind it must not flicker.
  - Open and close any dialog five times quickly: it never appears half-transparent or stuck.
  - DevTools → Animations at 10%: the dialog starts fast and settles; it never overshoots 100%.
  - DevTools → Rendering → emulate `prefers-reduced-motion: reduce`: after plan 003, dialogs still fade but do not scale or slide.
- **Done when**: all nine dialogs and the two menus enter with the values above, closing is unchanged, and keyboard focus behaves exactly as before.
