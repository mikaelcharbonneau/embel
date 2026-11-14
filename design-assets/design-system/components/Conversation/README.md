# Conversation message and step header

The pieces of the project conversation, assembled from Card, Badge, Disclosure, Icon button and the thinking indicator.

- **Assistant turn**: the Embel mark in an ink circle, a meta line ("Embel · Logo · 2 of 3") and text on the canvas, capped at `measure`.
- **The person's answer**: a paper card aligned right, with an edit Icon button.
- **Folded answer**: a Disclosure showing the question and the chosen answer as a badge. Finished steps fold, so their controls leave the keyboard order.
- **Step header**: the step name (`text-title-md`), a "Complete" badge and one edit action, above a summary of what was decided.
- Only content added after the page has loaded enters with `enter-shift`; saved sections do not replay it.
- This is the reading container: 792 px (`container-reading`).
- **Choices go into the reply box** (added November 13): when a question asks the person to pick options before Embel starts work (such as logo types), each chosen option appears as a static Chip in the reply box, in the order shown, and Send becomes available. Send starts the work; there is no separate start button. Its label and tooltip name the work ("Draw six concepts"). When the work can't start (no credits), Send is `aria-disabled`, described by the message that says why.
