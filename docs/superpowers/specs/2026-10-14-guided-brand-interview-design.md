# Guided brand interview

The user approved implementation on October 14, 2026. This supersedes the Strategy conversation presentation in D026 and the four-widget sequence in the older workspace design. It preserves existing projects, immutable provider output, ownership, compatibility identifiers and the dedicated durable worker.

## Experience

The opening sequence is **initial prompt → logo research screen → competitors → target audience → brand personality**. Each assistant turn presents one answer, one question, or one choice widget. Embel guides the next useful step and accepts changes of direction. It does not add a Positioning step to this interview.

Sending the initial prompt saves the project and admits real competitor research. A dedicated loading surface animates the original Embel logo while that work is pending. Completion, failure and cancellation follow the actual durable job; no timer fabricates research progress. Reduced motion uses a static mark. Failure preserves the prompt and offers status recovery and an explicit retry where safe.

Each choice widget asks one clear question, shows detailed options and explains its recommendations. Recommendations are never preselected. Competitors have actual research sources and separate website links; audience options explain needs and fit; personality directions include traits and tone examples. Continue confirms selected options. The normal composer remains available for an answer in the user's own words, a refinement, or a clarification. A clear custom answer advances; a question receives an answer and stays at the same stage.

Selections and messages save automatically. Earlier choices remain in chronological history and may be revisited; changing an earlier decision invalidates downstream approvals while retaining historical answers and provider results. Reopening restores the same conversation and pending operation. Old projects are not billed automatically merely because they are opened.

## Contracts and orchestration

Optional versioned `intake.guidedInterview` state contains stage, user/automatic turn references, exact input revisions, and explicit answer records. It never accepts assistant prose from the browser. Assistant content comes exclusively from verified owned immutable job results, bound to the exact turn and revision. Legacy snapshots without this field remain valid.

A versioned guided handler and policy coexist with the legacy handler. API input version 2 freezes a bounded history of owned assistant results. Guided results distinguish choices, a question, an answer, and an accepted custom answer. Selected choices save existing canonical competitors, audience or personality fields. An accepted custom answer saves its interpreted decision and requests only the next stage's widget. Clarifications do not advance.

The account conversation owns orchestration and presents a unified timeline. It does not mount the old manual editor and provider-job dashboard together. Remove Strategy/Competitors markers, step counts, stage bar, details disclosures, context/review blocks, result-navigation bars, permanent provider/cost copy and Project context hint from this surface. Keep account controls in Settings/global navigation. The composer uses the approved 44×44 arrow send control.

## Runtime and integrity

All requests use the existing authenticated project API, exact workload identity and durable worker. Existing generation fencing, revision compare-and-swap, idempotency, cancellation, lease settlement and uncertain-outcome handling remain mandatory. The private testing mode requires an explicit per-operation database grant; it does not fund other accounts or signup cohorts. Each request retains a conservative validated reservation and tool/token limits. The installed mode is described in [guided interview runtime](../../guided-interview-runtime.md), not authorized by this specification.

Research requires observed search results and matching citations. An unavailable search operation is reported honestly; a loading animation is not evidence of successful research. No paid provider requests are needed for fixture verification. New policies and migrations require independent database checks before any runtime activation.

## Acceptance

- Initial prompt shows the original animated mark until the actual competitor job completes.
- Exactly one current decision widget; no preselected recommendations.
- Continue, free-text answer, clarification and refinement follow distinct correct paths.
- Completed personality ends this interview without silently adding Positioning.
- Reload, account switch, conflict, lost acknowledgement, cancellation and uncertain provider outcome retain their proper fences.
- Original project facts/history and unrelated tools remain readable.
- Desktop/mobile, keyboard and reduced-motion behavior are checked in an isolated browser.
