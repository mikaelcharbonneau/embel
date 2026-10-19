import { namingHash } from "../../src/server/ai/naming-brain/identity";
import { normalizeNamingStoredJson } from "../../worker/naming-brain-store";
import type { JobDatabase } from "../../worker/postgres-store";
import type { TestDatabase } from "./local-supabase";

/** Test-only adapter for intentionally pre-upgrade SQL snapshots. Their original
 * claim RPC still enforces ownership and leases; this supplies the newer claim
 * envelope from the exact persisted local marker, without changing old inputs,
 * requests or SQL execution. Current migrations always use their real envelope. */
export async function historicalNamingClaimDatabase(database: TestDatabase): Promise<JobDatabase> {
  const installed = await database.query<{ installed: boolean }>("select to_regprocedure('fluid_private.naming_brain_execution_authority(uuid)') is not null as installed");
  if (installed.rows[0]!.installed) return database;
  const markers = await database.query<{ id: string; owner_id: string; project_id: string; input: unknown; role_name: string; role_oid: string; deployment_id: string }>(`
    select j.id,j.owner_id,j.project_id,j.input,m.role_name::text,m.role_oid::text,m.deployment_id
    from fluid_private.local_prototype_jobs m
    join public.jobs j on j.id=m.job_id and j.owner_id=m.owner_id and j.project_id=m.project_id
    join fluid_private.naming_brain_runs r on r.job_id=j.id and r.owner_id=j.owner_id and r.project_id=j.project_id
    where fluid_private.naming_brain_is_job(j) and not(j.input ? 'executionAuthority')
    and m.role_name=r.admitted_role_name and m.role_oid=r.admitted_role_oid and m.deployment_id=r.deployment_id
    and fluid_private.api_text_restricted_role(m.role_name,m.role_oid)`);
  const origins = new Map(markers.rows.map(marker => [marker.id, { ...marker, inputHash: namingHash(normalizeNamingStoredJson(marker.input)) }]));
  return { async query(sql, values = []) {
    const response = await database.query<Record<string, unknown>>(sql, values);
    if (!sql.includes("public.claim_naming_brain_job(")) return response;
    const result = response.rows[0]?.result as { executionAuthority?: unknown; job?: Record<string, unknown> } | null;
    if (!result || !result.job || Object.hasOwn(result, "executionAuthority")) return response;
    const job = result.job, marker = origins.get(String(job.id));
    let authority: "local_owner_v1" | null = null;
    if (marker) {
      const current = (await database.query<{ role_name: string; role_oid: string }>("select rolname::text role_name,oid::text role_oid from pg_roles where rolname=session_user")).rows[0]!;
      if (job.owner_id !== marker.owner_id || job.project_id !== marker.project_id || values[1] !== marker.deployment_id
        || current.role_name !== marker.role_name || current.role_oid !== marker.role_oid
        || namingHash(normalizeNamingStoredJson(job.input)) !== marker.inputHash) throw new Error("historical_fixture_claim_origin_mismatch");
      authority = "local_owner_v1";
    }
    return { rows: [{ ...response.rows[0], result: { ...result, executionAuthority: authority } }] };
  } };
}
