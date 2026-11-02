import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { MessageMetadata, MessageHandler, ReceiveOptions, ReceiveResult } from "@vercel/queue";
import type { SharedQueueConfiguration, SharedQueuePort } from "./queue";

const record = z.strictObject({ id:z.uuid(), key:z.string(), payload:z.unknown(), created:z.number(), expires:z.number(), visible:z.number(), attempts:z.number().int().nonnegative(), acknowledged:z.boolean() });
const stateSchema = z.array(record);
type Record = z.infer<typeof record>;
const unavailable = () => Error("shared_development_queue_unavailable");
/** A real, durable single-worker development broker. The SQL publication
 * receipt refers to this journal's persisted ID. Restart retains ACKs,
 * idempotency and visibility; hosted targets never construct this transport.
 * The launcher owns one named container/volume per checkout. */
export function createDevelopmentStrategyQueue(configuration:SharedQueueConfiguration, directory:string):SharedQueuePort {
 if(!path.isAbsolute(directory))throw unavailable();
 const file=path.join(directory,"strategy-queue.json"), active=new Set<string>();
 let serial:Promise<unknown>=Promise.resolve();
 const transact=<T>(operation:(records:Record[])=>T|Promise<T>):Promise<T>=>{
  const run=serial.then(async()=>{
   await mkdir(directory,{recursive:true,mode:0o700});
   let records:Record[]=[];
   try{records=stateSchema.parse(JSON.parse(await readFile(file,"utf8")));}catch(error){if(!(error instanceof Error&&"code" in error&&error.code==="ENOENT"))throw unavailable();}
   records=records.filter(item=>item.expires>Date.now()||active.has(item.id));
   const result=await operation(records),temporary=file+"."+randomUUID();
   const handle=await open(temporary,"wx",0o600);
   try{await handle.writeFile(JSON.stringify(records));await handle.sync();}finally{await handle.close();}
   await rename(temporary,file);
   const parent=await open(directory,"r");try{await parent.sync();}finally{await parent.close();}
   return result;
  });serial=run.catch(()=>{});return run;
 };
 return {
  async send(topic,payload,options){
   if(topic!==configuration.topic||!options?.idempotencyKey)throw unavailable();
   const encoded=JSON.stringify(payload);if(!encoded||encoded.length>1_000_000)throw unavailable();
   const key=createHash("sha256").update(options.idempotencyKey).digest("hex");
   return transact(records=>{
    const previous=records.find(item=>item.key===key);
    if(previous){if(JSON.stringify(previous.payload)!==encoded)throw unavailable();return{messageId:previous.id};}
    const now=Date.now(),entry:Record={id:randomUUID(),key,payload,created:now,expires:now+(options.retentionSeconds??86400)*1000,visible:now,attempts:0,acknowledged:false};
    records.push(entry);return{messageId:entry.id};
   });
  },
  async receive<T>(topic:string,group:string,handler:MessageHandler<T>,options?:ReceiveOptions):Promise<ReceiveResult>{
   if(topic!==configuration.topic||group!==configuration.consumerGroup)throw unavailable();
   const entry=await transact(records=>{
    const next=records.find(item=>!item.acknowledged&&!active.has(item.id)&&item.visible<=Date.now());
    if(!next)return null;next.attempts++;next.visible=Date.now()+(options?.visibilityTimeoutSeconds??configuration.visibilityTimeoutSeconds)*1000;
    active.add(next.id);return{...next};
   });
   if(!entry)return{ok:false,reason:"empty"};
   const metadata:MessageMetadata={messageId:entry.id,deliveryCount:entry.attempts,createdAt:new Date(entry.created),expiresAt:new Date(entry.expires),topicName:topic,consumerGroup:group,region:"local"};
   try{
    await handler(entry.payload as T,metadata);
    await transact(records=>{const actual=records.find(item=>item.id===entry.id);if(!actual)throw unavailable();actual.acknowledged=true;});
   }catch(error){
    const directive=options?.retry?.(error,metadata);
    await transact(records=>{const actual=records.find(item=>item.id===entry.id);if(!actual)throw unavailable();
     // Only the engine's normal completion ACKs. Retry callbacks cannot turn
     // an uncertain provider execution into a successful local delivery.
     actual.visible=Date.now()+(directive&&"afterSeconds" in directive?Math.max(1,directive.afterSeconds):60)*1000;
    });
    throw error;
   }finally{active.delete(entry.id);}
   return{ok:true};
  }
 };
}
