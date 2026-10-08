import { PGlite } from "@electric-sql/pglite";
import { readdir, readFile } from "node:fs/promises";
import { fixtureMigrationNames } from "./fixture-migrations";
import { createTestDatabase, installStorageOperationFixture, HASH, OWNER_A, type TestDatabase } from "./local-supabase";

export const assetLibraryMigration = "20261005010000_asset_library.sql";

/** LOCAL ONLY: ordinary calls exercise every migration; the callback seeds
 * legitimate old rows immediately before the additive Assets upgrade. */
export async function createAssetLibraryTestDatabase(beforeUpgrade?: (db: TestDatabase) => Promise<void>) {
  if (!beforeUpgrade) return createTestDatabase();
  const db = new PGlite();
  try {
    await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin bypassrls;
    create role fixture_subscription_worker_a login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
    create role fixture_subscription_worker_b login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
    create schema auth;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth, public to anon, authenticated, service_role;
    grant execute on function auth.uid() to anon, authenticated, service_role;
    create schema storage;
    create table storage.buckets(id text primary key, name text not null, public boolean not null default false, file_size_limit bigint);
    create table storage.objects(id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets(id), name text not null, owner_id text, unique(bucket_id,name));
    alter table storage.objects enable row level security;
    grant usage on schema storage to authenticated, service_role;
    grant select, insert, update, delete on storage.objects to authenticated, service_role;
    `);
    await installStorageOperationFixture(db);
    const directory = new URL("../../supabase/migrations/", import.meta.url);
    const names = fixtureMigrationNames(await readdir(directory));
    if (!names.includes(assetLibraryMigration)) throw new Error("Assets migration is not present in this local fixture");
    for (const name of names) {
      if (name === assetLibraryMigration) await beforeUpgrade(db);
      await db.exec(await readFile(new URL(name, directory), "utf8"));
    }
    return db;
  } catch (error) { await db.close(); throw error; }
}

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
