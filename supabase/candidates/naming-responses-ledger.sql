-- Dormant Responses prototype. No admission, provider call, worker grant or
-- billing settlement is enabled. Historical Agents rows/functions retain their
-- exact protocol and request bodies.
begin;
create function fluid_private.naming_responses_is_job(j public.jobs) returns boolean language sql immutable set search_path='' as $$
 select coalesce(j.operation='naming.generate' and j.billing_mode='openai_api'
  and (j.input->'version'='3'::jsonb or j.input->>'handlerVersion'='naming-responses-v1'),false);
$$;
create function fluid_private.naming_responses_canonical(p jsonb) returns text language plpgsql immutable set search_path='' as $$
declare result text; n numeric;
begin
 case jsonb_typeof(p)
 when 'object' then
  if exists(select 1 from jsonb_object_keys(p) k where k!~'^[ -~]*$') then raise exception 'unsupported_json_key' using errcode='22023'; end if;
  select '{'||coalesce(string_agg(to_jsonb(key)::text||':'||fluid_private.naming_responses_canonical(value),',' order by key collate "C"),'')||'}' into result from jsonb_each(p);
 when 'array' then select '['||coalesce(string_agg(fluid_private.naming_responses_canonical(value),',' order by a.n),'')||']' into result from jsonb_array_elements(p) with ordinality a(value,n);
 when 'number' then
  n:=(p#>>'{}')::numeric;
  if n<>trunc(n) or abs(n)>9007199254740991 then raise exception 'unsupported_json_number' using errcode='22023'; end if;
  result:=n::bigint::text;
 else result:=p::text;
 end case;
 return result;
end $$;
create function fluid_private.naming_responses_immutable() returns trigger language plpgsql set search_path='' as $$
begin raise exception 'immutable_responses_evidence' using errcode='55000'; end $$;
create table fluid_private.naming_responses_rate_cards(
 id text primary key check(length(id) between 1 and 100), model text not null check(model='gpt-6-luna'),
 input_nano_per_token bigint not null check(input_nano_per_token>0), output_nano_per_token bigint not null check(output_nano_per_token>0),
 search_call_nano bigint not null check(search_call_nano>=0), valid_until timestamptz not null, sources jsonb not null
);
create table fluid_private.naming_responses_qualifications(
 id text primary key check(length(id) between 1 and 100), rate_card_id text not null references fluid_private.naming_responses_rate_cards(id),
 hosted_search boolean not null, source_complete boolean not null default false,
 maximum_input_tokens bigint check(maximum_input_tokens>0 and maximum_input_tokens<=9007199254740991),
 maximum_output_tokens integer not null check(maximum_output_tokens between 1 and 32768),
 maximum_tool_calls integer not null check(maximum_tool_calls between 0 and 20), valid_until timestamptz not null,
 evidence jsonb not null, check(not source_complete or maximum_input_tokens is not null)
);
insert into fluid_private.naming_responses_rate_cards values('openai-gpt-6-luna-standard-20261024','gpt-6-luna',200,750,10000000,'2026-10-25T00:00:00Z',
 '{"pricing":"https://developers.openai.com/api/docs/pricing","model":"https://developers.openai.com/api/docs/models/gpt-6-luna","reviewedAt":"2026-10-24","scope":"global default tier, explicit cache without breakpoints, conservative long-context rates"}');
insert into fluid_private.naming_responses_qualifications values
 ('plaintext-full-context-v1','openai-gpt-6-luna-standard-20261024',false,true,1050000,32768,0,'2026-10-25T00:00:00Z','{"kind":"single text-only pass, full model context ceiling, no hosted tools"}'),
 ('hosted-search-unqualified-v1','openai-gpt-6-luna-standard-20261024',true,false,null,32768,20,'2026-10-25T00:00:00Z','{"blocker":"No source-backed cumulative billable input bound across hosted search internal model passes"}');
create table fluid_private.naming_responses_runs(
 id uuid primary key, job_id uuid not null unique, owner_id uuid not null, project_id uuid not null,
 admitted_role_name name not null, admitted_role_oid oid not null, created_at timestamptz not null default clock_timestamp(),
 maximum_cost_nano_usd bigint not null default 5000000000 check(maximum_cost_nano_usd=5000000000),
 actual_cost_nano_usd bigint check(actual_cost_nano_usd is null),
 unique(id,owner_id,project_id), foreign key(job_id,owner_id,project_id) references public.jobs(id,owner_id,project_id)
);
create table fluid_private.naming_responses_dispatches(
 run_id uuid not null, owner_id uuid not null, project_id uuid not null, dispatch_key text not null check(dispatch_key~'^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$'),
 request jsonb not null check(octet_length(request::text)<=262144), request_hash text not null check(request_hash~'^[a-f0-9]{64}$'),
 maximum_cost_nano_usd bigint not null check(maximum_cost_nano_usd between 1 and 5000000000),
 rate_card_id text not null references fluid_private.naming_responses_rate_cards(id), qualification_id text not null references fluid_private.naming_responses_qualifications(id),
 created_at timestamptz not null default clock_timestamp(), execution_deadline_at timestamptz not null, observation_deadline_at timestamptz not null,
 primary key(run_id,dispatch_key), foreign key(run_id,owner_id,project_id) references fluid_private.naming_responses_runs(id,owner_id,project_id),
 check(observation_deadline_at>execution_deadline_at)
);
create table fluid_private.naming_responses_attempts(
 run_id uuid not null, dispatch_key text not null, state text not null default 'reserved' check(state in('reserved','dispatching','accepted','rejected','terminal')),
 response_id text unique check(response_id~'^resp_[A-Za-z0-9_-]{1,194}$'), terminal_response jsonb,
 primary key(run_id,dispatch_key), foreign key(run_id,dispatch_key) references fluid_private.naming_responses_dispatches(run_id,dispatch_key),
 check((state in('accepted','terminal'))=(response_id is not null)), check((state='terminal')=(terminal_response is not null))
);
create function fluid_private.naming_responses_attempt_transition() returns trigger language plpgsql set search_path='' as $$
begin
 if tg_op='DELETE' or new.run_id is distinct from old.run_id or new.dispatch_key is distinct from old.dispatch_key
 or (old.response_id is not null and new.response_id is distinct from old.response_id)
 or (old.terminal_response is not null and new.terminal_response is distinct from old.terminal_response)
 or not ((new.state=old.state and new.response_id is not distinct from old.response_id and new.terminal_response is not distinct from old.terminal_response)
  or (old.state='reserved' and new.state='dispatching') or (old.state='dispatching' and new.state in('accepted','rejected')) or (old.state='accepted' and new.state='terminal')) then
  raise exception 'immutable_responses_attempt' using errcode='55000';
 end if;
 return new;
end $$;
create trigger monotonic_attempt before update or delete on fluid_private.naming_responses_attempts for each row execute function fluid_private.naming_responses_attempt_transition();
create table fluid_private.naming_responses_observations(
 id bigint generated always as identity primary key, run_id uuid not null, dispatch_key text not null,
 observation jsonb not null check(octet_length(observation::text)<=2097152), content_hash text not null,
 created_at timestamptz not null default clock_timestamp(), unique(run_id,dispatch_key,content_hash),
 foreign key(run_id,dispatch_key) references fluid_private.naming_responses_dispatches(run_id,dispatch_key)
);
do $$ declare t text; begin
 foreach t in array array['naming_responses_rate_cards','naming_responses_qualifications','naming_responses_runs','naming_responses_dispatches','naming_responses_observations'] loop
  execute format('create trigger immutable before update or delete on fluid_private.%I for each row execute function fluid_private.naming_responses_immutable()',t);
 end loop;
 foreach t in array array['naming_responses_rate_cards','naming_responses_qualifications','naming_responses_runs','naming_responses_dispatches','naming_responses_attempts','naming_responses_observations'] loop
  execute format('alter table fluid_private.%I enable row level security',t);execute format('alter table fluid_private.%I force row level security',t);
  execute format('revoke all on fluid_private.%I from public,anon,authenticated,service_role',t);
 end loop;
end $$;
-- A later under-bound snapshot can never erase an observed breach. This is
-- compatibility evidence, not a final-cost calculation or settlement witness.
create function fluid_private.naming_responses_observation_safe(p_response jsonb,p_request jsonb) returns boolean language plpgsql immutable set search_path='' as $$
declare b jsonb:=p_request->'body'; q jsonb:=p_request->'quote'; u jsonb:=p_response->'usage'; details jsonb; k text; n numeric;
begin
 if jsonb_typeof(p_response) is distinct from 'object' or p_response->>'object' is distinct from 'response'
 or p_response->>'model' is distinct from b->>'model' or p_response->'max_output_tokens' is distinct from b->'max_output_tokens'
 or nullif(p_response->'max_tool_calls','null'::jsonb) is distinct from b->'max_tool_calls'
 or p_response->>'service_tier' is distinct from 'default' or p_response->'reasoning' is distinct from b->'reasoning'
 or p_response->'prompt_cache_options' is distinct from b->'prompt_cache_options' or p_response->'tools' is distinct from b->'tools'
 or p_response->'text' is distinct from b->'text' or p_response->'background' is distinct from 'true'::jsonb
 or nullif(p_response->'previous_response_id','null'::jsonb) is not null or nullif(p_response->'conversation','null'::jsonb) is not null
 or coalesce(p_response->>'status','') not in('queued','in_progress','completed','failed','cancelled','incomplete')
 or jsonb_typeof(p_response->'output') is distinct from 'array'
 or exists(select 1 from jsonb_array_elements(p_response->'output') i where jsonb_typeof(i) is distinct from 'object' or coalesce(i->>'type','') not in('message','reasoning','function_call','web_search_call'))
 or (select count(*) from jsonb_array_elements(p_response->'output') i where i->>'type'='web_search_call')>(q->>'maximumToolCalls')::bigint
 or (exists(select 1 from jsonb_array_elements(p_response->'output') i where i->>'type'='web_search_call') and not exists(select 1 from jsonb_array_elements(b->'tools') t where t->>'type'='web_search'))
 or exists(select 1 from jsonb_array_elements(p_response->'output') i where i->>'type'='function_call' and (i->>'name' is distinct from 'read_reference' or not exists(select 1 from jsonb_array_elements(b->'tools') t where t->>'type'='function' and t->>'name'=i->>'name')))
 then return false; end if;
 if u is not null and u<>'null'::jsonb then
  if jsonb_typeof(u) is distinct from 'object' then return false; end if;
  foreach k in array array['input_tokens','output_tokens'] loop
   if jsonb_typeof(u->k) is distinct from 'number' then return false; end if;
   n:=(u->>k)::numeric;
   if n<>trunc(n) or n<0 or n>9007199254740991 or n>(q->>case k when 'input_tokens' then 'maximumInputTokens' else 'maximumOutputTokens' end)::numeric then return false; end if;
  end loop;
  details:=u->'input_tokens_details';
  if details is not null and details<>'null'::jsonb then
   if jsonb_typeof(details) is distinct from 'object' then return false; end if;
   foreach k in array array['cached_tokens','cache_write_tokens','cache_creation_tokens'] loop
    if details->k is not null and details->k<>'null'::jsonb and (jsonb_typeof(details->k) is distinct from 'number' or (details->>k)::numeric<>0) then return false; end if;
   end loop;
  end if;
 end if;
 return true;
exception when others then return false;
end $$;
create function fluid_private.naming_responses_run_safe(p_run uuid) returns boolean language sql stable set search_path='' as $$
 select not exists(select 1 from fluid_private.naming_responses_observations o join fluid_private.naming_responses_dispatches d using(run_id,dispatch_key)
 where o.run_id=p_run and (o.observation->>'unsafeReason' is not null or not fluid_private.naming_responses_observation_safe(o.observation->'response',d.request)));
$$;
-- No qualification setter is exposed to a worker or public caller.
create function fluid_private.naming_responses_lock(p_job uuid,p_lease uuid) returns public.jobs language plpgsql set search_path='' as $$
declare j public.jobs; o uuid:=fluid_private.naming_brain_worker_owner(); r fluid_private.naming_responses_runs;
begin
 if o is null then raise exception 'worker_owner_mismatch' using errcode='42501'; end if;
 select * into j from public.jobs where id=p_job;
 if not found or j.owner_id<>o or not fluid_private.naming_responses_is_job(j) then raise exception 'worker_owner_mismatch' using errcode='42501'; end if;
 perform fluid_private.lock_strategy_owner(o);
 select * into strict j from public.jobs where id=p_job for update;
 if j.owner_id<>o or not fluid_private.naming_responses_is_job(j) then raise exception 'worker_owner_mismatch' using errcode='42501'; end if;
 if j.input-array['version','handlerVersion','protocol','runId','model','reasoningEffort','targetCount']<>'{}'::jsonb
 or j.input->'version' is distinct from '3'::jsonb or j.input->>'handlerVersion' is distinct from 'naming-responses-v1'
 or j.input->>'protocol' is distinct from 'openai_responses' or j.input->>'model' is distinct from 'gpt-6-luna'
 or j.input->>'reasoningEffort' is distinct from 'xhigh' or j.input->'targetCount' is distinct from '100'::jsonb
 or j.input->>'runId' is null or j.reserved_cost_microusd<>5000000 then raise exception 'invalid_responses_job' using errcode='22023'; end if;
 if p_lease is null or j.lease_token is distinct from p_lease or j.lease_expires_at is null or j.lease_expires_at<=clock_timestamp() or j.state not in('running','cancel_requested') then raise exception 'lease_lost' using errcode='PT409'; end if;
 for r in select * from fluid_private.naming_responses_runs where job_id=j.id or id=(j.input->>'runId')::uuid loop
  if r.job_id<>j.id or r.id::text<>j.input->>'runId' or r.owner_id<>j.owner_id or r.project_id<>j.project_id or r.admitted_role_name<>session_user
   or not fluid_private.api_text_restricted_role(r.admitted_role_name,r.admitted_role_oid) then raise exception 'responses_run_binding_mismatch' using errcode='42501'; end if;
 end loop;
 return j;
end $$;
create function fluid_private.naming_responses_dispatch_dto(p_run uuid,p_key text) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('request',d.request,'state',a.state,'responseId',a.response_id,'terminalResponse',a.terminal_response,
 'executionDeadlineAt',to_char(d.execution_deadline_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 'observationDeadlineAt',to_char(d.observation_deadline_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 'observations',coalesce((select jsonb_agg(o.observation order by o.id) from fluid_private.naming_responses_observations o where o.run_id=d.run_id and o.dispatch_key=d.dispatch_key),'[]'::jsonb))
 from fluid_private.naming_responses_dispatches d join fluid_private.naming_responses_attempts a using(run_id,dispatch_key) where d.run_id=p_run and d.dispatch_key=p_key;
$$;
create function fluid_private.naming_responses_quote(p_request jsonb,p_owner uuid,p_project uuid) returns bigint language plpgsql stable set search_path='' as $$
declare b jsonb:=p_request->'body'; q jsonb:=p_request->'quote'; rate fluid_private.naming_responses_rate_cards; proof fluid_private.naming_responses_qualifications; tool jsonb; hosted boolean; maximum numeric; expected_hash text;
begin
 if jsonb_typeof(p_request) is distinct from 'object' or p_request-array['version','protocol','runId','dispatchKey','requestHash','body','quote']<>'{}'::jsonb
 or p_request->'version' is distinct from '1'::jsonb or p_request->>'protocol' is distinct from 'openai_responses' or p_request->>'runId' is null
 or coalesce(p_request->>'requestHash','')!~'^[a-f0-9]{64}$' or coalesce(p_request->>'dispatchKey','')!~'^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$'
 or octet_length(p_request::text)>262144 or jsonb_typeof(b) is distinct from 'object' or jsonb_typeof(q) is distinct from 'object'
 or q-array['rateCardId','qualificationId','validUntil','maximumInputTokens','maximumOutputTokens','maximumToolCalls','maximumCostNanoUsd']<>'{}'::jsonb then raise exception 'invalid_responses_request' using errcode='22023'; end if;
 expected_hash:=encode(sha256(convert_to(fluid_private.naming_responses_canonical(jsonb_set(p_request,'{requestHash}',to_jsonb(repeat('0',64)))),'UTF8')),'hex');
 if p_request->>'requestHash'<>expected_hash then raise exception 'responses_request_hash_mismatch' using errcode='22023'; end if;
 if b-array['model','reasoning','service_tier','prompt_cache_options','truncation','background','store','stream','parallel_tool_calls','text','metadata','input','instructions','tools','max_output_tokens','max_tool_calls','include','tool_choice']<>'{}'::jsonb
 or b->>'model' is distinct from 'gpt-6-luna' or b->'reasoning' is distinct from '{"effort":"xhigh","mode":"standard"}'::jsonb
 or b->>'service_tier' is distinct from 'default' or b->'prompt_cache_options' is distinct from '{"mode":"explicit","ttl":"30m"}'::jsonb
 or b->>'truncation' is distinct from 'disabled' or b->'background' is distinct from 'true'::jsonb or b->'store' is distinct from 'true'::jsonb
 or b->'stream' is distinct from 'true'::jsonb or b->'parallel_tool_calls' is distinct from 'false'::jsonb
 or (jsonb_typeof(b->'input') is null or jsonb_typeof(b->'input') not in('string','array')) or (b ? 'instructions' and jsonb_typeof(b->'instructions')<>'string')
 or b->>'tool_choice' is distinct from 'auto' or jsonb_typeof(b->'instructions') is distinct from 'string'
 or (not (b->'include' @> '["reasoning.encrypted_content"]'::jsonb))
 or jsonb_typeof(b->'include') is distinct from 'array' or jsonb_array_length(b->'include') not between 1 and 2
 or exists(select 1 from jsonb_array_elements(b->'include') i where i#>>'{}' not in('reasoning.encrypted_content','web_search_call.action.sources'))
 or octet_length(fluid_private.naming_responses_canonical(b))>131072
 or exists(select 1 from jsonb_path_query(b->'input','$.**.type') t where t#>>'{}' not in('message','input_text','function_call','function_call_output','reasoning','reasoning_text','summary_text'))
 or b#>>'{text,verbosity}' is distinct from 'low' or b#>>'{text,format,type}' is distinct from 'json_schema'
 or b#>>'{metadata,embel_run}' is distinct from p_request->>'runId' or b#>>'{metadata,embel_dispatch}' is distinct from p_request->>'dispatchKey'
 or b#>>'{metadata,embel_contract}' is distinct from 'naming-responses-v1' or b#>>'{metadata,embel_owner}' is distinct from p_owner::text or b#>>'{metadata,embel_project}' is distinct from p_project::text
 or jsonb_path_exists(b,'$.**.cache_control') or jsonb_path_exists(b,'$.**.cache_breakpoint') or jsonb_path_exists(b,'$.**.prompt_cache_breakpoint')
 or jsonb_typeof(b->'tools') is distinct from 'array' then raise exception 'unqualified_responses_body' using errcode='22023'; end if;
 hosted:=exists(select 1 from jsonb_array_elements(b->'tools') t where t->>'type'='web_search');
 if jsonb_array_length(b->'tools')>2 or exists(select 1 from jsonb_array_elements(b->'tools') t where (t->>'type' is null or t->>'type' not in('web_search','function')) or (t->>'type'='function' and (t->>'name' is distinct from 'read_reference' or jsonb_typeof(t->'description') is distinct from 'string' or t->'strict' is distinct from 'true'::jsonb)) or (t->>'type'='web_search' and t->>'search_context_size' is distinct from 'low'))
 or (not hosted and jsonb_array_length(b->'tools')<>0) or (hosted and (jsonb_array_length(b->'tools')<>2 or not exists(select 1 from jsonb_array_elements(b->'tools') t where t->>'type'='function' and t->>'name'='read_reference'))) then raise exception 'unqualified_responses_tools' using errcode='22023'; end if;
 select * into rate from fluid_private.naming_responses_rate_cards where id=q->>'rateCardId';
 select * into proof from fluid_private.naming_responses_qualifications where id=q->>'qualificationId';
 if rate.id is null or proof.id is null or proof.rate_card_id<>rate.id or not proof.source_complete or proof.maximum_input_tokens is null
 or proof.hosted_search<>hosted or least(rate.valid_until,proof.valid_until)<=clock_timestamp()
 or q->>'validUntil' is null or (q->>'validUntil')::timestamptz<>least(rate.valid_until,proof.valid_until)
 or q->'maximumInputTokens' is distinct from to_jsonb(proof.maximum_input_tokens)
 or coalesce((q->>'maximumOutputTokens')::numeric,0) not between 1 and proof.maximum_output_tokens
 or q->'maximumOutputTokens' is distinct from b->'max_output_tokens'
 or coalesce((q->>'maximumToolCalls')::numeric,-1) not between 0 and proof.maximum_tool_calls
 or (hosted and (q->'maximumToolCalls' is distinct from b->'max_tool_calls' or (q->>'maximumToolCalls')::integer<1))
 or (not hosted and (q->'maximumToolCalls'<>'0'::jsonb or b ? 'max_tool_calls')) then raise exception 'responses_qualification_unavailable' using errcode='55000'; end if;
 maximum:=proof.maximum_input_tokens::numeric*rate.input_nano_per_token+(q->>'maximumOutputTokens')::numeric*rate.output_nano_per_token+(q->>'maximumToolCalls')::numeric*rate.search_call_nano;
 if maximum<1 or maximum>5000000000 or q->'maximumCostNanoUsd' is distinct from to_jsonb(maximum::bigint) then raise exception 'responses_maximum_mismatch' using errcode='22023'; end if;
 return maximum::bigint;
end $$;
create function public.naming_responses_worker_action(p_job_id uuid,p_lease_token uuid,p_action text,p_payload jsonb default '{}') returns jsonb language plpgsql security definer set search_path='' as $$
#variable_conflict use_variable
declare j public.jobs; run_id uuid; d fluid_private.naming_responses_dispatches; a fluid_private.naming_responses_attempts; maximum bigint; allocated numeric; key text; body jsonb; observation jsonb; content text; until_time timestamptz;
begin
 j:=fluid_private.naming_responses_lock(p_job_id,p_lease_token); run_id:=(j.input->>'runId')::uuid;
 if p_action='load' then
  if p_payload is distinct from '{}'::jsonb then raise exception 'invalid_responses_payload' using errcode='22023'; end if;
  return jsonb_build_object('runId',run_id,'allocatedCostNanoUsd',coalesce((select sum(maximum_cost_nano_usd) from fluid_private.naming_responses_dispatches where naming_responses_dispatches.run_id=run_id),0),'maximumCostNanoUsd',5000000000,
   'dispatches',coalesce((select jsonb_agg(fluid_private.naming_responses_dispatch_dto(run_id,dispatch_key) order by created_at,dispatch_key) from fluid_private.naming_responses_dispatches where naming_responses_dispatches.run_id=run_id),'[]'::jsonb));
 end if;
 if p_action='reserve' then
  if j.state<>'running' or j.cancel_requested_at is not null or exists(select 1 from public.projects where id=j.project_id and (deleted_at is not null or deletion_requested_at is not null)) then raise exception 'responses_dispatch_stopped' using errcode='55000'; end if;
  if not fluid_private.naming_responses_run_safe(run_id) then raise exception 'responses_observed_bound_exceeded' using errcode='55000'; end if;
  maximum:=fluid_private.naming_responses_quote(p_payload,j.owner_id,j.project_id);
  if p_payload->>'runId' is distinct from run_id::text then raise exception 'responses_run_mismatch' using errcode='22023'; end if;
  key:=p_payload->>'dispatchKey';
  select * into d from fluid_private.naming_responses_dispatches where naming_responses_dispatches.run_id=run_id and dispatch_key=key;
  if found then if d.request<>p_payload then raise exception 'immutable_responses_request' using errcode='55000'; end if; return fluid_private.naming_responses_dispatch_dto(run_id,key); end if;
  select coalesce(sum(maximum_cost_nano_usd),0) into allocated from fluid_private.naming_responses_dispatches where naming_responses_dispatches.run_id=run_id;
  if (select count(*) from fluid_private.naming_responses_dispatches where naming_responses_dispatches.run_id=run_id)>=100 then raise exception 'responses_dispatch_limit' using errcode='55000'; end if;
  if allocated+maximum>5000000000 then raise exception 'responses_budget_exhausted' using errcode='55000'; end if;
  insert into fluid_private.naming_responses_runs(id,job_id,owner_id,project_id,admitted_role_name,admitted_role_oid) select run_id,j.id,j.owner_id,j.project_id,rolname,oid from pg_roles where rolname=session_user on conflict do nothing;
  until_time:=clock_timestamp();
  insert into fluid_private.naming_responses_dispatches values(run_id,j.owner_id,j.project_id,key,p_payload,p_payload->>'requestHash',maximum,p_payload#>>'{quote,rateCardId}',p_payload#>>'{quote,qualificationId}',until_time,until_time+interval '15 minutes',until_time+interval '30 minutes');
  insert into fluid_private.naming_responses_attempts(run_id,dispatch_key) values(run_id,key);
  return fluid_private.naming_responses_dispatch_dto(run_id,key);
 end if;
 key:=p_payload->>'dispatchKey';
 select * into d from fluid_private.naming_responses_dispatches where naming_responses_dispatches.run_id=run_id and dispatch_key=key;
 if not found then raise exception 'responses_dispatch_missing' using errcode='P0002'; end if;
 select * into strict a from fluid_private.naming_responses_attempts where naming_responses_attempts.run_id=run_id and dispatch_key=key for update;
 if p_action='begin' then
  if p_payload is distinct from jsonb_build_object('dispatchKey',key) then raise exception 'invalid_responses_payload' using errcode='22023'; end if;
  if not fluid_private.naming_responses_run_safe(run_id) or a.state<>'reserved' or j.state<>'running' or j.cancel_requested_at is not null or clock_timestamp()>=d.execution_deadline_at
   or exists(select 1 from public.projects where id=j.project_id and (deleted_at is not null or deletion_requested_at is not null)) then return 'false'::jsonb; end if;
  begin perform fluid_private.naming_responses_quote(d.request,j.owner_id,j.project_id); exception when sqlstate '55000' then return 'false'::jsonb; end;
  update fluid_private.naming_responses_attempts set state='dispatching' where naming_responses_attempts.run_id=run_id and dispatch_key=key;
  return 'true'::jsonb;
 end if;
 if clock_timestamp()>=d.observation_deadline_at then raise exception 'responses_observation_expired' using errcode='55000'; end if;
 if p_action='handle' then
  if p_payload is distinct from jsonb_build_object('dispatchKey',key,'responseId',p_payload->'responseId') or coalesce(p_payload->>'responseId','')!~'^resp_[A-Za-z0-9_-]{1,194}$' then raise exception 'invalid_responses_identity' using errcode='22023'; end if;
  if a.state in('accepted','terminal') and a.response_id=p_payload->>'responseId' then return fluid_private.naming_responses_dispatch_dto(run_id,key); end if;
  if a.state<>'dispatching' then raise exception 'responses_identity_conflict' using errcode='55000'; end if;
  update fluid_private.naming_responses_attempts set state='accepted',response_id=p_payload->>'responseId' where naming_responses_attempts.run_id=run_id and dispatch_key=key;
 elsif p_action='observe' then
  body:=p_payload->'response';
  if p_payload-array['dispatchKey','response','requestId']<>'{}'::jsonb or jsonb_typeof(body) is distinct from 'object' or body->>'id' is distinct from a.response_id or a.state not in('accepted','terminal')
  or body->>'object' is distinct from 'response' or body->'metadata' is distinct from d.request#>'{body,metadata}'
  or (p_payload->'requestId'<>'null'::jsonb and coalesce(p_payload->>'requestId','')!~'^[A-Za-z0-9_-]{1,200}$') then raise exception 'invalid_responses_observation' using errcode='22023'; end if;
  observation:=jsonb_build_object('response',body,'requestId',p_payload->'requestId');content:=encode(sha256(convert_to(observation::text,'UTF8')),'hex');
  if exists(select 1 from fluid_private.naming_responses_observations where naming_responses_observations.run_id=run_id and dispatch_key=key and content_hash=content) then return fluid_private.naming_responses_dispatch_dto(run_id,key); end if;
  -- Retain a compact unsafe witness instead of losing all evidence when the raw
  -- body/history exceeds bounded storage. It can never qualify final output.
  if (select count(*) from fluid_private.naming_responses_observations where naming_responses_observations.run_id=run_id and dispatch_key=key)>100 then raise exception 'responses_observation_limit' using errcode='22023'; end if;
  if octet_length(observation::text)>2097152 or (select count(*) from fluid_private.naming_responses_observations where naming_responses_observations.run_id=run_id and dispatch_key=key)>=100
   or (select coalesce(sum(octet_length(naming_responses_observations.observation::text)),0) from fluid_private.naming_responses_observations where naming_responses_observations.run_id=run_id and dispatch_key=key)+octet_length(observation::text)>8388608 then
   observation:=jsonb_build_object('kind','oversize_response','responseId',a.response_id,'requestId',p_payload->'requestId','bytes',octet_length(body::text),'sha256',encode(sha256(convert_to(body::text,'UTF8')),'hex'),'unsafeReason','responses_output_limit');
  elsif a.state='terminal' and body<>a.terminal_response then observation:=observation||jsonb_build_object('unsafeReason','responses_terminal_conflict'); end if;
  content:=encode(sha256(convert_to(observation::text,'UTF8')),'hex');
  insert into fluid_private.naming_responses_observations(run_id,dispatch_key,observation,content_hash) values(run_id,key,observation,content) on conflict do nothing;
  if a.state<>'terminal' and observation ? 'response' and body->>'status' in('completed','failed','cancelled','incomplete') then update fluid_private.naming_responses_attempts set state='terminal',terminal_response=body where naming_responses_attempts.run_id=run_id and dispatch_key=key; end if;
 elsif p_action='reject' then
  if p_payload is distinct from jsonb_build_object('dispatchKey',key,'requestId',p_payload->'requestId','code','provider_request_rejected') or coalesce(p_payload->>'requestId','')!~'^[A-Za-z0-9_-]{1,200}$' or a.state not in('dispatching','rejected') then raise exception 'invalid_responses_rejection' using errcode='22023'; end if;
  observation:=jsonb_build_object('code','provider_request_rejected','requestId',p_payload->'requestId');content:=encode(sha256(convert_to(observation::text,'UTF8')),'hex');
  if a.state='rejected' then
   if exists(select 1 from fluid_private.naming_responses_observations where naming_responses_observations.run_id=run_id and dispatch_key=key and content_hash=content) then return fluid_private.naming_responses_dispatch_dto(run_id,key); end if;
   raise exception 'immutable_responses_rejection' using errcode='55000';
  end if;
  insert into fluid_private.naming_responses_observations(run_id,dispatch_key,observation,content_hash) values(run_id,key,observation,content);
  update fluid_private.naming_responses_attempts set state='rejected' where naming_responses_attempts.run_id=run_id and dispatch_key=key;
 else raise exception 'unsupported_responses_action' using errcode='22023'; end if;
 return fluid_private.naming_responses_dispatch_dto(run_id,key);
end $$;
-- Production admission cannot become available through a worker flag or an
-- administrator's fixture row: required hosted-research input proof is absent.
create function public.ensure_naming_responses_run(p_project_id uuid,p_intent jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare o uuid:=auth.uid(); begin
 if o is null then raise exception 'unauthenticated' using errcode='42501'; end if;
 perform 1 from public.projects where id=p_project_id and owner_id=o and deleted_at is null and deletion_requested_at is null;
 if not found then raise exception 'not_found' using errcode='P0002'; end if;
 if jsonb_typeof(p_intent) is distinct from 'object' or octet_length(p_intent::text)>65536 then raise exception 'invalid_responses_intent' using errcode='22023'; end if;
 return jsonb_build_object('status','blocked','code','provider_budget_control_unavailable','message','Required hosted research has no qualified cumulative input cost bound. No job or reservation was created.','action','configure');
end $$;
-- Generic workers/expiry must never adopt even a malformed new-version job.
do $$ declare signature text; needle text; replacement text; definition text; begin
 for signature,needle,replacement in values
 ('public.claim_job(text,integer)','where not fluid_private.naming_brain_is_job(j) and not exists','where not fluid_private.naming_responses_is_job(j) and not fluid_private.naming_brain_is_job(j) and not exists'),
 ('public.expire_job_leases()','where not fluid_private.naming_brain_is_job(jobs) and not exists','where not fluid_private.naming_responses_is_job(jobs) and not fluid_private.naming_brain_is_job(jobs) and not exists') loop
  definition:=pg_get_functiondef(signature::regprocedure);
  if (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 then raise exception 'unexpected_responses_guard_predecessor'; end if;
  execute replace(definition,needle,replacement);
 end loop;
end $$;
alter function fluid_private.settle_reservation(uuid) rename to naming_responses_previous_settle;
create function fluid_private.settle_reservation(p_job_id uuid) returns void language plpgsql set search_path='' as $$
begin
 if exists(select 1 from public.jobs j where j.id=p_job_id and fluid_private.naming_responses_is_job(j)) then return; end if;
 perform fluid_private.naming_responses_previous_settle(p_job_id);
end $$;
revoke all on function fluid_private.settle_reservation(uuid) from public,anon,authenticated,service_role;
revoke all on function public.naming_responses_worker_action(uuid,uuid,text,jsonb) from public,anon,authenticated,service_role;
revoke all on function public.ensure_naming_responses_run(uuid,jsonb) from public,anon,service_role;
grant execute on function public.ensure_naming_responses_run(uuid,jsonb) to authenticated;
do $$ declare f record; begin
 for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='fluid_private' and p.proname like 'naming_responses_%' loop execute format('revoke all on function %s from public,anon,authenticated,service_role',f.signature); end loop;
end $$;
commit;
