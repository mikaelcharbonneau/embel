# Contrast

Every text/background and icon/background pair the system paints, with the outlines and rings that identify a control. Each ratio is calculated from the colour values in `tokens.json` with the WCAG 2 relative-luminance formula and floored to two decimals, so a failing value is never rounded up. Minimums are WCAG AA: 4.5:1 for text, 3:1 for icons, control outlines and focus rings.

**Result: 78 pairs checked against a minimum, 0 fail.** 10 decorative pairs are listed for the record.


## Text

| Pair | Foreground | Background | Ratio | Minimum | Result |
| --- | --- | --- | --- | --- | --- |
| Text on a surface | `color-text` #191919 | `color-bg-paper` #ffffff | 17.58:1 | 4.5:1 | pass |
| Text on a surface | `color-text` #191919 | `color-bg-canvas` #f7f7f5 | 16.39:1 | 4.5:1 | pass |
| Text on a surface | `color-text` #191919 | `color-bg-sunken` #f1f0ee | 15.43:1 | 4.5:1 | pass |
| Text on a surface | `color-text-muted` #696965 | `color-bg-paper` #ffffff | 5.51:1 | 4.5:1 | pass |
| Text on a surface | `color-text-muted` #696965 | `color-bg-canvas` #f7f7f5 | 5.13:1 | 4.5:1 | pass |
| Text on a surface | `color-text-muted` #696965 | `color-bg-sunken` #f1f0ee | 4.84:1 | 4.5:1 | pass |
| Text on a surface | `color-text-placeholder` #696965 | `color-bg-paper` #ffffff | 5.51:1 | 4.5:1 | pass |
| Text on a surface | `color-text-placeholder` #696965 | `color-bg-canvas` #f7f7f5 | 5.13:1 | 4.5:1 | pass |
| Text on a surface | `color-text-placeholder` #696965 | `color-bg-sunken` #f1f0ee | 4.84:1 | 4.5:1 | pass |
| Text on a surface | `color-text-positive` #3d6448 | `color-bg-paper` #ffffff | 6.74:1 | 4.5:1 | pass |
| Text on a surface | `color-text-positive` #3d6448 | `color-bg-canvas` #f7f7f5 | 6.28:1 | 4.5:1 | pass |
| Text on a surface | `color-text-positive` #3d6448 | `color-bg-sunken` #f1f0ee | 5.91:1 | 4.5:1 | pass |
| Text on a surface | `color-text-danger` #a42a2a | `color-bg-paper` #ffffff | 7.13:1 | 4.5:1 | pass |
| Text on a surface | `color-text-danger` #a42a2a | `color-bg-canvas` #f7f7f5 | 6.65:1 | 4.5:1 | pass |
| Text on a surface | `color-text-danger` #a42a2a | `color-bg-sunken` #f1f0ee | 6.26:1 | 4.5:1 | pass |
| Text on a surface | `color-text-warning` #6b4617 | `color-bg-paper` #ffffff | 8.35:1 | 4.5:1 | pass |
| Text on a surface | `color-text-warning` #6b4617 | `color-bg-canvas` #f7f7f5 | 7.78:1 | 4.5:1 | pass |
| Text on a surface | `color-text-warning` #6b4617 | `color-bg-sunken` #f1f0ee | 7.33:1 | 4.5:1 | pass |
| Message body and hint on a soft fill | `color-text` #191919 | `color-bg-positive-soft` #eef3ef | 15.65:1 | 4.5:1 | pass |
| Message body and hint on a soft fill | `color-text` #191919 | `color-bg-danger-soft` #faeeee | 15.51:1 | 4.5:1 | pass |
| Message body and hint on a soft fill | `color-text` #191919 | `color-bg-warning-soft` #fff8e9 | 16.62:1 | 4.5:1 | pass |
| Message body and hint on a soft fill | `color-text-muted` #696965 | `color-bg-positive-soft` #eef3ef | 4.90:1 | 4.5:1 | pass |
| Message body and hint on a soft fill | `color-text-muted` #696965 | `color-bg-danger-soft` #faeeee | 4.86:1 | 4.5:1 | pass |
| Message body and hint on a soft fill | `color-text-muted` #696965 | `color-bg-warning-soft` #fff8e9 | 5.21:1 | 4.5:1 | pass |
| Positive badge and field message | `color-text-positive` #3d6448 | `color-bg-positive-soft` #eef3ef | 6.00:1 | 4.5:1 | pass |
| Danger badge, field message, danger button hover | `color-text-danger` #a42a2a | `color-bg-danger-soft` #faeeee | 6.29:1 | 4.5:1 | pass |
| Warning badge and field message | `color-text-warning` #6b4617 | `color-bg-warning-soft` #fff8e9 | 7.89:1 | 4.5:1 | pass |
| Label on a hovered or selected row, chip or button | `color-text` #191919 | `color-bg-hover` #f1f0ee | 15.43:1 | 4.5:1 | pass |
| Label on a hovered or selected row, chip or button | `color-text` #191919 | `color-bg-selected` #f1f0ee | 15.43:1 | 4.5:1 | pass |
| Unselected segment label | `color-text-muted` #696965 | `color-bg-sunken` #f1f0ee | 4.84:1 | 4.5:1 | pass |
| Menu row while pressed; avatar button on hover (pressed fill is neutral-200) | `color-text` #191919 | `color-border` #e4e3df | 13.69:1 | 4.5:1 | pass |
| Link on hover | `color-accent-hover` #3a3a37 | `color-bg-paper` #ffffff | 11.41:1 | 4.5:1 | pass |
| Link on hover | `color-accent-hover` #3a3a37 | `color-bg-canvas` #f7f7f5 | 10.63:1 | 4.5:1 | pass |
| Link on hover | `color-accent-hover` #3a3a37 | `color-bg-sunken` #f1f0ee | 10.01:1 | 4.5:1 | pass |

## Text and icons on filled controls

| Pair | Foreground | Background | Ratio | Minimum | Result |
| --- | --- | --- | --- | --- | --- |
| Primary button, current nav item, selected segment, send button | `color-on-accent` #ffffff | `color-accent` #191919 | 17.58:1 | 4.5:1 | pass |
| The same on hover; toast action on hover | `color-on-accent` #ffffff | `color-accent-hover` #3a3a37 | 11.41:1 | 4.5:1 | pass |
| Danger-filled button | `color-on-accent` #ffffff | `color-bg-danger` #a42a2a | 7.13:1 | 4.5:1 | pass |
| Danger-filled button on hover | `color-on-accent` #ffffff | `color-bg-danger-hover` #8a2222 | 9.00:1 | 4.5:1 | pass |
| Toast and tooltip text | `color-text-inverse` #ffffff | `color-bg-inverse` #191919 | 17.58:1 | 4.5:1 | pass |
| Tick on the selected badge and in a checked box | `color-on-accent` #ffffff | `color-accent` #191919 | 17.58:1 | 3:1 | pass |

## Disabled (WCAG sets no minimum; house minimum 3:1)

| Pair | Foreground | Background | Ratio | Minimum | Result |
| --- | --- | --- | --- | --- | --- |
| Disabled label | `color-text-disabled` #85847f | `color-bg-disabled` #f1f0ee | 3.29:1 | 3:1 | pass |
| Disabled label | `color-text-disabled` #85847f | `color-bg-paper` #ffffff | 3.74:1 | 3:1 | pass |
| Disabled label | `color-text-disabled` #85847f | `color-bg-canvas` #f7f7f5 | 3.49:1 | 3:1 | pass |
| Tick in a disabled checked box | `color-on-accent` #ffffff | `color-text-disabled` #85847f | 3.74:1 | 3:1 | pass |

## Icons

| Pair | Foreground | Background | Ratio | Minimum | Result |
| --- | --- | --- | --- | --- | --- |
| Icon on a surface | `color-icon` #191919 | `color-bg-paper` #ffffff | 17.58:1 | 3:1 | pass |
| Icon on a surface | `color-icon` #191919 | `color-bg-canvas` #f7f7f5 | 16.39:1 | 3:1 | pass |
| Icon on a surface | `color-icon` #191919 | `color-bg-sunken` #f1f0ee | 15.43:1 | 3:1 | pass |
| Icon on a surface | `color-icon-muted` #696965 | `color-bg-paper` #ffffff | 5.51:1 | 3:1 | pass |
| Icon on a surface | `color-icon-muted` #696965 | `color-bg-canvas` #f7f7f5 | 5.13:1 | 3:1 | pass |
| Icon on a surface | `color-icon-muted` #696965 | `color-bg-sunken` #f1f0ee | 4.84:1 | 3:1 | pass |
| Positive icon | `color-text-positive` #3d6448 | `color-bg-positive-soft` #eef3ef | 6.00:1 | 3:1 | pass |
| Danger icon | `color-text-danger` #a42a2a | `color-bg-danger-soft` #faeeee | 6.29:1 | 3:1 | pass |
| Warning icon | `color-text-warning` #6b4617 | `color-bg-warning-soft` #fff8e9 | 7.89:1 | 3:1 | pass |
| Muted icon in a neutral message or a failed image frame | `color-icon-muted` #696965 | `color-bg-sunken` #f1f0ee | 4.84:1 | 3:1 | pass |
| Icon on the paper chip over dark artwork (#121212) | `color-icon` #191919 | #ececec | 14.88:1 | 3:1 | pass |
| Icon on the paper chip over white artwork | `color-icon` #191919 | #ffffff | 17.58:1 | 3:1 | pass |
| The paper chip itself against dark artwork | #ececec | #121212 | 15.85:1 | 3:1 | pass |
| Pressed toggle on artwork: white icon on ink | `color-on-accent` #ffffff | `color-accent` #191919 | 17.58:1 | 3:1 | pass |

## Outlines, rings and marks

| Pair | Foreground | Background | Ratio | Minimum | Result |
| --- | --- | --- | --- | --- | --- |
| Field, checkbox, radio and switch outline; slider track | `color-border-control` #8a8985 | `color-bg-paper` #ffffff | 3.50:1 | 3:1 | pass |
| Field, checkbox, radio and switch outline; slider track | `color-border-control` #8a8985 | `color-bg-canvas` #f7f7f5 | 3.26:1 | 3:1 | pass |
| Field, checkbox, radio and switch outline; slider track | `color-border-control` #8a8985 | `color-bg-sunken` #f1f0ee | 3.07:1 | 3:1 | pass |
| Control outline on hover and focus; selected ring; checked fill | `color-border-selected` #191919 | `color-bg-paper` #ffffff | 17.58:1 | 3:1 | pass |
| Control outline on hover and focus; selected ring; checked fill | `color-border-selected` #191919 | `color-bg-canvas` #f7f7f5 | 16.39:1 | 3:1 | pass |
| Control outline on hover and focus; selected ring; checked fill | `color-border-selected` #191919 | `color-bg-sunken` #f1f0ee | 15.43:1 | 3:1 | pass |
| Invalid field and outlined danger button | `color-border-danger` #b54b4b | `color-bg-paper` #ffffff | 5.15:1 | 3:1 | pass |
| Invalid field and outlined danger button | `color-border-danger` #b54b4b | `color-bg-canvas` #f7f7f5 | 4.80:1 | 3:1 | pass |
| Invalid field and outlined danger button | `color-border-danger` #b54b4b | `color-bg-danger-soft` #faeeee | 4.54:1 | 3:1 | pass |
| Focus ring (ink) | `focus-ring-color` #191919 | `color-bg-paper` #ffffff | 17.58:1 | 3:1 | pass |
| Focus ring (ink) | `focus-ring-color` #191919 | `color-bg-canvas` #f7f7f5 | 16.39:1 | 3:1 | pass |
| Focus ring (ink) | `focus-ring-color` #191919 | `color-bg-sunken` #f1f0ee | 15.43:1 | 3:1 | pass |
| Focus halo (paper) on artwork (the ink ring alone fails on dark artwork; the halo carries it) | `focus-ring-halo` #ffffff | #121212 | 18.73:1 | 3:1 | pass |
| Focus halo (paper) on artwork (the ink ring alone fails on dark artwork; the halo carries it) | `focus-ring-halo` #ffffff | #030436 | 19.54:1 | 3:1 | pass |
| Focus halo (paper) on artwork (the ink ring alone fails on dark artwork; the halo carries it) | `focus-ring-halo` #ffffff | #7a7a7a | 4.29:1 | 3:1 | pass |
| Ink ring against its own halo | `focus-ring-color` #191919 | `focus-ring-halo` #ffffff | 17.58:1 | 3:1 | pass |
| Flipped ring on an ink surface (toast) | `focus-ring-halo` #ffffff | `color-bg-inverse` #191919 | 17.58:1 | 3:1 | pass |
| Progress bar fill against its track | `color-accent` #191919 | `color-border` #e4e3df | 13.69:1 | 3:1 | pass |
| Selected tab underline | `color-border-selected` #191919 | `color-bg-canvas` #f7f7f5 | 16.39:1 | 3:1 | pass |
| Switch thumb, off | `color-border-control` #8a8985 | `color-bg-paper` #ffffff | 3.50:1 | 3:1 | pass |

## Decorative (no minimum)

| Pair | Foreground | Background | Ratio | Minimum | Result |
| --- | --- | --- | --- | --- | --- |
| Card edge, divider, secondary button edge | `color-border` #e4e3df | `color-bg-paper` #ffffff | 1.28:1 | none | decorative |
| Card edge, divider, secondary button edge | `color-border` #e4e3df | `color-bg-canvas` #f7f7f5 | 1.19:1 | none | decorative |
| Card and chip edge on hover | `color-border-strong` #c9c8c2 | `color-bg-paper` #ffffff | 1.67:1 | none | decorative |
| Card and chip edge on hover | `color-border-strong` #c9c8c2 | `color-bg-canvas` #f7f7f5 | 1.56:1 | none | decorative |
| Edge of a danger message | `color-border-danger-soft` #e5c4c4 | `color-bg-danger-soft` #faeeee | 1.42:1 | none | decorative |
| Edge of a warning message | `color-border-warning-soft` #e3ce9c | `color-bg-warning-soft` #fff8e9 | 1.46:1 | none | decorative |
| Edge of a positive message | `color-border-positive-soft` #c8d8cc | `color-bg-positive-soft` #eef3ef | 1.32:1 | none | decorative |
| Dot grid | `pattern-dot-color` #c9c8c2 | `color-bg-canvas` #f7f7f5 | 1.56:1 | none | decorative |
| Skeleton fill | `color-bg-skeleton` #e4e3df | `color-bg-paper` #ffffff | 1.28:1 | none | decorative |
| Skeleton fill | `color-bg-skeleton` #e4e3df | `color-bg-canvas` #f7f7f5 | 1.19:1 | none | decorative |

## Rules that keep these true

- Text the app sets on a generated brand colour picks black or white by calculated contrast.
- Status is never colour alone: every tone carries an icon or a word.
- `color-border` and `color-border-strong` never outline something a person types into or ticks; that is `color-border-control`.
- Disabled text is `color-text-disabled` on `color-bg-disabled`; a disabled control also has its reason in text beside it.
