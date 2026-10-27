import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { readSharedPoolConfiguration,sharedPoolConfigurationSchema,type SharedPoolConfiguration,type SharedPoolSlot } from "./configuration";
const noSpace=z.string().min(16).max(8192).refine(value=>!/\s/u.test(value));
const providerFields={bindingRef:z.string().min(1).max(200),model:z.string().min(1).max(150),modelVerificationReceipt:z.string().min(1).max(200)};
const provider=z.strictObject({...providerFields,apiKey:noSpace});
const providerInput=z.union([provider,z.strictObject({...providerFields,apiKeyEnvironment:z.literal("OPENAI_API_KEY")})]);
const storage=z.strictObject({authUserId:z.uuid(),publishableKey:z.string().min(20).max(4096).refine(value=>!/\s/u.test(value)),email:z.email().max(254),password:noSpace});
const slotSecret=z.strictObject({databaseUrl:z.string().min(1).max(8192),caPem:z.string().min(80).max(65_536).optional(),storage:storage.optional()});
const schema=z.strictObject({version:z.literal(1),slots:z.record(z.string(),slotSecret),providers:z.strictObject({strategy:provider,naming:provider,logo:provider,logoText:provider.optional()})});
const inputSchema=schema.extend({providers:z.strictObject({strategy:providerInput,naming:providerInput,logo:providerInput,logoText:providerInput.optional()})});
export type SharedPoolSecrets=z.infer<typeof schema>;
export type SharedSlotSecret=z.infer<typeof slotSecret>;
const unavailable=()=>Error("shared_pool_secrets_unavailable");
/** Finite credentials from the selected project's sensitive setting. There is
 * no dynamic owner secret, password creation, CAS backend or agent-key fallback. */
export function readSharedPoolSecrets(config:SharedPoolConfiguration,env:Readonly<Record<string,string|undefined>>=process.env):SharedPoolSecrets {
 try{
  if(env.EMBEL_SHARED_WORKER_POOL_ENABLED!=="true")throw unavailable();
  const input=inputSchema.parse(JSON.parse(env.EMBEL_SHARED_WORKER_POOL_SECRETS??""));
  let productionQualified=false;
  function resolve(supplied:z.infer<typeof providerInput>):z.infer<typeof provider>{
   if("apiKey" in supplied)return supplied;
   // Only an explicit reference in the existing production app process can
   // read this variable. Local/cloud-agent and staging environments never do.
   if(!productionQualified){
    const qualified=readSharedPoolConfiguration(env);
    if(env.NODE_ENV!=="production"||qualified?.target.kind!=="vercel"||qualified.target.purpose!=="production"
     ||JSON.stringify(qualified)!==JSON.stringify(sharedPoolConfigurationSchema.parse(config)))throw unavailable();
    productionQualified=true;
   }
   const apiKey=noSpace.parse(env.OPENAI_API_KEY);
   const resolved={bindingRef:supplied.bindingRef,model:supplied.model,modelVerificationReceipt:supplied.modelVerificationReceipt,apiKey:""};
   Object.defineProperty(resolved,"apiKey",{value:apiKey,enumerable:false,writable:false,configurable:false});
   return resolved;
  }
  const parsed=input;
  const ids=config.slots.map(s=>s.slotId);
  if(Object.keys(parsed.slots).length!==ids.length||Object.keys(parsed.slots).some(id=>!ids.includes(id)))throw unavailable();
  const storageActors=new Set<string>();
  for(const slot of config.slots){
   const secret=parsed.slots[slot.slotId];if(!secret)throw unavailable();assertSharedSlotSecret(config,slot,secret);
   const supplied=parsed.providers[slot.lane];
   if(supplied.bindingRef!==slot.providerBindingRef||supplied.model!==slot.model||supplied.modelVerificationReceipt!==slot.modelVerificationReceipt)throw unavailable();
   if(slot.lane==="logo"){
    if(!secret.storage||storageActors.has(secret.storage.authUserId))throw unavailable();storageActors.add(secret.storage.authUserId);
    if(slot.textProvider){
     const suppliedText=parsed.providers.logoText;
     if(!suppliedText||suppliedText.bindingRef!==slot.textProvider.providerBindingRef||suppliedText.model!==slot.textProvider.model
      ||suppliedText.modelVerificationReceipt!==slot.textProvider.modelVerificationReceipt)throw unavailable();
    }else if(parsed.providers.logoText)throw unavailable();
   }else if(secret.storage)throw unavailable();
  }
  return {version:parsed.version,slots:parsed.slots,
   providers:{strategy:resolve(parsed.providers.strategy),naming:resolve(parsed.providers.naming),logo:resolve(parsed.providers.logo),
    ...(parsed.providers.logoText?{logoText:resolve(parsed.providers.logoText)}:{})}};
 }catch{throw unavailable();}
}
export function assertSharedSlotSecret(config:SharedPoolConfiguration,slot:SharedPoolSlot,secret:SharedSlotSecret){
 try{
  const parsed=slotSecret.parse(secret),url=new URL(parsed.databaseUrl),target=config.target;
  if(!["postgres:","postgresql:"].includes(url.protocol)||url.hostname!==target.databaseHost||url.port!==String(target.databasePort)||url.pathname!=="/postgres"||url.hash
   ||!url.password||/[\s\x00-\x1f\x7f]/u.test(parsed.databaseUrl))throw unavailable();
  const user=decodeURIComponent(url.username),expected=target.kind==="vercel"&&target.databaseHost.endsWith(".pooler.supabase.com")?`${slot.roleName}.${target.projectRef}`:slot.roleName;
  if(user!==expected)throw unavailable();
  if(target.kind==="vercel"){
   if(!parsed.caPem||createHash("sha256").update(parsed.caPem).digest("hex")!==target.caSha256||[...url.searchParams].length!==1||url.searchParams.get("sslmode")!=="verify-full")throw unavailable();
  }else if(parsed.caPem||[...url.searchParams].some(([k,v])=>k!=="sslmode"||v!=="disable")||[...url.searchParams].length>1)throw unavailable();
 }catch{throw unavailable();}
}
