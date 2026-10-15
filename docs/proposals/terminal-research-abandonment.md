# Terminal research recovery

Status: the exact-request mechanism and adjudication were applied on 2026-10-15.

The reported competitor request returned a completed provider envelope but failed
output-item validation. Its saved partial contains structured text and observed
usage, but lacks the original rejected item, total tool count and source evidence.
It cannot be promoted to a successful result or treated as fully reconciled
billing. By default, the runtime pauses new requests while that ambiguity exists;
the exact reviewed exception below preserves the hold while permitting new work.

The operator action is limited to the exact reported request. It:

- Marks that unusable answer failed so the conversation can offer an explicit
  fresh request. It neither accepts the competitors nor advances the interview.
- Preserves the original ambiguous step, output, provider identifiers, observed
  usage, dispatch, admissions and project revision without modification.
- Retains the entire outstanding financial reservation as active. No actual
  charge is invented, no money is released, and billing remains unresolved.
- Appends an immutable private adjudication binding the precise original records
  and reason. No client, worker or service-role adjudication capability is added.
- Exempts only that matching, operator-reviewed terminal request from the new-work
  pause. A changed record, another ambiguous request or an overrun still blocks.
  Normal ownership, eligibility, per-request limits and one-active-request checks
  remain in force.
- Sends no provider request. Starting replacement research requires a separate
  explicit user action in the conversation.

This is a change to the current handling of unresolved billing, not evidence that
the rejected answer or its total cost has been verified. Existing approval for
ongoing testing funds normal requests; it does not by itself prove an ambiguous
historical charge. The lead made that deliberate operator decision under the
user's existing testing-account repair authorization and reported production
blocker. Its reference is
`operator-decision:lead-testing-account-recovery-20261015-6b310a38`;
it does not claim a separate human approval or successful research verification.
Local database tests, independent technical review and two exact native rollback
rehearsals passed before application.

The source migration is
`20261015011434_terminal_research_operator_adjudication.sql`, SHA-256
`e0f057da78e1edfeccd07796f9b59881257eb95c86db11c4c0de3d05452f7ca1`.
Hosted migration version is `20261015011955`. The separate guarded application
changed only the job state, error and completion time and appended its receipt.
Read-back confirms the original step/output, project revision and complete
account ledger are unchanged, the 15,818,215-microdollar outstanding hold remains
active, and the exact receipt removes the account/rollout pause. No inference,
settlement, refund or new authority was performed. These are incident-recovery
facts, not verification of the unavailable provider envelope.

Validation covers 142 distinct focused provider/worker/database checks and four
desktop/mobile failure/reload/explicit-retry checks. The browser fixtures
intercept all APIs and assert no external requests or unhandled writes. Both
the web production build and the seven-file worker production build pass.

The diagnostic change in `src/server/ai/strategy-response.ts` separately preserves
bounded rejection details and source observations for future investigation. It
does not automatically reconcile or retry historical requests.
