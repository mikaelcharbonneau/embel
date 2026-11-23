-- A switch to a smaller plan starts at the next renewal (docs/payments.md, state-machines R7).
--
-- The hole: the customer portal applied every plan change at once and gave money back for
-- unused time. Pro -> Studio granted the 350 extra credits on a small prorated invoice;
-- switching straight back returned almost all of that payment while the credits stayed. At
-- each renewal the granted allowance went back to Pro's 150, so the round trip worked again
-- every month: Studio's 500 credits for about the Pro price.
--
-- The fix is in Stripe: the portal now schedules a switch to a cheaper plan for the end of the
-- paid period (scripts/stripe/ensure-products.mjs, schedule_at_period_end), so no money comes
-- back mid-period. Until then the subscription keeps its plan, and Stripe holds the next plan
-- in a subscription schedule. This migration lets the app say so:
--   * billing_subscriptions.pending_plan_id: the plan the subscription changes to at its next
--     renewal, as the server read it from Stripe. Null when nothing is scheduled.
--   * billing_apply_subscription takes it as a tenth argument (default null) and also reports
--     "planLowered": the plan of a live subscription dropped inside one paid period. With the
--     portal set up as above that cannot happen; the server logs it when it does.
--   * billing_owner_state always returns pendingPlanId. get_billing_summary adds pendingPlanId
--     to the subscription only when one is set, so a release that does not know the key never
--     sees it (it never writes one either).
--
-- Compatible with the previous app release: it calls billing_apply_subscription with nine
-- named arguments, which resolve to the new function.
--
-- Rollback (deploy the previous app release first):
--   update fluid_private.billing_subscriptions set pending_plan_id = null;
--   then re-run billing_apply_subscription, billing_owner_state and get_billing_summary from
--   20261111100000_stripe_billing.sql with their revokes and grants, drop the ten-argument
--   billing_apply_subscription, and drop the column.

begin;

alter table fluid_private.billing_subscriptions
  add column pending_plan_id text references fluid_private.plans(id);

drop function public.billing_apply_subscription(uuid, text, text, text, text, timestamptz, timestamptz, boolean, timestamptz);

-- Saves a subscription's state as the server just read it from Stripe. A subscription that
-- ended (cancelled, unpaid or expired) returns the account to Free unless another live
-- subscription remains.
create function public.billing_apply_subscription(
  p_owner uuid, p_subscription text, p_customer text, p_plan text, p_status text,
  p_period_start timestamptz, p_period_end timestamptz, p_cancel_at_period_end boolean, p_synced_at timestamptz,
  p_pending_plan text default null)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s fluid_private.billing_subscriptions; prev fluid_private.billing_subscriptions; a public.credit_accounts;
  stored boolean := false; lowered boolean := false;
begin
  if p_owner is null or p_subscription is null or p_customer is null or p_plan is null or p_status is null
     or p_period_start is null or p_period_end is null or p_cancel_at_period_end is null or p_synced_at is null then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  if p_plan = 'free' or not exists (select 1 from fluid_private.plans where id = p_plan) then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  if p_pending_plan is not null
     and (p_pending_plan = 'free' or not exists (select 1 from fluid_private.plans where id = p_pending_plan)) then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  if not exists (select 1 from fluid_private.billing_customers where owner_id = p_owner and stripe_customer_id = p_customer) then
    raise exception 'customer_mismatch' using errcode = '42501';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('embel_generation:' || p_owner::text, 0));
  select * into s from fluid_private.billing_subscriptions where stripe_subscription_id = p_subscription for update;
  if found and s.owner_id <> p_owner then raise exception 'customer_mismatch' using errcode = '42501'; end if;
  if not found then
    insert into fluid_private.billing_subscriptions (stripe_subscription_id, owner_id, stripe_customer_id, plan_id, status,
        current_period_start, current_period_end, cancel_at_period_end, stripe_synced_at, pending_plan_id)
      values (p_subscription, p_owner, p_customer, p_plan, p_status, p_period_start, p_period_end, p_cancel_at_period_end,
              p_synced_at, nullif(p_pending_plan, p_plan))
      returning * into s;
    stored := true;
  elsif s.stripe_synced_at < p_synced_at then
    prev := s;
    update fluid_private.billing_subscriptions
       set plan_id = p_plan, status = p_status, current_period_start = p_period_start, current_period_end = p_period_end,
           cancel_at_period_end = p_cancel_at_period_end, stripe_synced_at = p_synced_at,
           pending_plan_id = nullif(p_pending_plan, p_plan), updated_at = clock_timestamp()
     where stripe_subscription_id = p_subscription returning * into s;
    stored := true;
    -- A smaller plan inside the same paid period: the change was applied at once.
    lowered := fluid_private.billing_subscription_live(prev) and fluid_private.billing_subscription_live(s)
      and prev.current_period_end = s.current_period_end
      and (select monthly_credits from fluid_private.plans where id = s.plan_id)
        < (select monthly_credits from fluid_private.plans where id = prev.plan_id);
  end if;
  -- Leaves a paid plan only when no live subscription remains (also covers a missed event).
  a := fluid_private.ensure_credit_period(p_owner);
  return jsonb_build_object('stored', stored, 'status', s.status, 'live', fluid_private.billing_subscription_live(s),
                            'accountPlanId', a.plan_id, 'planLowered', lowered);
end $$;

revoke all on function public.billing_apply_subscription(uuid, text, text, text, text, timestamptz, timestamptz, boolean, timestamptz, text)
  from public, anon, authenticated;
grant execute on function public.billing_apply_subscription(uuid, text, text, text, text, timestamptz, timestamptz, boolean, timestamptz, text)
  to service_role;

-- What the billing routes need to know about one account: its Stripe customer and its
-- newest subscription.
create or replace function public.billing_owner_state(p_owner uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c text; s fluid_private.billing_subscriptions;
begin
  if p_owner is null then raise exception 'invalid_input' using errcode = '22023'; end if;
  select stripe_customer_id into c from fluid_private.billing_customers where owner_id = p_owner;
  select bs.* into s from fluid_private.billing_subscriptions bs where bs.owner_id = p_owner
   order by fluid_private.billing_subscription_live(bs) desc, bs.current_period_end desc limit 1;
  return jsonb_build_object(
    'customerId', c,
    'subscription', case when s.stripe_subscription_id is null then null else jsonb_build_object(
      'id', s.stripe_subscription_id, 'planId', s.plan_id, 'status', s.status,
      'cancelAtPeriodEnd', s.cancel_at_period_end, 'live', fluid_private.billing_subscription_live(s),
      'pendingPlanId', s.pending_plan_id) end);
end $$;

revoke all on function public.billing_owner_state(uuid) from public, anon, authenticated;
grant execute on function public.billing_owner_state(uuid) to service_role;

-- The signed-in person's plan, credits and subscription, and the plans on offer. Credits and
-- states only; prices live in Stripe and in the page.
create or replace function public.get_billing_summary() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare o uuid := auth.uid(); a public.credit_accounts; s fluid_private.billing_subscriptions;
begin
  if o is null then raise exception 'unauthenticated' using errcode = '42501'; end if;
  a := fluid_private.ensure_credit_period(o);
  select bs.* into s from fluid_private.billing_subscriptions bs where bs.owner_id = o
   order by fluid_private.billing_subscription_live(bs) desc, bs.current_period_end desc limit 1;
  return jsonb_build_object(
    'planId', a.plan_id,
    'balance', fluid_private.credit_balance(o),
    'periodEnd', a.period_end,
    'subscription', case when s.stripe_subscription_id is null or not fluid_private.billing_subscription_live(s) then null
      else jsonb_build_object('planId', s.plan_id, 'status', s.status, 'cancelAtPeriodEnd', s.cancel_at_period_end,
                              'currentPeriodEnd', s.current_period_end)
           || case when s.pending_plan_id is null then '{}'::jsonb
                   else jsonb_build_object('pendingPlanId', s.pending_plan_id) end end,
    'plans', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'monthlyCredits', p.monthly_credits)
                                        order by p.monthly_credits)
                         from fluid_private.plans p where p.active), '[]'::jsonb));
end $$;

revoke all on function public.get_billing_summary() from public, anon, service_role;
grant execute on function public.get_billing_summary() to authenticated;

commit;
