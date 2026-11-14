# Embel design audit: the merged brief

Status: **complete** (the recap at the end lists what is still open). Code references were refreshed on November 14, 2026 after the cleanup in PR 258: line numbers follow each item's selector, component or function, and references to code that PR removed say so.
Date: 2026-11-12. Merged from `README.md`, `00_inventory.md`, `01_experience_review.md`, `02_motion_interaction.md`, `03_accessibility_technical.md`, `04_image_needs.md` and `05_design_system.md`, all in `design-audit/`. The app was not opened for this merge and no application file was changed.

**What this file is for.** It is the brief for Claude Design (the design system first, then the screens), the worklist for implementation, and later the checklist for reviewing the result. It is written to stand alone: a reader does not need the pass files to act on it, although each finding names its sources.

**How to read it.**

- **Finding IDs.** Every merged finding has a new ID, D-001 to D-97, in ranked order: severity first, then reach (problems that touch the whole app or the main journey before isolated ones), then effort (smaller first). The `Sources` field keeps the original IDs: E- (pass 1, experience), M- (pass 2, motion), A- (pass 3, accessibility and technical), DS- (pass 3b, design system), IMG- (pass 1b, image slots). The 163 source findings became 97.
- **Severity.** P0 blocks or breaks a task. P1 hurts trust or completion; any WCAG AA failure on a main flow is at least P1. P2 is noticeable polish. P3 is nice to have.
- **Tag.** *Needs redesign* means a new visual or interaction decision is required, so the item goes to Claude Design (sections 5 and 6). *Execution fix* means the right answer is already clear, so it goes straight to implementation (section 7).
- **Fixed by.** A screen finding that a design-system change will fix names that design-system item. The system item supplies the component; the screen keeps only its own share of the work.
- **Suggested direction** is a suggestion. It describes one good answer to the problem; Claude Design may solve the problem another way.
- **Needs the owner.** The redesign changes how the app looks and responds, not what it does. Where a direction would need new behaviour, new data, a document or a decision only the owner can make, the finding says so.
- **Evidence** paths are relative to `design-audit/evidence/` unless they start with `src/` or `design-audit/`. Screenshots are named `<route>__<state>__<width>.png`.
- **Where in the code** gives a file, a line and the component or function name. Line numbers are as of 2026-11-11 and 11-12. The code will be restructured before implementation, and a later pass uses the names to find each item again.

**Terms.**

- **Token:** a named value defined once and reused, such as the colour of a border. **Design system:** the tokens plus the shared components (button, dialog, message) and the rules for using them.
- **WCAG:** the Web Content Accessibility Guidelines, version 2.2. AA is the usual legal and commercial target. A number such as 1.4.11 identifies one testable rule.
- **Contrast ratio:** the measured difference in brightness between two colours, from 1:1 to 21:1. Text needs 4.5:1; the outline of a control and a focus ring need 3:1. Every ratio in this file was calculated, not judged by eye.
- **Focus ring:** the outline that shows which control the keyboard is on. **Tab stop:** one press of the Tab key.
- **Skeleton:** grey blocks in the shape of content that is still loading.
- **CLS, LCP, INP:** Google's three Core Web Vitals. CLS (layout shift) scores how much a page jumps while loading; good is 0.1 or less. LCP is when the main content appears; good is 2.5 seconds or less. INP is how fast the page reacts to a click; good is 200 ms or less.
- **Phone conditions:** a 390 px wide screen, a processor slowed 4 times and a slow mobile network, simulated on the production build.
- **Showcase brands:** Kestrel Analytics and Orchard Lane Cider, the two test brands with real generated images.

## 1. Summary for a non-designer

**Overall verdict.** Embel's structure is sound and its surface is calm. A person can go from an idea to a downloadable brand kit without getting lost, the palette stays out of the way, the copy is mostly plain, and the technical basics are unusually good (Lighthouse scores 100 for accessibility on 33 of 39 screens, and nothing in the app drops frames). What keeps it from "top-tier" is not the bones. It is four things: the product shows its own best work too small and delivers a weak ending; the system often talks about itself instead of the person's situation; actions are answered late or the page moves under the person; and underneath, almost every building block (button, dialog, message, "selected" state) exists in several hand-built versions, because the design system has rules for colour and little else.

The audit merged into **97 findings: 1 at P0, 35 at P1, 45 at P2 and 16 at P3.** 38 need a design decision and go to Claude Design; 59 are execution fixes with a clear answer.

**What already works.** The four-step journey and its one-question-at-a-time conversation; answered questions folding to one line; the warm ink-on-paper palette; the floating pill navigation; honest, specific copy in the password flows; reversible delete; "Retry 2 failed concepts"; the large inspiration brand view, which is the quality bar for the rest; dialogs that already behave correctly for keyboards; and the restraint in motion. None of this is fixed: the owner decided on 2026-11-12 that Claude Design may keep, change or replace any of it.

**The top 10 issues.**

1. **Deleting an account fails for most accounts** (D-001, P0). A fix was merged to `main` after the audit saw it; it has not been verified yet.
2. **Form fields and the keyboard focus ring are hard or impossible to see** (D-002, D-005). Field outlines measure 1.2:1 where 3:1 is required, placeholder text 3.6:1 to 3.9:1 where 4.5:1 is required, and the focus ring disappears on the inspiration gallery. These are accessibility failures on the main journey.
3. **There is one of nothing.** Four button implementations with no pressed state, ten hand-built dialogs, about twenty message styles, eight looks for "selected", no shared way to show loading (D-018, D-006, D-007, D-008, D-009, D-046). Every inconsistency on screen follows from this.
4. **The two decisions the product leads to have no clear controls and are shown at thumbnail size.** Logo concepts and direction boards are about 237 px wide on a 1440 px screen, with no label, no "Choose" button and no way to compare (D-007, D-013).
5. **A finished brand is one page 5,400 px tall with other companies' artwork permanently open in the middle, and it jumps when opened** (D-021, D-019). Layout shift is 0.18 on desktop and 0.75 under phone conditions; good is 0.1 or less. By keyboard the reply box is the 141st stop.
6. **The ending is the weakest part.** Every brand gets the same template with two circles, whatever direction was chosen; the guidelines are one sentence per topic and an unstyled web page as a file; a board can show a different logo from the one chosen; and the Assets page shifts by half a screen as it loads (D-022, D-023, D-024, D-029).
7. **Credits are invisible until they block you.** No balance in the navigation; running out produces three overlapping messages and two different renewal dates; Plans lists numbers with no meaning and clips its prices on a phone or at high zoom; Usage counts "tokens" and leaves out images (D-015, D-014, D-031, D-033, D-036).
8. **The system describes itself.** "Check AI availability", "The saved project could not be verified", "requests cancellation of active work", and up to four names for one thing (D-026, D-030, D-032, D-056, D-035).
9. **Actions are answered late, and keyboard users lose their place.** Paid actions show no change for up to 3 seconds; finished work is briefly reported as missing; focus drops to the top of the page after most actions (D-012, D-011, D-010, D-058).
10. **Trust gaps at the edges.** No Terms, Privacy or Help link anywhere; the only landing page shows no example of the result; images are sent at full size, so a brand page weighs about 5.6 MB and takes about 9 seconds under phone conditions (D-028, D-017, D-020).

**Recommendation (a), product structure: refresh.** Keep the information architecture (which pages exist and how they are grouped), the navigation and the page layouts; improve how they look, behave and speak.

- *Why.* The structure holds: Home, Projects, a project with four named steps, Assets, Library, Plans and Settings is a shape people already understand, and no finding asks to move a page or regroup the navigation. The main flow completes end to end. Across 96 captured states at three widths, the only layout that breaks is Plans at phone width (D-033). The problems are in depth, not shape. Evidence: `01_experience_review.md` section 5.
- *It is not a light touch.* Four surfaces need real design work inside the existing structure: choosing a logo and a direction; delivery (Assets, brand images, guidelines, exported files); credits and plans; and states and messages. Two smaller questions sit beside them: what Library is for, and what the signed-out Home shows as proof.
- *What you are agreeing to.* In time: 23 screen-level design items in Claude Design, of which the delivery templates and the guidelines document are the largest. In risk: low for navigation and routes, because nothing moves; the existing screenshots stay valid as the "before" set. The real risk is scope: several directions touch behaviour, and those are held back for your yes (see "Needs the owner" in the recap).

**Recommendation (b), design system: rebuild.** The structure underneath the interface is built new, because most of it does not exist yet. Pass 3b recommended keeping the current look (the palette, the floating pill navigation and the rounder corners confirmed on November 6). On 2026-11-12 the owner decided that the look is open as well: Claude Design may keep it, change it or replace it, whichever best serves the Direction.

- *Why.* The design-system audit scores the current system 35 out of 100. Five of eight foundations (spacing, shadows, motion, layering, breakpoints) have no tokens at all; the type scale exists and is used on one page; there is no component layer, so components have forked; and two tokens that every form depends on fail accessibility. A refresh keeps the structure and changes values, and there is too little structure to keep. Evidence: `05_design_system.md` section 1 and `evidence/design-system/drift.md`.
- *What you are agreeing to.* In time: this is the larger commitment. In Claude Design, a new design system built from the specification, not imported from the code (an import would bring in four button versions and ten dialogs). In implementation, about 3,400 hand-written values are replaced by tokens, most of them mechanically, and about 150 unused style rules are deleted, before any screen is redesigned. In risk: visual regression on every screen, and more of it if the look itself changes. That is what the screenshot script (`capture.mjs`) and the five validation screens are for.

**The two verdicts fit together.** They answer different questions. The pages and the navigation keep their shape (refresh); the system that draws them is rebuilt. No change to this pair is recommended.

**Owner's decision (2026-11-12): both verdicts approved.** Claude Design starts on the rebuild path: a new design system built from `05_design_system.md`, not imported from the code.

**Owner's decision (2026-11-12, later the same day): the look is open.** The list of things that must stay was removed from this brief, and every "keep the look" statement was loosened. What the app does and which pages exist stay as they are; how it looks is Claude Design's to propose.

**Three things to know before you approve.**

1. Both of the audit's blocking defects already have fixes merged to `main` (PR 254 for account deletion, PR 255 for Library's detail view). Neither is verified by this audit. Both are first on the review checklist.
2. 18 findings carry a "Needs the owner" note, because their direction touches behaviour, data, legal text or a real AI generation. They are listed in the recap. None blocks Claude Design from starting.
3. Embel needs no AI-generated or commissioned imagery for its own interface. Every image slot is filled by real output, code-drawn templates, one icon family, or what exists.

## 2. Design direction brief for Claude Design

### Direction (from `README.md`, unchanged)

- Audience: solo founders and startups, small local businesses, and freelancers or agencies who create brands for clients. Most are not designers. Freelancers and agencies expect professional control and polished exports.
- Target feel: minimal and premium. Calm, precise, generous white space. The interface stays quiet so that the user's own generated brand is the most colourful thing on the screen.

The setup offered the owner two more lines, on products whose look they admire and on things that must stay. Both were left blank. **Owner's decision (2026-11-12): this brief lists nothing that must stay.** Claude Design is free to design what it judges best, within the Direction above and the constraints below.

### What the product is

Embel turns a product idea into a usable brand. A person types a brief on Home; competitor research starts by itself, and a guided conversation walks through four steps: **Strategy** (Competitors, Audience, Positioning), **Voice** (Personality, Name, an optional Slogan), **Identity** (Inspiration, Logo, Creative direction) and **Assets** (Brand images, Brand guidelines, Design system, with downloads). The Logo step produces six black-and-white concepts that can be refined by describing a change; Creative direction produces three full-colour boards built around the chosen logo. AI work costs credits: Free, Pro and Studio plans give 30, 150 and 500 a month. There are no marketing pages, so the signed-out Home is the landing page. The app is light mode only.

### What must feel different

1. **The person's work is the hero.** Logos and direction boards are shown large enough to judge. Finished steps fold away. Other companies' artwork is never permanently open above the person's own.
2. **The ending delivers.** The brand images inherit more from the chosen direction than four colours. The guidelines are a document worth sending to a client. The Assets page feels like opening a finished package, and it arrives without jumping.
3. **Embel talks about the person's situation, never about itself.** One voice, one name per thing, and no "verified", "requests" or "generations" in customer copy.
4. **Every action is answered at once.** A pressed state on every button, a visible change within 100 ms, and nothing already on screen moves because something else loaded.
5. **Credits are visible before they block.** The balance is in the account menu, and one clear message appears when it runs out.
6. **There is one of everything.** One button, one message, one dialog, one look for "selected", one way to wait.
7. **Embel is recognisably itself in a few deliberate places.** Minimal is achieved; premium needs a point of view. Boldness is spent in one or two places and the rest stays quiet.
8. **Fields can be seen and focus can be followed.** By everyone, at any zoom.

### Target qualities

Calm, precise, understated. Generous white space. An interface quiet enough that the person's generated brand is the most colourful thing on screen. Legible to non-designers: nothing important in small grey type. Professional enough for freelancers and agencies: exports a customer would be proud to share, and controls that say what they do. Honest: the interface never claims what is not true.

### Constraints and goals

These are limits and goals, not a visual style. The style is Claude Design's to propose within them.

- **The look is open.** Nothing about the current appearance has to survive. Palette, typeface, shapes, canvas, navigation style, motion and imagery may all be kept, changed or replaced, whichever best serves the Direction. The one colour ruled out is magenta, which the owner has rejected as an accent.
- **What the app does is fixed.** Keep the pages, the destinations in the navigation and the routes. Keep the same data, actions and states as the real screens. Do not invent features. Within a page, the layout is open. Where a finding carries "Needs the owner", design it as an option and say so.
- **Design system first.** Build the system from `05_design_system.md` and prove it on the validation screens before redesigning any other screen (section 5).
- **Seven taste decisions are open** (section 3). Each comes with two options from the audit. They are starting points: recommend one, or propose a better third, and wait for the owner's answer.
- **Light mode only.** No dark mode is asked for; the token structure should make one possible later.
- **Desktop leads.** The owner's priority is desktop first. Designs are still needed at 390 px, and at 768 px where the layout changes, because narrow layouts are also what a person at high zoom sees, and reflow is an accessibility requirement.
- **Credits, never money.** The app shows remaining credits. It shows no cost estimates and no invented progress numbers. The plan prices on Plans are the only money shown.
- **Imagery.** The imagery pass recommends real output over illustration, stock photography or AI-made art (section 4). That is a recommendation, not a rule: propose other imagery if it serves the Direction, and label any slot that would need generating.
- **Meet section 8** (accessibility and performance acceptance criteria) in every design.
- **Goals to hold each screen to:** the person's brand is the loudest thing on it; one primary action is obvious; every state is designed (default, empty, loading, error); every word is one a founder would use.

## 3. Design system

**Source of truth: [`05_design_system.md`](05_design_system.md).** This section is a summary. The full specification (token names and values, the type scale, every component and its states, the patterns, and the map from old values to new) is in that file and is not copied here.

**Verdict: rebuild.** Pass 3b's verdict was "rebuild the architecture, keep the look". The owner has since opened the look as well (section 1), so where `05_design_system.md` says something must be kept, read it as a description of what works today, not as a requirement. Design-system skill score: 35 out of 100 (token coverage 13.5 of 40, component completeness 14.5 of 40, naming and documentation 7 of 20).

**How to start in Claude Design.** Start a new design system from the specification; do not import the current code with `/design-sync`, because that would bring in four button versions and ten dialogs. Attach current screenshots as a record of where the app is today, not as a look to preserve.

**The top changes.**

| What | From | To | Finding |
| --- | --- | --- | --- |
| Token structure | One flat file of 40 tokens covering three foundations | Primitive, semantic and component layers covering all eight | D-018 |
| Field outlines and placeholders | 1.28:1 and 3.9:1 | A control-outline role at 3:1 or better; a placeholder at 4.5:1 or better | D-002 |
| Focus ring | One colour, eleven offsets, clipped on tiles, removed in 14 places | A two-part ring, two offsets, never clipped, never removed | D-005 |
| Buttons | Four implementations, no pressed or shared loading state | One component, six states | D-006 |
| Selection | Eight looks; logo and direction cards with no visible control | One Choice card | D-007 |
| Messages | About 20 classes in seven looks, no toast | One Inline message in four tones and three forms, plus a Toast | D-008 |
| Loading | Text, blanks, three pulses | Skeleton, button spinner, progress bar; a Media frame that reserves image space | D-009 |
| Dialogs and menus | 10 and at least 6, hand-built | One Dialog in four widths, one Drawer, one Menu | D-046 |
| Type | 13 px for most things; 19 sizes | Ten roles; 14 px labels, 15 or 16 px body, nothing under 12 | D-044 |
| Disabled and busy | Two disabled looks; "disabled" used while a request runs | One disabled look; busy is a loading state that keeps focus | D-037 |
| Empty states, form controls, icons | 24 classes; browser defaults; three ways to draw an icon | One Empty state; system form controls; one icon family | D-038, D-047, D-049 |
| Motion | No tokens; reduced motion removes all animation | A small token set; reduced motion removes movement and keeps feedback | D-048 |
| Spacing, radius, shadows, breakpoints | 53 values, 18 values, 34 shadows, 21 widths | 14 steps, 6 steps, 4 levels and one backdrop, 3 named ranges | D-059, D-050, D-051, D-052 |

**Decisions marked "decide in Claude Design".** Each is a matter of taste, and both options fit the Direction. The specification does not choose. The options are starting points: Claude Design may recommend one, or propose a different answer.

| # | Decision | Option A | Option B |
| --- | --- | --- | --- |
| 1 | Accent colour | Ink only | One quiet accent used only for selection, links and focus (candidates: ink blue `#24406b`, slate `#3d4f63`) |
| 2 | Typeface | Geist Sans alone | Geist Sans plus one display face for three heading roles |
| 3 | Density | Comfortable: body 15, controls 44, card padding 24 | Roomy: body 16, controls 48 and 40, card padding 32 |
| 4 | Control shape | Pill buttons (today) | Pills for navigation and chips only; buttons at 12 px |
| 5 | When content is a card | Cards only for objects (a project, an asset, a plan, a choice); page sections sit on the canvas | Sections stay cards, and object cards get a distinct treatment |
| 6 | The dot-grid canvas | Only where work is made (Home and the project conversation) | Removed everywhere |
| 7 | Selected state of a choice card | A 2 px ink ring with a filled tick badge in a fixed corner | An ink ring plus a soft fill and a text label ("Chosen") |

Three further values are open because they depend on those options: the placeholder colour, the control-outline grey and the disabled-text grey. Their candidates and required minimums are in `05_design_system.md` section 3b. Any chosen accent must reach 4.5:1 as text, must not be magenta, and should stay out of green, red and amber, which carry status. In every option a selected state also needs a cue that is not colour.

The merge adds three smaller choices, recorded in the findings: the icon family (D-049: adopt Lucide, or extend the hand-drawn set at one stroke weight); how finished results arrive and whether cards respond to hover with more than colour (D-048); and two screen-level options where passes differed (D-060, D-068).

**The validation set.** Five real screens that Claude Design rebuilds with the new system, using only the system, to prove it works: Projects with eight brands, the card menu and the delete dialog; Settings, Account tab, with the offline save error; Library, empty; the project conversation for Tidewater Kayak Tours (logo concepts partly failed, with the out-of-credits message); and the Logo and Creative direction steps for Kestrel Analytics. A sixth is worth adding if time allows: Assets for Kestrel Analytics. Details and screenshot names are in `05_design_system.md` section 6.

## 4. Imagery

**Source of truth: [`04_image_needs.md`](04_image_needs.md).** It holds the full table of 29 image slots with sizes, formats, weight budgets and alt text. This section is a summary.

**Verdict.** Embel needs very little new imagery, and none of it should be illustration, stock photography or AI-made decoration: everything colourful on screen is, and should remain, either the person's own generated brand or the inspiration gallery. The work is to use the product's own output better. The one real gap is the signed-out Home, which shows no example of what Embel makes; a row of three real finished brands fixes it. Inside the app, logos and direction boards are shown too small and downloaded far too large, so the needs there are bigger presentation and proper thumbnails. The largest need is the exported files: every brand's social images and brand board share one fixed decoration, and the downloadable guidelines contain no logo and no image, so those templates are redrawn in code from the chosen direction. Of 29 slots, 9 keep what exists, 9 show real product output, 6 are drawn in code, 2 come from one icon library, 2 are removals and 1 is licensed third-party work; **none needs an AI-generated or commissioned image.**

This is the imagery pass's recommendation. Since the owner opened the look on 2026-11-12 it does not bind Claude Design, which may propose other imagery where it serves the Direction.

**Art direction block (unchanged).** It governs Embel's own imagery only, not what Embel generates for a person's brand. Its palette is the current token set and is replaced by the new design system's colours before any asset is produced. It is a draft that describes today's look; if Claude Design changes the look, the block is revised to match first.

```text
ART DIRECTION: EMBEL (draft, 2026-11-11)

Brand adjectives: calm, precise, understated.

Medium and style: flat vector drawing built from the geometry of the Embel
mark: solid square ink blocks on a strict grid, plus thin even lines with
round ends (1.5 px on a 24 px grid). Two-dimensional only. No gradients, no
3D, no perspective, no hand-drawn wobble.

Palette (current tokens, TO BE REPLACED BY THE NEW DESIGN SYSTEM):
  canvas   #F7F7F5   page background, the dominant colour of any image
  paper    #FFFFFF   raised surfaces
  surface  #F1F0EE   quiet fills
  ink      #191919   the only strong colour; marks, blocks, lines
  grey     #696965   secondary lines and details
  hairline #E4E3DF   borders and dividers
  hairline-strong #C9C8C2
  grid dot #DAD9D4
No accent colour. Never magenta. No colour that is not in this list: in the
product, the customer's own brand is the only colourful thing on screen.

Lighting and texture: none. Flat fills, no shadows, no glow, no grain, no
paper texture, no blur. Depth comes only from overlap and hairlines.

Composition: one subject per image. The subject takes at most one third of
the frame and sits at the centre or just left of centre. At least 40% of the
frame stays empty canvas. When text will be placed over or beside the image,
keep one side (the left half, or the lower third) completely clear. Align
everything to an 8 px grid. Square corners on ink blocks, as in the mark.

Avoid: any text, letters, numbers or logos inside the image; real brands or
anything resembling one; real people's likeness, and faces of any kind;
stock-photo cliches (light bulbs, rockets, handshakes, puzzle pieces, robots,
brains, magic wands, sparkles, paint splashes, people pointing at screens);
purple or blue "AI" gradients; glass, clay or isometric 3D; drop shadows;
decorative blobs and floating circles.

References:
  1. public/embel-mark.svg (the pixel ring: the source of the geometry)
  2. the share image at /opengraph-image (mark, type and canvas together)
  3. design-audit/evidence/annotated/E-054.png (not a style reference: the
     standard for how large and how calmly an image should be presented)
```

**P1 and P2 image slots.**

| ID | Route or component | Source | Purpose | Priority | Tag | Merged finding |
| --- | --- | --- | --- | --- | --- | --- |
| IMG-007 | Signed-out Home: a row of three example brands | REAL SCREENSHOT | informative | P1 | needs redesign | D-017 |
| IMG-012 | Library card previews | REAL SCREENSHOT | informative | P1 | execution fix | D-020 |
| IMG-018 | Logo concept cards | REAL SCREENSHOT | informative | P1 | needs redesign | D-013 |
| IMG-021 | Creative direction cards | REAL SCREENSHOT | informative | P1 | needs redesign | D-013 |
| IMG-022 | Brand board: the Assets preview and `brand-board.png` | CLAUDE SVG-CSS | informative | P1 | needs redesign | D-022 |
| IMG-023 | Social profile image | CLAUDE SVG-CSS | functional | P1 | needs redesign | D-022 |
| IMG-024 | Post templates, square and portrait | CLAUDE SVG-CSS | functional | P1 | needs redesign | D-022 |
| IMG-025 | Banners, wide and cover | CLAUDE SVG-CSS | functional | P1 | needs redesign | D-022 |
| IMG-026 | Brand guidelines: Logo and Imagery sections, and `brand-guide.html` | REAL SCREENSHOT | informative | P1 | needs redesign | D-023 |
| IMG-001 | Brand mark: navigation, sign-in card, conversation avatar | KEEP | functional | P2 | execution fix | D-043 |
| IMG-002 | Browser and home-screen icons | KEEP | functional | P2 | execution fix | D-043 |
| IMG-003 | Share image for links (`/opengraph-image`) | REAL SCREENSHOT | informative | P2 | needs redesign | D-075 |
| IMG-004 | Interface icons, every route | ICON LIBRARY | functional | P2 | needs redesign | D-049 |
| IMG-008 | Home for a new account | REAL SCREENSHOT | decorative | P2 | needs redesign | D-060 |
| IMG-011 | Project card thumbnail | REAL SCREENSHOT | functional | P2 | needs redesign | D-068 |
| IMG-014 | Inspiration gallery tiles, 56 brands | STOCK (licensed studio work) | informative | P2 | execution fix | D-067 |
| IMG-016 | The earlier inspiration catalogue, 30 files | REMOVE | none | P2 | execution fix | D-079 |
| IMG-019 | Logo placeholders: drawing and failed tiles | CLAUDE SVG-CSS | functional | P2 | execution fix | D-062 |
| IMG-020 | Chosen-logo thumbnails | REAL SCREENSHOT | functional | P2 | execution fix | D-020 |
| IMG-027 | Exported logo files | KEEP | functional | P2 | needs redesign in pass 1b; merged as an execution fix plus an owner decision | D-063 |
| IMG-029 | Stripe checkout and portal branding | KEEP | functional | P2 | execution fix | D-078 |

The eight P3 slots (IMG-005, 006, 009, 010, 013, 015, 017, 028) are in `04_image_needs.md` and are mapped to merged findings in the appendix.

**Note for Claude Design:** "Use labelled placeholders for every AI RASTER, AI VECTOR and ILLUSTRATOR slot, keep the IMG-ID in the placeholder label, and report final slot dimensions per breakpoint in the handoff."

No slot has one of those three sources today, so the note applies only if a design adds one. For REAL SCREENSHOT slots, use the showcase brands' real images. Report the final dimensions of every slot per breakpoint all the same: the asset step needs them.

## 5. Claude Design worklist, Part A: the design system (do first)

These are the 15 design-system items that need a design decision, in ranked order (D-002, D-005, D-006, D-007, D-008, D-009, D-018, D-037, D-038, D-044, D-045, D-046, D-047, D-048, D-049). Each lists the screen findings it fixes, so those are not separate screen work.

**Build order differs from rank.** D-018 (the token architecture) ranks below smaller items because it is the largest, but everything else is written against it, so it is built first. Then the foundations, then the components, then the five validation screens.

**D-002. Field outlines and placeholder text fail contrast**
- Sources: DS-002, A-001, A-002
- Screen/route, state and width: Every text field, search box, drop-down and checkbox; 390 and 1440.
- Category: color · Severity: P1 · Tag: needs redesign
- WCAG criterion or measured value: WCAG 1.4.11 Non-text Contrast (AA); 1.4.3 Contrast (Minimum) (AA)
- What's wrong: The token `--border` (`#e4e3df`) is both the decorative hairline and the outline of every field. It measures 1.28:1 on white and 1.19:1 on the page canvas; the minimum for the edge of a control is 3:1. The stronger token `--border-strong` is 1.67:1. The token `--placeholder` (`#82817b`) measures 3.9:1 on white and 3.64:1 on the canvas; the minimum for text is 4.5:1. Three placeholder colours are in use. On the brand page the placeholder is the only visible instruction for the reply box.
- Why it matters: People with low vision, and anyone on a dim or sunlit screen, cannot see where to type. Faint boxes also undercut the "precise" feel in the Direction.
- Suggested direction: Split the role. Keep the hairline for cards and dividers. Add a control-outline role that reaches 3:1 on paper and canvas, and one placeholder colour that reaches 4.5:1 on all three surfaces. The grey values are chosen in Claude Design within those minimums (candidates and calculated ratios are in `05_design_system.md` section 3b). Decide the outline of secondary buttons at the same time.
- Where in the code: `--border`, `--border-strong`, `--placeholder` in `src/styles/tokens.css:8-12`; `.field-label input` in `src/styles/globals.css:77-79`.
- Screen findings merged into this item: A-001, A-002
- Evidence: `a11y/sign-in__default__1440.json`, `a11y/settings__account-pro__1440.json`, `a11y/brand-conversation__kestrel-complete-pro__1440.json`, `design-system/contrast.md`, `screens/sign-in__default__1440.png`, `screens/settings__account-pro__1440.png`
- Systemic? Yes: one token with 253 uses; over 100 measured fields.

**D-005. The focus ring is not a system: it vanishes on dark artwork, is clipped on gallery tiles and is removed in 14 places**
- Sources: DS-014, A-004, A-005, A-012
- Screen/route, state and width: All screens; worst on the inspiration gallery inside a brand, and on the Home prompt; 390 and 1440.
- Category: components (keyboard) · Severity: P1 · Tag: needs redesign
- WCAG criterion or measured value: WCAG 2.4.7 Focus Visible (AA); 1.4.11 Non-text Contrast (AA)
- What's wrong: The focus ring (the outline that shows which control the keyboard is on) is a 2 px ink outline. It measures 15.4:1 or better on light surfaces and 1.02:1 to 1.11:1 on dark gallery artwork. 59 rules in 25 files override it with eleven offsets from -6 to 4 px, and 14 declarations remove it. On inspiration tiles, which are 40 of the 141 keyboard stops on a finished brand, the ring is cut off by the tile's rounded box, so nothing shows at all. The Home prompt's only focus cue is a border at 2.35:1, and the "own slogan" field removes the outline with no replacement (found in code).
- Why it matters: A keyboard user loses their place exactly where the page has the most controls, and on the first control anyone uses.
- Suggested direction: A two-part ring defined as tokens (ink with a paper halo) that holds 3:1 on any background. Two offsets only: outside for free-standing controls, inside for controls that fill a clipped box. No component removes the ring without the standard replacement. Text entry frames show it whenever the field inside has focus.
- Where in the code: Global `:focus-visible` rule in `src/styles/globals.css:22`; gallery tile rule in `src/components/inspiration/inspiration.css:724-728`; Home composer in `src/styles/home-concept.css:60-63`; slogan field in `src/styles/journey-conversation.css:581-590`; good model: gallery search in `src/components/inspiration/inspiration.css:114-116`.
- Screen findings merged into this item: A-004, A-005, A-012
- Screen findings this fixes: D-040 (E-003)
- Evidence: `annotated/A-kbd-tile-unfocused.png`, `annotated/A-kbd-tile-focused.png`, `annotated/A-kbd-home-composer-focus.png`, `screens/home__signed-out-prompt-focus__1440.png`, `design-system/drift.md`, `design-system/contrast.md`
- Systemic? Yes.

**D-006. Buttons exist in four implementations and none has a pressed state**
- Sources: DS-010, M-001
- Screen/route, state and width: Every route; the copies are on the Logo and Creative direction steps and the legacy identity page.
- Category: components · Severity: P1 · Tag: needs redesign
- What's wrong: Besides the shared `.button` class there are two copies in component stylesheets (`primaryButton`, `secondaryButton`) and an `.identity-*-button` family; 136 of 338 `<button>` elements use no shared class. There is no pressed style anywhere: the probe forced 59 kinds of enabled control into their pressed state and none changed. Loading is a spinner on sign-in, a label change on four screens and nothing elsewhere. Primary buttons are full width on some cards and hug their label on others, an arrow is added to some labels, and disabled appears two ways.
- Why it matters: The button is the most used control on the paid journey, and its states are how the app answers a click. On actions that take a second or more to show a result, nothing confirms the press. Heuristic: visibility of system status; consistency and standards.
- Suggested direction: One Button (primary, secondary, quiet, danger, and danger-filled for the last step of a destructive confirmation; 44 px and 36 px) with six states, a width rule and an arrow rule (only on buttons that go to another page), designed once in Claude Design. Pressed: scale to 0.97 over 160 ms with the ease-out token, removed under reduced motion. Loading keeps the label, adds a spinner and stays focusable.
- Where in the code: `.button`, `.icon-button` in `src/styles/globals.css:35-52`; module copies in `src/components/logo-creation/logo-creation.module.css:116-149` and `src/components/visual-directions/visual-directions-view.module.css:113-168`; `.identity-*-button` in `src/styles/identity.css:33-57`. Plan: `design-audit/animation-plans/001-motion-tokens-and-press-feedback.md`.
- Screen findings merged into this item: M-001
- Screen findings this fixes: D-010 (A-003, M-011); D-076 (E-027); D-082 (E-039); D-086 (E-015)
- Evidence: `design-system/components.md`, `motion/probe-summary.md`, `design-audit/animation-plans/001-motion-tokens-and-press-feedback.md`
- Systemic? Yes: every screen.

**D-007. "Selected" has eight looks, and logo and direction cards show no way to choose or compare**
- Sources: DS-011, E-051, A-006, A-007
- Screen/route, state and width: Project conversation: Strategy, Personality, Name, Inspiration, Logo and Creative direction; 390 and 1440.
- Category: components (selection) · Severity: P1 · Tag: needs redesign
- WCAG criterion or measured value: WCAG 4.1.2 Name, Role, Value (A); 1.3.1 Info and Relationships (A)
- What's wrong: A chosen item is shown by an ink fill, an ink border with a soft fill, a 1 px ring, an inset ring with a shadow, a thick radio border, a left bar, a green "Chosen" label or an underline, depending on the step, and the checkbox or radio moves between the left and the far right. A logo concept is a blank white card with no label, no "Choose" button and no hover change; clicking the picture commits the choice. Each logo card contains "Select concept" and "Compare concept" buttons with zero size, so comparing is unreachable for everyone. Direction cards are articles given a radio role with a real button nested inside them, with no radio group, and arrow keys do nothing (the axe rule engine reports "nested-interactive", serious). Logo concepts are `div` elements given a button role. The larger view of a direction has only a Close button.
- Why it matters: Choosing is the product. A first-time user discovers by accident that clicking a picture commits a choice, and a screen-reader user gets a confused picture of the two most consequential controls. Heuristic: recognition rather than recall; consistency and standards.
- Suggested direction: One Choice card with one selected treatment (design-system decision 7; the mark must reach 3:1 and not rely on colour alone), a fixed position for the control, a visible label on every card ("Concept 2"), and for image choices a real, labelled "Choose" button with enlarge and compare as secondary actions. The larger view gains "Choose this direction" and next and previous. Compare becomes a visible feature or is removed. Build choices as real buttons (pressed or not pressed), or as real radio inputs inside a named group.
- Where in the code: `ConceptGrid` in `src/components/logo-creation/concept-grid.tsx:297-310`; `VisualDirectionsView` in `src/components/visual-directions/visual-directions-view.tsx:234-254`; selected styles in `src/components/logo-creation/logo-creation.module.css:454`, `src/components/visual-directions/visual-directions-view.module.css:214`, `src/components/naming/naming-chat.module.css:567, 598`.
- Screen findings merged into this item: E-051, A-006, A-007
- Screen findings this fixes: D-013 (E-033, IMG-018, IMG-021); D-058 (M-015); D-070 (E-038); D-082 (E-039)
- Evidence: `annotated/E-051.png`, `annotated/E-051-larger-view.png`, `annotated/A-kbd-direction-card-focus.png`, `screens/brand-conversation__quill-logos-generated-free__1440.png`, `screens/brand-conversation__kestrel-complete-showcase-pro__1440.png`, `a11y/brand-conversation__kestrel-complete-pro__1440.json`, `a11y/keyboard.json`
- Systemic? Yes: six steps on every brand.

**D-008. Messages have about twenty implementations in seven looks, and there is no toast**
- Sources: DS-012, E-022
- Screen/route, state and width: Sign in, Projects, Deleted projects, Settings, Plans, Home, project conversation, Assets.
- Category: components (feedback) · Severity: P1 · Tag: needs redesign
- What's wrong: Errors, warnings, successes and notices are styled by about 20 separate classes. Seven looks were captured: a square pink strip (Projects), a rounded pink strip with a border (Settings), a pink box under a button (Sign in), bare red text (Plans), a strip docked to the reply box (research failed), a green strip (Plans success), and plain grey paragraphs used for both success and failure (Sign in notices). Danger text is spelled five ways and its background three. There is no component for a brief confirmation (a toast), so "copied", "downloaded" and "moved to Deleted" have no common place, and the out-of-credits prompt is a one-off floating card. Recovery actions are often faint grey text. The empty Deleted projects page shows "Back to projects" twice.
- Why it matters: When something goes wrong, the person has to work out each time whether what they are looking at is an error. Heuristic: help users recognise, diagnose and recover from errors; consistency and standards.
- Suggested direction: One Inline message in four tones (neutral, positive, warning, danger) and three forms (under a field, a block in a card or section, a page banner), always an icon plus text, with the recovery action as a real button. Plus one narrow Toast for confirmations, with Undo where the action can be reversed. Errors are never toasts and never bare coloured text. The patterns are in `05_design_system.md` section 3g.
- Where in the code: `.form-error`, `.form-success` in `src/styles/globals.css:90-91`; Plans notices in `src/styles/plans.css:145-156`; `.guided-conversation-error` in `src/styles/guided-conversation.css:112`.
- Screen findings merged into this item: E-022
- Screen findings this fixes: D-014 (E-037, A-017); D-016 (E-009); D-027 (E-012); D-030 (E-040); D-057 (M-007); D-072 (E-013, E-014, A-013); D-076 (E-027); D-081 (E-030); D-095 (E-016, IMG-009)
- Evidence: `screens/projects__error-api-500-free__1440.png`, `screens/settings__save-error-offline-free__1440.png`, `screens/sign-in__error-wrong-password__1440.png`, `screens/plans__upgrade-unavailable-free__1440.png`, `screens/home__research-failed-pro__1440.png`, `screens/plans__return-checkout-success-fresh__1440.png`, `screens/sign-in__email-confirmed-notice__1440.png`, `screens/projects-deleted__empty-free__1440.png`
- Systemic? Yes.

**D-009. There is no shared way to wait, or to hold space while something loads**
- Sources: DS-015, M-006
- Screen/route, state and width: Project conversation, Assets, Library, Projects, Home, Sign in; 390 and 1440.
- Category: components (loading) · Severity: P1 · Tag: needs redesign
- WCAG criterion or measured value: Layout shift (CLS) 0.18 on desktop and 0.75 under phone conditions on the conversation; 0.55 on Assets (production build)
- What's wrong: Only the project card has a skeleton (grey blocks in the shape of the content to come). Elsewhere loading is a line of text, a blank area, or a "Preparing…" box of a different size from the result, and images have no reserved frame. "Working" is shown seven ways: a spinner, a pulsing mark, a skeleton pulse, a sweeping bar, a rotating research mark (defined in code, not seen running), the logo-drawing texture, and plain sentences ending in "…" with nothing moving. The text-only kind is the most common on the brand page.
- Why it matters: The pages people work on, and the page where they collect the result, jump as content arrives. The person learns one signal for "wait" and then has to learn six more.
- Suggested direction: Three shared pieces: a Skeleton in the final shape and size; a Media frame with a fixed aspect ratio that holds any generated or uploaded image (loading, loaded, failed and private states, with one wording); and exactly three waiting patterns. (1) Content with a known shape: a skeleton. (2) An action just taken: a spinner inside the pressed button. (3) AI work of unknown length: the sweeping bar with one status sentence and a stop control. Keep the logo-drawing texture as the single expressive moment. Retire the rotating research mark.
- Where in the code: `pulse` in `src/components/workspace/project-card.module.css:151-155`; `embel-research-pulse` in `src/styles/guided-interview.css:300-342`; `journey-bar` in `src/components/journey/journey.module.css:283-309`.
- Screen findings merged into this item: M-006
- Screen findings this fixes: D-011 (M-014); D-013 (E-033, IMG-018, IMG-021); D-019 (M-013, A-024, E-052); D-029 (M-019, A-025); D-035 (E-023, E-024); D-041 (E-010); D-055 (E-008, M-008); D-062 (E-036, IMG-019); D-065 (M-018); D-071 (E-045); D-073 (M-009)
- Evidence: `annotated/M-006.png`, `annotated/M-019.png`, `screens/projects__loading-skeleton-free__1440.png`
- Systemic? Yes.

**D-018. The system has one flat layer of tokens, and five of eight foundations have none**
- Sources: DS-001, DS-004
- Screen/route, state and width: All routes, all widths.
- Category: consistency (token architecture) · Severity: P1 · Tag: needs redesign
- What's wrong: `src/styles/tokens.css` holds 40 tokens for colour, part of type, radius and three widths. There are no primitive values under the roles and no component tokens. Spacing (2,355 uses of 53 values), shadows (34 values), layering (12 values), breakpoints (21 widths) and motion (9 durations) are written by hand in each of 41 stylesheets. Ink has three token names (`--text`, `--accent`, `--accent-ink`), `--panel-radius` (16 px) and `--radius-panel` (20 px) are easy to confuse, a second token set (`--branding-*`) lives in two other files, and one scope redefines three global tokens.
- Why it matters: Every inconsistency pass 1 listed as a "design-system symptom" follows from this. Without a semantic layer the two failing colours cannot be fixed in one place, and no later change (an accent, a denser layout, a dark theme) can be made without editing hundreds of rules. Principle: a single source of truth.
- Suggested direction: Three layers (primitive, semantic, component) covering all eight foundations, as specified in `05_design_system.md` section 3a, built first in Claude Design. One name per role; the aliases and the second token set are removed.
- Evidence: `design-system/drift.md`, `src/styles/tokens.css`, `src/styles/branding-stage.module.css`, `src/styles/project-workspace.css`
- Systemic? Yes: every screen.

**D-037. "Disabled" has two looks and is also used to mean "busy"**
- Sources: DS-022
- Screen/route, state and width: Sign in, Settings, Plans, project conversation.
- Category: components (states) · Severity: P2 · Tag: needs redesign
- What's wrong: A global rule fades any disabled button to 48%, while `.button:disabled` sets a muted fill with the same grey as ordinary secondary text (4.84:1), so a disabled label does not look disabled; disabled text measured elsewhere is 1.92:1. Forms set `disabled` on fields and buttons while a request runs, which drops keyboard focus. Disabled buttons give no reason: the Usage "Refresh" while loading, plan buttons before the plan has loaded, a permanently disabled "Check request".
- Why it matters: People cannot tell "not available", "working" and "secondary" apart, and keyboard users lose their place on the main journey.
- Suggested direction: One disabled treatment with its own text colour (candidates and ratios in `05_design_system.md` section 3b), a separate loading state that keeps focus, and a visible reason next to any disabled control.
- Where in the code: `button:disabled` and `.button:disabled` in `src/styles/globals.css:9, 44`.
- Screen findings this fixes: D-010 (A-003, M-011); D-040 (E-003); D-081 (E-030); D-093 (A-030)
- Evidence: `design-system/contrast.md`, `screens/settings__account-pro__1440.png`, `screens/settings__save-error-offline-free__1440.png`
- Systemic? Yes.

**D-038. Empty states come in three styles and 24 classes**
- Sources: DS-016, IMG-010
- Screen/route, state and width: Home, Projects, Deleted projects, Library, search with no match, legacy pages.
- Category: components · Severity: P2 · Tag: needs redesign
- What's wrong: An empty page shows an icon in a grey rounded square with a button (Library), a bare line icon (Home, Projects), or text alone (Deleted projects, search with no match), each with its own spacing. Two legacy versions use dashed borders.
- Why it matters: An empty screen is a new account's first impression of each page; it should invite the next action.
- Suggested direction: One Empty state in three sizes (page, section, no results): a visual slot, a title that says what will appear here, one sentence, and the one action that fills it. The visual slot (image slot IMG-010) is one library icon, 24 px inside a 56 px circle, the same everywhere. The imagery pass recommends no illustration; never a dashed box.
- Where in the code: `public/projects/empty-projects.svg`; `.audience-empty`, `.strategy-empty` (dashed).
- Screen findings merged into this item: IMG-010
- Screen findings this fixes: D-060 (E-004, IMG-008); D-077 (E-041, A-022); D-096 (E-021, E-031)
- Evidence: `screens/library__empty-fresh__1440.png`, `screens/projects__empty-fresh__1440.png`, `screens/home__empty-fresh__1440.png`, `screens/projects-deleted__empty-free__1440.png`, `design-system/components.md`
- Systemic? Yes.

**D-044. The type scale exists but is not used, and most text is 13 px**
- Sources: DS-005
- Screen/route, state and width: All routes, all widths.
- Category: typography · Severity: P2 · Tag: needs redesign
- What's wrong: The `--text-*` scale is referenced 14 times, all on Plans. Font size is written by hand 557 times in 19 values; 13 px accounts for 54% of all sizes and 12 px for another 14%. There are 28 line heights, 27 letter-spacings in mixed units, six weights including 450, 550 and 650, and page titles of 24, 28 and 32 px.
- Why it matters: Small grey text carries instructions, status and errors, which works against an audience of non-designers and against a premium feel. Hierarchy is flat because steps are one pixel apart.
- Suggested direction: Ten type roles (`05_design_system.md` section 3c), with labels at 14 px, body at 15 or 16 px, and nothing under 12 px. The typeface is decision 2 and the body size is decision 3, both chosen in Claude Design.
- Where in the code: Scale tokens in `src/styles/tokens.css:26-34`; `h1` to `h3` in `src/styles/globals.css:19-21`; the only adopter, `src/styles/plans.css:12-142`.
- Evidence: `design-system/drift.md`, `screens/settings__account-pro__1440.png`, `screens/plans__pro-current-pro__1440.png`
- Systemic? Yes.

**D-045. The look is restrained but generic: one card for everything, pills everywhere, a stock typeface at 13 px, and a dot grid**
- Sources: DS-020, E-055, IMG-006
- Screen/route, state and width: Every page; see Home, Plans and Settings.
- Category: consistency (visual identity) · Severity: P2 · Tag: needs redesign
- What's wrong: The app avoids the loud generated-page habits, and its ink-on-warm-paper palette suits the brief. Four habits still mark it as a default kit. (1) One white, rounded, hairline card holds every kind of content at every level of importance: a plan, a settings group, an error, an empty state, a logo. (2) Pill shapes are used for navigation, buttons, chips, tabs and search alike. (3) Geist, the framework's stock typeface, at 13 px does all the talking, and the one distinctive graphic, the pixel-ring Embel mark, appears only at 28 px. (4) A dot grid sits behind most pages as decoration; it stops under the pill on Assets and is absent on the recover page and the legacy identity page. Smaller tells: grey meta lines joined with middle dots, arrows added to some buttons and links but not all, and small all-capitals labels in the exports.
- Why it matters: The Direction asks for "minimal and premium". Minimal is achieved; premium needs deliberate choices in a few places. Today the app could be any assistant product, and the sameness of surfaces flattens hierarchy.
- Suggested direction: Give Embel a deliberate identity. The passes suggest keeping the restraint and the palette and deciding four things: the typeface (decision 2), control shape (decision 4), when content is a card at all (decision 5), and the canvas (decision 6: the dot grid only where work is made, or nowhere). Those options are starting points. Since the owner opened the look on 2026-11-12, Claude Design may go further and change the palette, the shapes or the canvas if that serves the Direction better. Set one rule for links and buttons (arrows only on controls that navigate). If the dot grid stays, it stays a CSS pattern behind one token, never an image file.
- Where in the code: `--dot-grid` in `src/styles/tokens.css:47`, repeated in `src/styles/journey-conversation.css:204, 1061`.
- Screen findings merged into this item: E-055, IMG-006
- Screen findings this fixes: D-068 (E-005, E-017, IMG-011); D-071 (E-045)
- Evidence: `screens/home__signed-out__1440.png`, `screens/home__recent-brands-pro__1440.png`, `screens/plans__pro-current-pro__1440.png`, `screens/settings__account-pro__1440.png`, `screens/brand-conversation__spokesmith-research-done-free__1440.png`, `exports/rendered/kestrel__brand-board.png.png`
- Systemic? Yes: all screens.

**D-046. Ten dialogs and at least six menus are each built by hand, and all appear in a single frame**
- Sources: DS-013, M-003, A-011, A-032, M-010
- Screen/route, state and width: Sign-in overlay, Delete project, Delete account, sign-out confirmation, activity, name preview, direction view, inspiration brand view, details sheets, Library detail; account menu, project switcher, card menu, Sort, the prompt's "+" and voice panels; 390 and 1440.
- Category: components · Severity: P2 · Tag: needs redesign
- WCAG criterion or measured value: WCAG 2.4.11 Focus Not Obscured (Minimum) (AA) passes today, with two risks named here
- What's wrong: Dialog widths are 450, 460, 480, 502, 520, 620, 680, 860 and 1100 px, with two corner radii, six shadows, seven backdrops (from 22% to 53% ink, two of them blurred), two close-button styles and different headers. Every dialog and menu is absent in one frame and complete in the next. Moving between "Sign in" and "Create account" closes one dialog and opens another, which flickers. Five menus are built on `<details>` and stay open when keyboard focus leaves them, so the open account menu covers part of the Projects search field. With a menu open, a tap outside closes it and is also delivered to what is underneath: in the test the app opened a brand's Assets page 74 ms later. Detail sheets and the name dialog have a sticky header with no scroll padding, so a focused control can sit under the header (found in code).
- Why it matters: The behaviour underneath is good (native dialogs that trap focus and close on Escape), so the inconsistency is purely visible, and every fix has to be made ten times. A surface that covers the page with no bridge reads as a cut.
- Suggested direction: One Dialog in four widths (440, 560, 860, 1100 px) with fixed parts and one backdrop without blur, one Drawer, and one Menu. Dialogs fade in and grow from 97% over 200 ms with the ease-out token; menus grow from the corner nearest their trigger over 150 ms; closing is instant; under reduced motion, fade only. Menus close on Escape, on an outside click and when focus leaves; the first tap outside only closes. One dialog stays open when switching between Sign in and Create account. Scrolling dialogs get scroll padding equal to their header.
- Where in the code: `SignInDialog` in `src/components/auth/sign-in-dialog.tsx`; menus in `src/components/workspace/app-shell.tsx:150-163, 179`, `ProjectCapsule` in `src/components/journey/project-capsule.tsx:140-158`, `ProjectsWorkspace` in `src/components/workspace/projects-workspace.tsx:50-66`; good model: `AssetsWorkspace` in `src/components/assets/assets-workspace.tsx:58`; sticky headers in `src/components/ui/context-details.module.css:43-54` and `src/components/naming/naming-inspect.module.css:25-35`; dialog styles in `src/styles/project-card-actions.css:82-96`, `src/styles/auth.css:142-151`; `.menu` in `src/components/journey/journey.module.css:93`. Plan: `design-audit/animation-plans/002-overlay-enter-and-exit.md`.
- Screen findings merged into this item: M-003, A-011, A-032, M-010
- Screen findings this fixes: D-010 (A-003, M-011); D-032 (E-019); D-034 (E-050, M-012); D-065 (M-018); D-074 (E-018); D-080 (E-007)
- Evidence: `annotated/M-003.png`, `annotated/M-010.png`, `annotated/A-kbd-account-menu-left-open.png`, `screens/projects__delete-dialog-free__1440.png`, `screens/home__signed-out-sign-in-overlay__1440.png`, `screens/settings__delete-account-dialog-free__1440.png`
- Systemic? Yes: every dialog and menu.

**D-047. Form controls have no hover or error style of their own, and browser defaults show through**
- Sources: DS-021
- Screen/route, state and width: Sign in, Sign up, Settings, Projects and Library search, the logo version drop-down, the refine box.
- Category: components (forms) · Severity: P2 · Tag: needs redesign
- What's wrong: Text fields do not change on hover. An invalid field has no standard look: sign-in shows a pink box under the button, sign-up shows the browser's own validation bubble, the legacy composer turns its border red. Drop-downs are the browser's control with an overlaid chevron in some places and the bare browser control in others (the logo version drop-down); the refine box shows the browser's resize handle. Checkboxes and radios are the browser's own, 16 to 18 px, with uncontrolled outline contrast.
- Why it matters: Forms are where non-designers need the clearest signals. Heuristic: error prevention; consistency and standards.
- Suggested direction: Text field, Textarea and composer, Select, Checkbox, Radio and Switch with the states listed in `05_design_system.md` section 3f, and the form-validation pattern in section 3g (labels always visible, a message under its field, the app's own messages in place of the browser bubble).
- Where in the code: `.field-label` in `src/styles/globals.css:57-69`; version drop-down in `ConceptGrid`.
- Screen findings this fixes: D-040 (E-003); D-069 (E-035); D-072 (E-013, E-014, A-013); D-081 (E-030); D-093 (A-030)
- Evidence: `screens/sign-up__validation-password-mismatch__1440.png`, `screens/sign-in__error-wrong-password__1440.png`, `screens/settings__account-pro__1440.png`, `motion/probe-summary.md`
- Systemic? Yes.

**D-048. Motion has no tokens, hover is timed four ways, and reduced motion removes every sign of life**
- Sources: DS-019, M-002, M-004, M-017, E-056
- Screen/route, state and width: Every route; loading and generating states for reduced motion.
- Category: motion · Severity: P2 · Tag: needs redesign
- WCAG criterion or measured value: `prefers-reduced-motion` must be respected, and must keep feedback
- What's wrong: There are no motion tokens: nine durations and four easing keywords are written per file. Of 71 kinds of control, 3 carry a transition of their own; most change colour in a single frame, a few ease over 120 ms, and 17 show no hover change at all, including the "Continue" link that leads to Assets and the tabs in Library and Settings. Three pulse loops run at 1.5, 1.6 and 2.8 seconds. One global rule switches off every animation and transition under reduced motion, including the spinner, the progress bar and the skeleton pulse, so a one-minute wait looks like a frozen page. Finished logos and boards replace their placeholders in a single frame, while the one entrance animation replays on all saved sections every time a brand is opened.
- Why it matters: Pass 2 judged the restraint right: it found nothing over-animated and nothing that drops frames. But when one part of the screen eases and the next snaps, the product feels assembled from parts, and people who ask for less movement lose all feedback.
- Suggested direction: Adopt pass 2's token set, which the design-system spec takes unchanged (`05_design_system.md` section 3e): durations of 120, 160, 200 and 300 ms; an ease-out of `cubic-bezier(0.23, 1, 0.32, 1)`; press and entrance scale 0.97; entrance shift 4 px; stagger 40 ms. Rules: hover changes colour, border or background in 120 ms; only opacity and transform move; entrances animate and exits are instant; hover effects only where a pointer can hover; under reduced motion, movement is removed and opacity feedback stays (a slow pulse from 1 to 0.55 over 1.6 s; the spinner pulses). Limit the section entrance to content added after the page has loaded. Two choices are left to Claude Design. (1) How finished results arrive: the restrained option is a 300 ms fade, the six concepts 40 ms apart, no bounce. (2) Hover on cards: colour and border only (pass 2, kept by the design-system pass) or a slight lift (pass 1's example); the Direction's "calm" leans to the first. These values are pass 2's proposal; Claude Design may propose others within the rules in section 8.
- Where in the code: Global reduced-motion rule in `src/styles/globals.css:159`; `embel-flow-enter` in `src/styles/guided-conversation.css:143-156`; `a.identity-primary-button` (no hover). Plans: `design-audit/animation-plans/` 001, 003, 004 and 005.
- Screen findings merged into this item: M-002, M-004, M-017, E-056
- Screen findings this fixes: D-061 (M-005, A-020)
- Evidence: `annotated/M-004.png`, `annotated/E-051.png`, `motion/probe-summary.md`, `design-system/drift.md`, `design-audit/animation-plans/README.md`
- Systemic? Yes: every screen.

**D-049. Icons are drawn three ways with five stroke weights**
- Sources: DS-017, IMG-004
- Screen/route, state and width: All routes.
- Category: components (iconography) · Severity: P2 · Tag: needs redesign
- What's wrong: 94 uses go through the `Icon` component (24 hand-drawn line icons, stroke 1.55). Ten component files draw their own inline icons at strokes of 1.2 to 1.6. Arrows, chevrons and sort glyphs are loaded as image files from six folders, so they cannot follow the text colour or its hover and disabled states. There are no icon size tokens, and the set lacks a heart, eye, download, copy, expand, external link, info and warning icon, which is what forces the ad-hoc drawings.
- Why it matters: Small differences in line weight are visible at a glance in a line-icon interface, and image icons break state styling.
- Suggested direction: One icon family through one component, at one stroke weight and three sizes (16, 20, 24 px). The one decision: adopt a library (the static files already use Lucide's names, so Lucide is the natural candidate) or extend the hand-drawn set at one weight.
- Where in the code: `Icon` in `src/components/ui/icon.tsx:3-27, 145-162`; `src/components/auth/auth-icons.tsx`; `src/components/ui/projects-artwork.tsx`.
- Screen findings merged into this item: IMG-004
- Evidence: `src/components/ui/icon.tsx`, `src/components/auth/auth-icons.tsx`, `src/components/ui/projects-artwork.tsx`, `screens/projects__three-brands-pro__1440.png`
- Systemic? Yes.

### Also built into the system, with no decision to make

8 more design-system findings are execution fixes. Six of them are foundations whose values are already specified in `05_design_system.md`: Claude Design builds them as written, and implementation applies them. Their full findings are in section 7.

| ID | Piece | What Claude Design builds, as specified | Source |
| --- | --- | --- | --- |
| D-059 | Spacing | The 14-step scale and the four spacing roles (card padding, between fields, between sections, page gutter). The values of the roles follow decision 3. | DS-006 |
| D-050 | Radius | The six-step scale (4, 8, 12, 16, 20 px and pill) and the rule for nested corners. | DS-007 |
| D-051 | Shadows and layering | Four shadow levels, one backdrop without blur, and a named layer scale. | DS-008 |
| D-052 | Breakpoints and layout | Three named ranges, two page widths (792 and 1,056 px) and the grid at 390, 768 and 1440. | DS-009 |
| D-084 | Control and target sizes | Two control heights, a minimum target, and a minimum box for standalone links. | DS-023, A-021 |
| D-085 | Documentation and shared values | The published system is the documentation; its primitive values are also the source for the emails, the export templates and the crash screen. | DS-024 |

The other two, D-039 (hand-written colours) and D-053 (unused style rules), are clean-ups in the code with nothing to design.

## 6. Claude Design worklist, Part B: screens and exported files (after the design system is published)

These are the remaining 23 needs-redesign findings, grouped by screen and flow. Groups are in the order of their highest-ranked finding; inside a group, findings are in ranked order.

1. **Choosing a logo and a direction**: D-013, D-069
2. **Credits and plans**: D-014, D-015, D-031, D-036
3. **Brand conversation**: D-016, D-021, D-054, D-061, D-070
4. **Home**: D-017, D-060, D-080
5. **Delivery: Assets and exported files**: D-022, D-023, D-024, D-071
6. **Projects and Library**: D-035, D-068, D-074
7. **Brand and sharing**: D-075
8. **Settings**: D-081

One item, D-024, is listed here because it is tagged needs redesign, but it is not a design task: how a direction board is generated is the owner's to decide (see its "Needs the owner" note).

Use only the published design system. Where a screen needs something the system lacks, add it to the system first. For every screen, show the states that apply (default, empty, loading, error, key dialogs) at 390 and 1440, and at 768 where the layout changes.

### Choosing a logo and a direction

Execution fixes on the same screens, listed in section 7: D-025, D-058, D-062, D-065.

**D-013. The work Embel makes is shown at thumbnail size**
- Sources: E-033, IMG-018, IMG-021
- Screen/route, state and width: Logo and Creative direction steps, showcase brands; 768 and 1440 (390 is good: one per row).
- Category: hierarchy (also layout, imagery) · Severity: P1 · Tag: needs redesign · Area: Choosing a logo and a direction
- What's wrong: The conversation column is 792 px wide on a 1440 px screen, leaving about 320 px of empty canvas each side. Inside it, six logo concepts sit in cards about 237 px wide (the logo in a 205 × 168 px box), and each creative-direction board, a dense 1024 px image with small type, swatches and mock-ups, is shown about 237 px wide (214 px at 768), where none of its text can be read. A small expand icon is the only way to see a board properly.
- Why it matters: Choosing a logo and a direction are the two decisions the whole product leads to, and the output is the product's best argument for itself. Showing it small undersells it.
- Suggested direction: Let these two steps use the wider page width (1,056 px or more). Show concepts on a clean white field at 320 px or more, two or three per row. Make the board the card, at full card width, with its details under it and the larger view one click away. Show the selected concept or board large with the alternatives beside it. The inspiration brand view (`annotated/E-054.png`) is the model for scale and restraint. Image slots IMG-018 and IMG-021 give the sizes and weights.
- Fixed by: D-007 (Choice card; DS-011); D-009 (Skeleton, Media frame and waiting patterns; DS-015)
- Evidence: `screens/brand-conversation__kestrel-complete-showcase-pro__1440.png`, `screens/brand-conversation__orchardlane-complete-showcase-free__1440.png`, `screens/brand-conversation__quill-logos-generated-free__1440.png`, `annotated/E-054.png`
- Systemic? Yes: both steps on every brand.

**D-069. The Logo step has two text boxes and says the same hint three times**
- Sources: E-035
- Screen/route, state and width: Logo step before and after choosing a concept; all widths.
- Category: flow (also copy) · Severity: P2 · Tag: needs redesign · Area: Choosing a logo and a direction
- What's wrong: Under the concepts is a refine box ("Describe a change to this logo…" with a "Refine" button and a browser resize handle), and at the bottom of the page is the always-present reply box. Embel's message says "To change it, tell me what to adjust below", which could mean either. Before a concept is chosen, the same hint appears three times in three wordings.
- Why it matters: Two inputs with overlapping jobs make people hesitate, and repeated hints add noise to the screen with the most to look at.
- Suggested direction: One place to type. Either refine through the main reply box when a concept is selected ("Describe a change to Concept 1…"), or hide the reply box on this step. Show the refine control only once a concept is chosen.
- Where in the code: Refine box in `LogoCreationWorkspace`; `FloatingComposer`.
- Fixed by: D-047 (form controls; DS-021)
- Evidence: `screens/brand-conversation__tidewater-logos-partly-failed-free__1440.png`, `screens/brand-conversation__kestrel-complete-showcase-pro__1440.png`
- Systemic? Yes: the reply box sits under every structured step.

### Credits and plans

Execution fixes on the same screens, listed in section 7: D-033, D-076, D-078.

**D-014. Running out of credits produces three messages at once, one of them covering the send button**
- Sources: E-037, A-017
- Screen/route, state and width: Any AI button at 0 credits (Fromagerie Bérénice Côté → Explore six concepts); 390 and 1440.
- Category: flow (also copy, semantics) · Severity: P1 · Tag: needs redesign · Area: Credits and plans
- WCAG criterion or measured value: WCAG 4.1.3 Status Messages (AA)
- What's wrong: After the click, the page shows "Not ready yet." beside the button; under it "You've used this month's credits. They renew on December 1. Your logos are saved." with a "Try again" button that cannot succeed; and a floating card in the bottom-right corner, "You're out of credits for this month", which overlaps the reply box and hides its send button. The renewal date is December 1 here and November 30 on Plans for the same account. The floating card is inserted together with its text, which many screen readers do not announce; Escape does not close it; and focus is on the page body both when it appears and after "Not now".
- Why it matters: This is the moment a free user decides whether to pay. It should be the clearest message in the product. Heuristic: error prevention; help users recognise, diagnose and recover from errors.
- Suggested direction: One message, in place, where the action was: "You've used this month's 30 credits. New credits arrive on [date]. Your work is saved." with "See plans" as the button. Remove "Try again" and "Not ready yet." Show the same date everywhere (D-066). Build it as a block Inline message beside the button, written into a status region that already exists, or as a small dialog that takes focus and closes on Escape. Better still, mark AI buttons before the click when the balance cannot cover them (D-015).
- Where in the code: `OutOfCreditsPrompt` in `src/components/billing/out-of-credits-prompt.tsx:15-31`; `creditsMessage` in `src/components/workspace/credits-message.ts:7`.
- Fixed by: D-008 (Inline message and Toast; DS-012)
- Evidence: `screens/brand-conversation__out-of-credits-prompt-free__1440.png`, `screens/brand-conversation__out-of-credits-prompt-free__390.png`, `screens/plans__free-0-credits-upgrade-free__1440.png`
- Systemic? Yes: every AI button.

**D-015. Remaining credits are not visible anywhere outside Settings and Plans**
- Sources: E-006
- Screen/route, state and width: Navigation pill and account menu, every signed-in screen.
- Category: navigation/IA · Severity: P1 · Tag: needs redesign · Area: Credits and plans
- What's wrong: Every AI step costs credits, but the pill and the account menu show neither the plan nor the balance. The only places that state "credits left this month" are the plan card in Settings and the Plans page. A free account at 0 credits learns it only by clicking an AI button.
- Why it matters: People cannot plan their work, and the first sign of a limit is a blocked action. Heuristic: visibility of system status; error prevention.
- Suggested direction: Show the plan and the balance in the account menu ("Pro · 112 credits left"), and tell the person on an AI button, before the click, when the balance cannot cover it. Credits only, never money.
- Where in the code: `PlanCreditsCard` in `src/components/billing/plan-credits-card.tsx:35`; account menu in `FloatingNav` (`src/components/journey/floating-nav.tsx`).
- Needs the owner: Pass 1 also suggested printing each step's credit price on its button ("Explore six concepts · 6 credits"). The owner's standing rule is that the app shows remaining credits and no cost estimates. A fixed credit price is not a money estimate, but adding it is the owner's product call, so it is left out unless the owner asks for it.
- Evidence: `screens/home__account-menu-open-pro__1440.png`, `screens/brand-conversation__out-of-credits-prompt-free__1440.png`
- Systemic? Yes: every screen with an AI action.

**D-031. Plans sells a number, not an outcome**
- Sources: E-026
- Screen/route, state and width: `/plans`, all accounts, all widths.
- Category: hierarchy (also copy) · Severity: P1 · Tag: needs redesign · Area: Credits and plans
- What's wrong: Each plan card says only "150 credits every month" and one line ("For building a brand from idea to assets."). Nothing says what a credit buys. The three cards look identical except for the numbers, so nothing guides the choice, and the page has no visual link to the product. A free account at 0 credits sees "Credits left 0" in the same quiet style as everything else.
- Why it matters: People cannot judge value from an abstract unit, so upgrading feels like a guess. Heuristic: match between the system and the real world.
- Suggested direction: Translate credits into work ("about 1 complete brand", "about 6 brands", using the real credit price of each step), list once what each step costs in credits, and recommend one plan. When the balance is 0, say so in a sentence with the renewal date and the upgrade beside it. Credits and work only; the plan prices are the only money on the page. Design the stacked 390 px layout here (D-033).
- Where in the code: `PlansWorkspace` in `src/components/billing/plans-workspace.tsx`; `src/styles/plans.css`.
- Evidence: `screens/plans__free-0-credits-upgrade-free__1440.png`, `screens/plans__pro-current-pro__1440.png`, `screens/plans__signed-out__1440.png`
- Systemic? Yes: the out-of-credits prompt and the Settings plan card repeat the bare number.

**D-036. Usage counts "tokens", leaves out images, and never mentions credits**
- Sources: E-029
- Screen/route, state and width: `/settings` → Usage, all accounts, all widths.
- Category: copy (also hierarchy) · Severity: P1 · Tag: needs redesign · Area: Credits and plans
- What's wrong: The tab is titled "Recent requests" and reports "3 requests · 14,400 tokens used". Rows read "Voice · Name · 4,800". A footnote says "Logo and image requests are not included." The customer is charged in credits, and logos and boards are the main cost, yet this page shows a different unit and omits the main cost. A Pro account that has used 38 credits sees three naming rows. There is a manual "Refresh" button.
- Why it matters: This is the only usage record a paying customer has, and it cannot answer "where did my credits go?"
- Suggested direction: A credit ledger: date, brand, step in the journey's words ("Six logo concepts"), credits used, running balance, and monthly grants and refunds as their own rows. No tokens in the customer view. Built on the system Table (with a caption; stacks into cards at compact width).
- Where in the code: `RecordedUsage` in `src/components/workspace/recorded-usage.tsx`.
- Needs the owner: A credit ledger shows records the page does not load today (image requests, grants, refunds). That is a behaviour and data change. Claude Design can design it; implementation needs the owner's go-ahead.
- Evidence: `screens/settings__usage-pro__1440.png`, `screens/settings__usage-free__390.png`
- Systemic? Yes: credits are also missing from the navigation and from Plans' explanation.

### Brand conversation

Execution fixes on the same screens, listed in section 7: D-003, D-004, D-011, D-012, D-019, D-030, D-041, D-042, D-064, D-067, D-082, D-089, D-091.

**D-016. A failed research run leaves an empty page with the error docked to the reply box**
- Sources: E-009
- Screen/route, state and width: New project, research failed; 390 and 1440.
- Category: flow (also hierarchy, copy) · Severity: P1 · Tag: needs redesign · Area: Brand conversation
- What's wrong: When research fails, the "Researching your competitors" card disappears. The person's message stays at the top, the middle of the page is blank, and a pink strip is attached to the top of the reply box: "Research could not produce verified suggestions. Your prompt is saved. You can retry research." The two actions, "Check status" and "Retry research", are small grey text with no button shape, and "Check status" does not say what it checks.
- Why it matters: This is the first thing a new customer sees if the first AI step fails, and the recovery is easy to miss.
- Suggested direction: Keep the failure in the conversation where the progress card was, as a card from Embel: what happened in plain words, one primary button "Try again", and whether credits were used. Drop "Check status" or fold it into the retry.
- Fixed by: D-008 (Inline message and Toast; DS-012)
- Evidence: `screens/home__research-failed-pro__1440.png`, `screens/home__research-failed-pro__390.png`
- Systemic? Yes: error strips docked to the reply box are used elsewhere in the conversation.

**D-021. A finished brand is one page about 5,400 px tall and 141 keyboard stops long, because Inspiration never folds away**
- Sources: E-032, A-010
- Screen/route, state and width: Any brand at or past Inspiration; 390 (about 9,700 px) and 1440 (about 5,400 px).
- Category: flow (also layout, keyboard) · Severity: P1 · Tag: needs redesign · Area: Brand conversation
- WCAG criterion or measured value: WCAG 2.4.3 Focus Order (A), and plain usability
- What's wrong: Strategy and Voice answers fold to one line each, but the Inspiration gallery stays fully open for good: eight large third-party brand collages, "Show more brands", "Your images" and an upload button. To reach their own logos, a person scrolls through roughly 2,400 px of other companies' saturated artwork. The Logo step then shows all six concepts, the refine box and the direction boards, all open. By keyboard the page is 141 stops; the gallery alone is 97 of them, and the reply box and the Continue link to Assets come last.
- Why it matters: The Direction says the person's own brand should be the most colourful thing on screen. Here other brands are, permanently, and the page's most important content sits below them. A keyboard user who returns to reply must press Tab about 140 times.
- Suggested direction: Fold every finished step the way Voice folds ("Inspiration: 2 liked · Edit", "Logo: Concept 1, version 2 · Change"), so its controls leave the keyboard order until reopened. Decide what a reopened brand shows first (passes 1 and 2 both suggest the person's own latest work). Make the current step in the project bar a link that moves focus to that step, consider a "Skip to reply" link, and treat the gallery as one keyboard stop with arrow keys inside. Keep the one-page conversation; make it as short as the work that is still open. A calmer gallery tile layout is part of this.
- Evidence: `screens/brand-conversation__kestrel-complete-showcase-pro__1440.png`, `screens/brand-conversation__kestrel-complete-showcase-pro__390.png`, `screens/brand-conversation__orchardlane-complete-showcase-free__1440.png`, `a11y/brand-conversation__kestrel-complete-pro__1440.json`
- Systemic? Yes: every brand from Inspiration onward.

**D-054. Inside a project the pill loses the app's navigation, and at narrow widths it takes too much of the screen**
- Sources: E-053, A-015
- Screen/route, state and width: Project conversation and Assets; 390, 720 × 450 (200% zoom) and 1440.
- Category: navigation/IA (also layout at zoom) · Severity: P2 · Tag: needs redesign · Area: Brand conversation
- WCAG criterion or measured value: WCAG 1.4.10 Reflow (AA) is met; advisory for 1.4.4 Resize Text and 2.4.11 Focus Not Obscured
- What's wrong: In a project the pill replaces Home, Projects and Library with the brand name and the four steps. The brand name opens a menu the page calls "Switch project", which lists only "All projects", "New project" and "Home" (the last two go to the same place): no other brands and no Library. On the conversation page a finished brand never shows four ticks; Assets stays a numbered "4" until that page is opened. Below 900 px the bar wraps to two rows and is 116 to 124 px tall, and every step except the current one is a bare circle. At 720 × 450 the bar and the reply box leave 259 px, 58% of the height, for the brand's own content; at 320 px the bar is about 160 px.
- Why it matters: People working on several brands cannot move between them, and people who zoom see their work through a narrow slot on the pages where the work is the point.
- Suggested direction: A compact single-row project bar at narrow widths (the brand name and the current step, with the rest in a menu, or a "Step 3 of 4 · Identity" line). Let the bar shrink or scroll away while reading. Show all four steps' true state. Keep a visible way to Library. Fixed chrome takes at most a quarter of a 450 px tall window.
- Where in the code: `ProjectCapsule` in `src/components/journey/project-capsule.tsx:173-181`; `src/components/journey/journey.module.css`.
- Fixed by: D-052 (breakpoints and page widths; DS-009)
- Needs the owner: Listing recent brands in the brand menu (pass 1) is a small new feature. Include it only if the owner wants it.
- Evidence: `annotated/E-053.png`, `annotated/A-kbd-zoom200-conversation.png`, `a11y/reflow/brand-conversation__kestrel-complete-pro__zoom200.png`, `a11y/reflow/brand-assets__kestrel-ready-pro__320.png`, `screens/home__research-in-progress-pro__390.png`
- Systemic? Yes: all project pages.

**D-061. The hearts on inspiration tiles are hidden until hover, never appear on touch, and are faint on light images**
- Sources: M-005, A-020
- Screen/route, state and width: Project conversation, Inspiration gallery; 390 (touch) and 1440.
- Category: interaction state (also color) · Severity: P2 · Tag: needs redesign · Area: Brand conversation
- WCAG criterion or measured value: WCAG 1.4.11 Non-text Contrast (AA)
- What's wrong: Three things in the gallery are invisible until the pointer is over them: the heart that likes one part of a brand, the label naming that part, and the "Open brand" hint. On a touch device they were measured as fully transparent and never appear, so a phone user cannot discover that parts can be liked. When shown, the heart (a white stroke with a 28% ink fill, drawn straight on the artwork) measures 1.13:1 and 1.84:1 on pale images. The stylesheets hold 85 hover rules and no check that the device can hover, so on a phone a tap leaves a hover style stuck.
- Why it matters: Liking parts is how the person steers the logo and direction steps. A control that cannot be seen cannot be used. (The owner's priority is desktop first, which is why this is P2.)
- Suggested direction: Give the heart a small backing (a chip or a scrim) so it reaches 3:1 on any artwork, and decide whether it is always visible; always-visible hearts are the simplest answer on touch. How the labels and the hint appear on touch is the design decision. Limit hover movement to devices that can hover.
- Where in the code: `src/components/inspiration/inspiration.css:234-247, 748-750, 774-793`. Plan: `design-audit/animation-plans/004-hover-transitions-and-touch-gating.md`.
- Fixed by: D-048 (motion tokens; DS-019)
- Evidence: `annotated/M-005.png`, `annotated/A-kbd-inspiration-heart-focus.png`, `annotated/A-kbd-tile-focused.png`
- Systemic? Partly: the hidden controls are in Inspiration only (about 280 hearts when all 56 brands are shown); the missing hover check is everywhere.

**D-070. The Name step shows 100 names in one wall**
- Sources: E-038
- Screen/route, state and width: Voice → Name (shown through "Change name"); 1440.
- Category: layout · Severity: P2 · Tag: needs redesign · Area: Brand conversation
- What's wrong: All 100 generated names appear at once as identical cards in three columns, 34 rows and about 2,500 px tall, each with a radio button and a heart. The helper text mentions "Details shows each name's story and more checks", but no Details control is visible on a card. The only tools are "All 100 / Saved 0".
- Why it matters: 100 equal options is more than anyone can compare; people will pick from the first screen.
- Suggested direction: Lead with a short list (six to twelve names), keep the rest behind "Show more", and make the path to a name's details visible on the card.
- Where in the code: `src/components/naming/naming-chat.module.css`; `NamingInspect` in `src/components/naming/naming-inspect.tsx`.
- Fixed by: D-007 (Choice card; DS-011)
- Needs the owner: Pass 1 also suggests ranking the "strongest" names with a reason for each and grouping the rest by kind. That may need information the naming step does not produce today; if so it is a behaviour change for the owner to approve. The layout change above is within the redesign.
- Evidence: `screens/brand-conversation__kestrel-change-name-open-pro__1440.png`
- Systemic? No.

### Home

Execution fixes on the same screens, listed in section 7: D-026, D-040.

**D-017. Signed-out Home, the only landing page, shows no proof of what Embel makes**
- Sources: E-001, IMG-007
- Screen/route, state and width: `/` signed out; 390, 768 and 1440.
- Category: hierarchy (also imagery, layout) · Severity: P1 · Tag: needs redesign · Area: Home
- What's wrong: The page is a headline, one sentence, a text box and three chips. Below the chips, about 55% of a 1440 × 900 window is empty dot grid. Nothing shows a logo, a direction board or a brand kit, so a visitor must sign up before seeing any result. There is no price, no "free to start", and no link to Plans in the page body.
- Why it matters: A first-time visitor decides in seconds whether the output is worth an account. "Premium" is claimed by the chrome but never demonstrated. Heuristic: recognition rather than recall.
- Suggested direction: Keep the prompt as the hero. Use the lower half for real output: a row of three finished brands that Embel really made, in different sectors and moods, each shown as its chosen direction board cropped to the logo band and palette, with the brand name as a caption. Add one line that says it is free to start with 30 credits. Slot IMG-007: 4:3 crops at 360 × 270 and 720 × 540, AVIF and WebP, 35 KB each; the first image loads eagerly because it can be the largest thing on the first screen. Use boards without faces, and check each invented name against real companies first.
- Needs the owner: Two showcase brands exist (Kestrel Analytics and Orchard Lane Cider). A third, or a fresh set of three made for public display, is a real AI generation: 9 images per brand, very roughly $0.35 per brand by the audit's own spend record (an estimate, not a confirmed charge). It needs the owner's approval. The Kestrel board shows a face and an invented name and phone number, so it should not be used publicly as it is.
- Evidence: `screens/home__signed-out__1440.png`, `screens/home__signed-out__768.png`, `screens/home__signed-out__390.png`
- Systemic? No.

**D-060. A new account is told to "Pick up where you left off"**
- Sources: E-004, IMG-008
- Screen/route, state and width: `/` signed in, new account with no brands; all widths.
- Category: copy (also imagery) · Severity: P2 · Tag: needs redesign · Area: Home
- What's wrong: The heading "Pick up where you left off" and the link "All projects →" sit above an empty card that says "Your first brand starts here. Describe your idea above. Your saved work will appear here." The page headline already says "Your next brand starts here." So the page says the same thing twice and one heading is untrue.
- Why it matters: The first signed-in screen should point at one action.
- Suggested direction: Remove the untrue heading and greet a new account once ("You have 30 credits to start"). For what fills the space, the passes offer two options and Claude Design decides. (A) Hide the section, or show a quiet preview of the four steps (pass 1). (B) Reuse the row of example brands from D-017 with a caption such as "What you will get" (pass 1b; no new asset).
- Where in the code: `HomeWorkspace`.
- Fixed by: D-038 (Empty state; DS-016)
- Evidence: `screens/home__empty-fresh__1440.png`, `screens/home__empty-fresh__390.png`
- Systemic? No.

**D-080. "Generation activity" lists raw requests, six rows for one click**
- Sources: E-007
- Screen/route, state and width: `/` → account menu → Generation activity (dialog), signed in; 390 and 1440.
- Category: components (also copy) · Severity: P2 · Tag: needs redesign · Area: Home
- What's wrong: The dialog is a flat list of about 20 identical rows. One click on "Explore six concepts" produces six separate "Logo concepts · Done" rows for the same brand. Row types use internal names ("Identity images", "Logo refinement") that do not match the journey's words. Every row says "Done" in the same grey, so a running or failed request would not stand out. The helper text explains the panel's mechanics.
- Why it matters: The panel exists to answer "is anything still running, and did anything fail?" and it buries that answer.
- Suggested direction: Group by brand and by action ("Kestrel Analytics · Six logo concepts · Done"), put running and failed items first with a clear status mark, use the journey's own names, and rename the entry to plain words such as "Activity".
- Where in the code: `GenerationActivity` in `src/components/workspace/generation-activity.tsx`.
- Fixed by: D-046 (Dialog, Drawer and Menu; DS-013)
- Evidence: `screens/home__generation-activity-dialog-pro__1440.png`, `screens/home__generation-activity-dialog-pro__390.png`
- Systemic? No.

### Delivery: Assets and exported files

Execution fixes on the same screens, listed in section 7: D-029, D-063, D-090.

**D-022. The final brand images are one fixed template with two circles, for every brand**
- Sources: E-042, E-047, IMG-022, IMG-023, IMG-024, IMG-025
- Screen/route, state and width: Assets → Brand images (brand board, profile image, post templates, banners), all widths; the same files in the brand kit.
- Category: imagery (also exports) · Severity: P1 · Tag: needs redesign · Area: Delivery: Assets and exported files
- What's wrong: The direction board the person chose for Kestrel is rich: a mountain photograph, a flight-path line motif, a dashboard, a business card. The assets that follow keep only its four colours and two typefaces. Every brand image is the same layout on a cream field with two overlapping circles in the accent colour, for every brand. On both banners a circle cuts through the brand name, and the logo (which already contains the name) sits beside the name set again in type. The brand board is headed "BRAND IDENTITY", captions the logo "YOUR LOGO", uses filler type samples ("A distinct voice."), and its "In practice" row is three small copies of the same templates. The guidelines then describe "a fine grid, flight-path lines and data points", none of which appears in any file. At 390 the three social tiles are 82 px wide and their download buttons break mid-word.
- Why it matters: The journey builds expectation up to the direction board and then delivers something generic. These are the files people download, post publicly under their own name, and judge the product by. People remember the end.
- Suggested direction: Decide what the deliverables inherit from a direction beyond colour and type (a motif, an image treatment, a layout family). Design a small set of template families, drawn in code and fed by the chosen direction: its palette, its type, a shape family matched to its style, and real crops of the chosen board in "In practice". No decoration over text. The logo or the name, never both. Sample copy from the brand's own voice. Nothing addressed to "you". Important content inside each platform's safe area. File sizes stay as they are (1600 × 2200, 1024², 1080², 1080 × 1350, 1500 × 500, 1584 × 396).
- Where in the code: Export templates under `src/features/brand-assets/`; preview page `AssetsJourney` in `src/features/brand-assets/components/assets-journey.tsx`.
- Fixed by: D-085 (shared values for emails and exports; DS-024)
- Evidence: `screens/brand-assets__kestrel-ready-pro__1440.png`, `screens/brand-assets__orchardlane-ready-free__1440.png`, `screens/brand-assets__orchardlane-ready-free__390.png`, `exports/rendered/kestrel__brand-board.png.png`, `exports/rendered/kestrel__direction--selected-direction.png.png`, `exports/rendered/kestrel__social--banner-wide.png.png`, `exports/rendered/kestrel__social--banner-cover.png.png`, `exports/rendered/kestrel__social--post-square.png.png`
- Systemic? Yes: all brands, all exported social files.

**D-023. The brand guidelines are too thin on screen, and an unstyled web page as a file**
- Sources: E-044, E-046, IMG-026
- Screen/route, state and width: Assets → Brand guidelines, all widths; `guides/brand-guide.html` in the kit.
- Category: exports (also hierarchy, copy) · Severity: P1 · Tag: needs redesign · Area: Delivery: Assets and exported files
- What's wrong: On screen, Voice is one sentence, Logo rules are one paragraph with no diagram of clear space or minimum size, Typography shows one line per face, and Imagery is two sentences that call the person's choice "direction 1". The downloaded file is a plain HTML page in the system font: a bold title, default blue links, a bare table, four colour squares and paragraphs. It contains no logo image, does not use the brand's typefaces or colours, and repeats "for direction 1".
- Why it matters: Freelancers and agencies hand guidelines to clients; founders hand them to a web designer. As it stands they would have to rebuild the document. The Direction asks for polished exports.
- Suggested direction: Design the guidelines as a document: a cover with the logo, logo usage with clear space and do and don't examples, colours with roles and contrast pairs, type with a real hierarchy sample, voice with three "say this / not this" pairs, and imagery with two or three crops of the chosen direction board. Set it in the brand's own type and colours, and use the direction's name, never its number. The on-screen sections and the file share one content design. Image slot IMG-026 gives the sizes.
- Where in the code: Guide builder under `src/features/brand-assets/`; on-screen sections in `AssetsJourney`.
- Fixed by: D-085 (shared values for emails and exports; DS-024)
- Needs the owner: Exporting the guidelines as a PDF (pass 1's suggestion) is a new export format: a behaviour change and possibly a new dependency. It needs the owner's go-ahead. A designed HTML file is within the redesign.
- Evidence: `screens/brand-assets__kestrel-ready-pro__1440.png`, `screens/brand-assets__kestrel-ready-pro__390.png`, `exports/rendered/kestrel__guides--brand-guide.html.png`, `design-audit/evidence/exports/kestrel/kit/guides/brand-guide.html`
- Systemic? Yes: every brand.

**D-024. The chosen direction board shows a different logo from the one the person chose**
- Sources: E-043
- Screen/route, state and width: Creative direction step and Library, Kestrel Analytics, 1440; `direction/selected-direction.png` in the kit.
- Category: imagery · Severity: P1 · Tag: needs redesign · Area: Delivery: Assets and exported files
- What's wrong: The chosen logo is a striped wing with "KESTREL ANALYTICS" in bold capitals. The direction board, which the step says is "built on your chosen logo", shows a different mark (a single white arrow), the name in mixed case, and the line "Precision at altitude" where the chosen slogan is "See every mile". The board is then shipped in the kit as the selected direction. This was seen at full size on Kestrel only; pass 1b notes that Orchard Lane Cider's boards keep the chosen logo. The Kestrel board also shows a photographic-looking face and an invented person's name and phone number on a business card.
- Why it matters: A different logo on the board breaks the step's promise at the moment of choice. The project's agreed behaviour is that directions use the exact chosen logo.
- Suggested direction: Boards carry the exact chosen logo file and the chosen slogan, placed onto the board and not redrawn. If that cannot be guaranteed, the screen says plainly that a board is a mood reference.
- Needs the owner: This is how the generation engine makes images, not interface design. Claude Design cannot fix it, and a look-only implementation must not change it. The owner decides how to do it (for example, placing the saved logo file onto the generated board); checking it needs a real generation, which needs approval.
- Evidence: `exports/rendered/kestrel__direction--selected-direction.png.png`, `exports/rendered/kestrel__logo--logo-original.png.png`, `screens/brand-conversation__kestrel-complete-showcase-pro__1440.png`
- Systemic? Likely (seen on the one showcase brand reviewed at full size).

**D-071. The Assets page keeps the conversation's stepping after everything is done, and scatters downloads**
- Sources: E-045
- Screen/route, state and width: Assets, complete brand; all widths.
- Category: layout · Severity: P2 · Tag: needs redesign · Area: Delivery: Assets and exported files
- What's wrong: The page is a results page dressed as a chat: three Embel messages ("Brand images · 1 of 3"…), each section ending in a "Continue" button although all three sections are already shown. There are about fifteen separate download buttons. In the social grid the three cards have different heights, so their titles and buttons sit at three levels, and the profile image's button is beside its title while the others are below. The dot-grid canvas stops just under the pill.
- Why it matters: This is the delivery screen; it should feel like opening a finished package.
- Suggested direction: A single delivery layout: the brand board large at the top, then tabs or anchors for Images, Guidelines and Design system, with one download control per file type and the kit button always in view. No "Continue" once the brand is complete. This page is the optional sixth screen of the design system's validation set.
- Where in the code: `AssetsJourney` in `src/features/brand-assets/components/assets-journey.tsx`.
- Fixed by: D-009 (Skeleton, Media frame and waiting patterns; DS-015); D-045 (visual identity decisions; DS-020)
- Evidence: `screens/brand-assets__kestrel-ready-pro__1440.png`, `screens/brand-assets__kestrel-preparing-pro__1440.png`, `screens/brand-assets__orchardlane-ready-free__390.png`
- Systemic? No.

### Projects and Library

Execution fixes on the same screens, listed in section 7: D-032, D-034, D-073, D-077, D-088.

**D-035. Library uses several names for one thing, and "All generations" is one long ungrouped wall**
- Sources: E-023, E-024
- Screen/route, state and width: `/assets`, both tabs; 390 and 1440.
- Category: copy (also navigation/IA, layout) · Severity: P1 · Tag: needs redesign · Area: Projects and Library
- What's wrong: The tabs are "Kept assets" and "All generations". A creative-direction board is labelled "Brand board" here, "Identity images" in Generation activity, "Creative direction" in the journey and "selected-direction.png" in the kit, while the Assets page uses "brand board" for a different, composed image. Every logo card is titled just "Logo", so 20 cards share one title. "Used in brand" is the only status, and a manual "Refresh" sits at the top right. In "All generations", items from different brands are interleaved with no headings, dates or visible order; boards are letterboxed while logos fill their frames; at 390 the list is a single column about 10,000 px tall.
- Why it matters: The person cannot tell which image is their chosen logo or why two different pictures are both "Brand board". An agency account will have hundreds of items.
- Suggested direction: Decide what Library is for (most likely "everything Embel has made for you, by brand"). Name things with the journey's words (Logo concept 3, Direction board 2, Brand board) and mark the chosen ones. Rename the tabs. Group by brand with a heading and a count, newest first, with logos as a compact grid (two or three across on a phone) and one thumbnail treatment (the Media frame). Update the list automatically and remove Refresh.
- Where in the code: `AssetsWorkspace` in `src/components/assets/assets-workspace.tsx`.
- Fixed by: D-009 (Skeleton, Media frame and waiting patterns; DS-015)
- Evidence: `screens/library__kept-assets-pro__1440.png`, `screens/library__all-generations-pro__1440.png`, `screens/library__all-generations-free__390.png`, `screens/home__generation-activity-dialog-pro__1440.png`
- Systemic? Yes: the names also appear in Generation activity, on Assets and in export file names.

**D-068. Project cards under-report progress and cannot be told apart**
- Sources: E-005, E-017, IMG-011
- Screen/route, state and width: `/` ("Pick up where you left off") and `/brands`; all widths.
- Category: components (also hierarchy, imagery) · Severity: P2 · Tag: needs redesign · Area: Projects and Library
- What's wrong: Brands without a chosen name all show "Untitled brand"; two sit side by side and can only be told apart by reading the grey brief. When no logo is chosen, the card's picture area is a grey box with three clipped lines of the brief and a "No logo yet" chip. Quill has six finished concepts and Tidewater has four, yet both say "No logo yet" directly above the action "Choose a logo". Six of eight cards look unfinished. Every card says "Today". The 76-character name is cut after one line although the card has room for two. The round "…" button sits on top of the brief text. When a logo is chosen it is about 90 px wide on a flat grey box, from a 1024 px file.
- Why it matters: Projects is the screen an agency user lives in; brands must be distinguishable at a glance, and a card should not under-report progress. Heuristic: visibility of system status; recognition rather than recall.
- Suggested direction: One card design. Give unnamed brands a working title taken from the brief ("Bike repair, Montreal"), allow two lines for names, show relative time, add a small four-step progress mark, and use a stage label that matches the action ("6 concepts to choose from"). Show a chosen logo larger and centred, on its direction's background colour once a direction is chosen (slot IMG-011: thumbnails 320 and 640 px wide, 15 KB; the first row is not lazy-loaded). One choice is left open because two passes differ on the picture area of a brand with no logo: pass 1 would show what exists (a strip of the concepts, or the name set in type) and keep the brief out; pass 1b holds that the brief excerpt and a status chip say more than placeholder art would. Either way the label must never say "No logo yet" when concepts exist.
- Where in the code: `ProjectCard` in `src/components/workspace/project-card.tsx`, `src/components/workspace/project-card.module.css`.
- Fixed by: D-045 (visual identity decisions; DS-020)
- Evidence: `screens/home__recent-brands-free__1440.png`, `screens/home__recent-brands-free__390.png`, `screens/projects__eight-brands-free__1440.png`, `screens/projects__eight-brands-free__390.png`
- Systemic? Yes: Home and Projects use the same card; the project pill also shows "Untitled brand".

**D-074. The "…" menu on a card holds one item, Delete, and sits on the picture**
- Sources: E-018
- Screen/route, state and width: `/brands` and Home cards → Project options; all widths.
- Category: components · Severity: P2 · Tag: needs redesign · Area: Projects and Library
- What's wrong: Every card carries a 36 px round "…" button over its picture. It opens a menu with a single red item, "Delete". The menu covers the logo.
- Why it matters: The most prominent control on every card leads only to a destructive action, and it competes with the logo for attention.
- Suggested direction: Take the button off the picture and show a quiet control in the card's text row on hover or focus (always visible on touch).
- Where in the code: `ProjectCardActions` in `src/components/workspace/project-card-actions.tsx`; `.project-card-menu-trigger`.
- Fixed by: D-046 (Dialog, Drawer and Menu; DS-013)
- Needs the owner: Pass 1's other option is to add Rename and Duplicate to the menu. Those are new features; they are not designed or built unless the owner asks.
- Evidence: `screens/projects__options-menu-open-free__1440.png`, `screens/projects__options-menu-open-free__390.png`
- Systemic? Yes: Home recent cards.

### Brand and sharing

Execution fixes on the same screens, listed in section 7: D-043.

**D-075. The share image shows nothing Embel makes**
- Sources: IMG-003
- Screen/route, state and width: `/opengraph-image`, the picture shown when a link to Embel is shared (also used for X/Twitter).
- Category: imagery · Severity: P2 · Tag: needs redesign · Area: Brand and sharing
- What's wrong: The image is the mark, the name and a vague sentence ("Embel — Brand workspace"), 1200 × 630, 38.8 KB. It shows nothing the product makes.
- Why it matters: A shared link is often the first thing a new person sees of Embel.
- Suggested direction: Mark and name on the left, one real finished brand board on the right, cropped to its logo and palette, and one short line that says what Embel does. 1200 × 630 PNG, 200 KB at most. Alt text: "Embel. A finished brand board with a logo, colour palette and type samples, made from a one-line idea."
- Where in the code: `src/app/opengraph-image.tsx`.
- Evidence: `design-audit/04_image_needs.md`
- Systemic? No.

### Settings

Execution fixes on the same screens, listed in section 7: D-001.

**D-081. Save controls float between cards, and a failed save leaves a dead end**
- Sources: E-030
- Screen/route, state and width: `/settings` → Account; all widths.
- Category: components (also flow) · Severity: P2 · Tag: needs redesign · Area: Settings
- What's wrong: "Cancel" and "Save changes" sit outside any card, between Preferences and "Plan and credits", so it is unclear which cards they save. After a failed save both return to pale grey while the page still says "You have unsaved changes.", a pink strip says "Saving could not be confirmed. Your edits are still here. Check the saved settings before trying another save." and a new button "Check saved settings" appears. The "Sign out" row has an unlabelled circular-arrows icon beside the button.
- Why it matters: The person cannot tell whether saving is possible, and the recovery asks them to run a check the app should run itself. The project's own rule is that account edits save automatically.
- Suggested direction: Save each field automatically and show "Saved" beside it only after the server confirms, or keep the buttons inside the card they act on with a clear primary state. On failure: "Couldn't save. Check your connection." with one "Try again". Label or remove the icon beside Sign out.
- Where in the code: `AccountProfileEditor` in `src/components/workspace/account-profile-editor.tsx`; `AccountAccess` in `src/components/workspace/account-access.tsx`.
- Fixed by: D-008 (Inline message and Toast; DS-012); D-037 (disabled and busy states; DS-022); D-047 (form controls; DS-021)
- Evidence: `screens/settings__account-pro__1440.png`, `screens/settings__save-error-offline-free__1440.png`
- Systemic? Yes: the "could not be confirmed / check … before trying again" wording recurs in the project screens.

## 7. Execution-fix findings (the implementation worklist)

These 59 findings have a clear answer and need no design decision, in ranked order within each severity. Each gives the file, the line and the component or function name where known. Many say "Fixed by": they wait for the design-system component and then apply it. Items with "Needs the owner" are not implemented until the owner agrees. The five plans in `design-audit/animation-plans/` cover the motion-related fixes in detail.

### P0 (1)

**D-001. Deleting an account fails for anyone who has chosen a brand name**
- Sources: E-028
- Screen/route, state and width: `/settings` → Your data → Delete account → confirm.
- Category: flow · Severity: P0 · Tag: execution fix · Area: Settings
- What's wrong: For any account with a chosen brand name, deletion stops and the person sees "Deletion didn't finish". The audit setup recorded the cause: three naming tables point at each other in a loop, so the database function `account_deletion_purge` stops with `account_purge_blocked`. The audit did not re-run it, because it damages the test account.
- Why it matters: A person who asks to delete their data and cannot is a trust and legal problem at scale. Heuristic: user control and freedom.
- Suggested direction: Fix the purge, then check that the failure message says what happens next and who to contact.
- Where in the code: Database function `account_deletion_purge`; tables `name_candidates`, `name_selections`, `naming_sessions.current_selection_id`. Dialog: `AccountDataControls` in `src/components/workspace/account-data-controls.tsx`.
- Status: **Done, verified November 14, 2026.** The fix is PR 254 in mikaelcharbonneau/embel ("Let account deletion get past foreign-key loops between tables"). Verified on the local stack without the seed's workaround: a new test account built one brand through Voice with the stand-in AI (76-character name chosen), then was deleted through Settings → Delete account. The request answered 200, the deletion receipt reads `completed` after one attempt (138 rows), and no auth user, project or naming row of that account is left.
- Evidence: `design-audit/README.md`, `screens/settings__delete-account-dialog-free__1440.png`
- Systemic? No.

### P1 (16)

**D-003. The whole conversation is one live region**
- Sources: A-008
- Screen/route, state and width: Project conversation, every stage; 390 and 1440.
- Category: components (semantics) · Severity: P1 · Tag: execution fix · Area: Brand conversation
- WCAG criterion or measured value: WCAG 4.1.3 Status Messages (AA); 1.3.1 Info and Relationships (A)
- What's wrong: The scrolling area for the entire journey is marked as a log that announces changes (`role="log" aria-live="polite"`). On Kestrel it wraps 764 elements, 57 images and 6 further status regions, including the gallery, the logo grid and the direction boards. It is also a keyboard stop named "Conversation". This was reasoned from the markup; it was not heard in a screen reader.
- Why it matters: A live region tells a screen reader to read out whatever changes inside it. The user may be flooded, or the screen reader may give up and announce nothing, including the messages that matter ("6 of 6 concepts ready").
- Suggested direction: Limit the log to the message transcript, or drop it and rely on the small status regions that already sit next to each widget.
- Where in the code: `AccountGuidedInterview` in `src/components/workspace/account-guided-interview.tsx:1198-1206`.
- Status: **Done** (commit 72c566b4 on branch `ui/execution-fixes`). The Workspace redesign already limited the live log to the chat: the work area, gallery, logo grid and boards are outside it. The log now announces additions only (`aria-relevant="additions"`), so a status inside it (thinking, progress) is read once, by that status. Verified by a unit test (`tests/client/workspace-layout.test.tsx`). Not yet heard in a screen reader: the lead checks it in the running app.
- Evidence: `a11y/keyboard.json`
- Systemic? Yes: every brand page.

**D-004. Below 760 px, and at 200% zoom, the journey steps lose their names**
- Sources: A-016
- Screen/route, state and width: Project bar on brand pages at widths of 760 px and below, which includes 200% zoom on a 1440 px window.
- Category: navigation/IA (semantics) · Severity: P1 · Tag: execution fix · Area: Brand conversation
- WCAG criterion or measured value: WCAG 2.4.4 Link Purpose (In Context) (A); 4.1.2 Name, Role, Value (A)
- What's wrong: Below 760 px the step labels are hidden with `display: none`, which also removes them from the links' names. The keyboard walk at 390 px recorded the links as ", complete". Visually they become bare tick circles.
- Why it matters: A zoomed or small-screen user sees ticks with no words, and a screen-reader user hears "comma complete, link" twice.
- Suggested direction: Hide the labels visually only (the app's `.sr-only` pattern) or give the links an `aria-label`. Whether ticks alone are enough for sighted users is part of D-054.
- Where in the code: Step label rule in `src/components/journey/journey.module.css:382-385`; `ProjectCapsule` in `src/components/journey/project-capsule.tsx`.
- Status: **Done** by the project bar redesign: below 1024 px (and beside the side chat up to 1279 px) the four steps collapse into one menu button that names the current step ("Identity · 3 of 4"); its items carry full names ("Strategy, complete"). No step label is hidden with `display: none` any more (`StepsMenu` in `src/components/journey/project-capsule.tsx`). Verified in code.
- Evidence: `a11y/brand-conversation__kestrel-complete-pro__390.json`, `a11y/reflow/brand-conversation__kestrel-complete-pro__zoom200.png`
- Systemic? Yes: every brand page.

**D-010. Keyboard focus is dropped after actions, errors and some dialogs**
- Sources: A-003, M-011
- Screen/route, state and width: Sign in (failed sign-in), Settings (Save changes; closing Delete account), Plans (Upgrade, Manage plan), project conversation (Continue, Change name, Edit answer, Explore six concepts), the out-of-credits prompt (Not now), Projects (after a delete); 390 and 1440.
- Category: flow (keyboard) · Severity: P1 · Tag: execution fix · Area: App-wide
- WCAG criterion or measured value: WCAG 2.4.3 Focus Order (A); 3.3.1 Error Identification (A) in practice
- What's wrong: After each of these actions keyboard focus is on the page body, not on a control. Three causes were found. Forms disable their fields and button while a request runs, and a disabled control cannot hold focus. Steps in the conversation replace the pressed button with new content without moving focus to it. The Delete account dialog is removed before focus can return to its button. Also, the sign-in overlay opens with focus on Close, not on Email.
- Why it matters: A screen-reader user hears nothing where they were and has to find their place again; after a failed sign-in they land outside the form. It happens many times on the main journey.
- Suggested direction: Keep focus on the pressed control while it works (mark it busy with `aria-disabled` and ignore repeat presses; do not use `disabled`). When a step changes, move focus to the heading of the new step. After an error, move focus to the message or the first field to fix (the password field after a failed sign-in). Every dialog and menu returns focus to the control that opened it; if that control is gone, to the notice that explains what happened. Open the sign-in overlay with focus in Email.
- Where in the code: `SignInForm` (`<fieldset disabled>`) in `src/components/auth/sign-in-form.tsx:257`; `PlansWorkspace` in `src/components/billing/plans-workspace.tsx:323-342`; `AccountProfileEditor` in `src/components/workspace/account-profile-editor.tsx:157`; `AccountDataControls` in `src/components/workspace/account-data-controls.tsx:136-145`; good model: `ProjectCardActions` in `src/components/workspace/project-card-actions.tsx:62-68`.
- Fixed by: D-006 (Button; DS-010); D-037 (disabled and busy states; DS-022); D-046 (Dialog, Drawer and Menu; DS-013)
- Status: **Done.** Buttons keep focus while busy (`Button` `loading` sets `aria-disabled`), dialogs return focus to their opener (`Dialog`), Settings saves on its own, and the conversation moves on with Send, which keeps focus. Commit 0a6c59fd on branch `ui/execution-fixes`: the sign-in overlay opens in Email (Close only while the form is unavailable), and after a rejected email and password focus moves to the password field. Verified by unit tests (`dialog-backdrop`, `auth-field-errors`); `tests/e2e/auth-overlay.spec.ts` now expects Email focused. The lead repeats the keyboard walk in the running app.
- Evidence: `a11y/keyboard.json`, `annotated/A-kbd-sign-in-error.png`, `annotated/A-kbd-change-name.png`, `annotated/A-kbd-settings-offline-error.png`
- Systemic? Yes. Good counter-example: the sign-up password mismatch moves focus to the confirm field.

**D-011. While saved work loads, the Logo and Creative direction steps show instructions for an empty project**
- Sources: M-014
- Screen/route, state and width: Logo and Creative direction steps: on opening a brand (Kestrel) and on Continue from Inspiration (Fromagerie Bérénice Côté); 390 and 1440.
- Category: feedback · Severity: P1 · Tag: execution fix · Area: Brand conversation
- What's wrong: Before saved data arrives, the steps show their empty-state messages. Opening Kestrel, a finished brand, showed "Choose at least one type", "Getting ready…", "Complete your saved logo inputs to continue." and "Choose a logo concept to begin." before settling on "Logo chosen · 6 of 6 concepts ready" at about 2.6 seconds. Continuing from Inspiration showed five messages in 1.2 seconds, including "Enter a brand name before generating." for a brand that has a name, with the logo-type options drawn faded as if disabled (pass 3 saw the same). After an out-of-credits refusal the line "Not ready yet." stays under the button with no explanation.
- Why it matters: For a second or two the app tells a customer that finished work is missing and asks them to redo it. Each message is also announced to screen-reader users. It reads as data loss.
- Suggested direction: A step has three states and shows only the true one: loading (a skeleton of the step's shape, no instructions), empty (instructions), ready (the work). No validation message appears until the saved inputs have loaded. "Request in progress…" and "Not ready yet." are cleared when the request ends.
- Where in the code: `LogoCreationWorkspace` in `src/components/logo-creation/logo-creation-workspace.tsx`; `VisualDirectionsView` in `src/components/visual-directions/visual-directions-view.tsx`; hook in `src/components/logo-creation/use-logo-engine.ts`.
- Fixed by: D-009 (Skeleton, Media frame and waiting patterns; DS-015)
- Status: **Done** by the Logo and Creative direction rebuild (PR 265: loading tiles and "Loading saved concepts…", no instructions before saved inputs load) and commit fd208fc5 on branch `ui/execution-fixes` ("Not ready yet." no longer stays beside the button after a refusal; the warning with Try again says it once). Verified by a unit test (`journey-components`). The lead watches the first three seconds of opening Kestrel and of Continue from Inspiration in the running app.
- Evidence: `annotated/M-014.png`, `annotated/A-kbd-logo-step-preparing.png`, `motion/walk-brand-1440.txt`, `motion/walk-extra.txt`, `motion/walk-extra2.txt`
- Systemic? Yes: both steps, every brand.

**D-012. Starting, stopping and cancelling AI work are acknowledged late**
- Sources: M-016
- Screen/route, state and width: Logo step, "More concepts" and "Stop"; research, "Cancel research"; 1440.
- Category: feedback · Severity: P1 · Tag: execution fix · Area: Brand conversation
- What's wrong: After "More concepts" the button is disabled within 45 ms, but the six logos stay exactly as they were for 3.2 seconds, which matches the page's 3-second interval for asking the server again. Then all six are replaced at once, with two layout shifts. After "Stop" the button dims and nothing else changed in the next 8 seconds. After "Cancel research" the heading kept saying "Researching your competitors" with the bar sweeping for 2 seconds. (The stand-in AI was deliberately slow, so real stops may finish sooner; the missing acknowledgement does not depend on that.)
- Why it matters: These buttons spend the customer's credits or try to save them. An unchanged screen after a paid click, or after "Stop", raises the question "did that work?" at the moment trust matters most.
- Suggested direction: Show the placeholders in the same frame as the click. After Stop or Cancel, change the visible state at once (placeholders show "Stopping…", the bar stops sweeping). Ask the server once immediately after any action instead of waiting out the interval.
- Where in the code: Polling intervals in `src/components/logo-creation/use-logo-engine.ts:12`, `src/components/workspace/use-strategy-jobs.ts:41`, `src/components/naming/naming-feed-controller.ts:23-25`.
- Status: **Done** in code: the Logo engine asks the server again straight after a start or a stop (`refresh` in `use-logo-engine.ts`) and a stop shows "Stopping…" at once; research shows "Cancelling research…" and the bar's stopping state. The lead confirms the timing in the running app (placeholders appear with the start response, not on the click itself).
- Evidence: `annotated/M-016.png`, `motion/walk-live.txt`
- Systemic? Yes: research, names, logos and directions share the same polling pattern.

**D-019. Opening a brand jumps several times and lands in a different place each time**
- Sources: M-013, A-024, E-052
- Screen/route, state and width: `/brands/account/<id>?view=strategy` for any brand past Voice, opened from Projects or by link; 390 and 1440; production build for the measurements.
- Category: performance (stability) · Severity: P1 · Tag: execution fix · Area: Brand conversation
- WCAG criterion or measured value: CLS 0.18 on desktop and 0.75 under phone conditions (good is 0.1 or less); LCP 409 ms on desktop and 9.3 s under phone conditions (good is 2.5 s or less)
- What's wrong: On opening Kestrel at 1440, the scroll position was set four times in the first 850 ms, and the code repeats the jump at 300, 800, 1,600 and 3,000 ms. Between jumps the gallery loads 43 images and reflows. One load ended at Creative direction and the next in the middle of the Inspiration gallery; at 390 it parked about 2,200 px down, among other companies' brand boards. For the first seconds the page is faded, the pill highlights the wrong step, and images are grey boxes labelled "Private board preview", "Loading private reference" and "Checking private preview…". The largest element painted first is a lazy-loaded image from another company's brand; nine images have no width and height; the project bar resizes twice.
- Why it matters: This is how every return visit to a brand begins. A page that moves by itself four times and shifts by more than half the screen feels broken, and it buries the person's own work under someone else's.
- Suggested direction: Land once. Reserve the final size of the project bar, gallery cards, logo grid and direction boards before their content arrives, remove the timed re-jumps, give every image its dimensions, keep the pill in step with what is on screen, use plain skeletons with no "private" wording, and never let another brand's gallery image be the first large thing painted. What a reopened brand shows first is decided in D-021. Do not add smooth scrolling over these distances; after a step jump, a brief highlight of the section heading is enough.
- Where in the code: Timed re-jumps in `AccountGuidedInterview`, `src/components/workspace/account-guided-interview.tsx:101-108`; `src/components/workspace/use-conversation-follow.ts`.
- Fixed by: D-009 (Skeleton, Media frame and waiting patterns; DS-015); D-021 (folding finished steps)
- Status: **Done** by the Workspace redesign: the timed re-jumps are gone, the chat and the work area scroll on their own, and images sit in Media frames that reserve their size. The "private" wording on loading boards is gone (commit 9523a84a on branch `ui/execution-fixes`). The lead measures CLS and the landing position on opening Kestrel (production build).
- Evidence: `annotated/M-013.png`, `annotated/M-013-390.png`, `annotated/E-052.png`, `annotated/E-052-390-lands-mid-gallery.png`, `annotated/E-052-checking-private-preview.png`, `traces/brand-conversation__kestrel__desktop__load.json.gz`, `traces/brand-conversation__kestrel__mobile-slow4g-cpu4x__load.json.gz`
- Systemic? Yes: every brand from the Inspiration step onward.

**D-020. Images are downloaded at full size, one by one, and cannot be cached**
- Sources: IMG-012, IMG-017, IMG-020, A-026
- Screen/route, state and width: All signed-in pages; measured on Library and on the Kestrel conversation (production build).
- Category: performance (imagery) · Severity: P1 · Tag: execution fix · Area: App-wide
- WCAG criterion or measured value: About 5.6 MB of images on a finished brand page; 147 requests; LCP 9.3 s under phone conditions; an estimated 4.3 to 6.9 s before first paint under phone conditions because of render-blocking CSS
- What's wrong: The app sends each private image in full and scales it down in the browser. A direction board of 1.1 to 1.3 MB is drawn at 237 px. The chosen logo is a 1024 px file drawn at 38 to 42 px. A Library card loads up to 1,280 KB for a 339 px preview. An uploaded reference of 1200 × 900 is drawn at 177 px. There are no thumbnails and no list of sizes for the browser to choose from (`srcset`). The brand page makes 49 API requests (1.2 MB), most of them private image previews fetched one by one, in a form the browser cannot keep between visits. Gallery images are sent with a cache lifetime of zero (the folder is 24 MB). Eight CSS files block the first paint. Every Library card has the same alt text, "Brand board preview".
- Why it matters: On a laptop with a good connection none of this is felt. On a phone or a weak connection the brand pages take about 9 seconds.
- Suggested direction: Serve small previews made on the server at the sizes each slot needs (listed in `04_image_needs.md`), and the full file only when it is opened or downloaded. Give gallery images long-lived cache headers and fingerprinted names. Let the browser keep private previews for the session. Combine or defer the CSS the first screen does not need. Load the first row eagerly and the rest lazily. Give each Library card its own alt text ("[Brand board / Logo concept / Direction board] for [brand name]").
- Where in the code: Library cards in `AssetsWorkspace` (`src/components/assets/assets-workspace.tsx`); private preview loading used by `ConceptGrid`, `VisualDirectionsView` and `ProjectCard`; gallery files under `public/inspiration/brands/`.
- Needs the owner: Previews made on the server change how images are served, which is a behaviour change outside "change the look, not what the app does". It needs the owner's go-ahead before implementation.
- Status: **Needs the owner** (unchanged): previews made on the server change how images are served. Library cards already have their own alt text (Library rebuild, PR 263).
- Evidence: `assets/assets.md`, `assets/assets.json`, `screens/library__kept-assets-pro__1440.png`, `traces/brand-conversation__kestrel__mobile-slow4g-cpu4x__load.json.gz`
- Systemic? Yes.

**D-025. Direction cards break the brand name in the middle of a word**
- Sources: E-034
- Screen/route, state and width: Creative direction step, every brand; 768 and 1440.
- Category: typography · Severity: P1 · Tag: execution fix · Area: Choosing a logo and a direction
- What's wrong: Each direction card previews its typeface by setting the brand name at about 22 px in a column about 95 px wide. The name breaks mid-word: "Kestrel Analytic / s", "Mosswo / od Candles", "Bright Harbor Learnin / g". The break differs per typeface, so the three cards also end at different heights.
- Why it matters: This is the typography sample on the screen where the person chooses their brand's typography. A broken word reads as a broken product.
- Suggested direction: Give the type sample the full card width (Palette above Typography), never break inside a word, and scale the sample to fit long names.
- Where in the code: `VisualDirectionsView` in `src/components/visual-directions/visual-directions-view.tsx`, styles in `src/components/visual-directions/visual-directions-view.module.css`.
- Status: **Done** (commit bcb29750 on branch `ui/execution-fixes`): Palette sits above Typography, and the type sample breaks only between words and shrinks until its longest word fits the card. Verified by a unit test (`direction-type-sample`). The lead checks the Kestrel, Mosswood and Bright Harbor cards at 1440.
- Evidence: `screens/brand-conversation__kestrel-complete-showcase-pro__1440.png`, `screens/brand-conversation__mosswood-directions-generated-free__1440.png`, `screens/brand-conversation__logos-failed-brightharbor-pro__1440.png`
- Systemic? Yes: all direction cards.

**D-026. A diagnostic link and a stray note appear under the Home prompt once you type**
- Sources: E-002
- Screen/route, state and width: `/` signed out, prompt filled; all widths.
- Category: copy (also layout) · Severity: P1 · Tag: execution fix · Area: Home
- What's wrong: After typing, two left-aligned grey lines appear under the prompt: "Sign in to save your project. Your prompt is kept." and a link, "Check AI availability". They push the centred starter chips down by about 100 px.
- Why it matters: It exposes plumbing on the first screen and makes the product sound unreliable before the first click. Heuristic: match between the system and the real world.
- Suggested direction: Signed out, show one short line at most ("You'll sign in before we start. Your idea is kept."). Show an availability message only when AI really is unavailable, in plain words, with one Retry button. Reserve the space so the chips do not move.
- Where in the code: `AccountStrategyStart` in `src/components/workspace/account-strategy-start.tsx:470-494`.
- Status: **Done** by the Home rebuild (PR 261): no sign-in note or "Check AI availability" link under the prompt. The lead checks the prompt-filled state at 1440.
- Evidence: `screens/home__signed-out-prompt-filled__1440.png`, `screens/home__signed-out-prompt-filled__390.png`
- Systemic? Yes: system vocabulary in customer copy also appears in D-030, D-016 and D-080.

**D-027. Success and failure notices on the account screens look like ordinary helper text**
- Sources: E-012
- Screen/route, state and width: `/sign-in?confirmation=…` (confirmed and failed), `/forgot-password` sent; all widths.
- Category: hierarchy (also copy) · Severity: P1 · Tag: execution fix · Area: Sign in and account
- What's wrong: After confirming an email, the person lands on Sign in with a grey paragraph: "Your confirmation link was processed. Check your account or sign in to continue." It has the same colour and size as the subtitle above it. The failed-link version is four grey sentences, with "Request another confirmation email" as faint centred text. "Check your email" has three grey text blocks and a faint "Send another link".
- Why it matters: This is the moment a new customer arrives from their inbox, and "was processed" does not say whether it worked. Heuristic: visibility of system status.
- Suggested direction: Use the positive and warning Inline message. Success: "Email confirmed. Sign in to start your first brand." Failure: one sentence on what happened, one on what to do, and a real secondary button, "Send a new confirmation email".
- Where in the code: `SignInForm` in `src/components/auth/sign-in-form.tsx`; forgot-password page in `src/app/forgot-password/page.tsx`.
- Fixed by: D-008 (Inline message and Toast; DS-012)
- Status: **Done** (commit ae0722a5 on branch `ui/execution-fixes`): "Email confirmed. Sign in to start your first brand."; a failed link gets two sentences and a secondary button, "Send a new confirmation email"; "Send another link" is a real button. Verified by unit tests (`account-creation`).
- Evidence: `screens/sign-in__email-confirmed-notice__1440.png`, `screens/sign-in__email-confirmation-failed-notice__1440.png`, `screens/forgot-password__sent__1440.png`
- Systemic? Yes: status messages styled as secondary text recur across the app.

**D-028. There is no Terms, Privacy, Help or contact link anywhere**
- Sources: E-011
- Screen/route, state and width: `/sign-up` (page and overlay), `/plans`, the account menu; all widths.
- Category: flow · Severity: P1 · Tag: execution fix · Area: Sign in and account
- What's wrong: The sign-up form has no terms or privacy notice. A search of the source finds no link to terms, privacy, support, help or a contact address on any screen, including Plans, where people pay.
- Why it matters: Paying customers and agencies look for these before entering a card or a client's idea; their absence reads as unfinished. Heuristic: help and documentation.
- Suggested direction: One quiet line under the Create account button ("By creating an account you agree to the Terms and Privacy Policy"), and the same two links plus "Help" in the account menu and at the foot of Plans. Once help exists it must sit in the same place on every page (WCAG 3.2.6 Consistent Help).
- Where in the code: Sign-up form in `src/app/sign-up/page.tsx`; account menu in `FloatingNav` (`src/components/journey/floating-nav.tsx`); `PlansWorkspace` in `src/components/billing/plans-workspace.tsx`.
- Needs the owner: The Terms, Privacy and Help documents are not in this repository. The owner supplies them, or their addresses, before the links can be added.
- Status: **Needs the owner** (unchanged): the Terms, Privacy and Help documents or their addresses.
- Evidence: `screens/sign-up__default__1440.png`, `screens/home__signed-out-sign-up-overlay__390.png`, `screens/plans__signed-out__1440.png`, `screens/home__account-menu-open-pro__1440.png`
- Systemic? Yes: sign-up, Plans and the account menu.

**D-029. The Assets page shifts by more than half a screen when the files are ready, and again after a download**
- Sources: M-019, A-025
- Screen/route, state and width: `/brands/account/<id>/logo/deliverables` (Kestrel, Mosswood); 390 and 1440; production build for the measurements.
- Category: performance (stability) · Severity: P1 · Tag: execution fix · Area: Delivery: Assets and exported files
- WCAG criterion or measured value: CLS 0.55 on desktop (poor is above 0.25); LCP 1.2 s on desktop and 9.3 s under phone conditions
- What's wrong: The page arrives in four stages. For about half a second it is blank except for one small line, "Loading your chosen direction…". Then three grey "Preparing…" boxes appear. At about 1.3 seconds the brand board is inserted above them, which moves everything down by a third of the screen. Clicking "Download brand kit" changes the status text and moves the content again (0.26). Under phone conditions nothing meaningful is painted for 8.8 seconds.
- Why it matters: This is the screen the whole journey leads to, and where the customer collects what they paid for. The person reaches for a download button while the page is still moving.
- Suggested direction: Render the page's final structure at once, with skeletons the exact size of the brand board and each file tile, and replace them in place. Show headings, descriptions and download buttons in a waiting state before the images are built. Keep status text in a slot that never changes height. One quiet confirmation when everything is ready.
- Where in the code: `AssetsJourney` in `src/features/brand-assets/components/assets-journey.tsx`.
- Fixed by: D-009 (Skeleton, Media frame and waiting patterns; DS-015)
- Status: **Done** by the Assets rebuild (PR 268: skeletons in the final shape, status in toasts). The lead measures CLS on Kestrel's Assets page (production build).
- Evidence: `annotated/M-019.png`, `screens/brand-assets__kestrel-preparing-pro__1440.png`, `traces/brand-assets__kestrel__desktop__load.json.gz`, `traces/brand-assets__kestrel__mobile-slow4g-cpu4x__load.json.gz`
- Systemic? Every complete brand; one page.

**D-030. When a project cannot load, the page falls back to raw, unstyled messages**
- Sources: E-040
- Screen/route, state and width: `/brands/account/<id>` with the API failing, or a project that does not exist; 390 and 1440.
- Category: components (also copy) · Severity: P1 · Tag: execution fix · Area: Brand conversation
- What's wrong: The pill stays on "Loading project…" for good. A strip at the very top says "The saved project could not be verified. Your existing work is kept." with a faint "Check saved project". Below it: "Opening your project. Your saved work could not be checked…", or a heading "Account project", a pink strip and "Retry loading project / Back to brands". Up to three messages at three different left edges, none in a card.
- Why it matters: This is what a customer sees on a bad connection. It looks like a broken page, and the wording is the system talking to itself. Heuristic: help users recognise, diagnose and recover from errors.
- Suggested direction: One centred card in the page-error pattern: "We couldn't open this brand. Your work is saved. Check your connection and try again." with "Try again" and "Back to Projects". The pill shows the normal navigation.
- Where in the code: Project page in `src/app/brands/account/[projectId]/page.tsx`; fallback editor `AccountProjectEditor` in `src/components/workspace/account-project-editor.tsx`.
- Fixed by: D-008 (Inline message and Toast; DS-012)
- Status: **Done** (commit e818ae02 on branch `ui/execution-fixes`): a brand that can't be opened shows one page error in the Empty state layout ("We couldn't open this brand", the reason, Try again, Back to Projects) and the pill returns to the app's navigation; an invalid link gets the same layout. Verified by unit tests (`account-project-request-recovery`, `app-shell-stability`). **Open:** when the API fails, the layout's strip "The saved project could not be verified…" with "Check saved project" (`AccountProjectWorkspaceShell`) can still show above the page error; its wording is held by tests and it keeps an open editor usable. The lead checks the API-500 capture.
- Evidence: `screens/project-workspace__error-api-500-pro__1440.png`, `screens/project-workspace__missing-project-pro__1440.png`, `screens/project-workspace__error-api-500-pro__390.png`
- Systemic? Yes: the same "could not be confirmed / verified / checked" wording appears in Settings and on Home.

**D-032. The delete dialog explains the system instead of the consequence**
- Sources: E-019
- Screen/route, state and width: `/brands` → Delete; all widths. The Deleted projects subtitle repeats the wording.
- Category: copy · Severity: P1 · Tag: execution fix · Area: Projects and Library
- What's wrong: The body reads "This moves the project to Deleted projects and requests cancellation of active work. Work already started may still finish or incur usage. Its assets and history are kept. Restoring won't restart cancelled AI work." The confirm button is "Stop active work and delete project", shown even when nothing is running.
- Why it matters: A confirmation should say what happens to the person's work in one breath. This one makes a reversible action sound risky and vague. Heuristic: error prevention.
- Suggested direction: "Delete "Orchard Lane Cider"? It moves to Deleted projects. You can restore it any time." Buttons: "Delete project" and "Cancel". Add one sentence only when work is running ("Logo concepts in progress will be stopped. Credits already used are not returned.").
- Where in the code: `ProjectCardActions` in `src/components/workspace/project-card-actions.tsx`; styles in `src/styles/project-card-actions.css`.
- Fixed by: D-046 (Dialog, Drawer and Menu; DS-013)
- Status: **Done** (commit 69759b82 on branch `ui/execution-fixes`): "It moves to Deleted projects with its files and history. You can restore it any time." plus one plain sentence about work still running. The card can't tell whether work is running, so that sentence is always there.
- Evidence: `screens/projects__delete-dialog-free__1440.png`, `screens/projects__delete-dialog-free__390.png`
- Systemic? Yes: the dialog and the Deleted projects subtitle.

**D-033. Plans keeps three columns at every width, so prices are clipped on a phone and at high zoom**
- Sources: E-025, A-014
- Screen/route, state and width: `/plans`, all accounts, at 390 px and at 320 px (the same as 400% zoom on a 1280 px window).
- Category: responsiveness · Severity: P1 · Tag: execution fix · Area: Credits and plans
- WCAG criterion or measured value: WCAG 1.4.10 Reflow (AA)
- What's wrong: The plan grid is three equal columns with no rule for narrow widths. At 390 px each card is about 100 px wide: text wraps to one or two words per line, the "Current plan" badge spills out of its card, "/ month" is cut off, and the upgrade buttons become round blobs with clipped labels. At 320 px "$7.99" and "$27.99" are cut off. The summary card's renewal note wraps to five to seven lines.
- Why it matters: This is the screen where people pay, and the out-of-credits prompt sends phone users straight to it. A clipped price next to a pay button is the most visibly broken screen in the audit.
- Suggested direction: Stack the plans in one column below the compact breakpoint, current plan first, with full-width buttons. This much is required by WCAG whatever the redesign decides; the look of the stacked cards is designed with D-031.
- Where in the code: `.plans-grid` in `src/styles/plans.css:53-60`; `PlansWorkspace` in `src/components/billing/plans-workspace.tsx`.
- Fixed by: D-052 (breakpoints and page widths; DS-009)
- Status: **Done** by the Plans rebuild (PR 267): the plan grid wraps to one column at narrow widths. Not re-captured at 390 and 320 px (desktop scope).
- Evidence: `screens/plans__free-0-credits-upgrade-free__390.png`, `screens/plans__pro-current-pro__390.png`, `a11y/reflow/plans__pro-current-pro__320.png`, `a11y/reflow/plans__pro-current-pro__zoom200.png`
- Systemic? No: one page.

**D-034. Library's "View details" opened nothing, so its detail view has never been reviewed**
- Sources: E-050, M-012
- Screen/route, state and width: `/assets`, both tabs; 390, 768 and 1440; development server only.
- Category: flow (interaction state) · Severity: P1 · Tag: execution fix · Area: Projects and Library
- What's wrong: Each Library card ends in a small arrow button named "View details of …". Clicking it, clicking the picture, or pressing Enter on it showed nothing. Pass 2's recorder found the reason: the detail view opens 42 ms after the click and closes itself 10 ms later. The component opens the dialog when it mounts and closes it when it unmounts, and closing calls the page's handler that removes it. The development server mounts every component twice on purpose, so the dialog closes itself; a production build does not do that. Because the view never stayed open, nothing in Library could be opened or downloaded during the audit, and the detail view's design is unseen.
- Why it matters: The only action on every item in Library was dead during the audit. If it is development-only, customers are not affected, but the pattern is fragile and blocks local testing.
- Suggested direction: Do not call the page's close handler from the unmount cleanup. Verify on a production build. Then review the detail view, and rebuild it on the system's Drawer.
- Where in the code: `AssetDetailDialog` in `src/components/assets/asset-detail.tsx:46-54`; strict mode in `next.config.ts:107`.
- Fixed by: D-046 (Dialog, Drawer and Menu; DS-013)
- Status: **Done.** PR 255 stopped the dialog closing itself in development; the Library rebuild (PR 263) put the detail view on the system's Dialog. The lead verifies opening and downloading on a production build.
- Evidence: `annotated/E-050.png`, `annotated/M-012.png`, `motion/walk-shell-signed-in.txt`
- Systemic? No.

### P2 (26)

**D-039. Ninety colours are written by hand, including 30 stray greys, five reds and one leftover magenta**
- Sources: DS-003
- Screen/route, state and width: All; most visible on hover and error states.
- Category: color · Severity: P2 · Tag: execution fix · Area: Design system
- What's wrong: 189 hand-written colours in 90 values bypass the 23 tokens. 69 of them repeat a token's own value. 30 near-grey values exist once or twice each, mostly hover borders one shade apart. Danger text has five spellings and danger backgrounds three; warning has hand-written copies beside its tokens. One value, `#cbacc5`, survives from the retired magenta accent.
- Why it matters: Hover and error states look slightly different on every screen, and the owner's "no magenta" decision is not fully applied.
- Suggested direction: Replace by the map in `05_design_system.md` section 5.2. No design decision is needed.
- Where in the code: `.form-error` in `src/styles/globals.css:90`; `.segment-card.is-selected` (`#cbacc5`) in `src/styles/conversation.css:366`; `.guided-conversation-error` in `src/styles/guided-conversation.css:112`; `.strategy-review-notice` in `src/styles/strategy.css:46`; second text colour `#3a3a37` in `src/styles/journey-conversation.css:134`.
- Status: **Done** (commit 3887818d on branch `ui/execution-fixes`) by the map in section 5.2, including the last magenta value (`#cbacc5`). `tools/ds-drift.mjs`, rerun into a temporary folder, finds no hex color outside the design-system bundle; the shadow colors went with D-051.
- Evidence: `design-system/drift.md`
- Systemic? Yes: 26 of 41 stylesheets.

**D-040. The prompt's "+" and microphone say nothing about what they do, and the disabled send button is faint**
- Sources: E-003
- Screen/route, state and width: `/`, all states and widths; the same reply box at the bottom of every project.
- Category: components · Severity: P2 · Tag: execution fix · Area: Home
- What's wrong: The "+" and the microphone are bare icons with no visible label and no tooltip. The disabled send button is a white arrow on mid-grey, which reads as decoration; on Home with an empty prompt it is styled grey but is not actually disabled. Keyboard focus on the text box only darkens the border.
- Why it matters: A non-designer cannot guess that "+" attaches reference images or that the microphone dictates. Heuristic: recognition rather than recall.
- Suggested direction: Give both icons a tooltip and an accessible name that says the outcome ("Add reference images", "Dictate"). Use the standard focus ring. Give the disabled send button the system's disabled look, and make it truly disabled when it cannot send.
- Where in the code: `FloatingComposer` in `src/components/workspace/floating-composer.tsx`; Home composer styles in `src/styles/home-concept.css:60-63`.
- Fixed by: D-005 (focus ring; DS-014); D-047 (form controls; DS-021); D-037 (disabled and busy states; DS-022)
- Status: **Done** by the Home rebuild: the "+" and microphone have names and tooltips ("Add files or images", "Voice input"), the system's focus ring and disabled look.
- Evidence: `screens/home__signed-out__1440.png`, `screens/home__signed-out-prompt-focus__1440.png`, `screens/home__keyboard-focus-nav__1440.png`
- Systemic? Yes: the reply box on every project conversation.

**D-041. Research in progress gives no sense of what is happening, and the 390 px reply box clips its placeholder**
- Sources: E-010
- Screen/route, state and width: New project, research in progress; 390 and 1440.
- Category: components (also responsiveness) · Severity: P2 · Tag: execution fix · Area: Brand conversation
- What's wrong: The progress card shows a thin grey bar and "Suggestions appear here when they're ready", with no sign of what is happening. At 390 the reply box placeholder "Reply in your own words, or ask a question…" wraps to a second line that is cut off by the box.
- Why it matters: Research is the first wait in the product; an unexplained wait feels longer.
- Suggested direction: Name the stage ("Reading competitor sites") and say in one fixed sentence how long it usually takes. No counters or percentages: the work has no known length. Shorten the placeholder at narrow widths so it fits on one line.
- Where in the code: `GuidedThinking` and the research progress card; `FloatingComposer`.
- Fixed by: D-009 (Skeleton, Media frame and waiting patterns; DS-015)
- Status: **Done** for desktop by the Workspace: the chat names the stage ("Researching your competitors and the pages they were found on.") with the progress bar. No "usually takes" sentence: the app has no measured duration to state. The 390 px placeholder clip is **Skipped: phone-only**.
- Evidence: `screens/home__research-in-progress-pro__1440.png`, `screens/home__research-in-progress-pro__390.png`
- Systemic? Yes: the placeholder clip affects every project page at 390.

**D-042. Brand pages have no usable browser-tab title or main heading**
- Sources: A-009
- Screen/route, state and width: Project conversation and Assets, all stages; the 404 page; 390 and 1440.
- Category: hierarchy (semantics) · Severity: P2 · Tag: execution fix · Area: Brand conversation
- WCAG criterion or measured value: WCAG 2.4.2 Page Titled (A); 2.4.6 Headings and Labels (AA); 1.3.1 Info and Relationships (A)
- What's wrong: The browser tab always reads "Strategy · Embel", whichever brand is open and whichever step is active; Assets always reads "Brand assets · Embel"; Home reads "Embel — Brand workspace". Early stages have no top-level heading; later stages have two hidden ones ("Logo", "Creative direction") in the middle of the page. "Concept 1" to "Concept 6" are third-level headings directly under a first-level one, which Lighthouse flags. A region named "Strategy" contains another region named "Strategy", and the reply box's region is called "Strategy composer" on every step. The 404 page's tab reads "Embel — Brand workspace" once the page has loaded.
- Why it matters: Titles and headings are how screen-reader users, and anyone with several tabs, find their place.
- Suggested direction: Title brand pages "[Brand name] · [Step] · Embel". One top-level heading per page, the brand name; steps as second-level headings. Fix the 404 title.
- Where in the code: `src/app/brands/account/[projectId]/page.tsx:9`; `src/components/logo-creation/logo-creation-workspace.tsx:1008`; `src/components/visual-directions/visual-directions-view.tsx:124`; `src/app/not-found.tsx`.
- Status: **Done** (commit 6d6c6990 on branch `ui/execution-fixes`): the tab reads "[Brand] · [Step] · Embel"; the conversation has one top-level heading, the brand's name, with Logo and Creative direction as second-level headings; the 404 title was already right. Verified by a unit test (`app-shell-stability`). Not changed: the reply box's region names ("Strategy composer", "Naming composer"), which tests and browser specs use to tell the two apart. The lead runs Lighthouse's heading checks.
- Evidence: `lighthouse/brand-conversation__quill-logos-generated-free__desktop/report.html`, `lighthouse/summary.md`
- Systemic? Yes: every brand page.

**D-043. The Embel mark is served as a bloated, lazy-loaded file in three copies, and the icon set is incomplete**
- Sources: IMG-001, IMG-002
- Screen/route, state and width: The navigation pill on every page, the sign-in card, the conversation avatar; browser and home-screen icons.
- Category: imagery · Severity: P2 · Tag: execution fix · Area: Brand and sharing
- What's wrong: The mark's file is 19.8 KB, of which 18.6 KB is an embedded record of how the file was made; the drawing itself is 1.1 KB. Three identical copies exist (`public/embel-mark.svg`, `public/fluid-mark.svg`, `src/app/icon.svg`). In the navigation it is lazy-loaded although it is on the first screen of every page. The icon set is `/icon.svg` and a 180 px Apple icon only: there is no web manifest and no PNG fallback.
- Why it matters: The one image on every page is the slowest to arrive, and bookmarks, Android home screens and older browsers get no sharp icon.
- Suggested direction: Serve one clean copy of 2 KB or less, loaded eagerly, and delete the duplicates; keep the original file with its record in source control, since removing the record removes its proof of origin. Add the missing icon sizes (32, 192 and 512 px, and a 512 px version with the mark inside the central 80% for round masks, 15 KB each at most) and a manifest.
- Where in the code: `AppMark` in `src/components/ui/app-mark.tsx`; `src/app/icon.svg`; `src/app/apple-icon.tsx`; `public/embel-mark.svg`; `public/fluid-mark.svg`.
- Status: **Done in part** (commit 6cac4c65 on branch `ui/execution-fixes`): one clean 1 KB copy of the mark (`/embel-mark.svg`, the favicon and the `/fluid-mark.svg` alias), loaded eagerly; the original with its provenance record is kept at `design-assets/brand/embel-mark-original.svg`. **Open:** the 32, 192 and 512 px PNGs, the maskable icon and the manifest (generated routes to check in the running app). `docs/embel-branding.md` keeps `/fluid-mark.svg` "for existing links"; the owner can confirm it may go.
- Evidence: `assets/assets.md`
- Systemic? Yes: every page.

**D-050. Half of all corner radii bypass the tokens, and two generations of shape coexist**
- Sources: DS-007
- Screen/route, state and width: All; clearest where a pill button sits next to a square icon button (sign-in overlay, activity dialog).
- Category: components (shape) · Severity: P2 · Tag: execution fix · Area: Design system
- What's wrong: 203 of 414 radius declarations are hand-written, in 18 values. Every size from 4 to 10 px is in use because no token exists below 12. `.icon-button` (6 px), `.small-badge` (4 px) and `.preview-badge` (5 px) are from an older, squarer look.
- Why it matters: The owner's November 6 direction is "rounder corners"; the leftovers contradict it on the same screen.
- Suggested direction: The six-step scale and the nested-corner rule in `05_design_system.md` section 3d; map in section 5.4. Whether buttons are pills is decision 4 and does not block this.
- Where in the code: `.icon-button`, `.small-badge`, `.preview-badge` in `src/styles/globals.css:30, 48, 52`; `.menu` in `src/components/journey/journey.module.css:93`; `.project-card-menu` in `src/styles/project-card-actions.css:31`.
- Status: **Done** (commit 081c0fd8 on branch `ui/execution-fixes`) by the map in section 5.4. No pixel radius is left outside the design-system bundle except 50% circles and two nested-corner `calc()` values.
- Evidence: `design-system/drift.md`
- Systemic? Yes.

**D-051. Thirty-four shadows, seven backdrops and twelve layer values**
- Sources: DS-008
- Screen/route, state and width: The navigation pill, the prompt, menus, every dialog.
- Category: components (elevation) · Severity: P2 · Tag: execution fix · Area: Design system
- What's wrong: 41 shadow declarations use 34 different values. Dialogs have six different shadows and four have none. Nine backdrops come in seven variants, two with blur. Layering (`z-index`) uses 12 values, and menus sit at 25 on one page and 40 on another.
- Why it matters: Surfaces that are the same kind of thing float at visibly different heights; a dialog on one page feels heavier than on the next.
- Suggested direction: Four shadow levels, one backdrop without blur, and the layer scale in `05_design_system.md` section 3d; map in section 5.5.
- Where in the code: `src/components/journey/journey.module.css:21, 108`; `src/styles/home-concept.css:57`; `.auth-signout-dialog` in `src/styles/auth.css:142-151`; `src/components/visual-directions/visual-directions-view.module.css:422`; `src/components/naming/naming-inspect.module.css:21`.
- Status: **Done** (commit c3ed4652 on branch `ui/execution-fixes`): shadow-raised, shadow-overlay and shadow-modal, the one scrim without blur, and the z tokens. One small legibility shadow under the round Continue control over artwork remains (no token of its size).
- Evidence: `design-system/drift.md`
- Systemic? Yes.

**D-052. Twenty-one breakpoints and eight page widths**
- Sources: DS-009
- Screen/route, state and width: All; most visible at 390 and 768.
- Category: responsiveness · Severity: P2 · Tag: execution fix · Area: Design system
- What's wrong: Layout rules switch at 21 different screen widths, so one layout changes at 700 px and its neighbour at 760 or 850. Page containers are 792, 1056, 1088, 1120, 1160, 1260, 1360 and 1440 px. There is no column grid.
- Why it matters: Between 600 and 900 px, parts of a page are in their narrow layout while others are still wide, and page edges do not line up when moving between pages.
- Suggested direction: Three named ranges, two containers (792 and 1,056 px) and the grid in `05_design_system.md` section 3d. Keep the gallery's container queries, which are the cleanest responsive code in the app. Plans and the project bar need layout work beyond the replacement (D-033, D-054).
- Where in the code: `src/styles/tokens.css:43-46`; `.page` in `src/styles/globals.css:32-38` (other lines removed in PR #258); gallery container queries in `src/components/inspiration/inspiration.css:174-189`.
- Screen findings this fixes: D-033 (E-025, A-014); D-054 (E-053, A-015)
- Status: **To do, not done in this pass:** about 30 breakpoints remain in the older stylesheets. Moving the desktop ones (1190 and 1050 px) onto the three ranges changes layouts between 1024 and 1279 px and needs capture checks; the narrower ones are phone-only work.
- Evidence: `design-system/drift.md`, `screens/plans__pro-current-pro__390.png`
- Systemic? Yes.

**D-053. About one style selector in eight is dead, and stylesheet names record history, not structure**
- Sources: DS-018
- Screen/route, state and width: Code only.
- Category: consistency (code) · Severity: P2 · Tag: execution fix · Area: Design system
- What's wrong: 157 of 1,267 class selectors are not mentioned by any component: 53 in `globals.css`, 35 in `project-naming.css` and 32 in `project-workspace.css`. Prefixes such as `guided-`, `concept-`, `project-`, `sg-` and `identity-` come from successive redesigns. 35 declarations use `!important`.
- Why it matters: Dead styles make every later change riskier and inflate every measurement in the audit.
- Suggested direction: Delete after checking each one (a class name assembled while the app runs would not be detected). Organise styles by component once the component layer exists. The code cleanup planned before implementation should take these out first.
- Where in the code: `src/styles/globals.css`, `src/styles/project-naming.css`, `src/styles/project-workspace.css`; full list in `design-audit/evidence/design-system/components.json`.
- Status: **Done** (PR 258; then commits a0d019a9 and ab4a19bd on branch `ui/execution-fixes`). Rerun on November 14, 2026 into a temporary folder: 1,080 class selectors; outside the design-system bundle only template-built names (`project-stage-strategy`, `e-skeleton--circle`) and `identity-reference-tags` (used by a browser spec) are unmentioned. The blanket reduced-motion rule and its three `!important` are gone; five `!important` remain as guards (`[hidden]` and inline-height overrides).
- Evidence: `design-system/components.md`, `design-system/components.json`
- Systemic? Yes.

**D-055. Signed-in pages first show their signed-out version, and the pill changes width after each load**
- Sources: E-008, M-008
- Screen/route, state and width: The navigation pill on every page; `/brands`, `/settings`, `/plans` and `/brands/account/<id>` on every full load; 390 and 1440.
- Category: performance (perceived) · Severity: P2 · Tag: execution fix · Area: App-wide
- What's wrong: Until the account check answers, pages render as if nobody were signed in. The pill shows a placeholder or "Checking account…" and then changes width around its centre. The Projects heading reads "Your projects." before becoming "Projects."; Settings announces "Sign in to edit your profile and preferences."; a brand page shows "Project workspace", "Checking your account…" and a "Back to Projects" link on an empty screen. Locally this lasts 100 to 350 ms (about 2 seconds in one earlier pass); on a real connection it lasts as long as the request.
- Why it matters: A returning customer briefly sees a screen telling them to sign in, and the one persistent element of the app jumps on every navigation.
- Suggested direction: While the account is unknown, render a neutral frame: the pill at its signed-in width with placeholders, the page heading, and a skeleton of the content. Show signed-out content only once the check has said so. The server already knows whether a session cookie exists.
- Where in the code: `AccountSessionProvider` in `src/components/workspace/account-session.tsx`; `FloatingNav` in `src/components/journey/floating-nav.tsx`; `AppShell` in `src/components/workspace/app-shell.tsx`.
- Fixed by: D-009 (Skeleton, Media frame and waiting patterns; DS-015)
- Status: **Done** (commits e818ae02, 015edeeb and b4bb62c5 on branch `ui/execution-fixes`): while the account is checked, brand pages and their layout show a neutral skeleton frame instead of "Project workspace" or "Account project" with "Checking your account…"; Projects, Library, Plans and Settings already waited on skeletons, and the pill's account button keeps its signed-in size while checking. Verified by unit tests (`app-shell-stability`, `project-workspace-progress`, `account-project-entry`). The lead walks full loads of `/brands`, `/settings`, `/plans` and a brand at 1440.
- Evidence: `annotated/M-008.png`, `screens/sign-in__error-wrong-password__1440.png`, `motion/walk-shell-signed-in.txt`
- Systemic? Yes: every signed-in page.

**D-056. The same thing has up to four names, and headings change between states**
- Sources: E-020
- Screen/route, state and width: `/brands` (signed in, empty, signed out), `/assets`, Home cards, the project pill, dialogs.
- Category: consistency (copy) · Severity: P2 · Tag: execution fix · Area: App-wide
- What's wrong: The heading is "Projects." with brands and "Your projects." when empty or signed out. Headings end in a full stop on Projects, Settings and Library but not on Plans. The same object is a "project" (Projects, New project, Delete project), a "brand" (Untitled brand, View brand kit) and, in a recovery link, an "account brand". Elsewhere: direction board, brand board, identity images and selected direction; generation, request, work and usage; kept, saved, liked, chosen and used in brand. The empty state says "Start with a complete brand, a name, or a visual identity", which describes starting points the product no longer offers. The subtitle "Every idea, in its own world." is a slogan, not information.
- Why it matters: One name per thing is how people learn an interface. Heuristic: consistency and standards.
- Suggested direction: One noun for the object, used in navigation, headings, buttons and dialogs. One word per thing, taken from the journey's own vocabulary. One heading style without full stops. Rewrite the empty state for the single journey: "No brands yet. Describe an idea and Embel builds the name, logo and look with you."
- Where in the code: `ProjectsWorkspace` in `src/components/workspace/projects-workspace.tsx`; `AssetsWorkspace`; `ProjectCapsule`; `GenerationActivity`.
- Needs the owner: Pass 1 suggests "Brands" as the noun; the navigation says "Projects" today. Renaming a navigation item is the owner's call. Until the owner decides, keep "Projects" for the list and call the thing being made a "brand", consistently.
- Status: **Needs the owner** (unchanged) for the noun. Headings without full stops and the rewritten empty state came with the Projects and Library rebuild (PR 263).
- Evidence: `screens/projects__eight-brands-free__1440.png`, `screens/projects__empty-fresh__1440.png`, `screens/projects__signed-out__1440.png`, `screens/library__kept-assets-pro__1440.png`
- Systemic? Yes: all list pages, dialogs and the project pill.

**D-057. Messages are inserted into the page and push everything below them**
- Sources: M-007
- Screen/route, state and width: Home prompt (helper lines and the "+" panel), Plans (payment error), Projects (the "moved to Deleted projects" notice), Logo step ("Retry" with no credits, "Saving your choice…"), Creative direction ("Saving choice…"), Inspiration ("Show more brands"); 390 and 1440.
- Category: feedback · Severity: P2 · Tag: execution fix · Area: App-wide
- WCAG criterion or measured value: Layout shifts of 0.21 (deleting a project), 0.11 (the "+" panel at 390), 0.05 to 0.07 (retry with no credits), 0.04 (saving a direction)
- What's wrong: Status lines and notices are added in the normal flow of the page, so the content the person is looking at moves at the moment they act. On the two decision screens the cards shift at the exact moment of choosing.
- Why it matters: The control just pressed, or the next one the person was aiming for, moves away.
- Suggested direction: Give every status line a reserved place that exists before the message does (a fixed-height slot), or show it over the content (the Toast). Never insert a message above the thing that was clicked.
- Fixed by: D-008 (Inline message and Toast; DS-012)
- Status: **Done in part**: the rebuilt screens use Inline message slots and toasts, and Creative direction no longer inserts "Saving your choice…" under each board (commit b184371f on branch `ui/execution-fixes`). **Open:** Projects' "moved to Deleted projects" notice is still inserted above the list; it carries the live stop status of that project's work. The lead measures the shift when deleting a project.
- Evidence: `annotated/M-007.png`, `motion/walk-live2.txt`, `motion/walk-brand-1440.txt`, `motion/walk-brand-390.txt`
- Systemic? Yes.

**D-058. Choosing a logo or a direction is confirmed about a second after the click**
- Sources: M-015
- Screen/route, state and width: Logo step (Quill) and Creative direction step (Mosswood); 1440.
- Category: feedback · Severity: P2 · Tag: execution fix · Area: Choosing a logo and a direction
- What's wrong: Clicking a logo concept showed the line "Saving your choice…" after 15 ms and the selection ring 880 ms after the click. Clicking a direction showed the ring and "Editorial Soft Shapes chosen" after 1.3 seconds. In between, the card looks unchosen and the inserted line pushes the grid.
- Why it matters: These are the two decisions the whole journey leads to. A second without visible confirmation on the card invites a second click and makes the most satisfying moment in the product feel hesitant.
- Suggested direction: Mark the card as chosen at once (the ring and the tick appear with the click, easing in over 160 ms), save in the background, and revert with a message only if saving fails. Keep the "Saving…" text out of the layout (D-057).
- Where in the code: `ConceptGrid` in `src/components/logo-creation/concept-grid.tsx`; `VisualDirectionsView` in `src/components/visual-directions/visual-directions-view.tsx`.
- Fixed by: D-007 (Choice card; DS-011)
- Status: **Done** (commit b184371f on branch `ui/execution-fixes`): the clicked concept or board shows as chosen at once and goes back if saving fails. Verified by a unit test for the direction rule; the Logo path is checked in the running app by the lead.
- Evidence: `annotated/M-015.png`, `motion/walk-live.json`
- Systemic? Yes: both selection screens.

**D-059. Spacing has no scale: 53 values, every odd number included**
- Sources: DS-006
- Screen/route, state and width: All.
- Category: spacing · Severity: P2 · Tag: execution fix · Area: Design system
- What's wrong: Padding, margin and gap use 53 distinct values in 2,355 declarations. 56% sit on a ten-step 4 px scale; the rest include 5, 7, 9, 11, 13, 15, 17 and 19 px and a parallel 10 / 14 / 18 set (406 uses). Card padding ranges from 8 to 28 px.
- Why it matters: Alignment between neighbouring elements is off by one to three pixels throughout, which is exactly what reads as "not quite precise".
- Suggested direction: The 14-step scale and the rounding rule in `05_design_system.md` sections 3d and 5.4. Re-check layouts with `capture.mjs` after the replacement.
- Where in the code: `.draft-card`, `.form-panel`, `.segment-card`, `.settings-panel` in `src/styles/globals.css:85, 100` (other lines removed in PR #258).
- Status: **Done** (commit 53de31b1 on branch `ui/execution-fixes`): about 350 off-scale values rounded onto the scale by the rule in section 5.4 (on-scale values were already tokens). Left as they are: negative offsets, values inside `calc()`/`min()`/`max()`/`env()`, and the floating reply box's fixed rows. The lead re-checks layouts with `capture.mjs`.
- Evidence: `design-system/drift.md`
- Systemic? Yes: 36 of 41 stylesheets.

**D-062. Waiting and failed logo cards say little, say it twice, and change size**
- Sources: E-036, IMG-019
- Screen/route, state and width: Logo step while concepts are drawn, and after failures; 1440.
- Category: components (also copy) · Severity: P2 · Tag: execution fix · Area: Choosing a logo and a direction
- What's wrong: While drawing, each of six cards shows a "Creating your concept" chip and a "Creating" label; beside the refine button a note says "Request in progress…". A failed card says "No image preview yet" in the middle and "Failed" at the bottom, which contradict each other, and gives no reason. Waiting and failed cards are taller than finished ones, so the grid changes height when images arrive.
- Why it matters: Image drawing is the longest wait in the product. Heuristic: visibility of system status.
- Suggested direction: One message per card ("Drawing…", then the image, or "Couldn't draw this one"), one line for the whole set, the same tile size in every state (a soft pulse while drawing, a still tile when a concept could not be drawn), and a plain reason with whether credits were returned.
- Where in the code: `ConceptGrid` in `src/components/logo-creation/concept-grid.tsx`; `src/components/logo-creation/generation-animation.tsx`.
- Fixed by: D-009 (Skeleton, Media frame and waiting patterns; DS-015)
- Status: **Done** by the Logo rebuild: one message per tile ("Concept 3 couldn't be drawn."), the same frame in every state, one line for the set. Not shown: whether a failed tile's credits came back, which the tile's data doesn't carry.
- Evidence: `screens/brand-conversation__logos-drawing-aurelie-pro__1440.png`, `screens/brand-conversation__logos-failed-brightharbor-pro__1440.png`, `screens/brand-conversation__tidewater-logos-partly-failed-free__1440.png`
- Systemic? Yes: creative-direction boards use the same pattern.

**D-063. Logo files have the mark off-centre, the token file repeats its colours, and the kit's README reads defensively**
- Sources: E-048, A-034, IMG-027
- Screen/route, state and width: `logo/logo-*.png`, `design-system/design-tokens.css` (also shown on Assets → Design system → Export) and `README.txt` in the kit.
- Category: exports · Severity: P2 · Tag: execution fix · Area: Delivery: Assets and exported files
- What's wrong: The three logo files are 1024 × 1024 PNGs in which the mark fills about two thirds of the canvas and sits below centre, untrimmed. `design-tokens.css` declares the four colour variables twice in a row. The README is accurate but written defensively and in file-system terms ("Social SVG templates are not vector logo masters.").
- Why it matters: An off-centre canvas makes the logo awkward to place, and agencies will open the token file. The Direction asks for professional control and polished exports.
- Suggested direction: Trim and centre the logo with even padding. Remove the duplicated lines. Rewrite the README as a short, friendly "What's in this kit". Say on the Assets page, not only in the README, that the logos are images, not vectors. Never present a raster file as a vector.
- Where in the code: Export builders under `src/features/brand-assets/`; token export shown by `AssetsJourney`.
- Needs the owner: A larger logo export (pass 1 suggests 4,096 px; pass 1b calls it a product decision) cannot be made honestly from a 1024 px image. It would need the logo to be generated at a larger size, which is the owner's product decision and outside this redesign.
- Status: **Done in part** (commits de0321b1 and 8d5d31b2 on branch `ui/execution-fixes`): `design-tokens.css` writes each color variable once, and the README is a short "What's in this kit" that says the logos are PNG images, not vectors. **Open:** trimming and centring the logo PNGs (an image change in the export builder, to check on real exports) and saying on the Assets page that the logos are images. **Needs the owner:** a larger logo export.
- Evidence: `exports/rendered/kestrel__logo--logo-transparent.png.png`, `exports/rendered/kestrel__README.txt.png`, `design-audit/evidence/exports/kestrel/kit/design-system/design-tokens.css`
- Systemic? Yes: every brand.

**D-064. The inspiration brand view calls a named brand "Untitled brand"**
- Sources: E-054
- Screen/route, state and width: Project conversation → Inspiration → Open brand (dialog), Kestrel Analytics; 1440.
- Category: copy · Severity: P2 · Tag: execution fix · Area: Brand conversation
- What's wrong: The view's footer says "Your choices stay with Untitled brand." for a brand named Kestrel Analytics, and the panel is headed with a small all-capitals "BRAND". The view itself is, in pass 1's judgement, the best-presented screen in the journey.
- Why it matters: The wrong name is a visible slip in the product's best moment.
- Suggested direction: Use the brand's real name.
- Where in the code: `BrandOverlay` in `src/components/inspiration/inspiration-brands.tsx`.
- Status: **Done** (commit 2d7f4188 on branch `ui/execution-fixes`): the footer names the brand by its chosen name. Verified by a unit test (`inspiration-dom-stability`).
- Evidence: `annotated/E-054.png`
- Systemic? "Untitled brand" also appears for named brands on the legacy identity page (D-077).

**D-065. The larger view of a direction board opens small and jumps to full size**
- Sources: M-018
- Screen/route, state and width: Creative direction, "View … larger" (Mosswood); 390 and 1440.
- Category: motion (stability) · Severity: P2 · Tag: execution fix · Area: Choosing a logo and a direction
- WCAG criterion or measured value: Layout shift 0.32 at 1440 and 0.18 at 390
- What's wrong: The dialog opens as a short box containing "Private board preview" and, a frame or two later, grows to its full height when the image is ready.
- Why it matters: The dialog exists to show the board large. Opening at the wrong size makes the product's best image arrive with a twitch.
- Suggested direction: Give the dialog its final size from the start (the boards are square; reserve a square) and fade the image in over 200 ms.
- Where in the code: Larger-view dialog in `VisualDirectionsView`; `src/components/visual-directions/visual-directions-view.module.css:422`.
- Fixed by: D-009 (Skeleton, Media frame and waiting patterns; DS-015); D-046 (Dialog, Drawer and Menu; DS-013)
- Status: **Done** (commit 9523a84a on branch `ui/execution-fixes`): the larger view reserves the board's square from the first frame and fades it in; loading boards show no words. Verified by a unit test (`private-preview-stability`); the lead measures the shift in the running app.
- Evidence: `annotated/M-018.png`, `motion/walk-brand-1440.txt`
- Systemic? Probably: the same private-preview loader is used for other images.

**D-066. Dates ignore the account's date preference, and two screens show different renewal dates**
- Sources: A-028
- Screen/route, state and width: Project cards, the Projects list, Plans, credit messages. Found in code.
- Category: consistency · Severity: P2 · Tag: execution fix · Area: App-wide
- What's wrong: Settings lets a person choose a time zone and a date format, and one component honours them. Four other functions fix the language to English and ignore both. Relative times ("3 hours ago") are built by hand, and a card's tooltip shows the raw machine timestamp. Related, from pass 1: the same account's renewal date reads December 1 in the out-of-credits message and November 30 on Plans.
- Why it matters: A setting that only some screens respect looks broken, and Plans is where the renewal date matters most.
- Suggested direction: One shared date formatter that takes the account's preference, used everywhere, including the tooltip.
- Where in the code: Good model `BrowserLocalDate` in `src/components/workspace/browser-local-date.tsx:20-24`; `shortDate` in `src/components/workspace/project-card.tsx:21, 152, 168`; `dateLabel` in `src/components/workspace/projects-workspace.tsx:39-45`; `formatDate` in `src/components/billing/plans-workspace.tsx:26`; `creditsMessage` in `src/components/workspace/credits-message.ts:7`.
- Status: **Done in part** (commit ccbdeb8b on branch `ui/execution-fixes`): one renewal-date function for the account menu, Plans, Settings and every credits message, so they name the same day. Verified by a unit test (`credits-renew-date`). **Open:** Library and Activity dates still use fixed English formats instead of the account's preferences.
- Evidence: `screens/plans__free-0-credits-upgrade-free__1440.png`, `screens/brand-conversation__out-of-credits-prompt-free__1440.png`
- Systemic? Four functions.

**D-067. The inspiration gallery's 56 brand boards carry no credit line in the app's data**
- Sources: IMG-014, IMG-015
- Screen/route, state and width: Project conversation → Inspiration gallery and its large brand view.
- Category: imagery (credits) · Severity: P2 · Tag: execution fix · Area: Brand conversation
- What's wrong: The gallery shows real studio brand boards. The data file for the 56 brands has no creator, source or permission field on any entry, and nothing in `docs/` says where the permission records are. The owner confirmed on November 11 that the records exist and are kept outside the repository; the audit did not see them.
- Why it matters: The original decision for the gallery was to keep a credit line for every image.
- Suggested direction: Add each board's credit line to the data and show it in the large view. Note in `docs/` where the permission records are kept. The boards themselves do not need to change for this.
- Where in the code: `src/domain/inspiration-brands.json`; `BrandOverlay` in `src/components/inspiration/inspiration-brands.tsx`; `docs/inspiration-brand-boards.md`.
- Needs the owner: The credit wording comes from the permission records, which only the owner holds.
- Status: **Needs the owner** (unchanged): the credit wording comes from the permission records.
- Evidence: `annotated/E-054.png`
- Systemic? 56 gallery brands.

**D-072. Sign-in and sign-up errors are not tied to their fields, and sign-up validation is the browser's own tooltip**
- Sources: E-013, E-014, A-013
- Screen/route, state and width: `/sign-in`, `/sign-up`, `/forgot-password`, `/reset-password`, and the same forms in the overlay; 390 and 1440.
- Category: flow (forms) · Severity: P2 · Tag: execution fix · Area: Sign in and account
- WCAG criterion or measured value: WCAG 3.3.3 Error Suggestion (AA); 3.3.1 Error Identification (A) is met
- What's wrong: On sign-up a short password produces the browser's own bubble ("Please lengthen this text to 12 characters or more…"), one field at a time, so the mismatch is only reported after the length is fixed. On sign-in and forgot-password the error appears under the primary button, after the thing the person just pressed. No field is marked invalid. After a wrong password the password is emptied; after a mismatch both password fields are emptied and the message is linked to the first one only.
- Why it matters: A person who mistyped one character must retype everything, a screen-reader user is not told which field was wrong, and the browser bubble is the one place on the screen that is not Embel's design or voice.
- Suggested direction: Inline messages under each field in the app's own error style, shown when the field loses focus and on submit ("Use at least 12 characters", "The two passwords don't match"). Mark the field as invalid and link the message to it. Keep what was typed where security allows (at least the first password on a mismatch). Move focus to the field to fix.
- Where in the code: `SignInForm` in `src/components/auth/sign-in-form.tsx:95-107, 371-375`.
- Fixed by: D-047 (form controls; DS-021); D-008 (Inline message and Toast; DS-012)
- Status: **Done** by the account screens rebuild: the app's own messages under each field, fields marked invalid and linked, focus on the field to fix, no browser bubble. **Not changed:** passwords are still emptied after a mismatch; tests in `account-creation` and `sign-in-transient-password` hold that as deliberate credential handling, so keeping the first password is the owner's call.
- Evidence: `screens/sign-up__validation-password-mismatch__1440.png`, `screens/sign-in__error-wrong-password__1440.png`, `screens/forgot-password__error-rate-limited__1440.png`, `annotated/A-kbd-sign-up-mismatch.png`, `annotated/A-kbd-sign-in-error.png`
- Systemic? Three forms.

**D-073. Lists reload from a skeleton on every visit, then fill in three steps**
- Sources: M-009
- Screen/route, state and width: Home ("Pick up where you left off"), Projects, Library; signed in; 390 and 1440.
- Category: performance (perceived) · Severity: P2 · Tag: execution fix · Area: Projects and Library
- What's wrong: Going Home → Projects → Library → Home → Projects, each arrival shows the loading state again although the same list was on screen seconds earlier (skeleton cards for about 350 to 450 ms; "Loading assets…" on Library). The browser's Back button does the same. Clearing the Projects search box replaces the eight cards with eight skeletons and loads them again. When cards load, each fills in three steps: title, then thumbnail, then the "next step" line up to 800 ms later.
- Why it matters: Navigation is the most repeated action in the product. Showing a loading state for something the app already has makes it feel slower than it is.
- Suggested direction: Keep the last result in memory and show it at once on return, refreshing quietly in the background. Clear the search without a request. Reserve the skeleton for a first load. Fade thumbnails in over 200 ms. Do not animate the route change itself.
- Where in the code: `HomeWorkspace`, `ProjectsWorkspace`, `AssetsWorkspace`, `ProjectCard`. Plan: `design-audit/animation-plans/005-content-arrives-without-popping.md`.
- Fixed by: D-009 (Skeleton, Media frame and waiting patterns; DS-015)
- Status: **Done** (PR 263, commit 7defd4fd: lists already read show at once and refresh quietly).
- Evidence: `annotated/M-009.png`, `motion/walk-shell-signed-in.txt`
- Systemic? Yes: all three lists.

**D-076. Plan actions and messages are uneven**
- Sources: E-027
- Screen/route, state and width: `/plans` as a Pro account, and after a failed upgrade; 1440.
- Category: consistency · Severity: P2 · Tag: execution fix · Area: Credits and plans
- What's wrong: On Pro, "Manage plan" and "Cancel plan" are two identical outline buttons stacked together, so the destructive one has the same weight as the routine one. The Free card carries an instruction, "To return to Free, use Cancel plan on your current plan." The payment failure is bare red text with no container, while the success notice is a green strip. No navigation item is highlighted on this page.
- Why it matters: Billing is where precision is read as trustworthiness. Heuristic: consistency and standards; error prevention.
- Suggested direction: One "Manage plan" button, with cancel as a quiet text action. One notice component for success and failure.
- Where in the code: `PlansWorkspace` in `src/components/billing/plans-workspace.tsx`; `.plans-notice` in `src/styles/plans.css:145-156`.
- Fixed by: D-008 (Inline message and Toast; DS-012); D-006 (Button; DS-010)
- Needs the owner: Pass 1 also proposes rewriting the footer ("Payments are processed by Stripe through Link…") in two short sentences and adding "Downgrade to Free" on the Free card. The footer is billing and legal text, which the implementation rules leave to the owner, and a downgrade button is a new action. Neither is done without the owner's say.
- Status: **Done** by the Plans rebuild (one Manage plan button, Cancel plan as a quiet action, one notice component). **Needs the owner** (unchanged): the payment footer wording and a Downgrade to Free action.
- Evidence: `screens/plans__pro-current-pro__1440.png`, `screens/plans__upgrade-unavailable-free__1440.png`, `screens/plans__return-checkout-success-fresh__1440.png`
- Systemic? Yes: notice styles differ across pages.

**D-077. Two older screens are still reachable and do not match the app**
- Sources: E-041, A-022
- Screen/route, state and width: `/brands/account/<id>/identity` ("Build a visual starting point") and `/brands/<id>` ("Recover an unsaved project"); 390 and 1440.
- Category: consistency · Severity: P2 · Tag: execution fix · Area: Projects and Library
- WCAG criterion or measured value: Lighthouse accessibility 96 on the identity page (a label on an element with no role); WCAG 4.1.2 Name, Role, Value (A)
- What's wrong: The identity page predates the four-step journey: it calls Kestrel Analytics "Untitled brand", has a Chat / Controls side panel, square-cornered buttons, and messages such as "Reference discovery is not connected." It is linked from the fallback project editor. The recover page is plain text on a white page with "Back to projects" twice.
- Why it matters: A customer who lands on either sees a different, rougher product.
- Suggested direction: Retire the identity page (redirect it to the Inspiration step, like its sibling routes), and give the recover page the standard Empty state.
- Where in the code: `src/app/brands/account/[projectId]/identity/page.tsx`; link "Saved references and systems" in `AccountProjectEditor`, `src/components/workspace/account-project-editor.tsx` (lines removed in PR #258); `.identity-reference-indicators`; `src/app/brands/[projectId]/page.tsx`.
- Status: **Done.** PR 258 retired the identity route; PR 263 gave the recover page the standard Empty state (commit 1947b02e); commit ab4a19bd on branch `ui/execution-fixes` deletes the retired Identity editor's components and styles.
- Fixed by: D-038 (Empty state; DS-016)
- Needs the owner: Settled; the owner approved retiring the route in the code cleanup.
- Evidence: `screens/brand-identity__kestrel-pro__1440.png`, `screens/brand-recover__owner-no-unsaved-project-pro__1440.png`, `screens/recover-project__signed-out-none-available__1440.png`
- Systemic? No.

**D-078. Stripe's checkout and customer portal may not carry Embel's mark**
- Sources: IMG-029
- Screen/route, state and width: Stripe's hosted checkout and customer portal. Not seen: no Stripe test key is set locally.
- Category: imagery · Severity: P2 · Tag: execution fix · Area: Credits and plans
- What's wrong: The payment pages are hosted by Stripe and take their icon and logo from the Stripe Dashboard's branding settings. The audit could not see them.
- Why it matters: The page where a customer enters a card should look like Embel.
- Suggested direction: Set the existing mark as a square icon (512 × 512 PNG, 50 KB at most) in Stripe's branding settings, after checking Stripe's size rules.
- Needs the owner: This is a setting in the owner's Stripe Dashboard, not code. Only the owner can do it and check it.
- Status: **Needs the owner** (unchanged): a Stripe Dashboard setting.
- Evidence: `design-audit/04_image_needs.md`
- Systemic? No.

**D-079. Unused image files remain in the app, including other companies' logos**
- Sources: IMG-005, IMG-016
- Screen/route, state and width: None: these files are shown on no reviewed screen.
- Category: imagery (housekeeping) · Severity: P2 · Tag: execution fix · Area: App-wide
- What's wrong: `public/` holds 123 small SVG files; the asset scan saw 10 in use. A search found no reference to `handles/` (34 files, including the Facebook, Instagram, LinkedIn, TikTok, X and YouTube marks), `names/` (25 files), `logo-concepts/` (4 files), `fluid-mark.svg`, the repeated `shell-*` and `empty-shell-*` sets, or four app marks in `settings/` (Figma, Google Drive, Notion, Slack). Separately, the earlier inspiration catalogue is still present: 30 files in `public/inspiration/` (agency photographs of Dropbox and Mastercard work; logo studies of Airbnb, Figma, Spotify and others, 1.2 MB), still imported by two code files through `src/domain/inspiration-catalog.json`.
- Why it matters: Leftover files that include other companies' logos are a liability with no benefit.
- Suggested direction: Delete after one check that no component builds these paths by name. Remove the old catalogue together with its data file, after handling the two code files that still import it.
- Where in the code: `public/handles/`, `public/names/`, `public/logo-concepts/`, `public/fluid-mark.svg`, `public/settings/`; `public/inspiration/*.jpg`, `public/inspiration/*-logo-study.png`, `src/domain/inspiration-catalog.json`.
- Status: **Done in part**: the handles, names, settings and shell sets were already gone; `fluid-mark.svg` is a clean alias (D-043) and `public/naming/heart.svg` is deleted (commit b40cb00d on branch `ui/execution-fixes`). **Open:** the old inspiration catalogue (30 images and its data file) stays, because saved likes still resolve through it on the server; removing it is a data change.
- Evidence: `assets/assets.md`
- Systemic? No.

### P3 (16)

**D-082. Small inconsistencies in the conversation's own grammar**
- Sources: E-039
- Screen/route, state and width: All steps of the project conversation, and the Assets page; all widths.
- Category: consistency (also copy) · Severity: P3 · Tag: execution fix · Area: Brand conversation
- What's wrong: Every message carries a grey line such as "Embel · Competitors · 1 of 3" and the round Embel mark, even for folded answers, where a leftover intro also remains ("Three personality directions."). The same action is "Edit answer" on two steps and "Change name" on the third. "Continue" has an arrow in Strategy and Inspiration and none in Creative direction and Assets. A competitor card's "Sources" link repeats the competitor's name next to "Visit website". Selection controls are small and sit at the far right edge of wide cards. One intro reads "Here are competitors research found."
- Why it matters: The conversation is the product's voice; small slips are heard.
- Suggested direction: Drop the meta line and the intro on folded answers. One verb for changing an answer ("Change"). One Continue button style. Make the whole card the click target, with the control on the left. Fix the sentence ("Here are the competitors we found.").
- Where in the code: `AccountGuidedInterview` in `src/components/workspace/account-guided-interview.tsx`; `src/styles/guided-conversation.css`.
- Fixed by: D-007 (Choice card; DS-011); D-006 (Button; DS-010)
- Status: **Done.** The Workspace redesign removed the meta lines, the Continue arrows and the "competitors research found" sentence; commit ba642012 on branch `ui/execution-fixes` makes Change the one verb ("Change answer", "Change inspiration") with accessible names that start with the visible words.
- Evidence: `screens/brand-conversation__spokesmith-research-done-free__1440.png`, `screens/brand-conversation__northernlights-voice-done-long-name-free__1440.png`, `screens/brand-conversation__kestrel-complete-showcase-pro__1440.png`
- Systemic? Yes: all steps, and the Assets page.

**D-083. Nothing drops frames today; four details would if motion is added carelessly**
- Sources: M-020
- Screen/route, state and width: Research, logo drawing, the finished brand page, list loading; 1440.
- Category: performance · Severity: P3 · Tag: execution fix · Area: App-wide
- WCAG criterion or measured value: 60 frames per second measured in every case, including with the processor slowed 4 times
- What's wrong: No fault was measured. Four details are risks. (1) Each loading card runs four separate pulse animations, up to 32 on Projects, and they fall out of step. (2) The inspiration card's hover animates its shadow, which repaints the card every frame. (3) Two dialog backdrops use a blur. (4) The floating reply box writes its height into a CSS variable on the whole workspace container when it or the window resizes, which makes the browser re-check the style of everything inside. None of this was tested on a real phone.
- Why it matters: Smoothness is what lets good motion register at all, and a fast laptop hides nearly every such problem.
- Suggested direction: Pulse one wrapper per card. Keep hover changes to border and background. Fade overlays with opacity only, never the blur. Never update the reply box variable on every scroll frame. Before launch, record the logo-drawing screen and the finished brand page on a mid-range phone.
- Where in the code: `src/components/workspace/project-card.module.css:151-155`; `src/components/inspiration/inspiration.css:653-660`; `src/components/workspace/floating-composer.tsx:98-101`.
- Status: **Done in part** (commit 008ad6a5 on branch `ui/execution-fixes`): the gallery card's hover changes its border only; no dialog backdrop blurs; the side-chat reply box doesn't write its height on resize. **Open:** skeleton pieces still pulse one by one (a design-system change). Not tested on a real phone.
- Evidence: `motion/walk-live.json`
- Systemic? No.

**D-084. Control heights and text-link targets vary from about 20 to 48 px**
- Sources: DS-023, A-021
- Screen/route, state and width: Assets, Library, auth pages, the inspiration gallery; 390 and 1440.
- Category: components (targets) · Severity: P3 · Tag: execution fix · Area: Design system
- WCAG criterion or measured value: WCAG 2.5.8 Target Size (Minimum) (AA) passes, through its spacing exception
- What's wrong: 125 declarations set a 44 px height, but 32 set 40 px, 24 set 36 px, and others 28 to 48 px. Standalone text links are 19.5 to 23 px tall next to 44 px buttons ("Edit" on Assets, brand links in Library, "Return to Home"). On Sign in, the 44 px box of "Forgot password?" overlaps the top 4 px of the password field, so its focus ring cuts into the field. Gallery hearts are 30 and 36 px.
- Why it matters: Rows of controls do not line up, and small links are hard to hit on touch screens.
- Suggested direction: A minimum target token and the two control sizes in `05_design_system.md` sections 3d and 3f; a minimum box for standalone links; lay out "Forgot password?" so its box does not overlap the field.
- Where in the code: `.button`, `.icon-button`, `.text-link` in `src/styles/globals.css:35-52`.
- Screen findings merged into this item: A-021
- Status: **Done** by the design system (44 px controls, `link-target-min` for standalone links) and the account screens rebuild. The lead checks that "Forgot password?" no longer overlaps the password field.
- Evidence: `a11y/sign-in__default__1440.json`, `design-system/drift.md`
- Systemic? Yes (text links).

**D-085. Emails, exported files and crash screens sit outside the system, and nothing documents it**
- Sources: DS-024
- Screen/route, state and width: The two emails, `guides/brand-guide.html` in the kit, the global crash screen; documentation.
- Category: consistency · Severity: P3 · Tag: execution fix · Area: Design system
- What's wrong: The emails and the global crash screen carry their own hand-written colours and a system font, because they cannot load the app's stylesheet. The exported brand guide is unstyled. The only description of the system is a few comments in the token file and the November 6 plan.
- Why it matters: The files customers keep and the screens they see when something breaks are where drift is least noticed and most embarrassing. Without documentation the rebuilt system will drift the same way.
- Suggested direction: One shared source for the primitive values that the app, the emails and the export templates all read. The published Claude Design system becomes the documentation, and `/design-sync` keeps the code in step with it.
- Where in the code: `src/app/global-error.tsx`; `supabase/templates/confirmation.html`; `supabase/templates/recovery.html`.
- Screen findings this fixes: D-022 (E-042, E-047, IMG-022, IMG-023, IMG-024, IMG-025); D-023 (E-044, E-046, IMG-026); D-087 (E-049, IMG-028); D-095 (E-016, IMG-009)
- Status: **Done in part**: the crash screen uses the system's primitives and now the mark (commit a5c8a695 on branch `ui/execution-fixes`). **Open:** one shared source of primitive values for the emails and the exported guide.
- Evidence: `emails/confirmation__600.png`, `exports/rendered/kestrel__guides--brand-guide.html.png`
- Systemic? Yes.

**D-086. The account cards mix alignments and button widths**
- Sources: E-015
- Screen/route, state and width: All account screens and the overlay; all widths.
- Category: consistency · Severity: P3 · Tag: execution fix · Area: Sign in and account
- What's wrong: Headings and fields are left-aligned, while "New to Embel? Create account", "Send another link" and "Return to Home" are centred. Primary buttons are full width on forms but hug their label on "This link has expired" and "Your password is updated". The overlay over Home includes "Return to Home →" although Home is the page underneath. The pill above the Sign in page still offers "Sign in" and "Create account".
- Why it matters: Small inconsistencies in the simplest screens set expectations for the rest.
- Suggested direction: One alignment per card (left), one primary button width, drop "Return to Home" from the overlay, and hide the pill's account buttons on account pages.
- Where in the code: `src/styles/auth.css`; `SignInDialog` in `src/components/auth/sign-in-dialog.tsx`.
- Fixed by: D-006 (Button; DS-010)
- Status: **Done** (commit 5d15fd8a on branch `ui/execution-fixes`): the pill drops Sign in and Create account on the account pages; the cards were already left-aligned with one button width, and the overlay has no "Return to Home". Verified by a unit test (`app-shell-stability`).
- Evidence: `screens/sign-in__default__1440.png`, `screens/reset-password__error-link-expired__1440.png`, `screens/reset-password__saved__1440.png`, `screens/home__signed-out-sign-in-overlay__1440.png`
- Systemic? No.

**D-087. The two emails are clean and on-brand, with small gaps**
- Sources: E-049, IMG-028
- Screen/route, state and width: The confirmation and password-reset emails, as rendered previews at 390 and 600 px.
- Category: consistency (also imagery) · Severity: P3 · Tag: execution fix · Area: Sign in and account
- What's wrong: Both emails match the app and read well. The gaps: the brand is the word "Embel" in a system font with no mark; there is no plain link under the button for mail programs that block buttons; the reset email does not say how long the link lasts; and the footer is "Embel · embel.xyz" with no help contact.
- Why it matters: These are the first two messages a customer receives, and a dead button needs a fallback.
- Suggested direction: Add the mark beside the name as a hosted PNG (28 and 56 px, 3 KB at most, alt text "Embel"; many mail programs do not show SVG), an "or paste this link" line, the expiry time and a help address. The emails were not checked for accessibility; that is worth 30 minutes before launch.
- Where in the code: `supabase/templates/confirmation.html`; `supabase/templates/recovery.html`.
- Fixed by: D-085 (shared values for emails and exports; DS-024)
- Status: **Done in part** (commit 44807e8c on branch `ui/execution-fixes`): both emails print the link under the button, and the reset email says the link works once and expires after a short time. **Open:** the mark as a hosted PNG and a help address (D-028). The hosted project's templates are set in its dashboard by the release lead.
- Evidence: `emails/confirmation__600.png`, `emails/confirmation__390.png`, `emails/recovery__600.png`, `emails/recovery__390.png`
- Systemic? No.

**D-088. Project cards announce a different name from the one shown**
- Sources: A-018
- Screen/route, state and width: Home and Projects with brands; 390 and 1440.
- Category: components (semantics) · Severity: P3 · Tag: execution fix · Area: Projects and Library
- WCAG criterion or measured value: WCAG 2.5.3 Label in Name (A); Lighthouse "label-content-name-mismatch"
- What's wrong: The card link is announced as "View brand kit · Bright Harbor Learning", while the card shows "Bright Harbor Learning", "Today", "View brand kit". The words are reordered and the date is dropped.
- Why it matters: People who use voice control say what they see; names that start with the visible text work best.
- Suggested direction: Drop the hidden label and let the visible text be the name, or start the label with the brand name.
- Where in the code: `ProjectCard` in `src/components/workspace/project-card.tsx:183`.
- Status: **Done** by the Projects rebuild: the card's link is named by its visible title.
- Evidence: `lighthouse/projects__eight-brands-free__desktop/report.html`
- Systemic? Every project card.

**D-089. Like and Favourite buttons state their condition twice**
- Sources: A-019
- Screen/route, state and width: Gallery hearts, name favourites, Library like and save. Found in code.
- Category: components (semantics) · Severity: P3 · Tag: execution fix · Area: Brand conversation
- WCAG criterion or measured value: WCAG 4.1.2 Name, Role, Value (A)
- What's wrong: The label flips from "Like" to "Unlike" and the pressed state flips too, so a liked item is announced as "Unlike X, pressed".
- Why it matters: A screen-reader user hears a contradiction.
- Suggested direction: A fixed label ("Like X") with the pressed state, as the show-password button already does.
- Where in the code: `src/components/inspiration/inspiration-brands.tsx:61-74`; `src/components/naming/naming-inspect.tsx:85-86`; `src/components/assets/assets-workspace.tsx:315-336`.
- Status: **Done** (commit d8ebd41d on branch `ui/execution-fixes`): gallery and reference hearts keep the name "Like …" with the pressed state; Library's Like and Save already did.
- Evidence: `a11y/keyboard.json`
- Systemic? Three components.

**D-090. A generated brand's own preview can fail contrast**
- Sources: A-023
- Screen/route, state and width: Assets, Design system preview, Orchard Lane Cider; 390 and 1440.
- Category: color (exports) · Severity: P3 · Tag: execution fix · Area: Delivery: Assets and exported files
- WCAG criterion or measured value: WCAG 1.4.3 Contrast (Minimum) (AA)
- What's wrong: The preview sets the brand name in the brand's Text colour (`#141414`) on its Accent colour (`#c8553d`), which measures 4.23:1 at 13 px. The same card describes Accent as "Highlights and fills, not text".
- Why it matters: The customer copies these pairings into their own site. Embel should not demonstrate a pairing that fails.
- Suggested direction: When the preview puts text on a brand colour, pick dark or light text by calculated contrast, whichever passes. Consider showing the ratio next to each recommended pairing in the guidelines.
- Where in the code: Design system preview in `AssetsJourney`, `src/features/brand-assets/components/assets-journey.tsx`.
- Status: **Done** (commit 9f129118 on branch `ui/execution-fixes`): text on a brand color falls back to dark or light text when no palette color reaches 4.5:1. Verified by a unit test (`design-tokens`).
- Evidence: `a11y/brand-assets__orchardlane-ready-free__1440.json`, `screens/brand-assets__orchardlane-ready-free__1440.png`
- Systemic? Yes, for any generated palette.

**D-091. Every brand page logs two errors for missing competitor icons, and some icon circles stay empty**
- Sources: A-027, IMG-013
- Screen/route, state and width: Project conversation, every stage: research cards and the Strategy summary chips.
- Category: performance (best practices) · Severity: P3 · Tag: execution fix · Area: Brand conversation
- WCAG criterion or measured value: Lighthouse best practices 96 on all nine brand states ("errors-in-console")
- What's wrong: The request for a competitor's site icon answers "not found" when the competitor has no icon, and the browser logs each as an error. In Kestrel's Strategy summary the icon circles are empty instead of showing the initial. The seeded competitors have no real websites, so real icons were not seen.
- Why it matters: Console errors hide real problems, and an empty circle looks broken.
- Suggested direction: Answer "no icon" without an error status, or decide on the server and send no request. Always fall back to the competitor's initial.
- Where in the code: `CompetitorLogo` in `src/components/workspace/competitor-logo.tsx`; route `GET /api/projects/<id>/competitor-icon`.
- Needs the owner: Changing what the route answers is a small API change, which the implementation rules leave to the owner.
- Status: **Needs the owner** (unchanged): the competitor-icon route's answer is an API change.
- Evidence: `lighthouse/brand-conversation__spokesmith-research-done-free__desktop/report.html`
- Systemic? Every brand page.

**D-092. Invalid or duplicated markup in three places**
- Sources: A-029
- Screen/route, state and width: Inspiration gallery (failed image), Assets (colour tokens list), Settings (sign-out). Found in code.
- Category: components (code) · Severity: P3 · Tag: execution fix · Area: App-wide
- WCAG criterion or measured value: WCAG 4.1.2 Name, Role, Value (A); 1.3.1 Info and Relationships (A)
- What's wrong: (1) When a gallery image fails, a "Retry image" button is drawn inside the "Open brand" button; a button inside a button is invalid. (2) The colour tokens list on Assets is a table built from `div` elements with table roles, no header cells and one hidden cell. (3) The sign-out component is mounted twice on Settings, so two elements share each of the ids `sign-out-title` and `sign-out-description`.
- Why it matters: Invalid structure is read unpredictably by assistive technology.
- Suggested direction: Put the retry control beside the open button. Use a real table or a description list. Generate ids with `useId()`.
- Where in the code: `BrandImage` in `src/components/inspiration/inspiration-brands.tsx:92-100, 173-180`; `src/features/brand-assets/components/assets-journey.tsx:470-475`; `AccountAccess` in `src/components/workspace/account-access.tsx:122-133`.
- Status: **Done** (commit ed4c15e5 on branch `ui/execution-fixes`): no button inside a gallery tile's open button; the color tokens list and the sign-out ids were already rebuilt. Verified by a unit test (`inspiration-dom-stability`).
- Evidence: `a11y/keyboard.json`
- Systemic? No.

**D-093. Form details: unnamed inputs, status written into fields, a table with no caption**
- Sources: A-030
- Screen/route, state and width: Brand page, Settings, Plans, Usage. Found in code.
- Category: components (code) · Severity: P3 · Tag: execution fix · Area: App-wide
- What's wrong: (1) Several inputs have no `name`: the brief editor, both search boxes, the delete-account confirmation, the reply box. (2) Settings puts "Loading…" and "Unavailable" into the Full name and Email inputs as their value, and the email field is a plain text field. (3) Disabled buttons give no reason (see D-037). (4) The Usage table has no caption. (5) Placeholders repeat the label instead of giving an example.
- Why it matters: Browsers, password managers and screen readers all rely on these details.
- Suggested direction: Names and `autocomplete` on every field; status lines instead of values; a caption on the table; example placeholders.
- Where in the code: `AccountProfileEditor` in `src/components/workspace/account-profile-editor.tsx:61-72`; `RecordedUsage` in `src/components/workspace/recorded-usage.tsx:220-234`; `PlansWorkspace` in `src/components/billing/plans-workspace.tsx:313-318`; `ConceptGrid` in `src/components/logo-creation/concept-grid.tsx:469-479`.
- Fixed by: D-047 (form controls; DS-021); D-037 (disabled and busy states; DS-022)
- Status: **Done in part** (commit 4088ebe4 on branch `ui/execution-fixes`): the reply boxes, brief fields, search boxes and delete-account confirmation have a name and `autocomplete="off"`; Settings shows status lines, and the Usage table has a caption. **Open:** example placeholders.
- Evidence: `screens/settings__signed-out__1440.png`
- Systemic? No.

**D-094. Small polish items in text and markup**
- Sources: A-033
- Screen/route, state and width: App-wide. Found in code.
- Category: copy and typography (code) · Severity: P3 · Tag: execution fix · Area: App-wide
- What's wrong: Straight apostrophes in about 20 strings while the rest of the app uses curly ones. Headings do not balance their line breaks. The Embel wordmark and generated brand names are not protected from browser translation. Controls do not set `touch-action: manipulation`. A dead `.brief-composer` rule remains. The gallery overlay's image counter does not announce when the image changes.
- Why it matters: Each is small; together they are the difference between finished and nearly finished.
- Suggested direction: Fix each: curly apostrophes, `text-wrap: balance` on headings, `translate="no"` on names, `touch-action: manipulation` on controls, remove the dead rule, announce the counter.
- Where in the code: `.brief-composer` in `src/styles/globals.css` (lines removed in PR #258); image counter in `src/components/inspiration/inspiration-brands.tsx:283-313`.
- Status: **Done in part** (commit d7d5c929 on branch `ui/execution-fixes`): `touch-action: manipulation` on controls, `translate="no"` on brand names, the image counter announced; headings balance and `.brief-composer` was removed earlier. **Open:** straight apostrophes in about 40 strings, matched verbatim by tests and specs.
- Evidence: `screens/sign-in__error-wrong-password__1440.png`
- Systemic? Yes, in small ways.

**D-095. The 404 page is correct but generic, and the three crash screens do not match the app**
- Sources: E-016, IMG-009
- Screen/route, state and width: Any unknown URL; `error.tsx`, `global-error.tsx` and the project-level `error.tsx` (read in source only: they cannot be triggered without changing code).
- Category: copy (also imagery) · Severity: P3 · Tag: execution fix · Area: App-wide
- What's wrong: The 404 page says "Page not found. This link may be old, or the page may have moved." with one "Back to Home" button; signed in, the more likely need is Projects. The global crash screen uses inline styles, a system font and its own colours, and has no navigation. None of the four screens carries a brand element.
- Why it matters: Error pages are rare but are seen at the worst moment.
- Suggested direction: Offer "Go to Projects" as well when signed in. Style the crash screens with the page-error pattern (the same type and button as the 404). Put the existing mark at 32 px above the heading; no illustration and no "lost" joke art.
- Where in the code: `src/app/not-found.tsx`; `src/app/error.tsx`; `src/app/global-error.tsx`; `src/app/brands/account/[projectId]/error.tsx`.
- Fixed by: D-008 (Inline message and Toast; DS-012); D-085 (shared values for emails and exports; DS-024)
- Status: **Done** (commit a5c8a695 on branch `ui/execution-fixes`): the 404 and route error screens use the page-error layout; signed in, the 404 offers Go to Projects. Verified by a unit test (`not-found`).
- Evidence: `screens/not-found__default__1440.png`, `screens/not-found__default__390.png`
- Systemic? No.

**D-096. Signed-out versions of signed-in pages look like pages that failed to load**
- Sources: E-021, E-031
- Screen/route, state and width: `/brands`, `/assets` and `/settings` signed out; all widths.
- Category: layout (also flow) · Severity: P3 · Tag: execution fix · Area: App-wide
- What's wrong: On Projects and Library a heading and two small buttons sit in the top-left corner of an otherwise empty page, while the pill above repeats the same two buttons. On Settings the whole Profile and Preferences form is drawn disabled, with "Unavailable" in the name and email fields, and a "Sign in" card at the bottom.
- Why it matters: It looks like an error and shows controls nobody can use.
- Suggested direction: Send signed-out visitors to the sign-in overlay and return them to the page afterwards, or centre a single card in the Empty state style.
- Where in the code: `ProjectsWorkspace`, `AssetsWorkspace`, `SettingsWorkspace` in `src/components/workspace/settings-workspace.tsx`.
- Fixed by: D-038 (Empty state; DS-016)
- Status: **Done** by the Projects, Library and Settings rebuilds (signed-out Empty states and a sign-in invitation instead of disabled forms).
- Evidence: `screens/projects__signed-out__1440.png`, `screens/library__signed-out__1440.png`, `screens/settings__signed-out__1440.png`
- Systemic? Yes: Projects, Library, Settings, the Plans footer and the project page.

**D-097. Tabs, filters and sort are lost on reload**
- Sources: A-031
- Screen/route, state and width: Settings tabs, Library tabs, filters and search, Projects search and sort. Found in code.
- Category: navigation/IA (code) · Severity: P3 · Tag: execution fix · Area: App-wide
- What's wrong: These choices are held in memory only, so reload, Back and shared links reset them. Only `?state=deleted` is in the address.
- Why it matters: A person who reloads loses their place.
- Suggested direction: Mirror them in the address.
- Where in the code: `SettingsWorkspace` in `src/components/workspace/settings-workspace.tsx:20`; `AssetsWorkspace` in `src/components/assets/assets-workspace.tsx:65, 116`; `ProjectsWorkspace` in `src/components/workspace/projects-workspace.tsx:78-79`.
- Needs the owner: This adds address parameters, a small behaviour change. A comment in Settings suggests that always opening on Account is deliberate; confirm with the owner before changing that one.
- Status: **Needs the owner** (unchanged): address parameters, and whether Settings should open on the last tab.
- Evidence: `screens/settings__usage-pro__1440.png`
- Systemic? No.

## 8. Acceptance criteria

The redesign and the implementation must meet these. Each can be measured with the scripts in `design-audit/tools/`, with Lighthouse, or with a performance trace on the production build (`node design-audit/seed/serve.mjs --prod`).

### Accessibility (WCAG 2.2 AA)

| Criterion | Requirement | Today |
| --- | --- | --- |
| 1.4.3 Contrast (Minimum) | All text is 4.5:1 or better, including placeholders. Text the app sets on a generated brand colour picks dark or light by calculated contrast. | Placeholders 3.64:1 to 3.9:1; one brand preview 4.23:1 |
| 1.4.11 Non-text Contrast | Outlines of fields, drop-downs and checkboxes, icons that act as controls, and the mark of a selected state are 3:1 or better. | Field outlines 1.19:1 to 1.28:1; tile hearts 1.13:1 |
| 1.4.1 Use of Color | A selected state always has a cue that is not colour (a ring, a tick, a label). | Eight looks |
| 2.4.7 Focus Visible | A two-part focus ring that is 3:1 or better on any background, never clipped and never removed without the standard replacement. | 1.02:1 on dark tiles; clipped on gallery tiles; removed in 14 places |
| 2.4.11 Focus Not Obscured (Minimum) | A focused control is never fully covered by the floating bar, the reply box, an open menu or a sticky header. | Passes, with two risks |
| 2.4.3 Focus Order | Focus never lands on the page body after an action. Every dialog and menu returns focus to its opener. The reply box on a finished brand is a few stops from the content's start. | Lost after most actions; 141 stops |
| 4.1.2 Name, Role, Value and 1.3.1 Info and Relationships | Choices are real buttons or real radio inputs; no control is nested inside another; one top-level heading per page. | Direction cards and logo concepts are not real controls |
| 2.4.2 Page Titled | Brand pages are titled "[Brand name] · [Step] · Embel". | Always "Strategy · Embel" |
| 2.4.4 Link Purpose | Journey step links keep their names at every width. | ", complete" below 760 px |
| 4.1.3 Status Messages | Status messages are announced once; no page-wide live region. | The whole conversation is one live region |
| 1.4.10 Reflow and 1.4.4 Resize Text | No page scrolls sideways or clips content at 320 px or at 200% zoom. Fixed chrome takes at most a quarter of a 450 px tall window. | Plans clips prices; chrome takes 42% |
| 2.5.8 Target Size (Minimum) | Controls are 44 px (36 px allowed on pointer devices with a 44 px target); standalone links have at least a 24 px box. | Passes through the spacing exception; links 19.5 px tall |
| 2.5.7 Dragging Movements | Nothing requires dragging. | Passes; keep |
| 3.2.6 Consistent Help | Once Help exists, it sits in the same place on every page. | No help link exists |
| 3.3.1 Error Identification and 3.3.3 Error Suggestion | Errors appear by their field, name the problem and move focus to it; the app's own messages replace the browser's. | One message under the form; browser bubble on sign-up |
| 3.3.7 Redundant Entry and 3.3.8 Accessible Authentication | The typed brief survives sign-in; paste and password managers work. Check the sign-up check (Cloudflare Turnstile) once it is live. | Passes locally |
| Reduced motion | Under `prefers-reduced-motion`, movement is removed and feedback stays: waiting indicators still pulse. | All animation removed |
| Automated checks | Lighthouse accessibility 100 and best practices 100 on every route, desktop and mobile. No axe violation tagged WCAG A or AA. | 100 on 33 of 39 states; lowest 96 |

### Performance (production build)

| Measure | Target | Today |
| --- | --- | --- |
| Layout shift (CLS) | 0.1 or less on every route, on desktop and under phone conditions, including after a download or a choice | Conversation 0.18 and 0.75; Assets 0.55; Home 0 |
| Main content (LCP), signed-out Home | 2.5 s or less under phone conditions, and no worse than today once the example row is added | 2.4 s |
| Main content (LCP), signed-in pages | Pass 3 asked for "a stated target" without setting one. This brief proposes 4 s or less under phone conditions as a first target, for the owner to confirm. | 9.3 s on the conversation and on Assets |
| Responsiveness (INP) | 200 ms or less with the processor slowed 4 times | 42 to 140 ms; keep |
| Images | The image that can be the largest on the first screen is never lazy-loaded; every image has a width and a height; no image is more than twice its rendered width; each slot meets its weight budget in `04_image_needs.md` | Up to 27 times too large; 9 images without dimensions |
| Console | No errors logged on any route | Two per brand page |
| Frame rate | 60 frames per second during waiting states and scrolling; confirm on a mid-range phone before launch | 60 on desktop; no phone test |

### Interaction and motion

- Every action shows a visible change within 100 ms, on the control that was pressed.
- Anything a person triggers finishes in under 300 ms. Entrances animate; exits are instant.
- Only opacity and transform move. Colour, border and background may fade. Nothing animates size, position or blur.
- Nothing already on screen moves because something else loaded or a message appeared.
- Hover effects apply only where a pointer can hover, and nothing is reachable by hover alone.
- Motion never slows a main task: no animation on route changes, tabs, typing or keyboard actions.

## 9. Review checklist

One line per finding, for the final review. "Compare against" names the evidence to set beside the "after" capture: a screenshot where one exists, otherwise the report or script output to re-run. Screenshot paths are under `design-audit/evidence/`; the "after" set uses the same file names under `evidence/after/`.

| ID | Sev | Tag | What "fixed" looks like | Compare against |
| --- | --- | --- | --- | --- |
| D-001 | P0 | fix | A test account that has chosen a brand name can be deleted from the Settings dialog; a forced failure says what happens next. | `screens/settings__delete-account-dialog-free__1440.png` |
| D-002 | P1 | redesign | Every field, search box and drop-down outline measures 3:1 or better, and every placeholder 4.5:1 or better (re-run `tools/a11y-probe.mjs`). | `screens/sign-in__default__1440.png` |
| D-003 | P1 | fix | The log region wraps messages only (or is removed); a short VoiceOver run on a finished brand confirms that status messages are announced once. | `a11y/keyboard.json` |
| D-004 | P1 | fix | At 390 px and at 200% zoom each step link is announced with its name ("Strategy, complete"). | `a11y/reflow/brand-conversation__kestrel-complete-pro__zoom200.png` |
| D-005 | P1 | redesign | A Tab walk shows a ring of 3:1 or better on every stop, including dark gallery tiles, the Home prompt and the slogan field; only two offsets exist. | `annotated/A-kbd-tile-focused.png` |
| D-006 | P1 | redesign | Every button uses one component and shows hover, focus, pressed, disabled and loading states; the "Press changes" column of the motion probe is filled for every button. | `motion/probe-summary.md` |
| D-007 | P1 | redesign | Every choice in the six steps uses one selected look; logo and direction cards show a label and a visible Choose control; the larger view has Choose, next and previous; axe reports no "nested-interactive". | `screens/brand-conversation__quill-logos-generated-free__1440.png` |
| D-008 | P1 | redesign | Every error, warning, success and notice uses the one Inline message; copy, download and move confirmations use the Toast; no bare coloured text remains; recovery actions are buttons. | `screens/projects__error-api-500-free__1440.png` |
| D-009 | P1 | redesign | Skeleton, Media frame and the three waiting patterns exist in the system and are the only ones in use; brand pages have no text-only loading states; the rotating research mark is gone. | `annotated/M-006.png` |
| D-010 | P1 | fix | In `tools/a11y-keyboard.mjs`, focus is never on the page body after any of the listed actions; the sign-in overlay opens in Email. | `annotated/A-kbd-sign-in-error.png` |
| D-011 | P1 | fix | Opening a finished brand never shows an empty-project instruction; the recorder's list of live messages holds loading text and then the ready state only. | `annotated/M-014.png` |
| D-012 | P1 | fix | After More concepts, placeholders appear within 100 ms; after Stop or Cancel, the status text changes within 100 ms. | `annotated/M-016.png` |
| D-013 | P1 | redesign | At 1440 each logo concept is drawn at 320 px or more, and the text on a direction board can be read without opening the larger view. | `screens/brand-conversation__kestrel-complete-showcase-pro__1440.png` |
| D-014 | P1 | redesign | At 0 credits one message appears at the action, with one date that matches Plans; it is announced, reachable by keyboard and does not cover the reply box. | `screens/brand-conversation__out-of-credits-prompt-free__1440.png` |
| D-015 | P1 | redesign | The account menu shows the plan and the credits left; an AI button says so before the click when the balance is too low. | `screens/home__account-menu-open-pro__1440.png` |
| D-016 | P1 | redesign | A research failure appears in the conversation as a message card with one "Try again" button. | `screens/home__research-failed-pro__1440.png` |
| D-017 | P1 | redesign | Signed-out Home shows three real finished brands below the prompt and a "free to start" line; the first example image is not lazy-loaded. | `screens/home__signed-out__1440.png` |
| D-018 | P1 | redesign | Tokens exist in three layers for all eight foundations; stylesheets contain no hex value, pixel font size, pixel radius or shadow; no alias token remains (re-run `tools/ds-drift.mjs`). | `design-system/drift.md` |
| D-019 | P1 | fix | CLS is 0.1 or less on desktop and under phone conditions; the scroll position is set once; two loads in a row land in the same place; no "private" wording is shown. | `annotated/M-013.png` |
| D-020 | P1 | fix | No image is more than twice its rendered width; Library cards have distinct alt text; gallery images are cached between visits (re-run `scan-assets.mjs`). | `assets/assets.md` |
| D-021 | P1 | redesign | A finished brand opens with its finished steps folded; the person's own work is the first colourful thing on screen; the reply box is a few keyboard stops from the top of the content, not 141. | `screens/brand-conversation__kestrel-complete-showcase-pro__1440.png` |
| D-022 | P1 | redesign | Two brands with different directions get visibly different boards and social images; no decoration crosses text; "YOUR LOGO" and filler copy are gone; the two circles are gone. | `exports/rendered/kestrel__brand-board.png.png` |
| D-023 | P1 | redesign | The guide contains the logo and crops of the chosen board, is set in the brand's type and colours, and names the direction; the on-screen sections carry the same content. | `exports/rendered/kestrel__guides--brand-guide.html.png` |
| D-024 | P1 | redesign | A chosen direction board shows the chosen logo and slogan exactly, or is labelled as a mood reference. | `exports/rendered/kestrel__direction--selected-direction.png.png` |
| D-025 | P1 | fix | No brand name breaks inside a word at any width, including the 76-character name; the three cards are the same height. | `screens/brand-conversation__mosswood-directions-generated-free__1440.png` |
| D-026 | P1 | fix | "Check AI availability" is not shown unless AI is unavailable; the starter chips do not move when typing starts. | `screens/home__signed-out-prompt-filled__1440.png` |
| D-027 | P1 | fix | The three notices use the positive or warning message style; "send again" is a button. | `screens/sign-in__email-confirmed-notice__1440.png` |
| D-028 | P1 | fix | Terms and Privacy are linked at sign-up; Terms, Privacy and Help appear in the account menu and at the foot of Plans. | `screens/sign-up__default__1440.png` |
| D-029 | P1 | fix | CLS on Assets is 0.1 or less, including after "Download brand kit". | `screens/brand-assets__kestrel-preparing-pro__1440.png` |
| D-030 | P1 | fix | A failed or missing project shows one error card with two buttons; the pill shows the normal navigation; the words "verified", "checked" and "account project" are gone. | `screens/project-workspace__error-api-500-pro__1440.png` |
| D-031 | P1 | redesign | Each plan says what its credits make; one plan is recommended; a zero balance is stated in a sentence with the renewal date. | `screens/plans__free-0-credits-upgrade-free__1440.png` |
| D-032 | P1 | fix | The dialog names the brand, says it can be restored, and its button reads "Delete project". | `screens/projects__delete-dialog-free__1440.png` |
| D-033 | P1 | fix | At 320 and 390 px the plans stack, and every price, badge and button label is fully readable. | `screens/plans__pro-current-pro__390.png` |
| D-034 | P1 | fix | "View details" opens the detail view on the development server and on a production build, by mouse and by keyboard; the view uses the system Drawer. | `annotated/M-012.png` |
| D-035 | P1 | redesign | Library is grouped by brand; item names match the journey; chosen items are marked; there is no Refresh button. | `screens/library__all-generations-pro__1440.png` |
| D-036 | P1 | redesign | Usage lists credits by brand and step, including images, with a running balance; the word "tokens" is gone. | `screens/settings__usage-pro__1440.png` |
| D-037 | P2 | redesign | One disabled look exists; a busy control stays focusable and shows the loading state; each disabled control has a visible reason. | `screens/settings__account-pro__1440.png` |
| D-038 | P2 | redesign | Every empty page and section uses the one Empty state. | `screens/library__empty-fresh__1440.png` |
| D-039 | P2 | fix | `tools/ds-drift.mjs` reports no hand-written colour in the stylesheets; `#cbacc5` is gone. | `design-system/drift.md` |
| D-040 | P2 | fix | Both icons have a tooltip and a name; the text box shows the standard ring; the send button's disabled state matches its look. | `screens/home__signed-out-prompt-focus__1440.png` |
| D-041 | P2 | fix | The research card names its stage; the placeholder fits on one line at 390. | `screens/home__research-in-progress-pro__390.png` |
| D-042 | P2 | fix | Each brand tab names the brand and the step; Lighthouse accessibility is 100 on all brand states (no "heading-order" failure). | `lighthouse/summary.md` |
| D-043 | P2 | fix | One mark file of 2 KB or less, not lazy; icons exist at 32, 180, 192 and 512 px with a manifest. | `assets/assets.md` |
| D-044 | P2 | redesign | Ten type roles exist; stylesheets contain no hand-written font size; no interface text is under 12 px and labels are 14 px. | `screens/settings__account-pro__1440.png` |
| D-045 | P2 | redesign | Decisions 2, 4, 5 and 6 are recorded in the published system and applied on every screen; the canvas follows one rule on every page; arrows appear only on controls that navigate. | `screens/home__recent-brands-pro__1440.png` |
| D-046 | P2 | redesign | Every dialog uses one component (four widths, one backdrop, one close button) and has the entrance; every menu closes when focus leaves it and does not pass the first outside tap through. | `annotated/M-003.png` |
| D-047 | P2 | redesign | Every field has hover, focus, disabled and error styles from the system; no bare browser drop-down, resize handle or validation bubble is visible. | `screens/settings__account-pro__1440.png` |
| D-048 | P2 | redesign | Motion tokens exist and are the only timing values in use; under reduced motion, waiting indicators still pulse; hover timing is the same on every control. | `annotated/M-004.png` |
| D-049 | P2 | redesign | Every icon comes from one component and one family at one stroke weight; no icon is loaded as an image. | `screens/projects__three-brands-pro__1440.png` |
| D-050 | P2 | fix | All radii come from six tokens; the square generation of controls is gone. | `design-system/drift.md` |
| D-051 | P2 | fix | Four shadows, one backdrop and a named layer scale are the only values in use. | `design-system/drift.md` |
| D-052 | P2 | fix | Three breakpoints and two page widths are the only values in use. | `design-system/drift.md` |
| D-053 | P2 | fix | `tools/ds-components.mjs` reports no unreferenced selector; `!important` remains only where it is justified. | `design-system/components.md` |
| D-054 | P2 | redesign | At 390 px the bar is one row and names the current step; at 720 × 450 the bar and reply box take a quarter of the height or less; a finished brand shows four ticks. | `annotated/A-kbd-zoom200-conversation.png` |
| D-055 | P2 | fix | With a 3-second delay on the account check, the pill keeps its width and no signed-out text is shown to a signed-in person. | `annotated/M-008.png` |
| D-056 | P2 | fix | Each thing has one name on every screen; headings share one style. | `screens/projects__empty-fresh__1440.png` |
| D-057 | P2 | fix | No layout shift is recorded when a status message appears on the listed screens. | `annotated/M-007.png` |
| D-058 | P2 | fix | The selected look appears within 100 ms of the click on both steps. | `annotated/M-015.png` |
| D-059 | P2 | fix | `tools/ds-drift.mjs` reports all spacing through tokens. | `design-system/drift.md` |
| D-060 | P2 | redesign | An account with no brands does not see "Pick up where you left off". | `screens/home__empty-fresh__1440.png` |
| D-061 | P2 | redesign | Hearts are visible on a touch device and measure 3:1 or better on light and dark tiles. | `annotated/M-005.png` |
| D-062 | P2 | fix | Drawing, ready and failed tiles are the same size; each tile shows one message. | `screens/brand-conversation__logos-failed-brightharbor-pro__1440.png` |
| D-063 | P2 | fix | The exported logo is centred with even padding; the token file lists each colour once; the README is a short "What's in this kit". | `exports/rendered/kestrel__logo--logo-transparent.png.png` |
| D-064 | P2 | fix | The view names the brand correctly. | `annotated/E-054.png` |
| D-065 | P2 | fix | The larger view opens at its final size, with no layout shift. | `annotated/M-018.png` |
| D-066 | P2 | fix | Every date follows the account's format and time zone; the renewal date is the same on Plans and in the out-of-credits message. | `screens/plans__free-0-credits-upgrade-free__1440.png` |
| D-067 | P2 | fix | Each gallery brand shows its credit line in the large view; `docs/` says where the permission records are kept. | `annotated/E-054.png` |
| D-068 | P2 | redesign | No two cards share a title; the stage is visible without reading; long names take two lines; the label never contradicts the action. | `screens/projects__eight-brands-free__1440.png` |
| D-069 | P2 | redesign | One text input is visible on the Logo step, with one hint. | `screens/brand-conversation__tidewater-logos-partly-failed-free__1440.png` |
| D-070 | P2 | redesign | The first view of the Name step is a short list; a Details control is visible on each name. | `screens/brand-conversation__kestrel-change-name-open-pro__1440.png` |
| D-071 | P2 | redesign | A complete brand's Assets page has no "Continue"; the kit button is always visible; the social tiles align. | `screens/brand-assets__kestrel-ready-pro__1440.png` |
| D-072 | P2 | fix | Errors appear under their fields in the app's style; no browser bubble; the first password survives a mismatch; focus moves to the field to fix. | `screens/sign-up__validation-password-mismatch__1440.png` |
| D-073 | P2 | fix | Returning to a list shows its cards at once with no skeleton; clearing the search sends no request. | `annotated/M-009.png` |
| D-074 | P2 | redesign | Delete is reachable from a card without a control drawn over the picture. | `screens/projects__options-menu-open-free__1440.png` |
| D-075 | P2 | redesign | The share image shows a real brand board beside the mark. | `design-audit/04_image_needs.md` |
| D-076 | P2 | fix | Cancel is visually quieter than Manage plan; the payment failure uses the same notice component as the success. | `screens/plans__upgrade-unavailable-free__1440.png` |
| D-077 | P2 | fix | `/identity` redirects into the journey; the recover page uses the Empty state. | `screens/brand-identity__kestrel-pro__1440.png` |
| D-078 | P2 | fix | The checkout and portal pages show the Embel mark (checked by the owner in Stripe). | `design-audit/04_image_needs.md` |
| D-079 | P2 | fix | The listed folders and files are gone and the app still builds; nothing imports `inspiration-catalog.json`. | `assets/assets.md` |
| D-080 | P2 | redesign | The panel shows one row per action, with running and failed items first and the journey's names. | `screens/home__generation-activity-dialog-pro__1440.png` |
| D-081 | P2 | redesign | It is clear which fields are saved; a failed save offers one "Try again"; no control sits between cards. | `screens/settings__save-error-offline-free__1440.png` |
| D-082 | P3 | fix | Folded answers have no meta line; one verb and one Continue style are used throughout. | `screens/brand-conversation__northernlights-voice-done-long-name-free__1440.png` |
| D-083 | P3 | fix | One pulse per loading card; no animated shadow or blur; a phone recording of logo drawing and of a finished brand page shows no dropped frames. | `motion/walk-live.json` |
| D-084 | P3 | fix | Controls use two heights; every standalone link has at least a 24 px box; "Forgot password?" no longer overlaps the password field. | `design-system/drift.md` |
| D-085 | P3 | fix | Emails, export templates and the crash screen take their colours and type from the same source as the app; the published design system is the documentation. | `emails/confirmation__600.png` |
| D-086 | P3 | fix | Account cards are left-aligned with one button width; the overlay has no "Return to Home". | `screens/sign-in__default__1440.png` |
| D-087 | P3 | fix | Both emails show the mark, a plain link, the expiry time and a help address. | `emails/confirmation__600.png` |
| D-088 | P3 | fix | Lighthouse no longer reports "label-content-name-mismatch" on Home or Projects. | `lighthouse/projects__eight-brands-free__desktop/report.html` |
| D-089 | P3 | fix | A liked item is announced as "Like X, pressed". | `a11y/keyboard.json` |
| D-090 | P3 | fix | Text set on any brand colour in the preview measures 4.5:1 or better. | `screens/brand-assets__orchardlane-ready-free__1440.png` |
| D-091 | P3 | fix | Lighthouse best practices is 100 on brand pages; no icon circle is empty. | `lighthouse/brand-conversation__spokesmith-research-done-free__desktop/report.html` |
| D-092 | P3 | fix | No nested buttons, no duplicate ids, and the tokens list is a real table or list (axe reports none of the three). | `a11y/keyboard.json` |
| D-093 | P3 | fix | Every input has a name; no status text is stored as a field value; the Usage table has a caption. | `screens/settings__signed-out__1440.png` |
| D-094 | P3 | fix | No straight apostrophes in interface text; brand names carry `translate="no"`. | `screens/sign-in__error-wrong-password__1440.png` |
| D-095 | P3 | fix | The 404 offers Projects when signed in; the crash screens match the 404 and show the mark (checked in source, or with a deliberate failure on a throwaway branch). | `screens/not-found__default__1440.png` |
| D-096 | P3 | fix | A signed-out visitor to these pages sees the sign-in overlay or one centred card, never a disabled form. | `screens/settings__signed-out__1440.png` |
| D-097 | P3 | fix | Reloading keeps the chosen tab, filter and sort (except where the owner keeps the current behaviour). | `screens/settings__usage-pro__1440.png` |

## 10. Conflicts resolved, and the appendix

### Conflicts resolved

The rules, in order: (a) WCAG AA requirements and measured data win over taste; (b) a design-system-level fix wins over screen-level patches; (c) main-flow screens win over secondary screens; (d) motion must respect reduced motion and must not slow a main task; (e) where two passes disagree on taste, both options are recorded and Claude Design decides, and the owner's Direction and recorded decisions outrank any pass's taste. "Scope" marks a resolution that follows from the redesign's limit: it changes the look, not what the app does.

| # | Items | Disagreement | Decision | Rule |
| --- | --- | --- | --- | --- |
| 1 | E-050 (P0) and M-012 (P1) → D-034 | Pass 1 saw Library's "View details" do nothing and rated it P0. Pass 2 measured the dialog opening and closing in 10 ms and traced it to the development server. | P1, execution fix. The measured cause wins. A fix is merged on `main` (PR 255), unverified; the detail view's design is still unseen and must be reviewed. | a |
| 2 | M-013 (needs redesign) and A-024, E-052 (execution fix) → D-019, D-021 | One problem, opening a brand, tagged both ways. | Split. The design decision (what a reopened brand shows first, and folding) lives in D-021. Landing once and reserving space is execution in D-019, held to CLS 0.1. | a, b |
| 3 | E-025 (execution fix) and A-014 (needs redesign) → D-033, D-031 | Whether stacking the plan cards needs a design decision. | Stacking is an execution fix, because WCAG 1.4.10 requires it whatever the redesign decides. The look of the stacked cards is designed with the Plans redesign. | a |
| 4 | E-056 and pass 2's summary, with the keep list in pass 3b → D-048 | Pass 1: "almost nothing moves", with a card lifting on hover as an example. Pass 2: the lack of motion is close to right; hover lifts are rejected. | Motion scope is pass 2's five small additions; the token values are fixed. Hover on cards is taste: both options are recorded, and the Direction's "calm" leans to colour and border only. | d, e |
| 5 | M-002 (needs redesign) and DS-019 (execution fix) → D-048 | The same motion tokens, tagged both ways. | Needs redesign, so the tokens are built in Claude Design first; applying them afterwards is mechanical. | b |
| 6 | IMG-004 (needs redesign) and DS-017 (execution fix) → D-049 | Whether one icon family needs a decision. | Needs redesign, for one choice only: adopt Lucide or extend the hand-drawn set. | e |
| 7 | E-005, E-017 and pass 1b's "no image needed" note → D-068 | Pass 1: redesign the picture area of a card with no logo and keep the brief out of it. Pass 1b: the brief excerpt and a chip say more than placeholder art. | Both options recorded for Claude Design. Not taste, and fixed either way: the label never says "No logo yet" when concepts exist. | e |
| 8 | E-004 (execution fix) and IMG-008 (needs redesign) → D-060 | What fills a new account's Home: nothing or a preview of the steps, or the example-brand row. | Both options recorded; needs redesign. The untrue heading goes either way. | e |
| 9 | E-048 (execution fix) and IMG-027 (needs redesign) → D-063 | Pass 1: also export a 4,096 px logo. Pass 1b: a larger export is a product decision. | Trimming, centring, the token file and the README are execution fixes. A larger export is the owner's decision: it cannot be made honestly from a 1024 px image. | Scope |
| 10 | E-006 and the owner's rule on estimates → D-015 | Pass 1 suggests printing each step's credit price on its button. The owner's rule is remaining credits and no cost estimates. | The balance and a warning before the click are designed. Per-button credit prices are left out unless the owner asks. | e |
| 11 | E-055, IMG-006 and DS-020 → D-045 | Passes 1 and 1b allow the dot grid "everywhere or only where work happens". Pass 3b offers "only where work is made" or "removed", and excludes "everywhere". | Pass 3b's two options stand: it is the design-system-level decision, and the grid is already missing on Assets. | b |
| 12 | E-055 and the owner's November 6 decisions → D-045 | Pass 1 reads "pill shapes for everything" as generic. The owner confirmed a floating pill navigation and rounder corners. | The pill navigation stays in both options of decision 4; only whether buttons are pills is open. | e |
| 13 | E-033 and pass 3b's keep list → D-013 | Pass 1 asks for the Logo and Creative direction steps to use "1,056 px or more". Pass 3b keeps two page widths, 792 and 1,056. | Use the 1,056 px container. A wider one must be added to the system first, not made as a one-off. | b |
| 14 | E-010, E-036 and pass 2's rejections → D-041, D-062 | Pass 1 asks waits to say how long they take. Pass 2 rejects counters and percentages, because the work has no known length. | One fixed sentence about the usual duration is allowed. No counter, percentage or countdown. | d, e |
| 15 | E-030 and the owner's rule → D-081 | Pass 1 offers autosave or better-placed Save buttons. | Autosave is listed first, because the project's rule is that account edits save automatically and "Saved" shows only after confirmation. | e |
| 16 | E-018, E-029, E-038, E-046, E-053 and the redesign's limit → D-074, D-036, D-070, D-023, D-054 | Each direction includes new behaviour: rename and duplicate, a credit ledger, ranked names, PDF export, recent brands in the menu. | The visual part is in scope. The new behaviour is marked "Needs the owner" and is not built without a yes. | Scope |
| 17 | E-043 and what Claude Design can change → D-024 | Tagged needs redesign, but the fault is in how images are generated. | Kept as needs redesign, P1, and marked "Needs the owner". It is not Claude Design work, and it conflicts with the agreed behaviour that directions use the exact chosen logo. | Scope |
| 18 | Severities inside merged findings | Sources of one finding carried different severities (for example A-005 at P2 with DS-014 at P1; A-026 at P2 with IMG-012 at P1). | The merged finding takes the highest source severity. A WCAG AA failure on a main flow is at least P1. | a, c |
| 19 | The two verdicts: pass 1 "refresh", pass 3b "rebuild" | They could look contradictory. | Reported separately and left to differ. They answer different questions and fit together: the pages keep their shape, and the system that draws them is rebuilt. | Stated in the brief |
| 20 | The owner's decision of 2026-11-12 and every "keep the look" statement | Passes 1b, 2 and 3b, and rows 4, 11, 12 and 13 above, treat parts of the current look as fixed or limit the options: the palette, the pill navigation, the rounder corners, restrained motion, two page widths, no illustration. | The owner opened the look. Those statements describe what works today and do not bind Claude Design. Still in force: the accessibility and performance criteria in section 8, the fixed product structure, credits never money, and no magenta. | e |

### Appendix A: each D- finding and its sources

| ID | Severity | Tag | Section | Finding | Sources |
| --- | --- | --- | --- | --- | --- |
| D-001 | P0 | execution fix | 7 | Deleting an account fails for anyone who has chosen a brand name | E-028 |
| D-002 | P1 | needs redesign | 5 (Part A) | Field outlines and placeholder text fail contrast | DS-002, A-001, A-002 |
| D-003 | P1 | execution fix | 7 | The whole conversation is one live region | A-008 |
| D-004 | P1 | execution fix | 7 | Below 760 px, and at 200% zoom, the journey steps lose their names | A-016 |
| D-005 | P1 | needs redesign | 5 (Part A) | The focus ring is not a system: it vanishes on dark artwork, is clipped on gallery tiles and is removed in 14 places | DS-014, A-004, A-005, A-012 |
| D-006 | P1 | needs redesign | 5 (Part A) | Buttons exist in four implementations and none has a pressed state | DS-010, M-001 |
| D-007 | P1 | needs redesign | 5 (Part A) | "Selected" has eight looks, and logo and direction cards show no way to choose or compare | DS-011, E-051, A-006, A-007 |
| D-008 | P1 | needs redesign | 5 (Part A) | Messages have about twenty implementations in seven looks, and there is no toast | DS-012, E-022 |
| D-009 | P1 | needs redesign | 5 (Part A) | There is no shared way to wait, or to hold space while something loads | DS-015, M-006 |
| D-010 | P1 | execution fix | 7 | Keyboard focus is dropped after actions, errors and some dialogs | A-003, M-011 |
| D-011 | P1 | execution fix | 7 | While saved work loads, the Logo and Creative direction steps show instructions for an empty project | M-014 |
| D-012 | P1 | execution fix | 7 | Starting, stopping and cancelling AI work are acknowledged late | M-016 |
| D-013 | P1 | needs redesign | 6 (Part B) | The work Embel makes is shown at thumbnail size | E-033, IMG-018, IMG-021 |
| D-014 | P1 | needs redesign | 6 (Part B) | Running out of credits produces three messages at once, one of them covering the send button | E-037, A-017 |
| D-015 | P1 | needs redesign | 6 (Part B) | Remaining credits are not visible anywhere outside Settings and Plans | E-006 |
| D-016 | P1 | needs redesign | 6 (Part B) | A failed research run leaves an empty page with the error docked to the reply box | E-009 |
| D-017 | P1 | needs redesign | 6 (Part B) | Signed-out Home, the only landing page, shows no proof of what Embel makes | E-001, IMG-007 |
| D-018 | P1 | needs redesign | 5 (Part A) | The system has one flat layer of tokens, and five of eight foundations have none | DS-001, DS-004 |
| D-019 | P1 | execution fix | 7 | Opening a brand jumps several times and lands in a different place each time | M-013, A-024, E-052 |
| D-020 | P1 | execution fix | 7 | Images are downloaded at full size, one by one, and cannot be cached | IMG-012, IMG-017, IMG-020, A-026 |
| D-021 | P1 | needs redesign | 6 (Part B) | A finished brand is one page about 5,400 px tall and 141 keyboard stops long, because Inspiration never folds away | E-032, A-010 |
| D-022 | P1 | needs redesign | 6 (Part B) | The final brand images are one fixed template with two circles, for every brand | E-042, E-047, IMG-022, IMG-023, IMG-024, IMG-025 |
| D-023 | P1 | needs redesign | 6 (Part B) | The brand guidelines are too thin on screen, and an unstyled web page as a file | E-044, E-046, IMG-026 |
| D-024 | P1 | needs redesign | 6 (Part B) | The chosen direction board shows a different logo from the one the person chose | E-043 |
| D-025 | P1 | execution fix | 7 | Direction cards break the brand name in the middle of a word | E-034 |
| D-026 | P1 | execution fix | 7 | A diagnostic link and a stray note appear under the Home prompt once you type | E-002 |
| D-027 | P1 | execution fix | 7 | Success and failure notices on the account screens look like ordinary helper text | E-012 |
| D-028 | P1 | execution fix | 7 | There is no Terms, Privacy, Help or contact link anywhere | E-011 |
| D-029 | P1 | execution fix | 7 | The Assets page shifts by more than half a screen when the files are ready, and again after a download | M-019, A-025 |
| D-030 | P1 | execution fix | 7 | When a project cannot load, the page falls back to raw, unstyled messages | E-040 |
| D-031 | P1 | needs redesign | 6 (Part B) | Plans sells a number, not an outcome | E-026 |
| D-032 | P1 | execution fix | 7 | The delete dialog explains the system instead of the consequence | E-019 |
| D-033 | P1 | execution fix | 7 | Plans keeps three columns at every width, so prices are clipped on a phone and at high zoom | E-025, A-014 |
| D-034 | P1 | execution fix | 7 | Library's "View details" opened nothing, so its detail view has never been reviewed | E-050, M-012 |
| D-035 | P1 | needs redesign | 6 (Part B) | Library uses several names for one thing, and "All generations" is one long ungrouped wall | E-023, E-024 |
| D-036 | P1 | needs redesign | 6 (Part B) | Usage counts "tokens", leaves out images, and never mentions credits | E-029 |
| D-037 | P2 | needs redesign | 5 (Part A) | "Disabled" has two looks and is also used to mean "busy" | DS-022 |
| D-038 | P2 | needs redesign | 5 (Part A) | Empty states come in three styles and 24 classes | DS-016, IMG-010 |
| D-039 | P2 | execution fix | 7 | Ninety colours are written by hand, including 30 stray greys, five reds and one leftover magenta | DS-003 |
| D-040 | P2 | execution fix | 7 | The prompt's "+" and microphone say nothing about what they do, and the disabled send button is faint | E-003 |
| D-041 | P2 | execution fix | 7 | Research in progress gives no sense of what is happening, and the 390 px reply box clips its placeholder | E-010 |
| D-042 | P2 | execution fix | 7 | Brand pages have no usable browser-tab title or main heading | A-009 |
| D-043 | P2 | execution fix | 7 | The Embel mark is served as a bloated, lazy-loaded file in three copies, and the icon set is incomplete | IMG-001, IMG-002 |
| D-044 | P2 | needs redesign | 5 (Part A) | The type scale exists but is not used, and most text is 13 px | DS-005 |
| D-045 | P2 | needs redesign | 5 (Part A) | The look is restrained but generic: one card for everything, pills everywhere, a stock typeface at 13 px, and a dot grid | DS-020, E-055, IMG-006 |
| D-046 | P2 | needs redesign | 5 (Part A) | Ten dialogs and at least six menus are each built by hand, and all appear in a single frame | DS-013, M-003, A-011, A-032, M-010 |
| D-047 | P2 | needs redesign | 5 (Part A) | Form controls have no hover or error style of their own, and browser defaults show through | DS-021 |
| D-048 | P2 | needs redesign | 5 (Part A) | Motion has no tokens, hover is timed four ways, and reduced motion removes every sign of life | DS-019, M-002, M-004, M-017, E-056 |
| D-049 | P2 | needs redesign | 5 (Part A) | Icons are drawn three ways with five stroke weights | DS-017, IMG-004 |
| D-050 | P2 | execution fix | 7 | Half of all corner radii bypass the tokens, and two generations of shape coexist | DS-007 |
| D-051 | P2 | execution fix | 7 | Thirty-four shadows, seven backdrops and twelve layer values | DS-008 |
| D-052 | P2 | execution fix | 7 | Twenty-one breakpoints and eight page widths | DS-009 |
| D-053 | P2 | execution fix | 7 | About one style selector in eight is dead, and stylesheet names record history, not structure | DS-018 |
| D-054 | P2 | needs redesign | 6 (Part B) | Inside a project the pill loses the app's navigation, and at narrow widths it takes too much of the screen | E-053, A-015 |
| D-055 | P2 | execution fix | 7 | Signed-in pages first show their signed-out version, and the pill changes width after each load | E-008, M-008 |
| D-056 | P2 | execution fix | 7 | The same thing has up to four names, and headings change between states | E-020 |
| D-057 | P2 | execution fix | 7 | Messages are inserted into the page and push everything below them | M-007 |
| D-058 | P2 | execution fix | 7 | Choosing a logo or a direction is confirmed about a second after the click | M-015 |
| D-059 | P2 | execution fix | 7 | Spacing has no scale: 53 values, every odd number included | DS-006 |
| D-060 | P2 | needs redesign | 6 (Part B) | A new account is told to "Pick up where you left off" | E-004, IMG-008 |
| D-061 | P2 | needs redesign | 6 (Part B) | The hearts on inspiration tiles are hidden until hover, never appear on touch, and are faint on light images | M-005, A-020 |
| D-062 | P2 | execution fix | 7 | Waiting and failed logo cards say little, say it twice, and change size | E-036, IMG-019 |
| D-063 | P2 | execution fix | 7 | Logo files have the mark off-centre, the token file repeats its colours, and the kit's README reads defensively | E-048, A-034, IMG-027 |
| D-064 | P2 | execution fix | 7 | The inspiration brand view calls a named brand "Untitled brand" | E-054 |
| D-065 | P2 | execution fix | 7 | The larger view of a direction board opens small and jumps to full size | M-018 |
| D-066 | P2 | execution fix | 7 | Dates ignore the account's date preference, and two screens show different renewal dates | A-028 |
| D-067 | P2 | execution fix | 7 | The inspiration gallery's 56 brand boards carry no credit line in the app's data | IMG-014, IMG-015 |
| D-068 | P2 | needs redesign | 6 (Part B) | Project cards under-report progress and cannot be told apart | E-005, E-017, IMG-011 |
| D-069 | P2 | needs redesign | 6 (Part B) | The Logo step has two text boxes and says the same hint three times | E-035 |
| D-070 | P2 | needs redesign | 6 (Part B) | The Name step shows 100 names in one wall | E-038 |
| D-071 | P2 | needs redesign | 6 (Part B) | The Assets page keeps the conversation's stepping after everything is done, and scatters downloads | E-045 |
| D-072 | P2 | execution fix | 7 | Sign-in and sign-up errors are not tied to their fields, and sign-up validation is the browser's own tooltip | E-013, E-014, A-013 |
| D-073 | P2 | execution fix | 7 | Lists reload from a skeleton on every visit, then fill in three steps | M-009 |
| D-074 | P2 | needs redesign | 6 (Part B) | The "…" menu on a card holds one item, Delete, and sits on the picture | E-018 |
| D-075 | P2 | needs redesign | 6 (Part B) | The share image shows nothing Embel makes | IMG-003 |
| D-076 | P2 | execution fix | 7 | Plan actions and messages are uneven | E-027 |
| D-077 | P2 | execution fix | 7 | Two older screens are still reachable and do not match the app | E-041, A-022 |
| D-078 | P2 | execution fix | 7 | Stripe's checkout and customer portal may not carry Embel's mark | IMG-029 |
| D-079 | P2 | execution fix | 7 | Unused image files remain in the app, including other companies' logos | IMG-005, IMG-016 |
| D-080 | P2 | needs redesign | 6 (Part B) | "Generation activity" lists raw requests, six rows for one click | E-007 |
| D-081 | P2 | needs redesign | 6 (Part B) | Save controls float between cards, and a failed save leaves a dead end | E-030 |
| D-082 | P3 | execution fix | 7 | Small inconsistencies in the conversation's own grammar | E-039 |
| D-083 | P3 | execution fix | 7 | Nothing drops frames today; four details would if motion is added carelessly | M-020 |
| D-084 | P3 | execution fix | 7 | Control heights and text-link targets vary from about 20 to 48 px | DS-023, A-021 |
| D-085 | P3 | execution fix | 7 | Emails, exported files and crash screens sit outside the system, and nothing documents it | DS-024 |
| D-086 | P3 | execution fix | 7 | The account cards mix alignments and button widths | E-015 |
| D-087 | P3 | execution fix | 7 | The two emails are clean and on-brand, with small gaps | E-049, IMG-028 |
| D-088 | P3 | execution fix | 7 | Project cards announce a different name from the one shown | A-018 |
| D-089 | P3 | execution fix | 7 | Like and Favourite buttons state their condition twice | A-019 |
| D-090 | P3 | execution fix | 7 | A generated brand's own preview can fail contrast | A-023 |
| D-091 | P3 | execution fix | 7 | Every brand page logs two errors for missing competitor icons, and some icon circles stay empty | A-027, IMG-013 |
| D-092 | P3 | execution fix | 7 | Invalid or duplicated markup in three places | A-029 |
| D-093 | P3 | execution fix | 7 | Form details: unnamed inputs, status written into fields, a table with no caption | A-030 |
| D-094 | P3 | execution fix | 7 | Small polish items in text and markup | A-033 |
| D-095 | P3 | execution fix | 7 | The 404 page is correct but generic, and the three crash screens do not match the app | E-016, IMG-009 |
| D-096 | P3 | execution fix | 7 | Signed-out versions of signed-in pages look like pages that failed to load | E-021, E-031 |
| D-097 | P3 | execution fix | 7 | Tabs, filters and sort are lost on reload | A-031 |

### Appendix B: each source ID and where it went

Every source ID appears exactly once (163 in all).

- **Pass 1, experience (E-):** E-001 → D-017 · E-002 → D-026 · E-003 → D-040 · E-004 → D-060 · E-005 → D-068 · E-006 → D-015 · E-007 → D-080 · E-008 → D-055 · E-009 → D-016 · E-010 → D-041 · E-011 → D-028 · E-012 → D-027 · E-013 → D-072 · E-014 → D-072 · E-015 → D-086 · E-016 → D-095 · E-017 → D-068 · E-018 → D-074 · E-019 → D-032 · E-020 → D-056 · E-021 → D-096 · E-022 → D-008 · E-023 → D-035 · E-024 → D-035 · E-025 → D-033 · E-026 → D-031 · E-027 → D-076 · E-028 → D-001 · E-029 → D-036 · E-030 → D-081 · E-031 → D-096 · E-032 → D-021 · E-033 → D-013 · E-034 → D-025 · E-035 → D-069 · E-036 → D-062 · E-037 → D-014 · E-038 → D-070 · E-039 → D-082 · E-040 → D-030 · E-041 → D-077 · E-042 → D-022 · E-043 → D-024 · E-044 → D-023 · E-045 → D-071 · E-046 → D-023 · E-047 → D-022 · E-048 → D-063 · E-049 → D-087 · E-050 → D-034 · E-051 → D-007 · E-052 → D-019 · E-053 → D-054 · E-054 → D-064 · E-055 → D-045 · E-056 → D-048
- **Pass 2, motion (M-):** M-001 → D-006 · M-002 → D-048 · M-003 → D-046 · M-004 → D-048 · M-005 → D-061 · M-006 → D-009 · M-007 → D-057 · M-008 → D-055 · M-009 → D-073 · M-010 → D-046 · M-011 → D-010 · M-012 → D-034 · M-013 → D-019 · M-014 → D-011 · M-015 → D-058 · M-016 → D-012 · M-017 → D-048 · M-018 → D-065 · M-019 → D-029 · M-020 → D-083
- **Pass 3, accessibility and technical (A-):** A-001 → D-002 · A-002 → D-002 · A-003 → D-010 · A-004 → D-005 · A-005 → D-005 · A-006 → D-007 · A-007 → D-007 · A-008 → D-003 · A-009 → D-042 · A-010 → D-021 · A-011 → D-046 · A-012 → D-005 · A-013 → D-072 · A-014 → D-033 · A-015 → D-054 · A-016 → D-004 · A-017 → D-014 · A-018 → D-088 · A-019 → D-089 · A-020 → D-061 · A-021 → D-084 · A-022 → D-077 · A-023 → D-090 · A-024 → D-019 · A-025 → D-029 · A-026 → D-020 · A-027 → D-091 · A-028 → D-066 · A-029 → D-092 · A-030 → D-093 · A-031 → D-097 · A-032 → D-046 · A-033 → D-094 · A-034 → D-063
- **Pass 3b, design system (DS-):** DS-001 → D-018 · DS-002 → D-002 · DS-003 → D-039 · DS-004 → D-018 · DS-005 → D-044 · DS-006 → D-059 · DS-007 → D-050 · DS-008 → D-051 · DS-009 → D-052 · DS-010 → D-006 · DS-011 → D-007 · DS-012 → D-008 · DS-013 → D-046 · DS-014 → D-005 · DS-015 → D-009 · DS-016 → D-038 · DS-017 → D-049 · DS-018 → D-053 · DS-019 → D-048 · DS-020 → D-045 · DS-021 → D-047 · DS-022 → D-037 · DS-023 → D-084 · DS-024 → D-085
- **Pass 1b, imagery (IMG-):** IMG-001 → D-043 · IMG-002 → D-043 · IMG-003 → D-075 · IMG-004 → D-049 · IMG-005 → D-079 · IMG-006 → D-045 · IMG-007 → D-017 · IMG-008 → D-060 · IMG-009 → D-095 · IMG-010 → D-038 · IMG-011 → D-068 · IMG-012 → D-020 · IMG-013 → D-091 · IMG-014 → D-067 · IMG-015 → D-067 · IMG-016 → D-079 · IMG-017 → D-020 · IMG-018 → D-013 · IMG-019 → D-062 · IMG-020 → D-020 · IMG-021 → D-013 · IMG-022 → D-022 · IMG-023 → D-022 · IMG-024 → D-022 · IMG-025 → D-022 · IMG-026 → D-023 · IMG-027 → D-063 · IMG-028 → D-087 · IMG-029 → D-078

## Recap

**Counts by tag and severity.**

| Severity | Needs redesign | Execution fix | Total |
| --- | --- | --- | --- |
| P0 | 0 | 1 | 1 |
| P1 | 19 | 16 | 35 |
| P2 | 19 | 26 | 45 |
| P3 | 0 | 16 | 16 |
| **Total** | **38** | **59** | **97** |

Where they are: 15 design-system items needing a decision in Part A (section 5), plus 8 design-system execution fixes (six built to specification in Claude Design, two code-only); 23 screen and export items in Part B (section 6); 59 execution fixes in section 7. The 163 source findings (56 experience, 20 motion, 34 accessibility and technical, 24 design system, 29 image slots) are all mapped in Appendix B.

**Left unresolved.**

1. **Two fixes to verify.** PR 254 (account deletion, D-001) and PR 255 (Library detail view, D-034) were merged to `main` on 2026-11-12, after the passes ran. D-001 was verified on November 14, 2026 (see its entry); D-034 is still unverified. The Library detail view has still never been seen open, so its design is unreviewed.
2. **Taste decisions for Claude Design and the owner.** The look as a whole is open, by the owner's decision of 2026-11-12. The named choices are: the seven design-system decisions and three colour values in section 3; the icon family (D-049); how results arrive and how cards respond to hover (D-048); what a new account's Home shows (D-060); the picture area of a card with no logo (D-068).
3. **Findings that need the owner (18).** Each touches behaviour, data, legal text, a setting only the owner controls, or a real AI generation:

- **D-015** (Remaining credits are not visible anywhere outside Settings and Plans): Pass 1 also suggested printing each step's credit price on its button ("Explore six concepts · 6 credits"). The owner's standing rule is that the app shows remaining credits and no cost estimates. A fixed credit price is not a money estimate, but adding it is the owner's product call, so it is left out unless the owner asks for it.
- **D-017** (Signed-out Home, the only landing page, shows no proof of what Embel makes): Two showcase brands exist (Kestrel Analytics and Orchard Lane Cider). A third, or a fresh set of three made for public display, is a real AI generation: 9 images per brand, very roughly $0.35 per brand by the audit's own spend record (an estimate, not a confirmed charge). It needs the owner's approval. The Kestrel board shows a face and an invented name and phone number, so it should not be used publicly as it is.
- **D-020** (Images are downloaded at full size, one by one, and cannot be cached): Previews made on the server change how images are served, which is a behaviour change outside "change the look, not what the app does". It needs the owner's go-ahead before implementation.
- **D-023** (The brand guidelines are too thin on screen, and an unstyled web page as a file): Exporting the guidelines as a PDF (pass 1's suggestion) is a new export format: a behaviour change and possibly a new dependency. It needs the owner's go-ahead. A designed HTML file is within the redesign.
- **D-024** (The chosen direction board shows a different logo from the one the person chose): This is how the generation engine makes images, not interface design. Claude Design cannot fix it, and a look-only implementation must not change it. The owner decides how to do it (for example, placing the saved logo file onto the generated board); checking it needs a real generation, which needs approval.
- **D-028** (There is no Terms, Privacy, Help or contact link anywhere): The Terms, Privacy and Help documents are not in this repository. The owner supplies them, or their addresses, before the links can be added.
- **D-036** (Usage counts "tokens", leaves out images, and never mentions credits): A credit ledger shows records the page does not load today (image requests, grants, refunds). That is a behaviour and data change. Claude Design can design it; implementation needs the owner's go-ahead.
- **D-054** (Inside a project the pill loses the app's navigation, and at narrow widths it takes too much of the screen): Listing recent brands in the brand menu (pass 1) is a small new feature. Include it only if the owner wants it.
- **D-056** (The same thing has up to four names, and headings change between states): Pass 1 suggests "Brands" as the noun; the navigation says "Projects" today. Renaming a navigation item is the owner's call. Until the owner decides, keep "Projects" for the list and call the thing being made a "brand", consistently.
- **D-063** (Logo files have the mark off-centre, the token file repeats its colours, and the kit's README reads defensively): A larger logo export (pass 1 suggests 4,096 px; pass 1b calls it a product decision) cannot be made honestly from a 1024 px image. It would need the logo to be generated at a larger size, which is the owner's product decision and outside this redesign.
- **D-067** (The inspiration gallery's 56 brand boards carry no credit line in the app's data): The credit wording comes from the permission records, which only the owner holds.
- **D-070** (The Name step shows 100 names in one wall): Pass 1 also suggests ranking the "strongest" names with a reason for each and grouping the rest by kind. That may need information the naming step does not produce today; if so it is a behaviour change for the owner to approve. The layout change above is within the redesign.
- **D-074** (The "…" menu on a card holds one item, Delete, and sits on the picture): Pass 1's other option is to add Rename and Duplicate to the menu. Those are new features; they are not designed or built unless the owner asks.
- **D-076** (Plan actions and messages are uneven): Pass 1 also proposes rewriting the footer ("Payments are processed by Stripe through Link…") in two short sentences and adding "Downgrade to Free" on the Free card. The footer is billing and legal text, which the implementation rules leave to the owner, and a downgrade button is a new action. Neither is done without the owner's say.
- **D-077** (Two older screens are still reachable and do not match the app): Retiring a route is a route change, which the implementation rules leave to the owner. It fits the code cleanup planned before implementation.
- **D-078** (Stripe's checkout and customer portal may not carry Embel's mark): This is a setting in the owner's Stripe Dashboard, not code. Only the owner can do it and check it.
- **D-091** (Every brand page logs two errors for missing competitor icons, and some icon circles stay empty): Changing what the route answers is a small API change, which the implementation rules leave to the owner.
- **D-097** (Tabs, filters and sort are lost on reload): This adds address parameters, a small behaviour change. A comment in Settings suggests that always opening on Account is deliberate; confirm with the owner before changing that one.

4. **One proposed target to confirm.** LCP of 4 s or less on signed-in pages under phone conditions (section 8). Pass 3 asked for a target and did not set one; today's value is 9.3 s.
5. **Not reviewed by any pass.** The three crash screens (read in source only); Stripe's checkout and customer portal; the Library detail view; names, slogans and directions while in progress; "step unavailable"; "today's limit"; a failed reference upload; the name preview dialog and "Compare concept"; sign-up's "check your email" state; the sign-out confirmation; the account data export; the sign-up check (Cloudflare Turnstile); the accessibility of the two emails and of the exported guidelines file.
6. **Not tested.** No real screen reader was run, so the announcement findings (D-010, D-003, D-014, D-089) are reasoned from the markup. No real phone was used: every measurement is from a desktop browser, including the 390 px runs. Width 768 was reviewed from still images and not walked live. All numbers are lab measurements on one machine; the app has no customers yet, so there is no field data.
7. **Development-server caveats.** Passes 1 and 2 timed the development server, which is slower than production. The layout-shift numbers in this brief are from the production build. The timings of late acknowledgement (D-012, D-058) should be re-read on a production build during review.
8. **The owner's optional Direction line on products whose look they admire** was left blank at setup. Adding it before Prompt 5 would sharpen Claude Design's recommendations on the seven decisions. (The owner chose on 2026-11-12 not to list things that must stay.)
9. **Line numbers will go stale.** They are as of 2026-11-11 and 11-12. The code cleanup before implementation will move them; Prompt 7b refreshes them using the component and function names recorded beside each reference.
