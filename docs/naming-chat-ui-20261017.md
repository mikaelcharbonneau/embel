# Naming chat UI correction

## Confirmed user direction

The 2026-10-17 user review rejected the separate preferences form and oversized
cards in the local Naming preview. All generation decisions belong in chat
widgets, using the same conversational presentation as the Strategy questions.
Once decisions are made, the same chat becomes a smaller **left** panel and a
larger **right** container displays the names. This direction is recorded in D071.

The visual reference is [Naming — Results · Compact variation, frame 117:9404](https://www.figma.com/design/HP219GuYbpE8F1wHxj0h6N/Fluid-%E2%80%94-Screens?node-id=117-9404).
The reference places chat on the right; the user's explicit placement takes
precedence. Its compact name/rationale/heart cards, neutral surfaces, typography
and spacing remain the visual target. Illustrative names, recommendations,
personal initials and approval labels are not application data.

## Implementation and acceptance requirements

- Present approaches, directness and relevant follow-up preferences as ordered
  widgets in the conversation. Keep confirmed answers readable and editable.
- Reuse the Strategy conversation components and original project artwork where
  suitable. Keep a functioning composer and preserve its draft through the layout
  transition. Do not fabricate model replies or historical conversation events.
- Start with the full conversation; after the explicit start of exploration,
  retain that conversation beside the grid. At the 1440 px reference width, use
  the 340 px chat and 1020 px results proportions within the existing 80 px rail
  and 64 px header.
- Use compact cards with a name, short rationale and favorite control. Preserve
  inspection, selection, save and Workshop actions in suitable detail/menu views.
- Save meaningful answers through the existing acknowledged account workflow;
  retain recovery and account-switch protections. Merely rendering or revisiting
  chat must not start generation.
- Only actual name-grid exploration may trigger scroll continuation. Chat scroll
  must not trigger generation. Retain idle, hidden, filter, history, detail and
  Stop behavior, plus stable result anchors and saved results.
- On narrow screens, give chat and names usable space and a clear way to move
  between them. Verify keyboard use and no horizontal overflow.

## Current evidence boundary

The reference context and 1440 × 900 screenshot were retrieved from Figma and are
preserved under ignored `.references/naming-chat-117-9404/`. The existing preview
at port 3132 is the rejected historical layout, not evidence that this correction
is complete. Implementation, focused browser checks, screenshot comparison and
independent review are pending. Synthetic preview data does not qualify the
Naming brain's creative quality or live provider readiness.
