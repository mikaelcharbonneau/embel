-- Selected-logo brand boards on the existing shared Identity image lane.
-- Forward-only packet; install after shared_identity_generation.sql with lanes drained.
-- No rewrite of history, credentials, provider policies, or public.jobs schema.
begin;
do $$begin
 if current_user<>'postgres' or to_regprocedure('fluid_private.shared_identity_job(public.jobs)') is null
 or to_regclass('fluid_private.identity_system_applications') is not null then
  raise exception 'selected_logo_boards_install_prerequisite' using errcode='55000';end if;
end $$;

create function fluid_private.shared_identity_logo_source_valid(o uuid,p uuid,s jsonb) returns boolean
language plpgsql stable set search_path='' as $$
declare selection jsonb;brief jsonb;raster jsonb;publication public.logo_asset_publications;begin
 if fluid_private.standalone_keys(s,array['version','source','selectionRevision','logoType','brief','preview']) is distinct from true
 or s->'version' is distinct from '1'::jsonb then return false;end if;
 select record into selection from public.logo_stage_revisions where owner_id=o and project_id=p and stage='concepts' and revision=fluid_private.identity_counter(s->'selectionRevision',true);
 if selection#>'{payload,selected}' is distinct from s->'source' then return false;end if;
 raster:=fluid_private.resolve_logo_raster_source(o,p,s->'source');
 select record into brief from public.logo_stage_revisions where owner_id=o and project_id=p and stage='brief_references' and id=(s#>>'{brief,id}')::uuid;
 if brief is null or brief is distinct from s->'brief' or s->'preview' is distinct from raster->'preview' or s->'logoType' is distinct from raster->'logoType'
 or not exists(select 1 from jsonb_array_elements(raster->'inputRevisions') ref where ref->>'stage'='brief_references' and ref->>'id'=brief->>'id' and ref->'revision'=brief->'revision') then return false;end if;
 select * into publication from public.logo_asset_publications where id=(s#>>'{preview,id}')::uuid and owner_id=o and project_id=p;
 return publication.id is not null and publication.state='committed' and publication.purpose='brand_asset' and publication.mime_type in('image/png','image/jpeg','image/webp')
 and fluid_private.logo_asset_receipt(publication)=s->'preview'
 and exists(select 1 from public.asset_versions v where (v.id,v.asset_id,v.owner_id,v.project_id,v.content_hash,v.mime_type)=(publication.version_id,publication.asset_id,o,p,publication.content_hash,publication.mime_type)
 and v.storage_path=o::text||'/'||p::text||'/'||publication.asset_id::text||'/'||publication.version_id::text and v.provenance->>'publicationId'=publication.id::text);
exception when invalid_parameter_value or invalid_text_representation or numeric_value_out_of_range or no_data_found then return false;
end $$;

create function fluid_private.shared_identity_selected_logo(o uuid,p uuid) returns jsonb
language plpgsql stable set search_path='' as $$
declare workspace jsonb;selection jsonb;raster jsonb;brief jsonb;result jsonb;begin
 workspace:=fluid_private.logo_workspace_json(o,p);
 select record into selection from public.logo_stage_revisions where id=(workspace#>>'{stages,concepts,id}')::uuid and owner_id=o and project_id=p;
 if selection#>'{payload,selected}' is null or selection#>'{payload,selected}'='null'::jsonb then return null;end if;
 if exists(select 1 from jsonb_array_elements(workspace->'staleStages') stale where stale->>'stage' in('brief_references','concepts')
 or selection#>>'{payload,selected,kind}'='refinement' and stale->>'stage'='refinements') then return null;end if;
 raster:=fluid_private.resolve_logo_raster_source(o,p,selection#>'{payload,selected}');
 select record into brief from public.logo_stage_revisions where id=(workspace#>>'{stages,brief_references,id}')::uuid and owner_id=o and project_id=p;
 result:=jsonb_build_object('version',1,'source',raster->'source','selectionRevision',selection->'revision','logoType',raster->'logoType','brief',brief,'preview',raster->'preview');
 if fluid_private.shared_identity_logo_source_valid(o,p,result) is not true then return null;end if;
 return result;
end $$;

-- Version 2 records the saved logo brief explicitly; the real Strategy context is never rewritten.
create function fluid_private.identity_logo_basis(p_owner uuid,p_project uuid,p_context jsonb,p_references jsonb,p_preferences jsonb,p_brief jsonb) returns jsonb
language plpgsql immutable set search_path='' as $$declare v_refs jsonb;begin
 if p_brief->>'ownerId' is distinct from p_owner::text or p_brief->>'projectId' is distinct from p_project::text
 or p_brief->'version' is distinct from '2'::jsonb or p_brief->>'stage' is distinct from 'brief_references' then raise exception 'identity_logo_brief_invalid' using errcode='22023';end if;
 select coalesce(jsonb_agg(jsonb_build_object('referenceId',value#>'{reference,id}','media',value#>'{reference,media}','ensemble',value#>'{reaction,ensemble}','elements',value#>'{reaction,elements}') order by value#>>'{reference,id}'),'[]') into v_refs from jsonb_array_elements(p_references->'selected');
 return jsonb_build_object('version',2,'ownerId',p_owner,'projectId',p_project,'strategy',fluid_private.naming_strategy_basis(fluid_private.identity_material_context(p_context)),
 'name',normalize(fluid_private.identity_text(p_brief#>'{payload,name}',1,200),NFC),'logoBrief',p_brief,
 'referenceBasis',jsonb_build_object('version',1,'ownerId',p_owner,'projectId',p_project,'references',v_refs),'preferences',fluid_private.identity_preferences_value(p_preferences));
end $$;
-- Narrow owned read capabilities for the existing isolated Identity transaction writer.
create function fluid_private.identity_current_logo_brief(o uuid,p uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$begin
 if o is distinct from auth.uid() or not exists(select 1 from public.projects where id=p and owner_id=o) then raise exception 'not_found' using errcode='P0002';end if;
 return fluid_private.shared_identity_selected_logo(o,p)->'brief';
end $$;
create function fluid_private.identity_job_logo_brief(o uuid,p uuid,jid uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$declare j public.jobs;begin
 if o is distinct from auth.uid() then raise exception 'not_found' using errcode='P0002';end if;
 select * into strict j from public.jobs where id=jid and owner_id=o and project_id=p and operation='identity.image';
 if j.input->'version'<>'3' then return null;end if;
 if fluid_private.shared_identity_logo_source_valid(o,p,j.input->'sourceLogo') is not true then raise exception 'identity_logo_source_invalid' using errcode='55000';end if;
 return j.input#>'{sourceLogo,brief}';
end $$;
revoke all on function fluid_private.identity_logo_basis(uuid,uuid,jsonb,jsonb,jsonb,jsonb),fluid_private.identity_current_logo_brief(uuid,uuid),fluid_private.identity_job_logo_brief(uuid,uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function fluid_private.identity_current_logo_brief(uuid,uuid),fluid_private.identity_job_logo_brief(uuid,uuid,uuid) to fluid_identity_writer_definer_v1;

-- Widen the version check only. Column layout and all historical JSON remain unchanged.
do $snapshot_check$ declare c record;begin
 select conname,pg_get_constraintdef(oid) definition into strict c from pg_constraint where conrelid='public.identity_input_snapshots'::regclass and contype='c' and pg_get_constraintdef(oid) like '%jsonb_typeof(input)%';
 if c.definition not like '%(input -> ''version''::text) = ''1''::jsonb%' then raise exception 'identity_snapshot_constraint_changed';end if;
 execute format('alter table public.identity_input_snapshots drop constraint %I',c.conname);
 execute format('alter table public.identity_input_snapshots add constraint %I %s',c.conname,replace(c.definition,'(input -> ''version''::text) = ''1''::jsonb','(input ->> ''version''::text) in (''1'',''2'')'));
end $snapshot_check$;

create function fluid_private.identity_board_contrast_ratio(a text,b text) returns double precision
language plpgsql immutable set search_path='' as $$declare hex text;c double precision;lum double precision;values double precision[]:='{}';i integer;begin
 foreach hex in array array[a,b] loop
  if coalesce(hex,'')!~'^#[0-9A-Fa-f]{6}$' then return 0;end if;lum:=0;
  for i in 0..2 loop
   c:=('x'||substr(hex,2+i*2,2))::bit(8)::int/255.0;
   c:=case when c<=0.04045 then c/12.92 else power((c+0.055)/1.055,2.4) end;
   lum:=lum+c*(array[0.2126,0.7152,0.0722])[i+1];
  end loop;
  values:=array_append(values,lum);
 end loop;
 return (greatest(values[1],values[2])+0.05)/(least(values[1],values[2])+0.05);
end $$;
create function fluid_private.identity_application_design_valid(d jsonb,c jsonb) returns boolean
language plpgsql immutable set search_path='' as $$declare k text;style jsonb;begin
 if fluid_private.standalone_keys(d,array['version','graphic','layout','paletteRoles','headingStyleKey','bodyStyleKey']) is distinct from true
 or d->'version' is distinct from '1'::jsonb or d->>'graphic' not in('none','rounded_shapes','fine_lines','bold_blocks') or d->>'layout' not in('editorial','centered','split')
 or fluid_private.standalone_keys(d->'paletteRoles',array['primary','accent','background','text']) is distinct from true then return false;end if;
 foreach k in array array['primary','accent','background','text'] loop
  if coalesce(d#>>array['paletteRoles',k],'')!~'^[a-zA-Z0-9_-]{1,64}$' or not exists(select 1 from jsonb_array_elements(c#>'{colors,swatches}') s where s->>'key'=d#>>array['paletteRoles',k]) then return false;end if;
 end loop;
 foreach k in array array['headingStyleKey','bodyStyleKey'] loop
  if coalesce(d->>k,'')!~'^[a-zA-Z0-9_-]{1,64}$' or not exists(select 1 from jsonb_array_elements(c#>'{typography,styles}') s where s->>'key'=d->>k) then return false;end if;
 end loop;
 return fluid_private.identity_board_contrast_ratio((select s->>'hex' from jsonb_array_elements(c#>'{colors,swatches}') s where s->>'key'=d#>>'{paletteRoles,text}'),(select s->>'hex' from jsonb_array_elements(c#>'{colors,swatches}') s where s->>'key'=d#>>'{paletteRoles,background}'))>=4.5;
exception when others then return false;
end $$;
create function fluid_private.identity_board_typography_valid(c jsonb) returns boolean
language plpgsql immutable set search_path='' as $$declare s jsonb;w numeric;begin
 for s in select value from jsonb_array_elements(c#>'{typography,styles}') loop
  w:=(s->>'weight')::numeric;
  if s->>'style' is distinct from 'normal' or w<>trunc(w) or not(case s->>'family'
   when 'Geist' then w between 100 and 900 when 'Geist Mono' then w between 100 and 900
   when 'Lora' then w between 400 and 700 when 'Fraunces' then w between 100 and 900 when 'Manrope' then w between 200 and 800 else false end) then return false;end if;
 end loop;
 return jsonb_array_length(c#>'{typography,styles}')>0;
exception when others then return false;
end $$;
create table fluid_private.identity_system_applications(
 system_id uuid primary key,owner_id uuid not null,project_id uuid not null,design jsonb not null,
 foreign key(system_id,owner_id,project_id) references public.identity_system_versions(id,owner_id,project_id)
);
alter table fluid_private.identity_system_applications enable row level security;
alter table fluid_private.identity_system_applications force row level security;
create trigger identity_system_applications_immutable before update or delete on fluid_private.identity_system_applications
 for each row execute function fluid_private.prevent_history_change();
revoke all on table fluid_private.identity_system_applications from public,anon,authenticated,service_role;
grant select on table fluid_private.identity_system_applications to fluid_identity_writer_definer_v1;
create policy identity_application_internal_read on fluid_private.identity_system_applications for select to fluid_identity_writer_definer_v1 using(true);


create or replace function fluid_private.identity_system_json(p_system public.identity_system_versions) returns jsonb
language sql stable set search_path='' as $$
 select jsonb_build_object('id',p_system.id,'ownerId',p_system.owner_id,'projectId',p_system.project_id,'createdAt',p_system.created_at_text,'input',i.input,'source',p_system.source,'components',p_system.components,'board',p_system.board,'productionFiles',p_system.production_files)||coalesce((select jsonb_build_object('applicationDesign',a.design) from fluid_private.identity_system_applications a where (a.system_id,a.owner_id,a.project_id)=(p_system.id,p_system.owner_id,p_system.project_id)),'{}'::jsonb)
 from public.identity_input_snapshots i where i.id=p_system.input_id and i.owner_id=p_system.owner_id and i.project_id=p_system.project_id;
$$;

create or replace function fluid_private.identity_manifest_shape(p_manifest jsonb,p_owner uuid,p_project uuid) returns void
language plpgsql stable set search_path='' as $$
declare v_board jsonb:=p_manifest->'board';v_input jsonb:=p_manifest->'input';v_source jsonb:=p_manifest->'source';f jsonb;k text;v_stale jsonb;
begin
 if p_manifest?'applicationDesign' and fluid_private.identity_application_design_valid(p_manifest->'applicationDesign',p_manifest->'components') is not true then raise exception 'invalid_identity_application_design' using errcode='55000';end if;
 if jsonb_typeof(p_manifest) is distinct from 'object' or p_manifest-array['id','ownerId','projectId','createdAt','input','source','components','board','productionFiles','applicationDesign']<>'{}' or not(p_manifest ?& array['id','ownerId','projectId','createdAt','input','source','components','board','productionFiles'])
  or p_manifest->'ownerId' is distinct from to_jsonb(p_owner) or p_manifest->'projectId' is distinct from to_jsonb(p_project) or jsonb_typeof(p_manifest->'id') is distinct from 'string'
  or jsonb_typeof(p_manifest->'createdAt') is distinct from 'string'
  or jsonb_typeof(v_board) is distinct from 'object' or v_board-array['asset','depictsSystemVersionId','staleComponents']<>'{}' or not(v_board ?& array['asset','depictsSystemVersionId','staleComponents'])
  or jsonb_typeof(v_board->'depictsSystemVersionId') is distinct from 'string' or jsonb_typeof(v_board->'staleComponents') is distinct from 'array'
  or jsonb_typeof(p_manifest->'productionFiles') is distinct from 'array' or jsonb_array_length(p_manifest->'productionFiles')>48
 then raise exception 'invalid_identity_complete_manifest' using errcode='55000';end if;
 perform (p_manifest->>'id')::uuid;perform(v_board->>'depictsSystemVersionId')::uuid;perform fluid_private.identity_time_key(p_manifest->>'createdAt');
 select coalesce(jsonb_agg(to_jsonb(value) order by n),'[]') into v_stale from unnest(array['logo','colors','typography','graphics','imagery','composition']) with ordinality x(value,n) where v_board->'staleComponents' ? value;
 if v_board->'staleComponents'<>v_stale or p_manifest->'components' is distinct from fluid_private.identity_components(p_manifest->'components') then raise exception 'invalid_identity_complete_manifest' using errcode='55000';end if;
 if jsonb_typeof(v_source) is distinct from 'object' or v_source->>'kind' not in('generated','manual_edit') then raise exception 'invalid_identity_complete_manifest' using errcode='55000';end if;
 if v_source->>'kind'='generated' then
  if v_source-array['kind','batchId','jobId','stepKey']<>'{}' or not(v_source ?& array['kind','batchId','jobId','stepKey']) or jsonb_typeof(v_source->'batchId')<>'string' or jsonb_typeof(v_source->'jobId')<>'string' or v_board->'staleComponents'<>'[]' or v_board->'depictsSystemVersionId' is distinct from p_manifest->'id' then raise exception 'invalid_identity_complete_manifest' using errcode='55000';end if;
  perform(v_source->>'batchId')::uuid;perform(v_source->>'jobId')::uuid;perform fluid_private.identity_text(v_source->'stepKey',1,200,false);
 else
  if v_source-array['kind','baseSystemVersionId','changeId','component','editedAtProjectRevision','editedAtReferenceRevision','editedAtPreferencesRevision']<>'{}' or not(v_source ?& array['kind','baseSystemVersionId','changeId','component','editedAtProjectRevision','editedAtReferenceRevision','editedAtPreferencesRevision']) then raise exception 'invalid_identity_complete_manifest' using errcode='55000';end if;
  perform(v_source->>'baseSystemVersionId')::uuid;perform(v_source->>'changeId')::uuid;
  if v_source->>'component' not in('colors','typography') or v_source->'baseSystemVersionId'=p_manifest->'id' or v_board->'depictsSystemVersionId'=p_manifest->'id' or not(v_board->'staleComponents' ? (v_source->>'component')) then raise exception 'invalid_identity_complete_manifest' using errcode='55000';end if;
  perform fluid_private.identity_counter(v_source->'editedAtProjectRevision',true);perform fluid_private.identity_counter(v_source->'editedAtReferenceRevision');perform fluid_private.identity_counter(v_source->'editedAtPreferencesRevision');
 end if;
 if jsonb_typeof(v_input) is distinct from 'object' or v_input-array['version','ownerId','projectId','scope','projectRevision','context','referenceSnapshot','preferencesRevision','preferences','capturedAt','basis','logoBrief']<>'{}' or not(v_input ?& array['version','ownerId','projectId','scope','projectRevision','context','referenceSnapshot','preferencesRevision','preferences','capturedAt','basis'])
  or v_input->>'version' not in('1','2') or (v_input->'version'='1' and v_input?'logoBrief') or (v_input->'version'='2' and (v_input#>>'{logoBrief,stage}' is distinct from 'brief_references' or v_input#>>'{logoBrief,ownerId}' is distinct from p_owner::text or v_input#>>'{logoBrief,projectId}' is distinct from p_project::text)) or v_input->'ownerId' is distinct from to_jsonb(p_owner) or v_input->'projectId' is distinct from to_jsonb(p_project) or v_input->>'scope' not in('complete_brand','naming_only','visual_identity_only') or jsonb_typeof(v_input->'capturedAt') is distinct from 'string'
  or v_input->'context' is distinct from fluid_private.identity_material_context(v_input->'context') or v_input->'preferences' is distinct from fluid_private.identity_preferences_value(v_input->'preferences') then raise exception 'invalid_identity_complete_manifest' using errcode='55000';end if;
 perform fluid_private.identity_reference_snapshot_shape(v_input->'referenceSnapshot',p_owner,p_project);
 perform fluid_private.identity_counter(v_input->'projectRevision',true);perform fluid_private.identity_counter(v_input->'preferencesRevision');perform fluid_private.identity_time_key(v_input->>'capturedAt');
 perform fluid_private.identity_asset_shape(v_board->'asset',p_owner,p_project,true);
 for f in select value from jsonb_array_elements(p_manifest->'productionFiles') loop
  if jsonb_typeof(f) is distinct from 'object' or f-array['component','role','asset']<>'{}' or not(f ?& array['component','role','asset']) or f->>'component' not in('logo','colors','typography','graphics','imagery','composition')
   or f->>'role' is distinct from fluid_private.identity_text(f->'role',1,120) or f#>'{asset,versionId}'=v_board#>'{asset,versionId}' or f#>'{asset,contentHash}'=v_board#>'{asset,contentHash}'
   or(v_source->>'kind'='manual_edit' and f->'component'=v_source->'component') then raise exception 'invalid_identity_complete_manifest' using errcode='55000';end if;
  perform fluid_private.identity_asset_shape(f->'asset',p_owner,p_project,false);
 end loop;
 if exists(select 1 from jsonb_array_elements(p_manifest->'productionFiles') as files(value) group by files.value->>'component',files.value->>'role' having count(*)>1) then raise exception 'invalid_identity_complete_manifest' using errcode='55000';end if;
end $$;

create or replace function fluid_private.shared_identity_manifest_shape(p_manifest jsonb,p_owner uuid,p_project uuid) returns void
language plpgsql stable set search_path='' as $$
declare v_board jsonb:=p_manifest->'board';v_input jsonb:=p_manifest->'input';v_source jsonb:=p_manifest->'source';f jsonb;k text;v_stale jsonb;
begin
 if p_manifest?'applicationDesign' and fluid_private.identity_application_design_valid(p_manifest->'applicationDesign',p_manifest->'components') is not true then raise exception 'invalid_identity_application_design' using errcode='55000';end if;
 if jsonb_typeof(p_manifest) is distinct from 'object' or p_manifest-array['id','ownerId','projectId','createdAt','input','source','components','board','productionFiles','applicationDesign']<>'{}' or not(p_manifest ?& array['id','ownerId','projectId','createdAt','input','source','components','board','productionFiles'])
  or p_manifest->'ownerId' is distinct from to_jsonb(p_owner) or p_manifest->'projectId' is distinct from to_jsonb(p_project) or jsonb_typeof(p_manifest->'id') is distinct from 'string'
  or jsonb_typeof(p_manifest->'createdAt') is distinct from 'string'
  or jsonb_typeof(v_board) is distinct from 'object' or v_board-array['asset','depictsSystemVersionId','staleComponents']<>'{}' or not(v_board ?& array['asset','depictsSystemVersionId','staleComponents'])
  or jsonb_typeof(v_board->'depictsSystemVersionId') is distinct from 'string' or jsonb_typeof(v_board->'staleComponents') is distinct from 'array'
  or jsonb_typeof(p_manifest->'productionFiles') is distinct from 'array' or jsonb_array_length(p_manifest->'productionFiles')>48
 then raise exception 'invalid_identity_complete_manifest' using errcode='55000';end if;
 perform (p_manifest->>'id')::uuid;perform(v_board->>'depictsSystemVersionId')::uuid;perform fluid_private.identity_time_key(p_manifest->>'createdAt');
 select coalesce(jsonb_agg(to_jsonb(value) order by n),'[]') into v_stale from unnest(array['logo','colors','typography','graphics','imagery','composition']) with ordinality x(value,n) where v_board->'staleComponents' ? value;
 if v_board->'staleComponents'<>v_stale or p_manifest->'components' is distinct from fluid_private.identity_components(p_manifest->'components') then raise exception 'invalid_identity_complete_manifest' using errcode='55000';end if;
 if jsonb_typeof(v_source) is distinct from 'object' or v_source->>'kind' not in('generated','manual_edit') then raise exception 'invalid_identity_complete_manifest' using errcode='55000';end if;
 if v_source->>'kind'='generated' then
  if v_source-array['kind','batchId','jobId','stepKey']<>'{}' or not(v_source ?& array['kind','batchId','jobId','stepKey']) or jsonb_typeof(v_source->'batchId')<>'string' or jsonb_typeof(v_source->'jobId')<>'string' or v_board->'staleComponents'<>'[]' or v_board->'depictsSystemVersionId' is distinct from p_manifest->'id' then raise exception 'invalid_identity_complete_manifest' using errcode='55000';end if;
  perform(v_source->>'batchId')::uuid;perform(v_source->>'jobId')::uuid;perform fluid_private.identity_text(v_source->'stepKey',1,200,false);
 else
  if v_source-array['kind','baseSystemVersionId','changeId','component','editedAtProjectRevision','editedAtReferenceRevision','editedAtPreferencesRevision']<>'{}' or not(v_source ?& array['kind','baseSystemVersionId','changeId','component','editedAtProjectRevision','editedAtReferenceRevision','editedAtPreferencesRevision']) then raise exception 'invalid_identity_complete_manifest' using errcode='55000';end if;
  perform(v_source->>'baseSystemVersionId')::uuid;perform(v_source->>'changeId')::uuid;
  if v_source->>'component' not in('colors','typography') or v_source->'baseSystemVersionId'=p_manifest->'id' or v_board->'depictsSystemVersionId'=p_manifest->'id' or not(v_board->'staleComponents' ? (v_source->>'component')) then raise exception 'invalid_identity_complete_manifest' using errcode='55000';end if;
  perform fluid_private.identity_counter(v_source->'editedAtProjectRevision',true);perform fluid_private.identity_counter(v_source->'editedAtReferenceRevision');perform fluid_private.identity_counter(v_source->'editedAtPreferencesRevision');
 end if;
 if jsonb_typeof(v_input) is distinct from 'object' or v_input-array['version','ownerId','projectId','scope','projectRevision','context','referenceSnapshot','preferencesRevision','preferences','capturedAt','basis','logoBrief']<>'{}' or not(v_input ?& array['version','ownerId','projectId','scope','projectRevision','context','referenceSnapshot','preferencesRevision','preferences','capturedAt','basis'])
  or v_input->>'version' not in('1','2') or (v_input->'version'='1' and v_input?'logoBrief') or (v_input->'version'='2' and (v_input#>>'{logoBrief,stage}' is distinct from 'brief_references' or v_input#>>'{logoBrief,ownerId}' is distinct from p_owner::text or v_input#>>'{logoBrief,projectId}' is distinct from p_project::text)) or v_input->'ownerId' is distinct from to_jsonb(p_owner) or v_input->'projectId' is distinct from to_jsonb(p_project) or v_input->>'scope' not in('complete_brand','naming_only','visual_identity_only') or jsonb_typeof(v_input->'capturedAt') is distinct from 'string'
  or v_input->'context' is distinct from fluid_private.identity_material_context(v_input->'context') or v_input->'preferences' is distinct from fluid_private.identity_preferences_value(v_input->'preferences') then raise exception 'invalid_identity_complete_manifest' using errcode='55000';end if;
 perform fluid_private.identity_reference_snapshot_shape(v_input->'referenceSnapshot',p_owner,p_project);
 perform fluid_private.identity_counter(v_input->'projectRevision',true);perform fluid_private.identity_counter(v_input->'preferencesRevision');perform fluid_private.identity_time_key(v_input->>'capturedAt');
 perform fluid_private.shared_identity_asset_shape(v_board->'asset',p_owner,p_project,true);
 for f in select value from jsonb_array_elements(p_manifest->'productionFiles') loop
  if jsonb_typeof(f) is distinct from 'object' or f-array['component','role','asset']<>'{}' or not(f ?& array['component','role','asset']) or f->>'component' not in('logo','colors','typography','graphics','imagery','composition')
   or f->>'role' is distinct from fluid_private.identity_text(f->'role',1,120) or f#>'{asset,versionId}'=v_board#>'{asset,versionId}' or f#>'{asset,contentHash}'=v_board#>'{asset,contentHash}'
   or(v_source->>'kind'='manual_edit' and f->'component'=v_source->'component') then raise exception 'invalid_identity_complete_manifest' using errcode='55000';end if;
  perform fluid_private.shared_identity_asset_shape(f->'asset',p_owner,p_project,false);
 end loop;
 if exists(select 1 from jsonb_array_elements(p_manifest->'productionFiles') as files(value) group by files.value->>'component',files.value->>'role' having count(*)>1) then raise exception 'invalid_identity_complete_manifest' using errcode='55000';end if;
end $$;

create or replace function fluid_private.shared_identity_intent_valid(p_intent jsonb) returns boolean
language plpgsql immutable set search_path='' as $$begin
 if fluid_private.standalone_keys(p_intent,array['version','spendControl','expectedProjectRevision','expectedReferenceRevision','expectedPreferencesRevision','expectedIdentityRevision','idempotencyKey','acceptedPolicyIdentity']||(case when p_intent->'version'='3' then array['sourceLogo','expectedLogoRevision'] else array[]::text[] end)) is distinct from true
 or p_intent->>'version' not in('2','3') or p_intent->>'spendControl' is distinct from 'uncapped'
 or coalesce(p_intent->>'idempotencyKey','')!~'^[A-Za-z0-9._:-]{16,128}$' or coalesce(p_intent->>'acceptedPolicyIdentity','')!~'^[a-f0-9]{64}$' then return false;end if;
 perform fluid_private.identity_counter(p_intent->'expectedProjectRevision',true);perform fluid_private.identity_counter(p_intent->'expectedReferenceRevision');
 if p_intent->'version'='3' then perform fluid_private.identity_counter(p_intent->'expectedLogoRevision',true);if jsonb_typeof(p_intent->'sourceLogo') is distinct from 'object' then return false;end if;end if;
 perform fluid_private.identity_counter(p_intent->'expectedPreferencesRevision');perform fluid_private.identity_counter(p_intent->'expectedIdentityRevision');return true;
exception when invalid_parameter_value or invalid_text_representation or numeric_value_out_of_range then return false;
end $$;

create or replace function public.get_shared_identity_availability(p_project_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare o uuid:=fluid_private.shared_identity_customer(p_project_id);profile jsonb;state jsonb;basis jsonb;p public.projects;reason text;bytes bigint;members integer;logo jsonb;estimated bigint;
begin
 select * into strict p from public.projects where id=p_project_id and owner_id=o;
 state:=fluid_private.identity_current_state(p_project_id);
 if p.scope='naming_only' then reason:='inputs_not_ready';end if;
 logo:=fluid_private.shared_identity_selected_logo(o,p_project_id);
 if reason is null and logo is null then reason:=case when exists(select 1 from public.logo_stage_heads h join public.logo_stage_revisions r on r.id=h.revision_id where h.owner_id=o and h.project_id=p_project_id and h.stage='concepts' and r.record#>'{payload,selected}'<>'null'::jsonb) then 'logo_needs_review' else 'logo_selection_required' end;end if;
 if reason is null and (state#>>'{referenceSnapshot,selectedReferenceCount}')::integer>3 then reason:='reference_limit_exceeded';end if;
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
  elsif bytes+coalesce((logo#>>'{preview,verification,byteLength}')::bigint,0)>20971520 then reason:='reference_bytes_exceeded';end if;
 end if;
 profile:=fluid_private.shared_identity_policy(o);
 if reason is null and profile is null then reason:='runtime_unavailable';end if;
 if reason is not null then return jsonb_build_object('ownerId',o,'projectId',p_project_id,'status','unavailable','operation','identity.image','requestedModel','gpt-image-2.5-sunburst-2026-09-08','reason',reason);end if;
 select ceil(avg(actual_cost_microusd))::bigint into estimated from(select job.actual_cost_microusd from public.jobs job where job.owner_id=o and job.operation='identity.image' and job.input->'version'='3' and job.input->>'policyIdentity'=profile->>'policyIdentity' and job.state='succeeded' order by job.created_at desc limit 10) prior;
 return jsonb_build_object('version',3,'spendControl','uncapped','ownerId',o,'projectId',p_project_id,'status','available','operation','identity.image',
 'requestedModel','gpt-image-2.5-sunburst-2026-09-08','policyIdentity',profile->>'policyIdentity','handlerVersion','identity-image-v1','targetCount',3,'maxReferenceImages',4,'maxReferenceBytes',20971520,'estimatedCostMicrousd',estimated,'sourceLogo',logo,
 'expectedProjectRevision',p.current_revision,'expectedReferenceRevision',state#>'{referenceSnapshot,referenceRevision}',
 'expectedPreferencesRevision',coalesce(state#>'{preferences,revision}','0'::jsonb),'expectedIdentityRevision',coalesce(state#>'{session,identityRevision}','0'::jsonb),
 'expectedLogoRevision',logo->'selectionRevision');
end $$;

create or replace function public.ensure_shared_identity_batch(p_project_id uuid,p_intent jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare o uuid:=fluid_private.shared_identity_customer(p_project_id);p public.projects;s public.identity_sessions;pref public.identity_preferences;
 r fluid_private.shared_identity_requests;refs jsonb;context jsonb;preferences jsonb;snapshot jsonb;profile jsonb;input jsonb;manifest jsonb;bid uuid:=gen_random_uuid();jid uuid:=gen_random_uuid();iid uuid;systems jsonb;logo jsonb;
begin
 if fluid_private.shared_identity_intent_valid(p_intent) is not true then raise exception 'invalid_identity_generation_intent' using errcode='22023';end if;
 perform pg_advisory_xact_lock(hashtextextended(o::text||':'||p_project_id::text,724005));
 if exists(select 1 from fluid_private.shared_identity_rejected_intents closed where closed.owner_id=o and closed.project_id=p_project_id and closed.request_key=p_intent->>'idempotencyKey') then
  raise exception 'identity_generation_intent_closed' using errcode='PT409';end if;
 select * into r from fluid_private.shared_identity_requests where owner_id=o and project_id=p_project_id and request_key=p_intent->>'idempotencyKey';
 if found then if r.intent is distinct from p_intent then raise exception 'identity_generation_intent_conflict' using errcode='PT409';end if;return fluid_private.shared_identity_batch_state(o,p_project_id,r.batch_id);end if;
 if p_intent->'version' is distinct from '3'::jsonb then raise exception 'selected_logo_intent_required' using errcode='22023';end if;
 select * into strict p from public.projects where id=p_project_id and owner_id=o for update;
 perform 1 from public.logo_workspaces where project_id=p.id and owner_id=o for share;
 logo:=fluid_private.shared_identity_selected_logo(o,p.id);
 if logo is null or logo->'source' is distinct from p_intent->'sourceLogo' or logo->'selectionRevision' is distinct from p_intent->'expectedLogoRevision' then raise exception 'identity_logo_selection_conflict' using errcode='PT409';end if;
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
 snapshot:=jsonb_build_object('version',2,'logoBrief',logo->'brief','ownerId',o,'projectId',p.id,'scope',p.scope,'projectRevision',p.current_revision,'context',fluid_private.identity_material_context(context),
 'referenceSnapshot',refs,'preferencesRevision',coalesce(pref.revision,0),'preferences',fluid_private.identity_preferences_value(preferences),'capturedAt',clock_timestamp(),
 'basis',fluid_private.identity_logo_basis(o,p.id,context,refs,preferences,logo->'brief'));
 insert into public.identity_input_snapshots(project_id,owner_id,project_revision,reference_revision,preferences_revision,input)
 values(p.id,o,p.current_revision,(refs->>'referenceRevision')::bigint,pref.revision,snapshot) returning id into iid;
 systems:=jsonb_build_array(gen_random_uuid(),gen_random_uuid(),gen_random_uuid());
 input:=jsonb_build_object('version',3,'operation','identity.image','ownerId',o,'projectId',p.id,'batchId',bid,'input',snapshot,'policyIdentity',profile->>'policyIdentity',
 'handlerVersion','identity-image-v1','spendControl','uncapped','textPolicy',profile#>'{policy,textPolicy}','systemIds',systems,'sourceLogo',logo);
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

create or replace function fluid_private.shared_identity_job(j public.jobs) returns boolean
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
 and j.input->>'operation'='identity.image' and j.input->>'version' in('2','3')
 and (j.input->'version'='2' or (j.input#>'{input,version}'='2' and j.input#>'{input,logoBrief}'=j.input#>'{sourceLogo,brief}' and fluid_private.shared_identity_logo_source_valid(j.owner_id,j.project_id,j.input->'sourceLogo'))) and j.input->>'spendControl'='uncapped' and j.input->>'handlerVersion'='identity-image-v1'
 and j.input->>'ownerId'=j.owner_id::text and j.input->>'projectId'=j.project_id::text and j.input->>'batchId'=b.id::text and j.input->'input'=i.input
 and jsonb_array_length(j.input->'systemIds')=3 and (select count(distinct value) from jsonb_array_elements(j.input->'systemIds'))=3
 and j.input_hash=encode(sha256(convert_to(j.input::text,'UTF8')),'hex')) end;
$$;

create or replace function fluid_private.shared_identity_storage_member(j public.jobs,r public.logo_asset_publications,p_mode text) returns jsonb
language plpgsql stable set search_path='' as $$declare media jsonb;begin
 if not fluid_private.shared_identity_job(j) or r.id is null or r.owner_id<>j.owner_id or r.project_id<>j.project_id then return null;end if;
 if p_mode='read' then
  if j.input->'version'='3' and r.state='committed' and r.purpose='brand_asset'
   and fluid_private.logo_asset_receipt(r)=j.input#>'{sourceLogo,preview}'
   and fluid_private.shared_identity_logo_source_valid(j.owner_id,j.project_id,j.input->'sourceLogo') then return jsonb_build_object('member','base');end if;
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

create or replace function fluid_private.shared_identity_observation_valid(o jsonb,c fluid_private.shared_identity_calls) returns boolean
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
   if not fluid_private.standalone_keys(o->'specification',array['components','boardPrompt']||(case when o->'specification'?'applicationDesign' then array['applicationDesign'] else array[]::text[] end)) or (o#>'{specification,components}') is distinct from fluid_private.identity_components(o#>'{specification,components}')
   or (o->'specification'?'applicationDesign' and fluid_private.identity_application_design_valid(o#>'{specification,applicationDesign}',o#>'{specification,components}') is not true)
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

create or replace function fluid_private.shared_identity_stage(j public.jobs,p_step text,p_output jsonb,p_evidence jsonb) returns jsonb
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
 or (j.input->'version'='3' and (system->'applicationDesign' is null or system->'applicationDesign' is distinct from t.observation#>'{specification,applicationDesign}'
  or fluid_private.identity_application_design_valid(system->'applicationDesign',system->'components') is not true
  or fluid_private.identity_board_typography_valid(system->'components') is not true))
 or exists(select 1 from public.identity_generated_roots root where root.batch_id=(j.input->>'batchId')::uuid and root.system_id<>sid and root.board->>'contentHash'=r.content_hash)
 then raise exception 'identity_stage_provenance_invalid' using errcode='42501';end if;
 select * into prior from fluid_private.shared_identity_prepared where job_id=j.id and step_key=p_step;
 if found then
  if (prior.execution_id,prior.output,prior.text_receipt_id,prior.image_receipt_id,prior.publication_id) is distinct from(e.execution_id,p_output,t.id,i.id,r.id) then raise exception 'identity_stage_conflict' using errcode='PT409';end if;
 else insert into fluid_private.shared_identity_prepared values(j.id,p_step,e.execution_id,p_output,t.id,i.id,r.id);end if;
 return jsonb_build_object('status','staged','systemVersionId',sid,'stepKey',p_step);
end $$;

create or replace function fluid_private.shared_identity_complete(j public.jobs,p_step text,p_state text,p_cost bigint,p_output jsonb,p_request text) returns void
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
  if system?'applicationDesign' then insert into fluid_private.identity_system_applications(system_id,owner_id,project_id,design) values(sid,j.owner_id,j.project_id,system->'applicationDesign');end if;
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

create or replace function fluid_private.shared_identity_batch_state(p_owner uuid,p_project uuid,p_batch uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare b public.identity_batches;j public.jobs;i public.identity_input_snapshots;intent jsonb;systems jsonb;n integer;terminal boolean;usage_status text;known bigint;missing boolean;
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
 select coalesce(sum(case when r.observation#>>'{billing,status}'='recorded' then (r.observation#>>'{billing,confirmedMicrousd}')::bigint else 0 end),0),
 count(*) filter(where r.id is null or r.observation#>>'{billing,status}'<>'recorded')>0 into known,missing
 from fluid_private.shared_identity_calls c left join fluid_private.shared_identity_receipts r on r.call_id=c.id where c.job_id=j.id;
 usage_status:=case when missing then 'unknown' when j.state in('queued','running','cancel_requested') then 'pending' else 'recorded' end;
 return jsonb_build_object('ownerId',p_owner,'projectId',p_project,'batchId',b.id,'jobId',j.id,'status',j.state,'terminal',j.lease_token is null and j.state in('succeeded','failed','cancelled','partial'),'intent',intent,'input',i.input,'systems',systems,
 'fulfillment',jsonb_build_object('targetCount',3,'acceptedCount',n,'status',case when n=3 then 'complete' when n>0 then 'partial' when terminal or j.state='needs_reconciliation' then 'none' else 'pending' end))||case when j.input->'version'='3' then jsonb_build_object('sourceLogo',j.input->'sourceLogo','sourceLogoCurrent',coalesce(((j.input->'sourceLogo')-'selectionRevision')=(fluid_private.shared_identity_selected_logo(p_owner,p_project)-'selectionRevision'),false),'usage',jsonb_build_object('status',usage_status,'knownCostMicrousd',known)) else '{}'::jsonb end;
end $$;


-- Source provenance remains available for a generated system or one of its manual versions.
create function public.get_identity_logo_source(p_project_id uuid,p_system_version_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$declare o uuid:=auth.uid();j public.jobs;s public.identity_system_versions;begin
 if o is null then raise exception 'unauthenticated' using errcode='42501';end if;
 select * into s from public.identity_system_versions where id=p_system_version_id and owner_id=o and project_id=p_project_id;
 if not found then raise exception 'identity_system_not_found' using errcode='P0002';end if;
 select job.* into j from public.identity_generated_roots root join public.jobs job on job.id=root.job_id and job.owner_id=root.owner_id and job.project_id=root.project_id
 where root.system_id=s.root_system_id and root.owner_id=o and root.project_id=p_project_id;
 if j.id is null then raise exception 'identity_generated_source_missing' using errcode='55000';end if;
 if j.input->'version'<>'3' then return null;end if;
 if fluid_private.shared_identity_logo_source_valid(o,p_project_id,j.input->'sourceLogo') is not true then raise exception 'identity_logo_source_unavailable' using errcode='55000';end if;
 return jsonb_build_object('sourceLogo',j.input->'sourceLogo','sourceLogoCurrent',coalesce(((j.input->'sourceLogo')-'selectionRevision')=(fluid_private.shared_identity_selected_logo(o,p_project_id)-'selectionRevision'),false));
end $$;
revoke all on function public.get_identity_logo_source(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.get_identity_logo_source(uuid,uuid) to authenticated;

-- A later logo selection must not be silently approved through the older system selector.
create function fluid_private.identity_selection_current_logo() returns trigger
language plpgsql security definer set search_path='' as $$declare j public.jobs;s public.identity_system_versions;begin
 select * into strict s from public.identity_system_versions where id=new.system_id and owner_id=new.owner_id and project_id=new.project_id;
 select job.* into j from public.identity_generated_roots root join public.jobs job on job.id=root.job_id and job.owner_id=root.owner_id and job.project_id=root.project_id
 where root.system_id=s.root_system_id and root.owner_id=new.owner_id and root.project_id=new.project_id;
 if j.input->'version'='3' then
  perform 1 from public.logo_workspaces where owner_id=new.owner_id and project_id=new.project_id for share;
  if ((j.input->'sourceLogo')-'selectionRevision') is distinct from (fluid_private.shared_identity_selected_logo(new.owner_id,new.project_id)-'selectionRevision') then raise exception 'identity_logo_selection_changed' using errcode='PT409';end if;
 end if;
 return new;
end $$;
create trigger identity_selection_current_logo before insert on public.identity_selections
 for each row execute function fluid_private.identity_selection_current_logo();

-- Manual component versions inherit explicit application decisions. Invalid references fail in the existing manifest validator.
create function fluid_private.identity_inherit_application_design() returns trigger
language plpgsql security definer set search_path='' as $$begin
 if new.source->>'kind'='manual_edit' then
  insert into fluid_private.identity_system_applications(system_id,owner_id,project_id,design)
  select new.id,new.owner_id,new.project_id,a.design from fluid_private.identity_system_applications a
  where a.system_id=new.base_system_id and a.owner_id=new.owner_id and a.project_id=new.project_id;
 end if;
 return new;
end $$;
create trigger identity_inherit_application_design after insert on public.identity_system_versions
 for each row execute function fluid_private.identity_inherit_application_design();

do $$declare signature text;begin
 foreach signature in array array['fluid_private.shared_identity_logo_source_valid(uuid,uuid,jsonb)','fluid_private.shared_identity_selected_logo(uuid,uuid)',
 'fluid_private.identity_application_design_valid(jsonb,jsonb)','fluid_private.identity_board_typography_valid(jsonb)',
 'fluid_private.identity_selection_current_logo()','fluid_private.identity_inherit_application_design()'] loop
  execute format('revoke all on function %s from public,anon,authenticated,service_role',signature);
 end loop;
end $$;
-- Existing formatter/manifest validators execute inside this restricted definer.
grant execute on function fluid_private.identity_application_design_valid(jsonb,jsonb) to fluid_identity_writer_definer_v1;

create or replace function fluid_private.identity_current_state(p_project_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare v_owner uuid:=auth.uid();v_project public.projects;v_context jsonb;v_session public.identity_sessions;v_preferences public.identity_preferences;
begin
 select * into v_project from public.projects where id=p_project_id and owner_id=v_owner;if not found then raise exception 'not_found' using errcode='P0002';end if;
 select context into strict v_context from public.project_revisions where project_id=p_project_id and owner_id=v_owner and revision=v_project.current_revision;
 select * into v_session from public.identity_sessions where project_id=p_project_id and owner_id=v_owner;
 select * into v_preferences from public.identity_preferences where project_id=p_project_id and owner_id=v_owner and revision=v_session.current_preferences_revision;
 return jsonb_build_object('project',fluid_private.asset_library_project(v_project)||jsonb_build_object('context',v_context),
  'session',fluid_private.identity_session_json(v_session),'preferences',fluid_private.identity_preferences_json(v_preferences),'referenceSnapshot',fluid_private.identity_current_references(p_project_id))||coalesce((select jsonb_build_object('logoBrief',brief) from (select fluid_private.shared_identity_selected_logo(v_owner,p_project_id)->'brief' brief) captured where brief is not null),'{}'::jsonb);
end $$;

create or replace function fluid_private.identity_root_evidence(p_system public.identity_system_versions) returns jsonb
language plpgsql stable set search_path='' as $$
declare r public.identity_generated_roots;b public.identity_batches;j public.jobs;s public.job_steps;i public.identity_input_snapshots;v_system jsonb;v_output jsonb;v_snapshot jsonb;v_context jsonb;v_preferences jsonb;v_root jsonb;
begin
 if p_system.source->>'kind'<>'generated' or p_system.root_system_id<>p_system.id then raise exception 'invalid_identity_root' using errcode='55000';end if;
 select * into r from public.identity_generated_roots where system_id=p_system.id and project_id=p_system.project_id and owner_id=p_system.owner_id;if not found then raise exception 'missing_identity_receipt' using errcode='55000';end if;
 select * into strict b from public.identity_batches where id=r.batch_id and job_id=r.job_id and project_id=r.project_id and owner_id=r.owner_id;
 select * into strict j from public.jobs where id=b.job_id and project_id=b.project_id and owner_id=b.owner_id;
 select * into strict s from public.job_steps where job_id=r.job_id and step_key=r.step_key and project_id=r.project_id and owner_id=r.owner_id;
 select * into strict i from public.identity_input_snapshots where id=b.input_id and project_id=b.project_id and owner_id=b.owner_id;
 v_system:=fluid_private.identity_system_json(p_system);v_output:=s.output->'identity';
 select snapshot into strict v_snapshot from public.identity_reference_snapshots where project_id=i.project_id and owner_id=i.owner_id and reference_revision=i.reference_revision;
 select context into strict v_context from public.project_revisions where project_id=i.project_id and owner_id=i.owner_id and revision=i.project_revision;
 if i.preferences_revision is null then v_preferences:=jsonb_build_object('version',1,'creativeLocale',coalesce(v_context->>'creativeLocale','en'),'notes',coalesce(v_context#>>'{intake,identityNotes}',''),'avoidanceNotes','');
 else select preferences into strict v_preferences from public.identity_preferences where project_id=i.project_id and owner_id=i.owner_id and revision=i.preferences_revision;end if;
 if j.operation<>'identity.image' or j.input_revision<>i.project_revision or s.state<>'succeeded' or s.completed_at is null or i.id<>p_system.input_id
  or p_system.source is distinct from jsonb_build_object('kind','generated','batchId',b.id,'jobId',j.id,'stepKey',s.step_key)
  or s.output-array['identity']<>'{}' or jsonb_typeof(v_output) is distinct from 'object' or v_output-array['version','operation','ownerId','projectId','batchId','jobId','stepKey','targetCount','input','systems']<>'{}'
  or (v_output-'systems') is distinct from jsonb_build_object('version',1,'operation','identity.image','ownerId',r.owner_id,'projectId',r.project_id,'batchId',r.batch_id,'jobId',r.job_id,'stepKey',r.step_key,'targetCount',3,'input',i.input)
  or jsonb_typeof(v_output->'systems') is distinct from 'array' or jsonb_array_length(v_output->'systems')>3
  or v_output#>array['systems',r.output_index::text] is distinct from v_system or r.board is distinct from p_system.board->'asset'
  or i.input->'context' is distinct from fluid_private.identity_material_context(v_context)
  or i.input->'referenceSnapshot' is distinct from v_snapshot or i.input->'preferences' is distinct from fluid_private.identity_preferences_value(v_preferences)
  or i.input->'basis' is distinct from (case when i.input->'version'='2' then fluid_private.identity_logo_basis(i.owner_id,i.project_id,v_context,v_snapshot,v_preferences,j.input#>'{sourceLogo,brief}') else fluid_private.identity_basis(i.owner_id,i.project_id,v_context,v_snapshot,v_preferences) end)
  or (i.input->'version'='2' and (j.input->'version' is distinct from '3'::jsonb or i.input->'logoBrief' is distinct from j.input#>'{sourceLogo,brief}' or fluid_private.shared_identity_logo_source_valid(i.owner_id,i.project_id,j.input->'sourceLogo') is not true))
  or p_system.board->>'depictsSystemVersionId'<>p_system.id::text or p_system.board->'staleComponents' is distinct from '[]'::jsonb
 then raise exception 'invalid_identity_completed_evidence' using errcode='55000';end if;
 -- The exact full frozen input is bound by the immutable input row, output and
 -- receipt. Material equality never substitutes for completed manifest equality.
 for v_root in select value from jsonb_array_elements(v_output->'systems') loop
  perform fluid_private.identity_manifest_shape(v_root,p_system.owner_id,p_system.project_id);
  if v_root->'input' is distinct from i.input or v_root->'source' is distinct from p_system.source or v_root->'ownerId' is distinct from to_jsonb(r.owner_id) or v_root->'projectId' is distinct from to_jsonb(r.project_id)
   or v_root#>'{board,staleComponents}' is distinct from '[]'::jsonb or v_root#>'{board,depictsSystemVersionId}' is distinct from v_root->'id' or v_root->'components' is distinct from fluid_private.identity_components(v_root->'components') then raise exception 'invalid_identity_output' using errcode='55000';end if;
 end loop;
 if exists(select 1 from jsonb_array_elements(v_output->'systems') a group by a->>'id' having count(*)>1)
  or exists(select 1 from jsonb_array_elements(v_output->'systems') a group by a#>>'{board,asset,versionId}' having count(*)>1)
  or exists(select 1 from jsonb_array_elements(v_output->'systems') a group by a#>>'{board,asset,contentHash}' having count(*)>1)
  or exists(select 1 from jsonb_array_elements(v_output->'systems') a,jsonb_array_elements(v_output->'systems') other_system,jsonb_array_elements(other_system->'productionFiles') f where f#>'{asset,versionId}'=a#>'{board,asset,versionId}' or f#>'{asset,contentHash}'=a#>'{board,asset,contentHash}')
  or (select count(*) from public.identity_generated_roots where batch_id=b.id and owner_id=b.owner_id and project_id=b.project_id)>3
  or exists(select 1 from public.identity_generated_roots x where x.batch_id=b.id and x.system_id<>r.system_id and(x.board->>'versionId'=r.board->>'versionId' or x.board->>'contentHash'=r.board->>'contentHash')) or exists(select 1 from public.identity_generated_roots x join public.identity_generated_roots y on y.batch_id=x.batch_id and y.owner_id=x.owner_id and y.project_id=x.project_id join public.identity_system_versions ys on ys.id=y.system_id and ys.owner_id=y.owner_id and ys.project_id=y.project_id cross join lateral jsonb_array_elements(ys.production_files) pf where x.batch_id=b.id and x.owner_id=b.owner_id and x.project_id=b.project_id and(pf#>'{asset,versionId}'=x.board->'versionId' or pf#>'{asset,contentHash}'=x.board->'contentHash')) then raise exception 'invalid_identity_batch_outputs' using errcode='55000';end if;
 perform fluid_private.identity_check_files(p_system);
 return jsonb_build_object('batch',jsonb_build_object('id',b.id,'ownerId',b.owner_id,'projectId',b.project_id,'jobId',b.job_id,'targetCount',b.target_count,'input',i.input),
 'step',jsonb_build_object('ownerId',s.owner_id,'projectId',s.project_id,'jobId',s.job_id,'stepKey',s.step_key,'state',s.state,'completedAt',s.completed_at,'output',s.output),
 'receipt',jsonb_build_object('version',1,'ownerId',r.owner_id,'projectId',r.project_id,'batchId',r.batch_id,'jobId',r.job_id,'stepKey',r.step_key,'outputIndex',r.output_index,'systemVersionId',r.system_id,'board',r.board),'system',v_system);
end $$;

-- Temporary source-installer membership only; no runtime login gains authority.
grant fluid_identity_writer_definer_v1 to postgres with inherit true,set true;
create or replace function fluid_private.prepare_identity_transaction(p_project uuid,p_request jsonb,p_refinement boolean) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
 v_owner uuid:=fluid_private.identity_web_owner(); v_role oid:=pg_catalog.to_regrole(session_user)::oid;
 v_relation oid; v_target uuid; v_ids uuid[]; v_jobs uuid[]; v_assets uuid[]; v_output_assets uuid[]:='{}';
 v_project public.projects; v_head public.identity_reference_heads; v_session public.identity_sessions;
 v_preferences public.identity_preferences; v_replay public.identity_component_changes;
 v_row public.identity_system_versions; v_base public.identity_system_versions; v_root public.identity_generated_roots;
 v_batch public.identity_batches; v_job public.jobs; v_step public.job_steps; v_input public.identity_input_snapshots;
 v_change public.identity_component_changes; v_selection public.identity_selections;
 v_now timestamptz:=pg_catalog.clock_timestamp(); v_id uuid; v_walk uuid; v_seen uuid[]; v_key text; v_counter numeric;
 v_system jsonb; v_files jsonb; v_file jsonb; v_asset jsonb; v_output jsonb; v_manifest jsonb; v_stale jsonb;
 v_context jsonb; v_reference jsonb; v_selected jsonb; v_old_snapshot jsonb; v_preference_value jsonb; v_component text;
 v_records jsonb:='[]'; v_roots jsonb:='[]'; v_sources jsonb:='[]'; v_proof_files jsonb:='[]'; v_batches jsonb;
 v_dto jsonb; v_frozen jsonb; v_reason text; v_changed jsonb; v_previous jsonb;
begin
 if pg_catalog.current_setting('request.jwt.claim.sub',true) is distinct from v_owner::text then
  raise exception 'identity_claim_mismatch' using errcode='42501'; end if;
 if p_refinement is null or pg_catalog.jsonb_typeof(p_request) is distinct from 'object' or pg_catalog.octet_length(p_request::text)>32768
  or not(p_request ?& (case when p_refinement then array['baseSystemVersionId','component','input','idempotencyKey','expectedProjectRevision','expectedReferenceRevision','expectedPreferencesRevision','expectedIdentityRevision','acceptEarlierBasis']
   else array['systemVersionId','expectedProjectRevision','expectedReferenceRevision','expectedPreferencesRevision','expectedIdentityRevision','acceptEarlierBasis'] end))
  or p_request-(case when p_refinement then array['baseSystemVersionId','component','input','idempotencyKey','expectedProjectRevision','expectedReferenceRevision','expectedPreferencesRevision','expectedIdentityRevision','acceptEarlierBasis']
   else array['systemVersionId','expectedProjectRevision','expectedReferenceRevision','expectedPreferencesRevision','expectedIdentityRevision','acceptEarlierBasis'] end)<>'{}'
  or pg_catalog.jsonb_typeof(p_request->'acceptEarlierBasis') is distinct from 'boolean'
 then raise exception 'invalid_identity_request' using errcode='22023'; end if;
 foreach v_key in array array['expectedProjectRevision','expectedReferenceRevision','expectedPreferencesRevision','expectedIdentityRevision'] loop
  if pg_catalog.jsonb_typeof(p_request->v_key) is distinct from 'number' then raise exception 'invalid_identity_fence' using errcode='22023'; end if;
  v_counter:=(p_request->>v_key)::numeric;
  if v_counter<>pg_catalog.trunc(v_counter) or v_counter<(case when v_key='expectedProjectRevision' then 1 else 0 end) or v_counter>9007199254740991 then raise exception 'invalid_identity_fence' using errcode='22023'; end if;
 end loop;
 v_target:=(p_request->>(case when p_refinement then 'baseSystemVersionId' else 'systemVersionId' end))::uuid;
 if v_target is null or (p_refinement and (p_request->>'component' not in ('colors','typography') or pg_catalog.jsonb_typeof(p_request->'input') is distinct from 'object'
  or coalesce(p_request->>'idempotencyKey','')!~'^[A-Za-z0-9._:-]{16,128}$')) then raise exception 'invalid_identity_request' using errcode='22023'; end if;

 select c.oid into v_relation from pg_catalog.pg_class c where c.relnamespace=pg_catalog.pg_my_temp_schema() and c.relname='identity_transaction_preparation';
 if v_relation is not null then
  -- Never inspect caller contents or execute a caller view before validating its owner and shape.
  if not exists(select 1 from pg_catalog.pg_class c where c.oid=v_relation and c.relowner=pg_catalog.to_regrole(current_user)::oid
  and c.relnamespace=pg_catalog.pg_my_temp_schema() and c.relkind='r' and c.relpersistence='t'
  and not exists(select 1 from pg_catalog.aclexplode(coalesce(c.relacl,pg_catalog.acldefault('r',c.relowner))) acl where acl.grantee<>c.relowner))
  or (select pg_catalog.array_agg(attname::text order by attnum) from pg_catalog.pg_attribute where attrelid=v_relation and attnum>0 and not attisdropped)
   is distinct from array['singleton','backend_pid','transaction_id','session_user_name','session_user_oid','owner_id','project_id','refinement','request','payload','consumed']
  or (select pg_catalog.array_agg(pg_catalog.format_type(atttypid,atttypmod) order by attnum) from pg_catalog.pg_attribute where attrelid=v_relation and attnum>0 and not attisdropped)
   is distinct from array['boolean','integer','xid8','name','oid','uuid','uuid','boolean','jsonb','jsonb','boolean']
  or exists(select 1 from pg_catalog.pg_attribute where attrelid=v_relation and attnum>0 and (attisdropped or not attnotnull or attacl is not null))
  or (select count(*) from pg_catalog.pg_constraint where conrelid=v_relation and contype in ('p','c'))<>2
 then raise exception 'untrusted_identity_preparation_relation' using errcode='42501'; end if;
 end if;
 if exists(select 1 from pg_catalog.pg_locks l where l.locktype='advisory' and l.database=(select oid from pg_catalog.pg_database where datname=pg_catalog.current_database())
  and l.pid=pg_catalog.pg_backend_pid() and l.classid=1229214808::oid and l.objid=pg_catalog.pg_backend_pid()::oid and l.objsubid=2 and l.granted)
 then raise exception 'identity_preparation_repeated' using errcode='PT409'; end if;
 perform pg_catalog.pg_advisory_xact_lock(1229214808,pg_catalog.pg_backend_pid());
 if v_relation is not null then raise exception 'unexpected_identity_preparation' using errcode='55000'; end if;
 create temporary table identity_transaction_preparation (
  singleton boolean primary key check(singleton),backend_pid integer not null,transaction_id xid8 not null,
  session_user_name name not null,session_user_oid oid not null,owner_id uuid not null,project_id uuid not null,
  refinement boolean not null,request jsonb not null,payload jsonb not null,consumed boolean not null
 ) on commit drop;

 select * into v_project from public.projects where id=p_project and owner_id=v_owner for update;
 if not found then raise exception 'identity_project_not_found' using errcode='P0002'; end if;
 select * into v_head from public.identity_reference_heads where project_id=p_project and owner_id=v_owner for update;
 select * into v_session from public.identity_sessions where project_id=p_project and owner_id=v_owner for update;
 if p_refinement then
  select * into v_replay from public.identity_component_changes where project_id=p_project and owner_id=v_owner and idempotency_key=p_request->>'idempotencyKey';
  if found then
   if v_replay.intent is distinct from p_request then raise exception 'identity_intent_conflict' using errcode='PT409'; end if;
   v_target:=v_replay.result_system_id;
  end if;
 end if;
 if not exists(select 1 from public.identity_system_versions where id=v_target and owner_id=v_owner and project_id=p_project) then raise exception 'identity_system_not_found' using errcode='P0002'; end if;
 -- Immutable target/base/root and accepted same-batch siblings determine the graph before source locks.
 with recursive graph(id) as (
  select v_target union
  select edge.id from graph g join public.identity_system_versions s on s.id=g.id and s.owner_id=v_owner and s.project_id=p_project
  cross join lateral (
   select s.base_system_id id union select s.root_system_id
   union select sibling.system_id from public.identity_generated_roots root join public.identity_generated_roots sibling on sibling.batch_id=root.batch_id and sibling.owner_id=root.owner_id and sibling.project_id=root.project_id
    where root.system_id=s.root_system_id and root.owner_id=v_owner and root.project_id=p_project
  ) edge where edge.id is not null
 ) select pg_catalog.array_agg(id order by id) into v_ids from graph;
 if pg_catalog.cardinality(v_ids)>1024 or (select count(*) from public.identity_system_versions where id=any(v_ids) and owner_id=v_owner and project_id=p_project)<>pg_catalog.cardinality(v_ids)
 then raise exception 'invalid_identity_graph' using errcode='55000'; end if;
 foreach v_id in array v_ids loop
  v_walk:=v_id; v_seen:='{}';
  loop
   if v_walk=any(v_seen) then raise exception 'cyclic_identity_graph' using errcode='55000'; end if;
   v_seen:=pg_catalog.array_append(v_seen,v_walk);
   select * into strict v_row from public.identity_system_versions where id=v_walk and owner_id=v_owner and project_id=p_project;
   exit when v_row.source->>'kind'='generated';
   if v_row.base_system_id is null or not(v_row.base_system_id=any(v_ids)) then raise exception 'missing_identity_base' using errcode='55000'; end if;
   v_walk:=v_row.base_system_id;
  end loop;
 end loop;
 select coalesce(pg_catalog.array_agg(distinct job_id order by job_id),'{}') into v_jobs from public.identity_generated_roots where system_id=any(v_ids) and owner_id=v_owner and project_id=p_project;
 for v_id in select id from public.jobs where id=any(v_jobs) and owner_id=v_owner and project_id=p_project order by id for share loop null; end loop;
 perform 1 from public.job_steps where job_id=any(v_jobs) and owner_id=v_owner and project_id=p_project order by job_id,step_key for share;

 for v_row in select * from public.identity_system_versions where id=any(v_ids) and owner_id=v_owner and project_id=p_project order by id loop
  v_system:=fluid_private.identity_system_json(v_row);
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('component',f.component,'role',f.role,'asset',pg_catalog.jsonb_build_object(
   'ownerId',a.owner_id,'projectId',a.project_id,'assetId',a.id,'versionId',av.id,'contentHash',av.content_hash,'purpose',a.purpose,'mimeType',av.mime_type)) order by f.slot),'[]') into v_files
   from public.identity_system_files f join public.assets a on a.id=f.asset_id and a.owner_id=f.owner_id and a.project_id=f.project_id
   join public.asset_versions av on av.id=f.version_id and av.asset_id=f.asset_id and av.owner_id=f.owner_id and av.project_id=f.project_id
   where f.system_id=v_row.id and f.owner_id=v_owner and f.project_id=p_project;
  if v_files is distinct from pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('component',null,'role','board','asset',v_row.board->'asset'))||v_row.production_files
   or exists(select 1 from (select slot,pg_catalog.row_number() over(order by slot)-1 expected from public.identity_system_files where system_id=v_row.id and owner_id=v_owner and project_id=p_project) slots where slot<>expected)
  then raise exception 'invalid_identity_file_projection' using errcode='55000'; end if;
  select v_proof_files||coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('systemVersionId',v_row.id,'slot',n-1)||value order by n),'[]') into v_proof_files from pg_catalog.jsonb_array_elements(v_files) with ordinality x(value,n);
  v_change:=null; v_selection:=null;
  if v_row.source->>'kind'='generated' then
   select * into strict v_root from public.identity_generated_roots where system_id=v_row.id and owner_id=v_owner and project_id=p_project;
   select * into strict v_batch from public.identity_batches where id=v_root.batch_id and job_id=v_root.job_id and owner_id=v_owner and project_id=p_project;
   select * into strict v_job from public.jobs where id=v_root.job_id and owner_id=v_owner and project_id=p_project;
   select * into strict v_step from public.job_steps where job_id=v_root.job_id and step_key=v_root.step_key and owner_id=v_owner and project_id=p_project;
   select * into strict v_input from public.identity_input_snapshots where id=v_batch.input_id and owner_id=v_owner and project_id=p_project;
   select context into strict v_context from public.project_revisions where project_id=p_project and owner_id=v_owner and revision=v_input.project_revision;
   select snapshot into strict v_reference from public.identity_reference_snapshots where project_id=p_project and owner_id=v_owner and reference_revision=v_input.reference_revision;
   select preferences into v_preference_value from public.identity_preferences where project_id=p_project and owner_id=v_owner and revision=v_input.preferences_revision;
   if v_input.preferences_revision is null then v_preference_value:=pg_catalog.jsonb_build_object('version',1,'creativeLocale',coalesce(v_context->>'creativeLocale','en'),'notes',coalesce(v_context#>>'{intake,identityNotes}',''),'avoidanceNotes',''); end if;
   v_output:=v_step.output->'identity';
   if v_job.operation<>'identity.image' or v_job.input_revision<>v_input.project_revision or v_step.state<>'succeeded' or v_step.completed_at is null
    or v_row.input_id<>v_input.id or v_row.root_system_id<>v_row.id or v_row.base_system_id is not null or v_row.change_id is not null
    or v_row.source is distinct from pg_catalog.jsonb_build_object('kind','generated','batchId',v_batch.id,'jobId',v_job.id,'stepKey',v_step.step_key)
    or v_step.output-'identity' is distinct from '{}'::jsonb or pg_catalog.octet_length(v_step.output::text)>1048576
    or v_output-'systems' is distinct from pg_catalog.jsonb_build_object('version',1,'operation','identity.image','ownerId',v_owner,'projectId',p_project,'batchId',v_batch.id,'jobId',v_job.id,'stepKey',v_step.step_key,'targetCount',3,'input',v_input.input)
    or pg_catalog.jsonb_typeof(v_output->'systems') is distinct from 'array' or pg_catalog.jsonb_array_length(v_output->'systems') not between 1 and 3
    or v_output#>array['systems',v_root.output_index::text] is distinct from v_system or v_root.board is distinct from v_row.board->'asset'
    or v_input.input->'referenceSnapshot' is distinct from v_reference or v_input.input->'preferences' is distinct from v_preference_value
   then raise exception 'invalid_identity_completed_graph' using errcode='55000'; end if;
   -- Full output is checked, including not-yet-accepted siblings. Normalized
   -- context/WHATWG/Naming semantics remain the explicit shared-TS boundary.
   for v_manifest in select value from pg_catalog.jsonb_array_elements(v_output->'systems') loop
    if not(v_manifest ?& array['id','ownerId','projectId','createdAt','input','source','components','board','productionFiles'])
     or v_manifest-array['id','ownerId','projectId','createdAt','input','source','components','board','productionFiles','applicationDesign'] is distinct from '{}'::jsonb
     or v_manifest->'input' is distinct from v_input.input or v_manifest->'source' is distinct from v_row.source
     or v_manifest->>'ownerId' is distinct from v_owner::text or v_manifest->>'projectId' is distinct from p_project::text
     or v_manifest#>'{board,depictsSystemVersionId}' is distinct from v_manifest->'id' or v_manifest#>'{board,staleComponents}' is distinct from '[]'::jsonb
    then raise exception 'invalid_identity_output_scope' using errcode='55000'; end if;
    for v_file in select value from pg_catalog.jsonb_array_elements(pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('asset',v_manifest#>'{board,asset}'))||(v_manifest->'productionFiles')) loop
     select pg_catalog.jsonb_build_object('ownerId',a.owner_id,'projectId',a.project_id,'assetId',a.id,'versionId',av.id,'contentHash',av.content_hash,'purpose',a.purpose,'mimeType',av.mime_type) into v_asset
      from public.asset_versions av join public.assets a on a.id=av.asset_id and a.owner_id=av.owner_id and a.project_id=av.project_id
      where av.id=(v_file#>>'{asset,versionId}')::uuid and av.asset_id=(v_file#>>'{asset,assetId}')::uuid and av.owner_id=v_owner and av.project_id=p_project;
     if v_asset is null or v_asset is distinct from v_file->'asset' or v_asset->>'purpose' not in ('brand_asset','legacy_unknown') then raise exception 'invalid_identity_output_asset' using errcode='55000'; end if;
     v_output_assets:=pg_catalog.array_append(v_output_assets,(v_asset->>'assetId')::uuid);
    end loop;
   end loop;
   if exists(select 1 from pg_catalog.jsonb_array_elements(v_output->'systems') x group by x->>'id' having count(*)>1)
    or exists(select 1 from pg_catalog.jsonb_array_elements(v_output->'systems') x group by x#>'{board,asset,versionId}' having count(*)>1)
    or exists(select 1 from pg_catalog.jsonb_array_elements(v_output->'systems') x group by x#>'{board,asset,contentHash}' having count(*)>1)
   then raise exception 'duplicate_identity_output' using errcode='55000'; end if;
   v_roots:=v_roots||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('batch',pg_catalog.jsonb_build_object('id',v_batch.id,'ownerId',v_owner,'projectId',p_project,'jobId',v_job.id,'targetCount',3,'input',v_input.input),
    'step',pg_catalog.jsonb_build_object('ownerId',v_owner,'projectId',p_project,'jobId',v_job.id,'stepKey',v_step.step_key,'state',v_step.state,'completedAt',v_step.completed_at,'output',v_step.output),
    'receipt',pg_catalog.jsonb_build_object('version',1,'ownerId',v_owner,'projectId',p_project,'batchId',v_batch.id,'jobId',v_job.id,'stepKey',v_step.step_key,'outputIndex',v_root.output_index,'systemVersionId',v_row.id,'board',v_root.board),'system',v_system));
   v_sources:=v_sources||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('systemVersionId',v_row.id,'job',pg_catalog.jsonb_build_object('id',v_job.id,'ownerId',v_owner,'projectId',p_project,'operation',v_job.operation,'inputRevision',v_job.input_revision),
    'context',v_context,'referenceSnapshot',v_reference,'preferencesRevision',coalesce(v_input.preferences_revision,0),'preferences',v_preference_value)||case when v_input.input->'version'='2' then jsonb_build_object('logoBrief',fluid_private.identity_job_logo_brief(v_owner,p_project,v_job.id)) else '{}'::jsonb end);
  else
   select * into strict v_base from public.identity_system_versions where id=v_row.base_system_id and owner_id=v_owner and project_id=p_project;
   select * into strict v_change from public.identity_component_changes where id=v_row.change_id and owner_id=v_owner and project_id=p_project;
   select * into strict v_selection from public.identity_selections where id=v_change.selection_id and owner_id=v_owner and project_id=p_project;
   v_component:=v_change.component;
   select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(component) order by n),'[]') into v_stale from pg_catalog.unnest(array['logo','colors','typography','graphics','imagery','composition']) with ordinality t(component,n)
    where component=v_component or v_base.board->'staleComponents' ? component;
   select coalesce(pg_catalog.jsonb_agg(value order by n),'[]') into v_files from pg_catalog.jsonb_array_elements(v_base.production_files) with ordinality t(value,n) where value->>'component'<>v_component;
   if v_row.input_id<>v_base.input_id or v_row.root_system_id<>v_base.root_system_id or v_change.base_system_id<>v_base.id or v_change.result_system_id<>v_row.id
    or v_row.source is distinct from pg_catalog.jsonb_build_object('kind','manual_edit','baseSystemVersionId',v_base.id,'changeId',v_change.id,'component',v_component,'editedAtProjectRevision',v_change.project_revision,'editedAtReferenceRevision',v_change.reference_revision,'editedAtPreferencesRevision',coalesce(v_change.preferences_revision,0))
    or v_change.before_value is distinct from v_base.components->v_component or v_row.components is distinct from pg_catalog.jsonb_set(v_base.components,array[v_component],v_change.after_value)
    or v_row.board is distinct from pg_catalog.jsonb_set(v_base.board,'{staleComponents}',v_stale) or v_row.production_files is distinct from v_files
    or v_selection.system_id<>v_row.id or v_selection.reason<>'refined' or v_selection.current_basis<>v_change.current_basis
    or v_selection.project_revision<>v_change.project_revision or v_selection.reference_revision<>v_change.reference_revision or v_selection.preferences_revision is distinct from v_change.preferences_revision
    or v_selection.accepted_earlier_basis<>v_change.accepted_earlier_basis or v_change.accepted_earlier_basis is distinct from (v_change.current_basis<>(fluid_private.identity_system_json(v_base)#>'{input,basis}'))
    or v_change.created_at<>v_row.created_at or v_selection.created_at<>v_change.created_at
   then raise exception 'invalid_identity_manual_graph' using errcode='55000'; end if;
  end if;
  v_records:=v_records||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('system',v_system,'rootSystemId',v_row.root_system_id,'base',v_row.base_system_id,
   'change',case when v_change.id is null then null else fluid_private.identity_change_json(v_change) end,'selection',fluid_private.identity_selection_json(v_selection)));
 end loop;
 select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('batchId',batch_id,'acceptedRootCount',amount) order by batch_id),'[]') into v_batches from
  (select batch_id,count(*) amount from public.identity_generated_roots where owner_id=v_owner and project_id=p_project and system_id=any(v_ids) group by batch_id) b;
 if pg_catalog.jsonb_array_length(v_roots)>48 or pg_catalog.jsonb_array_length(v_batches)>48 or pg_catalog.jsonb_array_length(v_proof_files)>50176
  or exists(select 1 from pg_catalog.jsonb_array_elements(v_batches) x where (x->>'acceptedRootCount')::integer not between 1 and 3)
  or exists(select 1 from public.identity_generated_roots r join public.identity_generated_roots sibling on sibling.batch_id=r.batch_id and sibling.owner_id=r.owner_id and sibling.project_id=r.project_id
    where r.system_id=any(v_ids) and r.owner_id=v_owner and r.project_id=p_project and (not(sibling.system_id=any(v_ids)) or (r.system_id<>sibling.system_id and (r.board->'versionId'=sibling.board->'versionId' or r.board->'contentHash'=sibling.board->'contentHash'))))
 then raise exception 'invalid_identity_batch_graph' using errcode='55000'; end if;
 -- Freeze the final asset set before the last lock class. No earlier lock is acquired in commit.
 select coalesce(pg_catalog.array_agg(distinct asset_id order by asset_id),'{}') into v_assets from (
  select asset_id from public.identity_system_files where system_id=any(v_ids) and owner_id=v_owner and project_id=p_project
  union select asset_id from public.identity_references where owner_id=v_owner and project_id=p_project
  union select asset_id from public.asset_usages where selection_id=v_session.current_selection_id and owner_id=v_owner and project_id=p_project
  union select pg_catalog.unnest(v_output_assets)
 ) final_assets;
 perform 1 from public.assets where id=any(v_assets) and owner_id=v_owner and project_id=p_project order by id for update;
 if (select count(*) from public.assets where id=any(v_assets) and owner_id=v_owner and project_id=p_project)<>pg_catalog.cardinality(v_assets) then raise exception 'missing_identity_asset' using errcode='55000'; end if;

 v_dto:=pg_catalog.jsonb_build_object('version',1,'principal',pg_catalog.jsonb_build_object('sessionUserName',session_user,'sessionUserOid',v_role::bigint,'boundOwnerId',v_owner),'ownerId',v_owner,'projectId',p_project,
  'proofs',pg_catalog.jsonb_build_object('records',v_records,'roots',v_roots,'rootSources',v_sources,'files',v_proof_files,'batches',v_batches));
 if v_replay.id is not null then
  select * into strict v_row from public.identity_system_versions where id=v_replay.result_system_id and owner_id=v_owner and project_id=p_project;
  select * into strict v_selection from public.identity_selections where id=v_replay.selection_id and owner_id=v_owner and project_id=p_project;
  v_dto:=v_dto||pg_catalog.jsonb_build_object('kind','replay','intent',v_replay.intent,'response',pg_catalog.jsonb_build_object('system',fluid_private.identity_system_json(v_row),'change',fluid_private.identity_change_json(v_replay),'selection',fluid_private.identity_selection_json(v_selection)));
 else
  if (p_request->>'expectedProjectRevision')::bigint<>v_project.current_revision or (p_request->>'expectedReferenceRevision')::bigint<>coalesce(v_head.reference_revision,0)
   or (p_request->>'expectedPreferencesRevision')::bigint<>coalesce(v_session.current_preferences_revision,0) or (p_request->>'expectedIdentityRevision')::bigint<>coalesce(v_session.identity_revision,0)
  then raise exception 'identity_revision_conflict' using errcode='PT409'; end if;
  select context into strict v_context from public.project_revisions where project_id=p_project and owner_id=v_owner and revision=v_project.current_revision;
  select * into v_preferences from public.identity_preferences where project_id=p_project and owner_id=v_owner and revision=v_session.current_preferences_revision;
  select coalesce(pg_catalog.jsonb_agg(fluid_private.identity_reference_entry(reference_id,p_project,v_owner) order by reference_id),'[]') into v_selected
   from public.identity_reference_reactions where project_id=p_project and owner_id=v_owner and (ensemble or pg_catalog.cardinality(elements)>0);
  if pg_catalog.jsonb_array_length(v_selected)<>coalesce(v_head.selected_reference_count,0) or exists(select 1 from public.identity_reference_reactions where project_id=p_project and owner_id=v_owner and revision>coalesce(v_head.reference_revision,0)) then raise exception 'invalid_identity_reference_head' using errcode='55000'; end if;
  select snapshot into v_old_snapshot from public.identity_reference_snapshots where project_id=p_project and owner_id=v_owner and reference_revision=coalesce(v_head.reference_revision,0);
  v_reference:=coalesce(v_old_snapshot,pg_catalog.jsonb_build_object('version',1,'ownerId',v_owner,'projectId',p_project,'referenceRevision',coalesce(v_head.reference_revision,0),'selectedReferenceCount',coalesce(v_head.selected_reference_count,0),'capturedAt',v_now,'selected',v_selected));
  if v_reference->'selected' is distinct from v_selected or v_reference->'selectedReferenceCount' is distinct from pg_catalog.to_jsonb(coalesce(v_head.selected_reference_count,0)) then raise exception 'invalid_identity_reference_snapshot' using errcode='55000'; end if;
  select fluid_private.identity_selection_json(s) into v_previous from public.identity_selections s where s.id=v_session.current_selection_id and s.owner_id=v_owner and s.project_id=p_project;
  v_reason:=case when exists(select 1 from public.identity_selections where system_id=v_target and owner_id=v_owner and project_id=p_project) then 'restored' else 'selected' end;
  v_dto:=v_dto||pg_catalog.jsonb_build_object('kind','new','project',fluid_private.asset_library_project(v_project)||pg_catalog.jsonb_build_object('context',v_context),
   'session',fluid_private.identity_session_json(v_session),'preferences',fluid_private.identity_preferences_json(v_preferences),'referenceSnapshot',v_reference,'previousSelection',v_previous,
   'targetSystemId',v_target,'selectionId',pg_catalog.gen_random_uuid(),'systemVersionId',pg_catalog.gen_random_uuid(),'changeId',pg_catalog.gen_random_uuid(),'now',v_now,'reason',v_reason)||coalesce((select jsonb_build_object('logoBrief',brief) from(select fluid_private.identity_current_logo_brief(v_owner,p_project) brief) b where brief is not null),'{}'::jsonb);
 end if;
 select pg_catalog.jsonb_build_object(
  'projects',(select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(frozen_row) order by pg_catalog.to_jsonb(frozen_row)::text),'[]') from public.projects frozen_row where owner_id=v_owner and id=p_project),
  'project_revisions',(select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(frozen_row) order by pg_catalog.to_jsonb(frozen_row)::text),'[]') from public.project_revisions frozen_row where owner_id=v_owner and project_id=p_project),
  'identity_reference_heads',(select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(frozen_row) order by pg_catalog.to_jsonb(frozen_row)::text),'[]') from public.identity_reference_heads frozen_row where owner_id=v_owner and project_id=p_project),
  'identity_sessions',(select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(frozen_row) order by pg_catalog.to_jsonb(frozen_row)::text),'[]') from public.identity_sessions frozen_row where owner_id=v_owner and project_id=p_project),
  'identity_preferences',(select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(frozen_row) order by pg_catalog.to_jsonb(frozen_row)::text),'[]') from public.identity_preferences frozen_row where owner_id=v_owner and project_id=p_project),
  'identity_references',(select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(frozen_row) order by pg_catalog.to_jsonb(frozen_row)::text),'[]') from public.identity_references frozen_row where owner_id=v_owner and project_id=p_project),
  'identity_reference_reactions',(select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(frozen_row) order by pg_catalog.to_jsonb(frozen_row)::text),'[]') from public.identity_reference_reactions frozen_row where owner_id=v_owner and project_id=p_project),
  'identity_reference_snapshots',(select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(frozen_row) order by pg_catalog.to_jsonb(frozen_row)::text),'[]') from public.identity_reference_snapshots frozen_row where owner_id=v_owner and project_id=p_project),
  'identity_system_versions',(select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(frozen_row) order by pg_catalog.to_jsonb(frozen_row)::text),'[]') from public.identity_system_versions frozen_row where owner_id=v_owner and id=any(v_ids) and project_id=p_project),
  'identity_input_snapshots',(select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(frozen_row) order by pg_catalog.to_jsonb(frozen_row)::text),'[]') from public.identity_input_snapshots frozen_row where owner_id=v_owner and id in(select input_id from public.identity_system_versions where id=any(v_ids) and owner_id=v_owner and project_id=p_project) and project_id=p_project),
  'identity_system_files',(select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(frozen_row) order by pg_catalog.to_jsonb(frozen_row)::text),'[]') from public.identity_system_files frozen_row where owner_id=v_owner and system_id=any(v_ids) and project_id=p_project),
  'identity_generated_roots',(select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(frozen_row) order by pg_catalog.to_jsonb(frozen_row)::text),'[]') from public.identity_generated_roots frozen_row where owner_id=v_owner and batch_id in(select batch_id from public.identity_generated_roots where system_id=any(v_ids) and owner_id=v_owner and project_id=p_project) and project_id=p_project),
  'identity_batches',(select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(frozen_row) order by pg_catalog.to_jsonb(frozen_row)::text),'[]') from public.identity_batches frozen_row where owner_id=v_owner and id in(select batch_id from public.identity_generated_roots where system_id=any(v_ids) and owner_id=v_owner and project_id=p_project) and project_id=p_project),
  'jobs',(select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(frozen_row) order by pg_catalog.to_jsonb(frozen_row)::text),'[]') from public.jobs frozen_row where owner_id=v_owner and id=any(v_jobs) and project_id=p_project),
  'job_steps',(select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(frozen_row) order by pg_catalog.to_jsonb(frozen_row)::text),'[]') from public.job_steps frozen_row where owner_id=v_owner and job_id=any(v_jobs) and project_id=p_project),
  'identity_component_changes',(select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(frozen_row) order by pg_catalog.to_jsonb(frozen_row)::text),'[]') from public.identity_component_changes frozen_row where owner_id=v_owner and result_system_id=any(v_ids) and project_id=p_project),
  'identity_selections',(select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(frozen_row) order by pg_catalog.to_jsonb(frozen_row)::text),'[]') from public.identity_selections frozen_row where owner_id=v_owner and project_id=p_project),
  'asset_usages',(select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(frozen_row) order by pg_catalog.to_jsonb(frozen_row)::text),'[]') from public.asset_usages frozen_row where owner_id=v_owner and project_id=p_project),
  'assets',(select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(frozen_row) order by pg_catalog.to_jsonb(frozen_row)::text),'[]') from public.assets frozen_row where owner_id=v_owner and id=any(v_assets) and project_id=p_project),
  'asset_versions',(select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(frozen_row) order by pg_catalog.to_jsonb(frozen_row)::text),'[]') from public.asset_versions frozen_row where owner_id=v_owner and asset_id=any(v_assets) and project_id=p_project)
 ) into v_frozen;
 if pg_catalog.octet_length(v_dto::text)>16777216 or pg_catalog.octet_length(v_frozen::text)>16777216 then raise exception 'identity_graph_limit' using errcode='55000'; end if;
 insert into pg_temp.identity_transaction_preparation values(true,pg_catalog.pg_backend_pid(),pg_catalog.pg_current_xact_id(),session_user,v_role,v_owner,p_project,p_refinement,p_request,
  pg_catalog.jsonb_build_object('dto',v_dto,'frozen',v_frozen,'ids',v_ids,'jobs',v_jobs,'assets',v_assets),false);
 return v_dto;
end $$;

create or replace function fluid_private.commit_identity_transaction(p_project uuid,p_request jsonb,p_proposal jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
 v_owner uuid:=fluid_private.identity_web_owner(); v_role oid:=pg_catalog.to_regrole(session_user)::oid;
 v_relation oid; v_prepared record; v_dto jsonb; v_frozen jsonb; v_ids uuid[]; v_jobs uuid[]; v_assets uuid[];
 v_input jsonb; v_basis jsonb; v_reference_basis jsonb; v_response jsonb; v_expected jsonb; v_system jsonb; v_selection jsonb; v_change jsonb;
 v_components jsonb; v_board jsonb; v_files jsonb; v_stale_components jsonb; v_freshness jsonb; v_changed jsonb;
 v_project public.projects; v_head public.identity_reference_heads; v_session public.identity_sessions; v_target public.identity_system_versions;
 v_selected public.identity_selections; v_saved_change public.identity_component_changes; v_saved_system public.identity_system_versions;
 v_previous public.identity_selections; v_now timestamptz; v_system_id uuid; v_selection_id uuid; v_change_id uuid; v_component text;
 v_project_revision bigint; v_reference_revision bigint; v_preferences_revision bigint; v_identity_revision bigint;
 v_stale boolean; v_refinement boolean; v_reason text; v_count bigint; v_expected_count bigint; v_saved_snapshot jsonb;
begin
 if pg_catalog.current_setting('request.jwt.claim.sub',true) is distinct from v_owner::text then raise exception 'identity_claim_mismatch' using errcode='42501'; end if;
 select c.oid into v_relation from pg_catalog.pg_class c where c.relnamespace=pg_catalog.pg_my_temp_schema() and c.relname='identity_transaction_preparation';
 if v_relation is null then raise exception 'identity_preparation_required' using errcode='55000'; end if;
 if not exists(select 1 from pg_catalog.pg_class c where c.oid=v_relation and c.relowner=pg_catalog.to_regrole(current_user)::oid
  and c.relnamespace=pg_catalog.pg_my_temp_schema() and c.relkind='r' and c.relpersistence='t'
  and not exists(select 1 from pg_catalog.aclexplode(coalesce(c.relacl,pg_catalog.acldefault('r',c.relowner))) acl where acl.grantee<>c.relowner))
  or (select pg_catalog.array_agg(attname::text order by attnum) from pg_catalog.pg_attribute where attrelid=v_relation and attnum>0 and not attisdropped)
   is distinct from array['singleton','backend_pid','transaction_id','session_user_name','session_user_oid','owner_id','project_id','refinement','request','payload','consumed']
  or (select pg_catalog.array_agg(pg_catalog.format_type(atttypid,atttypmod) order by attnum) from pg_catalog.pg_attribute where attrelid=v_relation and attnum>0 and not attisdropped)
   is distinct from array['boolean','integer','xid8','name','oid','uuid','uuid','boolean','jsonb','jsonb','boolean']
  or exists(select 1 from pg_catalog.pg_attribute where attrelid=v_relation and attnum>0 and (attisdropped or not attnotnull or attacl is not null))
  or (select count(*) from pg_catalog.pg_constraint where conrelid=v_relation and contype in ('p','c'))<>2
 then raise exception 'untrusted_identity_preparation_relation' using errcode='42501'; end if;
 if not exists(select 1 from pg_catalog.pg_locks l where l.locktype='advisory' and l.database=(select oid from pg_catalog.pg_database where datname=pg_catalog.current_database())
  and l.pid=pg_catalog.pg_backend_pid() and l.classid=1229214808::oid and l.objid=pg_catalog.pg_backend_pid()::oid and l.objsubid=2 and l.granted)
 then raise exception 'identity_guard_required' using errcode='55000'; end if;
 if (select count(*) from pg_temp.identity_transaction_preparation)<>1 then raise exception 'invalid_identity_preparation' using errcode='55000'; end if;
 select * into strict v_prepared from pg_temp.identity_transaction_preparation where singleton;
 if v_prepared.consumed or v_prepared.backend_pid<>pg_catalog.pg_backend_pid() or v_prepared.transaction_id<>pg_catalog.pg_current_xact_id()
  or v_prepared.session_user_name<>session_user or v_prepared.session_user_oid<>v_role or v_prepared.owner_id<>v_owner or v_prepared.project_id<>p_project
  or v_prepared.request is distinct from p_request or v_prepared.payload#>>'{dto,kind}'<>'new'
 then raise exception 'stale_identity_preparation' using errcode='55000'; end if;
 v_dto:=v_prepared.payload->'dto'; v_refinement:=v_prepared.refinement;
 select pg_catalog.array_agg(value::uuid order by value) into v_ids from pg_catalog.jsonb_array_elements_text(v_prepared.payload->'ids');
 select coalesce(pg_catalog.array_agg(value::uuid order by value),'{}') into v_jobs from pg_catalog.jsonb_array_elements_text(v_prepared.payload->'jobs');
 select coalesce(pg_catalog.array_agg(value::uuid order by value),'{}') into v_assets from pg_catalog.jsonb_array_elements_text(v_prepared.payload->'assets');
 -- No lock acquisition here: exact graph reread is bound to preparation and the already-held classes.
 select pg_catalog.jsonb_build_object(
  'projects',(select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(frozen_row) order by pg_catalog.to_jsonb(frozen_row)::text),'[]') from public.projects frozen_row where owner_id=v_owner and id=p_project),
  'project_revisions',(select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(frozen_row) order by pg_catalog.to_jsonb(frozen_row)::text),'[]') from public.project_revisions frozen_row where owner_id=v_owner and project_id=p_project),
  'identity_reference_heads',(select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(frozen_row) order by pg_catalog.to_jsonb(frozen_row)::text),'[]') from public.identity_reference_heads frozen_row where owner_id=v_owner and project_id=p_project),
  'identity_sessions',(select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(frozen_row) order by pg_catalog.to_jsonb(frozen_row)::text),'[]') from public.identity_sessions frozen_row where owner_id=v_owner and project_id=p_project),
  'identity_preferences',(select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(frozen_row) order by pg_catalog.to_jsonb(frozen_row)::text),'[]') from public.identity_preferences frozen_row where owner_id=v_owner and project_id=p_project),
  'identity_references',(select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(frozen_row) order by pg_catalog.to_jsonb(frozen_row)::text),'[]') from public.identity_references frozen_row where owner_id=v_owner and project_id=p_project),
  'identity_reference_reactions',(select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(frozen_row) order by pg_catalog.to_jsonb(frozen_row)::text),'[]') from public.identity_reference_reactions frozen_row where owner_id=v_owner and project_id=p_project),
  'identity_reference_snapshots',(select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(frozen_row) order by pg_catalog.to_jsonb(frozen_row)::text),'[]') from public.identity_reference_snapshots frozen_row where owner_id=v_owner and project_id=p_project),
  'identity_system_versions',(select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(frozen_row) order by pg_catalog.to_jsonb(frozen_row)::text),'[]') from public.identity_system_versions frozen_row where owner_id=v_owner and id=any(v_ids) and project_id=p_project),
  'identity_input_snapshots',(select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(frozen_row) order by pg_catalog.to_jsonb(frozen_row)::text),'[]') from public.identity_input_snapshots frozen_row where owner_id=v_owner and id in(select input_id from public.identity_system_versions where id=any(v_ids) and owner_id=v_owner and project_id=p_project) and project_id=p_project),
  'identity_system_files',(select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(frozen_row) order by pg_catalog.to_jsonb(frozen_row)::text),'[]') from public.identity_system_files frozen_row where owner_id=v_owner and system_id=any(v_ids) and project_id=p_project),
  'identity_generated_roots',(select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(frozen_row) order by pg_catalog.to_jsonb(frozen_row)::text),'[]') from public.identity_generated_roots frozen_row where owner_id=v_owner and batch_id in(select batch_id from public.identity_generated_roots where system_id=any(v_ids) and owner_id=v_owner and project_id=p_project) and project_id=p_project),
  'identity_batches',(select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(frozen_row) order by pg_catalog.to_jsonb(frozen_row)::text),'[]') from public.identity_batches frozen_row where owner_id=v_owner and id in(select batch_id from public.identity_generated_roots where system_id=any(v_ids) and owner_id=v_owner and project_id=p_project) and project_id=p_project),
  'jobs',(select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(frozen_row) order by pg_catalog.to_jsonb(frozen_row)::text),'[]') from public.jobs frozen_row where owner_id=v_owner and id=any(v_jobs) and project_id=p_project),
  'job_steps',(select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(frozen_row) order by pg_catalog.to_jsonb(frozen_row)::text),'[]') from public.job_steps frozen_row where owner_id=v_owner and job_id=any(v_jobs) and project_id=p_project),
  'identity_component_changes',(select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(frozen_row) order by pg_catalog.to_jsonb(frozen_row)::text),'[]') from public.identity_component_changes frozen_row where owner_id=v_owner and result_system_id=any(v_ids) and project_id=p_project),
  'identity_selections',(select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(frozen_row) order by pg_catalog.to_jsonb(frozen_row)::text),'[]') from public.identity_selections frozen_row where owner_id=v_owner and project_id=p_project),
  'asset_usages',(select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(frozen_row) order by pg_catalog.to_jsonb(frozen_row)::text),'[]') from public.asset_usages frozen_row where owner_id=v_owner and project_id=p_project),
  'assets',(select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(frozen_row) order by pg_catalog.to_jsonb(frozen_row)::text),'[]') from public.assets frozen_row where owner_id=v_owner and id=any(v_assets) and project_id=p_project),
  'asset_versions',(select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(frozen_row) order by pg_catalog.to_jsonb(frozen_row)::text),'[]') from public.asset_versions frozen_row where owner_id=v_owner and asset_id=any(v_assets) and project_id=p_project)
 ) into v_frozen;
 if v_frozen is distinct from v_prepared.payload->'frozen' then raise exception 'identity_graph_changed' using errcode='55000'; end if;
 select * into strict v_project from public.projects where id=p_project and owner_id=v_owner;
 select * into v_head from public.identity_reference_heads where project_id=p_project and owner_id=v_owner;
 select * into v_session from public.identity_sessions where project_id=p_project and owner_id=v_owner;
 select * into strict v_target from public.identity_system_versions where id=(v_dto->>'targetSystemId')::uuid and owner_id=v_owner and project_id=p_project;
 v_project_revision:=(p_request->>'expectedProjectRevision')::bigint; v_reference_revision:=(p_request->>'expectedReferenceRevision')::bigint;
 v_preferences_revision:=(p_request->>'expectedPreferencesRevision')::bigint; v_identity_revision:=(p_request->>'expectedIdentityRevision')::bigint;
 if v_project_revision<>v_project.current_revision or v_reference_revision<>coalesce(v_head.reference_revision,0)
  or v_preferences_revision<>coalesce(v_session.current_preferences_revision,0) or v_identity_revision<>coalesce(v_session.identity_revision,0) or v_identity_revision>=9007199254740991
 then raise exception 'identity_revision_conflict' using errcode='PT409'; end if;
 v_input:=p_proposal->'currentInput'; v_basis:=v_input->'basis'; v_response:=p_proposal->'response';
 if p_proposal-array['version','kind','currentInput','response'] is distinct from '{}'::jsonb or p_proposal->'version' is distinct from '1'::jsonb
  or p_proposal->>'kind' is distinct from (case when v_refinement then 'refinement' else 'selection' end)
  or pg_catalog.octet_length(p_proposal::text)>16777216
  or v_input-array['version','ownerId','projectId','scope','projectRevision','context','referenceSnapshot','preferencesRevision','preferences','capturedAt','basis','logoBrief'] is distinct from '{}'::jsonb
  or v_input->'version' is distinct from (case when v_dto?'logoBrief' then '2'::jsonb else '1'::jsonb end) or v_input->'logoBrief' is distinct from v_dto->'logoBrief' or v_input->>'ownerId' is distinct from v_owner::text or v_input->>'projectId' is distinct from p_project::text
  or v_input->>'scope' is distinct from v_project.scope::text or v_input->'projectRevision' is distinct from pg_catalog.to_jsonb(v_project_revision)
  or v_input->'referenceSnapshot' is distinct from v_dto->'referenceSnapshot' or v_input->'preferencesRevision' is distinct from pg_catalog.to_jsonb(v_preferences_revision)
  or v_input->'capturedAt' is distinct from v_dto->'now' or pg_catalog.jsonb_typeof(v_input->'context') is distinct from 'object'
  or pg_catalog.jsonb_typeof(v_input->'preferences') is distinct from 'object' or pg_catalog.jsonb_typeof(v_basis) is distinct from 'object'
  or v_basis->'version' is distinct from v_input->'version' or v_basis->'logoBrief' is distinct from v_input->'logoBrief' or v_basis->>'ownerId' is distinct from v_owner::text or v_basis->>'projectId' is distinct from p_project::text
  or v_basis->'preferences' is distinct from v_input->'preferences' or (v_preferences_revision>0 and v_input->'preferences' is distinct from v_dto#>'{preferences,preferences}')
 then raise exception 'invalid_identity_proposal_input' using errcode='55000'; end if;
 -- Shared TypeScript owns normalized context/material-basis and complete Naming/WHATWG semantics.
 -- SQL binds that projection to the exact owner, four heads, stored references and preferences.
 select pg_catalog.jsonb_build_object('version',1,'ownerId',v_owner,'projectId',p_project,'references',coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
  'referenceId',value#>'{reference,id}','media',value#>'{reference,media}','ensemble',value#>'{reaction,ensemble}','elements',value#>'{reaction,elements}') order by value#>>'{reference,id}'),'[]')) into v_reference_basis
  from pg_catalog.jsonb_array_elements(v_dto#>'{referenceSnapshot,selected}');
 if v_basis->'referenceBasis' is distinct from v_reference_basis then raise exception 'invalid_identity_reference_basis' using errcode='55000'; end if;
 v_system:=fluid_private.identity_system_json(v_target);
 select * into v_previous from public.identity_selections where id=v_session.current_selection_id and owner_id=v_owner and project_id=p_project;
 if v_project_revision<coalesce((v_target.source->>'editedAtProjectRevision')::bigint,(v_system#>>'{input,projectRevision}')::bigint)
  or v_reference_revision<coalesce((v_target.source->>'editedAtReferenceRevision')::bigint,(v_system#>>'{input,referenceSnapshot,referenceRevision}')::bigint)
  or v_preferences_revision<coalesce((v_target.source->>'editedAtPreferencesRevision')::bigint,(v_system#>>'{input,preferencesRevision}')::bigint)
  or (v_previous.id is not null and (v_previous.identity_revision<>v_identity_revision or v_previous.project_revision>v_project_revision or v_previous.reference_revision>v_reference_revision or coalesce(v_previous.preferences_revision,0)>v_preferences_revision))
  or (v_previous.id is null and v_identity_revision<>0)
 then raise exception 'identity_creation_revision_conflict' using errcode='PT409'; end if;
 v_stale:=v_system#>'{input,basis}'<>v_basis;
 if v_stale and p_request->'acceptEarlierBasis'<>'true'::jsonb then raise exception 'identity_earlier_basis_required' using errcode='PT409'; end if;
 v_now:=(v_dto->>'now')::timestamptz; v_selection_id:=(v_dto->>'selectionId')::uuid; v_change_id:=(v_dto->>'changeId')::uuid;
 v_system_id:=case when v_refinement then (v_dto->>'systemVersionId')::uuid else v_target.id end;
 v_reason:=case when v_refinement then 'refined' else v_dto->>'reason' end;
 v_selection:=pg_catalog.jsonb_build_object('id',v_selection_id,'ownerId',v_owner,'projectId',p_project,'systemVersionId',v_system_id,
  'identityRevision',v_identity_revision+1,'projectRevision',v_project_revision,'referenceRevision',v_reference_revision,'preferencesRevision',v_preferences_revision,
  'currentBasis',v_basis,'acceptedEarlierBasis',v_stale,'previousSelectionId',v_previous.id,'reason',v_reason,'createdAt',v_now);
 if v_refinement then
  v_component:=p_request->>'component';
  if v_target.components->v_component is not distinct from p_request->'input' then raise exception 'identity_edit_must_change' using errcode='22023'; end if;
  v_components:=pg_catalog.jsonb_set(v_target.components,array[v_component],p_request->'input');
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(component) order by n),'[]') into v_stale_components
   from pg_catalog.unnest(array['logo','colors','typography','graphics','imagery','composition']) with ordinality x(component,n) where component=v_component or v_target.board->'staleComponents' ? component;
  v_board:=pg_catalog.jsonb_set(v_target.board,'{staleComponents}',v_stale_components);
  select coalesce(pg_catalog.jsonb_agg(value order by n),'[]') into v_files from pg_catalog.jsonb_array_elements(v_target.production_files) with ordinality x(value,n) where value->>'component'<>v_component;
  v_change:=pg_catalog.jsonb_build_object('id',v_change_id,'ownerId',v_owner,'projectId',p_project,'baseSystemVersionId',v_target.id,'resultSystemVersionId',v_system_id,
   'projectRevision',v_project_revision,'referenceRevision',v_reference_revision,'preferencesRevision',v_preferences_revision,'currentBasis',v_basis,'acceptedEarlierBasis',v_stale,
   'component',v_component,'before',v_target.components->v_component,'after',p_request->'input','provenance',pg_catalog.jsonb_build_object('kind','user_edit','actorId',v_owner),'createdAt',v_now);
  v_system:=v_system||pg_catalog.jsonb_build_object('id',v_system_id,'createdAt',v_dto->'now','source',pg_catalog.jsonb_build_object('kind','manual_edit','baseSystemVersionId',v_target.id,'changeId',v_change_id,'component',v_component,
   'editedAtProjectRevision',v_project_revision,'editedAtReferenceRevision',v_reference_revision,'editedAtPreferencesRevision',v_preferences_revision),'components',v_components,'board',v_board,'productionFiles',v_files);
  v_expected:=pg_catalog.jsonb_build_object('system',v_system,'change',v_change,'selection',v_selection);
 else
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(label) order by n),'[]') into v_changed from
   (values ('strategy','strategy',1),('name','name',2),('references','referenceBasis',3),('preferences','preferences',4),('logoBrief','logoBrief',5)) x(label,key,n)
   where v_system#>array['input','basis',key] is distinct from v_basis->key;
  v_freshness:=pg_catalog.jsonb_build_object('status',case when pg_catalog.jsonb_array_length(v_changed)=0 then 'current' else 'stale' end,'changed',v_changed);
  v_expected:=pg_catalog.jsonb_build_object('session',pg_catalog.jsonb_build_object('ownerId',v_owner,'projectId',p_project,'identityRevision',v_identity_revision+1,
   'currentSelectionId',v_selection_id,'currentPreferencesRevision',v_preferences_revision,'createdAt',coalesce(v_session.created_at,v_now),'updatedAt',v_now),
   'currentSelection',pg_catalog.jsonb_build_object('selection',v_selection,'system',v_system,'freshness',v_freshness));
 end if;
 if v_response is distinct from v_expected then raise exception 'invalid_identity_transition_projection' using errcode='55000'; end if;

 if v_session.project_id is null then
  insert into public.identity_sessions(project_id,owner_id,created_at,updated_at) values(p_project,v_owner,v_now,v_now);
  get diagnostics v_count=row_count;
  if v_count<>1 then raise exception 'identity_session_write_count' using errcode='55000'; end if;
 end if;
 select snapshot into v_saved_snapshot from public.identity_reference_snapshots where project_id=p_project and owner_id=v_owner and reference_revision=v_reference_revision;
 if found then
  if v_saved_snapshot is distinct from v_dto->'referenceSnapshot' then raise exception 'identity_snapshot_changed' using errcode='55000'; end if;
 else
  insert into public.identity_reference_snapshots(project_id,owner_id,reference_revision,snapshot) values(p_project,v_owner,v_reference_revision,v_dto->'referenceSnapshot');
  get diagnostics v_count=row_count;
  if v_count<>1 then raise exception 'identity_snapshot_write_count' using errcode='55000'; end if;
 end if;
 if v_refinement then
  insert into public.identity_system_versions(id,project_id,owner_id,input_id,root_system_id,base_system_id,change_id,source,components,board,production_files,created_at,created_at_text)
   values(v_system_id,p_project,v_owner,v_target.input_id,v_target.root_system_id,v_target.id,v_change_id,v_system->'source',v_components,v_board,v_files,v_now,v_dto->>'now');
  get diagnostics v_count=row_count;
  if v_count<>1 then raise exception 'identity_system_write_count' using errcode='55000'; end if;
  insert into public.identity_system_files(system_id,slot,project_id,owner_id,component,role,asset_id,version_id)
   select v_system_id,(n-1)::integer,p_project,v_owner,value->>'component',value->>'role',(value#>>'{asset,assetId}')::uuid,(value#>>'{asset,versionId}')::uuid
   from pg_catalog.jsonb_array_elements(pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('component',null,'role','board','asset',v_board->'asset'))||v_files) with ordinality x(value,n);
  get diagnostics v_count=row_count;
  if v_count<>pg_catalog.jsonb_array_length(v_files)+1 then raise exception 'identity_file_write_count' using errcode='55000'; end if;
 end if;
 insert into public.identity_selections(id,project_id,owner_id,system_id,identity_revision,project_revision,reference_revision,preferences_revision,current_basis,accepted_earlier_basis,previous_selection_id,reason,created_at)
  values(v_selection_id,p_project,v_owner,v_system_id,v_identity_revision+1,v_project_revision,v_reference_revision,nullif(v_preferences_revision,0),v_basis,v_stale,v_previous.id,v_reason,v_now) returning * into v_selected;
 get diagnostics v_count=row_count;
 if v_count<>1 or fluid_private.identity_selection_json(v_selected) is distinct from v_selection then raise exception 'identity_selection_receipt' using errcode='55000'; end if;
 select count(*) into v_expected_count from public.identity_system_files where system_id=v_system_id and owner_id=v_owner and project_id=p_project;
 insert into public.asset_usages(selection_id,system_id,slot,project_id,owner_id,asset_id,version_id)
  select v_selection_id,system_id,slot,project_id,owner_id,asset_id,version_id from public.identity_system_files where system_id=v_system_id and owner_id=v_owner and project_id=p_project;
 get diagnostics v_count=row_count;
 if v_count<>v_expected_count then raise exception 'identity_usage_write_count' using errcode='55000'; end if;
 if v_refinement then
  insert into public.identity_component_changes(id,project_id,owner_id,base_system_id,result_system_id,selection_id,component,before_value,after_value,project_revision,reference_revision,preferences_revision,current_basis,accepted_earlier_basis,idempotency_key,intent,created_at)
   values(v_change_id,p_project,v_owner,v_target.id,v_system_id,v_selection_id,v_component,v_target.components->v_component,p_request->'input',v_project_revision,v_reference_revision,nullif(v_preferences_revision,0),v_basis,v_stale,p_request->>'idempotencyKey',p_request,v_now) returning * into v_saved_change;
  get diagnostics v_count=row_count;
  if v_count<>1 or fluid_private.identity_change_json(v_saved_change) is distinct from v_change then raise exception 'identity_change_receipt' using errcode='55000'; end if;
 end if;
 update public.identity_sessions set identity_revision=v_identity_revision+1,current_selection_id=v_selection_id,updated_at=v_now
  where project_id=p_project and owner_id=v_owner and identity_revision=v_identity_revision and coalesce(current_preferences_revision,0)=v_preferences_revision and current_selection_id is not distinct from v_previous.id returning * into v_session;
 get diagnostics v_count=row_count;
 if v_count<>1 then raise exception 'identity_head_cas' using errcode='PT409'; end if;
 if exists(select 1 from public.asset_usages where selection_id in(v_previous.id,v_selection_id) and owner_id=v_owner and project_id=p_project and not(asset_id=any(v_assets))) then raise exception 'unprepared_identity_asset' using errcode='55000'; end if;
 select count(distinct asset_id) into v_expected_count from public.asset_usages where selection_id in(v_previous.id,v_selection_id) and owner_id=v_owner and project_id=p_project;
 update public.assets a set used=(a.legacy_used or exists(select 1 from public.asset_usages u join public.identity_sessions h on h.current_selection_id=u.selection_id and h.project_id=u.project_id and h.owner_id=u.owner_id
   where u.asset_id=a.id and u.owner_id=a.owner_id and u.project_id=a.project_id))
  where a.id=any(v_assets) and a.owner_id=v_owner and a.project_id=p_project and a.id in(select asset_id from public.asset_usages where selection_id in(v_previous.id,v_selection_id) and owner_id=v_owner and project_id=p_project);
 get diagnostics v_count=row_count;
 if v_count<>v_expected_count then raise exception 'identity_asset_write_count' using errcode='55000'; end if;
 select * into strict v_saved_system from public.identity_system_versions where id=v_system_id and owner_id=v_owner and project_id=p_project;
 v_response:=case when v_refinement then pg_catalog.jsonb_build_object('system',fluid_private.identity_system_json(v_saved_system),'change',fluid_private.identity_change_json(v_saved_change),'selection',fluid_private.identity_selection_json(v_selected))
  else pg_catalog.jsonb_build_object('session',fluid_private.identity_session_json(v_session),'currentSelection',pg_catalog.jsonb_build_object('selection',fluid_private.identity_selection_json(v_selected),'system',fluid_private.identity_system_json(v_saved_system),'freshness',v_freshness)) end;
 if v_response is distinct from v_expected then raise exception 'identity_persisted_receipt_mismatch' using errcode='55000'; end if;
 update pg_temp.identity_transaction_preparation set consumed=true where singleton and not consumed;
 get diagnostics v_count=row_count;
 if v_count<>1 then raise exception 'identity_preparation_consumed' using errcode='55000'; end if;
 return v_response;
end $$;

revoke fluid_identity_writer_definer_v1 from postgres granted by postgres;

-- Uncapped Identity admissions have no legacy reservation to settle. All other operations retain their existing cancellation path.
do $identity_cancel$ declare d text;fragment text:='perform fluid_private.settle_reservation(p_job_id);';begin
 d:=pg_get_functiondef('public.request_job_cancel(uuid)'::regprocedure);
 if (length(d)-length(replace(d,fragment,'')))/length(fragment)<>1 then raise exception 'identity_cancel_predecessor_changed';end if;
 execute replace(d,fragment,'if not fluid_private.shared_identity_job(v_job) then perform fluid_private.settle_reservation(p_job_id);end if;');
end $identity_cancel$;

-- Strip hostile default privileges from every new object before granting the narrow readers.
do $new_acl$ declare item record;begin
 for item in select p.oid::regprocedure signature,a.grantee from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
 where ((n.nspname='fluid_private' and p.proname in('shared_identity_logo_source_valid','shared_identity_selected_logo','identity_logo_basis','identity_current_logo_brief','identity_job_logo_brief','identity_board_contrast_ratio','identity_application_design_valid','identity_board_typography_valid','identity_selection_current_logo','identity_inherit_application_design'))
 or n.nspname='public' and p.proname='get_identity_logo_source') and a.grantee<>p.proowner loop
  execute format('revoke all on function %s from %s cascade',item.signature,case when item.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(item.grantee)) end);
 end loop;
 for item in select a.grantee from pg_class c cross join lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
 where c.oid='fluid_private.identity_system_applications'::regclass and a.grantee<>c.relowner loop
  execute format('revoke all on table fluid_private.identity_system_applications from %s cascade',case when item.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(item.grantee)) end);
 end loop;
end $new_acl$;
grant select on table fluid_private.identity_system_applications to fluid_identity_writer_definer_v1;
grant execute on function fluid_private.identity_current_logo_brief(uuid,uuid),fluid_private.identity_job_logo_brief(uuid,uuid,uuid),fluid_private.identity_application_design_valid(jsonb,jsonb),fluid_private.identity_board_contrast_ratio(text,text) to fluid_identity_writer_definer_v1;
grant execute on function public.get_identity_logo_source(uuid,uuid) to authenticated;

commit;
