import "server-only";
import { z } from "zod";
import type { OwnerWorkerProcessDescriptor } from "./adapter";
import { workerProfileFingerprint } from "./configuration";

const unavailable=()=>Error("Owner worker secret store is unavailable");
const configurationSchema=z.strictObject({origin:z.url().refine(raw=>{const url=new URL(raw);return url.protocol==="https:"&&url.origin===raw&&!url.username&&!url.password;}),
 mount:z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/u),token:z.string().min(16).max(4096).regex(/^[\x21-\x7e]+$/u)});
const envelopeSchema=z.strictObject({version:z.literal(1),ownerId:z.uuid(),generation:z.number().int().positive(),revision:z.number().int().positive(),
 operationKey:z.uuid(),capability:z.enum(["strategy","naming","logo"]),providerBindingRef:z.string(),modelVerificationReceipt:z.string(),retired:z.literal(false).optional(),verifier:z.string().nullable().optional(),profileFingerprint:z.string().nullable().optional(),secrets:z.record(z.string(),z.unknown())});
/** Concrete explicitly configured Vault KV-v2 read adapter. It never discovers
 * ambient platform tokens, persists secrets or provisions Vault access. The
 * configured token needs READ only for the exact dedicated worker records. */
export function createOwnerWorkerVaultReader(configuration:unknown){
 const parsed=configurationSchema.safeParse(configuration);if(!parsed.success)throw unavailable();const config=parsed.data;
 return{async read(descriptor:OwnerWorkerProcessDescriptor,signal?:AbortSignal):Promise<Record<string,unknown>>{
  const b=descriptor.binding,p=descriptor.profile;
  if(!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u.test(b.credentialRef)||b.credentialRef.split("/").some(part=>part==="."||part===".."||!part))throw unavailable();
  const path=b.credentialRef.split("/").map(encodeURIComponent).join("/"),url=`${config.origin}/v1/${config.mount}/data/${path}`;
  const timeout=AbortSignal.any([AbortSignal.timeout(10_000),...(signal?[signal]:[])]);let response:Response|undefined;
  try{
   response=await fetch(url,{method:"GET",redirect:"error",cache:"no-store",credentials:"omit",signal:timeout,headers:{"X-Vault-Token":config.token,"accept":"application/json"}});
   if(response.status!==200||response.redirected||response.url&&response.url!==url||!response.body)throw unavailable();
   const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
   try{while(true){timeout.throwIfAborted();const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>131_072)throw unavailable();chunks.push(part.value);}}
   finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
   const decoded=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(Buffer.concat(chunks))),value=envelopeSchema.parse(decoded?.data?.data);
   if(value.ownerId!==b.ownerId||value.generation!==b.generation||value.revision!==b.revision||value.operationKey!==b.operationKey||value.capability!==b.capability
    ||(value.profileFingerprint!==undefined&&value.profileFingerprint!==workerProfileFingerprint(p))||value.providerBindingRef!==p.providerBindingRef||value.modelVerificationReceipt!==p.modelVerificationReceipt||"attestation" in value.secrets)throw unavailable();
   return value.secrets;
  }catch{throw unavailable();}finally{await response?.body?.cancel().catch(()=>{});}
 }};
}
