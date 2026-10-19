-- Explicit owner-scoped hosted admission to the existing restricted Naming worker.
-- No activation, credentials, funding, historical relabelling or provider calls.
-- Historical local* wire identifiers remain compatible; authority is separate.
begin;

do $guard$
declare signature text; expected text; definer boolean; volatility text;
begin
 for signature,expected,definer,volatility in values
 ('public.append_prepared_naming_set(uuid,uuid)','b00aed54f85adaa0b1747fc7dc0964de',true,'v'),
 ('public.claim_naming_brain_job(text,text,integer)','89d01cccfdfbade7701333cb7823148c',true,'v'),
 ('public.ensure_local_naming_brain_run(uuid,jsonb)','66a9990839a97961701041108c3957cc',true,'v'),
 ('public.ensure_naming_brain_run(uuid,jsonb)','ee887ae4e31b5c1f9709384471b15dc9',true,'v'),
 ('public.expire_naming_brain_leases(text,text)','163cf4fcdc8a65e77bac277db6cd5ced',true,'v'),
 ('fluid_private.local_naming_previous_authorize(uuid,uuid,jsonb)','7a82b0661c6b7e2f5b30311fb5742a79',true,'v'),
 ('fluid_private.local_naming_previous_complete(uuid,uuid,text,text,jsonb)','42f87494ac31b4668778179d05be8233',true,'v'),
 ('fluid_private.local_naming_previous_preparation_pending(fluid_private.naming_brain_runs)','04d5117ad9b0908b981252967f12fb6c',false,'s'),
 ('fluid_private.local_naming_previous_worker_action(uuid,uuid,text,jsonb)','e85f85b75ef30ce06f801699e43ee28d',true,'v'),
 ('fluid_private.local_naming_progressive_job(uuid)','e6db0eee2737bf594aa3a1adc3bccaf2',false,'s'),
 ('fluid_private.naming_brain_local_not_dispatched(fluid_private.naming_brain_calls,jsonb)','2828c2db84eb4c0f7260525db4aef0ab',false,'s'),
 ('fluid_private.naming_brain_paid_resume(fluid_private.naming_brain_runs)','43b013f9b6e7e5e6b9dd275d6d319a93',false,'s'),
 ('fluid_private.naming_brain_saved_usable(fluid_private.naming_brain_runs)','a206bc8dfd141fee3a3b0233781c40fc',false,'s'),
 ('fluid_private.naming_brain_ready(fluid_private.naming_brain_runs,text)','07c473df6d41e3bea0c179b73418dc7e',false,'s'),
 ('fluid_private.naming_brain_summary(fluid_private.naming_brain_runs)','e0433f03705c9750f5072d8d9b59e2dc',false,'s'),
 ('public.get_naming_feed(uuid,jsonb)','bba475413960765828be777c33245f53',true,'v'),
 ('public.record_naming_brain_provider_receipt(uuid,uuid,jsonb)','b39d280e369ed6fb1ad25bf6e7be40bc',true,'v') loop
  if not exists(select 1 from pg_proc p where p.oid=signature::regprocedure and md5(p.prosrc)=expected
   and p.prosecdef=definer and p.provolatile::text=volatility and p.proconfig=array['search_path=""']
   and not p.proleakproof and p.proowner=(select oid from pg_roles where rolname=current_user)) then
   raise exception 'unexpected_hosted_naming_predecessor: %',signature;
  end if;
 end loop;
end $guard$;

create table fluid_private.hosted_naming_capabilities (
 id uuid primary key default gen_random_uuid(), owner_id uuid not null unique references auth.users(id),
 pilot_id uuid not null references fluid_private.naming_brain_pilots(id),
 role_name name not null, role_oid oid not null,
 deployment_id text not null check(deployment_id ~ '^[A-Za-z0-9._:-]{1,200}$'),
 policy_identity text not null check(policy_identity ~ '^[0-9a-f]{64}$'),
 execution_authority text not null default 'hosted_owner_v1' check(execution_authority='hosted_owner_v1'),
 enabled boolean not null default false,
 created_at timestamptz not null default clock_timestamp()
);
create table fluid_private.hosted_naming_admission_context (
 backend_pid integer not null, transaction_id bigint not null,
 owner_id uuid not null, project_id uuid not null,
 capability_id uuid not null references fluid_private.hosted_naming_capabilities(id),
 primary key(backend_pid,transaction_id)
);
create table fluid_private.hosted_naming_jobs (
 job_id uuid primary key, owner_id uuid not null, project_id uuid not null,
 capability_id uuid not null references fluid_private.hosted_naming_capabilities(id),
 pilot_id uuid not null references fluid_private.naming_brain_pilots(id),
 role_name name not null, role_oid oid not null, deployment_id text not null,
 policy_identity text not null check(policy_identity ~ '^[0-9a-f]{64}$'),
 job_input_sha256 text not null check(job_input_sha256 ~ '^[0-9a-f]{64}$'),
 created_at timestamptz not null default clock_timestamp(),
 foreign key(job_id,owner_id,project_id) references public.jobs(id,owner_id,project_id)
);
create trigger hosted_naming_job_immutable before update or delete on fluid_private.hosted_naming_jobs
 for each row execute function fluid_private.api_text_admission_immutable();

create function fluid_private.hosted_naming_owner_enabled(p_owner uuid) returns boolean
language sql stable set search_path='' as $$
 select exists(select 1 from fluid_private.hosted_naming_capabilities c
 join fluid_private.naming_brain_pilots p on p.id=c.pilot_id and p.owner_id=c.owner_id
 where c.owner_id=p_owner and c.enabled and p.enabled
 and c.role_name=p.role_name and c.role_oid=p.role_oid and c.deployment_id=p.deployment_id
 and c.policy_identity=encode(sha256(convert_to(p.policy::text,'UTF8')),'hex')
 and fluid_private.api_text_restricted_role(c.role_name,c.role_oid));
$$;
create function fluid_private.hosted_naming_context(p_owner uuid,p_project uuid) returns boolean
language sql stable set search_path='' as $$
 select fluid_private.hosted_naming_owner_enabled(p_owner) and exists(
 select 1 from fluid_private.hosted_naming_admission_context context
 join fluid_private.hosted_naming_capabilities c on c.id=context.capability_id and c.owner_id=context.owner_id
 where context.backend_pid=pg_backend_pid() and context.transaction_id=txid_current()
 and context.owner_id=p_owner and context.project_id=p_project and c.enabled);
$$;

-- Claim authority describes an immutable admission, independent of whether new
-- dispatch is still enabled. This preserves observation of already issued calls.
create function fluid_private.naming_brain_execution_authority(p_job uuid) returns text
language sql stable set search_path='' as $$
 select case when exists(
  select 1 from fluid_private.hosted_naming_jobs m
  join public.jobs j on j.id=m.job_id and j.owner_id=m.owner_id and j.project_id=m.project_id
  join fluid_private.naming_brain_runs r on r.job_id=j.id and r.owner_id=j.owner_id and r.project_id=j.project_id
  where m.job_id=p_job and fluid_private.naming_brain_is_job(j)
  and j.input->>'executionAuthority'='hosted_owner_v1' and j.input->'localTimingVersion'='2'::jsonb and j.input->'localPipelineVersion'='2'::jsonb
  and m.job_input_sha256=encode(sha256(convert_to(j.input::text,'UTF8')),'hex')
  and m.pilot_id=r.pilot_id and m.role_name=r.admitted_role_name and m.role_oid=r.admitted_role_oid
  and m.deployment_id=r.deployment_id and m.policy_identity=r.policy_identity
  and r.policy_identity=j.input->>'acceptedPolicyIdentity' and r.policy=j.input->'policy'
  and r.snapshot=j.input->'snapshot' and r.snapshot_hash=j.input_hash
  and fluid_private.api_text_restricted_role(m.role_name,m.role_oid)
  and not exists(select 1 from fluid_private.local_prototype_jobs local_marker where local_marker.job_id=j.id)) then 'hosted_owner_v1'
 when exists(
  select 1 from fluid_private.local_prototype_jobs m
  join public.jobs j on j.id=m.job_id and j.owner_id=m.owner_id and j.project_id=m.project_id
  join fluid_private.naming_brain_runs r on r.job_id=j.id and r.owner_id=j.owner_id and r.project_id=j.project_id
  where m.job_id=p_job and fluid_private.naming_brain_is_job(j) and not(j.input ? 'executionAuthority')
  and m.role_name=r.admitted_role_name and m.role_oid=r.admitted_role_oid and m.deployment_id=r.deployment_id
  and fluid_private.api_text_restricted_role(m.role_name,m.role_oid)
  and not exists(select 1 from fluid_private.hosted_naming_jobs hosted_marker where hosted_marker.job_id=j.id)) then 'local_owner_v1'
 else null end;
$$;
create function fluid_private.hosted_naming_job_enabled(p_job uuid) returns boolean
language sql stable set search_path='' as $$
 select fluid_private.naming_brain_execution_authority(p_job)='hosted_owner_v1' and exists(
 select 1 from fluid_private.hosted_naming_jobs m join fluid_private.hosted_naming_capabilities c on c.id=m.capability_id
 where m.job_id=p_job and c.owner_id=m.owner_id and c.pilot_id=m.pilot_id
 and c.role_name=m.role_name and c.role_oid=m.role_oid and c.deployment_id=m.deployment_id and c.policy_identity=m.policy_identity
 and c.enabled and fluid_private.hosted_naming_owner_enabled(c.owner_id));
$$;
create function fluid_private.naming_brain_unlimited_job(p_job uuid) returns boolean
language sql stable set search_path='' as $$
 select fluid_private.local_prototype_unlimited_job(p_job)
 or coalesce(fluid_private.naming_brain_execution_authority(p_job)='hosted_owner_v1',false);
$$;
create function fluid_private.naming_brain_unlimited_context(p_owner uuid,p_project uuid) returns boolean
language sql stable set search_path='' as $$
 select fluid_private.local_prototype_unlimited_context(p_owner,p_project) or fluid_private.hosted_naming_context(p_owner,p_project);
$$;
create function fluid_private.naming_brain_paid_paused(p_owner uuid,p_project uuid,p_job uuid default null) returns boolean
language sql stable set search_path='' as $$
 select case when fluid_private.hosted_naming_context(p_owner,p_project) or exists(
 select 1 from fluid_private.hosted_naming_jobs m where m.job_id=p_job and m.owner_id=p_owner and m.project_id=p_project
 and fluid_private.naming_brain_execution_authority(m.job_id)='hosted_owner_v1')
 then fluid_private.local_prototype_project_paused(p_owner,p_project)
 else fluid_private.local_prototype_paid_paused(p_owner,p_project,p_job) end;
$$;

create function public.get_hosted_naming_availability(p_project_id uuid default null) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare o uuid:=auth.uid();
begin
 if o is null then raise exception 'unauthenticated' using errcode='42501'; end if;
 if p_project_id is not null and not exists(select 1 from public.projects where id=p_project_id and owner_id=o and deleted_at is null and deletion_requested_at is null)
 then raise exception 'not_found' using errcode='P0002'; end if;
 if not fluid_private.hosted_naming_owner_enabled(o) then
 return jsonb_build_object('status','unavailable','executionAuthority','hosted_owner_v1','reason','runtime_disabled'); end if;
 if not exists(select 1 from fluid_private.naming_brain_pilots where owner_id=o and ready_until>clock_timestamp()) then
 return jsonb_build_object('status','unavailable','executionAuthority','hosted_owner_v1','reason','worker_unavailable'); end if;
 return jsonb_build_object('status','available','executionAuthority','hosted_owner_v1');
end $$;
create function public.ensure_hosted_naming_brain_run(p_project_id uuid,p_intent jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare o uuid:=auth.uid(); c fluid_private.hosted_naming_capabilities; result jsonb;
begin
 if o is null then raise exception 'unauthenticated' using errcode='42501'; end if;
 if not exists(select 1 from public.projects where id=p_project_id and owner_id=o and deleted_at is null and deletion_requested_at is null)
 then raise exception 'not_found' using errcode='P0002'; end if;
 if not fluid_private.naming_brain_valid_intent('ensure',p_intent) then raise exception 'invalid_intent' using errcode='22023'; end if;
 perform fluid_private.lock_strategy_owner(o);
 -- Exact old requests remain readable after disablement. The existing routine
 -- enforces canonical equality and never changes their admission provenance.
 if exists(select 1 from fluid_private.naming_brain_intents where owner_id=o and request_key=p_intent->>'idempotencyKey') then
 return public.ensure_naming_brain_run(p_project_id,p_intent); end if;
 select * into c from fluid_private.hosted_naming_capabilities where owner_id=o and enabled for share;
 if not found or not fluid_private.hosted_naming_owner_enabled(o) then raise exception 'runtime_unavailable' using errcode='P0001'; end if;
 insert into fluid_private.hosted_naming_admission_context values(pg_backend_pid(),txid_current(),o,p_project_id,c.id);
 result:=public.ensure_naming_brain_run(p_project_id,p_intent);
 delete from fluid_private.hosted_naming_admission_context where backend_pid=pg_backend_pid() and transaction_id=txid_current();
 return result;
end $$;

-- Add the new authority only to Naming-specific gates. Strategy and ordinary
-- unmarked admissions continue to use their original policy and helper bodies.
do $patch$
declare signature text; definition text; original text; replacement text;
begin
 for signature in select unnest(array[
 'public.append_prepared_naming_set(uuid,uuid)','public.claim_naming_brain_job(text,text,integer)',
 'public.ensure_naming_brain_run(uuid,jsonb)','public.expire_naming_brain_leases(text,text)',
 'fluid_private.local_naming_previous_authorize(uuid,uuid,jsonb)',
 'fluid_private.local_naming_previous_complete(uuid,uuid,text,text,jsonb)',
 'fluid_private.local_naming_previous_preparation_pending(fluid_private.naming_brain_runs)',
 'fluid_private.local_naming_previous_worker_action(uuid,uuid,text,jsonb)',
 'fluid_private.local_naming_progressive_job(uuid)',
 'fluid_private.naming_brain_local_not_dispatched(fluid_private.naming_brain_calls,jsonb)',
 'fluid_private.naming_brain_paid_resume(fluid_private.naming_brain_runs)',
 'fluid_private.naming_brain_saved_usable(fluid_private.naming_brain_runs)',
 'public.record_naming_brain_provider_receipt(uuid,uuid,jsonb)']) loop
  definition:=pg_get_functiondef(signature::regprocedure);
  if position('fluid_private.local_prototype_unlimited_' in definition)=0 then raise exception 'unexpected_hosted_naming_authority_fragment: %',signature; end if;
  definition:=replace(definition,'fluid_private.local_prototype_unlimited_job(','fluid_private.naming_brain_unlimited_job(');
  definition:=replace(definition,'fluid_private.local_prototype_unlimited_context(','fluid_private.naming_brain_unlimited_context(');
  definition:=replace(definition,'fluid_private.local_prototype_paid_paused(','fluid_private.naming_brain_paid_paused(');
  execute definition;
 end loop;
 for signature,original,replacement in values
 ('public.ensure_local_naming_brain_run(uuid,jsonb)',
 $old$if found and r.created_at>=statement_timestamp() and not exists(select 1 from fluid_private.local_prototype_jobs where job_id=r.job_id) then$old$,
 $new$if found and r.created_at>=statement_timestamp() and not exists(select 1 from fluid_private.local_prototype_jobs where job_id=r.job_id)
 and not exists(select 1 from fluid_private.hosted_naming_jobs where job_id=r.job_id) then$new$),
 ('public.ensure_naming_brain_run(uuid,jsonb)',
 $old$if fluid_private.naming_brain_unlimited_context(o,p.id) then input:=input||jsonb_build_object('localTimingVersion',2,'localPipelineVersion',2); end if;$old$,
 $new$if fluid_private.naming_brain_unlimited_context(o,p.id) then input:=input||jsonb_build_object('localTimingVersion',2,'localPipelineVersion',2); end if;
 if fluid_private.hosted_naming_context(o,p.id) then input:=input||jsonb_build_object('executionAuthority','hosted_owner_v1'); end if;$new$),
 ('public.ensure_naming_brain_run(uuid,jsonb)',
 $old$ update fluid_private.naming_brain_heads set demand_sequence=r.demand_sequence$old$,
 $new$ if input->>'executionAuthority'='hosted_owner_v1' then
 insert into fluid_private.hosted_naming_jobs(job_id,owner_id,project_id,capability_id,pilot_id,role_name,role_oid,deployment_id,policy_identity,job_input_sha256)
 select jobid,o,p.id,context.capability_id,pilot.id,pilot.role_name,pilot.role_oid,pilot.deployment_id,input->>'acceptedPolicyIdentity',encode(sha256(convert_to(input::text,'UTF8')),'hex')
 from fluid_private.hosted_naming_admission_context context where context.backend_pid=pg_backend_pid() and context.transaction_id=txid_current() and context.owner_id=o and context.project_id=p.id;
 if not found then raise exception 'hosted_naming_admission_missing' using errcode='55000'; end if;
 end if;
 update fluid_private.naming_brain_heads set demand_sequence=r.demand_sequence$new$),
 ('public.claim_naming_brain_job(text,text,integer)',
 $old$return jsonb_build_object('mode',r.recovery_mode,'job',to_jsonb(j));$old$,
 $new$return jsonb_build_object('mode',r.recovery_mode,'executionAuthority',fluid_private.naming_brain_execution_authority(j.id),'job',to_jsonb(j));$new$),
 ('fluid_private.naming_brain_ready(fluid_private.naming_brain_runs,text)',
 $old$ select exists(select 1 from fluid_private.naming_brain_pilots$old$,
 $new$ select (fluid_private.naming_brain_execution_authority(r.job_id) is distinct from 'hosted_owner_v1' or (fluid_private.hosted_naming_job_enabled(r.job_id)
 and not fluid_private.naming_brain_paid_paused(r.owner_id,r.project_id,r.job_id)))
 and exists(select 1 from fluid_private.naming_brain_pilots$new$),
 ('fluid_private.naming_brain_paid_resume(fluid_private.naming_brain_runs)',
 $old$ select coalesce(not r.superseded$old$,
 $new$ select coalesce((fluid_private.naming_brain_execution_authority(r.job_id) is distinct from 'hosted_owner_v1' or fluid_private.hosted_naming_job_enabled(r.job_id))
 and not r.superseded$new$),
 ('fluid_private.local_naming_previous_worker_action(uuid,uuid,text,jsonb)',
 $old$not exists(select 1 from fluid_private.local_prototype_jobs marker where marker.job_id=r.job_id)$old$,
 $new$(not exists(select 1 from fluid_private.local_prototype_jobs marker where marker.job_id=r.job_id) and fluid_private.naming_brain_execution_authority(r.job_id) is distinct from 'hosted_owner_v1')$new$),
 ('fluid_private.naming_brain_summary(fluid_private.naming_brain_runs)',
 $old$else jsonb_build_object('progressiveCompletionId',completion.id) end;$old$,
 $new$else jsonb_build_object('progressiveCompletionId',completion.id) end
 ||case when fluid_private.naming_brain_execution_authority(j.id)='hosted_owner_v1' then jsonb_build_object('executionAuthority','hosted_owner_v1') else '{}'::jsonb end;$new$),
 ('public.get_naming_feed(uuid,jsonb)',
 $old$if fluid_private.local_prototype_owner_enabled(auth.uid()) then$old$,
 $new$if fluid_private.local_prototype_owner_enabled(auth.uid()) or fluid_private.hosted_naming_owner_enabled(auth.uid()) then$new$) loop
  definition:=pg_get_functiondef(signature::regprocedure);
  if (length(definition)-length(replace(definition,original,'')))/length(original)<>1 then raise exception 'unexpected_hosted_naming_fragment: %',signature; end if;
  execute replace(definition,original,replacement);
 end loop;
end $patch$;

-- New private objects deny even hostile/default grants. Existing worker RPC ACLs
-- are preserved; no new worker privileges or public table access are needed.
do $deny$
declare object_id oid; privilege record;
begin
 for object_id in select unnest(array['fluid_private.hosted_naming_capabilities'::regclass,
 'fluid_private.hosted_naming_admission_context'::regclass,'fluid_private.hosted_naming_jobs'::regclass]) loop
  execute format('alter table %s enable row level security',object_id::regclass);
  execute format('alter table %s force row level security',object_id::regclass);
  for privilege in select distinct a.grantee from pg_class c,lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a where c.oid=object_id and a.grantee<>c.relowner loop
   execute format('revoke all on table %s from %s cascade',object_id::regclass,case when privilege.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(privilege.grantee)) end);
  end loop;
 end loop;
 for object_id in select unnest(array[
 'fluid_private.hosted_naming_owner_enabled(uuid)'::regprocedure,'fluid_private.hosted_naming_context(uuid,uuid)'::regprocedure,
 'fluid_private.naming_brain_execution_authority(uuid)'::regprocedure,'fluid_private.hosted_naming_job_enabled(uuid)'::regprocedure,
 'fluid_private.naming_brain_unlimited_job(uuid)'::regprocedure,'fluid_private.naming_brain_unlimited_context(uuid,uuid)'::regprocedure,
 'fluid_private.naming_brain_paid_paused(uuid,uuid,uuid)'::regprocedure,
 'public.get_hosted_naming_availability(uuid)'::regprocedure,'public.ensure_hosted_naming_brain_run(uuid,jsonb)'::regprocedure]) loop
  for privilege in select distinct a.grantee from pg_proc p,lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where p.oid=object_id and a.grantee<>p.proowner loop
   execute format('revoke all on function %s from %s cascade',object_id::regprocedure,case when privilege.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(privilege.grantee)) end);
  end loop;
 end loop;
end $deny$;
grant execute on function public.get_hosted_naming_availability(uuid),public.ensure_hosted_naming_brain_run(uuid,jsonb) to authenticated;
commit;
