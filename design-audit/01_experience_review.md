# Design audit, pass 1: experience review

Status: **complete for pass 1** (see the recap at the end for what could not be reviewed).
Environment: local stack only (`http://127.0.0.1:3105`, stand-in AI). Date: 2026-11-11. The seed reset was run at the start of this pass.

How to read a finding. Each block has an ID (E-001, E-002, …), where it is, a category, a severity and a tag.

- **Severity:** P0 blocks or breaks a task. P1 hurts trust or completion. P2 is noticeable polish. P3 is nice to have.
- **Tag:** *needs redesign* means a new visual or interaction decision is required (goes to Claude Design). *Execution fix* means the right answer is already clear (goes straight to implementation).
- **Heuristic** means one of Nielsen's ten usability heuristics, cited by name.
- **Evidence** paths are relative to `design-audit/evidence/`. Screens are in `screens/` and named `<route>__<state>__<width>.png`.
- **"AI default"** means a look that appears on generated pages whatever the subject (the frontend-design skill's list), so it reads as a template instead of a choice.

The yardstick is the Direction in `README.md`: an audience of founders, small businesses and freelancers or agencies, most of them not designers; and a feel that is minimal and premium, calm and precise, where the person's own brand is the most colourful thing on screen.

## 1. Gaps found in inventory

`00_inventory.md` was checked against the router code (`src/app/**`) and the running app. Its route list is complete: every page file in the router is listed, and the redirects behave as described. These are the differences found.

| # | Gap | What was done |
| --- | --- | --- |
| 1 | A third error screen exists and is not listed: `src/app/brands/account/[projectId]/error.tsx` (a project-level crash screen, besides `error.tsx` and `global-error.tsx`). | Read in source only; like the other two it cannot be triggered without changing code. |
| 2 | Library's detail view is listed as "could not reach", yet a file `screens/library__asset-detail-dialog-pro__*.png` exists and shows only the list. | Checked live: the control does nothing at all. Recorded as finding E-050 with `annotated/E-050.png`. |
| 3 | The larger view of a creative-direction board (the expand icon) was not captured. | Opened live; captured as `annotated/E-051-larger-view.png` and `annotated/E-052-checking-private-preview.png`. |
| 4 | The Inspiration "Open brand" view was not captured. | Opened live; captured as `annotated/E-054.png`. |
| 5 | The brand menu in the project pill ("Switch project": All projects, New project, Home) was not captured. | Captured as `annotated/E-053.png`. |
| 6 | The state of a brand while it reopens (faded page, wrong step highlighted, "Private board preview" placeholders, landing position) is not in the inventory, because the capture script waits for everything to load. | Observed live at 390 and 1440; captured as `annotated/E-052.png` and `annotated/E-052-390-lands-mid-gallery.png`. |
| 7 | Hidden controls: each logo card contains "Select concept" and "Compare concept" buttons with zero size. The inventory lists "Compare concept" as merely "not explored". | Measured live; recorded in E-051. |
| 8 | The audit README says a missing project shows "This project is not available to this account." The capture shows "Opening your project. Your saved work could not be checked." instead. | Reviewed as captured (E-040). |
| 9 | Sign-in in the Browser pane: the inventory says Enter submits and a click does not. In this pass the opposite happened twice (Enter did nothing; clicking the button signed in). | Not resolved; listed under "Could not review". It may be the pane, not the app. |
| 10 | Counts: the inventory says 94 states; the screens folder holds 96 state names (277 files). | No action needed. |

States the inventory lists as not captured, and that are still not reviewed, are listed in the recap at the end.


## 2. Executive summary

Embel's structure is sound and its surface is calm. A person can go from an idea to a downloadable kit without getting lost, the palette stays out of the way, and most of the copy is plain. What holds it back from "top-tier" is not the bones; it is how the work is shown, how the end of the journey delivers, and how often the system talks about itself. There are 56 findings: 2 at P0, 23 at P1, 23 at P2 and 8 at P3.

The five issues that most hold back a top-tier feel:

1. **The product undersells its own output, and the ending is the weakest part.** Logos and direction boards are shown at thumbnail size in a narrow column (E-033). The assets that follow a rich direction board are one fixed template with two circles, the same for every brand (E-042); the board itself can show a different logo from the one chosen (E-043); the guidelines are one sentence per topic on screen and an unstyled web page as a file (E-044, E-046); banners have decoration running through the brand name (E-047). People judge the product by what they download.
2. **The two decisions that matter most have no clear controls, on a page that is too long.** Logo and direction cards have no label, no "Choose" button and no hover state, and compare is hidden (E-051). A finished brand is a 5,400 px page with other companies' artwork permanently open in the middle (E-032), which reopens at an unpredictable place (E-052). Direction cards break the brand name mid-word (E-034).
3. **The system describes itself instead of the person's situation.** "Check AI availability", "The saved project could not be verified", "requests cancellation of active work", "Kept assets / All generations", "tokens used", "Checking private preview…" (E-002, E-019, E-023, E-029, E-040, E-052). The same thing has up to four names (project or brand; direction board, brand board or identity images).
4. **Credits are invisible until they block you, and Plans does not explain what they buy.** No balance in the navigation, no cost on AI buttons (E-006); running out produces three overlapping messages and two different renewal dates (E-037); Plans lists numbers with no meaning and breaks at phone width (E-025, E-026); Usage counts tokens and omits images (E-029).
5. **Trust gaps at the edges.** Two controls are broken outright: Library's "View details" does nothing (E-050) and account deletion fails for most accounts (E-028). There are no Terms, Privacy or Help links anywhere (E-011). The signed-out Home, the only landing page, shows no example of the result (E-001). Failure screens fall back to raw text (E-009, E-040). And the visual identity, while tidy, is the generic "AI tool" kit, not something recognisably Embel (E-055).

What is already good and should be kept: the four-step journey and its conversational pacing; answered questions folding to one line; the Strategy summary card; honest, specific copy in the password flows; reversible delete; partial-failure recovery for logos ("Retry 2 failed concepts"); the large inspiration brand view (E-054), which is the quality bar for the rest; and the two emails.


## 3. Findings

### 3.1 Home (`/`)

What works: the page is calm, the headline and composer are the clear first read, the ink-on-paper palette leaves room for the person's brand, and the placeholder "An idea you can't stop thinking about…" has a human voice. The signed-in "Pick up where you left off" row gives a real next action on each card ("Compare 3 directions", "View brand kit").

**E-001. Signed-out Home shows no proof of what Embel makes**
- Screen: `/` signed out, 390, 768 and 1440.
- Category: hierarchy (also imagery, layout)
- Severity: P1
- Tag: needs redesign
- What's wrong: this is the only landing page, and it is a headline, one sentence, a text box and three chips. Below the chips, about 55% of a 1440×900 window (and more at 768) is empty dot grid. Nothing shows a logo, a direction board or a brand kit, so a visitor must sign up before seeing any result. There is no price, no "free to start", and no link to Plans in the page body.
- Why it matters: a first-time visitor decides in seconds whether the output is worth an account. "Premium" is claimed by the chrome but never demonstrated. Heuristic: *recognition rather than recall* (show the outcome instead of asking the visitor to imagine it).
- Suggested direction: keep the composer as the hero, and use the empty lower half for real output: one finished brand (logo, palette, board, social tiles) shown large and quiet, or a short row of finished brands. Add one line that says it is free to start with 30 credits. The showcase brands already in the seed are the right kind of content.
- Evidence: `screens/home__signed-out__1440.png`, `screens/home__signed-out__768.png`, `screens/home__signed-out__390.png`
- Systemic? No.

**E-002. A diagnostic link and a stray note appear under the composer once you type**
- Screen: `/` signed out, prompt filled, all widths.
- Category: copy (also layout)
- Severity: P1
- Tag: execution fix
- What's wrong: after typing, two left-aligned grey lines appear under the composer: "Sign in to save your project. Your prompt is kept." and a link, "Check AI availability". They push the centred starter chips down by about 100 px. "Check AI availability" is a system check, shown to a visitor who has not done anything wrong; the related messages in code say "Sending checks AI availability for your new project. Earlier requests keep their own status."
- Why it matters: it exposes plumbing on the first screen and makes the product sound unreliable before the first click. Heuristic: *match between the system and the real world*; *aesthetic and minimalist design*.
- Suggested direction: signed out, show one short line at most ("You'll sign in before we start. Your idea is kept."). Show an availability message only when AI really is unavailable, in plain words ("Embel can't start new brands right now. Try again in a few minutes."), with one Retry button. Reserve the space so the chips do not jump.
- Evidence: `screens/home__signed-out-prompt-filled__1440.png`, `screens/home__signed-out-prompt-filled__390.png`; source `src/components/workspace/account-strategy-start.tsx:470-494`
- Systemic? Yes: system vocabulary in customer copy also appears in E-007, E-009 and the project screens (see section 4).

**E-003. The composer's "+" and microphone say nothing about what they do, and the disabled send button is faint**
- Screen: `/`, all states and widths; the same composer is reused at the bottom of every project.
- Category: components
- Severity: P2
- Tag: execution fix
- What's wrong: the "+" and microphone are bare icons with no visible label and no tooltip on hover. The disabled send button is a white arrow on mid-grey, which reads as a decoration. Keyboard focus on the text box only darkens the border; there is no ring, unlike every other control (which gets a 2 px ink outline).
- Why it matters: a non-designer cannot guess that "+" attaches reference images or that the microphone dictates on the device. Heuristic: *recognition rather than recall*; *consistency and standards*.
- Suggested direction: give both icons a tooltip and an accessible name that says the outcome ("Add reference images", "Dictate"). Use the same focus ring as other controls. Give the disabled send button a clearer disabled look (outline or lighter fill with a visible arrow).
- Evidence: `screens/home__signed-out__1440.png`, `screens/home__signed-out-prompt-focus__1440.png`, `screens/home__keyboard-focus-nav__1440.png`
- Systemic? Yes: the composer on every project conversation.

**E-004. A new account is told to "Pick up where you left off"**
- Screen: `/` signed in, new account (no brands), all widths.
- Category: copy
- Severity: P2
- Tag: execution fix
- What's wrong: the section heading "Pick up where you left off" and the link "All projects →" sit above an empty card that says "Your first brand starts here. Describe your idea above. Your saved work will appear here." The page headline already says "Your next brand starts here." So the page says the same thing twice and one heading is untrue.
- Why it matters: the first signed-in screen should point at one action. Heuristic: *aesthetic and minimalist design*.
- Suggested direction: with no brands, hide the section, or replace it with a quiet three-step preview of the journey (Strategy, Voice, Identity, Assets) so the new person knows what comes next. Greet a new account once ("You have 30 credits to start").
- Evidence: `screens/home__empty-fresh__1440.png`, `screens/home__empty-fresh__390.png`
- Systemic? No.

**E-005. Cards for brands in progress say "No logo yet" beside "Choose a logo"**
- Screen: `/` and `/brands`, brands before a logo is chosen (Quill, Tidewater, and earlier stages), all widths.
- Category: components (also hierarchy)
- Severity: P2
- Tag: needs redesign
- What's wrong: when no logo is chosen, the card's picture area is a grey box holding three clipped lines of the brief and a "No logo yet" chip. Quill has six finished concepts and Tidewater has four, yet both show "No logo yet" directly above the action "Choose a logo". The round "…" button sits on top of the brief text.
- Why it matters: the card under-reports progress, and half the grid looks unfinished. Heuristic: *visibility of system status*.
- Suggested direction: design one in-progress card: show what exists (a strip of the concepts, or the name set in type for brands with only a name), and a small stage label that matches the action ("6 concepts to choose from"). Keep the brief out of the picture area.
- Evidence: `screens/home__recent-brands-free__1440.png`, `screens/home__recent-brands-free__390.png`, `screens/projects__eight-brands-free__1440.png`
- Systemic? Yes: Home and Projects use the same card.

**E-006. Remaining credits are not visible anywhere outside Settings and Plans**
- Screen: navigation pill and account menu, every signed-in screen.
- Category: navigation/IA
- Severity: P1
- Tag: needs redesign
- What's wrong: every AI step costs credits, but the pill and the account menu show neither the plan nor the balance. The only places that state "credits left this month" are the plan card in Settings and the Plans page (`src/components/billing/plan-credits-card.tsx:35`). A free account at 0 credits learns it only by clicking an AI button and getting the out-of-credits prompt.
- Why it matters: people cannot plan their work, and the first sign of a limit is a blocked action. Heuristic: *visibility of system status*; *error prevention*.
- Suggested direction: show plan and balance in the account menu ("Pro · 112 credits left"), and show the cost on or beside each AI button in a project ("Explore six concepts · 6 credits"). Credits only, never money.
- Evidence: `screens/home__account-menu-open-pro__1440.png`, `screens/brand-conversation__out-of-credits-prompt-free__1440.png`
- Systemic? Yes: every screen with an AI action.

**E-007. "Generation activity" lists raw requests, six rows for one click**
- Screen: `/` → account menu → Generation activity (dialog), signed in, 1440.
- Category: components (also copy)
- Severity: P2
- Tag: needs redesign
- What's wrong: the dialog is a flat list of about 20 identical rows. One click on "Explore six concepts" produces six separate "Logo concepts · Done" rows for the same brand. Row types use internal names ("Identity images", "Logo refinement") that do not match the journey's words (Creative direction, Refine). Every row says "Done" in the same grey, so a running or failed request would not stand out. The helper text explains the panel's mechanics ("Closing this panel doesn't stop work in progress").
- Why it matters: the panel exists to answer "is anything still running, and did anything fail?" and it buries that answer. Heuristic: *match between the system and the real world*; *recognition rather than recall*.
- Suggested direction: group by brand and by action ("Kestrel Analytics · Six logo concepts · Done"), put running and failed items first with a clear status mark, use the journey's own names, and rename the entry to plain words such as "Activity".
- Evidence: `screens/home__generation-activity-dialog-pro__1440.png`, `screens/home__generation-activity-dialog-pro__390.png`
- Systemic? No.

**E-008. The navigation pill changes its contents and width after each page load**
- Screen: every page, first one to two seconds after load.
- Category: navigation/IA
- Severity: P2
- Tag: execution fix
- What's wrong: until the session check finishes, the pill shows a placeholder account icon; then it becomes "Sign in / Create account" or the avatar, and the pill changes width around its centre. The wrong-password capture caught the placeholder icon on a signed-out page. The inventory pass also measured about 2 seconds with no Sign in link.
- Why it matters: the one persistent element of the app visibly jumps on every navigation, which is the opposite of calm and precise. Heuristic: *consistency and standards*.
- Suggested direction: reserve the final width and render the right state on first paint (the server already knows whether a session cookie exists), or fade the account area in without moving the other items.
- Evidence: `screens/sign-in__error-wrong-password__1440.png` (pill shows an account icon while signed out) compared with `screens/sign-in__default__1440.png`
- Systemic? Yes: all pages.

**E-009. A failed research run leaves an empty page with the error docked to the composer**
- Screen: new project, research failed, 390 and 1440.
- Category: flow (also hierarchy, copy)
- Severity: P1
- Tag: needs redesign
- What's wrong: when research fails, the "Researching your competitors" card disappears. The person's message stays at the top, the middle of the page is blank, and a pink strip is attached to the top of the composer at the bottom: "Research could not produce verified suggestions. Your prompt is saved. You can retry research." The two actions, "Check status" and "Retry research", are small grey text with no button shape. "Check status" does not say what it checks.
- Why it matters: this is the first thing a new customer sees if the first AI step fails, and the recovery is easy to miss. Heuristic: *help users recognize, diagnose, and recover from errors*.
- Suggested direction: keep the failure in the conversation where the progress card was, as a card from Embel: what happened in plain words, one primary button "Try again", and whether credits were used. Drop "Check status" or fold it into the retry.
- Evidence: `screens/home__research-failed-pro__1440.png`, `screens/home__research-failed-pro__390.png`
- Systemic? Yes: error strips docked to the composer are used elsewhere in the project conversation (see 3.8).

**E-010. Research in progress gives no sense of how long, and the 390 composer clips its placeholder**
- Screen: new project, research in progress, 390 and 1440.
- Category: components (also responsiveness)
- Severity: P2
- Tag: execution fix
- What's wrong: the progress card shows a thin grey bar and "Suggestions appear here when they're ready", with no expected time and no sign of what is happening. At 390 the composer placeholder "Reply in your own words, or ask a question…" wraps to a second line that is cut off by the box.
- Why it matters: research is the first wait in the product; an unexplained wait feels longer. Heuristic: *visibility of system status*.
- Suggested direction: say roughly how long it takes ("Usually under a minute") and name the stage ("Reading competitor sites"). Shorten the placeholder at narrow widths so it fits on one line.
- Evidence: `screens/home__research-in-progress-pro__1440.png`, `screens/home__research-in-progress-pro__390.png`
- Systemic? Yes: the composer placeholder clip affects every project page at 390.

### 3.2 Sign in, create account and password reset (`/sign-in`, `/sign-up`, `/forgot-password`, `/reset-password`, and the overlay on Home)

What works: one card, one job, real labels above fields, a show-password control, the password rule stated before typing ("Use at least 12 characters"), and honest reset copy ("If an account uses this address…"). The overlay keeps the typed idea.

**E-011. Creating an account shows no Terms or Privacy link, and the app has no help or contact link at all**
- Screen: `/sign-up` (page and overlay), `/plans`, account menu; all widths.
- Category: flow
- Severity: P1
- Tag: execution fix
- What's wrong: the sign-up form has no terms or privacy notice. A search of the app's source finds no link to terms, privacy, support, help or a contact address on any screen, including Plans, where people pay.
- Why it matters: paying customers and agencies look for these before entering a card or a client's idea; their absence reads as unfinished. Heuristic: *help and documentation*.
- Suggested direction: one quiet line under the Create account button ("By creating an account you agree to the Terms and Privacy Policy"), the same two links plus "Help" in the account menu and at the foot of Plans. The documents themselves are outside this audit.
- Evidence: `screens/sign-up__default__1440.png`, `screens/home__signed-out-sign-up-overlay__390.png`, `screens/plans__signed-out__1440.png`, `screens/home__account-menu-open-pro__1440.png`
- Systemic? Yes: sign-up, Plans, account menu.

**E-012. Success and failure notices on the account screens look like ordinary helper text**
- Screen: `/sign-in?confirmation=…` (confirmed and failed), `/forgot-password` sent; all widths.
- Category: hierarchy (also copy)
- Severity: P1
- Tag: execution fix
- What's wrong: after confirming an email, the person lands on Sign in with a grey paragraph: "Your confirmation link was processed. Check your account or sign in to continue." It has the same colour and size as the subtitle above it. The failed-link version is four grey sentences in the same style, with "Request another confirmation email" as faint centred text. "Check your email" has three grey text blocks and a faint "Send another link".
- Why it matters: this is the moment a new customer arrives from their inbox. "Was processed" does not say whether it worked. Heuristic: *visibility of system status*; *help users recognize, diagnose, and recover from errors*.
- Suggested direction: use the positive and warning styles the app already has. Success: "Email confirmed. Sign in to start your first brand." Failure: one sentence on what happened, one on what to do, and a real secondary button for "Send a new confirmation email".
- Evidence: `screens/sign-in__email-confirmed-notice__1440.png`, `screens/sign-in__email-confirmation-failed-notice__1440.png`, `screens/forgot-password__sent__1440.png`
- Systemic? Yes: status messages styled as secondary text recur across the app (section 4).

**E-013. Sign-up validation is the browser's own tooltip**
- Screen: `/sign-up` with a short password or a mismatched confirmation, all widths.
- Category: components
- Severity: P2
- Tag: execution fix
- What's wrong: a short password produces the browser's native bubble ("Please lengthen this text to 12 characters or more (you are currently using 5 characters)"), with the browser's orange icon and font. It appears on one field at a time, so the mismatch is only reported after the length is fixed.
- Why it matters: it is the one place on the screen that is not Embel's design or voice, at the point of commitment. Heuristic: *error prevention*; *consistency and standards*.
- Suggested direction: inline messages under each field in the app's own error style, shown when the field loses focus: "Use at least 12 characters" and "The two passwords don't match".
- Evidence: `screens/sign-up__validation-password-mismatch__1440.png`, `screens/sign-up__validation-password-mismatch__390.png`
- Systemic? No (Settings uses its own inline messages).

**E-014. Sign-in errors appear below the button, and a failed attempt wipes the password**
- Screen: `/sign-in` and `/forgot-password`, error states, all widths.
- Category: layout
- Severity: P2
- Tag: execution fix
- What's wrong: "We couldn't sign you in with those details…" and "Too many reset requests…" appear under the primary button, after the thing the person just pressed, and push the "Create account" line down. The password field is emptied on failure. The audit's setup notes also record typed text being cleared shortly after page load in the Browser pane (README issue 2).
- Why it matters: errors belong next to their cause and above the action, where the eye already is. Heuristic: *help users recognize, diagnose, and recover from errors*.
- Suggested direction: place the message above the fields or directly under the field at fault, keep focus in the password field, and never clear what the person typed before they submit.
- Evidence: `screens/sign-in__error-wrong-password__1440.png`, `screens/forgot-password__error-rate-limited__1440.png`
- Systemic? No.

**E-015. The account cards mix alignments and button widths**
- Screen: all account screens and the overlay, all widths.
- Category: consistency
- Severity: P3
- Tag: execution fix
- What's wrong: headings and fields are left-aligned, while "New to Embel? Create account", "Send another link" and "Return to Home" are centred. Primary buttons are full width on forms but hug their label on "This link has expired" and "Your password is updated". The overlay over Home includes "Return to Home →" although Home is the page underneath and a close button is present. The pill above the Sign in page still offers "Sign in" and "Create account".
- Why it matters: small inconsistencies in the simplest screens set expectations for the rest. Heuristic: *consistency and standards*.
- Suggested direction: one alignment per card (left), one primary button width, drop "Return to Home" from the overlay, and hide the pill's account buttons on account pages.
- Evidence: `screens/sign-in__default__1440.png`, `screens/reset-password__error-link-expired__1440.png`, `screens/reset-password__saved__1440.png`, `screens/home__signed-out-sign-in-overlay__1440.png`
- Systemic? No.

### 3.3 Page not found and error screens

**E-016. The 404 page is correct but generic; the app's two crash screens could not be seen**
- Screen: any unknown URL, 390 and 1440. `error.tsx`, `global-error.tsx` and `brands/account/[projectId]/error.tsx` were read in source only.
- Category: copy
- Severity: P3
- Tag: execution fix
- What's wrong: "Page not found. This link may be old, or the page may have moved." with one "Back to Home" button. Signed in, the more likely need is Projects. The global crash screen uses inline styles and a system font, so it will not match the app.
- Why it matters: error pages are rare but are seen at the worst moment. Heuristic: *help users recognize, diagnose, and recover from errors*.
- Suggested direction: offer "Go to Projects" as well when signed in, and style the crash screens with the same type and button as the 404.
- Evidence: `screens/not-found__default__1440.png`, `screens/not-found__default__390.png`; source `src/app/global-error.tsx`
- Systemic? No.

### 3.4 Projects (`/brands`) and Deleted projects (`/brands?state=deleted`)

What works: the page is easy to scan, each card names the next step in plain words ("Compare 3 directions", "Review competitors"), search has a proper no-match state with "Clear search", loading uses skeleton cards the same size as real ones, and delete is reversible.

**E-017. Two brands are both called "Untitled brand", and six of eight cards look unfinished**
- Screen: `/brands`, free account with eight brands, all widths.
- Category: hierarchy
- Severity: P2
- Tag: needs redesign
- What's wrong: brands without a chosen name all show "Untitled brand"; two sit side by side and can only be told apart by reading the grey brief excerpt. Six of the eight cards carry the same "No logo yet" grey box (see E-005). Every card says "Today", so the date adds nothing. The 76-character name is cut after "Northern Lights Community …" although the card has room for two lines.
- Why it matters: Projects is the screen an agency user lives in; brands must be distinguishable at a glance. Heuristic: *recognition rather than recall*.
- Suggested direction: give unnamed brands a working title taken from the brief ("Bike repair, Montreal"), allow two lines for names, show relative time ("2 hours ago") and a small four-step progress mark so stage is visible without reading.
- Evidence: `screens/projects__eight-brands-free__1440.png`, `screens/projects__eight-brands-free__390.png`
- Systemic? Yes: Home recent cards; the project pill also shows "Untitled brand".

**E-018. The "…" menu on a card holds one item, Delete**
- Screen: `/brands` and Home cards → Project options, all widths.
- Category: components
- Severity: P2
- Tag: needs redesign
- What's wrong: every card carries a 36 px round "…" button over its picture. It opens a menu with a single red item, "Delete". There is no rename, duplicate or "open at step". The menu covers the logo.
- Why it matters: the most prominent control on every card leads only to a destructive action, and it competes with the logo for attention. Freelancers and agencies will expect rename and duplicate. Heuristic: *flexibility and efficiency of use*; *aesthetic and minimalist design*.
- Suggested direction: either add the expected actions (Rename, Duplicate, Delete), or remove the button from the picture and reveal a quiet control on hover or focus in the card's text row.
- Evidence: `screens/projects__options-menu-open-free__1440.png`, `screens/projects__options-menu-open-free__390.png`
- Systemic? Yes: Home recent cards.

**E-019. The delete dialog explains the system instead of the consequence**
- Screen: `/brands` → Delete, all widths.
- Category: copy
- Severity: P1
- Tag: execution fix
- What's wrong: the body reads "This moves the project to Deleted projects and requests cancellation of active work. Work already started may still finish or incur usage. Its assets and history are kept. Restoring won't restart cancelled AI work." The confirm button is "Stop active work and delete project", shown even when nothing is running. "Incur usage" hints at a charge without saying what.
- Why it matters: a confirmation should say what happens to the person's work in one breath. This one makes a reversible action sound risky and vague. Heuristic: *match between the system and the real world*; *error prevention*.
- Suggested direction: "Delete "Orchard Lane Cider"? It moves to Deleted projects. You can restore it any time." Buttons: "Delete project" / "Cancel". Add one extra sentence only when work is running ("Logo concepts in progress will be stopped. Credits already used are not returned.").
- Evidence: `screens/projects__delete-dialog-free__1440.png`, `screens/projects__delete-dialog-free__390.png`
- Systemic? Yes: the Deleted projects subtitle repeats "Restoring won't restart cancelled AI work."

**E-020. Page titles and words change between states: "Projects." / "Your projects.", project / brand**
- Screen: `/brands` (signed in, empty, signed out), `/assets`, Home cards, project pill.
- Category: consistency (copy)
- Severity: P2
- Tag: execution fix
- What's wrong: the heading is "Projects." with brands and "Your projects." when empty or signed out. Headings end in a full stop here and in Library ("Your visual library.") but not in Plans or Settings. The same object is a "project" (Projects, New project, Delete project), a "brand" (Untitled brand, "Your first brand starts here", View brand kit) and, in a recovery link, an "account brand". The empty state says "Start with a complete brand, a name, or a visual identity", which describes separate starting points that the product no longer offers. The subtitle "Every idea, in its own world." is a slogan, not information.
- Why it matters: one name per thing is how people learn an interface. Heuristic: *consistency and standards*.
- Suggested direction: choose one noun (the product makes brands, so "Brands" is the natural word) and use it in navigation, headings, buttons and dialogs. One heading style without full stops. Rewrite the empty state to match the single journey: "No brands yet. Describe an idea and Embel builds the name, logo and look with you."
- Evidence: `screens/projects__eight-brands-free__1440.png`, `screens/projects__empty-fresh__1440.png`, `screens/projects__signed-out__1440.png`, `screens/library__kept-assets-pro__1440.png`
- Systemic? Yes: all list pages, dialogs and the project pill.

**E-021. Signed-out list pages are a heading and two buttons in the top-left corner**
- Screen: `/brands`, `/assets` signed out, all widths.
- Category: layout
- Severity: P3
- Tag: execution fix
- What's wrong: "Your projects. Sign in to see your projects." with two small buttons, left-aligned at the top of an otherwise empty page, while the pill above repeats the same two buttons.
- Why it matters: it looks like a page that failed to load. Heuristic: *aesthetic and minimalist design*.
- Suggested direction: send signed-out visitors to the sign-in overlay and return them to the page afterwards, or centre a single card in the style of the empty states.
- Evidence: `screens/projects__signed-out__1440.png`, `screens/library__signed-out__1440.png`
- Systemic? Yes: Library, Plans footer, Settings (E-031), project workspace.

**E-022. The load-failure strip and the empty Deleted page use weaker patterns than the rest of the page**
- Screen: `/brands` with the API failing; `/brands?state=deleted` empty; 1440.
- Category: components
- Severity: P3
- Tag: execution fix
- What's wrong: the failure is a full-width pink strip with square corners (every other surface is rounded) and a red-text button "Try loading projects again". Deleted projects shows "Back to projects" twice, once as a button and once as faint text inside the empty card.
- Why it matters: error and empty states are where consistency is noticed. Heuristic: *consistency and standards*.
- Suggested direction: one error card pattern (rounded, icon, sentence, "Try again") used on every list page; one "Back to projects" control.
- Evidence: `screens/projects__error-api-500-free__1440.png`, `screens/projects-deleted__empty-free__1440.png`
- Systemic? Yes: error strips across the app (section 4).

### 3.5 Library (`/assets`)

What works: real output finally fills the screen, the grid is even, and filters by project and format exist.

**E-023. Library uses three names for one thing and words from the engine**
- Screen: `/assets`, both tabs, all widths.
- Category: copy (also navigation/IA)
- Severity: P1
- Tag: needs redesign
- What's wrong: the tabs are "Kept assets" and "All generations". A creative-direction board is labelled "Brand board" here, "Identity images" in Generation activity, "Creative direction" in the journey and "selected-direction.png" in the kit, while the Assets page uses "brand board" for a different, composed image. Every logo card is titled just "Logo", so 20 cards share one title with no concept number or date. "Used in brand" is the only status. A manual "Refresh" control sits at the top right.
- Why it matters: the person cannot tell which image is their chosen logo, which board is which, or why two different pictures are both "Brand board". Heuristic: *match between the system and the real world*; *consistency and standards*.
- Suggested direction: decide what Library is for (most likely: "everything Embel has made for you, by brand") and name things with the journey's words: Logo concept 3, Direction board 2, Brand board. Mark the chosen ones clearly ("Chosen logo"). Rename the tabs (for example "In your brands" and "Everything made"), and remove Refresh by updating the list automatically.
- Evidence: `screens/library__kept-assets-pro__1440.png`, `screens/library__all-generations-pro__1440.png`, `screens/home__generation-activity-dialog-pro__1440.png`
- Systemic? Yes: Generation activity, Assets page, export file names.

**E-024. "All generations" is one long ungrouped wall**
- Screen: `/assets` → All generations, 390 and 1440.
- Category: layout (also responsiveness)
- Severity: P2
- Tag: needs redesign
- What's wrong: items from different brands are interleaved with no headings, dates or order the eye can follow (Bright Harbor, Maison Aurélie and Kestrel alternate). Boards are letterboxed inside grey frames while logos fill theirs, so the grid looks uneven. At 390 the list is a single column about 10,000 px tall, with one full-width card per logo.
- Why it matters: with a few brands the page is already hard to scan; an agency account will have hundreds of items. Heuristic: *recognition rather than recall*; *flexibility and efficiency of use*.
- Suggested direction: group by brand with a heading and count, newest first, logos as a compact grid (two or three across on a phone), and one consistent thumbnail treatment.
- Evidence: `screens/library__all-generations-pro__1440.png`, `screens/library__all-generations-free__390.png`
- Systemic? No.

### 3.6 Plans and credits (`/plans`, the out-of-credits prompt)

What works: three plans, plain prices, the current plan is marked, the balance and renewal date are stated at the top, and the failure message says "Nothing was charged."

**E-025. At 390 the three plan cards stay side by side and break**
- Screen: `/plans`, all states, 390.
- Category: responsiveness
- Severity: P1
- Tag: execution fix
- What's wrong: on a phone the three cards do not stack. Each is about 100 px wide, so text wraps to one or two words per line, the "Current plan" badge spills out of its card, "/ month" is cut off after the price, and the upgrade buttons become round blobs with clipped labels ("Upgrade to Studio" is cut on both sides). The summary card's renewal note wraps to five lines.
- Why it matters: this is the screen where people pay, and the out-of-credits prompt sends phone users straight to it. It is the most visibly broken screen in the audit. Heuristic: *aesthetic and minimalist design*; *error prevention* (a clipped price next to a pay button).
- Suggested direction: stack the cards below about 760 px, current plan first, full-width buttons.
- Evidence: `screens/plans__free-0-credits-upgrade-free__390.png`, `screens/plans__pro-current-pro__390.png`
- Systemic? No (other pages stack correctly).

**E-026. Plans sells a number, not an outcome**
- Screen: `/plans`, all accounts, all widths.
- Category: hierarchy (also copy)
- Severity: P1
- Tag: needs redesign
- What's wrong: each plan card says only "150 credits every month" and one line ("For building a brand from idea to assets."). Nothing says what a credit buys: how many logo rounds, or how many complete brands, fit in 30, 150 or 500. The three cards look identical except for the numbers, so nothing guides the choice, and the page has no visual link to the product (no brand output, no icon, no example). A free account at 0 credits sees "Credits left 0" in the same quiet style as everything else.
- Why it matters: people cannot judge value from an abstract unit, so upgrading feels like a guess. Heuristic: *match between the system and the real world*; *recognition rather than recall*.
- Suggested direction: translate credits into work ("about 1 complete brand", "about 6 brands", "about 20 brands", using real step prices), list what each step costs once, and give the page one recommended plan. When the balance is 0, say so in a sentence with the renewal date and the upgrade beside it.
- Evidence: `screens/plans__free-0-credits-upgrade-free__1440.png`, `screens/plans__pro-current-pro__1440.png`, `screens/plans__signed-out__1440.png`
- Systemic? Yes: the out-of-credits prompt and the Settings plan card repeat the bare number.

**E-027. Plan actions and messages are uneven**
- Screen: `/plans` as a Pro account, and after a failed upgrade, 1440.
- Category: consistency
- Severity: P2
- Tag: execution fix
- What's wrong: on Pro, "Manage plan" and "Cancel plan" are two identical outline buttons stacked together, so the destructive one has the same weight as the routine one. The Free card carries an instruction, "To return to Free, use Cancel plan on your current plan." The payment failure is bare red text between the summary and the cards with no container, while the success notice is a green strip. The footer says "Cancel anytime with Cancel plan" and "Payments are processed by Stripe through Link, which handles receipts and billing support." No navigation item is highlighted on this page.
- Why it matters: billing is where precision is read as trustworthiness. Heuristic: *consistency and standards*; *error prevention*.
- Suggested direction: one "Manage plan" button, with cancel as a quiet text action; put "Downgrade to Free" on the Free card itself. Use one notice component for success and failure. Rewrite the footer in two short sentences ("Prices in US dollars, billed monthly, plus tax where it applies. Cancel any time; your plan stays active until the end of the paid period.").
- Evidence: `screens/plans__pro-current-pro__1440.png`, `screens/plans__upgrade-unavailable-free__1440.png`, `screens/plans__return-checkout-success-fresh__1440.png`
- Systemic? Yes: notice styles differ across pages (section 4).

### 3.7 Settings (`/settings`)

What works: clear sections, a date-format preview, an honest "Your data" block with export, and a delete dialog that asks for the email before enabling the button.

**E-028. Deleting an account fails for anyone who has chosen a brand name**
- Screen: `/settings` → Your data → Delete account → confirm.
- Category: flow
- Severity: P0
- Tag: execution fix
- What's wrong: this is a known defect recorded in the audit setup (README, "Issues found while seeding", item 1), not re-run here because it damages the test account. For any account with a chosen name, deletion stops and the person sees "Deletion didn't finish".
- Why it matters: a person who asks to delete their data and cannot is a trust and legal problem at scale. Heuristic: *user control and freedom*.
- Suggested direction: fix the database purge (the README names the cause), then check the failure message says what happens next and who to contact.
- Evidence: `design-audit/README.md` (issue 1); dialog in `screens/settings__delete-account-dialog-free__1440.png`
- Systemic? No.

**E-029. Usage counts "tokens", leaves out images, and never mentions credits**
- Screen: `/settings` → Usage, all accounts, all widths.
- Category: copy (also hierarchy)
- Severity: P1
- Tag: needs redesign
- What's wrong: the tab is titled "Recent requests" and reports "3 requests · 14,400 tokens used". Rows read "Voice · Name · 4,800". A footnote says "Logo and image requests are not included." The customer is charged in credits, and logos and boards are the main cost, yet this page shows a different unit and omits the main cost. A Pro account that has used 38 credits sees three naming rows. There is a manual "Refresh" button.
- Why it matters: this is the only usage record a paying customer has, and it cannot answer "where did my credits go?" Heuristic: *match between the system and the real world*; *visibility of system status*.
- Suggested direction: a credit ledger: date, brand, step in the journey's words ("Six logo concepts"), credits used, running balance, and monthly grants and refunds as their own rows. Drop tokens from the customer view.
- Evidence: `screens/settings__usage-pro__1440.png`, `screens/settings__usage-free__390.png`
- Systemic? Yes: credits are also missing from the navigation (E-006) and from Plans' explanation (E-026).

**E-030. Save controls float between cards, and a failed save leaves a dead end**
- Screen: `/settings` → Account, all widths.
- Category: components (also flow)
- Severity: P2
- Tag: needs redesign
- What's wrong: "Cancel" and "Save changes" sit outside any card, between Preferences and "Plan and credits", so it is unclear which cards they save. With a change typed they do turn into a clear white and black pair (checked live). After a failed save, though, both return to pale grey while the page still says "You have unsaved changes.", a pink strip says "Saving could not be confirmed. Your edits are still here. Check the saved settings before trying another save." and a new button "Check saved settings" appears below it. The "Sign out" row has an unlabelled circular-arrows icon beside the button.
- Why it matters: the person cannot tell whether saving is possible, and the recovery asks them to run a check the app should run itself. The project's own rule is that account edits save automatically. Heuristic: *visibility of system status*; *help users recognize, diagnose, and recover from errors*.
- Suggested direction: save each field automatically and show "Saved" beside it, or keep the buttons inside the card they act on with a clear primary state. On failure: "Couldn't save. Check your connection." with one "Try again". Label or remove the icon beside Sign out.
- Evidence: `screens/settings__account-pro__1440.png`, `screens/settings__save-error-offline-free__1440.png`
- Systemic? Yes: "could not be confirmed / check … before trying again" wording recurs in the project screens (section 4).

**E-031. Signed-out Settings shows a disabled form filled with "Unavailable"**
- Screen: `/settings` signed out, all widths.
- Category: flow
- Severity: P3
- Tag: execution fix
- What's wrong: the whole Profile and Preferences form is drawn with "Unavailable" in the name and email fields, a Toronto time zone, disabled buttons and a "Sign in" card at the bottom.
- Why it matters: it looks like an error and shows controls nobody can use. Heuristic: *aesthetic and minimalist design*.
- Suggested direction: redirect to sign in and return afterwards (same as E-021).
- Evidence: `screens/settings__signed-out__1440.png`
- Systemic? Yes: see E-021.

### 3.8 Project conversation: Strategy, Voice and Identity (`/brands/account/<id>?view=strategy`)

This one page is the core of the product. Embel asks a question, shows options as cards, and the person chooses and continues. Judged on the showcase brands (Kestrel Analytics, Orchard Lane Cider) for logos and directions.

What works: one question at a time; a recommended option with a reason; answered questions fold down to a one-line summary with "Edit answer"; the Strategy summary card is compact and clear; the pill shows the four steps and a "Saved" mark; a 76-character name is truncated cleanly in the pill; a skipped slogan says "Skipped for now. You can add a slogan later."; partial failure offers "Retry 2 failed concepts" and keeps the four good ones.

**E-032. A finished brand is one page about 5,400 px tall, because Inspiration never folds away**
- Screen: any brand at or past Inspiration, 390 (about 9,700 px) and 1440 (about 5,400 px).
- Category: flow (also layout)
- Severity: P1
- Tag: needs redesign
- What's wrong: Strategy and Voice answers fold to one line each, but the Inspiration gallery stays fully open for good: eight large third-party brand collages, "Show more brands", "Your images" and an upload button. To reach their own logos, a person scrolls through roughly 2,400 px of other companies' saturated artwork (red, blue, orange). The Logo step then shows all six concepts, the refine box and the direction boards, all open.
- Why it matters: the Direction for this audit says the person's own brand should be the most colourful thing on screen. Here other brands are, permanently, and the page's most important content sits below them. Heuristic: *aesthetic and minimalist design*; *recognition rather than recall*.
- Suggested direction: fold every finished step the way Voice folds ("Inspiration: 2 liked · Edit", "Logo: Concept 1, version 2 · Change"). The page already tries to scroll to the current step on opening, but that is unreliable on a page this long (E-052); a short page would not need it. Keep the one-page conversation; just make it as short as the work that is still open.
- Evidence: `screens/brand-conversation__kestrel-complete-showcase-pro__1440.png`, `screens/brand-conversation__kestrel-complete-showcase-pro__390.png`, `screens/brand-conversation__orchardlane-complete-showcase-free__1440.png`
- Systemic? Yes: every brand from Inspiration onward.

**E-033. The work Embel makes is shown at thumbnail size**
- Screen: Logo and Creative direction steps, showcase brands, 1440.
- Category: hierarchy (also layout)
- Severity: P1
- Tag: needs redesign
- What's wrong: the conversation column is 792 px wide on a 1440 px screen, leaving about 320 px of empty canvas each side. Inside it, six logo concepts sit in cards about 237 px wide, and each creative-direction board (a dense 1024 px image with small type, swatches and mock-ups) is shown about 237 px wide, where none of its text can be read. A small expand icon is the only way to see a board properly.
- Why it matters: choosing a logo and a direction are the two decisions the whole product leads to, and the output is the product's best argument for itself. Showing it small undersells it. Heuristic: *recognition rather than recall*; visual hierarchy (the most important thing should be the largest).
- Suggested direction: let these two steps use the wider page width the Assets page already uses (1,056 px) or more; show concepts larger, on a clean white field; show the selected concept or board large with the alternatives beside it. The interface around them can stay as quiet as it is.
- Evidence: `screens/brand-conversation__kestrel-complete-showcase-pro__1440.png`, `screens/brand-conversation__orchardlane-complete-showcase-free__1440.png`, `screens/brand-conversation__quill-logos-generated-free__1440.png`
- Systemic? Yes: Logo and Creative direction on every brand.

**E-034. Direction cards break the brand name in the middle of a word**
- Screen: Creative direction step, every brand, 1440 (and 768).
- Category: typography
- Severity: P1
- Tag: execution fix
- What's wrong: each direction card previews its typeface by setting the brand name at about 22 px in a column about 95 px wide. The name breaks mid-word: "Kestrel Analytic / s", "Mosswo / od Candles", "Bright Harbor Learnin / g". The break point differs per typeface, so the three cards also end at different heights.
- Why it matters: this is the typography sample on the screen where the person chooses their brand's typography. A broken word here reads as a broken product. Heuristic: *aesthetic and minimalist design*; *consistency and standards*.
- Suggested direction: give the type sample the full card width (stack Palette above Typography), never break inside a word, and scale the sample to fit long names.
- Evidence: `screens/brand-conversation__kestrel-complete-showcase-pro__1440.png`, `screens/brand-conversation__mosswood-directions-generated-free__1440.png`, `screens/brand-conversation__logos-failed-brightharbor-pro__1440.png`
- Systemic? Yes: all direction cards.

**E-035. The Logo step has two text boxes and says the same hint three times**
- Screen: Logo step before and after choosing a concept, all widths.
- Category: flow (also copy)
- Severity: P2
- Tag: needs redesign
- What's wrong: under the concepts is a refine box ("Describe a change to this logo…" with a "Refine" button and a browser resize handle), and at the bottom of the page is the always-present composer ("Reply in your own words, or ask a question…"). Embel's message says "To change it, tell me what to adjust below", which could mean either. Before a concept is chosen, the refine card says "Choose a concept above to change it", its placeholder says "Choose a concept, then describe a change…" and a third line says "Select a logo above to get started."
- Why it matters: two inputs with overlapping jobs make people hesitate, and repeated hints add noise to the screen with the most to look at. Heuristic: *consistency and standards*; *aesthetic and minimalist design*.
- Suggested direction: one place to type. Either refine through the main composer when a concept is selected (the composer says "Describe a change to Concept 1…"), or hide the composer on this step. Show the refine control only once a concept is chosen.
- Evidence: `screens/brand-conversation__tidewater-logos-partly-failed-free__1440.png`, `screens/brand-conversation__kestrel-complete-showcase-pro__1440.png`
- Systemic? Yes: the persistent composer sits under every structured step.

**E-036. Waiting and failed logo cards say little, and say it twice**
- Screen: Logo step while concepts are drawn, and after failures, 1440.
- Category: components (also copy)
- Severity: P2
- Tag: execution fix
- What's wrong: while drawing, each of six cards shows a "Creating your concept" chip and a "Creating" label, with no expected time; beside the refine button a note says "Request in progress…". A failed card says "No image preview yet" in the middle and "Failed" at the bottom, which contradict each other, and gives no reason. Waiting and failed cards are taller than finished ones, so the grid changes height when images arrive.
- Why it matters: image drawing is the longest wait in the product. Heuristic: *visibility of system status*; *help users recognize, diagnose, and recover from errors*.
- Suggested direction: one message per card ("Drawing…", then the image, or "Couldn't draw this one"), a single line for the set with a time expectation ("Six concepts, usually about a minute"), the same card size in every state, and a plain reason with whether credits were returned.
- Evidence: `screens/brand-conversation__logos-drawing-aurelie-pro__1440.png`, `screens/brand-conversation__logos-failed-brightharbor-pro__1440.png`, `screens/brand-conversation__tidewater-logos-partly-failed-free__1440.png`
- Systemic? Yes: creative-direction boards use the same pattern.

**E-037. Running out of credits produces three messages at once, one of them covering the send button**
- Screen: any AI button at 0 credits (Fromagerie Bérénice Côté → Explore six concepts), 390 and 1440.
- Category: flow (also copy)
- Severity: P1
- Tag: needs redesign
- What's wrong: after the click, the page shows "Not ready yet." beside the button; under it "You've used this month's credits. They renew on December 1. Your logos are saved." with a "Try again" button that cannot succeed; and a floating card in the bottom-right corner, "You're out of credits for this month", which overlaps the composer and hides its send button. The renewal date here is December 1, while Plans says November 30 for the same account.
- Why it matters: this is the moment a free user decides whether to pay. It should be the clearest message in the product, and it should have been preventable (see E-006). Heuristic: *error prevention*; *help users recognize, diagnose, and recover from errors*; *consistency and standards*.
- Suggested direction: one message, in place, where the action was: "You've used this month's 30 credits. New credits arrive on [date]. Your work is saved." with "See plans" as the button. Remove "Try again" and "Not ready yet." Show the same date everywhere. Better still, mark AI buttons before the click when the balance cannot cover them.
- Evidence: `screens/brand-conversation__out-of-credits-prompt-free__1440.png`, `screens/brand-conversation__out-of-credits-prompt-free__390.png`, `screens/plans__free-0-credits-upgrade-free__1440.png`
- Systemic? Yes: every AI button.

**E-038. The Name step shows 100 names in one wall**
- Screen: Voice → Name (shown through "Change name"), 1440.
- Category: layout
- Severity: P2
- Tag: needs redesign
- What's wrong: all 100 generated names appear at once as identical cards in three columns, 34 rows and about 2,500 px tall, each with a radio button and a heart. The helper text mentions "Details shows each name's story and more checks", but no Details control is visible on a card. The only tools are "All 100 / Saved 0".
- Why it matters: 100 equal options is more than anyone can compare; people will pick from the first screen. Heuristic: *recognition rather than recall*; *aesthetic and minimalist design*.
- Suggested direction: lead with a short list of the strongest names (six to twelve) with one line on why each fits, group the rest by kind (real words, blends, invented, phrases), and make the path to a name's details visible.
- Evidence: `screens/brand-conversation__kestrel-change-name-open-pro__1440.png`
- Systemic? No.

**E-039. Small inconsistencies in the conversation's own grammar**
- Screen: all steps, all widths.
- Category: consistency (also copy)
- Severity: P3
- Tag: execution fix
- What's wrong: every message carries a grey line such as "Embel · Competitors · 1 of 3" and the round Embel mark, even for folded answers, where a leftover intro also remains ("Three personality directions.", "A few slogan ideas."). The same action is "Edit answer" on two steps and "Change name" on the third. "Continue" has an arrow in Strategy and Inspiration and none in Creative direction and Assets. A competitor card's "Sources" link repeats the competitor's own name next to "Visit website". Selection controls (checkbox, radio) are small and sit at the far right edge of wide cards. One intro reads "Here are competitors research found."
- Why it matters: the conversation is the product's voice; small slips are heard. Heuristic: *consistency and standards*.
- Suggested direction: drop the meta line and intro on folded answers; one verb for changing an answer ("Change"); one Continue button style; make the whole card the click target with the control on the left; fix the sentence ("Here are the competitors we found.").
- Evidence: `screens/brand-conversation__spokesmith-research-done-free__1440.png`, `screens/brand-conversation__northernlights-voice-done-long-name-free__1440.png`, `screens/brand-conversation__kestrel-complete-showcase-pro__1440.png`
- Systemic? Yes: all steps, and the Assets page.

**E-040. When a project cannot load, the page falls back to raw, unstyled messages**
- Screen: `/brands/account/<id>` with the API failing, or a project that does not exist, 1440 and 390.
- Category: components (also copy)
- Severity: P1
- Tag: execution fix
- What's wrong: the pill stays on "Loading project…" for good. A full-width strip at the very top says "The saved project could not be verified. Your existing work is kept." with a faint "Check saved project". Below it: "Opening your project. Your saved work could not be checked. Try again, or open Strategy to review the project." or, for a server failure, "Return to saved work", a heading "Account project", a pink strip "The account could not be reached. Your edits are still in this tab. Try again.", and "Retry loading project / Back to brands". Up to three separate messages, at three different left edges, none in a card.
- Why it matters: this is what a customer sees on a bad connection. It looks like a broken page, and the wording ("verified", "checked", "account project") is the system talking to itself. Heuristic: *help users recognize, diagnose, and recover from errors*; *match between the system and the real world*.
- Suggested direction: one centred card in the style of the 404: "We couldn't open this brand. Your work is saved. Check your connection and try again." with "Try again" and "Back to Projects". The pill should show the normal navigation, not "Loading project…".
- Evidence: `screens/project-workspace__error-api-500-pro__1440.png`, `screens/project-workspace__missing-project-pro__1440.png`, `screens/project-workspace__error-api-500-pro__390.png`
- Systemic? Yes: the same "could not be confirmed / verified / checked" family appears in Settings (E-030) and Home (E-009).

**E-041. Two older screens are still reachable and do not match the app**
- Screen: `/brands/account/<id>/identity` ("Build a visual starting point") and `/brands/<id>` ("Recover an unsaved project"), 1440.
- Category: consistency
- Severity: P2
- Tag: execution fix
- What's wrong: the identity page predates the four-step journey: it calls Kestrel Analytics "Untitled brand", has a Chat / Controls side panel, square-cornered buttons, and messages such as "Reference discovery is not connected." It is linked from the fallback project editor ("Saved references and systems", `src/components/workspace/account-project-editor.tsx:562`). The recover page is plain text on a white page with "Back to projects" twice.
- Why it matters: a customer who lands on either sees a different, rougher product. Heuristic: *consistency and standards*.
- Suggested direction: retire the identity page (redirect it to the Inspiration step like its sibling routes), and give the recover page the standard empty-state card.
- Evidence: `screens/brand-identity__kestrel-pro__1440.png`, `screens/brand-recover__owner-no-unsaved-project-pro__1440.png`, `screens/recover-project__signed-out-none-available__1440.png`
- Systemic? No.

### 3.9 Assets (`/brands/account/<id>/logo/deliverables`)

Judged on Kestrel Analytics and Orchard Lane Cider.

What works: one clear primary action ("Download brand kit") at the top and bottom with a file count; each image states its pixel size; colours can be copied; the page says "Ready to download" only when the files exist; "Preparing…" placeholders hold the layout for the social images.

**E-042. The final brand images are one fixed template with two circles, far below the direction the person chose**
- Screen: Assets → Brand images (brand board, profile image, post templates, banners), showcase brands, all widths; the same files in the kit.
- Category: imagery (also exports)
- Severity: P1
- Tag: needs redesign
- What's wrong: the creative-direction board the person chose for Kestrel is rich: a mountain photograph header, a flight-path line motif, a dashboard, a business card, a conference stand. The assets that follow keep only its four colours and two typefaces. Every brand image is the same layout on a cream field with two overlapping circles in the accent colour, for every brand. The brand board's "In practice" row is three small copies of those same templates. The guidelines' Imagery section then describes "a fine grid, flight-path lines and data points", none of which appears in any file.
- Why it matters: the journey builds expectation up to the direction board and then delivers something generic. The last screen is the one people download, share and judge the product by. Heuristic: *match between the system and the real world* (the result should match what was chosen); peak-end rule (people remember the end).
- Suggested direction: decide what the deliverables inherit from a direction beyond colour and type (a motif, an image treatment, a layout family) and design a small set of template families so two brands do not get the same picture. This needs a design decision before any implementation. Pass 1b covers image quality itself.
- Evidence: `screens/brand-assets__kestrel-ready-pro__1440.png`, `screens/brand-assets__orchardlane-ready-free__1440.png`, `exports/rendered/kestrel__brand-board.png.png`, compared with `exports/rendered/kestrel__direction--selected-direction.png.png`
- Systemic? Yes: all brands, all exported social files.

**E-043. The chosen direction board shows a different logo from the one the person chose**
- Screen: Creative direction step and Library, Kestrel Analytics, 1440; `direction/selected-direction.png` in the kit.
- Category: imagery
- Severity: P1
- Tag: needs redesign
- What's wrong: the chosen logo is a striped wing with "KESTREL ANALYTICS" in bold capitals. The direction board built "around the chosen logo" shows a different mark (a single white arrow) with the name in mixed case, and the line "Precision at altitude" where the chosen slogan is "See every mile". The board is then shipped in the kit as the "selected direction".
- Why it matters: the step's promise, in its own words, is "three ways to bring Kestrel Analytics to life, each built on your chosen logo." A different logo on the board breaks that promise at the moment of choice. Heuristic: *consistency and standards*; *match between the system and the real world*. It is noted here because it damages the screen; image generation itself belongs to pass 1b.
- Suggested direction: boards must carry the exact chosen logo file and the chosen slogan (placed onto the board, not redrawn), or the screen must say plainly that a board is a mood reference.
- Evidence: `exports/rendered/kestrel__direction--selected-direction.png.png` compared with `exports/rendered/kestrel__logo--logo-original.png.png`; `screens/brand-conversation__kestrel-complete-showcase-pro__1440.png`
- Systemic? Likely (seen on the one showcase brand with a real board at full size; check Orchard Lane Cider in pass 1b).

**E-044. The on-screen guidelines are too thin to guide anyone**
- Screen: Assets → Brand guidelines, all widths.
- Category: hierarchy (also copy)
- Severity: P1
- Tag: needs redesign
- What's wrong: Voice is one sentence ("Leads with sincerity and competence, as in "See every mile"."). Logo rules are one paragraph with no diagram of clear space or minimum size. Typography shows one line per face. Imagery is two sentences that refer to the person's choice by an internal label ("Supporting graphics for direction 1", "Composition for direction 1"). The "Edit" links are small grey text at the right edge.
- Why it matters: freelancers and agencies hand guidelines to clients; founders hand them to a web designer. Thin guidelines read as a demo. Heuristic: *help and documentation*.
- Suggested direction: design the guidelines as a document: a cover, logo usage with clear-space and do/don't examples, colours with roles and contrast pairs, type with a real hierarchy sample, voice with three "say this / not this" pairs, imagery with examples. Use the direction's name, never its number.
- Evidence: `screens/brand-assets__kestrel-ready-pro__1440.png` (guidelines section), `screens/brand-assets__kestrel-ready-pro__390.png`
- Systemic? Yes: the exported `brand-guide.html` (E-046).

**E-045. The Assets page keeps the conversation's stepping after everything is done, and scatters downloads**
- Screen: Assets, complete brand, all widths.
- Category: layout
- Severity: P2
- Tag: needs redesign
- What's wrong: the page is a results page, but it is still dressed as a chat: three Embel messages ("Brand images · 1 of 3"…), each section ending in a "Continue" button ("5 social images · Next: Brand guidelines · Continue") although all three sections are already shown. There are about fifteen separate download buttons. In the social grid, the three cards have different heights, so their titles and buttons sit at three different levels, and the profile image's button is beside its title while the others are below. The dot-grid canvas used everywhere else stops just under the pill on this page. While files are prepared, the Brand board block is absent and appears later, pushing everything down.
- Why it matters: this is the delivery screen; it should feel like opening a finished package. Heuristic: *aesthetic and minimalist design*; *consistency and standards*.
- Suggested direction: a single delivery layout: the brand board large at the top, then tabs or anchors for Images, Guidelines and Design system, with one download control per file type and the kit button always in view. No "Continue" once the brand is complete.
- Evidence: `screens/brand-assets__kestrel-ready-pro__1440.png`, `screens/brand-assets__kestrel-preparing-pro__1440.png`, `screens/brand-assets__orchardlane-ready-free__390.png`
- Systemic? No.

### 3.10 Exported brand files (Kestrel Analytics kit, `exports/kestrel/`, renders in `exports/rendered/`)

The question for each file: would a customer be proud to share it?

**E-046. The brand guidelines file is an unstyled web page**
- File: `guides/brand-guide.html` (also "Download guidelines").
- Category: exports
- Severity: P1
- Tag: needs redesign
- What's wrong: the file is a plain HTML page in the system font: a bold title, default blue underlined links, a bare table for typography, four colour squares, and paragraphs. It contains no logo image at all, does not use the brand's typefaces or colours beyond the swatches, and repeats the internal wording "for direction 1". It is HTML, not PDF, so it cannot be attached to an email or printed predictably. Its last section is about file handling ("The original logo file keeps its saved artwork and background…").
- Why it matters: this is the document a freelancer sends to a client. As it stands they would have to rebuild it. Heuristic: *aesthetic and minimalist design*; the Direction's "polished exports".
- Suggested direction: a designed, paged guidelines document in the brand's own type and colours with the logo on the cover, exported as PDF (keep HTML as a second format if wanted). Same content design as E-044.
- Evidence: `exports/rendered/kestrel__guides--brand-guide.html.png`, `exports/kestrel/kit/guides/brand-guide.html`
- Systemic? Yes: every brand.

**E-047. The brand board and social files have layout collisions and placeholder copy**
- Files: `brand-board.png`, `social/banner-wide.*`, `social/banner-cover.*`, `social/post-*.{png,svg}`.
- Category: exports
- Severity: P1
- Tag: needs redesign
- What's wrong: on both banners the orange circle sits on top of the brand name, cutting through "Analytics". The banners show the logo (which already contains the name) beside the name set again in type. The brand board is headed "BRAND IDENTITY" and captions the logo "YOUR LOGO", so the file addresses the customer instead of their audience. Its type samples are filler ("A distinct voice.", "The details make the difference."), its footer reads "Logo · Color palette · Fonts · Social templates", and the palette and typography headings are spaced unevenly (the Typography heading touches the swatch labels above it). Post templates set the positioning sentence in very small type under the slogan.
- Why it matters: these are the files that get posted publicly under the customer's name. Heuristic: *aesthetic and minimalist design*.
- Suggested direction: redesign the board and templates as finished pieces (see E-042): no decoration over text, the logo or the name but not both, real sample copy from the brand's own voice, and nothing written to "you".
- Evidence: `exports/rendered/kestrel__social--banner-wide.png.png`, `exports/rendered/kestrel__social--banner-cover.png.png`, `exports/rendered/kestrel__brand-board.png.png`, `exports/rendered/kestrel__social--post-square.png.png`
- Systemic? Yes: every brand (fixed template).

**E-048. Logo files are 1024 px rasters with the mark off-centre, and the token file repeats its colours**
- Files: `logo/logo-*.png`, `design-system/design-tokens.css`, `README.txt`.
- Category: exports
- Severity: P2
- Tag: execution fix
- What's wrong: the three logo files are 1024×1024 PNGs in which the mark fills about two thirds of the canvas and sits below centre, untrimmed; there is no larger size and no vector (the README says so honestly: "There is no vector logo in this pack."). `design-tokens.css` declares the four colour variables twice in a row. The README is accurate but written defensively and in file-system terms ("Social SVG templates are not vector logo masters.").
- Why it matters: a 1024 px logo is too small for print, and an off-centre canvas makes it awkward to place. Agencies will open the token file. Heuristic: *error prevention*; the Direction's "professional control and polished exports".
- Suggested direction: trim and centre the logo with even padding, export at least a 4,096 px version alongside, and say on the Assets page (not only in the README) that logos are images, not vectors. Remove the duplicated lines. Rewrite the README as a short, friendly "What's in this kit".
- Evidence: `exports/rendered/kestrel__logo--logo-transparent.png.png`, `exports/kestrel/kit/design-system/design-tokens.css` (lines 3-10), `exports/rendered/kestrel__README.txt.png`
- Systemic? Yes: every brand.

### 3.11 Emails (`evidence/emails/`, rendered previews only)

**E-049. The two emails are clean and on-brand, with small gaps**
- File: `confirmation` and `recovery` templates at 390 and 600.
- Category: consistency
- Severity: P3
- Tag: execution fix
- What's wrong: both match the app (paper card, ink pill button, calm copy) and read well. Gaps: the brand is the word "Embel" in a system font with no mark; there is no plain link under the button for mail clients that block buttons; the reset email does not say how long the link lasts, though the app says links "expire after a short time"; the footer is "Embel · embel.xyz" with no help contact.
- Why it matters: these are the first two messages a customer receives. Heuristic: *help users recognize, diagnose, and recover from errors* (a dead button needs a fallback).
- Suggested direction: add the Embel mark, a "or paste this link" line, the expiry time and a help address.
- Evidence: `emails/confirmation__600.png`, `emails/confirmation__390.png`, `emails/recovery__600.png`, `emails/recovery__390.png`
- Systemic? No.

### 3.12 Added during the live walk (Browser pane, 390 and 1440, grouped by route)

These were checked in the running app because a still image cannot show them. New screenshots are in `evidence/annotated/`.

**E-050. Library: "View details" does nothing**
- Screen: `/assets`, both tabs, Pro account, 1440 (the inventory pass saw the same at 768 and 1440).
- Category: flow
- Severity: P0
- Tag: execution fix
- What's wrong: each Library card ends in a small arrow button named "View details of …". Clicking it, clicking the picture, or activating it from the keyboard opens nothing: no dialog is added to the page, the address does not change and no error is logged. The detail view exists in code (`src/components/assets/asset-detail.tsx`) and is where a person would see versions and download a file, so nothing in Library can be opened or downloaded.
- Why it matters: the only action on every item in Library is dead, which makes the page a picture wall. Heuristic: *user control and freedom*; *visibility of system status* (a click with no response).
- Suggested direction: find why the dialog does not mount, then review the detail view in a follow-up pass (it has not been seen). Until then, a click on a card could go to the brand's Assets page.
- Evidence: `annotated/E-050.png` (hover state on the arrow, nothing opened), `screens/library__asset-detail-dialog-pro__1440.png` (the capture script's attempt, list only)
- Note added after the pass: a separate fix session (PR 255 in mikaelcharbonneau/embel, not merged, not verified by this audit) reports the cause as a close listener firing during React's development-only double run of effects. If that is right, the dialog may open normally in a production build. This finding was observed on the development server only; re-check it on a production build before treating it as P0 for customers.
- Systemic? No.

**E-051. Logo and direction cards do not show how to choose, compare or tell concepts apart**
- Screen: project conversation → Logo and Creative direction, 1440 and 390.
- Category: components (also flow)
- Severity: P1
- Tag: needs redesign
- What's wrong: a logo concept is a blank white card with the image and nothing else. There is no visible "Concept 2" label, no "Choose" button and no hover change; the whole card is clickable but only the cursor says so. In the page's code each card has a "Select concept" and a "Compare concept" button, but both have zero width and height, so sighted people cannot see them and comparing is unreachable. The chosen card gets a dark border, a "Chosen" chip and a browser-style version dropdown squeezed along its top edge. Direction cards behave the same way; their expand icon opens a good large view (about 860 px), but that view has only a Close button: no "Choose this direction" and no next or previous.
- Why it matters: these two choices are the centre of the product, and a first-time user has to discover by accident that clicking a picture commits a choice. Heuristic: *recognition rather than recall*; *visibility of system status*; *user control and freedom*.
- Suggested direction: label every card ("Concept 2"), show a clear hover and focus state, and put an explicit "Choose" action on the card and in the large view. Give the large view next and previous so boards can be compared at full size. Make compare a visible feature or remove it.
- Evidence: `annotated/E-051.png`, `annotated/E-051-larger-view.png`, `screens/brand-conversation__quill-logos-generated-free__1440.png`
- Systemic? Yes: both steps, every brand.

**E-052. Reopening a brand lands in a different place each time, behind several seconds of placeholders**
- Screen: any complete brand opened from Projects or by link, 390 and 1440 (development server; real networks will be slower than this machine).
- Category: flow
- Severity: P1
- Tag: execution fix
- What's wrong: the conversation scrolls to the current step on load, but it does so before images have arrived. At 1440 one load ended at Creative direction and the next ended in the middle of the Inspiration gallery. At 390 it stopped about 2,200 px down a 9,500 px page, among other companies' brand boards, and stayed there. For the first seconds the page is faded, the pill highlights the wrong step ("Voice" while Creative direction is on screen), and images are replaced by grey boxes labelled "Private board preview", "Loading private reference" and, in the large view, "Checking private preview…".
- Why it matters: a returning customer's first impression of their own brand is a jumpy page that parks them in the wrong place, with wording about privacy checks. Heuristic: *visibility of system status*; *match between the system and the real world*; *consistency and standards*.
- Suggested direction: reserve image sizes so the layout does not move, scroll after layout is stable (or open folded at the current step, see E-032), keep the pill in step with what is on screen, and use plain skeletons with no "private" wording.
- Evidence: `annotated/E-052.png`, `annotated/E-052-390-lands-mid-gallery.png`, `annotated/E-052-checking-private-preview.png`, `annotated/E-053.png` (second 1440 load, mid-gallery)
- Systemic? Yes: every brand past Inspiration.

**E-053. Inside a project the pill loses the app's navigation and its labels**
- Screen: project conversation and Assets, 390 and 1440.
- Category: navigation/IA
- Severity: P2
- Tag: needs redesign
- What's wrong: in a project the pill replaces Home / Projects / Library with the brand name and the four steps. The brand name opens a menu that the page calls "Switch project", but it lists only "All projects", "New project" and "Home": no other brands, no Library, no rename. On the conversation page a finished brand never shows four ticks; Assets stays a numbered "4" until that page is opened. At 390 the pill becomes two rows about 116 px tall, and every step except the current one is a bare 40 px circle with a tick or a number and no word. The browser tab says "Strategy · Embel" on every step of the conversation, and Home's tab says "Embel — Brand workspace" while other pages use "Page · Embel".
- Why it matters: people working on several brands (the agency audience) cannot move between them, and on a phone the steps are unlabeled. Heuristic: *recognition rather than recall*; *flexibility and efficiency of use*; *consistency and standards*.
- Suggested direction: list recent brands in the brand menu, keep a visible way to Library, show all four steps' true state, keep short labels at 390 (or a "Step 3 of 4 · Identity" line), and name the tab after the brand and step.
- Evidence: `annotated/E-053.png`, `annotated/E-052-390-lands-mid-gallery.png`, `screens/home__research-in-progress-pro__390.png`
- Systemic? Yes: all project pages.

**E-054. The inspiration brand view is the journey's best screen, and it calls the brand "Untitled brand"**
- Screen: project conversation → Inspiration → Open brand (dialog), Kestrel Analytics, 1440.
- Category: copy
- Severity: P2
- Tag: execution fix
- What's wrong: opening a gallery brand shows a large image with next and previous, and a calm side panel: like the whole brand, or just its logo, colours, typefaces, socials or visuals. This is the level the rest of the journey should reach. Its footer says "Your choices stay with Untitled brand." for a brand named Kestrel Analytics, and the panel is headed with a small all-capitals "BRAND". By contrast, the gallery cards in the conversation behind it are small collages in two cramped columns.
- Why it matters: the wrong name is a visible slip in the product's best moment. Heuristic: *consistency and standards*.
- Suggested direction: use the brand's real name; use this dialog's scale and restraint as the model for showing logos and direction boards (E-033, E-051).
- Evidence: `annotated/E-054.png`
- Systemic? "Untitled brand" also appears for named brands on the legacy identity page (E-041).

### 3.13 Whole-app visual identity (the frontend-design lens)

**E-055. The interface is tidy but reads as a default "AI tool" kit, not as Embel**
- Screen: every page.
- Category: consistency (visual identity)
- Severity: P2
- Tag: needs redesign
- What's wrong: measured against the frontend-design skill's list of templated looks, the app uses several at once: a dot-grid canvas behind everything (and missing on Assets); one white, rounded, hairline-bordered card for every kind of content, at every level of importance; pill shapes for navigation, buttons, chips, tabs and inputs alike; grey meta lines joined with middle dots ("Embel · Competitors · 1 of 3", "Pro plan · 112 credits left this month"); an arrow added to most buttons and links ("Sign in →", "Return to Home →", "View brand kit →") but not all; small all-capitals labels in exports ("BRAND IDENTITY", "YOUR LOGO"); and Geist, the framework's stock typeface, at 13 to 14 px for almost everything. The one distinctive asset, the pixel-ring Embel mark, appears only at 28 px. Type is small for a premium feel: most interface text is 13 px and much status text is 12 px grey.
- Why it matters: the Direction asks for "minimal and premium". Minimal is achieved; premium needs a point of view. Today the app could be any assistant product, and the sameness of surfaces flattens hierarchy (a plan card, an error, a logo and an empty state all look alike). Principle: visual hierarchy and a deliberate identity; "spend your boldness in one place".
- Suggested direction: keep the ink-on-paper restraint and choose where Embel is recognisably itself: for example a display typeface used only for headings and the brand's name, a clear rule for when something is a card and when it is plain page, a larger base type size, and one consistent treatment for links versus buttons (arrows on navigation links only, or nowhere). Decide whether the dot grid stays; if it does, use it everywhere or only where work happens. This is input for pass 3b, not a specification.
- Evidence: `screens/home__signed-out__1440.png`, `screens/plans__pro-current-pro__1440.png`, `screens/settings__account-pro__1440.png`, `screens/brand-conversation__spokesmith-research-done-free__1440.png`, `exports/rendered/kestrel__brand-board.png.png`
- Systemic? Yes: all screens.

**E-056. Almost nothing moves or responds to hover**
- Screen: every page (checked live on Home, Projects, Library, the project conversation).
- Category: components (motion)
- Severity: P3
- Tag: needs redesign
- What's wrong: there are about nine transitions in the whole style base. Logo and direction cards show no hover change; menus, dialogs and folded answers appear and disappear instantly; the only regular motion is a fade when a conversation loads. The navigation pill, by contrast, jumps in width on each load (E-008).
- Why it matters: calm does not mean static. Small, fast responses to a person's action (a card lifting on hover, a choice settling into place, a dialog easing in) are a large part of what reads as "premium", and they show what changed. Heuristic: *visibility of system status*.
- Suggested direction: a short motion set tied to actions only (hover, press, choose, open, fold), about 120 to 200 ms, with reduced-motion respected as it is today. No decorative motion.
- Evidence: `annotated/E-051.png` (hover on a logo card, no change); inventory section 2, "Motion"
- Systemic? Yes: all screens.

## 4. Design-system symptoms

These are patterns that differ from screen to screen for no visible reason. They are symptoms only; the full design-system audit is pass 3b. Paths are under `evidence/`.

- **Messages have at least seven looks.** A square pink strip (Projects: `screens/projects__error-api-500-free__1440.png`), a rounded pink strip with a border (Settings: `screens/settings__save-error-offline-free__1440.png`), a pink box under a button (Sign in: `screens/sign-in__error-wrong-password__1440.png`), bare red text (Plans: `screens/plans__upgrade-unavailable-free__1440.png`), a strip docked to the composer (`screens/home__research-failed-pro__1440.png`), a green strip for success (`screens/plans__return-checkout-success-fresh__1440.png`), and plain grey paragraphs for both success and failure (`screens/sign-in__email-confirmed-notice__1440.png`). There are no toasts, and one floating card (out of credits) that behaves like one.
- **Actions have no fixed shape.** Primary buttons are full width on some cards and hug their label on others; arrows appear on some buttons and links and not on others; important recovery actions are faint grey text ("Check status", "Retry research", "Send another link", "Edit", "Back to brands"); disabled buttons are a pale grey fill that also appears after a failed save.
- **Empty states come in three styles.** An icon in a grey circle with a button (Library), a bare line icon (Home, Projects), and text only (Deleted projects, search no match), each with different spacing.
- **Page widths differ by page.** The conversation is 792 px, list pages and Assets 1,056 px, and older screens are full width (`screens/brand-identity__kestrel-pro__1440.png`, `screens/project-workspace__error-api-500-pro__1440.png`).
- **The canvas is not consistent.** The dot grid is on most pages, stops under the pill on Assets, and is absent (plain white) on the recover page and the legacy identity page.
- **One card style carries everything.** Plans, errors, empty states, form sections, logo concepts and answers share the same white rounded hairline card, so importance is not visible. Corner radii in code range from 4 to 20 px (inventory section 2).
- **Dialogs are each built by hand.** Widths seen: about 460 (delete project), 480 (delete account), 620 (activity), 860 (direction view), 1,320 (inspiration brand). Close buttons are a plain "×" in some and a circled "×" in others; headers differ.
- **Browser-native controls show through.** The version dropdown on a chosen logo, Settings selects, the resize handle on the refine box, and the validation bubble on sign-up (`screens/sign-up__validation-password-mismatch__1440.png`).
- **Headings and titles vary.** "Projects." / "Settings." / "Your visual library." end in a full stop; "Plans" does not. Tab titles use "Page · Embel" except Home ("Embel — Brand workspace") and the conversation (always "Strategy · Embel").
- **Type is small and grey carries too much.** Controls are 13 px, meta lines 12 px; status, hints, errors-as-notices and secondary actions all share the same grey. Meta strings are joined with middle dots throughout.
- **Selection controls move around.** Checkbox and radio at the far right of wide cards (Strategy, Personality), radio at the left (Names), no control at all (logos, directions), a heart for "like" (Inspiration, Names).
- **Vocabulary is not one system.** Project / brand; brand board / direction board / identity images / selected direction; generation / request / work / usage; kept / saved / liked / chosen / used in brand.
- **Motion is nearly absent**, and the one element that does move, the pill, moves by accident (E-008, E-056).
- **Phone width is uneven.** Most pages stack well; Plans does not (E-025); the project pill loses its labels (E-053); long pages become very long (Library about 10,000 px, a finished brand about 9,700 px).

## 5. Product-structure recommendation: refresh

**Recommendation: refresh.** Keep the information architecture, the navigation and the page layouts; improve how they look, behave and speak.

Why not a full redesign. The brief sets the bar for that at structural problems across multiple flows or breakpoints. The evidence does not meet it:

- **The information architecture holds.** Home (start), Projects (list), a project with four named steps, Assets (delivery), Library, Plans and Settings is a structure people already understand, and no finding asks to move a page or regroup the navigation. The floating pill works as the single navigation element at all three widths.
- **The main flow completes.** Brief → Strategy → Voice → Identity → Assets → download works end to end on the seeded brands, and the one-question-at-a-time conversation with folded answers is a good pattern (`screens/brand-conversation__northernlights-voice-done-long-name-free__1440.png`).
- **Layouts adapt.** Across 96 captured states at 390, 768 and 1440, the only layout that breaks is Plans at 390 (E-025). No page scrolls sideways at 390 in the live check.
- **The problems are in depth, not shape.** Of 56 findings, 29 have a clear answer already (execution fixes), and most of the 27 that need design are about how a screen presents its content inside the existing structure: scale, folding, labels, states and copy.

A refresh is not a light touch here. Four surfaces need real design work inside the existing structure, and should go to Claude Design as their own briefs:

1. **Choosing a logo and a direction** (E-033, E-051, E-034, E-035): larger presentation, explicit choose and compare, one input.
2. **Delivery: Assets, brand images, guidelines and the exported files** (E-042 to E-048): what a direction passes on to the deliverables, and a guidelines document worth sending to a client.
3. **Credits and plans** (E-006, E-026, E-029, E-037): one way to show balance, cost and limits, before and after the click.
4. **States and messages** (E-009, E-012, E-036, E-040, and section 4): one pattern each for waiting, failure, empty and success, with one voice.

Two smaller questions sit beside these: what Library is for (E-023, E-024) and what the signed-out Home shows as proof (E-001). The design system, including whether the current typeface, card and canvas choices stay, is judged in pass 3b; E-055 is the input from this pass.

## Recap

**Counts.** 56 findings.

| Severity | Needs redesign | Execution fix | Total |
| --- | --- | --- | --- |
| P0 (blocks or breaks a task) | 0 | 2 | 2 |
| P1 (hurts trust or completion) | 15 | 8 | 23 |
| P2 (noticeable polish) | 11 | 12 | 23 |
| P3 (nice to have) | 1 | 7 | 8 |
| **Total** | **27** | **29** | **56** |

The two P0s are E-028 (account deletion fails; taken from the audit setup notes, not re-run) and E-050 (Library "View details" does nothing; confirmed live).

**How this pass was run.** The seed reset ran first (11 brands, all ok, no real AI calls). Saved screenshots were the main evidence; the Browser pane was used at 390 and 1440 for the project conversation, Assets, Library, Settings and Home. No AI button was clicked and no test data was changed (one name typed in Settings was discarded), so no second reset was needed. Only files inside `design-audit/` were created or changed. The local audit server was restarted and is still running on port 3105.

**Could not review.**

- The three crash screens (`error.tsx`, `global-error.tsx`, the project-level `error.tsx`): they need a deliberate code failure. Source only.
- The Library detail view: it does not open (E-050), so its design is unseen.
- Stripe Checkout and the customer portal: hosted by Stripe; no test key locally. The final "payment confirmed" notice on Plans was therefore also not seen, only "Confirming your payment…".
- Sign-up's "check your email" state, the sign-out confirmation dialog, and the Settings data export: each needs an action that creates or exports real local data.
- Names, slogans and creative directions while in progress; "step unavailable"; "today's limit"; a failed reference upload: recipes exist but spend test credits or flip database switches, so they were left for a pass that reseeds afterwards.
- The name preview ("Details") view on the Name step, and "Compare concept" (hidden, E-051).
- Whether Enter submits the sign-in form: the Browser pane gave the opposite result from the inventory pass (gap 9). Worth one check in a normal browser.
- The 768 width was reviewed from stills for Home and sampled elsewhere; it was not walked live.
- Loading time and image weight: seen only on the development server, which is slower than production. E-052 should be re-checked on a production build.
- Some brand text in the captures comes from the stand-in AI (for example "For our audience, we are see the delay before it happens." and the generated names). It was not judged as product copy.
- Image quality itself (logos, boards, inspiration gallery) is left to pass 1b; E-042 and E-043 are noted here only because they damage the screens they appear on.
