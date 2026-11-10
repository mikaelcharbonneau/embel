import "server-only";
import { z } from "zod";
import { sharedLaneSchema } from "./contracts";
import { sharedQueueConfigurationSchema } from "./queue";
import { SHARED_CORE_RPC_PROOFS,SHARED_LANE_RPC_PROOFS,SHARED_STRATEGY_OUTBOX_PROOF,equalSharedRpcProof } from "./proofs";

const hash=z.string().regex(/^[a-f0-9]{64}$/u),reference=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u);
const canonicalHttps=z.url().refine(raw=>{const u=new URL(raw);return u.protocol==="https:"&&u.origin===raw&&!u.username&&!u.password;});
const localOrigin=z.string().max(60).regex(/^http:\/\/127\.0\.0\.1:[1-9][0-9]{3,4}$/u).refine(raw=>{const u=new URL(raw);return u.origin===raw&&Number(u.port)>=1024&&Number(u.port)<=65535;});
export const sharedPoolRuntimeSchema=z.strictObject({node:z.string().regex(/^\d+\.\d+\.\d+$/u),icu:z.string().min(1).max(20),unicode:z.string().min(1).max(20),platform:z.literal("linux"),arch:z.literal("x64")});
const artifact=z.strictObject({sourceRevision:z.string().regex(/^[a-f0-9]{40}$/u),artifactSha256:hash,runtime:sharedPoolRuntimeSchema});
const developmentTarget=z.strictObject({kind:z.literal("development"),applicationOrigin:localOrigin,supabaseOrigin:localOrigin,databaseHost:z.literal("127.0.0.1"),databasePort:z.number().int().min(1024).max(65535),deploymentId:reference});
const vercelTarget=z.strictObject({kind:z.literal("vercel"),purpose:z.enum(["staging","production"]),applicationOrigin:canonicalHttps,supabaseOrigin:canonicalHttps,
 projectRef:z.string().regex(/^[a-z0-9]{20}$/u),projectId:z.string().regex(/^prj_[A-Za-z0-9]{10,100}$/u),deploymentId:z.string().regex(/^dpl_[A-Za-z0-9_-]{1,196}$/u),
 databaseHost:z.string().min(1).max(253),databasePort:z.literal(5432),caSha256:hash});
const functionProof=z.strictObject({sha256:hash,language:z.enum(["sql","plpgsql"]),volatility:z.enum(["s","v"])});
const textProviderBinding=z.strictObject({providerBindingRef:reference,model:z.string().min(1).max(150),modelVerificationReceipt:reference});
/** Production slot ceilings. Six Logo slots let one six-concept batch run at
 * once; Strategy and Naming keep their single fixed slot. */
export const PRODUCTION_SLOTS_PER_LANE={strategy:1,naming:1,logo:6} as const satisfies Record<z.infer<typeof sharedLaneSchema>,number>;
const logoOperations=new Set(["identity.logo_concept","identity.logo_refine","identity.logo_vectorize","identity.logo_directions","identity.logo_export","identity.logo_vector_propose","identity.image","identity.logo_style_note"]);
export const sharedPoolSlotSchema=z.strictObject({slotId:z.uuid(),lane:sharedLaneSchema,roleName:z.string().max(63).regex(/^embel_shared_(strategy|naming|logo)_[a-z0-9_]{1,30}$/u),
 roleOid:z.number().int().min(1).max(4_294_967_295),workerId:z.string().regex(/^[A-Za-z0-9._:-]{1,100}$/u),providerBindingRef:reference,
 model:z.string().min(1).max(150),modelVerificationReceipt:reference,
 policies:z.record(z.string().min(1).max(100),z.record(z.string(),z.unknown())).refine(p=>Object.keys(p).length>0&&Object.keys(p).length<=7),
 textProvider:textProviderBinding.optional(),
 gatewayProof:functionProof,outboxProof:functionProof.optional()});
export type SharedPoolSlot=z.infer<typeof sharedPoolSlotSchema>;
export const sharedPoolConfigurationSchema=z.strictObject({version:z.literal(1),target:z.discriminatedUnion("kind",[developmentTarget,vercelTarget]),artifact,
 coreProofs:z.strictObject({claim:functionProof,renew:functionProof,release:functionProof,fence:functionProof,pending:functionProof,capacity:functionProof}),
 capacity:z.strictObject({maxConcurrentExecutions:z.number().int().min(1).max(32),maxPerTenantPerLane:z.number().int().min(1).max(32),
  leaseSeconds:z.number().int().min(30).max(120),renewalMs:z.number().int().min(1000).max(30_000),idlePollMs:z.number().int().min(100).max(60_000),drainTimeoutMs:z.number().int().min(1000).max(600_000)}),
 queue:sharedQueueConfigurationSchema,slots:z.array(sharedPoolSlotSchema).min(3).max(32)}).superRefine((config,ctx)=>{
 const distinct=(key:"slotId"|"roleName"|"roleOid"|"workerId")=>new Set(config.slots.map(s=>s[key])).size===config.slots.length;
 if(!(["slotId","roleName","roleOid","workerId"] as const).every(distinct))ctx.addIssue({code:"custom",message:"Shared slots require distinct registered identities"});
 for(const lane of sharedLaneSchema.options)if(!config.slots.some(s=>s.lane===lane))ctx.addIssue({code:"custom",message:"All three actual worker lanes require fixed slots"});
 for(const slot of config.slots){
  if(!slot.roleName.startsWith(`embel_shared_${slot.lane}_`))ctx.addIssue({code:"custom",message:"Slot role and lane must match"});
  if((slot.lane==="strategy")!==(slot.outboxProof!==undefined))ctx.addIssue({code:"custom",message:"Only Strategy slots require an approved outbox RPC"});
  if(slot.lane!=="logo"&&(slot.textProvider!==undefined||Object.keys(slot.policies).length>(slot.lane==="strategy"?6:4)))ctx.addIssue({code:"custom",message:"Only the Logo/Identity lane supports a separate text provider; Strategy has at most six operation policies"});
  if(slot.lane==="logo"&&Object.keys(slot.policies).some(operation=>!logoOperations.has(operation)))ctx.addIssue({code:"custom",message:"Logo/Identity policies require an explicit supported operation"});
  if(slot.lane==="logo"&&!slot.textProvider&&["identity.image","identity.logo_directions","identity.logo_vector_propose","identity.logo_style_note"].some(operation=>Object.hasOwn(slot.policies,operation)))
   ctx.addIssue({code:"custom",message:"Identity specifications, directions and vector proposals require an explicitly verified text provider"});
 }
 if(config.capacity.maxConcurrentExecutions!==config.slots.length||config.capacity.maxPerTenantPerLane>config.capacity.maxConcurrentExecutions||config.capacity.renewalMs*3>=config.capacity.leaseSeconds*1000)
  ctx.addIssue({code:"custom",message:"Shared execution and renewal capacity must remain bounded"});
 if(config.queue.deploymentId!==config.target.deploymentId||config.queue.concurrency>config.slots.filter(s=>s.lane==="strategy").length)
  ctx.addIssue({code:"custom",message:"Queue routing/concurrency must match qualified Strategy slots"});
 if(config.target.kind==="development"){
  if(new Set([config.target.applicationOrigin,config.target.supabaseOrigin]).size!==2||[new URL(config.target.applicationOrigin).port,new URL(config.target.supabaseOrigin).port].includes(String(config.target.databasePort)))
   ctx.addIssue({code:"custom",message:"Local services require distinct loopback ports"});
 }else{
  if(config.target.supabaseOrigin!==`https://${config.target.projectRef}.supabase.co`||config.target.databaseHost!==`db.${config.target.projectRef}.supabase.co`&&!/^aws-[0-9]+-[a-z0-9-]+\.pooler\.supabase\.com$/u.test(config.target.databaseHost))
   ctx.addIssue({code:"custom",message:"Database and Supabase target must match"});
  const production=config.target.purpose==="production";
  if(production){
   if(config.target.projectRef!=="fricsfwqibyhemknqgyf"||config.target.applicationOrigin!=="https://www.embel.xyz"
    ||!["prj_waP1hoGVtBiqJCTqTWKHfRy8iLMk","prj_vTOc6Kf8th7tXK2cOVwWTTaR20yx"].includes(config.target.projectId)
    ||sharedLaneSchema.options.some(lane=>{const count=config.slots.filter(slot=>slot.lane===lane).length;return count<1||count>PRODUCTION_SLOTS_PER_LANE[lane];}))
    ctx.addIssue({code:"custom",message:"Production requires the exact existing target, one Strategy slot, one Naming slot and one to six Logo slots"});
  }else if(config.target.projectRef==="fricsfwqibyhemknqgyf"||["https://www.embel.xyz","https://embel.xyz"].includes(config.target.applicationOrigin))
   ctx.addIssue({code:"custom",message:"Staging cannot select production"});
 }
});
export type SharedPoolConfiguration=z.infer<typeof sharedPoolConfigurationSchema>;
const unavailable=()=>Error("shared_pool_configuration_unavailable");
/** Only explicit project-sensitive settings. Disabled does not parse secrets,
 * open a pool, import an engine or infer an existing account/hosting target. */
export function readSharedPoolConfiguration(env:Readonly<Record<string,string|undefined>>=process.env):SharedPoolConfiguration|null {
 if(env.EMBEL_SHARED_WORKER_POOL_ENABLED!=="true")return null;
 try{
  const raw:unknown=JSON.parse(env.EMBEL_SHARED_WORKER_POOL_CONFIGURATION??"");
  // An explicit platform selector removes the need to redeploy settings merely
  // to learn the deployment that receives them. It never writes platform env.
  if(raw&&typeof raw==="object"&&"target" in raw&&raw.target&&typeof raw.target==="object"&&"kind" in raw.target&&raw.target.kind==="vercel"
   &&"deploymentId" in raw.target&&raw.target.deploymentId==="platform"){
   if(!("queue" in raw)||!raw.queue||typeof raw.queue!=="object"||!("deploymentId" in raw.queue)||raw.queue.deploymentId!=="platform"
    ||!/^dpl_[A-Za-z0-9_-]{1,196}$/u.test(env.VERCEL_DEPLOYMENT_ID??""))throw unavailable();
   raw.target.deploymentId=env.VERCEL_DEPLOYMENT_ID;raw.queue.deploymentId=env.VERCEL_DEPLOYMENT_ID;
  }
  const config=sharedPoolConfigurationSchema.parse(raw);
  if((Object.keys(SHARED_CORE_RPC_PROOFS) as Array<keyof typeof SHARED_CORE_RPC_PROOFS>).some(key=>!equalSharedRpcProof(config.coreProofs[key],SHARED_CORE_RPC_PROOFS[key])))throw unavailable();
  if(config.slots.some(slot=>!equalSharedRpcProof(slot.gatewayProof,SHARED_LANE_RPC_PROOFS[slot.lane])||slot.outboxProof&&!equalSharedRpcProof(slot.outboxProof,SHARED_STRATEGY_OUTBOX_PROOF)))throw unavailable();
  if(config.target.kind==="development"){
   if(env.EMBEL_DEVELOPMENT_ENABLED!=="true"||!["development","test"].includes(env.NODE_ENV??"")||Object.keys(env).some(k=>(k==="VERCEL"||k.startsWith("VERCEL_"))&&env[k]!==undefined))throw unavailable();
  }else if(env.VERCEL!=="1"||env.VERCEL_ENV!=="production"||env.VERCEL_PROJECT_ID!==config.target.projectId||env.VERCEL_DEPLOYMENT_ID!==config.target.deploymentId)throw unavailable();
  return config;
 }catch{throw unavailable();}
}
export type SharedPoolAttestation=Readonly<{sourceRevision:string;sourceClean:boolean;artifactSha256:string;runtime:z.infer<typeof sharedPoolRuntimeSchema>}>;
export function assertSharedPoolAttestation(config:SharedPoolConfiguration,actual:SharedPoolAttestation){
 const runtime=sharedPoolRuntimeSchema.safeParse({node:process.versions.node,icu:process.versions.icu,unicode:process.versions.unicode,platform:process.platform,arch:process.arch});
 if(!runtime.success||actual.sourceRevision!==config.artifact.sourceRevision||actual.artifactSha256!==config.artifact.artifactSha256
  ||(config.target.kind==="vercel"&&!actual.sourceClean)||Object.entries(config.artifact.runtime).some(([key,value])=>Reflect.get(actual.runtime,key)!==value||Reflect.get(runtime.data,key)!==value))throw unavailable();
}
