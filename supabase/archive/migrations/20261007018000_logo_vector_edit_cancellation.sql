-- LOCAL PROPOSAL ONLY. Not applied to any hosted database.
-- Exact saveLogoEdit cancellation. No worker/web login grants, credentials,
-- provider admission, mutable stage rewrite, or generic request-state change.
begin;
create table public.logo_vector_edit_cancellations (
 owner_id uuid not null, project_id uuid not null, request_key uuid not null,
 command jsonb not null, created_at timestamptz not null default clock_timestamp(),
 primary key(owner_id,project_id,request_key),
 foreign key(project_id,owner_id) references public.projects(id,owner_id),
 check(command->>'method'='saveLogoEdit' and command#>>'{body,requestKey}'=request_key::text and octet_length(command::text)<=32768)
);
create trigger logo_vector_edit_cancellations_immutable before update or delete on public.logo_vector_edit_cancellations for each row execute function fluid_private.prevent_history_change();

-- Passive command validation only. A tombstone does not validate or publish any
-- artwork, prove font rights, consume assets, or change the expected-head CAS.
create function fluid_private.logo_vector_edit_cancel_command_valid(v jsonb) returns boolean language plpgsql immutable set search_path='' as $$
declare b jsonb:=v->'body'; e jsonb:=b->'edit'; k text:=e->>'kind'; item jsonb; t jsonb; ids jsonb; check_command jsonb;
begin
 if not fluid_private.standalone_keys(v,array['method','body']) or v->>'method' is distinct from 'saveLogoEdit' or octet_length(v::text)>32768
  or not fluid_private.standalone_keys(b,array['requestKey','expected','baseVectorRevisionId','edit']) or not fluid_private.logo_uuid(b->'baseVectorRevisionId') then return false;end if;
 check_command:=jsonb_build_object('method','restoreLogoStage','body',jsonb_build_object('requestKey',b->'requestKey','expected',b->'expected','stage','concepts','revisionId','00000000-0000-4000-8000-000000000001','acceptEarlierBasis',false));
 if fluid_private.logo_base_command_valid(check_command) is distinct from true then return false;end if;
 if k in('text','font','spacing','size','rotation','color','replace_outlined_lettering') and
  (jsonb_typeof(e->'componentId') is distinct from 'string' or length(e->>'componentId') not between 1 and 200 or e->>'componentId'!~'^[A-Za-z0-9][A-Za-z0-9._:-]*$') then return false;end if;
 case k
 when 'text' then return fluid_private.standalone_keys(e,array['kind','componentId','text']) and jsonb_typeof(e->'text')='string' and char_length(e->>'text') between 1 and 200;
 when 'font' then return fluid_private.standalone_keys(e,array['kind','componentId','fontVersionId']) and fluid_private.logo_uuid(e->'fontVersionId');
 when 'spacing' then return fluid_private.standalone_keys(e,array['kind','componentId','letterSpacing','lineHeight']) and jsonb_typeof(e->'letterSpacing')='number' and(e->>'letterSpacing')::numeric between -1000000 and 1000000 and jsonb_typeof(e->'lineHeight')='number' and(e->>'lineHeight')::numeric>0 and(e->>'lineHeight')::numeric<=100;
 when 'size' then return fluid_private.standalone_keys(e,array['kind','componentId','scale']) and jsonb_typeof(e->'scale')='number' and(e->>'scale')::numeric between 0.01 and 100;
 when 'rotation' then return fluid_private.standalone_keys(e,array['kind','componentId','degrees']) and jsonb_typeof(e->'degrees')='number' and(e->>'degrees')::numeric between -180 and 180;
 when 'color' then return fluid_private.standalone_keys(e,array['kind','componentId','fill','stroke']) and(e->'fill'='null'::jsonb or(jsonb_typeof(e->'fill')='string' and e->>'fill'~'^#[0-9A-F]{6}$')) and(e->'stroke'='null'::jsonb or(jsonb_typeof(e->'stroke')='string' and e->>'stroke'~'^#[0-9A-F]{6}$'));
 when 'replace_outlined_lettering' then return fluid_private.standalone_keys(e-'contentKind',array['kind','componentId','fontVersionId','text']) and(not(e?'contentKind') or e->>'contentKind' in('brand_name','approved_initials')) and fluid_private.logo_uuid(e->'fontVersionId') and jsonb_typeof(e->'text')='string' and char_length(e->>'text') between 1 and 200;
 when 'locks' then
  if not fluid_private.standalone_keys(e,array['kind','componentIds']) or jsonb_typeof(e->'componentIds') is distinct from 'array' or jsonb_array_length(e->'componentIds')>64 then return false;end if;
  ids:=e->'componentIds';
 when 'arrangement' then
  if not fluid_private.standalone_keys(e,array['kind','placements','order']) or jsonb_typeof(e->'placements') is distinct from 'array' or jsonb_array_length(e->'placements') not between 1 and 64 or jsonb_typeof(e->'order') is distinct from 'array' or jsonb_array_length(e->'order') not between 1 and 64 then return false;end if;
  if(select count(*) from jsonb_array_elements(e->'placements'))<>(select count(distinct value->'componentId') from jsonb_array_elements(e->'placements')) then return false;end if;
  for item in select value from jsonb_array_elements(e->'placements') loop
   t:=item->'transform';
   if not fluid_private.standalone_keys(item,array['componentId','transform']) or not(e->'order'@>jsonb_build_array(item->'componentId')) or not fluid_private.standalone_keys(t,array['x','y','scale','rotation'])
    or jsonb_typeof(t->'x') is distinct from 'number' or(t->>'x')::numeric not between -1000000 and 1000000 or jsonb_typeof(t->'y') is distinct from 'number' or(t->>'y')::numeric not between -1000000 and 1000000
    or jsonb_typeof(t->'scale') is distinct from 'number' or(t->>'scale')::numeric not between 0.01 and 100 or jsonb_typeof(t->'rotation') is distinct from 'number' or(t->>'rotation')::numeric not between -180 and 180 then return false;end if;
  end loop;
  ids:=e->'order';
 when 'group_components' then
  if not fluid_private.standalone_keys(e,array['kind','regions']) or jsonb_typeof(e->'regions') is distinct from 'array' or jsonb_array_length(e->'regions') not between 1 and 64 then return false;end if;
  for item in select value from jsonb_array_elements(e->'regions') loop
   t:=item->'bounds';
   if not fluid_private.standalone_keys(item,array['id','role','bounds']) or jsonb_typeof(item->'role') is distinct from 'string' or item->>'role' not in('symbol','lettering','illustration','border','whole_artwork') or jsonb_typeof(t) is distinct from 'array' or jsonb_array_length(t)<>4
    or jsonb_typeof(t->0) is distinct from 'number' or(t->>0)::numeric not between -1000000 and 1000000 or jsonb_typeof(t->1) is distinct from 'number' or(t->>1)::numeric not between -1000000 and 1000000
    or jsonb_typeof(t->2) is distinct from 'number' or(t->>2)::numeric<=0 or(t->>2)::numeric>16384 or jsonb_typeof(t->3) is distinct from 'number' or(t->>3)::numeric<=0 or(t->>3)::numeric>16384 then return false;end if;
  end loop;
  select jsonb_agg(value->'id') into ids from jsonb_array_elements(e->'regions');
 else return false;
 end case;
 if(select count(*) from jsonb_array_elements(ids))<>(select count(distinct value) from jsonb_array_elements(ids)) then return false;end if;
 for item in select value from jsonb_array_elements(ids) loop
  if jsonb_typeof(item) is distinct from 'string' or length(item#>>'{}') not between 1 and 200 or item#>>'{}'!~'^[A-Za-z0-9][A-Za-z0-9._:-]*$' then return false;end if;
 end loop;
 return true;
exception when others then return false;
end $$;

create function fluid_private.logo_vector_edit_request_state(p_owner uuid,p_project uuid,p_key uuid) returns jsonb language plpgsql stable set search_path='' as $$
declare prior public.logo_workspace_requests; cancelled public.logo_vector_edit_cancellations;
begin
 select * into prior from public.logo_workspace_requests where owner_id=p_owner and project_id=p_project and request_key=p_key and method<>'startLogoProject';
 if found then
  if prior.method is distinct from 'saveLogoEdit' then raise exception 'logo_request_conflict' using errcode='PT409';end if;
  return jsonb_build_object('status','succeeded','ownerId',p_owner,'projectId',p_project,'requestKey',p_key,'command',prior.input,'receipt',prior.receipt);
 end if;
 select * into cancelled from public.logo_vector_edit_cancellations where owner_id=p_owner and project_id=p_project and request_key=p_key;
 if found then return jsonb_build_object('status','cancelled','ownerId',p_owner,'projectId',p_project,'requestKey',p_key,'command',cancelled.command);end if;
 return jsonb_build_object('status','not_found');
end $$;

create function public.cancel_logo_vector_edit(p_project_id uuid,p_command jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare owner uuid:=auth.uid(); key uuid; prior public.logo_workspace_requests; cancelled public.logo_vector_edit_cancellations;
begin
 if owner is null then raise exception 'unauthenticated' using errcode='42501';end if;
 if fluid_private.logo_vector_edit_cancel_command_valid(p_command) is distinct from true then raise exception 'invalid_logo_edit_cancellation' using errcode='22023';end if;
 key:=(p_command#>>'{body,requestKey}')::uuid;
 -- The same owned project lock serializes this tombstone against final commit.
 perform 1 from public.projects where id=p_project_id and owner_id=owner for update;
 if not found then raise exception 'logo_project_not_found' using errcode='P0002';end if;
 select * into prior from public.logo_workspace_requests where owner_id=owner and project_id=p_project_id and request_key=key and method<>'startLogoProject';
 if found then
  if prior.input is distinct from p_command then raise exception 'logo_request_conflict' using errcode='PT409';end if;
  return fluid_private.logo_vector_edit_request_state(owner,p_project_id,key);
 end if;
 if exists(select 1 from public.logo_operation_requests where owner_id=owner and project_id=p_project_id and request_key=key) or exists(select 1 from public.logo_operation_rejections where owner_id=owner and project_id=p_project_id and request_key=key) then raise exception 'logo_request_conflict' using errcode='PT409';end if;
 select * into cancelled from public.logo_vector_edit_cancellations where owner_id=owner and project_id=p_project_id and request_key=key;
 if found then
  if cancelled.command is distinct from p_command then raise exception 'logo_request_conflict' using errcode='PT409';end if;
 else
  insert into public.logo_vector_edit_cancellations(owner_id,project_id,request_key,command) values(owner,p_project_id,key,p_command);
 end if;
 return fluid_private.logo_vector_edit_request_state(owner,p_project_id,key);
end $$;
create function public.read_logo_vector_edit_request(p_project_id uuid,p_request_key uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare owner uuid:=auth.uid();
begin
 if owner is null then raise exception 'unauthenticated' using errcode='42501';end if;
 if not exists(select 1 from public.projects where id=p_project_id and owner_id=owner) then raise exception 'logo_project_not_found' using errcode='P0002';end if;
 return fluid_private.logo_vector_edit_request_state(owner,p_project_id,p_request_key);
end $$;

-- Preserve the existing trusted replay contract and its existing ACL. A cancelled
-- edit rejects before producer I/O; a preflight race is fenced again at commit.
create or replace function fluid_private.read_logo_trusted_request(p_project uuid,p_command jsonb) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare owner uuid:=fluid_private.logo_asset_web_owner();existing public.logo_workspace_requests;cancelled public.logo_vector_edit_cancellations;
begin
 if not exists(select 1 from public.projects where id=p_project and owner_id=owner) then raise exception 'logo_project_not_found' using errcode='P0002';end if;
 if not fluid_private.logo_uuid(p_command#>'{body,requestKey}') then raise exception 'invalid_logo_request' using errcode='22023';end if;
 select * into existing from public.logo_workspace_requests where owner_id=owner and project_id=p_project and request_key=(p_command#>>'{body,requestKey}')::uuid and method<>'startLogoProject';
 if found then
  if existing.input is distinct from p_command then raise exception 'logo_request_conflict' using errcode='PT409';end if;return existing.receipt;
 end if;
 select * into cancelled from public.logo_vector_edit_cancellations where owner_id=owner and project_id=p_project and request_key=(p_command#>>'{body,requestKey}')::uuid;
 if found then
  if cancelled.command is distinct from p_command then raise exception 'logo_request_conflict' using errcode='PT409';end if;
  raise exception 'logo_edit_cancelled' using errcode='PT409';
 end if;
 return null;
end $$;

-- Existing immutable publisher, with only the narrow cancellation fence added.
create or replace function fluid_private.commit_logo_vector_edit(p_owner uuid,p_project uuid,p_command jsonb,p_evidence jsonb) returns jsonb language plpgsql set search_path='' as $$
declare base jsonb;current_id uuid;d public.logo_asset_publications;s public.logo_asset_publications;b jsonb:=p_command->'body';v jsonb;payload jsonb;revision jsonb;ids jsonb;cancelled public.logo_vector_edit_cancellations;
begin
 if fluid_private.logo_asset_web_owner() is distinct from p_owner then raise exception 'logo_principal_mismatch' using errcode='42501';end if;
 -- Reacquire the owned project lock even if invoked directly by an existing
 -- internal caller. Cancel may have won while the producer was staging bytes.
 perform 1 from public.projects where id=p_project and owner_id=p_owner for update;
 if not found then raise exception 'logo_project_not_found' using errcode='P0002';end if;
 select * into cancelled from public.logo_vector_edit_cancellations where owner_id=p_owner and project_id=p_project and request_key=(b->>'requestKey')::uuid;
 if found then
  if cancelled.command is distinct from p_command then raise exception 'logo_request_conflict' using errcode='PT409';end if;
  raise exception 'logo_edit_cancelled' using errcode='PT409';
 end if;
 if p_command->>'method' is distinct from 'saveLogoEdit' or not coalesce(fluid_private.standalone_keys(b,array['requestKey','expected','baseVectorRevisionId','edit']),false)
  or not coalesce(fluid_private.logo_uuid(b->'baseVectorRevisionId'),false)
  or not coalesce(fluid_private.standalone_keys(p_evidence,array['baseVectorRevisionId','documentPublicationId','svgPublicationId','documentHash','proof','locks']),false)
  or p_evidence->'baseVectorRevisionId' is distinct from b->'baseVectorRevisionId'
  or not coalesce(fluid_private.logo_uuid(p_evidence->'documentPublicationId'),false) or not coalesce(fluid_private.logo_uuid(p_evidence->'svgPublicationId'),false)
  or not fluid_private.logo_vector_proof_valid(p_evidence->'proof') or p_evidence->'documentHash' is distinct from p_evidence#>'{proof,documentHash}'
  or not fluid_private.logo_vector_locks_valid(p_evidence->'locks') then raise exception 'invalid_logo_edit_evidence' using errcode='22023';end if;
 if fluid_private.logo_workspace_json(p_owner,p_project)->'heads' is distinct from b->'expected' then raise exception 'logo_head_conflict' using errcode='PT409';end if;
 select record into base from public.logo_vector_revisions where id=(b->>'baseVectorRevisionId')::uuid and owner_id=p_owner and project_id=p_project;
 if base is null then raise exception 'logo_vector_not_found' using errcode='P0002';end if;
 current_id:=fluid_private.logo_current_vector_id(p_owner,p_project);
 if current_id is distinct from (base->>'id')::uuid then raise exception 'logo_edit_base_conflict' using errcode='PT409';end if;
 if b#>>'{edit,kind}'='locks' then
  if not coalesce(fluid_private.standalone_keys(b->'edit',array['kind','componentIds']),false) or jsonb_typeof(b#>'{edit,componentIds}') is distinct from 'array'
   or p_evidence->'documentHash' is distinct from base->'documentHash' or p_evidence->'proof' is distinct from base->'proof' then raise exception 'logo_unlock_requires_unchanged_artwork' using errcode='22023';end if;
  select coalesce(jsonb_agg(value->'componentId' order by value->>'componentId'),'[]') into ids from jsonb_array_elements(p_evidence->'locks');
  if ids is distinct from (select coalesce(jsonb_agg(value order by value),'[]') from jsonb_array_elements(b#>'{edit,componentIds}')) then raise exception 'logo_lock_ids_mismatch' using errcode='22023';end if;
 elsif b#>>'{edit,kind}' not in('text','font','spacing','size','rotation','color','arrangement','group_components','replace_outlined_lettering') or p_evidence->'locks' is distinct from base->'locks' then raise exception 'logo_locks_mismatch' using errcode='22023';end if;
 select * into d from public.logo_asset_publications where id=(p_evidence->>'documentPublicationId')::uuid for update;
 select * into s from public.logo_asset_publications where id=(p_evidence->>'svgPublicationId')::uuid for update;
 if not fluid_private.logo_vector_member_valid(d,p_owner,p_project,(base->>'id')::uuid,base->'inputRevisions','application/json',p_evidence->>'documentHash')
  or not fluid_private.logo_vector_member_valid(s,p_owner,p_project,(base->>'id')::uuid,base->'inputRevisions','image/svg+xml',p_evidence#>>'{proof,svgContentHash}')
  or d.id=s.id or d.asset_id=s.asset_id or d.version_id=s.version_id or d.job_id is not null or s.job_id is not null then raise exception 'invalid_logo_vector_members' using errcode='55000';end if;
 perform fluid_private.logo_commit_asset(d);perform fluid_private.logo_commit_asset(s);
 v:=jsonb_build_object('id',gen_random_uuid(),'ownerId',p_owner,'projectId',p_project,'parentRevisionId',base->'id','source',base->'source','sourcePreview',base->'sourcePreview',
  'documentAsset',fluid_private.logo_asset_reservation(d)->'reference','svgAsset',fluid_private.logo_asset_reservation(s)->'reference','documentHash',p_evidence->'documentHash',
  'proof',p_evidence->'proof','locks',p_evidence->'locks','inputRevisions',base->'inputRevisions','reviewStatus','review_required','createdAt',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
 insert into public.logo_vector_revisions(id,owner_id,project_id,record) values((v->>'id')::uuid,p_owner,p_project,v);
 select r.record->'payload' into payload from public.logo_stage_heads h join public.logo_stage_revisions r on r.id=h.revision_id and r.owner_id=h.owner_id and r.project_id=h.project_id where h.owner_id=p_owner and h.project_id=p_project and h.stage='refinements';
 payload:=jsonb_build_object('rasterRevisionIds',coalesce(payload->'rasterRevisionIds','[]'::jsonb),'vectorRevisionId',v->'id','approvalId',null,'sourceRequestKey',b->'requestKey');
 revision:=fluid_private.logo_append_stage(p_owner,p_project,'refinements',payload,base->'inputRevisions');
 return revision;
end $$;

-- Preserve the trusted dispatch boundary and its existing ACL verbatim except
-- for the same narrow cancellation fence after immutable success replay.
create or replace function fluid_private.apply_logo_trusted_command(p_project uuid,p_command jsonb,p_evidence jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare owner uuid:=fluid_private.logo_asset_web_owner();b jsonb:=p_command->'body';method text:=p_command->>'method';existing public.logo_workspace_requests;workspace jsonb;revision jsonb;result jsonb;produced jsonb;check_command jsonb;target_stage jsonb;target_id uuid;current_id uuid;target_vector jsonb;current_vector jsonb;item jsonb;cancelled public.logo_vector_edit_cancellations;
begin
 if method not in('saveLogoEdit','acceptLogoVector','selectIdentityDirectionComponents','approveIdentityDirection','prepareLogoVariants','reviewLogoVariants','restoreLogoStage') or not fluid_private.standalone_keys(p_command,array['method','body']) or octet_length(p_command::text)>32768 or octet_length(p_evidence::text)>2097152 then raise exception 'invalid_logo_trusted_command' using errcode='22023';end if;
 check_command:=jsonb_build_object('method','restoreLogoStage','body',jsonb_build_object('requestKey',b->'requestKey','expected',b->'expected','stage','concepts','revisionId','00000000-0000-4000-8000-000000000001','acceptEarlierBasis',false));
 if not fluid_private.logo_base_command_valid(check_command) then raise exception 'invalid_logo_trusted_command' using errcode='22023';end if;
 perform 1 from public.projects where id=p_project and owner_id=owner for update;
 if not found then raise exception 'logo_project_not_found' using errcode='P0002';end if;
 select * into existing from public.logo_workspace_requests req where req.owner_id=owner and req.project_id=p_project and req.request_key=(b->>'requestKey')::uuid and req.method<>'startLogoProject';
 if found then if existing.input is distinct from p_command then raise exception 'logo_request_conflict' using errcode='PT409';end if;return existing.receipt;end if;
 -- A different trusted method may have passed preflight before cancellation.
 -- Fence the exact retained key here, under the existing project lock, before
 -- any source/asset commit. Existing immutable success above remains untouched.
 select * into cancelled from public.logo_vector_edit_cancellations where owner_id=owner and project_id=p_project and request_key=(b->>'requestKey')::uuid;
 if found then
  if cancelled.command is distinct from p_command then raise exception 'logo_request_conflict' using errcode='PT409';end if;
  raise exception 'logo_edit_cancelled' using errcode='PT409';
 end if;
 if to_regclass('public.logo_operation_rejections') is not null then
  if exists(select 1 from public.logo_operation_rejections req where req.owner_id=owner and req.project_id=p_project and req.request_key=(b->>'requestKey')::uuid) then raise exception 'logo_request_conflict' using errcode='PT409';end if;
 end if;
 if to_regclass('public.logo_operation_requests') is not null then
  if exists(select 1 from public.logo_operation_requests req where req.owner_id=owner and req.project_id=p_project and req.request_key=(b->>'requestKey')::uuid) then raise exception 'logo_request_conflict' using errcode='PT409';end if;
 end if;
 perform 1 from public.identity_reference_heads where owner_id=owner and project_id=p_project for update;
 perform 1 from public.identity_sessions where owner_id=owner and project_id=p_project for update;
 workspace:=fluid_private.logo_workspace_json(owner,p_project);
 if workspace->'heads' is distinct from b->'expected' then raise exception 'logo_head_conflict' using errcode='PT409';end if;
 if method in('acceptLogoVector','restoreLogoStage') then
  -- Only the trusted server producer may supply this evidence, after loading
  -- actual canonical/SVG bytes and validating complete geometry/occlusion locks.
  -- The commit rechecks the exact IDs that were checked outside the transaction.
  if not fluid_private.logo_command_valid(p_command) then raise exception 'invalid_logo_command' using errcode='22023';end if;
  current_id:=fluid_private.logo_current_vector_id(owner,p_project);
  if method='restoreLogoStage' then
   if b->>'stage' not in('vector','refinements') or not fluid_private.standalone_keys(p_evidence,array['targetStageRevisionId','currentVectorRevisionId','targetVectorRevisionId','expected']) or p_evidence->'targetStageRevisionId' is distinct from b->'revisionId' then raise exception 'invalid_logo_verified_restore' using errcode='22023';end if;
   select r.record into target_stage from public.logo_stage_revisions r where r.id=(b->>'revisionId')::uuid and r.owner_id=owner and r.project_id=p_project and r.stage=b->>'stage';
   if target_stage is null then raise exception 'logo_revision_not_found' using errcode='P0002';end if;
   target_id:=(target_stage#>>'{payload,vectorRevisionId}')::uuid;
   if p_evidence->'targetVectorRevisionId' is distinct from coalesce(to_jsonb(target_id),'null'::jsonb) then raise exception 'logo_verified_source_changed' using errcode='PT409';end if;
  else
   if not fluid_private.standalone_keys(p_evidence,array['vectorRevisionId','currentVectorRevisionId','expected']) or p_evidence->'vectorRevisionId' is distinct from b->'vectorRevisionId' then raise exception 'invalid_logo_verified_candidate' using errcode='22023';end if;
   target_id:=(b->>'vectorRevisionId')::uuid;
  end if;
  if p_evidence->'expected' is distinct from b->'expected' or p_evidence->'currentVectorRevisionId' is distinct from coalesce(to_jsonb(current_id),'null'::jsonb) then raise exception 'logo_verified_source_changed' using errcode='PT409';end if;
  if current_id is not null then
   select v.record into current_vector from public.logo_vector_revisions v where v.id=current_id and v.owner_id=owner and v.project_id=p_project;
   if current_vector is null then raise exception 'logo_vector_not_found' using errcode='P0002';end if;
  end if;
  if target_id is not null then
   select v.record into target_vector from public.logo_vector_revisions v where v.id=target_id and v.owner_id=owner and v.project_id=p_project;
   if target_vector is null then raise exception 'logo_vector_not_found' using errcode='P0002';end if;
  end if;
  -- Restoring/accepting another revision must not implicitly unlock a component.
  for item in select value from jsonb_array_elements(coalesce(current_vector->'locks','[]'::jsonb)) loop
   if not exists(select 1 from jsonb_array_elements(coalesce(target_vector->'locks','[]'::jsonb)) held where held=item) then raise exception 'logo_saved_lock_conflict' using errcode='PT409';end if;
  end loop;
  return fluid_private.logo_apply(owner,p_project,p_command);
 elsif method='saveLogoEdit' then revision:=fluid_private.commit_logo_vector_edit(owner,p_project,p_command,p_evidence);
 elsif method in('selectIdentityDirectionComponents','approveIdentityDirection') then revision:=fluid_private.commit_logo_direction_command(owner,p_project,p_command,p_evidence);
 else
  produced:=fluid_private.commit_logo_deliverable_command(owner,p_project,p_command,p_evidence);revision:=produced->'revision';
 end if;
 if revision->>'ownerId' is distinct from owner::text or revision->>'projectId' is distinct from p_project::text or not exists(select 1 from public.logo_stage_heads h where h.owner_id=owner and h.project_id=p_project and h.stage=revision->>'stage' and h.revision_id::text=revision->>'id') then raise exception 'invalid_logo_producer_stage' using errcode='55000';end if;
 if method='prepareLogoVariants' then
  result:=produced->'variantSet';
  if result->>'ownerId' is distinct from owner::text or result->>'projectId' is distinct from p_project::text or result->'approvedLogoId' is distinct from b->'approvedLogoId' or result->'directionApprovalId' is distinct from b->'directionApprovalId' then raise exception 'invalid_logo_variant_receipt' using errcode='55000';end if;
 else result:=jsonb_build_object('ownerId',owner,'projectId',p_project,'requestKey',b->'requestKey','revision',revision,'workspace',fluid_private.logo_workspace_json(owner,p_project));end if;
 insert into public.logo_workspace_requests(project_id,owner_id,request_key,method,input,receipt) values(p_project,owner,(b->>'requestKey')::uuid,method,p_command,result);return result;
end $$;

-- Manual methods share one owner/project/key namespace. Legacy brief/reference
-- writers must not consume a cancelled edit key after an acknowledgement was
-- lost. This final guard rolls back their earlier in-transaction stage writes.
-- Creation deliberately retains its separate owner/key namespace.
create function fluid_private.prevent_cancelled_logo_vector_receipt() returns trigger language plpgsql set search_path='' as $$
begin
 if new.method='startLogoProject' then return new;end if;
 perform 1 from public.projects where id=new.project_id and owner_id=new.owner_id for update;
 if exists(select 1 from public.logo_vector_edit_cancellations where owner_id=new.owner_id and project_id=new.project_id and request_key=new.request_key) then
  raise exception 'logo_request_conflict' using errcode='PT409';
 end if;
 return new;
end $$;
create trigger logo_workspace_requests_vector_cancellation before insert on public.logo_workspace_requests for each row execute function fluid_private.prevent_cancelled_logo_vector_receipt();

-- Generation and export admissions/rejections share the same request namespace.
-- Their pure-SQL admission writes must roll back if an edit cancellation won
-- the project lock; existing operation rows and exact replay remain untouched.
create function fluid_private.prevent_cancelled_logo_vector_operation() returns trigger language plpgsql set search_path='' as $$
begin
 perform 1 from public.projects where id=new.project_id and owner_id=new.owner_id for update;
 if exists(select 1 from public.logo_vector_edit_cancellations where owner_id=new.owner_id and project_id=new.project_id and request_key=new.request_key) then
  raise exception 'logo_request_conflict' using errcode='PT409';
 end if;
 return new;
end $$;
create trigger logo_operation_requests_vector_cancellation before insert on public.logo_operation_requests for each row execute function fluid_private.prevent_cancelled_logo_vector_operation();
create trigger logo_operation_rejections_vector_cancellation before insert on public.logo_operation_rejections for each row execute function fluid_private.prevent_cancelled_logo_vector_operation();

-- Scrub only exact NEW object OIDs. CREATE OR REPLACE retains the existing
-- trusted helpers' owner/ACL; no global grants or default privileges change.
do $$ declare relation_id oid:='public.logo_vector_edit_cancellations'::regclass; signature text; r record; c record;
begin
 for r in select distinct a.grantee from pg_class p cross join lateral aclexplode(coalesce(p.relacl,acldefault('r',p.relowner))) a where p.oid=relation_id and a.grantee<>p.relowner loop
  execute format('revoke all on table %s from %s cascade',relation_id::regclass,case when r.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(r.grantee)) end);
 end loop;
 for c in select at.attname,a.grantee from pg_attribute at join pg_class p on p.oid=at.attrelid cross join lateral aclexplode(at.attacl) a where p.oid=relation_id and a.grantee<>p.relowner loop
  execute format('revoke all (%I) on table %s from %s cascade',c.attname,relation_id::regclass,case when c.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(c.grantee)) end);
 end loop;
 alter table public.logo_vector_edit_cancellations enable row level security;
 alter table public.logo_vector_edit_cancellations force row level security;
 foreach signature in array array['fluid_private.logo_vector_edit_cancel_command_valid(jsonb)','fluid_private.logo_vector_edit_request_state(uuid,uuid,uuid)','fluid_private.prevent_cancelled_logo_vector_receipt()','fluid_private.prevent_cancelled_logo_vector_operation()','public.cancel_logo_vector_edit(uuid,jsonb)','public.read_logo_vector_edit_request(uuid,uuid)'] loop
  for r in select distinct a.grantee from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where p.oid=to_regprocedure(signature) and a.grantee<>p.proowner loop
   execute format('revoke all on function %s from %s cascade',signature,case when r.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(r.grantee)) end);
  end loop;
 end loop;
end $$;
create policy logo_vector_edit_cancellations_owner_read on public.logo_vector_edit_cancellations for select to authenticated using(owner_id=(select auth.uid()));
-- No direct table grant: owners read exact proofs only through the bounded RPC.
grant execute on function public.cancel_logo_vector_edit(uuid,jsonb),public.read_logo_vector_edit_request(uuid,uuid) to authenticated;
commit;
