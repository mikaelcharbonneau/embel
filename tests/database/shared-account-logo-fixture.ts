import { readFileSync } from "node:fs";
import { readFile as readText } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { AuthenticatedContext } from "../../src/server/auth/context";
import type { SharedAccountHttpDependencies } from "../../src/server/shared-account/runtime";
import { createSharedAccountFixture, sharedHttpOrigin } from "./shared-account-fixture";
import { createSharedLogoHttpRuntime } from "../../src/server/shared-account/logo-runtime";
import { logoHttpFixture } from "../fixtures/logo-http-runtime";
import { startLogoFixture } from "./logo-project-fixture";
export const sharedLogoRole = "embel_shared_http_logo_test";
export async function createSharedLogoFixture() {
  const f = await createSharedAccountFixture(), { db } = f;
  await db.exec(await readText(new URL("../../supabase/candidates/shared_logo_http.sql", import.meta.url), "utf8"));
  await db.exec(`create role ${sharedLogoRole} login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
    grant usage on schema public to ${sharedLogoRole};grant execute on function public.shared_logo_http_principal(),public.execute_shared_logo_request(text,text,jsonb,jsonb) to ${sharedLogoRole};
    insert into fluid_private.shared_logo_http_principals(lane,role_name,role_oid,enabled) select 'logo',rolname,oid,true from pg_roles where rolname='${sharedLogoRole}';`);
  const roleOid = Number((await db.query<{ oid: number }>("select oid::int oid from pg_roles where rolname=$1", [sharedLogoRole])).rows[0]!.oid);
  async function issue(owner: string, action: string, project: string, intent: unknown) {
    return f.asAuth(owner, async () => (await db.query<{ value: { version: 1; token: string; ownerId: string; expiresAt: string } }>("select public.issue_shared_logo_request($1,$2::jsonb) value", [action, JSON.stringify([project, intent])])).rows[0]!.value);
  }
  async function execute(owner: string, action: string, project: string, intent: unknown, evidence: unknown = null) {
    const cap = await issue(owner, action, project, intent);
    return f.asSession(sharedLogoRole, async () => (await db.query<{ value: unknown }>("select public.execute_shared_logo_request($1,$2,$3::jsonb,$4::jsonb) value", [cap.token, action, JSON.stringify([project, intent]), evidence === null ? null : JSON.stringify(evidence)])).rows[0]!.value);
  }
  const allowedRpc = new Set(["issue_shared_logo_request", "get_logo_workspace", "read_logo_asset", "list_logo_references", "read_logo_input_request", "list_logo_input_requests", "get_logo_stage_revision", "read_logo_workspace_request", "read_logo_current_vector", "read_logo_workspace_record"]);
  function auth(owner: string): AuthenticatedContext {
    const user = { id: owner, is_anonymous: false, email_confirmed_at: "2026-10-01T00:00:00Z" };
    return { userId: owner, client: { auth: { getSession: async () => ({ data: { session: { user, access_token: `inert.${owner}.token` } }, error: null }), getUser: async () => ({ data: { user }, error: null }) }, rpc(name: string, args: Record<string, unknown>) {
      if (!allowedRpc.has(name)) throw Error(`Unexpected fixture RPC ${name}`);
      const request = (async () => {
        const previous = (await db.query<{ role: string }>("select session_user::text role")).rows[0]!.role;
        try {
          const result = await f.asAuth(owner, () => db.query<{ value: unknown }>(`select public.${name}(${Object.keys(args).map((key, i) => `${key}=>$${i + 1}`).join(",")}) value`, Object.values(args).map(value => value && typeof value === "object" ? JSON.stringify(value) : value)));
          return { data: result.rows[0]!.value, error: null };
        } catch (error) { return { data: null, error }; }
        finally { await db.exec(`set session authorization ${previous}`); }
      })();
      return Object.assign(request, { abortSignal: () => request });
    } } } as unknown as AuthenticatedContext;
  }
  async function start(owner: string) {
    const query = async (sql: string, params: unknown[]) => {
      const previous = (await db.query<{ role: string }>("select session_user::text role")).rows[0]!.role;
      try { return (await f.asAuth(owner, () => db.query<{ value: unknown }>(sql, params))).rows[0]!.value; }
      finally { await db.exec(`set session authorization ${previous}`); }
    };
    return startLogoFixture(query, { requestKey: randomUUID(), brief: { name: "Shared test", activity: "Studio", audience: "Founders", personality: "Calm", logoTypes: ["wordmark"] } });
  }
  const objects = new Map<string, { bytes: Uint8Array; mime: string }>(), calls: string[] = [];
  async function seedVector(owner: string, project: string) {
    // Administrative synthetic source metadata only. All subsequent bytes,
    // geometry/provenance validation and command persistence use real services/SQL.
    const sample = logoHttpFixture(owner as ReturnType<typeof randomUUID>, project as ReturnType<typeof randomUUID>);
    for (const row of sample.rows.values()) {
      const ref = row.reference, file = sample.objects.get(row.storagePath)!;
      await db.query("insert into public.assets(id,owner_id,project_id,kind,purpose) values($1,$2,$3,'Synthetic vector source',$4)", [ref.assetId, owner, project, row.purpose]);
      await db.query("insert into public.asset_versions(id,owner_id,project_id,asset_id,version,input_revision,input_hash,content_hash,mime_type,storage_path,provenance) values($1,$2,$3,$4,1,1,$5,$6,$7,$8,'{}')", [ref.versionId, owner, project, ref.assetId, "a".repeat(64), ref.contentHash, row.mimeType, row.storagePath]);
      await db.query(`insert into public.logo_asset_publications(id,owner_id,project_id,request_key,request,asset_id,version_id,content_hash,mime_type,byte_length,purpose,source_receipt_id,source_kind,state,verification,input_revision,input_hash)
        values($1,$2,$3,$4,'{}',$5,$6,$7,$8,$9,$10,$11,'vector','committed',$12::jsonb,1,$13)`, [row.id, owner, project, row.requestKey, ref.assetId, ref.versionId, ref.contentHash, row.mimeType, row.byteLength, row.purpose, row.sourceReceiptId,
        JSON.stringify({ status: "verified", checkedAt: "2026-10-07T00:00:00Z", contentHash: ref.contentHash, mimeType: row.mimeType, byteLength: row.byteLength }), "a".repeat(64)]);
      objects.set(`${sharedHttpOrigin}/storage/v1/object/fluid-assets/${row.storagePath}`, { bytes: new Uint8Array(file.bytes), mime: file.mimeType });
    }
    await db.query("insert into public.logo_vector_revisions(id,owner_id,project_id,record) values($1,$2,$3,$4::jsonb)", [sample.revision.id, owner, project, JSON.stringify(sample.revision)]);
    return sample.revision;
  }
  function runtime(lostCommit = false) {
    const dependencies: SharedAccountHttpDependencies = {
      readCertificate: () => readFileSync(new URL("../../scripts/certs/supabase-prod-ca-2021.crt", import.meta.url), "utf8"),
      fetch: async (input, init) => {
        if (typeof input !== "string") throw Error("Unexpected fixture URL"); calls.push(`${init?.method} ${input}`);
        if (init?.method === "POST") { if (objects.has(input)) return Response.json({ code: "ResourceAlreadyExists" }, { status: 409 });
          objects.set(input, { bytes: new Uint8Array(init.body as Uint8Array), mime: new Headers(init.headers).get("content-type")! });
          return Response.json({ Id: randomUUID(), Key: input.split("/storage/v1/object/")[1] }); }
        const value = objects.get(input); return value ? new Response(new Uint8Array(value.bytes).buffer, { headers: { "content-type": value.mime } }) : new Response(null, { status: 404 });
      },
      createPool: () => ({ on() {}, async end() {}, async connect() {
        await db.exec(`set session authorization ${sharedLogoRole}`);
        return { on() {}, removeListener() {}, async end() {}, release() { void db.exec("reset role;set session authorization postgres"); }, async query(input) {
          const result = await db.query(input.text, input.values); if (lostCommit && input.text === "COMMIT") throw Error("Synthetic lost real COMMIT acknowledgement"); return result;
        } };
      } }),
    };
    return createSharedLogoHttpRuntime({ EMBEL_SHARED_WORKERS_ENABLED: "true", NEXT_PUBLIC_SUPABASE_URL: sharedHttpOrigin, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_inertfixture", EMBEL_SHARED_LOGO_HTTP_CONFIG: JSON.stringify({ roleName: sharedLogoRole, roleOid, databaseUrl: `postgresql://${sharedLogoRole}:inertfixture@db.fricsfwqibyhemknqgyf.supabase.co:5432/postgres?sslmode=verify-full` }) }, dependencies)!;
  }
  return { ...f, roleOid, issueLogo: issue, executeLogo: execute, auth, start, seedVector, objects, calls, runtime };
}
export type SharedLogoFixture = Awaited<ReturnType<typeof createSharedLogoFixture>>;
