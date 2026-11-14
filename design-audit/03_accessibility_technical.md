# Design audit, pass 3: accessibility and technical quality

Status: **complete for pass 3** (see section 9 for what could not be checked).
Environment: local stack only (`http://127.0.0.1:3105`, stand-in AI). Dates: 2026-11-11 and 11-12. The seed reset was run at the start of this pass and again at the end, so the data is in its seeded state. No real AI generation was started and no email was sent.

How to read a finding. Each block has an ID (A-001, A-002, …) and the same fields as pass 1, plus the WCAG criterion or the measured metric.

- **Severity:** P0 blocks or breaks a task. P1 hurts trust or completion; any WCAG AA failure on a primary flow is at least P1. P2 is noticeable polish. P3 is nice to have.
- **Tag:** *needs redesign* means the fix changes how something looks or works and needs a design decision (goes to Claude Design). *Execution fix* means the right answer is already clear (goes straight to implementation).
- **WCAG** means the Web Content Accessibility Guidelines, version 2.2. "A" and "AA" are its conformance levels; AA is the usual legal and commercial target. A criterion number such as 1.4.11 identifies one testable rule.
- **Contrast ratio** is the measured difference in brightness between two colours, from 1:1 (identical) to 21:1 (black on white). Body text needs 4.5:1; large text, the outline of a control and a focus ring need 3:1. Every ratio in this file was calculated from computed colours with `tools/contrast.mjs`; none was judged by eye.
- **Focus** is the control the keyboard is currently on. The **focus ring** is the outline that shows it. A **tab stop** is one press of the Tab key.
- **LCP, CLS, INP** are Google's three Core Web Vitals. LCP (Largest Contentful Paint) is when the main content appears; good is 2.5 s or less. CLS (Cumulative Layout Shift) scores how much the page jumps while loading; good is 0.1 or less, poor is above 0.25. INP (Interaction to Next Paint) is how long the page takes to react to a click or key; good is 200 ms or less.
- **Evidence** paths are relative to `design-audit/evidence/`.

## 1. Summary

**The basics are unusually sound, and the failures are concentrated in a few shared pieces.** Lighthouse scores 100 for accessibility on 33 of 39 route states, and the lowest score anywhere is 96. Every page has a working skip link, one `main` landmark, a language, real labels on every form field, alt text on every image, native dialogs that trap focus and close on Escape, and body text between 4.8:1 and 17.6:1. Automated tools find about a third of real problems, though, and the manual checks found the rest: 34 findings, **0 at P0, 11 at P1, 11 at P2 and 12 at P3**. Eight need a design decision; 26 are straightforward fixes.

The six things that matter most:

1. **Form fields and placeholders are too faint (A-001, A-002).** The border that marks every text field, search box and drop-down is 1.19:1 to 1.28:1 against its background; the minimum is 3:1. Placeholder text is 3.64:1 to 3.9:1; the minimum is 4.5:1. Both come from two colour tokens, so both are one palette decision for the new design system.
2. **Keyboard focus is often invisible or lost (A-003, A-004, A-005).** On the inspiration gallery, which holds most of the controls on a brand page, the focus ring is cut off by the tile's rounded corners, so a keyboard user cannot see where they are. Across the app, pressing a button that starts a request (Sign in, Save changes, Upgrade, Continue, Change name) drops focus to the top of the document.
3. **The two key choices are not built as real controls (A-006, A-007).** Creative direction cards are articles pretending to be radio buttons, with buttons nested inside them; logo concepts are `div`s pretending to be buttons. They work with Enter, but screen readers get a confused picture, and arrow keys do nothing.
4. **A finished brand is 141 tab stops long (A-010).** The reply box and the Continue link come last, after about 100 controls that belong to other companies' brands in the inspiration gallery. The whole page is also one "live" region (A-008), so a screen reader may try to announce any change anywhere in it.
5. **Two pages fail at high zoom (A-014, A-016).** Plans keeps three columns at any width and clips its prices at 320 px, which is what a low-vision user sees at 400% zoom. At 200% zoom the journey steps in the project bar lose their names and become ", complete".
6. **The brand pages jump while loading (A-024, A-025).** On the production build, the brand conversation scores CLS 0.18 on desktop and 0.75 under phone conditions; the Assets page scores 0.55 on desktop. Responsiveness to clicks is good everywhere (INP 42 to 140 ms with a 4 times slower processor).

What is already good and should be kept: the skip link; native `<dialog>` for every modal, with focus returned to the control that opened it (one exception, in A-003); the Settings and Library tabs, which follow the full keyboard pattern; the project options menu; the sign-in overlay, which keeps the typed brief and returns focus to it; the global reduced-motion rule; 44 px buttons; and honest, specific error text.

## 2. What was checked, and how

| Step | Tool | Coverage | Output |
| --- | --- | --- | --- |
| Lighthouse (accessibility, best practices) | Chrome DevTools MCP, in its own Chrome window, signed in as each test account | 39 route states, each at desktop and mobile emulation (78 reports), on the development server | `lighthouse/<state>__<device>/report.html`, table in `lighthouse/summary.md` |
| Performance traces | Chrome DevTools MCP against the production build (`serve.mjs --prod`) | 3 routes: signed-out Home, brand conversation, Assets. Each: desktop, phone conditions (390 px, 4x slower CPU, Slow 4G), and one trace with real clicks and typing for INP (9 traces) | `traces/*.json.gz` |
| Measured probe | `tools/a11y-probe.mjs` (Playwright and axe-core, which is the rule engine Lighthouse uses) | 42 route states at 390 and 1440 px (84 runs): axe rules for WCAG 2.0, 2.1 and 2.2 A and AA; contrast of every text run; control outlines; target sizes; a full Tab walk; hover colours; reflow at 320 px and at 200% zoom | `a11y/<state>__<width>.json`, `a11y/reflow/`, `a11y/focus/`; overview with `node design-audit/tools/a11y-aggregate.mjs` |
| Keyboard and focus scenarios | `tools/a11y-keyboard.mjs` (real key presses) | 16 scenarios: skip link, sign-in overlay, wrong password, sign-up mismatch, project menu, both delete dialogs, account menu, Settings tabs, offline save, brand conversation dialogs, out-of-credits, Library, Plans, zoom | `a11y/keyboard.json`, `annotated/A-kbd-*.png` |
| Hands-on checks | Browser pane | Keyboard-only sign-in, the Logo step and the out-of-credits prompt as audit-free | noted in the findings |
| Accessibility review | design plugin, accessibility-review skill (WCAG 2.1 AA), plus the six WCAG 2.2 criteria named in the brief | every route | sections 3 to 6 |
| Code review | web-design-guidelines skill (Vercel's Web Interface Guidelines) | 67 files read in full, 10 in part: the shell, navigation, every dialog, the main page components, global CSS | findings marked "code" |

How sign-in was verified. The session is kept in cookies that the page's scripts cannot read, and Lighthouse does not clear them, so the DevTools window stayed signed in. After each batch the page Lighthouse left behind was checked: the account menu was present and no "Sign in to…" message was shown. The failing nodes Lighthouse reported are signed-in content (project cards, logo concepts), which confirms it. No login-page score is reported as another route's score.

Two limits to keep in mind. Lighthouse ran on the development server, which is fine for accessibility rules but not for speed, so every performance number in this file comes from the production build. And the production build runs on this machine over HTTP/1.1 with a local database, so loading times are best cases; the layout-shift and responsiveness numbers carry over to production more directly.

## 3. Lighthouse scores per route

All runs are on the development server. "Layout shift" is the CLS Lighthouse happened to record there; treat it as a hint and use section 7 for real numbers. The SEO category is not reported: the site is deliberately marked `noindex`.

| Route state | URL | Accessibility (desktop / mobile) | Best practices (desktop / mobile) | Layout shift, dev server (desktop / mobile) | Failed audits |
| --- | --- | --- | --- | --- | --- |
| `brand-assets__kestrel-ready-pro` | `/brands/account/<id>/logo/deliverables` | 100 / 100 | 100 / 100 | 0.466 / 0.155 | none |
| `brand-assets__orchardlane-ready-free` | `/brands/account/<id>/logo/deliverables` | 100 / 100 | 100 / 100 | 0.466 / 0.155 | none |
| `brand-conversation__berenice-inspiration-chosen-free` | `/brands/account/<id>?view=strategy` | 100 / 100 | 96 / 96 | 0.104 / 0.759 | errors-in-console |
| `brand-conversation__brightsmile-strategy-done-free` | `/brands/account/<id>?view=strategy` | 100 / 100 | 96 / 96 | 0.016 / 0.009 | errors-in-console |
| `brand-conversation__kestrel-complete-pro` | `/brands/account/<id>?view=strategy` | 99 / 99 | 96 / 96 | 0.102 / 0.779 | errors-in-console, heading-order |
| `brand-conversation__mosswood-directions-generated-free` | `/brands/account/<id>?view=strategy` | 99 / 99 | 96 / 96 | 0.111 / 1.112 | errors-in-console, heading-order |
| `brand-conversation__northernlights-voice-done-free` | `/brands/account/<id>?view=strategy` | 100 / 100 | 96 / 96 | 0.100 / 1.081 | errors-in-console |
| `brand-conversation__orchardlane-complete-free` | `/brands/account/<id>?view=strategy` | 99 / 99 | 96 / 96 | 0.102 / 0.760 | errors-in-console, heading-order |
| `brand-conversation__quill-logos-generated-free` | `/brands/account/<id>?view=strategy` | 99 / 99 | 96 / 96 | 0.107 / 0.759 | errors-in-console, heading-order |
| `brand-conversation__spokesmith-research-done-free` | `/brands/account/<id>?view=strategy` | 100 / 100 | 96 / 96 | 0.016 / 0.009 | errors-in-console |
| `brand-conversation__tidewater-logos-partly-failed-free` | `/brands/account/<id>?view=strategy` | 99 / 99 | 96 / 96 | 0.112 / 0.760 | errors-in-console, heading-order |
| `brand-identity__kestrel-pro` | `/brands/account/<id>/identity` | 96 / 96 | 100 / 100 | 0.018 / 0.305 | aria-prohibited-attr |
| `brand-recover__owner-none-pro` | `/brands/<id>` | 100 / 100 | 100 / 100 | 0.000 / 0.002 | none |
| `forgot-password__default` | `/forgot-password` | 100 / 100 | 100 / 100 | 0.004 / 0.000 | none |
| `home__empty-fresh` | `/` | 100 / 100 | 100 / 100 | 0.000 / 0.000 | none |
| `home__recent-brands-free` | `/` | 100 / 100 | 100 / 100 | 0.009 / 0.017 | label-content-name-mismatch |
| `home__recent-brands-pro` | `/` | 100 / 100 | 100 / 100 | 0.006 / 0.017 | label-content-name-mismatch |
| `home__signed-out` | `/` | 100 / 100 | 100 / 100 | 0.000 / 0.000 | none |
| `library__empty-fresh` | `/assets` | 100 / 100 | 100 / 100 | 0.000 / 0.000 | none |
| `library__kept-assets-pro` | `/assets` | 100 / 100 | 100 / 100 | 0.000 / 0.000 | none |
| `library__signed-out` | `/assets` | 100 / 100 | 100 / 100 | 0.005 / 0.001 | none |
| `not-found__default` (snapshot mode) | `/this-page-does-not-exist` | 100 / 100 | 100 / 100 |  /  | none |
| `plans__free-0-credits-free` | `/plans` | 100 / 100 | 100 / 100 | 0.028 / 0.124 | none |
| `plans__free-fresh` | `/plans` | 100 / 100 | 100 / 100 | 0.028 / 0.124 | none |
| `plans__pro-current-pro` | `/plans` | 100 / 100 | 100 / 100 | 0.047 / 0.000 | none |
| `plans__signed-out` | `/plans` | 100 / 100 | 100 / 100 | 0.004 / 0.000 | none |
| `project-workspace__signed-out` | `/brands/account/<id>` | 100 / 100 | 100 / 100 | 0.005 / 0.003 | none |
| `projects-deleted__empty-pro` | `/brands?state=deleted` | 100 / 100 | 100 / 100 | 0.000 / 0.000 | none |
| `projects__eight-brands-free` | `/brands` | 100 / 100 | 100 / 100 | 0.015 / 0.028 | label-content-name-mismatch |
| `projects__empty-fresh` | `/brands` | 100 / 100 | 100 / 100 | 0.002 / 0.022 | none |
| `projects__signed-out` | `/brands` | 100 / 100 | 100 / 100 | 0.005 / 0.001 | none |
| `projects__three-brands-pro` | `/brands` | 100 / 100 | 100 / 100 | 0.004 / 0.034 | label-content-name-mismatch |
| `reset-password__no-recovery-session` | `/reset-password` | 100 / 100 | 100 / 100 | 0.004 / 0.000 | none |
| `settings__account-free` | `/settings` | 100 / 100 | 100 / 100 | 0.008 / 0.000 | none |
| `settings__account-fresh` | `/settings` | 100 / 100 | 100 / 100 | 0.008 / 0.000 | none |
| `settings__account-pro` | `/settings` | 100 / 100 | 100 / 100 | 0.008 / 0.000 | none |
| `settings__signed-out` | `/settings` | 100 / 100 | 100 / 100 | 0.004 / 0.000 | none |
| `sign-in__default` | `/sign-in` | 100 / 100 | 100 / 100 | 0.007 / 0.006 | none |
| `sign-up__default` | `/sign-up` | 100 / 100 | 100 / 100 | 0.007 / 0.005 | none |

What the failed audits are:

- **heading-order** (5 brand states): the hidden heading "Concept 1" is a level 3 directly under a level 1. See A-009.
- **errors-in-console** (all 9 brand conversation states, best practices 96): two requests for competitor icons answer 404. See A-027.
- **label-content-name-mismatch** (Home and Projects with brands; no effect on the score): see A-018.
- **aria-prohibited-attr** (the legacy `/identity` page, accessibility 96): see A-022.

Lighthouse's newer "agentic browsing" category also flags the creative direction cards as a malformed accessibility tree (A-006).

## 4. Findings

### 4.1 App-wide: colour and contrast

**A-001. Text fields, search boxes and drop-downs are outlined at 1.2:1**
- Screen: every form control in the app, 390 and 1440. Sign in, Sign up, password reset, Settings (Full name, Time zone, Date format), Projects search, Library search and filters, the logo "Describe a change" box, the logo version drop-down.
- Category: color
- Severity: P1
- Tag: needs redesign
- WCAG criterion: 1.4.11 Non-text Contrast (AA)
- What's wrong: a field is identified only by its border, and the border token `--border` (`#e4e3df`) measures 1.28:1 on white and 1.19:1 on the page canvas. The stronger token `--border-strong` (`#c9c8c2`) measures 1.67:1 and 1.56:1. The field's fill is the same white as the card around it (1:1), or 1.07:1 on the canvas. The danger button's border is 1.61:1.
- Why it matters: 3:1 is required for the part of a control that shows where it is. People with low vision, and anyone on a dim or sunlit screen, cannot see where to click or type. This also undercuts the "precise" feel in the Direction: fields look like faint boxes.
- Suggested direction: add one token for control outlines that reaches 3:1 on both surfaces, and keep the current hairline for cards and dividers, which do not need it. As a reference point, `#8a8985` measures 3.5:1 on white and 3.26:1 on the canvas. Buttons with a text label are not required to have a 3:1 outline, but secondary buttons (white fill, 1.19:1 border on the canvas) are currently hard to tell from cards, so decide them at the same time.
- Evidence: `a11y/sign-in__default__1440.json` (section `edges`), `a11y/settings__account-pro__1440.json`, `screens/sign-in__default__1440.png`, `screens/settings__account-pro__1440.png`; token values in `src/styles/tokens.css:8-12`, field rule in `src/styles/globals.css:140`.
- Systemic? Yes. One token; every text field, search box and drop-down the probe measured (over 100 across the app), plus every outlined button.

**A-002. Placeholder text is 3.6:1 to 3.9:1**
- Screen: the reply box on every brand page ("Reply in your own words, or ask a question…"), the logo "Describe a change to this logo…" box, and the auth fields ("you@example.com", "Enter your password"), 390 and 1440.
- Category: color
- Severity: P1
- Tag: needs redesign
- WCAG criterion: 1.4.3 Contrast (Minimum) (AA)
- What's wrong: the token `--placeholder` (`#82817b`) measures 3.9:1 on white and 3.64:1 on the canvas. The requirement for text is 4.5:1. The Home prompt and the Library search use the secondary colour instead and pass (5.51:1); the gallery search passes at 4.6:1 with a third colour (`#757575`).
- Why it matters: on the brand page the placeholder is the only visible instruction for the reply box, and on the logo step it is the only visible label for the refine box.
- Suggested direction: one placeholder colour that reaches 4.5:1 on both surfaces (for reference, `#6f6e69` measures 5.1:1 and 4.76:1), used by every field, so the three current placeholder colours become one.
- Evidence: `a11y/brand-conversation__kestrel-complete-pro__1440.json` (section `contrast`), `screens/brand-conversation__kestrel-complete-showcase-pro__1440.png`; `src/styles/tokens.css:8`, `src/styles/globals.css:142`.
- Systemic? Yes. One token.

**A-020. The heart on inspiration tiles is 1.1:1 to 1.8:1 on light images, and hidden until hover**
- Screen: brand conversation, Inspiration gallery, 1440 (and 390, where it cannot be revealed at all).
- Category: color
- Severity: P2
- Tag: needs redesign
- WCAG criterion: 1.4.11 Non-text Contrast (AA)
- What's wrong: each tile's "Like" button is a heart with a white stroke and a 28% ink fill, drawn straight on the artwork. On a white or pale image the stroke measures 1.13:1 and the fill 1.84:1. It is also fully transparent until the pointer is over the tile or the keyboard is on it, and there is no rule for touch screens, where hover does not exist (`src/components/inspiration/inspiration.css:846-863`).
- Why it matters: liking parts of brands is the whole point of this step, and the control for it is invisible by default and faint when shown.
- Suggested direction: give the heart its own small backing (a chip or scrim) so it reaches 3:1 on any artwork, and decide whether it is always visible. The brand-level heart in each card header is already clear (ink on white).
- Evidence: `annotated/A-kbd-inspiration-heart-focus.png`, `annotated/A-kbd-tile-focused.png`.
- Systemic? Yes, about 280 hearts when all 56 brands are shown.

**A-023. A generated brand's own preview can fail contrast**
- Screen: Assets, Design system preview, Orchard Lane Cider, 390 and 1440.
- Category: color (exports)
- Severity: P3
- Tag: execution fix
- WCAG criterion: 1.4.3 Contrast (Minimum) (AA)
- What's wrong: the preview sets the brand name in the brand's Text colour (`#141414`) on its Accent colour (`#c8553d`), which measures 4.23:1 at 13 px. The same card describes Accent as "Highlights and fills, not text".
- Why it matters: the customer copies these pairings into their own site. Embel should not demonstrate a pairing that fails.
- Suggested direction: when the preview puts text on a brand colour, pick the text colour by calculated contrast (dark or light, whichever passes), and consider showing the ratio next to each recommended pairing in the guidelines.
- Evidence: `a11y/brand-assets__orchardlane-ready-free__1440.json`, `screens/brand-assets__orchardlane-ready-free__1440.png`.
- Systemic? Yes, for any generated palette.

### 4.2 App-wide: keyboard and focus

**A-003. Focus is dropped to the top of the document when an action starts or a step changes**
- Screen: Sign in (failed sign-in), Settings (Save changes), Plans (Upgrade, Manage plan), brand conversation (Continue, Change name, Edit answer, Explore six concepts), the out-of-credits prompt (Not now), Settings (closing the Delete account dialog). 1440 and 390.
- Category: flow (keyboard)
- Severity: P1
- Tag: execution fix
- WCAG criterion: 2.4.3 Focus Order (A); also 3.3.1 Error Identification (A) in practice
- What's wrong: after each of these actions the focused element becomes the document body. Three causes were found. Forms disable their fields and button while a request runs (`<fieldset disabled>` in `src/components/auth/sign-in-form.tsx:257`; `disabled={…}` in `src/components/billing/plans-workspace.tsx:323-342` and `src/components/workspace/account-profile-editor.tsx:157`), and a disabled control cannot hold focus. Steps in the conversation replace the pressed button with new content without moving focus to it. And the Delete account dialog is removed before focus can return to its button (`src/components/workspace/account-data-controls.tsx:136-145`).
- Why it matters: a screen-reader user hears nothing where they were and has to find their place again; after a failed sign-in they land outside the form. In Chrome a sighted keyboard user's next Tab continues from roughly the same spot, so the damage is mostly to screen-reader and switch users, but it happens on the main journey many times.
- Suggested direction: keep focus on the pressed control while it works (mark it busy with `aria-disabled` and ignore repeat presses, do not use `disabled`). When a step changes, move focus to the heading of the new step. After an error, move focus to the message or the first field that needs attention. Restore focus to the Delete account button the way the other dialogs already do (`src/components/workspace/project-card-actions.tsx:62-68`).
- Evidence: `a11y/keyboard.json` (scenarios `sign-in-wrong-password`, `settings-offline-save`, `plans-upgrade`, `conversation-kestrel`, `settings-tabs-and-delete-account`, `focus-loss-on-submit`), `annotated/A-kbd-sign-in-error.png`, `annotated/A-kbd-change-name.png`, `annotated/A-kbd-settings-offline-error.png`.
- Systemic? Yes. Good counter-example: the sign-up password mismatch moves focus to the confirm field.

**A-004. Inspiration tiles show no focus ring**
- Screen: brand conversation, Inspiration gallery, 390 and 1440.
- Category: components (keyboard)
- Severity: P1
- Tag: execution fix
- WCAG criterion: 2.4.7 Focus Visible (AA)
- What's wrong: each tile is a button that fills a rounded box with `overflow: hidden` (`src/components/inspiration/inspiration.css:796-800`). The global focus ring is drawn 3 px outside the button, which is outside the box, so it is clipped away. The only change on focus is that the tile's small heart appears, which is a different control.
- Why it matters: these tiles are 40 of the 141 tab stops on a finished brand page (5 per brand, 8 brands shown), and up to 280 when the whole gallery is open. A keyboard user tabbing through them sees nothing move.
- Suggested direction: draw the ring inside the tile (a negative outline offset) or move the clipping to the image. Because tiles are often dark, this needs the two-colour ring in A-005.
- Evidence: `annotated/A-kbd-tile-unfocused.png` and `annotated/A-kbd-tile-focused.png` (same tile, before and during focus); `a11y/keyboard.json` (scenario `tile-focus-crop`).
- Systemic? Yes, every gallery tile on every brand page from the Inspiration step onward.

**A-005. The focus ring is one colour and one of eight offsets**
- Screen: all, 390 and 1440.
- Category: components (keyboard)
- Severity: P2
- Tag: needs redesign
- WCAG criterion: 2.4.7 Focus Visible (AA); 1.4.11 Non-text Contrast (AA)
- What's wrong: the ring is a 2 px ink outline (`src/styles/globals.css:22`). On light surfaces it is excellent (15.4:1 to 17.6:1). On dark artwork it is 1.02:1 to 1.11:1, measured on six gallery tiles. It is also offset by 4, 3, 2, 1, -2, -3, -4 or -6 px depending on the component, so it sits at a different distance on almost every kind of control.
- Why it matters: a ring that disappears on dark images fails exactly where the product is most visual, and the mixed offsets read as imprecision.
- Suggested direction: define the focus ring as a design-system token with two colours (for example ink with a white halo) so it holds 3:1 on any background, and two offsets at most (outside for free-standing controls, inside for controls that fill a clipped box).
- Evidence: `a11y/` (run `node design-audit/tools/a11y-aggregate.mjs focus`), crops in `a11y/focus/`.
- Systemic? Yes.

**A-010. On a finished brand, the reply box is the 141st of 141 tab stops**
- Screen: brand conversation, complete brand (Kestrel Analytics, Orchard Lane Cider), 1440; 142 stops at 390.
- Category: navigation/IA (keyboard)
- Severity: P1
- Tag: needs redesign
- WCAG criterion: 2.4.1 Bypass Blocks (A) is met by the skip link; this is about 2.4.3 Focus Order and plain usability
- What's wrong: the Tab order is: 7 stops in the project bar, the conversation scroll area itself, then every control of every step in page order. The inspiration gallery alone is 97 stops (49 hearts, 40 tiles, 8 brand titles) and sits in the middle of the page for good. The reply box and the Continue link to Assets come last.
- Why it matters: a keyboard user who returns to a brand to type a reply or continue must press Tab about 140 times. This is the keyboard face of finding E-032 in pass 1 (a 5,400 px page with other companies' artwork permanently open).
- Suggested direction: collapse finished steps, including the gallery, so their controls leave the Tab order until reopened; make the current step in the project bar a link that moves focus to that step; and consider a second skip link, "Skip to reply". Treat the gallery as one stop with arrow-key movement inside it.
- Evidence: `a11y/brand-conversation__kestrel-complete-pro__1440.json` (array `walk`).
- Systemic? Yes, every brand from the Inspiration step onward (121 to 142 stops).

**A-011. Menus stay open when focus leaves them**
- Screen: account menu (all pages), project switcher (brand pages), Sort (Projects), "Add files" and "Voice input" on Home. 1440.
- Category: components (keyboard)
- Severity: P2
- Tag: execution fix
- WCAG criterion: 2.4.11 Focus Not Obscured (Minimum) (AA): partly obscured, so it passes the minimum
- What's wrong: these are `<details>` elements that close on Escape and on an outside click only. Tabbing past the last item leaves the panel open over the page; on Projects the open account menu covers part of the search field and a card's options button while focus is on them.
- Why it matters: keyboard users are left with a panel covering what they are working on.
- Suggested direction: close on focus leaving, as the Library menus already do (`src/components/assets/assets-workspace.tsx:58`); ideally one shared menu component.
- Evidence: `annotated/A-kbd-account-menu-left-open.png`, `a11y/keyboard.json` (scenario `account-menu`); code in `src/components/workspace/app-shell.tsx:179`, `src/components/journey/project-capsule.tsx:140-158`, `src/components/workspace/projects-workspace.tsx:50-66`.
- Systemic? Yes, five menus.

**A-012. Text areas that remove the standard ring have a weak replacement, or none**
- Screen: Home prompt (all states), brand reply box, the "own slogan" field in the Voice step. 390 and 1440.
- Category: components (keyboard)
- Severity: P2
- Tag: execution fix
- WCAG criterion: 1.4.11 Non-text Contrast (AA); 2.4.7 Focus Visible (AA) for the slogan field
- What's wrong: the Home prompt's only focus cue is its border changing from `#e4e3df` to `#aaa9a5`, which measures 2.35:1 on white; the shadow does not change (`src/styles/home-concept.css:60-63`). The brand reply box uses a 1 px ring at 3.36:1, which passes narrowly. The "own slogan" input sets `outline: none` with no replacement at all (`src/styles/journey-conversation.css:581-590`; found in code, not reachable in the seeded data without credits).
- Why it matters: the Home prompt is the first thing anyone uses. The text cursor does show, so this is not a hard failure there, but the frame barely reacts.
- Suggested direction: give every text entry area the standard ring on `:focus-within`, as the gallery search already does (`src/components/inspiration/inspiration.css:158-160`).
- Evidence: `annotated/A-kbd-home-composer-focus.png`, `screens/home__signed-out-prompt-focus__1440.png`, `a11y/keyboard.json` (scenario `home-signed-out-overlay`).
- Systemic? Three components.

**A-021. Some targets are under 24 px tall and many are under the app's own 44 px rule**
- Screen: Assets ("Edit" links 23 x 19.5 px, "Font link" 63 x 19.5), Library (brand links 20 px tall), auth ("Return to Home" 20 px tall), gallery brand titles (23 px tall), gallery hearts (30 x 30 and 36 x 36), the choice checkboxes and radios (18 x 18 inside a large label). 390 and 1440.
- Category: components
- Severity: P3
- Tag: execution fix
- WCAG criterion: 2.5.8 Target Size (Minimum) (AA) passes, through its spacing exception
- What's wrong: no target fails the 24 px rule once spacing is counted, but 35 of 49 targets on Assets and 26 to 39 of about 100 on a brand page are smaller than 44 px in one direction, while buttons are a consistent 44 px. On Sign in, the 44 px box of "Forgot password?" overlaps the top 4 px of the password field, so its focus ring cuts into the field.
- Why it matters: small text links next to 44 px buttons are harder to hit and look unfinished; on touch widths they are below the usual 44 px guidance.
- Suggested direction: give text links a consistent minimum height in the design system and lay out "Forgot password?" so its box does not overlap the field.
- Evidence: run `node design-audit/tools/a11y-aggregate.mjs targets`; `a11y/sign-in__default__1440.json` (array `walk`, stops 9 to 11).
- Systemic? Yes (text links).

### 4.3 App-wide: names, roles and structure

**A-006. Creative direction cards are not real controls**
- Screen: brand conversation, Creative direction (Mosswood, Orchard Lane, Kestrel), 390 and 1440.
- Category: components (semantics)
- Severity: P1
- Tag: needs redesign
- WCAG criterion: 4.1.2 Name, Role, Value (A); 1.3.1 Info and Relationships (A)
- What's wrong: each card is an `<article role="radio">` with `tabindex="0"`, containing a heading, a palette and a real "View larger" button (`src/components/visual-directions/visual-directions-view.tsx:234-254`). There is no radio group around them, all three are separate tab stops, the arrow keys do nothing, and a control nested inside a radio is hidden from or confusing to assistive technology. axe reports it as "nested-interactive" (serious) and Lighthouse as a malformed accessibility tree. The code handles Enter and Space on a card; they were not pressed in this pass, to avoid changing the saved choice.
- Why it matters: this is the most consequential choice in the product. Pass 1 found the same cards have no visible "Choose" control and no hover state (E-051); the hidden structure has the same gap.
- Suggested direction: decide the selection control together with E-051. The simplest correct build is a plain card with a real "Choose this direction" button (pressed or not pressed) next to "View larger". If it stays a radio group, use real radio inputs with the card as their label, inside a named group.
- Evidence: `a11y/brand-conversation__kestrel-complete-pro__1440.json` (section `axe`), `a11y/keyboard.json` (key `directionCards`), `lighthouse/brand-conversation__kestrel-complete-pro__desktop/report.html`, `annotated/A-kbd-direction-card-focus.png`.
- Systemic? Three cards on every brand from the Creative direction step.

**A-007. Logo concepts are `div`s with a button role**
- Screen: brand conversation, Logo step, 390 and 1440.
- Category: components (semantics)
- Severity: P2
- Tag: execution fix
- WCAG criterion: 4.1.2 Name, Role, Value (A)
- What's wrong: each concept is a `<div role="button" tabindex="0" aria-pressed>` (`src/components/logo-creation/concept-grid.tsx:297-310`); the label and pressed state are also written when the role is absent. Each card also carries zero-size "Select concept" and "Compare concept" buttons that are not reachable, so comparing concepts has no keyboard path at all (see E-051).
- Why it matters: a `div` button needs every key and state rebuilt by hand, and gets none of the browser's behaviour for free.
- Suggested direction: a real `<button aria-pressed>` around the preview; remove the hidden duplicates or make Compare a visible control.
- Evidence: `a11y/keyboard.json` (key `logoConcepts`).
- Systemic? Six cards per brand.

**A-008. The whole conversation is one live region**
- Screen: brand conversation, every stage, 390 and 1440.
- Category: components (semantics)
- Severity: P1
- Tag: execution fix
- WCAG criterion: 4.1.3 Status Messages (AA); 1.3.1 Info and Relationships (A)
- What's wrong: the scrolling area for the entire journey is `role="log" aria-live="polite"` (`src/components/workspace/account-guided-interview.tsx:1198-1206`). On Kestrel it wraps 764 elements, 57 images and 6 further status regions, including the gallery, the logo grid and the direction boards. It is also a tab stop named "Conversation".
- Why it matters: a live region tells a screen reader to read out whatever changes inside it. Liking a tile, loading an image caption or a counter changing are all candidates, so the user may be flooded, or the screen reader may give up and announce nothing, including the messages that matter ("6 of 6 concepts ready"). This was reasoned from the markup; it was not heard in a screen reader (see section 9).
- Suggested direction: limit the log to the message transcript, or drop it and rely on the small status regions that already exist next to each widget.
- Evidence: `a11y/keyboard.json` (key `liveLog`).
- Systemic? Every brand page.

**A-009. Brand pages have no usable title or main heading**
- Screen: brand conversation and Assets, all stages; the 404 page. 390 and 1440.
- Category: hierarchy (semantics)
- Severity: P2
- Tag: execution fix
- WCAG criterion: 2.4.2 Page Titled (A); 2.4.6 Headings and Labels (AA); 1.3.1 Info and Relationships (A)
- What's wrong: (1) The browser tab is always "Strategy · Embel", whichever brand is open and whichever step is active (`src/app/brands/account/[projectId]/page.tsx:9`); Assets is always "Brand assets · Embel". With three brands open, the tabs are identical. (2) Early stages have no level 1 heading; later stages have two hidden ones, "Logo" and "Creative direction", in the middle of the page (`logo-creation-workspace.tsx:1008`, `visual-directions-view.tsx:124`). (3) "Concept 1" to "Concept 6" are level 3 headings directly under a level 1, which Lighthouse flags. (4) A region named "Strategy" contains another region named "Strategy", and the reply box's region is called "Strategy composer" on every step. (5) The 404 page's tab reads "Embel — Brand workspace" once the page has loaded, on both builds, although the server sends "Page not found · Embel".
- Why it matters: titles and headings are how screen-reader users, and anyone with several tabs, find their place.
- Suggested direction: title brand pages "<Brand name> · <Step> · Embel"; one level 1 heading per page, the brand name; steps as level 2; fix the 404 title.
- Evidence: run `node design-audit/tools/a11y-aggregate.mjs doc`; `lighthouse/brand-conversation__quill-logos-generated-free__desktop/report.html`.
- Systemic? Every brand page.

**A-016. At 200% zoom the journey steps lose their names**
- Screen: project bar on brand pages at widths of 760 px and below, which includes 200% zoom on a 1440 px window.
- Category: navigation/IA (semantics)
- Severity: P1
- Tag: execution fix
- WCAG criterion: 2.4.4 Link Purpose (In Context) (A); 4.1.2 Name, Role, Value (A)
- What's wrong: below 760 px the step labels are hidden with `display: none` (`src/components/journey/journey.module.css:382-385`), which also removes them from the links' names. The Tab walk at 390 px recorded the links as ", complete" and ", complete". Visually they become bare tick circles.
- Why it matters: a zoomed or small-screen user sees ticks with no words, and a screen-reader user hears "comma complete, link" twice.
- Suggested direction: hide the labels visually only (the app's `.sr-only` pattern) or give the links an `aria-label`; and decide in the redesign whether ticks alone are enough for sighted users (see A-015).
- Evidence: `a11y/brand-conversation__kestrel-complete-pro__390.json` (array `walk`, stops 4 and 5), `a11y/reflow/brand-conversation__kestrel-complete-pro__zoom200.png`.
- Systemic? Every brand page.

**A-017. The out-of-credits prompt is awkward for keyboard and screen-reader users**
- Screen: any brand page as audit-free, after pressing an AI button; 1440.
- Category: components (semantics)
- Severity: P2
- Tag: execution fix
- WCAG criterion: 4.1.3 Status Messages (AA)
- What's wrong: the prompt is an `<aside role="status">` inserted together with its text, which many screen readers do not announce; it holds two controls inside the status region; it is fixed to the bottom right, where it covers the end of the inline message and the corner of the reply box; Escape does not close it; and focus is on the body both when it appears and after "Not now". It sits last in the page, three stops after the button that triggered it.
- Why it matters: this is the moment the product asks for money. Pass 1 (E-037) found three overlapping messages here; the mechanics are just as loose.
- Suggested direction: once E-037 settles on one message, either make it a small dialog that takes focus and closes on Escape, or keep it inline next to the button with a permanent, empty status region that the text is written into.
- Evidence: `src/components/billing/out-of-credits-prompt.tsx:15-31`; checked by hand in the Browser pane (prompt position 620, 587, size 380 x 157; first control is tab stop 131 of 132).
- Systemic? One component, reachable from every AI button.

**A-018. Project cards announce a different name from the one shown**
- Screen: Home and Projects with brands, 390 and 1440.
- Category: components (semantics)
- Severity: P3
- Tag: execution fix
- WCAG criterion: 2.5.3 Label in Name (A); Lighthouse `label-content-name-mismatch`
- What's wrong: the card link's `aria-label` is "View brand kit · Bright Harbor Learning", while the card shows "Bright Harbor Learning", "Today", "View brand kit" (`src/components/workspace/project-card.tsx:183`). The words are present but reordered, and the date is dropped.
- Why it matters: people who use voice control say what they see; names that start with the visible text work best.
- Suggested direction: drop the `aria-label` and let the visible text be the name, or start the label with the brand name.
- Evidence: `lighthouse/projects__eight-brands-free__desktop/report.html`.
- Systemic? Every project card.

**A-019. Like and Favourite buttons state their condition twice**
- Screen: gallery hearts, name favourites, Library like and save. Code.
- Category: components (semantics)
- Severity: P3
- Tag: execution fix
- WCAG criterion: 4.1.2 Name, Role, Value (A)
- What's wrong: the label flips ("Like" to "Unlike") and `aria-pressed` flips too, so a liked item is announced as "Unlike X, pressed" (`src/components/inspiration/inspiration-brands.tsx:61-74`, `src/components/naming/naming-inspect.tsx:85-86`, `src/components/assets/assets-workspace.tsx:315-336`).
- Suggested direction: a fixed label ("Like X") with `aria-pressed`, as the password toggle already does.
- Evidence: accessibility tree in section 6 ("Unlike the whole Archi-Tex brand, pressed").
- Systemic? Three components.

**A-022. The legacy Identity page uses a label where none is allowed**
- Screen: `/brands/account/<id>/identity`, 390 and 1440.
- Category: components (semantics)
- Severity: P3
- Tag: execution fix
- WCAG criterion: 4.1.2 Name, Role, Value (A); Lighthouse accessibility 96
- What's wrong: `<div class="identity-reference-indicators" aria-label="Saved choices for …">` has no role, so the label is ignored. Pass 1 lists this page as orphaned.
- Suggested direction: remove the page if it is retired; otherwise give the element `role="group"`.
- Evidence: `lighthouse/brand-identity__kestrel-pro__desktop/report.html`.
- Systemic? No.

### 4.4 Forms and errors

**A-013. Sign-in, sign-up and reset errors are not tied to their fields**
- Screen: `/sign-in`, `/sign-up`, `/reset-password`, and the same forms in the overlay. 390 and 1440.
- Category: flow (forms)
- Severity: P2
- Tag: execution fix
- WCAG criterion: 3.3.1 Error Identification (A) is met (the message is an alert, 6.66:1); this is about 3.3.3 Error Suggestion (AA) and good practice
- What's wrong: there is one message under the form. No field is marked invalid (`aria-invalid` is never set). After a wrong password the password is emptied and focus is lost (A-003). After a password mismatch on sign-up both password fields are emptied, focus goes to the confirm field, and the message is linked to the first password field only.
- Why it matters: a person who mistyped one character must retype everything, and a screen-reader user is not told which field was wrong.
- Suggested direction: mark the field, link the message to it, keep what was typed where security allows (at least the first password on a mismatch), and move focus to the field to fix.
- Evidence: `a11y/keyboard.json` (scenarios `sign-in-wrong-password`, `sign-up-validation`), `annotated/A-kbd-sign-in-error.png`, `annotated/A-kbd-sign-up-mismatch.png`; `src/components/auth/sign-in-form.tsx:95-107, 371-375`.
- Systemic? Three forms.

### 4.5 Zoom and reflow

**A-014. Plans does not reflow: three columns at every width**
- Screen: `/plans`, all accounts, at 320 px (the same as 400% zoom on a 1280 px window) and at 390 px.
- Category: responsiveness
- Severity: P1
- Tag: needs redesign
- WCAG criterion: 1.4.10 Reflow (AA)
- What's wrong: the plan grid is `grid-template-columns: repeat(3, minmax(0, 1fr))` and the stylesheet has no narrow-width rule at all (`src/styles/plans.css:53-60`). At 320 px each card is about 75 px wide: "$7.99" and "$27.99" are cut off, "Current plan" overlaps the plan name, and the feature list wraps one word per line. The summary card above it breaks the renewal sentence into seven lines. At 200% zoom (720 px) the page is fine.
- Why it matters: this is the page where people decide to pay, and at high zoom or on a phone the prices cannot be read. Pass 1 found the phone-width breakage (E-026); this adds that it is also a zoom failure on desktop.
- Suggested direction: stack the plans in one column below a chosen width, current plan first; the layout is a design decision for E-025 and E-026.
- Evidence: `a11y/reflow/plans__pro-current-pro__320.png`, `a11y/reflow/plans__pro-current-pro__zoom200.png`.
- Systemic? No, one page.

**A-015. At 200% zoom the project bar and reply box take 42% of the window**
- Screen: brand conversation and Assets at 720 x 450 px (a 1440 x 900 window at 200%) and at 320 x 640.
- Category: layout (zoom)
- Severity: P2
- Tag: needs redesign
- WCAG criterion: 1.4.10 Reflow (AA) is met (no sideways scrolling); advisory for 1.4.4 Resize Text and 2.4.11 Focus Not Obscured
- What's wrong: below 900 px the project bar wraps to two rows and becomes 124 px tall; the reply box is 54 px plus its margins. At 720 x 450 that leaves 259 px, 58% of the height, for the brand's own content. At 320 x 640 the bar is about 160 px. Every other page reflows cleanly at both sizes: no route scrolled sideways.
- Why it matters: people who zoom see their work through a narrow slot, on the pages where the work is the point.
- Suggested direction: a compact single-row project bar at narrow widths (brand name and current step, the rest in a menu), and let the bar scroll away or shrink while reading.
- Evidence: `annotated/A-kbd-zoom200-conversation.png`, `a11y/reflow/brand-conversation__kestrel-complete-pro__zoom200.png`, `a11y/reflow/brand-assets__kestrel-ready-pro__320.png`, `a11y/keyboard.json` (scenario `zoom-200-chrome`).
- Systemic? Every brand page.

### 4.6 Performance and delivery (production build)

**A-024. The brand conversation jumps while it loads**
- Screen: brand conversation, Kestrel Analytics (complete), production build.
- Category: performance
- Severity: P1
- Tag: execution fix
- Lighthouse/trace metric: CLS 0.18 on desktop (good is 0.1 or less) and 0.75 under phone conditions (poor is above 0.25); LCP 409 ms on desktop and 9.3 s under phone conditions (good is 2.5 s or less)
- What's wrong: the trace lists the movers. The project bar resizes twice as the session loads (0.015). The gallery's cards and footer move as images arrive (0.07). Then the whole Identity section shifts as the page scrolls itself to the current step (0.087). Under phone conditions the same sequence is spread over two seconds and scores 0.75. The largest element painted is a lazy-loaded typography image from another company's brand in the gallery, requested 351 ms in, with no priority hint; under phone conditions the browser waits 6.9 s before it even asks for it. Nine images on the page have no width and height.
- Why it matters: this is the page people work in. It is the measured side of pass 1's E-052 (a brand reopens at an unpredictable place) and pass 2's loading findings.
- Suggested direction: reserve the final size of the project bar, gallery cards, logo grid and direction boards before their content arrives; land on the current step without a visible scroll; give every image its dimensions; and do not let another brand's gallery image be the first large thing painted (collapsing finished steps, as in A-010, solves this too).
- Evidence: `traces/brand-conversation__kestrel__desktop__load.json.gz`, `traces/brand-conversation__kestrel__mobile-slow4g-cpu4x__load.json.gz`.
- Systemic? Every brand from the Inspiration step (Lighthouse recorded 0.76 to 1.11 on five of them on the development server).

**A-025. The Assets page shifts by more than half a screen**
- Screen: Assets, Kestrel Analytics, production build.
- Category: performance
- Severity: P1
- Tag: execution fix
- Lighthouse/trace metric: CLS 0.55 on desktop, 0.06 under phone conditions; LCP 1.2 s on desktop, 9.3 s under phone conditions
- What's wrong: on desktop the first card moves by 0.42 when "Preparing…" placeholders are replaced by the built previews 1.2 s in, after the page frame has already moved by 0.12. Under phone conditions nothing meaningful is painted for 8.8 s, because the page shows no content until its scripts have run and its data has arrived.
- Why it matters: this is the page where the customer receives what they paid for; it should arrive calmly.
- Suggested direction: give the brand board and each social image a box of its final proportions from the first paint, so previews fade into place; show the page's text (headings, descriptions, download buttons in a waiting state) before the images are built.
- Evidence: `traces/brand-assets__kestrel__desktop__load.json.gz`, `traces/brand-assets__kestrel__mobile-slow4g-cpu4x__load.json.gz`.
- Systemic? Every complete brand.

**A-026. Signed-in pages are heavier and less cacheable than they need to be**
- Screen: all signed-in pages; measured on the Kestrel conversation, production build.
- Category: performance
- Severity: P2
- Tag: execution fix
- Lighthouse/trace metric: render-blocking requests (estimated 4.3 to 6.9 s to first paint under phone conditions); 147 requests; 1.76 MB of script and 292 KB of CSS before compression
- What's wrong: (1) Eight CSS files block the first paint on a brand page (13 are loaded in all). (2) The page makes 49 API requests, 1.2 MB, most of them private image previews fetched one by one and turned into `blob:` images, which the browser cannot cache between visits. (3) Gallery images under `/inspiration/` are sent with `Cache-Control: public, max-age=0`, so the browser re-checks every one on every visit; the folder is 24 MB. (4) As the inventory found, images are sent at full size and scaled down in CSS (1024 px logos shown at 38 px; 1.1 to 1.3 MB direction boards shown at 237 px). (5) The trace notes 12.5 KB of unnecessary older-browser code.
- Why it matters: on a laptop with a good connection none of this is felt (LCP 141 ms to 1.2 s). On a phone or a weak connection the brand pages take about 9 s.
- Suggested direction: serve thumbnails at display size; give gallery images long-lived cache headers and fingerprinted names; let the browser cache private previews for the session; combine or defer the CSS that the first screen does not need.
- Evidence: the two brand-conversation traces (insights "RenderBlocking", "LCPDiscovery"), `assets/assets.md` from pass 0.
- Systemic? Yes.

**A-027. Every brand page logs two errors for missing competitor icons**
- Screen: brand conversation, every stage.
- Category: performance (best practices)
- Severity: P3
- Tag: execution fix
- Lighthouse/trace metric: `errors-in-console`; best practices 96 on all nine brand states
- What's wrong: `GET /api/projects/<id>/competitor-icon?host=…` answers 404 when a competitor has no icon, and the browser logs each as an error. The seeded competitors use `example.com` addresses, so here they always fail; a real site without an icon would do the same.
- Suggested direction: answer "no icon" without an error status (for example 204), or decide on the server and send no request.
- Evidence: `lighthouse/brand-conversation__spokesmith-research-done-free__desktop/report.html`.
- Systemic? Every brand page.

### 4.7 Code-level findings (web-design-guidelines review)

These were found by reading the source; the first is important enough to stand alone. Line numbers are as of 2026-11-11; the component or selector name is given so each can be found again after the code is restructured.

**A-028. Dates on cards ignore the account's date preference**
- Screen: project cards, Projects list, Plans, credit messages. Code; not checked against each preference in the browser.
- Category: consistency
- Severity: P2
- Tag: execution fix
- What's wrong: Settings lets a person choose a time zone and a date format, and `BrowserLocalDate` honours them (`src/components/workspace/browser-local-date.tsx:20-24`). `shortDate` in `project-card.tsx:21`, `dateLabel` in `projects-workspace.tsx:39-45`, `formatDate` in `plans-workspace.tsx:26` and `creditsMessage` in `credits-message.ts:7` pin the locale to English and ignore both. Relative times ("3 hours ago") are built by hand. The card's tooltip shows the raw machine timestamp (`project-card.tsx:152, 168`).
- Why it matters: a setting that only some screens respect looks broken, and Plans is where the renewal date matters most.
- Suggested direction: one shared date formatter that takes the account preference, used everywhere.
- Evidence: source lines above.
- Systemic? Four functions.

**A-029. Invalid or duplicated markup in three places**
- Category: components (code) · Severity: P3 · Tag: execution fix · WCAG criterion: 4.1.2 Name, Role, Value (A); 1.3.1 Info and Relationships (A)
- What's wrong: (1) When a gallery image fails, `BrandImage` renders a "Retry image" button inside the "Open brand" button (`src/components/inspiration/inspiration-brands.tsx:92-100, 173-180`); a button inside a button is invalid. (2) The colour tokens list on Assets is a table built from `div`s with table roles, no header cells, and one cell hidden (`src/features/brand-assets/components/assets-journey.tsx:470-475`). (3) `AccountAccess` is mounted twice on Settings, so the ids `sign-out-title` and `sign-out-description` exist twice (`src/components/workspace/account-access.tsx:122-133`); axe also flagged duplicate ids there for review.
- Suggested direction: retry control beside the open button; a real `<table>` or a description list; ids from `useId()`.

**A-030. Form details**
- Category: components (code) · Severity: P3 · Tag: execution fix
- What's wrong: (1) Several inputs have no `name` (Chrome reports six on a brand page): the brief editor, both search boxes, the delete-account confirmation, the reply box. (2) Settings puts "Loading…" and "Unavailable" into the Full name and Email inputs as their value, and the email field is `type="text"` (`account-profile-editor.tsx:61-72`). (3) Disabled buttons give no reason: the Usage "Refresh" button while loading (`recorded-usage.tsx:220-234`), plan buttons before the plan has loaded (`plans-workspace.tsx:313-318`), a permanently disabled "Check request" button (`concept-grid.tsx:469-479`). Disabled button text measures 1.92:1, which WCAG exempts, so the reason matters more. (4) The Usage table has no caption or name. (5) Placeholders repeat the label instead of giving an example.
- Suggested direction: names and `autocomplete` on every field; status lines instead of values; a visible "Refreshing…" or "Checking your plan…".

**A-031. Tabs, filters and sort are lost on reload**
- Category: navigation/IA (code) · Severity: P3 · Tag: execution fix
- What's wrong: the Settings tab, the Library tab, filters and search, and the Projects search and sort are held in memory only (`settings-workspace.tsx:20`, `assets-workspace.tsx:65, 116`, `projects-workspace.tsx:78-79`). Reload, Back and shared links reset them. Only `?state=deleted` is in the address. A comment in Settings suggests always opening on Account is deliberate; confirm before changing that one.
- Suggested direction: mirror them in the address.

**A-032. Scrolling dialogs can hide focus under their own sticky header**
- Category: components (code) · Severity: P3 · Tag: execution fix · WCAG criterion: 2.4.11 Focus Not Obscured (Minimum) (AA), not confirmed in the browser
- What's wrong: the detail sheets and the name dialog have a sticky header and no `scroll-padding-top` (`src/components/ui/context-details.module.css:43-54`, `src/components/naming/naming-inspect.module.css:25-35`), so Shift+Tab can land under the header. Three scrolling dialogs lack `overscroll-behavior: contain`. In the direction "larger view" the dialog itself becomes a tab stop because it scrolls (measured: 860 x 860 px in a 900 px window).
- Suggested direction: scroll padding equal to the header height; contain overscroll.

**A-033. Small polish items**
- Category: copy and typography (code) · Severity: P3 · Tag: execution fix
- What's wrong: straight apostrophes in about 20 strings while the rest of the app uses curly ones ("You're signed in", "We couldn't sign you in…"); no `text-wrap: balance` on headings; no `translate="no"` on the Embel wordmark or generated brand names, so browser translation can alter them; no `touch-action: manipulation` on controls; a dead `.brief-composer` rule in `globals.css:69-74`; "New project" and "Home" in the project menu go to the same place (`project-capsule.tsx:173-181`); the gallery overlay's image counter does not announce when the image changes (`inspiration-brands.tsx:283-313`).

**A-034. The exported token file lists the four colours twice**
- Screen: Assets, Design system, Export (CSS), Kestrel Analytics.
- Category: exports · Severity: P3 · Tag: execution fix
- What's wrong: the CSS shown and downloaded begins with `--color-primary`, `--color-accent`, `--color-background`, `--color-text` and then repeats the same four lines.
- Why it matters: this file is a deliverable; a duplicated block reads as carelessness to exactly the agency audience in the Direction.
- Evidence: page text on the production build, 2026-11-12; `exports/kestrel/` from pass 0 has the downloaded file.

### 4.8 Confirmed from earlier passes (no new ID)

- **E-050, Library "Open …" does nothing:** the same with the keyboard. Enter on "Open Brand board from Bright Harbor Learning" opens no dialog and focus stays on the button (`a11y/keyboard.json`, scenario `library-details`).
- **E-051, no way to compare concepts:** the Compare buttons exist with zero size and cannot be reached by keyboard either.
- **E-037, three messages when credits run out:** seen again ("Not ready yet.", "You've used this month's credits…" with Try again, and the prompt).
- **A misleading message while the Logo step prepares (new observation, for the merge to place with E-037 or pass 2's loading findings):** for about two seconds after Continue on Fromagerie Bérénice Côté, the step shows every logo type unticked, "Choose at least one type", "Preparing saved inputs…" and "Enter a brand name before generating.", although the brand has a name and six types are saved. It then corrects itself to "6 types chosen". Evidence: `annotated/A-kbd-logo-step-preparing.png`.
- **Pass 0 note, text typed in the first seconds on Sign in can be lost:** not reproduced with the keyboard. In the Browser pane a click on the Email field put focus on the page instead of the field twice; tabbing to it worked every time. This looks like the pane, not the app.

## 5. Contrast measurements

All values are computed colours, composited over their real backgrounds, at 390 and 1440 px. 102 distinct text colour pairs were found; 5 fail, all listed.

| Element | Foreground | Background | Ratio | Required | Result |
| --- | --- | --- | --- | --- | --- |
| Body text, headings | `#191919` | `#f7f7f5` / `#ffffff` | 16.39 / 17.58 | 4.5 | pass |
| Secondary text (captions, hints, labels) | `#696965` | `#ffffff` | 5.51 | 4.5 | pass |
| Secondary text on the canvas | `#696965` | `#f7f7f5` | 5.13 | 4.5 | pass |
| Secondary text on the surface colour (the narrowest pass) | `#696965` | `#f1f0ee` | 4.84 | 4.5 | pass |
| Status "Saved", "Chosen", "Complete" | `#3d6448` | `#f7f7f5` to `#ffffff` | 6.28 to 6.74 | 4.5 | pass |
| Error text (form error) | `#a02929` | `#fff0ee` | 6.66 | 4.5 | pass |
| Error text (alerts) | `#a42a2a` | `#faeeee` / `#f7f7f5` | 6.29 / 6.65 | 4.5 | pass |
| Warning text | `#6b4617` | `#fff8e9` | 7.89 | 4.5 | pass |
| Primary button, active nav item | `#ffffff` | `#191919` | 17.58 | 4.5 | pass |
| Hover: secondary button | `#696965` | `#f7f7f5` | 5.13 | 4.5 | pass |
| Hover: danger button | `#a42a2a` | `#faeeee` | 6.29 | 4.5 | pass |
| Gallery search placeholder | `#757575` | `#ffffff` | 4.6 | 4.5 | pass |
| **Placeholder (reply box, auth fields)** | `#82817b` | `#ffffff` | **3.9** | 4.5 | **fail** (A-002) |
| **Placeholder (logo refine box)** | `#82817b` | `#f7f7f5` | **3.64** | 4.5 | **fail** (A-002) |
| **Brand name on Accent, Orchard Lane preview** | `#141414` | `#c8553d` | **4.23** | 4.5 | **fail** (A-023) |
| Disabled button text (exempt) | `#b0afac` | `#f1f0ee` | 1.92 | none | exempt |
| **Field border on white** | `#e4e3df` | `#ffffff` | **1.28** | 3 | **fail** (A-001) |
| **Field border on canvas** | `#e4e3df` | `#f7f7f5` | **1.19** | 3 | **fail** (A-001) |
| **Stronger border token** | `#c9c8c2` | `#ffffff` / `#f7f7f5` | **1.67 / 1.56** | 3 | **fail if used for fields** |
| **Danger button border** | `#e5c4c4` | `#ffffff` | **1.61** | 3 (text label carries it) | advisory |
| Error border | `#b54b4b` | `#ffffff` | 5.15 | 3 | pass |
| Focus ring on light surfaces | `#191919` | `#f1f0ee` to `#ffffff` | 15.43 to 17.58 | 3 | pass |
| **Focus ring on dark gallery tiles** | `#191919` | `#121212`, `#1e1e1e`, `#14173d`, `#030436` | **1.02 to 1.11** | 3 | **fail** (A-005) |
| **Home prompt focus border** | `#aaa9a5` | `#ffffff` | **2.35** | 3 | **fail** (A-012) |
| Reply box focus ring | `#8d8c88` | `#ffffff` | 3.36 | 3 | pass |
| **Tile heart: stroke on a light tile / fill on white** | `#ffffff` / ink at 28% | `#f1f0ee` / `#ffffff` | **1.13 / 1.84** | 3 | **fail** (A-020) |

Icons take the colour of the text next to them, so they pass wherever that text passes. There is no dark mode to check.

## 6. Keyboard and screen-reader structure

### Keyboard walk of the main flows

| Flow | Result |
| --- | --- |
| Skip link | First tab stop on every page, visible when focused, moves focus to `main`; the next Tab goes to the first control in the content. |
| Sign in (page) | Works by keyboard alone. Order: Email, Password, Show password, Forgot password?, Sign in. "Forgot password?" sits above the password field but comes after it (A-021). After a successful sign-in the app opens Projects with focus on the body; the page change is announced ("Projects."). After a failed one, focus is lost (A-003). |
| Sign in (overlay from Home) | Opens as a modal dialog named "Sign in to Embel"; focus starts on Close; Tab cycles through its 9 controls and does not leave; Escape closes it; focus returns to the prompt and the typed brief is kept. |
| Sign up | Password guidance is linked to the field; the mismatch message is an alert and focus moves to the confirm field (A-013). |
| Projects | Card options: Enter opens a menu named "Actions for <brand>", focus moves to Delete, Escape closes and returns focus. Delete dialog: named, described, focus starts on Cancel (the safe choice), stays inside, Escape returns focus to the options button. |
| Account menu | Opens with Enter, Escape closes and returns focus; stays open when tabbed out of (A-011). |
| Settings | Tabs: one tab stop, arrow keys move and select, the panel is labelled by its tab. Delete account dialog: focus starts in the confirmation field, stays inside; Escape closes but focus is lost (A-003). Offline save: the error is an alert (6.29:1); focus is lost. |
| Brand conversation | 121 to 142 tab stops; reply box and Continue last (A-010). Tiles show no ring (A-004). Direction "larger view": named dialog, focus on Close, Escape returns focus to the button. Gallery brand view: named dialog, 14 controls, focus stays inside, Escape returns focus to the tile. "Change name" opens the name choices in the page and loses focus (A-003). |
| Logo step, no credits | "Explore six concepts" shows the out-of-credits prompt; focus is lost; Escape does not close it (A-017). |
| Assets | 49 tab stops, all with a visible ring; section links are a labelled navigation. A status region sits beside the "Copy" buttons; what it announces was not verified. |
| Plans | Upgrade answers with an alert ("Payments are unavailable right now…") and loses focus (A-003). |
| Library | Tabs behave like Settings. "Open …" does nothing (E-050). |

### What a screen reader is given (from the accessibility tree; no screen reader was run)

- Every page: a banner with "Main navigation" or "Brand journey", one `main`, a level 1 heading on all pages except brand pages (A-009), and a live region that announces page changes.
- Brand page: the journey steps read "Strategy, complete", "Voice, complete", "Identity", "Assets, next step" at full width. The current step is plain text, not a link. The conversation is a log region (A-008).
- Direction cards read as "radio, Direction 1: Editorial Soft Shapes, checked" with a button inside (A-006). Logo concepts read as "button, Select concept 1, pressed".
- Images: 0 of 696 lack an `alt`; decorative artwork is `alt=""`; generated images have descriptive text such as "Kestrel Analytics final brand board".

## 7. Performance traces (production build)

Three routes: signed-out Home (the only landing page), the brand conversation (where people work), and Assets (where they collect the result). "Phone conditions" means a 390 px viewport, a processor slowed 4 times and the "Slow 4G" network profile. INP comes from a separate trace with real clicks and typing, with the processor slowed 4 times.

| Route | Conditions | LCP | CLS | INP | Notes |
| --- | --- | --- | --- | --- | --- |
| Home, signed out | desktop | 141 ms | 0.00 | 67 ms | Text LCP; nothing blocks. |
| Home, signed out | phone conditions | 2.4 s | 0.00 | | Just inside "good". 1.9 s of it is waiting for CSS. |
| Brand conversation (Kestrel) | desktop | 409 ms | **0.18** | 140 ms | LCP is another brand's gallery image, lazy-loaded (A-024). |
| Brand conversation (Kestrel) | phone conditions | **9.3 s** | **0.75** | | 6.9 s before the LCP image is requested. |
| Assets (Kestrel) | desktop | 1.2 s | **0.55** | 42 ms | Previews replace "Preparing…" at 1.2 s (A-025). |
| Assets (Kestrel) | phone conditions | **9.3 s** | 0.06 | | 8.8 s with nothing meaningful painted. |

Interactions measured for INP: opening and closing the account menu, switching gallery category, opening and closing a direction's larger view, typing in the reply box (conversation); a starter chip, typing, the attach popover, the sign-in overlay (Home); switching CSS and JSON, copying a colour, jumping to a section, the project switcher (Assets). All were well inside the 200 ms limit.

Insights the traces offered, in order of value: reserve space to stop layout shift (A-024, A-025); make the LCP image discoverable and not lazy (A-024); reduce render-blocking CSS (A-026); image delivery (A-026); forced reflows during load on the conversation (JavaScript measuring layout right after changing it; small); 12.5 KB of unneeded older-browser code. Response headers are sound: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, a referrer policy and a permissions policy are set, and build files are cached for a year. A Content-Security-Policy header was not present on the local production build.

## 8. WCAG 2.2 criteria checked explicitly

| Criterion | Result | Detail |
| --- | --- | --- |
| 2.4.11 Focus Not Obscured (Minimum), AA | **Pass, with two risks** | In 84 Tab walks no focused control was fully covered by the floating bar or the reply box; the conversation scrolls focused items clear of both. Risks: menus left open cover part of what is focused (A-011); sticky headers inside scrolling dialogs (A-032, from code). |
| 2.5.7 Dragging Movements, AA | **Pass** | Nothing needs dragging. The two sliders (name length, and one in the strategy review) are native range inputs, which work with arrow keys and clicks. Uploads use a file picker. |
| 2.5.8 Target Size (Minimum), AA | **Pass** | No target fails once the spacing exception is applied; the smallest are 18 x 18 px native checkboxes inside large labels and 19.5 px tall text links (A-021). |
| 3.2.6 Consistent Help, A | **Pass (nothing to be inconsistent)** | The app has no help link, contact detail or chat on any page, so the rule has nothing to test. Pass 1 (E-011) reports the absence itself. If help is added, it must sit in the same place on every page. |
| 3.3.7 Redundant Entry, A | **Pass** | The brief typed while signed out survives sign-in. Email is kept after a failed sign-in. Passwords are re-entered after an error, which the rule allows for security; see A-013 for making that gentler. |
| 3.3.8 Accessible Authentication (Minimum), AA | **Pass locally** | Email and password only; paste is allowed; the fields carry `autocomplete` values a password manager understands; there is a show-password button; no puzzle or memory test. Production adds a Cloudflare Turnstile check on sign-up when its key is set; that could not be seen here and should be checked once live. Deleting an account asks the person to type their email, which can be pasted. |

Other criteria worth recording as checked and met: 1.1.1 (alt text), 1.3.5 (input purpose on auth fields), 1.4.4 and 1.4.10 at 200% and 320 px on every page except Plans (A-014), 2.1.1 (everything reachable by keyboard except the two controls that do nothing for anyone, E-050 and E-051), 2.1.2 (no keyboard trap), 2.4.1 (skip link), 2.4.7 except A-004 and A-012, 3.1.1 (page language), 3.3.2 (labels).

## 9. Gaps

| Not checked | Why |
| --- | --- |
| A real screen reader (VoiceOver, NVDA) | Not available to this session. Announcement findings (A-003, A-008, A-017, A-019) are reasoned from markup and the accessibility tree; a short VoiceOver run on the brand page would confirm how noisy A-008 really is. |
| `error.tsx`, `global-error.tsx`, the project-level error screen | Cannot be triggered without changing code (see README). Read in pass 1; not measured here. |
| States behind a real generation or credits: names, slogans and directions in progress; the "own slogan" field; the name preview dialog; the sign-out confirmation; the brief editor and Generation activity dialogs | Not opened by keyboard in this pass. Their code was reviewed (dialogs use the same native pattern); A-012's slogan finding is from code only. |
| Stripe Checkout, the customer portal, Cloudflare Turnstile | Hosted elsewhere or switched off locally. |
| The two email templates and the exported `brand-guide.html` | Not audited for accessibility in this pass (contrast, headings, alt text in the files customers keep). Worth 30 minutes before launch. |
| Width 768 | The probe ran at 390 and 1440, plus 320 and 720 (200% zoom). Lighthouse ran desktop and mobile. |
| Real browser zoom, text-spacing overrides (1.4.12), forced-colours mode | Zoom was emulated with a 720 x 450 viewport, which gives the same layout but not the same text rendering. The other two were not run. |
| Lighthouse on the production build; Lighthouse's performance score | Lighthouse ran on the development server (accessibility and best practices do not depend on the build). The DevTools tool does not run the performance category; traces were used instead. |
| Field data (real users) | None exists; the app has no customers. All numbers are lab measurements on one machine, over local HTTP/1.1. Loading times will differ on Vercel; layout shift and responsiveness should carry over. |
| The production build's session and profile endpoints | They answer 503 locally (a known limit in the README). Pages still loaded signed in; the Settings name field was empty. |
| Browser pane clicks | A click on the Email field by reference focused the page instead, twice. Keyboard input worked, so hands-on checks were done by keyboard and the rest by script. |

Data state: nothing was confirmed, deleted or generated. One "Explore six concepts" press at zero credits was refused by the app, as intended. The seed reset was run again at the end of the pass.

## 10. Targets to hold the redesign to

Offered for the merge (Prompt 4, section 8); each is measurable with the scripts in `tools/`.

- Text 4.5:1 or better, including placeholders; control outlines and icons that act as controls 3:1 or better; a two-colour focus ring that is 3:1 on any background, never clipped.
- Focus never lands on the body after an action; every dialog returns focus to its opener.
- No page scrolls sideways or clips content at 320 px or at 200% zoom; fixed chrome takes at most a quarter of a 450 px tall window.
- Lighthouse accessibility 100 and best practices 100 on every route, both devices; no axe violation tagged WCAG A or AA.
- On the production build: CLS 0.1 or less on every route, desktop and phone conditions; LCP 2.5 s or less under phone conditions on Home, and a stated target for signed-in pages; INP 200 ms or less with a 4x slower processor.

## 11. Recap

**Findings: 34.** By severity: P0 0, P1 11, P2 11, P3 12. By tag: needs redesign 8 (A-001, A-002, A-005, A-006, A-010, A-014, A-015, A-020), execution fix 26.

| Severity | IDs |
| --- | --- |
| P1 | A-001, A-002, A-003, A-004, A-006, A-008, A-010, A-014, A-016, A-024, A-025 |
| P2 | A-005, A-007, A-009, A-011, A-012, A-013, A-015, A-017, A-020, A-026, A-028 |
| P3 | A-018, A-019, A-021, A-022, A-023, A-027, A-029, A-030, A-031, A-032, A-033, A-034 |

**Lighthouse (accessibility / best practices, same on desktop and mobile):** 100 / 100 on Home (signed out, new account, with brands), Sign in, Sign up, Forgot password, Reset password, 404, Projects (signed out, empty, 3 brands, 8 brands, deleted), Library (signed out, empty, with assets), Plans (signed out, free, free at 0 credits, Pro), Settings (signed out and all three accounts), Assets (Kestrel, Orchard Lane), Recover a project, and the signed-out project page. Brand conversation: 100 / 96 at the four early stages (Spokesmith, Little Lighthouse, Northern Lights, Fromagerie) and 99 / 96 at the five later ones (Quill, Tidewater, Mosswood, Orchard Lane, Kestrel). Legacy Identity page: 96 / 100.

**Core Web Vitals (production build):** Home 141 ms LCP, 0 CLS, 67 ms INP. Brand conversation 409 ms, 0.18, 140 ms; under phone conditions 9.3 s and 0.75. Assets 1.2 s, 0.55, 42 ms; under phone conditions 9.3 s and 0.06.

**Gaps:** no screen-reader run; error screens, credit-gated states, Stripe and Turnstile not reachable; emails and the exported guidelines file not audited; width 768, real zoom, text spacing and forced colours not run; lab numbers only. Details in section 9.

Files added in this pass: this report; `tools/contrast.mjs`, `tools/a11y-probe.mjs`, `tools/a11y-aggregate.mjs`, `tools/a11y-keyboard.mjs`, `tools/lighthouse-table.mjs`; `evidence/lighthouse/` (78 reports and `summary.md`), `evidence/traces/` (9 traces), `evidence/a11y/` (84 probe files, `keyboard.json`, reflow and focus screenshots), `evidence/annotated/A-kbd-*.png`.
