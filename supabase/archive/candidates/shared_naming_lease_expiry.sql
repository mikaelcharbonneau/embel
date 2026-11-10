-- UNAPPLIED. Expired Naming leases on the shared worker pool.
-- Requires shared_naming_brainstorm_delivery_recovery.sql.
--
-- A shared Naming job whose worker stopped (crash, restart, sleep) kept its
-- expired lease and stayed "running" indefinitely: the shared Naming gateway
-- had no counterpart of the per-owner expire_naming_brain_leases or the shared
-- Strategy "expire" action. This adds one slot-level action, "expire".
--
-- It never creates, resumes, dispatches or settles a possibly paid request:
--  * a brainstorm call that may have reached the provider (not completed or
--    rejected, or completed but unpublished) makes the job needs_reconciliation
--    with provider_outcome_unknown, exactly as brainstorm_finish does; its
--    execution is parked for observation and its hold stays open;
--  * a job with no dispatch evidence returns to the queue within its attempt
--    limit, or ends cancelled/failed, and only then is its zero-spend hold settled;
--  * a brainstorm job whose calls are all terminal and published returns to the
--    queue, where the existing handler publishes, tops up or finishes it.
begin;
set local lock_timeout='2s';
set local statement_timeout='30s';
do $guard$
begin
 if current_user<>'postgres' or session_user<>current_user
  or to_regprocedure('fluid_private.recover_naming_brainstorm_delivery(jsonb,jsonb,jsonb)') is null
  or to_regprocedure('fluid_private.expire_shared_naming_leases(jsonb,jsonb)') is not null
 then raise exception 'shared_naming_lease_expiry_prerequisite' using errcode='55000'; end if;
 -- Both exact released gateways after delivery recovery: with and without the
 -- event-capacity correction, which this packet preserves when present.
 if not exists(select 1 from pg_proc p where p.oid=to_regprocedure('public.shared_naming_worker_action(jsonb,jsonb,text,jsonb)')
  and encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=any(array['1a044e660bde27bf2d16cb3acce55fbe3e4f6bb88ada104ef354cc9b39c58d4f','c0dd10c70fa62f5d9f7551c1c34443e53b9a0a398293249805eb30e80211e598'])
  and p.proowner='postgres'::regrole and p.proconfig=array['search_path=""'] and p.prosecdef and p.provolatile='v' and not p.proleakproof)
 then raise exception 'shared_naming_lease_expiry_predecessor_mismatch' using errcode='55000'; end if;
end $guard$;

create function fluid_private.expire_shared_naming_leases(p_slot jsonb,p_args jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s fluid_private.shared_worker_slots; j public.jobs; r fluid_private.naming_brain_runs; h fluid_private.naming_brain_heads;
 candidate record; next_state text; old_lease uuid; brainstorm boolean; dispatched boolean; unresolved boolean; n integer:=0;
begin
 if jsonb_typeof(p_args) is distinct from 'array' or jsonb_array_length(p_args)<>2
  or jsonb_typeof(p_args->0) is distinct from 'string' or length(p_args->>0) not between 1 and 100
 then raise exception 'invalid_shared_naming_expiry' using errcode='22023'; end if;
 s:=fluid_private.lock_shared_worker_slot(p_slot,true);
 if s.lane<>'naming' or p_args->>1 is distinct from s.deployment_id then raise exception 'shared_lane_mismatch' using errcode='42501'; end if;
 -- Only jobs admitted to this slot's deployment and approved policy, as claim.
 for candidate in select jj.id,jj.owner_id from fluid_private.shared_job_admissions a join public.jobs jj on jj.id=a.job_id
  join fluid_private.shared_worker_policies policy on policy.slot_id=s.slot_id and policy.operation=a.operation
  where a.lane='naming' and a.deployment_id=s.deployment_id and a.policy_identity=policy.policy_identity and a.policy=policy.policy
  and fluid_private.shared_naming_job(a.job_id) and jj.state in('running','cancel_requested') and jj.lease_expires_at<=clock_timestamp()
  order by jj.lease_expires_at,jj.id limit 20 loop
  -- Owner before job row, as the brainstorm actions take them.
  perform pg_advisory_xact_lock(hashtextextended('embel-shared:naming:'||candidate.owner_id::text,0));
  perform fluid_private.lock_strategy_owner(candidate.owner_id);
  select * into j from public.jobs where id=candidate.id for update;
  if not found or j.state not in('running','cancel_requested') or j.lease_expires_at>clock_timestamp() then continue; end if;
  select * into strict r from fluid_private.naming_brain_runs where job_id=j.id for update;
  old_lease:=j.lease_token;
  brainstorm:=fluid_private.naming_brainstorm_job(j.id);
  if brainstorm then
   select * into strict h from fluid_private.naming_brain_heads where project_id=r.project_id and owner_id=r.owner_id for update;
   dispatched:=exists(select 1 from fluid_private.naming_brainstorm_calls call where call.run_id=r.id);
   -- The same unresolved-call condition as brainstorm_finish.
   unresolved:=exists(select 1 from fluid_private.naming_brainstorm_calls call where call.run_id=r.id and (fluid_private.naming_brainstorm_call_state(call)->>'state' not in('completed','rejected')
    or fluid_private.naming_brainstorm_call_state(call)->>'state'='completed' and jsonb_array_length(fluid_private.naming_brainstorm_call_state(call)->'candidates')>0
     and not exists(select 1 from fluid_private.naming_brainstorm_publications pub where pub.call_id=call.call_id)));
   next_state:=case when unresolved then 'needs_reconciliation'
    when not dispatched and (j.cancel_requested_at is not null or h.paused or r.superseded) then 'cancelled'
    when j.attempts<j.max_attempts and not r.superseded then 'queued'
    when not dispatched then 'failed' else 'needs_reconciliation' end;
  else
   -- The earlier multi-stage pipeline: any step or call is possible dispatch.
   dispatched:=exists(select 1 from public.job_steps where job_id=j.id)
    or exists(select 1 from fluid_private.naming_brain_calls c where c.run_id=r.id);
   next_state:=case when dispatched then 'needs_reconciliation'
    when j.cancel_requested_at is not null or r.superseded then 'cancelled'
    when j.attempts<j.max_attempts then 'queued' else 'failed' end;
  end if;
  update public.jobs set state=next_state,lease_token=null,lease_expires_at=null,
   error_code=case when next_state='needs_reconciliation' then 'provider_outcome_unknown' when next_state='queued' then error_code else 'lease_expired' end,
   finished_at=case when next_state in('cancelled','failed') then clock_timestamp() else null end
   where id=j.id returning * into j;
  update fluid_private.naming_brain_runs set revision=revision+1,updated_at=clock_timestamp(),
   recovery_mode=case when next_state='needs_reconciliation' then 'observe_only' else recovery_mode end where id=r.id;
  if next_state in('cancelled','failed') then
   if brainstorm and not exists(select 1 from fluid_private.naming_brainstorm_completions where run_id=r.id) then
    insert into fluid_private.naming_brainstorm_completions(run_id,owner_id,project_id,published_count,state) values(r.id,r.owner_id,r.project_id,0,next_state);
   end if;
   -- No dispatch evidence: the held allowance is released as zero spend.
   perform fluid_private.settle_reservation(j.id);
  end if;
  -- The expired lease already fences a delayed old handler. Observation keeps
  -- an unknown outcome's execution; every other outcome closes it.
  if next_state='needs_reconciliation' then
   update fluid_private.shared_worker_executions set state='observing' where job_id=j.id and lease_token=old_lease and state='active';
  else
   update fluid_private.shared_worker_executions set state='closed',closed_at=clock_timestamp() where job_id=j.id and lease_token=old_lease and state<>'closed';
  end if;
  n:=n+1;
 end loop;
 return jsonb_build_object('execution',null,'result',n);
end $$;

-- Route the slot-level action from the reviewed gateway, without rewriting
-- any other branch. The insertion point must exist exactly once.
do $install$
declare body text; definition text; needle text; replacement text;
begin
 select prosrc into body from pg_proc where oid='public.shared_naming_worker_action(jsonb,jsonb,text,jsonb)'::regprocedure;
 definition:=pg_get_functiondef('public.shared_naming_worker_action(jsonb,jsonb,text,jsonb)'::regprocedure);
 needle:=$needle$ if p_action='brainstorm_recover_delivery' then return fluid_private.recover_naming_brainstorm_delivery(p_slot,p_execution,p_args);end if;$needle$;
 replacement:=$replacement$ if p_action='expire' then
  if p_execution is not null then raise exception 'invalid_shared_naming_expiry' using errcode='22023';end if;
  return fluid_private.expire_shared_naming_leases(p_slot,p_args);
 end if;
 if p_action='brainstorm_recover_delivery' then return fluid_private.recover_naming_brainstorm_delivery(p_slot,p_execution,p_args);end if;$replacement$;
 if (length(body)-length(replace(body,needle,'')))/length(needle)<>1 then raise exception 'shared_naming_lease_expiry_gateway_mismatch';end if;
 execute replace(definition,body,replace(body,needle,replacement));
end $install$;

do $acl$
declare grant_row record;
begin
 revoke all on function fluid_private.expire_shared_naming_leases(jsonb,jsonb) from public,anon,authenticated,service_role;
 for grant_row in select distinct a.grantee from pg_proc p,lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
  where p.oid='fluid_private.expire_shared_naming_leases(jsonb,jsonb)'::regprocedure and a.grantee<>p.proowner and a.grantee<>0 loop
  execute format('revoke all on function fluid_private.expire_shared_naming_leases(jsonb,jsonb) from %I',pg_get_userbyid(grant_row.grantee));
 end loop;
end $acl$;
commit;
