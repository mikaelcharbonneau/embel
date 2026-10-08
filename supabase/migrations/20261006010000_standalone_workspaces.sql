-- Standalone manual drafts. LOCAL CANDIDATE ONLY: reviewed hosted activation is separate.
begin;

create table public.standalone_workspaces (
  id uuid primary key default gen_random_uuid(), owner_id uuid not null references auth.users(id),
  tool text not null check(tool in ('domains','handles','trademarks')),
  current_revision integer not null check(current_revision>0),
  created_at timestamptz not null default clock_timestamp(), updated_at timestamptz not null default clock_timestamp(),
  unique(owner_id,tool), unique(id,owner_id)
);
create table public.standalone_workspace_revisions (
  workspace_id uuid not null, owner_id uuid not null, revision integer not null check(revision>0),
  expected_revision integer not null check(expected_revision>=0 and revision=expected_revision+1),
  request_key uuid not null, payload jsonb not null check(jsonb_typeof(payload)='object' and octet_length(payload::text)<=262144),
  import_selections jsonb not null check(jsonb_typeof(import_selections)='array' and jsonb_array_length(import_selections)<=30),
  imports jsonb not null check(jsonb_typeof(imports)='array' and jsonb_array_length(imports)<=30),
  created_at timestamptz not null default clock_timestamp(), primary key(workspace_id,revision), unique(workspace_id,owner_id,revision),
  unique(owner_id,request_key), foreign key(workspace_id,owner_id) references public.standalone_workspaces(id,owner_id)
);
alter table public.standalone_workspaces add constraint standalone_workspace_head_fk foreign key(id,owner_id,current_revision)
  references public.standalone_workspace_revisions(workspace_id,owner_id,revision) deferrable initially deferred;
create trigger standalone_workspace_revisions_immutable before update or delete on public.standalone_workspace_revisions
  for each row execute function fluid_private.prevent_history_change();

-- Exact keys at every structured boundary; JSONB ownership/evidence assertions are not accepted.
create function fluid_private.standalone_keys(v jsonb, keys text[]) returns boolean language sql immutable set search_path='' as $$
  select case when jsonb_typeof(v)='object' then v ?& keys and not exists(select 1 from jsonb_object_keys(v) k where not(k=any(keys))) else false end
$$;
create function fluid_private.standalone_text(v jsonb, max_units integer, min_units integer default 0) returns boolean language sql immutable set search_path='' as $$
  select coalesce(jsonb_typeof(v)='string' and fluid_private.idea_text_units(v#>>'{}') between min_units and max_units,false)
$$;
create function fluid_private.standalone_timestamp(v jsonb) returns boolean language plpgsql immutable set search_path='' as $$
declare value text; year integer; month integer; day integer; days integer;
begin
  -- Match the installed z.iso.datetime({offset:true}) reader. PostgreSQL's
  -- timestamptz cast normalizes 24:00/leap seconds and rejects valid Zod offsets.
  if not fluid_private.standalone_text(v,120000,20) then return false; end if;
  value:=v#>>'{}';
  if value!~'^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]+)?(Z|[+-]([01][0-9]|2[0-3]):[0-5][0-9])$' then return false; end if;
  year:=substring(value from 1 for 4)::integer; month:=substring(value from 6 for 2)::integer; day:=substring(value from 9 for 2)::integer;
  days:=case when month=2 then case when mod(year,400)=0 or (mod(year,4)=0 and mod(year,100)<>0) then 29 else 28 end
    when month in(4,6,9,11) then 30 else 31 end;
  return day<=days;
end $$;
create function fluid_private.standalone_domain(v text) returns boolean language plpgsql immutable set search_path='' as $$
declare labels text[]; label text;
begin
  if v is null or length(v)>253 or v<>lower(v) or v~'[^a-z0-9.-]' then return false; end if;
  labels:=string_to_array(v,'.');
  if cardinality(labels)<2 or labels[cardinality(labels)]!~'^[a-z]{2,63}$' then return false; end if;
  foreach label in array labels loop
    if label!~'^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$' or label like 'xn--%' then return false; end if;
  end loop;
  return true;
end $$;
-- JSON compact serialization for byte bounds and the exact user-review key. Object order is explicit below.
create function fluid_private.standalone_compact(v jsonb) returns text language plpgsql immutable set search_path='' as $$
declare result text;
begin
  if jsonb_typeof(v)='array' then select '['||coalesce(string_agg(fluid_private.standalone_compact(value),',' order by ord),'')||']' into result from jsonb_array_elements(v) with ordinality e(value,ord); return result;
  elsif jsonb_typeof(v)='object' then select '{'||coalesce(string_agg(to_json(key)::text||':'||fluid_private.standalone_compact(value),',' order by key),'')||'}' into result from jsonb_each(v); return result;
  else return v::text; end if;
end $$;
create function fluid_private.standalone_payload(p_tool text,v jsonb) returns boolean language plpgsql immutable set search_path='' as $$
declare item jsonb; entry jsonb; source jsonb; account jsonb; key text; text_value text; authority text; host text; port text; root text;
  expected text[]:='{}'; line text; lines text[]; extension text; seed text; invalid boolean:=false; canonical_review text;
begin
  if v is null or jsonb_typeof(v)<>'object' or v->'version' is distinct from '1'::jsonb or octet_length(v::text)>262144 then return false; end if;
  if p_tool='domains' then
    if not fluid_private.standalone_keys(v,array['version','input','extensions','candidates']) or not fluid_private.standalone_text(v->'input',4000)
      or jsonb_typeof(v->'extensions')<>'array' or jsonb_array_length(v->'extensions')>10 or jsonb_typeof(v->'candidates')<>'array' or jsonb_array_length(v->'candidates')>200
      or octet_length(fluid_private.standalone_compact(v))>24000 then return false; end if;
    if (select count(*)<>count(distinct value) from jsonb_array_elements(v->'extensions')) then return false; end if;
    for item in select value from jsonb_array_elements(v->'extensions') loop
      if jsonb_typeof(item)<>'string' or (item#>>'{}')!~'^[a-z]{2,63}(\.[a-z]{2,63})?$' then return false; end if;
    end loop;
    for item in select value from jsonb_array_elements(v->'candidates') loop
      if jsonb_typeof(item)<>'string' or not fluid_private.standalone_domain(item#>>'{}') then return false; end if;
    end loop;
    if jsonb_array_length(v->'candidates')=0 then return true; end if;
    select array_agg(clean order by ord) into lines from (select fluid_private.idea_trim(value) clean,ord from regexp_split_to_table(v->>'input',E'[\n,]') with ordinality e(value,ord)) a where clean<>'';
    if coalesce(cardinality(lines),0) not between 1 and 20 then return false; end if;
    foreach line in array lines loop
      -- Only ASCII capitals and the Kelvin sign lowercase to ASCII under JS
      -- toLowerCase(). Leave other Unicode intact for the ASCII syntax check;
      -- PostgreSQL lower() can erase distinctions such as U+0130 -> i.
      line:=translate(line,'ABCDEFGHIJKLMNOPQRSTUVWXYZ'||chr(8490),'abcdefghijklmnopqrstuvwxyzk');
      if position('.' in line)>0 then
        if not fluid_private.standalone_domain(line) then invalid:=true; else if not(line=any(expected)) then expected:=array_append(expected,line); end if; end if;
      else
        -- Use the exact ECMAScript whitespace set, shared with idea_trim.
        -- POSIX [:space:] also removes U+0085, which JS /\s/g preserves.
        seed:=translate(line,chr(9)||chr(10)||chr(11)||chr(12)||chr(13)||chr(32)||chr(160)||chr(5760)||
          chr(8192)||chr(8193)||chr(8194)||chr(8195)||chr(8196)||chr(8197)||chr(8198)||chr(8199)||chr(8200)||chr(8201)||chr(8202)||
          chr(8232)||chr(8233)||chr(8239)||chr(8287)||chr(12288)||chr(65279),'');
        if seed!~'^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$' or seed like 'xn--%' or jsonb_array_length(v->'extensions')=0 then invalid:=true;
        else for extension in select value from jsonb_array_elements_text(v->'extensions') loop
          if not(seed||'.'||extension=any(expected)) then expected:=array_append(expected,seed||'.'||extension); end if;
        end loop; end if;
      end if;
    end loop;
    return not invalid and to_jsonb(expected)=v->'candidates';
  elsif p_tool='handles' then
    if not fluid_private.standalone_keys(v,array['version','bundles']) or jsonb_typeof(v->'bundles')<>'array' or jsonb_array_length(v->'bundles')>200
      or octet_length(fluid_private.standalone_compact(v))>120000 then return false; end if;
    if (select count(*)<>count(distinct value->>'id') from jsonb_array_elements(v->'bundles')) then return false; end if;
    for item in select value from jsonb_array_elements(v->'bundles') loop
      if not fluid_private.standalone_keys(item,array['id','title','list','source','savedAt','entries']) then return false; end if;
      foreach key in array array['id','title','list'] loop
        if not fluid_private.standalone_text(item->key,160,1) or fluid_private.idea_trim(item->>key)<>item->>key then return false; end if;
      end loop;
      if not fluid_private.standalone_timestamp(item->'savedAt') then return false; end if;
      source:=item->'source';
      if not fluid_private.standalone_keys(source,array['id','name','origin','projectId','projectTitle']) or coalesce(source->>'origin','') not in('manual','names','project') then return false; end if;
      foreach key in array array['id','name','projectId','projectTitle'] loop
        if key in('projectId','projectTitle') and source->key='null'::jsonb then continue; end if;
        if not fluid_private.standalone_text(source->key,160,1) or fluid_private.idea_trim(source->>key)<>source->>key then return false; end if;
      end loop;
      if (source->'projectId'='null'::jsonb)<>(source->'projectTitle'='null'::jsonb) or
        (source->>'origin'='manual' and source->'projectId'<>'null'::jsonb) or (source->>'origin'='project' and source->'projectId'='null'::jsonb) then return false; end if;
      if jsonb_typeof(item->'entries')<>'array' or jsonb_array_length(item->'entries') not between 1 and 5 or
        (select count(*)<>count(distinct value->>'platform') from jsonb_array_elements(item->'entries')) then return false; end if;
      for entry in select value from jsonb_array_elements(item->'entries') loop
        if not fluid_private.standalone_keys(entry,array['platform','handle','favorite','selected','accountCreated','evidence']) or
          coalesce(entry->>'platform','') not in('instagram','tiktok','youtube','x','linkedin') or not fluid_private.standalone_text(entry->'handle',64,1) or (entry->>'handle')!~'^[a-zA-Z0-9_.-]{1,64}$' or
          jsonb_typeof(entry->'favorite')<>'boolean' or jsonb_typeof(entry->'selected')<>'boolean' or entry->'evidence' is distinct from '[]'::jsonb then return false; end if;
        account:=entry->'accountCreated';
        if account<>'null'::jsonb then
          if not fluid_private.standalone_keys(account,array['declaredAt','url']) or not fluid_private.standalone_timestamp(account->'declaredAt') then return false; end if;
          if account->'url'<>'null'::jsonb then
            if not fluid_private.standalone_text(account->'url',2048,1) then return false; end if;
            text_value:=account->>'url';
            authority:=substring(text_value from '(?i)^https?://([^/?#]+)');
            if authority is null then return false; end if;
            host:=split_part(authority,':',1);
            -- Canonical ASCII platform hosts/subdomains are parseable by WHATWG.
            -- Reject forbidden authority characters and unvalidated ACE/IDN host
            -- encodings. Unicode, spaces, escapes, query and fragment in the path
            -- remain accepted; they do not alter host/port ownership.
            -- Admit the raw host before folding; SQL lower() is not WHATWG.
            if host!~'^[a-zA-Z0-9._-]+$' then return false; end if;
            host:=translate(host,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz');
            if exists(select 1 from regexp_split_to_table(host,'\.') label where label like 'xn--%') then return false; end if;
            if position(':' in authority)>0 then
              port:=substring(authority from position(':' in authority)+1);
              if port!~'^[0-9]*$' then return false; end if;
              -- Empty ports and leading zeros are valid URL spellings. Strip
              -- zeros before casting so a long valid zero prefix cannot overflow.
              port:=ltrim(port,'0');
              if length(port)>5 or (port<>'' and port::integer>65535) then return false; end if;
            end if;
            root:=case entry->>'platform' when 'instagram' then 'instagram.com' when 'tiktok' then 'tiktok.com' when 'youtube' then 'youtube.com' when 'x' then 'x.com' else 'linkedin.com' end;
            if host<>root and right(host,length(root)+1)<>'.'||root then return false; end if;
          end if;
        end if;
      end loop;
    end loop;
    return true;
  elsif p_tool='trademarks' then
    if not fluid_private.standalone_keys(v,array['version','markName','markType','representationNotes','territories','owner','goodsServices','classificationNotes','documents','userNotes','reviewedContent'])
      or octet_length(fluid_private.standalone_compact(v))>120000 or (jsonb_typeof(v->'markType')<>'string' or v->>'markType' not in('','word','logo','combined')) then return false; end if;
    foreach key in array array['markName','representationNotes','goodsServices','classificationNotes','userNotes'] loop
      if not fluid_private.standalone_text(v->key,case key when 'markName' then 160 when 'goodsServices' then 6000 when 'userNotes' then 4000 else 2000 end) or (v->>key)~'[\x01-\x08\x0b\x0c\x0e-\x1f]' then return false; end if;
    end loop;
    if jsonb_typeof(v->'territories')<>'array' or jsonb_array_length(v->'territories')>20 then return false; end if;
    for item in select value from jsonb_array_elements(v->'territories') loop
      if not fluid_private.standalone_text(item,160) or (item#>>'{}')~'[\x01-\x08\x0b\x0c\x0e-\x1f]' then return false; end if;
    end loop;
    if not fluid_private.standalone_keys(v->'owner',array['name','address','contact']) or not fluid_private.standalone_keys(v->'documents',array['plan','notes'])
      or coalesce(v#>>'{documents,plan}','') not in('unknown','none-planned','listed') then return false; end if;
    foreach key in array array['name','address','contact'] loop
      if not fluid_private.standalone_text(v->'owner'->key,case when key='address' then 2000 else 300 end) or (v->'owner'->>key)~'[\x01-\x08\x0b\x0c\x0e-\x1f]' then return false; end if;
    end loop;
    if not fluid_private.standalone_text(v#>'{documents,notes}',4000) or (v#>>'{documents,notes}')~'[\x01-\x08\x0b\x0c\x0e-\x1f]' then return false; end if;
    if v->'reviewedContent'<>'null'::jsonb then
      if not fluid_private.standalone_text(v->'reviewedContent',60000) then return false; end if;
      canonical_review:='{"version":1,"markName":'||(v->'markName')::text||',"markType":'||(v->'markType')::text||',"representationNotes":'||(v->'representationNotes')::text||',"territories":'||fluid_private.standalone_compact(v->'territories')||
        ',"owner":{"name":'||(v#>'{owner,name}')::text||',"address":'||(v#>'{owner,address}')::text||',"contact":'||(v#>'{owner,contact}')::text||'},"goodsServices":'||(v->'goodsServices')::text||',"classificationNotes":'||(v->'classificationNotes')::text||
        ',"documents":{"plan":'||(v#>'{documents,plan}')::text||',"notes":'||(v#>'{documents,notes}')::text||'},"userNotes":'||(v->'userNotes')::text||'}';
      if v->>'reviewedContent'<>canonical_review then return false; end if;
    end if;
    return true;
  end if;
  return false;
exception when others then return false;
end $$;

-- Source fields come only from owned immutable project/name records. Clients submit IDs/revisions.
create function fluid_private.standalone_current_import(p_owner uuid,p_project_id uuid) returns jsonb language plpgsql stable set search_path='' as $$
declare p public.projects; r public.project_revisions; s public.name_selections; c public.name_candidates; name text;
begin
  select * into p from public.projects where id=p_project_id and owner_id=p_owner;
  if not found then raise exception 'source_not_found' using errcode='P0002'; end if;
  select * into r from public.project_revisions where project_id=p.id and owner_id=p_owner and revision=p.current_revision;
  if not found then raise exception 'source_not_found' using errcode='P0002'; end if;
  select sel.* into s from public.naming_sessions ns join public.name_selections sel on (sel.id,sel.owner_id,sel.project_id)=(ns.current_selection_id,ns.owner_id,ns.project_id)
    where ns.project_id=p.id and ns.owner_id=p_owner;
  name:=coalesce(nullif(fluid_private.idea_trim(r.context->>'selectedName'),''),nullif(fluid_private.idea_trim(r.context#>>'{intake,suppliedName}'),''));
  if s.id is not null then
    select * into c from public.name_candidates where id=s.candidate_id and owner_id=p_owner and project_id=p.id;
    if c.id is null or c.value is distinct from r.context->>'selectedName' or c.value is distinct from r.context#>>'{intake,suppliedName}' or s.project_revision>p.current_revision then
      raise exception 'invalid_source' using errcode='22023'; end if;
    name:=c.value;
  end if;
  if name is null then return null; end if;
  if fluid_private.idea_text_units(name)>160 then raise exception 'invalid_source' using errcode='22023'; end if;
  return jsonb_build_object('projectId',p.id,'projectRevision',p.current_revision,'projectTitle',p.title,'name',name,'selectionId',s.id,'candidateId',c.id,
    'origin',case when s.id is null then 'project_name' else 'naming_selection' end);
end $$;
create function fluid_private.standalone_record(p_id uuid,p_owner uuid) returns jsonb language sql stable set search_path='' as $$
  select jsonb_build_object('id',w.id,'ownerId',w.owner_id,'tool',w.tool,'revision',w.current_revision,'payload',r.payload,'imports',r.imports,
    'createdAt',fluid_private.idea_timestamp(w.created_at),'updatedAt',fluid_private.idea_timestamp(w.updated_at))
  from public.standalone_workspaces w join public.standalone_workspace_revisions r on (r.workspace_id,r.owner_id,r.revision)=(w.id,w.owner_id,w.current_revision)
  where w.id=p_id and w.owner_id=p_owner
$$;
create function public.get_standalone_workspace(p_tool text) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare owner uuid:=auth.uid(); w uuid;
begin
  if owner is null then raise exception 'unauthenticated' using errcode='42501'; end if;
  if p_tool is null or p_tool not in('domains','handles','trademarks') then raise exception 'invalid_tool' using errcode='22023'; end if;
  select id into w from public.standalone_workspaces where owner_id=owner and tool=p_tool;
  return jsonb_build_object('ownerId',owner,'workspace',fluid_private.standalone_record(w,owner));
end $$;
create function public.get_standalone_import(p_project_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare owner uuid:=auth.uid();
begin
  if owner is null then raise exception 'unauthenticated' using errcode='42501'; end if;
  return jsonb_build_object('ownerId',owner,'projectId',p_project_id,'source',fluid_private.standalone_current_import(owner,p_project_id));
end $$;
create function public.save_standalone_workspace(p_tool text,p_expected_revision integer,p_request_key uuid,p_payload jsonb,p_imports jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare owner uuid:=auth.uid(); w public.standalone_workspaces; previous public.standalone_workspace_revisions; replay public.standalone_workspace_revisions;
  choice jsonb; resolved jsonb; sources jsonb:='[]'; project_id uuid; selection_id uuid; source_revision integer; project_ids uuid[]:='{}';
begin
  if owner is null then raise exception 'unauthenticated' using errcode='42501'; end if;
  if p_request_key is null or p_expected_revision is null or p_expected_revision not between 0 and 2147483646 or
    not fluid_private.standalone_payload(p_tool,p_payload) or p_imports is null or jsonb_typeof(p_imports)<>'array' or jsonb_array_length(p_imports)>30
    or octet_length(fluid_private.standalone_compact(jsonb_build_object('requestKey',p_request_key,'expectedRevision',p_expected_revision,'payload',p_payload,'imports',p_imports)))>131072 then
    raise exception 'invalid_draft' using errcode='22023'; end if;
  if (select count(*)<>count(distinct value) from jsonb_array_elements(p_imports)) then raise exception 'duplicate_import' using errcode='22023'; end if;
  for choice in select value from jsonb_array_elements(p_imports) loop
    if not fluid_private.standalone_keys(choice,array['projectId','projectRevision','selectionId']) or jsonb_typeof(choice->'projectId')<>'string' or
      (choice->>'projectId')!~'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' or
      jsonb_typeof(choice->'projectRevision')<>'number' or (choice->>'projectRevision')!~'^[0-9]+$' or (choice->>'projectRevision')::numeric not between 1 and 2147483647 or
      (choice->'selectionId'<>'null'::jsonb and (jsonb_typeof(choice->'selectionId')<>'string' or (choice->>'selectionId')!~'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')) then
      raise exception 'invalid_import' using errcode='22023'; end if;
    project_ids:=array_append(project_ids,(choice->>'projectId')::uuid);
  end loop;
  -- One lock order for creates, CAS and idempotency, including same-key cross-tool races.
  perform pg_advisory_xact_lock(hashtextextended(owner::text||':standalone:request:'||p_request_key::text,0));
  perform pg_advisory_xact_lock(hashtextextended(owner::text||':standalone:tool:'||p_tool,0));
  select * into w from public.standalone_workspaces where owner_id=owner and tool=p_tool for update;
  select * into replay from public.standalone_workspace_revisions where owner_id=owner and request_key=p_request_key;
  if found then
    if replay.workspace_id is distinct from w.id or replay.expected_revision<>p_expected_revision or replay.payload<>p_payload or replay.import_selections<>p_imports or w.current_revision<>replay.revision then
      raise exception 'request_conflict' using errcode='40001'; end if;
    return jsonb_build_object('ownerId',owner,'workspace',fluid_private.standalone_record(w.id,owner));
  end if;
  if coalesce(w.current_revision,0)<>p_expected_revision then raise exception 'revision_conflict' using errcode='40001'; end if;
  if w.id is not null then select * into previous from public.standalone_workspace_revisions where workspace_id=w.id and owner_id=owner and revision=w.current_revision; end if;
  -- Existing project writers lock these heads FOR UPDATE. Sorted SHARE locks stabilize every fresh import through commit.
  perform p.id from public.projects p where p.id=any(project_ids) and p.owner_id=owner order by p.id for share;
  for choice in select value from jsonb_array_elements(p_imports) loop
    project_id:=(choice->>'projectId')::uuid; source_revision:=(choice->>'projectRevision')::integer; selection_id:=(choice->>'selectionId')::uuid;
    resolved:=null;
    select value into resolved from jsonb_array_elements(coalesce(previous.imports,'[]'::jsonb)) where value->'projectId'=choice->'projectId' and value->'projectRevision'=choice->'projectRevision' and value->'selectionId'=choice->'selectionId';
    if resolved is null then
      resolved:=fluid_private.standalone_current_import(owner,project_id);
      if resolved is null or resolved->'projectRevision'<>choice->'projectRevision' or resolved->'selectionId'<>choice->'selectionId' then raise exception 'source_conflict' using errcode='40001'; end if;
    end if;
    sources:=sources||jsonb_build_array(resolved);
  end loop;
  if w.id is null then insert into public.standalone_workspaces(owner_id,tool,current_revision) values(owner,p_tool,1) returning * into w;
  else update public.standalone_workspaces set current_revision=current_revision+1,updated_at=clock_timestamp() where id=w.id and owner_id=owner returning * into w; end if;
  insert into public.standalone_workspace_revisions(workspace_id,owner_id,revision,expected_revision,request_key,payload,import_selections,imports)
    values(w.id,owner,w.current_revision,p_expected_revision,p_request_key,p_payload,p_imports,sources);
  return jsonb_build_object('ownerId',owner,'workspace',fluid_private.standalone_record(w.id,owner));
end $$;

do $$ declare table_name text; fn record; grantee record; object_name text; begin
  foreach table_name in array array['standalone_workspaces','standalone_workspace_revisions'] loop
    execute format('alter table public.%I enable row level security',table_name);
    execute format('alter table public.%I force row level security',table_name);
    execute format('revoke all on table public.%I from public,anon,authenticated,service_role',table_name);
    for grantee in select distinct r.rolname from pg_class c cross join lateral aclexplode(c.relacl) a join pg_roles r on r.oid=a.grantee
      where c.oid=format('public.%I',table_name)::regclass and a.grantee<>c.relowner loop
      execute format('revoke all on table public.%I from %I',table_name,grantee.rolname);
    end loop;
    execute format('grant select on table public.%I to authenticated',table_name);
    execute format('create policy standalone_owner_read on public.%I for select to authenticated using(owner_id=(select auth.uid()))',table_name);
  end loop;
  -- Resolve only the functions created above. Prefixes or name-only matching
  -- would also revoke rights from unrelated helpers or same-name overloads.
  for fn in select p.oid,p.proowner from pg_proc p where p.oid in (
    'fluid_private.standalone_keys(jsonb,text[])'::regprocedure,
    'fluid_private.standalone_text(jsonb,integer,integer)'::regprocedure,
    'fluid_private.standalone_timestamp(jsonb)'::regprocedure,
    'fluid_private.standalone_domain(text)'::regprocedure,
    'fluid_private.standalone_compact(jsonb)'::regprocedure,
    'fluid_private.standalone_payload(text,jsonb)'::regprocedure,
    'fluid_private.standalone_current_import(uuid,uuid)'::regprocedure,
    'fluid_private.standalone_record(uuid,uuid)'::regprocedure,
    'public.get_standalone_workspace(text)'::regprocedure,
    'public.get_standalone_import(uuid)'::regprocedure,
    'public.save_standalone_workspace(text,integer,uuid,jsonb,jsonb)'::regprocedure
  ) loop
    object_name:=fn.oid::regprocedure::text;
    execute 'revoke all on function '||object_name||' from public,anon,authenticated,service_role';
    for grantee in select distinct r.rolname from pg_proc p cross join lateral aclexplode(p.proacl) a join pg_roles r on r.oid=a.grantee where p.oid=fn.oid and a.grantee<>fn.proowner loop
      execute 'revoke all on function '||object_name||' from '||quote_ident(grantee.rolname);
    end loop;
    if fn.oid in ('public.get_standalone_workspace(text)'::regprocedure,'public.get_standalone_import(uuid)'::regprocedure,
      'public.save_standalone_workspace(text,integer,uuid,jsonb,jsonb)'::regprocedure) then
      execute 'grant execute on function '||object_name||' to authenticated';
    end if;
  end loop;
end $$;
commit;
