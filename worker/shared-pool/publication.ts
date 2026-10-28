import "server-only";
import type { SendOptions,SendResult } from "@vercel/queue";
import { apiTextDispatchDescriptorSchema,apiTextDispatchMessage,type ApiTextDispatchMessage } from "../../src/domain/api-text-dispatch";
import type { SharedSlotDatabase,SharedSlotLease } from "./contracts";
import type { SharedQueueConfiguration } from "./queue";
export interface SharedQueuePublisherPort {send<T=unknown>(topic:string,payload:T,options?:SendOptions):Promise<SendResult>;}
const unavailable=()=>Error("shared_strategy_publication_unavailable");
/** Transactional DB outbox -> same-project native Queue. No cross-project HTTP
 * worker endpoint or web provider/publisher credential is needed. Lost send or
 * publication acknowledgements leave the immutable outbox retryable. */
export async function publishSharedStrategyOutboxOnce(options:{database:SharedSlotDatabase;lease:()=>SharedSlotLease|null;
 queue:SharedQueuePublisherPort;configuration:SharedQueueConfiguration},signal:AbortSignal):Promise<number>{
 signal.throwIfAborted();const lease=options.lease();if(!lease||lease.lane!=="strategy")throw unavailable();
 const rows=await options.database.query("SELECT public.list_shared_strategy_dispatches($1::jsonb,$2) dispatch",[JSON.stringify(lease),25]);
 if(rows.rows.length>25)throw unavailable();let published=0;
 for(const row of rows.rows){
  signal.throwIfAborted();const current=options.lease();
  if(!current||current.slotId!==lease.slotId||current.instanceId!==lease.instanceId||current.generation!==lease.generation||current.leaseToken!==lease.leaseToken)throw unavailable();
  const descriptor=apiTextDispatchDescriptorSchema.parse(row.dispatch);
  if(descriptor.deploymentId!==options.configuration.deploymentId||descriptor.state!=="queued"||descriptor.publishedMessageId!==null||descriptor.publishedAt!==null||!descriptor.retryable)throw unavailable();
  const message:ApiTextDispatchMessage=apiTextDispatchMessage(descriptor);
  const receipt=await options.queue.send(options.configuration.topic,message,{retentionSeconds:86_400,idempotencyKey:descriptor.dispatchIdentity});
  // A null broker ID is not an invented successful publication receipt.
  if(receipt.messageId===null)continue;
  if(typeof receipt.messageId!=="string"||receipt.messageId.length<1||receipt.messageId.length>300)throw unavailable();
  signal.throwIfAborted();const actual=options.lease();
  if(!actual||actual.slotId!==lease.slotId||actual.instanceId!==lease.instanceId||actual.generation!==lease.generation||actual.leaseToken!==lease.leaseToken)throw unavailable();
  const result=await options.database.query("SELECT public.shared_strategy_worker_action($1::jsonb,NULL,$2,$3::jsonb) envelope",
   [JSON.stringify(actual),"published",JSON.stringify({message,values:[descriptor.publicationGeneration,receipt.messageId]})]);
  const envelope=result.rows[0]?.envelope;
  if(result.rows.length!==1||!envelope||typeof envelope!=="object"||Reflect.get(envelope,"execution")!==null||Reflect.get(envelope,"result")!==true)throw unavailable();
  published++;
 }
 return published;
}
