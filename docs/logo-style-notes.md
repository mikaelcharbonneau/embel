# Logo style notes from liked logos

November 9, 2026.

The image model never sees the logos people like in Inspiration. Until November 8
a like reached the logo prompt as one line naming a famous logo, which the model
already knew. The November 8 brand library replaced those with lesser-known
brands described in long paragraphs about colors, photos and billboards, and
likes stopped visibly shaping concepts. A side-by-side test on the same brief
compared that text, the October line and short style notes; the notes brought
the liked styles back without naming a brand.

## How it works

- `src/domain/logo-style-notes.ts` holds the note instruction (version
  `logo-style-note-v1`). A note has two parts: `symbol` (how the symbol is
  built: geometry, modules, weight, corners, spacing, detail) and `lettering`
  (typeface category, weight, width, case, spacing). Either can be empty.
- `src/domain/inspiration-logo-styles.json` holds one note per Inspiration
  brand, written once from the brand's logo image by `gpt-6.1-sol`. Each note
  records the logo image's SHA-256; a test fails if an image changes without a
  new note.
- When saved logo inputs are prepared, a liked brand (whole brand or its logo)
  adds `Liked logo style:` and `Liked lettering:` lines to the brief, and a liked
  typeface adds its description as `Liked lettering:`. At most four liked logos
  or typefaces are used, in like order. Brand descriptions stay in the brief
  because Creative direction reads it for colors and imagery.
- The concept prompt keeps only the notes from that block
  (`logoPromptPersonality`). Lettering reaches only types that draw text
  (wordmark, lettermark, combination, emblem). Pictorial, abstract and mascot
  concepts are told to draw the symbol alone, with no letters or brand name.
- Briefs without notes (older briefs, or likes without a logo or typeface) are
  sent exactly as before. A saved brief in the earlier format counts as
  outdated once notes exist for its likes, so the next set uses them.

## Regenerating library notes

After adding or changing Inspiration brands:

```bash
node --import tsx scripts/build-inspiration-logo-styles.mts
```

It reuses every note whose logo image, note version and model are unchanged,
and makes one paid text request per new or changed brand, using the
development provider key. The first full run on November 9 made 56 requests
(71,020 input and 4,118 output tokens).

## Not yet covered

Liked uploads ("Your images") are still attached to concept requests as images
for the edit endpoint. Giving them notes needs its own admitted, recorded AI
step; it is not part of this change. Uploads with a transparent background are
also read poorly by models today; the note step should place them on white.
