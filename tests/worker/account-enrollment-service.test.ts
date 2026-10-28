import { readFile } from "node:fs/promises";
import { afterEach,describe,expect,it,vi } from "vitest";
vi.mock("server-only",()=>({}));
import { createConfiguredAccountEnrollmentService } from "../../worker/account-enrollment/service";
import { validateEnrollmentOperatorCall } from "../../worker/account-enrollment/operator";
import { ownerWorkerChildEnvironment } from "../../worker/account-enrollment/process-controller";
afterEach(()=>{vi.unstubAllGlobals();});
describe("concrete configured enrollment service construction",()=>{
 it("constructs concrete backend/operator/adapters without I/O and leaves missing worker controller unavailable",async()=>{
  const caPem=await readFile("scripts/certs/supabase-prod-ca-2021.crt","utf8"),transport=vi.fn(async()=>{throw Error("fixture prohibits network");});vi.stubGlobal("fetch",transport);
  const vault={origin:"https://vault.example",mount:"embel",token:"fixture-not-configured-backend"};
  const service=createConfiguredAccountEnrollmentService({approvedProfiles:[],operator:{database:{databaseUrl:"postgresql://embel_account_operator_a:fixture@db.fricsfwqibyhemknqgyf.supabase.co:5432/postgres?sslmode=verify-full",caPem},roleName:"embel_account_operator_a",roleOid:123,trustedCreatorRoleOid:456},
   credentials:{vault,prefix:"accounts",database:{host:"db.fricsfwqibyhemknqgyf.supabase.co",caPem}},httpPublication:{vault,publicationPrefix:"bindings"},workerProcess:null});
  try{await expect(service.deliverStrategy({})).resolves.toEqual({disposition:"retry",state:"runtime_unavailable"});const stopped=new AbortController();stopped.abort();await service.run(stopped.signal);expect(transport).not.toHaveBeenCalled();}
  finally{await service.close();}
 });
 it("enables inherited proxy use without copying Node/driver/provider credentials",()=>{
  const env=ownerWorkerChildEnvironment({NODE_ENV:"test",HTTPS_PROXY:"http://session-proxy",NODE_EXTRA_CA_CERTS:"/managed/ca.pem",PGOPTIONS:"-c row_security=off",OPENAI_API_KEY:"do-not-copy",NODE_OPTIONS:"--inspect"});
  expect(env.NODE_USE_ENV_PROXY).toBe("1");expect(env.NODE_EXTRA_CA_CERTS).toBe("/managed/ca.pem");expect(env).not.toHaveProperty("OPENAI_API_KEY");expect(env).not.toHaveProperty("NODE_OPTIONS");expect(env).not.toHaveProperty("PGOPTIONS");
 });
});
describe("restricted outer operator call boundary",()=>{
 it.each([
  ["SELECT public.claim_account_service_enrollment($1::integer) AS value",[120]],
  ["SELECT public.finish_account_service_enrollment($1::uuid,$2::uuid,$3::text[]) AS value",["owner-claim","lease",[]]],
  ["SELECT public.provision_account_worker_enrollment($1,$2,$3,$4::jsonb,$5,$6) value",["claim","lease","naming","{}","ref","SCRAM"]],
 ])("accepts fixed placeholder-only lease call %s",(sql,values)=>{expect(()=>validateEnrollmentOperatorCall(sql as string,values as unknown[])).not.toThrow();});
 it.each([
  "SELECT * FROM auth.users", "SELECT public.report_account_worker_process($1,$2,$3,$4) value", "SELECT public.claim_account_service_enrollment(120) AS value",
  "SELECT public.claim_account_service_enrollment($2) AS value", "SELECT public.claim_account_service_enrollment($1) AS value; SELECT 1",
  "SELECT public.claim_account_service_enrollment((SELECT 1)) AS value", "GRANT ALL ON ALL TABLES IN SCHEMA public TO owner",
 ])("rejects unreviewed authority or SQL fragments before pool access: %s",sql=>{expect(()=>validateEnrollmentOperatorCall(sql,[120])).toThrow();});
});
