> Archived November 10, 2026: describes the system before the generation engine.

# Logo brief freshness after scope or title changes

Expanding a Logo project to a complete brand, or changing its title, creates a
new project revision with the same saved context. The previous workspace helper
treated every revision-counter change as a changed brief. That incorrectly
blocked visual identity generation for an otherwise valid selected logo.

`20261030150000_logo_brief_context_freshness.sql` changes only that comparison.
The original brief's owned project revision and the current owned revision must
both exist, contain context objects, and have exactly equal full JSONB context.
An actual context change remains stale. Missing source/current records remain
stale even when their revision counters match. Context is neither normalized nor
invented; title and scope metadata do not substitute for context equality.

The migration preserves the function OID, signature, owner, ACL, security mode
and volatility. It writes no project, stage, brief, selection, approval, asset,
receipt or job records. It rejects an unexpected predecessor or a second apply.

- Migration SHA-256:
  `2eb0f22983fdde2f619afb44d19bd1e8e67fba9e270fe02726665b70a67063bf`
- Required original `logo_workspace_base_json(uuid,uuid)` prosrc SHA-256:
  `0b6e77b1f06716421cfd3706b32f7df5bb303d81c21b397703526831a7ab4fd0`
- Resulting prosrc SHA-256:
  `a7048b7df7505df2938c03823200a971254dbdedadfb9c2bc34d25376f6cef79`

This baseline helper is absent from the shared-worker authority manifest and
the web helper hash allowlists. No service binding, provider policy, session
gate or worker code changes. A worker rebuild or drain is unnecessary for this
SQL correction. Native PostgreSQL 17 installation with a NOSUPER CREATEROLE
installer replayed all 87 baseline migrations and the existing 15 shared packets;
the authority manifest stayed byte-identical at SHA-256
`9212afb1aedbc3fbf009c18175890a969928ba2f2505087dfe5188765d8bf049`
(291 functions, 269 worker functions).

Regression tests cover unchanged-context expansion/retitling, actual content
changes, missing source/current records, ownership, unchanged stage history and
admission of a v3 brand-board request with its original saved logo and real
context. They also check installer guards and unchanged security metadata.
These are isolated local tests; no live account or provider call is involved.

If rollback is necessary, restore the predecessor function body only after
checking the resulting hash above. The original definition is retained in
`20261006130000_logo_workspace_v2.sql` (renamed to `logo_workspace_base_json` by
the later stage migration). No history or data rollback is necessary.
