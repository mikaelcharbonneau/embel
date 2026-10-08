import { randomUUID } from "node:crypto";
import { expect,it,vi } from "vitest";
vi.mock("server-only",()=>({}));
import { createTestDatabase,OWNER_A,resetFixture } from "./local-supabase";
import { approvedSqlDirectionFixture,bindSqlSubscriptionFixture,configureSqlSubscriptionFixture,installSqlSubscriptionFixture,logoSqlRpc,sqlWorker,SQL_SUBSCRIPTION_ROLE } from "./logo-directions-subscription-fixture";
import { createLogoWorkerRuntime } from "../../worker/logo-runtime";
import { createChatGPTDirectionsProvider } from "@/server/ai/chatgpt-directions";
import { logoResolvedDirectionInputSchema } from "@/domain/logo-jobs";
import type { ChatGPTTransport } from "@/server/ai/chatgpt-transport";
import type { IdentityAssetStore } from "@/server/data/identity-asset-store";
import type { LogoWorkerConnection } from "@/server/data/logo-jobs";
import { separatedLogoDocument } from "../features/logo-vector/fixtures";
it("finishes oversized exact geometry through actual restricted SQL and runner without trapping an undispatched job",async()=>{
 const db=await createTestDatabase();try{
  await resetFixture(db);await installSqlSubscriptionFixture(db);await bindSqlSubscriptionFixture(db);
  await db.exec(`grant execute on function public.register_logo_job_plan(uuid,uuid,jsonb),public.expire_logo_job_leases() to ${SQL_SUBSCRIPTION_ROLE}`);
  const {policy,descriptor}=await configureSqlSubscriptionFixture(db),f=await approvedSqlDirectionFixture(db);
  const quote=await logoSqlRpc(db,"quote_logo_operation",[f.w.projectId,f.request]) as {id:string};
  await logoSqlRpc(db,"admit_logo_operation",[f.w.projectId,{requestKey:randomUUID(),quoteId:quote.id,acceptedMaxCostMicrousd:0,expected:f.w.heads}]);
  const {logoRevision:_revision,...source}=f.source;void _revision;
  const logo=separatedLogoDocument();logo.components[0]!.paths[0]!.d="M 0 0 "+"L 1 1 ".repeat(23000);const resolved=logoResolvedDirectionInputSchema.parse({...source,logo});
  const transport:ChatGPTTransport={listModels:vi.fn(),streamResponse:vi.fn()};
  const provider=createChatGPTDirectionsProvider({transport,ownerId:OWNER_A,projectId:f.w.projectId,policy:{...policy,version:1,billingMode:"chatgpt_subscription",handlerVersion:"logo-directions-v1",adapterVersion:"logo-directions-chatgpt-v1",apiCharge:"verified_zero",limits:{...policy.limits,maxObservedWebSearchCalls:0}},expectedAccountId:policy.registrationId});
  const connection={query:(sql:string,parameters?:unknown[])=>sqlWorker(db,()=>db.query(sql,parameters))} as LogoWorkerConnection;
  const never=async():Promise<never>=>{throw new Error("No dispatch or publication expected");},record=vi.fn(never);
  const runtime=createLogoWorkerRuntime({connection,workerId:"subscription-fixture",manifest:[descriptor as never],composition:{concepts:null,refinements:null,vector:null,exports:null,unavailableReasons:{},directions:{provider,assets:{readLeasedAsset:never,publishLeasedAsset:never} as unknown as IdentityAssetStore,loadInput:async()=>resolved,assertReady:async()=>{},recordResponse:record,publish:never}}});
  expect(await runtime.tick()).toBe("failed");runtime.close();expect(transport.streamResponse).not.toHaveBeenCalled();expect(record).not.toHaveBeenCalled();
  expect((await db.query("select state,actual_cost_microusd from public.jobs")).rows).toEqual([{state:"failed",actual_cost_microusd:0}]);
  expect((await db.query("select state,output from public.job_steps")).rows).toEqual([{state:"failed",output:{error:"not_dispatched"}}]);
  expect((await db.query("select * from public.logo_provider_responses")).rows).toEqual([]);expect((await db.query("select * from public.usage_reservations")).rows).toEqual([]);
 }finally{await db.close();}
},60000);
