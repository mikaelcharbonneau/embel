-- Manual Domains shortlist choices only. Hosted activation requires separate approval.
-- Preserve legacy v1 JSON exactly: no row rewrite, new RPC, grant or ownership change.
-- Patch the one validator branch while retaining the installed function's metadata.
do $domain_shortlists$
declare
  target regprocedure := 'fluid_private.standalone_payload(text,jsonb)'::regprocedure;
  original text := pg_get_functiondef(target);
  patched text;
  metadata jsonb;
  old_branch text := $old$
    if not fluid_private.standalone_keys(v,array['version','input','extensions','candidates']) or not fluid_private.standalone_text(v->'input',4000)
      or jsonb_typeof(v->'extensions')<>'array' or jsonb_array_length(v->'extensions')>10 or jsonb_typeof(v->'candidates')<>'array' or jsonb_array_length(v->'candidates')>200
      or octet_length(fluid_private.standalone_compact(v))>24000 then return false; end if;
$old$;
  new_branch text := $new$
    -- The four original keys remain required; only shortlistedDomains is optional.
    if not fluid_private.standalone_keys(v-'shortlistedDomains',array['version','input','extensions','candidates']) or not fluid_private.standalone_text(v->'input',4000)
      or jsonb_typeof(v->'extensions')<>'array' or jsonb_array_length(v->'extensions')>10 or jsonb_typeof(v->'candidates')<>'array' or jsonb_array_length(v->'candidates')>200
      or octet_length(fluid_private.standalone_compact(v))>24000 then return false; end if;
    if v ? 'shortlistedDomains' then
      if jsonb_typeof(v->'shortlistedDomains') is distinct from 'array' or jsonb_array_length(v->'shortlistedDomains')>200 then return false; end if;
      if (select count(*)<>count(distinct value) from jsonb_array_elements(v->'shortlistedDomains')) then return false; end if;
      for item in select value from jsonb_array_elements(v->'shortlistedDomains') loop
        if jsonb_typeof(item)<>'string' or not fluid_private.standalone_domain(item#>>'{}') then return false; end if;
      end loop;
    end if;
$new$;
  old_count integer;
  new_count integer;
begin
  select to_jsonb(p) - 'prosrc' into metadata from pg_proc p where p.oid=target;
  old_count := (length(original)-length(replace(original,old_branch,'')))/length(old_branch);
  new_count := (length(original)-length(replace(original,new_branch,'')))/length(new_branch);
  if old_count+new_count<>1 then
    raise exception 'Unexpected standalone Domains validator definition';
  end if;
  patched := replace(original,old_branch,new_branch);
  if patched<>original then execute patched; end if;
  if pg_get_functiondef(target) is distinct from patched or
    (select to_jsonb(p) - 'prosrc' from pg_proc p where p.oid=target) is distinct from metadata then
    raise exception 'Standalone Domains validator metadata changed unexpectedly';
  end if;
end
$domain_shortlists$;
