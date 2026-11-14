# Dialog

A modal surface for one decision or one focused view. You provide the title, the body and the actions.

- Parts: a header with the title and one close button, a scrolling body, a footer with actions right-aligned and the primary action last.
- Sizes: small 440 px (`dialog-width-sm`, confirmations), medium 560 px, large 860 px (media, the extensions list), extra large 1100 px (the large brand view, a name's details). At compact width every dialog is a bottom sheet, full width, up to 90% of the height.
- A native `<dialog>`. Modal dialogs open with `showModal()`: focus moves in, is trapped, and returns to the opener. Escape closes it. Exception (November 13): a dialog about the work in the Workspace opens in the work-area overlay (`e-workspace__overlay`) and is not modal, so the chat beside it stays usable; Escape and Close still return focus to the opener.
- **Name details** (November 13): extra large, with tabs for Domains, Handles and Trademarks. Domains has a search field, Extensions, Tweaks and Filters buttons, a sort menu, quick filter chips and a results table (domain, status: Available, Premium or Taken; first-year price; renewal price; shortlist). Extensions, Tweaks and Filters each open a second dialog over the first (large for Extensions, medium for the others) with Clear or Reset on the left and the primary action on the right. Handles is a grid of variations by platform; only checks the app really runs show a status, the rest open the platform. Trademarks searches the EU register and links to the others; it always says it is not legal clearance.
- One scrim, `color-bg-scrim`, no blur. One shadow, `shadow-modal`. Radius `radius-panel`.
- Opening uses `enter-scale` and `duration-base`; closing is instant.
- While an action runs, its button shows the loading state and the dialog stays open. A failure appears inside the dialog as a danger Inline message.
- Scrolling bodies set scroll padding so a focused control never sits under the header. Their rows keep their natural height while the body scrolls (`grid-auto-rows: max-content`), so tabs and headings never collapse.
