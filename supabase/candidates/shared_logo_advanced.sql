-- UNAPPLIED shared advanced Logo v3 packet. Target: qualified current local-image
-- production predecessor plus shared_worker_logo/shared_storage_authority.
-- The conflicting historical proposal activation chain is NOT installed here.
-- Specialized validators/result/materialization code is retained under versioned
-- shared names. No credentials, roles, provider calls or activation is performed.
begin;
do $$begin
 if session_user<>'postgres' or current_user<>session_user
  or to_regprocedure('public.shared_logo_worker_action(jsonb,jsonb,text,jsonb)') is null
  or to_regclass('fluid_private.logo_vector_proposals') is not null
  or to_regclass('fluid_private.shared_logo_vector_proposals') is not null
  or not exists(select 1 from pg_proc where oid='public.complete_logo_job_step(uuid,uuid,text,text,bigint,jsonb,text)'::regprocedure
   and md5(prosrc)='a638f170315481412f111e4b11ba961d' and proowner=to_regrole('postgres')::oid and proconfig=array['search_path=""'])
 then raise exception 'shared_logo_advanced_predecessor_unqualified' using errcode='55000'; end if;
end $$;
create temporary table shared_logo_advanced_previous_objects on commit drop as
 select 'pg_class'::regclass::oid classid,oid from pg_class union all select 'pg_proc'::regclass::oid,oid from pg_proc;

-- Runtime advertisement follows native/Storage/engine construction. A slot
-- lease alone is not advanced-operation readiness. Re-advertising requires the
-- complete exact registered capability set and the current actual login lease.
create table fluid_private.shared_logo_slot_runtime_readiness(
 slot_id uuid primary key references fluid_private.shared_worker_slots(slot_id),instance_id uuid not null,generation bigint not null,
 lease_token uuid not null,policies jsonb not null,expires_at timestamptz not null,observed_at timestamptz not null default clock_timestamp()
);
create function fluid_private.shared_logo_slot_runtime_ready(p_slot uuid) returns boolean
language sql volatile security definer set search_path='' as $$
 select exists(select 1 from fluid_private.shared_logo_slot_runtime_readiness r join fluid_private.shared_worker_slots s using(slot_id)
  where s.slot_id=p_slot and s.lane='logo' and s.enabled and s.expires_at>clock_timestamp() and r.expires_at>clock_timestamp()
   and(r.instance_id,r.generation,r.lease_token)=(s.instance_id,s.generation,s.lease_token)
   and fluid_private.shared_worker_role_safe(s.role_name,s.role_oid)
   and r.policies=(select coalesce(jsonb_agg(p.policy order by p.operation),'[]'::jsonb) from fluid_private.shared_worker_policies p where p.slot_id=s.slot_id));
$$;
create function fluid_private.shared_logo_runtime_manifest_item_valid(p jsonb) returns boolean
language plpgsql stable set search_path='' as $$declare valid boolean;begin
 if p->>'operation'='identity.image' then
  if to_regprocedure('fluid_private.shared_identity_policy_valid(jsonb)') is null then return false;end if;
  execute 'select fluid_private.shared_identity_policy_valid($1)' into valid using p;return coalesce(valid,false);
 end if;return fluid_private.shared_logo_policy_valid(p->>'operation',p);
end $$;
create function fluid_private.shared_logo_report_runtime_ready(p_slot jsonb,p_manifest jsonb) returns boolean
language plpgsql security definer set search_path='' as $$declare s fluid_private.shared_worker_slots; expected jsonb; supplied jsonb; begin
 s:=fluid_private.lock_shared_worker_slot(p_slot,true);
 if s.lane<>'logo' then raise exception 'shared_logo_slot_required' using errcode='42501';end if;
 if jsonb_typeof(p_manifest) is distinct from 'array' or jsonb_array_length(p_manifest) not between 1 and 7 or octet_length(p_manifest::text)>131072
  or(select count(*)<>count(distinct value->>'operation') from jsonb_array_elements(p_manifest)) then raise exception 'shared_logo_runtime_manifest_invalid' using errcode='22023';end if;
 select jsonb_agg(policy order by operation) into expected from fluid_private.shared_worker_policies where slot_id=s.slot_id;
 select jsonb_agg(value order by value->>'operation') into supplied from jsonb_array_elements(p_manifest);
 if expected is null or expected is distinct from supplied or exists(select 1 from fluid_private.shared_worker_policies p where p.slot_id=s.slot_id
  and(p.policy->>'operation' is distinct from p.operation or p.policy->>'policyIdentity' is distinct from p.policy_identity or not fluid_private.shared_logo_runtime_manifest_item_valid(p.policy))) then raise exception 'shared_logo_runtime_manifest_mismatch' using errcode='42501';end if;
 insert into fluid_private.shared_logo_slot_runtime_readiness(slot_id,instance_id,generation,lease_token,policies,expires_at)
  values(s.slot_id,s.instance_id,s.generation,s.lease_token,expected,least(s.expires_at,clock_timestamp()+interval '90 seconds'))
  on conflict(slot_id) do update set instance_id=excluded.instance_id,generation=excluded.generation,lease_token=excluded.lease_token,policies=excluded.policies,
   expires_at=excluded.expires_at,observed_at=clock_timestamp();return true;
end $$;

create function fluid_private.shared_logo_text_policy_valid(p jsonb,p_kind text) returns boolean
language plpgsql immutable set search_path='' as $$declare k text; n numeric; keys text[]; begin
 keys:=array['version','billingMode','spendControl','handlerVersion','adapterVersion','model','pricingVersion','serviceTier','maxInputTokens','maxOutputTokens','maxInputBytes','maxOutputBytes','maxStreamBytes','deadlineMs','maxTools','inputMicrousdPerMillionTokens','cachedInputMicrousdPerMillionTokens','cacheWriteMicrousdPerMillionTokens','outputMicrousdPerMillionTokens'];
 if p_kind='proposal' then keys:=array_append(keys,'schemaVersion'); elsif p_kind<>'directions' then return false; end if;
 if not fluid_private.standalone_keys(p,keys) or p->>'billingMode' is distinct from 'openai_api' or p->>'spendControl' is distinct from 'uncapped'
  or p->>'model' is distinct from 'gpt-6.1-sol' or p->>'pricingVersion' is distinct from '2026-10-03' or p->>'serviceTier' is distinct from 'default'
  or p->'maxTools' is distinct from '0'::jsonb or p->'inputMicrousdPerMillionTokens' is distinct from '2000000'::jsonb
  or p->'cachedInputMicrousdPerMillionTokens' is distinct from '100000'::jsonb or p->'cacheWriteMicrousdPerMillionTokens' is distinct from '2500000'::jsonb
  or p->'outputMicrousdPerMillionTokens' is distinct from '10000000'::jsonb then return false; end if;
 if p_kind='directions' then
  if p->'version' is distinct from '1'::jsonb or p->>'handlerVersion' is distinct from 'logo-directions-api-v1' or p->>'adapterVersion' is distinct from 'logo-directions-openai-v1' then return false; end if;
 else
  if p->'version' is distinct from '2'::jsonb or p->>'handlerVersion' is distinct from 'logo-vector-propose-v1' or p->>'adapterVersion' is distinct from 'logo-vector-propose-api-uncapped-v2'
   or p->>'schemaVersion' is distinct from 'logo-vector-proposal-v1' then return false; end if;
 end if;
 foreach k in array array['maxInputTokens','maxOutputTokens','maxInputBytes','maxOutputBytes','maxStreamBytes','deadlineMs'] loop
  if jsonb_typeof(p->k) is distinct from 'number' then return false; end if; n:=(p->>k)::numeric;
  if trunc(n)<>n or n<(case when k in('maxInputBytes','maxOutputBytes','maxStreamBytes') then 1024 when k='deadlineMs' then 1000 else 1 end)
   or n>(case k when 'maxInputTokens' then 32768 when 'maxOutputTokens' then 4096 when 'maxInputBytes' then 131072 when 'maxOutputBytes' then 32768 when 'maxStreamBytes' then 2097152 when 'deadlineMs' then 240000 end) then return false; end if;
 end loop; return true;
exception when others then return false;
end $$;
create function fluid_private.shared_logo_advanced_policy_valid(p_operation text,p jsonb) returns boolean
language sql immutable set search_path='' as $$
 select coalesce(p->>'operation'=p_operation and p->>'policyIdentity'~'^[a-f0-9]{64}$' and p->>'spendControl'='uncapped'
  and p->>'provider'='openai' and p->>'model'='gpt-6.1-sol' and p->'engine'='null'::jsonb and (
   p_operation='identity.logo_directions' and fluid_private.standalone_keys(p,array['operation','policyIdentity','handlerVersion','provider','model','engine','spendControl','apiPolicy'])
    and p->>'handlerVersion'='logo-directions-api-v1' and fluid_private.shared_logo_text_policy_valid(p->'apiPolicy','directions')
   or p_operation='identity.logo_vector_propose' and fluid_private.standalone_keys(p,array['operation','policyIdentity','handlerVersion','provider','model','engine','spendControl','textPolicy'])
    and p->>'handlerVersion'='logo-vector-propose-v1' and fluid_private.shared_logo_text_policy_valid(p->'textPolicy','proposal')),false);
$$;
create function fluid_private.shared_logo_valid_vector_proposal_text_policy(p jsonb) returns boolean
language sql immutable set search_path='' as $$select fluid_private.shared_logo_text_policy_valid(p,'proposal')$$;

create table fluid_private.shared_logo_advanced_quotes(
 quote_id uuid primary key,owner_id uuid not null,project_id uuid not null,operation text not null,
 policy jsonb not null,deployment_id text not null,created_at timestamptz not null default clock_timestamp(),
 foreign key(quote_id,owner_id,project_id) references public.logo_cost_quotes(id,owner_id,project_id),
 check(fluid_private.shared_logo_advanced_policy_valid(operation,policy))
);
create trigger shared_logo_advanced_quote_immutable before update or delete on fluid_private.shared_logo_advanced_quotes for each row execute function fluid_private.prevent_history_change();
create table fluid_private.shared_logo_vector_proposal_dispatches(
 job_id uuid primary key,owner_id uuid not null,project_id uuid not null,quote_id uuid not null,
 role_name name not null,role_oid oid not null,worker_id text not null check(length(worker_id) between 1 and 200),
 lease_token uuid not null,step_key text not null check(step_key in('propose-directions','propose-vector-edit')),step_request_key text not null check(length(step_request_key) between 1 and 200),
 input jsonb not null,created_at timestamptz not null default clock_timestamp(),
 foreign key(job_id,owner_id,project_id) references public.jobs(id,owner_id,project_id),
 foreign key(quote_id,owner_id,project_id) references public.logo_cost_quotes(id,owner_id,project_id),
 foreign key(job_id,step_key) references public.job_steps(job_id,step_key)
);
create trigger shared_logo_advanced_dispatch_immutable before update or delete on fluid_private.shared_logo_vector_proposal_dispatches for each row execute function fluid_private.prevent_history_change();
create function fluid_private.shared_logo_advanced_quote_binding(q public.logo_cost_quotes,approved jsonb) returns boolean
language plpgsql stable set search_path='' as $$declare retained fluid_private.shared_logo_advanced_quotes; kind text; begin
 select * into retained from fluid_private.shared_logo_advanced_quotes where quote_id=q.id and owner_id=q.owner_id and project_id=q.project_id;
 kind:=case q.operation when 'identity.logo_directions' then 'apiPolicy' when 'identity.logo_vector_propose' then 'textPolicy' end;
 if not found or kind is null or retained.operation is distinct from q.operation or retained.policy is distinct from approved
  or not fluid_private.shared_logo_advanced_policy_valid(q.operation,approved)
  or q.record->'version' is distinct from '3'::jsonb or q.record->>'billingMode' is distinct from 'openai_api' or q.record->>'spendControl' is distinct from 'uncapped'
  or q.record->>'id' is distinct from q.id::text or q.record->>'ownerId' is distinct from q.owner_id::text or q.record->>'projectId' is distinct from q.project_id::text
  or q.record->'expected' is distinct from q.record#>'{request,expected}' or q.record->>'policyIdentity' is distinct from approved->>'policyIdentity'
  or q.record->>'handlerVersion' is distinct from approved->>'handlerVersion' or q.record->'provider' is distinct from approved->'provider'
  or q.record->'model' is distinct from approved->'model' or q.record->'engine' is distinct from 'null'::jsonb or q.record->kind is distinct from approved->kind
  or q.record ?| array['maxCostMicrousd','maximumCostMicrousd','estimatedCostMicrousd','externalProviderCostMicrousd','policy'] then return false; end if;
 return q.record->>'inputHash'=encode(sha256(convert_to(jsonb_build_object('request',q.record->'request','sources',q.source_inputs,'policy',approved)::text,'UTF8')),'hex');
exception when others then return false;
end $$;
create function fluid_private.shared_logo_vector_proposal_quote_binding(q public.logo_cost_quotes) returns boolean
language sql stable set search_path='' as $$ select q.operation='identity.logo_vector_propose' and fluid_private.shared_logo_advanced_quote_binding(q,(select policy from fluid_private.shared_logo_advanced_quotes where quote_id=q.id)); $$;
create function fluid_private.shared_logo_advanced_job_matches(j public.jobs,approved jsonb) returns boolean
language plpgsql stable set search_path='' as $$declare q public.logo_cost_quotes; input jsonb; manifest jsonb; begin
 if j.id is null or j.operation not in('identity.logo_directions','identity.logo_vector_propose') or j.billing_mode<>'openai_api' or j.policy_identity is not null
  or j.max_attempts<>1 or j.reserved_cost_microusd<>0 or not fluid_private.logo_uuid(j.input->'requestKey') then return false; end if;
 select * into q from public.logo_cost_quotes where id=(j.input->>'quoteId')::uuid and(owner_id,project_id,operation)=(j.owner_id,j.project_id,j.operation);
 if not found or not fluid_private.shared_logo_advanced_quote_binding(q,approved) or j.input_hash is distinct from q.record->>'inputHash'
  or j.input_revision is distinct from(q.record#>>'{expected,projectRevision}')::integer then return false; end if;
 input:=jsonb_build_object('version',3,'ownerId',j.owner_id,'projectId',j.project_id,'operation',j.operation,'requestKey',j.input->'requestKey','quoteId',q.id,
  'policyIdentity',approved->'policyIdentity','handlerVersion',approved->'handlerVersion','inputHash',j.input_hash,'billingMode','openai_api','spendControl','uncapped');
 if j.operation='identity.logo_directions' then
  input:=input||jsonb_build_object('approvedLogoId',q.record#>'{request,approvedLogoId}','briefRevisionId',q.source_inputs#>'{direction,brief,id}',
   'referenceSnapshotId',q.source_inputs#>'{direction,references,id}','fontVersionIds',(select coalesce(jsonb_agg(f->'id'),'[]') from jsonb_array_elements(q.source_inputs#>'{direction,permittedFonts}') f),'targetCount',3,'apiPolicy',approved->'apiPolicy');
  manifest:=jsonb_build_array(jsonb_build_object('key','propose-directions','maximumCostMicrousd',0));
 else
  input:=input||jsonb_build_object('baseVectorRevisionId',q.record#>'{request,baseVectorRevisionId}','contextHash',q.source_inputs->'contextHash',
   'instruction',q.record#>'{request,instruction}','targetComponentIds',q.record#>'{request,targetComponentIds}','textPolicy',approved->'textPolicy');
  manifest:=jsonb_build_array(jsonb_build_object('key','propose-vector-edit','maximumCostMicrousd',0));
 end if;
 return j.input=input and j.plan_manifest=manifest and j.plan_fingerprint=encode(sha256(convert_to(manifest::text,'UTF8')),'hex') and j.plan_registered_at is not null
  and exists(select 1 from public.logo_operation_requests r where r.owner_id=j.owner_id and r.project_id=j.project_id and r.quote_id=q.id and r.request_key::text=j.input->>'requestKey'
   and r.input=jsonb_build_object('requestKey',j.input->'requestKey','quoteId',q.id,'expected',q.record->'expected')
   and r.receipt->'jobIds'=jsonb_build_array(j.id) and r.receipt->>'operation'=j.operation and r.receipt->>'inputHash'=j.input_hash);
exception when others then return false;
end $$;
create function fluid_private.shared_logo_vector_proposal_job_quote_matches(j public.jobs,q public.logo_cost_quotes) returns boolean
language sql stable set search_path='' as $$select j.operation='identity.logo_vector_propose' and j.input->>'quoteId'=q.id::text
 and fluid_private.shared_logo_advanced_job_matches(j,(select policy from fluid_private.shared_logo_advanced_quotes where quote_id=q.id));$$;
create function fluid_private.shared_logo_lock_issued_job(p_job uuid,p_lease uuid) returns public.jobs
language plpgsql set search_path='' as $$declare j public.jobs; d fluid_private.shared_logo_vector_proposal_dispatches; begin
 if fluid_private.shared_worker_context_job('logo') is distinct from p_job then raise exception 'shared_logo_issued_context_required' using errcode='42501'; end if;
 select * into j from public.jobs where id=p_job and owner_id=fluid_private.logo_worker_owner() for update;
 select * into d from fluid_private.shared_logo_vector_proposal_dispatches where job_id=j.id and owner_id=j.owner_id and project_id=j.project_id;
 if j.id is null or d.job_id is null or p_lease is null or d.lease_token is distinct from p_lease or d.role_name is distinct from session_user
  or d.role_oid is distinct from to_regrole(session_user)::oid or d.worker_id is distinct from j.worker_id or d.input is distinct from j.input or j.attempts<>1
  or not fluid_private.shared_logo_advanced_job_matches(j,(select policy from fluid_private.shared_logo_advanced_quotes where quote_id=d.quote_id))
  or not exists(select 1 from public.job_steps s where(s.job_id,s.owner_id,s.project_id,s.step_key,s.request_key,s.reserved_cost_microusd)=(j.id,j.owner_id,j.project_id,d.step_key,d.step_request_key,0::bigint))
 then raise exception 'shared_logo_issued_binding_invalid' using errcode='42501'; end if; return j;
end $$;
create function fluid_private.shared_logo_lock_vector_proposal_dispatch(p_job uuid,p_lease uuid) returns public.jobs
language plpgsql set search_path='' as $$declare j public.jobs; begin
 j:=fluid_private.shared_logo_lock_issued_job(p_job,p_lease); if j.operation<>'identity.logo_vector_propose' then raise exception 'wrong_logo_operation' using errcode='42501'; end if;return j;
end $$;

create table fluid_private.shared_logo_vector_proposals (
 id uuid primary key, owner_id uuid not null, project_id uuid not null, job_id uuid not null unique,
 request_key uuid not null, quote_id uuid not null, base_vector_revision_id uuid not null, record jsonb not null,
 created_at timestamptz not null default clock_timestamp(),
 unique(id,owner_id,project_id), unique(owner_id,project_id,request_key),
 foreign key(job_id,owner_id,project_id) references public.jobs(id,owner_id,project_id),
 foreign key(quote_id,owner_id,project_id) references public.logo_cost_quotes(id,owner_id,project_id),
 foreign key(base_vector_revision_id,owner_id,project_id) references public.logo_vector_revisions(id,owner_id,project_id),
 check(octet_length(record::text)<=131072),
 check((record->>'id'=id::text and record->>'ownerId'=owner_id::text and record->>'projectId'=project_id::text
  and record->>'jobId'=job_id::text and record->>'requestKey'=request_key::text and record->>'quoteId'=quote_id::text
  and record->>'baseVectorRevisionId'=base_vector_revision_id::text and record->>'materialization'='unavailable'
  and record->>'state' in('succeeded','failed','needs_reconciliation')) is true)
);
alter table fluid_private.shared_logo_vector_proposals enable row level security;
alter table fluid_private.shared_logo_vector_proposals force row level security;
create index logo_vector_proposals_owned on fluid_private.shared_logo_vector_proposals(owner_id,project_id,created_at desc,id desc);
create trigger logo_vector_proposals_immutable before update or delete on fluid_private.shared_logo_vector_proposals for each row execute function fluid_private.prevent_history_change();

create function public.read_logo_vector_proposal(p_project_id uuid,p_proposal_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare owner uuid:=auth.uid();result jsonb;
begin
 if owner is null then raise exception 'unauthenticated' using errcode='42501';end if;
 if not exists(select 1 from public.projects where id=p_project_id and owner_id=owner) then raise exception 'logo_project_not_found' using errcode='P0002';end if;
 select record into result from fluid_private.shared_logo_vector_proposals where id=p_proposal_id and owner_id=owner and project_id=p_project_id;
 if not found then raise exception 'logo_proposal_not_found' using errcode='P0002';end if;
 return result;
end $$;

create function public.list_logo_vector_proposals(p_project_id uuid,p_query jsonb) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare owner uuid:=auth.uid();n integer;cursor_value jsonb;cursor_id uuid;cursor_time timestamptz;row fluid_private.shared_logo_vector_proposals;
 items jsonb:='[]';next_cursor text;seen integer:=0;
begin
 if owner is null then raise exception 'unauthenticated' using errcode='42501';end if;
 if not exists(select 1 from public.projects where id=p_project_id and owner_id=owner) then raise exception 'logo_project_not_found' using errcode='P0002';end if;
 if jsonb_typeof(p_query) is distinct from 'object' or octet_length(p_query::text)>4096 or exists(select 1 from jsonb_object_keys(p_query) k where k not in('cursor','limit')) then raise exception 'invalid_logo_page' using errcode='22023';end if;
 if p_query?'limit' and (jsonb_typeof(p_query->'limit') is distinct from 'number' or (p_query->>'limit')::numeric not between 1 and 50 or (p_query->>'limit')::numeric<>trunc((p_query->>'limit')::numeric)) then raise exception 'invalid_logo_page' using errcode='22023';end if;
 n:=coalesce((p_query->>'limit')::integer,20);
 if p_query?'cursor' then
  if jsonb_typeof(p_query->'cursor') is distinct from 'string' or length(p_query->>'cursor') not between 4 and 2048 or p_query->>'cursor'!~'^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$' then raise exception 'invalid_logo_cursor' using errcode='22023';end if;
  begin cursor_value:=convert_from(decode(p_query->>'cursor','base64'),'UTF8')::jsonb;
  exception when others then raise exception 'invalid_logo_cursor' using errcode='22023';end;
  if fluid_private.standalone_keys(cursor_value,array['ownerId','projectId','id','createdAt']) is distinct from true
   or cursor_value->>'ownerId' is distinct from owner::text or cursor_value->>'projectId' is distinct from p_project_id::text
   or fluid_private.logo_uuid(cursor_value->'id') is distinct from true or fluid_private.standalone_timestamp(cursor_value->'createdAt') is distinct from true then raise exception 'invalid_logo_cursor' using errcode='22023';end if;
  cursor_id:=(cursor_value->>'id')::uuid;cursor_time:=(cursor_value->>'createdAt')::timestamptz;
  if not exists(select 1 from fluid_private.shared_logo_vector_proposals where id=cursor_id and owner_id=owner and project_id=p_project_id and created_at=cursor_time) then raise exception 'invalid_logo_cursor' using errcode='22023';end if;
 end if;
 for row in select * from fluid_private.shared_logo_vector_proposals r where owner_id=owner and project_id=p_project_id
  and(cursor_id is null or(r.created_at,r.id)<(cursor_time,cursor_id)) order by r.created_at desc,r.id desc limit n+1 loop
  seen:=seen+1;
  if seen>n then return jsonb_build_object('ownerId',owner,'projectId',p_project_id,'items',items,'nextCursor',next_cursor);end if;
  items:=items||jsonb_build_array(jsonb_build_object('id',row.id,'jobId',row.job_id,'requestKey',row.request_key,'baseVectorRevisionId',row.base_vector_revision_id,'state',row.record->'state','createdAt',row.record->'createdAt'));
  next_cursor:=replace(encode(convert_to(jsonb_build_object('ownerId',owner,'projectId',p_project_id,'id',row.id,'createdAt',to_char(row.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))::text,'UTF8'),'base64'),E'\n','');
 end loop;
 return jsonb_build_object('ownerId',owner,'projectId',p_project_id,'items',items,'nextCursor',null);
end $$;

-- Compose with the exact restricted-runtime predecessor, or its exact Naming
-- wrapper plus unchanged delegated predecessor. Preserve both owners and ACLs.

create function fluid_private.shared_logo_vector_proposal_payload_shape_valid(v jsonb,c jsonb) returns boolean
language plpgsql immutable set search_path='' as $$
declare e jsonb:=v->'edit';component jsonb;item jsonb;t jsonb;k text;id text;ord bigint;
begin
 if octet_length(v::text)>32768 or v->'version' is distinct from '1'::jsonb or fluid_private.standalone_text(v->'explanation',1000,1) is distinct from true or nullif(btrim(v->>'explanation',U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'),'') is null then return false;end if;
 if v->>'status'='unsupported' then return fluid_private.standalone_keys(v,array['version','status','code','explanation']) and v->>'code' in('unsupported_request','multiple_changes','unsupported_component','unsupported_paint','unsupported_text','locked_component','no_change');end if;
 if v->>'status' is distinct from 'proposed' or fluid_private.standalone_keys(v,array['version','status','edit','explanation']) is distinct from true or e->>'kind' not in('size','rotation','color','arrangement','font','spacing') then return false;end if;
 if e->>'kind'='arrangement' then
  if fluid_private.standalone_keys(e,array['kind','placements','order']) is distinct from true or jsonb_typeof(e->'placements') is distinct from 'array' or jsonb_array_length(e->'placements') not between 1 and 64 or jsonb_typeof(e->'order') is distinct from 'array'
   or jsonb_array_length(e->'order') is distinct from jsonb_array_length(c->'components') or(select count(*)<>count(distinct value) from jsonb_array_elements(e->'order'))
   or(select count(*)<>count(distinct value->>'componentId') from jsonb_array_elements(e->'placements')) then return false;end if;
  for item,ord in select value,ordinality from jsonb_array_elements(e->'order') with ordinality loop
   if jsonb_typeof(item) is distinct from 'string' or not exists(select 1 from jsonb_array_elements(c->'components') x where x->'id'=item) then return false;end if;
   if c#>array['components',(ord-1)::text,'id'] is distinct from item and (not(c->'targetComponentIds'@>jsonb_build_array(item)) or exists(select 1 from jsonb_array_elements(c->'locks') l where l->'componentId'=item)) then return false;end if;
  end loop;
  for item in select value from jsonb_array_elements(e->'placements') loop
   if fluid_private.standalone_keys(item,array['componentId','transform']) is distinct from true or not(c->'targetComponentIds'@>jsonb_build_array(item->'componentId')) or exists(select 1 from jsonb_array_elements(c->'locks') l where l->'componentId'=item->'componentId') then return false;end if;
   select value into component from jsonb_array_elements(c->'components') where value->'id'=item->'componentId';
   if component is null or not(component->'allowedOperations'@>'["arrangement"]') then return false;end if;
   t:=item->'transform';if fluid_private.standalone_keys(t,array['x','y','scale','rotation']) is distinct from true then return false;end if;
   foreach k in array array['x','y','scale','rotation'] loop
    if jsonb_typeof(t->k) is distinct from 'number' or(t->>k)::numeric<(case k when 'scale' then 0.01 when 'rotation' then -180 else -1000000 end) or(t->>k)::numeric>(case k when 'scale' then 100 when 'rotation' then 180 else 1000000 end) then return false;end if;
   end loop;
  end loop;return true;
 end if;
 id:=e->>'componentId';select value into component from jsonb_array_elements(c->'components') where value->>'id'=id;
 if component is null or not(c->'targetComponentIds'@>jsonb_build_array(id)) or exists(select 1 from jsonb_array_elements(c->'locks') l where l->>'componentId'=id) or not(component->'allowedOperations'@>jsonb_build_array(e->>'kind')) then return false;end if;
 case e->>'kind'
 when 'size' then return fluid_private.standalone_keys(e,array['kind','componentId','scale']) and jsonb_typeof(e->'scale')='number' and(e->>'scale')::numeric between 0.01 and 100 and (e->>'scale')::double precision<>(component#>>'{transform,scale}')::double precision;
 when 'rotation' then return fluid_private.standalone_keys(e,array['kind','componentId','degrees']) and jsonb_typeof(e->'degrees')='number' and(e->>'degrees')::numeric between -180 and 180 and abs((e->>'degrees')::double precision-(component#>>'{transform,rotation}')::double precision) not in(0,360);
 when 'color' then
  if fluid_private.standalone_keys(e,array['kind','componentId','fill','stroke']) is distinct from true or component#>>'{paint,status}' is distinct from 'uniform' then return false;end if;
  foreach k in array array['fill','stroke'] loop
   if (e->k='null'::jsonb) is distinct from(component#>array['paint',k]='null'::jsonb) or(e->k<>'null'::jsonb and(jsonb_typeof(e->k) is distinct from 'string' or e->>k!~'^#[0-9A-F]{6}$')) then return false;end if;
  end loop;return e->'fill' is distinct from component#>'{paint,fill}' or e->'stroke' is distinct from component#>'{paint,stroke}';
 when 'font' then return fluid_private.standalone_keys(e,array['kind','componentId','fontVersionId']) and component->>'editingKind'='editable_text' and fluid_private.logo_uuid(e->'fontVersionId') and e->'fontVersionId'<>component#>'{text,fontVersionId}' and exists(select 1 from jsonb_array_elements(c->'fonts') f where f->'id'=e->'fontVersionId' and f->'fontContentHash'<>component#>'{text,fontContentHash}');
 when 'spacing' then return fluid_private.standalone_keys(e,array['kind','componentId','letterSpacing','lineHeight']) and component->>'editingKind'='editable_text' and jsonb_typeof(e->'letterSpacing')='number' and(e->>'letterSpacing')::numeric between -1000000 and 1000000 and jsonb_typeof(e->'lineHeight')='number' and(e->>'lineHeight')::numeric>0 and(e->>'lineHeight')::numeric<=100 and (e->>'lineHeight')::double precision=(component#>>'{text,lineHeight}')::double precision and(e->>'letterSpacing')::double precision<>(component#>>'{text,letterSpacing}')::double precision;
 else return false;end case;
exception when others then return false;
end $$;

create function fluid_private.shared_logo_vector_proposal_payload_valid(v jsonb,c jsonb) returns boolean
language plpgsql immutable set search_path='' as $$
declare e jsonb:=v->'edit';component jsonb;item jsonb;protected jsonb;t jsonb;before_bounds jsonb;after_bounds jsonb;local_bounds jsonb;
 changed text[]:=array[]::text[];transforms jsonb:='{}';ordering jsonb;id text;ord bigint;same boolean;
 angle double precision;cosine double precision;sine double precision;minx double precision;miny double precision;maxx double precision;maxy double precision;
begin
 if fluid_private.shared_logo_vector_proposal_payload_shape_valid(v,c) is distinct from true then return false;end if;
 if v->>'status'='unsupported' then return true;end if;
 select jsonb_agg(value->'id' order by ordinal) into ordering from jsonb_array_elements(c->'components') with ordinality x(value,ordinal);
 if e->>'kind'='arrangement' then
  for item,ord in select value,ordinality from jsonb_array_elements(e->'order') with ordinality loop
   if ordering->((ord-1)::integer) is distinct from item then changed:=array_append(changed,item#>>'{}');end if;
  end loop;
  ordering:=e->'order';
  for item in select value from jsonb_array_elements(e->'placements') loop
   id:=item->>'componentId';select value into component from jsonb_array_elements(c->'components') where value->>'id'=id;t:=item->'transform';
   same:=(t->>'x')::double precision=(component#>>'{transform,x}')::double precision and(t->>'y')::double precision=(component#>>'{transform,y}')::double precision
    and(t->>'scale')::double precision=(component#>>'{transform,scale}')::double precision
    and((t->>'rotation')::double precision=(component#>>'{transform,rotation}')::double precision or abs((t->>'rotation')::double precision-(component#>>'{transform,rotation}')::double precision)=360);
   if same and(t->>'rotation')::double precision<>(component#>>'{transform,rotation}')::double precision then return false;end if;
   if not same then if not(id=any(changed)) then changed:=array_append(changed,id);end if;transforms:=jsonb_set(transforms,array[id],t,true);end if;
  end loop;
 else
  id:=e->>'componentId';changed:=array[id];select value into component from jsonb_array_elements(c->'components') where value->>'id'=id;
  if e->>'kind'='size' then transforms:=jsonb_set(transforms,array[id],component->'transform'||jsonb_build_object('scale',e->'scale'),true);
  elsif e->>'kind'='rotation' then transforms:=jsonb_set(transforms,array[id],component->'transform'||jsonb_build_object('rotation',e->'degrees'),true);end if;
 end if;
 if cardinality(changed)=0 then return false;end if;
 foreach id in array changed loop
  select value into component from jsonb_array_elements(c->'components') where value->>'id'=id;
  if component is null or component->'paintedBounds'='null'::jsonb or not(c->'targetComponentIds'@>jsonb_build_array(id)) or not(component->'allowedOperations'@>jsonb_build_array(e->>'kind')) or exists(select 1 from jsonb_array_elements(c->'locks') l where l->>'componentId'=id) then return false;end if;
 end loop;
 for item in select value from jsonb_array_elements(c->'locks') loop
  select value,ordinality into protected,ord from jsonb_array_elements(c->'components') with ordinality where value->'id'=item->'componentId';
  if protected->>'id'=any(changed) or ordering->((ord-1)::integer) is distinct from protected->'id' then return false;end if;
  if protected->'paintedBounds'='null'::jsonb then continue;end if;
  foreach id in array changed loop
   select value into component from jsonb_array_elements(c->'components') where value->>'id'=id;
   before_bounds:=component->'paintedBounds';after_bounds:=before_bounds;
   if transforms?id then
    t:=transforms->id;local_bounds:=component->'localPaintedBounds';
    if local_bounds='null'::jsonb then after_bounds:='null';
    else
     angle:=((t->>'rotation')::double precision*pi())/180;cosine:=cos(angle)*(t->>'scale')::double precision;sine:=sin(angle)*(t->>'scale')::double precision;
     select min(px),min(py),max(px),max(py) into minx,miny,maxx,maxy from(
      select x*cosine-y*sine+(t->>'x')::double precision px,x*sine+y*cosine+(t->>'y')::double precision py
      from unnest(array[(local_bounds->>'minX')::double precision,(local_bounds->>'maxX')::double precision]) xx(x)
      cross join unnest(array[(local_bounds->>'minY')::double precision,(local_bounds->>'maxY')::double precision]) yy(y)
     ) points;
     after_bounds:=jsonb_build_object('minX',minx,'minY',miny,'maxX',maxx,'maxY',maxy);
    end if;
   end if;
   if before_bounds<>'null'::jsonb and(protected#>>'{paintedBounds,minX}')::double precision<(before_bounds->>'maxX')::double precision and(protected#>>'{paintedBounds,maxX}')::double precision>(before_bounds->>'minX')::double precision and(protected#>>'{paintedBounds,minY}')::double precision<(before_bounds->>'maxY')::double precision and(protected#>>'{paintedBounds,maxY}')::double precision>(before_bounds->>'minY')::double precision then return false;end if;
   if after_bounds<>'null'::jsonb and(protected#>>'{paintedBounds,minX}')::double precision<(after_bounds->>'maxX')::double precision and(protected#>>'{paintedBounds,maxX}')::double precision>(after_bounds->>'minX')::double precision and(protected#>>'{paintedBounds,minY}')::double precision<(after_bounds->>'maxY')::double precision and(protected#>>'{paintedBounds,maxY}')::double precision>(after_bounds->>'minY')::double precision then return false;end if;
  end loop;
 end loop;
 return true;
exception when others then return false;
end $$;

create function fluid_private.shared_logo_vector_proposal_result_valid(v jsonb,c jsonb,o jsonb) returns boolean
language plpgsql immutable set search_path='' as $$
declare b jsonb:=v->'retainedOutput';raw bytea;payload jsonb;
begin
 if fluid_private.standalone_keys(v,array['status','payload','reason','retainedOutput']) is distinct from true or octet_length(v::text)>98304
  or fluid_private.standalone_keys(b,array['encoding','data','sha256','byteLength','truncated']) is distinct from true or b->>'encoding' is distinct from 'base64'
  or jsonb_typeof(b->'data') is distinct from 'string' or length(b->>'data')>43692 or b->>'data'!~'^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$'
  or jsonb_typeof(b->'sha256') is distinct from 'string' or b->>'sha256'!~'^[0-9a-f]{64}$' or jsonb_typeof(b->'truncated') is distinct from 'boolean'
  or jsonb_typeof(b->'byteLength') is distinct from 'number' or(b->>'byteLength')::numeric not between 0 and 9007199254740991 or trunc((b->>'byteLength')::numeric)<>(b->>'byteLength')::numeric then return false;end if;
 raw:=decode(b->>'data','base64');
 if octet_length(raw)>32768 or replace(encode(raw,'base64'),E'\n','') is distinct from b->>'data' then return false;end if;
 if(b->>'truncated')::boolean then if(b->>'byteLength')::numeric<=octet_length(raw) then return false;end if;
 elsif(b->>'byteLength')::numeric<>octet_length(raw) or encode(sha256(raw),'hex') is distinct from b->>'sha256' then return false;end if;
 if v->>'status'='valid' then
  if v->'reason' is distinct from 'null'::jsonb or(b->>'truncated')::boolean or o->'responseComplete' is distinct from 'true'::jsonb or octet_length(raw)>(o#>>'{textPolicy,maxOutputBytes}')::integer then return false;end if;
  payload:=convert_from(raw,'UTF8')::jsonb;
  return payload=v->'payload' and fluid_private.shared_logo_vector_proposal_payload_valid(payload,c);
 end if;
 return v->>'status' in('invalid','incomplete','refused') and v->'payload'='null'::jsonb and v->>'reason' in('provider_refusal','invalid_output','output_too_large','incomplete_output','provider_outcome_unknown','model_mismatch','service_tier_mismatch','unexpected_tools');
exception when others then return false;
end $$;

create table fluid_private.shared_logo_vector_proposal_prepared_results(
 id uuid primary key default gen_random_uuid(),owner_id uuid not null,project_id uuid not null,job_id uuid not null unique,lease_token uuid not null,
 quote_id uuid not null,input_hash text not null check(input_hash~'^[0-9a-f]{64}$'),context_hash text not null check(context_hash~'^[0-9a-f]{64}$'),
 provider_receipt_id uuid not null references public.logo_provider_responses(id),result jsonb not null check(octet_length(result::text)<=98304),created_at timestamptz not null default clock_timestamp(),
 unique(id,owner_id,project_id),foreign key(job_id,owner_id,project_id) references public.jobs(id,owner_id,project_id),foreign key(quote_id,owner_id,project_id) references public.logo_cost_quotes(id,owner_id,project_id)
);
alter table fluid_private.shared_logo_vector_proposal_prepared_results enable row level security;
alter table fluid_private.shared_logo_vector_proposal_prepared_results force row level security;
create trigger logo_vector_proposal_prepared_results_immutable before update or delete on fluid_private.shared_logo_vector_proposal_prepared_results for each row execute function fluid_private.prevent_history_change();


create function fluid_private.shared_logo_vector_proposal_pending_reason(j public.jobs,o jsonb,result jsonb) returns text
language plpgsql set search_path='' as $$
declare cost bigint;reservation public.usage_reservations;account public.usage_accounts;s public.job_steps;
begin
 if o#>>'{billing,status}' is distinct from 'recorded' then return 'provider_billing_unknown';end if;
 cost:=(o#>>'{billing,confirmedMicrousd}')::bigint;
 select * into reservation from public.usage_reservations where job_id=j.id and owner_id=j.owner_id and project_id=j.project_id;
 select * into account from public.usage_accounts where owner_id=j.owner_id;
 select * into s from public.job_steps where job_id=j.id and step_key='propose-vector-edit';
 if j.error_code='provider_accounting_unconfirmed' or reservation.job_id is null or account.owner_id is null or reservation.state is distinct from 'active'
  or reservation.reserved_microusd is distinct from j.reserved_cost_microusd or reservation.actual_microusd is distinct from cost or reservation.captured_microusd is distinct from least(cost,j.reserved_cost_microusd)
  or j.actual_cost_microusd is distinct from cost or s.actual_cost_microusd is distinct from cost or account.reserved_microusd<greatest(reservation.reserved_microusd-reservation.actual_microusd,0)
  or account.spent_microusd<reservation.captured_microusd or account.provider_actual_microusd<cost then return 'provider_accounting_unconfirmed';end if;
 if not(o->>'responseComplete')::boolean or o->'responseId'='null'::jsonb or o->'responseHash'='null'::jsonb then return 'provider_evidence_incomplete';end if;
 if(o#>>'{usage,inputTokens}')::numeric>(j.input#>>'{textPolicy,maxInputTokens}')::numeric or(o#>>'{usage,outputTokens}')::numeric>(j.input#>>'{textPolicy,maxOutputTokens}')::numeric then return 'provider_usage_exceeded';end if;
 if result->>'status'='incomplete' then return 'provider_output_incomplete';end if;
 if j.state='needs_reconciliation' then return coalesce(j.error_code,'provider_outcome_unknown');end if;
 if j.lease_token is null or j.lease_expires_at is null or j.lease_expires_at<=clock_timestamp() then return 'provider_response_after_lease';end if;
 return null;
end $$;

create function fluid_private.shared_logo_retain_proposal(j public.jobs,p fluid_private.shared_logo_vector_proposal_prepared_results,p_state text,p_reason text) returns jsonb
language plpgsql set search_path='' as $$
declare q public.logo_cost_quotes;r public.logo_provider_responses;a fluid_private.shared_logo_vector_proposal_dispatches;stored fluid_private.shared_logo_vector_proposals;value jsonb;receipt jsonb;cost bigint;
begin
 select * into q from public.logo_cost_quotes where id=p.quote_id and owner_id=j.owner_id and project_id=j.project_id;
 select * into a from fluid_private.shared_logo_vector_proposal_dispatches where job_id=j.id and owner_id=j.owner_id and project_id=j.project_id;
 select * into r from public.logo_provider_responses where id=p.provider_receipt_id and job_id=j.id and owner_id=j.owner_id and project_id=j.project_id and lease_token=p.lease_token;
 if a.job_id is null or r.id is null or p.owner_id is distinct from j.owner_id or p.project_id is distinct from j.project_id or p.job_id is distinct from j.id or p.lease_token is distinct from a.lease_token
  or a.input is distinct from j.input or a.worker_id is distinct from j.worker_id or j.attempts<>1 or p.input_hash is distinct from j.input_hash or p.context_hash is distinct from j.input->>'contextHash'
  or fluid_private.shared_logo_vector_proposal_job_quote_matches(j,q) is distinct from true or fluid_private.shared_logo_valid_vector_proposal_observation(r.observation,j.input->'textPolicy') is distinct from true
  or fluid_private.shared_logo_vector_proposal_result_valid(p.result,q.source_inputs->'context',r.observation) is distinct from true then raise exception 'proposal_prepared_binding_invalid' using errcode='55000';end if;
 if p_state is null or p_state not in('succeeded','failed','needs_reconciliation') or(p_state='succeeded' and(p_reason is not null or p.result->>'status'<>'valid')) or(p_state<>'succeeded' and(p_reason is null or length(p_reason) not between 1 and 200)) then raise exception 'invalid_proposal_state' using errcode='22023';end if;
 if p_state<>'needs_reconciliation' and fluid_private.shared_logo_vector_proposal_pending_reason(j,r.observation,p.result) is not null then raise exception 'proposal_requires_reconciliation' using errcode='55000';end if;
 cost:=case when r.observation#>>'{billing,status}'='recorded' then(r.observation#>>'{billing,confirmedMicrousd}')::bigint else 0 end;
 receipt:=jsonb_build_object('id',r.id,'ownerId',r.owner_id,'projectId',r.project_id,'jobId',r.job_id,'leaseToken',r.lease_token,'observation',r.observation);
 value:=jsonb_build_object('version',1,'id',p.id,'ownerId',j.owner_id,'projectId',j.project_id,'jobId',j.id,'requestKey',j.input->'requestKey','quoteId',q.id,'baseVectorRevisionId',j.input->'baseVectorRevisionId','contextHash',p.context_hash,'inputRevisions',q.input_revisions,'expected',q.record->'expected','context',q.source_inputs->'context','state',p_state,'payload',p.result->'payload','providerReceipt',receipt,'actualCostMicrousd',cost,'reason',p_reason,'createdAt',to_char(p.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'materialization','unavailable');
 select * into stored from fluid_private.shared_logo_vector_proposals where job_id=j.id;
 if found then
  if(stored.record-array['reason']) is distinct from(value-array['reason']) then raise exception 'proposal_result_immutable' using errcode='PT409';end if;
  return stored.record;
 end if;
 insert into fluid_private.shared_logo_vector_proposals(id,owner_id,project_id,job_id,request_key,quote_id,base_vector_revision_id,record,created_at) values(p.id,j.owner_id,j.project_id,j.id,(j.input->>'requestKey')::uuid,q.id,(j.input->>'baseVectorRevisionId')::uuid,value,p.created_at);
 return value;
end $$;

create function fluid_private.shared_logo_stage_proposal(p_job uuid,p_lease uuid,p_result jsonb,p_provider_receipt uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare j public.jobs;q public.logo_cost_quotes;r public.logo_provider_responses;p fluid_private.shared_logo_vector_proposal_prepared_results;s public.job_steps;reason text;
begin
 j:=fluid_private.shared_logo_lock_vector_proposal_dispatch(p_job,p_lease);
 select * into p from fluid_private.shared_logo_vector_proposal_prepared_results where job_id=j.id and owner_id=j.owner_id and project_id=j.project_id;
 if found then
  if p.result is distinct from p_result or p.provider_receipt_id is distinct from p_provider_receipt or p.lease_token is distinct from p_lease then raise exception 'proposal_prepared_immutable' using errcode='PT409';end if;
 else
  select * into s from public.job_steps where job_id=j.id and step_key='propose-vector-edit';
  if j.state not in('running','cancel_requested','needs_reconciliation') or s.state not in('in_flight','ambiguous') then raise exception 'proposal_evidence_window_closed' using errcode='55000';end if;
  select * into q from public.logo_cost_quotes where id=(j.input->>'quoteId')::uuid and owner_id=j.owner_id and project_id=j.project_id;
  select * into r from public.logo_provider_responses where id=p_provider_receipt and job_id=j.id and owner_id=j.owner_id and project_id=j.project_id and lease_token=p_lease;
  if r.id is null or fluid_private.shared_logo_valid_vector_proposal_observation(r.observation,j.input->'textPolicy') is distinct from true or fluid_private.shared_logo_vector_proposal_result_valid(p_result,q.source_inputs->'context',r.observation) is distinct from true then raise exception 'invalid_proposal_result' using errcode='22023';end if;
  insert into fluid_private.shared_logo_vector_proposal_prepared_results(owner_id,project_id,job_id,lease_token,quote_id,input_hash,context_hash,provider_receipt_id,result) values(j.owner_id,j.project_id,j.id,p_lease,q.id,j.input_hash,j.input->>'contextHash',r.id,p_result) returning * into p;
  reason:=fluid_private.shared_logo_vector_proposal_pending_reason(j,r.observation,p.result);
  if reason is not null then
   perform fluid_private.shared_logo_retain_proposal(j,p,'needs_reconciliation',reason);
   update public.jobs set state='needs_reconciliation',lease_token=null,lease_expires_at=null,error_code=reason where id=j.id;
  end if;
 end if;
 return jsonb_build_object('version',1,'kind','logo_vector_proposal_prepared','id',p.id,'ownerId',p.owner_id,'projectId',p.project_id,'jobId',p.job_id,'leaseToken',p.lease_token,'quoteId',p.quote_id,'inputHash',p.input_hash,'contextHash',p.context_hash,'providerResponseReceiptId',p.provider_receipt_id);
end $$;

create function fluid_private.shared_logo_complete_proposal(p_job uuid,p_lease uuid,p_step text,p_state text,p_cost bigint,p_output jsonb,p_provider_request_id text) returns public.job_steps
language plpgsql set search_path='' as $$
declare j public.jobs;s public.job_steps;r public.logo_provider_responses;p fluid_private.shared_logo_vector_proposal_prepared_results;outcome jsonb;unpublished jsonb;ack jsonb;candidate jsonb;context jsonb;reason text;cost bigint;free boolean;bare boolean;
begin
 j:=fluid_private.shared_logo_lock_vector_proposal_dispatch(p_job,p_lease);
 if p_step is distinct from 'propose-vector-edit' or p_state is null or p_state not in('succeeded','failed','ambiguous') or p_cost is null or p_cost not between 0 and 9007199254740991 or jsonb_typeof(p_output) is distinct from 'object' or octet_length(p_output::text)>131072 or(p_provider_request_id is not null and length(p_provider_request_id) not between 1 and 200) then raise exception 'invalid_proposal_outcome' using errcode='22023';end if;
 select * into s from public.job_steps where job_id=j.id and step_key=p_step for update;
 bare:=p_state='ambiguous' and p_cost=0 and p_provider_request_id is null and p_output='{"error":"provider_outcome_unknown"}'::jsonb;
 if s.state<>'in_flight' then
  -- The original bare uncertainty request necessarily reported zero; a later
  -- immutable observation may truthfully increase actual cost without changing it.
  if s.state='ambiguous' and s.output='{"error":"provider_outcome_unknown"}'::jsonb and s.provider_request_id is null then
   if bare then return s;end if;raise exception 'proposal_outcome_immutable' using errcode='PT409';
  end if;
  if(s.state,s.actual_cost_microusd,s.output,s.provider_request_id) is not distinct from(p_state,p_cost,p_output,p_provider_request_id) then return s;end if;
  raise exception 'proposal_outcome_immutable' using errcode='PT409';
 end if;
 if j.state not in('running','cancel_requested','needs_reconciliation') then raise exception 'proposal_evidence_window_closed' using errcode='55000';end if;
 select * into r from public.logo_provider_responses where job_id=j.id and owner_id=j.owner_id and project_id=j.project_id;
 free:=p_state='failed' and p_cost=0 and p_provider_request_id is null and p_output='{"error":"not_dispatched"}'::jsonb;
 if free then
  if r.id is not null or j.actual_cost_microusd<>0 or s.actual_cost_microusd<>0 or j.state='needs_reconciliation' or j.lease_token is distinct from p_lease or j.lease_expires_at<=clock_timestamp() then raise exception 'proposal_nondispatch_conflict' using errcode='55000';end if;
 elsif bare then
  select * into p from fluid_private.shared_logo_vector_proposal_prepared_results where job_id=j.id;
  if p.id is not null then perform fluid_private.shared_logo_retain_proposal(j,p,'needs_reconciliation','provider_outcome_unknown');end if;
  reason:='provider_outcome_unknown';
 else
  if p_state='succeeded' then outcome:=p_output;
  else
   if fluid_private.standalone_keys(p_output,array['error','result']) is distinct from true or fluid_private.standalone_text(p_output->'error',100,1) is distinct from true then raise exception 'invalid_proposal_outcome' using errcode='22023';end if;
   outcome:=p_output->'result';reason:=p_output->>'error';
  end if;
  if outcome->>'kind'='logo_vector_proposal_unpublished' then
   unpublished:=outcome;
   if p_state<>'ambiguous' or fluid_private.standalone_keys(unpublished,array['version','kind','reason','observation','result']) is distinct from true or unpublished->'version' is distinct from '1'::jsonb or unpublished->>'reason' not in('provider_evidence_unconfirmed','publication_unconfirmed') or unpublished->>'reason' is distinct from reason then raise exception 'invalid_unpublished_proposal' using errcode='22023';end if;
   ack:=fluid_private.shared_logo_record_vector_proposal_response(p_job,p_lease,unpublished->'observation');
   candidate:=unpublished->'result';
   select source_inputs->'context' into context from public.logo_cost_quotes where id=(j.input->>'quoteId')::uuid and owner_id=j.owner_id and project_id=j.project_id;
   if fluid_private.shared_logo_vector_proposal_result_valid(candidate,context,unpublished->'observation') is distinct from true then
    -- Only this explicitly ambiguous recovery path may retain rejected intent
    -- as diagnostics. Preserve exact bounded bytes; never accept its payload.
    if fluid_private.standalone_keys(candidate,array['status','payload','reason','retainedOutput']) is distinct from true or candidate->>'status' is distinct from 'valid' or candidate->'reason' is distinct from 'null'::jsonb then raise exception 'invalid_unpublished_proposal_result' using errcode='22023';end if;
    candidate:=jsonb_build_object('status','incomplete','payload',null,'reason','provider_outcome_unknown','retainedOutput',candidate->'retainedOutput');
    if fluid_private.shared_logo_vector_proposal_result_valid(candidate,context,unpublished->'observation') is distinct from true then raise exception 'invalid_unpublished_proposal_bytes' using errcode='22023';end if;
   end if;
   ack:=fluid_private.shared_logo_stage_proposal(p_job,p_lease,candidate,(ack->>'id')::uuid);
   outcome:=jsonb_build_object('version',1,'kind','logo_vector_proposal','preparedId',ack->'id','providerResponseReceiptId',ack->'providerResponseReceiptId');
   j:=fluid_private.shared_logo_lock_vector_proposal_dispatch(p_job,p_lease);
  end if;
  if fluid_private.standalone_keys(outcome,array['version','kind','preparedId','providerResponseReceiptId']) is distinct from true or outcome->'version' is distinct from '1'::jsonb or outcome->>'kind' is distinct from 'logo_vector_proposal' or fluid_private.logo_uuid(outcome->'preparedId') is distinct from true or fluid_private.logo_uuid(outcome->'providerResponseReceiptId') is distinct from true then raise exception 'invalid_prepared_proposal_receipt' using errcode='22023';end if;
  select * into p from fluid_private.shared_logo_vector_proposal_prepared_results where id=(outcome->>'preparedId')::uuid and job_id=j.id and owner_id=j.owner_id and project_id=j.project_id and lease_token=p_lease and provider_receipt_id=(outcome->>'providerResponseReceiptId')::uuid;
  if p.id is null then raise exception 'proposal_prepared_not_found' using errcode='55000';end if;
  select * into r from public.logo_provider_responses where id=p.provider_receipt_id and job_id=j.id and owner_id=j.owner_id and project_id=j.project_id and lease_token=p_lease;
  if r.id is null or r.observation->>'providerRequestId' is distinct from p_provider_request_id then raise exception 'proposal_provider_receipt_mismatch' using errcode='22023';end if;
  cost:=case when r.observation#>>'{billing,status}'='recorded' then(r.observation#>>'{billing,confirmedMicrousd}')::bigint else 0 end;
  if cost<>p_cost then raise exception 'proposal_observed_cost_mismatch' using errcode='22023';end if;
  if p_state='succeeded' and p.result->>'status'<>'valid' then raise exception 'invalid_proposal_success' using errcode='22023';end if;
  if p_state='failed' and(p.result->>'status' not in('invalid','refused') or reason is distinct from p.result->>'reason') then raise exception 'invalid_proposal_failure' using errcode='22023';end if;
  if p_state='ambiguous' then reason:=coalesce(fluid_private.shared_logo_vector_proposal_pending_reason(j,r.observation,p.result),reason);
  elsif fluid_private.shared_logo_vector_proposal_pending_reason(j,r.observation,p.result) is not null then raise exception 'proposal_requires_reconciliation' using errcode='55000';end if;
  perform fluid_private.shared_logo_retain_proposal(j,p,case p_state when 'ambiguous' then 'needs_reconciliation' else p_state end,case when p_state='succeeded' then null else reason end);
 end if;
 -- Observation is the only capture point. Never add expense here or settle an
 -- uncertain remaining reservation. Preserve a known late bill on bare replay.
 update public.job_steps set state=p_state,output=p_output,provider_request_id=p_provider_request_id,completed_at=clock_timestamp() where id=s.id returning * into s;
 if p_state='ambiguous' then update public.jobs set state='needs_reconciliation',lease_token=null,lease_expires_at=null,error_code=reason where id=j.id;end if;
 return s;
end $$;

create function fluid_private.shared_logo_valid_vector_proposal_observation(o jsonb,p jsonb) returns boolean
language plpgsql immutable set search_path='' as $$
declare k text;v jsonb;u jsonb:=o->'usage';b jsonb:=o->'billing';cost numeric;
begin
 if fluid_private.standalone_keys(o,array['version','kind','provider','model','responseComplete','toolCalls','serviceTier','responseId','providerRequestId','responseHash','observedAt','textPolicy','usage','billing']) is distinct from true
  or octet_length(o::text)>32768 or o->'version' is distinct from '1'::jsonb or o->>'kind' is distinct from 'logo_vector_proposal_text' or o->>'provider' is distinct from 'openai'
  or jsonb_typeof(o->'responseComplete') is distinct from 'boolean' or o->'textPolicy' is distinct from p
  or fluid_private.shared_logo_valid_vector_proposal_text_policy(p) is distinct from true or fluid_private.standalone_timestamp(o->'observedAt') is distinct from true then return false;end if;
 foreach k in array array['model','serviceTier','responseId','providerRequestId'] loop
  if o->k<>'null'::jsonb and fluid_private.standalone_text(o->k,case k when 'model' then 150 when 'serviceTier' then 100 else 200 end,1) is distinct from true then return false;end if;
 end loop;
 if o->'responseHash'<>'null'::jsonb and (jsonb_typeof(o->'responseHash') is distinct from 'string' or o->>'responseHash'!~'^[0-9a-f]{64}$') then return false;end if;
 v:=o->'toolCalls';if v<>'null'::jsonb and (jsonb_typeof(v) is distinct from 'number' or(v#>>'{}')::numeric not between 0 and 9007199254740991 or trunc((v#>>'{}')::numeric)<>(v#>>'{}')::numeric) then return false;end if;
 if u<>'null'::jsonb then
  if fluid_private.standalone_keys(u,array['inputTokens','cachedInputTokens','cacheWriteInputTokens','outputTokens']) is distinct from true then return false;end if;
  foreach k in array array['inputTokens','cachedInputTokens','cacheWriteInputTokens','outputTokens'] loop
   if jsonb_typeof(u->k) is distinct from 'number' or(u->>k)::numeric not between 0 and 9007199254740991 or trunc((u->>k)::numeric)<>(u->>k)::numeric then return false;end if;
  end loop;
  if(u->>'cachedInputTokens')::numeric+(u->>'cacheWriteInputTokens')::numeric>(u->>'inputTokens')::numeric then return false;end if;
 end if;
 if fluid_private.standalone_keys(b,array['status','confirmedMicrousd']) is distinct from true then return false;end if;
 if b->>'status'='unknown' then return b->'confirmedMicrousd'='null'::jsonb;end if;
 if b->>'status' is distinct from 'recorded' or jsonb_typeof(b->'confirmedMicrousd') is distinct from 'number'
  or(b->>'confirmedMicrousd')::numeric not between 0 and 9007199254740991 or trunc((b->>'confirmedMicrousd')::numeric)<>(b->>'confirmedMicrousd')::numeric
  or u='null'::jsonb or o->'model' is distinct from p->'model' or o->'serviceTier' is distinct from p->'serviceTier' or o->'toolCalls' is distinct from '0'::jsonb
  or(u->>'inputTokens')::numeric>272000 then return false;end if;
 -- This frozen card covers standard-context observed usage only. Larger
 -- anomalous responses retain usage with unknown billing, never a false rate.
 cost:=ceil((((u->>'inputTokens')::numeric-(u->>'cachedInputTokens')::numeric-(u->>'cacheWriteInputTokens')::numeric)*2000000
  +(u->>'cachedInputTokens')::numeric*100000+(u->>'cacheWriteInputTokens')::numeric*2500000+(u->>'outputTokens')::numeric*10000000)/1000000);
 return cost=(b->>'confirmedMicrousd')::numeric;
exception when others then return false;
end $$;

create table fluid_private.shared_logo_vector_proposal_materializations(
 proposal_id uuid primary key, owner_id uuid not null, project_id uuid not null, request_key uuid not null,
 vector_revision_id uuid not null unique, revision_id uuid not null unique, stage text not null default 'refinements' check(stage='refinements'), record jsonb not null,
 unique(owner_id,project_id,request_key),
 foreign key(proposal_id,owner_id,project_id) references fluid_private.shared_logo_vector_proposals(id,owner_id,project_id),
 foreign key(vector_revision_id,owner_id,project_id) references public.logo_vector_revisions(id,owner_id,project_id),
 foreign key(revision_id,project_id,owner_id,stage) references public.logo_stage_revisions(id,project_id,owner_id,stage),
 check((fluid_private.standalone_keys(record,array['version','ownerId','projectId','proposalId','requestKey','vectorRevisionId','revisionId','createdAt'])
  and record->'version'='1'::jsonb and record->>'ownerId'=owner_id::text and record->>'projectId'=project_id::text
  and record->>'proposalId'=proposal_id::text and record->>'requestKey'=request_key::text
  and record->>'vectorRevisionId'=vector_revision_id::text and record->>'revisionId'=revision_id::text
  and fluid_private.standalone_timestamp(record->'createdAt') and octet_length(record::text)<=4096) is true)
);
alter table fluid_private.shared_logo_vector_proposal_materializations enable row level security;
alter table fluid_private.shared_logo_vector_proposal_materializations force row level security;
create trigger logo_vector_proposal_materializations_immutable before update or delete on fluid_private.shared_logo_vector_proposal_materializations for each row execute function fluid_private.prevent_history_change();


create function fluid_private.shared_logo_vector_proposal_application_command_valid(v jsonb) returns boolean
language plpgsql immutable set search_path='' as $$
declare b jsonb:=v->'body';check_command jsonb;
begin
 if fluid_private.standalone_keys(v,array['method','body']) is distinct from true or v->>'method' is distinct from 'applyLogoVectorProposal' or octet_length(v::text)>32768
  or fluid_private.standalone_keys(b,array['requestKey','expected','baseVectorRevisionId','proposalId']) is distinct from true
  or fluid_private.logo_uuid(b->'baseVectorRevisionId') is distinct from true or fluid_private.logo_uuid(b->'proposalId') is distinct from true then return false;end if;
 check_command:=jsonb_build_object('method','restoreLogoStage','body',jsonb_build_object('requestKey',b->'requestKey','expected',b->'expected','stage','concepts','revisionId','00000000-0000-4000-8000-000000000001','acceptEarlierBasis',false));
 return fluid_private.logo_base_command_valid(check_command) is true;
exception when others then return false;
end $$;

create function fluid_private.shared_logo_vector_proposal_materializable(p fluid_private.shared_logo_vector_proposals) returns boolean
language plpgsql stable set search_path='' as $$
declare j public.jobs;s public.job_steps;q public.logo_cost_quotes;r public.logo_provider_responses;
 a fluid_private.shared_logo_vector_proposal_dispatches;prepared fluid_private.shared_logo_vector_proposal_prepared_results;
 reservation public.usage_reservations;account public.usage_accounts;cost bigint;receipt jsonb;expected jsonb;
begin
 if p.id is null or p.record->>'state' is distinct from 'succeeded' or p.record#>>'{payload,status}' is distinct from 'proposed' then return false;end if;
 select * into j from public.jobs where id=p.job_id and owner_id=p.owner_id and project_id=p.project_id;
 select * into s from public.job_steps where job_id=p.job_id and owner_id=p.owner_id and project_id=p.project_id and step_key='propose-vector-edit';
 select * into q from public.logo_cost_quotes where id=p.quote_id and owner_id=p.owner_id and project_id=p.project_id;
 select * into a from fluid_private.shared_logo_vector_proposal_dispatches where job_id=p.job_id and owner_id=p.owner_id and project_id=p.project_id;
 select * into prepared from fluid_private.shared_logo_vector_proposal_prepared_results where id=p.id and job_id=p.job_id and owner_id=p.owner_id and project_id=p.project_id;
 select * into r from public.logo_provider_responses where id=prepared.provider_receipt_id and job_id=p.job_id and owner_id=p.owner_id and project_id=p.project_id;
 if j.id is null or j.state is distinct from 'succeeded' or j.finished_at is null or j.cancel_requested_at is not null or j.error_code is not null
  or j.lease_token is not null or j.lease_expires_at is not null or j.attempts<>1
  or fluid_private.shared_logo_vector_proposal_job_quote_matches(j,q) is distinct from true
  or a.job_id is null or a.input is distinct from j.input or a.worker_id is distinct from j.worker_id or a.quote_id is distinct from q.id
  or s.id is null or s.state is distinct from 'succeeded' or s.completed_at is null or s.step_key is distinct from a.step_key or s.request_key is distinct from a.step_request_key
  or s.reserved_cost_microusd is distinct from j.reserved_cost_microusd or (select count(*) from public.job_steps where job_id=j.id)<>1
  or prepared.id is null or prepared.quote_id is distinct from q.id or prepared.lease_token is distinct from a.lease_token
  or prepared.input_hash is distinct from j.input_hash or prepared.context_hash is distinct from j.input->>'contextHash'
  or prepared.result->>'status' is distinct from 'valid' or prepared.result#>>'{payload,status}' is distinct from 'proposed'
  or r.id is null or r.lease_token is distinct from a.lease_token or s.provider_request_id is distinct from r.observation->>'providerRequestId'
  or s.output is distinct from jsonb_build_object('version',1,'kind','logo_vector_proposal','preparedId',prepared.id,'providerResponseReceiptId',r.id)
  or fluid_private.shared_logo_valid_vector_proposal_observation(r.observation,j.input->'textPolicy') is distinct from true
  or fluid_private.shared_logo_vector_proposal_result_valid(prepared.result,q.source_inputs->'context',r.observation) is distinct from true
  or r.observation->'responseComplete' is distinct from 'true'::jsonb or r.observation->'responseId'='null'::jsonb or r.observation->'responseHash'='null'::jsonb
  or r.observation#>>'{billing,status}' is distinct from 'recorded'
  or (r.observation#>>'{usage,inputTokens}')::numeric>(j.input#>>'{textPolicy,maxInputTokens}')::numeric
  or (r.observation#>>'{usage,outputTokens}')::numeric>(j.input#>>'{textPolicy,maxOutputTokens}')::numeric then return false;end if;
 cost:=(r.observation#>>'{billing,confirmedMicrousd}')::bigint;
 select * into reservation from public.usage_reservations where job_id=j.id and owner_id=j.owner_id and project_id=j.project_id;
 select * into account from public.usage_accounts where owner_id=j.owner_id;
 if reservation.job_id is null or account.owner_id is null or reservation.state is distinct from 'settled'
  or reservation.reserved_microusd is distinct from j.reserved_cost_microusd or reservation.actual_microusd is distinct from cost or reservation.captured_microusd is distinct from 0
  or j.actual_cost_microusd is distinct from cost or s.actual_cost_microusd is distinct from cost or account.provider_actual_microusd<cost then return false;end if;
 receipt:=jsonb_build_object('id',r.id,'ownerId',r.owner_id,'projectId',r.project_id,'jobId',r.job_id,'leaseToken',r.lease_token,'observation',r.observation);
 expected:=jsonb_build_object('version',1,'id',prepared.id,'ownerId',j.owner_id,'projectId',j.project_id,'jobId',j.id,'requestKey',j.input->'requestKey','quoteId',q.id,'baseVectorRevisionId',j.input->'baseVectorRevisionId','contextHash',prepared.context_hash,'inputRevisions',q.input_revisions,'expected',q.record->'expected','context',q.source_inputs->'context','state','succeeded','payload',prepared.result->'payload','providerReceipt',receipt,'actualCostMicrousd',cost,'reason',null,'createdAt',to_char(prepared.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'materialization','unavailable');
 return p.record=expected and p.request_key::text=j.input->>'requestKey' and p.base_vector_revision_id::text=j.input->>'baseVectorRevisionId';
exception when others then return false;
end $$;

create function fluid_private.shared_logo_vector_proposal_owned_asset_valid(p_owner uuid,p_project uuid,p_reference jsonb,p_kind text) returns boolean
language sql stable set search_path='' as $$
 select exists(select 1 from public.logo_asset_publications r
  join public.asset_versions v on v.id=r.version_id and v.asset_id=r.asset_id and v.owner_id=r.owner_id and v.project_id=r.project_id
  join public.assets a on a.id=v.asset_id and a.owner_id=v.owner_id and a.project_id=v.project_id
  where r.owner_id=p_owner and r.project_id=p_project and r.state='committed' and r.purpose='brand_asset' and a.purpose='brand_asset'
   and fluid_private.logo_asset_reservation(r)->'reference'=p_reference
   and v.content_hash=r.content_hash and v.mime_type=r.mime_type and v.storage_path=r.owner_id::text||'/'||r.project_id::text||'/'||r.asset_id::text||'/'||r.version_id::text
   and r.verification->>'status'='verified' and r.verification->>'contentHash'=r.content_hash and r.verification->>'mimeType'=r.mime_type and r.verification->'byteLength'=to_jsonb(r.byte_length)
   and case p_kind when 'document' then r.mime_type='application/json' when 'svg' then r.mime_type='image/svg+xml'
    when 'raster' then r.mime_type in('image/png','image/jpeg','image/webp') when 'font' then r.mime_type in('font/ttf','font/otf','font/woff','font/woff2') else false end)
$$;

create function fluid_private.shared_logo_vector_proposal_basis_current(p fluid_private.shared_logo_vector_proposals) returns boolean
language plpgsql stable set search_path='' as $$
declare q public.logo_cost_quotes;base jsonb;brief jsonb;f jsonb;stored jsonb;
begin
 select * into q from public.logo_cost_quotes where id=p.quote_id and owner_id=p.owner_id and project_id=p.project_id;
 if q.id is null or fluid_private.shared_logo_vector_proposal_quote_binding(q) is distinct from true
  or fluid_private.logo_workspace_json(p.owner_id,p.project_id)->'heads' is distinct from q.record->'expected'
  or fluid_private.logo_current_vector_id(p.owner_id,p.project_id) is distinct from p.base_vector_revision_id then return false;end if;
 select record into base from public.logo_vector_revisions where id=p.base_vector_revision_id and owner_id=p.owner_id and project_id=p.project_id;
 if base is null or base is distinct from q.source_inputs->'baseRevision'
  or exists(select 1 from jsonb_array_elements(base->'inputRevisions') i left join public.logo_stage_heads h on h.owner_id=p.owner_id and h.project_id=p.project_id and h.stage=i->>'stage' where h.revision_id::text is distinct from i->>'id')
  or fluid_private.shared_logo_vector_proposal_owned_asset_valid(p.owner_id,p.project_id,base->'sourcePreview','raster') is distinct from true
  or fluid_private.shared_logo_vector_proposal_owned_asset_valid(p.owner_id,p.project_id,base->'documentAsset','document') is distinct from true
  or fluid_private.shared_logo_vector_proposal_owned_asset_valid(p.owner_id,p.project_id,base->'svgAsset','svg') is distinct from true then return false;end if;
 select record into brief from public.logo_stage_revisions where id=(q.source_inputs#>>'{brief,id}')::uuid and owner_id=p.owner_id and project_id=p.project_id and stage='brief_references';
 if brief is null or brief is distinct from q.source_inputs->'brief' then return false;end if;
 for f in select value from jsonb_array_elements(q.source_inputs->'fonts') loop
  select record into stored from public.logo_font_records where record_id=(f->>'id')::uuid and owner_id=p.owner_id and project_id=p.project_id;
  if stored is null or stored is distinct from f or f#>>'{rights,commercialUse}' is distinct from 'allowed' or f#>>'{rights,sourceKind}' is distinct from 'reviewed_license'
   or f#>>'{rights,permissions,render}' is distinct from 'allowed' or f#>>'{rights,permissions,outline}' is distinct from 'allowed'
   or f#>'{rights,fontContentHash}' is distinct from f#>'{asset,contentHash}' or fluid_private.standalone_timestamp(f#>'{rights,reviewedAt}') is distinct from true
   or fluid_private.shared_logo_vector_proposal_owned_asset_valid(p.owner_id,p.project_id,f->'asset','font') is distinct from true then return false;end if;
 end loop;
 return true;
exception when others then return false;
end $$;

create function fluid_private.shared_logo_commit_vector_proposal(p_owner uuid,p_project uuid,p_command jsonb,p_evidence jsonb) returns jsonb
language plpgsql set search_path='' as $$
declare b jsonb:=p_command->'body';p fluid_private.shared_logo_vector_proposals;prepared fluid_private.shared_logo_vector_proposal_prepared_results;q public.logo_cost_quotes;
 base jsonb;brief jsonb;f jsonb;stored jsonb;summary jsonb;c jsonb;d public.logo_asset_publications;s public.logo_asset_publications;
 v jsonb;payload jsonb;revision jsonb;association jsonb;digest text;document_key uuid;svg_key uuid;cancelled public.logo_vector_edit_cancellations;
begin
 if fluid_private.logo_asset_web_owner() is distinct from p_owner then raise exception 'logo_principal_mismatch' using errcode='42501';end if;
 if fluid_private.shared_logo_vector_proposal_application_command_valid(p_command) is distinct from true then raise exception 'invalid_logo_proposal_application' using errcode='22023';end if;
 perform pg_advisory_xact_lock(hashtextextended(p_owner::text,723902));
 perform 1 from public.projects where id=p_project and owner_id=p_owner for update;
 if not found then raise exception 'logo_project_not_found' using errcode='P0002';end if;
 select * into cancelled from public.logo_vector_edit_cancellations where owner_id=p_owner and project_id=p_project and request_key=(b->>'requestKey')::uuid;
 if found then
  if cancelled.command is distinct from p_command then raise exception 'logo_request_conflict' using errcode='PT409';end if;
  raise exception 'logo_edit_cancelled' using errcode='PT409';
 end if;
 select * into p from fluid_private.shared_logo_vector_proposals where id=(b->>'proposalId')::uuid and owner_id=p_owner and project_id=p_project;
 if not found then raise exception 'logo_proposal_not_found' using errcode='P0002';end if;
 if exists(select 1 from fluid_private.shared_logo_vector_proposal_materializations where proposal_id=p.id) then raise exception 'logo_proposal_already_materialized' using errcode='PT409';end if;
 -- Financial rows are held through the CAS; no expense is changed here.
 perform 1 from public.jobs where id=p.job_id for share;
 perform 1 from public.job_steps where job_id=p.job_id for share;
 perform 1 from public.usage_reservations where job_id=p.job_id for share;
 perform 1 from public.usage_accounts where owner_id=p_owner for share;
 if fluid_private.shared_logo_vector_proposal_materializable(p) is distinct from true then raise exception 'logo_proposal_not_materializable' using errcode='PT409';end if;
 select * into prepared from fluid_private.shared_logo_vector_proposal_prepared_results where id=p.id and owner_id=p_owner and project_id=p_project;
 select * into q from public.logo_cost_quotes where id=p.quote_id and owner_id=p_owner and project_id=p_project;
 c:=q.source_inputs->'context';
 if fluid_private.shared_logo_vector_proposal_basis_current(p) is distinct from true then raise exception 'logo_proposal_source_changed' using errcode='PT409';end if;
 if fluid_private.standalone_keys(p_evidence,array['proposalId','preparedId','providerResponseReceiptId','baseVectorRevisionId','contextHash','baseRevision','brief','fonts','documentPublicationId','svgPublicationId','documentHash','proof','locks']) is distinct from true
  or octet_length(p_evidence::text)>2097152 or p_evidence->'proposalId' is distinct from b->'proposalId' or p_evidence->>'preparedId' is distinct from prepared.id::text
  or p_evidence->>'providerResponseReceiptId' is distinct from prepared.provider_receipt_id::text or p_evidence->'baseVectorRevisionId' is distinct from b->'baseVectorRevisionId'
  or b->>'baseVectorRevisionId' is distinct from p.base_vector_revision_id::text or p_evidence->>'contextHash' is distinct from prepared.context_hash
  or fluid_private.logo_uuid(p_evidence->'documentPublicationId') is distinct from true or fluid_private.logo_uuid(p_evidence->'svgPublicationId') is distinct from true
  or fluid_private.logo_vector_proof_valid(p_evidence->'proof') is distinct from true or p_evidence->'documentHash' is distinct from p_evidence#>'{proof,documentHash}'
  or fluid_private.logo_vector_locks_valid(p_evidence->'locks') is distinct from true then raise exception 'invalid_logo_proposal_evidence' using errcode='22023';end if;
 if fluid_private.logo_workspace_json(p_owner,p_project)->'heads' is distinct from b->'expected' or b->'expected' is distinct from q.record->'expected' then raise exception 'logo_head_conflict' using errcode='PT409';end if;
 select record into base from public.logo_vector_revisions where id=p.base_vector_revision_id and owner_id=p_owner and project_id=p_project for share;
 if base is null or fluid_private.logo_current_vector_id(p_owner,p_project) is distinct from p.base_vector_revision_id
  or base is distinct from p_evidence->'baseRevision' or base is distinct from q.source_inputs->'baseRevision'
  or c->'documentHash' is distinct from base->'documentHash' or c->'locks' is distinct from base->'locks' or c->'source' is distinct from base->'source'
  or c->'inputRevisions' is distinct from base->'inputRevisions' or c->'viewBox' is distinct from base#>'{proof,viewBox}'
  or p_evidence->'documentHash' is not distinct from base->'documentHash'
  or p_evidence#>'{proof,viewBox}' is distinct from base#>'{proof,viewBox}' or p_evidence#>'{proof,componentCount}' is distinct from base#>'{proof,componentCount}'
  or p_evidence->'locks' is distinct from base->'locks' or fluid_private.logo_vector_proof_valid(base->'proof') is distinct from true
  or base->'documentHash' is distinct from base#>'{documentAsset,contentHash}' or base->'documentHash' is distinct from base#>'{proof,documentHash}'
  or exists(select 1 from jsonb_array_elements(base->'inputRevisions') i left join public.logo_stage_heads h on h.owner_id=p_owner and h.project_id=p_project and h.stage=i->>'stage' where h.revision_id::text is distinct from i->>'id') then raise exception 'logo_proposal_source_changed' using errcode='PT409';end if;
 select record into brief from public.logo_stage_revisions where id=(c#>>'{brief,id}')::uuid and owner_id=p_owner and project_id=p_project and stage='brief_references' for share;
 if brief is null or brief is distinct from p_evidence->'brief' or brief is distinct from q.source_inputs->'brief'
  or c->'brief' is distinct from jsonb_build_object('id',brief->'id','revision',brief->'revision','inputHash',brief->'inputHash','name',brief#>'{payload,name}')
  or not exists(select 1 from jsonb_array_elements(base->'inputRevisions') i where i->>'stage'='brief_references' and i->'id'=brief->'id' and i->'revision'=brief->'revision') then raise exception 'logo_proposal_source_changed' using errcode='PT409';end if;
 if p_evidence->'fonts' is distinct from q.source_inputs->'fonts' or jsonb_typeof(p_evidence->'fonts') is distinct from 'array'
  or jsonb_array_length(p_evidence->'fonts') is distinct from jsonb_array_length(c->'fonts') then raise exception 'logo_proposal_source_changed' using errcode='PT409';end if;
 for f in select value from jsonb_array_elements(p_evidence->'fonts') loop
  select record into stored from public.logo_font_records where record_id=(f->>'id')::uuid and owner_id=p_owner and project_id=p_project for share;
  select value into summary from jsonb_array_elements(c->'fonts') font where font->'id'=f->'id';
  if stored is null or stored is distinct from f or summary is null
   or summary->'family' is distinct from f->'family' or summary->'source' is distinct from f->'source'
   or summary->'assetVersionId' is distinct from f#>'{asset,versionId}' or summary->'fontContentHash' is distinct from f#>'{asset,contentHash}'
   or summary->'rightsEvidenceId' is distinct from f#>'{rights,id}' or f#>'{rights,fontContentHash}' is distinct from f#>'{asset,contentHash}'
   or f#>>'{rights,commercialUse}' is distinct from 'allowed' or f#>>'{rights,sourceKind}' is distinct from 'reviewed_license'
   or f#>>'{rights,permissions,render}' is distinct from 'allowed' or f#>>'{rights,permissions,outline}' is distinct from 'allowed'
   or fluid_private.standalone_timestamp(f#>'{rights,reviewedAt}') is distinct from true then raise exception 'logo_proposal_source_changed' using errcode='PT409';end if;
 end loop;
 select * into d from public.logo_asset_publications where id=(p_evidence->>'documentPublicationId')::uuid for update;
 select * into s from public.logo_asset_publications where id=(p_evidence->>'svgPublicationId')::uuid for update;
 digest:=encode(sha256(convert_to('fluid.logo-vector.publication.v1:'||(b->>'requestKey')||':document','UTF8')),'hex');
 document_key:=(substr(digest,1,8)||'-'||substr(digest,9,4)||'-5'||substr(digest,14,3)||'-a'||substr(digest,18,3)||'-'||substr(digest,21,12))::uuid;
 digest:=encode(sha256(convert_to('fluid.logo-vector.publication.v1:'||(b->>'requestKey')||':svg','UTF8')),'hex');
 svg_key:=(substr(digest,1,8)||'-'||substr(digest,9,4)||'-5'||substr(digest,14,3)||'-a'||substr(digest,18,3)||'-'||substr(digest,21,12))::uuid;
 if not fluid_private.logo_vector_member_valid(d,p_owner,p_project,p.base_vector_revision_id,base->'inputRevisions','application/json',p_evidence->>'documentHash')
  or not fluid_private.logo_vector_member_valid(s,p_owner,p_project,p.base_vector_revision_id,base->'inputRevisions','image/svg+xml',p_evidence#>>'{proof,svgContentHash}')
  or d.id=s.id or d.asset_id=s.asset_id or d.version_id=s.version_id or d.job_id is not null or s.job_id is not null
  or d.state is distinct from 'staged' or s.state is distinct from 'staged' or d.request_key is distinct from document_key or s.request_key is distinct from svg_key then raise exception 'invalid_logo_vector_members' using errcode='55000';end if;
 perform fluid_private.logo_commit_asset(d);perform fluid_private.logo_commit_asset(s);
 v:=jsonb_build_object('id',gen_random_uuid(),'ownerId',p_owner,'projectId',p_project,'parentRevisionId',base->'id','source',base->'source','sourcePreview',base->'sourcePreview',
  'documentAsset',fluid_private.logo_asset_reservation(d)->'reference','svgAsset',fluid_private.logo_asset_reservation(s)->'reference','documentHash',p_evidence->'documentHash',
  'proof',p_evidence->'proof','locks',p_evidence->'locks','inputRevisions',base->'inputRevisions','reviewStatus','review_required','createdAt',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
 insert into public.logo_vector_revisions(id,owner_id,project_id,record) values((v->>'id')::uuid,p_owner,p_project,v);
 select r.record->'payload' into payload from public.logo_stage_heads h join public.logo_stage_revisions r on r.id=h.revision_id and r.owner_id=h.owner_id and r.project_id=h.project_id where h.owner_id=p_owner and h.project_id=p_project and h.stage='refinements';
 payload:=jsonb_build_object('rasterRevisionIds',coalesce(payload->'rasterRevisionIds','[]'::jsonb),'vectorRevisionId',v->'id','approvalId',null,'sourceRequestKey',b->'requestKey');
 revision:=fluid_private.logo_append_stage(p_owner,p_project,'refinements',payload,base->'inputRevisions');
 association:=jsonb_build_object('version',1,'ownerId',p_owner,'projectId',p_project,'proposalId',p.id,'requestKey',b->'requestKey','vectorRevisionId',v->'id','revisionId',revision->'id','createdAt',v->'createdAt');
 insert into fluid_private.shared_logo_vector_proposal_materializations(proposal_id,owner_id,project_id,request_key,vector_revision_id,revision_id,record)
  values(p.id,p_owner,p_project,(b->>'requestKey')::uuid,(v->>'id')::uuid,(revision->>'id')::uuid,association);
 return revision;
end $$;

create function public.read_logo_vector_proposal_application(p_project_id uuid,p_proposal_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare owner uuid:=auth.uid();p fluid_private.shared_logo_vector_proposals;prepared fluid_private.shared_logo_vector_proposal_prepared_results;m jsonb;
begin
 if owner is null then raise exception 'unauthenticated' using errcode='42501';end if;
 if not exists(select 1 from public.projects where id=p_project_id and owner_id=owner) then raise exception 'logo_project_not_found' using errcode='P0002';end if;
 select * into p from fluid_private.shared_logo_vector_proposals where id=p_proposal_id and owner_id=owner and project_id=p_project_id;
 if not found then raise exception 'logo_proposal_not_found' using errcode='P0002';end if;
 select * into prepared from fluid_private.shared_logo_vector_proposal_prepared_results where id=p.id and job_id=p.job_id and owner_id=owner and project_id=p_project_id;
 select record into m from fluid_private.shared_logo_vector_proposal_materializations where proposal_id=p.id and owner_id=owner and project_id=p_project_id;
 return jsonb_build_object('proposal',p.record,'preparedId',prepared.id,'providerResponseReceiptId',prepared.provider_receipt_id,'materialization',m,'eligible',m is null and fluid_private.shared_logo_vector_proposal_materializable(p) and fluid_private.shared_logo_vector_proposal_basis_current(p));
end $$;

create function fluid_private.shared_logo_quote_vector_proposal(p_project_id uuid,p_evidence jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare owner uuid:=fluid_private.logo_asset_web_owner();request jsonb:=p_evidence->'request';context jsonb:=p_evidence->'context';
 base jsonb;brief jsonb;workspace jsonb;font jsonb;stored_font jsonb;summary jsonb;component jsonb;target jsonb;
 policy jsonb;profile jsonb;sources jsonb;input_hash text;context_hash text;
 quote_id uuid:=gen_random_uuid();expires timestamptz:=clock_timestamp()+interval '5 minutes';result jsonb;
begin
 if fluid_private.standalone_keys(p_evidence,array['version','request','context','baseRevision','brief','fonts']) is distinct from true
  or p_evidence->'version' is distinct from '1'::jsonb or octet_length(p_evidence::text)>1048576
  or fluid_private.standalone_keys(request,array['operation','expected','baseVectorRevisionId','instruction','targetComponentIds']) is distinct from true
  or request->>'operation' is distinct from 'propose_vector_edit' or fluid_private.logo_uuid(request->'baseVectorRevisionId') is distinct from true
  or fluid_private.standalone_text(request->'instruction',4000,1) is distinct from true or nullif(btrim(request->>'instruction'),'') is null
  or jsonb_typeof(request->'targetComponentIds') is distinct from 'array' or jsonb_array_length(request->'targetComponentIds') not between 1 and 64
  or (select count(*)<>count(distinct value) from jsonb_array_elements(request->'targetComponentIds')) then raise exception 'invalid_vector_proposal_quote' using errcode='22023';end if;
 if fluid_private.standalone_keys(context,array['version','ownerId','projectId','baseVectorRevisionId','documentHash','source','viewBox','locks','inputRevisions','brief','components','fonts','targetComponentIds','allowedOperations']) is distinct from true
  or octet_length(context::text)>65536 or context->'version' is distinct from '1'::jsonb or context->>'ownerId' is distinct from owner::text or context->>'projectId' is distinct from p_project_id::text
  or context->'baseVectorRevisionId' is distinct from request->'baseVectorRevisionId' or context->'targetComponentIds' is distinct from request->'targetComponentIds'
  or jsonb_typeof(context->'components') is distinct from 'array' or jsonb_array_length(context->'components') not between 1 and 64
  or jsonb_typeof(context->'fonts') is distinct from 'array' or jsonb_array_length(context->'fonts')>100
  or jsonb_typeof(p_evidence->'fonts') is distinct from 'array' or jsonb_array_length(p_evidence->'fonts')<>jsonb_array_length(context->'fonts') then raise exception 'invalid_vector_proposal_context' using errcode='22023';end if;
 if(select count(*)<>count(distinct value->>'id') from jsonb_array_elements(context->'components')) or(select count(*)<>count(distinct value->>'id') from jsonb_array_elements(context->'fonts')) or(select count(*)<>count(distinct value->>'id') from jsonb_array_elements(p_evidence->'fonts')) then raise exception 'invalid_vector_proposal_context' using errcode='22023';end if;
 for component in select value from jsonb_array_elements(context->'components') loop
  if fluid_private.standalone_keys(component,array['id','role','editingKind','transform','paintedBounds','localPaintedBounds','paint','text','allowedOperations']) is distinct from true then raise exception 'invalid_vector_proposal_component' using errcode='22023';end if;
 end loop;
 for target in select value from jsonb_array_elements(request->'targetComponentIds') loop
  if jsonb_typeof(target) is distinct from 'string' or target#>>'{}'!~'^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$' or not exists(select 1 from jsonb_array_elements(context->'components') c where c->'id'=target) then raise exception 'invalid_vector_proposal_target' using errcode='22023';end if;
 end loop;
 perform pg_advisory_xact_lock(hashtextextended(owner::text,723902));
 perform 1 from public.projects where id=p_project_id and owner_id=owner for update;if not found then raise exception 'logo_project_not_found' using errcode='P0002';end if;
 workspace:=fluid_private.logo_workspace_json(owner,p_project_id);
 if workspace->'heads' is distinct from request->'expected' or fluid_private.logo_current_vector_id(owner,p_project_id) is distinct from (request->>'baseVectorRevisionId')::uuid then raise exception 'logo_quote_stale' using errcode='PT409';end if;
 select record into base from public.logo_vector_revisions where id=(request->>'baseVectorRevisionId')::uuid and owner_id=owner and project_id=p_project_id;
 if base is null or base is distinct from p_evidence->'baseRevision' or context->'documentHash' is distinct from base->'documentHash'
  or context->'locks' is distinct from base->'locks' or context->'source' is distinct from base->'source' or context->'inputRevisions' is distinct from base->'inputRevisions'
  or context->'viewBox' is distinct from base#>'{proof,viewBox}' or fluid_private.logo_vector_proof_valid(base->'proof') is distinct from true
  or base->'documentHash' is distinct from base#>'{documentAsset,contentHash}' or base->'documentHash' is distinct from base#>'{proof,documentHash}' then raise exception 'logo_proposal_source_changed' using errcode='PT409';end if;
 if exists(select 1 from jsonb_array_elements(base->'inputRevisions') i left join public.logo_stage_heads h on h.owner_id=owner and h.project_id=p_project_id and h.stage=i->>'stage' where h.revision_id::text is distinct from i->>'id') then raise exception 'logo_proposal_source_changed' using errcode='PT409';end if;
 select r.record into brief from public.logo_stage_revisions r where r.id=(context#>>'{brief,id}')::uuid and r.owner_id=owner and r.project_id=p_project_id and r.stage='brief_references';
 if brief is null or brief is distinct from p_evidence->'brief' or context->'brief' is distinct from jsonb_build_object('id',brief->'id','revision',brief->'revision','inputHash',brief->'inputHash','name',brief#>'{payload,name}')
  or not exists(select 1 from jsonb_array_elements(base->'inputRevisions') i where i->>'stage'='brief_references' and i->'id'=brief->'id' and i->'revision'=brief->'revision') then raise exception 'logo_proposal_brief_changed' using errcode='PT409';end if;
 for font in select value from jsonb_array_elements(p_evidence->'fonts') loop
  select record into stored_font from public.logo_font_records where record_id=(font->>'id')::uuid and owner_id=owner and project_id=p_project_id;
  select value into summary from jsonb_array_elements(context->'fonts') f where f->'id'=font->'id';
  if stored_font is null or font is distinct from stored_font or summary is null
   or summary->'family' is distinct from font->'family' or summary->'source' is distinct from font->'source'
   or summary->'assetVersionId' is distinct from font#>'{asset,versionId}' or summary->'fontContentHash' is distinct from font#>'{asset,contentHash}'
   or summary->'rightsEvidenceId' is distinct from font#>'{rights,id}' or font#>>'{rights,commercialUse}' is distinct from 'allowed'
   or font#>>'{rights,sourceKind}' is distinct from 'reviewed_license' or font#>'{rights,reviewedAt}'='null'::jsonb
   or font#>>'{rights,permissions,render}' is distinct from 'allowed' or font#>>'{rights,permissions,outline}' is distinct from 'allowed' then raise exception 'logo_proposal_font_changed' using errcode='PT409';end if;
 end loop;
 profile:=fluid_private.shared_logo_policy(owner,'identity.logo_vector_propose'); policy:=profile->'policy';
 if policy is null or not fluid_private.shared_logo_advanced_policy_valid('identity.logo_vector_propose',policy) then raise exception 'shared_logo_policy_unavailable' using errcode='55000'; end if;
 if octet_length(jsonb_build_object('context',context,'instruction',request->'instruction')::text)>(policy#>>'{textPolicy,maxInputBytes}')::integer then raise exception 'logo_proposal_input_too_large' using errcode='22023';end if;
 context_hash:=encode(sha256(convert_to(context::text,'UTF8')),'hex');
 sources:=jsonb_build_object('context',context,'contextHash',context_hash,'baseRevision',base,'brief',brief,'fonts',p_evidence->'fonts');
 input_hash:=encode(sha256(convert_to(jsonb_build_object('request',request,'sources',sources,'policy',policy)::text,'UTF8')),'hex');
 result:=jsonb_build_object('id',quote_id,'ownerId',owner,'projectId',p_project_id,'request',request,'inputHash',input_hash,'expected',request->'expected','policyIdentity',policy->>'policyIdentity','handlerVersion',policy->>'handlerVersion','provider',policy->>'provider','model',policy->>'model','engine',null,'version',3,'billingMode','openai_api','spendControl','uncapped','expiresAt',to_char(expires at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'conceptPlan',null,'targetSlotIds','[]'::jsonb,'textPolicy',policy->'textPolicy');
 insert into public.logo_cost_quotes(id,owner_id,project_id,operation,record,input_revisions,source_inputs,expires_at) values(quote_id,owner,p_project_id,policy->>'operation',result,base->'inputRevisions',sources,expires);
 insert into fluid_private.shared_logo_advanced_quotes(quote_id,owner_id,project_id,operation,policy,deployment_id) values(quote_id,owner,p_project_id,policy->>'operation',policy,profile->>'deploymentId');return result;
end $$;

create function fluid_private.shared_logo_direction_storage_member(j public.jobs,r public.logo_asset_publications)
returns jsonb language plpgsql stable set search_path='' as $$
declare source jsonb; ref jsonb; font jsonb; catalog jsonb;
 request public.logo_input_requests; rights public.logo_input_rights; receipt public.logo_input_receipts;
begin
 if j.id is null or j.operation is distinct from 'identity.logo_directions' or r.id is null
  or r.owner_id is distinct from j.owner_id or r.project_id is distinct from j.project_id
  or r.purpose is distinct from 'brand_asset' or r.state is distinct from 'committed'
  or r.verification->>'status' is distinct from 'verified'
  or r.verification->>'contentHash' is distinct from r.content_hash
  or r.verification->>'mimeType' is distinct from r.mime_type
  or r.verification->'byteLength' is distinct from to_jsonb(r.byte_length) then return null; end if;
 if not exists(select 1 from public.asset_versions v join public.assets a
  on a.id=v.asset_id and a.owner_id=v.owner_id and a.project_id=v.project_id
  where v.owner_id=r.owner_id and v.project_id=r.project_id and v.asset_id=r.asset_id and v.id=r.version_id
   and v.content_hash=r.content_hash and v.mime_type=r.mime_type and v.input_revision=r.input_revision and v.input_hash=r.input_hash
   and v.storage_path=r.owner_id::text||'/'||r.project_id::text||'/'||r.asset_id::text||'/'||r.version_id::text
   and v.provenance->'version'='2'::jsonb and v.provenance->>'publicationId'=r.id::text
   and v.provenance->>'sourceReceiptId'=r.source_receipt_id::text
   and a.purpose=r.purpose and a.kind='logo_'||r.source_kind) then return null; end if;
 select d.source into source from public.logo_direction_inputs d where d.job_id=j.id
  and d.owner_id=j.owner_id and d.project_id=j.project_id and d.input_hash=j.input_hash;
 if source is null then return null; end if;
 ref:=fluid_private.logo_asset_reservation(r)->'reference';
 if source#>'{logoRevision,documentAsset}'=ref then
  if r.mime_type='application/json' and r.byte_length between 1 and 8388608 and r.source_kind='vector'
   and r.rights_evidence_id is null and source#>>'{logoRevision,documentHash}'=r.content_hash
   and source#>>'{logoRevision,proof,documentHash}'=r.content_hash
   and source#>'{logoRevision,svgAsset,contentHash}'=source#>'{logoRevision,proof,svgContentHash}'
   and fluid_private.logo_vector_proof_valid(source#>'{logoRevision,proof}') is true
   and r.request->>'kind'='stage' and r.request#>>'{publication,source,kind}'='vector'
   and r.request#>>'{publication,source,sourceId}'=r.source_receipt_id::text
   and r.request#>'{publication,inputRevisions}'=source#>'{logoRevision,inputRevisions}'
   and r.request#>>'{publication,requestKey}'=r.request_key::text
   and r.request#>>'{publication,contentHash}'=r.content_hash and r.request#>>'{publication,mimeType}'=r.mime_type
   and r.request#>'{publication,byteLength}'=to_jsonb(r.byte_length)
  then return jsonb_build_object('kind','logo-document'); end if;
  return null;
 end if;
 if jsonb_typeof(source->'permittedFonts') is distinct from 'array' or r.mime_type not in('font/ttf','font/otf')
  or r.byte_length not between 12 and 10485760 or r.source_kind is distinct from 'font'
  or r.job_id is not null or r.lease_token is not null or r.rights_evidence_id is null
  or r.request->>'kind' is distinct from 'upload' or r.request#>>'{intent,usage}' is distinct from 'font'
  or r.request#>>'{intent,requestKey}' is distinct from r.request_key::text
  or r.request#>>'{intent,contentHash}' is distinct from r.content_hash
  or r.request#>>'{intent,mimeType}' is distinct from r.mime_type
  or r.request->'byteLength' is distinct from to_jsonb(r.byte_length) then return null; end if;
 select f.record into font from public.logo_font_records f
  join jsonb_array_elements(source->'permittedFonts') frozen on frozen=f.record
  where f.record_id=r.version_id and f.version_id=r.version_id and f.owner_id=j.owner_id and f.project_id=j.project_id
   and f.record->'asset'=ref;
 if font is null or font->>'id' is distinct from r.version_id::text or font->>'source' is distinct from 'free_catalog'
  or font#>>'{rights,id}' is distinct from r.rights_evidence_id::text
  or font#>>'{rights,fontContentHash}' is distinct from r.content_hash
  or font#>>'{rights,sourceKind}' is distinct from 'reviewed_license'
  or font#>>'{rights,commercialUse}' is distinct from 'allowed'
  or font#>>'{rights,permissions,render}' is distinct from 'allowed'
  or jsonb_typeof(font#>'{rights,reviewedAt}') is distinct from 'string'
  or nullif(font#>>'{rights,reviewedAt}','') is null then return null; end if;
 select * into request from public.logo_input_requests where owner_id=r.owner_id and project_id=r.project_id and request_key=r.request_key;
 select * into rights from public.logo_input_rights where id=r.rights_evidence_id and publication_id=r.id and owner_id=r.owner_id and project_id=r.project_id;
 select * into receipt from public.logo_input_receipts where owner_id=r.owner_id and project_id=r.project_id and request_key=r.request_key and font_record_id=r.version_id;
 if request.request_key is null or rights.id is null or receipt.request_key is null or receipt.reference_id is not null
  or receipt.result is distinct from font or request.request->>'kind' is distinct from 'font_catalog'
  or fluid_private.logo_input_request_valid(request.request) is distinct from true
  or request.request#>>'{input,requestKey}' is distinct from r.request_key::text
  or request.request#>>'{file,contentHash}' is distinct from r.content_hash
  or request.request#>>'{file,mimeType}' is distinct from r.mime_type
  or request.request#>'{file,byteLength}' is distinct from to_jsonb(r.byte_length)
  or rights.source_kind is distinct from 'reviewed_license' or rights.catalog_id is null
  or rights.catalog_id is distinct from request.request#>>'{input,catalogFontId}'
  or rights.content_hash is distinct from r.content_hash
  or rights.source_url is distinct from font#>>'{rights,sourceUrl}'
  or rights.license_text is null or octet_length(rights.license_text) not between 1 and 262144
  or nullif(btrim(rights.license_text),'') is null
  or rights.license_text_hash is distinct from encode(sha256(convert_to(rights.license_text,'UTF8')),'hex')
  or rights.license_text_hash is distinct from font#>>'{rights,licenseTextHash}'
  or rights.rights_declaration is distinct from 'Reviewed free-commercial catalog '||rights.catalog_id||'; exact license SHA-256 '||rights.license_text_hash||'.'
  or rights.rights_declaration is distinct from r.request#>>'{intent,rightsDeclaration}'
  or exists(select 1 from public.logo_input_rejections x where x.owner_id=r.owner_id and x.project_id=r.project_id and x.request_key=r.request_key)
 then return null; end if;
 select c.record into catalog from fluid_private.logo_input_font_catalog c where c.id=rights.catalog_id;
 if catalog is null or catalog->>'id' is distinct from rights.catalog_id
  or catalog->>'contentHash' is distinct from r.content_hash or catalog->>'mimeType' is distinct from r.mime_type
  or catalog->'family' is distinct from font->'family'
  or catalog#>>'{rights,sourceUrl}' is distinct from rights.source_url
  or catalog#>>'{rights,licenseTextHash}' is distinct from rights.license_text_hash
  or (catalog->'rights')||jsonb_build_object('id',rights.id) is distinct from font->'rights'
 then return null; end if;
 return jsonb_build_object('kind','font','font',font);
exception when invalid_text_representation or numeric_value_out_of_range then return null;
end $$;

-- The native vector lane has no provider cost. Reuse the pinned original
-- admission/CAS/receipt code under a private shared-only zero-cost boundary;
-- an unrelated observed provider bill cannot prohibit local conversion.
do $$declare definition text;body text; original text;begin
 select prosrc into body from pg_proc where oid='public.admit_logo_operation(uuid,jsonb)'::regprocedure;
 if md5(body)<>'d6fe30e25ebe38cb40b957bb1be15a05' then raise exception 'shared_logo_vector_admission_predecessor_mismatch' using errcode='55000';end if;
 definition:=pg_get_functiondef('public.admit_logo_operation(uuid,jsonb)'::regprocedure);
 original:='cost>account.limit_microusd-greatest(account.spent_microusd,account.provider_actual_microusd)-account.reserved_microusd';
 if(length(body)-length(replace(body,original,'')))/length(original)<>1 then raise exception 'shared_logo_vector_budget_fragment_mismatch' using errcode='55000';end if;
 body:=replace(body,original,'cost>0');
 body:=replace(body,E'\nbegin\n',E'\nbegin\n if not fluid_private.shared_logo_context_allowed(owner,p_project_id) or not exists(select 1 from public.logo_cost_quotes where id=(p_input->>''quoteId'')::uuid and owner_id=owner and project_id=p_project_id and operation=''identity.logo_vectorize'' and record->''maxCostMicrousd''=''0''::jsonb) then raise exception ''shared_logo_vector_admission_denied'' using errcode=''42501'';end if;\n');
 definition:=replace(definition,(select prosrc from pg_proc where oid='public.admit_logo_operation(uuid,jsonb)'::regprocedure),body);
 execute replace(definition,'public.admit_logo_operation(','fluid_private.shared_logo_admit_vector(');
end $$;

-- Common observation accounting is independent of monetary admission. A zero
-- reservation is bookkeeping; every independently observed charge is retained.
create function fluid_private.shared_logo_directions_observation_valid(o jsonb,p jsonb) returns boolean
language plpgsql stable set search_path='' as $$declare u jsonb:=o->'usage'; b jsonb:=o->'billing'; k text; n numeric; cost numeric; begin
 if not fluid_private.shared_logo_text_policy_valid(p,'directions')
  or not fluid_private.standalone_keys(o,array['version','kind','provider','model','providerRequestId','responseHash','observedAt','billing','artifactHash','billingMode','spendControl','apiPolicy','responseId','usage','serviceTier','toolCalls','responseComplete'])
  or octet_length(o::text)>32768 or o->'version' is distinct from '3'::jsonb or o->>'kind' is distinct from 'logo_directions_text'
  or o->>'provider' is distinct from 'openai' or o->>'billingMode' is distinct from 'openai_api' or o->>'spendControl' is distinct from 'uncapped'
  or o->'apiPolicy' is distinct from p or o->'artifactHash' is distinct from 'null'::jsonb or jsonb_typeof(o->'responseComplete') is distinct from 'boolean'
  or not fluid_private.standalone_timestamp(o->'observedAt') or(o->>'observedAt')::timestamptz>clock_timestamp()+interval '1 minute' then return false;end if;
 foreach k in array array['model','serviceTier','responseId','providerRequestId'] loop
  if o->k<>'null'::jsonb and not fluid_private.standalone_text(o->k,case k when 'model' then 150 when 'serviceTier' then 100 else 200 end,1) then return false; end if;
 end loop;
 if o->'responseHash'<>'null'::jsonb and(jsonb_typeof(o->'responseHash') is distinct from 'string' or o->>'responseHash'!~'^[a-f0-9]{64}$') then return false;end if;
 if o->'responseId'<>'null'::jsonb and o->>'responseId'!~'^resp_[a-zA-Z0-9_-]+$' then return false;end if;
 if o->'toolCalls'<>'null'::jsonb and(jsonb_typeof(o->'toolCalls') is distinct from 'number' or(o->>'toolCalls')::numeric not between 0 and 9007199254740991 or trunc((o->>'toolCalls')::numeric)<>(o->>'toolCalls')::numeric) then return false;end if;
 if u<>'null'::jsonb then
  if not fluid_private.standalone_keys(u,array['inputTokens','cachedInputTokens','cacheWriteInputTokens','outputTokens']) then return false;end if;
  foreach k in array array['inputTokens','cachedInputTokens','cacheWriteInputTokens','outputTokens'] loop
   if jsonb_typeof(u->k) is distinct from 'number' then return false;end if;n:=(u->>k)::numeric;
   if n not between 0 and 9007199254740991 or n<>trunc(n) then return false;end if;
  end loop;
  if(u->>'cachedInputTokens')::numeric+(u->>'cacheWriteInputTokens')::numeric>(u->>'inputTokens')::numeric then return false;end if;
 end if;
 if not fluid_private.standalone_keys(b,array['status','confirmedMicrousd']) then return false;end if;
 if b->>'status'='unknown' then return b->'confirmedMicrousd'='null'::jsonb;end if;
 if b->>'status' is distinct from 'recorded' or jsonb_typeof(b->'confirmedMicrousd') is distinct from 'number' or(b->>'confirmedMicrousd')::numeric not between 0 and 9007199254740991
  or trunc((b->>'confirmedMicrousd')::numeric)<>(b->>'confirmedMicrousd')::numeric or u='null'::jsonb or o->'model' is distinct from p->'model'
  or o->'serviceTier' is distinct from p->'serviceTier' or o->'toolCalls' is distinct from '0'::jsonb or(u->>'inputTokens')::numeric>272000 then return false;end if;
 cost:=ceil((((u->>'inputTokens')::numeric-(u->>'cachedInputTokens')::numeric-(u->>'cacheWriteInputTokens')::numeric)*2000000
  +(u->>'cachedInputTokens')::numeric*100000+(u->>'cacheWriteInputTokens')::numeric*2500000+(u->>'outputTokens')::numeric*10000000)/1000000);
 return cost=(b->>'confirmedMicrousd')::numeric;
exception when others then return false;
end $$;
create function fluid_private.shared_logo_response_identity_complete(j public.jobs,o jsonb) returns boolean
language sql stable set search_path='' as $$select
 case when j.operation='identity.logo_directions' and j.input->'version'='3'::jsonb then
  fluid_private.shared_logo_directions_observation_valid(o,j.input->'apiPolicy') and o->'responseComplete'='true'::jsonb and o->>'responseId' is not null and o->>'responseHash' is not null
 else fluid_private.logo_response_identity_complete(j,o) end;$$;
create function fluid_private.shared_logo_record_response(p_job uuid,p_lease uuid,o jsonb) returns jsonb
language plpgsql set search_path='' as $$declare j public.jobs; r public.logo_provider_responses; s public.job_steps; account public.usage_accounts; reservation public.usage_reservations;
 cost bigint:=0; reason text; p jsonb; accountable boolean; begin
 j:=fluid_private.shared_logo_lock_issued_job(p_job,p_lease);
 select * into r from public.logo_provider_responses where job_id=j.id and owner_id=j.owner_id and project_id=j.project_id;
 if found then
  if r.observation is distinct from o or r.lease_token is distinct from p_lease then raise exception 'provider_evidence_immutable' using errcode='PT409';end if;
 else
  select * into s from public.job_steps where job_id=j.id for update;
  p:=case j.operation when 'identity.logo_directions' then j.input->'apiPolicy' else j.input->'textPolicy' end;
  if j.state not in('running','cancel_requested','needs_reconciliation') or s.state not in('in_flight','ambiguous') or
   (case j.operation when 'identity.logo_directions' then fluid_private.shared_logo_directions_observation_valid(o,p)
    when 'identity.logo_vector_propose' then fluid_private.shared_logo_valid_vector_proposal_observation(o,p) else false end) is distinct from true
   or(o->>'observedAt')::timestamptz>clock_timestamp()+interval '1 minute' then raise exception 'invalid_provider_evidence' using errcode='22023'; end if;
  insert into public.logo_provider_responses(owner_id,project_id,job_id,lease_token,observation) values(j.owner_id,j.project_id,j.id,p_lease,o) returning * into r;
  if o#>>'{billing,status}'='recorded' then
   cost:=(o#>>'{billing,confirmedMicrousd}')::bigint;
   select * into reservation from public.usage_reservations where job_id=j.id and owner_id=j.owner_id and project_id=j.project_id for update;
   select * into account from public.usage_accounts where owner_id=j.owner_id for update;
   accountable:=reservation.job_id is not null and account.owner_id is not null and reservation.state='active' and reservation.reserved_microusd=0
    and reservation.actual_microusd=0 and reservation.captured_microusd=0 and j.actual_cost_microusd=0 and s.actual_cost_microusd=0
    and account.provider_actual_microusd::numeric+cost<=9007199254740991;
   if accountable then
    update public.usage_accounts set provider_actual_microusd=provider_actual_microusd+cost where owner_id=j.owner_id;
    update public.usage_reservations set actual_microusd=cost where job_id=j.id;
   else reason:='provider_accounting_unconfirmed';end if;
   update public.jobs set actual_cost_microusd=cost where id=j.id;
   update public.job_steps set actual_cost_microusd=cost where id=s.id;
  else reason:='provider_billing_unknown';end if;
  if reason is null then
   if o->'responseComplete' is distinct from 'true'::jsonb or o->>'responseId' is null or o->>'responseHash' is null then reason:='provider_evidence_incomplete';
   elsif(o#>>'{usage,inputTokens}')::numeric>(p->>'maxInputTokens')::numeric or(o#>>'{usage,outputTokens}')::numeric>(p->>'maxOutputTokens')::numeric then reason:='provider_usage_exceeded';
   elsif j.lease_token is distinct from p_lease or j.lease_expires_at is null or j.lease_expires_at<=clock_timestamp() then reason:='provider_response_after_lease';end if;
  end if;
  if reason is not null then update public.jobs set state='needs_reconciliation',lease_token=null,lease_expires_at=null,error_code=reason where id=j.id;end if;
 end if;
 if j.operation='identity.logo_vector_propose' then
  return jsonb_build_object('id',r.id,'ownerId',r.owner_id,'projectId',r.project_id,'jobId',r.job_id,'leaseToken',r.lease_token,'observation',r.observation);
 end if;
 return r.observation||jsonb_build_object('id',r.id,'ownerId',r.owner_id,'projectId',r.project_id,'jobId',r.job_id,'leaseToken',r.lease_token);
end $$;
create function fluid_private.shared_logo_record_vector_proposal_response(p_job uuid,p_lease uuid,o jsonb) returns jsonb
language sql set search_path='' as $$select fluid_private.shared_logo_record_response(p_job,p_lease,o)$$;

create function fluid_private.shared_logo_claim_job(p_job uuid,p_worker text,p_seconds integer) returns public.jobs
language plpgsql set search_path='' as $$declare j public.jobs; begin
 if p_seconds not between 1 and 300 or p_worker is null or p_worker!~'^[A-Za-z0-9._:-]{1,200}$' or fluid_private.shared_worker_context_mode('logo')<>'claim'
  or fluid_private.shared_worker_context_job('logo') is distinct from p_job then raise exception 'shared_logo_claim_denied' using errcode='42501'; end if;
 select * into j from public.jobs where id=p_job and owner_id=fluid_private.logo_worker_owner() for update;
 if not found or j.state<>'queued' or j.cancel_requested_at is not null or j.attempts<>0 or not fluid_private.logo_job_ready(j,p_worker)
  or not fluid_private.shared_logo_advanced_job_matches(j,(select policy from fluid_private.shared_job_admissions where job_id=j.id)) then raise exception 'shared_logo_claim_unavailable' using errcode='55000';end if;
 update public.jobs set state='running',worker_id=p_worker,attempts=1,lease_token=gen_random_uuid(),lease_expires_at=clock_timestamp()+make_interval(secs=>p_seconds) where id=j.id returning * into j;
 return j;
end $$;
create function fluid_private.shared_logo_begin_job(p_job uuid,p_lease uuid,p_step text,p_key text,p_cost bigint) returns text
language plpgsql set search_path='' as $$declare j public.jobs; s public.job_steps; begin
 j:=fluid_private.logo_lock_job(p_job,p_lease);
 if j.state<>'running' or j.cancel_requested_at is not null or p_cost is distinct from 0 or p_key is null or length(p_key) not between 1 and 200
  or not fluid_private.lock_logo_job_readiness(j,j.worker_id) or not exists(select 1 from jsonb_array_elements(j.plan_manifest) m where m->>'key'=p_step and m->'maximumCostMicrousd'='0'::jsonb)
 then raise exception 'shared_logo_dispatch_denied' using errcode='55000'; end if;
 select * into s from public.job_steps where job_id=j.id and step_key=p_step;
 if found then
  if s.state='succeeded' and s.request_key=p_key and s.reserved_cost_microusd=0 then return 'already_succeeded'; end if;
  raise exception 'step_requires_reconciliation_or_new_job' using errcode='55000';
 end if;
 if exists(select 1 from public.job_steps where job_id=j.id) then raise exception 'unsafe_step' using errcode='55000';end if;
 insert into public.job_steps(job_id,owner_id,project_id,step_key,request_key,state,reserved_cost_microusd) values(j.id,j.owner_id,j.project_id,p_step,p_key,'in_flight',0);
 insert into fluid_private.shared_logo_vector_proposal_dispatches(job_id,owner_id,project_id,quote_id,role_name,role_oid,worker_id,lease_token,step_key,step_request_key,input)
  values(j.id,j.owner_id,j.project_id,(j.input->>'quoteId')::uuid,session_user,to_regrole(session_user)::oid,j.worker_id,p_lease,p_step,p_key,j.input);
 return 'started';
end $$;

-- Derive a separate shared directions completion helper from the exactly pinned
-- predecessor. The original function/OID/ACL and every historical row survive.
-- Only money-limit decisions and duplicate accounting are removed; frozen font,
-- source, receipt, geometry, cancellation and immutable publication checks stay.
do $$declare definition text; body text; original text; replacement text; begin
 definition:=pg_get_functiondef('fluid_private.logo_commit_direction_publication(public.jobs,uuid,uuid)'::regprocedure);
 definition:=replace(definition,'fluid_private.logo_commit_direction_publication(','fluid_private.shared_logo_commit_direction_publication(');
 definition:=replace(definition,'fluid_private.logo_response_identity_complete(','fluid_private.shared_logo_response_identity_complete(');execute definition;
 definition:=pg_get_functiondef('public.complete_logo_job_step(uuid,uuid,text,text,bigint,jsonb,text)'::regprocedure);
 select prosrc into body from pg_proc where oid='public.complete_logo_job_step(uuid,uuid,text,text,bigint,jsonb,text)'::regprocedure;
 original:=' if p_actual_cost_microusd>s.reserved_cost_microusd or j.actual_cost_microusd+p_actual_cost_microusd>j.reserved_cost_microusd then state:=''ambiguous'';reason:=''provider_cost_exceeded'';end if;';
 if (length(body)-length(replace(body,original,'')))/length(original)<>2 then raise exception 'shared_logo_complete_cost_fragment_mismatch' using errcode='55000';end if;
 body:=replace(body,original,'');
 original:=' if j.billing_mode<>''chatgpt_subscription'' then'||E'\n'||' select * into reservation from public.usage_reservations where job_id=j.id for update;';
 if strpos(body,original)=0 then raise exception 'shared_logo_complete_accounting_fragment_mismatch' using errcode='55000';end if;
 body:=overlay(body placing '' from strpos(body,original) for strpos(substr(body,strpos(body,original)),E'\n end if;')+length(E'\n end if;')-1);
 body:=replace(body,' update public.jobs set actual_cost_microusd=actual_cost_microusd+p_actual_cost_microusd where id=j.id;','');
 body:=replace(body,' if s.state<>''in_flight'' then', ' if s.state=''ambiguous'' and s.output=''{'||'"error":"provider_outcome_unknown"'||'}''::jsonb and p_state=''ambiguous'' and p_actual_cost_microusd=0 and p_provider_request_id is null and p_output=s.output then return s;end if; if s.state<>''in_flight'' then');
 body:=replace(body,' if paid then', ' if p_state=''ambiguous'' and p_actual_cost_microusd=0 and p_provider_request_id is null and p_output=''{'||'"error":"provider_outcome_unknown"'||'}''::jsonb and r.id is not null then p_actual_cost_microusd:=case when r.observation#>>''{billing,status}''=''recorded'' then(r.observation#>>''{billing,confirmedMicrousd}'')::bigint else 0 end;p_provider_request_id:=r.observation->>''providerRequestId'';end if; if paid then');
 body:=replace(body,'fluid_private.logo_response_identity_complete(','fluid_private.shared_logo_response_identity_complete(');
 body:=replace(body,'fluid_private.logo_commit_direction_publication(','fluid_private.shared_logo_commit_direction_publication(');
 definition:=replace(definition,(select prosrc from pg_proc where oid='public.complete_logo_job_step(uuid,uuid,text,text,bigint,jsonb,text)'::regprocedure),body);
 definition:=replace(definition,'public.complete_logo_job_step(','fluid_private.shared_logo_complete_directions(');execute definition;
end $$;
create function fluid_private.shared_logo_advanced_action(p_job uuid,p_lease uuid,p_action text,p_args jsonb) returns jsonb
language plpgsql set search_path='' as $$declare j public.jobs; q public.logo_cost_quotes; result jsonb; begin
 j:=fluid_private.logo_lock_job(p_job,p_lease);
 if fluid_private.shared_worker_context_job('logo') is distinct from j.id or not fluid_private.shared_logo_advanced_job_matches(j,(select policy from fluid_private.shared_job_admissions where job_id=j.id)) then raise exception 'shared_logo_advanced_binding_invalid' using errcode='42501';end if;
 select * into q from public.logo_cost_quotes where id=(j.input->>'quoteId')::uuid and owner_id=j.owner_id and project_id=j.project_id;
 if p_action='plan' and jsonb_array_length(p_args)=3 then perform public.register_logo_job_plan(p_job,p_lease,fluid_private.shared_logo_json_arg(p_args,2)); return 'null'::jsonb;
 elsif p_action='begin' and jsonb_array_length(p_args)=5 then return to_jsonb(fluid_private.shared_logo_begin_job(p_job,p_lease,p_args->>2,p_args->>3,(p_args->>4)::bigint));
 elsif p_action='receipt' and jsonb_array_length(p_args)=3 then return fluid_private.shared_logo_record_response(p_job,p_lease,fluid_private.shared_logo_json_arg(p_args,2));
 elsif p_action='complete' and jsonb_array_length(p_args)=7 then
  if j.operation='identity.logo_vector_propose' then perform fluid_private.shared_logo_complete_proposal(p_job,p_lease,p_args->>2,p_args->>3,(p_args->>4)::bigint,fluid_private.shared_logo_json_arg(p_args,5),p_args->>6);
  else perform fluid_private.shared_logo_complete_directions(p_job,p_lease,p_args->>2,p_args->>3,(p_args->>4)::bigint,fluid_private.shared_logo_json_arg(p_args,5),p_args->>6);end if;return 'null'::jsonb;
 elsif p_action='finish' and jsonb_array_length(p_args)=3 then perform public.finish_logo_job(p_job,p_lease,p_args->>2);return 'null'::jsonb;
 elsif p_action='direction_inputs' and jsonb_array_length(p_args)=2 and j.operation='identity.logo_directions' then return public.load_logo_direction_inputs(p_job,p_lease);
 elsif p_action='stage_directions' and jsonb_array_length(p_args)=5 and j.operation='identity.logo_directions' then return public.stage_logo_directions(p_job,p_lease,fluid_private.shared_logo_json_arg(p_args,2),(p_args->>3)::uuid,fluid_private.shared_logo_json_arg(p_args,4));
 elsif p_action='stage_proposal' and jsonb_array_length(p_args)=4 and j.operation='identity.logo_vector_propose' then return fluid_private.shared_logo_stage_proposal(p_job,p_lease,fluid_private.shared_logo_json_arg(p_args,2),(p_args->>3)::uuid);
 elsif p_action='read' and jsonb_array_length(p_args)=4 then
  if p_args->>2='runtime_readiness' and fluid_private.shared_logo_json_arg(p_args,3) in('null'::jsonb) then return to_jsonb(j.state='running' and fluid_private.logo_job_ready(j,j.worker_id));
  elsif p_args->>2='input_revisions' then return q.input_revisions;
  elsif p_args->>2 in('vector_proposal_inputs','vector_proposal_evidence_inputs') and j.operation='identity.logo_vector_propose' and fluid_private.shared_logo_json_arg(p_args,3) in('null'::jsonb) then
   if p_args->>2='vector_proposal_evidence_inputs' then perform fluid_private.shared_logo_lock_issued_job(p_job,p_lease);end if;
   return jsonb_build_object('input',j.input,'context',q.source_inputs->'context');
  elsif p_args->>2='step_output' then select output into result from public.job_steps where job_id=j.id and step_key=fluid_private.shared_logo_json_arg(p_args,3)->>'stepKey' and state='succeeded';return result;
  end if;
 end if; raise exception 'shared_logo_advanced_action_denied' using errcode='42501';
end $$;

create function fluid_private.shared_logo_read_proposal_asset(p_project uuid,p_reference jsonb,p_job uuid,p_lease uuid) returns jsonb
language plpgsql volatile set search_path='' as $$declare j public.jobs; r public.logo_asset_publications;begin
 j:=fluid_private.logo_lock_job(p_job,p_lease);
 if j.operation<>'identity.logo_vector_propose' or j.project_id is distinct from p_project or fluid_private.shared_logo_storage_policy(j) is null then raise exception 'shared_logo_asset_scope_denied' using errcode='42501';end if;
 select * into r from public.logo_asset_publications where owner_id=j.owner_id and project_id=j.project_id and fluid_private.logo_asset_reservation(logo_asset_publications)->'reference'=p_reference;
 if not found or fluid_private.shared_logo_storage_member(j,r,'read') is distinct from jsonb_build_object('member','logo-document') then raise exception 'logo_asset_not_found' using errcode='P0002';end if;
 return fluid_private.logo_asset_reservation(r);
end $$;

create function fluid_private.shared_logo_quote_directions(p_project uuid,p_input jsonb) returns jsonb
language plpgsql set search_path='' as $$declare owner uuid:=auth.uid(); profile jsonb; policy jsonb; source jsonb; sources jsonb; brief public.logo_stage_revisions;
 id uuid:=gen_random_uuid(); result jsonb; input_hash text; expires timestamptz:=clock_timestamp()+interval '5 minutes'; begin
 if owner is null or not fluid_private.shared_account_customer_active(owner) then raise exception 'unauthenticated' using errcode='42501'; end if;
 if not fluid_private.standalone_keys(p_input,array['operation','expected','approvedLogoId']) or p_input->>'operation' is distinct from 'directions'
  or not fluid_private.logo_uuid(p_input->'approvedLogoId') then raise exception 'invalid_logo_directions' using errcode='22023';end if;
 perform pg_advisory_xact_lock(hashtextextended(owner::text,723902));
 perform 1 from public.projects where projects.id=p_project and owner_id=owner for update;if not found then raise exception 'logo_project_not_found' using errcode='P0002';end if;
 if fluid_private.logo_workspace_json(owner,p_project)->'heads' is distinct from p_input->'expected' then raise exception 'logo_head_conflict' using errcode='PT409';end if;
 profile:=fluid_private.shared_logo_policy(owner,'identity.logo_directions');policy:=profile->'policy';
 if policy is null or not fluid_private.shared_logo_advanced_policy_valid('identity.logo_directions',policy) then raise exception 'shared_logo_policy_unavailable' using errcode='55000';end if;
 source:=fluid_private.logo_prepare_direction_sources(owner,p_project,(p_input->>'approvedLogoId')::uuid);
 if jsonb_array_length(source->'permittedFonts') not between 1 and 100 then raise exception 'shared_logo_font_required' using errcode='55000';end if;
 select * into brief from public.logo_stage_revisions where logo_stage_revisions.id=(source#>>'{brief,id}')::uuid and owner_id=owner and project_id=p_project and stage='brief_references';
 sources:=jsonb_build_object('brief',brief.record,'referenceSnapshot',source->'references','raster',null,'direction',source);
 if octet_length(source::text)>(policy#>>'{apiPolicy,maxInputBytes}')::integer then raise exception 'shared_logo_input_too_large' using errcode='22023';end if;
 input_hash:=encode(sha256(convert_to(jsonb_build_object('request',p_input,'sources',sources,'policy',policy)::text,'UTF8')),'hex');
 result:=jsonb_build_object('version',3,'billingMode','openai_api','spendControl','uncapped','id',id,'ownerId',owner,'projectId',p_project,'request',p_input,
  'inputHash',input_hash,'expected',p_input->'expected','policyIdentity',policy->'policyIdentity','handlerVersion',policy->'handlerVersion','provider','openai','model',policy->'model',
  'engine',null,'apiPolicy',policy->'apiPolicy','expiresAt',to_char(expires at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'conceptPlan',null,'targetSlotIds','[]'::jsonb);
 insert into public.logo_cost_quotes(id,owner_id,project_id,operation,record,input_revisions,source_inputs,expires_at)
  values(id,owner,p_project,'identity.logo_directions',result,source->'inputRevisions',sources,expires);
 insert into fluid_private.shared_logo_advanced_quotes(quote_id,owner_id,project_id,operation,policy,deployment_id)
  values(id,owner,p_project,'identity.logo_directions',policy,profile->>'deploymentId');return result;
end $$;
create function fluid_private.shared_logo_advanced_quote_current(q public.logo_cost_quotes,policy jsonb) returns boolean
language plpgsql stable set search_path='' as $$declare base jsonb; brief jsonb; font jsonb; stored jsonb; source jsonb; begin
 if not fluid_private.shared_logo_advanced_quote_binding(q,policy) or fluid_private.logo_workspace_json(q.owner_id,q.project_id)->'heads' is distinct from q.record->'expected' then return false;end if;
 if q.operation='identity.logo_directions' then
  return fluid_private.logo_prepare_direction_sources(q.owner_id,q.project_id,(q.record#>>'{request,approvedLogoId}')::uuid)=q.source_inputs->'direction';
 end if;
 if fluid_private.logo_current_vector_id(q.owner_id,q.project_id)::text is distinct from q.record#>>'{request,baseVectorRevisionId}' then return false;end if;
 select record into base from public.logo_vector_revisions where id=(q.record#>>'{request,baseVectorRevisionId}')::uuid and owner_id=q.owner_id and project_id=q.project_id;
 if base is null or base is distinct from q.source_inputs->'baseRevision'
  or exists(select 1 from jsonb_array_elements(q.input_revisions) i left join public.logo_stage_heads h on h.owner_id=q.owner_id and h.project_id=q.project_id and h.stage=i->>'stage' where h.revision_id::text is distinct from i->>'id') then return false;end if;
 select record into brief from public.logo_stage_revisions where id=(q.source_inputs#>>'{brief,id}')::uuid and owner_id=q.owner_id and project_id=q.project_id and stage='brief_references';
 if brief is null or brief is distinct from q.source_inputs->'brief' then return false;end if;
 for font in select value from jsonb_array_elements(q.source_inputs->'fonts') loop
  select record into stored from public.logo_font_records where record_id=(font->>'id')::uuid and owner_id=q.owner_id and project_id=q.project_id;
  if stored is null or stored is distinct from font or font#>>'{rights,sourceKind}' is distinct from 'reviewed_license' or font#>>'{rights,commercialUse}' is distinct from 'allowed'
   or font#>>'{rights,permissions,render}' is distinct from 'allowed' or font#>>'{rights,permissions,outline}' is distinct from 'allowed' then return false;end if;
 end loop;return true;
exception when others then return false;
end $$;
create function fluid_private.shared_logo_admit_advanced(p_project uuid,p_input jsonb) returns jsonb
language plpgsql set search_path='' as $$declare owner uuid:=auth.uid(); q public.logo_cost_quotes; previous public.logo_operation_requests; rejected public.logo_operation_rejections;
 profile jsonb; policy jsonb; input jsonb; manifest jsonb; id uuid:=gen_random_uuid(); receipt jsonb; j public.jobs; begin
 if owner is null then raise exception 'unauthenticated' using errcode='42501';end if;
 if not fluid_private.standalone_keys(p_input,array['requestKey','quoteId','expected']) or not fluid_private.logo_uuid(p_input->'requestKey') or not fluid_private.logo_uuid(p_input->'quoteId') then raise exception 'invalid_logo_intent' using errcode='22023';end if;
 perform pg_advisory_xact_lock(hashtextextended(owner::text,723902));
 perform 1 from public.projects where projects.id=p_project and owner_id=owner for update;if not found then raise exception 'logo_project_not_found' using errcode='P0002';end if;
 select * into previous from public.logo_operation_requests where owner_id=owner and project_id=p_project and request_key=(p_input->>'requestKey')::uuid;
 if found then if previous.input is distinct from p_input then raise exception 'logo_request_conflict' using errcode='PT409';end if;return previous.receipt;end if;
 select * into rejected from public.logo_operation_rejections where owner_id=owner and project_id=p_project and request_key=(p_input->>'requestKey')::uuid;
 if found then if rejected.input is distinct from p_input then raise exception 'logo_request_conflict' using errcode='PT409';end if;return rejected.receipt;end if;
 if exists(select 1 from public.logo_workspace_requests where owner_id=owner and project_id=p_project and request_key=(p_input->>'requestKey')::uuid) then raise exception 'logo_request_conflict' using errcode='PT409';end if;
 begin
  if not fluid_private.shared_account_customer_active(owner) or not fluid_private.shared_logo_project_clear(owner,p_project) then raise exception 'shared_logo_unavailable' using errcode='55000';end if;
  select * into q from public.logo_cost_quotes where logo_cost_quotes.id=(p_input->>'quoteId')::uuid and owner_id=owner and project_id=p_project for update;
  if not found then raise exception 'logo_quote_not_found' using errcode='P0002';end if;
  if exists(select 1 from public.logo_operation_requests where quote_id=q.id) or q.expires_at<=clock_timestamp() or q.record->'expected' is distinct from p_input->'expected' then raise exception 'logo_quote_stale' using errcode='PT409';end if;
  profile:=fluid_private.shared_logo_policy(owner,q.operation);policy:=profile->'policy';
  if policy is null or not fluid_private.shared_logo_advanced_quote_current(q,policy)
   or profile->>'deploymentId' is distinct from(select deployment_id from fluid_private.shared_logo_advanced_quotes where quote_id=q.id) then raise exception 'shared_logo_policy_changed' using errcode='PT409';end if;
  input:=jsonb_build_object('version',3,'ownerId',owner,'projectId',p_project,'operation',q.operation,'requestKey',p_input->'requestKey','quoteId',q.id,
   'policyIdentity',policy->'policyIdentity','handlerVersion',policy->'handlerVersion','inputHash',q.record->'inputHash','billingMode','openai_api','spendControl','uncapped');
  if q.operation='identity.logo_directions' then
   input:=input||jsonb_build_object('approvedLogoId',q.record#>'{request,approvedLogoId}','briefRevisionId',q.source_inputs#>'{direction,brief,id}','referenceSnapshotId',q.source_inputs#>'{direction,references,id}',
    'fontVersionIds',(select jsonb_agg(f->'id') from jsonb_array_elements(q.source_inputs#>'{direction,permittedFonts}') f),'targetCount',3,'apiPolicy',policy->'apiPolicy');
   manifest:='[{"key":"propose-directions","maximumCostMicrousd":0}]'::jsonb;
  elsif q.operation='identity.logo_vector_propose' then
   input:=input||jsonb_build_object('baseVectorRevisionId',q.record#>'{request,baseVectorRevisionId}','contextHash',q.source_inputs->'contextHash','instruction',q.record#>'{request,instruction}',
    'targetComponentIds',q.record#>'{request,targetComponentIds}','textPolicy',policy->'textPolicy');
   manifest:='[{"key":"propose-vector-edit","maximumCostMicrousd":0}]'::jsonb;
  else raise exception 'wrong_logo_operation' using errcode='22023';end if;
  insert into public.usage_accounts(owner_id,limit_microusd) values(owner,0) on conflict(owner_id) do nothing;
  insert into public.jobs(id,owner_id,project_id,operation,input_revision,input_hash,input,idempotency_key,reserved_cost_microusd,max_attempts,plan_manifest,plan_fingerprint,plan_registered_at)
   values(id,owner,p_project,q.operation,(p_input#>>'{expected,projectRevision}')::integer,q.record->>'inputHash',input,'logo-shared-v3:'||id,0,1,manifest,encode(sha256(convert_to(manifest::text,'UTF8')),'hex'),clock_timestamp()) returning * into j;
  insert into public.usage_reservations(job_id,owner_id,project_id,reserved_microusd) values(id,owner,p_project,0);
  receipt:=jsonb_build_object('ownerId',owner,'projectId',p_project,'requestKey',p_input->'requestKey','operation',q.operation,'batchId',null,'jobIds',jsonb_build_array(id),'inputHash',q.record->'inputHash');
  insert into public.logo_operation_requests(owner_id,project_id,request_key,quote_id,input,receipt) values(owner,p_project,(p_input->>'requestKey')::uuid,q.id,p_input,receipt);
  if q.operation='identity.logo_directions' then perform fluid_private.logo_freeze_direction_inputs(j,q.source_inputs->'direction');end if;
  perform fluid_private.admit_shared_worker_job(id,'logo',profile->>'policyIdentity',profile->>'deploymentId',policy);return receipt;
 exception when sqlstate 'PT409' then return fluid_private.reject_logo_admission(owner,p_project,p_input,'conflict');
  when sqlstate 'P0002' then return fluid_private.reject_logo_admission(owner,p_project,p_input,'not_found');
 end;
end $$;

-- Shared proposal materialization delegates only this new method. The existing
-- trusted command implementation and all historical receipts remain untouched.
create function fluid_private.shared_logo_read_proposal_command(p_project uuid,p_command jsonb) returns jsonb
language plpgsql set search_path='' as $$declare owner uuid:=fluid_private.logo_asset_web_owner(); existing public.logo_workspace_requests; cancelled public.logo_vector_edit_cancellations; p fluid_private.shared_logo_vector_proposals; begin
 if not fluid_private.shared_logo_vector_proposal_application_command_valid(p_command) then raise exception 'invalid_logo_proposal_application' using errcode='22023';end if;
 if not exists(select 1 from public.projects where projects.id=p_project and owner_id=owner) then raise exception 'logo_project_not_found' using errcode='P0002';end if;
 select * into existing from public.logo_workspace_requests where owner_id=owner and project_id=p_project and request_key=(p_command#>>'{body,requestKey}')::uuid and method<>'startLogoProject';
 if found then if existing.input is distinct from p_command then raise exception 'logo_request_conflict' using errcode='PT409';end if;return existing.receipt;end if;
 select * into cancelled from public.logo_vector_edit_cancellations where owner_id=owner and project_id=p_project and request_key=(p_command#>>'{body,requestKey}')::uuid;
 if found then if cancelled.command is distinct from p_command then raise exception 'logo_request_conflict' using errcode='PT409';end if;raise exception 'logo_edit_cancelled' using errcode='PT409';end if;
 if exists(select 1 from public.logo_operation_requests where owner_id=owner and project_id=p_project and request_key=(p_command#>>'{body,requestKey}')::uuid)
  or exists(select 1 from public.logo_operation_rejections where owner_id=owner and project_id=p_project and request_key=(p_command#>>'{body,requestKey}')::uuid) then raise exception 'logo_request_conflict' using errcode='PT409';end if;
 select * into p from fluid_private.shared_logo_vector_proposals where id=(p_command#>>'{body,proposalId}')::uuid and owner_id=owner and project_id=p_project;
 if not found then raise exception 'logo_proposal_not_found' using errcode='P0002';end if;
 if exists(select 1 from fluid_private.shared_logo_vector_proposal_materializations where proposal_id=p.id) or not fluid_private.shared_logo_vector_proposal_materializable(p) then raise exception 'logo_proposal_not_materializable' using errcode='PT409';end if;
 if p.base_vector_revision_id::text is distinct from p_command#>>'{body,baseVectorRevisionId}' or p.record->'expected' is distinct from p_command#>'{body,expected}'
  or not fluid_private.shared_logo_vector_proposal_basis_current(p) then raise exception 'logo_proposal_source_changed' using errcode='PT409';end if; return null;
end $$;
create function fluid_private.shared_logo_apply_proposal_command(p_project uuid,p_command jsonb,p_evidence jsonb) returns jsonb
language plpgsql set search_path='' as $$declare owner uuid:=fluid_private.logo_asset_web_owner(); prior jsonb; revision jsonb; result jsonb; begin
 perform pg_advisory_xact_lock(hashtextextended(owner::text,723902));
 perform 1 from public.projects where projects.id=p_project and owner_id=owner for update;if not found then raise exception 'logo_project_not_found' using errcode='P0002';end if;
 prior:=fluid_private.shared_logo_read_proposal_command(p_project,p_command);if prior is not null then return prior;end if;
 perform 1 from public.identity_reference_heads where owner_id=owner and project_id=p_project for update;
 perform 1 from public.identity_sessions where owner_id=owner and project_id=p_project for update;
 revision:=fluid_private.shared_logo_commit_vector_proposal(owner,p_project,p_command,p_evidence);
 if revision->>'ownerId' is distinct from owner::text or revision->>'projectId' is distinct from p_project::text
  or not exists(select 1 from public.logo_stage_heads where owner_id=owner and project_id=p_project and stage=revision->>'stage' and revision_id::text=revision->>'id') then raise exception 'invalid_logo_producer_stage' using errcode='55000';end if;
 result:=jsonb_build_object('ownerId',owner,'projectId',p_project,'requestKey',p_command#>'{body,requestKey}','revision',revision,'workspace',fluid_private.logo_workspace_json(owner,p_project));
 insert into public.logo_workspace_requests(project_id,owner_id,request_key,method,input,receipt) values(p_project,owner,(p_command#>>'{body,requestKey}')::uuid,'applyLogoVectorProposal',p_command,result);return result;
end $$;

-- Preserve the old subscription scope, extending only the new API directions
-- contract. Its public.policy_identity column remains subscription-only.
do $$declare expression text; begin
 select pg_get_expr(conbin,conrelid) into expression from pg_constraint where conrelid='public.jobs'::regclass and conname='logo_subscription_job_scope';
 if encode(sha256(convert_to(pg_get_constraintdef((select oid from pg_constraint where conrelid='public.jobs'::regclass and conname='logo_subscription_job_scope')),'UTF8')),'hex')<>'47794cdabebc93fb3534a82ea7c3feb493cb074cf9bf93119d678837fe28eb8a' then raise exception 'shared_logo_job_scope_predecessor_mismatch' using errcode='55000';end if;
 alter table public.jobs drop constraint logo_subscription_job_scope;
 execute 'alter table public.jobs add constraint logo_subscription_job_scope check(('||expression||') or (operation=''identity.logo_directions'' and billing_mode=''openai_api'' and input->''version''=''3''::jsonb and input->>''spendControl''=''uncapped'' and fluid_private.shared_logo_text_policy_valid(input->''apiPolicy'',''directions'')))';
end $$;
alter table public.logo_workspace_requests drop constraint logo_workspace_requests_method_check;
alter table public.logo_workspace_requests add constraint logo_workspace_requests_method_check check(method in('startLogoProject','saveLogoBrief','saveLogoReferences','restoreLogoStage','selectLogoConcept','selectLogoRaster','saveLogoEdit','acceptLogoVector','selectIdentityDirectionComponents','approveIdentityDirection','prepareLogoVariants','reviewLogoVariants','applyLogoVectorProposal'));
alter table public.logo_vector_edit_cancellations drop constraint logo_vector_edit_cancellations_check;
alter table public.logo_vector_edit_cancellations add constraint logo_vector_edit_cancellations_check check(command->>'method' in('saveLogoEdit','applyLogoVectorProposal') and command#>>'{body,requestKey}'=request_key::text and octet_length(command::text)<=32768);
-- A versioned wrapper recognizes the new method while preserving every old
-- validator/receipt statement and OID. No caller may choose ownership here.
do $$declare definition text; begin
 definition:=pg_get_functiondef('fluid_private.logo_vector_edit_cancel_command_valid(jsonb)'::regprocedure);
 execute replace(definition,'fluid_private.logo_vector_edit_cancel_command_valid(','fluid_private.shared_logo_legacy_cancel_command_valid(');
 definition:=pg_get_functiondef('fluid_private.logo_vector_edit_request_state(uuid,uuid,uuid)'::regprocedure);
 execute replace(definition,'fluid_private.logo_vector_edit_request_state(','fluid_private.shared_logo_legacy_edit_request_state(');
end $$;
create or replace function fluid_private.logo_vector_edit_cancel_command_valid(v jsonb) returns boolean
language plpgsql immutable set search_path='' as $$begin
 if v->>'method'='applyLogoVectorProposal' then return fluid_private.shared_logo_vector_proposal_application_command_valid(v);end if;
 return fluid_private.shared_logo_legacy_cancel_command_valid(v);
end $$;
create or replace function fluid_private.logo_vector_edit_request_state(p_owner uuid,p_project uuid,p_key uuid) returns jsonb
language plpgsql stable set search_path='' as $$declare prior public.logo_workspace_requests;begin
 select * into prior from public.logo_workspace_requests where owner_id=p_owner and project_id=p_project and request_key=p_key and method='applyLogoVectorProposal';
 if found then return jsonb_build_object('status','succeeded','ownerId',p_owner,'projectId',p_project,'requestKey',p_key,'command',prior.input,'receipt',prior.receipt);end if;
 return fluid_private.shared_logo_legacy_edit_request_state(p_owner,p_project,p_key);
end $$;

-- Observation-only resolution of a committed complete export group whose stage
-- acknowledgement was lost. No lease/context is revived and no artifact is
-- generated. The immutable ambiguity and exact readback set remain audit facts.
create table fluid_private.shared_logo_export_resolutions (
 execution_id uuid primary key references fluid_private.shared_worker_executions(execution_id),
 job_id uuid not null unique references public.jobs(id), step_id uuid not null unique references public.job_steps(id),
 publication_id uuid not null unique references public.logo_export_publications(id),
 original_job jsonb not null,original_step jsonb not null,original_group jsonb not null,
 readbacks jsonb not null,group_hash text not null,readbacks_hash text not null,receipt jsonb not null,
 resolved_at timestamptz not null default clock_timestamp(),
 check(group_hash ~ '^[a-f0-9]{64}$' and readbacks_hash ~ '^[a-f0-9]{64}$')
);
create trigger shared_logo_export_resolution_immutable before update or delete on fluid_private.shared_logo_export_resolutions
 for each row execute function fluid_private.shared_job_admission_immutable();

create function fluid_private.shared_logo_resolve_prepared_export() returns jsonb
language plpgsql volatile set search_path='' as $$
declare e fluid_private.shared_worker_executions;j public.jobs;validation_job public.jobs;s public.job_steps;
 p public.logo_export_publications;reservation public.usage_reservations;r public.logo_asset_publications;
 project_json jsonb;admission fluid_private.shared_job_admissions;group_input jsonb;issued uuid[];observations jsonb;
 original_job jsonb;original_step jsonb;original_group jsonb;source jsonb;file jsonb;files jsonb:='[]';outputs jsonb:='[]';
 receipt jsonb;manifest jsonb;omissions jsonb;resolution jsonb;existing fluid_private.shared_logo_export_resolutions;
 n integer;i integer:=0;prior_timeout text;
begin
 if fluid_private.shared_worker_context_mode('logo') is distinct from 'observe' then return null;end if;
 e:=fluid_private.shared_worker_context_execution('logo');
 if e.execution_id is null or e.operation<>'identity.logo_export' then return null;end if;
 -- Core already holds slot/execution/job UPDATE locks. Every additional lock is
 -- NOWAIT: project-edit/delete obtains project before job, so waiting here would
 -- invert that ordering. Any contention aborts this subtransaction harmlessly.
 select * into j from public.jobs where id=e.job_id;
 perform 1 from auth.users where id=e.owner_id for share nowait;
 if not found then return null;end if;
 perform 1 from fluid_private.shared_accounts where owner_id=e.owner_id for share nowait;
 if not found then return null;end if;
 select to_jsonb(project) into project_json from public.projects project where id=e.project_id and owner_id=e.owner_id for update nowait;
 if not found or not fluid_private.shared_account_customer_active(e.owner_id)
  or project_json->>'deleted_at' is not null or project_json->>'deletion_requested_at' is not null
  or j.cancel_requested_at is not null or to_jsonb(j)->>'project_deletion_requested_at' is not null then return null;end if;
 select * into existing from fluid_private.shared_logo_export_resolutions where execution_id=e.execution_id;
 if found then
  if j.state='succeeded' and j.lease_token is null and existing.job_id=j.id
   and exists(select 1 from public.job_steps where id=existing.step_id and job_id=j.id and state='succeeded' and output=existing.receipt->'output')
   and exists(select 1 from public.logo_export_publications where id=existing.publication_id and job_id=j.id and committed_at is not null and manifest_id=id)
   and exists(select 1 from public.logo_export_manifests where id=existing.publication_id and job_id=j.id)
   then return existing.receipt;end if;
  return null;
 end if;
 select * into admission from fluid_private.shared_job_admissions where job_id=j.id;
 if (j.owner_id,j.project_id,j.operation,j.input_hash) is distinct from(e.owner_id,e.project_id,e.operation,admission.input_hash)
  or (admission.policy_identity,admission.deployment_id,admission.lane) is distinct from(e.policy_identity,e.deployment_id,'logo'::text)
  or not fluid_private.shared_logo_policy_valid('identity.logo_export',admission.policy)
  or j.state<>'needs_reconciliation' or j.lease_token is not null or j.lease_expires_at is not null
  or j.reserved_cost_microusd<>0 or j.actual_cost_microusd<>0 or j.billing_mode<>'openai_api'
  or j.error_code is distinct from 'export_publication_unknown'
  or j.plan_registered_at is null or j.plan_manifest is distinct from jsonb_build_array(jsonb_build_object('key','prepare-export','maximumCostMicrousd',0))
  or (select count(*) from public.job_steps where job_id=j.id)<>1
  or exists(select 1 from public.logo_provider_responses where job_id=j.id) then return null;end if;
 select * into s from public.job_steps where job_id=j.id for update nowait;
 if (s.owner_id,s.project_id,s.step_key,s.state,s.reserved_cost_microusd,s.actual_cost_microusd)
   is distinct from(e.owner_id,e.project_id,'prepare-export'::text,'ambiguous'::text,0::bigint,0::bigint)
  or s.provider_request_id is not null or s.request_key is null or s.completed_at is null
  or s.output is distinct from '{"error":"export_publication_unknown"}'::jsonb then return null;end if;
 select * into p from public.logo_export_publications where job_id=j.id for update nowait;
 if not found or (p.owner_id,p.project_id,p.lease_token) is distinct from(e.owner_id,e.project_id,e.lease_token)
  or p.completeness<>'complete' or p.failure is not null or p.committed_at is not null or p.manifest_id is not null or p.stage_revision is not null then return null;end if;
 select array_agg(distinct g.reservation_id order by g.reservation_id) into issued from fluid_private.shared_storage_grants g
  where g.execution_id=e.execution_id and g.mode='write' and g.binding->'execution'=fluid_private.shared_worker_execution_json(e);
 if issued is distinct from(select array_agg(id order by id) from unnest(p.asset_receipt_ids) id)
  or cardinality(p.asset_receipt_ids)<>(select count(distinct id) from unnest(p.asset_receipt_ids) id) then return null;end if;
 select * into reservation from public.usage_reservations where job_id=j.id for update nowait;
 if not found or (reservation.owner_id,reservation.project_id,reservation.reserved_microusd,reservation.actual_microusd,reservation.captured_microusd,reservation.state)
   is distinct from(e.owner_id,e.project_id,0::bigint,0::bigint,0::bigint,'active'::text) then return null;end if;
 perform 1 from public.usage_accounts where owner_id=e.owner_id for update nowait;if not found then return null;end if;
 -- Freeze all member rows before validating the group. Immutable observations
 -- are durable actual readback witnesses, not claims that Storage POST succeeded.
 perform 1 from public.logo_asset_publications where id=any(issued) order by id for update nowait;
 validation_job:=j;validation_job.lease_token:=e.lease_token;
 group_input:=jsonb_build_object('sourceSnapshotHash',p.source_snapshot_hash,'completeness',p.completeness,'failure',p.failure,'files',p.files,'assetReceiptIds',to_jsonb(p.asset_receipt_ids));
 if not fluid_private.logo_export_group_valid(validation_job,group_input) then return null;end if;
 for r in select * from public.logo_asset_publications where id=any(issued) order by id loop
  if (r.owner_id,r.project_id,r.job_id,r.lease_token,r.state,r.input_hash)
    is distinct from(e.owner_id,e.project_id,e.job_id,e.lease_token,'staged'::text,j.input_hash)
   or r.verification is null or fluid_private.logo_production_storage_member(validation_job,r,'write') is null
   or not exists(select 1 from fluid_private.shared_logo_output_observations o where o.execution_id=e.execution_id and o.reservation_id=r.id
    and o.verification->>'status'='verified' and o.verification->>'contentHash'=r.content_hash
    and o.verification->>'mimeType'=r.mime_type and o.verification->'byteLength'=to_jsonb(r.byte_length)
    and o.verification-array['checkedAt'] is not distinct from r.verification-array['checkedAt']) then return null;end if;
  perform 1 from public.assets where id=r.asset_id for update nowait;if found then return null;end if;
  perform 1 from public.asset_versions where id=r.version_id for update nowait;if found then return null;end if;
 end loop;
 select jsonb_agg(jsonb_build_object('reservationId',o.reservation_id,'verification',o.verification) order by o.reservation_id)
 into observations from fluid_private.shared_logo_output_observations o where o.execution_id=e.execution_id and o.reservation_id=any(issued);
 original_job:=to_jsonb(j);original_step:=to_jsonb(s);original_group:=to_jsonb(p);
 source:=(select input.source from public.logo_export_inputs input where input.job_id=j.id);
 resolution:=jsonb_build_object('version',1,'executionId',e.execution_id,'jobId',j.id,'stepId',s.id,'publicationId',p.id,'state','succeeded','output',jsonb_build_object('version',2,'kind','logo_export','publicationId',p.id));
 -- No blocking legacy commit/lease helper is called. The bounded timeout is a
 -- last fence against unique/FK lock races during inserts; 55P03 rolls back ALL
 -- writes, including the witness, and returns retained_unknown.
 prior_timeout:=current_setting('lock_timeout');perform set_config('lock_timeout','1ms',true);
 insert into fluid_private.shared_logo_export_resolutions(execution_id,job_id,step_id,publication_id,original_job,original_step,original_group,readbacks,group_hash,readbacks_hash,receipt)
 values(e.execution_id,j.id,s.id,p.id,original_job,original_step,original_group,observations,
  encode(sha256(convert_to(original_group::text,'UTF8')),'hex'),encode(sha256(convert_to(observations::text,'UTF8')),'hex'),resolution);
 for file in select value from jsonb_array_elements(p.files) loop
  i:=i+1;select * into strict r from public.logo_asset_publications where id=p.asset_receipt_ids[i];
  receipt:=fluid_private.logo_commit_asset(r);outputs:=outputs||jsonb_build_array(receipt);
  files:=files||jsonb_build_array(jsonb_build_object('role',file->'role','format',case file->>'mimeType' when 'image/svg+xml' then 'svg' when 'application/pdf' then 'pdf' when 'image/png' then 'png' when 'application/zip' then 'zip' end,'variantId',file->'sourceVariantId','asset',receipt));
 end loop;
 select coalesce(jsonb_agg(jsonb_build_object('fontVersionId',f->'id','reason','Font binaries are not included. Consult the exact font license and source; permitted PDF specimens do not grant redistribution rights.') order by ordinality),'[]') into omissions from jsonb_array_elements(source->'fonts') with ordinality f(f,ordinality);
 manifest:=jsonb_build_object('id',p.id,'ownerId',j.owner_id,'projectId',j.project_id,'requestKey',j.input->'requestKey','approvedLogoId',source#>'{logoApproval,id}','directionApprovalId',source#>'{directionApproval,id}','variantSetId',source#>'{variants,id}','variantReviewId',source#>'{variantReview,id}','sourceSnapshotHash',p.source_snapshot_hash,'files',files,'licenseOmissions',omissions,'inputRevisions',source->'inputRevisions','createdAt',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
 insert into public.logo_export_manifests(id,owner_id,project_id,publication_id,job_id,record) values(p.id,j.owner_id,j.project_id,p.id,j.id,manifest);
 -- Historical recovery records the exact original publication; it never adopts
 -- current heads, current provider policy or a replacement operation.
 update public.logo_export_publications target set committed_at=clock_timestamp(),manifest_id=p.id where target.id=p.id and to_jsonb(target)=original_group;
 get diagnostics n=row_count;if n<>1 then raise exception 'shared_logo_export_resolution_conflict' using errcode='55000';end if;
 update public.job_steps target set state='succeeded',output=resolution->'output',completed_at=clock_timestamp()
  where target.id=s.id and to_jsonb(target)=original_step;
 get diagnostics n=row_count;if n<>1 then raise exception 'shared_logo_export_resolution_conflict' using errcode='55000';end if;
 update public.usage_reservations set state='settled' where job_id=j.id and state='active' and reserved_microusd=0 and actual_microusd=0 and captured_microusd=0;
 get diagnostics n=row_count;if n<>1 then raise exception 'shared_logo_export_resolution_conflict' using errcode='55000';end if;
 update public.jobs target set state='succeeded',error_code=null,progress=100,finished_at=clock_timestamp()
  where target.id=j.id and to_jsonb(target)=original_job;
 get diagnostics n=row_count;if n<>1 then raise exception 'shared_logo_export_resolution_conflict' using errcode='55000';end if;
 perform set_config('lock_timeout',prior_timeout,true);
 return resolution;
exception when lock_not_available then return null;
end $$;


-- Exact original paid-intent recovery. Reads never infer absence from history
-- pagination. Only an atomic close and durable existing rejection fence can
-- certify that replay of that same original intent will never dispatch work.
create table fluid_private.shared_logo_proposal_request_closures (
 owner_id uuid not null,project_id uuid not null,request_key uuid not null,quote_id uuid not null,
 input jsonb not null,receipt jsonb not null,created_at timestamptz not null default clock_timestamp(),
 primary key(owner_id,project_id,request_key),
 foreign key(project_id,owner_id) references public.projects(id,owner_id),
 foreign key(quote_id,owner_id,project_id) references public.logo_cost_quotes(id,owner_id,project_id),
 check(input->>'requestKey'=request_key::text and input->>'quoteId'=quote_id::text and octet_length(input::text)<=32768)
);
create trigger shared_logo_proposal_request_closure_immutable before update or delete on fluid_private.shared_logo_proposal_request_closures
 for each row execute function fluid_private.shared_job_admission_immutable();

create function fluid_private.shared_logo_proposal_request_owner(p_project uuid,p_lock boolean) returns uuid
language plpgsql volatile set search_path='' as $$
declare owner uuid:=auth.uid();claims jsonb:=auth.jwt();sid uuid;
begin
 if session_user<>'authenticator' or current_setting('role')<>'authenticated' or owner is null
  or claims->>'sub' is distinct from owner::text or claims->>'role' is distinct from 'authenticated'
  or claims->>'aud' is distinct from 'authenticated' or claims->>'is_anonymous' is distinct from 'false'
  or not exists(select 1 from fluid_private.shared_http_target where claims->>'iss'=origin||'/auth/v1')
  or jsonb_typeof(claims->'exp') is distinct from 'number' or (claims->>'exp')::numeric<=extract(epoch from clock_timestamp())
  or not fluid_private.logo_uuid(claims->'session_id')
 then raise exception 'shared_logo_proposal_verified_session_required' using errcode='42501';end if;
 sid:=(claims->>'session_id')::uuid;
 if p_lock then
  perform 1 from auth.users where id=owner for share;
  perform 1 from auth.sessions where id=sid and user_id=owner for share;
  perform 1 from fluid_private.shared_accounts where owner_id=owner for share;
 end if;
 if not fluid_private.shared_account_customer_active(owner)
  or not exists(select 1 from auth.sessions where id=sid and user_id=owner and(not_after is null or not_after>clock_timestamp()))
 then raise exception 'shared_logo_proposal_account_unavailable' using errcode='42501';end if;
 if not exists(select 1 from public.projects where id=p_project and owner_id=owner) then raise exception 'logo_project_not_found' using errcode='P0002';end if;
 return owner;
end $$;

create function fluid_private.shared_logo_proposal_request_quote(p_owner uuid,p_project uuid,p_input jsonb) returns public.logo_cost_quotes
language plpgsql stable set search_path='' as $$declare q public.logo_cost_quotes;amount numeric;
begin
 if jsonb_typeof(p_input) is distinct from 'object' or octet_length(p_input::text)>32768
  or not fluid_private.logo_uuid(p_input->'requestKey') or not fluid_private.logo_uuid(p_input->'quoteId')
 then raise exception 'invalid_logo_proposal_intent' using errcode='22023';end if;
 select * into q from public.logo_cost_quotes where id=(p_input->>'quoteId')::uuid and owner_id=p_owner and project_id=p_project;
 if not found then raise exception 'logo_quote_not_found' using errcode='P0002';end if;
 if q.operation is distinct from 'identity.logo_vector_propose' or q.record#>>'{request,operation}' is distinct from 'propose_vector_edit'
  or q.record->>'ownerId' is distinct from p_owner::text or q.record->>'projectId' is distinct from p_project::text
  or q.record->>'id' is distinct from q.id::text or p_input->'expected' is distinct from q.record->'expected'
 then raise exception 'logo_proposal_intent_conflict' using errcode='PT409';end if;
 if q.record->'version'='3'::jsonb then
  if not fluid_private.standalone_keys(p_input,array['requestKey','quoteId','expected'])
   or q.record->>'billingMode' is distinct from 'openai_api' or q.record->>'spendControl' is distinct from 'uncapped'
   or not fluid_private.shared_logo_vector_proposal_quote_binding(q)
  then raise exception 'logo_proposal_intent_conflict' using errcode='PT409';end if;
 else
  -- Historical bounded bodies are checked and echoed exactly; they are never
  -- rewritten to the future uncapped contract or silently assigned zero cost.
  if q.record?'version' or q.record?'spendControl' or q.record?'billingMode'
   or q.record#>'{textPolicy,version}' is distinct from '1'::jsonb
   or q.record#>'{textPolicy,maximumCostMicrousd}' is distinct from q.record->'maxCostMicrousd'
   or not fluid_private.standalone_keys(p_input,array['requestKey','quoteId','expected','acceptedMaxCostMicrousd'])
   or jsonb_typeof(p_input->'acceptedMaxCostMicrousd') is distinct from 'number'
   or jsonb_typeof(q.record->'maxCostMicrousd') is distinct from 'number'
  then raise exception 'logo_proposal_intent_conflict' using errcode='PT409';end if;
  amount:=(p_input->>'acceptedMaxCostMicrousd')::numeric;
  if amount<>trunc(amount) or amount not between 0 and 9007199254740991 or amount<(q.record->>'maxCostMicrousd')::numeric
  then raise exception 'logo_proposal_intent_conflict' using errcode='PT409';end if;
 end if;
 return q;
end $$;

create function fluid_private.shared_logo_read_proposal_request(p_owner uuid,p_project uuid,p_input jsonb,q public.logo_cost_quotes) returns jsonb
language plpgsql stable set search_path='' as $$
declare r public.logo_operation_requests;rejected public.logo_operation_rejections;j public.jobs;p fluid_private.shared_logo_vector_proposals;state jsonb;
begin
 select * into r from public.logo_operation_requests where owner_id=p_owner and project_id=p_project and request_key=(p_input->>'requestKey')::uuid;
 if not found then
  select * into rejected from public.logo_operation_rejections where owner_id=p_owner and project_id=p_project and request_key=(p_input->>'requestKey')::uuid;
  if not found then raise exception 'logo_proposal_request_not_found' using errcode='P0002';end if;
  if rejected.input is distinct from p_input or rejected.receipt->>'kind' is distinct from 'logo_admission_rejected'
   or rejected.receipt#>>'{rejection,status}' is distinct from 'rejected' or rejected.receipt#>>'{rejection,ownerId}' is distinct from p_owner::text
   or rejected.receipt#>>'{rejection,projectId}' is distinct from p_project::text
   or rejected.receipt#>'{rejection,requestKey}' is distinct from p_input->'requestKey' or rejected.receipt#>'{rejection,quoteId}' is distinct from p_input->'quoteId'
  then raise exception 'logo_proposal_request_conflict' using errcode='PT409';end if;
  state:=public.read_logo_request(p_project,(p_input->>'requestKey')::uuid);
  return jsonb_build_object('ownerId',p_owner,'projectId',p_project,'input',p_input,'state',state,'proposal',null);
 end if;
 if r.input is distinct from p_input or r.quote_id is distinct from q.id
  or r.receipt->>'operation' is distinct from 'identity.logo_vector_propose' or r.receipt->>'ownerId' is distinct from p_owner::text
  or r.receipt->>'projectId' is distinct from p_project::text or r.receipt->'requestKey' is distinct from p_input->'requestKey'
  or r.receipt->'inputHash' is distinct from q.record->'inputHash' or r.receipt->'batchId' is distinct from 'null'::jsonb
  or jsonb_typeof(r.receipt->'jobIds') is distinct from 'array' or jsonb_array_length(r.receipt->'jobIds')<>1
  or not fluid_private.logo_uuid(r.receipt#>'{jobIds,0}')
 then raise exception 'logo_proposal_request_conflict' using errcode='PT409';end if;
 select * into j from public.jobs where id=(r.receipt#>>'{jobIds,0}')::uuid and owner_id=p_owner and project_id=p_project;
 if not found or j.operation is distinct from 'identity.logo_vector_propose' or j.input->'requestKey' is distinct from p_input->'requestKey'
  or j.input->'quoteId' is distinct from p_input->'quoteId' or j.input_hash is distinct from q.record->>'inputHash'
  or j.input->'baseVectorRevisionId' is distinct from q.record#>'{request,baseVectorRevisionId}'
  or j.input->'contextHash' is distinct from q.source_inputs->'contextHash'
  or j.input->'instruction' is distinct from q.record#>'{request,instruction}' or j.input->'targetComponentIds' is distinct from q.record#>'{request,targetComponentIds}'
  or q.record->'version'='3'::jsonb and not fluid_private.shared_logo_vector_proposal_job_quote_matches(j,q)
 then raise exception 'logo_proposal_job_binding_invalid' using errcode='55000';end if;
 select * into p from fluid_private.shared_logo_vector_proposals where job_id=j.id;
 if found and ((p.owner_id,p.project_id,p.request_key,p.quote_id,p.base_vector_revision_id)
    is distinct from(p_owner,p_project,(p_input->>'requestKey')::uuid,q.id,(q.record#>>'{request,baseVectorRevisionId}')::uuid)
  or p.record->>'id' is distinct from p.id::text or p.record->>'ownerId' is distinct from p_owner::text or p.record->>'projectId' is distinct from p_project::text
  or p.record->>'jobId' is distinct from j.id::text or p.record->'requestKey' is distinct from p_input->'requestKey' or p.record->>'quoteId' is distinct from q.id::text
  or p.record->'baseVectorRevisionId' is distinct from q.record#>'{request,baseVectorRevisionId}'
  or p.record->'contextHash' is distinct from q.source_inputs->'contextHash' or p.record->'context' is distinct from q.source_inputs->'context'
  or p.record->'expected' is distinct from q.record->'expected' or p.record->'inputRevisions' is distinct from q.input_revisions)
 then raise exception 'logo_proposal_record_binding_invalid' using errcode='55000';end if;
 state:=public.read_logo_request(p_project,(p_input->>'requestKey')::uuid);
 if state->'receipt' is distinct from r.receipt then raise exception 'logo_proposal_request_state_invalid' using errcode='55000';end if;
 return jsonb_build_object('ownerId',p_owner,'projectId',p_project,'input',p_input,'state',state,'proposal',case when p.id is null then null else p.record end);
end $$;

create function public.read_logo_vector_proposal_request(p_project_id uuid,p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path='' as $$declare owner uuid;q public.logo_cost_quotes;
begin
 owner:=fluid_private.shared_logo_proposal_request_owner(p_project_id,false);
 q:=fluid_private.shared_logo_proposal_request_quote(owner,p_project_id,p_input);
 return fluid_private.shared_logo_read_proposal_request(owner,p_project_id,p_input,q);
end $$;

create function public.close_logo_vector_proposal_request(p_project_id uuid,p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare owner uuid;q public.logo_cost_quotes;r public.logo_operation_requests;rejected public.logo_operation_rejections;
 closure fluid_private.shared_logo_proposal_request_closures;j public.jobs;result jsonb;request jsonb;
begin
 owner:=fluid_private.shared_logo_proposal_request_owner(p_project_id,true);
 -- Same serialization namespace/order as both original admission branches.
 perform pg_advisory_xact_lock(hashtextextended(owner::text,723902));
 perform 1 from public.projects where id=p_project_id and owner_id=owner for update;
 if not found then raise exception 'logo_project_not_found' using errcode='P0002';end if;
 q:=fluid_private.shared_logo_proposal_request_quote(owner,p_project_id,p_input);
 select * into closure from fluid_private.shared_logo_proposal_request_closures where owner_id=owner and project_id=p_project_id and request_key=(p_input->>'requestKey')::uuid;
 if found then
  if closure.input is distinct from p_input then raise exception 'logo_proposal_request_conflict' using errcode='PT409';end if;
  return closure.receipt;
 end if;
 select * into r from public.logo_operation_requests where owner_id=owner and project_id=p_project_id and request_key=(p_input->>'requestKey')::uuid;
 if found then
  request:=fluid_private.shared_logo_read_proposal_request(owner,p_project_id,p_input,q);
  -- A worker may already hold job then request project. Never block behind that
  -- inverted order: a contended Stop retains the original intent for retry.
  select * into strict j from public.jobs where id=(r.receipt#>>'{jobIds,0}')::uuid for update nowait;
  if j.state='queued' and j.billing_mode='openai_api' then
   perform 1 from public.usage_reservations where job_id=j.id for update nowait;
   perform 1 from public.usage_accounts where owner_id=owner for update nowait;
  end if;
  perform public.request_job_cancel(j.id);
  return jsonb_build_object('status','admitted','request',fluid_private.shared_logo_read_proposal_request(owner,p_project_id,p_input,q));
 end if;
 if exists(select 1 from public.logo_workspace_requests where owner_id=owner and project_id=p_project_id and request_key=(p_input->>'requestKey')::uuid)
  or exists(select 1 from public.logo_vector_edit_cancellations where owner_id=owner and project_id=p_project_id and request_key=(p_input->>'requestKey')::uuid)
 then raise exception 'logo_request_conflict' using errcode='PT409';end if;
 select * into rejected from public.logo_operation_rejections where owner_id=owner and project_id=p_project_id and request_key=(p_input->>'requestKey')::uuid;
 if found then
  perform fluid_private.shared_logo_read_proposal_request(owner,p_project_id,p_input,q);
 else
  perform fluid_private.reject_logo_admission(owner,p_project_id,p_input,'conflict');
 end if;
 result:=jsonb_build_object('status','not_admitted','ownerId',owner,'projectId',p_project_id,'input',p_input);
 insert into fluid_private.shared_logo_proposal_request_closures(owner_id,project_id,request_key,quote_id,input,receipt)
 values(owner,p_project_id,(p_input->>'requestKey')::uuid,q.id,p_input,result);
 return result;
end $$;

-- Cold reload discovery starts from indexed pending jobs/unresolved steps, not
-- a scan of finished proposal history. More than one queued intent is valid.
create index shared_logo_proposal_pending_jobs on public.jobs(owner_id,project_id,id)
 where operation='identity.logo_vector_propose' and state in('queued','running','cancel_requested','needs_reconciliation');
create index shared_logo_proposal_unresolved_steps on public.job_steps(owner_id,project_id,job_id)
 where state in('in_flight','ambiguous');
create function public.list_pending_logo_vector_proposal_requests(p_project_id uuid,p_cursor uuid default null,p_limit integer default 10) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare owner uuid;anchor public.logo_operation_requests;r public.logo_operation_requests;q public.logo_cost_quotes;
 items jsonb:='[]';seen integer:=0;last_key uuid;has_more boolean:=false;candidate record;
begin
 owner:=fluid_private.shared_logo_proposal_request_owner(p_project_id,false);
 if p_limit is null or p_limit not between 1 and 10 then raise exception 'invalid_logo_proposal_request_page' using errcode='22023';end if;
 if p_cursor is not null then
  select request.* into anchor from public.logo_operation_requests request
   join public.logo_cost_quotes quote on (quote.id,quote.owner_id,quote.project_id)=(request.quote_id,request.owner_id,request.project_id)
   where request.owner_id=owner and request.project_id=p_project_id and request.request_key=p_cursor
    and quote.operation='identity.logo_vector_propose' and request.receipt->>'operation'='identity.logo_vector_propose';
  if not found then raise exception 'logo_proposal_request_cursor_not_found' using errcode='P0002';end if;
 end if;
 for candidate in
  with pending as (
   select j.id,j.input->>'requestKey' request_key from public.jobs j
    where j.owner_id=owner and j.project_id=p_project_id and j.operation='identity.logo_vector_propose'
     and j.state in('queued','running','cancel_requested','needs_reconciliation')
   union
   select j.id,j.input->>'requestKey' request_key from public.job_steps step join public.jobs j on (j.id,j.owner_id,j.project_id)=(step.job_id,step.owner_id,step.project_id)
    where step.owner_id=owner and step.project_id=p_project_id and step.state in('in_flight','ambiguous') and j.operation='identity.logo_vector_propose'
  )
  select request request_row,pending.id pending_job_id from pending left join public.logo_operation_requests request
   on (request.owner_id,request.project_id,request.request_key)=(owner,p_project_id,pending.request_key::uuid)
   where p_cursor is null or request.request_key is null or (request.created_at,request.request_key)<(anchor.created_at,anchor.request_key)
   order by request.created_at desc,request.request_key desc limit p_limit+1
 loop
  seen:=seen+1;if seen>p_limit then has_more:=true;exit;end if;
  r:=candidate.request_row;
  if r.request_key is null or r.receipt->'jobIds' is distinct from jsonb_build_array(candidate.pending_job_id)
   or r.receipt->>'operation' is distinct from 'identity.logo_vector_propose'
  then raise exception 'logo_proposal_pending_binding_invalid' using errcode='55000';end if;
  q:=fluid_private.shared_logo_proposal_request_quote(owner,p_project_id,r.input);
  items:=items||jsonb_build_array(fluid_private.shared_logo_read_proposal_request(owner,p_project_id,r.input,q));
  last_key:=r.request_key;
 end loop;
 return jsonb_build_object('ownerId',owner,'projectId',p_project_id,'items',items,'nextCursor',case when has_more then last_key else null end);
end $$;

-- New exact shared objects receive no ambient/default grants. Existing public
-- helpers, owners, OIDs, ACLs and all nonshared operation branches stay intact.
do $$declare object record; recipient record; begin
 for object in select c.oid,c.oid::regclass signature from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='fluid_private' and c.relkind in('r','p') and c.relname like 'shared_logo_%'
   and not exists(select 1 from shared_logo_advanced_previous_objects old where old.classid='pg_class'::regclass::oid and old.oid=c.oid) loop
  execute format('alter table %s enable row level security',object.signature); execute format('alter table %s force row level security',object.signature);
  for recipient in select distinct a.grantee from pg_class c,lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a where c.oid=object.oid and a.grantee<>c.relowner loop
   execute format('revoke all on table %s from %s cascade',object.signature,case when recipient.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(recipient.grantee)) end);
  end loop;
 end loop;
 for object in select p.oid,p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where (n.nspname='fluid_private' and p.proname like 'shared_logo_%'
   or n.nspname='public' and p.proname in('read_logo_vector_proposal','list_logo_vector_proposals','read_logo_vector_proposal_application','read_logo_vector_proposal_request','close_logo_vector_proposal_request','list_pending_logo_vector_proposal_requests'))
   and not exists(select 1 from shared_logo_advanced_previous_objects old where old.classid='pg_proc'::regclass::oid and old.oid=p.oid) loop
  for recipient in select distinct a.grantee from pg_proc p,lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where p.oid=object.oid and a.grantee<>p.proowner loop
   execute format('revoke all on function %s from %s cascade',object.signature,case when recipient.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(recipient.grantee)) end);
  end loop;
 end loop;
end $$;
grant execute on function public.list_pending_logo_vector_proposal_requests(uuid,uuid,integer) to authenticated;
grant execute on function public.read_logo_vector_proposal_request(uuid,jsonb),public.close_logo_vector_proposal_request(uuid,jsonb) to authenticated;
grant execute on function public.read_logo_vector_proposal(uuid,uuid),public.list_logo_vector_proposals(uuid,jsonb),public.read_logo_vector_proposal_application(uuid,uuid) to authenticated;
commit;
