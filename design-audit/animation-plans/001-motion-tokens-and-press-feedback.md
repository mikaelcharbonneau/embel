# 001 — Add motion tokens and press feedback to every button

- **Status**: TODO
- **Commit**: 06ba8a7
- **Severity**: HIGH
- **Category**: Cohesion & tokens; Physicality & origin (press feedback)
- **Estimated scope**: 2 files (`src/styles/tokens.css`, `src/styles/globals.css`), about 30 lines
- **Audit findings**: M-001, M-002 in `design-audit/02_motion_interaction.md`

## Problem

The app has no motion tokens and no pressed state. A search of `src/**/*.css` finds **0** `:active`
rules, so no button, chip, card or link responds while it is being pressed. Hover states exist, but
they switch colour instantly because the shared controls have no `transition`.

```css
/* src/styles/tokens.css:1-48 — current: colour, type, radius and layout tokens only. No duration, no easing. */

/* src/styles/globals.css:41-43 — current */
.button { border: 1px solid transparent; border-radius: var(--radius-pill); padding: 10px 18px; min-height: 44px; display: inline-flex; align-items: center; justify-content: center; gap: 12px; font-size: 13px; font-weight: 450; line-height: 1.25; text-align: center; white-space: nowrap; }
.button.primary { background: var(--text); color: var(--paper); }
.button.primary:hover:not(:disabled) { background: var(--text-strong-hover); }

/* src/styles/globals.css:54-55 — current */
.icon-button { display: grid; place-items: center; border: 1px solid var(--border); width: 44px; height: 44px; border-radius: 6px; background: var(--paper); }
.icon-button:hover { background: var(--surface); }
```

Why it matters: a press that gives nothing back makes the interface feel like it did not hear the
click. The few transitions that do exist use four different hand-typed durations (120 ms, 150 ms,
160 ms, 200 ms) with the browser's default easing, so nothing can be tuned in one place.

## Target

Add these tokens to `:root` in `src/styles/tokens.css`, after the `--dot-grid` line:

```css
  /* Motion. Interface motion stays under 300ms. Hover and colour use the keyword `ease`. */
  --duration-fast: 120ms;   /* hover colour, border, small fades */
  --duration-press: 160ms;  /* press scale */
  --duration-base: 200ms;   /* menus, dialogs, content entering */
  --duration-slow: 300ms;   /* phone-width sheets, a finished result appearing */
  --ease-out: cubic-bezier(0.23, 1, 0.32, 1);      /* entering, leaving, press */
  --ease-in-out: cubic-bezier(0.77, 0, 0.175, 1);  /* something moving across the screen */
  --ease-drawer: cubic-bezier(0.32, 0.72, 0, 1);   /* sheets sliding up at phone width */
  --press-scale: 0.97;
  --enter-scale: 0.97;
  --enter-shift: 4px;
  --stagger: 40ms;
```

Then, in `src/styles/globals.css`, add a transition and a pressed state to the shared controls:

```css
/* target: add after the existing .icon-button.subtle:hover rule (globals.css:57) */
.button, .icon-button, .text-link {
  transition:
    background-color var(--duration-fast) ease,
    border-color var(--duration-fast) ease,
    color var(--duration-fast) ease,
    transform var(--duration-press) var(--ease-out);
}
.button:active:not(:disabled, [aria-disabled="true"]),
.icon-button:active:not(:disabled) {
  transform: scale(var(--press-scale));
}
```

Do **not** use `transition: all`. Do not add a hover lift or a hover scale.

## Repo conventions to follow

- Tokens live only in `src/styles/tokens.css`, grouped under a one-line comment per group, e.g. `/* Shape scale for the redesigned app: pill controls, rounder surfaces. */` at `tokens.css:36`.
- Shared control styles are single-line rules in `src/styles/globals.css` (lines 41-58). A multi-line rule is acceptable for the new block; the project formats with Prettier (`npm run format`).
- The one existing well-formed transition to imitate is `src/styles/guided-interview.css:47-49` (`transition: border-color 120ms ease, background-color 120ms ease;`).

## Steps

1. `src/styles/tokens.css`: insert the motion token block shown above before the closing `}` of `:root`.
2. `src/styles/globals.css`: insert the transition and `:active` block shown above after line 57 (`.icon-button.subtle:hover { … }`).
3. Replace the hand-typed values in existing transitions with the tokens, value for value (no visual change):
   - `src/styles/guided-interview.css:47-49`: `120ms ease` → `var(--duration-fast) ease` (twice).
   - `src/components/visual-directions/visual-directions-view.module.css:209`: `transition: border-color 120ms;` → `transition: border-color var(--duration-fast) ease;`
   - `src/components/logo-creation/logo-creation.module.css:503`: same replacement.
   - `src/components/naming/naming-inspect.module.css:146`: `transition: transform 0.15s ease;` → `transition: transform var(--duration-fast) ease;`
4. Run `npm run format`.

## Boundaries

- Do NOT touch any `.tsx` file. Motion properties only.
- Do NOT change colours, sizes, radii or the disabled styles at `globals.css:50`.
- Do NOT add press scale to links in running text, to form fields, or to cards.
- Do NOT edit the reduced-motion rule at `globals.css:332`; plan 003 owns it.
- Do NOT add dependencies.
- If a step does not match the code you find (drift since commit 06ba8a7), STOP and report.

## Verification

- **Mechanical**: `npm run typecheck`, `npm run lint`, `npm run format:check` pass. `grep -rn ":active" src/styles/globals.css` shows the new rule.
- **Feel check**: start the app (`node design-audit/seed/serve.mjs`), open `http://127.0.0.1:3105/`.
  - Press and hold "Create account" in the navigation: the button shrinks slightly (3%) and returns when released. It must not look like it jumps.
  - Hover "Sign in" then move away: the background fades in and out; it no longer snaps.
  - A disabled button (the send arrow with an empty prompt) does not shrink when pressed.
  - In DevTools → Animations, set playback to 10% and confirm the press starts fast and settles (ease-out), with no overshoot.
  - Tab to a button and press Space: the focus ring stays a 2px ink outline; nothing else moves.
- **Done when**: every `.button` and `.icon-button` has a visible pressed state, hover colour changes take 120 ms, and no transition in the five edited files uses a literal duration.
