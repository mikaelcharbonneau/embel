begin;

-- Names V1 is user-authored workshop state, never evidence of provider output.
-- SQL validates bounds, structure and graph links. The web boundary additionally
-- replays the pinned JavaScript Unicode/grapheme transformations on every read/write.
create function fluid_private.names_workspace_text(v jsonb, maximum integer, minimum integer default 0)
returns boolean language sql immutable set search_path='' as $$
  select coalesce(jsonb_typeof(v)='string' and char_length(v#>>'{}') between minimum and maximum,false)
$$;
create function fluid_private.names_workspace_uuid(v jsonb, nullable boolean default false)
returns boolean language sql immutable set search_path='' as $$
  select coalesce((nullable and v='null'::jsonb) or (jsonb_typeof(v)='string' and (v#>>'{}') ~*
    '^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$'),false)
$$;
create function fluid_private.names_workspace_input(v jsonb) returns boolean
language plpgsql immutable set search_path='' as $$
declare item jsonb;
begin
  if jsonb_typeof(v) is distinct from 'object' or v->>'kind' is null then return false; end if;
  if v->>'kind'='blend' then
    return fluid_private.standalone_keys(v,array['kind','left','right','leftTake','rightDrop'])
      and fluid_private.standalone_text(v->'left',160,1) and fluid_private.standalone_text(v->'right',160,1)
      and jsonb_typeof(v->'leftTake')='number' and (v->>'leftTake') ~ '^[0-9]+$' and (v->>'leftTake')::numeric between 1 and 160
      and jsonb_typeof(v->'rightDrop')='number' and (v->>'rightDrop') ~ '^[0-9]+$' and (v->>'rightDrop')::numeric between 0 and 160;
  end if;
  if not fluid_private.standalone_text(v->'seed',160,1) then return false; end if;
  if v->>'kind'='affixes' then
    if not fluid_private.standalone_keys(v,array['kind','seed','prefixes','suffixes','separator'])
      or coalesce(v->>'separator','<invalid>') not in('',' ','-') or jsonb_typeof(v->'prefixes') is distinct from 'array'
      or jsonb_typeof(v->'suffixes') is distinct from 'array' then return false; end if;
    if jsonb_array_length(v->'prefixes')>12 or jsonb_array_length(v->'suffixes')>12 then return false; end if;
    for item in select value from jsonb_array_elements((v->'prefixes')||(v->'suffixes')) loop
      if not fluid_private.standalone_text(item,160) then return false; end if;
    end loop;
    return exists(select 1 from jsonb_array_elements((v->'prefixes')||(v->'suffixes')) where value<>'""'::jsonb);
  elsif v->>'kind'='tweaks' then
    if not fluid_private.standalone_keys(v,array['kind','seed','operations']) or jsonb_typeof(v->'operations') is distinct from 'array' then return false; end if;
    return jsonb_array_length(v->'operations') between 1 and 5 and not exists(select 1 from jsonb_array_elements(v->'operations')
      where jsonb_typeof(value)<>'string' or value#>>'{}' not in('lowercase','uppercase','titlecase','remove_spaces','hyphenate'));
  elsif v->>'kind'='swap' then
    return fluid_private.standalone_keys(v,array['kind','seed','find','replacement','match'])
      and fluid_private.standalone_text(v->'find',160,1) and fluid_private.standalone_text(v->'replacement',160) and v->>'match' in('first','all');
  end if;
  return false;
exception when data_exception then return false;
end $$;

create function fluid_private.names_workspace_payload(v jsonb) returns boolean
language plpgsql immutable set search_path='' as $$
declare c jsonb; s jsonb; r jsonb; parent jsonb; history jsonb; step jsonb; last_step jsonb;
  ui jsonb; f jsonb; g jsonb; item jsonb; word jsonb; list jsonb; k text; candidate jsonb; linked text[]:='{}'; previous_output jsonb;
begin
  if not fluid_private.standalone_keys(v,array['version','revision','candidates','runs','ui']) or v->'version' is distinct from '1'::jsonb
    or jsonb_typeof(v->'revision') is distinct from 'number' or (v->>'revision') !~ '^[0-9]+$'
    or (v->>'revision')::numeric not between 0 and 9007199254740991
    or jsonb_typeof(v->'candidates') is distinct from 'array' or jsonb_typeof(v->'runs') is distinct from 'array' then return false; end if;
  if jsonb_array_length(v->'candidates')>500 or jsonb_array_length(v->'runs')>100 then return false; end if;
  if (select count(*)<>count(distinct value#>>'{source,id}') from jsonb_array_elements(v->'candidates'))
    or (select count(*)<>count(distinct value->>'id') from jsonb_array_elements(v->'runs')) then return false; end if;
  ui:=v->'ui'; f:=ui->'form'; g:=ui->'guided';
  if not fluid_private.standalone_keys(ui-'guided',array['tab','filter','origin','query','manualValue','manualOpen','compareOpen','comparisonIds','activeRunId','seedCandidateId','form','context'])
    or coalesce(ui->>'tab','<invalid>') not in('library','workshop','assistant','saved','history') or coalesce(ui->>'filter','<invalid>') not in('retained','favorite','saved','all')
    or coalesce(ui->>'origin','<invalid>') not in('all','manual','workshop') or not fluid_private.names_workspace_text(ui->'query',160)
    or not fluid_private.names_workspace_text(ui->'manualValue',160) or jsonb_typeof(ui->'manualOpen')<>'boolean'
    or jsonb_typeof(ui->'compareOpen')<>'boolean' or jsonb_typeof(ui->'context')<>'object'
    or jsonb_typeof(ui->'comparisonIds') is distinct from 'array'
    or not fluid_private.names_workspace_uuid(ui->'activeRunId',true) or not fluid_private.names_workspace_uuid(ui->'seedCandidateId',true)
    or not fluid_private.standalone_keys(f,array['kind','seed','prefixes','suffixes','separator','operations','left','right','leftTake','rightDrop','find','replacement','match'])
    or coalesce(f->>'kind','<invalid>') not in('affixes','tweaks','blend','swap') or coalesce(f->>'separator','<invalid>') not in('',' ','-') or coalesce(f->>'match','<invalid>') not in('first','all')
    or jsonb_typeof(f->'operations') is distinct from 'array' then return false; end if;
  foreach k in array array['seed','left','right','find','replacement'] loop if not fluid_private.names_workspace_text(f->k,160) then return false; end if; end loop;
  foreach k in array array['prefixes','suffixes'] loop if not fluid_private.names_workspace_text(f->k,2000) then return false; end if; end loop;
  if not fluid_private.names_workspace_text(f->'leftTake',3) or not fluid_private.names_workspace_text(f->'rightDrop',3)
    or jsonb_array_length(f->'operations')>5 or (select count(*)<>count(distinct value) from jsonb_array_elements(f->'operations'))
    or exists(select 1 from jsonb_array_elements(f->'operations') where jsonb_typeof(value)<>'string' or value#>>'{}' not in('lowercase','uppercase','titlecase','remove_spaces','hyphenate'))
    or jsonb_array_length(ui->'comparisonIds')>3 or (select count(*)<>count(distinct value) from jsonb_array_elements(ui->'comparisonIds')) then return false; end if;
  for item in select value from jsonb_array_elements(ui->'comparisonIds') loop
    if not exists(select 1 from jsonb_array_elements(v->'candidates') where value#>'{source,id}'=item) then return false; end if;
  end loop;
  if ui->'activeRunId'<>'null'::jsonb and not exists(select 1 from jsonb_array_elements(v->'runs') where value->'id'=ui->'activeRunId') then return false; end if;
  if ui->'seedCandidateId'<>'null'::jsonb and not exists(select 1 from jsonb_array_elements(v->'candidates') where value#>'{source,id}'=ui->'seedCandidateId') then return false; end if;
  if g is not null then
    if not fluid_private.standalone_keys(g,array['words','draft','mode','prefixes','suffixes','customPrefixes','customSuffixes','tweaks','swapLevel','savedLists'])
      or not fluid_private.names_workspace_text(g->'draft',3000) or coalesce(g->>'mode','<invalid>') not in('affixes','tweaks','blend','swap')
      or coalesce(g->>'swapLevel','<invalid>') not in('safe','balanced','creative') then return false; end if;
    foreach k in array array['words','prefixes','suffixes','customPrefixes','customSuffixes','tweaks','savedLists'] loop
      if jsonb_typeof(g->k) is distinct from 'array' then return false; end if;
    end loop;
    if jsonb_array_length(g->'words')>300 or jsonb_array_length(g->'prefixes')>40 or jsonb_array_length(g->'suffixes')>40
      or jsonb_array_length(g->'customPrefixes') not between 1 and 12 or jsonb_array_length(g->'customSuffixes') not between 1 and 12
      or jsonb_array_length(g->'tweaks')>10 or jsonb_array_length(g->'savedLists')>20
      or (select count(*)<>count(distinct value->>'value') from jsonb_array_elements(g->'words'))
      or (select count(*)<>count(distinct value) from jsonb_array_elements(g->'tweaks')) then return false; end if;
    for item in select value from jsonb_array_elements((g->'prefixes')||(g->'suffixes')) loop
      if not fluid_private.standalone_text(item,160,1) then return false; end if;
    end loop;
    for item in select value from jsonb_array_elements((g->'customPrefixes')||(g->'customSuffixes')) loop
      if not fluid_private.names_workspace_text(item,160) then return false; end if;
    end loop;
    if exists(select 1 from jsonb_array_elements(g->'tweaks') where jsonb_typeof(value)<>'string' or value#>>'{}' not in('reverse','drop_vowel','strip_vowels','stutter','pig_latin','inner_reverse','vowel_shift','mirror','double_last','alternate_case')) then return false; end if;
    if exists(select 1 from jsonb_array_elements(g->'savedLists') where not fluid_private.standalone_keys(value,array['id','words','context','createdAt'])) then return false; end if;
    for list in select value from jsonb_array_elements((g->'savedLists')||jsonb_build_array(jsonb_build_object('words',g->'words'))) loop
      if list ? 'id' and (not fluid_private.standalone_keys(list,array['id','words','context','createdAt'])
        or not fluid_private.names_workspace_uuid(list->'id') or jsonb_typeof(list->'context')<>'object' or not fluid_private.standalone_timestamp(list->'createdAt')) then return false; end if;
      if jsonb_typeof(list->'words') is distinct from 'array' then return false; end if;
      if jsonb_array_length(list->'words')>300 or (list ? 'id' and jsonb_array_length(list->'words')=0) then return false; end if;
      for word in select value from jsonb_array_elements(list->'words') loop
        if not fluid_private.standalone_keys(word,array['value','candidateId']) or not fluid_private.standalone_text(word->'value',160,1)
          or not fluid_private.names_workspace_uuid(word->'candidateId',true) then return false; end if;
        if word->'candidateId'<>'null'::jsonb and not exists(select 1 from jsonb_array_elements(v->'candidates') where value#>'{source,id}'=word->'candidateId' and value#>'{source,value}'=word->'value') then return false; end if;
      end loop;
    end loop;
  end if;
  for c in select value from jsonb_array_elements(v->'candidates') loop
    s:=c->'source'; history:=s->'history';
    if not fluid_private.standalone_keys(c,array['source','context','runId','explanation','favorite','saved'])
      or jsonb_typeof(c->'context')<>'object' or not fluid_private.names_workspace_uuid(c->'runId',true)
      or not fluid_private.names_workspace_text(c->'explanation',2000) or jsonb_typeof(c->'favorite')<>'boolean' or jsonb_typeof(c->'saved')<>'boolean'
      or not fluid_private.standalone_keys(s,array['id','value','createdAt','origin','history']) or not fluid_private.names_workspace_uuid(s->'id')
      or not fluid_private.standalone_text(s->'value',160,1) or not fluid_private.standalone_timestamp(s->'createdAt')
      or coalesce(s->>'origin','<invalid>') not in('manual','workshop') or jsonb_typeof(history) is distinct from 'array' then return false; end if;
    if jsonb_array_length(history)>32 or (select count(*)<>count(distinct value->>'id') from jsonb_array_elements(history)) then return false; end if;
    if c->'runId'='null'::jsonb then
      if s->>'origin'<>'manual' or history<>'[]'::jsonb or c->>'explanation'<>'Added manually' then return false; end if;
    elsif s->>'origin'<>'workshop' or jsonb_array_length(history)=0 then return false; end if;
    previous_output:=null;
    for step in select value from jsonb_array_elements(history) loop
      if not fluid_private.standalone_keys(step,array['id','input','output','createdAt']) or not fluid_private.names_workspace_uuid(step->'id')
        or not coalesce(fluid_private.names_workspace_input(step->'input'),false) or not fluid_private.standalone_text(step->'output',160,1)
        or not fluid_private.standalone_timestamp(step->'createdAt') then return false; end if;
      if previous_output is not null and previous_output is distinct from coalesce(step#>'{input,seed}',step#>'{input,left}') then return false; end if;
      previous_output:=step->'output';
    end loop;
    if previous_output is not null and previous_output is distinct from s->'value' then return false; end if;
  end loop;
  for r in select value from jsonb_array_elements(v->'runs') loop
    if not fluid_private.standalone_keys(r,array['id','input','createdAt','parentId','candidateIds','context','notes','truncated'])
      or not fluid_private.names_workspace_uuid(r->'id') or not fluid_private.names_workspace_uuid(r->'parentId',true)
      or not coalesce(fluid_private.names_workspace_input(r->'input'),false) or not fluid_private.standalone_timestamp(r->'createdAt')
      or jsonb_typeof(r->'context')<>'object' or jsonb_typeof(r->'truncated')<>'boolean'
      or jsonb_typeof(r->'candidateIds') is distinct from 'array' or jsonb_typeof(r->'notes') is distinct from 'array' then return false; end if;
    if jsonb_array_length(r->'candidateIds')>64 or jsonb_array_length(r->'notes')>100
      or (select count(*)<>count(distinct value) from jsonb_array_elements(r->'candidateIds')) then return false; end if;
    for item in select value from jsonb_array_elements(r->'notes') loop if not fluid_private.names_workspace_text(item,2000) then return false; end if; end loop;
    parent:=null;
    if r->'parentId'<>'null'::jsonb then
      select value into parent from jsonb_array_elements(v->'candidates') where value#>'{source,id}'=r->'parentId';
      if parent is null or parent#>'{source,value}' is distinct from coalesce(r#>'{input,seed}',r#>'{input,left}') then return false; end if;
    end if;
    for item in select value from jsonb_array_elements(r->'candidateIds') loop
      select value into candidate from jsonb_array_elements(v->'candidates') where value#>'{source,id}'=item;
      if candidate is null or (item#>>'{}')=any(linked) then return false; end if;
      linked:=array_append(linked,item#>>'{}'); history:=candidate#>'{source,history}'; last_step:=history->-1;
      if candidate->'runId' is distinct from r->'id' or candidate#>>'{source,origin}'<>'workshop'
        or candidate->'context' is distinct from r->'context' or candidate#>'{source,createdAt}' is distinct from r->'createdAt'
        or last_step->'id' is distinct from r->'id' or last_step->'input' is distinct from r->'input'
        or last_step->'output' is distinct from candidate#>'{source,value}' or last_step->'createdAt' is distinct from r->'createdAt'
        or history-(jsonb_array_length(history)-1) is distinct from coalesce(parent#>'{source,history}','[]'::jsonb) then return false; end if;
    end loop;
  end loop;
  return not exists(select 1 from jsonb_array_elements(v->'candidates') where value->'runId'<>'null'::jsonb and not((value#>>'{source,id}')=any(linked)));
exception when data_exception then return false;
end $$;

-- One full snapshot per owner; compact receipts avoid copying 4 MB on every autosave.
create table public.names_workspaces (
  id uuid primary key default gen_random_uuid(), owner_id uuid not null unique references auth.users(id) on delete cascade,
  revision integer not null check(revision between 1 and 2147483647), payload jsonb not null,
  created_at timestamptz not null default clock_timestamp(), updated_at timestamptz not null default clock_timestamp(),
  unique(id,owner_id), check(jsonb_typeof(payload)='object' and octet_length(fluid_private.standalone_compact(payload))<=4000000)
);
create table fluid_private.names_workspace_requests (
  workspace_id uuid not null, owner_id uuid not null, request_key uuid not null,
  expected_revision integer not null check(expected_revision between 0 and 2147483646),
  revision integer not null check(revision=expected_revision+1), payload_hash bytea not null check(octet_length(payload_hash)=32),
  saved_at timestamptz not null,
  primary key(owner_id,request_key), unique(workspace_id,revision),
  foreign key(workspace_id,owner_id) references public.names_workspaces(id,owner_id) on delete cascade
);
create trigger names_workspace_requests_immutable before update on fluid_private.names_workspace_requests
  for each row execute function fluid_private.prevent_history_change();
alter table public.names_workspaces enable row level security;
alter table public.names_workspaces force row level security;
alter table fluid_private.names_workspace_requests enable row level security;
alter table fluid_private.names_workspace_requests force row level security;
create policy names_workspace_owner_read on public.names_workspaces for select to authenticated using(owner_id=(select auth.uid()));

create function public.get_names_workspace() returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare owner uuid:=auth.uid(); workspace jsonb;
begin
  if owner is null then raise exception 'unauthenticated' using errcode='42501'; end if;
  select jsonb_build_object('id',w.id,'ownerId',w.owner_id,'revision',w.revision,'payload',w.payload,'createdAt',w.created_at,'updatedAt',w.updated_at)
    into workspace from public.names_workspaces w where w.owner_id=owner;
  return jsonb_build_object('ownerId',owner,'workspace',workspace);
end $$;

-- The definer stays outside exposed schemas. Its parsed SQL wrapper below needs
-- EXECUTE only; authenticated users gain no USAGE on fluid_private or raw writes.
create function fluid_private.save_names_workspace(p_expected_revision integer,p_request_key uuid,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare owner uuid:=auth.uid(); w public.names_workspaces; receipt fluid_private.names_workspace_requests;
  payload_hash bytea; saved_revision integer; saved_at timestamptz;
begin
  if owner is null then raise exception 'unauthenticated' using errcode='42501'; end if;
  if p_payload is null or octet_length(fluid_private.standalone_compact(p_payload))>4000000 then raise exception 'workspace_size' using errcode='54000'; end if;
  if p_request_key is null or p_expected_revision is null or p_expected_revision not between 0 and 2147483646
    or not coalesce(fluid_private.names_workspace_payload(p_payload),false) then raise exception 'invalid_workspace' using errcode='22023'; end if;
  -- Stable owner-wide lock serializes initial creation, CAS and all replay keys.
  perform pg_advisory_xact_lock(hashtextextended(owner::text||':names-workspace',0));
  select * into w from public.names_workspaces where owner_id=owner for update;
  payload_hash:=sha256(convert_to(p_payload::text,'UTF8'));
  select * into receipt from fluid_private.names_workspace_requests where owner_id=owner and request_key=p_request_key;
  if found then
    if receipt.workspace_id is distinct from w.id or receipt.expected_revision<>p_expected_revision or receipt.payload_hash<>payload_hash then
      raise exception 'request_conflict' using errcode='PT409'; end if;
    saved_revision:=receipt.revision; saved_at:=receipt.saved_at;
  else
    if coalesce(w.revision,0)<>p_expected_revision then raise exception 'revision_conflict' using errcode='PT409'; end if;
    if w.id is null then
      insert into public.names_workspaces(owner_id,revision,payload) values(owner,1,p_payload) returning * into w;
    else
      update public.names_workspaces set revision=revision+1,payload=p_payload,updated_at=clock_timestamp()
        where id=w.id and owner_id=owner returning * into w;
    end if;
    saved_revision:=w.revision; saved_at:=w.updated_at;
    insert into fluid_private.names_workspace_requests(workspace_id,owner_id,request_key,expected_revision,revision,payload_hash,saved_at)
      values(w.id,owner,p_request_key,p_expected_revision,saved_revision,payload_hash,saved_at);
  end if;
  -- Exact acknowledged version reconstructed from the hash-matched request;
  -- replay never moves the current head backwards after another tab's save.
  return jsonb_build_object('ownerId',owner,'workspace',jsonb_build_object('id',w.id,'ownerId',owner,'revision',saved_revision,
    'payload',p_payload,'createdAt',w.created_at,'updatedAt',saved_at));
end $$;
create function public.save_names_workspace(p_expected_revision integer,p_request_key uuid,p_payload jsonb)
returns jsonb language sql security invoker set search_path=''
begin atomic
  select fluid_private.save_names_workspace(p_expected_revision,p_request_key,p_payload);
end;

-- Clear every inherited default grant on only these new objects, including
-- unexpected worker/service roles. Existing permissions remain untouched.
do $$ declare obj record; access record; target text; begin
  for obj in select c.oid,c.relowner from pg_class c where c.oid in('public.names_workspaces'::regclass,'fluid_private.names_workspace_requests'::regclass) loop
    target:=obj.oid::regclass::text;
    for access in select distinct a.grantee,r.rolname from pg_class c cross join lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
      left join pg_roles r on r.oid=a.grantee where c.oid=obj.oid and a.grantee<>obj.relowner loop
      execute 'revoke all on table '||target||' from '||case when access.grantee=0 then 'PUBLIC' else quote_ident(access.rolname) end;
    end loop;
  end loop;
  for obj in select p.oid,p.proowner from pg_proc p where p.oid in(
    'fluid_private.names_workspace_text(jsonb,integer,integer)'::regprocedure,
    'fluid_private.names_workspace_uuid(jsonb,boolean)'::regprocedure,
    'fluid_private.names_workspace_input(jsonb)'::regprocedure,
    'fluid_private.names_workspace_payload(jsonb)'::regprocedure,
    'fluid_private.save_names_workspace(integer,uuid,jsonb)'::regprocedure,
    'public.get_names_workspace()'::regprocedure,
    'public.save_names_workspace(integer,uuid,jsonb)'::regprocedure
  ) loop
    target:=obj.oid::regprocedure::text;
    for access in select distinct a.grantee,r.rolname from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
      left join pg_roles r on r.oid=a.grantee where p.oid=obj.oid and a.grantee<>obj.proowner loop
      execute 'revoke all on function '||target||' from '||case when access.grantee=0 then 'PUBLIC' else quote_ident(access.rolname) end;
    end loop;
  end loop;
end $$;
grant select on table public.names_workspaces to authenticated;
grant execute on function public.get_names_workspace(), public.save_names_workspace(integer,uuid,jsonb),
  fluid_private.save_names_workspace(integer,uuid,jsonb) to authenticated;
commit;
