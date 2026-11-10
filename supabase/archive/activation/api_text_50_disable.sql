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
 perform fluid_private.lock_strategy_owner(v_owner);
 update fluid_private.api_strategy_bindings set enabled=false where owner_id=v_owner and enabled;
 -- Leave explicit API route selected: never revive queued subscription work.
 -- No job/reservation settlement, cancellation, password, role or grant changes.
end $activation$;
commit;
