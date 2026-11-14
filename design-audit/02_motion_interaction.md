# Design audit, pass 2: motion and interaction

Status: **complete for pass 2** (the recap at the end lists what could not be tested).
Environment: local stack only (`http://127.0.0.1:3105`, development server, stand-in AI). Date: 2026-11-11. Code at commit `06ba8a7`.

How to read a finding. Each block has an ID (M-001, M-002, …), where it is, a category, a severity and a tag.

- **Category:** *motion* (something moves, or should), *feedback* (how and when the app answers an action), *interaction state* (hover, press, focus, disabled, selected), *performance* (real or perceived speed and stability).
- **Severity:** P0 blocks or breaks a task. P1 hurts trust or completion. P2 is noticeable polish. P3 is nice to have.
- **Tag:** *needs redesign* means a new visual or interaction decision is required (goes to Claude Design). *Execution fix* means the right answer is already clear (goes straight to implementation).
- **Evidence** paths are relative to `design-audit/evidence/`. `annotated/M-xxx.png` are sequences of frames taken a set number of milliseconds after an action; each frame is labelled with its delay.

Terms used in this file.

- **Transition / keyframe animation:** two ways CSS moves things. A transition goes from the current state to a new one and can be reversed halfway. A keyframe animation plays a fixed script and restarts from the beginning if triggered again.
- **Easing:** the speed curve of a movement. *Ease-out* starts fast and settles, which feels responsive. *Ease-in* starts slowly and feels sluggish.
- **Motion token:** a named value (a duration or an easing) defined once and reused, like the colour tokens in `src/styles/tokens.css`.
- **Skeleton:** grey blocks shown in place of content that is still loading.
- **Layout shift:** content that jumps after it has appeared. The score is the share of the screen that moved multiplied by how far it moved. Google's Web Vitals treat a page total under 0.1 as good and over 0.25 as poor.
- **Optimistic:** showing the result of an action at once and correcting it only if the server refuses, instead of waiting for the server first.
- **Reduced motion:** an operating-system setting (`prefers-reduced-motion`) used by people for whom movement on screen causes discomfort.

The yardstick is the Direction in `README.md`: minimal and premium, calm, precise, with the person's own brand as the most colourful thing on screen. For motion that means very little of it, and what there is must be exact.

## 1. Summary

**The app has almost no motion, and that is close to right. What is wrong is feedback, not animation.** Embel has 6 keyframe animations and about 9 transitions in the whole product, no animation library, and nothing that drops frames. Nothing is over-animated, which is the more common fault and the harder one to undo. The Direction asks for calm and precise; a version of Embel with page transitions, bouncing cards and hover lifts would be worse than what exists.

The problems are of a different kind. The interface often does not acknowledge an action for a second or more, shows the wrong thing while it loads, or moves the page under the person's eyes. There are 20 findings: none at P0, 5 at P1, 13 at P2 and 2 at P3. Fifteen are execution fixes and five need a design decision.

The five that matter most:

1. **Opening a brand is unstable for two to three seconds (M-013, M-014).** The view jumps to four or more scroll positions, the page shifts as images arrive (a layout-shift score of 0.61 at phone width, six times the "good" limit), and the Logo and Creative direction steps show instructions for an empty project ("Choose at least one type", "Enter a brand name before generating.") above work that is already finished.
2. **The paid actions answer late (M-016, M-015).** After "More concepts" nothing new appears for about 3 seconds, which is exactly the app's polling interval. After choosing a logo or a direction, the selection ring arrives about a second after the click. "Stop" and "Cancel research" dim their button and then show no other change for 2 to 8 seconds.
3. **The Assets page, the payoff of the journey, jumps (M-019).** A blank page with one line of small text becomes three "Preparing…" boxes, and then the brand board is inserted above them and everything moves down by a third of the screen (0.32). It jumps again after "Download brand kit" (0.26).
4. **No control has a pressed state, and dialogs and menus appear in a single frame (M-001, M-003).** Not one of the 59 kinds of enabled control measured changes while it is being pressed. These are the two places where a small amount of motion is missing rather than unwanted.
5. **Reduced motion removes every sign of life (M-004).** One global rule switches off all animation, including the progress bar, the spinner and the skeleton pulse. A one-minute research wait then looks identical to a frozen page.

Two further points for the merge. Library's "View details" (pass 1, E-050) opens and closes itself within 10 milliseconds because of how the development server runs React; it probably works in production and should be re-tested there (M-012). And nothing in this pass argues for a "motion redesign": the proposed motion tokens in section 8 are small, and five self-contained plans in `animation-plans/` cover the clear fixes.

## 2. How this pass was done

**Seed reset: not run, replaced by a check.** The audit rule is to run `node design-audit/seed/seed.mjs` first. The seed refuses to run while the app is up, and stopping the already-running audit server was blocked by this session's safety settings. Instead, `node design-audit/seed/verify.mjs` (read-only) was run first and passed all 35 checks, which shows the data matched the seed made at 21:19 the same evening. The tests in this pass that change data were run last. The recap lists what they changed. The seed was then reset at the end of the pass, once the owner approved stopping the server.

**Skills.**

- `review-animations` could not be started: the skill is set so that only a person can run it (typing `/review-animations`). Its rule set comes from the same source as the audit catalogue inside `improve-animations` (Emil Kowalski's rules for easing, duration, animated properties, origin and interruptibility), so existing animations were reviewed against that catalogue instead. Section 5 is that review. Running `/review-animations` by hand would be a second opinion, not a missing step.
- `improve-animations` was used in read-only mode. Its five plans are in `design-audit/animation-plans/` (not `plans/`), and its "execute" mode was not used. The `animate` skill was not used.
- `find-animation-opportunities` produced section 6, including the places where motion should not be added.
- `animation-performance` produced section 7. Diagnosis only.

**Tools.** Three small scripts were written in `design-audit/tools/` and drive the real local app in Chromium:

- `motion-probe.mjs` visits 26 route states at 1440 and 390, takes one sample of every kind of interactive control (71 kinds at 1440), and records what changes on hover, press and keyboard focus. It hovers with the real mouse and forces the pressed and focused states through the browser's developer protocol, so it never clicks anything. Output: `motion/probe.json`, `motion/probe-summary.md`.
- `walk-1-shell.mjs`, `walk-2-brand.mjs`, `walk-3-live.mjs` perform 30 scenarios (about 140 recorded steps per width). A recorder inside the page logs every animation and transition that actually starts, every layout shift, URL change, status message, dialog, focus move and scroll, with timestamps, and frames are saved at fixed delays after each action. Output: `motion/walk-*.json`, `motion/walk-*.txt`, `motion/frames/`.
- `contact-sheet.mjs` and `build-motion-evidence.sh` assemble the `annotated/M-xxx.png` images.

The 390 runs use a touch device profile (no hover, touch input). Reduced-motion runs set the browser's reduced-motion preference.

**Browser pane.** The pane was used for spot checks at 1440 and 390: navigation hover, project-card hover, the route change from Home to Projects with a timing recorder, and the skeletons. Its clicks land a few pixels off at the pane's zoom (the inventory noted the same), so the systematic work was done with the scripts above, in a real Chromium against the same running app. Everything in the inventory's interaction table was triggered at both widths unless the recap says otherwise.

**About the numbers.** All timings come from the development server on a fast Mac, with the test scripts sharing that server. Read them as sequences and proportions, not as production speeds. Where a delay is built into the code (the 3-second polling interval, the re-jump timers), that is said.

## 3. What already works and should be kept

- **Restraint.** No page transitions, no hover lifts, no bounce, no `ease-in`, no `transition: all`, no element growing from nothing, no animation on keyboard actions. Route changes swap in 40 to 100 ms. Keep all of this.
- **Every moving thing animates only position or opacity** (the cheap properties). Nothing animates size or layout. Measured 60 frames per second throughout (section 7).
- **The logo "drawing" placeholder** is a soft grey marbled texture that moves slowly. It is the right tone, runs at 60 frames per second, pauses when the tab is hidden, and is replaced by a plain caption under reduced motion (`generation-animation.tsx:29-40`).
- **Keyboard and dismissal basics are sound.** Escape closes every menu and dialog tested. The Delete project dialog puts focus on Cancel and returns it to the "…" button; the Inspiration view and the larger direction view return focus to what opened them.
- **Several actions already answer within 50 ms:** Upgrade ("Opening checkout…", both buttons disabled), Delete ("Moving to Deleted projects…"), Save changes ("Saving your profile and preferences…"), Sign in (spinner in the button), sending a brief ("Saving your project…", then the project opens in 250 ms), liking a brand (the heart fills at once, saved in the background).
- **Honest partial states:** "Retry 2 failed concepts", the failed-upload message with Check upload and Cancel upload, and "Saving could not be confirmed" when offline all appear promptly and keep the person's work.
- **Automatic scrolling respects the reader.** New replies are followed only while the reader is near the end of the conversation, and the one smooth scroll in the app (jumping to a new reply) becomes instant under reduced motion (`use-conversation-follow.ts:93-96`).
- **The keyboard focus ring** appears instantly on all 59 enabled control kinds: a 2 px ink outline. (Its contrast and offset are for pass 3.)

## 4. Findings

### 4.1 System-wide

**M-001. No control has a pressed state**
- Screen: every route, all states, 390 and 1440.
- Category: interaction state
- Severity: P2
- Tag: execution fix
- What's wrong: there is no `:active` rule in any stylesheet (0 matches in `src/**/*.css`). The probe sampled 59 kinds of enabled control at 1440 and 58 at 390 (buttons, pills, chips, cards, toggles, tabs, links, menu rows) and forced each into its pressed state: none changed colour, size, border or shadow.
- Why it matters: the press is the moment the person asks "did it hear me?". On the actions that then take a second or more to show a result (M-015, M-016), nothing at all confirms the click. A premium product answers the finger before it answers the request.
- Suggested direction: on `.button` and `.icon-button`, `transform: scale(0.97)` while pressed, with `transition: transform 160ms cubic-bezier(0.23, 1, 0.32, 1)`. No scale on text links, form fields or cards. Disabled controls do not respond. Under reduced motion the scale is removed (a colour change on press may stay). Plan: `animation-plans/001-motion-tokens-and-press-feedback.md`.
- Evidence: `motion/probe-summary.md` (column "Press changes", empty on every row); `motion/probe.json`; `src/styles/globals.css:41-58`.
- Systemic? Yes: every screen.

**M-002. Hover and state changes are timed four different ways, and most are not timed at all**
- Screen: every route; measured at 1440.
- Category: motion
- Severity: P2
- Tag: needs redesign
- What's wrong: there are no motion tokens. Of 71 kinds of interactive control, 3 carry a transition of their own. Navigation links, buttons, project cards, menu rows, tabs and text links switch colour in a single frame (`transition-duration: 0s`). The guided choice cards, logo cards and direction cards ease their border over 120 ms; Inspiration cards ease border and shadow over 120 ms and zoom their image over 200 ms; hearts change fill over 150 ms; one chevron turns over 150 ms. All use the browser's default curve. Seventeen control kinds show no hover change at all; most are text fields, where that is fine, but the list includes the "Continue" link that leads to Assets (`a.identity-primary-button`), the tabs in Library and Settings, the "+" on the composer, and the send arrow when the prompt is empty (which is styled grey but is not actually disabled).
- Why it matters: when one part of the screen eases and the next snaps, the product feels assembled from parts. Timing is part of the visual identity in the same way spacing is; today it is accidental.
- Suggested direction: adopt the token set in section 8 and apply one rule: colour, border and background changes on hover take 120 ms with `ease`; nothing moves on hover except the two Inspiration effects that already exist. Give the Continue link and the tabs a hover state. This is tagged "needs redesign" only because the token values belong in the design system that Claude Design builds first; once they exist, applying them is mechanical (plans 001 and 004).
- Evidence: `motion/probe-summary.md` (columns "Transition" and "Hover changes"); inventory section 2 "Motion".
- Systemic? Yes: every screen.

**M-003. Dialogs and menus appear and disappear in a single frame**
- Screen: all dialogs (11 in code; sign-in overlay, Delete project, Delete account, sign-out confirmation, Inspiration brand view and larger direction view were opened in this pass) and all menus (account menu, project switcher, project card menu, Sort, the composer's "+"); 390 and 1440.
- Category: motion
- Severity: P2
- Tag: execution fix
- What's wrong: every overlay is absent in one frame and complete in the next, in both directions. Measured on each: no animation, no transition. The sign-in overlay also blurs the page behind it instantly. The out-of-credits prompt, the app's only toast-like element, appears the same way in the bottom corner. Moving between "Sign in" and "Create account" inside the overlay closes the dialog and opens a new one, which flickers. A related inconsistency for the design-system pass: the nine dialog styles use seven different backdrops (from 22% to 53% ink, two of them blurred).
- Why it matters: a surface that covers the page with no bridge reads as a cut, and the person has to work out what just appeared and where it came from. These are occasional actions, so a short entrance costs nothing. Closing, by contrast, should stay instant: a dismissal that lingers feels slow.
- Suggested direction: dialogs fade in and grow from 97% to 100% over 200 ms with a strong ease-out, with the backdrop fading over the same time; they stay centred. Menus grow from the corner nearest their trigger over 150 ms. The Library side panel slides in from its edge over 300 ms. No exit animation. Under reduced motion, fade only. Keep one dialog open when switching between Sign in and Create account. Plan: `animation-plans/002-overlay-enter-and-exit.md`.
- Evidence: `annotated/M-003.png`; `motion/walk-shell-signed_out_composer_signed_out_sign_in_overlay_sign_in_page_sign_up.json` (notes "dialog styles"); `motion/walk-shell-signed-in.txt` (notes "menu styles", "delete dialog").
- Systemic? Yes: every overlay.

**M-004. Reduced motion removes every sign that work is in progress**
- Screen: every loading and generating state; verified live on research in progress and logo drawing at 1440.
- Category: motion
- Severity: P2
- Tag: execution fix
- What's wrong: `src/styles/globals.css:332` sets `animation: none !important; transition: none !important` on every element when reduced motion is on. With that setting, the browser reported zero running animations while research was in progress and while six logos were being drawn. The progress bar is a still grey line, the sign-in spinner a still ring, the skeletons still blocks, the "thinking" mark a still icon.
- Why it matters: reduced motion is a request for less movement, not for no feedback. An opacity pulse does not move anything and is safe to keep. Without it, a wait that can last a minute cannot be told apart from a page that has stopped working, for exactly the people who chose this setting.
- Suggested direction: replace the global rule with one that removes movement (press scale, entrance shift and scale set to none; smooth scrolling off) and keeps opacity. Give each looping indicator a reduced-motion version: a slow opacity pulse (1 to 0.55 and back over 1.6 s). The spinner stops turning and pulses instead. Plan: `animation-plans/003-reduced-motion-gentler-not-zero.md`.
- Evidence: `annotated/M-004.png`; `motion/walk-live.json` (scenarios `research-live-reduced-motion`, `logos-live-reduced-motion`: "animations while researching: []").
- Systemic? Yes: every waiting state.

**M-005. Some controls exist only on hover, and hover effects are not limited to devices that can hover**
- Screen: Inspiration gallery inside the brand conversation (Northern Lights, audit-free), 390 with touch; hover rules app-wide.
- Category: interaction state
- Severity: P2
- Tag: needs redesign
- What's wrong: three things in the gallery are invisible until the pointer is over them: the heart that likes one part of a brand (logo, colours, typeface), the label naming that part, and the "Open brand" hint. On a touch device they were measured at `opacity: 0` and never appear, so a phone user cannot discover that parts can be liked. Separately, the stylesheets contain 85 hover rules and no check that the device can hover, so on a phone a tap leaves the hover style (an enlarged heart, a zoomed image) stuck until the next tap elsewhere.
- Why it matters: liking parts is how the person steers the logo and direction steps. A control that cannot be seen cannot be used. The owner's stated priority is desktop first, which is why this is P2 and not P1.
- Suggested direction: decide how part-level liking shows on touch (always-visible hearts are the simplest answer; labels may stay hidden). Wrap the two hover movements in `@media (hover: hover) and (pointer: fine)`. Plan 004 does the gating and makes the hearts visible on touch; how labels and the hint appear is the design decision.
- Evidence: `annotated/M-005.png`; `motion/walk-brand-390.txt` (scenario `inspiration-gallery`, note "touch: hover-only controls"); `src/components/inspiration/inspiration.css:296-298, 820-822, 847-865`.
- Systemic? Partly: the hidden controls are in Inspiration only; the missing hover check is everywhere.

**M-006. "Working" is shown in seven different ways, and often only as a line of text**
- Screen: sign-in (spinner), Home, Projects and Library (skeleton pulse), research (sweeping bar), logo drawing (shader texture), any AI text step (pulsing mark), Assets ("Preparing…" boxes, then one line of text), brand page ("Loading saved choices…" and five other text-only messages); 390 and 1440.
- Category: feedback
- Severity: P2
- Tag: needs redesign
- What's wrong: each area invented its own waiting indicator: a spinner turning at 0.8 s per turn, a mark pulsing every 1.5 s, a skeleton pulsing every 1.6 s, a bar sweeping every 2.4 s, a research mark that rotates and scales every 2.8 s (defined in `guided-interview.css:300-342`; not seen in the running app during this pass), a shader, and plain sentences ending in "…" with nothing moving at all. The text-only kind is the most common on the brand page.
- Why it matters: the person learns one signal for "wait" and then has to learn six more. Text that changes without any moving indicator is easy to miss and gives no sense of whether anything is still happening.
- Suggested direction: define three waiting patterns in the design system and use only those. (1) Content that will have a known shape: a skeleton of that shape with the 1.6 s opacity pulse. (2) An action in a button: the spinner inside the button. (3) AI work of unknown length: the sweeping bar with one status sentence and a stop control. Keep the shader for logo drawing only, as the single expressive moment. Retire the rotating research mark.
- Evidence: `annotated/M-006.png`; inventory section 2 "Motion".
- Systemic? Yes.

**M-007. Messages are inserted into the page and push everything below them**
- Screen: Home composer (helper lines and the "+" panel), Plans (payment error line), Projects (the "moved to Deleted projects" notice), logo step ("Retry" with no credits, "Saving your choice…"), creative direction ("Saving choice…"), Inspiration ("Show more brands"); 390 and 1440.
- Category: feedback
- Severity: P2
- Tag: execution fix
- What's wrong: status lines and notices are added in the normal flow of the page, so the content the person is looking at moves at the moment they act. Measured layout shifts: deleting a project, 0.21 (the whole grid drops when the notice appears); the composer's "+" panel at 390, 0.11; "Retry 2 failed concepts" with no credits, 0.05 then 0.03 at 1440 and 0.07 then 0.06 at 390; "Saving choice…" on a direction, 0.04; selecting a logo, 0.03 twice; typing the first character on Home, which pushes the starter chips down (pass 1, E-002).
- Why it matters: the control just pressed, or the next one the person was aiming for, moves away. On the two decision screens the cards shift at the exact moment of choosing.
- Suggested direction: give every status line a reserved place that exists before the message does (a fixed-height slot under the toolbar or the composer), or show it over the content (the out-of-credits prompt already floats). Never insert above the thing that was clicked.
- Evidence: `annotated/M-007.png`; shift lines in `motion/walk-live2.txt`, `motion/walk-brand-1440.txt`, `motion/walk-brand-390.txt`.
- Systemic? Yes.

### 4.2 Sign-in, navigation, Projects, Library, Plans, Settings

**M-008. Signed-in pages first show their signed-out version**
- Screen: `/brands`, `/settings`, `/plans`, `/brands/account/<id>` and the navigation pill on every full page load, signed in; 390 and 1440.
- Category: performance
- Severity: P2
- Tag: execution fix
- What's wrong: until the account check answers, pages render as if nobody were signed in. Seen during loads: the Projects heading reads "Your projects." before becoming "Projects."; Settings announces "Sign in to edit your profile and preferences."; a brand page shows "Project workspace", "Checking your account…" and a "Back to Projects" link on an otherwise empty screen; the pill shows "Checking account…" and then changes width; the Plans grid moves (0.03). Locally this lasts 100 to 350 ms. The account check is a request to the server, so on a real connection it lasts as long as that request. The pill repeats "Checking account…" during sign-in and sign-out.
- Why it matters: a returning customer briefly sees a screen telling them to sign in. It is the first impression of every visit, and it makes the session feel unreliable.
- Suggested direction: while the account is unknown, render a neutral frame: the pill at its signed-in width with placeholders, the page heading, and a skeleton of the content. Show signed-out content only once the check has said so.
- Evidence: `annotated/M-008.png`; `motion/walk-shell-signed-in.txt` (steps `reload-with-3s-api-delay`, `load-settings`, `load-plans`); `motion/walk-brand-1440.txt` (step `direct-load`).
- Systemic? Yes: every signed-in page.

**M-009. Lists reload from a skeleton on every visit, then fill in three steps**
- Screen: Home ("Pick up where you left off"), Projects, Library; signed in; 390 and 1440.
- Category: performance
- Severity: P2
- Tag: execution fix
- What's wrong: going Home → Projects → Library → Home → Projects, each arrival shows the loading state again, although the same list was on screen seconds earlier: skeleton cards for about 350 to 450 ms on Home and Projects, "Loading assets…" for about 70 ms on Library. The browser's Back button does the same. Clearing the Projects search box replaces the eight cards with eight skeletons and loads them again, although typing had filtered them without any request. When cards do load, each fills in three steps with no bridge: title at about 100 ms, thumbnail at about 300 ms, "next step" line at up to 800 ms.
- Why it matters: navigation is the most repeated action in the product. Showing a loading state for something the app already has makes it feel slower than it is, and the three-step fill makes each card flicker.
- Suggested direction: keep the last result in memory and show it immediately on return, refreshing quietly in the background. Clear the search without a request. Reserve the skeleton for a first load. Fade thumbnails in over 200 ms when they arrive (plan 005). Do not animate the route change itself.
- Evidence: `annotated/M-009.png`; `motion/walk-shell-signed-in.txt` (scenario `nav-route-changes`, step `clear-search`).
- Systemic? Yes: all three lists.

**M-010. Closing the account menu by tapping elsewhere also activates what is under the finger**
- Screen: navigation pill, account menu open, Projects; reproduced at 390 (at 1440 the test click landed on empty space).
- Category: interaction state
- Severity: P2
- Tag: execution fix
- What's wrong: with the menu open, a tap on the page closes the menu and is also delivered to the element underneath. In the test the tap landed on a project card and the app navigated to that brand's Assets page 74 ms later. At phone width the content under the menu is almost all tappable.
- Why it matters: "tap away to close" is a reflex. Navigating somewhere unintended as a side effect is disorienting and looks like a bug.
- Suggested direction: the first tap outside an open menu only closes it. The same rule should hold for the project switcher, the card menu and Sort.
- Evidence: `annotated/M-010.png`; `motion/walk-shell-signed-in.txt` (scenario `account-menu` at 390, step `outside-click-closes-menu`); `src/components/workspace/app-shell.tsx:150-163`.
- Systemic? Probably: every `<details>` menu closed by an outside click.

**M-011. Keyboard focus is dropped after several actions**
- Screen: `/sign-in` after a wrong password; Settings, Delete account dialog closed with Escape; Projects after confirming Delete; Plans after a failed upgrade; sign-in overlay on opening; 390 and 1440.
- Category: interaction state
- Severity: P2
- Tag: execution fix
- What's wrong: after a wrong password the error appears, the password field is emptied, and focus is on the page body, so a keyboard user must tab back through the page to retype. Closing the Delete account dialog with Escape leaves focus on the body, while closing the Delete project dialog returns it to the button that opened it. After a project is deleted and after an upgrade fails, focus is also on the body. The sign-in overlay opens with focus on its Close button, not on the Email field. Sign-up relies on the browser's own validation bubbles where sign-in shows an inline message.
- Why it matters: focus is where the next keystroke goes. Losing it after an error is the moment a keyboard user most needs it. The inconsistency between two dialogs that look the same shows there is no shared dialog behaviour. Pass 3 will judge this against WCAG; it is recorded here as interaction behaviour.
- Suggested direction: one rule for every dialog and menu: on close, focus returns to the control that opened it; if that control is gone (deleted card), focus goes to the notice that explains what happened. After a failed sign-in, focus the password field. Open the sign-in overlay with focus in Email.
- Evidence: `motion/walk-shell-*.json` (notes "after wrong password", "after Escape", "after upgrade click"); `motion/walk-shell-settings_dialogs.json`; `motion/walk-live-choose_direction_delete_project.json` (note "after delete").
- Systemic? Yes: dialogs have no shared behaviour (11 separate implementations).

**M-012. Library "View details" opens and closes itself within 10 milliseconds (cause of pass 1's E-050)**
- Screen: `/assets`, Kept assets, audit-pro; 390 and 1440.
- Category: interaction state
- Severity: P1
- Tag: execution fix
- What's wrong: clicking "View details of …" does open the detail panel: the recorder saw `dialog.assets-detail` open 42 ms after the click with "Loading version history…", and gone 10 ms later. No frame shows it. The cause is in `src/components/assets/asset-detail.tsx:46-54`: the component opens the dialog when it mounts and closes it when it unmounts, and closing fires the same handler that tells the page to remove it. The development server runs React in strict mode (`next.config.ts:107`), which mounts, unmounts and remounts every component once on purpose, so the dialog closes itself. A production build does not do that.
- Why it matters: pass 1 recorded this control as doing nothing (E-050). It is most likely a development-only failure, which changes its priority for launch, but the pattern is fragile and blocks anyone testing locally.
- Suggested direction: re-test on the production build (`node design-audit/seed/serve.mjs --prod`) before the merge decides severity. Then fix the pattern: do not call the page's close handler from the unmount cleanup.
- Evidence: `annotated/M-012.png`; `motion/walk-shell-signed-in.txt` (scenario `library`, step `view-details`).
- Systemic? No.

### 4.3 The brand conversation

**M-013. Opening a brand: the view jumps several times and the page shifts under it**
- Screen: `/brands/account/<id>?view=strategy` for any brand past Voice (Kestrel, Quill, Mosswood, Northern Lights measured), direct load and from a link; 390 and 1440.
- Category: motion
- Severity: P1
- Tag: needs redesign
- What's wrong: on opening Kestrel at 1440, the conversation's scroll position was set to 2618, then 2427, 2361 and 2838 pixels within the first 850 ms. The code then repeats the jump at 300, 800, 1600 and 3000 ms unless the person touches the page (`account-guided-interview.tsx:101-108`). Between jumps the Inspiration gallery loads 43 images and reflows (shifts of 0.05, 0.02 and 0.01; 0.08 more on Mosswood). At 390 the positions were 1861, 4290, 4270 and 4922, with shifts of 0.61 and 0.32. The first content a returning customer sees, for about a second, is the middle of the gallery: other companies' brand boards. Clicking "Strategy" in the pill from the Assets page lands mid-gallery at 2618 first and corrects to the top 400 ms later. Step links inside the page jump instantly across thousands of pixels, which is right for speed but gives no cue about where the person has landed.
- Why it matters: this is how every return visit to a brand begins. A page that moves by itself four times and shifts by more than half the screen feels broken, and it buries the person's own work under someone else's. Pass 1 described where the page lands (E-032, E-052); this finding is about the instability on the way there.
- Suggested direction: decide what a reopened brand shows first (pass 1 suggests the person's own latest work). Then land once: reserve the height of sections that are still loading so that one scroll is enough, and remove the timed re-jumps. Do not add smooth scrolling over these distances; it would take seconds. If orientation is wanted after a step jump, a brief highlight of the section heading (background fading out over 300 ms) is enough.
- Evidence: `annotated/M-013.png`, `annotated/M-013-390.png`; `motion/walk-brand-1440.txt` and `motion/walk-brand-390.txt` (steps `direct-load`, `pill-step-strategy`).
- Systemic? Yes: every brand past the Voice step.

**M-014. While saved work loads, steps show instructions for an empty project**
- Screen: Logo and Creative direction steps inside the brand conversation: on opening a brand (Kestrel, audit-pro) and on Continue from Inspiration (Fromagerie Bérénice Côté, audit-free); 390 and 1440.
- Category: feedback
- Severity: P1
- Tag: execution fix
- What's wrong: before saved data arrives, the steps render their empty-state messages. Opening Kestrel, a finished brand, showed "Choose at least one type" (from about 1.2 s to 1.9 s), "Getting ready…", "Complete your saved logo inputs to continue." (1.5 s to 2.1 s) and "Choose a logo concept to begin." before settling on "Logo chosen · 6 of 6 concepts ready" at about 2.6 s. Continuing from Inspiration to Logo showed five messages in 1.2 s: "Choose at least one type", "Complete your saved logo inputs to continue.", "Enter a brand name before generating." (the brand has a name), "Preparing saved inputs…" and "Request in progress…", with the logo-type options drawn faded as if disabled. After an out-of-credits refusal the line "Not ready yet." stays under the button with no explanation.
- Why it matters: for a second or two the app tells a customer that finished work is missing, and asks them to do things they have already done. Each message is also announced to screen-reader users. It reads as data loss.
- Suggested direction: a step has three states and must show only the true one: loading (a skeleton of the step's shape, no instructions), empty (instructions), ready (the work). Do not render validation messages until the saved inputs have loaded. Clear "Request in progress…" and "Not ready yet." when the request ends.
- Evidence: `annotated/M-014.png`; `motion/walk-brand-1440.txt` (step `direct-load`, "live" lists); `motion/walk-extra.txt` (step `continue-from-inspiration-to-logo`); `motion/walk-extra2.txt` (step `explore-with-zero-credits`).
- Systemic? Yes: Logo and Creative direction steps for every brand.

**M-015. Choosing a logo or a direction is confirmed about a second after the click**
- Screen: Logo step (Quill, audit-free) and Creative direction step (Mosswood, audit-free); 1440.
- Category: feedback
- Severity: P2
- Tag: execution fix
- What's wrong: clicking a logo concept showed the line "Saving your choice…" after 15 ms, and the selection ring 880 ms after the click (140 ms the second time). Clicking a direction showed "Saving choice…" after 47 ms, and the ring and "Editorial Soft Shapes chosen" after 1.3 s. In between, the card looks unchosen and the inserted line pushes the grid (M-007). The card has no pressed state (M-001) and only a slightly darker border on hover.
- Why it matters: these are the two decisions the whole journey leads to. A second without visible confirmation on the card itself invites a second click, and it makes the most satisfying moment in the product feel hesitant.
- Suggested direction: mark the card as chosen at once (ring and check appear with the click, border and check easing in over 160 ms), save in the background, and revert with a message only if saving fails. Keep the "Saving…" text out of the layout (M-007). What the chosen state looks like is pass 1's E-051.
- Evidence: `annotated/M-015.png`; `motion/walk-live.json` (scenario `select-concept`); `motion/walk-live-choose_direction_delete_project.json` (scenario `choose-direction`).
- Systemic? Yes: both selection screens.

**M-016. Starting, stopping and cancelling AI work are acknowledged late**
- Screen: Logo step, "More concepts" and "Stop" (Maison Aurélie, audit-pro, with the stand-in AI slowed down); research, "Cancel research" (new brief, audit-pro, stand-in held); 1440.
- Category: feedback
- Severity: P1
- Tag: execution fix
- What's wrong: after "More concepts" the button is disabled and a small "Request in progress…" appears within 45 ms, but the six logos stay exactly as they were for 3.2 seconds. Then all six are replaced at once by "Creating your concept" placeholders, with two layout shifts (0.07 and 0.06). The wait matches the 3-second polling interval in `use-logo-engine.ts:12`: the page learns that its own request has started by asking again later. After "Stop", the button dims and nothing else changed in the following 8 seconds; "More concepts" was still disabled 6 seconds after that. After "Cancel research", the button dims at once, but the heading kept saying "Researching your competitors" with the bar sweeping for 2 seconds before "Cancelling research…", and still read "Stopping…" 5 seconds later. (The stand-in was deliberately slow or held, so real stops may finish sooner; the missing acknowledgement does not depend on that.)
- Why it matters: these buttons spend the customer's credits or try to save them. Three seconds of an unchanged screen after a paid click, and an unchanged screen after "Stop", both raise the question "did that work?" at the moment trust matters most.
- Suggested direction: show the six placeholders in the same frame as the click (the request has been accepted or it has not; the page does not need to poll to know it asked). After Stop or Cancel, change the visible state at once: placeholders show "Stopping…", the bar stops sweeping. Poll once immediately after any action instead of waiting out the interval.
- Evidence: `annotated/M-016.png`; `motion/walk-live.txt` (scenarios `logos-live`, `research-live`).
- Systemic? Yes: research, names, logos and directions share the same polling pattern (`use-strategy-jobs.ts:41`, `naming-feed-controller.ts:23-25`, `use-logo-engine.ts:12`).

**M-017. Finished work arrives with no moment of its own**
- Screen: logo concepts, creative direction boards, brand board on Assets, project thumbnails; 390 and 1440. Seen on page loads; the arrival of a freshly generated concept could not be observed live (see recap).
- Category: motion
- Severity: P3
- Tag: needs redesign
- What's wrong: images replace their placeholders in a single frame. The one entrance animation in the app (`flow-enter`: 160 ms, from 45% opacity and 4 px lower) is applied to conversation sections, and it plays on all saved sections every time a brand is opened (seven at once on Kestrel), not only on new replies. So old content animates and the new logo does not.
- Why it matters: receiving six logos, or three directions, is the high point of the product and the only place where a little delight is earned. Today it is a flicker. This is where the Direction's "the brand is the most colourful thing on screen" can be felt.
- Suggested direction: a decision for Claude Design: how results arrive. A restrained option: each finished image fades in over 300 ms with a strong ease-out, the six concepts 40 ms apart; no bounce, no slide longer than 4 px. Limit `flow-enter` to content added after the page has loaded. Plan 005 covers the plain fade.
- Evidence: `annotated/M-016.png` (the swap to placeholders), `annotated/M-013.png`; `src/styles/guided-conversation.css:174-187`; animation lines in `motion/walk-brand-1440.txt` ("embel-flow-enter … x7 in this step").
- Systemic? Yes.

**M-018. The larger view of a direction board opens small and jumps to full size**
- Screen: Creative direction, "View … larger" (Mosswood, audit-free); 390 and 1440.
- Category: motion
- Severity: P2
- Tag: execution fix
- What's wrong: the dialog opens as a short box containing "Private board preview", and within the next frame or two grows to its full height when the image is ready. Layout shift 0.32 at 1440 and 0.18 at 390. Pass 1 noted the "Checking private preview…" text (E-052); this is the size jump.
- Why it matters: the dialog exists to show the board large. Opening at the wrong size and snapping makes the product's best image arrive with a twitch.
- Suggested direction: give the dialog its final size from the start (the boards are square; reserve a square area) and fade the image in inside it over 200 ms.
- Evidence: `annotated/M-018.png`; `motion/walk-brand-1440.txt` (scenario `directions`, step `open-larger-view`).
- Systemic? Probably: the same private-preview loader is used for other images.

### 4.4 Assets

**M-019. The Assets page jumps by a third of the screen when the files are ready, and again after a download**
- Screen: `/brands/account/<id>/logo/deliverables` (Kestrel, audit-pro; Mosswood on first build, audit-free); 390 and 1440.
- Category: performance
- Severity: P1
- Tag: execution fix
- What's wrong: the page arrives in four stages. For about half a second it is blank except for one small line at the top left, "Loading your chosen direction…". Then three grey boxes labelled "Preparing…" appear. At about 1.3 to 1.5 s the brand board is inserted above them and the status changes to "Ready to download.", which moves the page down: shifts of 0.05 and 0.32 at 1440 and 0.14 at 390. Clicking "Download brand kit" dims the button for a moment and changes the status text, which moves the content again (0.26 at 1440, 0.09 at 390). There is no moment that says the kit is ready.
- Why it matters: this is the screen the whole journey leads to, and a layout shift of 0.32 is in the "poor" range by itself. The person reaches for a download button while the page is still moving. Pass 1 found the content of this page to be the weakest part of the product (E-042 to E-047); its arrival is equally rough.
- Suggested direction: render the page's final structure at once, with skeletons the exact size of the brand board and each file tile, and replace them in place. Keep status text in a slot that never changes height. When everything is ready, one quiet confirmation is enough (the status line changing to "Ready", a check easing in over 200 ms).
- Evidence: `annotated/M-019.png`; `motion/walk-brand-1440.txt` (scenario `assets-page`); `motion/walk-live2.txt` (step `continue-to-assets-first-time`).
- Systemic? No: this page.

### 4.5 Performance of the animations themselves

**M-020. Nothing drops frames today; four things to keep that way**
- Screen: research, logo drawing, the finished brand page, list loading; 1440.
- Category: performance
- Severity: P3
- Tag: execution fix
- What's wrong: no fault was measured (section 7). Four details would become faults if motion is added carelessly. (1) Each loading card runs four separate pulse animations (preview, title, date, step), up to 32 on Projects, and they fall out of step as cards finish at different times. (2) The Inspiration card hover animates `box-shadow`, which repaints the card every frame; it is one card at a time today. (3) Two dialog backdrops use `backdrop-filter: blur`; if overlays gain a fade (M-003), animate only opacity, never the blur amount. (4) The floating composer writes its height into a CSS variable on the whole workspace container when the composer or the window resizes (`floating-composer.tsx:98-101`); a variable set on a container makes the browser re-check the style of everything inside it, so it must never be updated on every scroll frame. None of this was tested on a real phone.
- Why it matters: smoothness is what lets good motion register at all, and a fast laptop hides nearly every such problem.
- Suggested direction: pulse one wrapper per card. Keep hover changes to border and background. Fade overlays with opacity. Before launch, record the logo-drawing screen and the finished brand page on a mid-range phone.
- Evidence: `motion/walk-live.json` (notes "frame rate …"); `src/components/workspace/project-card.module.css:151-155`; `src/components/inspiration/inspiration.css:725-732`.
- Systemic? No.

## 5. Existing animations against the rules

Every animation and transition in the code, judged on easing, duration, which properties animate, origin, and whether it can be interrupted.

| What | Where | Values | Verdict |
| --- | --- | --- | --- |
| Spinner in auth buttons (`auth-spin`) | `src/styles/auth.css:93-99` | rotate, 800 ms, linear, endless | Correct: constant motion is linear. Becomes a still ring under reduced motion (M-004). |
| "Thinking" mark (`guided-thinking-pulse`) | `src/styles/guided-conversation.css:133-135` | opacity 0.35 to 1, 1.5 s, ease-in-out, endless | Fine. Calm, opacity only. |
| Section entrance (`flow-enter`) | `src/styles/guided-conversation.css:174-187` | opacity 0.45 to 1 and 4 px upward, 160 ms, ease-out, once | Duration and easing are right. Two problems: it starts half visible, which reads as a flicker more than an entrance, and it plays on restored content at every page load (M-017). |
| Research mark (`embel-research-pulse`) | `src/styles/guided-interview.css:300-342` | rotate ±6°, scale 1.85 to 2, opacity 0.65 to 1, 2.8 s, endless | Out of character: a wobble in a "calm, precise" product. Not seen in the running app in this pass. Retire or reduce to opacity (M-006). |
| Skeleton (`pulse`) | `src/components/workspace/project-card.module.css:151-155` | opacity 1 to 0.55, 1.6 s, ease-in-out, endless | Fine. Four animations per card where one would do (M-020). |
| Progress bar (`journey-bar`) | `src/components/journey/journey.module.css:283-309` | a soft band sliding across, 2.4 s, ease-in-out, endless | Fine and calm. The rule for constant motion is linear; the ease makes it surge slightly. Low priority. |
| Guided choice card | `src/styles/guided-interview.css:47-49` | border and background colour, 120 ms, ease | Correct. The model for other hover states. |
| Logo and direction cards | `logo-creation.module.css:503`, `visual-directions-view.module.css:209` | border colour, 120 ms | Fine. Selection itself is late (M-015). |
| Inspiration card | `src/components/inspiration/inspiration.css:725-732` | border colour and shadow, 120 ms | Acceptable. Shadow repaints (M-020). |
| Inspiration tile image | `inspiration.css:818-822` | scale to 1.03, 200 ms | Subtle enough. Not limited to hover-capable devices (M-005). |
| Hearts | `inspiration.css:285-298` | scale to 1.12 on hover, opacity, fill, 120 to 150 ms | Fine on desktop. Same hover gap (M-005). |
| Chevron in the name preview | `naming-inspect.module.css:144-149` | rotate, 150 ms, ease | Fine. |
| Scroll to a new reply | `use-conversation-follow.ts:89-99` | browser smooth scroll, on an explicit click only | Correct, and instant under reduced motion. |
| Logo drawing texture | `generation-animation.tsx` (the `img-fx` library) | GPU shader | Appropriate for a rare wait; pauses when hidden; off under reduced motion. |

What is absent, and correctly so: `ease-in`, `transition: all`, anything growing from `scale(0)`, animated width, height or margins, animation on keyboard-triggered actions, tooltips with delays.

What is absent and should exist: a pressed state (M-001), overlay entrances (M-003), shared values (M-002).

## 6. Where motion would help, and where it should not be added

A candidate had to pass four tests in order: it is not seen hundreds of times a day; it has a named purpose (feedback, showing where something came from, making a state change readable, preventing a jarring change, or, only for rare moments, delight); it works in under 300 ms; and it does not decorate something the person is trying to read.

### Opportunities

| # | Location | Today | Purpose | Frequency | Suggested motion |
| --- | --- | --- | --- | --- | --- |
| 1 | Every `.button` and `.icon-button` (`src/styles/globals.css:41-58`) | No response to a press | Feedback | Tens of times a day, so keep it nearly invisible | `:active { transform: scale(0.97) }`, `transition: transform 160ms cubic-bezier(0.23, 1, 0.32, 1)`. Removed under reduced motion. |
| 2 | Dialogs and menus (9 dialog styles, 3 menus; plan 002 lists them) | Appear in one frame | Preventing a jarring change; showing where a menu came from | Occasional | Dialog: opacity 0 to 1 and scale 0.97 to 1, 200 ms, `cubic-bezier(0.23, 1, 0.32, 1)`, centred. Menu: same, 150 ms, origin at the trigger's corner. No exit. Reduced motion: opacity only. |
| 3 | Logo concept and direction cards | Ring arrives 0.9 to 1.3 s after the click | Making a state change readable; feedback | A few times per brand | Ring and check appear with the click: border colour 120 ms `ease`; check opacity 0 to 1 and scale 0.9 to 1 over 160 ms, `cubic-bezier(0.23, 1, 0.32, 1)`. |
| 4 | Finished logo concepts, direction boards, brand board | Replace placeholders in one frame | Delight (rare, wanted) | A few times per brand | Opacity 0 to 1 over 300 ms, `cubic-bezier(0.23, 1, 0.32, 1)`; six concepts 40 ms apart. No bounce. Reduced motion: keep the fade, drop the stagger. |
| 5 | Project and Library thumbnails | Pop in after the title | Preventing a jarring change | Tens of times a day, so opacity only | Opacity 0 to 1 over 200 ms on insertion (`@starting-style`). The larger fix is not replaying the skeleton (M-009). |

To turn a row into an implementation plan: `improve-animations plan <description>`. Rows 1, 2 and 5 already have plans.

### Considered and rejected

- **Page transitions between Home, Projects and Library.** Rejected: core navigation, seen all day. The 40 to 100 ms swap is the best version.
- **A sliding highlight in the navigation pill** (the dark capsule gliding to the new item). Rejected: it would play at the moment the next page is loading, which is exactly when frames drop, and it decorates the most frequent action.
- **Smooth scrolling for the journey steps.** Rejected: the distances are 2,000 to 5,000 pixels. A smooth scroll would take seconds and blur the content. Land once and correctly instead (M-013).
- **Hover lift, shadow or scale on project cards and buttons.** Rejected: decoration on things used tens of times a day; it fights "calm".
- **Animated tab changes in Settings and Library.** Rejected: frequent toggles. Instant is correct.
- **Counting numbers for credits, or progress percentages for AI work.** Rejected: the work has no known length, so a moving number would be invented; and the owner's rule is no estimates.
- **A second expressive loading effect** (for research, names or directions, to match the logo shader). Rejected: one is a signature, three are a theme park. Use the bar.
- **Exit animations for dialogs and menus.** Rejected for now: dismissal should feel immediate, and Escape is a keyboard action.

### Verdict

Embel needs very little motion and is already close: the work is five small additions, not a motion layer. The single change with the most effect is the pressed state (row 1), because it touches every click in the product. The rest of what feels wrong is timing and stability (sections 4.2 to 4.4), which no animation would fix.

## 7. Animation performance

**What animates, how, and when.**

| Element | Driven by | Properties | Plays during |
| --- | --- | --- | --- |
| Skeleton blocks | CSS keyframes | opacity | list loading (the page is busy) |
| Auth spinner | CSS keyframes | transform (rotate) | form submit |
| Progress bar | CSS keyframes | transform (translate) | research and other AI text work |
| "Thinking" mark | CSS keyframes | opacity | AI text work |
| Section entrance | CSS keyframes | opacity, transform | brand page load, new replies |
| Choice, logo, direction cards | CSS transition | border-color, background-color | hover, select |
| Inspiration card | CSS transition | border-color, box-shadow | hover |
| Inspiration tile image, hearts | CSS transition | transform, opacity, fill | hover, like |
| Logo drawing texture | WebGL shader in a canvas (`img-fx`), 6 stages, 12 canvases | drawn on the GPU | logo generation |
| Scroll to a new reply | browser smooth scroll | scroll position | an explicit click |
| Composer placement | `requestAnimationFrame` and `ResizeObserver`, writing CSS variables | style recalculation | resize, content change |

**Diagnosis, in order of likelihood.**

1. *Which properties animate?* Only transform, opacity, colour and one shadow. No layout property is animated anywhere. No `transition: all`.
2. *Does motion coincide with a busy page?* The skeleton pulse and the section entrance play during loading. Both are CSS on opacity and transform, which the browser can run off the main thread, so they are the right kind.
3. *Is React re-rendering every frame?* No. There is no hand-written animation loop; the only `requestAnimationFrame` uses are one-off focus moves and the composer placement.
4. *Does anything get worse as content grows?* The composer's CSS variable on the workspace container is the one pattern to watch (M-020).
5. *Animated blur?* None. Two static backdrop blurs of 2 and 3 px.

**Measurements** (frames counted in the page over 2 to 3 seconds; 60 per second is the display's maximum here):

| Situation | Frames per second | Worst gap between frames |
| --- | --- | --- |
| Research in progress, bar sweeping | 60 | 17 ms |
| Six logos drawing | 60 | 17 ms |
| Six logos drawing, processor slowed 4x | 60 | 17 ms |
| Six logos drawing and scrolling, processor slowed 4x | 59 | 33 ms |
| Scrolling the finished Kestrel page (5,365 px, 59 images) | 54 | 317 ms once, at the start; 17 ms otherwise |
| The same, processor slowed 4x | 60 | 17 ms |

Long pauses that are not animation: opening a brand has main-thread tasks of 63 to 71 ms, the Assets page 69 to 182 ms, and the start of logo drawing one of 225 ms. They contribute to the instability in M-013 and M-019.

**Verified from code and from a desktop browser only.** Slowing the processor models a slow CPU, not a weak graphics chip or little memory. The shader and the long, image-heavy brand page (about 5.6 MB of images per the inventory) need a recording on a real mid-range phone before launch.

## 8. Proposed motion tokens

For pass 3b. Names follow the existing token style (`--radius-control`, `--text-sm`).

**Durations**

| Token | Value | Use |
| --- | --- | --- |
| `--duration-fast` | 120 ms | Hover and selection colour, border, small fades. Today's most common value. |
| `--duration-press` | 160 ms | Press scale; a check or ring appearing. |
| `--duration-base` | 200 ms | Dialogs, content entering, thumbnails fading in. Menus use 150 ms. |
| `--duration-slow` | 300 ms | A side panel or phone-width sheet sliding; a finished result appearing. The ceiling for interface motion. |
| Loops | 1.6 s (pulse), 0.8 s (spinner turn), 2.4 s (bar sweep) | The three waiting patterns only. |

**Easings**

| Token | Value | Use |
| --- | --- | --- |
| `--ease-out` | `cubic-bezier(0.23, 1, 0.32, 1)` | Anything entering, and press. The default. |
| `--ease-in-out` | `cubic-bezier(0.77, 0, 0.175, 1)` | Something moving from one place on screen to another. Rare in this app. |
| `--ease-drawer` | `cubic-bezier(0.32, 0.72, 0, 1)` | A panel or sheet sliding in from an edge. |
| (keyword) `ease` | | Hover and colour changes. |
| (keyword) `linear` | | Constant motion: the spinner. |
| (keyword) `ease-in-out` | | The opacity pulse. |

Never `ease-in` on interface elements.

**Distances and scale**

| Token | Value | Use |
| --- | --- | --- |
| `--press-scale` | 0.97 | Pressed buttons. |
| `--enter-scale` | 0.97 | Dialogs and menus start here. Never from 0. |
| `--enter-shift` | 4 px | Content entering the conversation. |
| `--stagger` | 40 ms | Between the six concepts or three directions. Only for results. |

**Rules for when to animate**

1. **Frequency decides.** Seen hundreds of times a day (route changes, tabs, typing, keyboard shortcuts, Escape): no animation. Seen tens of times a day (hover, press, list thumbnails): colour or opacity only, 120 to 200 ms. Occasional (dialogs, menus, panels): the standard entrance. Rare and wanted (a finished logo, a finished kit): the only place for a slower, more generous reveal.
2. **Name the purpose.** Feedback, showing where something came from, making a state change readable, or preventing a jarring change. "It looks nice" is not a purpose.
3. **Only opacity and transform move.** Colour, border and background may fade. Never animate size, position properties, or blur.
4. **Entrances are animated; exits are instant.** Dismissal must never wait.
5. **Answer first, confirm later.** Every action shows a visible change within 100 ms, on the control that was pressed. If the server is slow, the acknowledgement still is not.
6. **Nothing already on screen moves because something else loaded.** Reserve the space; replace in place.
7. **Under 300 ms** for anything the person triggers. Loops are slow (1.6 s or more) and low contrast.
8. **Hover effects only where a pointer can hover** (`@media (hover: hover) and (pointer: fine)`), and nothing may be reachable by hover alone.
9. **Reduced motion removes movement, not feedback.** Set `--press-scale` and `--enter-scale` to 1 and `--enter-shift` to 0; turn off smooth scrolling and stagger; keep opacity fades and the 1.6 s pulse; the spinner pulses instead of turning.

**Three waiting patterns** (see M-006): a skeleton of the content's shape with the pulse; a spinner inside the pressed button; the sweeping bar with one status sentence and a stop control for AI work. The logo shader is the one exception.

## 9. Interaction states by component (measured)

From `motion/probe-summary.md`: 71 kinds of interactive control at 1440, 69 at 390.

| Component | Hover | Press | Keyboard focus | Disabled | Busy |
| --- | --- | --- | --- | --- | --- |
| Primary button (`.button.primary`) | Background `#191919` to `#333`, instant | Nothing | 2 px ink ring, 4 px away (2 px in the pill) | Muted grey fill, grey text, "not allowed" cursor | Spinner on sign-in and reset; label change on Upgrade, Delete, Save; none elsewhere |
| Secondary button | Background and border, instant | Nothing | Ring | Same muted fill | Label change on some |
| Icon button | Background, instant | Nothing | Ring | Not seen | Not seen |
| Navigation link, journey step | Grey capsule, instant; current item is a dark capsule | Nothing | Ring | Steps not yet reached are plain text | "Checking account…" replaces the account area |
| Text link | Grey to ink, instant; links already in ink show no change | Nothing | Ring | Not seen | Not seen |
| Starter chip | Background, instant | Nothing | Ring | Not seen | Not seen |
| Project card | Border one step darker, instant; "next step" text turns ink | Nothing | Ring on the link | Not seen | Skeleton, then three-step fill |
| Logo concept, direction card | Border one step darker, 120 ms | Nothing | Ring | Not seen | "Saving…" text only; ring after the save (M-015) |
| Guided choice card (radio, checkbox) | Border and background, 120 ms | Nothing | Ring | Has a disabled style | Not seen |
| Inspiration card, tile, heart | Border and shadow, image zoom, heart and label appear | Nothing | Ring; heart and hint appear on focus | Has a disabled style | Heart fills at once |
| Text field, textarea | Nothing | Nothing | Ring; the Home composer only darkens its border | Settings fields grey when signed out | Not seen |
| Tabs (Settings, Library) | Nothing | Nothing | Ring | Not seen | "Loading usage…", "Loading assets…" text |
| Send arrow | Nothing while the prompt is empty (it is styled grey but not disabled); dark when there is text | Nothing | Ring | Truly disabled inside projects while a request runs | Not seen |
| Menu row | Grey background, instant | Nothing | Ring | Not seen | "Checking account…" on Sign out |

Pass 3 will judge contrast and target sizes. For this pass the pattern is: hover and focus are covered almost everywhere, press nowhere, and busy states are inconsistent.

## 10. What was tested

Each line was triggered at 1440 and at 390 (touch) unless marked. "S" = scripted Chromium against the running app; "P" = also checked in the Browser pane.

| Area | Interactions |
| --- | --- |
| Signed-out Home | Load and the pill's account check (S); composer focus, typing, starter chip, "+" panel and Escape (S); Send while signed out, overlay opens, Escape, backdrop click, switch to Create account (S); nav hover (S, P) |
| Sign in, sign up, reset | Load; show password; wrong password with a slowed request; sign-up with invalid passwords; forgot password with a slowed, script-answered request (no email was created); 404 (S) |
| Navigation | Home → Projects → Library → Home → Projects, Back; account menu open, Escape, outside click; sign out; sign out with unsaved edits and "Keep editing"; Tab through Home (S); Home → Projects with a timing recorder (P) |
| Projects | Card hover (S, P); card menu; Delete dialog and Escape; search typing, no match, clear; Sort; reload with a 3 s API delay; delete confirmed, twice, on projects this pass created (S; 1440) |
| Library | Load; both tabs; View details; card hover (S) |
| Plans | Load; Upgrade and the "payments unavailable" answer (S) |
| Settings | Load; both tabs; Save changes; Save while offline; Delete account dialog and Escape (S) |
| Brand conversation | Open from a Projects card; direct load (Kestrel, Brightsmile, Spokesmith, Northern Lights, Quill, Tidewater, Mosswood, Bérénice); pill steps Strategy, Voice, Identity, Assets (1440; at 390 the steps have no names to click by); project switcher; Change name; choice-card hover and check; competitor check and uncheck; Tab through the page (S) |
| Inspiration | Card and tile hover (1440); like and unlike; open brand view, Escape; Show more brands; failed upload and Cancel upload (1440) (S) |
| Logo | Card hover; Continue from Inspiration; logo-type toggle; all types off (disabled Explore); Explore with no credits, out-of-credits prompt, Not now; Retry with no credits; select a concept, switch to another; refine composer focus; Refine with no credits (1440); More concepts with slowed images, the drawing state, Stop, with normal and reduced motion (1440) (S) |
| Creative direction | Card hover; larger view and Escape; choose a direction; Continue to Assets for the first time (1440) (S) |
| Assets | Load to "Ready"; copy a colour; Download brand kit (S) |
| Research | New brief with the stand-in held: start, running, Cancel, with normal and reduced motion (1440) (S) |
| Performance | Frame rate during research, logo drawing and scrolling, at normal speed and with the processor slowed 4x (S; scrolling also at 390) |
| Every route | Hover, forced press and forced keyboard focus on one sample of every kind of control, 26 route states × 2 widths (S) |

## 11. Recap

**Counts.** 20 findings.

| | P0 | P1 | P2 | P3 | Total |
| --- | --- | --- | --- | --- | --- |
| Execution fix | 0 | 4 | 10 | 1 | 15 |
| Needs redesign | 0 | 1 | 3 | 1 | 5 |
| Total | 0 | 5 | 13 | 2 | 20 |

By category: motion 6 (M-002, M-003, M-004, M-013, M-017, M-018), feedback 5 (M-006, M-007, M-014, M-015, M-016), interaction state 5 (M-001, M-005, M-010, M-011, M-012), performance 4 (M-008, M-009, M-019, M-020).
P1: M-012, M-013, M-014, M-016, M-019. Needs redesign: M-002, M-005, M-006, M-013, M-017.
Systemic or probably systemic: 17 of 20 (all except M-012, M-019 and M-020; M-005 only in part).

**Links to pass 1.** M-012 explains E-050 and suggests it is development-only. M-013 and M-014 add timing to E-032 and E-052. M-015 is the behaviour side of E-051. M-007 includes E-002. M-019 is the arrival of the page E-042 to E-047 describe.

**Files written.**

- `design-audit/02_motion_interaction.md` (this file).
- `design-audit/animation-plans/` : `README.md` and plans 001 to 005. None applied.
- `design-audit/tools/` : `motion-probe.mjs`, `walk-lib.mjs`, `walk-1-shell.mjs`, `walk-2-brand.mjs`, `walk-3-live.mjs`, `contact-sheet.mjs`, `build-motion-evidence.sh`.
- `design-audit/evidence/annotated/` : `M-003` to `M-010`, `M-012` to `M-016`, `M-018`, `M-019` (16 images; M-013 has a second one for 390).
- `design-audit/evidence/motion/` : `probe.json`, `probe-summary.md`, `walk-*.json`, `walk-*.txt`, `frames/` (about 970 JPEG frames, 44 MB).

No application code, configuration or dependency was changed.

**Gaps.**

| Not done | Why |
| --- | --- |
| Seed reset before starting | Stopping the running audit server was blocked by this session's safety settings, and the seed will not run while the app is up. Replaced by the read-only verify (35 of 35 passed before testing). |
| `review-animations` skill | Locked to manual use. Its rules were applied through the `improve-animations` catalogue (section 5). |
| A finished concept arriving after a normal-speed generation | After "Stop", "More concepts" stayed disabled for the rest of the scenario, so the follow-up run never started. M-017 rests on page loads and code. |
| Names, slogans and directions in progress; "step unavailable"; "today's limit" | They need credits on audit-free or database switches, and would have moved more seeded brands forward without a reseed to follow. They share the polling pattern and the "thinking" indicator covered in M-006 and M-016. |
| Answering a strategy question and watching it fold to one line | Continue starts AI work on audit-free (no credits). |
| Name preview dialog, Generation activity dialog, context details sheet, voice-input panel, changing the Sort value, Library filters and its Like and Save buttons, restoring a deleted project, account data export | Not reached in the time available. The dialogs share the "appears in one frame" behaviour by code (no transition is defined for any dialog). Library's Like button could not be hovered by the probe (something covers it); worth a look in pass 3. |
| Pill step links at 390 | The steps have no visible names at that width, so the script could not find them by name. Not tested. |
| Sign-up success, new password, email flows | Would create accounts or emails. The pending states were tested with script-answered requests. |
| `error.tsx` screens, Stripe pages | Not reachable locally (inventory section 7). |
| A real phone | All measurements are from desktop Chromium, including the 390 runs. |
| Production build | Timings are from the development server. M-012 in particular must be re-checked on the production build. |
| Deleting stale test frames | `evidence/motion/frames/` contains some duplicate frames from the first trial runs (names ending in odd millisecond values). A safety check blocked removing them; they are harmless and can be deleted by hand. |

**Seed data: reset after this pass.** The live tests changed some seeded brands (`verify.mjs` reported 33 of 35 afterwards): Quill had a chosen concept, Mosswood a chosen direction and built assets, Fromagerie Bérénice Côté reopened on the Logo step, Maison Aurélie and Bright Harbor Learning each had an extra stopped logo batch, and two "Untitled brand" research projects were in audit-pro's Deleted projects. Once the owner approved stopping the server, `node design-audit/seed/seed.mjs` was run (11 brands rebuilt, 19 cached showcase images reused, no real image generated), `serve.mjs` was started again, and `verify.mjs` passed 35 of 35. Brand ids changed with the reseed (`.logs/last-seed.json` has the new ones), so project URLs in this pass's logs no longer open.

No real AI request was made and no email was sent at any point. The stand-in AI is in normal mode.
