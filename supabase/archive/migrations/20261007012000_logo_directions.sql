-- P4 local candidate only. No live activation, principal binding or worker grant.
begin;
create table public.logo_direction_inputs(
 job_id uuid primary key,owner_id uuid not null,project_id uuid not null,input_hash text not null,source jsonb not null,
 foreign key(job_id,owner_id,project_id) references public.jobs(id,owner_id,project_id),check(octet_length(source::text)<=4194304)
);
create table public.logo_direction_publications(
 id uuid primary key default gen_random_uuid(),job_id uuid not null unique,owner_id uuid not null,project_id uuid not null,lease_token uuid not null,
 provider_receipt_id uuid not null references public.logo_provider_responses(id),input_hash text not null,result jsonb not null,font_checks jsonb not null,
 committed_at timestamptz,stage_revision jsonb,created_at timestamptz not null default clock_timestamp(),
 foreign key(job_id,owner_id,project_id) references public.jobs(id,owner_id,project_id),check(octet_length(result::text)<=393216),check(octet_length(font_checks::text)<=262144)
);
create table public.logo_direction_records(
 id uuid primary key,owner_id uuid not null,project_id uuid not null,kind text not null check(kind in('direction','palette','typography','graphics','selection','approval')),
 approved_logo_id uuid not null,record jsonb not null,publication_id uuid references public.logo_direction_publications(id),created_at timestamptz not null default clock_timestamp(),
 unique(id,owner_id,project_id),foreign key(project_id,owner_id) references public.projects(id,owner_id),foreign key(approved_logo_id,owner_id,project_id) references public.logo_approvals(id,owner_id,project_id),
 check(record->>'id'=id::text and record->>'ownerId'=owner_id::text and record->>'projectId'=project_id::text and record->>'approvedLogoId'=approved_logo_id::text),check(octet_length(record::text)<=65536)
);
create index logo_direction_history on public.logo_direction_records(owner_id,project_id,kind,created_at desc,id desc);
create table public.logo_direction_font_checks(
 typography_id uuid not null,style_key text not null,owner_id uuid not null,project_id uuid not null,record jsonb not null,
 primary key(typography_id,style_key),foreign key(typography_id,owner_id,project_id) references public.logo_direction_records(id,owner_id,project_id),
 check(record->>'typographyVersionId'=typography_id::text and record->>'styleKey'=style_key),check(octet_length(record::text)<=32768)
);
create trigger logo_direction_inputs_immutable before update or delete on public.logo_direction_inputs for each row execute function fluid_private.prevent_history_change();
create trigger logo_direction_records_immutable before update or delete on public.logo_direction_records for each row execute function fluid_private.prevent_history_change();
create trigger logo_direction_checks_immutable before update or delete on public.logo_direction_font_checks for each row execute function fluid_private.prevent_history_change();
create function fluid_private.logo_direction_publication_immutable() returns trigger language plpgsql set search_path='' as $$
begin
 if tg_op='DELETE' or (to_jsonb(new)-array['committed_at','stage_revision']) is distinct from (to_jsonb(old)-array['committed_at','stage_revision']) or old.committed_at is not null or new.committed_at is null then raise exception 'immutable_direction_publication' using errcode='55000';end if;return new;
end $$;
create trigger logo_direction_publications_immutable before update or delete on public.logo_direction_publications for each row execute function fluid_private.logo_direction_publication_immutable();

create function fluid_private.logo_prepare_direction_sources(p_owner uuid,p_project uuid,p_approval uuid) returns jsonb language plpgsql stable set search_path='' as $$
declare w jsonb;a jsonb;v jsonb;b jsonb;r jsonb;fonts jsonb;inputs jsonb;
begin
 w:=fluid_private.logo_workspace_json(p_owner,p_project);
 if w#>>'{approvedLogo,id}' is distinct from p_approval::text then raise exception 'logo_approval_required' using errcode='PT409';end if;
 select record into a from public.logo_approvals where id=p_approval and owner_id=p_owner and project_id=p_project;
 select record into v from public.logo_vector_revisions where id=(a->>'vectorRevisionId')::uuid and owner_id=p_owner and project_id=p_project;
 select record into b from public.logo_stage_revisions where id=(w#>>'{stages,brief_references,id}')::uuid and owner_id=p_owner and project_id=p_project and stage='brief_references';
 if a is null or v is null or b is null then raise exception 'direction_source_not_found' using errcode='P0002';end if;
 r:=fluid_private.logo_snapshot_json(p_owner,p_project,(b#>>'{payload,referenceSnapshotId}')::uuid);
 select coalesce(jsonb_agg(record order by record_id),'[]') into fonts from public.logo_font_records where owner_id=p_owner and project_id=p_project and record#>>'{rights,sourceKind}'='reviewed_license' and record#>>'{rights,commercialUse}'='allowed' and record#>>'{rights,permissions,render}'='allowed';
 if jsonb_array_length(fonts)>100 then raise exception 'too_many_direction_fonts' using errcode='55000';end if;
 select jsonb_agg(jsonb_build_object('stage',stage,'id',id,'revision',revision) order by stage) into inputs from public.logo_stage_revisions where owner_id=p_owner and project_id=p_project and id in((b->>'id')::uuid,(a->>'stageRevisionId')::uuid);
 if jsonb_array_length(inputs)<>2 then raise exception 'direction_stage_basis_missing' using errcode='55000';end if;
 return jsonb_build_object('approvedLogo',a,'logoRevision',v,'brief',b,'references',r,'permittedFonts',fonts,'targetCount',3,'inputRevisions',inputs);
end $$;
create function fluid_private.logo_freeze_direction_inputs(p_job public.jobs,p_source jsonb) returns void language plpgsql set search_path='' as $$
declare q public.logo_cost_quotes;
begin
 select * into q from public.logo_cost_quotes where id=(p_job.input->>'quoteId')::uuid and owner_id=p_job.owner_id and project_id=p_job.project_id;
 if p_job.operation<>'identity.logo_directions' or p_source is distinct from q.source_inputs->'direction' or p_source#>>'{approvedLogo,id}' is distinct from p_job.input->>'approvedLogoId' or p_source#>>'{brief,id}' is distinct from p_job.input->>'briefRevisionId' or p_source#>>'{references,id}' is distinct from p_job.input->>'referenceSnapshotId' then raise exception 'direction_input_mismatch' using errcode='55000';end if;
 insert into public.logo_direction_inputs(job_id,owner_id,project_id,input_hash,source) values(p_job.id,p_job.owner_id,p_job.project_id,p_job.input_hash,p_source);
end $$;
create function public.load_logo_direction_inputs(p_job uuid,p_lease uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.jobs;r public.logo_direction_inputs;
begin
 j:=fluid_private.logo_lock_job(p_job,p_lease);
 select * into r from public.logo_direction_inputs where job_id=j.id and owner_id=j.owner_id and project_id=j.project_id;
 if not found or j.operation<>'identity.logo_directions' or r.input_hash<>j.input_hash then raise exception 'direction_inputs_not_found' using errcode='P0002';end if;return r.source;
end $$;
create function fluid_private.logo_direction_group_valid(p_result jsonb,p_source jsonb,p_owner uuid,p_project uuid) returns boolean language plpgsql immutable set search_path='' as $$
declare k text;r jsonb;d jsonb;s jsonb;f jsonb;all_ids jsonb:='[]';palette jsonb;t jsonb;g jsonb;keys text[];
begin
 if not fluid_private.standalone_keys(p_result,array['directions','palettes','typography','graphics']) or octet_length(p_result::text)>393216 then return false;end if;
 foreach k in array array['directions','palettes','typography','graphics'] loop
  if jsonb_typeof(p_result->k) is distinct from 'array' or jsonb_array_length(p_result->k)<>3 then return false;end if;
  for r in select value from jsonb_array_elements(p_result->k) loop
   if not fluid_private.logo_uuid(r->'id') or r->>'ownerId' is distinct from p_owner::text or r->>'projectId' is distinct from p_project::text or r->'approvedLogoId' is distinct from p_source#>'{approvedLogo,id}' or r->'inputRevisions' is distinct from p_source->'inputRevisions' or octet_length(r::text)>32768 then return false;end if;
   all_ids:=all_ids||jsonb_build_array(r->'id');
   keys:=case k when 'directions' then array['id','ownerId','projectId','approvedLogoId','inputRevisions','name','paletteVersionId','typographyVersionId','graphicsVersionId'] when 'palettes' then array['id','ownerId','projectId','approvedLogoId','inputRevisions','swatches','pairings'] when 'typography' then array['id','ownerId','projectId','approvedLogoId','inputRevisions','styles'] else array['id','ownerId','projectId','approvedLogoId','inputRevisions','elements'] end;
   if not fluid_private.standalone_keys(r,keys) then return false;end if;
   if k='directions' then
    if not fluid_private.standalone_text(r->'name',200,1) or not fluid_private.logo_uuid(r->'paletteVersionId') or not fluid_private.logo_uuid(r->'typographyVersionId') or not fluid_private.logo_uuid(r->'graphicsVersionId') then return false;end if;
   elsif k='typography' then
    if jsonb_typeof(r->'styles') is distinct from 'array' or jsonb_array_length(r->'styles') not between 1 and 32 then return false;end if;
    if (select count(*)<>count(distinct value->>'key') from jsonb_array_elements(r->'styles')) then return false;end if;
    for s in select value from jsonb_array_elements(r->'styles') loop
     if not fluid_private.standalone_keys(s,array['key','role','sampleText','fontVersionId','weight','style','sizePx','lineHeight']) or s->>'key' !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$' or s->>'role' not in('heading','body','accent') or not fluid_private.standalone_text(s->'sampleText',2000,1) or s->>'style' not in('normal','italic') or jsonb_typeof(s->'weight')<>'number' or (s->>'weight')::numeric<>trunc((s->>'weight')::numeric) or (s->>'weight')::numeric not between 1 and 1000 or jsonb_typeof(s->'sizePx')<>'number' or (s->>'sizePx')::numeric<=0 or (s->>'sizePx')::numeric>16384 or jsonb_typeof(s->'lineHeight')<>'number' or (s->>'lineHeight')::numeric<=0 or (s->>'lineHeight')::numeric>100 then return false;end if;
     select value into f from jsonb_array_elements(p_source->'permittedFonts') where value->'id'=s->'fontVersionId';
     if f is null or f#>>'{rights,sourceKind}'<>'reviewed_license' or f#>>'{rights,commercialUse}'<>'allowed' or f#>>'{rights,permissions,render}'<>'allowed' then return false;end if;
    end loop;
   elsif k='palettes' then
    if jsonb_typeof(r->'swatches') is distinct from 'array' or jsonb_array_length(r->'swatches') not between 1 and 32 or jsonb_typeof(r->'pairings') is distinct from 'array' or jsonb_array_length(r->'pairings')>100 or (select count(*)<>count(distinct value->>'key') from jsonb_array_elements(r->'swatches')) then return false;end if;
    for s in select value from jsonb_array_elements(r->'swatches') loop
     if not fluid_private.standalone_keys(s,array['key','name','color']) or s->>'key' !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$' or not fluid_private.standalone_text(s->'name',200,1) or not fluid_private.standalone_keys(s->'color',array['hex','rgb','cmyk','pantone']) or s#>>'{color,hex}' !~ '^#[0-9A-F]{6}$' or jsonb_typeof(s#>'{color,rgb}') is distinct from 'array' or jsonb_array_length(s#>'{color,rgb}')<>3 then return false;end if;
     if s#>'{color,rgb}' is distinct from jsonb_build_array(get_byte(decode(substr(s#>>'{color,hex}',2),'hex'),0),get_byte(decode(substr(s#>>'{color,hex}',2),'hex'),1),get_byte(decode(substr(s#>>'{color,hex}',2),'hex'),2)) or s#>'{color,cmyk}'<>'{"status":"unavailable","reason":"profile_unavailable"}' or s#>'{color,pantone}'<>'{"status":"unavailable","reason":"licensed_source_unavailable"}' then return false;end if;
    end loop;
    for s in select value from jsonb_array_elements(r->'pairings') loop
     if not fluid_private.standalone_keys(s,array['foregroundKey','backgroundKey','role']) or s->>'role' not in('heading','body','accent') or not exists(select 1 from jsonb_array_elements(r->'swatches') sw where sw->'key'=s->'foregroundKey') or not exists(select 1 from jsonb_array_elements(r->'swatches') sw where sw->'key'=s->'backgroundKey') then return false;end if;
    end loop;
   else
    if jsonb_typeof(r->'elements') is distinct from 'array' or jsonb_array_length(r->'elements')>100 then return false;end if;
    for s in select value from jsonb_array_elements(r->'elements') loop
     if s->>'paletteKey' !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$' then return false;end if;
     if s->>'kind'='dots' then
      if not fluid_private.standalone_keys(s,array['kind','paletteKey','radius','spacing']) or jsonb_typeof(s->'radius')<>'number' or (s->>'radius')::numeric<=0 or (s->>'radius')::numeric>256 or jsonb_typeof(s->'spacing')<>'number' or (s->>'spacing')::numeric not between 2 and 512 then return false;end if;
     elsif s->>'kind'='stripes' then
      if not fluid_private.standalone_keys(s,array['kind','paletteKey','width','spacing','rotation']) or jsonb_typeof(s->'width')<>'number' or (s->>'width')::numeric<=0 or (s->>'width')::numeric>256 or jsonb_typeof(s->'spacing')<>'number' or (s->>'spacing')::numeric not between 2 and 512 or jsonb_typeof(s->'rotation')<>'number' or (s->>'rotation')::numeric not between -180 and 180 then return false;end if;
     elsif s->>'kind'='shape' then
      if not fluid_private.standalone_keys(s,array['kind','paletteKey','shape','x','y','width','height']) or s->>'shape' not in('circle','rectangle','triangle') or jsonb_typeof(s->'x')<>'number' or (s->>'x')::numeric not between -512 and 512 or jsonb_typeof(s->'y')<>'number' or (s->>'y')::numeric not between -512 and 512 or jsonb_typeof(s->'width')<>'number' or (s->>'width')::numeric<=0 or (s->>'width')::numeric>512 or jsonb_typeof(s->'height')<>'number' or (s->>'height')::numeric<=0 or (s->>'height')::numeric>512 then return false;end if;
     else return false;end if;
    end loop;
   end if;
  end loop;
 end loop;
 if (select count(*)<>count(distinct value) from jsonb_array_elements(all_ids)) then return false;end if;
 foreach k in array array['paletteVersionId','typographyVersionId','graphicsVersionId'] loop if (select count(*)<>count(distinct value->>k) from jsonb_array_elements(p_result->'directions')) then return false;end if;end loop;
 for d in select value from jsonb_array_elements(p_result->'directions') loop
  select value into palette from jsonb_array_elements(p_result->'palettes') where value->'id'=d->'paletteVersionId';select value into t from jsonb_array_elements(p_result->'typography') where value->'id'=d->'typographyVersionId';select value into g from jsonb_array_elements(p_result->'graphics') where value->'id'=d->'graphicsVersionId';
  if palette is null or t is null or g is null or exists(select 1 from jsonb_array_elements(g->'elements') e where not exists(select 1 from jsonb_array_elements(palette->'swatches') sw where sw->'key'=e->'paletteKey')) then return false;end if;
 end loop;
 return true;
exception when invalid_text_representation or numeric_value_out_of_range or invalid_parameter_value then return false;
end $$;
create function fluid_private.logo_direction_checks_valid(p_checks jsonb,p_result jsonb,p_source jsonb) returns boolean language plpgsql immutable set search_path='' as $$
declare t jsonb;s jsonb;c jsonb;f jsonb;style_hash text;total integer:=0;
begin
 if jsonb_typeof(p_checks) is distinct from 'array' or jsonb_array_length(p_checks)>100 or octet_length(p_checks::text)>262144 then return false;end if;
 for t in select value from jsonb_array_elements(p_result->'typography') loop for s in select value from jsonb_array_elements(t->'styles') loop
  total:=total+1;select value into f from jsonb_array_elements(p_source->'permittedFonts') where value->'id'=s->'fontVersionId';
  select value into c from jsonb_array_elements(p_checks) where value->'typographyVersionId'=t->'id' and value->'styleKey'=s->'key';
  if c is null or not fluid_private.standalone_keys(c,array['typographyVersionId','styleKey','sampleHash','styleHash','role','fontVersionId','fontContentHash','missingCodePoints','styleSupported']) or c->'role' is distinct from s->'role' or c->'fontVersionId' is distinct from s->'fontVersionId' or c->'fontContentHash' is distinct from f#>'{asset,contentHash}' or c->>'sampleHash' is distinct from encode(sha256(convert_to(s->>'sampleText','UTF8')),'hex') or jsonb_typeof(c->'styleSupported') is distinct from 'boolean' or jsonb_typeof(c->'missingCodePoints') is distinct from 'array' or jsonb_array_length(c->'missingCodePoints')>200 then return false;end if;
  style_hash:=encode(sha256(convert_to('{"fontContentHash":'||to_jsonb(f#>>'{asset,contentHash}')::text||',"fontVersionId":'||to_jsonb(f->>'id')::text||',"style":'||to_jsonb(s->>'style')::text||',"version":1,"weight":'||(s->>'weight')||'}','UTF8')),'hex');
  if c->>'styleHash' is distinct from style_hash or (select count(*)<>count(distinct value) from jsonb_array_elements(c->'missingCodePoints')) or exists(select 1 from jsonb_array_elements(c->'missingCodePoints') n where jsonb_typeof(n)<>'number' or n::text::numeric<>trunc(n::text::numeric) or n::text::numeric<0 or n::text::numeric>1114111 or n::text::numeric between 55296 and 57343) then return false;end if;
 end loop;end loop;
 return total=jsonb_array_length(p_checks) and not exists(select 1 from jsonb_array_elements(p_checks) a group by a->>'typographyVersionId',a->>'styleKey' having count(*)<>1);
exception when invalid_text_representation or numeric_value_out_of_range then return false;
end $$;
create function public.stage_logo_directions(p_job uuid,p_lease uuid,p_result jsonb,p_provider_receipt uuid,p_checks jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.jobs;s public.logo_direction_inputs;p public.logo_direction_publications;r public.logo_provider_responses;
begin
 perform 1 from public.projects where id=(select project_id from public.jobs where id=p_job and owner_id=fluid_private.logo_worker_owner()) for update;
 j:=fluid_private.logo_lock_job(p_job,p_lease);
 select * into s from public.logo_direction_inputs where job_id=j.id and owner_id=j.owner_id and project_id=j.project_id;
 select * into r from public.logo_provider_responses where id=p_provider_receipt and job_id=j.id and owner_id=j.owner_id and project_id=j.project_id and lease_token=j.lease_token;
 if j.operation<>'identity.logo_directions' or s.job_id is null or r.id is null or r.observation->>'responseHash' is null then raise exception 'direction_source_evidence_required' using errcode='55000';end if;
 if not fluid_private.logo_direction_group_valid(p_result,s.source,j.owner_id,j.project_id) or not fluid_private.logo_direction_checks_valid(p_checks,p_result,s.source) then raise exception 'invalid_direction_result' using errcode='22023';end if;
 select * into p from public.logo_direction_publications where job_id=j.id;
 if found then
  if p.result is distinct from p_result or p.font_checks is distinct from p_checks or p.provider_receipt_id<>p_provider_receipt or p.lease_token<>p_lease then raise exception 'immutable_direction_request' using errcode='PT409';end if;
 else
  insert into public.logo_direction_publications(job_id,owner_id,project_id,lease_token,provider_receipt_id,input_hash,result,font_checks) values(j.id,j.owner_id,j.project_id,j.lease_token,r.id,j.input_hash,p_result,p_checks) returning * into p;
 end if;
 return jsonb_build_object('id',p.id,'ownerId',p.owner_id,'projectId',p.project_id,'jobId',p.job_id,'inputHash',p.input_hash,'directionIds',(select jsonb_agg(value->'id') from jsonb_array_elements(p.result->'directions')),'publicationState','staged');
end $$;
create function fluid_private.logo_commit_direction_publication(p_job public.jobs,p_publication uuid,p_provider_receipt uuid) returns jsonb language plpgsql set search_path='' as $$
declare j public.jobs;p public.logo_direction_publications;s public.logo_direction_inputs;r public.logo_provider_responses;k text;item jsonb;revision jsonb;q public.logo_cost_quotes;
begin
 j:=fluid_private.logo_lock_job(p_job.id,p_job.lease_token);
 select * into p from public.logo_direction_publications where id=p_publication and owner_id=j.owner_id and project_id=j.project_id and job_id=j.id and lease_token=j.lease_token for update;
 select * into r from public.logo_provider_responses where id=p_provider_receipt and job_id=j.id and owner_id=j.owner_id and project_id=j.project_id and lease_token=j.lease_token;
 if p.id is null or r.id is null or p.provider_receipt_id<>r.id or p.input_hash<>j.input_hash or r.observation#>>'{billing,status}'<>'recorded' or r.observation->>'responseHash' is null or r.observation->>'providerRequestId' is null then raise exception 'direction_publication_evidence_required' using errcode='55000';end if;
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
 if j.state='running' and fluid_private.logo_workspace_json(j.owner_id,j.project_id)->'heads'=q.record->'expected' and fluid_private.logo_workspace_json(j.owner_id,j.project_id)#>>'{approvedLogo,id}'=j.input->>'approvedLogoId' then
  revision:=fluid_private.logo_append_stage(j.owner_id,j.project_id,'directions',jsonb_build_object('directionIds',(select jsonb_agg(value->'id') from jsonb_array_elements(p.result->'directions')),'selectionId',null,'approvalId',null),s.source->'inputRevisions');
 end if;
 update public.logo_direction_publications set committed_at=clock_timestamp(),stage_revision=revision where id=p.id;
 return revision;
end $$;

create function fluid_private.logo_direction_selection_sources(p_owner uuid,p_project uuid,p_body jsonb) returns jsonb language plpgsql stable set search_path='' as $$
declare w jsonb;palette jsonb;typography jsonb;graphics jsonb;dirs jsonb;fonts jsonb;checks jsonb;selected jsonb;approval jsonb;stage jsonb;k text;item jsonb;basis jsonb;
begin
 w:=fluid_private.logo_workspace_json(p_owner,p_project);
 if w->'approvedLogo'='null' then raise exception 'logo_approval_required' using errcode='PT409';end if;
 select record into palette from public.logo_direction_records where id=(p_body->>'paletteVersionId')::uuid and kind='palette' and owner_id=p_owner and project_id=p_project;
 select record into typography from public.logo_direction_records where id=(p_body->>'typographyVersionId')::uuid and kind='typography' and owner_id=p_owner and project_id=p_project;
 select record into graphics from public.logo_direction_records where id=(p_body->>'graphicsVersionId')::uuid and kind='graphics' and owner_id=p_owner and project_id=p_project;
 if palette is null or typography is null or graphics is null then raise exception 'direction_component_not_found' using errcode='P0002';end if;
 if palette->'approvedLogoId' is distinct from w#>'{approvedLogo,id}' or typography->'approvedLogoId' is distinct from palette->'approvedLogoId' or graphics->'approvedLogoId' is distinct from palette->'approvedLogoId' or typography->'inputRevisions' is distinct from palette->'inputRevisions' or graphics->'inputRevisions' is distinct from palette->'inputRevisions' then raise exception 'direction_component_basis_changed' using errcode='PT409';end if;
 select coalesce(jsonb_agg(record order by id),'[]') into dirs from public.logo_direction_records where id in(
  select min(id::text)::uuid from public.logo_direction_records r, lateral(values('paletteVersionId',palette->>'id'),('typographyVersionId',typography->>'id'),('graphicsVersionId',graphics->>'id')) component(field,value)
   where r.owner_id=p_owner and r.project_id=p_project and r.kind='direction' and r.record->'inputRevisions'=palette->'inputRevisions' and r.record->'approvedLogoId'=palette->'approvedLogoId' and r.record->>component.field=component.value group by component.field
 );
 if jsonb_array_length(dirs)<1 then raise exception 'direction_sources_missing' using errcode='P0002';end if;
 select coalesce(jsonb_agg(f.record order by f.record_id),'[]') into fonts from public.logo_font_records f where f.owner_id=p_owner and f.project_id=p_project and exists(select 1 from jsonb_array_elements(typography->'styles') s where s->>'fontVersionId'=f.record_id::text);
 select coalesce(jsonb_agg(c.record order by c.style_key collate "C"),'[]') into checks from public.logo_direction_font_checks c where c.owner_id=p_owner and c.project_id=p_project and c.typography_id=(typography->>'id')::uuid;
 select record into stage from public.logo_stage_revisions where id=(w#>>'{stages,directions,id}')::uuid and owner_id=p_owner and project_id=p_project;
 select record into selected from public.logo_direction_records where id=(stage#>>'{payload,selectionId}')::uuid and kind='selection' and owner_id=p_owner and project_id=p_project;
 select record into approval from public.logo_direction_records where id=(stage#>>'{payload,approvalId}')::uuid and kind='approval' and owner_id=p_owner and project_id=p_project;
 return jsonb_build_object('ownerId',p_owner,'projectId',p_project,'currentApprovedLogo',w->'approvedLogo','directions',dirs,'palettes',jsonb_build_array(palette),'typography',jsonb_build_array(typography),'graphics',jsonb_build_array(graphics),'fonts',fonts,'fontChecks',checks,'selection',selected,'approval',approval,'stale',exists(select 1 from jsonb_array_elements(w->'staleStages') s where s->>'stage'='directions'),'nextCursor',null);
exception when invalid_text_representation then raise exception 'invalid_direction_source_request' using errcode='22023';
end $$;
create function public.read_logo_direction_selection_sources(p_project uuid,p_body jsonb) returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if auth.uid() is null then raise exception 'unauthenticated' using errcode='42501';end if;
 if not fluid_private.standalone_keys(p_body,array['paletteVersionId','typographyVersionId','graphicsVersionId']) or not fluid_private.logo_uuid(p_body->'paletteVersionId') or not fluid_private.logo_uuid(p_body->'typographyVersionId') or not fluid_private.logo_uuid(p_body->'graphicsVersionId') then raise exception 'invalid_direction_source_request' using errcode='22023';end if;
 return fluid_private.logo_direction_selection_sources(auth.uid(),p_project,p_body);
end $$;
create function fluid_private.logo_direction_overview(p_owner uuid,p_project uuid,p_query jsonb) returns jsonb language plpgsql stable set search_path='' as $$
declare w jsonb;stage jsonb;selected jsonb;approval jsonb;dirs jsonb;palettes jsonb;types jsonb;graphics jsonb;fonts jsonb;checks jsonb;ids uuid[];current_ids uuid[];last public.logo_direction_records;cursor_row public.logo_direction_records;current_after uuid;current_offset integer:=0;remaining_current boolean:=false;more boolean;pin_current boolean:=false;lim integer:=least(coalesce((p_query->>'limit')::integer,3),3);
begin
 w:=fluid_private.logo_workspace_json(p_owner,p_project);
 if lim<1 then raise exception 'invalid_direction_page' using errcode='22023';end if;
 if p_query->>'cursor' like 'current:%' then
  if cardinality(string_to_array(p_query->>'cursor',':'))<>3 or not fluid_private.logo_uuid(to_jsonb(split_part(p_query->>'cursor',':',2))) or not fluid_private.logo_uuid(to_jsonb(split_part(p_query->>'cursor',':',3))) then raise exception 'invalid_direction_page' using errcode='22023';end if;
  -- A current-set continuation is bound to its immutable stage, so a changed
  -- head requires a fresh first page instead of silently switching collections.
  if split_part(p_query->>'cursor',':',2) is distinct from w#>>'{stages,directions,id}' then raise exception 'direction_page_head_changed' using errcode='PT409';end if;
  current_after:=split_part(p_query->>'cursor',':',3)::uuid;
 elsif p_query->>'cursor' is not null and p_query->>'cursor'<>'history' then
  if not fluid_private.logo_uuid(p_query->'cursor') then raise exception 'invalid_direction_page' using errcode='22023';end if;
  select * into cursor_row from public.logo_direction_records where id=(p_query->>'cursor')::uuid and owner_id=p_owner and project_id=p_project and kind='direction';if not found then raise exception 'direction_cursor_not_found' using errcode='P0002';end if;
 end if;
 select record into stage from public.logo_stage_revisions where id=(w#>>'{stages,directions,id}')::uuid and owner_id=p_owner and project_id=p_project;
 select coalesce(array_agg((value#>>'{}')::uuid),'{}') into current_ids from jsonb_array_elements(coalesce(stage#>'{payload,directionIds}','[]'));
 if current_after is not null then
  current_offset:=array_position(current_ids,current_after);if current_offset is null then raise exception 'direction_cursor_not_found' using errcode='P0002';end if;
 end if;
 if (p_query->>'cursor' is null or current_after is not null) and cardinality(current_ids)>0 then
  pin_current:=true;
  -- The first page is the current available set, independent of selected-source
  -- provenance and of newer retained groups that never advanced this head.
  select array_agg(id order by ordinal) into ids from(select r.id,d.ordinality ordinal from jsonb_array_elements(stage#>'{payload,directionIds}') with ordinality d(value,ordinality) join public.logo_direction_records r on r.id::text=d.value#>>'{}' and r.owner_id=p_owner and r.project_id=p_project and r.kind='direction' where d.ordinality>current_offset order by d.ordinality limit lim) current_set;
 else
  select array_agg(id) into ids from(select id from public.logo_direction_records where owner_id=p_owner and project_id=p_project and kind='direction' and not(id=any(current_ids)) and (cursor_row.id is null or(created_at,id)<(cursor_row.created_at,cursor_row.id)) order by created_at desc,id desc limit lim) page;
 end if;
 select coalesce(jsonb_agg(record order by array_position(ids,id)),'[]') into dirs from public.logo_direction_records where id=any(ids);
 select * into last from public.logo_direction_records where id=any(ids) order by created_at,id limit 1;
 remaining_current:=pin_current and exists(select 1 from unnest(current_ids) with ordinality d(id,ordinal) join public.logo_direction_records r on r.id=d.id and r.owner_id=p_owner and r.project_id=p_project and r.kind='direction' where d.ordinal>coalesce(array_position(current_ids,ids[cardinality(ids)]),current_offset));
 more:=exists(select 1 from public.logo_direction_records where owner_id=p_owner and project_id=p_project and kind='direction' and not(id=any(current_ids)) and (pin_current or (last.id is not null and(created_at,id)<(last.created_at,last.id))));
 select record into stage from public.logo_stage_revisions where id=(w#>>'{stages,directions,id}')::uuid and owner_id=p_owner and project_id=p_project;
 select record into selected from public.logo_direction_records where id=(stage#>>'{payload,selectionId}')::uuid and kind='selection' and owner_id=p_owner and project_id=p_project;
 select record into approval from public.logo_direction_records where id=(stage#>>'{payload,approvalId}')::uuid and kind='approval' and owner_id=p_owner and project_id=p_project;
 select coalesce(jsonb_agg(record order by id),'[]') into palettes from public.logo_direction_records where owner_id=p_owner and project_id=p_project and kind='palette' and(id::text=selected->>'paletteVersionId' or exists(select 1 from jsonb_array_elements(dirs) d where d->>'paletteVersionId'=id::text));
 select coalesce(jsonb_agg(record order by id),'[]') into types from public.logo_direction_records where owner_id=p_owner and project_id=p_project and kind='typography' and(id::text=selected->>'typographyVersionId' or exists(select 1 from jsonb_array_elements(dirs) d where d->>'typographyVersionId'=id::text));
 select coalesce(jsonb_agg(record order by id),'[]') into graphics from public.logo_direction_records where owner_id=p_owner and project_id=p_project and kind='graphics' and(id::text=selected->>'graphicsVersionId' or exists(select 1 from jsonb_array_elements(dirs) d where d->>'graphicsVersionId'=id::text));
 select coalesce(jsonb_agg(record order by record_id),'[]') into fonts from public.logo_font_records f where owner_id=p_owner and project_id=p_project and exists(select 1 from jsonb_array_elements(types) t,jsonb_array_elements(t->'styles') s where s->>'fontVersionId'=f.record_id::text);
 select coalesce(jsonb_agg(record),'[]') into checks from(select c.record from public.logo_direction_font_checks c where owner_id=p_owner and project_id=p_project and exists(select 1 from jsonb_array_elements(types) t where t->>'id'=c.typography_id::text) order by(c.typography_id::text=selected->>'typographyVersionId') desc nulls last,c.typography_id,c.style_key limit 100) bounded_checks;
 return jsonb_build_object('ownerId',p_owner,'projectId',p_project,'currentApprovedLogo',w->'approvedLogo','directions',dirs,'palettes',palettes,'typography',types,'graphics',graphics,'fonts',fonts,'fontChecks',checks,'selection',selected,'approval',approval,'stale',exists(select 1 from jsonb_array_elements(w->'staleStages') s where s->>'stage'='directions') or (selected is not null and selected->'approvedLogoId' is distinct from w#>'{approvedLogo,id}'),'nextCursor',case when remaining_current then 'current:'||(stage->>'id')||':'||ids[cardinality(ids)]::text when more then case when pin_current then 'history' else last.id::text end else null end);
exception when invalid_text_representation or numeric_value_out_of_range then raise exception 'invalid_direction_page' using errcode='22023';
end $$;
create function fluid_private.commit_logo_direction_command(p_owner uuid,p_project uuid,p_command jsonb,p_evidence jsonb) returns jsonb language plpgsql set search_path='' as $$
declare b jsonb:=p_command->'body';method text:=p_command->>'method';source jsonb;consistency jsonb;overview jsonb;selection jsonb;approval jsonb;stage jsonb;new_id uuid:=gen_random_uuid();available_ids jsonb;inputs jsonb;w jsonb;actual jsonb;
begin
 -- The fixed trusted wrapper has already verified the direct-login owner,
 -- original request body, all expected heads and project-first lock order.
 if method not in('selectIdentityDirectionComponents','approveIdentityDirection') then raise exception 'direction_method_unavailable' using errcode='55000';end if;
 if not fluid_private.standalone_keys(p_evidence,array['sources','consistency']) or octet_length(p_evidence::text)>1048576 then raise exception 'invalid_direction_evidence' using errcode='22023';end if;
 source:=p_evidence->'sources';consistency:=p_evidence->'consistency';
 if not fluid_private.standalone_keys(source,array['approvedLogo','palette','typography','graphics','fonts','fontChecks','sourceDirectionIds']) then raise exception 'invalid_direction_sources' using errcode='22023';end if;
 w:=fluid_private.logo_workspace_json(p_owner,p_project);
 if source->'approvedLogo' is distinct from w->'approvedLogo' then raise exception 'direction_approval_changed' using errcode='PT409';end if;
 select record into stage from public.logo_stage_revisions where id=(w#>>'{stages,directions,id}')::uuid and owner_id=p_owner and project_id=p_project;
 available_ids:=coalesce(stage#>'{payload,directionIds}',source->'sourceDirectionIds');
 overview:=fluid_private.logo_direction_selection_sources(p_owner,p_project,jsonb_build_object('paletteVersionId',source#>'{palette,id}','typographyVersionId',source#>'{typography,id}','graphicsVersionId',source#>'{graphics,id}'));
 if overview->'stale'='true' then raise exception 'direction_source_stale' using errcode='PT409';end if;
 if source->'palette' is distinct from overview#>'{palettes,0}' or source->'typography' is distinct from overview#>'{typography,0}' or source->'graphics' is distinct from overview#>'{graphics,0}' or source->'fonts' is distinct from overview->'fonts' or source->'fontChecks' is distinct from overview->'fontChecks' then raise exception 'direction_source_changed' using errcode='PT409';end if;
 if jsonb_typeof(source->'sourceDirectionIds') is distinct from 'array' or jsonb_array_length(source->'sourceDirectionIds') not between 1 and 3 or (select count(*)<>count(distinct value) from jsonb_array_elements(source->'sourceDirectionIds')) or exists(select 1 from jsonb_array_elements(source->'sourceDirectionIds') i where not exists(select 1 from jsonb_array_elements(overview->'directions') d where d->'id'=i)) then raise exception 'direction_source_changed' using errcode='PT409';end if;
 if not fluid_private.standalone_keys(consistency,array['hash','status','checks','warnings','blockingReasons']) or consistency->>'hash' !~ '^[a-f0-9]{64}$' or consistency->>'status' not in('pass','warning') or jsonb_typeof(consistency->'checks') is distinct from 'array' or jsonb_array_length(consistency->'checks')>100 or jsonb_typeof(consistency->'warnings') is distinct from 'array' or jsonb_array_length(consistency->'warnings')>100 or consistency->'blockingReasons'<>'[]' or exists(select 1 from jsonb_array_elements(consistency->'checks') c where c->>'status'='blocked') or (consistency->>'status'='pass' and(jsonb_array_length(consistency->'warnings')>0 or exists(select 1 from jsonb_array_elements(consistency->'checks') c where c->>'status'='warning'))) then raise exception 'direction_consistency_blocked' using errcode='55000';end if;
 inputs:=source#>'{palette,inputRevisions}';
 if method='selectIdentityDirectionComponents' then
  if b->'approvedLogoId' is distinct from source#>'{approvedLogo,id}' or b->'paletteVersionId' is distinct from source#>'{palette,id}' or b->'typographyVersionId' is distinct from source#>'{typography,id}' or b->'graphicsVersionId' is distinct from source#>'{graphics,id}' then raise exception 'direction_selection_changed' using errcode='PT409';end if;
  selection:=jsonb_build_object('id',new_id,'ownerId',p_owner,'projectId',p_project,'approvedLogoId',source#>'{approvedLogo,id}','inputRevisions',inputs,'paletteVersionId',b->'paletteVersionId','typographyVersionId',b->'typographyVersionId','graphicsVersionId',b->'graphicsVersionId','sourceDirectionIds',source->'sourceDirectionIds','consistency',consistency);
  insert into public.logo_direction_records(id,owner_id,project_id,kind,approved_logo_id,record) values(new_id,p_owner,p_project,'selection',(source#>>'{approvedLogo,id}')::uuid,selection);
  return fluid_private.logo_append_stage(p_owner,p_project,'directions',jsonb_build_object('directionIds',available_ids,'selectionId',new_id,'approvalId',null),inputs);
 end if;
 selection:=overview->'selection';
 if selection is null or selection='null' or selection->'id' is distinct from b->'directionSelectionId' or selection->'consistency' is distinct from consistency or b->'consistencyHash' is distinct from consistency->'hash' or selection->'paletteVersionId' is distinct from source#>'{palette,id}' or selection->'typographyVersionId' is distinct from source#>'{typography,id}' or selection->'graphicsVersionId' is distinct from source#>'{graphics,id}' then raise exception 'direction_review_changed' using errcode='PT409';end if;
 approval:=jsonb_build_object('id',new_id,'ownerId',p_owner,'projectId',p_project,'directionSelectionId',selection->'id','approvedLogoId',source#>'{approvedLogo,id}','consistencyHash',consistency->'hash','approvedAt',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
 insert into public.logo_direction_records(id,owner_id,project_id,kind,approved_logo_id,record) values(new_id,p_owner,p_project,'approval',(source#>>'{approvedLogo,id}')::uuid,approval);
 return fluid_private.logo_append_stage(p_owner,p_project,'directions',jsonb_build_object('directionIds',available_ids,'selectionId',selection->'id','approvalId',new_id),inputs);
end $$;
-- RLS and explicit revocation cover staged and immutable source tables. A
-- dedicated restricted login may receive named EXECUTEs only after separate review.
do $$declare t text;s text;r record;begin
 foreach t in array array['logo_direction_inputs','logo_direction_publications','logo_direction_records','logo_direction_font_checks'] loop
  -- Scrub every inherited nonowner ACL on only this exact new table. This
  -- includes TRUNCATE/REFERENCES/TRIGGER and grant options from hostile defaults.
  for r in select distinct a.grantee from pg_class c cross join lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a where c.oid=to_regclass(format('public.%I',t)) and a.grantee<>c.relowner loop
   execute format('revoke all on table public.%I from %s',t,case when r.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(r.grantee)) end);
  end loop;
  execute format('revoke all on table public.%I from public,anon,authenticated,service_role',t);
  execute format('alter table public.%I enable row level security',t);execute format('alter table public.%I force row level security',t);
  if t in('logo_direction_records','logo_direction_font_checks') then execute format('create policy logo_direction_owned_read on public.%I for select to authenticated using(owner_id=auth.uid())',t);execute format('grant select on table public.%I to authenticated',t);end if;
 end loop;
 foreach s in array array['fluid_private.logo_direction_publication_immutable()','fluid_private.logo_prepare_direction_sources(uuid,uuid,uuid)','fluid_private.logo_freeze_direction_inputs(public.jobs,jsonb)','public.load_logo_direction_inputs(uuid,uuid)','fluid_private.logo_direction_group_valid(jsonb,jsonb,uuid,uuid)','fluid_private.logo_direction_checks_valid(jsonb,jsonb,jsonb)','public.stage_logo_directions(uuid,uuid,jsonb,uuid,jsonb)','fluid_private.logo_commit_direction_publication(public.jobs,uuid,uuid)','fluid_private.logo_direction_selection_sources(uuid,uuid,jsonb)','public.read_logo_direction_selection_sources(uuid,jsonb)','fluid_private.logo_direction_overview(uuid,uuid,jsonb)','fluid_private.commit_logo_direction_command(uuid,uuid,jsonb,jsonb)'] loop
  for r in select distinct a.grantee from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where p.oid=to_regprocedure(s) and a.grantee<>p.proowner loop execute format('revoke all on function %s from %s',s,case when r.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(r.grantee)) end);end loop;
 end loop;
end $$;
grant execute on function public.read_logo_direction_selection_sources(uuid,jsonb) to authenticated;
commit;
