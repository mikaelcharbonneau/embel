import "server-only";
import { z } from "zod";
import { EnrollmentEffectUnavailable } from "../../src/server/account-enrollment/contracts";
const configurationSchema=z.strictObject({origin:z.url().refine(raw=>{const url=new URL(raw);return url.protocol==="https:"&&url.origin===raw&&!url.username&&!url.password;}),
 mount:z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/u),token:z.string().min(16).max(4096).regex(/^[\x21-\x7e]+$/u)});
const unavailable=(uncertain=false)=>new EnrollmentEffectUnavailable("store_unavailable",uncertain);
export type VaultKvValue={data:Record<string,unknown>;version:number};
/** Explicit optional Hashicorp Vault KV-v2 protocol adapter. Construction does
 * not select/create a backend or discover any ambient token. */
export function createEnrollmentVaultClient(raw:unknown){
 const parsed=configurationSchema.safeParse(raw);if(!parsed.success)throw unavailable();const config=parsed.data;
 function path(reference:string){if(!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u.test(reference)||reference.split("/").some(s=>!s||s==="."||s===".."))throw unavailable();return reference.split("/").map(encodeURIComponent).join("/");}
 async function request(section:"data"|"destroy",reference:string,method:"GET"|"POST",body:unknown,signal?:AbortSignal){
  const url=`${config.origin}/v1/${config.mount}/${section}/${path(reference)}`,deadline=AbortSignal.any([AbortSignal.timeout(10_000),...(signal?[signal]:[])]);
  let response:Response|undefined;
  try{
   response=await fetch(url,{method,redirect:"error",cache:"no-store",credentials:"omit",signal:deadline,
    headers:{"X-Vault-Token":config.token,accept:"application/json",...(method==="POST"?{"content-type":"application/json"}:{})},...(method==="POST"?{body:JSON.stringify(body)}:{})});
   if(response.redirected||response.url&&response.url!==url)throw unavailable(method==="POST");
   if(response.status===204)return{status:204,value:null};
   if(method==="GET"&&response.status===404)return{status:404,value:null};
   if(!response.body)throw unavailable(method==="POST");
   const reader=response.body.getReader(),parts:Uint8Array[]=[];let size=0;
   try{while(true){deadline.throwIfAborted();const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>131_072)throw unavailable(method==="POST");parts.push(part.value);}}
   finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
   const value=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(Buffer.concat(parts))) as unknown;return{status:response.status,value};
  }catch(error){if(error instanceof EnrollmentEffectUnavailable)throw error;throw unavailable(method==="POST");}
  finally{await response?.body?.cancel().catch(()=>{});}
 }
 return{
  async read(reference:string,signal?:AbortSignal):Promise<VaultKvValue|null>{
   const result=await request("data",reference,"GET",undefined,signal);if(result.status===404)return null;
   const value=z.object({data:z.object({data:z.record(z.string(),z.unknown()),metadata:z.object({version:z.number().int().positive(),destroyed:z.literal(false).optional(),deletion_time:z.literal("").optional()})})}).safeParse(result.value);
   if(result.status!==200||!value.success)throw unavailable();return{data:value.data.data.data,version:value.data.data.metadata.version};
  },
  async write(reference:string,version:number,data:Record<string,unknown>,signal?:AbortSignal):Promise<number|null>{
   if(!Number.isSafeInteger(version)||version<0||Buffer.byteLength(JSON.stringify(data))>120_000)throw unavailable();
   const result=await request("data",reference,"POST",{options:{cas:version},data},signal);
   const conflict=z.object({errors:z.tuple([z.literal("check-and-set parameter did not match the current version")])}).safeParse(result.value);
   if(result.status===400&&conflict.success)return null;
   const value=z.object({data:z.object({version:z.number().int().positive()})}).safeParse(result.value);
   if(result.status!==200||!value.success||value.data.data.version!==version+1)throw unavailable(true);return value.data.data.version;
  },
  async destroy(reference:string,versions:readonly number[],signal?:AbortSignal){
   if(!versions.length)return;if(versions.length>100||versions.some(v=>!Number.isSafeInteger(v)||v<1))throw unavailable();
   const result=await request("destroy",reference,"POST",{versions},signal);if(result.status!==204)throw unavailable(true);
  },
 };
}
