-- Recovery must acknowledge the exact immutable plan before observing issued
-- calls on a cancel_requested job. This is a read-only replay, not permission
-- to register a new plan, dispatch another step, or settle unknown charges.
-- Keep the existing lease/owner lock first and preserve all ACLs and guards.
do $$
declare
  definition text;
  old_block text := $old$  if v_job.state <> 'running' then raise exception 'cancel_requested' using errcode = '55000'; end if;
  if v_job.plan_manifest is not null then
    if v_job.plan_manifest is distinct from p_manifest then raise exception 'plan_conflict' using errcode = '40001'; end if;
    return v_job;
  end if;$old$;
  new_block text := $new$  if v_job.plan_manifest is not null then
    if v_job.plan_manifest is distinct from p_manifest then raise exception 'plan_conflict' using errcode = '40001'; end if;
    return v_job;
  end if;
  if v_job.state <> 'running' then raise exception 'cancel_requested' using errcode = '55000'; end if;$new$;
begin
  definition := pg_get_functiondef('public.register_job_plan(uuid,uuid,jsonb)'::regprocedure);
  if strpos(definition, old_block) = 0
     or length(definition) - length(replace(definition, old_block, '')) <> length(old_block) then
    raise exception 'register_job_plan_definition_changed';
  end if;
  execute replace(definition, old_block, new_block);
end $$;
