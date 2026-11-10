-- Add a narrowly witnessed projection for incorrect provider quote offsets.
-- Original provider items, receipts, source records and historical artifacts are
-- immutable. Only source-derived UTF-16 start/end positions may differ.
begin;

create function fluid_private.naming_brain_artifact_output_matches(p_text text,p_artifact jsonb,p_item_id text)
returns boolean language plpgsql immutable set search_path='' as $$
declare witness jsonb; raw_output jsonb; projected jsonb; finding jsonb; evidence jsonb; source jsonb;
 source_key jsonb; source_keys jsonb; excerpt text; quote_text text; position integer; quote_length integer;
 start_offset integer; finding_index integer; evidence_index integer; supported boolean;
begin
 if not(p_artifact ? 'quoteBinding') then
  return fluid_private.naming_brain_json_matches(p_text,p_artifact->'output');
 end if;
 witness:=p_artifact->'quoteBinding';
 if jsonb_typeof(witness) is distinct from 'object'
 or witness-array['version','itemId','itemContentHash']<>'{}'::jsonb
 or not(witness ?& array['version','itemId','itemContentHash'])
 or witness->'version' is distinct from '1'::jsonb
 or jsonb_typeof(witness->'itemId') is distinct from 'string'
 or length(witness->>'itemId') not between 1 and 300
 or witness->>'itemId' is distinct from p_item_id
 or jsonb_typeof(witness->'itemContentHash') is distinct from 'string'
 or coalesce(witness->>'itemContentHash','')!~'^[0-9a-f]{64}$'
 or witness->>'itemContentHash' is distinct from encode(sha256(convert_to(p_text,'UTF8')),'hex')
 or p_artifact#>>'{output,role}' is distinct from 'verifier'
 or p_text is null or octet_length(p_text)>524288 then return false; end if;
 raw_output:=p_text::jsonb;
 if jsonb_typeof(raw_output) is distinct from 'object'
 or raw_output-array['role','findings']<>'{}'::jsonb
 or not(raw_output ?& array['role','findings']) or raw_output->>'role' is distinct from 'verifier'
 or jsonb_typeof(raw_output->'findings') is distinct from 'array'
 or jsonb_array_length(raw_output->'findings')>1600
 or jsonb_typeof(p_artifact->'sources') is distinct from 'array'
 or jsonb_array_length(p_artifact->'sources')>80 then return false; end if;
 if exists(select 1 from jsonb_array_elements(p_artifact->'sources') row
  group by row->>'sourceKey' having count(*)<>1) then return false; end if;
 for source in select value from jsonb_array_elements(p_artifact->'sources') loop
  if jsonb_typeof(source) is distinct from 'object'
  or jsonb_typeof(source->'sourceKey') is distinct from 'string'
  or length(source->>'sourceKey') not between 1 and 100
  or coalesce(source->>'sourceKey','')!~'^[A-Za-z0-9][A-Za-z0-9._:-]*$'
  or coalesce(source->>'evidenceStatus','') not in('retrieved','unretrieved') then return false; end if;
  if source->>'evidenceStatus'='retrieved' then
   excerpt:=source->>'excerpt';
   if jsonb_typeof(source->'excerpt') is distinct from 'string' or length(excerpt)=0
   or char_length(excerpt)+(select count(*) from regexp_split_to_table(excerpt,'') c where ascii(nullif(c,''))>65535)>8000
   or jsonb_typeof(source->'contentHash') is distinct from 'string'
   or coalesce(source->>'contentHash','')!~'^[0-9a-f]{64}$'
   or source->>'contentHash' is distinct from encode(sha256(convert_to(excerpt,'UTF8')),'hex') then return false; end if;
  elsif source->'excerpt' is distinct from 'null'::jsonb or source->'contentHash' is distinct from 'null'::jsonb then return false;
  end if;
 end loop;
 projected:=raw_output;
 for finding,finding_index in select value,(ordinality-1)::integer from jsonb_array_elements(raw_output->'findings') with ordinality loop
  if jsonb_typeof(finding) is distinct from 'object'
  or finding-array['assignmentKey','candidateKey','claimKey','status','supportedWording','sourceKeys','evidence','supportsPrimaryApproach','explanation']<>'{}'::jsonb
  or not(finding ?& array['assignmentKey','candidateKey','claimKey','status','supportedWording','sourceKeys','evidence','supportsPrimaryApproach','explanation'])
  or jsonb_typeof(finding->'sourceKeys') is distinct from 'array' or jsonb_array_length(finding->'sourceKeys')>20
  or jsonb_typeof(finding->'evidence') is distinct from 'array' or jsonb_array_length(finding->'evidence')>10
  or coalesce(finding->>'status','') not in('supported','corrected','unresolved','contradicted')
  or jsonb_typeof(finding->'supportsPrimaryApproach') is distinct from 'boolean' then return false; end if;
  foreach excerpt in array array['assignmentKey','candidateKey','claimKey'] loop
   if jsonb_typeof(finding->excerpt) is distinct from 'string'
   or length(finding->>excerpt) not between 1 and 100
   or coalesce(finding->>excerpt,'')!~'^[A-Za-z0-9][A-Za-z0-9._:-]*$' then return false; end if;
  end loop;
  if jsonb_typeof(finding->'explanation') is distinct from 'string' or length(finding->>'explanation') not between 1 and 2000 then return false; end if;
  source_keys:=finding->'sourceKeys';
  if exists(select 1 from jsonb_array_elements(source_keys) row group by row having count(*)<>1) then return false; end if;
  for source_key in select value from jsonb_array_elements(source_keys) loop
   if jsonb_typeof(source_key) is distinct from 'string' or length(source_key#>>'{}') not between 1 and 100
   or coalesce(source_key#>>'{}','')!~'^[A-Za-z0-9][A-Za-z0-9._:-]*$'
   or not exists(select 1 from jsonb_array_elements(p_artifact->'sources') row where row->'sourceKey'=source_key) then return false; end if;
  end loop;
  supported:=finding->>'status' in('supported','corrected');
  if supported then
   if jsonb_typeof(finding->'supportedWording') is distinct from 'string'
   or length(finding->>'supportedWording') not between 1 and 2000
   or jsonb_array_length(source_keys)=0 or jsonb_array_length(finding->'evidence')=0
   or exists(select 1 from jsonb_array_elements(source_keys) key where not exists(
    select 1 from jsonb_array_elements(finding->'evidence') row where row->'sourceKey'=key)) then return false; end if;
  elsif finding->'supportedWording' is distinct from 'null'::jsonb or finding->'supportsPrimaryApproach' is distinct from 'false'::jsonb then return false;
  end if;
  for evidence,evidence_index in select value,(ordinality-1)::integer from jsonb_array_elements(finding->'evidence') with ordinality loop
   if jsonb_typeof(evidence) is distinct from 'object' or evidence-array['sourceKey','start','end','quote']<>'{}'::jsonb
   or not(evidence ?& array['sourceKey','start','end','quote'])
   or jsonb_typeof(evidence->'sourceKey') is distinct from 'string'
   or not(source_keys ? (evidence->>'sourceKey'))
   or jsonb_typeof(evidence->'quote') is distinct from 'string'
   or jsonb_typeof(evidence->'start') is distinct from 'number' or jsonb_typeof(evidence->'end') is distinct from 'number' then return false; end if;
   if (evidence->>'start')::numeric not between 0 and 7999 or (evidence->>'end')::numeric not between 1 and 8000
   or trunc((evidence->>'start')::numeric)<>(evidence->>'start')::numeric
   or trunc((evidence->>'end')::numeric)<>(evidence->>'end')::numeric
   or (evidence->>'end')::numeric<=(evidence->>'start')::numeric then return false; end if;
   quote_text:=evidence->>'quote';
   select coalesce(sum(case when ascii(c)>65535 then 2 else 1 end),0)::integer into quote_length
    from regexp_split_to_table(quote_text,'') c where c<>'';
   if quote_length not between 1 and 2000 then return false; end if;
   select value into source from jsonb_array_elements(p_artifact->'sources') where value->'sourceKey'=evidence->'sourceKey';
   if source->>'evidenceStatus' is distinct from 'retrieved' then return false; end if;
   excerpt:=source->>'excerpt';
   -- Preserve an already exact declared span, including either occurrence of a
   -- repeated quotation. Convert only real UTF-16 boundaries to codepoints;
   -- a hint inside a surrogate pair or beyond the source cannot be exact.
   if (evidence->>'end')::numeric::integer-(evidence->>'start')::numeric::integer=quote_length then
    select n::integer into position from (
     select n,sum(case when ascii(c)>65535 then 2 else 1 end) over(order by n)
      -case when ascii(c)>65535 then 2 else 1 end boundary
     from regexp_split_to_table(excerpt,'') with ordinality chars(c,n) where c<>''
    ) boundaries where boundary=(evidence->>'start')::numeric::integer;
    if position is not null and substr(excerpt,position,char_length(quote_text)) collate "C"=quote_text collate "C" then continue; end if;
   end if;
   -- Only an inaccurate span needs a unique exact source-backed correction.
   position:=strpos(excerpt collate "C",quote_text collate "C");
   -- Start the second search one codepoint later, so overlapping matches count.
   if position=0 or strpos(substr(excerpt,position+1) collate "C",quote_text collate "C")<>0 then return false; end if;
   select coalesce(sum(case when ascii(c)>65535 then 2 else 1 end),0)::integer into start_offset
    from regexp_split_to_table(substr(excerpt,1,position-1),'') c where c<>'';
   projected:=jsonb_set(projected,array['findings',finding_index::text,'evidence',evidence_index::text,'start'],to_jsonb(start_offset),false);
   projected:=jsonb_set(projected,array['findings',finding_index::text,'evidence',evidence_index::text,'end'],to_jsonb(start_offset+quote_length),false);
  end loop;
 end loop;
 return projected is distinct from raw_output and projected=p_artifact->'output';
exception when data_exception then return false;
end $$;
revoke all on function fluid_private.naming_brain_artifact_output_matches(text,jsonb,text) from public,anon,authenticated,service_role;

do $patch$
declare definition text; original text; replacement text;
begin
 if not exists(select 1 from pg_proc p where p.oid='fluid_private.naming_brain_call_completed(fluid_private.naming_brain_calls)'::regprocedure
  and md5(p.prosrc)='fcdbf12f1495f52b75bbbc7b4b99f4cd' and not p.prosecdef and p.provolatile='s'
  and p.proconfig=array['search_path=""'] and not p.proleakproof and p.proowner=(select oid from pg_roles where rolname=current_user)) then
  raise exception 'unexpected_naming_quote_binding_predecessor';
 end if;
 definition:=pg_get_functiondef('fluid_private.naming_brain_call_completed(fluid_private.naming_brain_calls)'::regprocedure);
 original:=$old$fluid_private.naming_brain_json_matches(final.text,a.artifact->'output')$old$;
 replacement:=$new$fluid_private.naming_brain_artifact_output_matches(final.text,a.artifact,pr.payload->>'itemId')$new$;
 if (length(definition)-length(replace(definition,original,'')))/length(original)<>1 then raise exception 'unexpected_naming_quote_binding_fragment'; end if;
 execute replace(definition,original,replacement);
end $patch$;
commit;
