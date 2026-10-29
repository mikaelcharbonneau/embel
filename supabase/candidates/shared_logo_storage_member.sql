-- Finite missing dependency closure. Exact reviewed member helper only.
BEGIN;
SET LOCAL search_path='';SET LOCAL lock_timeout='2s';SET LOCAL statement_timeout='30s';
DO $member_dependency$
DECLARE pins jsonb:='{"dependencies":[{"acl":[{"grantable":false,"grantee":"postgres","privilege":"EXECUTE"}],"config":["search_path=\"\""],"definer":false,"language":"sql","leakproof":false,"owner":"postgres","sha256":"44f5f7f84a5fd9ff97a96e0872871da6f063c873cf47cd6b4193879e295e4eb7","signature":"fluid_private.logo_asset_reservation(public.logo_asset_publications)","volatility":"s"},{"acl":[{"grantable":false,"grantee":"postgres","privilege":"EXECUTE"}],"config":["search_path=\"\""],"definer":false,"language":"plpgsql","leakproof":false,"owner":"postgres","sha256":"cb80ca177bab7279c2c0dcaa7c275cb5434829c68c0db5451bf2974b2d11e134","signature":"fluid_private.logo_job_input_revisions(public.jobs)","volatility":"s"},{"acl":[{"grantable":false,"grantee":"postgres","privilege":"EXECUTE"}],"config":["search_path=\"\""],"definer":false,"language":"plpgsql","leakproof":false,"owner":"postgres","sha256":"3027bed899ef9d7f7ff6762e6f5499ff927fe6490aa609e2d4e69876be70f64b","signature":"fluid_private.logo_export_expected_files(jsonb)","volatility":"i"},{"acl":[{"grantable":false,"grantee":"postgres","privilege":"EXECUTE"}],"config":["search_path=\"\""],"definer":false,"language":"plpgsql","leakproof":false,"owner":"postgres","sha256":"c5cabfc78c2c0e30561d62e1098ae45cc9ed39f7dc352ced8f88ad99c8c66fe4","signature":"fluid_private.shared_logo_storage_member(public.jobs,public.logo_asset_publications,text)","volatility":"s"},{"acl":[{"grantable":false,"grantee":"postgres","privilege":"EXECUTE"}],"config":["search_path=\"\""],"definer":false,"language":"plpgsql","leakproof":false,"owner":"postgres","sha256":"7ae99f89a873e624d3580b591257625cf48b7c04d304716597fd1ac4fd6e32d1","signature":"fluid_private.shared_storage_operation_member(public.jobs,public.logo_asset_publications,text)","volatility":"s"},{"acl":[{"grantable":false,"grantee":"authenticated","privilege":"EXECUTE"},{"grantable":false,"grantee":"postgres","privilege":"EXECUTE"}],"config":["search_path=\"\""],"definer":true,"language":"plpgsql","leakproof":false,"owner":"postgres","sha256":"d6741cd71eef8004aa35808bab89c0516218dbde13fac14e3285e5ddda743655","signature":"public.authorize_shared_logo_storage(uuid,uuid,uuid,uuid,uuid,text)","volatility":"v"}],"helper":{"acl":[{"grantable":false,"grantee":"postgres","privilege":"EXECUTE"}],"config":["search_path=\"\""],"definer":false,"language":"plpgsql","leakproof":false,"owner":"postgres","sha256":"4daa68465c9c0ed4cb36223d8348d3d1b78c2bb8c0cdff889eb4f567e5e3d0ee","signature":"fluid_private.logo_production_storage_member(public.jobs,public.logo_asset_publications,text)","volatility":"s"}}'::jsonb;phase text:='apply';dep jsonb;actual jsonb;p pg_catalog.pg_proc;
 old_functions jsonb;new_functions jsonb;old_security jsonb;new_security jsonb;installed boolean:=false;acl_row record;helper_oid oid;
BEGIN
 IF current_user<>'postgres'OR session_user<>'postgres'OR current_database()<>'postgres'OR current_setting('server_version_num')::integer<>170011
 OR NOT EXISTS(SELECT 1 FROM fluid_private.shared_storage_target t WHERE t.singleton AND t.origin='https://fricsfwqibyhemknqgyf.supabase.co')
 OR(SELECT count(*)FROM fluid_private.shared_storage_target)<>1 THEN RAISE EXCEPTION 'storage_member_operator_target';END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(q)ORDER BY q.oid),'[]')INTO old_functions FROM pg_proc q JOIN pg_namespace n ON n.oid=q.pronamespace WHERE n.nspname IN('public','fluid_private')AND NOT(n.nspname='fluid_private'AND q.proname='logo_production_storage_member');
 SELECT jsonb_build_object('roles',(SELECT jsonb_agg(to_jsonb(r)ORDER BY oid)FROM pg_roles r),'relations',(SELECT jsonb_agg(to_jsonb(c)ORDER BY oid)FROM pg_class c WHERE relnamespace IN(SELECT oid FROM pg_namespace WHERE nspname IN('public','fluid_private','auth','storage'))),'policies',(SELECT jsonb_agg(to_jsonb(q)ORDER BY oid)FROM pg_policy q),'defaultACLs',(SELECT jsonb_agg(to_jsonb(q)ORDER BY oid)FROM pg_default_acl q))INTO old_security;
 FOR dep IN SELECT value FROM jsonb_array_elements(pins->'dependencies')LOOP
  SELECT *INTO p FROM pg_proc WHERE oid=to_regprocedure(dep->>'signature');
  SELECT jsonb_build_object('signature',p.oid::regprocedure::text,'sha256',encode(sha256(convert_to(p.prosrc,'UTF8')),'hex'),'owner',pg_get_userbyid(p.proowner),'definer',p.prosecdef,'volatility',p.provolatile::text,'leakproof',p.proleakproof,'config',p.proconfig,'language',(SELECT lanname FROM pg_language WHERE oid=p.prolang),'acl',(SELECT jsonb_agg(jsonb_build_object('grantee',coalesce(r.rolname,'PUBLIC'),'privilege',a.privilege_type,'grantable',a.is_grantable)ORDER BY coalesce(r.rolname,'PUBLIC'),a.privilege_type,a.is_grantable)FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))a LEFT JOIN pg_roles r ON r.oid=a.grantee))INTO actual;
  IF p.oid IS NULL OR actual IS DISTINCT FROM dep THEN RAISE EXCEPTION 'storage_member_dependency_changed';END IF;
 END LOOP;
 IF(SELECT count(*)FROM pg_proc q JOIN pg_namespace n ON n.oid=q.pronamespace WHERE n.nspname='fluid_private'AND q.proname='logo_production_storage_member')>1 THEN RAISE EXCEPTION 'storage_member_overload_collision';END IF;
 SELECT *INTO p FROM pg_proc WHERE oid=to_regprocedure('fluid_private.logo_production_storage_member(public.jobs,public.logo_asset_publications,text)');
 IF p.oid IS NULL THEN
  IF EXISTS(SELECT 1 FROM pg_proc q JOIN pg_namespace n ON n.oid=q.pronamespace WHERE n.nspname='fluid_private'AND q.proname='logo_production_storage_member')THEN RAISE EXCEPTION 'storage_member_signature_collision';END IF;
  IF phase='resume'THEN RAISE EXCEPTION 'storage_member_missing_after_ack';END IF;
  IF phase='apply'THEN
   EXECUTE $reviewed_member$create function fluid_private.logo_production_storage_member(j public.jobs,r public.logo_asset_publications,p_mode text)
returns text language plpgsql stable set search_path='' as $$
declare ref jsonb; q public.logo_cost_quotes; source jsonb; item jsonb; member text; digest text; expected_key uuid;
begin
 if j.id is null or r.id is null or r.owner_id<>j.owner_id or r.project_id<>j.project_id or r.purpose<>'brand_asset' then return null; end if;
 ref:=fluid_private.logo_asset_reservation(r)->'reference';
 if p_mode='read' then
   if r.state<>'committed' or r.verification is null or not exists(select 1 from public.asset_versions v where v.owner_id=r.owner_id and v.project_id=r.project_id
     and v.asset_id=r.asset_id and v.id=r.version_id and v.content_hash=r.content_hash and v.mime_type=r.mime_type
     and v.storage_path=r.owner_id::text||'/'||r.project_id::text||'/'||r.asset_id::text||'/'||r.version_id::text
     and v.provenance->>'publicationId'=r.id::text) then return null; end if;
   if j.operation='identity.logo_vectorize' then
     select * into q from public.logo_cost_quotes where id=(j.input->>'quoteId')::uuid and owner_id=j.owner_id and project_id=j.project_id;
     if q.source_inputs#>'{raster,preview,reference}'=ref and r.mime_type in('image/png','image/jpeg','image/webp')
       and exists(select 1 from public.logo_raster_results a where a.owner_id=j.owner_id and a.project_id=j.project_id and a.preview->'reference'=ref) then return 'raster-source'; end if;
   elsif j.operation='identity.logo_export' then
     select e.source into source from public.logo_export_inputs e where e.job_id=j.id and e.owner_id=j.owner_id and e.project_id=j.project_id and e.source_snapshot_hash=j.input->>'sourceSnapshotHash';
     if source#>'{logo,documentAsset}'=ref and r.mime_type='application/json' then return 'logo-document'; end if;
     if source#>'{logo,svgAsset}'=ref and r.mime_type='image/svg+xml' then return 'logo-svg'; end if;
     if source#>'{logo,sourcePreview}'=ref and r.mime_type in('image/png','image/jpeg','image/webp') then return 'logo-preview'; end if;
     for item in select value from jsonb_array_elements(source#>'{variants,items}') loop
       if item#>>'{applicability,status}'='applicable' then
         if item->'documentAsset'=ref and r.mime_type='application/json' then return 'variant-document:'||(item->>'id'); end if;
         if item#>'{preview,reference}'=ref and r.mime_type='image/png' then return 'variant-preview:'||(item->>'id'); end if;
       end if;
     end loop;
     -- Fonts require a separate rights/storage capability and remain excluded.
   end if;
   return null;
 elsif p_mode<>'write' then return null; end if;
 if r.job_id is distinct from j.id or r.lease_token is distinct from j.lease_token or r.state not in('reserved','staged')
   or r.rights_evidence_id is not null or r.source_receipt_id<>j.id or r.input_hash<>j.input_hash or r.input_revision<>j.input_revision
   or r.source_kind<>(case j.operation when 'identity.logo_vectorize' then 'vector' when 'identity.logo_export' then 'export' else '' end)
   or r.request->>'kind' is distinct from 'stage' or r.request#>>'{publication,source,kind}' is distinct from r.source_kind
   or r.request#>>'{publication,source,sourceId}' is distinct from j.id::text
   or r.request#>>'{publication,requestKey}' is distinct from r.request_key::text
   or r.request#>>'{publication,contentHash}' is distinct from r.content_hash or r.request#>>'{publication,mimeType}' is distinct from r.mime_type
   or r.request#>'{publication,byteLength}' is distinct from to_jsonb(r.byte_length)
   or r.request#>'{publication,inputRevisions}' is distinct from fluid_private.logo_job_input_revisions(j) then return null; end if;
 if j.operation='identity.logo_vectorize' then
   member:=case r.mime_type when 'application/json' then 'document' when 'image/svg+xml' then 'svg' else null end;
   if member is null then return null; end if;
   digest:=encode(sha256(convert_to('fluid.logo-vector.publication.v1:'||j.id::text||':'||member,'UTF8')),'hex');
   expected_key:=(substr(digest,1,8)||'-'||substr(digest,9,4)||'-5'||substr(digest,14,3)||'-a'||substr(digest,18,3)||'-'||substr(digest,21,12))::uuid;
   if expected_key=r.request_key then return member; end if;
 elsif j.operation='identity.logo_export' then
   select e.source into source from public.logo_export_inputs e where e.job_id=j.id and e.owner_id=j.owner_id and e.project_id=j.project_id and e.source_snapshot_hash=j.input->>'sourceSnapshotHash';
   for item in select value from jsonb_array_elements(fluid_private.logo_export_expected_files(source)) loop
     if item->>'mimeType'=r.mime_type then
       digest:=encode(sha256(convert_to('{"jobId":'||to_json(j.id::text)::text||',"sourceSnapshotHash":'||to_json(j.input->>'sourceSnapshotHash')::text||',"name":'||to_json(item->>'name')::text||',"hash":'||to_json(r.content_hash)::text||'}','UTF8')),'hex');
       expected_key:=(substr(digest,1,8)||'-'||substr(digest,9,4)||'-5'||substr(digest,14,3)||'-8'||substr(digest,18,3)||'-'||substr(digest,21,12))::uuid;
       if expected_key=r.request_key then return item->>'name'; end if;
     end if;
   end loop;
 end if;
 return null;
end $$;
$reviewed_member$;
   SELECT oid INTO STRICT helper_oid FROM pg_proc WHERE oid=to_regprocedure('fluid_private.logo_production_storage_member(public.jobs,public.logo_asset_publications,text)');
   FOR acl_row IN SELECT DISTINCT a.grantee FROM pg_proc q CROSS JOIN LATERAL aclexplode(coalesce(q.proacl,acldefault('f',q.proowner)))a WHERE q.oid=helper_oid AND a.grantee<>q.proowner LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION fluid_private.logo_production_storage_member(public.jobs,public.logo_asset_publications,text) FROM %s CASCADE',CASE WHEN acl_row.grantee=0 THEN 'PUBLIC'ELSE quote_ident(pg_get_userbyid(acl_row.grantee))END);
   END LOOP;installed:=true;
  END IF;
 END IF;
 IF phase<>'prepare'OR p.oid IS NOT NULL THEN
  SELECT *INTO p FROM pg_proc WHERE oid=to_regprocedure('fluid_private.logo_production_storage_member(public.jobs,public.logo_asset_publications,text)');
  SELECT jsonb_build_object('signature',p.oid::regprocedure::text,'sha256',encode(sha256(convert_to(p.prosrc,'UTF8')),'hex'),'owner',pg_get_userbyid(p.proowner),'definer',p.prosecdef,'volatility',p.provolatile::text,'leakproof',p.proleakproof,'config',p.proconfig,'language',(SELECT lanname FROM pg_language WHERE oid=p.prolang),'acl',(SELECT jsonb_agg(jsonb_build_object('grantee',coalesce(r.rolname,'PUBLIC'),'privilege',a.privilege_type,'grantable',a.is_grantable)ORDER BY coalesce(r.rolname,'PUBLIC'),a.privilege_type,a.is_grantable)FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))a LEFT JOIN pg_roles r ON r.oid=a.grantee))INTO actual;
  IF p.oid IS NULL OR actual IS DISTINCT FROM pins->'helper'THEN RAISE EXCEPTION 'storage_member_helper_collision';END IF;
 END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(q)ORDER BY q.oid),'[]')INTO new_functions FROM pg_proc q JOIN pg_namespace n ON n.oid=q.pronamespace WHERE n.nspname IN('public','fluid_private')AND NOT(n.nspname='fluid_private'AND q.proname='logo_production_storage_member');
 SELECT jsonb_build_object('roles',(SELECT jsonb_agg(to_jsonb(r)ORDER BY oid)FROM pg_roles r),'relations',(SELECT jsonb_agg(to_jsonb(c)ORDER BY oid)FROM pg_class c WHERE relnamespace IN(SELECT oid FROM pg_namespace WHERE nspname IN('public','fluid_private','auth','storage'))),'policies',(SELECT jsonb_agg(to_jsonb(q)ORDER BY oid)FROM pg_policy q),'defaultACLs',(SELECT jsonb_agg(to_jsonb(q)ORDER BY oid)FROM pg_default_acl q))INTO new_security;
 IF old_functions IS DISTINCT FROM new_functions OR old_security IS DISTINCT FROM new_security THEN RAISE EXCEPTION 'storage_member_unrelated_authority_changed';END IF;
 PERFORM set_config('embel_operator.storage_member_receipt',jsonb_build_object('version',1,'phase',phase,'verified',true,'createdExactHelper',installed,'helperBodySha256',pins#>>'{helper,sha256}','otherFunctionsRolesRLSACLsUnchanged',true,'noExistingDataWrites',true)::text,true);
END $member_dependency$;
SELECT current_setting('embel_operator.storage_member_receipt')::jsonb AS receipt;
COMMIT;

