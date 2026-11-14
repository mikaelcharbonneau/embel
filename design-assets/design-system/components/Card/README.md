# Card

A bounded object on the page. You provide the content; for an interactive card, the one destination it links to.

- A card is for a thing: a project, an asset, a plan, a choice. Page sections (Settings groups, form sections) are **not** cards; they sit on the canvas under a heading.
- **Static**: a bounded group of content. No states.
- **Interactive**: the whole card is one link (a project). Hover is a stronger hairline, never a lift; pressed scales to 0.97; focus draws the two-part ring around the card. Other controls on it (the options button) sit above the link.
- **Media**: an image in a Media frame with a caption and actions.
- **Summary**: a few labelled numbers (plan and credits), with tabular figures.
- Paper on canvas with a `color-border` hairline, `radius-card`, no shadow. Padding `space-card`.
- Loading is a skeleton in the card's exact shape, so nothing moves when content arrives.
- A long name truncates on one line and shows in full in a tooltip. Dates show a formatted date in a tooltip, never a raw timestamp.
- **Project card** (added November 12 for D-068 and D-074): the name may take two lines (`e-card__title--two-line`); the options button sits in the text row (`e-card__action`), never on the picture; when a brand has concepts but no chosen logo the picture area shows a strip of them (`e-card__media--strip`); progress is a Journey mark with its sentence.
