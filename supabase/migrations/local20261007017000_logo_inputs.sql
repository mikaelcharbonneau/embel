-- LOCAL PROPOSAL ONLY. Supabase CLI was unavailable. Not generated/applied remotely.
-- Requires reviewed owner-bound asset login and private object storage. No roles,
-- credentials, runtime policies, provider admission or grants to web logins created.
begin;
create table fluid_private.logo_input_font_catalog (
 id text primary key, record jsonb not null,
 check(record->>'id'=id and octet_length(record::text)<16384)
);
create table public.logo_input_requests (
 owner_id uuid not null, project_id uuid not null, request_key uuid not null,
 request jsonb not null, created_at timestamptz not null default clock_timestamp(),
 primary key(owner_id,project_id,request_key),
 foreign key(project_id,owner_id) references public.projects(id,owner_id),
 check(request#>>'{input,requestKey}'=request_key::text and octet_length(request::text)<=327680)
);
create table public.logo_input_rejections (
 owner_id uuid not null, project_id uuid not null, request_key uuid not null, reason text not null check(reason in('inputs_changed','cancelled_by_user')),
 primary key(owner_id,project_id,request_key),foreign key(owner_id,project_id,request_key) references public.logo_input_requests(owner_id,project_id,request_key)
);
create trigger logo_input_rejections_immutable before update or delete on public.logo_input_rejections for each row execute function fluid_private.prevent_history_change();
create table public.logo_input_rights (
 id uuid primary key, owner_id uuid not null, project_id uuid not null,
 publication_id uuid not null unique references public.logo_asset_publications(id),
 source_kind text not null check(source_kind in('user_declaration','reviewed_license')),
 content_hash text not null check(content_hash~'^[0-9a-f]{64}$'),
 rights_declaration text not null check(length(rights_declaration) between 1 and 2000),
 license_text text, license_text_hash text, source_url text, catalog_id text references fluid_private.logo_input_font_catalog(id),
 foreign key(project_id,owner_id) references public.projects(id,owner_id),
 check((license_text is null)=(license_text_hash is null)),
 check(license_text is null or(octet_length(license_text)<=262144 and license_text_hash=encode(sha256(convert_to(license_text,'UTF8')),'hex'))),
 check((source_kind='reviewed_license')=(catalog_id is not null))
);
create table public.logo_input_receipts (
 owner_id uuid not null, project_id uuid not null, request_key uuid not null,
 result jsonb not null, reference_id uuid, font_record_id uuid, created_at timestamptz not null default clock_timestamp(),
 primary key(owner_id,project_id,request_key),
 foreign key(owner_id,project_id,request_key) references public.logo_input_requests(owner_id,project_id,request_key),
 foreign key(reference_id,project_id,owner_id) references public.logo_reference_sources(reference_id,project_id,owner_id),
 foreign key(font_record_id) references public.logo_font_records(record_id),
 check((reference_id is null)<>(font_record_id is null)),check(octet_length(result::text)<=65536)
);
create unique index logo_input_reference_receipt on public.logo_input_receipts(reference_id) where reference_id is not null;
create unique index logo_input_font_receipt on public.logo_input_receipts(font_record_id) where font_record_id is not null;
create trigger logo_input_catalog_immutable before update or delete on fluid_private.logo_input_font_catalog for each row execute function fluid_private.prevent_history_change();
create trigger logo_input_requests_immutable before update or delete on public.logo_input_requests for each row execute function fluid_private.prevent_history_change();
create trigger logo_input_rights_immutable before update or delete on public.logo_input_rights for each row execute function fluid_private.prevent_history_change();
create trigger logo_input_receipts_immutable before update or delete on public.logo_input_receipts for each row execute function fluid_private.prevent_history_change();
insert into fluid_private.logo_input_font_catalog(id,record) values('geist-sans-variable','{"id":"geist-sans-variable","family":"Geist","contentHash":"cdcc4815cbf5f9882fa74e48f8ab410a0495781a58ff7316570f664e7e987753","mimeType":"font/ttf","rights":{"id":"64100000-0000-4000-8000-000000000001","fontContentHash":"cdcc4815cbf5f9882fa74e48f8ab410a0495781a58ff7316570f664e7e987753","sourceKind":"reviewed_license","sourceUrl":"https://github.com/vercel/geist-font/blob/main/OFL.txt","licenseTextHash":"930853ee1daa68554d9e35c8a9175affb74f699fad9a5da6ee5ebe76379d9137","commercialUse":"allowed","permissions":{"render":"allowed","outline":"allowed","embed":"allowed","modify":"allowed","redistribute":"allowed"},"reviewedAt":"2026-10-07T01:42:00Z"}}'::jsonb);
insert into fluid_private.logo_input_font_catalog(id,record) values('geist-sans-italic','{"id":"geist-sans-italic","family":"Geist","contentHash":"c5db6397dae7993afb72e397277c5a5308ba32de010eb19ec2b8b73f5e9d3ec4","mimeType":"font/ttf","rights":{"id":"64100000-0000-4000-8000-000000000002","fontContentHash":"c5db6397dae7993afb72e397277c5a5308ba32de010eb19ec2b8b73f5e9d3ec4","sourceKind":"reviewed_license","sourceUrl":"https://github.com/vercel/geist-font/blob/main/OFL.txt","licenseTextHash":"930853ee1daa68554d9e35c8a9175affb74f699fad9a5da6ee5ebe76379d9137","commercialUse":"allowed","permissions":{"render":"allowed","outline":"allowed","embed":"allowed","modify":"allowed","redistribute":"allowed"},"reviewedAt":"2026-10-07T01:42:00Z"}}'::jsonb);
insert into fluid_private.logo_input_font_catalog(id,record) values('geist-mono-variable','{"id":"geist-mono-variable","family":"Geist Mono","contentHash":"0e1af3f507a1c8dfbb03d13ffad585834cd45ed7ccb78c756c7ce7873d180d30","mimeType":"font/ttf","rights":{"id":"64100000-0000-4000-8000-000000000003","fontContentHash":"0e1af3f507a1c8dfbb03d13ffad585834cd45ed7ccb78c756c7ce7873d180d30","sourceKind":"reviewed_license","sourceUrl":"https://github.com/vercel/geist-font/blob/main/OFL.txt","licenseTextHash":"930853ee1daa68554d9e35c8a9175affb74f699fad9a5da6ee5ebe76379d9137","commercialUse":"allowed","permissions":{"render":"allowed","outline":"allowed","embed":"allowed","modify":"allowed","redistribute":"allowed"},"reviewedAt":"2026-10-07T01:42:00Z"}}'::jsonb);
insert into fluid_private.logo_input_font_catalog(id,record) values('geist-mono-italic','{"id":"geist-mono-italic","family":"Geist Mono","contentHash":"e5800990ff5069667f4ff0a5dc582b260597e0adc022a887d9d103fc4cdd2cf2","mimeType":"font/ttf","rights":{"id":"64100000-0000-4000-8000-000000000004","fontContentHash":"e5800990ff5069667f4ff0a5dc582b260597e0adc022a887d9d103fc4cdd2cf2","sourceKind":"reviewed_license","sourceUrl":"https://github.com/vercel/geist-font/blob/main/OFL.txt","licenseTextHash":"930853ee1daa68554d9e35c8a9175affb74f699fad9a5da6ee5ebe76379d9137","commercialUse":"allowed","permissions":{"render":"allowed","outline":"allowed","embed":"allowed","modify":"allowed","redistribute":"allowed"},"reviewedAt":"2026-10-07T01:42:00Z"}}'::jsonb);

create function fluid_private.logo_input_request_valid(v jsonb) returns boolean language plpgsql immutable set search_path='' as $$
declare b jsonb:=v->'input'; f jsonb:=v->'file'; k text:=v->>'kind'; n numeric; source_url text; source_host text; source_port text;
begin
 if not fluid_private.standalone_keys(v,array['kind','input','file']) or octet_length(v::text)>327680 or jsonb_typeof(v->'kind') is distinct from 'string' or k not in('reference_upload','font_upload','font_catalog') then return false;end if;
 if not fluid_private.logo_command_valid(jsonb_build_object('method','saveLogoReferences','body',jsonb_build_object('requestKey',b->'requestKey','expected',b->'expected','selections','[]'::jsonb))) then return false;end if;
 if not fluid_private.standalone_keys(f,array['contentHash','mimeType','byteLength']) or jsonb_typeof(f->'contentHash') is distinct from 'string' or f->>'contentHash' !~ '^[0-9a-f]{64}$' or jsonb_typeof(f->'byteLength') is distinct from 'number' or jsonb_typeof(f->'mimeType') is distinct from 'string' then return false;end if;
 n:=(f->>'byteLength')::numeric;if n<>trunc(n) or n<1 or n>(case when k='reference_upload' then 33554432 else 10485760 end) then return false;end if;
 if k='reference_upload' then
  return fluid_private.standalone_keys(b,array['requestKey','expected','aspects','rightsDeclaration'])
   and f->>'mimeType' in('image/png','image/jpeg','image/webp')
   and fluid_private.standalone_text(b->'rightsDeclaration',2000,1) and fluid_private.idea_trim(b->>'rightsDeclaration')<>''
   and fluid_private.logo_command_valid(jsonb_build_object('method','saveLogoReferences','body',jsonb_build_object('requestKey',b->'requestKey','expected',b->'expected','selections',jsonb_build_array(jsonb_build_object('referenceId',b->'requestKey','aspects',b->'aspects')))));
 end if;
 if jsonb_typeof(f->'mimeType') is distinct from 'string' or f->>'mimeType' not in('font/ttf','font/otf') or n<12 then return false;end if;
 if k='font_catalog' then return fluid_private.standalone_keys(b,array['requestKey','expected','catalogFontId']) and jsonb_typeof(b->'catalogFontId')='string' and length(b->>'catalogFontId') between 1 and 100 and b->>'catalogFontId'~'^[a-z][a-z0-9-]*$';end if;
 if b->'licenseSourceUrl' is distinct from 'null'::jsonb then
  if jsonb_typeof(b->'licenseSourceUrl') is distinct from 'string' then return false;end if;
  source_url:=b->>'licenseSourceUrl';
  if length(source_url)>2048 or source_url !~ '^https://([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*)(:[0-9]{1,5})?(/[A-Za-z0-9._~!$&''()*+,;=:@%/-]*)?$' then return false;end if;
  source_host:=substring(source_url from '^https://([^/:]+)');source_port:=substring(source_url from '^https://[^/:]+:([0-9]{1,5})');
  if length(source_host)>253 or source_host !~ '[A-Za-z]$' or(source_port is not null and source_port::integer not between 1 and 65535) then return false;end if;
 end if;
 return fluid_private.standalone_keys(b,array['requestKey','expected','licenseSourceUrl','licenseText','rightsDeclaration'])
  and fluid_private.standalone_text(b->'rightsDeclaration',2000,1) and fluid_private.idea_trim(b->>'rightsDeclaration')<>''
  and jsonb_typeof(b->'licenseText')='string' and octet_length(b->>'licenseText')<=262144 and fluid_private.idea_trim(b->>'licenseText')<>'';

exception when others then return false;
end $$;
create function fluid_private.logo_input_state(p_owner uuid,p_project uuid,p_key uuid) returns jsonb language plpgsql stable set search_path='' as $$
declare r public.logo_input_requests; result jsonb; rejection_reason text;
begin
 select * into r from public.logo_input_requests where owner_id=p_owner and project_id=p_project and request_key=p_key;
 if not found then return jsonb_build_object('status','not_found');end if;
 select reason into rejection_reason from public.logo_input_rejections where owner_id=p_owner and project_id=p_project and request_key=p_key;
 if rejection_reason is not null then return jsonb_build_object('status','rejected','reason',rejection_reason,'ownerId',p_owner,'projectId',p_project,'requestKey',p_key,'request',r.request);end if;
 select x.result into result from public.logo_input_receipts x where x.owner_id=p_owner and x.project_id=p_project and x.request_key=p_key;
 return jsonb_build_object('status',case when result is null then 'pending' else 'succeeded' end,'ownerId',p_owner,'projectId',p_project,'requestKey',p_key,'request',r.request)
  ||case when result is null then '{}'::jsonb else jsonb_build_object('result',result) end;
end $$;
create function fluid_private.prepare_logo_input(p_project uuid,p_request jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare owner uuid:=fluid_private.logo_asset_web_owner(); prior public.logo_input_requests; workspace jsonb; catalog jsonb;
begin
 if fluid_private.logo_input_request_valid(p_request) is distinct from true then raise exception 'invalid_logo_input' using errcode='22023';end if;
 perform 1 from public.projects where id=p_project and owner_id=owner for update;
 if not found then raise exception 'logo_project_not_found' using errcode='P0002';end if;
 select * into prior from public.logo_input_requests where owner_id=owner and project_id=p_project and request_key=(p_request#>>'{input,requestKey}')::uuid;
 if found then
  if prior.request is distinct from p_request then raise exception 'immutable_logo_input_request' using errcode='PT409';end if;
  return fluid_private.logo_input_state(owner,p_project,prior.request_key);
 end if;
 perform 1 from public.identity_reference_heads where owner_id=owner and project_id=p_project for update;
 perform 1 from public.identity_sessions where owner_id=owner and project_id=p_project for update;
 workspace:=fluid_private.logo_workspace_json(owner,p_project);
 if workspace->'heads' is distinct from p_request#>'{input,expected}' then raise exception 'logo_input_head_conflict' using errcode='PT409';end if;
 if workspace#>'{stages,brief_references}'='null'::jsonb then raise exception 'logo_brief_required' using errcode='PT409';end if;
 if p_request->>'kind'='font_catalog' then
  select record into catalog from fluid_private.logo_input_font_catalog where id=p_request#>>'{input,catalogFontId}';
  if catalog is null or catalog->'contentHash' is distinct from p_request#>'{file,contentHash}' or catalog->'mimeType' is distinct from p_request#>'{file,mimeType}' then raise exception 'logo_catalog_source_unavailable' using errcode='P0002';end if;
 end if;
 if p_request->>'kind'<>'reference_upload' and (select count(*) from public.logo_font_records where owner_id=owner and project_id=p_project)>=100 then raise exception 'logo_font_limit' using errcode='22023';end if;
 insert into public.logo_input_requests(owner_id,project_id,request_key,request) values(owner,p_project,(p_request#>>'{input,requestKey}')::uuid,p_request);
 return fluid_private.logo_input_state(owner,p_project,(p_request#>>'{input,requestKey}')::uuid);
end $$;
create function fluid_private.commit_logo_input(p_project uuid,p_request jsonb,p_receipt jsonb,p_evidence jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare owner uuid:=fluid_private.logo_asset_web_owner(); prior public.logo_input_requests; request_state jsonb; workspace jsonb; a public.logo_asset_publications;
 k text:=p_request->>'kind'; declaration text; catalog jsonb; rights jsonb; result jsonb; license_text text; license_hash text; source_url text; family text;
begin
 if fluid_private.logo_input_request_valid(p_request) is distinct from true then raise exception 'invalid_logo_input' using errcode='22023';end if;
 perform 1 from public.projects where id=p_project and owner_id=owner for update;
 if not found then raise exception 'logo_project_not_found' using errcode='P0002';end if;
 select * into prior from public.logo_input_requests where owner_id=owner and project_id=p_project and request_key=(p_request#>>'{input,requestKey}')::uuid;
 if not found then raise exception 'logo_input_request_not_found' using errcode='P0002';end if;
 if prior.request is distinct from p_request then raise exception 'immutable_logo_input_request' using errcode='PT409';end if;
 request_state:=fluid_private.logo_input_state(owner,p_project,prior.request_key);if request_state->>'status' in('succeeded','rejected') then return request_state;end if;
 perform 1 from public.identity_reference_heads where owner_id=owner and project_id=p_project for update;
 perform 1 from public.identity_sessions where owner_id=owner and project_id=p_project for update;
 workspace:=fluid_private.logo_workspace_json(owner,p_project);
 if workspace->'heads' is distinct from p_request#>'{input,expected}' then
  insert into public.logo_input_rejections(owner_id,project_id,request_key,reason) values(owner,p_project,prior.request_key,'inputs_changed');
  return fluid_private.logo_input_state(owner,p_project,prior.request_key);
 end if;
 select * into a from public.logo_asset_publications where id=(p_receipt->>'id')::uuid and owner_id=owner and project_id=p_project and request_key=prior.request_key and state='committed' and job_id is null and request->>'kind'='upload';
 if not found or fluid_private.logo_asset_receipt(a) is distinct from p_receipt or a.rights_evidence_id is null or a.content_hash is distinct from p_request#>>'{file,contentHash}' or a.mime_type is distinct from p_request#>>'{file,mimeType}' or to_jsonb(a.byte_length) is distinct from p_request#>'{file,byteLength}'
  or a.purpose is distinct from(case when k='reference_upload' then 'reference_media' else 'brand_asset' end)
  or a.request#>>'{intent,usage}' is distinct from(case when k='reference_upload' then 'logo_reference' else 'font' end) then raise exception 'logo_input_publication_not_found' using errcode='P0002';end if;
 if k='reference_upload' then
  if p_evidence is distinct from 'null'::jsonb then raise exception 'invalid_logo_reference_evidence' using errcode='22023';end if;
  declaration:=p_request#>>'{input,rightsDeclaration}';
 else
  if not fluid_private.standalone_keys(p_evidence,array['family','licenseText','licenseSourceUrl']) or not fluid_private.standalone_text(p_evidence->'family',200,1) or jsonb_typeof(p_evidence->'licenseText') is distinct from 'string' or octet_length(p_evidence->>'licenseText')>262144 or fluid_private.idea_trim(p_evidence->>'licenseText')='' then raise exception 'invalid_logo_font_evidence' using errcode='22023';end if;
  family:=p_evidence->>'family';license_text:=p_evidence->>'licenseText';license_hash:=encode(sha256(convert_to(license_text,'UTF8')),'hex');source_url:=p_evidence->>'licenseSourceUrl';
  if k='font_catalog' then
   select record into catalog from fluid_private.logo_input_font_catalog where id=p_request#>>'{input,catalogFontId}';
   if catalog is null or catalog->>'contentHash' is distinct from a.content_hash or catalog->>'mimeType' is distinct from a.mime_type or catalog->>'family' is distinct from family or catalog#>>'{rights,licenseTextHash}' is distinct from license_hash or catalog#>>'{rights,sourceUrl}' is distinct from source_url then raise exception 'logo_catalog_source_unavailable' using errcode='P0002';end if;
   declaration:='Reviewed free-commercial catalog '||(catalog->>'id')||'; exact license SHA-256 '||license_hash||'.';
   rights:=(catalog->'rights')||jsonb_build_object('id',a.rights_evidence_id);
  else
   if p_evidence->'licenseText' is distinct from p_request#>'{input,licenseText}' or p_evidence->'licenseSourceUrl' is distinct from p_request#>'{input,licenseSourceUrl}' then raise exception 'logo_license_changed' using errcode='PT409';end if;
   declaration:=p_request#>>'{input,rightsDeclaration}';
   rights:=jsonb_build_object('id',a.rights_evidence_id,'fontContentHash',a.content_hash,'sourceKind','user_declaration','sourceUrl',source_url,'licenseTextHash',license_hash,'commercialUse','unknown','permissions',jsonb_build_object('render','unknown','outline','unknown','embed','unknown','modify','unknown','redistribute','unknown'),'reviewedAt',null);
  end if;
  if (select count(*) from public.logo_font_records where owner_id=owner and project_id=p_project)>=100 then raise exception 'logo_font_limit' using errcode='22023';end if;
 end if;
 if a.request#>>'{intent,rightsDeclaration}' is distinct from declaration then raise exception 'logo_declaration_changed' using errcode='PT409';end if;
 insert into public.logo_input_rights(id,owner_id,project_id,publication_id,source_kind,content_hash,rights_declaration,license_text,license_text_hash,source_url,catalog_id)
 values(a.rights_evidence_id,owner,p_project,a.id,case when k='font_catalog' then 'reviewed_license' else 'user_declaration' end,a.content_hash,declaration,license_text,license_hash,source_url,case when k='font_catalog' then catalog->>'id' else null end);
 if k='reference_upload' then
  insert into public.logo_reference_sources(reference_id,project_id,owner_id,asset_id,version_id,content_hash,source_kind,rights_evidence_id) values(a.source_receipt_id,p_project,owner,a.asset_id,a.version_id,a.content_hash,'upload',a.rights_evidence_id);
  result:=jsonb_build_object('referenceId',a.source_receipt_id,'asset',p_receipt->'reference','sourceKind','upload','aspects',p_request#>'{input,aspects}','rightsEvidenceId',a.rights_evidence_id,'workspace',workspace);
 else
  result:=jsonb_build_object('id',a.version_id,'asset',p_receipt->'reference','family',family,'source',case when k='font_catalog' then 'free_catalog' else 'user_upload' end,'rights',rights);
  insert into public.logo_font_records(record_id,version_id,owner_id,project_id,record) values(a.version_id,a.version_id,owner,p_project,result);
 end if;
 insert into public.logo_input_receipts(owner_id,project_id,request_key,result,reference_id,font_record_id) values(owner,p_project,prior.request_key,result,case when k='reference_upload' then a.source_receipt_id else null end,case when k<>'reference_upload' then a.version_id else null end);
 return fluid_private.logo_input_state(owner,p_project,prior.request_key);
end $$;
-- Rejection-only exact identity fence. An absent request may be closed before a
-- delayed upload arrives. It never deletes bytes or changes a successful result.
create function public.cancel_logo_input_request(p_project_id uuid,p_request jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare owner uuid:=auth.uid(); prior public.logo_input_requests; validated jsonb:=p_request; request_state jsonb;
begin
 if owner is null then raise exception 'unauthenticated' using errcode='42501';end if;
 -- Preserve former client URL spellings only for cancellation, never admission.
 if p_request->>'kind'='font_upload' then
  if p_request#>'{input,licenseSourceUrl}' is distinct from 'null'::jsonb and (jsonb_typeof(p_request#>'{input,licenseSourceUrl}') is distinct from 'string' or length(p_request#>>'{input,licenseSourceUrl}')>2048) then raise exception 'invalid_logo_input' using errcode='22023';end if;
  validated:=jsonb_set(p_request,'{input,licenseSourceUrl}','null'::jsonb);
 end if;
 if octet_length(p_request::text)>327680 or fluid_private.logo_input_request_valid(validated) is distinct from true then raise exception 'invalid_logo_input' using errcode='22023';end if;
 perform 1 from public.projects where id=p_project_id and owner_id=owner for update;
 if not found then raise exception 'logo_project_not_found' using errcode='P0002';end if;
 select * into prior from public.logo_input_requests where owner_id=owner and project_id=p_project_id and request_key=(p_request#>>'{input,requestKey}')::uuid;
 if found then
  if prior.request is distinct from p_request then raise exception 'immutable_logo_input_request' using errcode='PT409';end if;
 else
  insert into public.logo_input_requests(owner_id,project_id,request_key,request) values(owner,p_project_id,(p_request#>>'{input,requestKey}')::uuid,p_request) returning * into prior;
 end if;
 request_state:=fluid_private.logo_input_state(owner,p_project_id,prior.request_key);
 if request_state->>'status' in('succeeded','rejected') then return request_state;end if;
 insert into public.logo_input_rejections(owner_id,project_id,request_key,reason) values(owner,p_project_id,prior.request_key,'cancelled_by_user');
 return fluid_private.logo_input_state(owner,p_project_id,prior.request_key);
end $$;
create function public.read_logo_input_request(p_project_id uuid,p_request_key uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if auth.uid() is null then raise exception 'unauthenticated' using errcode='42501';end if;
 if not exists(select 1 from public.projects where id=p_project_id and owner_id=auth.uid()) then raise exception 'logo_project_not_found' using errcode='P0002';end if;
 return fluid_private.logo_input_state(auth.uid(),p_project_id,p_request_key);
end $$;
create function public.list_logo_input_references(p_project_id uuid,p_query jsonb) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare owner uuid:=auth.uid(); lim integer; cursor_row public.logo_input_receipts; row public.logo_input_receipts; items jsonb:='[]'; last_id uuid; more boolean:=false;
begin
 if owner is null then raise exception 'unauthenticated' using errcode='42501';end if;
 if not exists(select 1 from public.projects where id=p_project_id and owner_id=owner) then raise exception 'logo_project_not_found' using errcode='P0002';end if;
 if jsonb_typeof(p_query) is distinct from 'object' or exists(select 1 from jsonb_object_keys(p_query) k where k not in('cursor','limit')) or not p_query?'limit' or jsonb_typeof(p_query->'limit') is distinct from 'number' then raise exception 'invalid_logo_input_query' using errcode='22023';end if;
 lim:=(p_query->>'limit')::integer;if lim not between 1 and 50 or to_jsonb(lim) is distinct from p_query->'limit' then raise exception 'invalid_logo_input_query' using errcode='22023';end if;
 if p_query?'cursor' then
  if not fluid_private.logo_uuid(p_query->'cursor') then raise exception 'invalid_logo_input_cursor' using errcode='22023';end if;
  select * into cursor_row from public.logo_input_receipts where owner_id=owner and project_id=p_project_id and reference_id=(p_query->>'cursor')::uuid;
  if not found then raise exception 'invalid_logo_input_cursor' using errcode='22023';end if;
 end if;
 for row in select * from public.logo_input_receipts where owner_id=owner and project_id=p_project_id and reference_id is not null and(cursor_row.reference_id is null or(created_at,reference_id)>(cursor_row.created_at,cursor_row.reference_id)) order by created_at,reference_id limit lim+1 loop
  if jsonb_array_length(items)=lim then more:=true;exit;end if;
  items:=items||jsonb_build_array(row.result);last_id:=row.reference_id;
 end loop;
 return jsonb_build_object('ownerId',owner,'projectId',p_project_id,'items',items,'nextCursor',case when more then last_id else null end);
end $$;
create function public.list_logo_input_fonts(p_project_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare owner uuid:=auth.uid(); result jsonb;
begin
 if owner is null then raise exception 'unauthenticated' using errcode='42501';end if;
 if not exists(select 1 from public.projects where id=p_project_id and owner_id=owner) then raise exception 'logo_project_not_found' using errcode='P0002';end if;
 select coalesce(jsonb_agg(record order by record_id),'[]') into result from public.logo_font_records where owner_id=owner and project_id=p_project_id;
 if jsonb_array_length(result)>100 then raise exception 'logo_font_limit' using errcode='55000';end if;
 return result;
end $$;
create function public.list_logo_input_requests(p_project_id uuid,p_query jsonb) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare owner uuid:=auth.uid(); lim integer; cursor_row public.logo_input_requests; row public.logo_input_requests; items jsonb:='[]'; last_key uuid; more boolean:=false;
begin
 if owner is null then raise exception 'unauthenticated' using errcode='42501';end if;
 if not exists(select 1 from public.projects where id=p_project_id and owner_id=owner) then raise exception 'logo_project_not_found' using errcode='P0002';end if;
 if jsonb_typeof(p_query) is distinct from 'object' or exists(select 1 from jsonb_object_keys(p_query) k where k not in('cursor','limit')) or not p_query?'limit' or jsonb_typeof(p_query->'limit') is distinct from 'number' then raise exception 'invalid_logo_input_query' using errcode='22023';end if;
 lim:=(p_query->>'limit')::integer;if lim not between 1 and 10 or to_jsonb(lim) is distinct from p_query->'limit' then raise exception 'invalid_logo_input_query' using errcode='22023';end if;
 if p_query?'cursor' then
  if not fluid_private.logo_uuid(p_query->'cursor') then raise exception 'invalid_logo_input_cursor' using errcode='22023';end if;
  select * into cursor_row from public.logo_input_requests where owner_id=owner and project_id=p_project_id and request_key=(p_query->>'cursor')::uuid;
  if not found then raise exception 'invalid_logo_input_cursor' using errcode='22023';end if;
 end if;
 for row in select r.* from public.logo_input_requests r where r.owner_id=owner and r.project_id=p_project_id
  and not exists(select 1 from public.logo_input_receipts c where c.owner_id=r.owner_id and c.project_id=r.project_id and c.request_key=r.request_key)
  and not exists(select 1 from public.logo_input_rejections c where c.owner_id=r.owner_id and c.project_id=r.project_id and c.request_key=r.request_key)
  and(cursor_row.request_key is null or(r.created_at,r.request_key)>(cursor_row.created_at,cursor_row.request_key)) order by r.created_at,r.request_key limit lim+1 loop
  if jsonb_array_length(items)=lim then more:=true;exit;end if;
  items:=items||jsonb_build_array(fluid_private.logo_input_state(owner,p_project_id,row.request_key));last_key:=row.request_key;
 end loop;
 return jsonb_build_object('ownerId',owner,'projectId',p_project_id,'items',items,'nextCursor',case when more then last_key else null end);
end $$;
-- Exact newly created inventory only. Default ACLs and unrelated grants stay untouched.
do $$ declare t text; s text; r record;
 relation_id oid; c record;
begin
 foreach t in array array['public.logo_input_requests','public.logo_input_rights','public.logo_input_receipts','public.logo_input_rejections','fluid_private.logo_input_font_catalog'] loop
  relation_id:=to_regclass(t);
  for r in select distinct a.grantee from pg_class p cross join lateral aclexplode(coalesce(p.relacl,acldefault('r',p.relowner))) a where p.oid=relation_id and a.grantee<>p.relowner loop
   execute format('revoke all on table %s from %s cascade',relation_id::regclass,case when r.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(r.grantee)) end);
  end loop;
  for c in select at.attname,a.grantee from pg_attribute at join pg_class p on p.oid=at.attrelid cross join lateral aclexplode(at.attacl) a where p.oid=relation_id and a.grantee<>p.relowner loop
   execute format('revoke all (%I) on table %s from %s cascade',c.attname,relation_id::regclass,case when c.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(c.grantee)) end);
  end loop;
  execute format('alter table %s enable row level security',relation_id::regclass);
  execute format('alter table %s force row level security',relation_id::regclass);
 end loop;
 foreach s in array array['fluid_private.logo_input_request_valid(jsonb)','fluid_private.logo_input_state(uuid,uuid,uuid)','fluid_private.prepare_logo_input(uuid,jsonb)','fluid_private.commit_logo_input(uuid,jsonb,jsonb,jsonb)','public.read_logo_input_request(uuid,uuid)','public.list_logo_input_references(uuid,jsonb)','public.list_logo_input_fonts(uuid)','public.list_logo_input_requests(uuid,jsonb)','public.cancel_logo_input_request(uuid,jsonb)'] loop
  for r in select distinct a.grantee from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where p.oid=to_regprocedure(s) and a.grantee<>p.proowner loop
   execute format('revoke all on function %s from %s cascade',s,case when r.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(r.grantee)) end);
  end loop;
 end loop;
end $$;
grant execute on function public.read_logo_input_request(uuid,uuid),public.list_logo_input_references(uuid,jsonb),public.list_logo_input_fonts(uuid),public.list_logo_input_requests(uuid,jsonb),public.cancel_logo_input_request(uuid,jsonb) to authenticated;
commit;
