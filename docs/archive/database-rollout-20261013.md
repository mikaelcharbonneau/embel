> Archived November 10, 2026: describes the system before the generation engine.

> **Archived November 9, 2026.** Historical record; it may not match the current code. Current architecture and plan: [architecture-review.md](../architecture-review.md).

# Database rollout — 2026-10-13

The user authorized the database changes needed to proceed toward the production rollout. The lead applied eight reviewed migrations to the existing Supabase project `fricsfwqibyhemknqgyf` between 19:07 and 19:08 UTC. All eight succeeded; hosted history now contains 42 entries, preserving its previous 34 entries.

## Applied source and hosted history

Hosted versions are assigned by the migration service. Historical local filenames already differ from hosted versions: this mapping is authoritative for this rollout. Do not blindly run `supabase db push`, repair historical versions, or reapply a candidate that has already been promoted.

| Local migration | Hosted version | Purpose |
| --- | --- | --- |
| `20261008033000_workspace_business_conflict_codes.sql` | `20261013190737` | Return application conflicts without requesting serialization retries. |
| `20261008043000_api_strategy_budget_status.sql` | `20261013190740` | Distinguish unavailable budget from unavailable runtime; required before multi-account installation. |
| `20261013035222_account_profiles.sql` | `20261013190758` | Owned profile preferences and revision-controlled updates. |
| `20261013120000_project_inspiration.sql` | `20261013190800` | Immutable catalog and owned project likes. |
| `20261013140801_reviewed_visual_direction.sql` | `20261013190802` | Reviewed visual guidance, frozen generation inputs and stale-result fencing. |
| `20261013190225_project_screening.sql` | `20261013190804` | Owned, explicitly user-recorded screening history. |
| `20261013190229_standalone_ai_names.sql` | `20261013190805` | Durable standalone Names jobs and shared subscription quotas. |
| `20261013190236_api_text_multi_account.sql` | `20261013190811` | Disabled multi-account allowance and restricted dispatch gateway. |

The three new versioned filenames were generated with the official Supabase CLI 2.120.0. Their contents are byte-identical to the frozen candidates. Candidates remain as review provenance; ordinary migration replay installs the versioned copy once. Historical API tests explicitly stop before the multi-account upgrade so predecessor guards remain strict. The budget-status test compares the complete catalog immediately across its own historical patch, excluding later feature migrations.

## Verification

- Replayed all 40 local migrations on disposable PostgreSQL 17, with Supabase-style default public grants. The five live visual-direction predecessors matched this chain in body hashes and security metadata before installation. The API migration's four exact predecessor guards also matched after the budget-status fix.
- All 53 affected hosted function bodies, owners, execution modes, search paths and ACLs match the native rehearsal.
- All 12 new account/runtime tables enforce and force RLS. None grants anonymous access or raw access to the existing workers. Profile writes retain their narrow authenticated column grants; other writes use owner-checking RPCs.
- A hosted read-only transaction under `authenticated`, with no authenticated user claim, passed the project/profile RLS and new read-RPC rejection checks. Local tests exercise positive saves, cross-account isolation and stale revisions using synthetic accounts. No hosted test accounts or customer writes were used.
- Existing project/job/asset counts and fingerprints of usage limits, API policy, API bindings and both worker-principal mappings are unchanged.
- Multi-account rollout remains disabled, with zero limits and no cohorts, entitlements, admissions or gateway contexts. Standalone Names has no enabled/runtime rows or jobs. No new worker RPC grants were installed. The existing availability helper remains private; the authenticated app uses `get_strategy_availability`.
- Eighteen native concurrency/worker-isolation tests passed against the full combined sequence. Another 157 distinct SQL/worker regressions passed across the initial run and corrected historical-fixture rerun, for 175 distinct checks. The initial run had one catalog-comparison failure; the first rerun hit its unchanged setup timeout; the final isolated historical suite passed all 25 tests. All original logs are retained. Global typecheck, lint and production build passed.

Security-advisor changes match the intended schema: seven new RPC-only/private tables appear in the [RLS-without-policy advisory](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy), and eleven intentional owner-checking RPCs appear in the [authenticated definer advisory](https://supabase.com/docs/guides/database/database-linter?lint=0029_authenticated_security_definer_function_executable). These tables have no caller table grants. No additional anonymous definer exposure appeared. The pre-existing Auth password-protection advisory is unchanged; this rollout did not change Auth configuration.

## Release boundary

These changes clear the database prerequisite for the integrated application checkpoint `af0660696b9283bc9162b0055a2b8173dade81ff` in PR #11. Production application promotion is a separate step and must use a build with Production environment variables and its canonical origin. The protected preview already uses the integrated application source.

Hosted worker publication/trust and configuration, email confirmation delivery, and any separately funded multi-account activation still require their own readiness verification. Installing these tables does not establish successful provider inference. The separately reviewed vector-proposal candidate chain remains unapplied; whole-system Identity generation and final export are not established by this rollout.

Non-secret preflight, source SHA-256 hashes, individual apply results, hosted history, catalog comparison, advisor delta and test/build logs are retained at `/workspace/scratch/fluid-database-rollout-20261013/`.
