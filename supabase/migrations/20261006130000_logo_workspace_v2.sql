-- NEW local candidate: six-stage V2 manual persistence. No role, provider, source
-- admission, or hosted activation. Reviewed inventory: task3-evidence/sql-inventory-manual.md.
begin;
do $$
declare name text; signature text;
begin
 foreach name in array array['logo_workspaces','logo_stage_revisions','logo_stage_heads','logo_reference_sources','logo_reference_snapshots','logo_workspace_requests','logo_workspace_requests_creation_key','logo_workspace_requests_manual_key','logo_workspace_requests_owner_created','logo_stage_revisions_history'] loop
  if to_regclass('public.'||name) is not null then raise exception 'logo_object_collision: %',name using errcode='42710'; end if;
 end loop;
 foreach signature in array array[
  'fluid_private.logo_uuid(jsonb)','fluid_private.logo_brief_valid(jsonb)','fluid_private.logo_command_valid(jsonb)',
  'fluid_private.logo_workspace_json(uuid,uuid)','fluid_private.logo_snapshot_json(uuid,uuid,uuid)',
  'fluid_private.logo_append_brief(uuid,uuid,jsonb,uuid,jsonb)','fluid_private.logo_apply(uuid,uuid,jsonb)',
  'public.start_logo_project(jsonb)','public.read_logo_project_creation(uuid)','public.list_logo_project_creations(jsonb)',
  'public.get_logo_workspace(uuid)','public.read_logo_workspace_record(uuid,text,uuid)',
  'public.list_logo_workspace_records(uuid,text,jsonb)','public.apply_logo_workspace_command(uuid,jsonb)'] loop
  if to_regprocedure(signature) is not null then raise exception 'logo_function_collision: %',signature using errcode='42710'; end if;
 end loop;
 if to_regprocedure('fluid_private.standalone_keys(jsonb,text[])') is null
  or to_regprocedure('fluid_private.idea_trim(text)') is null
  or to_regprocedure('fluid_private.standalone_timestamp(jsonb)') is null
  or to_regprocedure('fluid_private.prevent_history_change()') is null then
  raise exception 'logo_prerequisite_missing' using errcode='55000';
 end if;
end $$;

create function fluid_private.logo_uuid(v jsonb) returns boolean language sql immutable set search_path='' as $$
 select coalesce(jsonb_typeof(v)='string' and (v#>>'{}') ~ '^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$',false)
$$;
create function fluid_private.logo_brief_valid(v jsonb) returns boolean language plpgsql immutable set search_path='' as $$
declare k text; item jsonb;
begin
 if not fluid_private.standalone_keys(v,array['name','activity','audience','personality','logoTypes']) or octet_length(v::text)>32768 then return false; end if;
 foreach k in array array['name','activity','audience','personality'] loop
  -- Installed Zod 4.6.5 string min/max count Unicode code points. Do not trim saved spelling.
  if jsonb_typeof(v->k) is distinct from 'string' or length(v->>k)>(case when k='name' then 200 else 4000 end) then return false; end if;
 end loop;
 if fluid_private.idea_trim(v->>'name')='' or jsonb_typeof(v->'logoTypes') is distinct from 'array' then return false; end if;
 if jsonb_array_length(v->'logoTypes') not between 1 and 7 or (select count(*)<>count(distinct value) from jsonb_array_elements(v->'logoTypes')) then return false; end if;
 for item in select value from jsonb_array_elements(v->'logoTypes') loop
  if jsonb_typeof(item) is distinct from 'string' or (item#>>'{}') not in ('wordmark','lettermark_monogram','pictorial','abstract','combination','emblem','mascot') then return false; end if;
 end loop;
 return true;
exception when others then return false;
end $$;
create function fluid_private.logo_command_valid(v jsonb) returns boolean language plpgsql immutable set search_path='' as $$
declare b jsonb; e jsonb; item jsonb; aspect jsonb; k text; n numeric;
begin
 if not fluid_private.standalone_keys(v,array['method','body']) or octet_length(v::text)>32768 then return false; end if;
 b:=v->'body'; e:=b->'expected';
 if not fluid_private.logo_uuid(b->'requestKey') or not fluid_private.standalone_keys(e,array['projectRevision','referenceRevision','preferencesRevision','workspaceRevision','stageRevisions'])
  or not fluid_private.standalone_keys(e->'stageRevisions',array['brief_references','concepts','vector','refinements','directions','deliverables']) then return false; end if;
 for k,item in select key,value from jsonb_each(e-'stageRevisions') union all select key,value from jsonb_each(e->'stageRevisions') loop
  if jsonb_typeof(item) is distinct from 'number' then return false; end if;
  n:=(item#>>'{}')::numeric;
  if n<>trunc(n) or n<(case when k='projectRevision' then 1 else 0 end) or n>9007199254740991 then return false; end if;
 end loop;
 case v->>'method'
 when 'saveLogoBrief' then
  return fluid_private.standalone_keys(b,array['requestKey','expected','brief']) and fluid_private.logo_brief_valid(b->'brief');
 when 'saveLogoReferences' then
  if not fluid_private.standalone_keys(b,array['requestKey','expected','selections']) or jsonb_typeof(b->'selections') is distinct from 'array' then return false; end if;
  if jsonb_array_length(b->'selections')>100 or (select count(*)<>count(distinct value->>'referenceId') from jsonb_array_elements(b->'selections')) then return false; end if;
  for item in select value from jsonb_array_elements(b->'selections') loop
   if not fluid_private.standalone_keys(item,array['referenceId','aspects']) or not fluid_private.logo_uuid(item->'referenceId') or jsonb_typeof(item->'aspects') is distinct from 'array' then return false; end if;
   if jsonb_array_length(item->'aspects') not between 1 and 4 or (select count(*)<>count(distinct value) from jsonb_array_elements(item->'aspects')) then return false; end if;
   for aspect in select value from jsonb_array_elements(item->'aspects') loop
    if jsonb_typeof(aspect) is distinct from 'string' or (aspect#>>'{}') not in ('lettering','shape','composition','overall_feel') then return false; end if;
   end loop;
  end loop;
  return true;
 when 'restoreLogoStage' then
  return fluid_private.standalone_keys(b,array['requestKey','expected','stage','revisionId','acceptEarlierBasis'])
   and b->>'stage' in ('brief_references','concepts','vector','refinements','directions','deliverables')
   and fluid_private.logo_uuid(b->'revisionId') and jsonb_typeof(b->'acceptEarlierBasis')='boolean';
 else return false;
 end case;
exception when others then return false;
end $$;

create table public.logo_workspaces (
 project_id uuid primary key, owner_id uuid not null, revision bigint not null default 0 check(revision between 0 and 9007199254740991),
 unique(project_id,owner_id), foreign key(project_id,owner_id) references public.projects(id,owner_id)
);
create table public.logo_reference_sources (
 reference_id uuid primary key, project_id uuid not null, owner_id uuid not null, asset_id uuid not null, version_id uuid not null,
 content_hash text not null check(content_hash ~ '^[0-9a-f]{64}$'), source_kind text not null check(source_kind in ('curated','upload')), rights_evidence_id uuid not null,
 unique(reference_id,project_id,owner_id), foreign key(project_id,owner_id) references public.projects(id,owner_id),
 foreign key(version_id,asset_id,project_id,owner_id) references public.asset_versions(id,asset_id,project_id,owner_id)
);
create table public.logo_reference_snapshots (
 id uuid primary key, project_id uuid not null, owner_id uuid not null, revision bigint not null check(revision between 1 and 9007199254740991), snapshot jsonb not null,
 unique(id,project_id,owner_id), unique(project_id,owner_id,revision), foreign key(project_id,owner_id) references public.projects(id,owner_id),
 check((fluid_private.standalone_keys(snapshot,array['version','id','ownerId','projectId','revision','references']) and snapshot->'version'='2'::jsonb
  and snapshot->>'id'=id::text and snapshot->>'ownerId'=owner_id::text and snapshot->>'projectId'=project_id::text and snapshot->'revision'=to_jsonb(revision)
  and jsonb_typeof(snapshot->'references')='array' and jsonb_array_length(snapshot->'references')<=100 and octet_length(snapshot::text)<=65536) is true)
);
create table public.logo_stage_revisions (
 id uuid primary key, project_id uuid not null, owner_id uuid not null, stage text not null check(stage in ('brief_references','concepts','vector','refinements','directions','deliverables')),
 revision bigint not null check(revision between 1 and 9007199254740991), parent_revision_id uuid, reference_snapshot_id uuid, record jsonb not null,
 unique(id,project_id,owner_id,stage), unique(project_id,owner_id,stage,revision), foreign key(project_id,owner_id) references public.projects(id,owner_id),
 foreign key(parent_revision_id,project_id,owner_id,stage) references public.logo_stage_revisions(id,project_id,owner_id,stage),
 foreign key(reference_snapshot_id,project_id,owner_id) references public.logo_reference_snapshots(id,project_id,owner_id),
 check((revision=1)=(parent_revision_id is null)),
 check((fluid_private.standalone_keys(record,array['version','id','ownerId','projectId','stage','revision','parentRevisionId','inputRevisions','inputHash','payload','createdAt'])
  and record->'version'='2'::jsonb and record->>'id'=id::text and record->>'ownerId'=owner_id::text and record->>'projectId'=project_id::text and record->>'stage'=stage
  and record->'revision'=to_jsonb(revision) and record->'parentRevisionId'=coalesce(to_jsonb(parent_revision_id),'null'::jsonb)
  and jsonb_typeof(record->'inputRevisions')='array' and jsonb_array_length(record->'inputRevisions')<=100
  and record->>'inputHash' ~ '^[0-9a-f]{64}$' and fluid_private.standalone_timestamp(record->'createdAt') and length(record->>'createdAt')<=64
  and octet_length(record::text)<=32768) is true),
 check(stage<>'brief_references' or (reference_snapshot_id is not null and record#>>'{payload,referenceSnapshotId}'=reference_snapshot_id::text
  and fluid_private.logo_brief_valid((record->'payload')-array['referenceSnapshotId','sourceProjectRevision'])) is true)
);
create table public.logo_stage_heads (
 project_id uuid not null, owner_id uuid not null, stage text not null, revision_id uuid not null, primary key(project_id,stage),
 foreign key(project_id,owner_id) references public.logo_workspaces(project_id,owner_id),
 foreign key(revision_id,project_id,owner_id,stage) references public.logo_stage_revisions(id,project_id,owner_id,stage)
);
create table public.logo_workspace_requests (
 id uuid primary key default gen_random_uuid(), project_id uuid not null, owner_id uuid not null, request_key uuid not null,
 method text not null check(method in ('startLogoProject','saveLogoBrief','saveLogoReferences','restoreLogoStage')), input jsonb not null, receipt jsonb not null,
 created_at timestamptz not null default clock_timestamp() check(isfinite(created_at)), foreign key(project_id,owner_id) references public.projects(id,owner_id),
 check(jsonb_typeof(input)='object' and octet_length(input::text)<=32768 and jsonb_typeof(receipt)='object' and octet_length(receipt::text)<=65536)
);
create unique index logo_workspace_requests_creation_key on public.logo_workspace_requests(owner_id,request_key) where method='startLogoProject';
create unique index logo_workspace_requests_manual_key on public.logo_workspace_requests(owner_id,project_id,request_key) where method<>'startLogoProject';
create index logo_workspace_requests_owner_created on public.logo_workspace_requests(owner_id,created_at desc,id desc);
create index logo_stage_revisions_history on public.logo_stage_revisions(owner_id,project_id,stage,revision desc);
create trigger logo_stage_revisions_immutable before update or delete on public.logo_stage_revisions for each row execute function fluid_private.prevent_history_change();
create trigger logo_reference_sources_immutable before update or delete on public.logo_reference_sources for each row execute function fluid_private.prevent_history_change();
create trigger logo_reference_snapshots_immutable before update or delete on public.logo_reference_snapshots for each row execute function fluid_private.prevent_history_change();
create trigger logo_workspace_requests_immutable before update or delete on public.logo_workspace_requests for each row execute function fluid_private.prevent_history_change();

create function fluid_private.logo_snapshot_json(p_owner uuid,p_project uuid,p_id uuid) returns jsonb language plpgsql stable set search_path='' as $$
declare result jsonb; item jsonb; actual jsonb;
begin
 select snapshot into result from public.logo_reference_snapshots where id=p_id and project_id=p_project and owner_id=p_owner;
 if not found then raise exception 'logo_snapshot_not_found' using errcode='P0002'; end if;
 for item in select value from jsonb_array_elements(result->'references') loop
  select jsonb_build_object('referenceId',s.reference_id,'asset',jsonb_build_object('ownerId',s.owner_id,'projectId',s.project_id,'assetId',s.asset_id,'versionId',s.version_id,'contentHash',v.content_hash),
   'sourceKind',s.source_kind,'rightsEvidenceId',s.rights_evidence_id,'aspects',item->'aspects') into actual
  from public.logo_reference_sources s join public.asset_versions v on v.id=s.version_id and v.asset_id=s.asset_id and v.owner_id=s.owner_id and v.project_id=s.project_id
  join public.assets a on a.id=s.asset_id and a.owner_id=s.owner_id and a.project_id=s.project_id
  where s.reference_id=(item->>'referenceId')::uuid and s.owner_id=p_owner and s.project_id=p_project and s.content_hash=v.content_hash and a.purpose='reference_media';
  if actual is distinct from item then raise exception 'logo_reference_source_unavailable' using errcode='55000'; end if;
 end loop;
 return result;
end $$;
create function fluid_private.logo_workspace_json(p_owner uuid,p_project uuid) returns jsonb language plpgsql stable set search_path='' as $$
declare project public.projects; w bigint; rr bigint; pr bigint; s text; row public.logo_stage_revisions; stages jsonb:='{}'; revisions jsonb:='{}'; stale jsonb:='[]'; reasons jsonb;
begin
 select * into project from public.projects where id=p_project and owner_id=p_owner;
 if not found then raise exception 'logo_project_not_found' using errcode='P0002'; end if;
 select revision into w from public.logo_workspaces where project_id=p_project and owner_id=p_owner;
 select reference_revision into rr from public.identity_reference_heads where project_id=p_project and owner_id=p_owner;
 select current_preferences_revision into pr from public.identity_sessions where project_id=p_project and owner_id=p_owner;
 foreach s in array array['brief_references','concepts','vector','refinements','directions','deliverables'] loop
  select r.* into row from public.logo_stage_heads h join public.logo_stage_revisions r on r.id=h.revision_id and r.owner_id=h.owner_id and r.project_id=h.project_id and r.stage=h.stage
   where h.project_id=p_project and h.owner_id=p_owner and h.stage=s;
  stages:=stages||jsonb_build_object(s,case when row.id is null then null else jsonb_build_object('stage',s,'id',row.id,'revision',row.revision) end);
  revisions:=revisions||jsonb_build_object(s,coalesce(row.revision,0));
  if row.id is not null then
   reasons:='[]';
   if s='brief_references' and (row.record#>>'{payload,sourceProjectRevision}')::bigint<>project.current_revision then reasons:=reasons||'"project_revision_changed"'::jsonb; end if;
   if exists(select 1 from jsonb_array_elements(row.record->'inputRevisions') i left join public.logo_stage_heads h on h.owner_id=p_owner and h.project_id=p_project and h.stage=i->>'stage'
    left join public.logo_stage_revisions r on r.id=h.revision_id and r.owner_id=p_owner and r.project_id=p_project
    where r.id is null or r.id::text<>i->>'id' or r.revision<>(i->>'revision')::bigint) then reasons:=reasons||'"input_revision_changed"'::jsonb; end if;
   if jsonb_array_length(reasons)>0 then stale:=stale||jsonb_build_array(jsonb_build_object('stage',s,'reasons',reasons)); end if;
  end if;
 end loop;
 return jsonb_build_object('version',2,'ownerId',p_owner,'projectId',p_project,'heads',jsonb_build_object('projectRevision',project.current_revision,'referenceRevision',coalesce(rr,0),'preferencesRevision',coalesce(pr,0),'workspaceRevision',coalesce(w,0),'stageRevisions',revisions),
  'stages',stages,'approvedLogo',null,'staleStages',stale,'capabilities',jsonb_build_object('save',jsonb_build_object('status','available'),'upload',jsonb_build_object('status','unavailable','reason','logo_upload_unavailable'),
   'generate',jsonb_build_object('status','unavailable','reason','logo_pipeline_unavailable'),'convert',jsonb_build_object('status','unavailable','reason','logo_pipeline_unavailable'),'export',jsonb_build_object('status','unavailable','reason','logo_pipeline_unavailable')));
end $$;
create function fluid_private.logo_append_brief(p_owner uuid,p_project uuid,p_brief jsonb,p_snapshot uuid,p_inputs jsonb) returns jsonb language plpgsql set search_path='' as $$
declare prior public.logo_stage_revisions; project_revision bigint; new_id uuid:=gen_random_uuid(); result jsonb; payload jsonb; item jsonb;
begin
 if not fluid_private.logo_brief_valid(p_brief-'sourceProjectRevision') or jsonb_typeof(p_inputs) is distinct from 'array' or jsonb_array_length(p_inputs)>100 then raise exception 'invalid_logo_brief' using errcode='22023'; end if;
 select current_revision into project_revision from public.projects where id=p_project and owner_id=p_owner;
 if not found then raise exception 'logo_project_not_found' using errcode='P0002'; end if;
 perform fluid_private.logo_snapshot_json(p_owner,p_project,p_snapshot);
 for item in select value from jsonb_array_elements(p_inputs) loop
  if not fluid_private.standalone_keys(item,array['stage','id','revision']) or not exists(select 1 from public.logo_stage_revisions r where r.id=(item->>'id')::uuid and r.owner_id=p_owner and r.project_id=p_project and r.stage=item->>'stage' and r.revision=(item->>'revision')::bigint) then
   raise exception 'invalid_logo_input_source' using errcode='55000'; end if;
 end loop;
 if (select count(*)<>count(distinct value->>'id') from jsonb_array_elements(p_inputs)) then raise exception 'duplicate_logo_input' using errcode='55000'; end if;
 select r.* into prior from public.logo_stage_heads h join public.logo_stage_revisions r on r.id=h.revision_id where h.project_id=p_project and h.owner_id=p_owner and h.stage='brief_references';
 -- Only the fixed restore branch supplies this field, copied from its actual
 -- immutable source row; browser brief schemas reject it. Retain earlier basis.
 if p_brief ? 'sourceProjectRevision' then
  if jsonb_typeof(p_brief->'sourceProjectRevision') is distinct from 'number' or not exists(select 1 from public.project_revisions r where r.project_id=p_project and r.owner_id=p_owner and to_jsonb(r.revision)=p_brief->'sourceProjectRevision') then
   raise exception 'invalid_logo_project_source' using errcode='55000'; end if;
  project_revision:=(p_brief->>'sourceProjectRevision')::bigint;
 end if;
 payload:=(p_brief-'sourceProjectRevision')||jsonb_build_object('referenceSnapshotId',p_snapshot,'sourceProjectRevision',project_revision);
 result:=jsonb_build_object('version',2,'id',new_id,'ownerId',p_owner,'projectId',p_project,'stage','brief_references','revision',coalesce(prior.revision,0)+1,'parentRevisionId',prior.id,
  'inputRevisions',p_inputs,'inputHash',encode(sha256(convert_to(jsonb_build_object('payload',payload,'inputs',p_inputs)::text,'UTF8')),'hex'),'payload',payload,
  'createdAt',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
 insert into public.logo_workspaces(project_id,owner_id) values(p_project,p_owner) on conflict(project_id) do nothing;
 insert into public.logo_stage_revisions(id,project_id,owner_id,stage,revision,parent_revision_id,reference_snapshot_id,record)
  values(new_id,p_project,p_owner,'brief_references',coalesce(prior.revision,0)+1,prior.id,p_snapshot,result);
 insert into public.logo_stage_heads(project_id,owner_id,stage,revision_id) values(p_project,p_owner,'brief_references',new_id)
  on conflict(project_id,stage) do update set revision_id=excluded.revision_id;
 update public.logo_workspaces set revision=revision+1 where project_id=p_project and owner_id=p_owner;
 return result;
end $$;
create function fluid_private.logo_apply(p_owner uuid,p_project uuid,p_command jsonb) returns jsonb language plpgsql set search_path='' as $$
declare b jsonb:=p_command->'body'; project public.projects; old public.logo_stage_revisions; target public.logo_stage_revisions; existing public.logo_workspace_requests;
 workspace jsonb; brief jsonb; snapshot_id uuid; snapshot_revision bigint; snapshot jsonb; selections jsonb; selection jsonb; item jsonb; refs jsonb:='[]'; inputs jsonb:='[]'; revision jsonb; result jsonb;
begin
 if not fluid_private.logo_command_valid(p_command) then raise exception 'invalid_logo_command' using errcode='22023'; end if;
 select * into project from public.projects where id=p_project and owner_id=p_owner for update;
 if not found then raise exception 'logo_project_not_found' using errcode='P0002'; end if;
 select * into existing from public.logo_workspace_requests where project_id=p_project and owner_id=p_owner and request_key=(b->>'requestKey')::uuid and method<>'startLogoProject';
 if found then
  if existing.input is distinct from p_command then raise exception 'logo_request_conflict' using errcode='PT409'; end if;
  return existing.receipt;
 end if;
 -- Existing source writers use the same project-first lock. Read their real heads.
 perform 1 from public.identity_reference_heads where project_id=p_project and owner_id=p_owner for update;
 perform 1 from public.identity_sessions where project_id=p_project and owner_id=p_owner for update;
 workspace:=fluid_private.logo_workspace_json(p_owner,p_project);
 if workspace->'heads' is distinct from b->'expected' then raise exception 'logo_head_conflict' using errcode='PT409'; end if;
 select r.* into old from public.logo_stage_heads h join public.logo_stage_revisions r on r.id=h.revision_id where h.project_id=p_project and h.owner_id=p_owner and h.stage='brief_references';
 if p_command->>'method'='restoreLogoStage' then
  if b->>'stage'<>'brief_references' then raise exception 'logo_producer_unavailable' using errcode='55000'; end if;
  select * into target from public.logo_stage_revisions where id=(b->>'revisionId')::uuid and owner_id=p_owner and project_id=p_project and stage='brief_references';
  if not found then raise exception 'logo_revision_not_found' using errcode='P0002'; end if;
  if ((target.record#>>'{payload,sourceProjectRevision}')::bigint<>project.current_revision
    or exists(select 1 from jsonb_array_elements(target.record->'inputRevisions') i left join public.logo_stage_heads h on h.project_id=p_project and h.owner_id=p_owner and h.stage=i->>'stage' where h.revision_id is distinct from (i->>'id')::uuid))
   and b->'acceptEarlierBasis'<>'true'::jsonb then raise exception 'logo_earlier_basis_requires_acknowledgement' using errcode='PT409'; end if;
  brief:=(target.record->'payload')-'referenceSnapshotId'; snapshot_id:=target.reference_snapshot_id;
  -- Brief has no generated inputs. Preserve its original dependency set on restore.
  inputs:=target.record->'inputRevisions';
 elsif p_command->>'method'='saveLogoBrief' then
  brief:=b->'brief'; snapshot_id:=old.reference_snapshot_id;
 else
  if old.id is null then raise exception 'logo_brief_required' using errcode='PT409'; end if;
  brief:=(old.record->'payload')-array['referenceSnapshotId','sourceProjectRevision']; selections:=b->'selections';
  for selection in select value from jsonb_array_elements(selections) loop
   select jsonb_build_object('referenceId',s.reference_id,'asset',jsonb_build_object('ownerId',s.owner_id,'projectId',s.project_id,'assetId',s.asset_id,'versionId',s.version_id,'contentHash',v.content_hash),
    'sourceKind',s.source_kind,'aspects',selection->'aspects','rightsEvidenceId',s.rights_evidence_id) into item
   from public.logo_reference_sources s join public.asset_versions v on v.id=s.version_id and v.asset_id=s.asset_id and v.project_id=s.project_id and v.owner_id=s.owner_id
   join public.assets a on a.id=s.asset_id and a.project_id=s.project_id and a.owner_id=s.owner_id
   where s.reference_id=(selection->>'referenceId')::uuid and s.project_id=p_project and s.owner_id=p_owner and s.content_hash=v.content_hash and a.purpose='reference_media';
   if item is null then raise exception 'logo_reference_source_unavailable' using errcode='P0002'; end if;
   refs:=refs||jsonb_build_array(item);
  end loop;
  snapshot_id:=null;
 end if;
 if snapshot_id is null then
  snapshot_id:=gen_random_uuid();
  select coalesce(max(rs.revision),0)+1 into snapshot_revision from public.logo_reference_snapshots rs where rs.project_id=p_project and rs.owner_id=p_owner;
  snapshot:=jsonb_build_object('version',2,'id',snapshot_id,'ownerId',p_owner,'projectId',p_project,'revision',snapshot_revision,'references',refs);
  insert into public.logo_reference_snapshots(id,project_id,owner_id,revision,snapshot) values(snapshot_id,p_project,p_owner,snapshot_revision,snapshot);
 end if;
 revision:=fluid_private.logo_append_brief(p_owner,p_project,brief,snapshot_id,inputs);
 result:=jsonb_build_object('ownerId',p_owner,'projectId',p_project,'requestKey',b->'requestKey','revision',revision,'workspace',fluid_private.logo_workspace_json(p_owner,p_project));
 insert into public.logo_workspace_requests(project_id,owner_id,request_key,method,input,receipt) values(p_project,p_owner,(b->>'requestKey')::uuid,p_command->>'method',p_command,result);
 return result;
end $$;

create function public.start_logo_project(p_input jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare owner uuid:=auth.uid(); existing public.logo_workspace_requests; project public.projects; sid uuid:=gen_random_uuid(); snapshot jsonb; revision jsonb; workspace jsonb; context jsonb;
begin
 if owner is null then raise exception 'unauthenticated' using errcode='42501'; end if;
 if not fluid_private.standalone_keys(p_input,array['requestKey','brief']) or not fluid_private.logo_uuid(p_input->'requestKey') or not fluid_private.logo_brief_valid(p_input->'brief') or octet_length(p_input::text)>32768 then raise exception 'invalid_logo_creation' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtextextended('logo-create:'||owner::text||':'||(p_input->>'requestKey'),0));
 select * into existing from public.logo_workspace_requests where owner_id=owner and request_key=(p_input->>'requestKey')::uuid and method='startLogoProject';
 if found then
  if existing.input is distinct from p_input then raise exception 'logo_creation_conflict' using errcode='PT409'; end if;
  return existing.receipt;
 end if;
 -- Brief is authoritative in its own stage; do not truncate it into shorter Strategy fields.
 context:=jsonb_build_object('description','','activity','','offering','','knownAudience','','reformulationConfirmed',false,'audienceSegments','[]'::jsonb,'competitors','[]'::jsonb,'competitorReviewComplete',false,'personality',null,'positioning','','selectedName',null,'creativeLocale','en',
  'intake',jsonb_build_object('suppliedName','','namingNotes','','identityNotes','','step','review','audienceReviewedAt',null,'personalityReviewedAt',null,'positioningReviewedAt',null,'example',false));
 -- AccountProjectSummary titles cap at 160 code points. Keep every byte of
 -- the approved brand name in the brief; long names use a neutral project label.
 project:=public.create_project('visual_identity_only',case when length(fluid_private.idea_trim(p_input#>>'{brief,name}'))<=160 then fluid_private.idea_trim(p_input#>>'{brief,name}') else 'Visual identity' end,context,encode(sha256(convert_to(context::text,'UTF8')),'hex'));
 snapshot:=jsonb_build_object('version',2,'id',sid,'ownerId',owner,'projectId',project.id,'revision',1,'references','[]'::jsonb);
 insert into public.logo_reference_snapshots(id,project_id,owner_id,revision,snapshot) values(sid,project.id,owner,1,snapshot);
 revision:=fluid_private.logo_append_brief(owner,project.id,p_input->'brief',sid,'[]'::jsonb);
 workspace:=fluid_private.logo_workspace_json(owner,project.id);
 insert into public.logo_workspace_requests(project_id,owner_id,request_key,method,input,receipt) values(project.id,owner,(p_input->>'requestKey')::uuid,'startLogoProject',p_input,workspace);
 return workspace;
end $$;
create function public.read_logo_project_creation(p_request_key uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare owner uuid:=auth.uid(); row public.logo_workspace_requests;
begin
 if owner is null then raise exception 'unauthenticated' using errcode='42501'; end if;
 select * into row from public.logo_workspace_requests where owner_id=owner and request_key=p_request_key and method='startLogoProject';
 if not found then return jsonb_build_object('status','not_found'); end if;
 return jsonb_build_object('status','succeeded','requestKey',row.request_key,'projectId',row.project_id,'workspace',row.receipt);
end $$;
create function public.list_logo_project_creations(p_query jsonb) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare owner uuid:=auth.uid(); n integer; cursor_row public.logo_workspace_requests; row public.logo_workspace_requests; items jsonb:='[]'; next_cursor text; seen integer:=0;
begin
 if owner is null then raise exception 'unauthenticated' using errcode='42501'; end if;
 if jsonb_typeof(p_query) is distinct from 'object' or p_query-array['cursor','limit']<>'{}' or octet_length(p_query::text)>32768 then raise exception 'invalid_logo_query' using errcode='22023'; end if;
 if p_query ? 'limit' and (jsonb_typeof(p_query->'limit') is distinct from 'number' or (p_query->>'limit')::numeric<>trunc((p_query->>'limit')::numeric) or (p_query->>'limit')::numeric not between 1 and 50) then raise exception 'invalid_logo_limit' using errcode='22023'; end if;
 n:=coalesce((p_query->>'limit')::integer,20);
 if p_query ? 'cursor' then
  if not fluid_private.logo_uuid(p_query->'cursor') then raise exception 'invalid_logo_cursor' using errcode='22023'; end if;
  select * into cursor_row from public.logo_workspace_requests where id=(p_query->>'cursor')::uuid and owner_id=owner and method='startLogoProject';
  if not found then raise exception 'invalid_logo_cursor' using errcode='22023'; end if;
 end if;
 for row in select * from public.logo_workspace_requests where owner_id=owner and method='startLogoProject' and (cursor_row.id is null or (created_at,id)<(cursor_row.created_at,cursor_row.id)) order by created_at desc,id desc limit n+1 loop
  seen:=seen+1;
  if seen>n then return jsonb_build_object('ownerId',owner,'items',items,'nextCursor',next_cursor); end if;
  items:=items||jsonb_build_array(jsonb_build_object('requestKey',row.request_key,'projectId',row.project_id,'brief',row.input->'brief','createdAt',to_char(row.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')));
  next_cursor:=row.id::text;
 end loop;
 return jsonb_build_object('ownerId',owner,'items',items,'nextCursor',null);
end $$;
create function public.get_logo_workspace(p_project_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if auth.uid() is null then raise exception 'unauthenticated' using errcode='42501'; end if;
 return fluid_private.logo_workspace_json(auth.uid(),p_project_id);
end $$;
create function public.read_logo_workspace_record(p_project_id uuid,p_kind text,p_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare owner uuid:=auth.uid(); result jsonb;
begin
 if owner is null then raise exception 'unauthenticated' using errcode='42501'; end if;
 if not exists(select 1 from public.projects where id=p_project_id and owner_id=owner) then raise exception 'logo_project_not_found' using errcode='P0002'; end if;
 case p_kind
 when 'stage' then select record into result from public.logo_stage_revisions where id=p_id and project_id=p_project_id and owner_id=owner;
 when 'reference_snapshot' then return fluid_private.logo_snapshot_json(owner,p_project_id,p_id);
 when 'manual_request' then
  select receipt into result from public.logo_workspace_requests where request_key=p_id and project_id=p_project_id and owner_id=owner and method<>'startLogoProject';
  if not found then return jsonb_build_object('status','not_found'); end if;
  return jsonb_build_object('status','succeeded','requestKey',p_id,'receipt',result,'outputs','[]'::jsonb,'billing',jsonb_build_object('status','recorded','confirmedMicrousd',0),'reason',null);
 else raise exception 'invalid_logo_read_kind' using errcode='22023';
 end case;
 if result is null then raise exception 'logo_record_not_found' using errcode='P0002'; end if;
 return result;
end $$;
create function public.list_logo_workspace_records(p_project_id uuid,p_kind text,p_query jsonb) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare owner uuid:=auth.uid(); n integer; cursor_id uuid; cursor_revision bigint; row public.logo_stage_revisions; items jsonb:='[]'; next_cursor jsonb; seen integer:=0;
begin
 if owner is null then raise exception 'unauthenticated' using errcode='42501'; end if;
 if not exists(select 1 from public.projects where id=p_project_id and owner_id=owner) then raise exception 'logo_project_not_found' using errcode='P0002'; end if;
 if p_kind not in ('brief_references','concepts','vector','refinements','directions','deliverables') or jsonb_typeof(p_query) is distinct from 'object' or p_query-array['cursor','limit']<>'{}' or octet_length(p_query::text)>32768 then raise exception 'invalid_logo_query' using errcode='22023'; end if;
 if p_query ? 'limit' and (jsonb_typeof(p_query->'limit') is distinct from 'number' or (p_query->>'limit')::numeric<>trunc((p_query->>'limit')::numeric) or (p_query->>'limit')::numeric not between 1 and 50) then raise exception 'invalid_logo_limit' using errcode='22023'; end if;
 n:=coalesce((p_query->>'limit')::integer,20);
 if p_query ? 'cursor' then
  if not fluid_private.standalone_keys(p_query->'cursor',array['stage','createdAt','id']) or p_query#>>'{cursor,stage}'<>p_kind or not fluid_private.logo_uuid(p_query#>'{cursor,id}') or not fluid_private.standalone_timestamp(p_query#>'{cursor,createdAt}') or length(p_query#>>'{cursor,createdAt}')>64 then raise exception 'invalid_logo_cursor' using errcode='22023'; end if;
  cursor_id:=(p_query#>>'{cursor,id}')::uuid;
  select revision into cursor_revision from public.logo_stage_revisions where id=cursor_id and owner_id=owner and project_id=p_project_id and stage=p_kind and record->'createdAt'=p_query#>'{cursor,createdAt}';
  if not found then raise exception 'invalid_logo_cursor' using errcode='22023'; end if;
 end if;
 for row in select * from public.logo_stage_revisions where owner_id=owner and project_id=p_project_id and stage=p_kind and (cursor_revision is null or revision<cursor_revision) order by revision desc limit n+1 loop
  seen:=seen+1;
  if seen>n then return jsonb_build_object('ownerId',owner,'projectId',p_project_id,'items',items,'nextCursor',next_cursor); end if;
  items:=items||jsonb_build_array(row.record);
  next_cursor:=jsonb_build_object('stage',p_kind,'createdAt',row.record->'createdAt','id',row.id);
 end loop;
 return jsonb_build_object('ownerId',owner,'projectId',p_project_id,'items',items,'nextCursor',null);
end $$;
create function public.apply_logo_workspace_command(p_project_id uuid,p_command jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
begin
 if auth.uid() is null then raise exception 'unauthenticated' using errcode='42501'; end if;
 return fluid_private.logo_apply(auth.uid(),p_project_id,p_command);
end $$;

-- Clean default privileges ONLY on the exact NEW objects, never another overload
-- or an existing relation/schema/default ACL. Explicit grants follow below.
do $$
declare t text; signature text; r record; c record;
begin
 foreach t in array array['logo_workspaces','logo_stage_revisions','logo_stage_heads','logo_reference_sources','logo_reference_snapshots','logo_workspace_requests'] loop
  for r in select distinct a.grantee from pg_class cl cross join lateral aclexplode(coalesce(cl.relacl,acldefault('r',cl.relowner))) a where cl.oid=to_regclass('public.'||t) and a.grantee<>cl.relowner loop
   execute format('revoke all on table public.%I from %s',t,case when r.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(r.grantee)) end);
  end loop;
  for c in select at.attname,a.grantee from pg_attribute at join pg_class cl on cl.oid=at.attrelid cross join lateral aclexplode(at.attacl) a where cl.oid=to_regclass('public.'||t) and a.grantee<>cl.relowner loop
   execute format('revoke all (%I) on table public.%I from %s',c.attname,t,case when c.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(c.grantee)) end);
  end loop;
  execute format('alter table public.%I enable row level security',t);
  execute format('alter table public.%I force row level security',t);
  execute format('create policy logo_owned_read on public.%I for select to authenticated using (owner_id=auth.uid())',t);
  execute format('grant select on table public.%I to authenticated',t);
 end loop;
 foreach signature in array array[
  'fluid_private.logo_uuid(jsonb)','fluid_private.logo_brief_valid(jsonb)','fluid_private.logo_command_valid(jsonb)',
  'fluid_private.logo_workspace_json(uuid,uuid)','fluid_private.logo_snapshot_json(uuid,uuid,uuid)',
  'fluid_private.logo_append_brief(uuid,uuid,jsonb,uuid,jsonb)','fluid_private.logo_apply(uuid,uuid,jsonb)',
  'public.start_logo_project(jsonb)','public.read_logo_project_creation(uuid)','public.list_logo_project_creations(jsonb)',
  'public.get_logo_workspace(uuid)','public.read_logo_workspace_record(uuid,text,uuid)',
  'public.list_logo_workspace_records(uuid,text,jsonb)','public.apply_logo_workspace_command(uuid,jsonb)'] loop
  for r in select distinct a.grantee from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where p.oid=to_regprocedure(signature) and a.grantee<>p.proowner loop
   execute format('revoke all on function %s from %s',signature,case when r.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(r.grantee)) end);
  end loop;
 end loop;
end $$;
grant execute on function public.start_logo_project(jsonb),public.read_logo_project_creation(uuid),public.list_logo_project_creations(jsonb),public.get_logo_workspace(uuid),public.read_logo_workspace_record(uuid,text,uuid),public.list_logo_workspace_records(uuid,text,jsonb),public.apply_logo_workspace_command(uuid,jsonb) to authenticated;
commit;
