-- REHEARSAL ONLY. Not an activation, production execution or global backfill.
-- On a separately approved disposable/restored database, supply one known run:
-- psql ... -v naming_run_id='<synthetic UUID>' -f this-file
-- Each run is locked in the existing owner -> run order. Never parallelize this
-- against live writers without the separately reviewed installation procedure.
\set ON_ERROR_STOP on
begin;
set local lock_timeout='1s';
set local statement_timeout='5s';
select fluid_private.lock_strategy_owner(owner_id)
from fluid_private.naming_brain_runs where id=:'naming_run_id'::uuid;
select id from fluid_private.naming_brain_runs where id=:'naming_run_id'::uuid for update;
select fluid_private.ensure_naming_brain_receipt_totals(:'naming_run_id'::uuid);
select t.run_id,t.receipt_count,t.receipt_bytes,actual.receipt_count actual_count,actual.receipt_bytes actual_bytes,
 t.receipt_count=actual.receipt_count and t.receipt_bytes=actual.receipt_bytes consistent
from fluid_private.naming_brain_receipt_totals t
cross join lateral(select count(*) receipt_count,coalesce(sum(octet_length(q.receipt::text)),0) receipt_bytes
 from fluid_private.naming_brain_receipts q where q.run_id=t.run_id) actual
where t.run_id=:'naming_run_id'::uuid;
rollback;
