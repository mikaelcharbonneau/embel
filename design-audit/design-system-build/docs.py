import json, os, datetime
HERE=os.path.dirname(os.path.abspath(__file__))+'/'
S=HERE+'out/'; P=S+'project/'
README='''Embel turns a product idea into a usable brand: a name, a logo, a creative direction and a kit to download. Its audience is founders, small businesses, and freelancers or agencies making brands for clients; most are not designers. The interface is minimal and premium: calm, precise, with generous white space, and quiet enough that the brand a person makes is the most colourful thing on screen. Light mode only.

Build every screen from the tokens and components here. If a screen needs something that is missing, add it to the system; never make a one-off.

## Voice and content

- Talk about the person's situation, never about the system. Write "Your changes weren't saved", not "The request could not be verified".
- One name per thing: project, brand kit, credits, Strategy, Voice, Identity, Assets.
- Sentence case everywhere. Page titles carry no full stop: "Projects", "Settings".
- Buttons are verbs that say what happens: "Save changes", "Delete project", "Choose". The control that confirms repeats the verb.
- An error says what happened and what to do next, with the fix as a real button: "Two of the six concepts couldn't be drawn. The other four are ready." then "Retry 2 failed concepts".
- Credits, never money. The plan prices on Plans are the only money shown. No cost estimates, no percentages, no invented progress.
- No emoji. Mark generated brand names and the Embel wordmark as not to be translated.
- Never claim what is not true: "Saved" only after the server confirms.

## Token architecture

Three layers; each refers only to the layer above it.

1. **Primitive**: raw values with neutral names (`neutral-200`, `red-700`, `space-4`, `font-size-3`). Never used in a stylesheet.
2. **Semantic**: roles that point at primitives (`color-bg-canvas`, `color-text-muted`, `color-border-control`, `space-card`, `radius-control`, `shadow-overlay`, `duration-fast`). Components are written against this layer; a future accent or dark theme re-points it.
3. **Component**: values that belong to one component (`button-height`, `dialog-width-sm`, `focus-ring-width`).

Rules: a stylesheet contains no hex value, no pixel font size, no pixel radius and no shadow. Tokens live in one place; no scope redefines one. One name per value-with-a-role, no aliases. A new token needs a second use. Emails, exported files and the crash screen cannot read CSS variables: they take the primitive values from `tokens.json`, written out.

## Colour

- Page background is `color-bg-canvas`. Cards, fields, menus and dialogs are `color-bg-paper`. Recessed areas are `color-bg-sunken`.
- Text is `color-text`. Secondary text is `color-text-muted`; grey is not a hierarchy tool on its own, so errors, recovery actions and current status stay in `color-text`.
- Embel has no accent hue. `color-accent` is ink: the primary button, the current navigation item, a checked box, the tick badge. Selection is always carried by shape as well: a 2 px ring and a tick.
- `color-border` is a decorative hairline for cards and dividers. Anything a person types into or ticks is outlined with `color-border-control`. Never swap them.
- Green, red and amber are for status only, never decoration, and always come with an icon or a word. There is no blue: neutral messages use the neutral ramp.
- A generated brand's colours appear only inside bounded previews (Media frame, Colour swatch), never as interface chrome. No magenta anywhere.
- Every pair is listed with its calculated ratio in the Contrast section.

## Type

- Geist Sans for all interface text. Instrument Sans only for `text-display` (the Home headline), `text-title-xl` (a brand's name on Assets) and `text-title-lg` (page titles); never below 24 px.
- Pick one role and nothing else; each role fixes size, line height, weight and letter-spacing: `text-title-md` for section and dialog headings, `text-title-sm` for card titles, `text-body` (16/24) for reading and field values, `text-label` (14/20, medium) for buttons, navigation, labels and tabs, `text-small` (13/20) for hints and meta, `text-caption` (12/16) for timestamps and counters, `text-code` for exported values.
- Three weights: 400 reading, 500 labels and headings, 600 the Embel wordmark and emphasised numbers.
- Nothing under 12 px. A status, an instruction or an error is at least `text-small`.
- Numbers that line up (credits, prices, tables, dates) use tabular figures. Running text is capped at `measure`. Headings wrap in balance.

## Space, shape and depth

- Spacing is a 4 px scale, `space-0-5` to `space-24`. Gaps round down, padding rounds up. Four roles carry density: `space-card` 24, `space-stack` 20 (between fields), `space-section` 48 (64 at wide width), `space-gutter` 16 / 24 / 32.
- Controls are 44 px tall (`button-height`); 36 px (`button-height-sm`) in dense rows on pointer devices, with a 44 px target.
- Radius: `radius-control` 12 for buttons and fields, `radius-card` 16 for cards and menus, `radius-panel` 20 for dialogs and the composer, `radius-small` 8, `radius-inset` 4. `radius-pill` is for the navigation, chips, badges, avatars and round icon buttons only; buttons are never pills.
- Cards are for objects: a project, an asset, a plan, a choice. Page sections sit directly on the canvas under a heading, separated by `space-section`.
- Cards have no shadow; hover is a stronger hairline, not a lift. `shadow-raised` is for what floats permanently (navigation, docked composer, toast), `shadow-overlay` for menus and popovers, `shadow-modal` for dialogs. One scrim, `color-bg-scrim`, no blur.
- The dot grid (`e-canvas--dots`) is used on Home and the project conversation only. Every other page is plain canvas.

## Layout

- Breakpoints are constants: compact below 640 px, medium 640 to 1023 px, wide 1024 px and up.
- Two containers: `container-reading` 792 px for the project conversation, `container-page` 1056 px for everything else. Result grids (logo concepts, direction boards) may break out to the page width so the work is large enough to judge.
- Card grids run 1, 2 and 3 across. Forms put the label above the field; buttons go full width at compact.
- The navigation pill and the project bar float 16 px from the top. Below 1024 px the four journey steps collapse into one menu button.
- No page scrolls sideways at 320 px or at 200% zoom.

## Motion

- `duration-fast` 120 ms for hover and colour, `duration-press` 160 ms for press, `duration-base` 200 ms for dialogs and content entering, `duration-slow` 300 ms for sheets and finished results. Default easing `ease-out`.
- Only opacity and transform move. Entrances animate, exits are instant, and nothing already on screen moves because something else loaded.
- Pressed controls scale to `press-scale`. Every action shows a change within 100 ms on the control that was pressed.
- Reduced motion removes movement and keeps feedback: fades stay, the skeleton keeps its pulse, the spinner pulses, the progress bar is a static filled track.

## States and focus

- Every control defines default, hover, focus-visible, active and disabled; controls that wait add loading, inputs add error, choices add selected.
- Hover exists only where a pointer can hover. Nothing is reachable by hover alone.
- Focus is one two-part ring: 2 px ink with a 2 px paper halo, outside free-standing controls and inside controls that fill a clipped box. No component removes it.
- Disabled is `color-text-disabled` on `color-bg-disabled`, with the reason in text beside the control. Busy is not disabled: a loading button keeps its label, shows a spinner and keeps focus.

## Iconography

- One family, Lucide, on a 24 px grid at a 1.5 stroke, at 16, 20 and 24 px. Icons take the text colour.
- An arrow appears only on a control that goes to another page. Icon-only controls always have an accessible name and a tooltip.
- No emoji, no image-file icons, no second stroke weight. The Embel mark is a single-ink shape in `color-text`.

## Using the files

- `tokens.json` is the source of every value. `components/bundle.css` holds the components as classes prefixed `e-`, written only against tokens, plus the type roles as variables (`--text-label`) and the icon masks. `components/bundle.js` adds optional behaviour (`window.Embel`): toast, tab keys, menu dismissal, dialog open and close.
- Each component folder has its guidelines and a live preview showing every variant and state. Forced states in previews use `data-force`; never ship that attribute.
- The ten "Validation screens" rebuild five real screens at 1440 and 390 using only this system.
'''
CHANGELOG='''# Change log

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

## Not covered

- Table, Toast, Range slider, Tooltip and Drawer are not in the five screens; each is shown in full on its own component page. The optional sixth screen (Assets) was not built.
- Copy on the validation screens is the app's own, apart from titles losing their full stop and errors gaining a recovery button. Rewriting copy is screen work.
- The Inspiration gallery on the Tidewater screen is shown folded, as the long-lists pattern specifies; the gallery's own tiles were not rebuilt.
- Dark mode is not specified. The semantic layer is where one would be added.
'''
os.makedirs(P+'assets/Logos',exist_ok=True); os.makedirs(P+'assets/Showcase',exist_ok=True)
open(P+'README.md','w').write(README)
open(P+'changelog.md','w').write(CHANGELOG)
open(P+'assets/Logos/README.md','w').write('The Embel pixel-ring mark, copied from `public/embel-mark.svg` with its embedded metadata removed. A single-ink shape: set it in `color-text` (#191919), at 24 px or larger. In components it is drawn as a mask (`e-mark`) so it takes the text colour.\n')
open(P+'assets/Showcase/README.md','w').write('Real generated images from the audit\'s two showcase test brands, Kestrel Analytics and Orchard Lane Cider. They are test data, used in previews and validation screens to judge the interface against real artwork. They are not part of Embel\'s own identity.\n')
COVER='''<!-- @dsCard height=288 -->
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Embel</title>
<style>
  html, body { margin:0; height:100%; }
  body { background:var(--color-bg-canvas); color:var(--color-text); font-family:var(--font-sans); overflow:hidden; }
  .cover { position:relative; width:960px; height:288px; overflow:hidden; }
  .art { position:absolute; top:0; left:480px; width:480px; height:288px; overflow:hidden; }
  .art svg { display:block; width:480px; height:288px; }
  .ink { fill:var(--color-text); }
  .soft { fill:var(--color-accent-hover); }
  .line { fill:var(--color-border-strong); }
  .tint { fill:var(--color-bg-sunken); }
  .tile { rx:var(--radius-inset); }
  .dot { fill:var(--pattern-dot-color); }
  .words { position:absolute; left:var(--space-6); bottom:var(--space-6); max-width:440px; }
  .name { margin:0; font-family:var(--font-display); font-size:112px; line-height:.9; font-weight:500; letter-spacing:-0.03em; color:var(--color-text); }
  .tag { margin:var(--space-3) 0 0 var(--space-1); font-size:14px; line-height:20px; color:var(--color-text-muted); }
</style>
</head>
<body>
<div class="cover">
<div class="art" aria-hidden="true">
<svg viewBox="0 0 480 288" width="480" height="288">
<!--
  blocks      eight 72px tiles (space-6 x 3): five in color-text (ink, the identity), one color-accent-hover, one color-border-strong, one color-bg-sunken; about a quarter of the cover
  arrangement the ring of the Embel pixel mark at large scale, centred in the box, bleeding off the top and bottom edges
  pattern     a dot grid at one pattern-dot-size step (24px), 8 x 6 dots in pattern-dot-color: "precise, a grid" is the row, and the dot grid is the canvas where work is made
  scales      tile 72 = space-6 x 3; pitch 24 = space-6 / pattern-dot-size; rx radius-inset
-->
<g>
  <rect class="tile tint" x="24" y="108" width="72" height="72"/>
  <g class="dot"><circle cx="36" cy="36" r="1.5"/><circle cx="60" cy="36" r="1.5"/><circle cx="84" cy="36" r="1.5"/><circle cx="108" cy="36" r="1.5"/><circle cx="36" cy="60" r="1.5"/><circle cx="60" cy="60" r="1.5"/><circle cx="84" cy="60" r="1.5"/><circle cx="108" cy="60" r="1.5"/><circle cx="36" cy="84" r="1.5"/><circle cx="60" cy="84" r="1.5"/><circle cx="84" cy="84" r="1.5"/><circle cx="108" cy="84" r="1.5"/><circle cx="36" cy="204" r="1.5"/><circle cx="60" cy="204" r="1.5"/><circle cx="84" cy="204" r="1.5"/><circle cx="108" cy="204" r="1.5"/><circle cx="36" cy="228" r="1.5"/><circle cx="60" cy="228" r="1.5"/><circle cx="84" cy="228" r="1.5"/><circle cx="108" cy="228" r="1.5"/><circle cx="36" cy="252" r="1.5"/><circle cx="60" cy="252" r="1.5"/><circle cx="84" cy="252" r="1.5"/><circle cx="108" cy="252" r="1.5"/></g>
  <rect class="tile ink" x="264" y="-36" width="72" height="72"/>
  <rect class="tile ink" x="156" y="0" width="72" height="72"/>
  <rect class="tile soft" x="372" y="0" width="72" height="72"/>
  <rect class="tile ink" x="120" y="108" width="72" height="72"/>
  <rect class="tile ink" x="408" y="108" width="72" height="72"/>
  <rect class="tile line" x="156" y="216" width="72" height="72"/>
  <rect class="tile ink" x="372" y="216" width="72" height="72"/>
  <rect class="tile ink" x="264" y="252" width="72" height="72"/>
</g>
</svg>
</div>
<div class="words">
  <p class="name" translate="no">Embel</p>
  <p class="tag">A quiet interface, so the brand you make is the loudest thing on screen.</p>
</div>
</div>
</body>
</html>
'''
os.makedirs(P+'components/Cover',exist_ok=True)
open(P+'components/Cover/preview.html','w').write(COVER)
A=json.load(open(HERE+'assets.json'))
groups={'Logos':{'name':'Logos','tile':'m','order':[],'files':{}},'Showcase':{'name':'Showcase','tile':'m','order':[],'files':{}}}
for k,(g,f,bid,size,typ) in A.items():
    groups[g]['files'][f]={'name':f,'blob':bid,'size':size,'type':typ}; groups[g]['order'].append(f)
now=datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
CREATED='2026-11-12T16:16:10Z'  # when the published system was first written; the index must keep this value
idx={"v":3,"layout":"files","createdOnFiles":{"v":1,"at":CREATED},"title":"Embel Design System","namespace":"Embel","libraries":[],"sections":{},"groups":["Logos","Showcase"],"assetGroups":groups,"blobs":{},"docs":{"readme":"project/README.md","sections":[]},
     "lastChange":{"by":"Claude","at":now,"via":"Claude Code","note":"Built from 05_design_system.md with the owner's eleven decisions; five validation screens at 1440 and 390."}}
json.dump(idx,open(P+'design-system.json','w'),indent=1)
print('docs ok')
