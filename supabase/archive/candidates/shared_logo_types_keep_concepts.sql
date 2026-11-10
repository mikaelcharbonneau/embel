-- UNAPPLIED. Logo types can change without making earlier Logo work outdated.
-- Requires shared_identity_selected_logo_boards.sql and the logo brief context
-- freshness migration (20261030150000).
--
-- The logo types in a saved Logo brief only choose what the next concepts
-- explore. Until now, any brief save made every concept, vector and direction
-- recorded against the earlier brief outdated, so changing the types meant
-- generating new concepts before Creative direction. A brief that differs from
-- the current one only in its logo types now counts as current:
--  * the Logo workspace no longer marks a stage outdated for that difference;
--  * the selected logo for Creative direction carries the brief its image was
--    actually made from (the current brief when its inputs include it), so its
--    recorded source still matches that image exactly.
-- Any other brief change (name, activity, audience, personality, liked images,
-- project basis or recorded inputs) still makes that work outdated. No rows,
-- jobs or recorded evidence change.
begin;
set local lock_timeout='2s';
set local statement_timeout='30s';
do $guard$
begin
 if current_user<>'postgres' or session_user<>current_user
  or to_regprocedure('fluid_private.logo_brief_same_except_types(uuid,uuid,uuid,uuid)') is not null
 then raise exception 'shared_logo_types_keep_concepts_prerequisite' using errcode='55000'; end if;
 -- The exact reviewed predecessors this packet edits.
 if not exists(select 1 from pg_proc p where p.oid=to_regprocedure('fluid_private.logo_workspace_base_json(uuid,uuid)')
  and encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')='a7048b7df7505df2938c03823200a971254dbdedadfb9c2bc34d25376f6cef79'
  and p.proowner='postgres'::regrole and not p.prosecdef)
  or not exists(select 1 from pg_proc p where p.oid=to_regprocedure('fluid_private.shared_identity_selected_logo(uuid,uuid)')
  and encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')='157404646b0ee642ced2f143127a50a84654058a6080d069398b42255ffd6bb7'
  and p.proowner='postgres'::regrole and not p.prosecdef)
 then raise exception 'shared_logo_types_keep_concepts_predecessor_mismatch' using errcode='55000'; end if;
end $guard$;

-- True when two saved briefs of the same project are identical apart from
-- their logo types. False for anything missing or from another project.
create function fluid_private.logo_brief_same_except_types(p_owner uuid,p_project uuid,p_left uuid,p_right uuid) returns boolean
language sql stable set search_path='' as $$
 select coalesce((select (a.record->'payload')-'logoTypes'=(b.record->'payload')-'logoTypes' and a.record->'inputRevisions'=b.record->'inputRevisions'
  from public.logo_stage_revisions a,public.logo_stage_revisions b
  where a.id=p_left and b.id=p_right and a.owner_id=p_owner and b.owner_id=p_owner and a.project_id=p_project and b.project_id=p_project
   and a.stage='brief_references' and b.stage='brief_references'),false)
$$;
-- Owner-only, like the two readers that call it; this also removes any grant
-- that default privileges added.
do $acl$
declare grant_row record;
begin
 revoke all on function fluid_private.logo_brief_same_except_types(uuid,uuid,uuid,uuid) from public,anon,authenticated,service_role;
 for grant_row in select distinct a.grantee from pg_proc p,lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
  where p.oid='fluid_private.logo_brief_same_except_types(uuid,uuid,uuid,uuid)'::regprocedure and a.grantee<>p.proowner and a.grantee<>0 loop
  execute format('revoke all on function fluid_private.logo_brief_same_except_types(uuid,uuid,uuid,uuid) from %I',pg_get_userbyid(grant_row.grantee));
 end loop;
end $acl$;

-- Each edit replaces one exact fragment that must occur exactly once.
do $install$
declare target regprocedure; body text; definition text; needle text; replacement text;
begin
 target:='fluid_private.logo_workspace_base_json(uuid,uuid)'::regprocedure;
 select prosrc into body from pg_proc where oid=target; definition:=pg_get_functiondef(target);
 needle:=$needle$    where r.id is null or r.id::text<>i->>'id' or r.revision<>(i->>'revision')::bigint) then reasons:=reasons||'"input_revision_changed"'::jsonb; end if;$needle$;
 replacement:=$replacement$    where (r.id is null or r.id::text<>i->>'id' or r.revision<>(i->>'revision')::bigint)
    and not (i->>'stage'='brief_references' and fluid_private.logo_brief_same_except_types(p_owner,p_project,(i->>'id')::uuid,r.id))) then reasons:=reasons||'"input_revision_changed"'::jsonb; end if;$replacement$;
 if (length(body)-length(replace(body,needle,'')))/length(needle)<>1 then raise exception 'shared_logo_types_keep_concepts_workspace_mismatch'; end if;
 execute replace(definition,body,replace(body,needle,replacement));

 target:='fluid_private.shared_identity_selected_logo(uuid,uuid)'::regprocedure;
 select prosrc into body from pg_proc where oid=target; definition:=pg_get_functiondef(target);
 needle:=$needle$ select record into brief from public.logo_stage_revisions where id=(workspace#>>'{stages,brief_references,id}')::uuid and owner_id=o and project_id=p;$needle$;
 replacement:=$replacement$ select r.record into brief from jsonb_array_elements(raster->'inputRevisions') ref
  join public.logo_stage_revisions r on r.id=(ref->>'id')::uuid and r.owner_id=o and r.project_id=p and r.stage='brief_references' and to_jsonb(r.revision)=ref->'revision'
  where ref->>'stage'='brief_references' and fluid_private.logo_brief_same_except_types(o,p,r.id,(workspace#>>'{stages,brief_references,id}')::uuid)
  order by r.id::text=workspace#>>'{stages,brief_references,id}' desc,r.revision desc limit 1;$replacement$;
 if (length(body)-length(replace(body,needle,'')))/length(needle)<>1 then raise exception 'shared_logo_types_keep_concepts_selection_mismatch'; end if;
 execute replace(definition,body,replace(body,needle,replacement));
end $install$;
commit;
