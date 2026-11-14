# Toast

A brief neutral confirmation for a result the person cannot see where they are looking. You provide one short sentence and, optionally, one action.

- Use for: copied, downloaded, saved in the background, moved to Deleted. Offer **Undo** when the action can be reversed.
- One size, bottom centre, above the composer (`z-toast`). Ink fill with white text; `radius-control`; `shadow-raised`.
- Appears with `enter-shift`, leaves after `toast-duration` (5 s) or on dismiss, pauses on hover and focus, and is announced politely (`role="status"`).
- One toast at a time. Never use a toast for an error, a warning or anything the person must read.
- On the ink surface the focus ring flips: a paper ring with an ink halo.
