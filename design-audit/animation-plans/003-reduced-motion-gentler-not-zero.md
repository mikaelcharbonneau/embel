# 003 — Reduced motion: remove movement, keep the signs of progress

- **Status**: TODO
- **Commit**: 06ba8a7
- **Severity**: MEDIUM
- **Category**: Accessibility
- **Estimated scope**: 6 CSS files, about 60 lines
- **Depends on**: plan 001 (tokens)
- **Audit findings**: M-004 in `design-audit/02_motion_interaction.md`

## Problem

When the operating system asks for reduced motion, one global rule switches off every animation and
every transition in the app:

```css
/* src/styles/globals.css:332 — current */
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { scroll-behavior: auto !important; animation: none !important; transition: none !important; } }
```

Measured in the running app with reduced motion on: `document.getAnimations()` returns an empty list
while competitor research is running. The progress bar becomes a still grey line
(`src/components/journey/journey.module.css:312-318`), the sign-in spinner becomes a still ring
(`src/styles/auth.css:93-99`), the "thinking" mark stops pulsing (`src/styles/guided-conversation.css:197-202`),
and the loading skeletons stop pulsing (`src/components/workspace/project-card.module.css:188-192`).
A wait of a minute then looks exactly like a frozen page.

Reduced motion means fewer and gentler animations, not none. Movement across the screen (sliding,
scaling, rotating) should go; a slow opacity pulse and colour fades should stay, because they are the
only signal that work is still happening.

## Target

Replace the global rule with one that removes movement through the tokens and keeps opacity:

```css
/* target: src/styles/globals.css:332 */
@media (prefers-reduced-motion: reduce) {
  :root {
    --press-scale: 1;
    --enter-scale: 1;
    --enter-shift: 0px;
  }
  *, *::before, *::after { scroll-behavior: auto !important; }
}
```

Give every looping indicator a reduced-motion version that pulses opacity instead of moving. One
shared keyframe, added to `src/styles/globals.css` next to the rule above:

```css
@keyframes embel-calm-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.55; }
}
```

Then, in each file's existing `@media (prefers-reduced-motion: reduce)` block, replace
`animation: none` with the calm pulse:

```css
/* src/components/journey/journey.module.css:312-318 — target */
@media (prefers-reduced-motion: reduce) {
  .bar > span {
    width: 100%;
    background: var(--border-strong);
    animation: embel-calm-pulse 1.6s ease-in-out infinite;
  }
}

/* src/styles/auth-guided.css:192-196 — target (the spinner stops turning and pulses instead) */
@media (prefers-reduced-motion: reduce) {
  .auth-guided .auth-progress {
    animation: embel-calm-pulse 1.6s ease-in-out infinite;
  }
}

/* src/styles/guided-conversation.css:197-202 — target */
@media (prefers-reduced-motion: reduce) {
  .flow-enter {
    animation: none;
  }
  /* .guided-thinking > img keeps its opacity pulse: it does not move. */
}

/* src/styles/guided-interview.css:378-387 — target (no rotation, no scale; opacity only) */
@media (prefers-reduced-motion: reduce) {
  .guided-research-mark-motion {
    transform: scale(2);
    animation: embel-calm-pulse 1.6s ease-in-out infinite;
  }
}

/* src/components/workspace/project-card.module.css:188-192 — target: delete this block.
   The skeleton pulse is opacity only (1 → 0.55 → 1 over 1.6s) and may keep running. */
```

Removing the global kill switch means two existing movements must be switched off explicitly under
reduced motion. Add to the end of `src/components/inspiration/inspiration.css`:

```css
@media (prefers-reduced-motion: reduce) {
  .inspiration-heart:hover:not(:disabled) { transform: none; }
  .inspiration-brand-tile:hover .inspiration-brand-open img { transform: none; }
}
```

If plan 002 has been applied, also add to `src/styles/assets.css`:
`@media (prefers-reduced-motion: reduce) { .assets-detail[open] { transition: none; } }`

`.auth-progress` outside `.auth-guided` (`src/styles/auth.css:93-99`) needs the same reduced-motion
override; add it to `src/styles/auth.css`.

## Repo conventions to follow

- Reduced-motion overrides sit at the end of the file that defines the animation (see the five existing blocks listed above).
- CSS modules scope keyframe names, so `embel-calm-pulse` must be referenced from a module with `:global`: inside a `.module.css` file write `animation: :global(embel-calm-pulse) 1.6s ease-in-out infinite;` if the build mangles the name. Check the built CSS; if the name is mangled, define a local copy of the keyframe in that module instead.
- The logo generation effect already handles reduced motion in code (`src/components/logo-creation/generation-animation.tsx:29-40`): it shows the caption without the shader. Leave it.

## Steps

1. Confirm plan 001 is applied. If not, STOP.
2. `src/styles/globals.css:332`: replace the rule with the target block and add the `embel-calm-pulse` keyframe after it.
3. Edit the five reduced-motion blocks as shown.
4. Add the `.auth-progress` override to `src/styles/auth.css`.
5. Run `npm run format`.

## Boundaries

- Do NOT remove the `scroll-behavior: auto !important` part.
- Do NOT add new animations for people who have not asked for reduced motion.
- Do NOT touch `generation-animation.tsx` or `use-conversation-follow.ts` (they already branch on the setting).
- If a block does not match the excerpts above, STOP and report.

## Verification

- **Mechanical**: `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run build` pass.
- **Feel check** (DevTools → Rendering → emulate `prefers-reduced-motion: reduce`):
  - Sign in with a wrong password on a throttled network: the ring in the button pulses slowly; it does not spin.
  - Projects on a throttled network: skeleton blocks pulse; nothing slides.
  - Start research with the stand-in AI held (`design-audit/README.md`, "Research in progress"): the bar is a full-width line that breathes; `document.getAnimations().length` in the console is greater than 0.
  - Press a button: no shrink. Open a dialog (after plan 002): it fades, with no scale.
  - Switch the emulation off: everything behaves as before this plan.
- **Done when**: with reduced motion on, no element moves, scales or rotates, and every waiting state still shows a slow opacity pulse.
