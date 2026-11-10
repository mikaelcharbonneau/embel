-- LOCAL CANDIDATE ONLY: existing verified-owner JWT Storage staging.
-- Activation prerequisites include 017000 logo inputs and 018000 edit
-- cancellations BEFORE this migration, regardless of local fixture filenames.
-- Requires the provider's storage.operation()/storage.allow_only_operation().
-- Do not create or replace provider functions, identities or credentials here.
begin;

create function fluid_private.owner_staging_object_allowed(bucket_id text, name text)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare owner uuid := auth.uid();
begin
  if bucket_id is distinct from 'fluid-assets' or owner is null or name is null then
    return false;
  end if;

  -- Exact immutable path equality, never a prefix or a caller-supplied owner.
  -- Verified and linked Home rows remain eligible: create-only retry performs
  -- INSERT preflight before resolving an existing immutable object. Home has no
  -- cancellation/expiry state; do not invent one here.
  if pg_catalog.split_part(name, '/', 2) = 'home' then
    return exists (
      select 1 from public.home_attachments h
      where h.owner_id = owner
        and $2 = h.owner_id::text || '/home/' || h.id::text || '/' || h.blob_version_id::text
    );
  end if;

  return exists (
    select 1 from public.logo_asset_publications p
    join public.projects project on project.id = p.project_id and project.owner_id = p.owner_id
    where p.owner_id = owner
      and p.job_id is null and p.lease_token is null
      and p.state in ('reserved', 'staged')
      and $2 = p.owner_id::text || '/' || p.project_id::text || '/' || p.asset_id::text || '/' || p.version_id::text
      and (
        (
          p.request->>'kind' = 'upload'
          and p.source_kind in ('logo_reference', 'font')
          and p.request#>>'{intent,usage}' = p.source_kind
          and p.request#>>'{intent,requestKey}' = p.request_key::text
          and p.request#>>'{intent,contentHash}' = p.content_hash
          and p.request#>>'{intent,mimeType}' = p.mime_type
          and p.request->'byteLength' = pg_catalog.to_jsonb(p.byte_length)
          and exists (
            select 1 from public.logo_input_requests r
            where r.owner_id = p.owner_id and r.project_id = p.project_id and r.request_key = p.request_key
              and ((p.source_kind = 'logo_reference' and r.request->>'kind' = 'reference_upload')
                or (p.source_kind = 'font' and r.request->>'kind' in ('font_upload', 'font_catalog')))
              and r.request#>>'{file,contentHash}' = p.content_hash
              and r.request#>>'{file,mimeType}' = p.mime_type
              and r.request#>'{file,byteLength}' = pg_catalog.to_jsonb(p.byte_length)
          )
          and not exists (
            select 1 from public.logo_input_rejections r
            where r.owner_id = p.owner_id and r.project_id = p.project_id and r.request_key = p.request_key
          )
        )
        or (
          p.request->>'kind' = 'stage'
          and p.source_kind in ('vector', 'variant')
          and p.request#>>'{publication,source,kind}' = p.source_kind
          and p.request#>>'{publication,source,sourceId}' = p.source_receipt_id::text
          and p.request#>>'{publication,requestKey}' = p.request_key::text
          and p.request#>>'{publication,contentHash}' = p.content_hash
          and p.request#>>'{publication,mimeType}' = p.mime_type
          and p.request#>'{publication,byteLength}' = pg_catalog.to_jsonb(p.byte_length)
          and (
            (p.source_kind = 'vector' and exists (
              select 1 from public.logo_vector_revisions v
              where v.id = p.source_receipt_id and v.owner_id = p.owner_id and v.project_id = p.project_id
                and v.record->'inputRevisions' = p.request#>'{publication,inputRevisions}'
            ) and not exists (
              -- Exact vectorMemberRequestKey(commandKey, member), pinned by SQL
              -- versus TypeScript golden vectors. A publication key is NOT the
              -- saveLogoEdit command key. Both document and SVG are fenced.
              select 1 from public.logo_vector_edit_cancellations c
              cross join (values ('document'), ('svg')) member(kind)
              cross join lateral (
                select pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
                  'fluid.logo-vector.publication.v1:' || c.request_key::text || ':' || member.kind, 'UTF8'
                )), 'hex') as hash
              ) digest
              where c.owner_id = p.owner_id and c.project_id = p.project_id
                and p.request_key::text = pg_catalog.substr(digest.hash, 1, 8) || '-'
                  || pg_catalog.substr(digest.hash, 9, 4) || '-5' || pg_catalog.substr(digest.hash, 14, 3)
                  || '-a' || pg_catalog.substr(digest.hash, 18, 3) || '-' || pg_catalog.substr(digest.hash, 21, 12)
            ))
            or (p.source_kind = 'variant' and exists (
              select 1 from public.logo_approvals a
              where a.id = p.source_receipt_id and a.owner_id = p.owner_id and a.project_id = p.project_id
            ))
          )
          -- These are retained immutable sources, not current-head selection.
          -- Variant preparation has no cancellation registry to invent here.
        )
      )
  );
end;
$$;

-- Scrub inherited/default EXECUTE grants on this exact new signature only.
-- No broad private-schema USAGE, raw reservation access, default-ACL change,
-- provider helper mutation or grants to service_role/worker identities.
do $$
declare r record; function_id oid := 'fluid_private.owner_staging_object_allowed(text,text)'::regprocedure;
begin
  for r in
    select distinct a.grantee from pg_catalog.pg_proc p
    cross join lateral pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
    where p.oid = function_id and a.grantee <> p.proowner
  loop
    execute pg_catalog.format('revoke all on function %s from %s cascade', function_id::regprocedure,
      case when r.grantee = 0 then 'PUBLIC' else pg_catalog.quote_ident(pg_catalog.pg_get_userbyid(r.grantee)) end);
  end loop;
end;
$$;
grant execute on function fluid_private.owner_staging_object_allowed(text,text) to authenticated;

-- Additive access only. Existing committed manifest policies remain byte-for-
-- byte unchanged: these policies cannot revoke their downloads or signing.
-- Standard create-only upload and authenticated download are the only staging
-- operations. Missing operation context fails closed in the provider helper.
create policy fluid_owner_staging_read on storage.objects as permissive for select to authenticated
  using (bucket_id = 'fluid-assets' and owner_id = (select auth.uid())::text
    and storage.allow_only_operation('object.get_authenticated')
    and fluid_private.owner_staging_object_allowed(bucket_id, name));
create policy fluid_owner_staging_insert on storage.objects as permissive for insert to authenticated
  with check (bucket_id = 'fluid-assets' and owner_id = (select auth.uid())::text
    and storage.allow_only_operation('object.upload')
    and fluid_private.owner_staging_object_allowed(bucket_id, name));
-- No UPDATE, DELETE, ALL, upsert, bucket change or new provider activation.
commit;
