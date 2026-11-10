-- Extend the existing explicit local image authority to saved-preview refinement.
-- No runtime policy is enabled here; no credential, table or grant is created.
-- Vector refinement and every ordinary/hosted admission retain their own gates.
begin;
create temporary table logo_refinement_original_functions on commit drop as
 select oid,proowner,proacl,prosecdef,provolatile,proconfig,proleakproof from pg_proc where oid in(
 'fluid_private.logo_local_project_clear(uuid,uuid)'::regprocedure,
 'fluid_private.logo_local_job_allowed(uuid,text)'::regprocedure,
 'public.local_logo_operation(uuid,text,jsonb)'::regprocedure,
 'public.admit_logo_operation(uuid,jsonb)'::regprocedure,
 'fluid_private.logo_operation_ready(uuid,text)'::regprocedure);
do $guard$
declare signature text; expected text;
begin
 for signature,expected in values
 ('fluid_private.logo_local_project_clear(uuid,uuid)','b4001775156867ef313497ac224081c6'),
 ('fluid_private.logo_local_job_allowed(uuid,text)','95cf5be451804b226431dc1652a9a7bf'),
 ('public.local_logo_operation(uuid,text,jsonb)','82075fc14456e6bf3ed66c61c82c5715'),
 ('public.admit_logo_operation(uuid,jsonb)','2bb2318fc18c7e3109ba525566812295'),
 ('fluid_private.logo_operation_ready(uuid,text)','90fe89bf3e8e1b5172bc9bb7296ef132') loop
  if not exists(select 1 from pg_proc where oid=signature::regprocedure and md5(prosrc)=expected
   and proconfig=array['search_path=""'] and not proleakproof
   and proowner=(select oid from pg_roles where rolname=current_user)) then
   raise exception 'unexpected_local_refinement_predecessor: %',signature; end if;
 end loop;
end $guard$;

do $patch$
declare signature text; original text; replacement text; definition text;
begin
 for signature,original,replacement in values
 ('fluid_private.logo_local_project_clear(uuid,uuid)',
 $old$j.operation='identity.logo_concept'$old$,
 $new$j.operation in('identity.logo_concept','identity.logo_refine')$new$),
 ('fluid_private.logo_local_job_allowed(uuid,text)',
 $old$j.operation='identity.logo_concept'$old$,
 $new$(j.operation='identity.logo_concept' or (j.operation='identity.logo_refine' and j.input#>>'{source,kind}'='preview'))$new$),
 ('public.admit_logo_operation(uuid,jsonb)',
 $old$q.operation='identity.logo_concept' and fluid_private.logo_local_context_allowed(owner,p_project_id)$old$,
 $new$(q.operation='identity.logo_concept' or (q.operation='identity.logo_refine' and q.record#>>'{request,operation}'='refine_preview')) and fluid_private.logo_local_context_allowed(owner,p_project_id)$new$),
 ('fluid_private.logo_operation_ready(uuid,text)',
 $old$p_operation='identity.logo_concept' and fluid_private.logo_local_context_allowed(p_owner)$old$,
 $new$p_operation in('identity.logo_concept','identity.logo_refine') and fluid_private.logo_local_context_allowed(p_owner)$new$) loop
  definition:=pg_get_functiondef(signature::regprocedure);
  if (length(definition)-length(replace(definition,original,'')))/length(original)<>1 then
   raise exception 'unexpected_local_refinement_fragment: %',signature; end if;
  execute replace(definition,original,replacement);
 end loop;
end $patch$;

create or replace function public.local_logo_operation(p_project_id uuid,p_kind text,p_input jsonb default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare o uuid:=auth.uid(); c fluid_private.logo_local_capabilities; result jsonb; q public.logo_cost_quotes;
begin
 if o is null then raise exception 'unauthenticated' using errcode='42501'; end if;
 perform 1 from public.projects where id=p_project_id and owner_id=o;
 if not found then raise exception 'logo_project_not_found' using errcode='P0002'; end if;
 if p_kind not in('capabilities','quote','admit') or p_kind is null then raise exception 'invalid_local_logo_action' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(pg_catalog.hashtextextended(o::text,723902));
 -- Replays keep the original immutable admission, including after disablement.
 if p_kind='admit' and fluid_private.logo_uuid(p_input->'requestKey') and (
  exists(select 1 from public.logo_operation_requests where owner_id=o and project_id=p_project_id and request_key=(p_input->>'requestKey')::uuid)
  or exists(select 1 from public.logo_operation_rejections where owner_id=o and project_id=p_project_id and request_key=(p_input->>'requestKey')::uuid))
  then return public.admit_logo_operation(p_project_id,p_input); end if;
 -- The local image lane includes only raster previews, never vector sources.
 if p_kind='quote' and p_input->>'operation' not in('concepts','more_concepts','retry_failed','refine_preview')
  then return public.quote_logo_operation(p_project_id,p_input); end if;
 if p_kind='admit' and fluid_private.logo_uuid(p_input->'quoteId') and exists(
  select 1 from public.logo_cost_quotes where id=(p_input->>'quoteId')::uuid and owner_id=o and project_id=p_project_id
   and not(operation='identity.logo_concept' or (operation='identity.logo_refine' and record#>>'{request,operation}'='refine_preview')))
  then return public.admit_logo_operation(p_project_id,p_input); end if;
 if p_kind='capabilities' and not fluid_private.logo_local_enabled(o) then return public.read_logo_capabilities(p_project_id); end if;
 if not fluid_private.logo_local_enabled(o) or not fluid_private.logo_local_project_clear(o,p_project_id)
  then raise exception 'logo_runtime_unavailable' using errcode='55000'; end if;
 select * into c from fluid_private.logo_local_capabilities where owner_id=o for share;
 if p_kind='quote' and (p_input->>'operation' not in('concepts','more_concepts','retry_failed','refine_preview') or p_input->>'operation' is null)
  then raise exception 'invalid_local_logo_action' using errcode='22023'; end if;
 if p_kind='admit' then
  if not fluid_private.logo_uuid(p_input->'quoteId') then raise exception 'invalid_logo_intent' using errcode='22023'; end if;
  select * into q from public.logo_cost_quotes where id=(p_input->>'quoteId')::uuid and owner_id=o and project_id=p_project_id;
  if not found then raise exception 'logo_quote_not_found' using errcode='P0002'; end if;
  if not(q.operation='identity.logo_concept' or (q.operation='identity.logo_refine' and q.record#>>'{request,operation}'='refine_preview'))
   or q.record->>'policyIdentity'<>c.policy_identity then raise exception 'logo_policy_changed' using errcode='PT409'; end if;
 end if;
 insert into fluid_private.logo_local_context values(pg_backend_pid(),txid_current(),o,p_project_id);
 if p_kind='capabilities' then result:=public.read_logo_capabilities(p_project_id);
 elsif p_kind='quote' then result:=public.quote_logo_operation(p_project_id,p_input);
 else
  result:=public.admit_logo_operation(p_project_id,p_input);
  if result->>'operation' in('identity.logo_concept','identity.logo_refine') then
   insert into fluid_private.logo_local_jobs(job_id,owner_id,project_id,role_name,role_oid,worker_id,policy_identity)
   select j.id,j.owner_id,j.project_id,c.role_name,c.role_oid,c.worker_id,c.policy_identity from public.jobs j
   where j.id in(select (value#>>'{}')::uuid from jsonb_array_elements(result->'jobIds')) and j.owner_id=o and j.project_id=p_project_id;
  end if;
 end if;
 delete from fluid_private.logo_local_context where backend_pid=pg_backend_pid() and transaction_id=txid_current();
 return result;
end $$;

do $security$ begin
 if exists(select 1 from logo_refinement_original_functions old left join pg_proc p on p.oid=old.oid
  where p.oid is null or (p.proowner,p.proacl,p.prosecdef,p.provolatile,p.proconfig,p.proleakproof)
   is distinct from (old.proowner,old.proacl,old.prosecdef,old.provolatile,old.proconfig,old.proleakproof)) then
  raise exception 'local_refinement_security_changed'; end if;
end $security$;
commit;
