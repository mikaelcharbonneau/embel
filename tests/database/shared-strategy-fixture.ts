import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { asRole } from "./local-supabase";
import { createSharedWorkerFixture, OWNER_A, OWNER_B } from "./shared-worker-fixture";
import { guidedStrategyPolicy } from "../../src/server/ai/config";
import { contextSnapshotSchema } from "../../src/domain/projects";
import type { StrategyOperation } from "../../src/domain/strategy-jobs";
import { strategyOperations } from "../../worker/account-enrollment/configuration";

export { OWNER_A, OWNER_B };
export async function createSharedStrategyFixture() {
 const core=await createSharedWorkerFixture({probe:false}),db=core.db;
 try {
  await db.exec(await readFile(new URL("../../supabase/candidates/shared_worker_strategy.sql",import.meta.url),"utf8"));
  await core.seedUser(OWNER_A);await core.seedUser(OWNER_B);
  const policies=Object.fromEntries(strategyOperations.map(op=>[op,guidedStrategyPolicy(op)]));
  const identities:Record<string,string>={};
  for(const operation of strategyOperations)identities[operation]=(await db.query<{value:string}>("select encode(sha256(convert_to($1::jsonb::text,'UTF8')),'hex') value",[JSON.stringify(policies[operation])])).rows[0]!.value;
  const slot=await core.seedSlot({lane:"strategy",policies:strategyOperations.map(operation=>({operation,policyIdentity:identities[operation]!,policy:policies[operation]!}))});
  slot.deploymentId="dpl_sharedfixture";
  await db.query("update fluid_private.shared_worker_slots set deployment_id=$1 where slot_id=$2",[slot.deploymentId,slot.slotId]);
  await db.exec(`grant execute on function public.shared_strategy_worker_action(jsonb,jsonb,text,jsonb),public.list_shared_strategy_dispatches(jsonb,integer) to ${slot.roleName}`);
  let lease=await core.lease(slot);
  async function owner<T>(ownerId:string,name:string,args:unknown[]) {
   if(!/^[a-z_]+$/u.test(name))throw Error("Invalid fixture RPC");
   return asRole(db,"authenticated",ownerId,async()=>(await db.query<{value:T}>(`select to_jsonb(public.${name}(${args.map((_,i)=>`$${i+1}`).join(",")})) value`,args.map(v=>v&&typeof v==="object"?JSON.stringify(v):v))).rows[0]!.value);
  }
  async function project(operation:StrategyOperation="strategy.reformulate",ownerId=OWNER_A) {
   const stage=operation==="strategy.reformulate"?"competitors":operation.slice("strategy.".length);
   const context=contextSnapshotSchema.parse({description:"Synthetic shared Strategy brief",intake:{conversation:[{kind:"user_message",id:"synthetic-prompt",text:"Coffee workshops",createdAt:"2026-10-17T12:00:00Z"}],
    guidedInterview:{version:1,stage,turns:[{id:"synthetic-turn",userMessageId:"synthetic-prompt",inputRevision:1,stage,purpose:operation==="strategy.reformulate"?"message":operation==="strategy.competitors"?"research":"propose"}],answers:[]}}});
   return owner<{id:string}>(ownerId,"create_project",["complete_brand","Synthetic shared Strategy",context,"a".repeat(64)]);
  }
  type Message={version:1;jobId:string;policyIdentity:string;deploymentId:string;dispatchIdentity:string};
  async function submit(projectId:string,operation:StrategyOperation="strategy.reformulate",ownerId=OWNER_A,key=`shared-fixture-${crypto.randomUUID()}`) {
   return owner<{id:string;spendControl:string;dispatch:Message}>(ownerId,"enqueue_shared_strategy_job",[projectId,1,operation,key,identities[operation]]);
  }
  async function action<T=unknown>(message:Message|null,action:string,values:unknown[]=[],execution:Record<string,unknown>|null=null) {
   return core.asSlot(slot,async()=>(await db.query<{envelope:{execution:Record<string,unknown>|null;result:T}}>("select public.shared_strategy_worker_action($1::jsonb,$2::jsonb,$3,$4::jsonb) envelope",
    [JSON.stringify(lease),execution===null?null:JSON.stringify(execution),action,JSON.stringify({message,values})])).rows[0]!.envelope);
  }
  async function claim(message:Message) {
   const value=await action<{disposition:string;job:{id:string;lease_token:string;reserved_cost_microusd:number};executionAuthority:Record<string,unknown>}>(message,"claim",["synthetic-shared-worker",120]);
   if(!value.execution||value.result.disposition!=="claimed")throw Error("Synthetic shared claim unavailable");
   return {...value,execution:value.execution,requestKey:createHash("sha256").update(`${message.jobId}:synthetic`).digest("hex")};
  }
  return {...core,policies,identities,slot,get lease(){return lease;},setLease(value:typeof lease){lease=value;},leaseSlot:()=>core.lease(slot),owner,project,submit,action,claim};
 }catch(error){await core.close();throw error;}
}
