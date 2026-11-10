-- Account-only display data. No signup trigger and no project/bootstrap dependency.
create table public.account_profiles (
  owner_id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null default '' check (char_length(full_name) <= 100 and full_name = btrim(full_name) and full_name !~ '[[:cntrl:]]'),
  time_zone text not null default 'America/Toronto' check (time_zone in (
    'America/Toronto','America/Vancouver','America/New_York','America/Chicago',
    'America/Denver','America/Los_Angeles','America/Sao_Paulo','Europe/London',
    'Europe/Paris','Europe/Berlin','Africa/Johannesburg','Asia/Dubai','Asia/Kolkata',
    'Asia/Singapore','Asia/Tokyo','Australia/Sydney','Pacific/Auckland','UTC')),
  date_format text not null default 'friendly' check (date_format in ('friendly','iso')),
  revision integer not null default 1 check (revision between 1 and 2147483646),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.account_profiles enable row level security;
alter table public.account_profiles force row level security;
create policy profile_owner_read on public.account_profiles for select to authenticated
  using (owner_id = (select auth.uid()));
create policy profile_owner_insert on public.account_profiles for insert to authenticated
  with check (owner_id = (select auth.uid()));
create policy profile_owner_update on public.account_profiles for update to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));

-- The invoker trigger controls versions and timestamps even for direct Data API writes.
create function fluid_private.advance_account_profile_revision() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if new.owner_id is distinct from old.owner_id or new.revision is distinct from old.revision
    or new.created_at is distinct from old.created_at then
    raise exception using errcode = '22023', message = 'invalid_profile_update';
  end if;
  new.revision := old.revision + 1;
  new.updated_at := clock_timestamp();
  return new;
end;
$$;
create trigger account_profile_revision before update on public.account_profiles
  for each row execute function fluid_private.advance_account_profile_revision();

-- Remove inherited default grants from only these new objects, including worker
-- roles if an installation has custom default privileges. No existing ACL changes.
do $$
declare grant_entry record;
begin
  for grant_entry in
    select distinct a.grantee, r.rolname from pg_class c
      cross join lateral aclexplode(coalesce(c.relacl, acldefault('r',c.relowner))) a
      left join pg_roles r on r.oid = a.grantee
      where c.oid = 'public.account_profiles'::regclass and a.grantee <> c.relowner
  loop
    execute format('revoke all on table public.account_profiles from %s',
      case when grant_entry.grantee = 0 then 'PUBLIC' else quote_ident(grant_entry.rolname) end);
  end loop;
  for grant_entry in
    select distinct a.grantee, r.rolname from pg_proc p
      cross join lateral aclexplode(coalesce(p.proacl, acldefault('f',p.proowner))) a
      left join pg_roles r on r.oid = a.grantee
      where p.oid = 'fluid_private.advance_account_profile_revision()'::regprocedure and a.grantee <> p.proowner
  loop
    execute format('revoke all on function fluid_private.advance_account_profile_revision() from %s',
      case when grant_entry.grantee = 0 then 'PUBLIC' else quote_ident(grant_entry.rolname) end);
  end loop;
end;
$$;
grant select on table public.account_profiles to authenticated;
grant insert (owner_id,full_name,time_zone,date_format) on public.account_profiles to authenticated;
grant update (full_name,time_zone,date_format) on public.account_profiles to authenticated;
