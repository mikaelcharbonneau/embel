-- Guided interview: exact operator-selected policies and per-operation testing.
-- No account, cohort, policy, binding, environment, grant or provider is enabled.
begin;

do $guard$
declare signature text; expected text; expected_definer boolean; expected_volatility text;
begin
 for signature,expected,expected_definer,expected_volatility in values
  ('fluid_private.api_text_allowance_available(uuid,text)','e330f0f2ead5ede59f816a43577a345a',false,'s'),
  ('public.api_text_multi_account_readiness(jsonb,text)','b5cc98309bb88f3939ecd1f853cc4ca0',true,'v'),
  ('fluid_private.api_text_policy_allowed(uuid,text,jsonb,text,oid)','4d19b1f22180ac46f339828fffd64110',false,'s'),
  ('fluid_private.api_text_testing_enqueue_matches(uuid,uuid,text,integer,text,jsonb,text,bigint,integer)','b4f4ecb5442f6d5dbd2d9b4c81e658e5',false,'s'),
  ('fluid_private.api_text_testing_job_allowed(uuid)','4745692f9eb8a36cb6a98aa062c9e333',false,'s'),
  ('public.authorize_api_text_dispatch(uuid,uuid,text,text,text)','0db28ed7b73284ba6df4f5ae91d60487',true,'v'),
  ('public.enqueue_strategy_job(uuid,integer,text,text,bigint)','c212dbe673d2f6e8a6e717b1652a5ce9',true,'v'),
  ('fluid_private.enqueue_strategy_job_legacy(uuid,integer,text,text,bigint)','31433c9abcf50dd6cd000ceb65e2a343',true,'v'),
  ('public.get_api_strategy_availability(uuid)','c1b720a0a96c6addd53be78a1fd18edd',true,'v'),
  ('fluid_private.identity_material_context(jsonb)','44f05d7300904f2d71accc53dad530a9',false,'i'),
  ('fluid_private.naming_readiness(text,jsonb)','3c0a279081cefb3ee021f6f43777246b',false,'i') loop
  if not exists(select 1 from pg_catalog.pg_proc p where p.oid=signature::regprocedure
   and md5(p.prosrc)=expected and p.proconfig=array['search_path=""'] and not p.proleakproof
   and p.prosecdef=expected_definer and p.provolatile::text=expected_volatility
   and p.proowner=(select oid from pg_catalog.pg_roles where rolname=current_user)) then
   raise exception 'unexpected_guided_strategy_predecessor: %',signature;
  end if;
 end loop;
end $guard$;

-- Preserve each existing grant; additional operations require additional rows.
alter table fluid_private.api_text_testing_access drop constraint api_text_testing_access_pkey;
alter table fluid_private.api_text_testing_access add primary key(owner_id,operation);
alter table fluid_private.api_text_testing_access drop constraint api_text_testing_access_operation_check;
alter table fluid_private.api_text_testing_access add constraint api_text_testing_access_operation_check
 check(operation in ('strategy.reformulate','strategy.competitors','strategy.audience','strategy.personality'));
alter table fluid_private.api_text_testing_admission_context drop constraint api_text_testing_admission_context_operation_check;
alter table fluid_private.api_text_testing_admission_context add constraint api_text_testing_admission_context_operation_check
 check(operation in ('strategy.reformulate','strategy.competitors','strategy.audience','strategy.personality'));
alter table fluid_private.api_text_allowance_admissions drop constraint api_text_allowance_admissions_maximum_cost_microusd_check;
alter table fluid_private.api_text_allowance_admissions add constraint api_text_allowance_admissions_maximum_cost_microusd_check
 check(maximum_cost_microusd in (122880,15892880));
alter table fluid_private.api_text_allowance_cohorts drop constraint api_text_allowance_cohorts_operations_check;
alter table fluid_private.api_text_allowance_cohorts add constraint api_text_allowance_cohorts_operations_check
 check(cardinality(operations) between 1 and 5 and operations <@ array['strategy.reformulate','strategy.competitors','strategy.audience','strategy.personality','strategy.positioning']);

create function fluid_private.api_text_guided_policy(p_operation text,p jsonb) returns boolean
language sql immutable set search_path='' as $$
 select coalesce(p_operation in ('strategy.reformulate','strategy.competitors','strategy.audience','strategy.personality')
  and p=jsonb_build_object('version',2,'pricingVersion','2026-10-14','handlerVersion','strategy-openai-guided-v1',
   'model','gpt-6.1-sol','maxInputTokens',case when p_operation='strategy.competitors' then 3150000 else 32768 end,
   'maxOutputTokens',case when p_operation='strategy.competitors' then 8192 else 4096 end,
   'maxWebSearchCalls',case when p_operation='strategy.competitors' then 2 else 0 end,
   'inputMicrousdPerMillionTokens',2000000,'cachedInputMicrousdPerMillionTokens',100000,
   'cacheWriteMicrousdPerMillionTokens',2500000,'outputMicrousdPerMillionTokens',10000000,
   'webSearchMicrousdPerCall',10000,'maximumCostMicrousd',case when p_operation='strategy.competitors' then 15892880 else 122880 end),false);
$$;
create function fluid_private.api_text_request_policy(p_owner uuid,p_operation text,p_policy jsonb) returns boolean
language sql stable set search_path='' as $$
 select (p_operation in ('strategy.reformulate','strategy.audience','strategy.personality','strategy.positioning') and fluid_private.api_text_bounded_policy(p_policy))
  or (fluid_private.api_text_testing_enabled(p_owner,p_operation) and fluid_private.api_text_guided_policy(p_operation,p_policy));
$$;

-- Retain the historical constraint exactly; admit only the additional exact
-- guided policies. Installing their schema does not enable a runtime row.
do $constraint$
declare definition text;
begin
 select pg_get_constraintdef(oid) into strict definition from pg_catalog.pg_constraint
 where conrelid='fluid_private.strategy_runtime_policy'::regclass and conname='strategy_runtime_policy_policy_check';
 if position('CHECK (' in definition)<>1 then raise exception 'unexpected_strategy_constraint'; end if;
 alter table fluid_private.strategy_runtime_policy drop constraint strategy_runtime_policy_policy_check;
 execute 'alter table fluid_private.strategy_runtime_policy add constraint strategy_runtime_policy_policy_check check ('||
  substr(definition,8,length(definition)-8)||' or fluid_private.api_text_guided_policy(operation,policy))';
end $constraint$;

-- User-authored metadata is not assistant evidence. Validate its references,
-- sizes and ordering; provider output is obtained only from owned job_steps.
create function fluid_private.guided_interview_context(p_value jsonb,p_events jsonb) returns jsonb
language plpgsql immutable set search_path='' as $$
declare t jsonb; a jsonb; x jsonb; ids text[]:='{}'; stages text[]:='{}'; option_ids text[];
 previous_revision integer:=0; revision integer; id text;
begin
 perform fluid_private.identity_conversation(coalesce(p_events,'[]'));
 if jsonb_typeof(p_value) is distinct from 'object' or p_value-array['version','stage','turns','answers']<>'{}'
  or not(p_value ?& array['version','stage','turns','answers']) or p_value->'version'<>'1'
  or coalesce(p_value->>'stage','') not in ('competitors','audience','personality','complete')
  or jsonb_typeof(p_value->'turns') is distinct from 'array' or jsonb_array_length(p_value->'turns')>48
  or jsonb_typeof(p_value->'answers') is distinct from 'array' or jsonb_array_length(p_value->'answers')>3
  or octet_length(fluid_private.standalone_compact(p_value))>32768 then
  raise exception 'invalid_guided_interview' using errcode='22023'; end if;
 for t in select value from jsonb_array_elements(p_value->'turns') loop
  if jsonb_typeof(t) is distinct from 'object' or t-array['id','userMessageId','stage','purpose','inputRevision']<>'{}'
   or not(t ?& array['id','userMessageId','stage','purpose','inputRevision'])
   or coalesce(t->>'stage','') not in ('competitors','audience','personality') or coalesce(t->>'purpose','') not in ('research','message','propose') then
   raise exception 'invalid_guided_interview' using errcode='22023'; end if;
  id:=fluid_private.identity_text(t->'id',1,128,false);
  revision:=fluid_private.identity_counter(t->'inputRevision');
  if revision<=previous_revision or id=any(ids) then raise exception 'invalid_guided_interview' using errcode='22023'; end if;
  previous_revision:=revision; ids:=array_append(ids,id);
  if t->'userMessageId'='null' then
   if t->>'purpose'<>'propose' then raise exception 'invalid_guided_interview' using errcode='22023'; end if;
  else
   perform fluid_private.identity_text(t->'userMessageId',1,128,false);
   if (t->>'purpose'='research' and t->>'stage'<>'competitors') or not exists(
    select 1 from jsonb_array_elements(coalesce(p_events,'[]')) e where e->>'kind'='user_message' and e->>'id'=t->>'userMessageId') then
    raise exception 'invalid_guided_interview' using errcode='22023'; end if;
  end if;
 end loop;
 for a in select value from jsonb_array_elements(p_value->'answers') loop
  if jsonb_typeof(a) is distinct from 'object' or a-array['stage','turnId','optionIds','customText','confirmedAt']<>'{}'
   or not(a ?& array['stage','turnId','optionIds','customText','confirmedAt'])
   or coalesce(a->>'stage','') not in ('competitors','audience','personality') or a->>'stage'=any(stages)
   or jsonb_typeof(a->'optionIds') is distinct from 'array' or jsonb_array_length(a->'optionIds')>20 then
   raise exception 'invalid_guided_interview' using errcode='22023'; end if;
  stages:=array_append(stages,a->>'stage');
  perform fluid_private.identity_text(a->'turnId',1,128,false);
  if not exists(select 1 from jsonb_array_elements(p_value->'turns') turn where turn->>'id'=a->>'turnId' and turn->>'stage'=a->>'stage') then
   raise exception 'invalid_guided_interview' using errcode='22023'; end if;
  option_ids:='{}';
  for x in select value from jsonb_array_elements(a->'optionIds') loop
   id:=fluid_private.identity_text(x,1,128,false);
   if id=any(option_ids) then raise exception 'invalid_guided_interview' using errcode='22023'; end if;
   option_ids:=array_append(option_ids,id);
  end loop;
  if a->'customText'<>'null' then perform fluid_private.identity_text(a->'customText',1,12000); end if;
  perform fluid_private.identity_time_key(fluid_private.identity_text(a->'confirmedAt',1,64,false));
 end loop;
 return p_value;
end $$;

create function fluid_private.guided_api_strategy_input(p_owner uuid,p_project uuid,p_revision integer,p_operation text,p_policy jsonb,p_accepted bigint)
returns jsonb language plpgsql stable set search_path='' as $$
declare context jsonb; state jsonb; turn jsonb; result jsonb; source record; candidate jsonb; entry jsonb;
 history jsonb:='{"entries":[],"truncated":false}';
begin
 select r.context into strict context from public.project_revisions r
 where r.owner_id=p_owner and r.project_id=p_project and r.revision=p_revision;
 result:=jsonb_build_object('version',1,'context',context,'policy',p_policy,'acceptedMaxCostMicrousd',p_accepted);
 if p_policy->'version'<>'2' then return result; end if;
 if not fluid_private.api_text_guided_policy(p_operation,p_policy) then raise exception 'invalid_guided_policy' using errcode='22023'; end if;
 state:=fluid_private.guided_interview_context(context#>'{intake,guidedInterview}',context#>'{intake,conversation}');
 turn:=state->'turns'->-1;
 if turn is null or state->>'stage'='complete' or turn->>'stage' is distinct from state->>'stage'
  or (turn->>'inputRevision')::integer<>p_revision
  or p_operation is distinct from (case when turn->>'purpose'='message' then 'strategy.reformulate' else 'strategy.'||(turn->>'stage') end)
  or exists(select 1 from jsonb_array_elements(state->'answers') a where a->>'turnId'=turn->>'id') then
  raise exception 'guided_turn_conflict' using errcode='PT409'; end if;
 result:=result||jsonb_build_object('version',2,'assistantHistory',history);
 for source in
  select j.id job_id,j.owner_id,j.project_id,j.input_revision,s.step_key,s.completed_at,s.output
  from public.jobs j join public.job_steps s on s.job_id=j.id and s.owner_id=j.owner_id and s.project_id=j.project_id
  where j.owner_id=p_owner and j.project_id=p_project and j.input_revision<p_revision
   and j.state='succeeded' and j.finished_at<=statement_timestamp() and s.state='succeeded' and s.completed_at<=statement_timestamp()
   and fluid_private.api_text_operation(j.operation) and s.output->'version'='1'
   and s.output->>'provider'='openai' and s.output->>'operation'=j.operation
   and s.output->>'model'=j.input->'policy'->>'model' and coalesce(s.output->>'billingMode','openai_api')=j.billing_mode
   and s.provider_request_id=s.output->>'responseId' and jsonb_typeof(s.output->'proposal')='object'
   and s.output-array['version','provider','billingMode','operation','model','responseId','requestId','generatedAt','usage','proposal','guidance']='{}'
  order by s.completed_at desc,j.id desc,s.step_key desc limit 6
 loop
  if jsonb_array_length(history->'entries')>=5 then history:=jsonb_set(history,'{truncated}','true'); exit; end if;
  entry:=jsonb_build_object('jobId',source.job_id,'ownerId',source.owner_id,'projectId',source.project_id,
   'inputRevision',source.input_revision,'stepKey',source.step_key,'completedAt',source.completed_at,'output',source.output);
  candidate:=jsonb_set(history,'{entries}',(history->'entries')||jsonb_build_array(entry));
  if octet_length(candidate::text)<=32768 and octet_length(to_jsonb(jsonb_set(result,'{assistantHistory}',candidate)::text)::text)+8192<=131072 then
   history:=candidate;
  else history:=jsonb_set(history,'{truncated}','true'); end if;
 end loop;
 result:=jsonb_set(result,'{assistantHistory}',history);
 if octet_length(result::text)>131072 then raise exception 'input_too_large' using errcode='22023'; end if;
 return result;
end $$;

-- Exact substitutions preserve existing signatures, owners, attributes and ACLs.
-- Ordinary-account allowance counters/costs remain the original 122880 policy.
do $patch$
declare signature text; definition text; original text; replacement text;
begin
 for signature,original,replacement in values
  ('fluid_private.api_text_policy_allowed(uuid,text,jsonb,text,oid)',
   $old$fluid_private.api_text_bounded_policy(p_policy)$old$,
   $new$fluid_private.api_text_request_policy(p_owner,p_operation,p_policy)$new$),
  ('fluid_private.api_text_allowance_available(uuid,text)',
   $old$fluid_private.api_text_bounded_policy(p.policy)$old$,
   $new$fluid_private.api_text_request_policy(p_owner,p_operation,p.policy)$new$),
  ('fluid_private.api_text_testing_enqueue_matches(uuid,uuid,text,integer,text,jsonb,text,bigint,integer)',
   $old$p_operation='strategy.reformulate' and p_cost=122880$old$,
   $new$p_operation in ('strategy.reformulate','strategy.competitors','strategy.audience','strategy.personality') and p_cost=(p_input->'policy'->>'maximumCostMicrousd')::bigint$new$),
  ('fluid_private.api_text_testing_enqueue_matches(uuid,uuid,text,integer,text,jsonb,text,bigint,integer)',
   $old$fluid_private.api_text_bounded_policy(p_input->'policy')$old$,
   $new$fluid_private.api_text_request_policy(p_owner,p_operation,p_input->'policy')$new$),
  ('fluid_private.api_text_testing_job_allowed(uuid)',
   $old$j.operation='strategy.reformulate'
   and a.maximum_cost_microusd=122880 and j.reserved_cost_microusd=122880
   and fluid_private.api_text_bounded_policy(j.input->'policy')$old$,
   $new$j.operation in ('strategy.reformulate','strategy.competitors','strategy.audience','strategy.personality')
   and a.maximum_cost_microusd=(j.input->'policy'->>'maximumCostMicrousd')::bigint and j.reserved_cost_microusd=a.maximum_cost_microusd
   and fluid_private.api_text_request_policy(j.owner_id,j.operation,j.input->'policy')$new$),
  ('public.authorize_api_text_dispatch(uuid,uuid,text,text,text)',
   $old$state='in_flight' and reserved_cost_microusd=122880$old$,
   $new$state='in_flight' and reserved_cost_microusd=j.reserved_cost_microusd and reserved_cost_microusd=(j.input->'policy'->>'maximumCostMicrousd')::bigint$new$),
  ('public.get_api_strategy_availability(uuid)',
   $old$jsonb_build_object('operation',operation,'maximumCostMicrousd',122880) order by operation$old$,
   $new$jsonb_build_object('operation',operation,'maximumCostMicrousd',(select (p.policy->>'maximumCostMicrousd')::bigint from fluid_private.strategy_runtime_policy p where p.operation=operation.operation))
    ||case when exists(select 1 from fluid_private.strategy_runtime_policy p where p.operation=operation.operation and fluid_private.api_text_guided_policy(p.operation,p.policy))
      then '{"interviewVersion":1}'::jsonb else '{}'::jsonb end order by operation$new$),
  ('public.get_api_strategy_availability(uuid)',
   $old$array['strategy.reformulate','strategy.audience','strategy.personality','strategy.positioning']$old$,
   $new$array['strategy.reformulate','strategy.competitors','strategy.audience','strategy.personality','strategy.positioning']$new$),
  ('public.api_text_multi_account_readiness(jsonb,text)',
   $old$jsonb_array_length(p_candidates)>4$old$,
   $new$jsonb_array_length(p_candidates)>5$new$),
  ('public.api_text_multi_account_readiness(jsonb,text)',
   $old$fluid_private.api_text_bounded_policy(candidate->'policy')$old$,
   $new$(fluid_private.api_text_bounded_policy(candidate->'policy') or exists(
    select 1 from fluid_private.api_text_testing_access testing where fluid_private.api_text_testing_enabled(testing.owner_id,candidate->>'operation')
     and fluid_private.api_text_guided_policy(candidate->>'operation',candidate->'policy')
     and fluid_private.api_text_policy_allowed(testing.owner_id,candidate->>'operation',candidate->'policy',p_deployment,v_role)))$new$),
  ('public.enqueue_strategy_job(uuid,integer,text,text,bigint)',
   $old$v_testing boolean; v_count integer;$old$,
   $new$v_testing boolean; v_count integer; v_input jsonb; v_input_hash text;$new$),
  ('public.enqueue_strategy_job(uuid,integer,text,text,bigint)',
   $old$ if v_testing then
  insert into fluid_private.api_text_testing_admission_context($old$,
   $new$ if v_testing then
  select fluid_private.guided_api_strategy_input(v_owner,p_project_id,p_expected_revision,p_operation,p.policy,p_accepted_max_cost_microusd)
   into v_input from fluid_private.strategy_runtime_policy p where p.operation=p_operation;
  select case when v_input->'version'='2' then encode(sha256(convert_to(v_input::text,'UTF8')),'hex') else r.input_hash end
   into v_input_hash from public.project_revisions r where r.owner_id=v_owner and r.project_id=p_project_id and r.revision=p_expected_revision;
  insert into fluid_private.api_text_testing_admission_context($new$),
  ('public.enqueue_strategy_job(uuid,integer,text,text,bigint)',
   $old$p_idempotency_key,revision.input_hash,
   jsonb_build_object('version',1,'context',revision.context,'policy',policy.policy,'acceptedMaxCostMicrousd',p_accepted_max_cost_microusd)$old$,
   $new$p_idempotency_key,v_input_hash,v_input$new$),
  ('public.enqueue_strategy_job(uuid,integer,text,text,bigint)',
   $old$c.id,c.role_name,c.role_oid,122880);$old$,
   $new$c.id,c.role_name,c.role_oid,(v_result->>'reserved_cost_microusd')::bigint);$new$),
  ('fluid_private.enqueue_strategy_job_legacy(uuid,integer,text,text,bigint)',
   $old$v_dispatch fluid_private.api_text_dispatches;$old$,
   $new$v_dispatch fluid_private.api_text_dispatches; v_input jsonb; v_input_hash text;$new$),
  ('fluid_private.enqueue_strategy_job_legacy(uuid,integer,text,text,bigint)',
   $old$  select * into v_job from public.enqueue_job(v_owner, p_project_id, p_operation, p_expected_revision, v_revision.input_hash,
    jsonb_build_object('version',1,'context',v_revision.context,'policy',v_policy.policy,'acceptedMaxCostMicrousd',p_accepted_max_cost_microusd),$old$,
   $new$  select c.input,c.input_hash into v_input,v_input_hash from fluid_private.api_text_testing_admission_context c
   where c.backend_pid=pg_backend_pid() and c.transaction_id=txid_current() and c.owner_id=v_owner
    and c.project_id=p_project_id and c.input_revision=p_expected_revision and c.operation=p_operation and c.idempotency_key=p_idempotency_key;
  if not found then
   v_input:=fluid_private.guided_api_strategy_input(v_owner,p_project_id,p_expected_revision,p_operation,v_policy.policy,p_accepted_max_cost_microusd);
   v_input_hash:=case when v_input->'version'='2' then encode(sha256(convert_to(v_input::text,'UTF8')),'hex') else v_revision.input_hash end;
  end if;
  select * into v_job from public.enqueue_job(v_owner, p_project_id, p_operation, p_expected_revision, v_input_hash,v_input,$new$),
  ('fluid_private.identity_material_context(jsonb)',
   $old$'positioningReviewedAt','conversation','example']$old$,
   $new$'positioningReviewedAt','conversation','guidedInterview','example']$new$),
  ('fluid_private.identity_material_context(jsonb)',
   $old$ if v_intake ? 'conversation' then perform fluid_private.identity_conversation(v_intake->'conversation');end if;$old$,
   $new$ if v_intake ? 'conversation' then perform fluid_private.identity_conversation(v_intake->'conversation');end if;
 if v_intake ? 'guidedInterview' then perform fluid_private.guided_interview_context(v_intake->'guidedInterview',v_intake->'conversation');end if;$new$),
  ('fluid_private.naming_readiness(text,jsonb)',
   $old$if coalesce(p_context->'reformulationConfirmed','false')<>'true' then$old$,
   $new$if p_context#>'{intake,guidedInterview}' is null and coalesce(p_context->'reformulationConfirmed','false')<>'true' then$new$),
  ('fluid_private.naming_readiness(text,jsonb)',
   $old$if length(btrim(coalesce(p_context->>'positioning','')))=0 or coalesce(p_context#>'{intake,positioningReviewedAt}','null')='null' then$old$,
   $new$if p_context#>'{intake,guidedInterview}' is null and (length(btrim(coalesce(p_context->>'positioning','')))=0 or coalesce(p_context#>'{intake,positioningReviewedAt}','null')='null') then$new$),
  ('fluid_private.naming_readiness(text,jsonb)',
   $old$ return jsonb_build_object('ready',case when p_scope='naming_only'$old$,
   $new$ if p_context#>'{intake,guidedInterview}' is not null then
  perform fluid_private.guided_interview_context(p_context#>'{intake,guidedInterview}',p_context#>'{intake,conversation}');
 end if;
 return jsonb_build_object('ready',case when p_scope='naming_only'$new$) loop
  definition:=pg_get_functiondef(signature::regprocedure);
  if (length(definition)-length(replace(definition,original,'')))/length(original)<>1 then
   raise exception 'unexpected_guided_strategy_fragment: %',signature;
  end if;
  execute replace(definition,original,replacement);
 end loop;
end $patch$;

-- No new function can be called by a client, service role or worker directly,
-- including when an installation has hostile default EXECUTE privileges.
do $deny$
declare object_id oid; privilege record;
begin
 foreach object_id in array array[
  'fluid_private.api_text_guided_policy(text,jsonb)'::regprocedure,
  'fluid_private.api_text_request_policy(uuid,text,jsonb)'::regprocedure,
  'fluid_private.guided_interview_context(jsonb,jsonb)'::regprocedure,
  'fluid_private.guided_api_strategy_input(uuid,uuid,integer,text,jsonb,bigint)'::regprocedure] loop
  execute format('revoke all on function %s from public,anon,authenticated,service_role',object_id::regprocedure);
  for privilege in select distinct a.grantee from pg_catalog.pg_proc p,
   lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
   where p.oid=object_id and a.grantee<>p.proowner loop
   execute format('revoke all on function %s from %s cascade',object_id::regprocedure,
    case when privilege.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(privilege.grantee)) end);
  end loop;
 end loop;
end $deny$;
commit;
