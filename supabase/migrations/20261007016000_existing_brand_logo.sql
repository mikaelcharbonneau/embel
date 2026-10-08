-- Local candidate only. Explicitly starts the V2 logo brief on the SAME owned
-- brand; no project/context/name mutation, legacy conversion, job, or provider.
begin;
do $$ begin
 if to_regprocedure('public.initialize_existing_brand_logo(uuid,jsonb)') is not null then
  raise exception 'logo_initialization_function_collision' using errcode='42710';
 end if;
 if to_regprocedure('fluid_private.logo_apply(uuid,uuid,jsonb)') is null or to_regclass('public.logo_operation_rejections') is null then
  raise exception 'logo_initialization_prerequisite_missing' using errcode='55000';
 end if;
end $$;
create function public.initialize_existing_brand_logo(p_project_id uuid,p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare owner uuid:=auth.uid(); project public.projects; command jsonb; existing public.logo_workspace_requests; rejected public.logo_operation_rejections; result jsonb;
begin
 if owner is null then raise exception 'unauthenticated' using errcode='42501'; end if;
 command:=jsonb_build_object('method','saveLogoBrief','body',p_input);
 if not fluid_private.logo_command_valid(command) then raise exception 'invalid_logo_initialization' using errcode='22023'; end if;
 -- Use the same project-first lock as context, Naming, references and stage
 -- writers. The downstream apply reads and compares every authoritative head.
 select * into project from public.projects where id=p_project_id and owner_id=owner for update;
 if not found then raise exception 'logo_project_not_found' using errcode='P0002'; end if;
 -- Exact original requests are recoverable even after later stage/context saves.
 -- Reuse the manual receipt contract; do not invent another request namespace.
 select * into existing from public.logo_workspace_requests
  where project_id=p_project_id and owner_id=owner and request_key=(p_input->>'requestKey')::uuid and method<>'startLogoProject';
 if found then
  if existing.input is distinct from command then raise exception 'logo_request_conflict' using errcode='PT409'; end if;
  if existing.input#>'{body,expected,stageRevisions,brief_references}' is distinct from '0'::jsonb then
   raise exception 'logo_initialization_conflict' using errcode='PT409';
  end if;
  return existing.receipt;
 end if;
 -- Durable tombstones share the already owner-scoped immutable cross-operation
 -- key fence. A lost rejection response can never later admit the same command.
 select * into rejected from public.logo_operation_rejections
  where owner_id=owner and project_id=p_project_id and request_key=(p_input->>'requestKey')::uuid;
 if found then
  if rejected.input is distinct from command then raise exception 'logo_request_conflict' using errcode='PT409'; end if;
  return rejected.receipt;
 end if;
 -- A preexisting different operation is not this initialization's rejection.
 if exists(select 1 from public.logo_operation_requests where owner_id=owner and project_id=p_project_id and request_key=(p_input->>'requestKey')::uuid) then
  raise exception 'logo_request_conflict' using errcode='PT409';
 end if;
 if project.scope in ('complete_brand','visual_identity_only')
  and p_input#>'{expected,stageRevisions,brief_references}'='0'::jsonb
  and not exists(select 1 from public.logo_stage_heads where project_id=p_project_id and owner_id=owner and stage='brief_references') then
  begin
   return fluid_private.logo_apply(owner,p_project_id,command);
  exception when sqlstate 'PT409' then
   -- Only the semantic CAS failure is recorded. Serialization failures, unique
   -- constraint errors and unavailable storage must remain uncertain/retryable.
   null;
  end;
 end if;
 result:=jsonb_build_object('kind','logo_initialization_rejected','rejection',jsonb_build_object('status','rejected','ownerId',owner,'projectId',p_project_id,'requestKey',p_input->'requestKey','input',p_input));
 insert into public.logo_operation_rejections(owner_id,project_id,request_key,input,receipt)
  values(owner,p_project_id,(p_input->>'requestKey')::uuid,command,result);
 return result;
end $$;
-- Clean privileges only on this new exact signature, including inherited
-- default ACL grants. No role, existing object ACL, or default ACL is changed.
do $$ declare r record; begin
 for r in select distinct a.grantee from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
  where p.oid='public.initialize_existing_brand_logo(uuid,jsonb)'::regprocedure and a.grantee<>p.proowner loop
  execute format('revoke all on function public.initialize_existing_brand_logo(uuid,jsonb) from %s',case when r.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(r.grantee)) end);
 end loop;
end $$;
grant execute on function public.initialize_existing_brand_logo(uuid,jsonb) to authenticated;
commit;
