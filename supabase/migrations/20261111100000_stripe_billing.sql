-- Paid plans through Stripe Managed Payments (docs/payments.md; execution plan tasks C1 and C2).
--
-- What this adds:
--   1. Billing records in fluid_private: the Stripe customer of each account, the state of
--      each Stripe subscription, one row per paid invoice that granted credits, and the Stripe
--      events already processed (idempotency for the webhook).
--   2. Server-only functions (service_role) that the webhook and the billing routes call. The
--      server always re-reads the subscription and invoice from Stripe before calling them, so
--      nothing here trusts a webhook payload.
--   3. public.get_billing_summary() for the Plans page (the signed-in person's own plan,
--      credits and subscription; never a payment detail).
--   4. ensure_credit_period learns about paid plans: a paid period is never renewed by itself.
--      Its next allowance comes only from the next paid invoice, and a paid plan whose
--      subscription has ended returns to Free (calendar-month periods, as before).
--
-- Credit rules (one allowance per paid period, never granted twice):
--   * A paid invoice for a new billing period moves the account to the subscription's plan and
--     period and sets the balance to that plan's monthly credits, exactly as a Free period does
--     (credits do not roll over).
--   * A paid invoice inside the period already granted (an upgrade billed by proration) adds
--     only the difference between the new plan's allowance and the largest allowance already
--     granted for that period. A downgrade keeps the current balance until the next period, so
--     switching down and back up never grants twice.
--   * Each invoice is applied once (billing_invoice_grants is keyed by the Stripe invoice id).
--   * A cancelled subscription keeps its plan until Stripe ends it at the period end; then the
--     account returns to Free and receives the Free allowance for the current calendar month.
--
-- Every billing table has an owner_id column, so account deletion purges it with the rest of
-- the account (account_deletion_purge). billing_events holds only Stripe event ids and types.
--
-- Rollback: drop the functions and tables created below, drop the column
-- public.credit_accounts.granted_allowance, and restore fluid_private.ensure_credit_period
-- from the baseline (20261110190000_baseline.sql).

begin;

-- 1. Records -------------------------------------------------------------------

alter table public.credit_accounts add column granted_allowance integer
  check (granted_allowance is null or granted_allowance >= 0);

create table fluid_private.billing_customers (
  owner_id uuid primary key references auth.users(id) on delete cascade,
  stripe_customer_id text not null unique check (stripe_customer_id ~ '^cus_[A-Za-z0-9]{1,250}$'),
  created_at timestamptz not null default clock_timestamp()
);

create table fluid_private.billing_subscriptions (
  stripe_subscription_id text primary key check (stripe_subscription_id ~ '^sub_[A-Za-z0-9]{1,250}$'),
  owner_id uuid not null references auth.users(id) on delete cascade,
  stripe_customer_id text not null check (stripe_customer_id ~ '^cus_[A-Za-z0-9]{1,250}$'),
  plan_id text not null references fluid_private.plans(id),
  status text not null check (status in ('incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due', 'canceled', 'unpaid', 'paused')),
  current_period_start timestamptz not null,
  current_period_end timestamptz not null,
  cancel_at_period_end boolean not null default false,
  -- When the server read this state from Stripe; an older read never overwrites a newer one.
  stripe_synced_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  check (current_period_end > current_period_start)
);
create index billing_subscriptions_owner on fluid_private.billing_subscriptions (owner_id);

create table fluid_private.billing_invoice_grants (
  stripe_invoice_id text primary key check (stripe_invoice_id ~ '^in_[A-Za-z0-9]{1,250}$'),
  owner_id uuid not null references auth.users(id) on delete cascade,
  stripe_subscription_id text not null,
  plan_id text not null references fluid_private.plans(id),
  period_end timestamptz not null,
  credits integer not null,
  applied_at timestamptz not null default clock_timestamp()
);
create index billing_invoice_grants_owner on fluid_private.billing_invoice_grants (owner_id);

create table fluid_private.billing_events (
  stripe_event_id text primary key check (stripe_event_id ~ '^evt_[A-Za-z0-9]{1,250}$'),
  event_type text not null check (length(event_type) between 1 and 100),
  processed_at timestamptz not null default clock_timestamp()
);

alter table fluid_private.billing_customers enable row level security;
alter table fluid_private.billing_subscriptions enable row level security;
alter table fluid_private.billing_invoice_grants enable row level security;
alter table fluid_private.billing_events enable row level security;
revoke all on fluid_private.billing_customers, fluid_private.billing_subscriptions,
  fluid_private.billing_invoice_grants, fluid_private.billing_events
  from public, anon, authenticated, service_role;

-- 2. Shared rules ----------------------------------------------------------------

-- A subscription that still pays for its plan: active, trialing or past due (Stripe is still
-- retrying), and not cancelled with its period already over.
create function fluid_private.billing_subscription_live(s fluid_private.billing_subscriptions) returns boolean
language sql stable set search_path = '' as $$
  select s.status in ('active', 'trialing', 'past_due')
     and not (s.cancel_at_period_end and s.current_period_end <= now());
$$;
revoke all on function fluid_private.billing_subscription_live(fluid_private.billing_subscriptions) from public, anon, authenticated, service_role;

create function fluid_private.billing_has_live_subscription(p_owner uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from fluid_private.billing_subscriptions s
                  where s.owner_id = p_owner and fluid_private.billing_subscription_live(s));
$$;
revoke all on function fluid_private.billing_has_live_subscription(uuid) from public, anon, authenticated, service_role;

-- The monthly allowance, as before, except that a paid plan never starts a new period by
-- itself: the next paid invoice does (billing_apply_invoice). A paid plan whose subscription
-- is no longer live returns to Free.
create or replace function fluid_private.ensure_credit_period(p_owner uuid) returns public.credit_accounts
language plpgsql security definer set search_path = '' as $$
declare a public.credit_accounts; monthly integer; balance integer;
begin
  insert into public.credit_accounts (owner_id, period_start, period_end)
    values (p_owner, date_trunc('month', now()), date_trunc('month', now()) + interval '1 month')
    on conflict (owner_id) do nothing;
  select * into strict a from public.credit_accounts where owner_id = p_owner for update;
  if a.plan_id <> 'free' and (a.period_end <= now() or not fluid_private.billing_has_live_subscription(p_owner)) then
    if a.period_end <= now() and fluid_private.billing_has_live_subscription(p_owner) then
      -- Waiting for the renewal invoice to be paid; nothing is granted before it is.
      return a;
    end if;
    update public.credit_accounts
       set plan_id = 'free', period_start = date_trunc('month', now()), period_end = date_trunc('month', now()) + interval '1 month',
           granted_period_start = null, granted_allowance = null, updated_at = now()
     where owner_id = p_owner returning * into a;
  elsif a.period_end <= now() then
    update public.credit_accounts
       set period_start = date_trunc('month', now()), period_end = date_trunc('month', now()) + interval '1 month', updated_at = now()
     where owner_id = p_owner returning * into a;
  end if;
  if a.granted_period_start is distinct from a.period_start then
    select monthly_credits into strict monthly from fluid_private.plans where id = a.plan_id;
    balance := fluid_private.credit_balance(p_owner);
    if monthly - balance <> 0 then
      insert into public.credit_entries (owner_id, delta, kind, note) values (p_owner, monthly - balance, 'grant', 'Monthly allowance');
    end if;
    update public.credit_accounts set granted_period_start = a.period_start, granted_allowance = monthly, updated_at = now()
     where owner_id = p_owner returning * into a;
  end if;
  return a;
end $$;
revoke all on function fluid_private.ensure_credit_period(uuid) from public, anon, authenticated, service_role;

-- 3. Server-only functions (service_role) ----------------------------------------------

-- Records the Stripe customer the server created for an account. Returns the account's
-- customer, which is the existing one if it already had one.
create function public.billing_link_customer(p_owner uuid, p_customer text) returns text
language plpgsql security definer set search_path = '' as $$
declare c text;
begin
  if p_owner is null or p_customer is null or p_customer !~ '^cus_[A-Za-z0-9]{1,250}$' then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  if not exists (select 1 from auth.users where id = p_owner) then raise exception 'not_found' using errcode = 'P0002'; end if;
  insert into fluid_private.billing_customers (owner_id, stripe_customer_id) values (p_owner, p_customer)
    on conflict (owner_id) do nothing;
  select stripe_customer_id into strict c from fluid_private.billing_customers where owner_id = p_owner;
  return c;
end $$;

-- What the billing routes need to know about one account: its Stripe customer and its
-- newest subscription.
create function public.billing_owner_state(p_owner uuid) returns jsonb
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
      'cancelAtPeriodEnd', s.cancel_at_period_end, 'live', fluid_private.billing_subscription_live(s)) end);
end $$;

-- The account a Stripe customer belongs to, or null (for example after the account was deleted).
create function public.billing_owner_for_customer(p_customer text) returns uuid
language sql stable security definer set search_path = '' as $$
  select owner_id from fluid_private.billing_customers where stripe_customer_id = p_customer;
$$;

-- True when the event was already processed.
create function public.billing_event_seen(p_event text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from fluid_private.billing_events where stripe_event_id = p_event);
$$;

-- Marks an event processed, after everything it caused was applied. Safe to repeat.
create function public.billing_record_event(p_event text, p_type text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  if p_event is null or p_event !~ '^evt_[A-Za-z0-9]{1,250}$' or p_type is null then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  insert into fluid_private.billing_events (stripe_event_id, event_type) values (p_event, left(p_type, 100))
    on conflict (stripe_event_id) do nothing;
  get diagnostics n = row_count;
  return n = 1;
end $$;

-- Saves a subscription's state as the server just read it from Stripe. A subscription that
-- ended (cancelled, unpaid or expired) returns the account to Free unless another live
-- subscription remains.
create function public.billing_apply_subscription(
  p_owner uuid, p_subscription text, p_customer text, p_plan text, p_status text,
  p_period_start timestamptz, p_period_end timestamptz, p_cancel_at_period_end boolean, p_synced_at timestamptz)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s fluid_private.billing_subscriptions; a public.credit_accounts; stored boolean := false;
begin
  if p_owner is null or p_subscription is null or p_customer is null or p_plan is null or p_status is null
     or p_period_start is null or p_period_end is null or p_cancel_at_period_end is null or p_synced_at is null then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  if p_plan = 'free' or not exists (select 1 from fluid_private.plans where id = p_plan) then
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
        current_period_start, current_period_end, cancel_at_period_end, stripe_synced_at)
      values (p_subscription, p_owner, p_customer, p_plan, p_status, p_period_start, p_period_end, p_cancel_at_period_end, p_synced_at)
      returning * into s;
    stored := true;
  elsif s.stripe_synced_at < p_synced_at then
    update fluid_private.billing_subscriptions
       set plan_id = p_plan, status = p_status, current_period_start = p_period_start, current_period_end = p_period_end,
           cancel_at_period_end = p_cancel_at_period_end, stripe_synced_at = p_synced_at, updated_at = clock_timestamp()
     where stripe_subscription_id = p_subscription returning * into s;
    stored := true;
  end if;
  -- Leaves a paid plan only when no live subscription remains (also covers a missed event).
  a := fluid_private.ensure_credit_period(p_owner);
  return jsonb_build_object('stored', stored, 'status', s.status, 'live', fluid_private.billing_subscription_live(s),
                            'accountPlanId', a.plan_id);
end $$;

-- Grants the credits of one paid subscription invoice, once. p_plan and the period are the
-- subscription's current plan and billing period, read from Stripe by the server.
create function public.billing_apply_invoice(
  p_owner uuid, p_invoice text, p_subscription text, p_plan text, p_period_start timestamptz, p_period_end timestamptz)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare a public.credit_accounts; monthly integer; grant_credits integer := 0; outcome text;
begin
  if p_owner is null or p_invoice is null or p_invoice !~ '^in_[A-Za-z0-9]{1,250}$' or p_subscription is null
     or p_plan is null or p_period_start is null or p_period_end is null or p_period_end <= p_period_start then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  select monthly_credits into monthly from fluid_private.plans where id = p_plan and id <> 'free';
  if not found then raise exception 'invalid_input' using errcode = '22023'; end if;
  -- The server saves the subscription first. One that is not live yet (Stripe still finishing
  -- the first payment) is retried later rather than granted.
  if not exists (select 1 from fluid_private.billing_subscriptions bs
                  where bs.stripe_subscription_id = p_subscription and bs.owner_id = p_owner
                    and fluid_private.billing_subscription_live(bs)) then
    raise exception 'subscription_not_live' using errcode = '55000';
  end if;
  -- The same lock start_generation takes: no charge races the new balance.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('embel_generation:' || p_owner::text, 0));
  if exists (select 1 from fluid_private.billing_invoice_grants where stripe_invoice_id = p_invoice) then
    return jsonb_build_object('applied', false, 'reason', 'already_applied');
  end if;
  insert into public.credit_accounts (owner_id, period_start, period_end)
    values (p_owner, date_trunc('month', now()), date_trunc('month', now()) + interval '1 month')
    on conflict (owner_id) do nothing;
  select * into strict a from public.credit_accounts where owner_id = p_owner for update;

  if a.plan_id <> 'free' and a.period_end > p_period_end then
    -- An invoice of an earlier period arriving late: the newer period already has its allowance.
    outcome := 'stale';
  elsif a.plan_id <> 'free' and a.period_end = p_period_end and a.granted_period_start = a.period_start then
    -- Same paid period (a plan change billed by proration): only the missing difference.
    outcome := 'same_period';
    grant_credits := greatest(monthly - coalesce(a.granted_allowance, 0), 0);
    if grant_credits > 0 then
      insert into public.credit_entries (owner_id, delta, kind, note) values (p_owner, grant_credits, 'grant', 'Plan upgrade');
    end if;
    update public.credit_accounts
       set plan_id = p_plan, granted_allowance = greatest(coalesce(granted_allowance, 0), monthly), updated_at = now()
     where owner_id = p_owner;
  else
    -- A new paid period: the plan's allowance, as at the start of any period.
    outcome := 'new_period';
    grant_credits := monthly - fluid_private.credit_balance(p_owner);
    if grant_credits <> 0 then
      insert into public.credit_entries (owner_id, delta, kind, note) values (p_owner, grant_credits, 'grant', 'Monthly allowance');
    end if;
    update public.credit_accounts
       set plan_id = p_plan, period_start = p_period_start, period_end = p_period_end,
           granted_period_start = p_period_start, granted_allowance = monthly, updated_at = now()
     where owner_id = p_owner;
  end if;
  insert into fluid_private.billing_invoice_grants (stripe_invoice_id, owner_id, stripe_subscription_id, plan_id, period_end, credits)
    values (p_invoice, p_owner, p_subscription, p_plan, p_period_end, grant_credits);
  return jsonb_build_object('applied', true, 'outcome', outcome, 'credits', grant_credits);
end $$;

revoke all on function public.billing_link_customer(uuid, text), public.billing_owner_state(uuid),
  public.billing_owner_for_customer(text), public.billing_event_seen(text), public.billing_record_event(text, text),
  public.billing_apply_subscription(uuid, text, text, text, text, timestamptz, timestamptz, boolean, timestamptz),
  public.billing_apply_invoice(uuid, text, text, text, timestamptz, timestamptz)
  from public, anon, authenticated;
grant execute on function public.billing_link_customer(uuid, text), public.billing_owner_state(uuid),
  public.billing_owner_for_customer(text), public.billing_event_seen(text), public.billing_record_event(text, text),
  public.billing_apply_subscription(uuid, text, text, text, text, timestamptz, timestamptz, boolean, timestamptz),
  public.billing_apply_invoice(uuid, text, text, text, timestamptz, timestamptz)
  to service_role;

-- 4. The Plans page -----------------------------------------------------------------

-- The signed-in person's plan, credits and subscription, and the plans on offer. Credits and
-- states only; prices live in Stripe and in the page.
create function public.get_billing_summary() returns jsonb
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
                              'currentPeriodEnd', s.current_period_end) end,
    'plans', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'monthlyCredits', p.monthly_credits)
                                        order by p.monthly_credits)
                         from fluid_private.plans p where p.active), '[]'::jsonb));
end $$;
revoke all on function public.get_billing_summary() from public, anon, service_role;
grant execute on function public.get_billing_summary() to authenticated;

commit;
