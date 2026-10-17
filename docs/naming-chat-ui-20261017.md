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
preserved under ignored `.references/naming-chat-117-9404/`. The preview at port
3132 remains the rejected historical layout. The corrected source is
`a13e94c34d8d67d52fb6dc23415f5be679f823d6`, integrated in clean pre-verification
base `a48eb033acc29e8f260ebfaadf2cae6bf6343423`.

The local implementation, compact-card visual comparison and bounded independent
review are complete. F1 and F2 are addressed and the corrected source has approved
specification/code-quality verdicts. F1 retains acknowledged question progress in
owner/generation-fenced memory, preserves it across same-owner re-verification,
and conservatively asks unfinished follow-ups instead of inventing confirmations.
F2 excludes activation of native/ARIA actions from exploration keyboard input;
genuine results-scroller keys and wheel/touch exploration remain covered.

Recorded author checks on that corrected source are 142 client tests across 13
files and 46/46 final affected desktop/mobile browser checks: 16 review-fix cases
and 30 preserved V2/layout cases. Fresh nonincremental TypeScript, scoped lint,
production build and diff checks passed. Earlier source-specific browser counts
remain historical evidence in the correction and verification records; these
focused runs are not a final combined-branch matrix.

The corrected independent preview is `http://127.0.0.1:3135/__preview`, identifying
source `a13e94c` / build `gfuuPIn1v7wdAnbMseDvK`. The lead's desktop/mobile wrapper
smoke passes, including interruption and resumption of questions. It displays
sample data only and does not qualify creative quality or real generation.

The full stable-source matrix and whole-branch review are the only remaining local
acceptance gates; their measured results and final combined revision remain
pending. Live activation is separate. Connector metadata identifies the configured
database as `fluid-platform-dev` (`fricsfwqibyhemknqgyf`, `us-east-1`), where Naming
migration `20261016180000` and all nine RPCs are absent. Existing restricted role
`fluid_api_text_worker` has OID `21484`; this catalog fact does not configure its
Naming grants, owner binding, credentials or model access. See the exact
[activation requirements](naming-brain-activation-20261016.md) and
[source-specific verification](naming-brain-verification-20261016.md).
