import "server-only";
import { setTimeout as delay } from "node:timers/promises";
import { QueueClient } from "@vercel/queue";
import { createSqlEnrollmentStore } from "../../src/server/account-enrollment/sql-store";
import { reconcileAccountEnrollmentOnce } from "../../src/server/account-enrollment/reconciler";
import { createHttpEnrollmentAdapter } from "../../src/server/account-enrollment/http-adapter";
import { handleApiTextQueueRequest } from "../hosting/consumer";
import { readApprovedWorkerProfiles } from "./configuration";
import { createConfiguredEnrollmentOperator } from "./operator";
import { createVaultEnrollmentCredentialStore } from "./vault-credentials";
import { createVaultHttpBindingPublisher } from "./http-publication";
import { createOwnerWorkerProcessController } from "./process-controller";
import { createOwnerWorkerEnrollmentAdapter } from "./adapter";

export type ConfiguredAccountEnrollmentServiceInput={
 approvedProfiles:unknown;
 operator:Parameters<typeof createConfiguredEnrollmentOperator>[0];
 credentials:Omit<Parameters<typeof createVaultEnrollmentCredentialStore>[0],"profiles">;
 httpPublication:Omit<Parameters<typeof createVaultHttpBindingPublisher>[0],"credentials">;
 workerProcess:Parameters<typeof createOwnerWorkerProcessController>[0]|null;
};
/** Explicit trusted service composition. No environment discovery, backend
 * selection, secret provisioning, database mutation or process launch occurs on
 * import. Construction prepares concrete adapters; processOnce/run perform the
 * lease-derived control-plane work only when the operator explicitly starts it.
 * Provider execution remains existing admitted job authority in child engines.
 */
export function createConfiguredAccountEnrollmentService(input:ConfiguredAccountEnrollmentServiceInput){
 const profiles=readApprovedWorkerProfiles(input.approvedProfiles),operator=createConfiguredEnrollmentOperator(input.operator),store=createSqlEnrollmentStore(operator);
 const credentials=createVaultEnrollmentCredentialStore({...input.credentials,profiles}),publisher=createVaultHttpBindingPublisher({...input.httpPublication,credentials});
 const controller=input.workerProcess?createOwnerWorkerProcessController(input.workerProcess):null;
 const http=createHttpEnrollmentAdapter({credentials,publisher}),worker=createOwnerWorkerEnrollmentAdapter({profiles,credentials,controller});
 const adapters={home_attachments:http,identity_transactions:http,strategy:worker,naming:worker,logo:worker};
 let closed=false,running:Promise<void>|undefined;const lifetime=new AbortController();
 const processOnce=(signal?:AbortSignal)=>{
  if(closed)return Promise.resolve({status:"stopped"} as const);
  return reconcileAccountEnrollmentOnce(store,adapters,{signal:AbortSignal.any([lifetime.signal,...(signal?[signal]:[])])});
 };
 const deliverStrategy=(message:unknown,signal?:AbortSignal)=>{
  if(closed||!controller)return Promise.resolve({disposition:"retry" as const,state:"runtime_unavailable"});
  return controller.deliverAdmittedStrategy(message,AbortSignal.any([lifetime.signal,...(signal?[signal]:[])]));
 };
 return Object.freeze({processOnce,deliverStrategy,
  run(signal:AbortSignal):Promise<void>{
   if(running)return running;const combined=AbortSignal.any([lifetime.signal,signal]);
   running=(async()=>{while(!closed&&!combined.aborted){await processOnce(combined);await delay(1000,undefined,{signal:combined}).catch(()=>{});}})();return running;
  },
  /** Actual Vercel Queue SDK callback verification/lease/ack implementation;
   * no public plain-JSON execution fallback or owner selector. Hosting must
   * configure the queue/v2beta trigger separately before mounting this handler.
   */
  createStrategyQueueConsumer(){const queue=new QueueClient({region:"iad1",telemetry:{isEnabled:false}});return{fetch:(request:Request)=>handleApiTextQueueRequest(request,{queue,deliver:deliverStrategy})};},
  async close(){
   closed=true;lifetime.abort();await running?.catch(()=>{});
   const result=await Promise.allSettled([controller?.close(),credentials.close(),operator.close()]);
   if(result.some(item=>item.status==="rejected"))throw Error("Account enrollment service drain is unconfirmed");
  },
 });
}
