-- LOCAL REVIEW CANDIDATE. No policy enabled, credentials, funding, historical
-- job/ledger rewrite or provider call. Existing generic/hosted admission keeps
-- its aggregate allowance checks. Only future jobs from the explicit local
-- wrapper receive the private immutable marker below.
begin;
do $guard$
declare signature text; expected text;
begin
 for signature,expected in values
 ('public.admit_logo_operation(uuid,jsonb)','b4d1a3d4fe8910a421639208ed06c32e'),
 ('public.claim_logo_job(text,integer)','bd3a8596ce3709007d4f94707f5dc24e'),
 ('public.begin_logo_job_step(uuid,uuid,text,text,bigint)','62bf13b2fde3ab477e51da5ed655db86'),
 ('fluid_private.logo_operation_ready(uuid,text)','7b7326efe53f1968a627e75e5868f544'),
 ('fluid_private.logo_job_ready(public.jobs,text)','1a6e7dd0b27fe6c296fa951583c9eb32') loop
  if not exists(select 1 from pg_proc p where p.oid=signature::regprocedure and md5(p.prosrc)=expected
   and p.proconfig=array['search_path=""'] and not p.proleakproof
   and p.proowner=(select oid from pg_roles where rolname=current_user)) then raise exception 'unexpected_local_logo_predecessor: %',signature; end if;
 end loop;
end $guard$;
create table fluid_private.logo_local_capabilities(
 owner_id uuid primary key references auth.users(id),
 role_name name not null,role_oid oid not null,worker_id text not null check(worker_id ~ '^[A-Za-z0-9._:-]{1,200}$'),
 policy_identity text not null check(policy_identity ~ '^[a-f0-9]{64}$'),enabled boolean not null default false
);
create table fluid_private.logo_local_context(
 backend_pid integer not null,transaction_id bigint not null,owner_id uuid not null,project_id uuid not null,
 primary key(backend_pid,transaction_id)
);
create table fluid_private.logo_local_jobs(
 job_id uuid primary key,owner_id uuid not null,project_id uuid not null,role_name name not null,role_oid oid not null,
 worker_id text not null,policy_identity text not null,
 foreign key(job_id,owner_id,project_id) references public.jobs(id,owner_id,project_id)
);
create trigger logo_local_job_immutable before update or delete on fluid_private.logo_local_jobs
 for each row execute function fluid_private.api_text_admission_immutable();

create function fluid_private.logo_local_enabled(p_owner uuid) returns boolean language sql stable set search_path='' as $$
 select exists(select 1 from fluid_private.logo_local_capabilities c
 join fluid_private.logo_worker_principals binding on binding.owner_id=c.owner_id and binding.role_name=c.role_name and binding.role_oid=c.role_oid
 join pg_roles r on r.oid=c.role_oid and r.rolname=c.role_name
 join fluid_private.logo_runtime_policies p on p.owner_id=c.owner_id and p.operation='identity.logo_concept' and p.policy_identity=c.policy_identity and p.enabled
 where c.owner_id=p_owner and c.enabled and r.rolcanlogin and not r.rolinherit and not r.rolsuper
 and not r.rolbypassrls and not r.rolcreatedb and not r.rolcreaterole and not r.rolreplication
 and not exists(select 1 from pg_auth_members m where m.member=r.oid));
$$;
create function fluid_private.logo_local_project_clear(p_owner uuid,p_project uuid) returns boolean language sql stable set search_path='' as $$
 select not exists(select 1 from public.jobs j where j.owner_id=p_owner and j.project_id=p_project and j.operation='identity.logo_concept'
  and (j.state='needs_reconciliation' or exists(select 1 from public.job_steps s where s.job_id=j.id and s.state='ambiguous')));
$$;
create function fluid_private.logo_local_context_allowed(p_owner uuid,p_project uuid default null) returns boolean language sql stable set search_path='' as $$
 select fluid_private.logo_local_enabled(p_owner) and exists(select 1 from fluid_private.logo_local_context c
 where c.backend_pid=pg_backend_pid() and c.transaction_id=txid_current() and c.owner_id=p_owner
 and (p_project is null or c.project_id=p_project) and fluid_private.logo_local_project_clear(c.owner_id,c.project_id));
$$;
create function fluid_private.logo_local_job_allowed(p_job uuid,p_worker text default null) returns boolean language sql stable set search_path='' as $$
 select exists(select 1 from fluid_private.logo_local_jobs m join public.jobs j on j.id=m.job_id and j.owner_id=m.owner_id and j.project_id=m.project_id
 join fluid_private.logo_local_capabilities c on c.owner_id=m.owner_id and c.role_name=m.role_name and c.role_oid=m.role_oid
 and c.worker_id=m.worker_id and c.policy_identity=m.policy_identity
 where m.job_id=p_job and j.operation='identity.logo_concept' and j.input->>'policyIdentity'=m.policy_identity
 and m.role_name=session_user and m.role_oid=(select oid from pg_roles where rolname=session_user)
 and m.worker_id=coalesce(j.worker_id,p_worker) and (p_worker is null or m.worker_id=p_worker)
 and fluid_private.logo_local_enabled(m.owner_id) and fluid_private.logo_local_project_clear(m.owner_id,m.project_id));
$$;

-- Three actions share one owned local boundary. A private transaction witness,
-- never client JSON or a GUC, authorizes the aggregate-allowance exception.
create function public.local_logo_operation(p_project_id uuid,p_kind text,p_input jsonb default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare o uuid:=auth.uid(); c fluid_private.logo_local_capabilities; result jsonb; q public.logo_cost_quotes;
begin
 if o is null then raise exception 'unauthenticated' using errcode='42501'; end if;
 perform 1 from public.projects where id=p_project_id and owner_id=o;
 if not found then raise exception 'logo_project_not_found' using errcode='P0002'; end if;
 if p_kind not in('capabilities','quote','admit') or p_kind is null then raise exception 'invalid_local_logo_action' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(pg_catalog.hashtextextended(o::text,723902));
 -- An exact saved request/rejection remains replayable after disablement. Never
 -- attach a local marker to an older request created by another entrypoint.
 if p_kind='admit' and fluid_private.logo_uuid(p_input->'requestKey') and (
  exists(select 1 from public.logo_operation_requests where owner_id=o and project_id=p_project_id and request_key=(p_input->>'requestKey')::uuid)
  or exists(select 1 from public.logo_operation_rejections where owner_id=o and project_id=p_project_id and request_key=(p_input->>'requestKey')::uuid))
  then return public.admit_logo_operation(p_project_id,p_input); end if;
 -- Other logo operations retain the ordinary path and receive no local witness.
 if p_kind='quote' and p_input->>'operation' not in('concepts','more_concepts','retry_failed')
  then return public.quote_logo_operation(p_project_id,p_input); end if;
 if p_kind='admit' and fluid_private.logo_uuid(p_input->'quoteId') and exists(
  select 1 from public.logo_cost_quotes where id=(p_input->>'quoteId')::uuid and owner_id=o and project_id=p_project_id and operation<>'identity.logo_concept')
  then return public.admit_logo_operation(p_project_id,p_input); end if;
 if p_kind='capabilities' and not fluid_private.logo_local_enabled(o) then return public.read_logo_capabilities(p_project_id); end if;
 if not fluid_private.logo_local_enabled(o) or not fluid_private.logo_local_project_clear(o,p_project_id)
  then raise exception 'logo_runtime_unavailable' using errcode='55000'; end if;
 select * into c from fluid_private.logo_local_capabilities where owner_id=o for share;
 if p_kind='quote' and (p_input->>'operation' not in('concepts','more_concepts','retry_failed') or p_input->>'operation' is null)
  then raise exception 'invalid_local_logo_action' using errcode='22023'; end if;
 if p_kind='admit' then
  if not fluid_private.logo_uuid(p_input->'quoteId') then raise exception 'invalid_logo_intent' using errcode='22023'; end if;
  select * into q from public.logo_cost_quotes where id=(p_input->>'quoteId')::uuid and owner_id=o and project_id=p_project_id;
  if not found then raise exception 'logo_quote_not_found' using errcode='P0002'; end if;
  if q.operation<>'identity.logo_concept' or q.record->>'policyIdentity'<>c.policy_identity then raise exception 'logo_policy_changed' using errcode='PT409'; end if;
 end if;
 insert into fluid_private.logo_local_context values(pg_backend_pid(),txid_current(),o,p_project_id);
 if p_kind='capabilities' then result:=public.read_logo_capabilities(p_project_id);
 elsif p_kind='quote' then result:=public.quote_logo_operation(p_project_id,p_input);
 else
  result:=public.admit_logo_operation(p_project_id,p_input);
  if result->>'operation'='identity.logo_concept' then
   insert into fluid_private.logo_local_jobs(job_id,owner_id,project_id,role_name,role_oid,worker_id,policy_identity)
   select j.id,j.owner_id,j.project_id,c.role_name,c.role_oid,c.worker_id,c.policy_identity from public.jobs j
   where j.id in(select (value#>>'{}')::uuid from jsonb_array_elements(result->'jobIds')) and j.owner_id=o and j.project_id=p_project_id;
  end if;
 end if;
 delete from fluid_private.logo_local_context where backend_pid=pg_backend_pid() and transaction_id=txid_current();
 return result;
end $$;

do $patch$
declare signature text; original text; replacement text; definition text;
begin
 for signature,original,replacement in values
 ('public.admit_logo_operation(uuid,jsonb)',
 $old$or cost>account.limit_microusd-greatest(account.spent_microusd,account.provider_actual_microusd)-account.reserved_microusd then$old$,
 $new$or (cost>account.limit_microusd-greatest(account.spent_microusd,account.provider_actual_microusd)-account.reserved_microusd and not (q.operation='identity.logo_concept' and fluid_private.logo_local_context_allowed(owner,p_project_id))) then$new$),
 ('public.claim_logo_job(text,integer)',
 $old$a.reserved_microusd<=a.limit_microusd-greatest(a.spent_microusd,a.provider_actual_microusd) or not exists($old$,
 $new$a.reserved_microusd<=a.limit_microusd-greatest(a.spent_microusd,a.provider_actual_microusd) or fluid_private.logo_local_job_allowed(candidate.id,p_worker) or not exists($new$),
 ('public.claim_logo_job(text,integer)',
 $old$or account.reserved_microusd>account.limit_microusd-greatest(account.spent_microusd,account.provider_actual_microusd) then return;$old$,
 $new$or (account.reserved_microusd>account.limit_microusd-greatest(account.spent_microusd,account.provider_actual_microusd) and not fluid_private.logo_local_job_allowed(j.id,p_worker)) then return;$new$),
 ('public.begin_logo_job_step(uuid,uuid,text,text,bigint)',
 $old$or account.reserved_microusd>account.limit_microusd-greatest(account.spent_microusd,account.provider_actual_microusd) then raise exception 'budget_exceeded'$old$,
 $new$or (account.reserved_microusd>account.limit_microusd-greatest(account.spent_microusd,account.provider_actual_microusd) and not fluid_private.logo_local_job_allowed(j.id)) then raise exception 'budget_exceeded'$new$),
 ('fluid_private.logo_operation_ready(uuid,text)',
 $old$or not fluid_private.api_text_paid_paused(p.owner_id))$old$,
 $new$or not fluid_private.api_text_paid_paused(p.owner_id) or (p_operation='identity.logo_concept' and fluid_private.logo_local_context_allowed(p_owner) and exists(select 1 from fluid_private.logo_local_capabilities lc where lc.owner_id=p_owner and lc.role_oid=r.role_oid and lc.worker_id=r.worker_id)))$new$),
 ('fluid_private.logo_job_ready(public.jobs,text)',
 $old$or not fluid_private.api_text_paid_paused(p.owner_id))$old$,
 $new$or not fluid_private.api_text_paid_paused(p.owner_id) or fluid_private.logo_local_job_allowed(j.id,p_worker))$new$) loop
  definition:=pg_get_functiondef(signature::regprocedure);
  if (length(definition)-length(replace(definition,original,'')))/length(original)<>1 then raise exception 'unexpected_local_logo_fragment: %',signature; end if;
  execute replace(definition,original,replacement);
 end loop;
end $patch$;

do $acl$
declare name text; object_id oid; recipient record; column_grant record;
begin
 foreach name in array array['logo_local_capabilities','logo_local_context','logo_local_jobs'] loop
  execute format('alter table fluid_private.%I enable row level security',name);
  execute format('alter table fluid_private.%I force row level security',name);
  object_id:=to_regclass('fluid_private.'||name);
  for recipient in select distinct a.grantee from pg_class c cross join lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
   where c.oid=object_id and a.grantee<>c.relowner loop
   execute format('revoke all on table %s from %s cascade',object_id::regclass,
    case when recipient.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(recipient.grantee)) end);
  end loop;
  for column_grant in select a.attname,g.grantee from pg_attribute a cross join lateral aclexplode(a.attacl) g
   join pg_class c on c.oid=a.attrelid where a.attrelid=object_id and g.grantee<>c.relowner loop
   execute format('revoke all (%I) on table %s from %s cascade',column_grant.attname,object_id::regclass,
    case when column_grant.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(column_grant.grantee)) end);
  end loop;
 end loop;
 foreach name in array array['fluid_private.logo_local_enabled(uuid)','fluid_private.logo_local_project_clear(uuid,uuid)',
  'fluid_private.logo_local_context_allowed(uuid,uuid)','fluid_private.logo_local_job_allowed(uuid,text)','public.local_logo_operation(uuid,text,jsonb)'] loop
  object_id:=to_regprocedure(name);
  for recipient in select distinct a.grantee from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
   where p.oid=object_id and a.grantee<>p.proowner loop
   execute format('revoke all on function %s from %s cascade',object_id::regprocedure,
    case when recipient.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(recipient.grantee)) end);
  end loop;
 end loop;
end $acl$;
grant execute on function public.local_logo_operation(uuid,text,jsonb) to authenticated;
commit;
