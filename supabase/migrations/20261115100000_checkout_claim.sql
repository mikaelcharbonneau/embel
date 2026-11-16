-- One Checkout request at a time per account, and a count of live subscriptions
-- (docs/state-machines.md, R7).
--
-- Opening Checkout closes the account's earlier open pages and then opens a new one
-- (src/server/billing/sessions.ts). Two requests in the same instant both saw "no open page"
-- and each opened one; paying both made two subscriptions. This adds a short claim on the
-- account's billing_customers row that the server takes before it looks at open pages and gives
-- back as soon as the new page exists:
--   billing_claim_checkout(owner)    true when this request may go on; false when another
--                                    request of the same account holds the claim.
--   billing_release_checkout(owner)  gives the claim back (after success and after failure).
-- A claim that was never given back (the server stopped mid-request) ends by itself after 30
-- seconds, so an account can never be locked out of Checkout.
--
-- Two simultaneous claims take turns on the row: the second waits for the first to commit, then
-- reads the row again, finds it claimed and returns false.
--
-- billing_live_subscription_count(owner) lets the webhook notice an account with more than one
-- live subscription and log it. It changes nothing: what Stripe reports is still always saved.
--
-- All three are callable by service_role only, like the other billing functions.
--
-- Rollback (deploy the previous app release first, which calls none of these):
--   drop function public.billing_claim_checkout(uuid);
--   drop function public.billing_release_checkout(uuid);
--   drop function public.billing_live_subscription_count(uuid);
--   alter table fluid_private.billing_customers drop column checkout_claimed_at;

alter table fluid_private.billing_customers add column checkout_claimed_at timestamptz;

create function public.billing_claim_checkout(p_owner uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if p_owner is null then raise exception 'invalid_input' using errcode = '22023'; end if;
  update fluid_private.billing_customers
     set checkout_claimed_at = clock_timestamp()
   where owner_id = p_owner
     and (checkout_claimed_at is null or checkout_claimed_at < clock_timestamp() - interval '30 seconds');
  if found then return true; end if;
  if not exists (select 1 from fluid_private.billing_customers where owner_id = p_owner) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  return false;
end $$;

create function public.billing_release_checkout(p_owner uuid) returns void
language sql security definer set search_path = '' as $$
  update fluid_private.billing_customers set checkout_claimed_at = null where owner_id = p_owner;
$$;

create function public.billing_live_subscription_count(p_owner uuid) returns integer
language sql stable security definer set search_path = '' as $$
  select count(*)::integer from fluid_private.billing_subscriptions s
   where s.owner_id = p_owner and fluid_private.billing_subscription_live(s);
$$;

revoke all on function public.billing_claim_checkout(uuid), public.billing_release_checkout(uuid),
  public.billing_live_subscription_count(uuid) from public, anon, authenticated;
grant execute on function public.billing_claim_checkout(uuid), public.billing_release_checkout(uuid),
  public.billing_live_subscription_count(uuid) to service_role;
