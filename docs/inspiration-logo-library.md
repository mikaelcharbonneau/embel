# Inspiration logo library (November 24, 2026)

The Inspiration gallery's **Logos** tab shows the 56 brand boards' logos first,
then the logo library: 919 single logos saved from the
[logosystem.co](https://logosystem.co) gallery. The owner confirmed on November
24, 2026 that Embel has permission to show them; the records are kept outside
this repository, like those for the brand boards.

## How a library logo behaves

- It appears only in the Logos tab (never in Brands, Colors, Typefaces, Socials
  or Visuals) and in search there. Its overlay shows the one image and a
  "Like this logo" button.
- A like is saved like any other Inspiration like and counts toward
  "Inspiration: N liked".
- It is shown for inspiration only. It has no logo style note, and its name and
  description never reach a generation prompt (`src/server/data/logo-saved-inputs.ts`
  skips library logos), so liking one does not yet steer logo concepts or
  Creative direction. Writing style notes for them would be a paid AI run
  (`scripts/build-inspiration-logo-styles.mts`) and needs the owner's go-ahead.

## Files

| What | Where |
| --- | --- |
| Images (large and `-small`) | `public/inspiration/logos/<slug>.webp` |
| Catalog entries | `src/domain/inspiration-logos.json`, expanded in `src/domain/inspiration.ts` |
| Database rows | `supabase/migrations/20261124120000_inspiration_logo_library.sql` |
| Build script | `scripts/build-inspiration-logos.mjs` |

Names come from the saved file names ("nfl-plus.webp" → "NFL Plus"), so a few
may be cased differently from the real brand.

To add or replace logos, put the images in a folder and run
`node scripts/build-inspiration-logos.mjs <folder> <new migration name>`. It
rewrites the images and JSON, and writes a new migration with one immutable
catalog row per logo (existing rows are left alone). Catalog rows cannot be
changed or deleted, so a removed logo needs a migration that also clears its
saved likes, as the brand boards' migration did.

## Releasing

Deploy the web app first, then apply the migration. Until the rows exist,
library logos show "Browse only for now" and cannot be liked. Applying the rows
before the new web app is live would push the reference list past the old
app's limit of 1,000, and the old app would then mark every brand as browse-only.
