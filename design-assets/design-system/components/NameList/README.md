# Name list

The names Embel suggests on the Name step, shown so that many can be compared at once. You provide the names, which one is chosen and which are saved.

- **Name grid** (`e-name-grid`): compact cards about 224 px wide (`space-16` × 3.5), as many across as fit with an 8 px gap: four in the Workspace at 1440 px. The first batch fills the work area (40 names at 1440 × 900); "Show 40 more names" sits in the action row with "Suggest more names", "Add your own name" and the count ("40 of 100 names").
- **Name card** (`e-name-card`): one row, at least 52 px tall. The name (`e-name-card__name`, `text-label`, wraps when long), then two quiet small Icon buttons: Details (`info`, tooltip "Details") and Save (`heart`, `aria-pressed`).
- The whole name is the choice: a radio inside a `role="radiogroup"`, visually hidden (owner decision, November 13). The chosen name shows only the 2 px ink ring; no radio circle, no tick, no extra line. The reply box carries it as a chip ("Name: Kestrel Analytics").
- Focus: the card shows the focus ring when its radio or a button inside it has focus.
- Loading: the same card shape with one skeleton line (`e-name-card--skeleton`), as many as the batch.
- Saved with none: the empty message and "Show all 100 names" replace the grid.
- Details open the name details in the work-area overlay (see Dialog).
