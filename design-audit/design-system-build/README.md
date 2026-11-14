# Embel design-system generator

The scripts that produced the published Embel Design System (a Claude Design artifact) from
`../05_design_system.md` and the owner's eleven decisions of November 12, 2026. The artifact is the
design system; these scripts are how its files were written, kept so the system can be regenerated
or changed in one place.

Nothing here is used by the app. Output goes to `out/`, which git ignores.

## What each file does

| File | Does |
| --- | --- |
| `tokens.py` | Writes `out/project/tokens.json`: primitive and semantic colour, type, spacing, radius, shadow, layering, layout, component sizes, duration, easing, movement. |
| `bundle.css.src` | The component stylesheet source. It is CSS plus four state macros (`:hover!`, `:active!`, `:focus!`, `:within!`), which is why it is not named `.css`. |
| `bundle.src.js` | Optional behaviour (`window.Embel`): toast, tab keys, menu dismissal, dialog open and close. |
| `build.py` | Expands the macros into real states plus a `data-force` twin for documentation, embeds the Lucide icons and the Embel mark as masks, copies the two font files, and compiles a local `tokens.css`. |
| `pv.py` | Helpers for writing preview pages. |
| `comp_a.py`, `comp_b.py`, `comp_c.py` | The 27 components, six Embel compositions, seven patterns and three foundation pages: each preview and its guidelines. |
| `screens.py` | The five validation screens, written once and emitted at 1440 and 390. |
| `make.py` | Runs the build and writes every preview. |
| `contrast.py` | Calculates every colour pair from `tokens.json` and writes `contrast.md`. It lists any pair that fails. |
| `docs.py` | Writes the brand book, the change log, the cover and the artifact's index. |
| `assets.py` | Prepares the showcase artwork and the Embel mark that the previews use. Needs Pillow. |
| `assets.json` | Maps each prepared image to its upload id in the published artifact. |
| `render.mjs`, `cover.mjs` | Render previews in a browser the way the artifact's frame does, to check them and to measure their heights. Need Playwright. |

## Running it

From this folder:

```bash
npm install --no-package-lock
```

```bash
python3 assets.py
```

```bash
python3 tokens.py
```

```bash
python3 make.py comp_a,comp_b,comp_c,screens
```

```bash
python3 contrast.py
```

```bash
python3 docs.py
```

To check the result in a browser and refresh the preview heights, render and then run `make.py` again:

```bash
node render.mjs all
```

`node render.mjs ScreenProjectsWide@3` renders one preview; `@3` selects the third state of a
validation screen. Screenshots go to `out/shots/`.

## Things to know

- `assets.json` holds upload ids that belong to the published artifact. If the images are uploaded
  again, update the ids.
- `docs.py` pins the time the published system was first written (`CREATED`). The artifact's index
  must keep that value.
- The previews use `data-force` to show hover, focus and pressed states side by side. That attribute
  is for documentation only.
- Icons come from `lucide-static` (ISC licence); fonts from the `@fontsource-variable` packages for
  Geist and Instrument Sans (SIL Open Font License).
- The side-by-side samples page used to choose the eleven decisions was a one-off and is not kept here.
