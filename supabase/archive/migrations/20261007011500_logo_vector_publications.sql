-- Local candidate only. Reuses the existing asset publications, immutable
-- vector revisions, approvals and durable job queue. No login or grant setup.
begin;

create table fluid_private.logo_vector_publications(
 id uuid primary key references public.logo_asset_publications(id),
 document_publication_id uuid not null unique references public.logo_asset_publications(id),
 owner_id uuid not null,project_id uuid not null,job_id uuid not null unique,lease_token uuid not null,
 evidence jsonb not null,record jsonb not null,engine jsonb not null,
 state text not null default 'staged' check(state in('staged','committed')),
 foreign key(job_id,owner_id,project_id) references public.jobs(id,owner_id,project_id),
 check(id<>document_publication_id),check(octet_length(evidence::text)<=65536),check(octet_length(record::text)<=65536)
);
alter table fluid_private.logo_vector_publications enable row level security;
alter table fluid_private.logo_vector_publications force row level security;
revoke all on fluid_private.logo_vector_publications from public,anon,authenticated,service_role;

create function fluid_private.logo_vector_proof_valid(p jsonb) returns boolean language plpgsql immutable set search_path='' as $$
declare n numeric;
begin
 if not coalesce(fluid_private.standalone_keys(p,array['version','svgContentHash','documentHash','validator','viewBox','pathCount','componentCount','externalFontDependencies']),false)
  or p->'version' is distinct from '1'::jsonb or p->'validator' is distinct from '{"id":"fluid.logo-vector","version":"1"}'::jsonb
  or p->'externalFontDependencies' is distinct from '[]'::jsonb
  or jsonb_typeof(p->'documentHash') is distinct from 'string' or p->>'documentHash'!~'^[0-9a-f]{64}$'
  or jsonb_typeof(p->'svgContentHash') is distinct from 'string' or p->>'svgContentHash'!~'^[0-9a-f]{64}$'
  or jsonb_typeof(p->'viewBox') is distinct from 'array' or jsonb_array_length(p->'viewBox')<>4
  or jsonb_typeof(p->'pathCount') is distinct from 'number' or jsonb_typeof(p->'componentCount') is distinct from 'number' then return false;end if;
 n:=(p->>'pathCount')::numeric;if n<>trunc(n) or n not between 1 and 20000 then return false;end if;
 n:=(p->>'componentCount')::numeric;if n<>trunc(n) or n not between 1 and 64 or n>(p->>'pathCount')::numeric then return false;end if;
 for i in 0..3 loop
  if jsonb_typeof(p#>array['viewBox',i::text]) is distinct from 'number' then return false;end if;
  n:=(p#>>array['viewBox',i::text])::numeric;
  if abs(n)>1000000 or (i>=2 and (n<=0 or n>16384)) then return false;end if;
 end loop;
 return true;
exception when others then return false;
end $$;

-- Only the trusted geometry producer calls this envelope validator. Actual
-- canonical bytes and locks are inspected before file staging; SQL repeats the
-- exact ownership/source/hash/size bindings inside the final transaction.
create function fluid_private.logo_vector_member_valid(r public.logo_asset_publications,p_owner uuid,p_project uuid,p_source uuid,p_inputs jsonb,p_mime text,p_hash text) returns boolean language sql stable set search_path='' as $$
 select coalesce(r.id is not null and r.owner_id=p_owner and r.project_id=p_project and r.source_kind='vector' and r.source_receipt_id=p_source
  and r.request#>'{publication,inputRevisions}'=p_inputs and r.state in('staged','committed') and r.purpose='brand_asset'
  and r.mime_type=p_mime and r.content_hash=p_hash and r.byte_length between 1 and 8388608
  and r.verification->>'status'='verified' and r.verification->>'contentHash'=r.content_hash and r.verification->>'mimeType'=r.mime_type
  and r.verification->'byteLength'=to_jsonb(r.byte_length),false)
$$;

create function fluid_private.stage_logo_vector_publication(p_job uuid,p_lease uuid,p_evidence jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.jobs;q public.logo_cost_quotes;d public.logo_asset_publications;s public.logo_asset_publications;g fluid_private.logo_vector_publications;v jsonb;source_preview jsonb;
begin
 perform 1 from public.projects where id=(select project_id from public.jobs where id=p_job and owner_id=fluid_private.logo_worker_owner()) for update;
 j:=fluid_private.logo_lock_job(p_job,p_lease);
 if j.operation<>'identity.logo_vectorize' or j.state<>'running' then raise exception 'logo_vector_publication_unavailable' using errcode='55000';end if;
 if not coalesce(fluid_private.standalone_keys(p_evidence,array['documentPublicationId','svgPublicationId','documentHash','proof']),false)
  or not coalesce(fluid_private.logo_uuid(p_evidence->'documentPublicationId'),false) or not coalesce(fluid_private.logo_uuid(p_evidence->'svgPublicationId'),false)
  or not fluid_private.logo_vector_proof_valid(p_evidence->'proof') or p_evidence->'documentHash' is distinct from p_evidence#>'{proof,documentHash}' then raise exception 'invalid_logo_vector_proof' using errcode='22023';end if;
 select * into q from public.logo_cost_quotes where id=(j.input->>'quoteId')::uuid and owner_id=j.owner_id and project_id=j.project_id and record->>'inputHash'=j.input_hash;
 if not found or q.source_inputs#>'{raster,source}' is distinct from j.input->'source' or q.record#>'{request,settings}' is distinct from j.input->'settings'
  or (q.record->'engine')-'settingsHash' is distinct from j.input->'engine' then raise exception 'logo_vector_source_mismatch' using errcode='55000';end if;
 source_preview:=q.source_inputs#>'{raster,preview,reference}';
 if not exists(select 1 from public.logo_asset_publications r where r.owner_id=j.owner_id and r.project_id=j.project_id and r.state='committed' and fluid_private.logo_asset_reservation(r)->'reference'=source_preview)
  or not fluid_private.logo_job_can_read_asset(j,source_preview) then raise exception 'logo_vector_source_not_found' using errcode='P0002';end if;
 select * into d from public.logo_asset_publications where id=(p_evidence->>'documentPublicationId')::uuid for update;
 select * into s from public.logo_asset_publications where id=(p_evidence->>'svgPublicationId')::uuid for update;
 if not fluid_private.logo_vector_member_valid(d,j.owner_id,j.project_id,j.id,q.input_revisions,'application/json',p_evidence->>'documentHash')
  or not fluid_private.logo_vector_member_valid(s,j.owner_id,j.project_id,j.id,q.input_revisions,'image/svg+xml',p_evidence#>>'{proof,svgContentHash}')
  or d.id=s.id or d.asset_id=s.asset_id or d.version_id=s.version_id or d.job_id is distinct from j.id or s.job_id is distinct from j.id or d.lease_token is distinct from j.lease_token or s.lease_token is distinct from j.lease_token
  then raise exception 'invalid_logo_vector_members' using errcode='55000';end if;
 select * into g from fluid_private.logo_vector_publications where job_id=j.id;
 if found then
  if g.evidence is distinct from p_evidence or g.lease_token is distinct from j.lease_token then raise exception 'logo_vector_publication_conflict' using errcode='PT409';end if;
  return fluid_private.logo_asset_receipt(s);
 end if;
 v:=jsonb_build_object('id',gen_random_uuid(),'ownerId',j.owner_id,'projectId',j.project_id,'parentRevisionId',null,'source',j.input->'source',
  'sourcePreview',source_preview,'documentAsset',fluid_private.logo_asset_reservation(d)->'reference','svgAsset',fluid_private.logo_asset_reservation(s)->'reference',
  'documentHash',p_evidence->'documentHash','proof',p_evidence->'proof','locks','[]'::jsonb,'inputRevisions',q.input_revisions,'reviewStatus','review_required',
  'createdAt',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
 insert into fluid_private.logo_vector_publications(id,document_publication_id,owner_id,project_id,job_id,lease_token,evidence,record,engine)
  values(s.id,d.id,j.owner_id,j.project_id,j.id,j.lease_token,p_evidence,v,j.input->'engine');
 return fluid_private.logo_asset_receipt(s);
end $$;

create function fluid_private.logo_commit_vector_publication(p_job public.jobs,p_publication uuid) returns jsonb language plpgsql set search_path='' as $$
declare j public.jobs;g fluid_private.logo_vector_publications;d public.logo_asset_publications;s public.logo_asset_publications;q public.logo_cost_quotes;receipt jsonb;workspace jsonb;payload jsonb;
begin
 j:=fluid_private.logo_lock_job(p_job.id,p_job.lease_token);
 if j.owner_id is distinct from p_job.owner_id or j.project_id is distinct from p_job.project_id or j.operation<>'identity.logo_vectorize' then raise exception 'logo_vector_publication_unavailable' using errcode='55000';end if;
 select * into g from fluid_private.logo_vector_publications where id=p_publication and job_id=j.id and owner_id=j.owner_id and project_id=j.project_id and lease_token=j.lease_token for update;
 if not found then raise exception 'logo_vector_publication_not_found' using errcode='P0002';end if;
 select * into q from public.logo_cost_quotes where id=(j.input->>'quoteId')::uuid and owner_id=j.owner_id and project_id=j.project_id and record->>'inputHash'=j.input_hash;
 select * into d from public.logo_asset_publications where id=g.document_publication_id for update;
 select * into s from public.logo_asset_publications where id=g.id for update;
 if q.id is null or g.engine is distinct from j.input->'engine' or g.record->'inputRevisions' is distinct from q.input_revisions
  or not fluid_private.logo_vector_member_valid(d,j.owner_id,j.project_id,j.id,q.input_revisions,'application/json',g.record->>'documentHash')
  or not fluid_private.logo_vector_member_valid(s,j.owner_id,j.project_id,j.id,q.input_revisions,'image/svg+xml',g.record#>>'{proof,svgContentHash}')
  or d.job_id is distinct from j.id or s.job_id is distinct from j.id or d.lease_token is distinct from j.lease_token or s.lease_token is distinct from j.lease_token
  or fluid_private.logo_asset_reservation(d)->'reference' is distinct from g.record->'documentAsset' or fluid_private.logo_asset_reservation(s)->'reference' is distinct from g.record->'svgAsset'
  then raise exception 'invalid_logo_vector_members' using errcode='55000';end if;
 if g.state='committed' then return fluid_private.logo_asset_receipt(s);end if;
 perform fluid_private.commit_logo_asset_publication(j,d.id);
 receipt:=fluid_private.commit_logo_asset_publication(j,s.id);
 insert into public.logo_vector_revisions(id,owner_id,project_id,record) values((g.record->>'id')::uuid,j.owner_id,j.project_id,g.record);
 update fluid_private.logo_vector_publications set state='committed' where id=g.id;
 workspace:=fluid_private.logo_workspace_json(j.owner_id,j.project_id);
 -- Changed heads and an existing locked vector retain this result off-head.
 -- A converter has no component-preserving base mapping and cannot erase the
 -- authoritative lock basis merely by publishing a new lockless candidate.
 if j.state='running' and workspace->'heads'=q.record->'expected'
  and not exists(select 1 from public.logo_vector_revisions r where r.owner_id=j.owner_id and r.project_id=j.project_id and r.id=fluid_private.logo_current_vector_id(j.owner_id,j.project_id) and coalesce(jsonb_array_length(r.record->'locks'),1)>0) then
  if workspace->'approvedLogo'='null'::jsonb then
   perform fluid_private.logo_append_stage(j.owner_id,j.project_id,'vector',jsonb_build_object('vectorRevisionId',g.record->'id','approvalId',null),q.input_revisions);
  else
   select r.record->'payload' into payload from public.logo_stage_heads h join public.logo_stage_revisions r on r.id=h.revision_id and r.owner_id=h.owner_id and r.project_id=h.project_id where h.owner_id=j.owner_id and h.project_id=j.project_id and h.stage='refinements';
   payload:=jsonb_build_object('rasterRevisionIds',coalesce(payload->'rasterRevisionIds','[]'::jsonb),'vectorRevisionId',g.record->'id','approvalId',null,'sourceRequestKey',j.input->'requestKey');
   perform fluid_private.logo_append_stage(j.owner_id,j.project_id,'refinements',payload,q.input_revisions);
  end if;
 end if;
 return receipt;
end $$;

create function fluid_private.logo_vector_locks_valid(p jsonb) returns boolean language plpgsql immutable set search_path='' as $$
declare item jsonb;key text;
begin
 if jsonb_typeof(p) is distinct from 'array' or jsonb_array_length(p)>64 then return false;end if;
 for item in select value from jsonb_array_elements(p) loop
  if not coalesce(fluid_private.standalone_keys(item,array['componentId','geometryHash','appearanceHash','transformHash','textHash','zOrderHash','effectiveHash']),false)
   or jsonb_typeof(item->'componentId') is distinct from 'string' or item->>'componentId'!~'^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$' then return false;end if;
  foreach key in array array['geometryHash','appearanceHash','transformHash','textHash','zOrderHash','effectiveHash'] loop
   if jsonb_typeof(item->key) is distinct from 'string' or item->>key!~'^[0-9a-f]{64}$' then return false;end if;
  end loop;
 end loop;
 return (select count(*)=count(distinct value->>'componentId') from jsonb_array_elements(p));
exception when others then return false;
end $$;

create function fluid_private.commit_logo_vector_edit(p_owner uuid,p_project uuid,p_command jsonb,p_evidence jsonb) returns jsonb language plpgsql set search_path='' as $$
declare base jsonb;current_id uuid;d public.logo_asset_publications;s public.logo_asset_publications;b jsonb:=p_command->'body';v jsonb;payload jsonb;revision jsonb;ids jsonb;
begin
 if fluid_private.logo_asset_web_owner() is distinct from p_owner then raise exception 'logo_principal_mismatch' using errcode='42501';end if;
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

-- Scrub every inherited/default grant on these exact new objects, not only the
-- well-known API roles. Hostile default ACLs (including TRUNCATE/grant options)
-- must not expose staged groups or trusted publisher entrypoints.
create function fluid_private.read_leased_logo_vector_revision(p_job uuid,p_lease uuid,p_vector uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.jobs;q public.logo_cost_quotes;frozen jsonb;result jsonb;
begin
 j:=fluid_private.logo_lock_job(p_job,p_lease);
 select * into q from public.logo_cost_quotes where id=(j.input->>'quoteId')::uuid and owner_id=j.owner_id and project_id=j.project_id and record->>'inputHash'=j.input_hash;
 if j.operation='identity.logo_directions' then
  frozen:=q.source_inputs#>'{direction,logoRevision}';
  if q.source_inputs#>>'{direction,approvedLogo,id}' is distinct from j.input->>'approvedLogoId'
   or not exists(select 1 from public.logo_approvals a where a.id::text=j.input->>'approvedLogoId' and a.owner_id=j.owner_id and a.project_id=j.project_id and a.vector_revision_id=p_vector and a.record=q.source_inputs#>'{direction,approvedLogo}') then raise exception 'logo_unlisted_vector' using errcode='P0002';end if;
 elsif j.operation='identity.logo_refine' and j.input#>>'{source,kind}'='vector' and j.input#>>'{source,vectorRevisionId}'=p_vector::text then
  -- This source has no enabled quote path yet. Missing frozen source fails
  -- closed; no reader activates provider refinement or widens blob access.
  frozen:=q.source_inputs#>'{vector,revision}';
 else raise exception 'logo_unlisted_vector' using errcode='P0002';end if;
 select record into result from public.logo_vector_revisions where id=p_vector and owner_id=j.owner_id and project_id=j.project_id;
 if result is null or result is distinct from frozen then raise exception 'logo_unlisted_vector' using errcode='P0002';end if;
 return result;
end $$;

do $$declare grant_row record;signature text;begin
 for grant_row in select distinct a.grantee from pg_class c cross join lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a where c.oid='fluid_private.logo_vector_publications'::regclass and a.grantee<>c.relowner loop
  execute format('revoke all on table fluid_private.logo_vector_publications from %s cascade',case when grant_row.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(grant_row.grantee)) end);
 end loop;
 foreach signature in array array['fluid_private.logo_vector_proof_valid(jsonb)','fluid_private.logo_vector_member_valid(public.logo_asset_publications,uuid,uuid,uuid,jsonb,text,text)','fluid_private.stage_logo_vector_publication(uuid,uuid,jsonb)','fluid_private.logo_commit_vector_publication(public.jobs,uuid)','fluid_private.logo_vector_locks_valid(jsonb)','fluid_private.commit_logo_vector_edit(uuid,uuid,jsonb,jsonb)','fluid_private.read_leased_logo_vector_revision(uuid,uuid,uuid)'] loop
  for grant_row in select distinct a.grantee from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where p.oid=to_regprocedure(signature) and a.grantee<>p.proowner loop
   execute format('revoke all on function %s from %s cascade',signature,case when grant_row.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(grant_row.grantee)) end);
  end loop;
 end loop;
end $$;
commit;
