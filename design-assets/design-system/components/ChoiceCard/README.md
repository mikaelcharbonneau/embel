# Choice card

A selectable card: the one look for "this is my choice" across the whole journey. You provide the options, whether one or several may be chosen, and for image choices the artwork and a label such as "Concept 2".

- **Single** (radio) and **multiple** (checkbox): a real input inside a named group; the whole card is the label, and the input is visually hidden. No mark or tick on the card (owner decision, November 13); the group's question says whether to choose one or several ("Choose one", "Choose any that apply").
- **Image choice** (direction board, inspiration tile): the artwork in a Media frame at 1:1 or 4:5, a visible label (for a direction board: its number, name, palette and typography), and a real **Choose** button (`aria-pressed`). Enlarge is a secondary Icon button on a paper chip.
- Selected: a 2 px ring in `color-border-selected`. Nothing else marks it: no tick, on text cards as on image choices (November 13). The button reads "Chosen". No soft fill, so artwork keeps its own background. A chosen result keeps its size and place; it is never enlarged.
- Loading (saving the choice): a spinner appears in the top-right corner and the card is `aria-busy`. Error: `color-border-danger` and a field-level message.
- Never commit a choice from a click on the picture. Never show a card without its label. Exception below.
- **Artwork only** (owner decision, November 13, logo concepts in the side chat): no label row and no Choose button. The whole picture is a button (`e-choice__hit`, `aria-pressed`, named "Concept 2") that chooses it; Enlarge stays in the corner above it. Choosing is not final: Send in the reply box commits it, and another concept can be chosen any time. The chosen tile shows the 2 px ring only, no tick. The logo sits inset in its tile (`e-media--inset`, 12% of paper on each side) so the tile keeps its size while the logo reads a little smaller. A tile still being drawn or that failed has no button.
- **Name cards** are a separate, compact pattern: see Name list.
