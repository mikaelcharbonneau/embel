import { createTestDatabase, HASH, OWNER_A, type TestDatabase } from "./local-supabase";

/** LOCAL ONLY: the baseline database for the Assets library tests. */
export const createAssetLibraryTestDatabase = createTestDatabase;

/** Explicit metadata fixtures; no object is uploaded and no provider is called. */
export async function seedLibraryAsset(db: TestDatabase, projectId: string, options: {
  ownerId?: string; kind?: string; purpose?: "legacy_unknown"|"brand_asset"|"reference_media"; liked?: boolean; saved?: boolean; used?: boolean; createdAt?: string;
} = {}) {
  const result = await db.query<{ id: string }>(`insert into public.assets(owner_id,project_id,kind,liked,saved,used,created_at${options.purpose===undefined?"":",purpose"})
    values($1,$2,$3,$4,$5,$6,coalesce($7::timestamptz,clock_timestamp())${options.purpose===undefined?"":",$8"}) returning id`,
  [options.ownerId ?? OWNER_A, projectId, options.kind ?? "Explicit local asset fixture", options.liked ?? false, options.saved ?? false, options.used ?? false, options.createdAt ?? null,...(options.purpose===undefined?[]:[options.purpose])]);
  return result.rows[0]!.id;
}
export async function seedLibraryVersion(db: TestDatabase, projectId: string, assetId: string, options: {
  ownerId?: string; version?: number; inputRevision?: number; mimeType?: string; provenance?: unknown; stored?: boolean; createdAt?: string;
} = {}) {
  const id = (await db.query<{ id: string }>("select gen_random_uuid() id")).rows[0]!.id;
  const owner = options.ownerId ?? OWNER_A;
  await db.query(`insert into public.asset_versions(id,owner_id,project_id,asset_id,version,input_revision,input_hash,content_hash,mime_type,provenance,storage_path,created_at)
    values($1,$2,$3,$4,$5,$6,$7,$7,$8,$9::jsonb,$10,coalesce($11::timestamptz,clock_timestamp()))`,
  [id, owner, projectId, assetId, options.version ?? 1, options.inputRevision ?? 1, HASH, options.mimeType ?? "image/png",
    JSON.stringify(options.provenance ?? {}), options.stored ? `${owner}/${projectId}/${assetId}/${id}` : null, options.createdAt ?? null]);
  return id;
}
