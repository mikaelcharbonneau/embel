-- Business conflicts must not request PostgREST transaction retries (SQLSTATE 40001).
-- Preserve the exact installed function and all catalog metadata except its three codes.
do $workspace_conflict_codes$
declare
  target regprocedure := 'public.save_standalone_workspace(text,integer,uuid,jsonb,jsonb)'::regprocedure;
  original text := pg_get_functiondef(target);
  patched text := original;
  metadata jsonb;
  conflict text;
  old_raise text;
  new_raise text;
  old_count integer;
  new_count integer;
begin
  select to_jsonb(p) - 'prosrc' into metadata from pg_proc p where p.oid = target;
  foreach conflict in array array['request_conflict','revision_conflict','source_conflict'] loop
    old_raise := format('raise exception %L using errcode=%L', conflict, '40001');
    new_raise := format('raise exception %L using errcode=%L', conflict, 'PT409');
    old_count := (length(original) - length(replace(original, old_raise, ''))) / length(old_raise);
    new_count := (length(original) - length(replace(original, new_raise, ''))) / length(new_raise);
    if old_count + new_count <> 1 then
      raise exception 'Unexpected standalone workspace conflict definition: %', conflict;
    end if;
    patched := replace(patched, old_raise, new_raise);
  end loop;
  if position('40001' in patched) <> 0 then
    raise exception 'Unexpected retryable SQLSTATE in standalone workspace definition';
  end if;
  if patched <> original then
    execute patched;
  end if;
  if pg_get_functiondef(target) is distinct from patched or
    (select to_jsonb(p) - 'prosrc' from pg_proc p where p.oid = target) is distinct from metadata then
    raise exception 'Standalone workspace function metadata changed unexpectedly';
  end if;
end
$workspace_conflict_codes$;
