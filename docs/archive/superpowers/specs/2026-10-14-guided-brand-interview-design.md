> Archived November 10, 2026: describes the system before the generation engine.

> **Archived November 9, 2026.** Historical record; it may not match the current code. Current architecture and plan: [architecture-review.md](../../../architecture-review.md).

# Guided brand interview

## Current status — 2026-10-29

Follow the [current working agreement](../../../../AGENTS.md) for redesign freedom, product priorities, test-data retention, AI testing, cost presentation and release authority. Historical layout and control-format requirements in this specification no longer freeze the UI. This documentation update does not implement runtime cost-policy or confirmation-dialog changes.

The October 14, 2026 specification superseded the Strategy conversation presentation in D026 and the four-widget sequence in the older workspace design. That increment preserved existing projects, immutable provider output, ownership, compatibility identifiers and the dedicated durable worker. [D064](../../../decisions.md) subsequently replaced its separate research loading screen with immediate conversation UI; the experience below reflects that correction.

## Experience

The opening sequence is **initial prompt → conversation with inline research status → competitors → target audience → brand personality**. Embel guides the next useful step and accepts changes of direction. It does not add a Positioning step to this interview.

Sending the initial prompt opens the conversation immediately with the submitted prompt and visible composer, saves the project and admits real competitor research. The same inline Embel thinking mark used for later replies indicates actual pending work; there is no separate research loading screen. Completion, failure and cancellation follow the actual durable job; no timer fabricates research progress. Keep Stop and saved-request recovery available. Reduced motion uses a static mark. Failure preserves the prompt and offers status recovery and an explicit retry where safe.

Each choice widget asks one clear question, shows detailed options and explains its recommendations. Recommendations are never preselected. Competitors have actual research sources and separate website links; audience options explain needs and fit; personality directions include traits and tone examples. Continue confirms selected options. The normal composer remains available for an answer in the user's own words, a refinement, or a clarification. A clear custom answer advances; a question receives an answer and stays at the same stage.

Selections and messages save automatically. Earlier choices remain in chronological history and may be revisited; changing an earlier decision invalidates downstream approvals while retaining historical answers and provider results. Reopening restores the same conversation and pending operation. Old projects are not billed automatically merely because they are opened.

## Contracts and orchestration

Optional versioned `intake.guidedInterview` state contains stage, user/automatic turn references, exact input revisions, and explicit answer records. It never accepts assistant prose from the browser. Assistant content comes exclusively from verified owned immutable job results, bound to the exact turn and revision. Legacy snapshots without this field remain valid.

A versioned guided handler and policy coexist with the legacy handler. API input version 2 freezes a bounded history of owned assistant results. Guided results distinguish choices, a question, an answer, and an accepted custom answer. Selected choices save existing canonical competitors, audience or personality fields. An accepted custom answer saves its interpreted decision and requests only the next stage's widget. Clarifications do not advance.

## Historical presentation choices

The October 14 design presented one answer, question or choice widget per assistant turn, with exactly one current decision widget. The account conversation owned orchestration and presented a unified timeline instead of mounting the old manual editor and provider-job dashboard together. That task removed Strategy/Competitors markers, step counts, the stage bar, details disclosures, context/review blocks, result-navigation bars, permanent provider/cost copy and the Project context hint. It placed account controls in Settings/global navigation and used a 44×44 arrow send control.

These record the original presentation task, not permanent bans on useful navigation, progress indicators or revised controls. New designs follow the current working agreement, including expected cost beside Generate and one deliberate click to start generation. Those product requirements do not assert that the current UI already implements them.

## Runtime and integrity

All requests use the existing authenticated project API, exact workload identity and durable worker. Existing generation fencing, revision compare-and-swap, idempotency, cancellation, lease settlement and uncertain-outcome handling remain mandatory. The historical private testing mode used per-operation database grants, conservative validated reservations and tool/token limits; its qualification is recorded in [guided interview runtime](../../guided-interview-runtime.md). That record is not the current working agreement or a requirement to reintroduce fixed monetary caps. Runtime changes still require implementation and verification.

Research requires observed search results and matching citations. An unavailable search operation is reported honestly; a loading animation is not evidence of successful research. No paid provider requests are needed for fixture verification. New policies and migrations require independent database checks before any runtime activation.

## Functional acceptance

- Initial prompt appears in the conversation immediately, with the composer visible and an inline indicator tied to actual pending work. Stop and saved-request recovery remain available.
- The current decision is clear; recommendations are not preselected.
- Continue, free-text answer, clarification and refinement follow distinct correct paths.
- Completed personality ends this interview without silently adding Positioning.
- Reload, account switch, conflict, lost acknowledgement, cancellation and uncertain provider outcome retain their proper fences.
- Retained project facts/history and unrelated tools remain readable.
- Desktop/mobile, keyboard and reduced-motion behavior are checked in an isolated browser.
