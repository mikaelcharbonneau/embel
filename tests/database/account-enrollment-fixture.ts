import { readFile } from "node:fs/promises";
import { createIdentityTrustedDatabase } from "./identity-trusted-replacement-database";
import type { EnrollmentOperatorPort } from "@/server/account-enrollment/contracts";

/** Disposable SQL fixture only. Auth rows/provider schemas are emulated; this
 * is not a hosted service, provider call, persistent principal or vault. */
export async function createAccountEnrollmentFixture() {
  const db = await createIdentityTrustedDatabase();
  try {
    await db.exec(`alter table auth.users add column email_confirmed_at timestamptz;
      alter table auth.users add column is_anonymous boolean not null default false;
      alter table auth.users add column banned_until timestamptz;
      alter table auth.users add column deleted_at timestamptz;
      truncate fluid_private.identity_web_principals;`);
    await db.exec(await readFile(new URL("../../supabase/candidates/account_service_enrollment.sql", import.meta.url), "utf8"));
    await db.exec(`create role fixture_enrollment_operator login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
      grant usage on schema public to fixture_enrollment_operator;
      grant execute on function public.claim_account_service_enrollment(integer),public.read_account_service_enrollment_claim(uuid,uuid),
       public.record_account_service_enrollment(uuid,uuid,text,text,text),public.provision_account_enrollment_http(uuid,uuid,text,text,text),
       public.revoke_account_enrollment_http(uuid,uuid,text),public.verify_account_http_revocation(uuid,uuid,text,text),public.acknowledge_account_enrollment_revocation(uuid,uuid,text,text),
       public.finish_account_service_enrollment(uuid,uuid,text[]) to fixture_enrollment_operator;
      insert into fluid_private.account_enrollment_operators(role_name,role_oid,management_version)
       select rolname,oid,2 from pg_roles where rolname='fixture_enrollment_operator';`);
    async function admin<T>(run: () => Promise<T>) {
      await db.exec("set session authorization postgres"); return await run();
    }
    const operator: EnrollmentOperatorPort = { async query(sql, values) {
      await db.exec("set session authorization postgres");
      await db.exec("set session authorization fixture_enrollment_operator");
      try { return await db.query(sql, values ? [...values] : []); }
      finally { if (db.isInTransaction()) await db.exec("ROLLBACK"); await db.exec("set session authorization postgres"); }
    } };
    async function seedUser(id: string, options: { confirmed?: boolean; anonymous?: boolean; banned?: boolean; deleted?: boolean } = {}) {
      await admin(async () => { await db.query(`insert into auth.users(id,email_confirmed_at,is_anonymous,banned_until,deleted_at)
       values($1,case when $2 then clock_timestamp() else null end,$3,case when $4 then clock_timestamp()+interval '1 day' else null end,
       case when $5 then clock_timestamp() else null end)`, [id, options.confirmed !== false, options.anonymous ?? false, options.banned ?? false, options.deleted ?? false]); });
    }
    return { db, admin, operator, seedUser, async close() { await db.exec("set session authorization postgres"); await db.close(); } };
  } catch (error) { await db.close(); throw error; }
}
