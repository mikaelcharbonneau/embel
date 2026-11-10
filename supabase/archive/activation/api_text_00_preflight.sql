-- LOCAL REVIEW TEMPLATE ONLY. Do not execute without the separately reviewed
-- exact project/owner/phase approval. Target project: fricsfwqibyhemknqgyf.
-- Owner is derived internally from two confirmed historical signed-in QA projects.
-- Replace only non-secret reviewed phase evidence below; never expose owner/contact data.
begin read only;
do $activation$
declare
 v_project uuid := '17dd910a-a9cb-4999-aa0e-2b5aa141bb29'::uuid;
 v_second_project uuid := '850dba6b-6811-41a2-ab26-cd3248039574'::uuid;
 v_owner uuid;
begin
 if current_database()<>'postgres' then raise exception 'unexpected_database'; end if;
 select p.owner_id into v_owner from public.projects p
 join public.projects q on q.owner_id=p.owner_id and q.id=v_second_project
 where p.id=v_project and p.id<>q.id;
 if v_owner is null then raise exception 'verified_owner_project_anchor_mismatch'; end if;
 if to_regprocedure('public.claim_api_text_job(uuid,text,integer,text,text)') is null then raise exception 'reviewed_schema_missing'; end if;
end $activation$;
with a as (
 select p.owner_id from public.projects p
 join public.projects q on q.owner_id=p.owner_id and q.id='850dba6b-6811-41a2-ab26-cd3248039574'::uuid
 where p.id='17dd910a-a9cb-4999-aa0e-2b5aa141bb29'::uuid and p.id<>q.id
)
select jsonb_build_object(
 'verifiedProjectAnchorsMatch',true,
 'route',(select jsonb_build_object('billingMode',r.billing_mode,'revision',r.revision) from fluid_private.strategy_billing_routes r where r.owner_id=a.owner_id),
 'usageAccount',(select jsonb_build_object('limitMicrousd',u.limit_microusd,'spentMicrousd',u.spent_microusd,'reservedMicrousd',u.reserved_microusd,'providerActualMicrousd',u.provider_actual_microusd) from public.usage_accounts u where u.owner_id=a.owner_id),
 'subscriptionUnknownCount',(select count(*) from public.jobs j where j.owner_id=a.owner_id and j.billing_mode='chatgpt_subscription' and j.state='needs_reconciliation'),
 'subscriptionUnknownSha256',(select encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(j) order by j.id),'[]'::jsonb)::text,'UTF8')),'hex') from public.jobs j where j.owner_id=a.owner_id and j.billing_mode='chatgpt_subscription' and j.state='needs_reconciliation'),
 'subscriptionPolicySha256',(select encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(p) order by p.operation),'[]'::jsonb)::text,'UTF8')),'hex') from fluid_private.subscription_runtime_policy p where p.owner_id=a.owner_id),
 'subscriptionRegistrationSha256',(select encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(r) order by r.registration_id),'[]'::jsonb)::text,'UTF8')),'hex') from fluid_private.subscription_registrations r where r.owner_id=a.owner_id),
 'subscriptionUnknownRows',(select coalesce(jsonb_agg(jsonb_build_object('id',j.id,'reserved',j.reserved_cost_microusd,'actual',j.actual_cost_microusd,'maxAttempts',j.max_attempts,'hasLease',j.lease_token is not null,'sha256',encode(sha256(convert_to(to_jsonb(j)::text,'UTF8')),'hex')) order by j.id),'[]'::jsonb) from public.jobs j where j.owner_id=a.owner_id and j.billing_mode='chatgpt_subscription' and j.state='needs_reconciliation'),
 'reservationTotals',(select jsonb_build_object('captured',coalesce(sum(captured_microusd),0),'actual',coalesce(sum(actual_microusd),0),'activeRemaining',coalesce(sum(case when state='active' then reserved_microusd-captured_microusd else 0 end),0)) from public.usage_reservations r where r.owner_id=a.owner_id),
 'apiBindings',(select coalesce(jsonb_agg(jsonb_build_object('operation',b.operation,'roleOid',b.role_oid,'policyIdentity',b.policy_identity,'deploymentId',b.deployment_id,'enabled',b.enabled) order by b.operation),'[]'::jsonb) from fluid_private.api_strategy_bindings b where b.owner_id=a.owner_id),
 'paidApiPaused',fluid_private.api_text_paid_paused(a.owner_id)
) as activation_preflight from a;
commit;
