-- Supplement an undersized terminal brainstorm from its original saved Responses
-- output. Only the local database owner may submit candidates, after applying
-- the current TypeScript construction validator to the frozen brief. No network.
begin;

create table fluid_private.naming_brainstorm_supplemental_members (
 candidate_id uuid primary key references public.name_candidates(id),
 run_id uuid not null, owner_id uuid not null, project_id uuid not null,
 call_id uuid not null references fluid_private.naming_brainstorm_publications(call_id),
 event_id uuid not null references fluid_private.naming_brainstorm_events(event_id),
 completion_id uuid not null references fluid_private.naming_brainstorm_completions(id),
 raw_index integer not null check (raw_index between 0 and 119),
 created_at timestamptz not null default clock_timestamp(),
 foreign key (run_id,owner_id,project_id) references fluid_private.naming_brain_runs(id,owner_id,project_id),
 unique(call_id,raw_index)
);
alter table fluid_private.naming_brainstorm_supplemental_members enable row level security;
alter table fluid_private.naming_brainstorm_supplemental_members force row level security;
create trigger naming_brainstorm_supplemental_no_rewrite before update or delete
 on fluid_private.naming_brainstorm_supplemental_members for each row execute function fluid_private.prevent_history_change();

-- Restrict the parser to the single completed assistant JSON message used in
-- these requests. It never accepts an event's already-filtered candidate list
-- as a replacement for the text the provider actually returned.
create function fluid_private.naming_brainstorm_supplemental_raw_v1(ev jsonb, model text, target integer)
returns jsonb language plpgsql immutable strict set search_path='' as $$
declare b jsonb:=ev->'response'; msg jsonb; part jsonb; raw jsonb; content text;
begin
 if ev->>'kind' is distinct from 'completed' or b->>'status' is distinct from 'completed'
  or b->>'id' is distinct from ev->>'responseId' or not coalesce((b->>'id')~'^resp_[A-Za-z0-9_-]{1,194}$',false)
  or b->>'model' is distinct from model or ev->>'model' is distinct from model
  or coalesce(b->'error','null')<>'null' or coalesce(b->'incomplete_details','null')<>'null'
  or jsonb_typeof(b->'output') is distinct from 'array' or jsonb_array_length(b->'output')>100
 then raise exception 'invalid_supplemental_response';end if;
 for msg in select value from jsonb_array_elements(b->'output') loop
  if msg->>'type'='reasoning' then continue;end if;
  if msg->>'type' is distinct from 'message' or msg->>'role' is distinct from 'assistant'
   or msg->>'status' is distinct from 'completed' or jsonb_typeof(msg->'content') is distinct from 'array'
  then raise exception 'invalid_supplemental_message';end if;
  for part in select value from jsonb_array_elements(msg->'content') loop
   if content is not null or part->>'type' is distinct from 'output_text' or jsonb_typeof(part->'text') is distinct from 'string'
   then raise exception 'invalid_supplemental_text';end if;
   content:=part->>'text';
  end loop;
 end loop;
 if content is null or octet_length(content)>262144 then raise exception 'invalid_supplemental_text';end if;
 raw:=content::jsonb;
 if jsonb_typeof(raw->'candidates') is distinct from 'array' or jsonb_array_length(raw->'candidates')>target
 then raise exception 'invalid_supplemental_candidates';end if;
 return raw->'candidates';
end $$;

create function fluid_private.repair_partial_brainstorm_v1(p_project_id uuid,p_run_id uuid,p_candidates jsonb)
returns jsonb language plpgsql volatile set search_path='' set lock_timeout='1s' as $$
declare r fluid_private.naming_brain_runs; j public.jobs; h fluid_private.naming_brain_heads; p public.projects;
 s public.naming_sessions; comp fluid_private.naming_brainstorm_completions; c fluid_private.naming_brainstorm_calls;
 ev fluid_private.naming_brainstorm_events; member jsonb; raw jsonb; source jsonb; origin jsonb; candidate uuid;
 source_index integer; nm text; why text; approach text; ident text; n integer; total integer; prior integer; added integer:=0;
 prefs jsonb; route_count integer; existing fluid_private.naming_brainstorm_supplemental_members;
 caution constant text:='Unchecked brainstorm. Research and screening are needed before use.';
begin
 if p_candidates is null or jsonb_typeof(p_candidates)<>'array' or jsonb_array_length(p_candidates) not between 1 and 99
  or octet_length(p_candidates::text)>200000 then raise exception 'invalid_supplemental_request';end if;
 select * into strict r from fluid_private.naming_brain_runs where id=p_run_id and project_id=p_project_id;
 if not exists(select 1 from fluid_private.portable_development_installation d where d.singleton and d.project_id=r.deployment_id and d.origin~'^http://127[.]0[.]0[.]1:[0-9]+$')
 then raise exception 'supplemental_local_target_required';end if;
 if not pg_try_advisory_xact_lock(hashtextextended(r.owner_id::text,723902)) then raise exception 'supplemental_owner_busy';end if;
 perform 1 from auth.users where id=r.owner_id for share nowait;
 perform 1 from fluid_private.shared_accounts where owner_id=r.owner_id for share nowait;
 select * into strict p from public.projects where id=r.project_id and owner_id=r.owner_id for update nowait;
 select * into strict s from public.naming_sessions where project_id=p.id and owner_id=p.owner_id for update nowait;
 select * into strict h from fluid_private.naming_brain_heads where project_id=p.id and owner_id=p.owner_id for update nowait;
 select * into strict r from fluid_private.naming_brain_runs where id=p_run_id and project_id=p.id and owner_id=p.owner_id for update nowait;
 select * into strict j from public.jobs where id=r.job_id and owner_id=r.owner_id and project_id=r.project_id for share nowait;
 select * into strict comp from fluid_private.naming_brainstorm_completions where run_id=r.id and owner_id=r.owner_id and project_id=r.project_id;
 prefs:=r.snapshot->'preferences';route_count:=jsonb_array_length(prefs->'approaches');
 if not fluid_private.naming_brainstorm_job(j.id) or fluid_private.shared_account_customer_active(r.owner_id) is distinct from true
  or j.state<>'partial' or j.error_code is distinct from 'brainstorm_target_shortfall' or j.cancel_requested_at is not null
  or j.lease_token is not null or j.lease_expires_at is not null or j.billing_mode<>'openai_api'
  or comp.state<>'partial' or r.superseded or r.recovery_mode<>'observe_only'
  or h.current_run_id is distinct from r.id or h.paused or h.coverage_epoch is distinct from h.writer_epoch
  or p.deleted_at is not null or p.deletion_requested_at is not null or p.current_revision is distinct from (r.snapshot->>'contextRevision')::integer
  or s.preferences_version is distinct from (r.snapshot->>'preferencesVersion')::integer
  or h.steering_revision is distinct from (r.snapshot->>'steeringRevision')::bigint
  or h.feedback_revision is distinct from (r.snapshot->>'feedbackRevision')::bigint
  or (select fluid_private.naming_strategy_basis(rev.context) from public.project_revisions rev
   where rev.project_id=p.id and rev.owner_id=p.owner_id and rev.revision=p.current_revision) is distinct from r.snapshot->'strategyBasis'
  or not exists(select 1 from public.naming_preferences pref where pref.owner_id=r.owner_id and pref.project_id=r.project_id
    and pref.version=s.preferences_version and pref.preferences=prefs)
  or not exists(select 1 from fluid_private.shared_worker_executions x where x.job_id=j.id and x.project_id=p.id and x.owner_id=p.owner_id
    and x.state='closed' and x.lane='naming' and x.deployment_id=r.deployment_id and x.policy_identity=r.policy_identity)
  or route_count is null or route_count not between 1 and 11
 then raise exception 'supplemental_run_not_current';end if;
 select count(*) into prior from fluid_private.naming_brainstorm_supplemental_members where run_id=r.id;
 select count(*) into total from fluid_private.naming_brain_feed_entries where run_id=r.id;
 if total<>comp.published_count+prior or jsonb_array_length(p_candidates)<>100-comp.published_count
  or prior not in(0,jsonb_array_length(p_candidates))
  or (select count(distinct (v->>'callId',v->>'rawIndex')) from jsonb_array_elements(p_candidates) v)<>jsonb_array_length(p_candidates)
 then raise exception 'supplemental_membership_changed';end if;

 for member in select value from jsonb_array_elements(p_candidates) loop
  if jsonb_typeof(member) is distinct from 'object' or not member ?& array['callId','rawIndex','value','identityKey','rationale','primaryApproach','graphemeCount']
   or member-array['callId','rawIndex','value','identityKey','rationale','primaryApproach','graphemeCount']<>'{}'
   or jsonb_typeof(member->'rawIndex') is distinct from 'number' or (member->>'rawIndex') !~ '^(0|[1-9][0-9]{0,2})$'
  then raise exception 'invalid_supplemental_member';end if;
  source_index:=(member->>'rawIndex')::integer;
  select * into strict c from fluid_private.naming_brainstorm_calls where call_id=(member->>'callId')::uuid
    and run_id=r.id and project_id=r.project_id and owner_id=r.owner_id;
  select * into strict ev from fluid_private.naming_brainstorm_events where call_id=c.call_id and kind='completed';
  if c.request->>'model' is distinct from r.policy->>'model' or c.request#>>'{metadata,embel_job_id}' is distinct from j.id::text
   or c.request#>>'{metadata,embel_run_id}' is distinct from r.id::text or c.request#>>'{metadata,embel_call_index}' is distinct from c.call_index::text
   or c.request#>>'{text,format,name}' is distinct from 'naming_brainstorm_balanced_v2'
   or ev.payload->>'callId' is distinct from c.call_id::text
   or not exists(select 1 from fluid_private.naming_brainstorm_publications pub where pub.call_id=c.call_id and pub.run_id=r.id
     and pub.project_id=r.project_id and pub.owner_id=r.owner_id)
  then raise exception 'invalid_supplemental_call';end if;
  raw:=fluid_private.naming_brainstorm_supplemental_raw_v1(ev.payload,r.policy->>'model',c.candidate_target);source:=raw->source_index;
  nm:=btrim(source->>'value');why:=btrim(source->>'rationale');approach:=source->>'primaryApproach';
  -- Deliberately narrow subset for which SQL can reproduce the ICU grapheme
  -- count and identity exactly. Ordinary product generation remains multilingual.
  ident:=replace(replace(lower(nm collate "C"),' ',''),'-','');n:=length(nm);
  if jsonb_typeof(source) is distinct from 'object' or source-array['value','rationale','primaryApproach','construction']<>'{}'
   or jsonb_typeof(source->'value') is distinct from 'string' or coalesce(nm collate "C" !~ '^[a-zA-Z0-9 -]+$',true)
   or length(ident) not between 1 and 100 or n not between 1 and 100
   or jsonb_typeof(source->'rationale') is distinct from 'string' or why~'[[:cntrl:]]' or length(why) not between 1 and 600
   or jsonb_typeof(source->'construction') is distinct from 'array' or jsonb_array_length(source->'construction')>12
   or exists(select 1 from jsonb_array_elements(source->'construction') word where jsonb_typeof(word)<>'string' or length(btrim(word#>>'{}')) not between 1 and 100)
   or member->'value' is distinct from to_jsonb(nm) or member->'rationale' is distinct from to_jsonb(why)
   or member->'identityKey' is distinct from to_jsonb(ident) or member->'graphemeCount' is distinct from to_jsonb(n)
   or member->'primaryApproach' is distinct from source->'primaryApproach' or jsonb_typeof(source->'primaryApproach') is distinct from 'string'
   or not coalesce(prefs->'approaches' ? approach,false)
   or not coalesce(c.request#>'{text,format,schema,properties,candidates,items,properties,primaryApproach,enum}' ? approach,false)
   or n<coalesce((prefs->>'minimumGraphemes')::integer,1) or n>coalesce((prefs->>'maximumGraphemes')::integer,100)
   or exists(select 1 from jsonb_array_elements_text(prefs->'requiredText') x where position(lower(normalize(x,NFC)) in lower(nm))=0)
   or exists(select 1 from jsonb_array_elements_text(prefs->'excludedText') x where position(lower(normalize(x,NFC)) in lower(nm))>0)
   or exists(select 1 from jsonb_array_elements(ev.payload->'candidates') original where original->>'identityKey'=ident)
  then raise exception 'invalid_supplemental_source';end if;
  select * into existing from fluid_private.naming_brainstorm_supplemental_members where call_id=c.call_id and raw_index=source_index;
  if found then
   if prior=0 or existing.run_id<>r.id or existing.event_id<>ev.event_id or existing.completion_id<>comp.id then raise exception 'invalid_supplemental_replay';end if;
   continue;
  end if;
  if prior>0 or exists(select 1 from public.name_candidates where project_id=p.id and owner_id=p.owner_id and identity_key=ident)
   or exists(select 1 from fluid_private.naming_brain_identity_index where project_id=p.id and owner_id=p.owner_id and identity_key=ident)
  then raise exception 'duplicate_supplemental_member';end if;
  candidate:=gen_random_uuid();
  origin:=jsonb_build_object('kind','brainstorm','version',1,'profile','brainstorm_v1','ownerId',r.owner_id,'projectId',r.project_id,
   'candidateId',candidate,'contextRevision',p.current_revision,'value',nm,'batchId',r.batch_id,'jobId',j.id,'runId',r.id,
   'callId',c.call_id,'responseId',ev.payload->>'responseId','requestId',ev.payload->>'requestId','model',r.policy->>'model','generatedAt',ev.payload->>'observedAt');
  insert into public.name_candidates(id,owner_id,project_id,value,identity_key,context_revision,strategy_basis,origin,rationale,caution,batch_id)
   values(candidate,p.owner_id,p.id,nm,ident,p.current_revision,r.snapshot->'strategyBasis',origin,why,caution,r.batch_id);
  insert into fluid_private.naming_brain_identity_index(candidate_id,owner_id,project_id,value,identity_key) values(candidate,p.owner_id,p.id,nm,ident);
  insert into fluid_private.naming_brain_feed_entries(owner_id,project_id,run_id,candidate_id,position,steering_revision,metadata)
   values(p.owner_id,p.id,r.id,candidate,h.next_position,h.steering_revision,jsonb_build_object('primaryApproach',approach,'additionalApproaches','[]'::jsonb,'publishedClaims','[]'::jsonb));
  insert into fluid_private.naming_brainstorm_supplemental_members(candidate_id,run_id,owner_id,project_id,call_id,event_id,completion_id,raw_index)
   values(candidate,r.id,p.owner_id,p.id,c.call_id,ev.event_id,comp.id,source_index);
  h.next_position:=h.next_position+1;added:=added+1;
 end loop;
 select count(*) into total from fluid_private.naming_brain_feed_entries where run_id=r.id;
 if total<>100 or exists(select 1 from jsonb_array_elements_text(prefs->'approaches') selected(approach)
  left join lateral (select count(*) n from fluid_private.naming_brain_feed_entries f where f.run_id=r.id and f.metadata->>'primaryApproach'=selected.approach) counts on true
  where counts.n not between 100/route_count and (100+route_count-1)/route_count)
 then raise exception 'supplemental_coverage_mismatch';end if;
 if added>0 then
  update fluid_private.naming_brain_heads set next_position=h.next_position,coverage_epoch=writer_epoch where project_id=p.id;
  update fluid_private.naming_brain_runs set revision=revision+1,updated_at=clock_timestamp() where id=r.id;
 end if;
 return jsonb_build_object('insertedCount',added,'acceptedCount',total,'originalPublishedCount',comp.published_count,'originalState',comp.state);
end $$;

-- Supplement proofs are anchored to the unmodified raw provider output index.
-- All previously published IDs must still pass the original source reader.
create function public.get_naming_brainstorm_sources_v2(p_project_id uuid,p_candidate_ids uuid[])
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare original_ids uuid[]; old_rows jsonb; new_rows jsonb; actor uuid:=auth.uid();
begin
 if actor is null or p_candidate_ids is null or cardinality(p_candidate_ids)>100 or array_position(p_candidate_ids,null) is not null
  or not exists(select 1 from public.projects where id=p_project_id and owner_id=actor)
 then raise exception 'not_found' using errcode='P0002';end if;
 select coalesce(array_agg(distinct id),'{}') into original_ids from unnest(p_candidate_ids) id where not exists(
  select 1 from fluid_private.naming_brainstorm_supplemental_members m where m.candidate_id=id and m.owner_id=actor and m.project_id=p_project_id);
 old_rows:=public.get_naming_brainstorm_sources(p_project_id,original_ids);
 with sources as materialized (
  select distinct m.event_id,ev.payload,call.candidate_target,r.policy->>'model' model
  from fluid_private.naming_brainstorm_supplemental_members m
  join fluid_private.naming_brainstorm_calls call on call.call_id=m.call_id and (call.run_id,call.project_id,call.owner_id)=(m.run_id,m.project_id,m.owner_id)
  join fluid_private.naming_brainstorm_events ev on ev.event_id=m.event_id and ev.call_id=call.call_id and ev.kind='completed'
  join fluid_private.naming_brain_runs r on r.id=m.run_id and (r.project_id,r.owner_id)=(m.project_id,m.owner_id)
  where m.owner_id=actor and m.project_id=p_project_id and m.candidate_id=any(p_candidate_ids)
 ), event_rows as materialized (
  select event_id,payload,fluid_private.naming_brainstorm_supplemental_raw_v1(payload,model,candidate_target) raws from sources
 )
 select coalesce(jsonb_agg(jsonb_build_object('ownerId',m.owner_id,'projectId',m.project_id,'candidateId',m.candidate_id,
  'runId',r.id,'jobId',r.job_id,'batchId',r.batch_id,'callId',m.call_id,'responseId',e.payload->>'responseId','requestId',e.payload->>'requestId',
  'model',r.policy->>'model','generatedAt',e.payload->>'observedAt','value',btrim(raw.row->>'value'),'identityKey',ix.identity_key,
  'rationale',btrim(raw.row->>'rationale'),'snapshot',r.snapshot,'profile','brainstorm_v1') order by m.candidate_id),'[]'::jsonb) into new_rows
 from fluid_private.naming_brainstorm_supplemental_members m join event_rows e using(event_id)
 join fluid_private.naming_brain_runs r on (r.id,r.owner_id,r.project_id)=(m.run_id,m.owner_id,m.project_id)
 join fluid_private.naming_brainstorm_completions comp on comp.id=m.completion_id and comp.run_id=r.id and comp.state='partial'
 join public.name_candidates c on (c.id,c.project_id,c.owner_id,c.batch_id)=(m.candidate_id,m.project_id,m.owner_id,r.batch_id)
 join fluid_private.naming_brain_identity_index ix on (ix.candidate_id,ix.project_id,ix.owner_id,ix.identity_key)=(c.id,c.project_id,c.owner_id,c.identity_key)
 join fluid_private.naming_brain_feed_entries f on (f.candidate_id,f.run_id,f.project_id,f.owner_id)=(c.id,r.id,c.project_id,c.owner_id)
 cross join lateral(select e.raws->m.raw_index as row) raw
 where m.candidate_id=any(p_candidate_ids) and m.owner_id=actor and m.project_id=p_project_id
  and c.origin->>'kind'='brainstorm' and fluid_private.naming_brainstorm_job(r.job_id)
  and c.value=btrim(raw.row->>'value') and c.rationale=btrim(raw.row->>'rationale')
  and c.identity_key=replace(replace(lower(c.value collate "C"),' ',''),'-','') and f.metadata->>'primaryApproach'=raw.row->>'primaryApproach';
 if jsonb_array_length(old_rows)+jsonb_array_length(new_rows)<>(select count(distinct x) from unnest(p_candidate_ids)x)
 then raise exception 'invalid_brainstorm_source' using errcode='55000';end if;
 return old_rows||new_rows;
end $$;

-- Some installations have extra role-specific DEFAULT PRIVILEGES. Remove every
-- inherited object grant, then expose only the authenticated read facade.
do $acl$
declare grant_row record; target regprocedure;
begin
 for grant_row in select distinct a.grantee from pg_class c,lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
  where c.oid='fluid_private.naming_brainstorm_supplemental_members'::regclass and a.grantee<>c.relowner loop
  execute format('revoke all on fluid_private.naming_brainstorm_supplemental_members from %s',case when grant_row.grantee=0 then 'public' else quote_ident(pg_get_userbyid(grant_row.grantee)) end);
 end loop;
 foreach target in array array['fluid_private.naming_brainstorm_supplemental_raw_v1(jsonb,text,integer)'::regprocedure,
  'fluid_private.repair_partial_brainstorm_v1(uuid,uuid,jsonb)'::regprocedure,'public.get_naming_brainstorm_sources_v2(uuid,uuid[])'::regprocedure] loop
  for grant_row in select distinct a.grantee from pg_proc p,lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where p.oid=target and a.grantee<>p.proowner loop
   execute format('revoke all on function %s from %s',target,case when grant_row.grantee=0 then 'public' else quote_ident(pg_get_userbyid(grant_row.grantee)) end);
  end loop;
 end loop;
 grant execute on function public.get_naming_brainstorm_sources_v2(uuid,uuid[]) to authenticated;
end $acl$;
commit;
