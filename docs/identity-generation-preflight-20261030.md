# Visual direction preflight repair — October 30, 2026

The first live Northline direction sets failed before any paid AI dispatch.
The selected logo was valid and Storage returned its original image successfully.
The preliminary `/responses/input_tokens` call rejected `service_tier` and other
generation-only settings. After projecting onto the supported request fields,
JSON mode also required the word JSON in an input message, not only instructions.

The common transport now uses the installed SDK's complete token-count field
list, preserving prompt content and leaving generation requests unchanged.
Selected-logo requests explicitly ask for a JSON object in their input message.
Historical v2 generation request bytes remain unchanged. Preflight diagnostics
contain only fixed stage/error classifications; no prompts, credentials or raw
provider errors are logged. Existing uncertain-paid-outcome handling is retained.

## Evidence

- Real count-only requests reproduced both 400 responses. The corrected request
  returned 200 with 2,527 input tokens.
- One isolated actual specification call completed and passed application
  validation. Its recorded usage is 26,956 micro-USD (US$0.026956), not an invoice
  reconciliation. It was not inserted into a customer job or presented as a board.
- All three failed Northline jobs were terminal, with no provider call records
  or receipts and zero recorded cost. No existing job was requeued or rewritten.
- 149 focused tests across nine files passed: transport HTTP boundaries, Identity
  producer/runtime, Strategy and vector-proposal callers. Typecheck and full lint
  passed; one existing unused-variable warning remains. Production build passed.
- Independent review found no blocking issues. The packaged worker passed all
  seven native checks on Node 22.22.2, including raster/vector, font shaping,
  PNG/PDF rendering and archive validation.

## Published release

- PR: [#170](https://github.com/mikaelcharbonneau/embel/pull/170).
- Source: `47e9ef78942a7998b27715988fc60f63fbf503c7`.
- Web: `dpl_5nqJSeVJscBgEojgn8jgXhef4kzW`.
- Shared worker: `dpl_C1fd6MAvpd1eVu52TBTwtMzukbPT`.
- Worker artifact: `0cd1b4f7d6dd9a8097cd294fdc41932e5a10b94ba316408ed5f2588becb8d9b8`.
- Naming owner binding: revision 9, `7651f6c5-8da9-4c88-9429-f29b002faa08`.

The prior worker was drained with zero active jobs/open executions, stopped, and
its database connections closed before switching the three deployment bindings.
Only source/artifact configuration values changed; all authority proofs, service
bindings and provider policies were retained and configuration readback matched.
The replacement has one ready daemon, all three lane leases and reachable core
services. No database schema migration was needed.

The previous compatible source remains recoverable through the same stopped
deployment cutover; do not overwrite admissions or receipts to force retries.
The owner's subsequent batch `362fe642-da70-487a-9b8f-04ff045cd617` succeeded in
their actual session: three distinct committed boards and six settled provider
receipts, with 170,487 micro-USD recorded usage. The selected logo remains current,
and persisted board/publication evidence passes read-only verification. This is
separate from the isolated specification call above.

The subsequent disabled-choice issue and web repair are recorded in the
[current release record](visual-identity-release-20261030.md). The owner later
selected Direction 3, with persisted selection readback, and confirmed that the
final asset package downloads and opens. The established checks do not prove
capacity for thousands of users.
