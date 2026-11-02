-- Recover saved Naming output without another provider request. Install after
-- the brainstorm/event-capacity packets with shared worker lanes drained.
-- Unknown billing remains unknown: no reservation, cost, completion or lease
-- is settled by this packet. The original source packets remain immutable.
begin;
set local search_path='';
set local lock_timeout='2s';
set local statement_timeout='30s';
do $guard$
declare signature text;hashes text[];definer boolean;volatility text;
begin
 if current_user<>'postgres' or session_user<>current_user
  or to_regclass('fluid_private.naming_brainstorm_delivery_recoveries') is not null
  or to_regprocedure('fluid_private.recover_naming_brainstorm_delivery(jsonb,jsonb,jsonb)') is not null
 then raise exception 'brainstorm_delivery_install_prerequisite' using errcode='55000';end if;
 for signature,hashes,definer,volatility in values
  -- Both exact released source predecessors are supported. The event-capacity
  -- correction is preserved when present; this packet never undoes it.
  ('public.shared_naming_worker_action(jsonb,jsonb,text,jsonb)',array['e8bae9ed6a46f0b87e8c78474d5d059dd608b27442421e730d2f0c9f4e599ea4','5b9e16f786364d7cb5e58a5b9380a1da3490f5c950f8dfb7f47fde435518d7f9'],true,'v'),
  ('fluid_private.naming_brain_summary(fluid_private.naming_brain_runs)',array['8b50135a4883f4d6c5abe3ed03102627d3eca5fc58ce8428066e97b12ab2a5e4'],false,'s'),
  ('fluid_private.shared_worker_execution(jsonb,jsonb,text)',array['a5f4e1f6fefc9933c6e11c39bb70ba3597f711f3c4c66ca5ae73566a703073a8'],true,'v'),
  ('fluid_private.shared_naming_job(uuid)',array['83d5aa09c6cf60626015f5c33675e0e06d78201bce4f0c489c935a2fd5bc60bc'],true,'s')
 loop
  if not exists(select 1 from pg_proc p where p.oid=to_regprocedure(signature)
   and encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=any(hashes)
   and p.proowner='postgres'::regrole and p.proconfig=array['search_path=""']
   and p.prosecdef=definer and p.provolatile::text=volatility and not p.proleakproof)
  then raise exception 'brainstorm_delivery_predecessor_mismatch: %',signature using errcode='55000';end if;
 end loop;
end $guard$;

-- Separate immutable receipt: do not rewrite provider events or add columns to
-- historical job rows whose exact representation is used by other evidence.
create table fluid_private.naming_brainstorm_delivery_recoveries(
 call_id uuid primary key references fluid_private.naming_brainstorm_publications(call_id),
 execution_id uuid not null references fluid_private.shared_worker_executions(execution_id),
 event_id uuid not null unique references fluid_private.naming_brainstorm_events(event_id),
 run_id uuid not null,owner_id uuid not null,project_id uuid not null,
 candidate_ids jsonb not null check(jsonb_typeof(candidate_ids)='array' and jsonb_array_length(candidate_ids)<=100),
 evidence jsonb not null check(jsonb_typeof(evidence)='object' and octet_length(evidence::text)<=4096),
 created_at timestamptz not null default clock_timestamp(),
 foreign key(run_id,owner_id,project_id) references fluid_private.naming_brain_runs(id,owner_id,project_id)
);
alter table fluid_private.naming_brainstorm_delivery_recoveries enable row level security;
alter table fluid_private.naming_brainstorm_delivery_recoveries force row level security;
create trigger brainstorm_delivery_recovery_immutable before update or delete on fluid_private.naming_brainstorm_delivery_recoveries
 for each row execute function fluid_private.prevent_history_change();

create function fluid_private.recover_naming_brainstorm_delivery(p_slot jsonb,p_execution jsonb,p_args jsonb) returns jsonb
language plpgsql volatile set search_path='' as $$
declare e fluid_private.shared_worker_executions;j public.jobs;r fluid_private.naming_brain_runs;
 h fluid_private.naming_brain_heads;p public.projects;s public.naming_sessions;
 c fluid_private.naming_brainstorm_calls;ev fluid_private.naming_brainstorm_events;
 item jsonb;part jsonb;raw jsonb;body jsonb;request_state jsonb;ids jsonb;candidate uuid;origin jsonb;
 text_parts text[];message jsonb;total integer;inserted integer:=0;prior_timeout text;
 result jsonb:='{"status":"retained_unknown","insertedCount":0}'::jsonb;
begin
 if p_args is distinct from '{}'::jsonb then raise exception 'invalid_brainstorm_delivery' using errcode='22023';end if;
 prior_timeout:=current_setting('lock_timeout');perform set_config('lock_timeout','100ms',true);
 begin
  e:=fluid_private.shared_worker_execution(p_slot,p_execution,'observe');
  if e.lane<>'naming' or not fluid_private.naming_brainstorm_job(e.job_id)
  then raise exception 'brainstorm_profile_required' using errcode='42501';end if;
  perform fluid_private.enter_shared_worker_context(p_slot,p_execution,'observe');
  <<delivery>>
  begin
   select * into strict j from public.jobs where id=e.job_id;
   if e.state<>'observing' or j.state<>'needs_reconciliation' or j.lease_token is not null or j.lease_expires_at is not null
    or j.cancel_requested_at is not null or to_jsonb(j)->>'project_deletion_requested_at' is not null
    or j.billing_mode<>'openai_api' then exit delivery;end if;
   -- Job/slot locks precede project edits in the gateway. Never wait on the
   -- reverse order held by an editor, Stop, deletion or another owner action.
   if not pg_try_advisory_xact_lock(hashtextextended(e.owner_id::text,723902)) then exit delivery;end if;
   perform 1 from fluid_private.strategy_billing_routes where owner_id=e.owner_id for update nowait;
   perform 1 from auth.users where id=e.owner_id for share nowait;if not found then exit delivery;end if;
   perform 1 from fluid_private.shared_accounts where owner_id=e.owner_id for share nowait;
   if not found or fluid_private.shared_account_customer_active(e.owner_id) is distinct from true then exit delivery;end if;
   select * into p from public.projects where id=e.project_id and owner_id=e.owner_id for update nowait;
   if not found or p.deleted_at is not null or p.deletion_requested_at is not null then exit delivery;end if;
   select * into strict s from public.naming_sessions where project_id=e.project_id and owner_id=e.owner_id for update nowait;
   select * into strict h from fluid_private.naming_brain_heads where project_id=e.project_id and owner_id=e.owner_id for update nowait;
   select * into strict r from fluid_private.naming_brain_runs where job_id=e.job_id for update nowait;
   if (r.owner_id,r.project_id,r.policy_identity,r.deployment_id) is distinct from(e.owner_id,e.project_id,e.policy_identity,e.deployment_id)
    or r.recovery_mode<>'observe_only' or r.superseded or h.paused or h.current_run_id is distinct from r.id
    or h.steering_revision is distinct from (r.snapshot->>'steeringRevision')::bigint
    or s.preferences_version is distinct from (r.snapshot->>'preferencesVersion')::integer
    or (select fluid_private.naming_strategy_basis(rev.context) from public.project_revisions rev
     where rev.project_id=p.id and rev.owner_id=p.owner_id and rev.revision=p.current_revision) is distinct from r.snapshot->'strategyBasis'
    or h.coverage_epoch is distinct from h.writer_epoch
    or exists(select 1 from fluid_private.naming_brainstorm_completions where run_id=r.id)
   then exit delivery;end if;
   select count(*) into total from fluid_private.naming_brain_feed_entries where run_id=r.id;
   if total>100 then raise exception 'brainstorm_delivery_membership_invalid' using errcode='55000';end if;
   for c in select * from fluid_private.naming_brainstorm_calls where run_id=r.id order by call_index loop
    if (c.owner_id,c.project_id) is distinct from(e.owner_id,e.project_id)
     or c.request->>'model' is distinct from r.policy->>'model'
     or c.request#>>'{metadata,embel_job_id}' is distinct from j.id::text
     or c.request#>>'{metadata,embel_run_id}' is distinct from r.id::text
     or c.request#>>'{metadata,embel_call_index}' is distinct from c.call_index::text
    then raise exception 'brainstorm_delivery_call_mismatch' using errcode='55000';end if;
    if exists(select 1 from fluid_private.naming_brainstorm_publications pub where pub.call_id=c.call_id) then continue;end if;
    select * into ev from fluid_private.naming_brainstorm_events event where event.call_id=c.call_id and event.kind='completed';
    if not found then continue;end if; -- An issued unknown call remains unknown.
    request_state:=fluid_private.naming_brainstorm_call_state(c);body:=ev.payload->'response';
    if (select count(*) from fluid_private.naming_brainstorm_events event where event.call_id=c.call_id and event.kind='completed')<>1
     or jsonb_typeof(body) is distinct from 'object' or body->>'status' is distinct from 'completed'
     or body->>'id' is distinct from ev.payload->>'responseId' or body->>'id' is distinct from request_state->>'responseId'
     or body->>'id' !~ '^resp_[A-Za-z0-9_-]{1,194}$' or body->>'model' is distinct from r.policy->>'model'
     or body->'error' is not null and body->'error'<>'null'::jsonb
     or body->'incomplete_details' is not null and body->'incomplete_details'<>'null'::jsonb
     or jsonb_typeof(body->'output') is distinct from 'array' or jsonb_array_length(body->'output')>100
     or jsonb_typeof(ev.payload->'candidates') is distinct from 'array' or jsonb_array_length(ev.payload->'candidates')>c.candidate_target
    then continue;end if;
    text_parts:=array[]::text[];
    for message in select value from jsonb_array_elements(body->'output') loop
     if message->>'type'='reasoning' then continue;end if;
     if message->>'type' is distinct from 'message' or message->>'role' is distinct from 'assistant'
      or message->>'status' is distinct from 'completed' or jsonb_typeof(message->'content') is distinct from 'array'
     then raise exception 'brainstorm_delivery_response_invalid' using errcode='22023';end if;
     for part in select value from jsonb_array_elements(message->'content') loop
      if part->>'type' is distinct from 'output_text' or jsonb_typeof(part->'text') is distinct from 'string'
      then raise exception 'brainstorm_delivery_response_invalid' using errcode='22023';end if;
      text_parts:=array_append(text_parts,part->>'text');
     end loop;
    end loop;
    if cardinality(text_parts)<>1 or octet_length(text_parts[1])>262144 then continue;end if;
    raw:=text_parts[1]::jsonb;
    if jsonb_typeof(raw->'candidates') is distinct from 'array' or jsonb_array_length(raw->'candidates')>c.candidate_target
    then continue;end if;
    ids:='[]';
    for item in select value from jsonb_array_elements(ev.payload->'candidates') loop
     if not(item ?& array['value','identityKey','rationale','caution','primaryApproach','graphemeCount'])
      or item-array['value','identityKey','rationale','caution','primaryApproach','graphemeCount']<>'{}'
      or jsonb_typeof(item->'value') is distinct from 'string' or length(item->>'value') not between 1 and 160
      or normalize(btrim(item->>'value'),NFC)<>item->>'value' or item->>'value' ~ '[[:cntrl:]]'
      or coalesce(length(item->>'identityKey'),0) not between 1 and 320
      or coalesce(length(btrim(item->>'rationale')),0) not between 1 and 600 or item->>'rationale' ~ '[[:cntrl:]]'
      or item->>'caution' is distinct from 'Unchecked brainstorm. Research and screening are needed before use.'
      or jsonb_typeof(item->'primaryApproach') is distinct from 'string' or not(r.snapshot#>'{preferences,approaches}' ? (item->>'primaryApproach'))
      or jsonb_typeof(item->'graphemeCount') is distinct from 'number' or (item->>'graphemeCount')::integer not between 1 and 100
      or (item->>'graphemeCount')::integer<coalesce((r.snapshot#>>'{preferences,minimumGraphemes}')::integer,1)
      or (item->>'graphemeCount')::integer>coalesce((r.snapshot#>>'{preferences,maximumGraphemes}')::integer,100)
      or not exists(select 1 from jsonb_array_elements(raw->'candidates') source
       where normalize(btrim(source->>'value'),NFC)=item->>'value' and btrim(source->>'rationale')=item->>'rationale'
        and source->>'primaryApproach'=item->>'primaryApproach')
     then raise exception 'brainstorm_delivery_candidate_invalid' using errcode='22023';end if;
     exit when total>=100;
     if exists(select 1 from jsonb_array_elements_text(r.snapshot#>'{preferences,requiredText}') fragment where position(normalize(lower(normalize(fragment,NFC)),NFC) in normalize(lower(item->>'value'),NFC))=0)
      or exists(select 1 from jsonb_array_elements_text(r.snapshot#>'{preferences,excludedText}') fragment where position(normalize(lower(normalize(fragment,NFC)),NFC) in normalize(lower(item->>'value'),NFC))>0)
      or exists(select 1 from public.name_candidates candidate where candidate.owner_id=r.owner_id and candidate.project_id=r.project_id and candidate.identity_key=item->>'identityKey')
      or exists(select 1 from fluid_private.naming_brain_identity_index ix where ix.owner_id=r.owner_id and ix.project_id=r.project_id and ix.identity_key=item->>'identityKey') then continue;end if;
     candidate:=gen_random_uuid();
     origin:=jsonb_build_object('kind','brainstorm','version',1,'profile','brainstorm_v1','ownerId',r.owner_id,'projectId',r.project_id,'candidateId',candidate,
      'contextRevision',(r.snapshot->>'contextRevision')::integer,'value',item->>'value','batchId',r.batch_id,'jobId',r.job_id,'runId',r.id,'callId',c.call_id,
      'responseId',ev.payload->>'responseId','requestId',ev.payload->>'requestId','model',r.policy->>'model','generatedAt',ev.payload->>'observedAt');
     insert into public.name_candidates(id,owner_id,project_id,value,identity_key,context_revision,strategy_basis,origin,rationale,caution,batch_id)
      values(candidate,r.owner_id,r.project_id,item->>'value',item->>'identityKey',(r.snapshot->>'contextRevision')::integer,r.snapshot->'strategyBasis',origin,item->>'rationale',item->>'caution',r.batch_id);
     insert into fluid_private.naming_brain_identity_index(candidate_id,owner_id,project_id,value,identity_key) values(candidate,r.owner_id,r.project_id,item->>'value',item->>'identityKey');
     insert into fluid_private.naming_brain_feed_entries(owner_id,project_id,run_id,candidate_id,position,steering_revision,metadata)
      values(r.owner_id,r.project_id,r.id,candidate,h.next_position,h.steering_revision,jsonb_build_object('primaryApproach',item->>'primaryApproach','additionalApproaches','[]'::jsonb,'publishedClaims','[]'::jsonb));
     ids:=ids||to_jsonb(candidate);h.next_position:=h.next_position+1;total:=total+1;inserted:=inserted+1;
    end loop;
    insert into fluid_private.naming_brainstorm_publications(call_id,run_id,owner_id,project_id,candidate_ids) values(c.call_id,r.id,r.owner_id,r.project_id,ids);
    insert into fluid_private.naming_brainstorm_delivery_recoveries(call_id,execution_id,event_id,run_id,owner_id,project_id,candidate_ids,evidence)
     values(c.call_id,e.execution_id,ev.event_id,r.id,r.owner_id,r.project_id,ids,jsonb_build_object('version',1,'responseId',ev.payload->>'responseId',
      'requestHash',encode(sha256(convert_to(c.request::text,'UTF8')),'hex'),'responseHash',encode(sha256(convert_to(body::text,'UTF8')),'hex'),
      'eventHash',encode(sha256(convert_to(ev.payload::text,'UTF8')),'hex'),'originalJobState',j.state,'originalErrorCode',j.error_code));
   end loop;
   if inserted>0 then
    update fluid_private.naming_brain_heads set next_position=h.next_position,coverage_epoch=writer_epoch where project_id=r.project_id;
    update public.jobs set progress=total where id=j.id;
    update fluid_private.naming_brain_runs set revision=revision+1,updated_at=clock_timestamp() where id=r.id;
    result:=jsonb_build_object('status','published_unsettled','insertedCount',inserted);
   end if;
   -- Do not manufacture a completed/zero-cost job from token counters. Existing
   -- actual-cost fields, reservations, call receipts and job state stay exact.
  end delivery;
  perform fluid_private.leave_shared_worker_context();
 exception when lock_not_available or data_exception then
  -- The subtransaction rolls back any partial publication and context entry.
  -- A malformed retained response or concurrent edit must not retire the lane.
  result:='{"status":"retained_unknown","insertedCount":0}'::jsonb;
 end;
 perform set_config('lock_timeout',prior_timeout,true);
 return jsonb_build_object('execution',p_execution,'result',result);
end $$;

do $install$
declare definition text;body text;needle text;replacement text;
begin
 select prosrc into body from pg_proc where oid='public.shared_naming_worker_action(jsonb,jsonb,text,jsonb)'::regprocedure;
 definition:=pg_get_functiondef('public.shared_naming_worker_action(jsonb,jsonb,text,jsonb)'::regprocedure);
 needle:=$needle$begin
 if p_action not in('brainstorm_state','brainstorm_begin','brainstorm_event','brainstorm_publish','brainstorm_finish') then$needle$;
 replacement:=$replacement$begin
 if p_action='brainstorm_recover_delivery' then return fluid_private.recover_naming_brainstorm_delivery(p_slot,p_execution,p_args);end if;
 if p_action not in('brainstorm_state','brainstorm_begin','brainstorm_event','brainstorm_publish','brainstorm_finish') then$replacement$;
 if (length(body)-length(replace(body,needle,'')))/length(needle)<>1 then raise exception 'brainstorm_delivery_gateway_mismatch';end if;
 execute replace(definition,body,replace(body,needle,replacement));
 select prosrc into body from pg_proc where oid='fluid_private.naming_brain_summary(fluid_private.naming_brain_runs)'::regprocedure;
 definition:=pg_get_functiondef('fluid_private.naming_brain_summary(fluid_private.naming_brain_runs)'::regprocedure);
 needle:=$needle$ ||case when completion.id is not null$needle$;
 replacement:=$replacement$ ||case when exists(select 1 from fluid_private.naming_brainstorm_delivery_recoveries recovery where recovery.run_id=r.id and jsonb_array_length(recovery.candidate_ids)>0)
 then jsonb_build_object('recoveredNameCount',(select sum(jsonb_array_length(recovery.candidate_ids)) from fluid_private.naming_brainstorm_delivery_recoveries recovery where recovery.run_id=r.id)) else '{}'::jsonb end
 ||case when completion.id is not null$replacement$;
 if (length(body)-length(replace(body,needle,'')))/length(needle)<>1 then raise exception 'brainstorm_delivery_summary_mismatch';end if;
 execute replace(definition,body,replace(body,needle,replacement));
end $install$;
do $acl$
declare grant_row record;
begin
 revoke all on table fluid_private.naming_brainstorm_delivery_recoveries from public,anon,authenticated,service_role;
 for grant_row in select distinct a.grantee from pg_class c,lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
  where c.oid='fluid_private.naming_brainstorm_delivery_recoveries'::regclass and a.grantee<>c.relowner and a.grantee<>0 loop
  execute format('revoke all on table fluid_private.naming_brainstorm_delivery_recoveries from %I',pg_get_userbyid(grant_row.grantee));
 end loop;
 revoke all on function fluid_private.recover_naming_brainstorm_delivery(jsonb,jsonb,jsonb) from public,anon,authenticated,service_role;
 for grant_row in select distinct a.grantee from pg_proc p,lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
  where p.oid='fluid_private.recover_naming_brainstorm_delivery(jsonb,jsonb,jsonb)'::regprocedure and a.grantee<>p.proowner and a.grantee<>0 loop
  execute format('revoke all on function fluid_private.recover_naming_brainstorm_delivery(jsonb,jsonb,jsonb) from %I',pg_get_userbyid(grant_row.grantee));
 end loop;
end $acl$;
commit;
