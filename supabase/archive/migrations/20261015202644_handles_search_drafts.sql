-- Optional authored Handles search state, preserving all existing draft and
-- provider-evidence boundaries. Historical v1 payloads remain accepted as-is.
begin;

create function fluid_private.handles_search_preset(v jsonb) returns boolean
language plpgsql immutable set search_path='' as $$
declare item jsonb; options jsonb;
begin
  if not fluid_private.standalone_keys(v,array['names','imports','platforms','options'])
    or not fluid_private.standalone_text(v->'names',3000)
    or jsonb_typeof(v->'imports') is distinct from 'array' or jsonb_array_length(v->'imports')>30
    or jsonb_typeof(v->'platforms') is distinct from 'array' or jsonb_array_length(v->'platforms')>5 then return false; end if;
  if (select count(*)<>count(distinct value) from jsonb_array_elements(v->'imports'))
    or (select count(*)<>count(distinct value) from jsonb_array_elements(v->'platforms')) then return false; end if;
  for item in select value from jsonb_array_elements(v->'imports') loop
    if not fluid_private.standalone_text(item,160) then return false; end if;
  end loop;
  for item in select value from jsonb_array_elements(v->'platforms') loop
    if jsonb_typeof(item) is distinct from 'string' or (item#>>'{}') not in('instagram','tiktok','youtube','x','linkedin') then return false; end if;
  end loop;
  options:=v->'options';
  if not fluid_private.standalone_keys(options,array['prefixes','suffixes','separators'])
    or not fluid_private.standalone_text(options->'prefixes',200) or not fluid_private.standalone_text(options->'suffixes',200)
    or jsonb_typeof(options->'separators') is distinct from 'array' or jsonb_array_length(options->'separators')>3 then return false; end if;
  if (select count(*)<>count(distinct value) from jsonb_array_elements(options->'separators')) then return false; end if;
  for item in select value from jsonb_array_elements(options->'separators') loop
    if jsonb_typeof(item) is distinct from 'string' or (item#>>'{}') not in('','.','_') then return false; end if;
  end loop;
  return true;
exception when others then return false;
end $$;

create function fluid_private.handles_search_payload(v jsonb) returns boolean
language plpgsql immutable set search_path='' as $$
declare item jsonb;
begin
  if not fluid_private.standalone_keys(v,array['names','nameDraft','imports','platforms','options','title','list','savedSearches'])
    or not fluid_private.standalone_text(v->'nameDraft',3000)
    or not fluid_private.standalone_text(v->'title',160) or not fluid_private.standalone_text(v->'list',160)
    or not fluid_private.handles_search_preset(v-array['nameDraft','title','list','savedSearches'])
    or jsonb_typeof(v->'savedSearches') is distinct from 'array' or jsonb_array_length(v->'savedSearches')>20 then return false; end if;
  if (select count(*)<>count(distinct value->>'id') from jsonb_array_elements(v->'savedSearches')) then return false; end if;
  for item in select value from jsonb_array_elements(v->'savedSearches') loop
    if not fluid_private.standalone_keys(item,array['id','names','imports','platforms','options'])
      or not fluid_private.standalone_text(item->'id',36,36)
      or (item->>'id')!~'^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$'
      or not fluid_private.handles_search_preset(item-'id') then return false; end if;
  end loop;
  return true;
exception when others then return false;
end $$;

-- Remove any inherited EXECUTE defaults from exactly the two new helpers.
do $$ declare obj record; access record; begin
  for obj in select p.oid,p.proowner from pg_proc p where p.oid in(
    'fluid_private.handles_search_preset(jsonb)'::regprocedure,
    'fluid_private.handles_search_payload(jsonb)'::regprocedure
  ) loop
    for access in select distinct a.grantee,r.rolname from pg_proc p
      cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
      left join pg_roles r on r.oid=a.grantee where p.oid=obj.oid and a.grantee<>obj.proowner loop
      execute 'revoke all on function '||obj.oid::regprocedure::text||' from '||case when access.grantee=0 then 'PUBLIC' else quote_ident(access.rolname) end;
    end loop;
  end loop;
end $$;

-- Patch only the Handles top-level key check. The existing byte bounds,
-- bundles, account declarations, provider-evidence rejection and other tools
-- retain their exact source; OID, grants and all other metadata must match.
do $$
declare
  target regprocedure:='fluid_private.standalone_payload(text,jsonb)'::regprocedure;
  original text;
  patched text;
  predecessor_hash text;
  metadata jsonb;
  old_check text:='if not fluid_private.standalone_keys(v,array[''version'',''bundles'']) or jsonb_typeof(v->''bundles'')<>''array''';
  new_check text:='if not fluid_private.standalone_keys(v-''search'',array[''version'',''bundles'']) or (v ? ''search'' and not fluid_private.handles_search_payload(v->''search'')) or jsonb_typeof(v->''bundles'')<>''array''';
begin
  select encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') into predecessor_hash from pg_proc p where p.oid=target;
  -- The second reviewed predecessor adds only optional Domains shortlistedDomains
  -- validation. Preserve that hosted addition byte-for-byte when it is present.
  if predecessor_hash is null or predecessor_hash not in(
    '5e7cbe36b4e7921830dd159d1653a3db32dab0115f42b5193ed982d21ff650b1',
    'cd1f2d2c36a2941265ee5e16f849a7afc48aeddd03be6af54c25210dd9f34d94'
  ) then
    raise exception 'Unexpected standalone payload predecessor';
  end if;
  original:=pg_get_functiondef(target);
  select to_jsonb(p)-'prosrc' into metadata from pg_proc p where p.oid=target;
  if (length(original)-length(replace(original,old_check,'')))/length(old_check)<>1 then
    raise exception 'Unexpected Handles payload boundary';
  end if;
  patched:=replace(original,old_check,new_check);
  execute patched;
  if pg_get_functiondef(target) is distinct from patched or
    (select to_jsonb(p)-'prosrc' from pg_proc p where p.oid=target) is distinct from metadata then
    raise exception 'Standalone payload metadata changed unexpectedly';
  end if;
end $$;

commit;
