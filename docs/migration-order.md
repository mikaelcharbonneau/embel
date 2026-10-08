# Database and vector-proposal migration handoff

This source upload does not apply SQL or activate a provider. Historical source filenames are not proof of hosted history. Reconcile the authorized target’s actual migration history before any rollout; do not blindly run a migration push or repair old version mappings. Use the existing reviewed Supabase CLI `migration new` process when the CLI and a separately authorized environment are available. No CLI was available while this vector-proposal bundle was assembled, so no dated migration was invented.

## New unapplied vector-proposal candidates

Apply each exact candidate once, in this predecessor order, only after separate review and authorization:

1. `supabase/candidates/logo-vector-proposals.sql`
2. `supabase/candidates/logo-vector-proposal-quotes.sql`
3. `supabase/candidates/logo-vector-proposal-admission.sql`
4. `supabase/candidates/logo-vector-proposal-observations.sql` (accepted v2)
5. `supabase/candidates/logo-vector-proposal-completion.sql`
6. `supabase/candidates/logo-vector-proposal-materialization.sql`
7. `supabase/candidates/logo-vector-proposal-capabilities.sql`

All 28 function-body predecessor guards were independently checked against the ordered local chain. Preserve those exact guards, OIDs, ACLs, transaction boundaries and historical migrations. Other candidates and activation templates are separate work; their presence is not an instruction to apply them.

The optional proposal operation remains disabled without an independently qualified policy, explicit configuration and approved provider route. The text worker receives no vector/font storage capability. Ordinary web UI setup must not install worker grants, provision credentials, apply migrations or authorize paid inference.

See the [approved logo/identity specification](superpowers/specs/2026-10-06-fluid-logo-visual-identity-approved.md), [bounded refinement plan](superpowers/plans/2026-10-08-vector-refinement.md) and [current verification limits](verification-status.md).
