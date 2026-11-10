-- LOCAL REVIEW TEMPLATE ONLY. Do not execute without the separately reviewed
-- exact project/owner/phase approval. Target project: fricsfwqibyhemknqgyf.
-- Owner is derived internally from two confirmed historical signed-in QA projects.
-- Replace only non-secret reviewed phase evidence below; never expose owner/contact data.
begin;
do $activation$
declare
 v_project uuid := '17dd910a-a9cb-4999-aa0e-2b5aa141bb29'::uuid;
 v_second_project uuid := '850dba6b-6811-41a2-ab26-cd3248039574'::uuid;
 v_owner uuid;
 v_account public.usage_accounts;
 v_expected_external_floor bigint := 'REPLACE_REVIEWED_EXTERNAL_CHARGE_FLOOR_MICROUSD'::bigint;
 v_external_status text := 'REPLACE_EXTERNAL_USAGE_RECONCILIATION_STATUS';
 v_evidence text := 'REPLACE_RECONCILIATION_EVIDENCE_REFERENCE';
 v_captured numeric; v_actual numeric; v_reserved numeric;
begin
 if current_database()<>'postgres' then raise exception 'unexpected_database'; end if;
 select p.owner_id into v_owner from public.projects p
 join public.projects q on q.owner_id=p.owner_id and q.id=v_second_project
 where p.id=v_project and p.id<>q.id;
 if v_owner is null then raise exception 'verified_owner_project_anchor_mismatch'; end if;
 perform fluid_private.lock_strategy_owner(v_owner);
 select * into v_account from public.usage_accounts where owner_id=v_owner for update;
 if not found then
  -- Historical zero-API-cost subscription uncertainty is preserved and allowed.
  if v_external_status<>'REVIEWED_COMPLETE' or v_expected_external_floor<>0 or v_evidence like 'REPLACE_%' or length(v_evidence)<8
   or exists(select 1 from public.usage_reservations where owner_id=v_owner)
   or exists(select 1 from public.jobs where owner_id=v_owner and billing_mode='openai_api'
      and (reserved_cost_microusd>0 or actual_cost_microusd>0 or state='needs_reconciliation')) then
   raise exception 'missing_account_has_prior_or_unknown_paid_exposure'; end if;
  insert into public.usage_accounts(owner_id,limit_microusd) values(v_owner,5000000) returning * into v_account;
 end if;
 -- Existing accounts are read/validated only. No UPDATE or ON CONFLICT reset.
 if v_external_status<>'REVIEWED_COMPLETE' or v_expected_external_floor<0 or v_evidence like 'REPLACE_%' or length(v_evidence)<8 then
  raise exception 'complete_external_test_reconciliation_required'; end if;
 if exists(select 1 from public.jobs where owner_id=v_owner and billing_mode='chatgpt_subscription'
   and (reserved_cost_microusd<>0 or actual_cost_microusd<>0 or max_attempts<>1)) then raise exception 'subscription_zero_money_invariant_failed'; end if;
 select coalesce(sum(captured_microusd),0),coalesce(sum(actual_microusd),0),
   coalesce(sum(case when state='active' then reserved_microusd-captured_microusd else 0 end),0)
 into v_captured,v_actual,v_reserved from public.usage_reservations where owner_id=v_owner;
 if exists(select 1 from public.usage_reservations r join public.jobs j on j.id=r.job_id where r.owner_id=v_owner
   and (j.billing_mode<>'openai_api' or j.owner_id<>r.owner_id or j.project_id<>r.project_id
     or j.reserved_cost_microusd<>r.reserved_microusd or j.actual_cost_microusd<>r.actual_microusd
     or r.captured_microusd<>least(r.reserved_microusd,r.actual_microusd)
     or (r.state='settled' and j.state not in ('succeeded','failed','partial','cancelled'))
     or (r.state='active' and j.state in ('succeeded','failed','partial','cancelled')))) then raise exception 'reservation_job_reconciliation_mismatch'; end if;
 if exists(select 1 from public.jobs j where j.owner_id=v_owner and j.billing_mode='openai_api'
   and (j.reserved_cost_microusd>0 or j.actual_cost_microusd>0)
   and not exists(select 1 from public.usage_reservations r where r.job_id=j.id)) then raise exception 'unrepresented_paid_job'; end if;
 if v_account.owner_id is null or v_account.limit_microusd<>5000000
   or v_account.spent_microusd<>v_captured or v_account.provider_actual_microusd<>v_actual or v_account.reserved_microusd<>v_reserved
   or v_account.provider_actual_microusd<v_expected_external_floor
   or greatest(v_account.spent_microusd,v_account.provider_actual_microusd)+v_account.reserved_microusd>5000000 then
  raise exception 'shared_ledger_requires_reviewed_reconciliation'; end if;
 if fluid_private.api_text_paid_paused(v_owner) then raise exception 'unresolved_paid_api_outcome'; end if;
 if 5000000-greatest(v_account.spent_microusd,v_account.provider_actual_microusd)-v_account.reserved_microusd<122880 then raise exception 'insufficient_trial_balance'; end if;
end $activation$;
commit;
