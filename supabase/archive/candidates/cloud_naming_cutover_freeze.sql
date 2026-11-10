-- PROPOSED OPERATOR PACKET. Do not execute before the cloud hosting and existing
-- credential-transfer approval recorded in docs/cloud-naming-worker-20261019.md.
-- Target only Supabase project fricsfwqibyhemknqgyf. This packet does not provision
-- a service, read a secret, grant privileges, or change a request/accounting row.
-- First let current Naming work settle. After this transaction succeeds, stop
-- every Mac Naming supervisor/process before cloud preflight and enablement.
-- An expired connector response is not a failure: read back, then retry this
-- identical packet. Only the exact already-frozen state is a successful replay.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
set local search_path = '';
do $freeze$
declare
 p fluid_private.naming_brain_pilots;
 c fluid_private.hosted_naming_capabilities;
begin
 perform fluid_private.lock_strategy_owner('6840f4c2-15a6-45a7-97be-41e7e5e37f42');
 select * into strict p from fluid_private.naming_brain_pilots
 where id='742aefc5-b222-48a6-8ee6-668f818d3c2a'
 and owner_id='6840f4c2-15a6-45a7-97be-41e7e5e37f42' for update;
 if p.role_name is distinct from 'fluid_naming_brain_worker'::name
 or p.role_oid is distinct from 23033::oid
 or p.deployment_id is distinct from 'embel-naming-local-b2ff6ce8bbc2-20261017'
 or encode(sha256(convert_to(p.policy::text,'UTF8')),'hex') is distinct from '76ceb803800e70c800d7a352f8cb8bcc1621f691fec21ebb197028fefde53176'
 or p.policy->>'model' is distinct from 'gpt-6-luna'
 or p.policy->>'reasoningEffort' is distinct from 'xhigh'
 or p.policy->>'protocol' is distinct from 'openai_agents'
 or p.readiness_fingerprint is distinct from '{"version":1,"normalizer":"naming-preferences-v1:nfc-lower-nfc","implementationHash":"7108319323898692a388fcf17cb542509583288b0d4b05d7384f8c5b707aeb01","nodeVersion":"22.22.2","icuVersion":"78.2","unicodeVersion":"17.0"}'::jsonb
 or not fluid_private.api_text_restricted_role(p.role_name,p.role_oid)
 or not exists(select 1 from pg_catalog.pg_roles where oid=p.role_oid and rolname=p.role_name and rolconnlimit=4)
 then raise exception 'cloud_naming_binding_mismatch'; end if;

 select * into strict c from fluid_private.hosted_naming_capabilities
 where id='fa818f06-6bad-4a7f-a585-1af332263215' and owner_id=p.owner_id for update;
 if (c.pilot_id,c.role_name,c.role_oid,c.deployment_id,c.policy_identity,c.execution_authority) is distinct from
 (p.id,p.role_name,p.role_oid,p.deployment_id,encode(sha256(convert_to(p.policy::text,'UTF8')),'hex'),'hosted_owner_v1'::text)
 then raise exception 'cloud_naming_capability_mismatch'; end if;

 -- Check the owner's Naming work, including older logical deployments. An
 -- expired but uncleared lease is not permission to interrupt an unknown worker.
 if exists(select 1 from public.jobs j where j.owner_id=p.owner_id and j.operation='naming.generate'
 and (j.state in('running','cancel_requested') or j.lease_token is not null or j.lease_expires_at is not null
 or (j.state='queued' and j.cancel_requested_at is not null)))
 then raise exception 'cloud_naming_active_work'; end if;

 -- A recent authorization might be between the durable authorization and the
 -- provider create acknowledgement even when its lease has been cleared. The
 -- request's original deadline plus 30 seconds of settlement grace must pass.
 -- Older needs_reconciliation calls remain UNRESOLVED: age is not terminal proof,
 -- a refund, or permission to resend. Their saved rows and deadlines are intact.
 if exists(select 1 from fluid_private.naming_brain_calls call
 join fluid_private.naming_brain_runs run on run.id=call.run_id and run.owner_id=call.owner_id
 join public.jobs job on job.id=run.job_id and job.owner_id=run.owner_id
 where call.owner_id=p.owner_id and fluid_private.naming_brain_call_terminal(call) is distinct from true
 and (job.state<>'needs_reconciliation' or case
 when call.request#>>'{policy,deadlineMs}' in('240000','900000') then
 call.authorized_at+make_interval(secs=>(call.request#>>'{policy,deadlineMs}')::integer/1000)+interval '30 seconds'>clock_timestamp()
 else true end))
 then raise exception 'cloud_naming_pending_provider_outcome'; end if;

 if not p.enabled and not c.enabled and p.worker_id is null and p.ready_until is null then
 raise notice 'cloud_naming_already_frozen';
 return;
 end if;
 if not p.enabled or not c.enabled then raise exception 'cloud_naming_unexpected_freeze_state'; end if;

 update fluid_private.naming_brain_pilots set enabled=false,worker_id=null,ready_until=null where id=p.id;
 update fluid_private.hosted_naming_capabilities set enabled=false where id=c.id;
 raise notice 'cloud_naming_frozen';
end $freeze$;
commit;

-- Read-back contains only the exact operational bindings and readiness state.
select p.id as pilot_id,p.owner_id,p.enabled as pilot_enabled,c.enabled as hosted_enabled,
 p.worker_id,p.ready_until,p.role_name,p.role_oid,p.deployment_id,p.readiness_fingerprint,
 encode(sha256(convert_to(p.policy::text,'UTF8')),'hex') as policy_identity
from fluid_private.naming_brain_pilots p join fluid_private.hosted_naming_capabilities c on c.pilot_id=p.id and c.owner_id=p.owner_id
where p.id='742aefc5-b222-48a6-8ee6-668f818d3c2a' and c.id='fa818f06-6bad-4a7f-a585-1af332263215'
and p.owner_id='6840f4c2-15a6-45a7-97be-41e7e5e37f42';
