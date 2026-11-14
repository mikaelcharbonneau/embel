# Change log

What this system changes from the audited app, mapped to the findings in `05_design_system.md` (DS-001 to DS-024).

## Decisions taken (owner, November 12, 2026)

| # | Decision | Chosen |
| --- | --- | --- |
| 1 | Accent colour | Ink only |
| 2 | Typeface for headings | Geist Sans plus Instrument Sans for `text-display`, `text-title-xl`, `text-title-lg` |
| 3 | Density | Hybrid: body 16, controls 44, card padding 24, sections 48 (64 at wide width) |
| 4 | Control shape | Buttons at 12 px; pills for navigation, chips and badges only |
| 5 | When content is a card | Cards for objects only; page sections sit on the canvas |
| 6 | Dot-grid canvas | Dots where work is made: Home and the project conversation |
| 7 | Selected state | A 2 px ink ring with a filled tick in a fixed corner |
| 8 | Placeholder text | `#696965` |
| 9 | Control outline | `#8a8985` |
| 10 | Disabled text | `#85847f` on the grey disabled fill |
| 11 | Icon family | Lucide at a 1.5 stroke |

## Changes by finding

| ID | Finding | What the system does |
| --- | --- | --- |
| DS-001 | One flat layer of tokens; five foundations with none | Three layers (primitive, semantic, component) across 13 token families and 160 tokens: colour, type, spacing, radius, shadow, layering, layout, component sizes, duration, easing, movement, and the primitive type steps and weights. |
| DS-002 | Field outlines and placeholders fail contrast | New role `color-border-control` `#8a8985`: 3.50:1 on paper, 3.26:1 on canvas, 3.07:1 on sunken. `color-text-placeholder` `#696965`: 5.51, 5.13, 4.84. `color-border` is kept for decorative hairlines only. |
| DS-003 | Ninety hand-written colours | One danger set, one warning set, one positive set. Every hover grey is `color-border-strong`; every scrim is `color-bg-scrim`. No magenta. Components contain no hex value. |
| DS-004 | One colour with three names; confusable radius tokens | One name per role: `color-text`, `color-accent`, `color-border-selected` and `focus-ring-color` are separate roles on one primitive. Six radius names, no aliases, no second token set, no scoped redefinition. |
| DS-005 | The type scale is unused; most text is 13 px | Ten roles plus `text-code`. Labels 14 px, body 16 px, nothing under 12 px. Three weights. Instrument Sans for the three display roles. |
| DS-006 | 53 spacing values | A 13-step scale on a 4 px base and four roles (`space-card`, `space-stack`, `space-section`, `space-gutter`). |
| DS-007 | Half of all radii bypass tokens; two generations of shape | Six steps. Buttons and fields share `radius-control`; pills are for navigation, chips, badges, avatars and round icon buttons. The square icon button and badges are gone. |
| DS-008 | 34 shadows, seven backdrops, twelve layer values | Four shadow levels, one scrim without blur, seven named layers. Cards have no shadow. |
| DS-009 | 21 breakpoints and eight page widths | Three named ranges, two containers (792 and 1056 px), a 4 / 8 / 12 column grid, documented behaviour at 390, 768 and 1440. |
| DS-010 | Four button implementations, no pressed state | One Button: five variants, two sizes, six states including pressed (0.97 over 160 ms) and a loading state that keeps the label and focus. Width and arrow rules written down. |
| DS-011 | "Selected" has eight looks; no visible choose control | One Choice card with one selected treatment (ring and tick in a fixed corner), a label on every card and a real Choose button on image choices. |
| DS-012 | About twenty message styles; no toast | One Inline message in four tones and three forms, and one Toast with an optional Undo. |
| DS-013 | Ten dialogs and six menus built by hand | One Dialog in four widths with fixed parts, one Drawer, one Menu and Popover. Bottom sheet at compact width. Opening transitions defined; closing is instant. |
| DS-014 | The focus ring is not a system | One two-part ring as tokens, two offsets, an inset form for clipped boxes and a flipped form for ink surfaces. No component removes it. |
| DS-015 | No shared way to hold space while loading | Skeleton, Media frame (four ratios; loading, loaded, failed and private states) and exactly three waiting patterns: skeleton, button spinner, progress bar with Stop. |
| DS-016 | Empty states in three styles | One Empty state in three forms: page, section, no results. One icon in a 56 px circle; never a dashed box. |
| DS-017 | Icons drawn three ways | One family (Lucide, 1.5 stroke) through one component at 16, 20 and 24 px, taking the text colour. |
| DS-018 | One selector in eight is dead; names record history | Nothing to design. The system names classes by component (`e-button`, `e-dialog`), which is the structure to migrate to after the dead selectors are deleted. |
| DS-019 | No motion tokens; reduced motion removes feedback | Duration, easing and movement tokens from pass 2, unchanged. Reduced motion removes movement and keeps fades, the skeleton pulse, a pulsing spinner and a static progress track. |
| DS-020 | Restrained but generic in four ways | Decisions 2, 4, 5 and 6 above: a display face in three places, buttons that are not pills, cards only for objects, dots only where work is made. Arrows only on controls that navigate. |
| DS-021 | Form controls show browser defaults | Text field, Textarea, Composer, Select, Checkbox, Radio, Switch and Range slider with hover, focus, disabled, read-only and error states, and the form-validation pattern. |
| DS-022 | "Disabled" has two looks and also means "busy" | One disabled look (`color-text-disabled` on `color-bg-disabled`, 3.29:1). Loading is a separate state (`aria-busy`) that keeps focus. A disabled control has its reason in text beside it. |
| DS-023 | Control heights from 28 to 48 px | `target-min` 44 px; two control heights (44 and 36 with a 44 px hit area); `link-target-min` 24 px for standalone links. |
| DS-024 | Emails, exports and crash screens sit outside the system; no documentation | This published system is the documentation. `tokens.json` lists every primitive as a plain value, to be written out into the emails, the export templates and the crash screen. |

## Where the build departs from the spec's wording

- **Grey ramp order.** The spec named the disabled grey `neutral-400` and the outline grey `neutral-500`. With the values chosen, the outline (`#8a8985`) is the lighter of the two, so it is `neutral-400` and the disabled grey (`#85847f`) is `neutral-500`. Primitives stay in lightness order.
- **`amber-600` is left out.** No component outlines a control in amber, and the spec's own rule is that a token needs a second use.
- **Spacing has 13 steps.** The spec says 14 and lists 13; the 13 listed are built.
- **`text-display` in the type list shows 44 px.** The live role is fluid, `clamp(32px, 4vw, 44px)`, set in `bundle.css`.
- **The selected segment is an ink fill**, not a grey fill, so the selected state holds well over 3:1.

## Added to the system while rebuilding the validation screens

Each was needed by a screen and added to the system rather than made as a one-off.

| Addition | Needed by | What it is |
| --- | --- | --- |
| `color-bg-danger`, `color-bg-danger-hover`, primitive `red-800` | Projects: delete dialog | Fill and hover of the danger-filled button. White on them: 7.13:1 and 9.00:1. |
| `color-bg-skeleton` | Projects: loading | A skeleton fill that is visible on paper, canvas and sunken. |
| `color-border-positive-soft`, primitive `green-200` | Inline message | The decorative edge of a positive message, matching danger and warning. |
| Focus ring on ink surfaces (`e-on-inverse`) | Settings: saved toast | A paper ring with an ink halo, for the toast's buttons. |
| Form actions row (`e-form-actions`) | Settings | Actions right-aligned with the reason for a disabled button beside them; full width and stacked at compact. |
| Setting row (`e-setting-row`) | Settings | A label and hint on the left, one control on the right; stacks at compact. |
| Summary stat (`e-stat`) | Settings: plan and credits | A labelled number in tabular figures, inside a summary Card. |
| Steps menu button (`e-steps-compact`) | Both conversation screens at 390 | Below 1024 px the four journey steps collapse into one button that opens a Menu, so step names stay reachable. |
| Breakout (`e-breakout`), large choice grid | Tidewater and Kestrel | Lets a result grid use the page width inside the reading column, so logos and boards are large enough to judge; boards go one across at compact. |
| Turn continuation (`e-turn__continue`) | Tidewater and Kestrel | Aligns cards that follow a broken-out grid with the message text. |
| Card corner and anchor (`e-card__corner`, `e-anchor`) | Projects: card menu | Places an Icon button on a card above its link, and anchors a Menu to its trigger. |
| Thumbnail Media frame (`e-media--thumb`) | Kestrel: "Your logo" | A 44 px frame for the chosen logo beside its label. |
| Primary Icon button | Both conversation screens | The round ink send button of the composer. |
| Docked composer (`e-composer-dock`) | Both conversation screens | Keeps the reply box at the bottom of the conversation. |
| `text-code` and the mono family | Code block | For exported token values. |

## Added for the Part B screens (November 12, 2026)

Six small additions, made while redesigning the screens. Each uses existing tokens only.

| Addition | Where | Why |
| --- | --- | --- |
| Media frame ratios 4:3, 3:1 and 4:1 | `e-media--4x3`, `e-media--3x1`, `e-media--4x1` | The example brands on Home (IMG-007) and the two banner files (IMG-025). |
| Project card parts | `e-card__title--two-line`, `e-card__action`, `e-card__media--strip` | D-068 and D-074: two-line names, the options button off the picture, a strip of concepts when no logo is chosen. |
| Journey mark | `e-journey`, `e-journey__step` | D-068: the four steps of a brand at card size. |
| Menu summary block | `e-menu__summary` | D-015: the plan and the balance at the top of the account menu. |
| Section bar | `e-section-bar` | D-071: the anchors of the Assets page and the brand kit button, in view where there is room. |
| Short-window rule | `e-composer-dock` under 600 px tall | D-054: fixed chrome is at most a quarter of a 450 px window. |
| Results grid and Compare | `e-grid-results`, `e-compare` | D-013: concepts and boards never under 320 px; the chosen one large with the alternatives beside it. |
| Workspace (a variation) | `e-workspace`, `e-workspace__chat`, `e-workspace__log`, `e-workspace__thread`, `e-workspace__reply`, `e-workspace__main` | A variation of the project conversation at wide width: a side chat on the left, the step's work on the right. Chosen rules: status and errors live in the chat with their button; finished steps are folded entries in the chat. November 13: the chat runs the full window height from the top, and `e-nav-wrap--workspace` centres the project bar over the work column. Later the same day: a chat header with Hide chat (`e-workspace__head`), a resize handle (`e-workspace__resize`) with the new token `workspace-chat-width` (400 px, draggable from 320 to 560), the hidden state (`e-workspace--chat-hidden`) with a Show chat pill (`e-workspace__show`), and two Lucide icons, `panel-left-close` and `panel-left-open`. Then: the layout fills the window (no maximum width); the chat sits 16 px from the left, top and bottom edges at any window size, and the work area scrolls on its own with its content centred at page width. Later: Stop moved from the progress bar into the reply box, replacing Send while Embel works; `e-workspace__main--rows-1` and `--rows-2` fit three boards or six concepts in the window; a chosen result keeps its size. |
| Artwork-only choice (November 13) | `e-choice__hit` | Logo concept tiles drop their label row and Choose button: the whole picture chooses it, Enlarge stays in the corner; owner decision overriding "never commit from a click on the picture" for this case. Concept tiles are now plain squares, so six fit larger. |
| Send moves to the next step (November 13) | `e-workspace__main--rows-2` | Logo and Creative direction steps: no Continue button anywhere (the direction step continues to Assets the same way). Once a concept is chosen it sits in the reply box as a Chip and Send continues to Creative direction; the concepts grow to fill the work area. |
| Media inset (November 13) | `e-media--inset` | The artwork sits smaller inside the same frame (12% paper on each side); used for logo concept tiles. |
| Drawing state for media (November 13) | `e-media--drawing`, `e-media__status`, `e-media--reveal` | Logo concepts being drawn show a dotted frame and a sweeping halftone screen with a mono status line; the finished picture comes in from a blur. Owner request, after transitions.dev's UI generation transition. |
| Name list (November 13) | `e-name-grid`, `e-name-card`, `e-name-card__name` | Compact one-line name cards (the name, Details and Save icon buttons; no visible radio, the border marks the chosen name), about 224 px wide, so 20 or more names show at once in the work area. |
| Project bar steps (November 13) | `e-step` | The current step has no fill: its mark (an ink ring with a dot) and ink text show it; the other steps read in muted text. Owner request. |
| Name details dialog (November 13) | `e-dialog--xl`, `e-tabs`, `e-table--stack`, `e-chip[aria-pressed]` | Name details grow to the extra-large dialog with the features of the retired Domains, Handles and Trademarks tools that are still backed: several extensions checked at once, a handle grid with prefixes, suffixes and a separator (YouTube checked, other platforms opened), and the EU register search with links to the US, Canadian and WIPO searches. Fix: dialog body rows no longer collapse when the body scrolls (`grid-auto-rows: max-content`). |
| Work-area overlay (November 13) | `e-workspace__overlay` | Dialogs about the work open over the work area only; the side chat stays visible and usable. |
| Guidance brought up to date (November 13) | README, Navigation, Choice card, Grid, Dialog, Workspace, new Name list | Guidance now matches the November 13 decisions: the side chat is the desktop conversation; Send is the one way forward; no tick on generated results; the current step has no fill; the chosen result keeps its size; the work-area overlay is not modal; name details documented. Domain prices are an exception to "credits, never money" (owner decision). Previews added for artwork-only tiles, the Drawing frame, the name list, reply box states and the work-area overlay. |
| Choices in the reply box (November 13) | `e-chip--static` inside `e-composer` | Options chosen before work starts (logo types) appear as Chips in the reply box and Send starts the work; the separate start button is gone. Send is `aria-disabled` with the reason when there are no credits. |

## Not covered

- Table, Toast, Range slider, Tooltip and Drawer are not in the five screens; each is shown in full on its own component page. The optional sixth screen (Assets) was not built.
- Copy on the validation screens is the app's own, apart from titles losing their full stop and errors gaining a recovery button. Rewriting copy is screen work.
- The Inspiration gallery on the Tidewater screen is shown folded, as the long-lists pattern specifies; the gallery's own tiles were not rebuilt.
- Dark mode is not specified. The semantic layer is where one would be added.
| Drawing effect, fuller (November 13) | `e-media__handles`, `e-media__label`, `e-media__status`, `e-media--revealing`, `e-media__canvas` | Owner approved the fuller transitions.dev effect: corner handles and two mono labels on the drawing frame, and a scripted reveal from the picture's own pixels (sketch, grey screen, colour, picture). |
| Stop at every width (November 13) | `e-composer` | Stop replaces Send in the reply box in the one-column conversation too; the progress row no longer carries a Stop button. |
| Resizing the chat (November 13) | `e-workspace__main--rows-1`, `--rows-2` | Owner chose option 2: results shrink as the chat widens, chat range 320 to 560 px. |
| No tick on text choice cards (November 13) | `e-choice`, `e-choice__mark` | Owner decision: text option cards (Audience, Positioning, Personality, Slogan, competitors) show the 2 px ring alone, like results and names. The mark only holds the saving spinner; the corner padding it reserved is gone. |
| Code box width fix (November 13) | `e-code` | A code box inside a grid or flex column keeps the column's width; long lines scroll inside it. Fixes the Assets › Design system tab at 390 px, which was 603 px wide. |
