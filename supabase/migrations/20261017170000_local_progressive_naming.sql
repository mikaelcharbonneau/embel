-- Future-only local progressive Naming. Existing runs, plans, receipts, prepared
-- sets and feed membership remain immutable and retain their original pipeline.
begin;
do $guard$
declare signature text; expected text;
begin
 for signature,expected in values
 ('public.ensure_naming_brain_run(uuid,jsonb)','e567623d778036e3776757b47d04be81'),
 ('public.ensure_local_naming_brain_run(uuid,jsonb)','ad4452dca0db9261caf0bba2285b74cf'),
 ('public.naming_brain_worker_action(uuid,uuid,text,jsonb)','1dcf6683af041f9bcbe6264e2469ac7b'),
 ('public.authorize_naming_brain_dispatch(uuid,uuid,jsonb)','7a82b0661c6b7e2f5b30311fb5742a79'),
 ('public.record_naming_brain_provider_receipt(uuid,uuid,jsonb)','6ac7032d233e168d12ebac9f568675e8'),
 ('public.complete_naming_brain_stage(uuid,uuid,text,text,jsonb)','42f87494ac31b4668778179d05be8233'),
 ('public.get_naming_feed(uuid,jsonb)','07a3cf7aaba9b82f3fd7fa6ff8ba99ef'),
 ('public.get_naming_brain_run(uuid,uuid)','9b38d9656985f32366caa766e7c5e15e'),
 ('public.get_naming_brain_candidate_source(uuid,uuid)','c2c63e89f1ca24c82ed68a5f0c895c64'),
 ('public.steer_naming_feed(uuid,jsonb)','090f0c1d2bebaa7e924b92e1baead558'),
 ('fluid_private.naming_brain_summary(fluid_private.naming_brain_runs)','e560bf4e3cc998e53d27993002f6059d'),
 ('fluid_private.naming_brain_preparation_pending(fluid_private.naming_brain_runs)','04d5117ad9b0908b981252967f12fb6c'),
 ('fluid_private.naming_brain_call_terminal(fluid_private.naming_brain_calls)','a780e2fee00da074b774ded4612908ca'),
 ('fluid_private.naming_brain_can_resume(fluid_private.naming_brain_runs)','8e95ef5b251f13ef041890ef98b2add2'),
 ('fluid_private.naming_brain_ensure_response(fluid_private.naming_brain_runs,boolean)','d7e854bf303087ad05c1844b9ce22239'),
 ('fluid_private.naming_candidate_dto(public.name_candidates)','9664a87d3c810137c1f0b169ef10f9bb'),
 ('fluid_private.naming_job_dto(public.naming_batches)','9bd273d8ed98ce7e8213bf46e9fbbcb8') loop
  if not exists(select 1 from pg_proc p where p.oid=signature::regprocedure and md5(p.prosrc)=expected
   and p.proconfig=array['search_path=""'] and not p.proleakproof and p.prosecdef=(signature like 'public.%')
   and p.provolatile=case when signature like 'public.get_naming_brain_candidate_source%' or signature like 'fluid_private.naming_brain_summary%' or signature like 'fluid_private.naming_brain_preparation_pending%' or signature like 'fluid_private.naming_brain_call_terminal%' or signature like 'fluid_private.naming_brain_can_resume%' or signature like 'fluid_private.naming_candidate_dto%' or signature like 'fluid_private.naming_job_dto%' then 's' else 'v' end
   and p.proowner=(select oid from pg_roles where rolname=current_user)) then raise exception 'unexpected_progressive_naming_predecessor: %',signature; end if;
 end loop;
end $guard$;

create table fluid_private.naming_brain_progressive_plans(
 run_id uuid not null,owner_id uuid not null,project_id uuid not null,phase_key text not null,
 requests jsonb not null check(jsonb_typeof(requests)='array' and jsonb_array_length(requests) between 1 and 3 and octet_length(requests::text)<=524288),
 created_at timestamptz not null default clock_timestamp(),primary key(run_id,phase_key),
 foreign key(run_id,owner_id,project_id) references fluid_private.naming_brain_runs(id,owner_id,project_id));
create table fluid_private.naming_brain_microbatches(
 id uuid primary key,run_id uuid not null,owner_id uuid not null,project_id uuid not null,microbatch_key text not null check(microbatch_key~'^part[0-9]{3}$'),
 request jsonb not null check(octet_length(request::text)<=131072),publication jsonb not null check(octet_length(publication::text)<=262144),
 created_at timestamptz not null default clock_timestamp(),unique(run_id,microbatch_key),
 foreign key(run_id,owner_id,project_id) references fluid_private.naming_brain_runs(id,owner_id,project_id));
create table fluid_private.naming_brain_progressive_results(
 id uuid primary key default gen_random_uuid(),run_id uuid not null unique,owner_id uuid not null,project_id uuid not null,
 result jsonb not null check(octet_length(result::text)<=262144),created_at timestamptz not null default clock_timestamp(),
 foreign key(run_id,owner_id,project_id) references fluid_private.naming_brain_runs(id,owner_id,project_id));
do $$ declare table_name text; begin
 foreach table_name in array array['naming_brain_progressive_plans','naming_brain_microbatches','naming_brain_progressive_results'] loop
 execute format('alter table fluid_private.%I enable row level security',table_name);
 execute format('alter table fluid_private.%I force row level security',table_name);
 execute format('create trigger progressive_history_immutable before update or delete on fluid_private.%I for each row execute function fluid_private.prevent_history_change()',table_name);
 end loop;
end $$;

create function fluid_private.local_naming_publish_microbatch(r fluid_private.naming_brain_runs,p_payload jsonb) returns jsonb language plpgsql set search_path='' as $$
 declare j public.jobs; h fluid_private.naming_brain_heads; project public.projects; prior fluid_private.naming_brain_microbatches;
 publication_id uuid:=gen_random_uuid(); refs jsonb:=p_payload->'candidates'; ref jsonb; source jsonb; proposal jsonb; creator_call fluid_private.naming_brain_calls;
 curator jsonb; curator_request jsonb; verified jsonb; claims jsonb; notes jsonb; origin jsonb; receipt jsonb; attribution jsonb; display_rationale text;
 entries jsonb:='[]'; ids jsonb:='[]'; candidates jsonb:='[]'; entry_id uuid; counts jsonb; total integer; missing integer; complete boolean; result jsonb;
 begin
 select * into j from public.jobs where id=r.job_id;
 if not fluid_private.local_naming_progressive_job(r.job_id) then raise exception 'progressive_worker_required' using errcode='42501'; end if;
 if p_payload-array['version','key','candidates','curationArtifactId','verification']<>'{}'::jsonb or p_payload->'version' is distinct from '1'::jsonb
 or coalesce(p_payload->>'key','')!~'^part[0-9]{3}$' or jsonb_typeof(refs) is distinct from 'array' or jsonb_array_length(refs) not between 1 and 30
 or octet_length(p_payload::text)>131072 then raise exception 'invalid_microbatch' using errcode='22023'; end if;
 select * into prior from fluid_private.naming_brain_microbatches where run_id=r.id and microbatch_key=p_payload->>'key';
 if found then if prior.request is distinct from p_payload then raise exception 'immutable_microbatch' using errcode='55000'; end if; return prior.publication->'result'; end if;
 select * into project from public.projects where id=r.project_id and owner_id=r.owner_id;
 select * into h from fluid_private.naming_brain_heads where project_id=r.project_id and owner_id=r.owner_id for update;
 if j.state<>'running' or j.cancel_requested_at is not null or r.recovery_mode<>'execute' or r.superseded or h.paused
 or project.deleted_at is not null or project.deletion_requested_at is not null or not fluid_private.naming_brain_ready(r,j.worker_id)
 or h.current_run_id is distinct from r.id or h.steering_revision is distinct from (r.snapshot->>'steeringRevision')::integer
 or (select preferences_version from public.naming_sessions where project_id=r.project_id) is distinct from (r.snapshot->>'preferencesVersion')::integer
 or (select fluid_private.naming_strategy_basis(context) from public.project_revisions where project_id=r.project_id and owner_id=r.owner_id and revision=project.current_revision) is distinct from r.snapshot->'strategyBasis'
 then raise exception 'microbatch_stopped' using errcode='PT409'; end if;
 if h.coverage_epoch is distinct from h.writer_epoch then raise exception 'identity_coverage_incomplete' using errcode='PT409'; end if;
 select a.artifact,c.request into curator,curator_request from fluid_private.naming_brain_artifacts a join fluid_private.naming_brain_calls c
 on c.run_id=a.run_id and c.stage_key=a.stage_key and c.call_key=a.artifact#>>'{providerReceipt,providerCallKey}'
 where a.id=(p_payload->>'curationArtifactId')::uuid and a.run_id=r.id and a.owner_id=r.owner_id and a.project_id=r.project_id
 and a.artifact#>>'{output,role}'='curator' and c.phase_key=(p_payload->>'key')||'.curation' and fluid_private.naming_brain_call_completed(c);
 if curator is null then raise exception 'completed_microbatch_review_required' using errcode='22023'; end if;
 if p_payload#>>'{verification,kind}'='verified' then
 select a.artifact into verified from fluid_private.naming_brain_artifacts a join fluid_private.naming_brain_calls c
 on c.run_id=a.run_id and c.stage_key=a.stage_key and c.call_key=a.artifact#>>'{providerReceipt,providerCallKey}'
 where a.id=(p_payload#>>'{verification,artifactId}')::uuid and a.run_id=r.id and a.owner_id=r.owner_id and a.project_id=r.project_id
 and a.artifact#>>'{output,role}'='verifier' and c.phase_key=(p_payload->>'key')||'.verification' and fluid_private.naming_brain_call_completed(c)
 and c.request->'dependencyArtifactIds' ? (curator->>'artifactId');
 if verified is null then raise exception 'completed_microbatch_verification_required' using errcode='22023'; end if;
 elsif p_payload->'verification' is distinct from '{"kind":"not_required","reason":"no_factual_claims"}'::jsonb then raise exception 'invalid_microbatch_verification' using errcode='22023'; end if;
 if (select count(distinct candidate_ref->>'candidateId') from jsonb_array_elements(refs) candidate_ref)<>jsonb_array_length(refs) then raise exception 'duplicate_microbatch_candidate' using errcode='22023'; end if;
 select count(*)::integer into total from fluid_private.naming_brain_feed_entries where run_id=r.id;
 for ref in select value from jsonb_array_elements(refs) loop
 if ref-array['candidateId','sourceArtifactId','candidateKey','assignmentKey','identityKey']<>'{}'::jsonb or coalesce(ref->>'identityKey','')='' then raise exception 'invalid_microbatch_candidate' using errcode='22023'; end if;
 select a.artifact into source from fluid_private.naming_brain_artifacts a join fluid_private.naming_brain_calls c
 on c.run_id=a.run_id and c.stage_key=a.stage_key and c.call_key=a.artifact#>>'{providerReceipt,providerCallKey}'
 where a.id=(ref->>'sourceArtifactId')::uuid and a.run_id=r.id and a.owner_id=r.owner_id and a.project_id=r.project_id
 and a.artifact#>>'{output,role}'='creator' and c.phase_key=(p_payload->>'key')||'.creation' and fluid_private.naming_brain_call_completed(c);
 select proposal_row into proposal from jsonb_array_elements(source#>'{output,candidates}') proposal_row
 join jsonb_array_elements(source->'candidateIds') candidate on candidate->>'candidateKey'=proposal_row->>'candidateKey'
 where candidate->>'candidateId'=ref->>'candidateId' and proposal_row->>'candidateKey'=ref->>'candidateKey';
 if source is null or proposal is null or source#>>'{output,assignmentKey}' is distinct from ref->>'assignmentKey'
 or (r.snapshot#>'{preferences,approaches}' ? (proposal->>'primaryApproach')) is distinct from true
 or not(curator_request->'dependencyArtifactIds' ? (source->>'artifactId'))
 or not exists(select 1 from jsonb_array_elements(curator_request#>'{input,review,artifacts}') a join jsonb_array_elements(curator_request#>'{input,review,candidates}') c on c->>'artifactKey'=a->>'artifactKey'
 where a->>'sourceArtifactId'=source->>'artifactId' and a->>'assignmentKey'=ref->>'assignmentKey' and c->>'candidateKey'=ref->>'candidateKey')
 then raise exception 'microbatch_source_mismatch' using errcode='22023'; end if;
 if jsonb_typeof(proposal->'claims') is distinct from 'array' then raise exception 'invalid_microbatch_claims' using errcode='22023'; end if;
 if verified is null and (jsonb_array_length(proposal->'claims')<>0 or proposal->>'primaryApproach' in('other_languages','classical_roots','stories_culture','people_places')) then raise exception 'microbatch_factual_verification_required' using errcode='22023'; end if;
 if verified is not null and exists(
 select 1 from jsonb_array_elements(verified#>'{output,findings}') finding
 where finding->>'assignmentKey'=ref->>'assignmentKey' and finding->>'candidateKey'=ref->>'candidateKey'
 and(not exists(select 1 from jsonb_array_elements(proposal->'claims') claim where claim->>'claimKey'=finding->>'claimKey')
 or exists(select 1 from jsonb_array_elements(finding->'evidence') quote where not exists(
 select 1 from jsonb_array_elements(verified->'sources') evidence_source where evidence_source->>'sourceKey'=quote->>'sourceKey'
 and evidence_source->>'evidenceStatus'='retrieved' and evidence_source->>'excerpt' is not null and coalesce(quote->>'quote','')<>''
 and position(quote->>'quote' in evidence_source->>'excerpt')>0 and finding->'sourceKeys' ? (quote->>'sourceKey')))
 or (finding->>'status' in('supported','corrected') and(jsonb_array_length(finding->'evidence')=0
 or exists(select 1 from jsonb_array_elements_text(finding->'sourceKeys') source_key where not exists(select 1 from jsonb_array_elements(finding->'evidence') quote where quote->>'sourceKey'=source_key)))))
 ) then raise exception 'microbatch_verification_evidence_mismatch' using errcode='22023'; end if;
 if proposal->>'primaryApproach' in('other_languages','classical_roots','stories_culture','people_places') and not exists(select 1 from jsonb_array_elements(proposal->'claims') claim where claim->>'requirement'='primary_approach') then raise exception 'unsupported_primary_approach' using errcode='22023'; end if;
 if exists(select 1 from jsonb_array_elements(proposal->'claims') claim where claim->>'requirement'='primary_approach' and not exists(select 1 from jsonb_array_elements(verified#>'{output,findings}') f where f->>'assignmentKey'=ref->>'assignmentKey' and f->>'candidateKey'=ref->>'candidateKey' and f->>'claimKey'=claim->>'claimKey'
 and f->>'status' in('supported','corrected') and f->'supportsPrimaryApproach'='true'::jsonb and jsonb_array_length(f->'evidence')>0)) then raise exception 'unsupported_primary_approach' using errcode='22023'; end if;
 if total>=100 or exists(select 1 from fluid_private.naming_brain_identity_index where owner_id=r.owner_id and project_id=r.project_id and identity_key=ref->>'identityKey') then continue; end if;
 select coalesce(sum(greatest(0,5-(select count(*) from fluid_private.naming_brain_feed_entries f where f.run_id=r.id and f.metadata->>'primaryApproach'=approach)-case when proposal->>'primaryApproach'=approach then 1 else 0 end)),0)::integer into missing
 from jsonb_array_elements_text(r.snapshot#>'{preferences,approaches}') approach;
 if 100-total-1<missing then continue; end if;
 select coalesce(jsonb_agg(jsonb_build_object('claimKey',f->'claimKey','statement',f->'supportedWording','sourceKeys',f->'sourceKeys','evidence',f->'evidence')),'[]') into claims
 from jsonb_array_elements(verified#>'{output,findings}') f where f->>'assignmentKey'=ref->>'assignmentKey' and f->>'candidateKey'=ref->>'candidateKey' and f->>'status' in('supported','corrected') and f->>'supportedWording' is not null and jsonb_array_length(f->'evidence')>0;
 select coalesce(jsonb_agg(jsonb_build_object('claimKey',claim->'claimKey','originalStatement',claim->'statement','status',coalesce(f->>'status','unresolved'),'explanation',coalesce(f->>'explanation','No completed verification supports this claim.')) order by n),'[]') into notes
 from jsonb_array_elements(proposal->'claims') with ordinality cc(claim,n) left join lateral(select f from jsonb_array_elements(verified#>'{output,findings}') f where f->>'assignmentKey'=ref->>'assignmentKey' and f->>'candidateKey'=ref->>'candidateKey' and f->>'claimKey'=claim->>'claimKey') ff on true;
 display_rationale:=case when exists(select 1 from jsonb_array_elements(proposal->'claims') claim where not exists(select 1 from jsonb_array_elements(verified#>'{output,findings}') f where f->>'assignmentKey'=ref->>'assignmentKey' and f->>'candidateKey'=ref->>'candidateKey' and f->>'claimKey'=claim->>'claimKey' and f->>'status'='supported')) then 'Optional factual explanation withheld after verification.' else proposal->>'rationale' end;
 receipt:=source->'providerReceipt'; attribution:=source->'creatorAttribution';
 origin:=jsonb_build_object('kind','generated','version',2,'handlerVersion','naming-brain-v1','ownerId',r.owner_id,'projectId',r.project_id,'candidateId',ref->'candidateId','contextRevision',r.snapshot->'contextRevision',
 'value',proposal->'value','batchId',r.batch_id,'jobId',r.job_id,'stepKey','prepare','runId',r.id,'sourceArtifactId',ref->'sourceArtifactId','sourceStageKey','creation',
 'provider','openai','billingMode','openai_api','model',receipt->'observedModel','requestId',receipt->'requestId','providerItemId',attribution->'itemId','generatedAt',receipt->'recordedAt',
 'protocol','openai_agents','sessionId',receipt->'sessionId','turnId',receipt->'turnId','agentId',receipt->'agentId','responseId',null);
 insert into public.name_candidates(id,owner_id,project_id,value,identity_key,context_revision,strategy_basis,origin,rationale,caution,batch_id)
 values((ref->>'candidateId')::uuid,r.owner_id,r.project_id,proposal->>'value',ref->>'identityKey',(r.snapshot->>'contextRevision')::integer,r.snapshot->'strategyBasis',origin,display_rationale,proposal->>'caution',r.batch_id);
 insert into fluid_private.naming_brain_identity_index(candidate_id,owner_id,project_id,value,identity_key) values((ref->>'candidateId')::uuid,r.owner_id,r.project_id,proposal->>'value',ref->>'identityKey');
 entry_id:=gen_random_uuid();
 insert into fluid_private.naming_brain_feed_entries(id,owner_id,project_id,run_id,set_id,candidate_id,position,steering_revision,metadata)
 values(entry_id,r.owner_id,r.project_id,r.id,null,(ref->>'candidateId')::uuid,h.next_position,h.steering_revision,jsonb_build_object('microbatchId',publication_id,'primaryApproach',proposal->'primaryApproach','additionalApproaches',proposal->'additionalApproaches','publishedClaims',claims,'verificationNotes',notes));
 entries:=entries||jsonb_build_array(jsonb_build_object('candidateId',ref->'candidateId','entryId',entry_id,'identityKey',ref->'identityKey','primaryApproach',proposal->'primaryApproach','additionalApproaches',proposal->'additionalApproaches','publishedClaims',claims,'verificationNotes',notes));
 ids:=ids||to_jsonb(entry_id);candidates:=candidates||jsonb_build_array(ref->'candidateId');h.next_position:=h.next_position+1;total:=total+1;
 end loop;
 update fluid_private.naming_brain_heads set next_position=h.next_position,coverage_epoch=writer_epoch where project_id=r.project_id;
 counts:=fluid_private.local_naming_progressive_counts(r);complete:=total=100 and not exists(select 1 from jsonb_array_elements(counts->'primaryCounts') count where (count->>'count')::integer<5);
 result:=counts||jsonb_build_object('key',p_payload->>'key','publicationId',publication_id,'entryIds',ids,'candidateIds',candidates,'complete',complete);
 insert into fluid_private.naming_brain_microbatches(id,run_id,owner_id,project_id,microbatch_key,request,publication) values(publication_id,r.id,r.owner_id,r.project_id,p_payload->>'key',p_payload,jsonb_build_object('entries',entries,'entryIds',ids,'candidateIds',candidates,'result',result));
 update fluid_private.naming_brain_runs set revision=revision+1,updated_at=clock_timestamp() where id=r.id;
 return result;
end $$;

-- Keep the original functions intact as private delegates. Public identities,
-- owners and existing grants remain unchanged when the new wrappers are defined.
do $$ declare signature text; prior_name text; definition text; source_name text; begin
 for signature,source_name,prior_name in values
 ('public.naming_brain_worker_action(uuid,uuid,text,jsonb)','public.naming_brain_worker_action','fluid_private.local_naming_previous_worker_action'),
 ('public.authorize_naming_brain_dispatch(uuid,uuid,jsonb)','public.authorize_naming_brain_dispatch','fluid_private.local_naming_previous_authorize'),
 ('public.complete_naming_brain_stage(uuid,uuid,text,text,jsonb)','public.complete_naming_brain_stage','fluid_private.local_naming_previous_complete'),
 ('public.get_naming_feed(uuid,jsonb)','public.get_naming_feed','fluid_private.local_naming_previous_feed'),
 ('public.get_naming_brain_run(uuid,uuid)','public.get_naming_brain_run','fluid_private.local_naming_previous_run'),
 ('public.get_naming_brain_candidate_source(uuid,uuid)','public.get_naming_brain_candidate_source','fluid_private.local_naming_previous_source'),
 ('fluid_private.naming_brain_summary(fluid_private.naming_brain_runs)','fluid_private.naming_brain_summary','fluid_private.local_naming_previous_summary'),
 ('fluid_private.naming_brain_preparation_pending(fluid_private.naming_brain_runs)','fluid_private.naming_brain_preparation_pending','fluid_private.local_naming_previous_preparation_pending'),
 ('fluid_private.naming_brain_call_terminal(fluid_private.naming_brain_calls)','fluid_private.naming_brain_call_terminal','fluid_private.local_naming_previous_call_terminal'),
 ('fluid_private.naming_brain_can_resume(fluid_private.naming_brain_runs)','fluid_private.naming_brain_can_resume','fluid_private.local_naming_previous_can_resume'),
 ('fluid_private.naming_brain_ensure_response(fluid_private.naming_brain_runs,boolean)','fluid_private.naming_brain_ensure_response','fluid_private.local_naming_previous_ensure_response'),
 ('fluid_private.naming_candidate_dto(public.name_candidates)','fluid_private.naming_candidate_dto','fluid_private.local_naming_previous_candidate_dto'),
 ('fluid_private.naming_job_dto(public.naming_batches)','fluid_private.naming_job_dto','fluid_private.local_naming_previous_job_dto') loop
  definition:=pg_get_functiondef(signature::regprocedure);
  if position('FUNCTION '||source_name||'(' in definition)=0 then raise exception 'unexpected_progressive_delegate: %',signature; end if;
  execute replace(definition,'FUNCTION '||source_name||'(','FUNCTION '||prior_name||'(');
 end loop;
end $$;

create function fluid_private.local_naming_progressive_job(p_job uuid) returns boolean language sql stable set search_path='' as $$
 select fluid_private.local_prototype_unlimited_job(p_job) and exists(select 1 from public.jobs j where j.id=p_job and j.operation='naming.generate'
 and j.input->'localTimingVersion'='2'::jsonb and j.input->'localPipelineVersion'='2'::jsonb);
$$;

create function fluid_private.local_naming_progressive_researched(r fluid_private.naming_brain_runs) returns boolean language sql stable set search_path='' as $$
 select exists(select 1 from fluid_private.naming_brain_calls c join fluid_private.naming_brain_provider_records observed on observed.run_id=c.run_id and observed.call_key=c.call_key
 where c.run_id=r.id and c.request->>'role'='researcher' and c.phase_key='context.research' and fluid_private.naming_brain_call_completed(c)
 and(observed.kind='tool_result' or(observed.kind='provider_item' and(observed.payload#>>'{item,type}'='web_search_call' or(observed.payload#>>'{item,type}'='function_call' and observed.payload#>>'{item,name}'='read_reference')))));
$$;

create or replace function fluid_private.naming_brain_call_terminal(c fluid_private.naming_brain_calls) returns boolean language sql stable set search_path='' as $$
 select fluid_private.local_naming_previous_call_terminal(c) or(c.phase_key='context.direction' and c.request->>'role'='director'
 and exists(select 1 from fluid_private.naming_brain_runs r where r.id=c.run_id and r.owner_id=c.owner_id and r.project_id=c.project_id and fluid_private.local_naming_progressive_job(r.job_id))
 and exists(select 1 from fluid_private.naming_brain_stage_results result where result.run_id=c.run_id and result.stage_key='creation' and result.state='succeeded'
 and fluid_private.naming_brain_invalid_output(c,result.output)));
$$;

create function fluid_private.local_naming_progressive_basis(r fluid_private.naming_brain_runs) returns boolean language sql stable set search_path='' as $$
 select exists(select 1 from public.projects p join public.project_revisions revision on revision.project_id=p.id and revision.owner_id=p.owner_id and revision.revision=p.current_revision
 join public.naming_sessions session on session.project_id=p.id and session.owner_id=p.owner_id
 join fluid_private.naming_brain_heads h on h.project_id=p.id and h.owner_id=p.owner_id
 where p.id=r.project_id and p.owner_id=r.owner_id and p.deleted_at is null and p.deletion_requested_at is null and not r.superseded
 and h.current_run_id=r.id and h.steering_revision=(r.snapshot->>'steeringRevision')::integer
 and session.preferences_version=(r.snapshot->>'preferencesVersion')::integer and fluid_private.naming_strategy_basis(revision.context)=r.snapshot->'strategyBasis');
$$;

create function fluid_private.local_naming_progressive_current(r fluid_private.naming_brain_runs) returns boolean language sql stable set search_path='' as $$
 select fluid_private.local_naming_progressive_basis(r) and not exists(select 1 from fluid_private.naming_brain_heads where project_id=r.project_id and paused);
$$;



-- The many small genuine role calls retain their records independently. Keep the
-- historical aggregate bound unchanged and widen only the new immutable profile.
do $$ declare definition text; original text; begin
 definition:=pg_get_functiondef('fluid_private.local_naming_previous_worker_action(uuid,uuid,text,jsonb)'::regprocedure);
 original:=$old$if (select count(*) from fluid_private.naming_brain_provider_records where run_id=r.id)>=500 or (select coalesce(sum(octet_length(payload::text)),0) from fluid_private.naming_brain_provider_records where run_id=r.id)+octet_length(p_payload::text)>8388608 then$old$;
 if(length(definition)-length(replace(definition,original,'')))/length(original)<>1 then raise exception 'unexpected_progressive_record_capacity_fragment';end if;
 execute replace(definition,original,$new$if (select count(*) from fluid_private.naming_brain_provider_records where run_id=r.id)>=(case when fluid_private.local_naming_progressive_job(r.job_id) then 5000 else 500 end)
 or (select coalesce(sum(octet_length(payload::text)),0) from fluid_private.naming_brain_provider_records where run_id=r.id)+octet_length(p_payload::text)>(case when fluid_private.local_naming_progressive_job(r.job_id) then 67108864 else 8388608 end) then$new$);
end $$;

do $$ declare definition text; original text; constraint_name text; begin
 definition:=pg_get_functiondef('public.ensure_naming_brain_run(uuid,jsonb)'::regprocedure);
 original:=$old$input:=input||jsonb_build_object('localTimingVersion',2);$old$;
 if (length(definition)-length(replace(definition,original,'')))/length(original)<>1 then raise exception 'unexpected_progressive_admission_fragment'; end if;
 execute replace(definition,original,$new$input:=input||jsonb_build_object('localTimingVersion',2,'localPipelineVersion',2);$new$);
 definition:=pg_get_functiondef('public.ensure_naming_brain_run(uuid,jsonb)'::regprocedure);
 original:=$old$if p_intent->>'reason'='resume' and fluid_private.naming_brain_free_resume(source) then$old$;
 if(length(definition)-length(replace(definition,original,'')))/length(original)<>1 then raise exception 'unexpected_progressive_saved_resume_fragment';end if;
 definition:=replace(definition,original,$new$if p_intent->>'reason'='resume' and (fluid_private.naming_brain_free_resume(source) or fluid_private.local_naming_progressive_saved_resume(source)) then$new$);
 original:=$old$and exists(select 1 from fluid_private.naming_brain_prepared_sets saved where saved.run_id=source.id and saved.prepared#>>'{fulfillment,status}'='complete') then$old$;
 if(length(definition)-length(replace(definition,original,'')))/length(original)<>1 then raise exception 'unexpected_progressive_saved_ack_fragment';end if;
 execute replace(definition,original,$new$and(exists(select 1 from fluid_private.naming_brain_prepared_sets saved where saved.run_id=source.id and saved.prepared#>>'{fulfillment,status}'='complete')
 or(fluid_private.local_naming_progressive_job(source.job_id) and exists(select 1 from fluid_private.naming_brain_progressive_results where run_id=source.id))) then$new$);
 definition:=pg_get_functiondef('public.ensure_local_naming_brain_run(uuid,jsonb)'::regprocedure);
 original:=$old$ return result;
end$old$;
 if(length(definition)-length(replace(definition,original,'')))/length(original)<>1 then raise exception 'unexpected_progressive_admission_ack_fragment';end if;
 execute replace(definition,original,$new$ if r.id is not null and fluid_private.local_naming_progressive_job(r.job_id) then
 return fluid_private.naming_brain_ensure_response(r,coalesce((result->>'reused')::boolean,false));end if;
 return result;
end$new$);
 definition:=pg_get_functiondef('public.record_naming_brain_provider_receipt(uuid,uuid,jsonb)'::regprocedure);
 original:=$old$or p_receipt->'budgetControl' is distinct from c.request#>'{policy,budgetControl}'$old$;
 if (length(definition)-length(replace(definition,original,'')))/length(original)<>1 then raise exception 'unexpected_progressive_receipt_fragment'; end if;
 execute replace(definition,original,original||$new$
 or p_receipt->'localPipelineVersion' is distinct from c.request#>'{policy,localPipelineVersion}'$new$);
 definition:=pg_get_functiondef('public.steer_naming_feed(uuid,jsonb)'::regprocedure);
 original:=$old$and not exists(select 1 from fluid_private.naming_brain_feed_entries where run_id=rr.id) and (exists$old$;
 if(length(definition)-length(replace(definition,original,'')))/length(original)<>1 then raise exception 'unexpected_progressive_steering_fragment';end if;
 execute replace(definition,original,$new$and(not exists(select 1 from fluid_private.naming_brain_feed_entries where run_id=rr.id)
 or(fluid_private.local_naming_progressive_job(rr.job_id) and exists(select 1 from public.jobs active_job where active_job.id=rr.job_id and active_job.state in('queued','running','cancel_requested','needs_reconciliation')))) and (exists$new$);
 select conname into strict constraint_name from pg_constraint where conrelid='fluid_private.naming_brain_call_plans'::regclass and contype='c' and pg_get_constraintdef(oid) like '%phase_key%';
 execute format('alter table fluid_private.naming_brain_call_plans drop constraint %I',constraint_name);
 alter table fluid_private.naming_brain_call_plans add constraint naming_brain_call_phase_check check(
 (stage_key='gap' and phase_key in('direction','creation','curation','verification')) or(stage_key<>'gap' and phase_key='main')
 or(stage_key='creation' and (phase_key in('context.research','context.direction') or phase_key~'^part[0-9]{3}\.(creation|curation|verification)$')));
end $$;

create function fluid_private.local_naming_progressive_counts(r fluid_private.naming_brain_runs) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('publishedCount',(select count(*)::int from fluid_private.naming_brain_feed_entries where run_id=r.id),
 'primaryCounts',(select coalesce(jsonb_agg(jsonb_build_object('approach',a,'count',(select count(*)::int from fluid_private.naming_brain_feed_entries f where f.run_id=r.id and f.metadata->>'primaryApproach'=a)) order by n),'[]')
 from jsonb_array_elements_text(r.snapshot#>'{preferences,approaches}') with ordinality selected(a,n)));
$$;

create or replace function fluid_private.naming_brain_preparation_pending(r fluid_private.naming_brain_runs) returns boolean language sql stable set search_path='' as $$
 select case when not fluid_private.local_naming_progressive_job(r.job_id) then fluid_private.local_naming_previous_preparation_pending(r) else
 fluid_private.local_naming_progressive_current(r) and fluid_private.local_naming_progressive_researched(r)
 and fluid_private.local_naming_progressive_counts(r)->'publishedCount'='100'::jsonb
 and not exists(select 1 from jsonb_array_elements(fluid_private.local_naming_progressive_counts(r)->'primaryCounts') count where(count->>'count')::integer<5)
 and exists(select 1 from public.jobs j where j.id=r.job_id and j.owner_id=r.owner_id and j.project_id=r.project_id and j.cancel_requested_at is null
 and j.plan_registered_at is not null and j.plan_manifest='[{"key":"creation","maximumCostMicrousd":1500000},{"key":"prepare","maximumCostMicrousd":0}]'::jsonb
 and j.plan_fingerprint=encode(sha256(convert_to(j.plan_manifest::text,'UTF8')),'hex'))
 and exists(select 1 from public.job_steps where job_id=r.job_id and owner_id=r.owner_id and project_id=r.project_id and step_key='creation' and state='succeeded')
 and not exists(select 1 from public.job_steps where job_id=r.job_id and(step_key not in('creation','prepare') or(step_key='prepare' and(reserved_cost_microusd<>0 or state not in('in_flight','ambiguous','succeeded')
 or(state='succeeded' and not exists(select 1 from fluid_private.naming_brain_progressive_results where run_id=r.id))))))
 and not exists(select 1 from fluid_private.naming_brain_calls c where c.run_id=r.id and not fluid_private.naming_brain_call_terminal(c)) end;
$$;

create function fluid_private.local_naming_progressive_saved_resume(r fluid_private.naming_brain_runs) returns boolean language sql stable set search_path='' as $$
 select fluid_private.local_naming_progressive_job(r.job_id) and fluid_private.local_naming_progressive_basis(r)
 and exists(select 1 from fluid_private.naming_brain_heads where project_id=r.project_id and owner_id=r.owner_id and paused)
 and exists(select 1 from fluid_private.naming_brain_progressive_results where run_id=r.id and owner_id=r.owner_id and project_id=r.project_id)
 and exists(select 1 from public.jobs where id=r.job_id and state in('succeeded','partial','failed','cancelled'))
 and not exists(select 1 from public.jobs where owner_id=r.owner_id and project_id=r.project_id and operation='naming.generate' and state in('queued','running','cancel_requested','needs_reconciliation'))
 and not exists(select 1 from fluid_private.naming_brain_calls c where c.run_id=r.id and not fluid_private.naming_brain_call_terminal(c));
$$;
create or replace function fluid_private.naming_brain_can_resume(r fluid_private.naming_brain_runs) returns boolean language sql stable set search_path='' as $$
 select fluid_private.local_naming_previous_can_resume(r) or fluid_private.local_naming_progressive_saved_resume(r);
$$;

create function fluid_private.local_naming_progressive_state(r fluid_private.naming_brain_runs,p_stage text,p_phase text default null,p_call text default null) returns jsonb language plpgsql stable set search_path='' as $$
 declare scope_prefix text; s public.job_steps; stage jsonb; counts jsonb; begin
 if p_stage not in('creation','prepare') then raise exception 'invalid_stage' using errcode='22023'; end if;
 if p_call is not null then
 select cp.phase_key into p_phase from fluid_private.naming_brain_call_plans cp cross join lateral jsonb_array_elements(cp.calls) allocation where cp.run_id=r.id and allocation->>'providerCallKey'=p_call;
 if not found then raise exception 'unknown_progressive_call' using errcode='22023'; end if;
 end if;
 scope_prefix:=case when p_phase like 'part%' then split_part(p_phase,'.',1)||'.' when p_phase is not null then 'context.' else null end;
 select * into s from public.job_steps where job_id=r.job_id and step_key=p_stage;
 with scoped as(select c.* from fluid_private.naming_brain_calls c where c.run_id=r.id and c.stage_key=p_stage and (scope_prefix is null or c.phase_key like scope_prefix||'%' or c.phase_key like 'context.%'))
 select jsonb_build_object('stageKey',p_stage,'preparation',null,'state',coalesce(s.state,'pending'),'requestKey',s.request_key,'startedAt',s.created_at,'maximumCostMicrousd',fluid_private.naming_brain_cap(p_stage),
 'recoveryMode',r.recovery_mode,'observationDeadlineAt',r.observation_deadline_at,'gapEnvelope',r.gap_envelope,'gapPlanIdentity',r.gap_plan_identity,
 'stageResults',coalesce((select jsonb_agg(to_jsonb(result)-array['owner_id','project_id'] order by result.created_at,result.id) from fluid_private.naming_brain_stage_results result where result.run_id=r.id and result.stage_key=p_stage),'[]'),
 'artifacts',coalesce((select jsonb_agg(a.artifact order by a.id) from fluid_private.naming_brain_artifacts a where a.run_id=r.id and a.stage_key=p_stage
 and(exists(select 1 from scoped c where c.call_key=a.artifact#>>'{providerReceipt,providerCallKey}')
 or exists(select 1 from fluid_private.naming_brain_progressive_plans p cross join lateral jsonb_array_elements(p.requests) request
 where p.run_id=r.id and(scope_prefix is null or p.phase_key like scope_prefix||'%' or p.phase_key like 'context.%') and request->'dependencyArtifactIds' ? a.id::text))),'[]'),
 'receipts',coalesce((select jsonb_agg(q.receipt order by q.created_at,q.id) from fluid_private.naming_brain_receipts q join scoped c on c.call_key=q.call_key where q.run_id=r.id and q.stage_key=p_stage),'[]'),
 'requests',coalesce((select jsonb_agg(request order by authorized_at,call_key) from scoped),'[]'),
 'authorizations',coalesce((select jsonb_agg(jsonb_build_object('providerCallKey',call_key,'requestHash',request->>'requestHash','authorizedAt',authorized_at) order by authorized_at,call_key) from scoped),'[]'),
 'providerItems',coalesce((select jsonb_agg(p.payload order by p.id) from fluid_private.naming_brain_provider_records p join scoped c on c.call_key=p.call_key where p.run_id=r.id and p.stage_key=p_stage and p.kind='provider_item'),'[]'),
 'providerTurns',coalesce((select jsonb_agg(p.payload order by p.id) from fluid_private.naming_brain_provider_records p join scoped c on c.call_key=p.call_key where p.run_id=r.id and p.stage_key=p_stage and p.kind='provider_turn'),'[]'),
 'toolResults',coalesce((select jsonb_agg(p.payload order by p.id) from fluid_private.naming_brain_provider_records p join scoped c on c.call_key=p.call_key where p.run_id=r.id and p.stage_key=p_stage and p.kind='tool_result'),'[]'),
 'callPlans',coalesce((select jsonb_agg(jsonb_build_object('phase',cp.phase_key,'calls',cp.calls) order by cp.phase_key) from fluid_private.naming_brain_call_plans cp where cp.run_id=r.id and cp.stage_key=p_stage and (scope_prefix is null or cp.phase_key like scope_prefix||'%' or cp.phase_key like 'context.%')),'[]')) into stage;
 counts:=fluid_private.local_naming_progressive_counts(r);
 return counts||jsonb_build_object('stage',stage,'plannedRequests',coalesce((select jsonb_agg(request order by p.phase_key,n) from fluid_private.naming_brain_progressive_plans p cross join lateral jsonb_array_elements(p.requests) with ordinality plan(request,n) where p.run_id=r.id and (scope_prefix is null or p.phase_key like scope_prefix||'%' or p.phase_key like 'context.%')),'[]'),
 'publications',coalesce((select jsonb_agg(jsonb_build_object('key',m.microbatch_key,'publicationId',m.id,'entryIds',m.publication->'entryIds','candidateIds',m.publication->'candidateIds') order by m.microbatch_key) from fluid_private.naming_brain_microbatches m where m.run_id=r.id),'[]'));
end $$;

create function fluid_private.local_naming_progressive_authorize(p_job uuid,p_token uuid,p_request jsonb) returns boolean language plpgsql set search_path='' as $$
 declare r fluid_private.naming_brain_runs; j public.jobs; phase text; saved jsonb; begin
 r:=fluid_private.naming_brain_lock(p_job,p_token); select * into strict j from public.jobs where id=p_job;
 if not fluid_private.local_naming_progressive_job(j.id) or not fluid_private.local_naming_progressive_current(r) or r.recovery_mode<>'execute' or r.superseded or j.state<>'running' or j.cancel_requested_at is not null
 or not fluid_private.naming_brain_ready(r,j.worker_id) or exists(select 1 from fluid_private.naming_brain_heads where project_id=r.project_id and paused)
 or exists(select 1 from public.projects where id=r.project_id and(deleted_at is not null or deletion_requested_at is not null)) then return false; end if;
 select p.phase_key,request into phase,saved from fluid_private.naming_brain_progressive_plans p cross join lateral jsonb_array_elements(p.requests) request where p.run_id=r.id and request->>'providerCallKey'=p_request->>'providerCallKey';
 if saved is null or saved is distinct from p_request or p_request->>'stageKey'<>'creation' or p_request#>'{policy,localPipelineVersion}' is distinct from '2'::jsonb
 or p_request#>>'{policy,budgetControl}' is distinct from 'local_unlimited_v1' or p_request#>'{policy,deadlineMs}' is distinct from '900000'::jsonb
 or p_request#>>'{policy,model}' is distinct from r.policy->>'model' or p_request#>>'{policy,reasoningEffort}' is distinct from 'xhigh'
 or p_request#>>'{policy,protocol}' is distinct from 'openai_agents' or p_request#>'{policy,nativeDelegation}' is distinct from 'false'::jsonb
 or p_request->>'runId' is distinct from r.id::text or p_request->>'snapshotHash' is distinct from r.snapshot_hash or ((p_request#>'{input,snapshot}')-'strategyKey') is distinct from r.snapshot
 then raise exception 'invalid_progressive_dispatch' using errcode='22023'; end if;
 if not exists(select 1 from public.job_steps where job_id=j.id and step_key='creation' and state='in_flight' and created_at+interval '1 hour'>clock_timestamp()) then raise exception 'stage_not_started' using errcode='55000'; end if;
 if exists(select 1 from jsonb_array_elements_text(p_request->'dependencyArtifactIds') id where not exists(select 1 from fluid_private.naming_brain_artifacts a where a.id=id::uuid and a.run_id=r.id and a.owner_id=r.owner_id and a.project_id=r.project_id)) then raise exception 'dependency_mismatch' using errcode='22023'; end if;
 if exists(select 1 from fluid_private.naming_brain_calls where run_id=r.id and call_key=p_request->>'providerCallKey') then return false; end if;
 insert into fluid_private.naming_brain_calls(run_id,owner_id,project_id,stage_key,phase_key,call_key,request) values(r.id,r.owner_id,r.project_id,'creation',phase,p_request->>'providerCallKey',p_request); return true;
end $$;

create function fluid_private.local_naming_progressive_action(p_job uuid,p_token uuid,p_action text,p_payload jsonb) returns jsonb language plpgsql set search_path='' as $$
 declare r fluid_private.naming_brain_runs; j public.jobs; s public.job_steps; phase text:=p_payload->>'phase'; role text; v_request jsonb; requests jsonb:=p_payload->'requests'; allocations jsonb;
 old jsonb; manifest jsonb; counts jsonb; completion fluid_private.naming_brain_progressive_results; candidate_ids jsonb; entry_ids jsonb; publication_ids jsonb;
 begin
 if jsonb_typeof(p_payload) is distinct from 'object' or octet_length(p_payload::text)>1048576 then raise exception 'invalid_worker_payload' using errcode='22023'; end if;
 -- Read snapshots use the current lease and restricted identity without taking
 -- the same-job update lock on every transport state load.
 if p_action in('progressive_state','stage') then
 select * into j from public.jobs where id=p_job; select * into r from fluid_private.naming_brain_runs where job_id=p_job;
 if not fluid_private.local_naming_progressive_job(p_job) or not fluid_private.naming_brain_run_worker(r) then raise exception 'worker_owner_mismatch' using errcode='42501'; end if;
 if p_token is null or j.lease_token is distinct from p_token or j.lease_expires_at<=clock_timestamp() or j.state not in('running','cancel_requested') then raise exception 'lease_lost' using errcode='PT409'; end if;
 if p_action='stage' then return fluid_private.local_naming_progressive_state(r,p_payload->>'stageKey')->'stage'; end if;
 return fluid_private.local_naming_progressive_state(r,'creation',phase,p_payload->>'providerCallKey');
 end if;
 r:=fluid_private.naming_brain_lock(p_job,p_token); select * into strict j from public.jobs where id=p_job;
 if not fluid_private.local_naming_progressive_job(j.id) then raise exception 'progressive_worker_required' using errcode='42501'; end if;
 case p_action
 when 'plan' then
 manifest:=jsonb_build_array(jsonb_build_object('key','creation','maximumCostMicrousd',1500000),jsonb_build_object('key','prepare','maximumCostMicrousd',0));
 if p_payload->'manifest' is distinct from manifest or p_payload->'gapEnvelope' is distinct from r.gap_envelope then raise exception 'plan_conflict' using errcode='PT409'; end if;
 perform public.register_job_plan(j.id,p_token,manifest);return manifest;
 when 'begin' then
 if p_payload->>'stageKey' not in('creation','prepare') then raise exception 'invalid_stage' using errcode='22023'; end if;
 select * into s from public.job_steps where job_id=j.id and step_key=p_payload->>'stageKey';
 if found then
 if s.request_key is distinct from p_payload->>'requestKey' then raise exception 'step_identity_conflict' using errcode='PT409'; end if;
 if s.state='succeeded' then return jsonb_build_object('disposition','already_succeeded','step',to_jsonb(s)); end if;
 if s.state in('in_flight','ambiguous') then return jsonb_build_object('disposition',case when r.recovery_mode='observe_only' then 'resume_observation' else 'started' end,'step',to_jsonb(s)); end if;
 end if;
 if not fluid_private.local_naming_progressive_current(r) or j.cancel_requested_at is not null or r.superseded or exists(select 1 from fluid_private.naming_brain_heads where project_id=r.project_id and paused)
 or exists(select 1 from public.projects where id=r.project_id and(deleted_at is not null or deletion_requested_at is not null)) then raise exception 'runtime_unavailable' using errcode='55000'; end if;
 if p_payload->>'stageKey'='creation' and(r.recovery_mode<>'execute' or not fluid_private.naming_brain_ready(r,j.worker_id)) then raise exception 'runtime_unavailable' using errcode='55000'; end if;
 if p_payload->>'stageKey'='prepare' and not exists(select 1 from public.job_steps where job_id=j.id and step_key='creation' and state='succeeded') then raise exception 'dependency_incomplete' using errcode='55000'; end if;
 s:=public.begin_job_step(j.id,p_token,p_payload->>'stageKey',p_payload->>'requestKey',fluid_private.naming_brain_cap(p_payload->>'stageKey'));
 return jsonb_build_object('disposition','started','step',to_jsonb(s));
 when 'progressive_call_plan' then
 if not fluid_private.local_naming_progressive_current(r) or r.recovery_mode<>'execute' or j.state<>'running' or j.cancel_requested_at is not null or not fluid_private.naming_brain_ready(r,j.worker_id)
 or not exists(select 1 from public.job_steps where job_id=j.id and step_key='creation' and state='in_flight' and created_at+interval '1 hour'>clock_timestamp()) then raise exception 'observation_only' using errcode='55000'; end if;
 if phase not in('context.research','context.direction') and coalesce(phase,'')!~'^part[0-9]{3}\.(creation|curation|verification)$' then raise exception 'invalid_call_phase' using errcode='22023'; end if;
 role:=case when phase='context.research' then 'researcher' when phase='context.direction' then 'director' when phase like '%.creation' then 'creator' when phase like '%.curation' then 'curator' else 'verifier' end;
 if p_payload-array['phase','requests']<>'{}'::jsonb or jsonb_typeof(requests) is distinct from 'array' or jsonb_array_length(requests) not between 1 and 3 or octet_length(requests::text)>524288 then raise exception 'invalid_call_plan' using errcode='22023'; end if;
 select p.requests into old from fluid_private.naming_brain_progressive_plans p where p.run_id=r.id and p.phase_key=phase;
 if found then if old is distinct from requests then raise exception 'immutable_call_plan' using errcode='55000'; end if; return old; end if;
 for v_request in select value from jsonb_array_elements(requests) loop
 if v_request->>'runId' is distinct from r.id::text or v_request->>'snapshotHash' is distinct from r.snapshot_hash or v_request->>'stageKey' is distinct from 'creation'
 or v_request->>'role' is distinct from role or v_request#>>'{input,role}' is distinct from role or v_request#>>'{policy,role}' is distinct from role
 or v_request#>'{policy,localPipelineVersion}' is distinct from '2'::jsonb or v_request#>>'{policy,budgetControl}' is distinct from 'local_unlimited_v1'
 or v_request#>'{policy,deadlineMs}' is distinct from '900000'::jsonb or v_request#>>'{policy,model}' is distinct from r.policy->>'model'
 or ((v_request#>'{input,snapshot}')-'strategyKey') is distinct from r.snapshot or coalesce(v_request->>'requestHash','')!~'^[a-f0-9]{64}$'
 or coalesce(v_request->>'providerCallKey','')!~'^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$' or not fluid_private.naming_brain_request_key(v_request->'requestKey')
 or ((role='creator')<>(v_request->>'assignmentKey' is not null)) or octet_length(v_request::text)>131072 then raise exception 'invalid_progressive_call_plan' using errcode='22023'; end if;
 if exists(select 1 from fluid_private.naming_brain_progressive_plans prior cross join lateral jsonb_array_elements(prior.requests) p where prior.run_id=r.id and p->>'providerCallKey'=v_request->>'providerCallKey') then raise exception 'call_identity_reused' using errcode='22023'; end if;
 end loop;
 if(select count(distinct request->>'providerCallKey') from jsonb_array_elements(requests) request)<>jsonb_array_length(requests) then raise exception 'call_identity_reused' using errcode='22023'; end if;
 select jsonb_agg(jsonb_build_object('providerCallKey',request->'providerCallKey','assignmentKey',request->'assignmentKey','requestKey',request->'requestKey','requestHash',request->'requestHash','sessionLimitCents',request#>'{policy,sessionLimitCents}','maxWebSearchCalls',request#>'{policy,maxWebSearchCalls}','role',request->'role') order by n) into allocations from jsonb_array_elements(requests) with ordinality p(request,n);
 insert into fluid_private.naming_brain_call_plans values(r.id,r.owner_id,r.project_id,'creation',phase,allocations);
 insert into fluid_private.naming_brain_progressive_plans(run_id,owner_id,project_id,phase_key,requests) values(r.id,r.owner_id,r.project_id,phase,requests);return requests;
 when 'publish_microbatch' then return fluid_private.local_naming_publish_microbatch(r,p_payload);
 when 'resume_execution' then
 select * into s from public.job_steps where job_id=j.id and step_key='creation';
 if not fluid_private.local_naming_progressive_current(r) or s.state not in('in_flight','ambiguous') or s.created_at+interval '1 hour'<=clock_timestamp() or j.state<>'running' or j.cancel_requested_at is not null or r.superseded
 or not fluid_private.naming_brain_ready(r,j.worker_id) or exists(select 1 from fluid_private.naming_brain_heads where project_id=r.project_id and paused)
 or exists(select 1 from public.projects where id=r.project_id and(deleted_at is not null or deletion_requested_at is not null))
 or exists(select 1 from fluid_private.naming_brain_calls c where c.run_id=r.id and not fluid_private.naming_brain_call_terminal(c)) then return jsonb_build_object('recoveryMode',r.recovery_mode,'resumed',false); end if;
 if s.state='ambiguous' then update public.job_steps set state='in_flight',output=null,completed_at=null where id=s.id; end if;
 update fluid_private.naming_brain_runs set recovery_mode='execute' where id=r.id;return jsonb_build_object('recoveryMode','execute','resumed',true);
 when 'finalize_progressive' then
 select * into completion from fluid_private.naming_brain_progressive_results where run_id=r.id;
 if found then return jsonb_build_object('completionId',completion.id,'publishedCount',100); end if;
 counts:=fluid_private.local_naming_progressive_counts(r);
 if not fluid_private.local_naming_progressive_current(r) or counts->'publishedCount' is distinct from '100'::jsonb or exists(select 1 from jsonb_array_elements(counts->'primaryCounts') c where(c->>'count')::integer<5)
 or j.cancel_requested_at is not null or r.superseded or exists(select 1 from fluid_private.naming_brain_heads where project_id=r.project_id and paused)
 or exists(select 1 from public.projects where id=r.project_id and(deleted_at is not null or deletion_requested_at is not null))
 or not exists(select 1 from public.job_steps where job_id=j.id and step_key='prepare' and state='in_flight')
 or exists(select 1 from fluid_private.naming_brain_calls c where c.run_id=r.id and not fluid_private.naming_brain_call_terminal(c)) then raise exception 'progressive_completion_incomplete' using errcode='55000'; end if;
 if not fluid_private.local_naming_progressive_researched(r) then raise exception 'external_research_attempt_required' using errcode='55000'; end if;
 select jsonb_agg(candidate_id order by position),jsonb_agg(id order by position) into candidate_ids,entry_ids from fluid_private.naming_brain_feed_entries where run_id=r.id;
 select jsonb_agg(id order by created_at,id) into publication_ids from fluid_private.naming_brain_microbatches where run_id=r.id;
 insert into fluid_private.naming_brain_progressive_results(run_id,owner_id,project_id,result) values(r.id,r.owner_id,r.project_id,counts||jsonb_build_object('version',1,'runId',r.id,'targetCount',100,'candidateIds',candidate_ids,'entryIds',entry_ids,'sourcePublicationIds',publication_ids)) returning * into completion;
 insert into public.naming_batch_results(batch_id,owner_id,project_id,result,completion_input) values(r.batch_id,r.owner_id,r.project_id,jsonb_build_object('version',2,'localPipelineVersion',2,'ownerId',r.owner_id,'projectId',r.project_id,'batchId',r.batch_id,'jobId',r.job_id,'runId',r.id,'completionId',completion.id,'stepKey','prepare','candidateIds',candidate_ids,
 'fulfillment',jsonb_build_object('status','complete','targetCount',100,'acceptedCount',100,'missingCount',0,'coverageSatisfied',true,'message',null),'completedAt',completion.created_at),completion.result);
 return jsonb_build_object('completionId',completion.id,'publishedCount',100);
 when 'finish' then
 if p_payload->>'state' not in('succeeded','partial','failed','cancelled') or exists(select 1 from public.job_steps where job_id=j.id and state in('in_flight','ambiguous')) then raise exception 'unresolved_steps' using errcode='55000'; end if;
 if j.cancel_requested_at is not null and p_payload->>'state'<>'cancelled' then raise exception 'cancel_requested' using errcode='55000'; end if;
 if p_payload->>'state'='succeeded' and(not exists(select 1 from fluid_private.naming_brain_progressive_results where run_id=r.id) or(select count(*) from public.job_steps where job_id=j.id and step_key in('creation','prepare') and state='succeeded')<>2) then raise exception 'plan_incomplete' using errcode='55000'; end if;
 update public.jobs set state=p_payload->>'state',finished_at=clock_timestamp(),lease_token=null,lease_expires_at=null,progress=case when p_payload->>'state'='succeeded' then 100 else progress end,error_code=p_payload->>'errorCode' where id=j.id;
 update fluid_private.naming_brain_runs set revision=revision+1,updated_at=clock_timestamp() where id=r.id;
 return jsonb_build_object('state',p_payload->>'state','accounting',fluid_private.naming_brain_accounting(r));
 when 'heartbeat' then
 if r.recovery_mode='execute' and not fluid_private.local_naming_progressive_current(r) then
 update public.jobs set state='cancel_requested',cancel_requested_at=coalesce(cancel_requested_at,clock_timestamp()) where id=j.id and state='running';
 update fluid_private.naming_brain_runs set superseded=not exists(select 1 from fluid_private.naming_brain_heads where project_id=r.project_id and paused),revision=revision+1,updated_at=clock_timestamp() where id=r.id;
 end if;
 return fluid_private.local_naming_previous_worker_action(p_job,p_token,p_action,p_payload);
 when 'provider_item','tool_result','provider_turn','artifact','index_page','index_record','index_finalize','identities' then
 return fluid_private.local_naming_previous_worker_action(p_job,p_token,p_action,p_payload);
 else raise exception 'unsupported_progressive_action' using errcode='22023'; end case;
end $$;

create or replace function public.naming_brain_worker_action(p_job_id uuid,p_lease_token uuid,p_action text,p_payload jsonb default '{}') returns jsonb language plpgsql security definer set search_path='' as $$
begin
 if fluid_private.local_naming_progressive_job(p_job_id) then return fluid_private.local_naming_progressive_action(p_job_id,p_lease_token,p_action,p_payload); end if;
 return fluid_private.local_naming_previous_worker_action(p_job_id,p_lease_token,p_action,p_payload);
end $$;
create or replace function public.authorize_naming_brain_dispatch(p_job_id uuid,p_lease_token uuid,p_request jsonb) returns boolean language plpgsql security definer set search_path='' as $$
begin
 if fluid_private.local_naming_progressive_job(p_job_id) then return fluid_private.local_naming_progressive_authorize(p_job_id,p_lease_token,p_request); end if;
 return fluid_private.local_naming_previous_authorize(p_job_id,p_lease_token,p_request);
end $$;
create or replace function public.complete_naming_brain_stage(p_job_id uuid,p_lease_token uuid,p_stage_key text,p_state text,p_output jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare r fluid_private.naming_brain_runs; s public.job_steps; counts jsonb; begin
 if not fluid_private.local_naming_progressive_job(p_job_id) then return fluid_private.local_naming_previous_complete(p_job_id,p_lease_token,p_stage_key,p_state,p_output); end if;
 r:=fluid_private.naming_brain_lock(p_job_id,p_lease_token);select * into s from public.job_steps where job_id=p_job_id and step_key=p_stage_key for update;
 if not found or p_stage_key not in('creation','prepare') or p_state not in('succeeded','failed','ambiguous') or jsonb_typeof(p_output) is distinct from 'object'
 or p_output-array['artifactIds','errorCode','partialArtifacts']<>'{}'::jsonb or jsonb_typeof(p_output->'artifactIds') is distinct from 'array' or octet_length(p_output::text)>524288 then raise exception 'invalid_stage_result' using errcode='22023'; end if;
 if s.state not in('in_flight','ambiguous') then if s.state=p_state and s.output=p_output then return to_jsonb(s); end if;raise exception 'immutable_stage_result' using errcode='55000'; end if;
 if exists(select 1 from jsonb_array_elements_text(p_output->'artifactIds') id where not exists(select 1 from fluid_private.naming_brain_artifacts a where a.id=id::uuid and a.run_id=r.id and a.stage_key='creation')) then raise exception 'artifact_mismatch' using errcode='22023'; end if;
 if exists(select 1 from fluid_private.naming_brain_calls c where c.run_id=r.id and not fluid_private.naming_brain_call_terminal(c) and not fluid_private.naming_brain_local_not_dispatched(c,p_output) and not fluid_private.naming_brain_invalid_output(c,p_output)
 and not(p_state='failed' and p_output->>'errorCode'='provider_request_rejected' and fluid_private.naming_brain_rejected_receipt(c))) then p_state:='ambiguous'; end if;
 counts:=fluid_private.local_naming_progressive_counts(r);
 if p_state='succeeded' and p_stage_key='creation' and(counts->'publishedCount' is distinct from '100'::jsonb or exists(select 1 from jsonb_array_elements(counts->'primaryCounts') c where(c->>'count')::integer<5)) then raise exception 'progressive_creation_incomplete' using errcode='55000'; end if;
 if p_state='succeeded' and p_stage_key='creation' and not fluid_private.local_naming_progressive_researched(r) then raise exception 'external_research_attempt_required' using errcode='55000'; end if;
 if p_state='succeeded' and p_stage_key='prepare' and not exists(select 1 from fluid_private.naming_brain_progressive_results where run_id=r.id) then raise exception 'preparation_required' using errcode='55000'; end if;
 insert into fluid_private.naming_brain_stage_results(run_id,owner_id,project_id,stage_key,state,output) values(r.id,r.owner_id,r.project_id,p_stage_key,p_state,p_output);
 update public.job_steps set state=p_state,output=p_output,completed_at=clock_timestamp() where id=s.id returning * into s;
 update fluid_private.naming_brain_runs set recovery_mode=case when p_state='ambiguous' then 'observe_only' else recovery_mode end,revision=revision+1,updated_at=clock_timestamp() where id=r.id;
 if p_state='ambiguous' then update public.jobs set state='needs_reconciliation',lease_token=null,lease_expires_at=null,error_code=coalesce(p_output->>'errorCode','provider_outcome_unknown') where id=p_job_id; end if;
 return to_jsonb(s);
end $$;

create or replace function fluid_private.naming_brain_summary(r fluid_private.naming_brain_runs) returns jsonb language plpgsql stable set search_path='' as $$
 declare j public.jobs; counts jsonb; completion fluid_private.naming_brain_progressive_results; total integer; covered boolean; begin
 if not fluid_private.local_naming_progressive_job(r.job_id) then return fluid_private.local_naming_previous_summary(r); end if;
 select * into strict j from public.jobs where id=r.job_id;select * into completion from fluid_private.naming_brain_progressive_results where run_id=r.id;
 counts:=fluid_private.local_naming_progressive_counts(r);total:=(counts->>'publishedCount')::integer;covered:=not exists(select 1 from jsonb_array_elements(counts->'primaryCounts') c where(c->>'count')::integer<5);
 return jsonb_build_object('version',1,'ownerId',r.owner_id,'projectId',r.project_id,'runId',r.id,'jobId',r.job_id,'batchId',r.batch_id,'revision',r.revision,'resumedFromRunId',r.resumed_from_run_id,
 'localPipelineVersion',2,'canResume',fluid_private.local_naming_progressive_saved_resume(r) or(completion.id is null and fluid_private.local_naming_progressive_basis(r) and fluid_private.naming_brain_can_resume(r)),
 'canResumeSaved',fluid_private.local_naming_progressive_saved_resume(r),'state',case when r.superseded then 'superseded'
 when completion.id is not null and j.state in('succeeded','partial','failed','cancelled') and not exists(select 1 from fluid_private.naming_brain_calls c where c.run_id=r.id and not fluid_private.naming_brain_call_terminal(c)) then 'succeeded' else j.state end,
 'projectRevision',(r.snapshot->>'contextRevision')::integer,'preferencesVersion',(r.snapshot->>'preferencesVersion')::integer,'feedbackRevision',(r.snapshot->>'feedbackRevision')::integer,'steeringRevision',(r.snapshot->>'steeringRevision')::integer,'demandSequence',r.demand_sequence,
 'snapshotHash',r.snapshot_hash,'acceptedPolicyIdentity',r.policy_identity,'progress',total,'preparedSetId',null,
 'fulfillment',jsonb_build_object('status',case when total=0 then 'none' when total=100 and covered then 'complete' else 'partial' end,'targetCount',100,'acceptedCount',total,'missingCount',100-total,'coverageSatisfied',covered,'message',case when total=100 and covered then null else total::text||' of 100 names are saved. Exploration continues while the remaining names are reviewed.' end),
 'accounting',fluid_private.naming_brain_accounting(r),'createdAt',r.created_at,'updatedAt',r.updated_at)||case when completion.id is null then '{}'::jsonb else jsonb_build_object('progressiveCompletionId',completion.id) end;
end $$;

create or replace function fluid_private.naming_brain_ensure_response(r fluid_private.naming_brain_runs,p_reused boolean) returns jsonb language plpgsql set search_path='' as $$
 declare summary jsonb; begin
 if not fluid_private.local_naming_progressive_job(r.job_id) then return fluid_private.local_naming_previous_ensure_response(r,p_reused); end if;
 summary:=fluid_private.naming_brain_summary(r);
 if summary->>'state' in('queued','running','cancel_requested') then return jsonb_build_object('status','pending','feed',public.get_naming_feed(r.project_id),'run',summary,'reused',p_reused); end if;
 if exists(select 1 from fluid_private.naming_brain_progressive_results where run_id=r.id) then
 if exists(select 1 from fluid_private.naming_brain_heads where project_id=r.project_id and owner_id=r.owner_id and current_run_id=r.id) then
 return jsonb_build_object('status','appended','feed',public.get_naming_feed(r.project_id),'runId',r.id,'appendedEntryIds','[]'::jsonb); end if;
 return jsonb_build_object('status','paused','feed',public.get_naming_feed(r.project_id),'code','saved_exploration','message','These names are already saved. Continue from your current exploration.','action','none'); end if;
 if summary#>>'{fulfillment,status}'='complete' and summary->>'state' not in('partial','failed','cancelled') then return jsonb_build_object('status','blocked','feed',public.get_naming_feed(r.project_id),'code','completion_unresolved','message','All 100 reviewed names are saved. The remaining exploration outcome is still being resolved.','action','resolve');end if;
 if summary->>'state' in('partial','failed','cancelled','succeeded') then return jsonb_build_object('status','incomplete','feed',public.get_naming_feed(r.project_id),'run',summary,'fulfillment',summary->'fulfillment','message','Your saved names and unfinished work are retained.','canResume',summary->'canResume'); end if;
 return jsonb_build_object('status','blocked','feed',public.get_naming_feed(r.project_id),'code','dispatch_unresolved','message','The current provider outcome is still being resolved.','action','resolve');
end $$;

create or replace function public.get_naming_feed(p_project_id uuid,p_query jsonb default '{}') returns jsonb language plpgsql security definer set search_path='' as $$
 declare feed jsonb; r fluid_private.naming_brain_runs; counts jsonb; begin
 feed:=fluid_private.local_naming_previous_feed(p_project_id,p_query);
 if fluid_private.local_prototype_owner_enabled(auth.uid()) then feed:=feed||jsonb_build_object('retentionRevision',(select coalesce(sum(revision),0) from public.name_retention where owner_id=auth.uid() and project_id=p_project_id)); end if;
 select * into r from fluid_private.naming_brain_runs where id=(feed#>>'{activeRun,runId}')::uuid and owner_id=auth.uid() and project_id=p_project_id;
 if found and fluid_private.local_naming_progressive_job(r.job_id) then counts:=fluid_private.local_naming_progressive_counts(r);feed:=feed||jsonb_build_object('progressive',jsonb_build_object('version',1,'targetCount',100,'publishedCount',counts->'publishedCount')); end if;
 return feed;
end $$;

create or replace function public.get_naming_brain_run(p_project_id uuid,p_run_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
 declare result jsonb; begin
 result:=fluid_private.local_naming_previous_run(p_project_id,p_run_id);
 if result->'localPipelineVersion'='2'::jsonb then result:=result||jsonb_build_object('stages',(select jsonb_agg(stage order by case stage->>'stageKey' when 'creation' then 1 else 2 end) from jsonb_array_elements(result->'stages') stage where stage->>'stageKey' in('creation','prepare'))); end if;
 return result;
end $$;

create or replace function fluid_private.naming_candidate_dto(p_candidate public.name_candidates) returns jsonb language plpgsql stable set search_path='' as $$
 declare result jsonb; notes jsonb; begin
 result:=fluid_private.local_naming_previous_candidate_dto(p_candidate);
 select entry->'verificationNotes' into notes from fluid_private.naming_brain_microbatches m cross join lateral jsonb_array_elements(m.publication->'entries') entry
 where m.owner_id=p_candidate.owner_id and m.project_id=p_candidate.project_id and m.run_id=(p_candidate.origin->>'runId')::uuid and entry->>'candidateId'=p_candidate.id::text;
 if found then result:=result||jsonb_build_object('verificationNotes',coalesce(notes,'[]'::jsonb)); end if;return result;
end $$;

create or replace function fluid_private.naming_job_dto(p_batch public.naming_batches) returns jsonb language plpgsql stable set search_path='' as $$
 declare result jsonb; r fluid_private.naming_brain_runs; completion fluid_private.naming_brain_progressive_results; begin
 result:=fluid_private.local_naming_previous_job_dto(p_batch);
 select * into r from fluid_private.naming_brain_runs where batch_id=p_batch.id and owner_id=p_batch.owner_id and project_id=p_batch.project_id;
 if not found or not fluid_private.local_naming_progressive_job(r.job_id) then return result;end if;
 select * into completion from fluid_private.naming_brain_progressive_results where run_id=r.id;
 if found then result:=result||jsonb_build_object('results',jsonb_build_array(jsonb_build_object('stepKey','prepare','output',jsonb_build_object('version',2,'localPipelineVersion',2,'operation','naming.generate','handlerVersion','naming-brain-v1','provider','openai','billingMode','openai_api',
 'runId',r.id,'jobId',r.job_id,'batchId',r.batch_id,'completionId',completion.id,'completion',completion.result,'completedAt',completion.created_at))));end if;
 return result;
end $$;

create or replace function public.get_naming_brain_candidate_source(p_project_id uuid,p_candidate_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
 declare c public.name_candidates;r fluid_private.naming_brain_runs;a fluid_private.naming_brain_artifacts;m fluid_private.naming_brain_microbatches;proposal jsonb;verification jsonb;findings jsonb;
 begin
 select * into c from public.name_candidates where id=p_candidate_id and project_id=p_project_id and owner_id=auth.uid();if not found then raise exception 'not_found' using errcode='P0002';end if;
 select * into r from fluid_private.naming_brain_runs where id=(c.origin->>'runId')::uuid and owner_id=c.owner_id and project_id=c.project_id;
 if not found or not fluid_private.local_naming_progressive_job(r.job_id) then return fluid_private.local_naming_previous_source(p_project_id,p_candidate_id);end if;
 select * into a from fluid_private.naming_brain_artifacts where id=(c.origin->>'sourceArtifactId')::uuid and run_id=r.id and owner_id=c.owner_id and project_id=c.project_id;
 select m0.* into m from fluid_private.naming_brain_microbatches m0 join fluid_private.naming_brain_feed_entries f on f.metadata->>'microbatchId'=m0.id::text and f.run_id=m0.run_id and f.owner_id=m0.owner_id and f.project_id=m0.project_id
 where m0.run_id=r.id and m0.owner_id=c.owner_id and m0.project_id=c.project_id and f.candidate_id=c.id and m0.publication->'candidateIds' ? c.id::text;
 select candidate into proposal from jsonb_array_elements(a.artifact#>'{output,candidates}') candidate join jsonb_array_elements(a.artifact->'candidateIds') resolved on resolved->>'candidateKey'=candidate->>'candidateKey' where resolved->>'candidateId'=c.id::text;
 if m.request#>>'{verification,kind}'='verified' then select artifact into verification from fluid_private.naming_brain_artifacts where id=(m.request#>>'{verification,artifactId}')::uuid and run_id=r.id;end if;
 select coalesce(jsonb_agg(f),'[]') into findings from jsonb_array_elements(verification#>'{output,findings}') f where f->>'assignmentKey'=a.artifact#>>'{output,assignmentKey}' and f->>'candidateKey'=proposal->>'candidateKey';
 if a.id is null or m.id is null or proposal is null or(m.request#>>'{verification,kind}'='verified' and verification is null) then raise exception 'invalid_generated_source' using errcode='55000';end if;
 return jsonb_build_object('ownerId',c.owner_id,'projectId',c.project_id,'candidateId',c.id,'runId',r.id,'jobId',r.job_id,'batchId',r.batch_id,
 'snapshot',r.snapshot,'sourceArtifactId',a.id,'sourceStageKey',a.stage_key,'sourceCandidate',proposal,'verificationArtifactId',verification->'artifactId','verificationFindings',findings,'providerReceipt',a.artifact->'providerReceipt','creatorAttribution',a.artifact->'creatorAttribution',
 'preparedSetId',null,'preparedCandidateIds',m.publication->'candidateIds','microbatchId',m.id,'verificationMode',m.request#>'{verification,kind}');
end $$;

-- No worker/client receives direct table access or private helper execution.
do $$ declare item record; privilege record; begin
 for item in select c.oid,c.relowner owner from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='fluid_private' and c.relname in('naming_brain_progressive_plans','naming_brain_microbatches','naming_brain_progressive_results') loop
 for privilege in select distinct a.grantee from pg_class c,lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a where c.oid=item.oid and a.grantee<>item.owner loop
 execute format('revoke all on table %s from %s cascade',item.oid::regclass,case when privilege.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(privilege.grantee)) end);end loop;end loop;
 for item in select p.oid,p.proowner owner from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='fluid_private' and(p.proname like 'local_naming_progressive_%' or p.proname like 'local_naming_previous_%' or p.proname='local_naming_publish_microbatch') loop
 for privilege in select distinct a.grantee from pg_proc p,lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where p.oid=item.oid and a.grantee<>item.owner loop
 execute format('revoke all on function %s from %s cascade',item.oid::regprocedure,case when privilege.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(privilege.grantee)) end);end loop;end loop;
end $$;
commit;
