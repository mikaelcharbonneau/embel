> **Archived November 9, 2026.** Historical record; it may not match the current code. Current architecture and plan: [architecture-review.md](architecture-review.md).

# Naming chat UI correction

## Confirmed user direction

The 2026-10-17 user review rejected the separate preferences form and oversized
cards in the local Naming preview. All generation decisions belong in chat
widgets, using the same conversational presentation as the Strategy questions.
Once decisions are made, the same chat becomes a smaller **left** panel and a
larger **right** container displays the names. This direction is recorded in D071.

In the subsequent live review, the user removed the three optional questions
about source languages or roots, people or places, and stories or cultural
references (D076). The conversation retains approaches, directness, output
language, length and included/excluded text. All naming approaches remain
available; saved inspiration fields remain compatible without becoming questions
or answer cards in the conversation.

The visual reference is [Naming — Results · Compact variation, frame 117:9404](https://www.figma.com/design/HP219GuYbpE8F1wHxj0h6N/Fluid-%E2%80%94-Screens?node-id=117-9404).
The reference places chat on the right; the user's explicit placement takes
precedence. Its compact name/rationale/heart cards, neutral surfaces, typography
and spacing remain the visual target. Illustrative names, recommendations,
personal initials and approval labels are not application data.

## Implementation and acceptance requirements

- Present approaches, directness, output language, length and text constraints as
  ordered widgets in the conversation. Keep confirmed answers readable and
  editable; do not ask the three retired inspiration questions.
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

## Preserved correction evidence and final local status

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

The historical verified local sample preview at `http://127.0.0.1:3137/__preview` uses
source `d654d62fcbaaddad0002eff088bbf0983d97d6c9` / build `EjbFioaYQxauMXsNryONs`.
Its complete desktop/mobile wrapper smoke passes refresh recovery, the same composer,
chat→grid, 100→200 names, favorite, steering, selection, reset and cookie checks.
It displays synthetic names and simulated saves; no live generation. The earlier
3135/a13e94c preview (`gfuuPIn1v7wdAnbMseDvK`) remains preserved as historical evidence.

The final local matrix passed on `d654d62fcbaaddad0002eff088bbf0983d97d6c9`, tree
`483278cbdc0ce6f6d9100b53cdf122a5dc075b59`, full 1,907-file manifest
`ba317ea3b0a61046da8564b14ee740f4bf1a072f0a7e58f48d7b69af301c800a`. Scoped F1–F7 repair review
approved 7 addressed / 0 open / 0 new. All eight commands exited 0, including 8,636
passing tests (23 intentional native-PostgreSQL gates, 0 failures) and 172/172
browsers (86+86, no skips/retries). D071 layout/keyboard cases passed on both sizes.
This later four-file status refresh is documentation-only; the tested code and
built preview retain d654d62 identity. No new user approval or live activation is implied.
The later D072–D075 approvals authorized local live setup separately. The Naming
migration and nine restricted capabilities are now installed on
`fluid-platform-dev` (`fricsfwqibyhemknqgyf`, `us-east-1`) for the separate
`fluid_naming_brain_worker` login/OID `23033`; the existing API-worker role and
privileges remain separate. D076 corrected the initial pilot's mistaken owner
binding while retaining one US$25 pilot and every unrelated reservation. Actual
restricted native authentication, exact-project readiness and a rollback-only
US$5 admission check passed; no model execution is implied. See the exact
[activation requirements](naming-brain-activation-20261016.md) and
[source-specific verification](naming-brain-verification-20261016.md).

## D076 follow-up and scroll-race repair

The local follow-up removes exactly three inspiration questions and their answer
cards. The five retained steps are approaches, directness, output language,
length and text constraints. All eleven approaches, Real words/metaphor copy,
saved inspiration fields, preference schema and account-save contracts remain
unchanged. In-memory progress that points to a retired question resolves to an
unfinished retained step instead of blocking the conversation.

The first exact candidate passed types, full lint, 1,176 client tests and the
production build. Its seven-spec browser run passed 175/176 (88/88 desktop,
87/88 mobile, zero skips/retries). The failure was retained rather than retried
away: the mobile idle test observed a POST for more names after the first wheel
near the grid's head while its tail was still beyond the two-viewport prefetch
region. Both new question-removal and unavailable/available Start cases passed
on both viewports. The preview switch was withheld.

Three deterministic hook regressions reproduced unexpected admission against the
old source while the original eighteen hook checks passed. The repair in
`use-naming-feed.ts` removes cached observer proximity as admission authority.
Both wheel and observer paths now check the current connected, visible, nonzero
results geometry and the same two-viewport margin. Replaced/disposed observer
callbacks are ignored. The controller, idle window, owner, provider and budget
policies are unchanged; a genuine interaction stays unconsumed while far from
the tail. Independent review accepted the fix; 57 focused checks, types, scoped
lint and diff checks pass. Independent combined revised-archive verification
also passed: nonincremental TypeScript, full lint, all 1,186 client tests in 120
files, production build, diff check and all 176 Naming browser checks
(88 desktop + 88 mobile, zero failures/skips/retries). Both original idle-boundary browser
cases pass on both sizes without weakening assertions.

The real local preview on port 3106 now serves production build
`Ub5lazMmLCPeVaPMyBTyY` from the revised web-only archive, base `b2ff6ce8` plus
eight explicit source/test patches. Its 1,908-file manifest is
`1ec002ea4fbfd5738128ad9c2d04c26527560cdfc9db8f643290c7ebb0df78a4` and patch
manifest `ac367356b10ac77f19ec2dfe2b8d8c8abf06f0c9fca67e3fe0b00d9cf34bafaa`.
Web PID `83018` replaced the identity-checked old web at 01:48:26.912Z. The
dedicated Naming worker, protected configuration and US$25 pilot were unchanged
by this web-only switch. Port 3137 had no listener at switch time; its synthetic
archive remains historical, and the actual signed-in account route on 3106 is
the current review destination.

Repair SHA-256 digests:

- `src/components/naming/use-naming-feed.ts`:
  `e193911bb6622f4a446ad9173f8f8986787f30fa9e6da1f97b3851cbe0286294`
- `tests/client/naming-feed-observer.test.tsx`:
  `e8aa2815ea6d6e0d9c060fe9d559f773ffb94e086f36565a637e892513c8a1cd`

The Start-button blocker was separate: the original pilot belonged to a different
test owner. The same pilot is now bound to the actual project's owner, with
US$25 available and all old reservations preserved. Exact-project readiness and
rollback-only admission passed; see the activation packet for the distinction
between real native worker authentication, simulated app claims in SQL probes,
and actual signed-in browser acceptance. No paid model test was used for these
checks.

Actual signed-in acceptance after the switch confirmed the three prompts absent,
all saved choices intact, Saved status and an enabled Start exploring button on
the user's project. The lead acknowledged the retained already-saved choices
without editing them after refresh and left Start unclicked. This browser proof
is separate from fixture checks and the simulated SQL app claims; no session was
extracted or paid generation triggered.
