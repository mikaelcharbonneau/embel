import type { AuthenticatedContext } from "../../src/server/auth/context";
import { createTestDatabase, asRole, OWNER_A, HASH, type TestDatabase } from "./local-supabase";
import { identityReferencesOverviewSchema, setReferenceReactionResponseSchema, identityReferenceSnapshotSchema } from "../../src/domain/identity-references";
export { createTestDatabase as createReferenceTestDatabase };

/** Administrative LOCAL ONLY metadata; no uploaded bytes, catalog or remote call. */
export async function seedReference(db: TestDatabase, projectId: string, options: {
  ownerId?: string; tags?: string[]; relevantElements?: string[]; createdAt?: string; purpose?: string;
  mimeType?: string; stored?: boolean; source?: string; attribution?: unknown; mediaProjectId?: string; mediaOwnerId?: string;
} = {}) {
  const owner = options.ownerId ?? OWNER_A, mediaOwner = options.mediaOwnerId ?? owner, mediaProject = options.mediaProjectId ?? projectId;
  const ids = (await db.query<{ asset: string; version: string; reference: string }>("select gen_random_uuid() asset,gen_random_uuid() version,gen_random_uuid() reference")).rows[0]!;
  await db.query("insert into public.assets(id,owner_id,project_id,kind,purpose) values($1,$2,$3,'Explicit local reference fixture',$4)", [ids.asset, mediaOwner, mediaProject, options.purpose ?? "reference_media"]);
  await db.query(`insert into public.asset_versions(id,owner_id,project_id,asset_id,version,input_revision,input_hash,content_hash,mime_type,storage_path,provenance)
    values($1,$2,$3,$4,1,1,$5,$5,$6,$7,'{}'::jsonb)`, [ids.version, mediaOwner, mediaProject, ids.asset, HASH, options.mimeType ?? "image/png", options.stored === false ? null : `${mediaOwner}/${mediaProject}/${ids.asset}/${ids.version}`]);
  await db.query(`insert into public.identity_references(id,owner_id,project_id,asset_id,media_version_id,source,attribution,relevant_elements,tags,created_at)
    values($1,$2,$3,$4,$5,$10,$6::jsonb,$7::text[],$8::text[],coalesce($9::timestamptz,clock_timestamp()))`,
  [ids.reference, owner, projectId, ids.asset, ids.version, JSON.stringify(options.attribution ?? { label: "Synthetic local reference", creator: null, sourceUrl: "https://example.invalid/reference", rightsNote: null }), options.relevantElements ?? ["logo", "colors"], options.tags ?? ["local-tag"], options.createdAt ?? null, options.source ?? "user_supplied"]);
  return ids;
}
export async function readReferences(db: TestDatabase, projectId: string, query: unknown = {}, owner = OWNER_A) {
  return asRole(db, "authenticated", owner, async () => identityReferencesOverviewSchema.parse((await db.query<{ value: unknown }>("select public.get_identity_references($1,$2::jsonb) value", [projectId, JSON.stringify(query)])).rows[0]!.value));
}
export async function react(db: TestDatabase, projectId: string, referenceId: string, input: unknown = { expectedRevision: 0, ensemble: false, elements: ["logo"] }, owner = OWNER_A) {
  return asRole(db, "authenticated", owner, async () => setReferenceReactionResponseSchema.parse((await db.query<{ value: unknown }>("select public.set_identity_reference_reaction($1,$2,$3::jsonb) value", [projectId, referenceId, JSON.stringify(input)])).rows[0]!.value));
}
/** The private seam is invoked as the local administrator with an explicit synthetic
 * JWT claim, never by granting the client or worker a production capability. */
export async function capture(db: TestDatabase, projectId: string, revision: number, owner = OWNER_A) {
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [owner]);
  try { return identityReferenceSnapshotSchema.parse((await db.query<{ value: unknown }>("select fluid_private.capture_identity_reference_snapshot($1,$2) value", [projectId, revision])).rows[0]!.value); }
  finally { await db.query("select set_config('request.jwt.claim.sub','',false)"); }
}

/** Local Supabase-shaped transport backed by actual PostgreSQL/RLS/RPC behavior.
 * This exercises DAL response acceptance after a real commit, without a network. */
export function referenceDalAuth(db: TestDatabase, owner = OWNER_A): AuthenticatedContext {
  const client = {
    from(table: string) {
      if (table !== "projects") throw new Error("Unexpected fixture read");
      const filters: Record<string, string> = {};
      const chain = {
        select(columns: string) { if (columns !== "id,owner_id") throw new Error("Unexpected fixture projection"); return chain; },
        eq(key: string, value: string) { filters[key] = value; return chain; },
        async maybeSingle() {
          const result = await asRole(db, "authenticated", owner, () => db.query("select id,owner_id from public.projects where id=$1 and owner_id=$2", [filters.id, filters.owner_id]));
          return { data: result.rows[0] ?? null, error: null };
        },
      };
      return chain;
    },
    async rpc(name: string, args: Record<string, unknown>) {
      try {
        const result = await asRole(db, "authenticated", owner, async () => {
          if (name === "get_identity_references") return db.query<{ value: unknown }>("select public.get_identity_references($1,$2::jsonb) value", [args.p_project_id, JSON.stringify(args.p_query)]);
          if (name === "set_identity_reference_reaction") return db.query<{ value: unknown }>("select public.set_identity_reference_reaction($1,$2,$3::jsonb) value", [args.p_project_id, args.p_reference_id, JSON.stringify(args.p_input)]);
          throw new Error("Unexpected fixture RPC");
        });
        return { data: result.rows[0]!.value, error: null };
      } catch (error) { return { data: null, error: error as { code?: string } }; }
    },
  };
  return { userId: owner, client } as unknown as AuthenticatedContext;
}
