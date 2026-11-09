> **Archived November 9, 2026.** Historical record; it may not match the current code. Current architecture and plan: [architecture-review.md](architecture-review.md).

# UI and design audit — November 7, 2026

Scope: the local app at `http://127.0.0.1:3105` (code identical to `main` 1a69d3c),
signed out and signed in with the local test account, at 1440 × 900 plus
1024, 1280 and 1920 widths. Desktop only, as agreed. Screenshots are in
`.playwright-mcp/audit/` (local only, not in git).

The question asked: what stops Embel from looking like a professional AI SaaS
app that is ready for launch? Findings are grouped by priority. Each one says
where it is and what a good fix looks like.

---

## P0 — Launch blockers

These would make a first-time visitor or customer doubt the product.

1. **Signed-out visitors land on an empty tool, not a product page.**
   Home has a headline, the composer and three idea chips; the lower half of
   the screen is blank. There is no example of what Embel produces, no "how it
   works", no pricing, no footer. Projects, Library and Tools are shown to
   signed-out visitors and lead to "No verified account session. Sign in to view
   your account projects." with a plain-text "Sign in" link.
   *Fix:* a signed-out Home with real example brand kits, three-step "how it
   works", pricing or "free to start", and a footer; hide account-only nav until
   signed in; add a "Get started" button next to "Sign in".
   (`01-home-signed-out.png`, `05-projects-signed-out.png`)

2. **No Terms, Privacy or legal footer anywhere**, and sign-up has no consent
   line. There are no `/terms` or `/privacy` pages in the app.

3. **No "Forgot password?"** on sign-in, and no way to change the password or
   delete the account in Settings. There is no password-reset route.
   (`03-sign-in-page.png`)

4. **Settings is mostly placeholders and diagnostics.**
   - Seven "Not available yet" cards with "View unavailable features" links,
     one on every tab (Account, Workspace, AI preferences, Usage & billing,
     Notifications, Security & privacy, Integrations). Notifications and Integrations contain
     nothing usable.
   - *AI preferences* is a developer readiness panel: "Read-only readiness for
     your verified account", a list of internal operations each ending in
     "OpenAI API usage", "Check text status", and the heading "Text and
     strategy" twice.
   - *Usage & billing* is a raw log of 20 requests with input/output tokens;
     "Total tokens" says **Unknown** on every row even when both parts are known,
     and Naming rows are all "Unknown". "Recorded usage loaded." is shown as
     page text. "Billing is not connected."
   - *Workspace* offers "Recover drafts left by an earlier version of Embel",
     which customers will never have.
   *Fix:* keep Account (name, email, password, delete account), Usage (in plain
   terms, per project and per month) and Sign out. Remove every "Not available
   yet" card and the diagnostics until they exist.
   (`20-settings-*.png`)

5. **Finished deliverables contain placeholder text.** The wide banner and cover
   banner say "Your tagline here" even though the slogan "From idea to
   identity." was chosen — the text is hard-coded in
   `src/features/brand-assets/model/artwork.ts:57,60`. The post templates say
   "Your headline goes here." and "Add your message.". A customer downloading
   these sees an unfinished product.
   *Fix:* use the chosen slogan, the positioning line and a real call to action.
   (`32-launchpad-assets-01.png`, `-02.png`)

6. **Logos are shown as opaque squares.** Every generated logo is a raster image
   with an off-white background, so a lighter square is visible inside every
   card (logo concepts, Home and Projects cards, brand board, social images). The
   brand guidelines' "logo on dark" example is a white square on green, next to
   text saying to use the logo on light backgrounds.
   *Fix:* remove the background (transparent PNG), and produce a reversed
   (light-on-dark) version for dark backgrounds.
   (`35-launchpad-identity-00.png`, `32-launchpad-assets-03.png`)

7. **Internal and technical language is visible to customers** on almost every
   screen. Examples:
   - Library: "Kept assets includes likes, saves and recorded project use.
     Project logo choices, library-version selections and vector approvals are
     separate.", "File checked", "2 assets loaded", "Check assets", asset titles
     like `logo_identity_system`.
   - Account menu: "Refresh connection"; Settings: "A verified account session
     is connected."
   - Personality: "Scores use independent 1–5 scales for each Aaker personality
     dimension; they are not percentage allocations."
   - Guidelines: "Use guide_heading at 48–64 px … clear_body … action_label"
     (internal token names).
   - Naming: "100 unchecked brainstorm names are saved."; a stalled project:
     "Send a message below to begin competitor research when AI is available."
   - Handles: "Availability requires a connected check.", "Checks not connected
     · availability unknown", "Invalid combinations are excluded per platform,
     never silently changed."
   - Trademarks: "Manual research criteria only. This action does not query a
     registry. Requested territories: not provided."
   - Domains: "Premium classification is not supplied. Results are not filtered
     by it."
   - Vector page: "A saved image preview is not an approved vector. Open Project
     context, then Saved inputs and recovery in Logo concepts…"
   *Fix:* one copy pass with a rule: say what the customer can do, never how the
   system works.

8. **Project names are wrong outside the project.** Library, Generation activity
   and the project-card menus call Launchpad and Larder "Untitled brand"
   (the card menu buttons are labelled "Project options for Untitled brand").
   (`13-library.png`, `22-generation-activity.png`)

9. **Old, un-redesigned screens are still reachable.**
   - "New project" (Projects page and the project menu) opens `/brands/new`, a
     second copy of Home with "Save project · Saves to your account · does not
     start AI" and "Create a logo Start in the dedicated logo workflow."
   - That link opens `/brands/logo/new`: the old logo workflow with a right
     sidebar, "01 / BRIEF", "Reference library unavailable…", "Uploads are
     unavailable…" and an unstyled "Choose File" control.
   - "Advanced vector editor" opens `/logo/vector`: old layout with a white band
     behind the navigation, "Workspace version 4", "AI Vector Edit Suggestions".
   - The 404 page uses the old boxed panel.
   (`86-brands-new.png`, `87-logo-new.png`, `85-logo-vector.png`, `07-404.png`)

10. **Two tools can't do what their names promise.** Handles builds a list of
    spellings but doesn't check availability; Trademarks prepares "manual
    research criteria" without searching a registry. Either finish them or
    remove them from the Tools menu for launch.

---

## P1 — Visual consistency (design system)

These are why the app feels assembled rather than designed.

1. **Two shape languages.** The base button (`.button` in
   `src/styles/globals.css:41`) still has a 7px corner; pills only appear where
   journey screens override it. So the same screen mixes shapes: Assets has a
   pill "Continue" next to square "PNG", "SVG", "Download PNG", "Copy CSS
   palette" and "Download brand kit". Projects, Settings, Library and every Tool
   use square buttons and inputs. The code has 20+ different corner values and
   uses the radius tokens in only about a fifth of places.
   *Fix:* make the redesign's shapes the base: pill buttons, 12px inputs,
   16–20px cards, everywhere.

2. **No type scale.** Over 30 different font sizes are used (9 to 56px). The
   base interface text is 13px with 11–12px secondary text, which reads small
   and dense next to typical SaaS apps at 14–16px.
   *Fix:* six or seven named sizes, base 14px.

3. **Colours bypass the tokens.** 528 hard-coded colour values outside
   `tokens.css` (many are copies of the token values), two different error reds
   and no tokens for error, warning or info.

4. **Every area has a different page width.** Home content 1056px, Projects
   and Tools 1008px, the Domains search 800px, the conversation 748px, Logo
   792px, and Creative direction, Inspiration and Assets nearly full width
   (1376px). On Inspiration, Embel's message sits in the narrow column while the
   grid runs edge to edge.

5. **Two background patterns.** Dots on Home, Ideas, Domains, 404 and inside
   projects; a square grid on Projects, Library, Settings, sign-in, Names,
   Handles and Trademarks.

6. **Page headers aren't aligned the same way.** Domains is centred; every
   other page is left-aligned.

7. **Three designs for the same project card.** The Home card, the Projects
   card (with a large empty gap between the name and its details) and the
   loading card all differ. (`10-projects.png`, `12-home-signed-in.png`)

8. **Tabs and toggles take four forms.** Underline tabs (Settings, Library and
   all Tools; Names nests two rows of them), pill toggles (Home, naming All/Saved),
   separate buttons (Inspiration's Identities/Logos/All) and a boxed segmented
   control (CSS/JSON). The bold active tab also shifts its neighbours sideways.

9. **Filter menus look like links to other pages.** "All projects ›", "All
   formats ›", "All states ›" use a right chevron.

10. **Three input styles.** A black border (Names), a grey fill (Handles
    prefixes and suffixes), and a light border elsewhere. Single-line Trademarks
    fields are resizable text areas with a drag handle in the corner.

11. **Two different composers.** Home has attach and dictation; inside a project
    the composer has "Move composer", "Expand composer" and "Minimize composer"
    controls and no attach or dictation. The conversation scrolls visibly
    underneath it with no fade, so cut-off text and avatars show below it.

---

## P2 — Brand journey screens

1. **The step pills don't take you to the step.** Clicking Strategy opens the
   conversation scrolled to the bottom with Voice highlighted.
   (`33-launchpad-strategy-00.png`)

2. **The journey isn't one conversation yet.** Strategy and Voice are one
   scrolling conversation; Inspiration, Logo, Creative direction and Assets are
   separate pages with different widths. The composer disappears on the Logo
   page, so "refine through the box below" has no box.

3. **Logo page header is cluttered.** A large empty gap under Embel's message,
   then "Logo chosen. Continue, or describe a change below.", "6 of 6 concepts
   ready" and a lone "More concepts" button. Below the grid: "Refine selected"
   plus a second panel "Refinement target: Concept 4 · Refine logo · Project
   context", then a "Download your logo" card with a grey filled button in the
   middle of the journey. The selected concept has only a dark border, no check
   mark. (`35-launchpad-identity-00.png`, `-01.png`)

4. **Creative direction.** A stray grey "Download PNG" button sits under
   Embel's message with no context, then a logo thumbnail with "Change logo".
   "Compare visual directions", "Selected direction: Room to Begin." and "3 of 3
   ready" stack up. The step is called Creative direction in the message,
   "Visual direction" in the page title and "Compare visual directions" on the
   page. The direction boards themselves look good.
   (`36-launchpad-directions-00.png`)

5. **Assets.**
   - A grey full-width bar "Your brand assets are ready." looks like a debug
     notice.
   - Embel's message says "Brand images · 1 of 3" above a card titled "Brand
     board", and names the direction ("all in Room to Begin") as if the reader
     remembers it.
   - "In practice" on the brand board ends in a large empty area.
   - The "Selected direction" thumbnail is too small to read.
   - Download buttons are labelled only "PNG" and "SVG".
   - Spelling switches between "Colours" and "Color palette".
   - The guidelines list competitors ("Compared with: Looka, Brandmark…").
   - The Voice line ends in `"From idea to identity.".` (double full stop).
   - The design-system preview puts apricot text on paper (1.6:1 contrast),
     breaking the guidelines' own rule.
   - "Download brand kit", the end of the whole journey, is a small square
     button at the bottom of a 7,000px page with no completion moment.
   - Two headings on the page have no text (screen readers announce them).

6. **Competitor question.** Cards are tall: "Why it matters" mostly repeats the
   description, so only two or three fit on screen. Every card says
   "Recommended". Hovering a card gives it the same dark border as selecting it.
   Site icons render at different sizes. In the summary, competitor logos
   overflow their chips and the chips wrap raggedly. (`53-research-result-00.png`,
   `34-launchpad-conv-00.png`)

7. **Naming.** 100 names arrive at once. ".com" status stayed on "Checking
   .com…" for most names during this session, with no timeout state (may be
   partly local). "Saved names & history" floats above the All/Saved toggle.
   Some names are misspellings or carry bad associations ("Servise",
   "Audence", "Distory", "Bluebeard"). (`40-untitled-naming-01.png`, `-04.png`)

8. **A stalled project is a dead end.** "Your brief is saved. Send a message
   below to begin competitor research when AI is available." — no button and no
   Embel avatar. (`41-brief-00.png`)

9. **Research progress.** The progress bar is a small dash that reads as
   "barely started" and gives no sense of steps or time.

10. **Inspiration.** The Continue button touches the right edge of the window
    and, with "0 liked · Next: Logo", overlaps the images. White hearts are
    nearly invisible on light tiles. Credit lines read "icon via Simple Icons".
    Flat icon tiles sit next to rich photography. Footer links "Saved references
    & systems · Visual directions" are plain underlined text.
    (`37-launchpad-inspiration-00.png`)

11. **Browser tab titles** inside a project: "Account brand · Embel", "Embel —
    Brand workspace" (Inspiration), "Visual direction · Embel". The 404 page is
    titled "Does-not-exist · Embel" after the mistyped address.

---

## P3 — Shell, menus and polish

1. **Home flashes fake content while loading.** Every recent card first shows
   "Untitled brand · Open project · Saved project", then switches to the real
   name. *Fix:* skeleton cards. (`11-home-loading.png`)
2. **Untitled projects look identical**, and "No logo selected" on a grey
   panel reads like an error. Show the idea's first line or the brand initial.
3. **Account menu (signed out)** says "Sign in" three times and offers "Refresh
   connection". **Signed in:** a generic person icon instead of initials, "My
   account" with no name, "Refresh connection", mixed icon and text colours, and
   no Help, Feedback or legal links. (`02b-account-menu-signed-out.png`,
   `21-account-menu.png`)
4. **Tools menu** is a plain word list with no icons or one-line descriptions.
5. **Generation activity** closes with a "Close activity" text button rather
   than ×; the item "Needs review … will not be retried automatically" offers no
   action; rows don't link to their project.
6. **Projects page:** "Deleted projects" is a top-level button next to "New
   project"; the card menu has only Delete (no Rename or Duplicate); the project
   menu in the top bar has no Rename.
7. **Sign-in and sign-up:** no show-password toggle; older square card and
   button shapes; "Create account" is a faint link; odd footer line "Your
   projects and names save to your account."
8. **Sharing and browser polish:** no social preview image (`og:image`), no
   PNG or Apple touch icon, no theme colour.
9. **Console errors on normal use:** a 401 from `/api/session` on every page
   for signed-out visitors, and a 404 for every competitor without a site icon.
10. **Scrolling happens inside panels, not the page.** Each area scrolls its own
    inner panel, so the scrollbar starts below the navigation and a full-page
    browser screenshot or print captures only the first screen.
11. **No dark mode** (optional for launch).

---

## What already works

- Keyboard focus is visible (2px ink outline) on everything tested on Home.
- Text contrast in the app interface passes WCAG AA on every page tested; the
  only failure was inside the generated design-system preview.
- No horizontal scrolling at 1024, 1280, 1440 or 1920 widths.
- Escape closes the Tools menu and the activity panel.
- The creative-direction boards, the brand board's typography section and the
  floating step navigation look professional and are the right reference for
  the rest of the app.

## Not covered

Phone and tablet layouts (by agreement), email templates, offline and server
error states, the Audience, Positioning and Personality questions while
unanswered (seen only as summaries), logo generation in progress, and the
contents of the downloaded brand kit.

## Test usage

One new test project ("handmade ceramic tableware … Lisbon") was created to see
the first-run screens; it ran one competitor-research request recorded as
15,983 input and 844 output tokens. Nothing else was generated.

---

## Status — fixes on branch `ui/launch-polish` (November 7, 2026)

Fixed (checked in the browser at 1440 × 900, signed in and signed out):

- **Shared design:** pill buttons everywhere, inputs and cards on the
  rounder scale, one dot background, no text below 12px, readable disabled
  buttons, and tokens for status colors and page widths. List and tool pages
  share one 1056px width.
- **P0:** Settings is now Account and Usage, with no "Not available yet"
  cards or diagnostics; usage totals are fixed. Deliverables use the chosen
  slogan and positioning, with no placeholder text. Logos have transparent
  and one-color reversed copies (added to the kit). Technical wording is
  rewritten across the app. Chosen project names show in Library, activity,
  card menus and project lists. `/brands/new` and `/brands/logo/new` redirect
  to Home; the old vector-editor link is gone; the 404 page is redesigned.
  Handles and Trademarks say plainly what they don't check.
- **P1:** one card design for Home and Projects, consistent tabs (no shifting),
  segmented toggles for inner choices, one input style, down chevrons for
  filter menus, one composer without move/expand/minimize controls.
- **P2:** step pills scroll to their step and stay checked when done; tidy
  toolbars on Logo and Creative direction; "Creative direction" used
  everywhere; Inspiration aligned with a non-overlapping Continue bar;
  shorter competitor cards with distinct hover and selected states; "Start
  research" for stalled projects; ".com" checks time out to "not checked";
  plain page titles; no money shown anywhere in the logo screens.
- **P3:** skeleton loading cards, idea text for projects without a logo,
  initials in the account menu, "Sign in" and "Create account" in the
  navigation when signed out, a tools menu with icons and descriptions,
  show-password toggles, social preview image and app icons, no console
  error for signed-out visitors.

Still open:

- Decisions needed: signed-out landing content, pricing, Terms and Privacy,
  password reset, and whether to keep, finish or hide Handles and Trademarks.
- Worker prompt changes (not made, they need a worker release): stop the
  strategy prompt from explaining its scoring scale, and stop the identity
  prompt from naming token keys. Both are already hidden on screen.
- A real monthly usage total needs a new server query; Usage shows the
  recent requests.
- Rename from the project card needs a rename API.
- Playwright specs were updated by text only and have not been run; CI does
  not run them.
- Dark mode and phone layouts remain out of scope.
