> **Archived November 9, 2026.** Historical record; it may not match the current code. Current architecture and plan: [architecture-review.md](architecture-review.md).

# Assets request lifetimes

Issue #39 bounds each private Assets HTTP request to 30 seconds, using the same
acknowledgment window as the existing bounded account request helper. This is a
client transport deadline, not a limit on durable jobs or provider execution.
The bound includes response headers, streamed bytes, preview queue wait and
SHA-256 verification. Aborting the transport is not sufficient on its own:
each asynchronous wait also observes the abort signal, including fixtures that
ignore fetch cancellation. Reader cancellation, listener/timer cleanup and
preview-slot release run on terminal paths. Late responses are discarded and
cancelled; late digests cannot create object URLs. Disposal also revokes URLs.

Read failures expose an actionable timeout while retaining the loaded window.
The pagination fix's complete-window refresh and query/account fences are
unchanged. A timed-out write is not described as unsaved or retried. Retention
and selection share a per-asset client fence after transport failure, timeout,
server error or an unverifiable response. Known HTTP rejections such as a 409
remain distinct. Fresh head-detail verification begun after uncertainty clears
the fence; reads begun before the timeout and history continuation reads cannot.
Library Check latest performs that explicit verification before refreshing its
complete loaded window. The detail dialog's existing Check latest read performs
the same verification. Revision checks still protect subsequent user mutations;
no client read claims to cancel a request still running on the server.

Verification is local synthetic coverage, not live acceptance. Focused tests
exercise never-resolving fetch, stalled streams, preview slot recovery, disposal,
late response suppression, both mutation types, failed recovery, pre-timeout
reads, acknowledged conflicts, loaded-window preservation and explicit recovery
without automatic mutation resend. No provider, database or deployment operation
is part of this change.
