-- UNAPPLIED Identity image generation on the existing fixed Logo lane.
-- Requires the baseline + shared account/Logo/Storage packets. No login,
-- credential, provider call, historical rewrite or runtime grant is installed.
begin;
do $$begin
 if current_user<>'postgres' or to_regclass('fluid_private.shared_identity_requests') is not null
 or to_regprocedure('public.shared_logo_worker_action(jsonb,jsonb,text,jsonb)') is null
 or to_regprocedure('fluid_private.identity_root_evidence(public.identity_system_versions)') is null
 or to_regprocedure('fluid_private.shared_storage_slot_ready(uuid)') is null
 then raise exception 'shared_identity_install_prerequisite' using errcode='55000'; end if;
end $$;
-- The completed-system and byte-publication contract is pinned independently
-- of the new worker port; malformed or alternate predecessors are not upgraded.
do $identity_predecessors$
declare signature text;expected text;definer boolean;volatility text;
begin
 for signature,expected,definer,volatility in values
 ('fluid_private.capture_identity_reference_snapshot(uuid,bigint)','7dfe446ae519deafaed0cfaec5f36bea2bcf2337d739d77b44344bdb585e6aab',true,'v'),
 ('fluid_private.identity_check_files(public.identity_system_versions)','262c9f10133409576bb09db7c2523525cf28528995ad354234f2bb75054f6992',false,'s'),
 ('fluid_private.identity_components(jsonb)','7f5c1d28f120f54bb0be6533a916f4c3c4a186066ec9a66f3c55f60f4186dcdb',false,'i'),
 ('fluid_private.identity_manifest_shape(jsonb,uuid,uuid)','018456afdde2aceb244517c499959581769b7dd94bf3244d9e828779bcffc3b1',false,'s'),
 ('fluid_private.identity_root_evidence(public.identity_system_versions)','7304c48073c2b3361007629e703954f407513347c43efb1dd14c465d99ef4b64',false,'s'),
 ('fluid_private.logo_commit_asset(public.logo_asset_publications)','8e99110a507a470956cd2f19b8102b1c363c09a61261d56efc699beba00a8ca9',false,'v') loop
  if not exists(select 1 from pg_proc where oid=to_regprocedure(signature) and proowner=to_regrole('postgres')::oid and prosecdef=definer
   and provolatile::text=volatility and proconfig=array['search_path=""'] and not proleakproof
   and encode(sha256(convert_to(prosrc,'UTF8')),'hex')=expected) then raise exception 'shared_identity_contract_predecessor_mismatch: %',signature using errcode='55000';end if;
 end loop;
end $identity_predecessors$;
create table fluid_private.shared_identity_requests(
 owner_id uuid not null,project_id uuid not null,request_key text not null,intent jsonb not null,
 batch_id uuid not null unique references public.identity_batches(id),primary key(owner_id,project_id,request_key)
);
-- Admission provenance captures the actual approved fixed principal once;
-- future worker takeover remains logical policy/deployment based, not pinned
-- to that particular physical slot. Retirement never makes a legacy generic
-- worker eligible to consume this operation.
create table fluid_private.shared_identity_admissions(
 job_id uuid primary key references public.jobs(id),owner_id uuid not null,project_id uuid not null,
 slot_id uuid not null references fluid_private.shared_worker_slots(slot_id),role_name name not null,role_oid oid not null,
 input_hash text not null,policy_identity text not null,policy jsonb not null,deployment_id text not null,
 foreign key(job_id,owner_id,project_id) references public.jobs(id,owner_id,project_id)
);
create table fluid_private.shared_identity_rejected_intents(
 owner_id uuid not null,project_id uuid not null,request_key text not null,intent jsonb not null,
 reason text not null check(reason='explicit_cancel'),created_at timestamptz not null default clock_timestamp(),
 primary key(owner_id,project_id,request_key),foreign key(project_id,owner_id) references public.projects(id,owner_id)
);
create table fluid_private.shared_identity_calls(
 id uuid primary key default gen_random_uuid(),execution_id uuid not null references fluid_private.shared_worker_executions(execution_id),
 job_id uuid not null references public.jobs(id),step_key text not null,phase text not null check(phase in('specifications','board')),
 request_key text not null check(request_key~'^[a-f0-9]{64}$'),request_hash text not null check(request_hash~'^[a-f0-9]{64}$'),
 authorized_at timestamptz not null default clock_timestamp(),unique(job_id,step_key,phase),unique(job_id,request_key)
);
create table fluid_private.shared_identity_receipts(
 id uuid primary key default gen_random_uuid(),call_id uuid not null unique references fluid_private.shared_identity_calls(id),
 observation jsonb not null,recorded_at timestamptz not null default clock_timestamp()
);
create table fluid_private.shared_identity_prepared(
 job_id uuid not null references public.jobs(id),step_key text not null,execution_id uuid not null references fluid_private.shared_worker_executions(execution_id),
 output jsonb not null,text_receipt_id uuid not null references fluid_private.shared_identity_receipts(id),
 image_receipt_id uuid not null references fluid_private.shared_identity_receipts(id),publication_id uuid not null references public.logo_asset_publications(id),
 primary key(job_id,step_key)
);
-- Resolution records preserve the original ambiguous/in-flight row. They are
-- not provider-stop receipts and never erase an issued image outcome.
create table fluid_private.shared_identity_specification_cancellations(
 job_id uuid not null references public.jobs(id),step_key text not null,
 mode text not null check(mode in('no_provider_authorized','specifications_only')),
 receipt_id uuid references fluid_private.shared_identity_receipts(id),original_step jsonb not null,
 known_cost_microusd bigint not null check(known_cost_microusd>=0),recorded_at timestamptz not null default clock_timestamp(),
 primary key(job_id,step_key),check((mode='no_provider_authorized' and receipt_id is null and known_cost_microusd=0) or (mode='specifications_only' and receipt_id is not null))
);
create table fluid_private.shared_identity_reference_requests(
 owner_id uuid not null,project_id uuid not null,request_key uuid not null,intent jsonb not null,
 reference_id uuid not null unique references public.identity_references(id),primary key(owner_id,project_id,request_key)
);
create function fluid_private.shared_identity_policy_valid(p jsonb) returns boolean
language sql immutable set search_path='' as $$
 select coalesce(fluid_private.standalone_keys(p,array['operation','policyIdentity','handlerVersion','provider','model','engine','maxCostMicrousd','spendControl','textPolicy'])
 and p->>'operation'='identity.image' and p->>'policyIdentity'~'^[a-f0-9]{64}$' and p->>'handlerVersion'='identity-image-v1'
 and p->>'provider'='openai' and p->>'model'='gpt-image-2.5-sunburst-2026-09-08' and p->'engine'='null' and p->'maxCostMicrousd'='0' and p->>'spendControl'='uncapped'
 and fluid_private.standalone_keys(p->'textPolicy',array['version','model','serviceTier','pricingVersion','maxInputTokens','maxOutputTokens','maxInputBytes','maxOutputBytes','deadlineMs','maxTools'])
 and p#>'{textPolicy,version}'='1' and p#>>'{textPolicy,model}'='gpt-6.1-sol' and p#>>'{textPolicy,serviceTier}'='default' and p#>>'{textPolicy,pricingVersion}'='2026-10-03'
 and p#>'{textPolicy,maxTools}'='0' and fluid_private.identity_counter(p#>'{textPolicy,maxInputTokens}',true)<=32768
 and fluid_private.identity_counter(p#>'{textPolicy,maxOutputTokens}',true)<=8192
 and fluid_private.identity_counter(p#>'{textPolicy,maxInputBytes}') between 1024 and 131072
 and fluid_private.identity_counter(p#>'{textPolicy,maxOutputBytes}') between 1024 and 65536
 and fluid_private.identity_counter(p#>'{textPolicy,deadlineMs}') between 1000 and 240000,false);
$$;
create function fluid_private.shared_identity_customer(p_project uuid) returns uuid
language plpgsql volatile security definer set search_path='' as $$
declare o uuid:=auth.uid();c jsonb:=auth.jwt();sid uuid;
begin
 if session_user<>'authenticator' or current_setting('role')<>'authenticated' or o is null or c->>'sub' is distinct from o::text
 or c->>'role' is distinct from 'authenticated' or c->>'aud' is distinct from 'authenticated' or c->>'is_anonymous' is distinct from 'false'
 or jsonb_typeof(c->'exp') is distinct from 'number' or to_timestamp((c->>'exp')::double precision)<=clock_timestamp()
 or not exists(select 1 from fluid_private.shared_http_target where c->>'iss'=origin||'/auth/v1')
 then raise exception 'shared_identity_verified_account_required' using errcode='42501'; end if;
 sid:=(c->>'session_id')::uuid;
 perform 1 from auth.users where id=o for share;
 perform 1 from auth.sessions where id=sid and user_id=o for share;
 perform 1 from fluid_private.shared_accounts where owner_id=o for share;
 if not fluid_private.shared_account_customer_active(o) or not exists(select 1 from auth.sessions where id=sid and user_id=o and (not_after is null or not_after>clock_timestamp()))
 then raise exception 'shared_identity_account_unavailable' using errcode='42501'; end if;
 if not exists(select 1 from public.projects where id=p_project and owner_id=o and deleted_at is null and deletion_requested_at is null)
 then raise exception 'shared_identity_project_missing' using errcode='P0002'; end if;
 return o;
end $$;
create function fluid_private.shared_identity_runtime_ready(p_slot uuid) returns boolean
language plpgsql volatile set search_path='' as $$declare ready boolean;begin
 if to_regprocedure('fluid_private.shared_logo_slot_runtime_ready(uuid)') is null then return false;end if;
 execute 'select fluid_private.shared_logo_slot_runtime_ready($1)' into ready using p_slot;return coalesce(ready,false);
end $$;
create function fluid_private.shared_identity_policy(p_owner uuid) returns jsonb
language sql volatile security definer set search_path='' as $$
 select jsonb_build_object('policy',p.policy,'policyIdentity',p.policy_identity,'deploymentId',s.deployment_id,'slotId',s.slot_id,'roleName',s.role_name,'roleOid',s.role_oid)
 from fluid_private.shared_worker_slots s join fluid_private.shared_worker_policies p using(slot_id)
 where s.lane='logo' and s.enabled and s.expires_at>clock_timestamp() and s.instance_id is not null and p.operation='identity.image'
 and p.policy_identity=p.policy->>'policyIdentity' and fluid_private.shared_identity_policy_valid(p.policy)
 and fluid_private.shared_worker_role_safe(s.role_name,s.role_oid) and fluid_private.shared_storage_slot_ready(s.slot_id) and fluid_private.shared_identity_runtime_ready(s.slot_id)
 and fluid_private.shared_account_customer_active(p_owner) order by s.slot_index limit 1;
$$;
create function fluid_private.shared_identity_verified_system(s public.identity_system_versions) returns jsonb
language plpgsql stable set search_path='' as $$begin
 if s.source->>'kind'<>'generated' then raise exception 'identity_generated_source_required' using errcode='42501';end if;
 perform fluid_private.identity_root_evidence(s);return fluid_private.identity_system_json(s);
end $$;
create function fluid_private.shared_identity_batch_state(p_owner uuid,p_project uuid,p_batch uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare b public.identity_batches;j public.jobs;i public.identity_input_snapshots;intent jsonb;systems jsonb;n integer;terminal boolean;
begin
 select * into b from public.identity_batches where id=p_batch and owner_id=p_owner and project_id=p_project;
 if not found then return null; end if;
 select * into strict j from public.jobs where id=b.job_id and owner_id=p_owner and project_id=p_project and operation='identity.image';
 select * into strict i from public.identity_input_snapshots where id=b.input_id and owner_id=p_owner and project_id=p_project;
 select r.intent into strict intent from fluid_private.shared_identity_requests r where r.batch_id=b.id and r.owner_id=p_owner and r.project_id=p_project;
 select coalesce(jsonb_agg(fluid_private.shared_identity_verified_system(s) order by root.step_key,root.output_index),'[]') into systems
 from public.identity_generated_roots root join public.identity_system_versions s on s.id=root.system_id and s.owner_id=root.owner_id and s.project_id=root.project_id
 where root.batch_id=b.id and root.owner_id=p_owner and root.project_id=p_project;
 n:=jsonb_array_length(systems);terminal:=j.state in('succeeded','failed','cancelled','partial');
 return jsonb_build_object('ownerId',p_owner,'projectId',p_project,'batchId',b.id,'jobId',j.id,'status',j.state,'terminal',j.lease_token is null and j.state in('succeeded','failed','cancelled','partial'),'intent',intent,'input',i.input,'systems',systems,
 'fulfillment',jsonb_build_object('targetCount',3,'acceptedCount',n,'status',case when n=3 then 'complete' when n>0 then 'partial' when terminal or j.state='needs_reconciliation' then 'none' else 'pending' end));
end $$;
create function public.get_shared_identity_batch(p_project_id uuid,p_batch_id uuid default null,p_request_key text default null) returns jsonb
language plpgsql security definer set search_path='' as $$declare o uuid:=fluid_private.shared_identity_customer(p_project_id);bid uuid;begin
 if p_batch_id is not null and p_request_key is not null then raise exception 'shared_identity_selector_invalid' using errcode='22023';end if;
 select r.batch_id into bid from fluid_private.shared_identity_requests r join public.identity_batches b on b.id=r.batch_id
 where r.owner_id=o and r.project_id=p_project_id and (p_batch_id is null or r.batch_id=p_batch_id) and (p_request_key is null or r.request_key=p_request_key)
 order by b.created_at desc,b.id desc limit 1;
 return fluid_private.shared_identity_batch_state(o,p_project_id,bid);
end $$;
create function public.get_shared_identity_availability(p_project_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare o uuid:=fluid_private.shared_identity_customer(p_project_id);profile jsonb;state jsonb;basis jsonb;p public.projects;reason text;bytes bigint;members integer;
begin
 select * into strict p from public.projects where id=p_project_id and owner_id=o;
 state:=fluid_private.identity_current_state(p_project_id);
 begin basis:=fluid_private.identity_basis(o,p_project_id,state#>'{project,context}',state->'referenceSnapshot',coalesce(state#>'{preferences,preferences}',jsonb_build_object('version',1,'creativeLocale',coalesce(state#>>'{project,context,creativeLocale}','en'),'notes',coalesce(state#>>'{project,context,intake,identityNotes}',''),'avoidanceNotes','')));
 exception when invalid_parameter_value or sqlstate 'PT409' then reason:='inputs_not_ready';end;
 if reason is null and (p.scope='naming_only' or coalesce(state#>>'{project,context,description}','')='' or p.scope='complete_brand' and (fluid_private.naming_readiness(p.scope,state#>'{project,context}')->>'ready')::boolean is not true) then reason:='inputs_not_ready';end if;
 if reason is null and (state#>>'{referenceSnapshot,selectedReferenceCount}')::integer=0 then reason:='references_unavailable';end if;
 if reason is null and (state#>>'{referenceSnapshot,selectedReferenceCount}')::integer>4 then reason:='reference_limit_exceeded';end if;
 if reason is null then
  select count(*),coalesce(sum(publication.byte_length),0) into members,bytes from jsonb_array_elements(state#>'{referenceSnapshot,selected}') entry
  join public.logo_asset_publications publication on publication.owner_id=o and publication.project_id=p_project_id
   and publication.asset_id=(entry#>>'{reference,media,assetId}')::uuid and publication.version_id=(entry#>>'{reference,media,versionId}')::uuid
   and publication.content_hash=entry#>>'{reference,media,contentHash}' and publication.mime_type=entry#>>'{reference,media,mimeType}'
   and publication.state='committed' and publication.purpose='reference_media' and publication.verification->>'status'='verified'
  join fluid_private.shared_identity_reference_requests registered on registered.owner_id=o and registered.project_id=p_project_id and registered.request_key=publication.request_key
   and registered.reference_id=(entry#>>'{reference,id}')::uuid
  join public.asset_versions v on (v.id,v.asset_id,v.owner_id,v.project_id,v.content_hash,v.mime_type)=(publication.version_id,publication.asset_id,o,p_project_id,publication.content_hash,publication.mime_type)
   and v.provenance->>'publicationId'=publication.id::text;
  if members<>(state#>>'{referenceSnapshot,selectedReferenceCount}')::integer then reason:='references_unavailable';
  elsif bytes>20971520 then reason:='reference_bytes_exceeded';end if;
 end if;
 profile:=fluid_private.shared_identity_policy(o);
 if reason is null and profile is null then reason:='runtime_unavailable';end if;
 if reason is not null then return jsonb_build_object('ownerId',o,'projectId',p_project_id,'status','unavailable','operation','identity.image','requestedModel','gpt-image-2.5-sunburst-2026-09-08','reason',reason);end if;
 return jsonb_build_object('version',2,'spendControl','uncapped','ownerId',o,'projectId',p_project_id,'status','available','operation','identity.image',
 'requestedModel','gpt-image-2.5-sunburst-2026-09-08','policyIdentity',profile->>'policyIdentity','handlerVersion','identity-image-v1','targetCount',3,'maxReferenceImages',4,'maxReferenceBytes',20971520);
end $$;
create function fluid_private.shared_identity_intent_valid(p_intent jsonb) returns boolean
language plpgsql immutable set search_path='' as $$begin
 if fluid_private.standalone_keys(p_intent,array['version','spendControl','expectedProjectRevision','expectedReferenceRevision','expectedPreferencesRevision','expectedIdentityRevision','idempotencyKey','acceptedPolicyIdentity']) is distinct from true
 or p_intent->'version' is distinct from '2'::jsonb or p_intent->>'spendControl' is distinct from 'uncapped'
 or coalesce(p_intent->>'idempotencyKey','')!~'^[A-Za-z0-9._:-]{16,128}$' or coalesce(p_intent->>'acceptedPolicyIdentity','')!~'^[a-f0-9]{64}$' then return false;end if;
 perform fluid_private.identity_counter(p_intent->'expectedProjectRevision',true);perform fluid_private.identity_counter(p_intent->'expectedReferenceRevision');
 perform fluid_private.identity_counter(p_intent->'expectedPreferencesRevision');perform fluid_private.identity_counter(p_intent->'expectedIdentityRevision');return true;
exception when invalid_parameter_value or invalid_text_representation or numeric_value_out_of_range then return false;
end $$;
create function public.ensure_shared_identity_batch(p_project_id uuid,p_intent jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare o uuid:=fluid_private.shared_identity_customer(p_project_id);p public.projects;s public.identity_sessions;pref public.identity_preferences;
 r fluid_private.shared_identity_requests;refs jsonb;context jsonb;preferences jsonb;snapshot jsonb;profile jsonb;input jsonb;manifest jsonb;bid uuid:=gen_random_uuid();jid uuid:=gen_random_uuid();iid uuid;systems jsonb;
begin
 if not fluid_private.standalone_keys(p_intent,array['version','spendControl','expectedProjectRevision','expectedReferenceRevision','expectedPreferencesRevision','expectedIdentityRevision','idempotencyKey','acceptedPolicyIdentity'])
 or p_intent->'version'<>'2' or p_intent->>'spendControl'<>'uncapped' or coalesce(p_intent->>'idempotencyKey','')!~'^[A-Za-z0-9._:-]{16,128}$'
 or coalesce(p_intent->>'acceptedPolicyIdentity','')!~'^[a-f0-9]{64}$' then raise exception 'invalid_identity_generation_intent' using errcode='22023';end if;
 perform fluid_private.identity_counter(p_intent->'expectedProjectRevision',true);perform fluid_private.identity_counter(p_intent->'expectedReferenceRevision');perform fluid_private.identity_counter(p_intent->'expectedPreferencesRevision');perform fluid_private.identity_counter(p_intent->'expectedIdentityRevision');
 perform pg_advisory_xact_lock(hashtextextended(o::text||':'||p_project_id::text,724005));
 if exists(select 1 from fluid_private.shared_identity_rejected_intents closed where closed.owner_id=o and closed.project_id=p_project_id and closed.request_key=p_intent->>'idempotencyKey') then
  raise exception 'identity_generation_intent_closed' using errcode='PT409';end if;
 select * into r from fluid_private.shared_identity_requests where owner_id=o and project_id=p_project_id and request_key=p_intent->>'idempotencyKey';
 if found then if r.intent is distinct from p_intent then raise exception 'identity_generation_intent_conflict' using errcode='PT409';end if;return fluid_private.shared_identity_batch_state(o,p_project_id,r.batch_id);end if;
 select * into strict p from public.projects where id=p_project_id and owner_id=o for update;
 insert into public.identity_sessions(project_id,owner_id) values(p.id,o) on conflict do nothing;
 select * into strict s from public.identity_sessions where project_id=p.id and owner_id=o for update;
 if p.current_revision<>fluid_private.identity_counter(p_intent->'expectedProjectRevision',true) or s.identity_revision<>fluid_private.identity_counter(p_intent->'expectedIdentityRevision')
 or coalesce(s.current_preferences_revision,0)<>fluid_private.identity_counter(p_intent->'expectedPreferencesRevision') then raise exception 'identity_generation_head_conflict' using errcode='PT409';end if;
 if exists(select 1 from public.jobs where owner_id=o and project_id=p.id and operation='identity.image' and state in('queued','running','cancel_requested','needs_reconciliation')) then raise exception 'identity_generation_pending' using errcode='PT409';end if;
 if public.get_shared_identity_availability(p.id)->>'status'<>'available' then raise exception 'identity_generation_unavailable' using errcode='55000';end if;
 profile:=fluid_private.shared_identity_policy(o);
 if profile->>'policyIdentity'<>p_intent->>'acceptedPolicyIdentity' then raise exception 'identity_generation_policy_changed' using errcode='PT409';end if;
 refs:=fluid_private.capture_identity_reference_snapshot(p.id,fluid_private.identity_counter(p_intent->'expectedReferenceRevision'));
 select pr.context into strict context from public.project_revisions pr where pr.project_id=p.id and pr.owner_id=o and pr.revision=p.current_revision;
 select * into pref from public.identity_preferences where project_id=p.id and owner_id=o and revision=s.current_preferences_revision;
 preferences:=coalesce(pref.preferences,jsonb_build_object('version',1,'creativeLocale',coalesce(context->>'creativeLocale','en'),'notes',coalesce(context#>>'{intake,identityNotes}',''),'avoidanceNotes',''));
 snapshot:=jsonb_build_object('version',1,'ownerId',o,'projectId',p.id,'scope',p.scope,'projectRevision',p.current_revision,'context',fluid_private.identity_material_context(context),
 'referenceSnapshot',refs,'preferencesRevision',coalesce(pref.revision,0),'preferences',fluid_private.identity_preferences_value(preferences),'capturedAt',clock_timestamp(),
 'basis',fluid_private.identity_basis(o,p.id,context,refs,preferences));
 insert into public.identity_input_snapshots(project_id,owner_id,project_revision,reference_revision,preferences_revision,input)
 values(p.id,o,p.current_revision,(refs->>'referenceRevision')::bigint,pref.revision,snapshot) returning id into iid;
 systems:=jsonb_build_array(gen_random_uuid(),gen_random_uuid(),gen_random_uuid());
 input:=jsonb_build_object('version',2,'operation','identity.image','ownerId',o,'projectId',p.id,'batchId',bid,'input',snapshot,'policyIdentity',profile->>'policyIdentity',
 'handlerVersion','identity-image-v1','spendControl','uncapped','textPolicy',profile#>'{policy,textPolicy}','systemIds',systems);
 select jsonb_agg(jsonb_build_object('key','identity-system-v1:'||n,'maximumCostMicrousd',0) order by n) into manifest from generate_series(1,3) n;
 insert into public.jobs(id,owner_id,project_id,operation,input_revision,input_hash,input,idempotency_key,reserved_cost_microusd,max_attempts,plan_manifest,plan_fingerprint,plan_registered_at,billing_mode)
 values(jid,o,p.id,'identity.image',p.current_revision,encode(sha256(convert_to(input::text,'UTF8')),'hex'),input,'identity:'||bid,0,1,manifest,encode(sha256(convert_to(manifest::text,'UTF8')),'hex'),clock_timestamp(),'openai_api');
 insert into public.identity_batches(id,project_id,owner_id,job_id,input_id) values(bid,p.id,o,jid,iid);
 insert into fluid_private.shared_identity_requests values(o,p.id,p_intent->>'idempotencyKey',p_intent,bid);
 insert into public.usage_accounts(owner_id) values(o) on conflict do nothing;
 perform fluid_private.admit_shared_worker_job(jid,'logo',profile->>'policyIdentity',profile->>'deploymentId',profile->'policy');
 insert into fluid_private.shared_identity_admissions(job_id,owner_id,project_id,slot_id,role_name,role_oid,input_hash,policy_identity,policy,deployment_id)
 select jid,o,p.id,fixed_slot.slot_id,fixed_slot.role_name,fixed_slot.role_oid,admitted_job.input_hash,profile->>'policyIdentity',profile->'policy',profile->>'deploymentId'
 from fluid_private.shared_worker_slots fixed_slot join public.jobs admitted_job on admitted_job.id=jid where fixed_slot.slot_id=(profile->>'slotId')::uuid
 and (fixed_slot.role_name,fixed_slot.role_oid)=((profile->>'roleName')::name,(profile->>'roleOid')::oid);
 if not found then raise exception 'identity_admission_principal_changed' using errcode='42501';end if;
 return fluid_private.shared_identity_batch_state(o,p.id,bid);
end $$;
create function public.close_shared_identity_generation_intent(p_project_id uuid,p_intent jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare o uuid:=fluid_private.shared_identity_customer(p_project_id);admitted fluid_private.shared_identity_requests;closed fluid_private.shared_identity_rejected_intents;jid uuid;
begin
 if not fluid_private.shared_identity_intent_valid(p_intent) then raise exception 'identity_generation_intent_invalid' using errcode='22023';end if;
 perform pg_advisory_xact_lock(hashtextextended(o::text||':'||p_project_id::text,724005));
 select * into admitted from fluid_private.shared_identity_requests where owner_id=o and project_id=p_project_id and request_key=p_intent->>'idempotencyKey';
 if found then
  if admitted.intent is distinct from p_intent then raise exception 'identity_generation_intent_conflict' using errcode='PT409';end if;
  select job_id into strict jid from public.identity_batches where id=admitted.batch_id and owner_id=o and project_id=p_project_id;
  perform public.request_job_cancel(jid);return jsonb_build_object('status','admitted','batch',fluid_private.shared_identity_batch_state(o,p_project_id,admitted.batch_id));
 end if;
 select * into closed from fluid_private.shared_identity_rejected_intents where owner_id=o and project_id=p_project_id and request_key=p_intent->>'idempotencyKey';
 if found then
  if closed.intent is distinct from p_intent then raise exception 'identity_generation_intent_conflict' using errcode='PT409';end if;
 else insert into fluid_private.shared_identity_rejected_intents(owner_id,project_id,request_key,intent,reason) values(o,p_project_id,p_intent->>'idempotencyKey',p_intent,'explicit_cancel');end if;
 return jsonb_build_object('status','not_admitted','ownerId',o,'projectId',p_project_id,'intent',p_intent);
end $$;
create function public.cancel_shared_identity_batch(p_project_id uuid,p_batch_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$declare o uuid:=fluid_private.shared_identity_customer(p_project_id);j uuid;begin
 select job_id into j from public.identity_batches where id=p_batch_id and owner_id=o and project_id=p_project_id;
 if j is null then raise exception 'identity_batch_missing' using errcode='P0002';end if;
 perform public.request_job_cancel(j);return fluid_private.shared_identity_batch_state(o,p_project_id,p_batch_id);
end $$;

create function fluid_private.shared_identity_job(j public.jobs) returns boolean
language sql stable set search_path='' as $$
 select case when j.operation is distinct from 'identity.image' or not exists(select 1 from fluid_private.shared_identity_admissions admitted where admitted.job_id=j.id) then false else exists(select 1 from fluid_private.shared_job_admissions a
 join fluid_private.shared_identity_admissions admitted on admitted.job_id=a.job_id
 and (admitted.owner_id,admitted.project_id,admitted.input_hash,admitted.policy_identity,admitted.policy,admitted.deployment_id)
 =(a.owner_id,a.project_id,a.input_hash,a.policy_identity,a.policy,a.deployment_id)
 join fluid_private.shared_worker_slots anchor on anchor.slot_id=admitted.slot_id and (anchor.role_name,anchor.role_oid)=(admitted.role_name,admitted.role_oid)
 join public.identity_batches b on b.job_id=j.id and b.owner_id=j.owner_id and b.project_id=j.project_id
 join public.identity_input_snapshots i on i.id=b.input_id and i.owner_id=b.owner_id and i.project_id=b.project_id
 where a.job_id=j.id and (a.owner_id,a.project_id,a.operation,a.input_hash,a.lane)=(j.owner_id,j.project_id,'identity.image'::text,j.input_hash,'logo'::text)
 and fluid_private.shared_identity_policy_valid(a.policy) and a.policy_identity=j.input->>'policyIdentity' and a.policy->'textPolicy'=j.input->'textPolicy'
 and j.input->>'operation'='identity.image' and j.input->'version'='2' and j.input->>'spendControl'='uncapped' and j.input->>'handlerVersion'='identity-image-v1'
 and j.input->>'ownerId'=j.owner_id::text and j.input->>'projectId'=j.project_id::text and j.input->>'batchId'=b.id::text and j.input->'input'=i.input
 and jsonb_array_length(j.input->'systemIds')=3 and (select count(distinct value) from jsonb_array_elements(j.input->'systemIds'))=3
 and j.input_hash=encode(sha256(convert_to(j.input::text,'UTF8')),'hex')) end;
$$;
create function fluid_private.shared_identity_context(p_job uuid,p_lease uuid,p_active boolean default false) returns public.jobs
language plpgsql set search_path='' as $$declare j public.jobs;e fluid_private.shared_worker_executions;begin
 e:=fluid_private.shared_worker_context_execution('logo');
 if e.job_id is distinct from p_job or e.lease_token is distinct from p_lease or e.operation<>'identity.image'
 or p_active and fluid_private.shared_worker_context_mode('logo')<>'active' then raise exception 'identity_execution_required' using errcode='42501';end if;
 select * into strict j from public.jobs where id=e.job_id and owner_id=e.owner_id and project_id=e.project_id for update;
 if not fluid_private.shared_identity_job(j) or j.lease_token is not null and j.lease_token<>p_lease then raise exception 'identity_job_unqualified' using errcode='42501';end if;
 return j;
end $$;
create function fluid_private.shared_identity_system_id(j public.jobs,p_step text) returns uuid
language plpgsql immutable set search_path='' as $$begin
 if p_step!~'^identity-system-v1:[123]$' then raise exception 'identity_step_invalid' using errcode='22023';end if;
 return (j.input#>>array['systemIds',(right(p_step,1)::integer-1)::text])::uuid;
end $$;
create function fluid_private.shared_identity_input(j public.jobs) returns jsonb
language sql stable set search_path='' as $$
 select jsonb_build_object('batch',jsonb_build_object('id',b.id,'ownerId',b.owner_id,'projectId',b.project_id,'jobId',j.id,'targetCount',3,'input',i.input),
 'input',j.input,'systems',coalesce((select jsonb_agg(fluid_private.shared_identity_verified_system(s) order by array_position(array(select value#>>'{}' from jsonb_array_elements(j.input->'systemIds')),s.id::text))
 from public.identity_generated_roots r join public.identity_system_versions s on s.id=r.system_id and s.owner_id=r.owner_id and s.project_id=r.project_id
 where r.batch_id=b.id),'[]'::jsonb))
 from public.identity_batches b join public.identity_input_snapshots i on i.id=b.input_id and i.owner_id=b.owner_id and i.project_id=b.project_id
 where b.job_id=j.id and b.owner_id=j.owner_id and b.project_id=j.project_id;
$$;
create function fluid_private.shared_identity_receipt_json(r fluid_private.shared_identity_receipts) returns jsonb
language sql stable set search_path='' as $$
 select jsonb_build_object('id',r.id,'ownerId',j.owner_id,'projectId',j.project_id,'jobId',j.id,'leaseToken',e.lease_token,'callId',c.id,'observation',r.observation)
 from fluid_private.shared_identity_calls c join fluid_private.shared_worker_executions e on e.execution_id=c.execution_id join public.jobs j on j.id=c.job_id where c.id=r.call_id;
$$;
create function fluid_private.shared_identity_authorize(j public.jobs,p_step text,p_phase text,p_key text,p_hash text) returns jsonb
language plpgsql set search_path='' as $$declare c fluid_private.shared_identity_calls;e fluid_private.shared_worker_executions;begin
 perform fluid_private.shared_identity_system_id(j,p_step);e:=fluid_private.shared_worker_context_execution('logo');
 if fluid_private.shared_worker_context_mode('logo')<>'active' or not fluid_private.shared_storage_slot_ready(e.slot_id) or not fluid_private.shared_identity_runtime_ready(e.slot_id) or j.state<>'running' or j.cancel_requested_at is not null
 or p_phase is null or p_phase not in('specifications','board') or p_key!~'^[a-f0-9]{64}$' or p_hash!~'^[a-f0-9]{64}$'
 or not exists(select 1 from public.job_steps where job_id=j.id and step_key=p_step and state='in_flight') then raise exception 'identity_dispatch_denied' using errcode='42501';end if;
 if p_phase='board' and not exists(select 1 from fluid_private.shared_identity_calls prior join fluid_private.shared_identity_receipts receipt on receipt.call_id=prior.id
 where prior.job_id=j.id and prior.step_key=p_step and prior.phase='specifications' and receipt.observation->'responseComplete'='true'
 and receipt.observation->'specification'<>'null' and receipt.observation#>>'{billing,status}'='recorded'
 and fluid_private.shared_identity_receipt_complete(j,receipt,'specifications')) then raise exception 'identity_specification_required' using errcode='42501';end if;
 select * into c from fluid_private.shared_identity_calls where job_id=j.id and step_key=p_step and phase=p_phase;
 if found then
  if c.request_key<>p_key or c.request_hash<>p_hash or c.execution_id<>e.execution_id then raise exception 'identity_call_conflict' using errcode='PT409';end if;
  return jsonb_build_object('callId',c.id,'disposition','already_issued');
 end if;
 insert into fluid_private.shared_identity_calls(execution_id,job_id,step_key,phase,request_key,request_hash) values(e.execution_id,j.id,p_step,p_phase,p_key,p_hash) returning * into c;
 return jsonb_build_object('callId',c.id,'disposition','started');
end $$;
create function fluid_private.shared_identity_observation_valid(o jsonb,c fluid_private.shared_identity_calls) returns boolean
language plpgsql immutable set search_path='' as $$declare k text;u jsonb:=o->'usage';b jsonb:=o->'billing';cost numeric;begin
 if not fluid_private.standalone_keys(o,array['version','phase','provider','model','requestKey','requestHash','responseId','providerRequestId','responseHash','observedAt','responseComplete','serviceTier','usage','billing','specification','artifactHash'])
 or octet_length(o::text)>131072 or o->'version'<>'1' or o->>'phase'<>c.phase or o->>'provider'<>'openai'
 or o->>'requestKey'<>c.request_key or o->>'requestHash'<>c.request_hash or jsonb_typeof(o->'responseComplete')<>'boolean'
 or not fluid_private.standalone_timestamp(o->'observedAt') then return false;end if;
 foreach k in array array['model','responseId','providerRequestId','serviceTier'] loop
  if o->k<>'null' and not fluid_private.standalone_text(o->k,case when k='model' then 150 when k='serviceTier' then 100 else 200 end,1) then return false;end if;
 end loop;
 foreach k in array array['responseHash','artifactHash'] loop
  if o->k<>'null' and (jsonb_typeof(o->k)<>'string' or o->>k!~'^[a-f0-9]{64}$') then return false;end if;
 end loop;
 if not fluid_private.standalone_keys(b,array['status','confirmedMicrousd']) or not((b->>'status'='unknown' and b->'confirmedMicrousd'='null')
 or (b->>'status'='recorded' and fluid_private.identity_counter(b->'confirmedMicrousd')>=0)) then return false;end if;
 if c.phase='specifications' then
  if o->'artifactHash'<>'null' then return false;end if;
  if o->'specification'<>'null' then
   if not fluid_private.standalone_keys(o->'specification',array['components','boardPrompt']) or (o#>'{specification,components}') is distinct from fluid_private.identity_components(o#>'{specification,components}')
   or not fluid_private.standalone_text(o#>'{specification,boardPrompt}',6000,1) then return false;end if;
  end if;
  if u<>'null' then
   if not fluid_private.standalone_keys(u,array['inputTokens','cachedInputTokens','cacheWriteInputTokens','outputTokens']) then return false;end if;
   foreach k in array array['inputTokens','cachedInputTokens','cacheWriteInputTokens','outputTokens'] loop perform fluid_private.identity_counter(u->k);end loop;
   if (u->>'cachedInputTokens')::numeric+(u->>'cacheWriteInputTokens')::numeric>(u->>'inputTokens')::numeric then return false;end if;
  end if;
 else
  if o->'specification'<>'null' then return false;end if;
  if u<>'null' then
   if jsonb_typeof(u)<>'object' or u-array['input_tokens','output_tokens','input_tokens_details','total_tokens','output_tokens_details']<>'{}' or not(u ?& array['input_tokens','output_tokens','input_tokens_details'])
   or not fluid_private.standalone_keys(u->'input_tokens_details',array['text_tokens','image_tokens']) then return false;end if;
   if fluid_private.identity_counter(u->'input_tokens')>1000000000 or fluid_private.identity_counter(u->'output_tokens')>1000000000
   or fluid_private.identity_counter(u#>'{input_tokens_details,text_tokens}')>1000000000 or fluid_private.identity_counter(u#>'{input_tokens_details,image_tokens}')>1000000000 then return false;end if;
   if fluid_private.identity_counter(u#>'{input_tokens_details,text_tokens}')+fluid_private.identity_counter(u#>'{input_tokens_details,image_tokens}')<>(u->>'input_tokens')::bigint then return false;end if;
   if u?'total_tokens' and fluid_private.identity_counter(u->'total_tokens')<>(u->>'input_tokens')::bigint+(u->>'output_tokens')::bigint then return false;end if;
   if u?'output_tokens_details' and (not fluid_private.standalone_keys(u->'output_tokens_details',array['text_tokens','image_tokens'])
   or fluid_private.identity_counter(u#>'{output_tokens_details,text_tokens}')<>0 or fluid_private.identity_counter(u#>'{output_tokens_details,image_tokens}')<>(u->>'output_tokens')::bigint) then return false;end if;
  end if;
 end if;
 if b->>'status'='recorded' then
  if u='null' then return false;end if;
  if c.phase='specifications' then
   cost:=ceil((((u->>'inputTokens')::numeric-(u->>'cachedInputTokens')::numeric-(u->>'cacheWriteInputTokens')::numeric)*2000000+(u->>'cachedInputTokens')::numeric*100000+(u->>'cacheWriteInputTokens')::numeric*2500000+(u->>'outputTokens')::numeric*10000000)/1000000);
  else cost:=(u#>>'{input_tokens_details,text_tokens}')::numeric*5+(u#>>'{input_tokens_details,image_tokens}')::numeric*8+(u->>'output_tokens')::numeric*30;end if;
  if cost is distinct from (b->>'confirmedMicrousd')::numeric then return false;end if;
 end if;
 return true;
exception when invalid_parameter_value or invalid_text_representation or numeric_value_out_of_range then return false;
end $$;
create function fluid_private.shared_identity_record_receipt(j public.jobs,p_call uuid,o jsonb) returns jsonb
language plpgsql set search_path='' as $$declare c fluid_private.shared_identity_calls;r fluid_private.shared_identity_receipts;e fluid_private.shared_worker_executions;begin
 e:=fluid_private.shared_worker_context_execution('logo');
 select * into c from fluid_private.shared_identity_calls where id=p_call and job_id=j.id and execution_id=e.execution_id;
 if not found or not fluid_private.shared_identity_observation_valid(o,c) then raise exception 'identity_observation_invalid' using errcode='22023';end if;
 select * into r from fluid_private.shared_identity_receipts where call_id=c.id;
 if found then if r.observation is distinct from o then raise exception 'identity_observation_immutable' using errcode='PT409';end if;return fluid_private.shared_identity_receipt_json(r);end if;
 insert into fluid_private.shared_identity_receipts(call_id,observation) values(c.id,o) returning * into r;
 -- Record the observed charge independently of successful board publication.
 -- It is not an allowance, estimate, refund or permission for another call.
 if o#>>'{billing,status}'='recorded' then
  update public.usage_accounts set provider_actual_microusd=provider_actual_microusd+(o#>>'{billing,confirmedMicrousd}')::bigint where owner_id=j.owner_id;
 end if;
 return fluid_private.shared_identity_receipt_json(r);
end $$;

create function fluid_private.shared_identity_prepare_asset(j public.jobs,p_write jsonb) returns jsonb
language plpgsql set search_path='' as $$declare b jsonb:=p_write->'publication';r public.logo_asset_publications;sid uuid;step text;begin
 if fluid_private.shared_worker_context_mode('logo')<>'active' or not fluid_private.standalone_keys(p_write,array['kind','publication']) or p_write->>'kind'<>'stage'
 or not fluid_private.standalone_keys(b,array['requestKey','inputRevisions','mimeType','contentHash','byteLength','source'])
 or not fluid_private.standalone_keys(b->'source',array['kind','sourceId']) or b#>>'{source,kind}'<>'identity_system'
 or not fluid_private.logo_uuid(b#>'{source,sourceId}') or b->'requestKey' is distinct from b#>'{source,sourceId}' or b->'inputRevisions'<>'[]'
 or b->>'mimeType'<>'image/png' or coalesce(b->>'contentHash','')!~'^[a-f0-9]{64}$'
 or fluid_private.identity_counter(b->'byteLength',true)>20971520 then raise exception 'identity_board_publication_invalid' using errcode='22023';end if;
 sid:=(b#>>'{source,sourceId}')::uuid;
 select 'identity-system-v1:'||n into step from generate_series(1,3) n where (j.input#>>array['systemIds',(n-1)::text])::uuid=sid;
 if step is null or not exists(select 1 from public.job_steps where job_id=j.id and step_key=step and state='in_flight')
 or not exists(select 1 from fluid_private.shared_identity_calls c where c.job_id=j.id and c.step_key=step and c.phase='board') then raise exception 'identity_board_source_denied' using errcode='42501';end if;
 select * into r from public.logo_asset_publications where owner_id=j.owner_id and project_id=j.project_id and request_key=sid;
 if found then if r.request is distinct from p_write or r.job_id<>j.id or r.lease_token<>j.lease_token or r.source_kind<>'identity_system' then raise exception 'identity_board_request_conflict' using errcode='PT409';end if;return fluid_private.logo_asset_reservation(r);end if;
 insert into public.logo_asset_publications(owner_id,project_id,request_key,request,content_hash,mime_type,byte_length,purpose,source_receipt_id,source_kind,job_id,lease_token,input_revision,input_hash)
 values(j.owner_id,j.project_id,sid,p_write,b->>'contentHash','image/png',(b->>'byteLength')::bigint,'brand_asset',sid,'identity_system',j.id,j.lease_token,j.input_revision,j.input_hash) returning * into r;
 return fluid_private.logo_asset_reservation(r);
end $$;
create function fluid_private.shared_identity_observe_asset(j public.jobs,p_reservation uuid,v jsonb) returns jsonb
language plpgsql set search_path='' as $$declare r public.logo_asset_publications;e fluid_private.shared_worker_executions;begin
 e:=fluid_private.shared_worker_context_execution('logo');
 select * into r from public.logo_asset_publications where id=p_reservation and owner_id=j.owner_id and project_id=j.project_id and job_id=j.id and lease_token=e.lease_token and source_kind='identity_system' for update;
 if not found or not fluid_private.standalone_keys(v,array['status','checkedAt','contentHash','mimeType','byteLength']) or v->>'status'<>'verified'
 or not fluid_private.standalone_timestamp(v->'checkedAt') or v->>'contentHash' is distinct from r.content_hash or v->>'mimeType' is distinct from r.mime_type
 or v->'byteLength' is distinct from to_jsonb(r.byte_length)
 or not exists(select 1 from fluid_private.shared_storage_grants g where g.execution_id=e.execution_id and g.reservation_id=r.id and g.mode='write'
 and g.binding->'execution'=fluid_private.shared_worker_execution_json(e)) then raise exception 'identity_board_observation_invalid' using errcode='42501';end if;
 if r.verification is not null then
  if r.verification-'checkedAt' is distinct from v-'checkedAt' then raise exception 'identity_board_observation_conflict' using errcode='PT409';end if;
 else update public.logo_asset_publications set state='staged',verification=v where id=r.id returning * into r;end if;
 return fluid_private.logo_asset_receipt(r);
end $$;
create function fluid_private.shared_identity_storage_member(j public.jobs,r public.logo_asset_publications,p_mode text) returns jsonb
language plpgsql stable set search_path='' as $$declare media jsonb;begin
 if not fluid_private.shared_identity_job(j) or r.id is null or r.owner_id<>j.owner_id or r.project_id<>j.project_id then return null;end if;
 if p_mode='read' then
  if r.state<>'committed' or r.purpose<>'reference_media' or r.mime_type not in('image/png','image/jpeg','image/webp') or r.verification->>'status'<>'verified'
  or r.verification->>'contentHash'<>r.content_hash or r.verification->>'mimeType'<>r.mime_type or r.verification->'byteLength'<>to_jsonb(r.byte_length)
  or not exists(select 1 from public.asset_versions v join public.assets a on (a.id,a.owner_id,a.project_id)=(v.asset_id,v.owner_id,v.project_id)
   where v.id=r.version_id and v.asset_id=r.asset_id and v.owner_id=j.owner_id and v.project_id=j.project_id and v.content_hash=r.content_hash
   and v.mime_type=r.mime_type and a.purpose='reference_media' and v.storage_path=r.owner_id::text||'/'||r.project_id::text||'/'||r.asset_id::text||'/'||r.version_id::text
   and v.provenance->>'publicationId'=r.id::text) then return null;end if;
  for media in select value#>'{reference,media}' from jsonb_array_elements(j.input#>'{input,referenceSnapshot,selected}') loop
   if media=jsonb_build_object('ownerId',j.owner_id,'projectId',j.project_id,'assetId',r.asset_id,'versionId',r.version_id,'contentHash',r.content_hash,'purpose','reference_media','mimeType',r.mime_type) then return jsonb_build_object('member','reference');end if;
  end loop;
 elsif p_mode='write' then
  if r.job_id=j.id and r.lease_token=j.lease_token and r.source_kind='identity_system' and r.source_receipt_id=r.request_key and r.rights_evidence_id is null
  and r.state in('reserved','staged') and r.purpose='brand_asset' and r.mime_type='image/png' and r.input_hash=j.input_hash and r.input_revision=j.input_revision
  and r.request->>'kind'='stage' and r.request#>>'{publication,source,kind}'='identity_system' and r.request#>>'{publication,source,sourceId}'=r.source_receipt_id::text
  and r.request#>>'{publication,requestKey}'=r.request_key::text and r.request#>'{publication,inputRevisions}'='[]'
  and r.request#>>'{publication,contentHash}'=r.content_hash and r.request#>>'{publication,mimeType}'=r.mime_type and r.request#>'{publication,byteLength}'=to_jsonb(r.byte_length)
  and exists(select 1 from generate_series(1,3) n join public.job_steps step on step.job_id=j.id and step.step_key='identity-system-v1:'||n
   where j.input#>>array['systemIds',(n-1)::text]=r.source_receipt_id::text and step.state in('in_flight','ambiguous')) then return jsonb_build_object('member','output');end if;
 end if;
 return null;
end $$;
create function fluid_private.shared_identity_read_asset(j public.jobs,ref jsonb) returns jsonb
language plpgsql stable set search_path='' as $$declare r public.logo_asset_publications;begin
 select * into r from public.logo_asset_publications where owner_id=j.owner_id and project_id=j.project_id and asset_id=(ref->>'assetId')::uuid and version_id=(ref->>'versionId')::uuid and content_hash=ref->>'contentHash';
 if ref is distinct from fluid_private.logo_asset_reservation(r)->'reference' or fluid_private.shared_identity_storage_member(j,r,'read') is null then raise exception 'identity_reference_not_captured' using errcode='42501';end if;
 return fluid_private.logo_asset_reservation(r);
end $$;
create function fluid_private.shared_identity_receipt_complete(j public.jobs,r fluid_private.shared_identity_receipts,p_phase text) returns boolean
language plpgsql stable set search_path='' as $$declare c fluid_private.shared_identity_calls;o jsonb:=r.observation;u jsonb:=o->'usage';cost numeric;begin
 select * into c from fluid_private.shared_identity_calls where id=r.call_id and job_id=j.id and phase=p_phase;
 if not found or o->'responseComplete'<>'true' or o->>'responseHash' is null or o#>>'{billing,status}'<>'recorded' or u='null' then return false;end if;
 if p_phase='specifications' then
  if coalesce(o->>'responseId','')!~'^resp_[A-Za-z0-9_-]+$' or o->>'model'<>j.input#>>'{textPolicy,model}' or o->>'serviceTier'<>j.input#>>'{textPolicy,serviceTier}' or o->'specification'='null'
  or (u->>'inputTokens')::numeric>(j.input#>>'{textPolicy,maxInputTokens}')::numeric or (u->>'outputTokens')::numeric>(j.input#>>'{textPolicy,maxOutputTokens}')::numeric then return false;end if;
  cost:=ceil((((u->>'inputTokens')::numeric-(u->>'cachedInputTokens')::numeric-(u->>'cacheWriteInputTokens')::numeric)*2000000+(u->>'cachedInputTokens')::numeric*100000+(u->>'cacheWriteInputTokens')::numeric*2500000+(u->>'outputTokens')::numeric*10000000)/1000000);
 else
  if o->>'providerRequestId' is null or o->>'model'<>'gpt-image-2.5-sunburst-2026-09-08' or o->>'serviceTier'<>'standard' or o->>'artifactHash' is null then return false;end if;
  cost:=(u#>>'{input_tokens_details,text_tokens}')::numeric*5+(u#>>'{input_tokens_details,image_tokens}')::numeric*8+(u->>'output_tokens')::numeric*30;
 end if;
 return cost=(o#>>'{billing,confirmedMicrousd}')::numeric;
end $$;
-- Staging may inspect a real observed reservation before its asset/version
-- rows exist. Publication and the unchanged complete-manifest/root checker run
-- together later, in the same completed-step transaction.
create function fluid_private.shared_identity_asset_shape(ref jsonb,p_owner uuid,p_project uuid,p_board boolean) returns void
language plpgsql stable set search_path='' as $$declare r public.logo_asset_publications;e fluid_private.shared_worker_executions;begin
 e:=fluid_private.shared_worker_context_execution('logo');
 if not p_board or fluid_private.standalone_keys(ref,array['ownerId','projectId','assetId','versionId','contentHash','purpose','mimeType']) is distinct from true
 or ref->>'ownerId' is distinct from p_owner::text or ref->>'projectId' is distinct from p_project::text
 or ref->>'purpose' is distinct from 'brand_asset' or ref->>'mimeType' is distinct from 'image/png' then raise exception 'identity_staged_asset_manifest_invalid' using errcode='42501';end if;
 select * into r from public.logo_asset_publications where owner_id=p_owner and project_id=p_project and job_id=e.job_id and lease_token=e.lease_token
 and asset_id=(ref->>'assetId')::uuid and version_id=(ref->>'versionId')::uuid and source_kind='identity_system';
 if not found or r.state not in('staged','committed') or r.verification->>'status' is distinct from 'verified'
 or r.verification->>'contentHash' is distinct from r.content_hash or r.verification->>'mimeType' is distinct from r.mime_type or r.verification->'byteLength' is distinct from to_jsonb(r.byte_length)
 or ref is distinct from jsonb_build_object('ownerId',r.owner_id,'projectId',r.project_id,'assetId',r.asset_id,'versionId',r.version_id,'contentHash',r.content_hash,'purpose',r.purpose,'mimeType',r.mime_type)
 then raise exception 'identity_staged_asset_manifest_invalid' using errcode='42501';end if;
end $$;
do $staged_shape$
declare definition text;fragment text:='fluid_private.identity_asset_shape(';begin
 definition:=pg_get_functiondef('fluid_private.identity_manifest_shape(jsonb,uuid,uuid)'::regprocedure);
 if (length(definition)-length(replace(definition,fragment,'')))/length(fragment)<>2 then raise exception 'identity_staged_shape_fragment';end if;
 definition:=replace(definition,'FUNCTION fluid_private.identity_manifest_shape(','FUNCTION fluid_private.shared_identity_manifest_shape(');
 execute replace(definition,fragment,'fluid_private.shared_identity_asset_shape(');
end $staged_shape$;
create function fluid_private.shared_identity_stage(j public.jobs,p_step text,p_output jsonb,p_evidence jsonb) returns jsonb
language plpgsql set search_path='' as $$declare system jsonb;source jsonb;sid uuid;e fluid_private.shared_worker_executions;
 t fluid_private.shared_identity_receipts;i fluid_private.shared_identity_receipts;tc fluid_private.shared_identity_calls;ic fluid_private.shared_identity_calls;r public.logo_asset_publications;prior fluid_private.shared_identity_prepared;
begin
 e:=fluid_private.shared_worker_context_execution('logo');sid:=fluid_private.shared_identity_system_id(j,p_step);
 if not fluid_private.standalone_keys(p_evidence,array['textReceiptId','imageReceiptId','publicationId']) or octet_length(p_output::text)>1048576
 or not fluid_private.standalone_keys(p_output,array['identity']) or not fluid_private.standalone_keys(p_output->'identity',array['version','operation','ownerId','projectId','batchId','jobId','stepKey','targetCount','input','systems'])
 or ((p_output->'identity')-'systems') is distinct from jsonb_build_object('version',1,'operation','identity.image','ownerId',j.owner_id,'projectId',j.project_id,'batchId',(j.input->>'batchId')::uuid,'jobId',j.id,'stepKey',p_step,'targetCount',3,'input',j.input->'input')
 or jsonb_typeof(p_output#>'{identity,systems}')<>'array' or jsonb_array_length(p_output#>'{identity,systems}')<>1 then raise exception 'identity_stage_output_invalid' using errcode='22023';end if;
 system:=p_output#>'{identity,systems,0}';source:=jsonb_build_object('kind','generated','batchId',(j.input->>'batchId')::uuid,'jobId',j.id,'stepKey',p_step);
 perform fluid_private.shared_identity_manifest_shape(system,j.owner_id,j.project_id);
 if system->>'id'<>sid::text or system->'source' is distinct from source or system->'input' is distinct from j.input->'input' or system->'productionFiles'<>'[]'
 or (system->>'createdAt')::timestamptz<j.created_at or (system->>'createdAt')::timestamptz>clock_timestamp()+interval '1 minute'
 or system#>>'{board,depictsSystemVersionId}'<>sid::text or system#>'{board,staleComponents}'<>'[]' then raise exception 'identity_stage_scope_invalid' using errcode='42501';end if;
 select * into t from fluid_private.shared_identity_receipts where id=(p_evidence->>'textReceiptId')::uuid;
 select * into i from fluid_private.shared_identity_receipts where id=(p_evidence->>'imageReceiptId')::uuid;
 select * into tc from fluid_private.shared_identity_calls where id=t.call_id and job_id=j.id and step_key=p_step and phase='specifications' and execution_id=e.execution_id;
 select * into ic from fluid_private.shared_identity_calls where id=i.call_id and job_id=j.id and step_key=p_step and phase='board' and execution_id=e.execution_id;
 select * into r from public.logo_asset_publications where id=(p_evidence->>'publicationId')::uuid and job_id=j.id and owner_id=j.owner_id and project_id=j.project_id and lease_token=e.lease_token;
 if tc.id is null or ic.id is null or r.id is null or not fluid_private.shared_identity_receipt_complete(j,t,'specifications') or not fluid_private.shared_identity_receipt_complete(j,i,'board')
 or r.source_kind<>'identity_system' or r.source_receipt_id<>sid or r.state not in('staged','committed') or r.verification->>'status'<>'verified'
 or r.content_hash<>i.observation->>'artifactHash' or system->'components' is distinct from t.observation#>'{specification,components}'
 or system#>'{board,asset}' is distinct from jsonb_build_object('ownerId',j.owner_id,'projectId',j.project_id,'assetId',r.asset_id,'versionId',r.version_id,'contentHash',r.content_hash,'purpose','brand_asset','mimeType','image/png')
 or exists(select 1 from public.identity_generated_roots root where root.batch_id=(j.input->>'batchId')::uuid and root.system_id<>sid and root.board->>'contentHash'=r.content_hash)
 then raise exception 'identity_stage_provenance_invalid' using errcode='42501';end if;
 select * into prior from fluid_private.shared_identity_prepared where job_id=j.id and step_key=p_step;
 if found then
  if (prior.execution_id,prior.output,prior.text_receipt_id,prior.image_receipt_id,prior.publication_id) is distinct from(e.execution_id,p_output,t.id,i.id,r.id) then raise exception 'identity_stage_conflict' using errcode='PT409';end if;
 else insert into fluid_private.shared_identity_prepared values(j.id,p_step,e.execution_id,p_output,t.id,i.id,r.id);end if;
 return jsonb_build_object('status','staged','systemVersionId',sid,'stepKey',p_step);
end $$;

create function fluid_private.shared_identity_complete(j public.jobs,p_step text,p_state text,p_cost bigint,p_output jsonb,p_request text) returns void
language plpgsql set search_path='' as $$
declare s public.job_steps;prepared fluid_private.shared_identity_prepared;r public.logo_asset_publications;system jsonb;bid uuid;iid uuid;sid uuid;known bigint;unknown boolean;v_state text:=p_state;receipt fluid_private.shared_identity_receipts;
begin
 sid:=fluid_private.shared_identity_system_id(j,p_step);
 select * into s from public.job_steps where job_id=j.id and step_key=p_step for update;
 if not found then raise exception 'identity_step_missing' using errcode='P0002';end if;
 if p_state is null or p_state not in('succeeded','failed','ambiguous') or p_cost is null or p_cost<0 or octet_length(p_output::text)>1048576 then raise exception 'identity_outcome_invalid' using errcode='22023';end if;
 if s.state<>'in_flight' then
  if (s.state,s.actual_cost_microusd,s.output,s.provider_request_id) is not distinct from(p_state,p_cost,p_output,p_request) then return;end if;
  raise exception 'identity_outcome_immutable' using errcode='PT409';
 end if;
 select coalesce(sum(case when receipt_row.observation#>>'{billing,status}'='recorded' then (receipt_row.observation#>>'{billing,confirmedMicrousd}')::bigint else 0 end),0),
 count(*) filter(where receipt_row.id is null or receipt_row.observation#>>'{billing,status}'<>'recorded')>0 into known,unknown
 from fluid_private.shared_identity_calls issued_call left join fluid_private.shared_identity_receipts receipt_row on receipt_row.call_id=issued_call.id where issued_call.job_id=j.id and issued_call.step_key=p_step;
 if p_cost<>known then raise exception 'identity_observed_cost_mismatch' using errcode='22023';end if;
 if v_state='succeeded' then
  select * into prepared from fluid_private.shared_identity_prepared where job_id=j.id and step_key=p_step;
  if not found or prepared.output is distinct from p_output then raise exception 'identity_prepared_output_required' using errcode='42501';end if;
  perform fluid_private.shared_identity_stage(j,p_step,p_output,jsonb_build_object('textReceiptId',prepared.text_receipt_id,'imageReceiptId',prepared.image_receipt_id,'publicationId',prepared.publication_id));
  select * into receipt from fluid_private.shared_identity_receipts where id=prepared.image_receipt_id;
  if p_request is distinct from receipt.observation->>'providerRequestId' or unknown then raise exception 'identity_completion_receipt_mismatch' using errcode='42501';end if;
  select * into strict r from public.logo_asset_publications where id=prepared.publication_id for update;
  perform fluid_private.logo_commit_asset(r);
  system:=p_output#>'{identity,systems,0}';bid:=(j.input->>'batchId')::uuid;
  select input_id into strict iid from public.identity_batches where id=bid and job_id=j.id and owner_id=j.owner_id and project_id=j.project_id;
  insert into public.identity_system_versions(id,owner_id,project_id,input_id,source,components,board,production_files,created_at,created_at_text,root_system_id)
  values(sid,j.owner_id,j.project_id,iid,system->'source',system->'components',system->'board',system->'productionFiles',(system->>'createdAt')::timestamptz,system->>'createdAt',sid);
  insert into public.identity_system_files(system_id,slot,project_id,owner_id,component,role,asset_id,version_id)
  values(sid,0,j.project_id,j.owner_id,null,'board',r.asset_id,r.version_id);
  insert into public.identity_generated_roots(system_id,project_id,owner_id,batch_id,job_id,step_key,output_index,board)
  values(sid,j.project_id,j.owner_id,bid,j.id,p_step,0,system#>'{board,asset}');
 elsif exists(select 1 from fluid_private.shared_identity_calls where job_id=j.id and step_key=p_step) then
  -- An issued call is never converted into proven non-dispatch by a failed
  -- callback or a Stop. Keep unknown outcome/cost alongside prior accepted rows.
  if unknown or p_state='failed' then v_state:='ambiguous';end if;
 elsif p_cost<>0 or p_request is not null or p_state<>'failed' or p_output->>'error'<>'not_dispatched' then
  raise exception 'identity_non_dispatch_proof_required' using errcode='42501';
 end if;
 update public.job_steps set state=v_state,actual_cost_microusd=known,output=p_output,provider_request_id=p_request,completed_at=clock_timestamp() where job_id=j.id and step_key=p_step;
 update public.jobs set actual_cost_microusd=actual_cost_microusd+known,
 state=case when v_state='ambiguous' then 'needs_reconciliation' else public.jobs.state end,
 lease_token=case when v_state='ambiguous' then null else public.jobs.lease_token end,lease_expires_at=case when v_state='ambiguous' then null else public.jobs.lease_expires_at end,
 error_code=case when v_state='ambiguous' then coalesce(p_output->>'error','provider_outcome_unknown') else public.jobs.error_code end where id=j.id;
 if v_state='succeeded' then
  perform fluid_private.identity_root_evidence(generated) from public.identity_system_versions generated where id=sid and owner_id=j.owner_id and project_id=j.project_id;
 end if;
end $$;
-- Only an explicit Stop can resolve a step that has no authorized provider
-- work, or one wholly observed specification call with no board authorization.
-- The original step and its charge remain independently inspectable forever.
create function fluid_private.shared_identity_cancel_known_specification(j public.jobs,p_step text) returns boolean
language plpgsql set search_path='' as $$
declare e fluid_private.shared_worker_executions;s public.job_steps;c fluid_private.shared_identity_calls;r fluid_private.shared_identity_receipts;
 n integer;known bigint:=0;resolution_mode text:='no_provider_authorized';sid uuid;
begin
 e:=fluid_private.shared_worker_context_execution('logo');sid:=fluid_private.shared_identity_system_id(j,p_step);
 if j.cancel_requested_at is null or e.job_id is distinct from j.id then return false;end if;
 select * into s from public.job_steps where job_id=j.id and step_key=p_step for update;
 if not found or s.state not in('in_flight','ambiguous')
 or exists(select 1 from fluid_private.shared_identity_prepared where job_id=j.id and step_key=p_step)
 or exists(select 1 from public.logo_asset_publications where job_id=j.id and source_receipt_id=sid) then return false;end if;
 select count(*) into n from fluid_private.shared_identity_calls where job_id=j.id and step_key=p_step;
 if n=1 then
  select * into c from fluid_private.shared_identity_calls where job_id=j.id and step_key=p_step and phase='specifications' and execution_id=e.execution_id;
  if not found then return false;end if;
  select * into r from fluid_private.shared_identity_receipts where call_id=c.id;
  if not found or fluid_private.shared_identity_receipt_complete(j,r,'specifications') is distinct from true then return false;end if;
  known:=(r.observation#>>'{billing,confirmedMicrousd}')::bigint;resolution_mode:='specifications_only';
 elsif n<>0 then return false;end if;
 if s.actual_cost_microusd is not null and s.actual_cost_microusd<>known then return false;end if;
 insert into fluid_private.shared_identity_specification_cancellations(job_id,step_key,mode,receipt_id,original_step,known_cost_microusd)
 values(j.id,p_step,resolution_mode,r.id,to_jsonb(s),known);
 update public.job_steps set state='failed',actual_cost_microusd=known,completed_at=coalesce(completed_at,clock_timestamp())
 where job_id=j.id and step_key=p_step;
 update public.jobs set actual_cost_microusd=actual_cost_microusd+known-coalesce(s.actual_cost_microusd,0) where id=j.id;
 return true;
end $$;
create function fluid_private.shared_identity_finish(j public.jobs,p_state text) returns void
language plpgsql set search_path='' as $$declare n integer;steps integer;final text;begin
 if p_state is null or p_state not in('succeeded','failed','cancelled','partial') then raise exception 'identity_terminal_invalid' using errcode='22023';end if;
 if j.state in('succeeded','failed','cancelled','partial') then if j.state=p_state then return;end if;raise exception 'identity_terminal_immutable' using errcode='PT409';end if;
 if exists(select 1 from public.job_steps where job_id=j.id and state in('in_flight','ambiguous')) then
  update public.jobs set state='needs_reconciliation',lease_token=null,lease_expires_at=null,error_code=coalesce(error_code,'provider_outcome_unknown') where id=j.id;return;
 end if;
 select count(*) into n from public.identity_generated_roots where job_id=j.id and owner_id=j.owner_id and project_id=j.project_id;
 select count(*) into steps from public.job_steps where job_id=j.id and state in('succeeded','failed');
 if j.cancel_requested_at is not null then final:='cancelled';
 elsif n=3 and steps=3 then final:='succeeded';
 elsif steps=3 or exists(select 1 from public.job_steps where job_id=j.id and state='failed') then
  if exists(select 1 from fluid_private.shared_identity_calls issued left join fluid_private.shared_identity_receipts r on r.call_id=issued.id
   where issued.job_id=j.id and (r.id is null or r.observation#>>'{billing,status}' is distinct from 'recorded')) then
   raise exception 'identity_issued_outcome_unresolved' using errcode='42501';end if;
  final:=case when n>0 then 'partial' else 'failed' end;
 else raise exception 'identity_steps_incomplete' using errcode='42501';end if;
 if p_state<>final then raise exception 'identity_terminal_unproven' using errcode='42501';end if;
 update public.jobs set state=final,lease_token=null,lease_expires_at=null,finished_at=clock_timestamp(),progress=n*100/3 where id=j.id;
end $$;

-- Reuse the fixed same-lane gateway OID/ACL. Its legacy/advanced branches stay
-- byte-for-byte in the private copy; only this distinct admitted operation uses
-- the new Identity lifecycle below.
do $$declare d text;begin
 if not exists(select 1 from pg_proc where oid='public.shared_logo_worker_action(jsonb,jsonb,text,jsonb)'::regprocedure
 and proowner=to_regrole('postgres')::oid and prosecdef and proconfig=array['search_path=""'] and not proleakproof
 and provolatile='v' and prolang=(select oid from pg_language where lanname='plpgsql')
 and encode(sha256(convert_to(prosrc,'UTF8')),'hex')='585fa162edfd0263c6399017232c7373cb108a7f079434db35c8ba888ac1ac18')
 then raise exception 'shared_identity_logo_gateway_predecessor' using errcode='55000';end if;
 d:=pg_get_functiondef('public.shared_logo_worker_action(jsonb,jsonb,text,jsonb)'::regprocedure);
 execute replace(d,'FUNCTION public.shared_logo_worker_action(','FUNCTION fluid_private.shared_identity_previous_logo_gateway(');
end $$;
create or replace function public.shared_logo_worker_action(p_slot jsonb,p_execution jsonb,p_action text,p_args jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s fluid_private.shared_worker_slots;e fluid_private.shared_worker_executions;j public.jobs;candidate public.jobs;mode text;result jsonb;step text;st public.job_steps;
 c fluid_private.shared_identity_calls;r fluid_private.shared_identity_receipts;asset public.logo_asset_publications;prepared fluid_private.shared_identity_prepared;missing boolean;final text;cost bigint;
begin
 if jsonb_typeof(p_args) is distinct from 'array' or octet_length(p_args::text)>2097152 or p_action is null then raise exception 'invalid_shared_identity_action' using errcode='22023';end if;
 if p_action='claim' then
  if p_execution is not null or jsonb_array_length(p_args)<>2 then raise exception 'invalid_identity_claim' using errcode='22023';end if;
  s:=fluid_private.lock_shared_worker_slot(p_slot,true);
  if s.lane<>'logo' then raise exception 'identity_logo_slot_required' using errcode='42501';end if;
  select jobs.* into candidate from public.jobs jobs join fluid_private.shared_job_admissions a on a.job_id=jobs.id and a.lane='logo'
  where jobs.state='queued' and fluid_private.shared_worker_claimable(p_slot,jobs.id) order by jobs.created_at,jobs.id for update of jobs skip locked limit 1;
  if candidate.operation is distinct from 'identity.image' then return fluid_private.shared_identity_previous_logo_gateway(p_slot,p_execution,p_action,p_args);end if;
  if not fluid_private.shared_identity_job(candidate) or not fluid_private.shared_storage_slot_ready(s.slot_id) or not fluid_private.shared_identity_runtime_ready(s.slot_id)
  or length(p_args->>0) not between 1 and 200 or (p_args->>1)::integer not between 10 and 300 then raise exception 'identity_claim_unqualified' using errcode='42501';end if;
  perform fluid_private.enter_shared_worker_claim_context(p_slot,candidate.id);
  update public.jobs set state='running',worker_id=p_args->>0,attempts=attempts+1,lease_token=gen_random_uuid(),lease_expires_at=clock_timestamp()+make_interval(secs=>(p_args->>1)::integer)
  where id=candidate.id and state='queued' and cancel_requested_at is null and attempts<max_attempts returning * into j;
  if not found then perform fluid_private.leave_shared_worker_context();return jsonb_build_object('execution',null,'result','[]'::jsonb);end if;
  e:=fluid_private.bind_shared_worker_execution(p_slot,j.id);perform fluid_private.leave_shared_worker_context();
  return jsonb_build_object('execution',fluid_private.shared_worker_execution_json(e),'result',jsonb_build_array(to_jsonb(j)));
 end if;
 select * into e from fluid_private.shared_worker_executions where execution_id=(p_execution->>'executionId')::uuid;
 if e.operation is distinct from 'identity.image' or e.state='closed' then return fluid_private.shared_identity_previous_logo_gateway(p_slot,p_execution,p_action,p_args);end if;
 if p_action not in('heartbeat','plan','begin','complete','finish','read','has_results','assert_continue','prepare_asset','read_asset','observe_asset',
 'identity_input','identity_authorize','identity_receipt','identity_call','identity_stage','recovery','observe_recovered_asset','finish_known') then raise exception 'identity_action_denied' using errcode='42501';end if;
 mode:=case when p_action in('plan','heartbeat','complete','finish','has_results','observe_asset','identity_input','identity_receipt','identity_call','identity_stage','recovery','observe_recovered_asset','finish_known') then 'observe' else 'active' end;
 if p_action='heartbeat' then begin perform fluid_private.shared_worker_execution(p_slot,p_execution,'active');mode:='active';exception when insufficient_privilege then mode:='observe';end;end if;
 e:=fluid_private.shared_worker_execution(p_slot,p_execution,mode);
 if e.lane<>'logo' or e.operation<>'identity.image' then raise exception 'identity_execution_required' using errcode='42501';end if;
 if p_action in('assert_continue','recovery','finish_known') then
  if p_args<>'[]'::jsonb then raise exception 'identity_args_invalid' using errcode='22023';end if;
 elsif p_action in('prepare_asset','read_asset','observe_asset') then
  if jsonb_array_length(p_args)<>4 or (p_args->>2)::uuid is distinct from e.job_id or (p_args->>3)::uuid is distinct from e.lease_token
  or p_action<>'observe_asset' and (p_args->>0)::uuid is distinct from e.project_id then raise exception 'identity_asset_scope_invalid' using errcode='42501';end if;
 elsif p_action='observe_recovered_asset' then
  if jsonb_array_length(p_args)<>3 or (p_args->>0)::uuid is distinct from e.lease_token then raise exception 'identity_args_invalid' using errcode='42501';end if;
 elsif (p_args->>0)::uuid is distinct from e.job_id or (p_args->>1)::uuid is distinct from e.lease_token then raise exception 'identity_args_invalid' using errcode='42501';end if;
 perform fluid_private.enter_shared_worker_context(p_slot,p_execution,mode);
 j:=fluid_private.shared_identity_context(e.job_id,e.lease_token,mode='active');
 if p_action='assert_continue' then result:='true';
 elsif p_action='identity_input' and jsonb_array_length(p_args)=2 then result:=fluid_private.shared_identity_input(j);
 elsif p_action='identity_authorize' and jsonb_array_length(p_args)=6 then result:=fluid_private.shared_identity_authorize(j,p_args->>2,p_args->>3,p_args->>4,p_args->>5);
 elsif p_action='identity_call' and jsonb_array_length(p_args)=4 then
  perform fluid_private.shared_identity_system_id(j,p_args->>2);
  select receipt.* into r from fluid_private.shared_identity_calls call join fluid_private.shared_identity_receipts receipt on receipt.call_id=call.id
  where call.job_id=j.id and call.execution_id=e.execution_id and call.step_key=p_args->>2 and call.phase=p_args->>3;
  result:=case when r.id is null then 'null'::jsonb else fluid_private.shared_identity_receipt_json(r) end;
 elsif p_action='identity_receipt' and jsonb_array_length(p_args)=4 then result:=fluid_private.shared_identity_record_receipt(j,(p_args->>2)::uuid,fluid_private.shared_logo_json_arg(p_args,3));
 elsif p_action='identity_stage' and jsonb_array_length(p_args)=5 then result:=fluid_private.shared_identity_stage(j,p_args->>2,fluid_private.shared_logo_json_arg(p_args,3),fluid_private.shared_logo_json_arg(p_args,4));
 elsif p_action='prepare_asset' then result:=fluid_private.shared_identity_prepare_asset(j,fluid_private.shared_logo_json_arg(p_args,1));
 elsif p_action='read_asset' then result:=fluid_private.shared_identity_read_asset(j,fluid_private.shared_logo_json_arg(p_args,1));
 elsif p_action='observe_asset' then result:=fluid_private.shared_identity_observe_asset(j,(p_args->>0)::uuid,fluid_private.shared_logo_json_arg(p_args,1));
 elsif p_action='observe_recovered_asset' then
  result:=fluid_private.shared_identity_observe_asset(j,(p_args->>1)::uuid,fluid_private.shared_logo_json_arg(p_args,2));
  insert into fluid_private.shared_logo_output_observations(execution_id,reservation_id,verification) values(e.execution_id,(p_args->>1)::uuid,fluid_private.shared_logo_json_arg(p_args,2)) on conflict do nothing;
 elsif p_action='recovery' then
  select coalesce(jsonb_agg(jsonb_build_object('reservation',fluid_private.logo_asset_reservation(p),'publication',p.request->'publication') order by p.id),'[]') into result
  from public.logo_asset_publications p where p.job_id=j.id and p.owner_id=j.owner_id and p.project_id=j.project_id and p.lease_token=e.lease_token and p.source_kind='identity_system' and p.state in('reserved','staged')
  and exists(select 1 from fluid_private.shared_storage_grants g where g.execution_id=e.execution_id and g.reservation_id=p.id and g.mode='write' and g.binding->'execution'=fluid_private.shared_worker_execution_json(e))
  and not exists(select 1 from fluid_private.shared_logo_output_observations observed where observed.execution_id=e.execution_id and observed.reservation_id=p.id);
  if jsonb_array_length(result)>3 then raise exception 'identity_recovery_bound_exceeded' using errcode='55000';end if;
  result:=jsonb_build_object('observationJob',to_jsonb(j),'observationLeaseToken',e.lease_token,'outputs',result,'executionClosed',false,'capability',(select policy from fluid_private.shared_job_admissions where job_id=j.id),'remaining',false);
 elsif p_action='heartbeat' and jsonb_array_length(p_args)=3 then
  if (p_args->>2)::integer not between 10 and 300 then raise exception 'identity_lease_invalid' using errcode='22023';end if;
  if mode='active' then update public.jobs set lease_expires_at=clock_timestamp()+make_interval(secs=>(p_args->>2)::integer) where id=j.id returning * into j;end if;
  result:=jsonb_build_array(to_jsonb(j));
 elsif p_action='plan' and jsonb_array_length(p_args)=3 then
  if j.plan_manifest is distinct from fluid_private.shared_logo_json_arg(p_args,2) then raise exception 'plan_conflict' using errcode='40001';end if;result:='null';
 elsif p_action='begin' and jsonb_array_length(p_args)=5 then
  step:=p_args->>2;perform fluid_private.shared_identity_system_id(j,step);
  if (p_args->>4)::bigint is distinct from 0 or coalesce(p_args->>3,'')='' or not exists(select 1 from jsonb_array_elements(j.plan_manifest) x where x->>'key'=step and x->'maximumCostMicrousd'='0')
  or exists(select 1 from public.job_steps where job_id=j.id and step_key<>step and state in('in_flight','ambiguous','failed'))
  or exists(select 1 from generate_series(1,right(step,1)::integer-1) earlier where not exists(select 1 from public.job_steps prior_step where prior_step.job_id=j.id and prior_step.step_key='identity-system-v1:'||earlier and prior_step.state='succeeded')) then raise exception 'identity_step_plan_invalid' using errcode='42501';end if;
  select * into st from public.job_steps where job_id=j.id and step_key=step;
  if found then if st.state='succeeded' and st.request_key=p_args->>3 then result:='"already_succeeded"';else raise exception 'identity_step_already_issued' using errcode='42501';end if;
  else insert into public.job_steps(job_id,owner_id,project_id,step_key,request_key,state,reserved_cost_microusd) values(j.id,j.owner_id,j.project_id,step,p_args->>3,'in_flight',0);result:='"started"';end if;
 elsif p_action='complete' and jsonb_array_length(p_args)=7 then
  perform fluid_private.shared_identity_complete(j,p_args->>2,p_args->>3,(p_args->>4)::bigint,fluid_private.shared_logo_json_arg(p_args,5),p_args->>6);result:='null';
 elsif p_action='finish' and jsonb_array_length(p_args)=3 then perform fluid_private.shared_identity_finish(j,p_args->>2);result:='null';
 elsif p_action='has_results' and jsonb_array_length(p_args)=2 then result:=to_jsonb(exists(select 1 from public.identity_generated_roots where job_id=j.id));
 elsif p_action='read' and jsonb_array_length(p_args)=4 and p_args->>2='has_results' then result:=to_jsonb(exists(select 1 from public.identity_generated_roots where job_id=j.id));
 elsif p_action='read' and jsonb_array_length(p_args)=4 and p_args->>2='input_revisions' then result:='[]';
 elsif p_action='finish_known' then
  for prepared in select p.* from fluid_private.shared_identity_prepared p join public.job_steps completed_step on completed_step.job_id=p.job_id and completed_step.step_key=p.step_key
   where p.job_id=j.id and p.execution_id=e.execution_id and completed_step.state='in_flight' order by p.step_key loop
   select coalesce(sum((receipt_row.observation#>>'{billing,confirmedMicrousd}')::bigint),0) into cost from fluid_private.shared_identity_receipts receipt_row where receipt_row.id in(prepared.text_receipt_id,prepared.image_receipt_id) and receipt_row.observation#>>'{billing,status}'='recorded';
   select * into strict r from fluid_private.shared_identity_receipts where id=prepared.image_receipt_id;
   perform fluid_private.shared_identity_complete(j,prepared.step_key,'succeeded',cost,prepared.output,r.observation->>'providerRequestId');
  end loop;
  if j.cancel_requested_at is not null then
   for st in select * from public.job_steps where job_id=j.id and state in('in_flight','ambiguous') order by step_key loop
    perform fluid_private.shared_identity_cancel_known_specification(j,st.step_key);
   end loop;
  end if;
  select * into strict j from public.jobs where id=e.job_id;
  missing:=exists(select 1 from public.job_steps where job_id=j.id and state in('in_flight','ambiguous'));
  if missing then result:=jsonb_build_object('status','retained_unknown');
  elsif j.cancel_requested_at is not null then perform fluid_private.shared_identity_finish(j,'cancelled');result:=jsonb_build_object('status','terminal','state','cancelled');
  elsif (select count(*) from public.job_steps where job_id=j.id and state in('succeeded','failed'))=3 or exists(select 1 from public.job_steps where job_id=j.id and state='failed') then
   final:=case (select count(*) from public.identity_generated_roots where job_id=j.id) when 3 then 'succeeded' when 0 then 'failed' else 'partial' end;
   perform fluid_private.shared_identity_finish(j,final);result:=jsonb_build_object('status','terminal','state',final);
  else result:=jsonb_build_object('status','retained_unknown');end if;
 else raise exception 'identity_action_denied' using errcode='42501';end if;
 perform fluid_private.leave_shared_worker_context();
 select * into strict j from public.jobs where id=e.job_id;
 if j.state='needs_reconciliation' or not fluid_private.shared_worker_admission_active(j.id) then perform fluid_private.park_shared_worker_execution(p_slot,p_execution);
 elsif j.state in('succeeded','failed','cancelled','partial') and j.lease_token is null and not exists(select 1 from public.job_steps where job_id=j.id and state in('in_flight','ambiguous')) then perform fluid_private.close_shared_worker_execution(p_slot,p_execution);end if;
 return jsonb_build_object('execution',fluid_private.shared_worker_execution_json(e),'result',result);
end $$;

-- This is user intent only. It permits a generic Identity project to reuse
-- the exact existing byte/Storage/rights publisher without inventing a Logo
-- brief or accepting byte observations through an authenticated RPC.
create function public.prepare_shared_identity_reference_upload(p_project_id uuid,p_request jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare o uuid:=fluid_private.shared_identity_customer(p_project_id);prior public.logo_input_requests;workspace jsonb;begin
 if p_request->>'kind' is distinct from 'reference_upload' or fluid_private.logo_input_request_valid(p_request) is distinct from true
 then raise exception 'identity_reference_upload_intent_invalid' using errcode='22023';end if;
 perform 1 from public.projects where id=p_project_id and owner_id=o for update;
 select * into prior from public.logo_input_requests where owner_id=o and project_id=p_project_id and request_key=(p_request#>>'{input,requestKey}')::uuid;
 if found then
  if prior.request is distinct from p_request then raise exception 'identity_reference_upload_intent_conflict' using errcode='PT409';end if;
  return fluid_private.logo_input_state(o,p_project_id,prior.request_key);
 end if;
 perform 1 from public.identity_reference_heads where owner_id=o and project_id=p_project_id for update;
 perform 1 from public.identity_sessions where owner_id=o and project_id=p_project_id for update;
 workspace:=fluid_private.logo_workspace_json(o,p_project_id);
 if workspace->'heads' is distinct from p_request#>'{input,expected}' then raise exception 'identity_reference_upload_heads_changed' using errcode='PT409';end if;
 if exists(select 1 from public.logo_workspace_requests where owner_id=o and project_id=p_project_id and request_key=(p_request#>>'{input,requestKey}')::uuid) then raise exception 'identity_reference_upload_key_conflict' using errcode='PT409';end if;
 insert into public.logo_input_requests(owner_id,project_id,request_key,request) values(o,p_project_id,(p_request#>>'{input,requestKey}')::uuid,p_request);
 return fluid_private.logo_input_state(o,p_project_id,(p_request#>>'{input,requestKey}')::uuid);
end $$;

-- Explicit user registration of one already committed/observed upload. This
-- neither imports a foreign asset nor selects Ensemble/elements automatically.
create function public.register_shared_identity_reference(p_project_id uuid,p_upload_request_key uuid,p_metadata jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare o uuid:=fluid_private.shared_identity_customer(p_project_id);prior fluid_private.shared_identity_reference_requests;
 request public.logo_input_requests;receipt public.logo_input_receipts;publication public.logo_asset_publications;rights public.logo_input_rights;reference public.identity_references;
 intent jsonb:=jsonb_build_object('uploadRequestKey',p_upload_request_key,'metadata',p_metadata);rid uuid;
begin
 if p_upload_request_key is null or not fluid_private.standalone_keys(p_metadata,array['attribution','relevantElements','tags'])
 or not fluid_private.reference_attribution(p_metadata->'attribution') or octet_length(p_metadata::text)>8192 then raise exception 'identity_reference_registration_invalid' using errcode='22023';end if;
 perform fluid_private.reference_elements(p_metadata->'relevantElements');perform fluid_private.reference_tags(p_metadata->'tags');
 perform 1 from public.projects where id=p_project_id and owner_id=o for update;
 select * into prior from fluid_private.shared_identity_reference_requests where owner_id=o and project_id=p_project_id and request_key=p_upload_request_key;
 if found then if prior.intent is distinct from intent then raise exception 'identity_reference_registration_conflict' using errcode='PT409';end if;return fluid_private.identity_reference_entry(prior.reference_id,p_project_id,o);end if;
 select * into request from public.logo_input_requests where owner_id=o and project_id=p_project_id and request_key=p_upload_request_key;
 select * into receipt from public.logo_input_receipts where owner_id=o and project_id=p_project_id and request_key=p_upload_request_key;
 select * into publication from public.logo_asset_publications where owner_id=o and project_id=p_project_id and request_key=p_upload_request_key and job_id is null;
 select * into rights from public.logo_input_rights where id=publication.rights_evidence_id and owner_id=o and project_id=p_project_id and publication_id=publication.id;
 if request.request_key is null or receipt.request_key is null or publication.id is null or rights.id is null
 or request.request->>'kind'<>'reference_upload' or receipt.reference_id is distinct from publication.source_receipt_id or receipt.font_record_id is not null
 or publication.state<>'committed' or publication.source_kind<>'logo_reference' or publication.purpose<>'reference_media' or publication.mime_type not in('image/png','image/jpeg','image/webp')
 or publication.verification->>'status'<>'verified' or publication.verification->>'contentHash'<>publication.content_hash or publication.verification->>'mimeType'<>publication.mime_type
 or publication.verification->'byteLength'<>to_jsonb(publication.byte_length) or publication.request#>>'{intent,usage}'<>'logo_reference'
 or rights.source_kind<>'user_declaration' or rights.catalog_id is not null or rights.content_hash<>publication.content_hash
 or request.request->'file' is distinct from jsonb_build_object('contentHash',publication.content_hash,'mimeType',publication.mime_type,'byteLength',publication.byte_length)
 or rights.rights_declaration is distinct from publication.request#>>'{intent,rightsDeclaration}'
 or p_metadata#>>'{attribution,rightsNote}' is distinct from rights.rights_declaration
 or receipt.result->'asset' is distinct from fluid_private.logo_asset_reservation(publication)->'reference'
 or exists(select 1 from public.logo_input_rejections where owner_id=o and project_id=p_project_id and request_key=p_upload_request_key)
 or not exists(select 1 from public.asset_versions v join public.assets a on (a.id,a.owner_id,a.project_id)=(v.asset_id,v.owner_id,v.project_id)
  where v.id=publication.version_id and v.asset_id=publication.asset_id and v.owner_id=o and v.project_id=p_project_id and v.mime_type=publication.mime_type
  and v.content_hash=publication.content_hash and a.purpose='reference_media' and v.provenance->>'publicationId'=publication.id::text)
 then raise exception 'identity_reference_upload_unconfirmed' using errcode='42501';end if;
 insert into public.identity_references(project_id,owner_id,asset_id,media_version_id,source,attribution,relevant_elements,tags)
 values(p_project_id,o,publication.asset_id,publication.version_id,'user_supplied',p_metadata->'attribution',fluid_private.reference_elements(p_metadata->'relevantElements'),fluid_private.reference_tags(p_metadata->'tags')) returning * into reference;
 insert into fluid_private.shared_identity_reference_requests values(o,p_project_id,p_upload_request_key,intent,reference.id);
 return fluid_private.identity_reference_entry(reference.id,p_project_id,o);
end $$;


create function public.read_shared_identity_reference_upload(p_project_id uuid,p_upload_request_key uuid) returns jsonb
language plpgsql security definer set search_path='' as $$declare o uuid:=fluid_private.shared_identity_customer(p_project_id);rid uuid;begin
 select reference_id into rid from fluid_private.shared_identity_reference_requests where owner_id=o and project_id=p_project_id and request_key=p_upload_request_key;
 return case when rid is null then null else fluid_private.identity_reference_entry(rid,p_project_id,o) end;
end $$;


do $generic_isolation$
declare signature text;expected text;fragment text;replacement text;definition text;
begin
 for signature,expected,fragment,replacement in values
 ('public.claim_job(text,integer)','c8e0437a204720f45b20b9f3375e037646e4f29dc0a72198c961bd1351312308',
 'where not fluid_private.naming_brain_is_job(j) and','where not fluid_private.shared_identity_job(j) and not fluid_private.naming_brain_is_job(j) and'),
 ('public.expire_job_leases()','e99608d2bb26164d29202613c87c81c96eee9ee74ec093d95185c04c2a3baea4',
 'where not fluid_private.naming_brain_is_job(jobs) and','where not fluid_private.shared_identity_job(jobs) and not fluid_private.naming_brain_is_job(jobs) and') loop
  if not exists(select 1 from pg_proc where oid=to_regprocedure(signature) and proowner=to_regrole('postgres')::oid and prosecdef
   and provolatile='v' and proconfig=array['search_path=""'] and not proleakproof
   and encode(sha256(convert_to(prosrc,'UTF8')),'hex')=expected) then raise exception 'shared_identity_generic_predecessor_mismatch: %',signature using errcode='55000';end if;
  definition:=pg_get_functiondef(signature::regprocedure);
  if (length(definition)-length(replace(definition,fragment,'')))/length(fragment)<>1 then raise exception 'shared_identity_generic_fragment_mismatch';end if;
  execute replace(definition,fragment,replacement);
 end loop;
end $generic_isolation$;

do $$declare t record;f record;gr record;begin
 for t in select c.oid,c.relowner,c.relacl from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='fluid_private' and c.relname in('shared_identity_requests','shared_identity_admissions','shared_identity_rejected_intents','shared_identity_calls','shared_identity_receipts','shared_identity_prepared','shared_identity_specification_cancellations','shared_identity_reference_requests') loop
  execute format('alter table %s enable row level security',t.oid::regclass);execute format('alter table %s force row level security',t.oid::regclass);
  execute format('create trigger shared_identity_immutable before update or delete on %s for each row execute function fluid_private.shared_job_admission_immutable()',t.oid::regclass);
  for gr in select distinct a.grantee from aclexplode(coalesce(t.relacl,acldefault('r',t.relowner))) a where a.grantee<>t.relowner loop
   execute format('revoke all on table %s from %s cascade',t.oid::regclass,case when gr.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(gr.grantee)) end);
  end loop;
 end loop;
 for f in select p.oid,p.proowner,p.proacl from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='fluid_private' and p.proname like 'shared_identity_%'
  or n.nspname='public' and p.proname in('get_shared_identity_availability','ensure_shared_identity_batch','get_shared_identity_batch','cancel_shared_identity_batch','close_shared_identity_generation_intent','register_shared_identity_reference','read_shared_identity_reference_upload','prepare_shared_identity_reference_upload') loop
  for gr in select distinct a.grantee from aclexplode(coalesce(f.proacl,acldefault('f',f.proowner))) a where a.grantee<>f.proowner loop
   execute format('revoke all on function %s from %s cascade',f.oid::regprocedure,case when gr.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(gr.grantee)) end);
  end loop;
 end loop;
end $$;
grant execute on function public.get_shared_identity_availability(uuid),public.ensure_shared_identity_batch(uuid,jsonb),public.get_shared_identity_batch(uuid,uuid,text),
 public.close_shared_identity_generation_intent(uuid,jsonb),public.prepare_shared_identity_reference_upload(uuid,jsonb),public.cancel_shared_identity_batch(uuid,uuid),public.register_shared_identity_reference(uuid,uuid,jsonb),public.read_shared_identity_reference_upload(uuid,uuid) to authenticated;
commit;
