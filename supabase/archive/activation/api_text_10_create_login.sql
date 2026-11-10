-- LOCAL REVIEW TEMPLATE ONLY. Do not execute without the separately reviewed
-- exact project/owner/phase approval. Target project: fricsfwqibyhemknqgyf.
-- Owner is derived internally from two confirmed historical signed-in QA projects.
-- Replace only non-secret reviewed phase evidence below; never expose owner/contact data.
begin;
do $activation$
declare
 v_project uuid := '17dd910a-a9cb-4999-aa0e-2b5aa141bb29'::uuid;
 v_second_project uuid := '850dba6b-6811-41a2-ab26-cd3248039574'::uuid;
 v_owner uuid;
begin
 if current_database()<>'postgres' then raise exception 'unexpected_database'; end if;
 select p.owner_id into v_owner from public.projects p
 join public.projects q on q.owner_id=p.owner_id and q.id=v_second_project
 where p.id=v_project and p.id<>q.id;
 if v_owner is null then raise exception 'verified_owner_project_anchor_mismatch'; end if;
 if exists(select 1 from pg_roles where rolname='fluid_api_text_worker')
 or exists(select 1 from fluid_private.api_text_worker_principals where role_name='fluid_api_text_worker' or owner_id=v_owner) then
  raise exception 'role_or_owner_mapping_collision_stop'; end if;
 -- No PASSWORD clause: PostgreSQL creates the login with no password assigned.
 create role fluid_api_text_worker login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
end $activation$;
select oid,rolname,rolcanlogin,rolinherit,rolsuper,rolbypassrls,rolcreatedb,rolcreaterole,rolreplication from pg_roles where rolname='fluid_api_text_worker';
commit;
