# Menu and popover

A floating list of actions or choices, and a small non-modal panel. You provide the trigger and the rows.

- **Menu**: rows of actions (`menuitem`) or choices (`menuitemradio`, with a tick on the current one). A destructive row is the danger row, last, after a separator.
- **Popover**: a small panel for a few controls, such as adding files or voice input.
- Minimum width 200 px; rows 40 px, 44 px at compact width. Radius `radius-card`, rows `radius-small`, `shadow-overlay`, `z-popover`.
- Opens over `menu-duration` from the corner nearest its trigger. Closes on Escape (focus returns to the trigger), on an outside press and when focus leaves. The press that closes it is not passed to what is underneath.
- Do not build menus on `<details>`.
- **Summary block** (added November 12 for D-015): `e-menu__summary` is a block that is not a row. The account menu opens with the plan and the balance ("Pro" and "112 credits left this month"), in `color-text`, followed by a separator. Credits only, never money.
