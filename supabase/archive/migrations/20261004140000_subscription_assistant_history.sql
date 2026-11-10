-- Freeze bounded server-owned assistant proposals at subscription admission.
-- Deploy a worker supporting input versions 1 and 2 before applying this change.
-- Existing jobs, selected policies, limits and all RPC/table grants are unchanged.
begin;

create or replace function public.enqueue_subscription_strategy_job(p_project_id uuid,p_expected_revision integer,p_operation text,p_idempotency_key text,p_accepted_policy_identity text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_owner uuid:=auth.uid(); v_project public.projects; v_revision public.project_revisions; v_policy fluid_private.subscription_runtime_policy; v_job public.jobs; v_input jsonb;
 v_history jsonb := '{"entries":[],"truncated":false}'::jsonb; v_candidate jsonb; v_entry jsonb; v_source record;
 v_frozen_at timestamptz;
begin
 if v_owner is null then raise exception 'unauthenticated' using errcode='42501'; end if;
 if p_expected_revision is null or p_expected_revision<1 or p_operation is null or p_operation not in ('strategy.reformulate','strategy.competitors','strategy.audience','strategy.personality','strategy.positioning')
   or p_idempotency_key is null or p_idempotency_key !~ '^[A-Za-z0-9._:-]{16,128}$'
   or p_accepted_policy_identity is null or p_accepted_policy_identity !~ '^[0-9a-f]{64}$' then raise exception 'invalid_input' using errcode='22023'; end if;
 if not exists(select 1 from public.projects where id=p_project_id and owner_id=v_owner) then raise exception 'not_found' using errcode='P0002'; end if;
 -- Serialize all operations/registrations for this owner, without a USD account.
 perform pg_advisory_xact_lock(hashtextextended(v_owner::text,723902));
 select * into v_job from public.jobs where owner_id=v_owner and idempotency_key=p_idempotency_key;
 if found then
   if (v_job.project_id,v_job.operation,v_job.input_revision,v_job.billing_mode) is distinct from (p_project_id,p_operation,p_expected_revision,'chatgpt_subscription') then raise exception 'idempotency_conflict' using errcode='23505'; end if;
   if v_job.policy_identity<>p_accepted_policy_identity then raise exception 'policy_identity_conflict' using errcode='40001'; end if;
   return fluid_private.strategy_job_summary(v_job);
 end if;
 select * into v_job from public.jobs where owner_id=v_owner and project_id=p_project_id and input_revision=p_expected_revision and operation=p_operation and billing_mode='chatgpt_subscription';
 if found then
   if v_job.policy_identity<>p_accepted_policy_identity then raise exception 'policy_identity_conflict' using errcode='40001'; end if;
   return fluid_private.strategy_job_summary(v_job);
 end if;
 select * into v_project from public.projects where id=p_project_id and owner_id=v_owner for share;
 if v_project.current_revision<>p_expected_revision then raise exception 'revision_conflict' using errcode='40001'; end if;
 select * into v_policy from fluid_private.subscription_runtime_policy where owner_id=v_owner and operation=p_operation and enabled for share;
 if not found or v_policy.worker_ready_until is null or v_policy.worker_ready_until<=clock_timestamp() then raise exception 'runtime_unavailable' using errcode='P0001'; end if;
 if encode(sha256(convert_to(v_policy.policy::text,'UTF8')),'hex')<>p_accepted_policy_identity then raise exception 'policy_identity_conflict' using errcode='40001'; end if;
 if (select count(*) from public.jobs where owner_id=v_owner and billing_mode='chatgpt_subscription' and created_at>clock_timestamp()-interval '1 hour') >= (v_policy.policy->'limits'->>'maxRequestsPerHour')::integer
   or (select count(*) from public.jobs where owner_id=v_owner and billing_mode='chatgpt_subscription' and state in ('queued','running','cancel_requested')) >= (v_policy.policy->'limits'->>'maxQueuedJobs')::integer then raise exception 'quota_unavailable' using errcode='P0001'; end if;
 select * into strict v_revision from public.project_revisions where project_id=p_project_id and owner_id=v_owner and revision=p_expected_revision;
 v_input:=jsonb_build_object('version',2,'billingMode','chatgpt_subscription','context',v_revision.context,'policy',v_policy.policy,'assistantHistory',v_history);
 -- Freeze one database snapshot of completed, bound sources. Never read partial
 -- text, provider reasoning, browser-authored assistant events or another tenant.
 -- Provider context/history are JSON strings inside the request. Budget their
 -- escaped serialization as well as raw history, with room for instructions and
 -- output schema. Whole-entry omission never raises the selected input limit.
 v_frozen_at:=clock_timestamp();
 for v_source in
   select j.id as job_id,j.owner_id,j.project_id,j.input_revision,s.step_key,s.completed_at,s.output
   from public.jobs j join public.job_steps s on s.job_id=j.id and s.owner_id=j.owner_id and s.project_id=j.project_id
   where j.owner_id=v_owner and j.project_id=p_project_id and j.input_revision<=p_expected_revision
     and j.state='succeeded' and j.finished_at<=v_frozen_at and s.state='succeeded' and s.completed_at<=v_frozen_at
     and j.operation in ('strategy.reformulate','strategy.competitors','strategy.audience','strategy.personality','strategy.positioning')
     and s.output->'version'='1'::jsonb and s.output->>'provider'='openai'
     and s.output->>'operation'=j.operation and s.output->>'model'=j.input->'policy'->>'model'
     and coalesce(s.output->>'billingMode','openai_api')=j.billing_mode
     and s.provider_request_id=s.output->>'responseId'
     and jsonb_typeof(s.output->'proposal')='object'
     and s.output-array['version','provider','billingMode','operation','model','responseId','requestId','generatedAt','usage','proposal']='{}'::jsonb
   order by s.completed_at desc,j.id desc,s.step_key desc limit 6
 loop
   if jsonb_array_length(v_history->'entries')>=5 then
     v_history:=jsonb_set(v_history,'{truncated}','true'::jsonb); exit;
   end if;
   v_entry:=jsonb_build_object('jobId',v_source.job_id,'ownerId',v_source.owner_id,'projectId',v_source.project_id,
     'inputRevision',v_source.input_revision,'stepKey',v_source.step_key,'completedAt',v_source.completed_at,'output',v_source.output);
   v_candidate:=jsonb_set(v_history,'{entries}',(v_history->'entries')||jsonb_build_array(v_entry));
   if octet_length(v_candidate::text)<=32768
     and octet_length(to_jsonb(jsonb_set(v_input,'{assistantHistory}',v_candidate)::text)::text)+8192
       <=(v_policy.policy->'limits'->>'maxInputBytes')::integer then v_history:=v_candidate;
   else v_history:=jsonb_set(v_history,'{truncated}','true'::jsonb); end if;
 end loop;
 v_input:=jsonb_set(v_input,'{assistantHistory}',v_history);
 if octet_length(v_input::text)>(v_policy.policy->'limits'->>'maxInputBytes')::integer then raise exception 'input_too_large' using errcode='22023'; end if;
 insert into public.jobs(owner_id,project_id,operation,input_revision,input_hash,input,idempotency_key,reserved_cost_microusd,max_attempts,billing_mode,policy_identity)
   values(v_owner,p_project_id,p_operation,p_expected_revision,encode(sha256(convert_to(v_input::text,'UTF8')),'hex'),v_input,p_idempotency_key,0,1,'chatgpt_subscription',p_accepted_policy_identity) returning * into v_job;
 return fluid_private.strategy_job_summary(v_job);
end $$;

commit;
