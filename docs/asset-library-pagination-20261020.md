> **Archived November 9, 2026.** Historical record; it may not match the current code. Current architecture and plan: [architecture-review.md](architecture-review.md).

# Asset library loaded-window reconciliation

Issue: [#34](https://github.com/mikaelcharbonneau/embel/issues/34).

The asset collection previously replaced every loaded page with the first
40 rows after Check assets, a like/save, or a version selection. The repaired
client re-reads from the first page through the oldest previously loaded
`createdAt`/asset-ID position. It uses freshly returned, filter-bound cursors
instead of replaying old page boundaries. Newly inserted head rows cannot push
previously loaded cards out of the view. Deleted or no-longer-matching cards are
removed by the successful reconciliation.

The complete refreshed window is published atomically. Existing cards remain
mounted during the read and on failure, preserving their private-preview
identity and ordinary scroll context. Likes/saves update only acknowledged
retention flags; neutral mutation responses never replace filtered version
metadata. A failed save does not invent a successful flag change and requires a
fresh successful check before another retention write.

Reads are abortable, account-generation fenced and sequence fenced. Changing
project, format or tab starts a new window; no metadata or image cache crosses
that boundary. Load-more cancellation has its own operation identity, so a late
response or cleanup cannot replace a newer view or unlock another write.
Refresh traversal requires advancing cursors and is bounded to the previously
loaded page depth plus ten pages. If unusually large head churn exceeds that
budget, the old view remains visible with a retry/new-filter explanation rather
than publishing a truncated result. Timestamp ordering retains sub-millisecond
precision.

Focused synthetic tests cover 80+ loaded rows, likes and saves, new head rows,
deleted boundary rows, changed metadata, real end cursors, partial refresh
failure, failed/uncertain writes, query and account-generation changes,
out-of-order replies, write serialization, deduplication and bounded traversal.
They are local contract evidence, not live database or provider verification.
No API, schema, provider, storage, presentation or private-preview contract is
changed.
