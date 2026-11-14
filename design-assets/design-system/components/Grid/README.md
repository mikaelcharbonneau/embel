# Grid and breakpoints

Three named ranges replace 21 widths. They are constants, because CSS variables cannot be used in media queries.

| Name | Range | Columns, gap | Gutter |
| --- | --- | --- | --- |
| compact | below 640 px | 4, 16 px | 16 px |
| medium | 640 to 1023 px | 8, 20 px | 24 px |
| wide | 1024 px and up | 12, 24 px | 32 px |

- Two containers: `container-reading` 792 px (the project conversation) and `container-page` 1056 px (every other page). Content is centred.
- Running text is capped at `measure` (68 characters).
- Card grids are 1, 2 and 3 across. Logo concepts and boards are 2 across at compact (never under 160 px) and 3 across from medium.
- **Results grid** (`e-grid-results`, added November 12 for D-013): on the Logo and Creative direction steps, three across at page width, two at medium, one at compact. It replaces `e-grid-choices` for generated work. In the Workspace (wide width) the work area takes `e-workspace__main--rows-2` (six logo concepts) or `--rows-1` (three direction boards): the results stay three across and are sized from the window's height so all of them are in view without scrolling, with the column centred under the project bar (see Workspace). A chosen result keeps its size and place.
- **Compare** (`e-compare`) is no longer used on the Logo and Creative direction steps (November 13); it remains for the finished brand summary (the chosen board large, the logo beside it).
- **Name list** (`e-name-grid`): compact name cards about 224 px wide, as many across as fit (four in the Workspace at 1440 px).
- Forms: label above the field; two fields side by side only when related; fields up to 480 px wide.
- No page scrolls sideways or clips at 320 px or at 200% zoom.
