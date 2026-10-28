import "server-only";
import { PollingQueueClient,type ReceiveOptions,type ReceiveResult,type MessageHandler } from "@vercel/queue";
import { z } from "zod";
import type { SharedDeliveryResult } from "./contracts";
import type { SharedQueuePublisherPort } from "./publication";

export const sharedQueueConfigurationSchema=z.strictObject({region:z.literal("iad1"),topic:z.string().regex(/^[A-Za-z0-9_-]{1,100}$/u),
 consumerGroup:z.string().regex(/^[A-Za-z0-9_-]{1,100}$/u),deploymentId:z.string().min(1).max(200),
 visibilityTimeoutSeconds:z.number().int().min(30).max(3600),handlerDeadlineMs:z.number().int().min(1000).max(3_600_000),
 emptyPollMs:z.number().int().min(100).max(60_000),errorPollMs:z.number().int().min(100).max(60_000),concurrency:z.number().int().min(1).max(32)});
export type SharedQueueConfiguration=z.infer<typeof sharedQueueConfigurationSchema>;
export interface SharedQueueReceiverPort {receive<T=unknown>(topic:string,group:string,handler:MessageHandler<T>,options?:ReceiveOptions):Promise<ReceiveResult>;}
export interface SharedQueuePort extends SharedQueueReceiverPort,SharedQueuePublisherPort {}
const unavailable=()=>Error("shared_strategy_queue_unavailable");
class SharedDeliveryPending extends Error {}
/** Production always uses the installed SDK/OIDC path. An explicit port is a
 * test seam, not a second HTTP consumer, plain-JSON endpoint or credential fallback. */
export function createSharedStrategyQueue(configuration:SharedQueueConfiguration):SharedQueuePort {
 const config=sharedQueueConfigurationSchema.parse(configuration);
 return new PollingQueueClient({region:config.region,deploymentId:config.deploymentId,telemetry:{isEnabled:false}});
}
export async function receiveSharedStrategyOnce(options:{configuration:SharedQueueConfiguration;queue:SharedQueueReceiverPort;
 deliver(message:unknown,signal:AbortSignal):Promise<SharedDeliveryResult>},signal:AbortSignal):Promise<ReceiveResult> {
 signal.throwIfAborted();const config=sharedQueueConfigurationSchema.parse(options.configuration);
 return options.queue.receive(config.topic,config.consumerGroup,async message=>{
  // A receive begun before shutdown may deliver afterward. Never dispatch then.
  signal.throwIfAborted();const lifetime=new AbortController(),abort=()=>lifetime.abort();
  signal.addEventListener("abort",abort,{once:true});
  const timer=setTimeout(abort,config.handlerDeadlineMs);
  try{
   const result=await options.deliver(message,lifetime.signal);
   if(signal.aborted||lifetime.signal.aborted||result.disposition!=="ack")throw new SharedDeliveryPending("Shared delivery needs durable recheck");
  }finally{clearTimeout(timer);signal.removeEventListener("abort",abort);lifetime.abort();}
 },{limit:1,visibilityTimeoutSeconds:config.visibilityTimeoutSeconds,
  // Normal callback completion ACKs in the SDK. Unknown/retry is therefore an
  // exception with a visibility directive, never a successful result object.
  retry:(_error,metadata)=>({afterSeconds:Math.min(300,60*Math.max(1,metadata.deliveryCount))})});
}
function pause(milliseconds:number,signal:AbortSignal){
 if(signal.aborted)return Promise.resolve();
 return new Promise<void>(resolve=>{const done=()=>{clearTimeout(timer);signal.removeEventListener("abort",done);resolve();};
  const timer=setTimeout(done,milliseconds);signal.addEventListener("abort",done,{once:true});});
}
/** Each receiver awaits its complete SDK lifecycle, including ACK/visibility
 * cleanup, before receiving again. A timeout never releases local capacity while
 * the old receive/handler is still running. Stop drains these promises honestly. */
export async function runSharedStrategyQueue(options:{configuration:SharedQueueConfiguration;queue:SharedQueueReceiverPort;
 deliver(message:unknown,signal:AbortSignal):Promise<SharedDeliveryResult>;
 available?():boolean},signal:AbortSignal):Promise<void> {
 const config=sharedQueueConfigurationSchema.parse(options.configuration);
 const receive=async()=>{while(!signal.aborted){
  if(options.available&&!options.available()){await pause(config.emptyPollMs,signal);continue;}
  try{const result=await receiveSharedStrategyOnce({...options,configuration:config},signal);if(!result.ok)await pause(config.emptyPollMs,signal);}
  catch{if(!signal.aborted)await pause(config.errorPollMs,signal);}
 }};
 if(config.concurrency<1)throw unavailable();
 await Promise.all(Array.from({length:config.concurrency},receive));
}
