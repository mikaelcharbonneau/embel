-- Receipt evidence stays append-only. Coalesce only an unchanged current
-- observation, returning its original timestamp; preserve every historical row.
-- Lazy per-run totals avoid a global history scan during this migration.
begin;
do $$ begin
 if not exists(select 1 from pg_catalog.pg_proc p
  where p.oid='public.record_naming_brain_provider_receipt(uuid,uuid,jsonb)'::regprocedure
  and md5(p.prosrc)='b9ddbf490a01d9c292229ec2ec483d54'
  and p.prosecdef and p.provolatile='v' and not p.proleakproof
  and p.proconfig=array['search_path=""']
  and p.proowner=(select oid from pg_catalog.pg_roles where rolname=current_user)) then
  raise exception 'unexpected_naming_receipt_state_predecessor';
 end if;
end $$;

do $$ declare signature text; expected text; begin
 for signature,expected in values
 ('public.naming_brain_worker_action(uuid,uuid,text,jsonb)','9034cfec034f833e6c8b05e91a06b355'),
 ('fluid_private.naming_brain_rejected_receipt(fluid_private.naming_brain_calls)','2b1e519dc80425114d3136cad0717560'),
 ('fluid_private.naming_brain_local_not_dispatched(fluid_private.naming_brain_calls,jsonb)','89debf21b5f744cb25e034fdd5e73ff6') loop
  if not exists(select 1 from pg_catalog.pg_proc p where p.oid=signature::regprocedure and md5(p.prosrc)=expected
   and p.proconfig=array['search_path=""'] and not p.proleakproof
   and p.proowner=(select oid from pg_catalog.pg_roles where rolname=current_user)) then
   raise exception 'unexpected_naming_receipt_reader_predecessor: %',signature;
  end if;
 end loop;
end $$;

create table fluid_private.naming_brain_receipt_totals (
 run_id uuid primary key, owner_id uuid not null, project_id uuid not null,
 receipt_count bigint not null check(receipt_count>=0), receipt_bytes bigint not null check(receipt_bytes>=0),
 foreign key(run_id,owner_id,project_id) references fluid_private.naming_brain_runs(id,owner_id,project_id) on delete cascade
);
alter table fluid_private.naming_brain_receipt_totals enable row level security;
alter table fluid_private.naming_brain_receipt_totals force row level security;
revoke all on table fluid_private.naming_brain_receipt_totals from public,anon,authenticated,service_role;
-- Insertion order is authoritative for new observations even when clocks tie or
-- move backwards. No timestamp is rewritten to manufacture that ordering.
create table fluid_private.naming_brain_receipt_current (
 run_id uuid not null, stage_key text not null, call_key text not null,
 receipt_id uuid not null references fluid_private.naming_brain_receipts(id) on delete cascade,
 primary key(run_id,stage_key,call_key),
 foreign key(run_id,stage_key,call_key) references fluid_private.naming_brain_calls(run_id,stage_key,call_key) on delete cascade
);
alter table fluid_private.naming_brain_receipt_current enable row level security;
alter table fluid_private.naming_brain_receipt_current force row level security;
revoke all on table fluid_private.naming_brain_receipt_current from public,anon,authenticated,service_role;

create function fluid_private.latest_naming_brain_receipt(p_run uuid,p_stage text,p_call text)
returns fluid_private.naming_brain_receipts language plpgsql stable set search_path='' as $$
 declare latest fluid_private.naming_brain_receipts; begin
 select q.* into latest from fluid_private.naming_brain_receipt_current current
 join fluid_private.naming_brain_receipts q on q.id=current.receipt_id
  and q.run_id=current.run_id and q.stage_key=current.stage_key and q.call_key=current.call_key
 where current.run_id=p_run and current.stage_key=p_stage and current.call_key=p_call;
 if found then return latest; end if;
 select * into latest from fluid_private.naming_brain_receipts
 where run_id=p_run and stage_key=p_stage and call_key=p_call order by created_at desc,id desc limit 1;
 return latest;
end $$;
revoke all on function fluid_private.latest_naming_brain_receipt(uuid,text,text) from public,anon,authenticated,service_role;

-- Called only with the existing Naming owner/job/run locks held. A missing row
-- means uninitialized, never zero historical usage. This is the sole history
-- aggregate, executed once per run, or explicitly in a bounded operator rehearsal.
create function fluid_private.ensure_naming_brain_receipt_totals(p_run uuid)
returns fluid_private.naming_brain_receipt_totals language plpgsql set search_path='' as $$
 declare totals fluid_private.naming_brain_receipt_totals; begin
 select * into totals from fluid_private.naming_brain_receipt_totals where run_id=p_run;
 if found then return totals; end if;
 insert into fluid_private.naming_brain_receipt_totals(run_id,owner_id,project_id,receipt_count,receipt_bytes)
 select r.id,r.owner_id,r.project_id,count(q.id),coalesce(sum(octet_length(q.receipt::text)),0)
 from fluid_private.naming_brain_runs r left join fluid_private.naming_brain_receipts q on q.run_id=r.id
 where r.id=p_run group by r.id,r.owner_id,r.project_id
 returning * into totals;
 if not found then raise exception 'naming_run_missing' using errcode='P0002'; end if;
 return totals;
end $$;

-- Cover every physical append, including old writer code and disposable bulk
-- fixture inserts. Uninitialized runs stay uninitialized until the locked scan.
-- Existing immutable-history triggers still prohibit UPDATE/DELETE.
create function fluid_private.track_naming_brain_receipt_totals()
returns trigger language plpgsql set search_path='' as $$
 begin
  update fluid_private.naming_brain_receipt_totals
  set receipt_count=receipt_count+1,receipt_bytes=receipt_bytes+octet_length(NEW.receipt::text)
  where run_id=NEW.run_id;
  insert into fluid_private.naming_brain_receipt_current(run_id,stage_key,call_key,receipt_id)
  values(NEW.run_id,NEW.stage_key,NEW.call_key,NEW.id)
  on conflict(run_id,stage_key,call_key) do update set receipt_id=excluded.receipt_id;
 return null;
end $$;
create trigger naming_brain_receipt_totals_after_write
after insert on fluid_private.naming_brain_receipts
for each row execute function fluid_private.track_naming_brain_receipt_totals();
revoke all on function fluid_private.ensure_naming_brain_receipt_totals(uuid),fluid_private.track_naming_brain_receipt_totals()
from public,anon,authenticated,service_role;

-- CREATE OR REPLACE preserves the existing function identity, owner and ACL.
create or replace function public.record_naming_brain_provider_receipt(p_job_id uuid,p_lease_token uuid,p_receipt jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
 declare r fluid_private.naming_brain_runs; c fluid_private.naming_brain_calls; previous jsonb; key text; digest text; previous_id uuid; replay jsonb;
 totals fluid_private.naming_brain_receipt_totals; begin
 r:=fluid_private.naming_brain_lock(p_job_id,p_lease_token);
 select * into c from fluid_private.naming_brain_calls where run_id=r.id and stage_key=p_receipt->>'stageKey' and call_key=p_receipt->>'providerCallKey';
 if not found or p_receipt->>'runId' is distinct from r.id::text or p_receipt->>'snapshotHash' is distinct from r.snapshot_hash
 or p_receipt->>'protocol' is distinct from 'openai_agents' or p_receipt->>'provider' is distinct from 'openai' or p_receipt->>'billingMode' is distinct from 'openai_api'
 or p_receipt->>'requestHash' is distinct from c.request->>'requestHash' or p_receipt->>'requestKey' is distinct from c.request->>'requestKey'
 or p_receipt->'assignmentKey' is distinct from c.request->'assignmentKey' or p_receipt->>'role' is distinct from c.request->>'role'
 or p_receipt->'sessionLimitCents' is distinct from c.request#>'{policy,sessionLimitCents}'
 or p_receipt->'budgetControl' is distinct from c.request#>'{policy,budgetControl}'
 or p_receipt->'localPipelineVersion' is distinct from c.request#>'{policy,localPipelineVersion}'
 or p_receipt->'providerSpendCapCents' is distinct from c.request#>'{policy,providerSpendCapCents}'
 or p_receipt->>'accountingStatus' is distinct from 'provisional' or p_receipt->'confirmedActualCostMicrousd' is distinct from 'null'::jsonb
 or (p_receipt->>'observedModel' is not null and p_receipt->>'observedModel'<>r.policy->>'model') then raise exception 'receipt_mismatch' using errcode='22023'; end if;
 digest:=encode(sha256(convert_to(p_receipt::text,'UTF8')),'hex');
 select receipt into replay from fluid_private.naming_brain_receipts
 where run_id=r.id and stage_key=c.stage_key and call_key=c.call_key and content_hash=digest;
 -- Exact historical replay acknowledges that immutable row, without regressing
 -- the current projection or synthesizing a new observation timestamp.
 if found then return replay; end if;
 select q.id,q.receipt into previous_id,previous from fluid_private.naming_brain_receipt_current current
 join fluid_private.naming_brain_receipts q on q.id=current.receipt_id
 where current.run_id=r.id and current.stage_key=c.stage_key and current.call_key=c.call_key;
 if not found then
  -- Existing history retains its legacy deterministic ordering at initialization.
  select id,receipt into previous_id,previous from fluid_private.naming_brain_receipts
  where run_id=r.id and stage_key=c.stage_key and call_key=c.call_key order by created_at desc,id desc limit 1;
  if found then
   insert into fluid_private.naming_brain_receipt_current(run_id,stage_key,call_key,receipt_id)
   values(r.id,c.stage_key,c.call_key,previous_id);
  end if;
 end if;
 foreach key in array array['sessionId','turnId','agentId','responseId'] loop
 if previous->>key is not null and previous->key is distinct from p_receipt->key then raise exception 'provider_identity_changed' using errcode='55000'; end if; end loop;
 -- Old snapshots must not erase already observed usage/identity sets. An exact
 -- old replay above is harmless; a newly timestamped regression is not current.
 foreach key in array array['callIds','artifactItemIds','usageObservations','providerCostCounters'] loop
  if not coalesce(p_receipt->key,'[]'::jsonb) @> coalesce(previous->key,'[]'::jsonb) then
   raise exception 'receipt_observation_regressed' using errcode='55000';
  end if;
 end loop;
 if exists(select 1 from jsonb_array_elements(coalesce(previous->'toolCalls','[]'::jsonb)) old_tool
  where old_tool->>'status' in('completed','failed') and not exists(
   select 1 from jsonb_array_elements(coalesce(p_receipt->'toolCalls','[]'::jsonb)) new_tool
   where new_tool-'providerItemId'=old_tool-'providerItemId'
   and(old_tool->>'providerItemId' is null or new_tool->'providerItemId'=old_tool->'providerItemId')))
 then raise exception 'receipt_observation_regressed' using errcode='55000'; end if;
 -- Deduplicate only against the latest call observation. A -> B -> A remains
 -- a durable transition; old hashes/rows and exact digest replay stay unchanged.
 if previous is not null and previous-'recordedAt'=p_receipt-'recordedAt' then return previous; end if;
 totals:=fluid_private.ensure_naming_brain_receipt_totals(r.id);
 if totals.receipt_count>=(case when fluid_private.local_naming_progressive_job(r.job_id) then 5000 else 500 end)
 or totals.receipt_bytes+octet_length(p_receipt::text)>(case when fluid_private.local_naming_progressive_job(r.job_id) then 67108864 else 8388608 end)
 then raise exception 'receipt_capacity' using errcode='22023'; end if;
 insert into fluid_private.naming_brain_receipts(run_id,owner_id,project_id,stage_key,call_key,receipt,content_hash)
 values(r.id,r.owner_id,r.project_id,c.stage_key,c.call_key,p_receipt,digest);
 if (p_receipt->'providerSpendCapCents' is not null or not fluid_private.naming_brain_unlimited_job(r.job_id))
 and exists(select 1 from jsonb_array_elements(coalesce(p_receipt->'providerCostCounters','[]')) x where (x->>'value')::bigint>(p_receipt->>'sessionLimitCents')::integer)
 then update fluid_private.naming_brain_runs set observed_overrun=true where id=r.id; end if;
 return p_receipt;
end $$;

-- Current selection also governs completion/rejection proof; raw history ordering
-- stays byte-for-byte unchanged in the existing response.
CREATE OR REPLACE FUNCTION fluid_private.naming_brain_rejected_receipt(c fluid_private.naming_brain_calls)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
 select exists(select 1 from lateral(
  select (fluid_private.latest_naming_brain_receipt(c.run_id,c.stage_key,c.call_key)).receipt receipt
 ) latest where latest.receipt->>'dispatchState'='not_dispatched'
 and latest.receipt->>'requestId' ~ '^req_[A-Za-z0-9_-]{1,196}$'
 and latest.receipt->>'requestHash'=c.request->>'requestHash' and latest.receipt->>'requestKey'=c.request->>'requestKey'
 and latest.receipt->>'providerCallKey'=c.call_key
 and latest.receipt->>'sessionId' is null and latest.receipt->>'turnId' is null and latest.receipt->>'agentId' is null and latest.receipt->>'responseId' is null
 and latest.receipt->'callIds'='[]'::jsonb and latest.receipt->'toolCalls'='[]'::jsonb and latest.receipt->'artifactItemIds'='[]'::jsonb
 and latest.receipt->'usageObservations'='[]'::jsonb and latest.receipt->'providerCostCounters'='[]'::jsonb
 and latest.receipt->>'accountingStatus'='provisional' and latest.receipt->>'confirmedActualCostMicrousd' is null
 and not exists(select 1 from fluid_private.naming_brain_receipts other where other.run_id=c.run_id and other.stage_key=c.stage_key and other.call_key=c.call_key
  and (other.receipt->>'dispatchState'<>'not_dispatched' or other.receipt->>'sessionId' is not null or other.receipt->>'turnId' is not null
   or other.receipt->>'responseId' is not null or other.receipt->'usageObservations'<>'[]'::jsonb or other.receipt->'providerCostCounters'<>'[]'::jsonb))
 and not exists(select 1 from fluid_private.naming_brain_provider_records records where records.run_id=c.run_id and records.stage_key=c.stage_key and records.call_key=c.call_key)
 and not exists(select 1 from fluid_private.naming_brain_artifacts a where a.run_id=c.run_id and a.stage_key=c.stage_key and a.artifact#>>'{providerReceipt,providerCallKey}'=c.call_key));
$function$;
CREATE OR REPLACE FUNCTION fluid_private.naming_brain_local_not_dispatched(c fluid_private.naming_brain_calls, p_output jsonb)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
 select c.request#>>'{policy,budgetControl}' is not distinct from 'local_unlimited_v1'
 and exists(select 1 from fluid_private.naming_brain_runs r where r.id=c.run_id and r.owner_id=c.owner_id and r.project_id=c.project_id
  and fluid_private.naming_brain_unlimited_job(r.job_id))
 and exists(select 1 from jsonb_array_elements(case when jsonb_typeof(p_output->'partialArtifacts')='array' then p_output->'partialArtifacts' else '[]'::jsonb end) proof
  join fluid_private.naming_brain_receipts saved on saved.run_id=c.run_id and saved.stage_key=c.stage_key and saved.call_key=c.call_key and saved.receipt=proof->'receipt'
  where proof->>'providerCallKey'=c.call_key and proof->>'status'='rejected_before_dispatch' and proof->>'code'='local_dispatch_not_attempted'
  and saved.receipt->>'budgetControl'='local_unlimited_v1' and saved.receipt->>'protocol'='openai_agents'
  and saved.receipt->>'dispatchState'='not_dispatched' and saved.receipt->>'requestId' is null
  and saved.receipt->>'requestHash'=c.request->>'requestHash' and saved.receipt->>'requestKey'=c.request->>'requestKey'
  and saved.receipt->>'providerCallKey'=c.call_key and saved.receipt->>'runId'=c.run_id::text and saved.receipt->>'stageKey'=c.stage_key
  and saved.receipt->>'observedModel' is null and saved.receipt->>'estimatedCostMicrousd' is null
  and saved.receipt->>'accountingStatus'='provisional' and saved.receipt->>'confirmedActualCostMicrousd' is null
  and saved.id=(fluid_private.latest_naming_brain_receipt(c.run_id,c.stage_key,c.call_key)).id)
 and not exists(select 1 from fluid_private.naming_brain_receipts other where other.run_id=c.run_id and other.stage_key=c.stage_key and other.call_key=c.call_key
  and (other.receipt->>'budgetControl' is distinct from 'local_unlimited_v1' or coalesce(other.receipt->>'dispatchState','') not in('not_dispatched','unknown')
   or other.receipt->>'requestId' is not null or other.receipt->>'sessionId' is not null or other.receipt->>'turnId' is not null
   or other.receipt->>'agentId' is not null or other.receipt->>'responseId' is not null or other.receipt->>'observedModel' is not null
   or other.receipt->'callIds' is distinct from '[]'::jsonb or other.receipt->'toolCalls' is distinct from '[]'::jsonb or other.receipt->'artifactItemIds' is distinct from '[]'::jsonb
   or other.receipt->'usageObservations' is distinct from '[]'::jsonb or other.receipt->'providerCostCounters' is distinct from '[]'::jsonb
   or other.receipt->>'estimatedCostMicrousd' is not null or other.receipt->>'confirmedActualCostMicrousd' is not null))
 and not exists(select 1 from fluid_private.naming_brain_provider_records pr where pr.run_id=c.run_id and pr.stage_key=c.stage_key and pr.call_key=c.call_key)
 and not exists(select 1 from fluid_private.naming_brain_artifacts a where a.run_id=c.run_id and a.stage_key=c.stage_key and a.artifact#>>'{providerReceipt,providerCallKey}'=c.call_key);
$function$;

create or replace function public.naming_brain_worker_action(p_job_id uuid,p_lease_token uuid,p_action text,p_payload jsonb default '{}')
returns jsonb language plpgsql security definer set search_path='' as $$
 declare result jsonb; stage jsonb; latest jsonb; begin
 if fluid_private.local_naming_progressive_job(p_job_id) then
  result:=fluid_private.local_naming_progressive_action(p_job_id,p_lease_token,p_action,p_payload);
 else result:=fluid_private.local_naming_previous_worker_action(p_job_id,p_lease_token,p_action,p_payload); end if;
 -- The unchanged delegate has already enforced role, ownership and lease.
 if p_action in('stage','progressive_state') then
  stage:=case when p_action='stage' then result else result->'stage' end;
  select coalesce(jsonb_agg(q.receipt order by requested->>'providerCallKey') filter(where q.id is not null),'[]'::jsonb)
  into latest from jsonb_array_elements(stage->'requests') requested
  cross join lateral fluid_private.latest_naming_brain_receipt(
   (select id from fluid_private.naming_brain_runs where job_id=p_job_id),
   stage->>'stageKey',requested->>'providerCallKey') q;
  stage:=stage||jsonb_build_object('currentReceipts',latest);
  if p_action='stage' then return stage; end if;
  return jsonb_set(result,'{stage}',stage);
 end if;
 return result;
end $$;

-- Honor hostile/default ACLs as well as the ordinary baseline. These are private
-- projections, with no new worker/browser privileges or ownership capabilities.
do $$ declare item record; privilege record; begin
 for item in select c.oid,c.relowner owner from pg_catalog.pg_class c
 where c.oid in('fluid_private.naming_brain_receipt_totals'::regclass,'fluid_private.naming_brain_receipt_current'::regclass) loop
  for privilege in select distinct a.grantee from pg_catalog.pg_class c,
   lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a where c.oid=item.oid and a.grantee<>item.owner loop
   execute format('revoke all on table %s from %s cascade',item.oid::regclass,
    case when privilege.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(privilege.grantee)) end);
  end loop;
 end loop;
 for item in select p.oid,p.proowner owner from pg_catalog.pg_proc p where p.oid in(
  'fluid_private.ensure_naming_brain_receipt_totals(uuid)'::regprocedure,
  'fluid_private.latest_naming_brain_receipt(uuid,text,text)'::regprocedure,
  'fluid_private.track_naming_brain_receipt_totals()'::regprocedure) loop
  for privilege in select distinct a.grantee from pg_catalog.pg_proc p,
   lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where p.oid=item.oid and a.grantee<>item.owner loop
   execute format('revoke all on function %s from %s cascade',item.oid::regprocedure,
    case when privilege.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(privilege.grantee)) end);
  end loop;
 end loop;
end $$;
commit;
