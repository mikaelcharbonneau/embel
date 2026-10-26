-- Additive lookup indexes only. Retained evidence, hashes, functions, ownership,
-- accounting and execution authority are unchanged, including historical runs.
-- Ordinary index builds take table write locks: this bounded transaction must
-- be rehearsed and separately approved before any held production release.
begin;
set local lock_timeout = '3s';
set local statement_timeout = '30s';

create index naming_brain_artifacts_run_stage_order
 on fluid_private.naming_brain_artifacts(run_id,stage_key,id);
create index naming_brain_stage_results_run_stage_order
 on fluid_private.naming_brain_stage_results(run_id,stage_key,created_at,id);
create index naming_brain_feed_entries_run
 on fluid_private.naming_brain_feed_entries(run_id);
-- Exact equality keys precede the latest-receipt order. Do not copy receipt JSON
-- into the index; the existing immutable content-hash replay index is retained.
create index naming_brain_receipts_call_latest
 on fluid_private.naming_brain_receipts(run_id,stage_key,call_key,created_at desc,id desc);

commit;
