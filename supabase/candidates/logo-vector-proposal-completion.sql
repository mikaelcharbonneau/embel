-- UNAPPLIED TASK 2 RESULT-RETENTION CANDIDATE. No activation or asset capability.
begin;
-- New private result-retention functions only. No grants or provider/host activation.
create function fluid_private.logo_vector_proposal_payload_shape_valid(v jsonb,c jsonb) returns boolean
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

-- Provisional metadata parity with the accepted core: no changes, raw equivalent
-- rotation rewrites, saved ordering and known painted-bound overlap are denied.
-- This does not prove exact future glyph geometry or candidate applicability.
create function fluid_private.logo_vector_proposal_payload_valid(v jsonb,c jsonb) returns boolean
language plpgsql immutable set search_path='' as $$
declare e jsonb:=v->'edit';component jsonb;item jsonb;protected jsonb;t jsonb;before_bounds jsonb;after_bounds jsonb;local_bounds jsonb;
 changed text[]:=array[]::text[];transforms jsonb:='{}';ordering jsonb;id text;ord bigint;same boolean;
 angle double precision;cosine double precision;sine double precision;minx double precision;miny double precision;maxx double precision;maxy double precision;
begin
 if fluid_private.logo_vector_proposal_payload_shape_valid(v,c) is distinct from true then return false;end if;
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

create function fluid_private.logo_vector_proposal_result_valid(v jsonb,c jsonb,o jsonb) returns boolean
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
  return payload=v->'payload' and fluid_private.logo_vector_proposal_payload_valid(payload,c);
 end if;
 return v->>'status' in('invalid','incomplete','refused') and v->'payload'='null'::jsonb and v->>'reason' in('provider_refusal','invalid_output','output_too_large','incomplete_output','provider_outcome_unknown','model_mismatch','service_tier_mismatch','unexpected_tools');
exception when others then return false;
end $$;

create table fluid_private.logo_vector_proposal_prepared_results(
 id uuid primary key default gen_random_uuid(),owner_id uuid not null,project_id uuid not null,job_id uuid not null unique,lease_token uuid not null,
 quote_id uuid not null,input_hash text not null check(input_hash~'^[0-9a-f]{64}$'),context_hash text not null check(context_hash~'^[0-9a-f]{64}$'),
 provider_receipt_id uuid not null references public.logo_provider_responses(id),result jsonb not null check(octet_length(result::text)<=98304),created_at timestamptz not null default clock_timestamp(),
 unique(id,owner_id,project_id),foreign key(job_id,owner_id,project_id) references public.jobs(id,owner_id,project_id),foreign key(quote_id,owner_id,project_id) references public.logo_cost_quotes(id,owner_id,project_id)
);
alter table fluid_private.logo_vector_proposal_prepared_results enable row level security;
alter table fluid_private.logo_vector_proposal_prepared_results force row level security;
create trigger logo_vector_proposal_prepared_results_immutable before update or delete on fluid_private.logo_vector_proposal_prepared_results for each row execute function fluid_private.prevent_history_change();

create function fluid_private.logo_vector_proposal_pending_reason(j public.jobs,o jsonb,result jsonb) returns text
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
 if(o#>>'{usage,inputTokens}')::numeric>(j.input#>>'{textPolicy,maxInputTokens}')::numeric or(o#>>'{usage,outputTokens}')::numeric>(j.input#>>'{textPolicy,maxOutputTokens}')::numeric or cost>j.reserved_cost_microusd then return 'provider_usage_exceeded';end if;
 if result->>'status'='incomplete' then return 'provider_output_incomplete';end if;
 if j.state='needs_reconciliation' then return coalesce(j.error_code,'provider_outcome_unknown');end if;
 if j.lease_token is null or j.lease_expires_at is null or j.lease_expires_at<=clock_timestamp() then return 'provider_response_after_lease';end if;
 return null;
end $$;

create function fluid_private.retain_logo_vector_proposal(j public.jobs,p fluid_private.logo_vector_proposal_prepared_results,p_state text,p_reason text) returns jsonb
language plpgsql set search_path='' as $$
declare q public.logo_cost_quotes;r public.logo_provider_responses;a fluid_private.logo_vector_proposal_dispatches;stored fluid_private.logo_vector_proposals;value jsonb;receipt jsonb;cost bigint;
begin
 select * into q from public.logo_cost_quotes where id=p.quote_id and owner_id=j.owner_id and project_id=j.project_id;
 select * into a from fluid_private.logo_vector_proposal_dispatches where job_id=j.id and owner_id=j.owner_id and project_id=j.project_id;
 select * into r from public.logo_provider_responses where id=p.provider_receipt_id and job_id=j.id and owner_id=j.owner_id and project_id=j.project_id and lease_token=p.lease_token;
 if a.job_id is null or r.id is null or p.owner_id is distinct from j.owner_id or p.project_id is distinct from j.project_id or p.job_id is distinct from j.id or p.lease_token is distinct from a.lease_token
  or a.input is distinct from j.input or a.worker_id is distinct from j.worker_id or j.attempts<>1 or p.input_hash is distinct from j.input_hash or p.context_hash is distinct from j.input->>'contextHash'
  or fluid_private.logo_vector_proposal_job_quote_matches(j,q) is distinct from true or fluid_private.valid_logo_vector_proposal_observation(r.observation,j.input->'textPolicy') is distinct from true
  or fluid_private.logo_vector_proposal_result_valid(p.result,q.source_inputs->'context',r.observation) is distinct from true then raise exception 'proposal_prepared_binding_invalid' using errcode='55000';end if;
 if p_state is null or p_state not in('succeeded','failed','needs_reconciliation') or(p_state='succeeded' and(p_reason is not null or p.result->>'status'<>'valid')) or(p_state<>'succeeded' and(p_reason is null or length(p_reason) not between 1 and 200)) then raise exception 'invalid_proposal_state' using errcode='22023';end if;
 if p_state<>'needs_reconciliation' and fluid_private.logo_vector_proposal_pending_reason(j,r.observation,p.result) is not null then raise exception 'proposal_requires_reconciliation' using errcode='55000';end if;
 cost:=case when r.observation#>>'{billing,status}'='recorded' then(r.observation#>>'{billing,confirmedMicrousd}')::bigint else 0 end;
 receipt:=jsonb_build_object('id',r.id,'ownerId',r.owner_id,'projectId',r.project_id,'jobId',r.job_id,'leaseToken',r.lease_token,'observation',r.observation);
 value:=jsonb_build_object('version',1,'id',p.id,'ownerId',j.owner_id,'projectId',j.project_id,'jobId',j.id,'requestKey',j.input->'requestKey','quoteId',q.id,'baseVectorRevisionId',j.input->'baseVectorRevisionId','contextHash',p.context_hash,'inputRevisions',q.input_revisions,'expected',q.record->'expected','context',q.source_inputs->'context','state',p_state,'payload',p.result->'payload','providerReceipt',receipt,'actualCostMicrousd',cost,'reason',p_reason,'createdAt',to_char(p.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'materialization','unavailable');
 select * into stored from fluid_private.logo_vector_proposals where job_id=j.id;
 if found then
  if(stored.record-array['reason']) is distinct from(value-array['reason']) then raise exception 'proposal_result_immutable' using errcode='PT409';end if;
  return stored.record;
 end if;
 insert into fluid_private.logo_vector_proposals(id,owner_id,project_id,job_id,request_key,quote_id,base_vector_revision_id,record,created_at) values(p.id,j.owner_id,j.project_id,j.id,(j.input->>'requestKey')::uuid,q.id,(j.input->>'baseVectorRevisionId')::uuid,value,p.created_at);
 return value;
end $$;

create function fluid_private.stage_logo_vector_proposal(p_job uuid,p_lease uuid,p_result jsonb,p_provider_receipt uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare j public.jobs;q public.logo_cost_quotes;r public.logo_provider_responses;p fluid_private.logo_vector_proposal_prepared_results;s public.job_steps;reason text;
begin
 j:=fluid_private.lock_logo_vector_proposal_dispatch(p_job,p_lease);
 select * into p from fluid_private.logo_vector_proposal_prepared_results where job_id=j.id and owner_id=j.owner_id and project_id=j.project_id;
 if found then
  if p.result is distinct from p_result or p.provider_receipt_id is distinct from p_provider_receipt or p.lease_token is distinct from p_lease then raise exception 'proposal_prepared_immutable' using errcode='PT409';end if;
 else
  select * into s from public.job_steps where job_id=j.id and step_key='propose-vector-edit';
  if j.state not in('running','cancel_requested','needs_reconciliation') or s.state not in('in_flight','ambiguous') then raise exception 'proposal_evidence_window_closed' using errcode='55000';end if;
  select * into q from public.logo_cost_quotes where id=(j.input->>'quoteId')::uuid and owner_id=j.owner_id and project_id=j.project_id;
  select * into r from public.logo_provider_responses where id=p_provider_receipt and job_id=j.id and owner_id=j.owner_id and project_id=j.project_id and lease_token=p_lease;
  if r.id is null or fluid_private.valid_logo_vector_proposal_observation(r.observation,j.input->'textPolicy') is distinct from true or fluid_private.logo_vector_proposal_result_valid(p_result,q.source_inputs->'context',r.observation) is distinct from true then raise exception 'invalid_proposal_result' using errcode='22023';end if;
  insert into fluid_private.logo_vector_proposal_prepared_results(owner_id,project_id,job_id,lease_token,quote_id,input_hash,context_hash,provider_receipt_id,result) values(j.owner_id,j.project_id,j.id,p_lease,q.id,j.input_hash,j.input->>'contextHash',r.id,p_result) returning * into p;
  reason:=fluid_private.logo_vector_proposal_pending_reason(j,r.observation,p.result);
  if reason is not null then
   perform fluid_private.retain_logo_vector_proposal(j,p,'needs_reconciliation',reason);
   update public.jobs set state='needs_reconciliation',lease_token=null,lease_expires_at=null,error_code=reason where id=j.id;
  end if;
 end if;
 return jsonb_build_object('version',1,'kind','logo_vector_proposal_prepared','id',p.id,'ownerId',p.owner_id,'projectId',p.project_id,'jobId',p.job_id,'leaseToken',p.lease_token,'quoteId',p.quote_id,'inputHash',p.input_hash,'contextHash',p.context_hash,'providerResponseReceiptId',p.provider_receipt_id);
end $$;

create function fluid_private.complete_logo_vector_proposal_step(p_job uuid,p_lease uuid,p_step text,p_state text,p_cost bigint,p_output jsonb,p_provider_request_id text) returns public.job_steps
language plpgsql set search_path='' as $$
declare j public.jobs;s public.job_steps;r public.logo_provider_responses;p fluid_private.logo_vector_proposal_prepared_results;outcome jsonb;unpublished jsonb;ack jsonb;candidate jsonb;context jsonb;reason text;cost bigint;free boolean;bare boolean;
begin
 j:=fluid_private.lock_logo_vector_proposal_dispatch(p_job,p_lease);
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
  select * into p from fluid_private.logo_vector_proposal_prepared_results where job_id=j.id;
  if p.id is not null then perform fluid_private.retain_logo_vector_proposal(j,p,'needs_reconciliation','provider_outcome_unknown');end if;
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
   ack:=fluid_private.record_logo_vector_proposal_response(p_job,p_lease,unpublished->'observation');
   candidate:=unpublished->'result';
   select source_inputs->'context' into context from public.logo_cost_quotes where id=(j.input->>'quoteId')::uuid and owner_id=j.owner_id and project_id=j.project_id;
   if fluid_private.logo_vector_proposal_result_valid(candidate,context,unpublished->'observation') is distinct from true then
    -- Only this explicitly ambiguous recovery path may retain rejected intent
    -- as diagnostics. Preserve exact bounded bytes; never accept its payload.
    if fluid_private.standalone_keys(candidate,array['status','payload','reason','retainedOutput']) is distinct from true or candidate->>'status' is distinct from 'valid' or candidate->'reason' is distinct from 'null'::jsonb then raise exception 'invalid_unpublished_proposal_result' using errcode='22023';end if;
    candidate:=jsonb_build_object('status','incomplete','payload',null,'reason','provider_outcome_unknown','retainedOutput',candidate->'retainedOutput');
    if fluid_private.logo_vector_proposal_result_valid(candidate,context,unpublished->'observation') is distinct from true then raise exception 'invalid_unpublished_proposal_bytes' using errcode='22023';end if;
   end if;
   ack:=fluid_private.stage_logo_vector_proposal(p_job,p_lease,candidate,(ack->>'id')::uuid);
   outcome:=jsonb_build_object('version',1,'kind','logo_vector_proposal','preparedId',ack->'id','providerResponseReceiptId',ack->'providerResponseReceiptId');
   j:=fluid_private.lock_logo_vector_proposal_dispatch(p_job,p_lease);
  end if;
  if fluid_private.standalone_keys(outcome,array['version','kind','preparedId','providerResponseReceiptId']) is distinct from true or outcome->'version' is distinct from '1'::jsonb or outcome->>'kind' is distinct from 'logo_vector_proposal' or fluid_private.logo_uuid(outcome->'preparedId') is distinct from true or fluid_private.logo_uuid(outcome->'providerResponseReceiptId') is distinct from true then raise exception 'invalid_prepared_proposal_receipt' using errcode='22023';end if;
  select * into p from fluid_private.logo_vector_proposal_prepared_results where id=(outcome->>'preparedId')::uuid and job_id=j.id and owner_id=j.owner_id and project_id=j.project_id and lease_token=p_lease and provider_receipt_id=(outcome->>'providerResponseReceiptId')::uuid;
  if p.id is null then raise exception 'proposal_prepared_not_found' using errcode='55000';end if;
  select * into r from public.logo_provider_responses where id=p.provider_receipt_id and job_id=j.id and owner_id=j.owner_id and project_id=j.project_id and lease_token=p_lease;
  if r.id is null or r.observation->>'providerRequestId' is distinct from p_provider_request_id then raise exception 'proposal_provider_receipt_mismatch' using errcode='22023';end if;
  cost:=case when r.observation#>>'{billing,status}'='recorded' then(r.observation#>>'{billing,confirmedMicrousd}')::bigint else 0 end;
  if cost<>p_cost then raise exception 'proposal_observed_cost_mismatch' using errcode='22023';end if;
  if p_state='succeeded' and p.result->>'status'<>'valid' then raise exception 'invalid_proposal_success' using errcode='22023';end if;
  if p_state='failed' and(p.result->>'status' not in('invalid','refused') or reason is distinct from p.result->>'reason') then raise exception 'invalid_proposal_failure' using errcode='22023';end if;
  if p_state='ambiguous' then reason:=coalesce(fluid_private.logo_vector_proposal_pending_reason(j,r.observation,p.result),reason);
  elsif fluid_private.logo_vector_proposal_pending_reason(j,r.observation,p.result) is not null then raise exception 'proposal_requires_reconciliation' using errcode='55000';end if;
  perform fluid_private.retain_logo_vector_proposal(j,p,case p_state when 'ambiguous' then 'needs_reconciliation' else p_state end,case when p_state='succeeded' then null else reason end);
 end if;
 -- Observation is the only capture point. Never add expense here or settle an
 -- uncertain remaining reservation. Preserve a known late bill on bare replay.
 update public.job_steps set state=p_state,output=p_output,provider_request_id=p_provider_request_id,completed_at=clock_timestamp() where id=s.id returning * into s;
 if p_state='ambiguous' then update public.jobs set state='needs_reconciliation',lease_token=null,lease_expires_at=null,error_code=reason where id=j.id;end if;
 return s;
end $$;

-- Exact predecessor; preserve existing OID, owner, ACL and execution metadata.
do $patch$declare body text;definition text;begin
 select prosrc into body from pg_proc where oid='public.read_leased_logo_record(uuid,uuid,text,jsonb)'::regprocedure;
 if encode(sha256(convert_to(body,'UTF8')),'hex') is distinct from 'a37515b4f297068e3f105f5d7ace28247f645ca155edac565f82a796f13c9419' then raise exception 'proposal_completion_predecessor_mismatch: public.read_leased_logo_record(uuid,uuid,text,jsonb)' using errcode='55000';end if;
 definition:=pg_get_functiondef('public.read_leased_logo_record(uuid,uuid,text,jsonb)'::regprocedure);execute replace(definition,body,$replacement$
declare j public.jobs;q public.logo_cost_quotes;result jsonb;
begin
 if p_kind='vector_proposal_evidence_inputs' then
  if p_input is not null and p_input<>'null'::jsonb then raise exception 'invalid_vector_proposal_read_input' using errcode='22023';end if;
  j:=fluid_private.lock_logo_vector_proposal_dispatch(p_job,p_lease);
  select * into q from public.logo_cost_quotes where id=(j.input->>'quoteId')::uuid and owner_id=j.owner_id and project_id=j.project_id;
  return jsonb_build_object('input',j.input,'context',q.source_inputs->'context');
 end if;
 j:=fluid_private.logo_lock_job(p_job,p_lease);select * into q from public.logo_cost_quotes where id=(j.input->>'quoteId')::uuid and owner_id=j.owner_id and project_id=j.project_id;
 if p_kind='runtime_readiness' then
  if p_input is not null and p_input<>'null'::jsonb then raise exception 'invalid_logo_readiness_input' using errcode='22023';end if;
  return to_jsonb(j.state='running' and fluid_private.logo_job_ready(j,j.worker_id));
 end if;
 if p_kind='vector_proposal_inputs' then
  if p_input is not null and p_input<>'null'::jsonb then raise exception 'invalid_vector_proposal_read_input' using errcode='22023';end if;
  if fluid_private.logo_vector_proposal_job_quote_matches(j,q) is distinct from true then raise exception 'logo_proposal_input_mismatch' using errcode='55000';end if;
  return jsonb_build_object('input',j.input,'context',q.source_inputs->'context');
 end if;
 case p_kind
 when 'concept_inputs' then if j.operation<>'identity.logo_concept' then raise exception 'wrong_logo_operation' using errcode='22023';end if;return jsonb_build_object('input',j.input,'inputRevisions',q.input_revisions,'brief',q.source_inputs->'brief','referenceSnapshot',q.source_inputs->'referenceSnapshot');
 when 'refinement_inputs' then if j.operation<>'identity.logo_refine' then raise exception 'wrong_logo_operation' using errcode='22023';end if;return jsonb_build_object('input',j.input,'inputRevisions',q.input_revisions,'brief',q.source_inputs->'brief','referenceSnapshot',q.source_inputs->'referenceSnapshot','basePreview',q.source_inputs#>'{raster,preview,reference}');
 when 'vector_input' then if j.operation<>'identity.logo_vectorize' then raise exception 'wrong_logo_operation' using errcode='22023';end if;return jsonb_build_object('reference',q.source_inputs#>'{raster,preview,reference}','logoType',q.source_inputs#>'{raster,logoType}','settings',j.input->'settings');
 when 'step_output' then select output into result from public.job_steps where job_id=j.id and step_key=p_input->>'stepKey' and state='succeeded';return result;
 when 'step_asset' then if p_input->>'stepKey'<>'generate-refinement' or j.operation<>'identity.logo_refine' then raise exception 'wrong_logo_step' using errcode='22023';end if;select r.preview->'reference' into result from public.logo_raster_results r join public.job_steps s on s.job_id=r.job_id where r.job_id=j.id and s.step_key='generate-refinement' and s.state='succeeded';if result is null then raise exception 'logo_step_not_found' using errcode='P0002';end if;return result;
 when 'has_results' then return to_jsonb(exists(select 1 from public.job_steps where job_id=j.id and state='succeeded'));
 when 'input_revisions' then return fluid_private.logo_job_input_revisions(j);
 else raise exception 'invalid_logo_read_kind' using errcode='22023';end case;
end $replacement$);
end $patch$;

-- Exact predecessor; preserve existing OID, owner, ACL and execution metadata.
do $patch$declare body text;definition text;begin
 select prosrc into body from pg_proc where oid='public.complete_logo_job_step(uuid,uuid,text,text,bigint,jsonb,text)'::regprocedure;
 if encode(sha256(convert_to(body,'UTF8')),'hex') is distinct from 'fde55b1322cf97c98525e11da2d538bbf5dfb01ee3aa84eedf55da37750f4449' then raise exception 'proposal_completion_predecessor_mismatch: public.complete_logo_job_step(uuid,uuid,text,text,bigint,jsonb,text)' using errcode='55000';end if;
 definition:=pg_get_functiondef('public.complete_logo_job_step(uuid,uuid,text,text,bigint,jsonb,text)'::regprocedure);execute replace(definition,body,$replacement$
<<completion>>
declare j public.jobs;s public.job_steps;r public.logo_provider_responses;reservation public.usage_reservations;output jsonb;receipt jsonb;reason text;state text:=p_state;paid boolean;q public.logo_cost_quotes;current_heads jsonb;payload jsonb;revision jsonb;duplicate boolean:=false;
begin
 if exists(select 1 from public.jobs where id=p_job_id and owner_id=fluid_private.logo_worker_owner() and operation='identity.logo_vector_propose') then
  return fluid_private.complete_logo_vector_proposal_step(p_job_id,p_lease_token,p_step_key,p_state,p_actual_cost_microusd,p_output,p_provider_request_id);
 end if;
 -- Project-first order matches manual publication/admission and prevents lock inversion.
 perform 1 from public.projects where id=(select project_id from public.jobs where id=p_job_id and owner_id=fluid_private.logo_worker_owner()) for update;
 j:=fluid_private.logo_lock_job(p_job_id,p_lease_token);
 if j.operation='identity.logo_vector_propose' then raise exception 'logo_vector_proposal_evidence_unavailable' using errcode='55000';end if;
 select * into s from public.job_steps where job_id=j.id and step_key=p_step_key for update;if not found then raise exception 'step_not_found' using errcode='P0002';end if;
 if state is null or state not in ('succeeded','failed','ambiguous') or p_actual_cost_microusd is null or p_actual_cost_microusd not between 0 and 9007199254740991 or octet_length(p_output::text)>1048576 then raise exception 'invalid_outcome' using errcode='22023';end if;
 if j.billing_mode='chatgpt_subscription' and p_actual_cost_microusd<>0 then raise exception 'invalid_subscription_cost' using errcode='22023';end if;
 if s.state<>'in_flight' then if (s.state,s.actual_cost_microusd,s.output,s.provider_request_id) is not distinct from (state,p_actual_cost_microusd,p_output,p_provider_request_id) then return s;end if;raise exception 'immutable_outcome' using errcode='55000';end if;
 select * into q from public.logo_cost_quotes where id=(j.input->>'quoteId')::uuid and owner_id=j.owner_id and project_id=j.project_id;
 paid:=q.record->'provider'<>'null' and (j.operation in ('identity.logo_concept','identity.logo_directions') or p_step_key='generate-refinement');
 output:=case when state='succeeded' then p_output else p_output->'result' end;reason:=p_output->>'error';
 if p_state='failed' and output is not null and output<>'null' and j.operation<>'identity.logo_export' then raise exception 'failed_publication_not_supported' using errcode='22023';end if;
 if j.operation='identity.logo_export' and (p_actual_cost_microusd<>0 or p_provider_request_id is not null or j.reserved_cost_microusd<>0 or p_step_key<>'prepare-export') then raise exception 'invalid_zero_cost_export' using errcode='22023';end if;
 select * into r from public.logo_provider_responses where job_id=j.id and owner_id=j.owner_id and project_id=j.project_id and lease_token=p_lease_token;
 if paid then
  if state='succeeded' and (r.id is null or r.observation#>>'{billing,status}'<>'recorded' or not fluid_private.logo_response_identity_complete(j,r.observation)) then raise exception 'provider_evidence_required' using errcode='55000';end if;
  if r.id is not null and ((r.observation->>'providerRequestId') is distinct from p_provider_request_id or (r.observation#>>'{billing,status}'='recorded' and (r.observation#>>'{billing,confirmedMicrousd}')::bigint<>p_actual_cost_microusd)) then raise exception 'provider_evidence_mismatch' using errcode='22023';end if;
  if r.id is not null and r.observation#>>'{billing,status}'='unknown' then state:='ambiguous';reason:=case when output is not null then 'billing_unknown' else 'provider_outcome_unknown' end;end if;
  if state='failed' and r.id is null and not (reason='not_dispatched' and p_actual_cost_microusd=0 and p_provider_request_id is null) then state:='ambiguous';reason:='provider_outcome_unknown';end if;
 end if;
 if j.billing_mode='chatgpt_subscription' and state='failed' and (reason='not_dispatched' and r.id is null and p_provider_request_id is null) is not true then state:='ambiguous';reason:='provider_outcome_unknown';end if;
 if p_actual_cost_microusd>s.reserved_cost_microusd or j.actual_cost_microusd+p_actual_cost_microusd>j.reserved_cost_microusd then state:='ambiguous';reason:='provider_cost_exceeded';end if;
 if output is not null and output<>'null' then
  if j.operation='identity.logo_export' then
   if (fluid_private.standalone_keys(output,array['version','kind','publicationId']) and output->'version'='2' and fluid_private.logo_uuid(output->'publicationId')
    and ((state='succeeded' and output->>'kind'='logo_export') or (state='failed' and output->>'kind'='logo_export_partial' and reason in ('export_file_failed','export_package_too_large')))) is not true then raise exception 'invalid_export_output' using errcode='22023';end if;
   receipt:=fluid_private.logo_commit_export_publication(j,(output->>'publicationId')::uuid);
   if (fluid_private.standalone_keys(receipt,array['publicationId','completeness','failure','manifestId','stageRevision','outputs']) and receipt->'publicationId'=output->'publicationId' and jsonb_typeof(receipt->'outputs')='array' and jsonb_array_length(receipt->'outputs') between 1 and 100
    and ((state='succeeded' and receipt->>'completeness'='complete' and fluid_private.logo_uuid(receipt->'manifestId') and receipt->'failure'='null')
      or (state='failed' and receipt->>'completeness'='partial' and receipt->'manifestId'='null' and receipt->'stageRevision'='null' and 'export_'||(receipt->>'failure')=reason))) is not true then raise exception 'export_group_outcome_mismatch' using errcode='55000';end if;
  elsif j.operation='identity.logo_directions' and state='ambiguous' and output->>'kind'='logo_directions_unpublished' then
   payload:=output->'payload';
   if (fluid_private.standalone_keys(output,array['version','kind','reason','payload']) and output->'version'='2' and output->>'reason'=p_output->>'error'
    and output->>'reason' in ('provider_outcome_unknown','provider_evidence_unconfirmed','provider_evidence_incomplete','publication_unknown','direction_payload_invalid','billing_unknown')
    and fluid_private.standalone_keys(payload,array['json','sha256','byteLength','truncated'])
    and jsonb_typeof(payload->'json')='string' and octet_length(payload->>'json')<=262144
    and jsonb_typeof(payload->'sha256')='string' and payload->>'sha256' ~ '^[0-9a-f]{64}$'
    and jsonb_typeof(payload->'byteLength')='number' and (payload->>'byteLength')::numeric between 0 and 9007199254740991 and (payload->>'byteLength')::numeric=trunc((payload->>'byteLength')::numeric)
    and jsonb_typeof(payload->'truncated')='boolean'
    and ((payload->'truncated'='false' and (payload->>'byteLength')::numeric=octet_length(payload->>'json') and payload->>'sha256'=encode(sha256(convert_to(payload->>'json','UTF8')),'hex'))
      or (payload->'truncated'='true' and (payload->>'byteLength')::numeric>octet_length(payload->>'json')))) is not true then raise exception 'invalid_unpublished_direction_evidence' using errcode='22023';end if;
   -- This passive evidence never creates a direction, publication receipt or head.
  elsif j.operation='identity.logo_directions' and state='ambiguous' and reason='direction_payload_invalid' then
   -- Retain bounded raw provider response only as non-publishable step evidence.
   null;
  elsif j.operation='identity.logo_directions' then
   if not fluid_private.standalone_keys(output,array['version','kind','publicationId','providerResponseReceiptId']) or output->'version'<>'2' or output->>'kind'<>'logo_directions' or not fluid_private.logo_uuid(output->'publicationId') or output->>'providerResponseReceiptId' is distinct from r.id::text then raise exception 'invalid_direction_output' using errcode='22023';end if;
   if not exists(select 1 from public.logo_direction_publications p where p.id=(output->>'publicationId')::uuid and p.job_id=j.id and p.owner_id=j.owner_id and p.project_id=j.project_id and p.lease_token=j.lease_token and p.provider_receipt_id=r.id) then raise exception 'direction_publication_not_found' using errcode='P0002';end if;
   if state='succeeded' and r.observation#>>'{billing,status}'='recorded' then perform fluid_private.logo_commit_direction_publication(j,(output->>'publicationId')::uuid,r.id);end if;
  elsif j.operation='identity.logo_vectorize' or (j.operation='identity.logo_refine' and p_step_key='convert-refinement') then
   if j.operation='identity.logo_vectorize' then
    if not fluid_private.standalone_keys(output,array['version','kind','publicationId']) or output->'version'<>'2' or output->>'kind'<>'logo_vector' then raise exception 'invalid_vector_output' using errcode='22023';end if;
   else
    if not fluid_private.standalone_keys(output,array['version','kind','publicationId','sourceStepKey']) or output->'version'<>'2' or output->>'kind'<>'logo_refinement_vector' or output->>'sourceStepKey'<>'generate-refinement' then raise exception 'invalid_vector_output' using errcode='22023';end if;
   end if;
   if not fluid_private.logo_uuid(output->'publicationId') or p_actual_cost_microusd<>0 or p_provider_request_id is not null then raise exception 'invalid_vector_output' using errcode='22023';end if;
   perform fluid_private.logo_commit_vector_publication(j,(output->>'publicationId')::uuid);
  else
  if j.operation='identity.logo_concept' then
   if not fluid_private.standalone_keys(output,array['version','kind','batchId','slotId','attemptId','publicationId','providerResponseReceiptId']) or output->'version'<>'2' or output->>'kind'<>'logo_concept' or output->'batchId' is distinct from j.input->'batchId' or output->'slotId' is distinct from j.input->'slotId' or output->'attemptId' is distinct from j.input->'attemptId' then raise exception 'invalid_logo_output' using errcode='22023';end if;
  elsif j.operation='identity.logo_refine' and p_step_key='generate-refinement' then
   if not fluid_private.standalone_keys(output,array['version','kind','rasterRevisionId','publicationId','providerResponseReceiptId']) or output->>'kind'<>'logo_refinement_raster' or output->'version'<>'2' or output->'rasterRevisionId' is distinct from j.input->'rasterRevisionId' then raise exception 'invalid_logo_output' using errcode='22023';end if;
  else raise exception 'logo_publication_adapter_unavailable' using errcode='55000';end if;
  if r.id is null or output->>'providerResponseReceiptId' is distinct from r.id::text or not fluid_private.logo_uuid(output->'publicationId') then raise exception 'provider_evidence_required' using errcode='55000';end if;
  if r.observation->>'normalizedPixelHash' is null then raise exception 'normalized_pixel_evidence_required' using errcode='55000';end if;
  if j.operation='identity.logo_concept' then
   duplicate:=exists(select 1 from public.logo_concept_attempts a join public.logo_concept_slots sl on sl.id=a.slot_id join public.logo_raster_results rr on rr.job_id=a.job_id join public.logo_provider_responses pr on pr.id=rr.provider_response_receipt_id where sl.batch_id=(j.input->>'batchId')::uuid and a.owner_id=j.owner_id and a.project_id=j.project_id and pr.observation->>'normalizedPixelHash'=r.observation->>'normalizedPixelHash');
  end if;
  if duplicate then state:=case when r.observation#>>'{billing,status}'='recorded' then 'failed' else 'ambiguous' end;reason:='duplicate_preview';
  else
  receipt:=fluid_private.commit_logo_asset_publication(j,(output->>'publicationId')::uuid);
  if receipt#>>'{reference,contentHash}' is distinct from r.observation->>'artifactHash' or receipt#>>'{verification,mimeType}'<>'image/png' or receipt->>'sourceReceiptId' is distinct from coalesce(j.input->>'attemptId',j.input->>'rasterRevisionId') then raise exception 'invalid_logo_artifact' using errcode='22023';end if;
  insert into public.logo_raster_results(job_id,owner_id,project_id,preview,provider_response_receipt_id) values(j.id,j.owner_id,j.project_id,receipt,r.id);
  -- A stale result is retained against its frozen source; it cannot move a current head.
  if j.operation='identity.logo_refine' and j.state='running' and fluid_private.logo_workspace_json(j.owner_id,j.project_id)->'heads'=q.record->'expected' then
   select rr.record->'payload' into payload from public.logo_stage_heads h join public.logo_stage_revisions rr on rr.id=h.revision_id where h.project_id=j.project_id and h.owner_id=j.owner_id and h.stage='refinements';
   payload:=jsonb_build_object('rasterRevisionIds',coalesce(payload->'rasterRevisionIds','[]')||jsonb_build_array(j.input->'rasterRevisionId'),'vectorRevisionId',null,'approvalId',null,'sourceRequestKey',j.input->'requestKey');
   perform fluid_private.logo_append_stage(j.owner_id,j.project_id,'refinements',payload,q.input_revisions);
  end if;
 end if; -- duplicate artifacts stay staged and never become selectable
  end if; -- operation-specific publication group
 elsif state='succeeded' then raise exception 'logo_publication_required' using errcode='55000';
 end if;
 if j.billing_mode='chatgpt_subscription' and state='failed' and (reason='not_dispatched' and r.id is null and p_provider_request_id is null) is not true then state:='ambiguous';reason:='provider_outcome_unknown';end if;
 if p_actual_cost_microusd>s.reserved_cost_microusd or j.actual_cost_microusd+p_actual_cost_microusd>j.reserved_cost_microusd then state:='ambiguous';reason:='provider_cost_exceeded';end if;
 if j.billing_mode<>'chatgpt_subscription' then
 select * into reservation from public.usage_reservations where job_id=j.id for update;
 update public.usage_accounts set spent_microusd=spent_microusd+least(greatest(reservation.reserved_microusd-reservation.actual_microusd,0),p_actual_cost_microusd),provider_actual_microusd=provider_actual_microusd+p_actual_cost_microusd,reserved_microusd=reserved_microusd-least(greatest(reservation.reserved_microusd-reservation.actual_microusd,0),p_actual_cost_microusd) where owner_id=j.owner_id;
 update public.usage_reservations set actual_microusd=actual_microusd+p_actual_cost_microusd,captured_microusd=captured_microusd+least(greatest(reservation.reserved_microusd-reservation.actual_microusd,0),p_actual_cost_microusd) where job_id=j.id;
 end if;
 update public.job_steps set state=completion.state,actual_cost_microusd=p_actual_cost_microusd,output=p_output,provider_request_id=p_provider_request_id,completed_at=clock_timestamp() where id=s.id returning * into s;
 update public.jobs set actual_cost_microusd=actual_cost_microusd+p_actual_cost_microusd where id=j.id;
 if state='ambiguous' then update public.jobs set state='needs_reconciliation',lease_token=null,lease_expires_at=null,error_code=coalesce(reason,'provider_outcome_unknown') where id=j.id;
 elsif duplicate then perform fluid_private.settle_reservation(j.id);update public.jobs set state='failed',lease_token=null,lease_expires_at=null,error_code='duplicate_preview',finished_at=clock_timestamp() where id=j.id;end if;
 return s;
end $replacement$);
end $patch$;

-- Exact predecessor; preserve existing OID, owner, ACL and execution metadata.
do $patch$declare body text;definition text;begin
 select prosrc into body from pg_proc where oid='public.expire_logo_job_leases()'::regprocedure;
 if encode(sha256(convert_to(body,'UTF8')),'hex') is distinct from 'cf9bca6b2af1a4f764318458baa9c9eb49458d11152ee087be3e568e8ee86df0' then raise exception 'proposal_completion_predecessor_mismatch: public.expire_logo_job_leases()' using errcode='55000';end if;
 definition:=pg_get_functiondef('public.expire_logo_job_leases()'::regprocedure);execute replace(definition,body,$replacement$
declare owner uuid:=fluid_private.logo_worker_owner();j public.jobs;next text;n integer:=0;p fluid_private.logo_vector_proposal_prepared_results;
begin
 if owner is null then raise exception 'logo_worker_unauthorized' using errcode='42501';end if;
 for j in select * from public.jobs where owner_id=owner and operation in ('identity.logo_concept','identity.logo_refine','identity.logo_vectorize','identity.logo_directions','identity.logo_export','identity.logo_vector_propose') and state in ('running','cancel_requested') and lease_expires_at<=clock_timestamp() for update skip locked loop
  if exists(select 1 from public.job_steps where job_id=j.id and state in ('in_flight','ambiguous')) then next:='needs_reconciliation';
  elsif j.state='cancel_requested' then next:='cancelled';
  elsif exists(select 1 from public.job_steps where job_id=j.id and state='failed') then
   next:=case when exists(select 1 from public.job_steps where job_id=j.id and state='succeeded') then 'partial' else 'failed' end;
  elsif j.attempts<j.max_attempts then next:='queued';elsif exists(select 1 from public.job_steps where job_id=j.id and state='succeeded') then next:='partial';else next:='failed';end if;
  if next in ('failed','cancelled','partial') then perform fluid_private.settle_reservation(j.id);end if;
  update public.jobs set state=next,lease_token=null,lease_expires_at=null,error_code='lease_expired',finished_at=case when next in ('failed','partial','cancelled') then clock_timestamp() else null end where id=j.id;
  if j.operation='identity.logo_vector_propose' and next='needs_reconciliation' then
   select * into p from fluid_private.logo_vector_proposal_prepared_results where job_id=j.id and owner_id=j.owner_id and project_id=j.project_id;
   if p.id is not null then
    select * into j from public.jobs where id=p.job_id;
    perform fluid_private.retain_logo_vector_proposal(j,p,'needs_reconciliation','lease_expired_with_prepared_result');
   end if;
  end if;n:=n+1;
 end loop;return n;
end $replacement$);
end $patch$;

-- No grants. New entrypoints/helpers and the prepared evidence table stay private.
do $$declare signature text;r record;object_id oid;begin
 foreach signature in array array['fluid_private.logo_vector_proposal_payload_shape_valid(jsonb,jsonb)','fluid_private.logo_vector_proposal_payload_valid(jsonb,jsonb)','fluid_private.logo_vector_proposal_result_valid(jsonb,jsonb,jsonb)','fluid_private.logo_vector_proposal_pending_reason(public.jobs,jsonb,jsonb)','fluid_private.retain_logo_vector_proposal(public.jobs,fluid_private.logo_vector_proposal_prepared_results,text,text)','fluid_private.stage_logo_vector_proposal(uuid,uuid,jsonb,uuid)','fluid_private.complete_logo_vector_proposal_step(uuid,uuid,text,text,bigint,jsonb,text)'] loop
  object_id:=signature::regprocedure;
  for r in select distinct a.grantee from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where p.oid=object_id and a.grantee<>p.proowner loop
   execute format('revoke all on function %s from %s cascade',object_id::regprocedure,case when r.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(r.grantee)) end);
  end loop;
 end loop;
 object_id:='fluid_private.logo_vector_proposal_prepared_results'::regclass;
 for r in select distinct a.grantee from pg_class c cross join lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a where c.oid=object_id and a.grantee<>c.relowner loop
  execute format('revoke all on table %s from %s cascade',object_id::regclass,case when r.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(r.grantee)) end);
 end loop;
end $$;
commit;
