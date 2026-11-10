-- Revision-only changes (scope expansion or retitling) must not invalidate an
-- unchanged saved logo brief. Preserve all records and the existing function's
-- OID, owner, ACL, signature and security mode; change only its freshness test.
begin;
do $logo_brief_context_freshness$
declare
 signature regprocedure:=to_regprocedure('fluid_private.logo_workspace_base_json(uuid,uuid)');
 definition text;
 old_fragment text:=$old$if s='brief_references' and (row.record#>>'{payload,sourceProjectRevision}')::bigint<>project.current_revision then$old$;
 new_fragment text:=$new$if s='brief_references' and not exists(
    select 1 from public.project_revisions source_revision
    join public.project_revisions current_revision
      on current_revision.project_id=source_revision.project_id and current_revision.owner_id=source_revision.owner_id
    where source_revision.project_id=p_project and source_revision.owner_id=p_owner
      and source_revision.revision=(row.record#>>'{payload,sourceProjectRevision}')::bigint
      and current_revision.revision=project.current_revision
      and jsonb_typeof(source_revision.context)='object' and jsonb_typeof(current_revision.context)='object'
      and source_revision.context=current_revision.context
   ) then$new$;
begin
 if current_user<>'postgres' or signature is null or not exists(
   select 1 from pg_proc p join pg_language l on l.oid=p.prolang
   where p.oid=signature and p.proowner=to_regrole('postgres')::oid
     and not p.prosecdef and p.provolatile='s' and not p.proleakproof
     and p.proconfig=array['search_path=""'] and l.lanname='plpgsql'
     and encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')='0b6e77b1f06716421cfd3706b32f7df5bb303d81c21b397703526831a7ab4fd0'
 ) then raise exception 'logo_brief_context_freshness_predecessor_mismatch' using errcode='55000';end if;
 definition:=pg_get_functiondef(signature);
 if (length(definition)-length(replace(definition,old_fragment,'')))/length(old_fragment)<>1 then
   raise exception 'logo_brief_context_freshness_fragment_mismatch' using errcode='55000';
 end if;
 execute replace(definition,old_fragment,new_fragment);
end $logo_brief_context_freshness$;
commit;
