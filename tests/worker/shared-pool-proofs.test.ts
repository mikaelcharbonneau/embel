import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe,expect,it,vi } from "vitest";
vi.mock("server-only",()=>({}));
import { SHARED_CORE_RPC_PROOFS } from "../../worker/shared-pool/proofs";
import { readSharedPoolConfiguration } from "../../worker/shared-pool/configuration";
import { sharedConfiguration,sharedEnvironment } from "./shared-pool-fixture";
const names={claim:"claim_shared_worker_slot",renew:"renew_shared_worker_slot",release:"release_shared_worker_slot",fence:"fence_shared_worker_slot",pending:"read_shared_worker_execution_page",capacity:"shared_worker_pool_configuration"};
describe("reviewed shared SQL release pins (source, not connected-server discovery)",()=>{
 for(const key of Object.keys(names) as Array<keyof typeof names>)it(`pins exact reviewed ${key} source body`,()=>{
  const sql=readFileSync(new URL("../../supabase/candidates/shared_worker_pool.sql",import.meta.url),"utf8");
  const body=new RegExp(`create(?: or replace)? function public\\.${names[key]}\\([^$]+?as \\$\\$([\\s\\S]*?)\\$\\$;`,"iu").exec(sql)?.[1];
  expect(body).toBeTypeOf("string");expect(createHash("sha256").update(body!).digest("hex")).toBe(SHARED_CORE_RPC_PROOFS[key].sha256);
 });
 it("does not accept an arbitrary procedure hash copied from a server into settings",()=>{
  const config=sharedConfiguration();config.coreProofs.claim.sha256="f".repeat(64);
  expect(()=>readSharedPoolConfiguration(sharedEnvironment(config))).toThrow("configuration");
 });
});
