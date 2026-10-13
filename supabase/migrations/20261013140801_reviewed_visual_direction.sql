-- Reviewed catalog guidance is text plus attribution. It never becomes private
-- media, logo geometry, a licensed font, a generated asset or authorization data.
begin;
create table public.project_visual_directions (
 id uuid primary key default gen_random_uuid(), owner_id uuid not null, project_id uuid not null,
 revision bigint not null check(revision between 1 and 9007199254740991),
 record jsonb not null check(jsonb_typeof(record)='object' and octet_length(record::text)<=32768),
 unique(owner_id,project_id,revision),
 foreign key(project_id,owner_id) references public.projects(id,owner_id),
 check(record->>'id'=id::text and record->>'ownerId'=owner_id::text and record->>'projectId'=project_id::text and (record->>'revision')::bigint=revision)
);
alter table public.project_visual_directions enable row level security;
alter table public.project_visual_directions force row level security;
revoke all on public.project_visual_directions from public,anon,authenticated,service_role;
grant select on public.project_visual_directions to authenticated;
create policy owned_read on public.project_visual_directions for select to authenticated using(owner_id=(select auth.uid()));
create trigger project_visual_directions_immutable before update or delete on public.project_visual_directions
 for each row execute function fluid_private.prevent_history_change();

create function fluid_private.visual_direction_latest(p_owner uuid,p_project uuid) returns jsonb
language sql stable set search_path='' as $$
 select record from public.project_visual_directions where owner_id=p_owner and project_id=p_project order by revision desc limit 1
$$;
create function fluid_private.visual_direction_source_current(p_owner uuid,p_project uuid,p_source jsonb) returns boolean
language plpgsql stable set search_path='' as $$
declare latest jsonb; project_revision bigint; selection_revision bigint;
begin
 select current_revision into project_revision from public.projects where owner_id=p_owner and id=p_project;
 if not found then return false;end if;
 latest:=fluid_private.visual_direction_latest(p_owner,p_project);
 if p_source is null then
  return latest is null and not exists(select 1 from public.project_inspiration_choices where owner_id=p_owner and project_id=p_project and (ensemble or cardinality(elements)>0));
 end if;
 select coalesce((select revision from public.project_inspiration_heads where owner_id=p_owner and project_id=p_project),0) into selection_revision;
 return coalesce(p_source=latest and (p_source->>'projectRevision')::bigint=project_revision and (p_source->>'selectionRevision')::bigint=selection_revision and p_source->>'catalogVersion'='2026-10-13.1',false);
end $$;
create function public.get_project_visual_direction(p_project_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare owner uuid:=auth.uid(); inspiration jsonb; current_direction jsonb; history jsonb;
begin
 -- This read also verifies an authenticated owner and existing project.
 inspiration:=public.get_project_inspiration(p_project_id);
 current_direction:=fluid_private.visual_direction_latest(owner,p_project_id);
 select coalesce(jsonb_agg(record order by revision desc),'[]') into history from
  (select record,revision from public.project_visual_directions where owner_id=owner and project_id=p_project_id and revision<(current_direction->>'revision')::bigint order by revision desc limit 20) h;
 return jsonb_build_object('inspiration',inspiration,'current',current_direction,'history',history,
  'hasEarlierHistory',coalesce((current_direction->>'revision')::bigint,0)>21,
  'stale',current_direction is not null and not fluid_private.visual_direction_source_current(owner,p_project_id,current_direction));
end $$;
create function public.review_project_visual_direction(p_project_id uuid,p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare owner uuid:=auth.uid(); project public.projects; latest jsonb; guidance jsonb; refs jsonb; next_id uuid:=gen_random_uuid();
 expected numeric; expected_project numeric; expected_selection numeric; selection_revision bigint; field text; value text; revision bigint;
begin
 -- All inspiration/project/review writers acquire this same project lock first.
 select * into project from public.projects where id=p_project_id and owner_id=owner for update;
 if not found then raise exception 'project_not_found' using errcode='P0002';end if;
 if project.scope='naming_only' then raise exception 'visual_direction_scope' using errcode='22023';end if;
 if not fluid_private.standalone_keys(p_input,array['expectedRevision','expectedProjectRevision','expectedSelectionRevision','catalogVersion','guidance']) or octet_length(p_input::text)>32768
  or jsonb_typeof(p_input->'expectedRevision') is distinct from 'number' or jsonb_typeof(p_input->'expectedProjectRevision') is distinct from 'number'
  or jsonb_typeof(p_input->'expectedSelectionRevision') is distinct from 'number' then raise exception 'invalid_visual_direction' using errcode='22023';end if;
 expected:=(p_input->>'expectedRevision')::numeric;expected_project:=(p_input->>'expectedProjectRevision')::numeric;expected_selection:=(p_input->>'expectedSelectionRevision')::numeric;
 if expected not between 0 and 9007199254740990 or expected<>trunc(expected) or expected_project not between 1 and 9007199254740991 or expected_project<>trunc(expected_project)
  or expected_selection not between 0 and 9007199254740991 or expected_selection<>trunc(expected_selection) then raise exception 'invalid_visual_direction_revision' using errcode='22023';end if;
 guidance:=p_input->'guidance';
 if not fluid_private.standalone_keys(guidance,array['character','colors','typography','graphics']) then raise exception 'invalid_visual_guidance' using errcode='22023';end if;
 foreach field in array array['character','colors','typography','graphics'] loop
  value:=guidance->>field;
  -- Match the JS schema's UTF-16 length and ECMAScript trim, including astral
  -- characters. Direct RPC calls cannot persist a value the reader rejects.
  if jsonb_typeof(guidance->field) is distinct from 'string' or char_length(value)+(select count(*) from regexp_split_to_table(value,'') c where ascii(nullif(c,''))>65535)>1200
   or value ~ '[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]' or value<>btrim(value,E' \t\r\n'||chr(11)||chr(12)||chr(160)||chr(5760)||chr(8192)||chr(8193)||chr(8194)||chr(8195)||chr(8196)||chr(8197)||chr(8198)||chr(8199)||chr(8200)||chr(8201)||chr(8202)||chr(8232)||chr(8233)||chr(8239)||chr(8287)||chr(12288)||chr(65279)) then raise exception 'invalid_visual_guidance' using errcode='22023';end if;
 end loop;
 latest:=fluid_private.visual_direction_latest(owner,p_project_id);
 select coalesce((select h.revision from public.project_inspiration_heads h where h.owner_id=owner and h.project_id=p_project_id),0) into selection_revision;
 if expected<>coalesce((latest->>'revision')::bigint,0) or expected_project<>project.current_revision or expected_selection<>selection_revision or p_input->>'catalogVersion' is distinct from '2026-10-13.1'
  then raise exception 'visual_direction_changed' using errcode='PT409';end if;
 select coalesce(jsonb_agg(jsonb_build_object('referenceId',c.reference_id,'brand',a.descriptor->'brand','creator',a.descriptor->'creator',
  'description',a.descriptor->'description','sourceUrl',a.descriptor->'sourceUrl','contentHash',a.descriptor->'contentHash','ensemble',c.ensemble,'elements',c.elements) order by c.reference_id),'[]') into refs
  from public.project_inspiration_choices c join fluid_private.inspiration_catalog a on a.id=c.reference_id
  where c.owner_id=owner and c.project_id=p_project_id and (c.ensemble or cardinality(c.elements)>0);
 if refs='[]' and not exists(select 1 from jsonb_each_text(guidance) t where t.value<>'') then raise exception 'visual_direction_empty' using errcode='22023';end if;
 revision:=expected::bigint+1;
 insert into public.project_visual_directions(id,owner_id,project_id,revision,record) values(next_id,owner,p_project_id,revision,
  jsonb_build_object('id',next_id,'ownerId',owner,'projectId',p_project_id,'revision',revision,'projectRevision',project.current_revision,'selectionRevision',selection_revision,
   'catalogVersion','2026-10-13.1','guidance',guidance,'references',refs,'reviewedAt',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));
 return public.get_project_visual_direction(p_project_id);
end $$;

-- Preserve the established complete source constructor; add reviewed guidance
-- only when one exists. Existing projects without likes/reviews remain valid.
alter function fluid_private.logo_prepare_direction_sources(uuid,uuid,uuid) rename to logo_prepare_direction_sources_before_visual_direction;
create function fluid_private.logo_prepare_direction_sources(p_owner uuid,p_project uuid,p_approval uuid) returns jsonb
language plpgsql stable set search_path='' as $$
declare source jsonb; review jsonb; workspace jsonb;
begin
 source:=fluid_private.logo_prepare_direction_sources_before_visual_direction(p_owner,p_project,p_approval);
 workspace:=fluid_private.logo_workspace_json(p_owner,p_project);
 if exists(select 1 from jsonb_array_elements(workspace->'staleStages') s where s->>'stage' in('brief_references','vector')) then raise exception 'current_logo_review_required' using errcode='PT409';end if;
 review:=fluid_private.visual_direction_latest(p_owner,p_project);
 if not fluid_private.visual_direction_source_current(p_owner,p_project,review) then raise exception 'visual_direction_review_required' using errcode='PT409';end if;
 return case when review is null then source else source||jsonb_build_object('reviewedVisualDirection',review) end;
end $$;
create or replace function fluid_private.logo_freeze_direction_inputs(p_job public.jobs,p_source jsonb) returns void language plpgsql set search_path='' as $$
declare q public.logo_cost_quotes;
begin
 select * into q from public.logo_cost_quotes where id=(p_job.input->>'quoteId')::uuid and owner_id=p_job.owner_id and project_id=p_job.project_id;
 if p_job.operation<>'identity.logo_directions' or p_source is distinct from q.source_inputs->'direction' or p_source#>>'{approvedLogo,id}' is distinct from p_job.input->>'approvedLogoId' or p_source#>>'{brief,id}' is distinct from p_job.input->>'briefRevisionId' or p_source#>>'{references,id}' is distinct from p_job.input->>'referenceSnapshotId' then raise exception 'direction_input_mismatch' using errcode='55000';end if;
 -- Called inside admission's project-locked transaction. A changed review or
 -- font set rolls back the job, budget reservation and request together.
 if p_source is distinct from fluid_private.logo_prepare_direction_sources(p_job.owner_id,p_job.project_id,(p_job.input->>'approvedLogoId')::uuid) then raise exception 'direction_quote_sources_changed' using errcode='PT409';end if;
 insert into public.logo_direction_inputs(job_id,owner_id,project_id,input_hash,source) values(p_job.id,p_job.owner_id,p_job.project_id,p_job.input_hash,p_source);
end $$;

create function fluid_private.logo_direction_visual_basis_current(p_owner uuid,p_project uuid,p_ids jsonb) returns boolean
language plpgsql stable set search_path='' as $$
declare item_id jsonb; source jsonb;
begin
 for item_id in select value from jsonb_array_elements(p_ids) loop
  select i.source into source from public.logo_direction_records r
   left join public.logo_direction_publications p on p.id=r.publication_id and p.owner_id=r.owner_id and p.project_id=r.project_id
   left join public.logo_direction_inputs i on i.job_id=p.job_id and i.owner_id=p.owner_id and i.project_id=p.project_id
   where r.id=(item_id#>>'{}')::uuid and r.owner_id=p_owner and r.project_id=p_project;
  if not found or not fluid_private.visual_direction_source_current(p_owner,p_project,source->'reviewedVisualDirection') then return false;end if;
 end loop;
 return true;
end $$;
alter function fluid_private.logo_workspace_json(uuid,uuid) rename to logo_workspace_json_before_visual_direction;
create function fluid_private.logo_workspace_json(p_owner uuid,p_project uuid) returns jsonb
language plpgsql stable set search_path='' as $$
declare workspace jsonb; stage jsonb; key text; stages jsonb;
begin
 workspace:=fluid_private.logo_workspace_json_before_visual_direction(p_owner,p_project);
 select record into stage from public.logo_stage_revisions where id=(workspace#>>'{stages,directions,id}')::uuid and owner_id=p_owner and project_id=p_project;
 if stage is not null and not fluid_private.logo_direction_visual_basis_current(p_owner,p_project,stage#>'{payload,directionIds}') then
  stages:=workspace->'staleStages';
  foreach key in array array['directions','deliverables'] loop
   if workspace#>>array['stages',key,'id'] is not null and not exists(select 1 from jsonb_array_elements(stages) s where s->>'stage'=key) then
    stages:=stages||jsonb_build_array(jsonb_build_object('stage',key,'reasons',jsonb_build_array('Reviewed visual direction or saved inspiration changed.')));
   end if;
  end loop;
  workspace:=jsonb_set(workspace,'{staleStages}',stages);
 end if;
 return workspace;
end $$;
alter function fluid_private.logo_direction_selection_sources(uuid,uuid,jsonb) rename to logo_direction_selection_sources_before_visual_direction;
create function fluid_private.logo_direction_selection_sources(p_owner uuid,p_project uuid,p_body jsonb) returns jsonb
language plpgsql stable set search_path='' as $$
declare source jsonb;
begin
 source:=fluid_private.logo_direction_selection_sources_before_visual_direction(p_owner,p_project,p_body);
 if not fluid_private.logo_direction_visual_basis_current(p_owner,p_project,jsonb_build_array(p_body->'paletteVersionId',p_body->'typographyVersionId',p_body->'graphicsVersionId')) then source:=jsonb_set(source,'{stale}','true');end if;
 return source;
end $$;

-- Exact predecessor: 20261007020000_logo_directions_subscription.sql. Preserve
-- provider receipts, paid/subscription accounting, cancellation and immutable
-- retention. Only the current-head condition gains the reviewed-source check.
create or replace function fluid_private.logo_commit_direction_publication(p_job public.jobs,p_publication uuid,p_provider_receipt uuid) returns jsonb language plpgsql set search_path='' as $$
declare j public.jobs;p public.logo_direction_publications;s public.logo_direction_inputs;r public.logo_provider_responses;k text;item jsonb;revision jsonb;q public.logo_cost_quotes;
begin
 j:=fluid_private.logo_lock_job(p_job.id,p_job.lease_token);
 select * into p from public.logo_direction_publications where id=p_publication and owner_id=j.owner_id and project_id=j.project_id and job_id=j.id and lease_token=j.lease_token for update;
 select * into r from public.logo_provider_responses where id=p_provider_receipt and job_id=j.id and owner_id=j.owner_id and project_id=j.project_id and lease_token=j.lease_token;
 if p.id is null or r.id is null or p.provider_receipt_id<>r.id or p.input_hash<>j.input_hash or r.observation#>>'{billing,status}'<>'recorded' or not fluid_private.logo_response_identity_complete(j,r.observation) then raise exception 'direction_publication_evidence_required' using errcode='55000';end if;
 if p.committed_at is not null then return p.stage_revision;end if;
 select * into s from public.logo_direction_inputs where job_id=j.id;
 if not fluid_private.logo_direction_group_valid(p.result,s.source,j.owner_id,j.project_id) or not fluid_private.logo_direction_checks_valid(p.font_checks,p.result,s.source) then raise exception 'invalid_direction_publication' using errcode='55000';end if;
 foreach k in array array['directions','palettes','typography','graphics'] loop
  for item in select value from jsonb_array_elements(p.result->k) loop
   insert into public.logo_direction_records(id,owner_id,project_id,kind,approved_logo_id,record,publication_id) values((item->>'id')::uuid,j.owner_id,j.project_id,case k when 'directions' then 'direction' when 'palettes' then 'palette' else k end,(item->>'approvedLogoId')::uuid,item,p.id);
  end loop;
 end loop;
 for item in select value from jsonb_array_elements(p.font_checks) loop insert into public.logo_direction_font_checks(typography_id,style_key,owner_id,project_id,record) values((item->>'typographyVersionId')::uuid,item->>'styleKey',j.owner_id,j.project_id,item);end loop;
 select * into q from public.logo_cost_quotes where id=(j.input->>'quoteId')::uuid;
 if j.state='running' and fluid_private.logo_workspace_json(j.owner_id,j.project_id)->'heads'=q.record->'expected' and fluid_private.logo_workspace_json(j.owner_id,j.project_id)#>>'{approvedLogo,id}'=j.input->>'approvedLogoId'
  and fluid_private.visual_direction_source_current(j.owner_id,j.project_id,s.source->'reviewedVisualDirection') then
  revision:=fluid_private.logo_append_stage(j.owner_id,j.project_id,'directions',jsonb_build_object('directionIds',(select jsonb_agg(value->'id') from jsonb_array_elements(p.result->'directions')),'selectionId',null,'approvalId',null),s.source->'inputRevisions');
 end if;
 update public.logo_direction_publications set committed_at=clock_timestamp(),stage_revision=revision where id=p.id;
 return revision;
end $$;

-- Narrow RPC surface only; no browser/service-role access to private helpers.
-- Remove any inherited function ACLs from these new objects, not other services.
do $$ declare signature text; grantee text; privilege text; begin
 for grantee,privilege in select case a.grantee when 0 then 'public' else quote_ident(r.rolname) end,a.privilege_type from pg_class c
  cross join lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a left join pg_roles r on r.oid=a.grantee
  where c.oid='public.project_visual_directions'::regclass and a.grantee<>c.relowner loop
  execute format('revoke %s on public.project_visual_directions from %s',privilege,grantee);
 end loop;
 foreach signature in array array['fluid_private.visual_direction_latest(uuid,uuid)','fluid_private.visual_direction_source_current(uuid,uuid,jsonb)',
  'public.get_project_visual_direction(uuid)','public.review_project_visual_direction(uuid,jsonb)',
  'fluid_private.logo_prepare_direction_sources(uuid,uuid,uuid)','fluid_private.logo_direction_visual_basis_current(uuid,uuid,jsonb)',
  'fluid_private.logo_workspace_json(uuid,uuid)','fluid_private.logo_direction_selection_sources(uuid,uuid,jsonb)'] loop
  for grantee,privilege in select case a.grantee when 0 then 'public' else quote_ident(r.rolname) end,a.privilege_type from pg_proc p
   cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a left join pg_roles r on r.oid=a.grantee
   where p.oid=signature::regprocedure and a.grantee<>p.proowner loop
   execute format('revoke %s on function %s from %s',privilege,signature,grantee);
  end loop;
 end loop;
end $$;
grant select on public.project_visual_directions to authenticated;
grant execute on function public.get_project_visual_direction(uuid),public.review_project_visual_direction(uuid,jsonb) to authenticated;
commit;
