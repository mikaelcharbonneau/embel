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

## Liked uploads

A liked upload ("Your images") gets its own note, written once per upload
version by the admitted operation `identity.logo_style_note`
(`supabase/candidates/shared_logo_style_notes.sql`):

- Clicking Generate (or More concepts) requests a note for each liked upload
  that has none, then waits up to a minute for them. A note still being
  written, or one that is unavailable, stays out of that brief; it joins the
  next set once written.
- The worker decodes the upload in the isolated raster child, places it on
  white (a transparent logo is otherwise read as solid black) and sends it at
  most 1024 px, as PNG or, if larger, JPEG within the 128 KiB request bound.
- One structured `gpt-6.1-sol` request under Creative direction's exact text
  prices and limits; usage is recorded from the response before the note is
  stored, and the price is checked against the policy in the database.
- Notes are stored in `public.logo_style_notes` (owner-readable, never
  changed). An unclear outcome is left for review and never repeated; a
  request is not admitted while another for the same upload version is
  unfinished or awaiting review. After two definite failures, that upload
  version is not requested again automatically.
- Concepts no longer attach uploads as images; refinements still attach their
  base logo and references. Ready upload notes come first in the brief, then
  library likes, at most four in all.
- A saved brief whose liked-style lines differ from the latest (for example,
  an upload note written after the brief was saved) counts as outdated.

The first local note: 1,447 input and 61 output tokens, recorded at $0.004.
