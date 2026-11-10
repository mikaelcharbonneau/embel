-- Keep explicit Naming question acknowledgements in the existing owner/CAS view.
-- No preference, provider snapshot, worker privilege, or historical row changes.
begin;

create or replace function public.save_naming_view(p_project_id uuid,p_expected_revision integer,p_view jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_owner uuid:=auth.uid(); v_session public.naming_sessions; v_key text; v_chat jsonb; v_answer jsonb;
begin
 if p_expected_revision is null or p_expected_revision<1 or jsonb_typeof(p_view) is distinct from 'object'
  or p_view-array['pane','conversationOpen','filter','query','visibleBatchId','scrollCandidateId','workshopCandidateId','namingChat']<>'{}'
  or not(p_view ?& array['pane','conversationOpen','filter','query','visibleBatchId','scrollCandidateId','workshopCandidateId'])
  or jsonb_typeof(p_view->'pane')<>'string' or jsonb_typeof(p_view->'filter')<>'string' or p_view->>'pane' not in('results','screening','workshop') or jsonb_typeof(p_view->'conversationOpen')<>'boolean'
  or p_view->>'filter' not in('all','retained','favorite','saved') or jsonb_typeof(p_view->'query')<>'string' or length(p_view->>'query')>200 then raise exception 'invalid_view' using errcode='22023'; end if;
 if p_view ? 'namingChat' then
  v_chat:=p_view->'namingChat';
  if jsonb_typeof(v_chat) is distinct from 'object' or v_chat-array['version','preferencesVersion','confirmed']<>'{}'
   or not(v_chat ?& array['version','preferencesVersion','confirmed']) or v_chat->'version' is distinct from '1'::jsonb
   or jsonb_typeof(v_chat->'preferencesVersion') is distinct from 'number' or v_chat->>'preferencesVersion' !~ '^[1-9][0-9]{0,9}$'
   or jsonb_typeof(v_chat->'confirmed') is distinct from 'object'
   or (v_chat->'confirmed')-array['approaches','directness','language','length','fragments']<>'{}' then raise exception 'invalid_view' using errcode='22023'; end if;
  if (v_chat->>'preferencesVersion')::bigint>2147483647 then raise exception 'invalid_view' using errcode='22023'; end if;
  for v_key,v_answer in select key,value from jsonb_each(v_chat->'confirmed') loop
   if jsonb_typeof(v_answer) is distinct from 'string' or length(v_answer#>>'{}')>(case v_key when 'approaches' then 400 when 'directness' then 32 when 'language' then 200 when 'length' then 32 else 13200 end) then raise exception 'invalid_view' using errcode='22023'; end if;
  end loop;
 end if;
 v_session:=fluid_private.ensure_naming_session(p_project_id,v_owner);
 if v_session.view_revision<>p_expected_revision then raise exception 'view_conflict' using errcode='PT409'; end if;
 -- Older view bodies remain accepted and cannot erase a newer acknowledgement.
 if not(p_view ? 'namingChat') and v_session.view_state ? 'namingChat' then p_view:=p_view||jsonb_build_object('namingChat',v_session.view_state->'namingChat'); end if;
 -- An unchanged checkpoint can accompany ordinary navigation after a preference
 -- edit. New confirmations must bind the exact current immutable V2 preference.
 if p_view ? 'namingChat' and p_view->'namingChat' is distinct from v_session.view_state->'namingChat' then
  if (p_view->'namingChat'->>'preferencesVersion')::integer is distinct from v_session.preferences_version
   or not exists(select 1 from public.naming_preferences where project_id=p_project_id and owner_id=v_owner and version=v_session.preferences_version and preferences->'version'='2'::jsonb)
   then raise exception 'preferences_conflict' using errcode='PT409'; end if;
 end if;
 if p_view->>'visibleBatchId' is not null and not exists(select 1 from public.naming_batches where id=(p_view->>'visibleBatchId')::uuid and project_id=p_project_id and owner_id=v_owner) then raise exception 'not_found' using errcode='P0002'; end if;
 foreach v_key in array array['scrollCandidateId','workshopCandidateId'] loop
  if p_view->>v_key is not null and not exists(select 1 from public.name_candidates where id=(p_view->>v_key)::uuid and project_id=p_project_id and owner_id=v_owner) then raise exception 'not_found' using errcode='P0002'; end if;
 end loop;
 update public.naming_sessions set view_state=p_view,view_revision=view_revision+1,revision=revision+1,updated_at=clock_timestamp() where project_id=p_project_id and owner_id=v_owner returning * into v_session;
 return jsonb_build_object('session',fluid_private.naming_session_dto(v_session));
end $$;

commit;
