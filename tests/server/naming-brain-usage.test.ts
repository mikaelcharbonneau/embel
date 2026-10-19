import { expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { listRecordedUsage } from "../../src/server/data/recorded-usage";
import type { AuthenticatedContext } from "../../src/server/auth/context";
const owner="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",project="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",managed="11111111-1111-4111-8111-111111111111",legacy="22222222-2222-4222-8222-222222222222";
it("retains managed completion with unknown tokens while reading the single legacy usage receipt",async()=>{
 const jobs=[{id:managed,owner_id:owner,project_id:project,operation:"naming.generate",billing_mode:"openai_api",state:"succeeded",finished_at:"2026-10-16T12:00:00Z"},{id:legacy,owner_id:owner,project_id:project,operation:"strategy.reformulate",billing_mode:"openai_api",state:"succeeded",finished_at:"2026-10-16T11:00:00Z"}];
 const steps=[...Array.from({length:7},()=>({job_id:managed,owner_id:owner,project_id:project,state:"succeeded",receipt_operation:null,usage:null})),{job_id:legacy,owner_id:owner,project_id:project,state:"succeeded",receipt_operation:"strategy.reformulate",usage:{inputTokens:10,outputTokens:4,totalTokens:14}}];
 const auth={userId:owner,client:{from:(table:string)=>{
  let rows:unknown[]=table==="jobs"?jobs:steps;
  const query={select:()=>query,eq:()=>query,order:()=>query,in:(field:string,values:string[])=>{rows=rows.filter(row=>values.includes((row as Record<string,string>)[field]!));return query;},limit:async(n:number)=>({data:rows.slice(0,n),error:null})};return query;
 }}} as unknown as AuthenticatedContext;
 const result=await listRecordedUsage(auth);
 expect(result.entries).toEqual([{id:managed,operation:"naming.generate",completedAt:"2026-10-16T12:00:00Z",tokens:null},{id:legacy,operation:"strategy.reformulate",completedAt:"2026-10-16T11:00:00Z",tokens:{inputTokens:10,outputTokens:4,totalTokens:14}}]);
});
