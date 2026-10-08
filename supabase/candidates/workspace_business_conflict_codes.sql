-- Deterministic application conflicts must not request PostgREST retries (40001).
-- Requires the installed Ideas, Home lifecycle and Home attachment RPCs.
-- Preserve exact installed definitions and all catalog metadata except these 11 codes.
-- One DO statement keeps all five replacements atomic; repeated application is safe.
do $workspace_business_conflict_codes$
declare
  spec record;
  target regprocedure;
  original text;
  patched text;
  metadata jsonb;
  conflict record;
  old_raise text;
  new_raise text;
  old_count integer;
  new_count integer;
begin
  for spec in select * from (values
    ('public.update_idea(uuid,integer,uuid,jsonb)', '{"revision_conflict":2}'::jsonb),
    ('public.create_idea_brand(uuid,integer,uuid,jsonb,text)', '{"revision_conflict":1,"idea_link_capacity":1}'::jsonb),
    ('public.attach_idea_to_project(jsonb)', '{"request_conflict":1,"revision_conflict":1}'::jsonb),
    ('public.promote_standalone_workspace(jsonb)', '{"request_conflict":1,"revision_conflict":1}'::jsonb),
    ('public.save_attached_home_project(jsonb,text)', '{"home_request_conflict":1,"home_attachment_conflict":2}'::jsonb)
  ) as targets(signature, conflicts) loop
    target := spec.signature::regprocedure;
    original := pg_get_functiondef(target);
    patched := original;
    select to_jsonb(p) - 'prosrc' into metadata from pg_proc p where p.oid = target;
    for conflict in select key as message, value::integer as expected_count from jsonb_each_text(spec.conflicts) loop
      old_raise := format('raise exception %L using errcode=%L', conflict.message, '40001');
      new_raise := format('raise exception %L using errcode=%L', conflict.message, 'PT409');
      old_count := (length(original) - length(replace(original, old_raise, ''))) / length(old_raise);
      new_count := (length(original) - length(replace(original, new_raise, ''))) / length(new_raise);
      if old_count + new_count <> conflict.expected_count then
        raise exception 'Unexpected workspace business conflict definition: % / %', spec.signature, conflict.message;
      end if;
      patched := replace(patched, old_raise, new_raise);
    end loop;
    if position('40001' in patched) <> 0 then
      raise exception 'Unexpected retryable SQLSTATE in workspace business definition: %', spec.signature;
    end if;
    if patched <> original then
      execute patched;
    end if;
    if pg_get_functiondef(target) is distinct from patched or
      (select to_jsonb(p) - 'prosrc' from pg_proc p where p.oid = target) is distinct from metadata then
      raise exception 'Workspace business function metadata changed unexpectedly: %', spec.signature;
    end if;
  end loop;
end
$workspace_business_conflict_codes$;
