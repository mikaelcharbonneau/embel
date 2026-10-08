-- Forward status-only correction after restricted_api_text_runtime.
-- No budget, runtime policy, owner binding, grants, or admission changes.
-- Guard the complete known source body; preserve the installed definition and
-- catalog metadata/ACLs. One DO statement is atomic and safe to replay.
do $api_strategy_budget_status$
declare
  target regprocedure := 'public.get_api_strategy_availability(uuid)'::regprocedure;
  original text;
  source_body text;
  patched_body text;
  patched text;
  metadata jsonb;
  body_hash text;
begin
  original := pg_get_functiondef(target);
  select p.prosrc,to_jsonb(p)-'prosrc' into source_body,metadata from pg_proc p where p.oid=target;
  body_hash := encode(sha256(convert_to(source_body,'UTF8')),'hex');
  if body_hash='b525fd07c0b3558d301103c75815e37841006e10d0fd782ccb7f743ee130a5f9' then
    return;
  end if;
  if body_hash<>'e5e71fbdcf97b0b6c2a649c75a5637b57f1d4ee0f19bde0ba8988d80d5bee94b' then
    raise exception 'Unexpected API Strategy availability definition';
  end if;
  patched_body := replace(source_body,
    'declare v_owner uuid:=auth.uid(); v_operations jsonb; a public.usage_accounts;',
    'declare v_owner uuid:=auth.uid(); v_operations jsonb; v_qualified_count bigint; a public.usage_accounts;');
  patched_body := replace(patched_body,
$old_query$ select coalesce(jsonb_agg(jsonb_build_object('operation',p.operation,'maximumCostMicrousd',(p.policy->>'maximumCostMicrousd')::bigint) order by p.operation),'[]'::jsonb)
 into v_operations from fluid_private.strategy_runtime_policy p join fluid_private.api_strategy_bindings b on b.operation=p.operation and b.owner_id=v_owner
 where fluid_private.api_text_policy_allowed(v_owner,p.operation,p.policy,b.deployment_id)
 and (p.policy->>'maximumCostMicrousd')::bigint<=a.limit_microusd-greatest(a.spent_microusd,a.provider_actual_microusd)-a.reserved_microusd;
 if jsonb_array_length(v_operations)=0 then return jsonb_build_object('status','unavailable','operations','[]'::jsonb,'reason','runtime_disabled'); end if;$old_query$,
$new_query$ select count(*), coalesce(jsonb_agg(jsonb_build_object('operation',p.operation,'maximumCostMicrousd',(p.policy->>'maximumCostMicrousd')::bigint) order by p.operation)
   filter (where (p.policy->>'maximumCostMicrousd')::bigint<=a.limit_microusd-greatest(a.spent_microusd,a.provider_actual_microusd)-a.reserved_microusd),'[]'::jsonb)
 into v_qualified_count,v_operations from fluid_private.strategy_runtime_policy p join fluid_private.api_strategy_bindings b on b.operation=p.operation and b.owner_id=v_owner
 where fluid_private.api_text_policy_allowed(v_owner,p.operation,p.policy,b.deployment_id);
 if v_qualified_count=0 then return jsonb_build_object('status','unavailable','operations','[]'::jsonb,'reason','runtime_disabled'); end if;
 if jsonb_array_length(v_operations)=0 then return jsonb_build_object('status','unavailable','operations','[]'::jsonb,'reason','budget_unavailable'); end if;$new_query$);
  if encode(sha256(convert_to(patched_body,'UTF8')),'hex')<>'b525fd07c0b3558d301103c75815e37841006e10d0fd782ccb7f743ee130a5f9' then
    raise exception 'Unexpected API Strategy availability replacement';
  end if;
  patched := replace(original,source_body,patched_body);
  execute patched;
  if pg_get_functiondef(target) is distinct from patched or
    (select to_jsonb(p)-'prosrc' from pg_proc p where p.oid=target) is distinct from metadata then
    raise exception 'API Strategy availability metadata changed unexpectedly';
  end if;
end
$api_strategy_budget_status$;
