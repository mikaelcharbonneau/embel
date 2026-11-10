> Archived November 10, 2026: describes the system before the generation engine.

# Second terminal research recovery

Status: the lead applied the exact recovery on 2026-10-15 after a successful
native rollback rehearsal. No provider request was sent by the recovery.

The exact request is job `5f31a4ff-f747-4464-bc79-64b757fe5df3`, project
`4da54b89-43b8-4da6-a092-ce6113fd3916`, step
`a4794328-be5e-4c7e-a6b0-9a6f007e0f05`, for the existing approved testing owner.
It originally entered `needs_reconciliation` with one ambiguous step and no
active lease. It is now failed with `operator_abandoned_billing_unresolved`;
the original step remains ambiguous.
The saved output SHA-256 is
`2182808eb117289a1e340943063c4033fbaef6ff534c030965a20578353e3a6c`.

Native read-only inspection established these retained facts:

- The envelope status was `completed`. Output items were completed search,
  completed open-page, reasoning, searching search and completed assistant
  message. The sole output issue is `web_search_not_completed` at index 3.
- The admitted maximum was two tool calls. The old adapter counted three
  items and set `usageExceeded`. Observed usage is 25,693 input tokens, 711
  output tokens, 5,805 cache-write input tokens, zero cached-input tokens and
  two search calls. The recorded conservative cost is 81,399 microdollars.
- All 2,634 retained text characters form parseable JSON. Source observations
  are untruncated: 44 from the completed search, three from the unfinished
  search and three answer citations, representing 46 unique URLs.
- The first of three competitor options has neither its website nor its cited
  source in the completed-search evidence. The other two options are covered.
  A trailing-slash-tolerant comparison also fails for the first option.
- The original complete provider envelope was not stored. The diagnostic
  projection cannot reproduce every original field or prove a successful
  response under corrected validation.

The answer cannot safely be promoted. Discarding its first option or recreating
the original envelope from diagnostics would change the provider result and
invent successful validation. Its saved text, sources and usage remain useful
incident evidence, and stay unchanged.

The applied recovery extends the existing private operator-adjudication table
to exactly the original incident and this incident. One composite constraint
binds each job, project, step, output hash, source revision, adapter hash and
observed/retained costs. The insertion trigger selects between two literal
evidence tuples; there is no runtime incident-registration API. The existing
receipt matcher and account/rollout pause predicates remain byte-for-byte
unchanged. The original receipt remains immutable and valid.

The separate application packet recorded the lead's incident-specific operator
decision, referenced as
`operator-decision:lead-testing-account-recovery-20261015-5f31a4ff`.
This is an operator decision, not a claim of separate human approval or verified
provider billing. It changed only this job's state, error and completion time
and appended a receipt. It did not publish competitors, change the project
revision, settle usage, release funds, grant permissions or resend research.
The entire 15,811,481-microdollar outstanding hold remains active, alongside the
first incident's 15,818,215 hold: 31,629,696 total. Both steps retain their
ambiguous state, provider identifiers, output and original observed charges.
Billing remains unresolved. Replacement research requires an explicit user
request and the normal admission gates.

The reviewed source is `4c0bbf362e8c85132f9d5068ec25dc771ef5cd5b`; the adapter
SHA-256 is `d37e4c528334e7099d042d835d2cebc75cc06d214c2b52deb3299e38441888a9`.
The lead confirmed worker deployment `dpl_dH4b38QkzS5sQnFDuYHZgsVv84Jy`
and bundle manifest `78ebc28014988d83371cd7b12de7900243f01e6a0b679acea88c0263501cf342`.

Candidate installation and application are
`supabase/candidates/research_operator_abandonment_5f31a4ff.sql` and
`supabase/candidates/research_operator_abandonment_5f31a4ff_apply.sql`.
The cached Supabase CLI generated canonical migration
`20261015020136_second_terminal_research_operator_adjudication.sql`; it contains
the identical reviewed installation SQL. Its application still creates no
adjudication until the separate decision packet runs.
The hosted migration version is `20261015020240`; the receipt was recorded at
`2026-10-15T02:02:46.362563+00:00`. Native read-back confirms both receipt matches
are true, both pause predicates are false, and the full account ledger and
runtime/admission configuration match the pre-recovery snapshot. The source
migration SHA-256 is
`e1da054945588e8464888a91a15a023f109837fa46383f7816d2d422dfdc67d6`.
The local extension suite uses disposable synthetic data and preserves a prior
adjudication while testing installation, exact-row rejection, immutable
evidence, retained holds, unchanged security, new ambiguity/overrun blocking,
late completion rejection and explicit new admission. It does not substitute
for native qualification or establish provider billing.
