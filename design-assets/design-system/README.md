Embel turns a product idea into a usable brand: a name, a logo, a creative direction and a kit to download. Its audience is founders, small businesses, and freelancers or agencies making brands for clients; most are not designers. The interface is minimal and premium: calm, precise, with generous white space, and quiet enough that the brand a person makes is the most colourful thing on screen. Light mode only.

Build every screen from the tokens and components here. If a screen needs something that is missing, add it to the system; never make a one-off.

## Voice and content

- Talk about the person's situation, never about the system. Write "Your changes weren't saved", not "The request could not be verified".
- One name per thing: project, brand kit, credits, Strategy, Voice, Identity, Assets.
- Sentence case everywhere. Page titles carry no full stop: "Projects", "Settings".
- Buttons are verbs that say what happens: "Save changes", "Delete project", "Choose". The control that confirms repeats the verb.
- An error says what happened and what to do next, with the fix as a real button: "Two of the six concepts couldn't be drawn. The other four are ready." then "Retry 2 failed concepts".
- Credits, never money, for Embel's own work: no cost estimates for AI work, no percentages, no invented progress. Money appears in two places only: the plan prices on Plans, and registrar prices for domains in a name's details (owner decision, November 13): the registrar's own price in USD, per year, with the renewal price beside it.
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
- Embel has no accent hue. `color-accent` is ink: the primary button, the current destination in the navigation pill, a checked box. Selection is always carried by shape as well as colour: on every choice card (text options, generated results, names) a 2 px ring alone, with no tick or radio circle (owner decision, November 13). The current journey step is shown by its mark (an ink ring with a dot) and ink text, never a fill.
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
- Two containers: `container-reading` 792 px for the one-column project conversation, `container-page` 1056 px for everything else.
- At wide width (1024 px and up) the project conversation is the Workspace: the chat in a floating panel on the left, the step's work on the right, filling the window. The chat talks; the right shows what the person judges or chooses. Below 1024 px it is one column in `container-reading`, where result grids may break out to the page width.
- Card grids run 1, 2 and 3 across. Forms put the label above the field; buttons go full width at compact.
- The navigation pill and the project bar float 16 px from the top. Below 1024 px the four journey steps collapse into one menu button.
- In the project conversation, Send in the reply box is the one way forward: chosen options sit in it as chips, Send starts the work or moves to the next step, and Stop takes its place while Embel works, at every width. There are no separate Continue or Explore buttons.
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
