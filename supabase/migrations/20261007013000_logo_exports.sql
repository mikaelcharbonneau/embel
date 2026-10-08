-- P5 candidate: local validation only. No live role, credential, grant or storage activation.
begin;
create table public.logo_variant_sets (
 id uuid primary key, owner_id uuid not null, project_id uuid not null, approved_logo_id uuid not null, direction_approval_id uuid not null,
 record jsonb not null, source jsonb not null, created_at timestamptz not null default clock_timestamp(),
 unique(id,owner_id,project_id), foreign key(project_id,owner_id) references public.projects(id,owner_id),
 foreign key(approved_logo_id,owner_id,project_id) references public.logo_approvals(id,owner_id,project_id),
 foreign key(direction_approval_id,owner_id,project_id) references public.logo_direction_records(id,owner_id,project_id),
 check(record->>'id'=id::text and record->>'ownerId'=owner_id::text and record->>'projectId'=project_id::text and record->>'approvedLogoId'=approved_logo_id::text and record->>'directionApprovalId'=direction_approval_id::text),
 check(octet_length(record::text)<=131072 and octet_length(source::text)<=2097152)
);
create table public.logo_variant_reviews (
 id uuid primary key, owner_id uuid not null, project_id uuid not null, variant_set_id uuid not null, record jsonb not null,
 created_at timestamptz not null default clock_timestamp(), unique(id,owner_id,project_id),
 foreign key(variant_set_id,owner_id,project_id) references public.logo_variant_sets(id,owner_id,project_id),
 check(record->>'id'=id::text and record->>'ownerId'=owner_id::text and record->>'projectId'=project_id::text and record->>'variantSetId'=variant_set_id::text), check(octet_length(record::text)<=32768)
);
create table public.logo_export_inputs (
 job_id uuid primary key, owner_id uuid not null, project_id uuid not null, source_snapshot_hash text not null, source jsonb not null,
 foreign key(job_id,owner_id,project_id) references public.jobs(id,owner_id,project_id),
 check(source_snapshot_hash ~ '^[0-9a-f]{64}$' and source->>'sourceSnapshotHash'=source_snapshot_hash and octet_length(source::text)<=2097152)
);
create table public.logo_export_publications (
 id uuid primary key default gen_random_uuid(), job_id uuid not null unique, owner_id uuid not null, project_id uuid not null, lease_token uuid not null,
 source_snapshot_hash text not null, completeness text not null check(completeness in('complete','partial')), failure text,
 files jsonb not null, asset_receipt_ids uuid[] not null, committed_at timestamptz, stage_revision jsonb, manifest_id uuid,
 created_at timestamptz not null default clock_timestamp(), unique(id,owner_id,project_id),
 foreign key(job_id,owner_id,project_id) references public.jobs(id,owner_id,project_id),
 check((completeness='complete' and failure is null) or(completeness='partial' and failure is not null and failure in('file_failed','package_too_large'))),
 check(cardinality(asset_receipt_ids) between 1 and 100 and jsonb_array_length(files)=cardinality(asset_receipt_ids) and octet_length(files::text)<=262144),
 check((committed_at is null and manifest_id is null and stage_revision is null) or(committed_at is not null and(completeness='partial' and manifest_id is null or completeness='complete' and manifest_id is not null)))
);
create table public.logo_export_manifests (
 id uuid primary key, owner_id uuid not null, project_id uuid not null, publication_id uuid not null unique, job_id uuid not null unique,
 record jsonb not null, created_at timestamptz not null default clock_timestamp(),
 foreign key(publication_id,owner_id,project_id) references public.logo_export_publications(id,owner_id,project_id),
 foreign key(job_id,owner_id,project_id) references public.jobs(id,owner_id,project_id),
 check(record->>'id'=id::text and record->>'ownerId'=owner_id::text and record->>'projectId'=project_id::text and octet_length(record::text)<=131072)
);
create index logo_export_history on public.logo_export_manifests(owner_id,project_id,created_at desc,id desc);
create index logo_variant_history on public.logo_variant_sets(owner_id,project_id,created_at desc,id desc);
create trigger logo_variant_sets_immutable before update or delete on public.logo_variant_sets for each row execute function fluid_private.prevent_history_change();
create trigger logo_variant_reviews_immutable before update or delete on public.logo_variant_reviews for each row execute function fluid_private.prevent_history_change();
create trigger logo_export_inputs_immutable before update or delete on public.logo_export_inputs for each row execute function fluid_private.prevent_history_change();
create trigger logo_export_manifests_immutable before update or delete on public.logo_export_manifests for each row execute function fluid_private.prevent_history_change();
create function fluid_private.logo_export_publication_immutable() returns trigger language plpgsql set search_path='' as $$
begin
 if tg_op='DELETE' or (to_jsonb(new)-array['committed_at','stage_revision','manifest_id']) is distinct from (to_jsonb(old)-array['committed_at','stage_revision','manifest_id']) or old.committed_at is not null or new.committed_at is null then raise exception 'immutable_export_publication' using errcode='55000';end if; return new;
end $$;
create trigger logo_export_publications_immutable before update or delete on public.logo_export_publications for each row execute function fluid_private.logo_export_publication_immutable();

-- Frozen metadata contains immutable owned references and rights records. Geometry
-- is resolved and independently checked from private bytes by the server bridge.
create function fluid_private.logo_approved_deliverable_sources(p_owner uuid,p_project uuid) returns jsonb language plpgsql stable set search_path='' as $$
declare w jsonb;logo jsonb;direction_stage jsonb;selection jsonb;approval jsonb;palette jsonb;typography jsonb;graphics jsonb;fonts jsonb;inputs jsonb;brand text;
begin
 w:=fluid_private.logo_workspace_json(p_owner,p_project);
 if w->'approvedLogo' is null or w->'approvedLogo'='null' then raise exception 'logo_approval_required' using errcode='PT409';end if;
 if exists(select 1 from jsonb_array_elements(w->'staleStages') s where s->>'stage' in('vector','directions')) then raise exception 'identity_approval_stale' using errcode='PT409';end if;
 select record into logo from public.logo_vector_revisions where id=(w#>>'{approvedLogo,vectorRevisionId}')::uuid and owner_id=p_owner and project_id=p_project;
 select record into direction_stage from public.logo_stage_revisions where id=(w#>>'{stages,directions,id}')::uuid and owner_id=p_owner and project_id=p_project;
 select record into selection from public.logo_direction_records where id=(direction_stage#>>'{payload,selectionId}')::uuid and owner_id=p_owner and project_id=p_project and kind='selection';
 select record into approval from public.logo_direction_records where id=(direction_stage#>>'{payload,approvalId}')::uuid and owner_id=p_owner and project_id=p_project and kind='approval';
 if logo is null or selection is null or approval is null or selection->'approvedLogoId' is distinct from w#>'{approvedLogo,id}' or approval->'approvedLogoId' is distinct from w#>'{approvedLogo,id}' or approval->'directionSelectionId' is distinct from selection->'id' or approval->'consistencyHash' is distinct from selection#>'{consistency,hash}' then raise exception 'identity_approval_required' using errcode='PT409';end if;
 select record into palette from public.logo_direction_records where id=(selection->>'paletteVersionId')::uuid and owner_id=p_owner and project_id=p_project and kind='palette';
 select record into typography from public.logo_direction_records where id=(selection->>'typographyVersionId')::uuid and owner_id=p_owner and project_id=p_project and kind='typography';
 select record into graphics from public.logo_direction_records where id=(selection->>'graphicsVersionId')::uuid and owner_id=p_owner and project_id=p_project and kind='graphics';
 if palette is null or typography is null or graphics is null or exists(select 1 from jsonb_array_elements(jsonb_build_array(palette,typography,graphics)) r where r->'approvedLogoId' is distinct from w#>'{approvedLogo,id}') then raise exception 'identity_components_missing' using errcode='P0002';end if;
 select coalesce(jsonb_agg(record order by record_id),'[]') into fonts from public.logo_font_records f where owner_id=p_owner and project_id=p_project and exists(select 1 from jsonb_array_elements(typography->'styles') s where s->>'fontVersionId'=f.record_id::text);
 if exists(select 1 from jsonb_array_elements(typography->'styles') s where not exists(select 1 from jsonb_array_elements(fonts) f where f->'id'=s->'fontVersionId')) or jsonb_array_length(fonts)>100 then raise exception 'identity_font_sources_missing' using errcode='P0002';end if;
 select record#>>'{payload,name}' into brand from public.logo_stage_revisions where id=(w#>>'{stages,brief_references,id}')::uuid and owner_id=p_owner and project_id=p_project;
 if brand is null or char_length(brand) not between 1 and 200 then raise exception 'brand_name_required' using errcode='55000';end if;
 select jsonb_agg(jsonb_build_object('stage',r.stage,'id',r.id,'revision',r.revision) order by r.stage) into inputs from public.logo_stage_revisions r where r.owner_id=p_owner and r.project_id=p_project and r.id in((w#>>'{stages,brief_references,id}')::uuid,(w#>>'{approvedLogo,stageRevisionId}')::uuid,(direction_stage->>'id')::uuid);
 if jsonb_array_length(inputs)<>3 then raise exception 'export_basis_missing' using errcode='55000';end if;
 return jsonb_build_object('ownerId',p_owner,'projectId',p_project,'brandName',brand,'heads',w->'heads','logo',logo,'logoApproval',w->'approvedLogo','directionSelection',selection,'directionApproval',approval,'palette',palette,'typography',typography,'graphics',graphics,'fonts',fonts,'inputRevisions',inputs);
end $$;
create function public.read_logo_deliverable_sources(p_project_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare owner uuid:=auth.uid();begin
 if owner is null then raise exception 'unauthenticated' using errcode='42501';end if;
 if not exists(select 1 from public.projects where id=p_project_id and owner_id=owner) then raise exception 'logo_project_not_found' using errcode='P0002';end if;
 return fluid_private.logo_approved_deliverable_sources(owner,p_project_id);
end $$;

create function public.read_logo_variant_set(p_project_id uuid,p_set_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare owner uuid:=auth.uid();result jsonb;begin
 if owner is null then raise exception 'unauthenticated' using errcode='42501';end if;
 select record into result from public.logo_variant_sets where id=p_set_id and owner_id=owner and project_id=p_project_id;
 if result is null then raise exception 'variant_set_not_found' using errcode='P0002';end if;return result;
end $$;
create function fluid_private.commit_logo_deliverable_command(p_owner uuid,p_project uuid,p_command jsonb,p_evidence jsonb) returns jsonb language plpgsql set search_path='' as $$
declare b jsonb:=p_command->'body';method text:=p_command->>'method';source jsonb;candidate jsonb;item jsonb;items jsonb:='[]';document public.logo_asset_publications;preview public.logo_asset_publications;stored public.logo_variant_sets;expected_reviews jsonb;review jsonb;revision jsonb;review_id uuid:=gen_random_uuid();prior jsonb;format text;
begin
 source:=fluid_private.logo_approved_deliverable_sources(p_owner,p_project);
 if b->'approvedLogoId' is distinct from source#>'{logoApproval,id}' or b->'directionApprovalId' is distinct from source#>'{directionApproval,id}' then raise exception 'export_approval_changed' using errcode='PT409';end if;
 select r.record->'payload' into prior from public.logo_stage_heads h join public.logo_stage_revisions r on r.id=h.revision_id where h.owner_id=p_owner and h.project_id=p_project and h.stage='deliverables';
 if method='prepareLogoVariants' then
  if (fluid_private.standalone_keys(b,array['requestKey','expected','approvedLogoId','directionApprovalId']) and fluid_private.standalone_keys(p_evidence,array['source','variantSet']) and p_evidence->'source'=source) is not true then raise exception 'variant_source_changed' using errcode='PT409';end if;
  candidate:=p_evidence->'variantSet';
  if (fluid_private.standalone_keys(candidate,array['id','ownerId','projectId','approvedLogoId','directionApprovalId','items','createdAt']) and fluid_private.logo_uuid(candidate->'id') and candidate->>'ownerId'=p_owner::text and candidate->>'projectId'=p_project::text and candidate->'approvedLogoId'=b->'approvedLogoId' and candidate->'directionApprovalId'=b->'directionApprovalId' and fluid_private.standalone_timestamp(candidate->'createdAt') and jsonb_typeof(candidate->'items')='array' and jsonb_array_length(candidate->'items')=12) is not true then raise exception 'invalid_variant_set' using errcode='22023';end if;
  if (select count(*)<>count(distinct value->>'id') or count(*)<>count(distinct (value->>'role',value->>'colorway')) from jsonb_array_elements(candidate->'items')) then raise exception 'duplicate_variant' using errcode='22023';end if;
  for item in select value from jsonb_array_elements(candidate->'items') loop
   if (fluid_private.standalone_keys(item,array['id','role','colorway','documentAsset','renderHash','preview','clearSpace','minimumDigitalSize','applicability','reviewStatus']) and fluid_private.logo_uuid(item->'id') and item->>'role' in('primary','horizontal','stacked','symbol_only') and item->>'colorway' in('black','white','color') and item->>'reviewStatus'='review_required' and jsonb_typeof(item->'clearSpace')='number' and(item->>'clearSpace')::numeric between 0 and 1000000 and(item->'minimumDigitalSize'='null' or(jsonb_typeof(item->'minimumDigitalSize')='number' and(item->>'minimumDigitalSize')::numeric>0 and(item->>'minimumDigitalSize')::numeric<=16384))) is not true then raise exception 'invalid_variant_item' using errcode='22023';end if;
   if item#>>'{applicability,status}'='not_applicable' then
    if (fluid_private.standalone_keys(item->'applicability',array['status','reason']) and item#>>'{applicability,reason}' in('no_symbol','inseparable_artwork') and item->>'role'<>'primary' and item->'documentAsset'='null' and item->'renderHash'='null' and item->'preview'='null') is not true then raise exception 'invalid_variant_omission' using errcode='22023';end if;
   elsif item->'applicability'='{"status":"applicable"}' then
    if (item->>'renderHash' ~ '^[0-9a-f]{64}$' and fluid_private.logo_uuid(item#>'{documentAsset,versionId}') and fluid_private.logo_uuid(item#>'{preview,id}')) is not true then raise exception 'variant_proof_required' using errcode='55000';end if;
    select * into document from public.logo_asset_publications a where a.owner_id=p_owner and a.project_id=p_project and a.version_id=(item#>>'{documentAsset,versionId}')::uuid and a.source_kind='variant' and a.source_receipt_id=(b->>'approvedLogoId')::uuid and a.job_id is null for update;
    select * into preview from public.logo_asset_publications a where a.owner_id=p_owner and a.project_id=p_project and a.id=(item#>>'{preview,id}')::uuid and a.source_kind='variant' and a.source_receipt_id=(b->>'approvedLogoId')::uuid and a.job_id is null for update;
    if document.id is null or preview.id is null or document.state='reserved' or preview.state='reserved' or document.mime_type<>'application/json' or preview.mime_type<>'image/png' or document.request#>'{publication,inputRevisions}' is distinct from source->'inputRevisions' or preview.request#>'{publication,inputRevisions}' is distinct from source->'inputRevisions' or fluid_private.logo_asset_reservation(document)->'reference' is distinct from item->'documentAsset' or fluid_private.logo_asset_receipt(preview) is distinct from item->'preview' then raise exception 'variant_bytes_missing_or_changed' using errcode='55000';end if;
    perform fluid_private.logo_commit_asset(document);
    item:=jsonb_set(item,'{preview}',fluid_private.logo_commit_asset(preview));
   else raise exception 'invalid_variant_applicability' using errcode='22023';end if;
   items:=items||jsonb_build_array(item);
  end loop;
  -- All four roles and three colorways are explicit, even when non-applicable.
  candidate:=jsonb_set(candidate,'{items}',items);
  insert into public.logo_variant_sets(id,owner_id,project_id,approved_logo_id,direction_approval_id,record,source) values((candidate->>'id')::uuid,p_owner,p_project,(b->>'approvedLogoId')::uuid,(b->>'directionApprovalId')::uuid,candidate,source);
  revision:=fluid_private.logo_append_stage(p_owner,p_project,'deliverables',jsonb_build_object('variantSetId',candidate->'id','exportManifestIds',coalesce(prior->'exportManifestIds','[]')),source->'inputRevisions');
  return jsonb_build_object('revision',revision,'variantSet',candidate);
 elsif method='reviewLogoVariants' then
  if (fluid_private.standalone_keys(b,array['requestKey','expected','approvedLogoId','directionApprovalId','variantSetId','acceptedVariantIds']) and fluid_private.logo_uuid(b->'variantSetId') and fluid_private.standalone_keys(p_evidence,array['variantSet','acceptedVariants']) and jsonb_typeof(b->'acceptedVariantIds')='array') is not true then raise exception 'invalid_variant_review' using errcode='22023';end if;
  select * into stored from public.logo_variant_sets where id=(b->>'variantSetId')::uuid and owner_id=p_owner and project_id=p_project;
  if stored.id is null then raise exception 'variant_set_not_found' using errcode='P0002';end if;
  if stored.record is distinct from p_evidence->'variantSet' or stored.source-'heads' is distinct from source-'heads' or prior->'variantSetId' is distinct from b->'variantSetId' then raise exception 'variant_source_changed' using errcode='PT409';end if;
  select jsonb_agg(jsonb_build_object('variantId',value->'id','renderHash',value->'renderHash') order by ordinality) into expected_reviews from jsonb_array_elements(stored.record->'items') with ordinality where value#>>'{applicability,status}'='applicable';
  if expected_reviews is null or p_evidence->'acceptedVariants' is distinct from expected_reviews or jsonb_array_length(b->'acceptedVariantIds')<>jsonb_array_length(expected_reviews) or(select count(*)<>count(distinct value) from jsonb_array_elements(b->'acceptedVariantIds')) or exists(select 1 from jsonb_array_elements(expected_reviews) r where not (b->'acceptedVariantIds' @> jsonb_build_array(r->'variantId'))) then raise exception 'every_variant_requires_review' using errcode='22023';end if;
  review:=jsonb_build_object('id',review_id,'ownerId',p_owner,'projectId',p_project,'variantSetId',stored.id,'approvedLogoId',stored.approved_logo_id,'directionApprovalId',stored.direction_approval_id,'acceptedVariants',expected_reviews,'reviewedAt',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
  insert into public.logo_variant_reviews(id,owner_id,project_id,variant_set_id,record) values(review_id,p_owner,p_project,stored.id,review);
  revision:=fluid_private.logo_append_stage(p_owner,p_project,'deliverables',prior,source->'inputRevisions');
  return jsonb_build_object('revision',revision);
 else raise exception 'deliverable_method_unavailable' using errcode='55000';end if;
end $$;

create function fluid_private.logo_export_expected_files(p_source jsonb) returns jsonb language plpgsql immutable set search_path='' as $$
declare items jsonb:='[]';v jsonb;s jsonb;fmt text;primary_id jsonb;
begin
 for v in select value from jsonb_array_elements(p_source#>'{variants,items}') where value#>>'{applicability,status}'='applicable' loop
  if v->>'role'='primary' and v->>'colorway'='color' then primary_id:=v->'id';end if;
  foreach fmt in array array['svg','pdf','png'] loop items:=items||jsonb_build_array(jsonb_build_object('name',v->>'role'||'-'||(v->>'colorway')||'-'||(v->>'id')||'.'||fmt,'role',v->>'role'||'.'||(v->>'colorway'),'mimeType',case fmt when 'svg' then 'image/svg+xml' when 'pdf' then 'application/pdf' else 'image/png' end,'sourceVariantId',v->'id'));end loop;
 end loop;
 items:=items||jsonb_build_array(jsonb_build_object('name','brand-guidelines.pdf','role','guidelines','mimeType','application/pdf','sourceVariantId',null));
 for s in select value from jsonb_array_elements(p_source->'socialSelections') loop items:=items||jsonb_build_array(jsonb_build_object('name',s->>'kind'||'-'||(s->>'presetId')||'-'||(primary_id#>>'{}')||'.png','role',s->'kind','mimeType','image/png','sourceVariantId',primary_id));end loop;
 return items||jsonb_build_array(jsonb_build_object('name','logo-pack-'||(p_source#>>'{logoApproval,id}')||'.zip','role','pack','mimeType','application/zip','sourceVariantId',null));
end $$;
create function fluid_private.reject_logo_export_admission(p_owner uuid,p_project uuid,p_input jsonb) returns jsonb language plpgsql set search_path='' as $$
declare result jsonb;
begin
 -- The caller holds the owned project lock; the inner admission block has
 -- rolled back every partial write before this exact-body fence is retained.
 result:=jsonb_build_object('kind','logo_export_admission_rejected','errorCode','conflict','rejection',jsonb_build_object('status','rejected','operation','identity.logo_export','ownerId',p_owner,'projectId',p_project,'requestKey',p_input->'requestKey','input',p_input));
 insert into public.logo_operation_rejections(owner_id,project_id,request_key,input,receipt) values(p_owner,p_project,(p_input->>'requestKey')::uuid,p_input,result);
 return result;
end $$;
create function public.request_logo_export(p_project_id uuid,p_input jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare owner uuid:=auth.uid();prior public.logo_operation_requests;rejected public.logo_operation_rejections;failure_message text;policy fluid_private.logo_runtime_policies;source jsonb;variant public.logo_variant_sets;review public.logo_variant_reviews;w jsonb;job_id uuid:=gen_random_uuid();snapshot_hash text;input_hash text;job_input jsonb;receipt jsonb;plan jsonb;item jsonb;expected_reviews jsonb;basis jsonb;
begin
 if owner is null then raise exception 'unauthenticated' using errcode='42501';end if;
 if (fluid_private.standalone_keys(p_input,array['requestKey','expected','approvedLogoId','directionApprovalId','variantSetId','pngLongEdge','socialSelections']) and fluid_private.logo_uuid(p_input->'requestKey') and fluid_private.logo_uuid(p_input->'approvedLogoId') and fluid_private.logo_uuid(p_input->'directionApprovalId') and fluid_private.logo_uuid(p_input->'variantSetId') and p_input->'pngLongEdge' in('512','1024','2048','4096') and jsonb_typeof(p_input->'socialSelections')='array' and jsonb_array_length(p_input->'socialSelections')<=2 and octet_length(p_input::text)<=32768) is not true then raise exception 'invalid_export_intent' using errcode='22023';end if;
 for item in select value from jsonb_array_elements(p_input->'socialSelections') loop
  if (fluid_private.standalone_keys(item,array['kind','presetId']) and(item='{"kind":"avatar","presetId":"avatar-1024-contain-v1"}' or item='{"kind":"banner","presetId":"banner-1500x500-contain-v1"}')) is not true then raise exception 'invalid_export_social' using errcode='22023';end if;
 end loop;
 if(select count(*)<>count(distinct value) from jsonb_array_elements(p_input->'socialSelections')) then raise exception 'duplicate_export_social' using errcode='22023';end if;
 perform 1 from public.projects where id=p_project_id and owner_id=owner for update;if not found then raise exception 'logo_project_not_found' using errcode='P0002';end if;
 select * into prior from public.logo_operation_requests where owner_id=owner and project_id=p_project_id and request_key=(p_input->>'requestKey')::uuid;
 if found then if prior.input is distinct from p_input then raise exception 'logo_request_conflict' using errcode='PT409';end if;return prior.receipt;end if;
 select * into rejected from public.logo_operation_rejections where owner_id=owner and project_id=p_project_id and request_key=(p_input->>'requestKey')::uuid;
 if found then
  if rejected.input is distinct from p_input or rejected.receipt->>'kind' is distinct from 'logo_export_admission_rejected' then raise exception 'logo_request_conflict' using errcode='PT409';end if;return rejected.receipt;
 end if;
 if exists(select 1 from public.logo_workspace_requests where owner_id=owner and project_id=p_project_id and request_key=(p_input->>'requestKey')::uuid) then raise exception 'logo_request_conflict' using errcode='PT409';end if;
 begin
 w:=fluid_private.logo_workspace_json(owner,p_project_id);
 if w->'heads' is distinct from p_input->'expected' then raise exception 'logo_head_conflict' using errcode='PT409';end if;
 source:=fluid_private.logo_approved_deliverable_sources(owner,p_project_id);
 if source#>'{logoApproval,id}' is distinct from p_input->'approvedLogoId' or source#>'{directionApproval,id}' is distinct from p_input->'directionApprovalId' then raise exception 'export_approval_changed' using errcode='PT409';end if;
 select * into variant from public.logo_variant_sets where id=(p_input->>'variantSetId')::uuid and owner_id=owner and project_id=p_project_id;
 select r.record->'payload' into basis from public.logo_stage_heads h join public.logo_stage_revisions r on r.id=h.revision_id where h.owner_id=owner and h.project_id=p_project_id and h.stage='deliverables';
 if variant.id is null or variant.source-'heads' is distinct from source-'heads' or basis->'variantSetId' is distinct from p_input->'variantSetId' then raise exception 'export_variant_source_changed' using errcode='PT409';end if;
 select * into review from public.logo_variant_reviews where variant_set_id=variant.id and owner_id=owner and project_id=p_project_id order by created_at desc,id desc limit 1;
 select jsonb_agg(jsonb_build_object('variantId',value->'id','renderHash',value->'renderHash') order by ordinality) into expected_reviews from jsonb_array_elements(variant.record->'items') with ordinality where value#>>'{applicability,status}'='applicable';
 if review.id is null or review.record->'acceptedVariants' is distinct from expected_reviews then raise exception 'variant_review_required' using errcode='PT409';end if;
 select * into policy from fluid_private.logo_runtime_policies where owner_id=owner and operation='identity.logo_export' and enabled for share;
 if not found or policy.handler_version<>'logo-export-v1' or policy.provider is not null or policy.model is not null or policy.max_cost_microusd<>0 then raise exception 'export_runtime_unavailable' using errcode='55000';end if;
 select jsonb_build_object('stage',r.stage,'id',r.id,'revision',r.revision) into basis from public.logo_stage_heads h join public.logo_stage_revisions r on r.id=h.revision_id where h.owner_id=owner and h.project_id=p_project_id and h.stage='deliverables';
 source:=source||jsonb_build_object('inputRevisions',(source->'inputRevisions')||jsonb_build_array(basis),'variants',variant.record,'variantReview',review.record,'pngLongEdge',p_input->'pngLongEdge','socialSelections',p_input->'socialSelections');
 snapshot_hash:=encode(sha256(convert_to(source::text,'UTF8')),'hex');source:=source||jsonb_build_object('sourceSnapshotHash',snapshot_hash);
 input_hash:=encode(sha256(convert_to(jsonb_build_object('sourceSnapshotHash',snapshot_hash,'policyIdentity',policy.policy_identity,'handlerVersion',policy.handler_version)::text,'UTF8')),'hex');
 job_input:=jsonb_build_object('version',2,'ownerId',owner,'projectId',p_project_id,'requestKey',p_input->'requestKey','policyIdentity',policy.policy_identity,'handlerVersion',policy.handler_version,'inputHash',input_hash,'operation','identity.logo_export','approvedLogoId',p_input->'approvedLogoId','directionApprovalId',p_input->'directionApprovalId','variantSetId',variant.id,'variantReviewId',review.id,'sourceSnapshotHash',snapshot_hash);
 plan:='[{"key":"prepare-export","maximumCostMicrousd":0}]';
 insert into public.jobs(id,owner_id,project_id,operation,input_revision,input_hash,input,idempotency_key,reserved_cost_microusd,max_attempts,plan_manifest,plan_fingerprint,plan_registered_at) values(job_id,owner,p_project_id,'identity.logo_export',(p_input#>>'{expected,projectRevision}')::integer,input_hash,job_input,'logo:'||job_id,0,3,plan,encode(sha256(convert_to(plan::text,'UTF8')),'hex'),clock_timestamp());
 insert into public.logo_export_inputs(job_id,owner_id,project_id,source_snapshot_hash,source) values(job_id,owner,p_project_id,snapshot_hash,source);
 insert into public.usage_reservations(job_id,owner_id,project_id,reserved_microusd) values(job_id,owner,p_project_id,0);
 receipt:=jsonb_build_object('ownerId',owner,'projectId',p_project_id,'requestKey',p_input->'requestKey','operation','identity.logo_export','batchId',null,'jobIds',jsonb_build_array(job_id),'inputHash',input_hash);
 insert into public.logo_operation_requests(owner_id,project_id,request_key,quote_id,input,receipt) values(owner,p_project_id,(p_input->>'requestKey')::uuid,null,p_input,receipt);
 return receipt;
 exception when sqlstate 'PT409' then
  get stacked diagnostics failure_message=MESSAGE_TEXT;
  if failure_message in('logo_head_conflict','export_approval_changed','export_variant_source_changed','variant_review_required','logo_approval_required','identity_approval_stale','identity_approval_required') then
   return fluid_private.reject_logo_export_admission(owner,p_project_id,p_input);
  end if;raise;
 end;
end $$;
create function fluid_private.logo_export_input_revisions(p_job public.jobs) returns jsonb language plpgsql stable set search_path='' as $$
declare result jsonb;begin
 select source->'inputRevisions' into result from public.logo_export_inputs where job_id=p_job.id and owner_id=p_job.owner_id and project_id=p_job.project_id and source_snapshot_hash=p_job.input->>'sourceSnapshotHash';
 if result is null then raise exception 'export_input_missing' using errcode='55000';end if;return result;
end $$;
create function fluid_private.logo_export_can_read_asset(p_job public.jobs,p_reference jsonb) returns boolean language plpgsql stable set search_path='' as $$
declare source jsonb;begin
 select e.source into source from public.logo_export_inputs e where e.job_id=p_job.id and e.owner_id=p_job.owner_id and e.project_id=p_job.project_id and e.source_snapshot_hash=p_job.input->>'sourceSnapshotHash';
 return source is not null and(source#>'{logo,documentAsset}'=p_reference or source#>'{logo,svgAsset}'=p_reference or source#>'{logo,sourcePreview}'=p_reference or exists(select 1 from jsonb_array_elements(source->'fonts') f where f->'asset'=p_reference) or exists(select 1 from jsonb_array_elements(source#>'{variants,items}') v where v->'documentAsset'=p_reference or v#>'{preview,reference}'=p_reference));
end $$;
create function public.load_logo_export_inputs(p_job uuid,p_lease uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.jobs;e public.logo_export_inputs;begin
 j:=fluid_private.logo_lock_job(p_job,p_lease);
 select * into e from public.logo_export_inputs where job_id=j.id and owner_id=j.owner_id and project_id=j.project_id;
 if j.operation<>'identity.logo_export' or e.job_id is null or e.source_snapshot_hash is distinct from j.input->>'sourceSnapshotHash' or encode(sha256(convert_to((e.source-'sourceSnapshotHash')::text,'UTF8')),'hex')<>e.source_snapshot_hash then raise exception 'export_input_not_found' using errcode='P0002';end if;return e.source;
end $$;
create function public.get_logo_export(p_project_id uuid,p_export_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare owner uuid:=auth.uid();result jsonb;begin
 if owner is null then raise exception 'unauthenticated' using errcode='42501';end if;
 select record into result from public.logo_export_manifests where id=p_export_id and owner_id=owner and project_id=p_project_id;
 if result is null then raise exception 'export_manifest_not_found' using errcode='P0002';end if;return result;
end $$;
create function public.get_logo_deliverables(p_project_id uuid,p_query jsonb) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare owner uuid:=auth.uid();w jsonb;lim integer;current_set uuid;direction_approval jsonb;sets jsonb;reviews jsonb;exports jsonb:='[]';requests jsonb:='[]';m public.logo_export_manifests;req public.logo_operation_requests;anchor public.logo_export_manifests;request_anchor public.logo_operation_requests;last_id uuid;last_request uuid;next_cursor text;next_request text;seen integer:=0;manifest_id uuid;stale boolean;
begin
 if owner is null then raise exception 'unauthenticated' using errcode='42501';end if;
 if not exists(select 1 from public.projects where id=p_project_id and owner_id=owner) then raise exception 'logo_project_not_found' using errcode='P0002';end if;
 if (jsonb_typeof(p_query)='object' and p_query-array['cursor','requestCursor','limit']='{}' and(not(p_query?'limit') or(jsonb_typeof(p_query->'limit')='number' and(p_query->>'limit')::numeric=trunc((p_query->>'limit')::numeric) and(p_query->>'limit')::numeric between 1 and 50))) is not true then raise exception 'invalid_export_page' using errcode='22023';end if;
 lim:=coalesce((p_query->>'limit')::integer,20);w:=fluid_private.logo_workspace_json(owner,p_project_id);
 select (r.record#>>'{payload,variantSetId}')::uuid into current_set from public.logo_stage_heads h join public.logo_stage_revisions r on r.id=h.revision_id where h.owner_id=owner and h.project_id=p_project_id and h.stage='deliverables';
 select d.record into direction_approval from public.logo_stage_heads h join public.logo_stage_revisions r on r.id=h.revision_id join public.logo_direction_records d on d.id::text=r.record#>>'{payload,approvalId}' and d.owner_id=owner and d.project_id=p_project_id and d.kind='approval' where h.owner_id=owner and h.project_id=p_project_id and h.stage='directions';
 select coalesce(jsonb_agg(record order by current desc,created_at desc,id desc),'[]') into sets from(select record,id,created_at,id=current_set current from public.logo_variant_sets where owner_id=owner and project_id=p_project_id order by(id=current_set) desc nulls last,created_at desc,id desc limit 50) s;
 select coalesce(jsonb_agg(record order by current desc,created_at desc,id desc),'[]') into reviews from(select record,id,created_at,variant_set_id=current_set current from public.logo_variant_reviews where owner_id=owner and project_id=p_project_id and exists(select 1 from jsonb_array_elements(sets) s where s->>'id'=variant_set_id::text) order by(variant_set_id=current_set) desc nulls last,created_at desc,id desc limit 50) r;
 if p_query?'cursor' then
  if not fluid_private.logo_uuid(p_query->'cursor') then raise exception 'invalid_export_cursor' using errcode='22023';end if;
  select * into anchor from public.logo_export_manifests where id=(p_query->>'cursor')::uuid and owner_id=owner and project_id=p_project_id;
  if not found then raise exception 'invalid_export_cursor' using errcode='22023';end if;
 end if;
 for m in select * from public.logo_export_manifests where owner_id=owner and project_id=p_project_id and(anchor.id is null or(created_at,id)<(anchor.created_at,anchor.id)) order by created_at desc,id desc limit lim+1 loop
  seen:=seen+1;if seen>lim then next_cursor:=last_id::text;exit;end if;
  stale:=m.record->'approvedLogoId' is distinct from w#>'{approvedLogo,id}' or m.record->'directionApprovalId' is distinct from direction_approval->'id' or m.record->>'variantSetId' is distinct from current_set::text or exists(select 1 from jsonb_array_elements(w->'staleStages') s where s->>'stage' in('vector','directions'));
  exports:=exports||jsonb_build_array(jsonb_build_object('manifest',m.record,'stale',stale));last_id:=m.id;
 end loop;
 if p_query?'requestCursor' then
  if not fluid_private.logo_uuid(p_query->'requestCursor') then raise exception 'invalid_export_request_cursor' using errcode='22023';end if;
  select * into request_anchor from public.logo_operation_requests where request_key=(p_query->>'requestCursor')::uuid and owner_id=owner and project_id=p_project_id and receipt->>'operation'='identity.logo_export';
  if not found then raise exception 'invalid_export_request_cursor' using errcode='22023';end if;
 end if;
 seen:=0;
 for req in select * from public.logo_operation_requests where owner_id=owner and project_id=p_project_id and receipt->>'operation'='identity.logo_export' and(request_anchor.request_key is null or(created_at,request_key)<(request_anchor.created_at,request_anchor.request_key)) order by created_at desc,request_key desc limit lim+1 loop
  seen:=seen+1;if seen>lim then next_request:=last_request::text;exit;end if;
  select e.id into manifest_id from public.logo_export_manifests e where e.owner_id=owner and e.project_id=p_project_id and e.record->>'requestKey'=req.request_key::text;
  requests:=requests||jsonb_build_array(jsonb_build_object('requestKey',req.request_key,'input',req.input,'state',public.read_logo_request(p_project_id,req.request_key),'exportManifestId',manifest_id,'createdAt',to_char(req.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));last_request:=req.request_key;
 end loop;
 return jsonb_build_object('ownerId',owner,'projectId',p_project_id,'logoApproval',w->'approvedLogo','directionApproval',direction_approval,'variantSets',sets,'variantReviews',reviews,'exports',exports,'exportRequests',requests,'nextCursor',next_cursor,'nextRequestCursor',next_request);
end $$;
create function fluid_private.logo_export_group_valid(p_job public.jobs,p_result jsonb) returns boolean language plpgsql stable set search_path='' as $$
declare source jsonb;expected jsonb;file jsonb;asset public.logo_asset_publications;i integer:=0;count_files integer;
begin
 select e.source into source from public.logo_export_inputs e where e.job_id=p_job.id and e.owner_id=p_job.owner_id and e.project_id=p_job.project_id;
 if (source is not null and p_job.operation='identity.logo_export' and source->'sourceSnapshotHash'=p_job.input->'sourceSnapshotHash' and fluid_private.standalone_keys(p_result,array['sourceSnapshotHash','completeness','failure','files','assetReceiptIds']) and p_result->'sourceSnapshotHash'=source->'sourceSnapshotHash' and jsonb_typeof(p_result->'files')='array' and jsonb_typeof(p_result->'assetReceiptIds')='array' and octet_length(p_result::text)<=262144) is not true then return false;end if;
 count_files:=jsonb_array_length(p_result->'files');expected:=fluid_private.logo_export_expected_files(source);
 if count_files not between 1 and 100 or count_files<>jsonb_array_length(p_result->'assetReceiptIds') or(select count(*)<>count(distinct value) from jsonb_array_elements(p_result->'assetReceiptIds')) then return false;end if;
 if p_result->>'completeness'='complete' then
  if p_result->'failure'<>'null' or count_files<>jsonb_array_length(expected) then return false;end if;
 elsif p_result->>'completeness'='partial' then
  if (p_result->>'failure' in('file_failed','package_too_large') and count_files<jsonb_array_length(expected)) is not true then return false;end if;
 else return false;end if;
 for file in select value from jsonb_array_elements(p_result->'files') loop
  if (fluid_private.standalone_keys(file,array['name','role','mimeType','contentHash','sourceVariantId','byteLength']) and (file-array['contentHash','byteLength'])=expected->i and file->>'contentHash' ~ '^[0-9a-f]{64}$' and jsonb_typeof(file->'byteLength')='number' and(file->>'byteLength')::numeric between 1 and 52428800 and(file->>'byteLength')::numeric=trunc((file->>'byteLength')::numeric) and fluid_private.logo_uuid(p_result#>array['assetReceiptIds',i::text])) is not true then return false;end if;
  select * into asset from public.logo_asset_publications where id=(p_result#>>array['assetReceiptIds',i::text])::uuid and owner_id=p_job.owner_id and project_id=p_job.project_id and job_id=p_job.id and lease_token=p_job.lease_token;
  if asset.id is null or asset.state='reserved' or asset.source_kind<>'export' or asset.source_receipt_id<>p_job.id or asset.purpose<>'brand_asset' or asset.request#>'{publication,inputRevisions}' is distinct from source->'inputRevisions' or asset.mime_type is distinct from file->>'mimeType' or asset.content_hash is distinct from file->>'contentHash' or to_jsonb(asset.byte_length) is distinct from file->'byteLength' then return false;end if;
  i:=i+1;
 end loop;return true;
exception when invalid_text_representation or numeric_value_out_of_range or invalid_parameter_value then return false;
end $$;
create function public.stage_logo_exports(p_job uuid,p_lease uuid,p_result jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.jobs;p public.logo_export_publications;ids uuid[];
begin
 perform 1 from public.projects where id=(select project_id from public.jobs where id=p_job and owner_id=fluid_private.logo_worker_owner()) for update;
 j:=fluid_private.logo_lock_job(p_job,p_lease);
 if not fluid_private.logo_export_group_valid(j,p_result) then raise exception 'invalid_export_group' using errcode='22023';end if;
 select array_agg(value::uuid order by ordinality) into ids from jsonb_array_elements_text(p_result->'assetReceiptIds') with ordinality;
 select * into p from public.logo_export_publications where job_id=j.id;
 if found then
  if p.lease_token<>p_lease or p.source_snapshot_hash is distinct from p_result->>'sourceSnapshotHash' or p.completeness is distinct from p_result->>'completeness' or p.failure is distinct from p_result->>'failure' or p.files is distinct from p_result->'files' or p.asset_receipt_ids is distinct from ids then raise exception 'immutable_export_group' using errcode='PT409';end if;
 else
  insert into public.logo_export_publications(job_id,owner_id,project_id,lease_token,source_snapshot_hash,completeness,failure,files,asset_receipt_ids) values(j.id,j.owner_id,j.project_id,p_lease,p_result->>'sourceSnapshotHash',p_result->>'completeness',p_result->>'failure',p_result->'files',ids) returning * into p;
 end if;
 return jsonb_build_object('id',p.id,'ownerId',p.owner_id,'projectId',p.project_id,'jobId',p.job_id,'sourceSnapshotHash',p.source_snapshot_hash,'assetReceiptIds',to_jsonb(p.asset_receipt_ids),'publicationState','staged');
end $$;
create function fluid_private.logo_export_job_outputs(p_job public.jobs) returns jsonb language sql stable set search_path='' as $$
 select coalesce(jsonb_agg(fluid_private.logo_asset_receipt(a) order by member.ordinality),'[]') from public.logo_export_publications p
 cross join lateral unnest(p.asset_receipt_ids) with ordinality member(id,ordinality)
 join public.logo_asset_publications a on a.id=member.id and a.owner_id=p.owner_id and a.project_id=p.project_id and a.job_id=p.job_id and a.state='committed'
 where p.job_id=p_job.id and p.owner_id=p_job.owner_id and p.project_id=p_job.project_id and p.committed_at is not null
$$;
create function fluid_private.logo_commit_export_publication(p_job public.jobs,p_publication uuid) returns jsonb language plpgsql set search_path='' as $$
declare j public.jobs;p public.logo_export_publications;source jsonb;file jsonb;files jsonb:='[]';outputs jsonb:='[]';receipt jsonb;manifest jsonb;revision jsonb;omissions jsonb;prior jsonb;i integer:=0;group_input jsonb;
begin
 j:=fluid_private.logo_lock_job(p_job.id,p_job.lease_token);
 select * into p from public.logo_export_publications where id=p_publication and job_id=j.id and owner_id=j.owner_id and project_id=j.project_id and lease_token=j.lease_token for update;
 if p.id is null then raise exception 'export_publication_not_found' using errcode='P0002';end if;
 if p.committed_at is not null then return jsonb_build_object('publicationId',p.id,'completeness',p.completeness,'failure',p.failure,'manifestId',p.manifest_id,'stageRevision',p.stage_revision,'outputs',fluid_private.logo_export_job_outputs(j));end if;
 group_input:=jsonb_build_object('sourceSnapshotHash',p.source_snapshot_hash,'completeness',p.completeness,'failure',p.failure,'files',p.files,'assetReceiptIds',to_jsonb(p.asset_receipt_ids));
 if not fluid_private.logo_export_group_valid(j,group_input) then raise exception 'export_group_changed' using errcode='55000';end if;
 select e.source into source from public.logo_export_inputs e where e.job_id=j.id;
 for file in select value from jsonb_array_elements(p.files) loop
  i:=i+1;receipt:=fluid_private.commit_logo_asset_publication(j,p.asset_receipt_ids[i]);outputs:=outputs||jsonb_build_array(receipt);
  files:=files||jsonb_build_array(jsonb_build_object('role',file->'role','format',case file->>'mimeType' when 'image/svg+xml' then 'svg' when 'application/pdf' then 'pdf' when 'image/png' then 'png' when 'application/zip' then 'zip' end,'variantId',file->'sourceVariantId','asset',receipt));
 end loop;
 if p.completeness='complete' then
  select coalesce(jsonb_agg(jsonb_build_object('fontVersionId',f->'id','reason','Font binaries are not included. Consult the exact font license and source; permitted PDF specimens do not grant redistribution rights.') order by ordinality),'[]') into omissions from jsonb_array_elements(source->'fonts') with ordinality f(f,ordinality);
  manifest:=jsonb_build_object('id',p.id,'ownerId',j.owner_id,'projectId',j.project_id,'requestKey',j.input->'requestKey','approvedLogoId',source#>'{logoApproval,id}','directionApprovalId',source#>'{directionApproval,id}','variantSetId',source#>'{variants,id}','variantReviewId',source#>'{variantReview,id}','sourceSnapshotHash',p.source_snapshot_hash,'files',files,'licenseOmissions',omissions,'inputRevisions',source->'inputRevisions','createdAt',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
  insert into public.logo_export_manifests(id,owner_id,project_id,publication_id,job_id,record) values(p.id,j.owner_id,j.project_id,p.id,j.id,manifest);
  if j.state='running' and fluid_private.logo_workspace_json(j.owner_id,j.project_id)->'heads'=source->'heads' then
   select r.record->'payload' into prior from public.logo_stage_heads h join public.logo_stage_revisions r on r.id=h.revision_id where h.owner_id=j.owner_id and h.project_id=j.project_id and h.stage='deliverables';
   revision:=fluid_private.logo_append_stage(j.owner_id,j.project_id,'deliverables',jsonb_build_object('variantSetId',source#>'{variants,id}','exportManifestIds',coalesce(prior->'exportManifestIds','[]')||jsonb_build_array(p.id)),source->'inputRevisions');
  end if;
 end if;
 update public.logo_export_publications set committed_at=clock_timestamp(),stage_revision=revision,manifest_id=case when p.completeness='complete' then p.id else null end where id=p.id;
 return jsonb_build_object('publicationId',p.id,'completeness',p.completeness,'failure',p.failure,'manifestId',case when p.completeness='complete' then p.id else null end,'stageRevision',revision,'outputs',outputs);
end $$;

-- Scrub exact-object inherited/default privileges; no new principal receives a grant.
do $$declare t text;s text;r record;begin
 foreach t in array array['logo_variant_sets','logo_variant_reviews','logo_export_inputs','logo_export_publications','logo_export_manifests'] loop
  for r in select distinct a.grantee from pg_class c cross join lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a where c.oid=to_regclass(format('public.%I',t)) and a.grantee<>c.relowner loop execute format('revoke all on table public.%I from %s cascade',t,case when r.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(r.grantee)) end);end loop;
  execute format('alter table public.%I enable row level security',t);execute format('alter table public.%I force row level security',t);
  if t in('logo_variant_sets','logo_variant_reviews','logo_export_manifests') then execute format('create policy logo_export_owned_read on public.%I for select to authenticated using(owner_id=auth.uid())',t);execute format('grant select on public.%I to authenticated',t);end if;
 end loop;
 foreach s in array array['fluid_private.logo_export_publication_immutable()','fluid_private.logo_approved_deliverable_sources(uuid,uuid)','public.read_logo_deliverable_sources(uuid)','public.read_logo_variant_set(uuid,uuid)','fluid_private.commit_logo_deliverable_command(uuid,uuid,jsonb,jsonb)','fluid_private.logo_export_expected_files(jsonb)','public.request_logo_export(uuid,jsonb)','fluid_private.reject_logo_export_admission(uuid,uuid,jsonb)','fluid_private.logo_export_input_revisions(public.jobs)','fluid_private.logo_export_can_read_asset(public.jobs,jsonb)','public.load_logo_export_inputs(uuid,uuid)','public.get_logo_export(uuid,uuid)','public.get_logo_deliverables(uuid,jsonb)','fluid_private.logo_export_group_valid(public.jobs,jsonb)','public.stage_logo_exports(uuid,uuid,jsonb)','fluid_private.logo_export_job_outputs(public.jobs)','fluid_private.logo_commit_export_publication(public.jobs,uuid)'] loop
  for r in select distinct a.grantee from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where p.oid=to_regprocedure(s) and a.grantee<>p.proowner loop execute format('revoke all on function %s from %s cascade',s,case when r.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(r.grantee)) end);end loop;
 end loop;
end $$;
grant execute on function public.read_logo_deliverable_sources(uuid) to authenticated;
grant execute on function public.read_logo_variant_set(uuid,uuid) to authenticated;
grant execute on function public.request_logo_export(uuid,jsonb) to authenticated;
grant execute on function public.get_logo_export(uuid,uuid) to authenticated;
grant execute on function public.get_logo_deliverables(uuid,jsonb) to authenticated;
commit;
