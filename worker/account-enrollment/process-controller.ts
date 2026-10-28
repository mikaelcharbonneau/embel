import "server-only";
import { fork,type ChildProcess } from "node:child_process";
import { createHash,randomUUID } from "node:crypto";
import { lstat,readFile,realpath } from "node:fs/promises";
import { isAbsolute,join,resolve } from "node:path";
import { z } from "zod";
import type { EnrollmentContext,EnrollmentCredentialReservation,EnrollmentPublication,EnrollmentRevocationProof } from "../../src/server/account-enrollment/contracts";
import type { ApprovedWorkerProfile } from "./configuration";
import { approvedWorkerProfileSchema,workerProfileFingerprint } from "./configuration";
import type { OwnerWorkerBinding,OwnerWorkerProcessController,OwnerWorkerProcessDescriptor,OwnerWorkerRuntimeProof } from "./adapter";
import { ownerWorkerBindingSchema } from "./adapter";
import { apiTextDispatchMessageSchema } from "../../src/domain/api-text-dispatch";
import type { ApiTextDeliveryResult } from "../api-text-runtime";
import { createPreparedWorkerDescriptorPublisher } from "./prepared-publication";
import { createOwnerWorkerVaultReader } from "./secret-store";
import type { OwnerWorkerReadyNotice } from "./process-contracts";
import type { OwnerWorkerDatabaseSecret } from "./process-contracts";
import { createOwnerWorkerProcessReporter } from "./process-reporter";

const unavailable=()=>Error("Owner worker process controller is unavailable");
const manifestSchema=z.strictObject({version:z.literal(1),sourceRevision:z.string().regex(/^[a-f0-9]{40}$/u),sourceClean:z.literal(true),bundleSha256:z.string().regex(/^[a-f0-9]{64}$/u),rasterSha256:z.string().regex(/^[a-f0-9]{64}$/u),artifactSha256:z.string().regex(/^[a-f0-9]{64}$/u)});
const readySchema=z.strictObject({workerId:z.string(),roleOid:z.number().int().positive(),observedAt:z.iso.datetime({offset:true}),storageSessionId:z.uuid().nullable()});
type Handle={child:ChildProcess;descriptor:OwnerWorkerProcessDescriptor;ready:OwnerWorkerReadyNotice|null;drained:boolean;exit:Promise<void>;publication:EnrollmentPublication};
export type ConfiguredOwnerWorkerProcessController=OwnerWorkerProcessController&{
 maintain(context:EnrollmentContext,signal?:AbortSignal):Promise<OwnerWorkerRuntimeProof>;
 suspend(context:EnrollmentContext,signal?:AbortSignal):Promise<void>;
 hasObservedRuntime(context:EnrollmentContext):boolean;
 deliver(context:EnrollmentContext,message:unknown,signal?:AbortSignal):Promise<ApiTextDeliveryResult>;
 deliverAdmittedStrategy(message:unknown,signal?:AbortSignal):Promise<ApiTextDeliveryResult>;close():Promise<void>};
/** Preserve the configured network trust path without inheriting app/provider,
 * database, agent, driver-option or Node-injection credentials/options. */
export function ownerWorkerChildEnvironment(source:NodeJS.ProcessEnv=process.env):NodeJS.ProcessEnv{
 const env:NodeJS.ProcessEnv={NODE_ENV:"production",TZ:"UTC",LANG:"C.UTF-8"};
 for(const name of["VERCEL","VERCEL_ENV","VERCEL_PROJECT_ID","VERCEL_DEPLOYMENT_ID","HTTPS_PROXY","HTTP_PROXY","ALL_PROXY","NO_PROXY",
  "https_proxy","http_proxy","all_proxy","no_proxy","NODE_EXTRA_CA_CERTS","SSL_CERT_FILE"] as const)if(source[name]!==undefined)env[name]=source[name];
 if(source.NODE_USE_ENV_PROXY==="1"||["HTTPS_PROXY","HTTP_PROXY","ALL_PROXY","https_proxy","http_proxy","all_proxy"].some(name=>Boolean(source[name])))env.NODE_USE_ENV_PROXY="1";
 return env;
}
/** Concrete same-host dedicated child controller. Its optional Vault KV-v2
 * backend must be explicitly selected/configured; installing this source does
 * not create a vault, credentials, operator authority, model access or launcher.
 * Children receive secrets through IPC only and derive their own artifact hash.
 * Missing SQL worker installer/proof functions fail before publication. */
export function createOwnerWorkerProcessController(configuration:{artifactDirectory:string;publicationDirectory:string;vault:unknown;
 reporter:{database:OwnerWorkerDatabaseSecret;roleName:string;roleOid:number;trustedCreatorRoleOid:number}}):ConfiguredOwnerWorkerProcessController{
 const folder=configuration.artifactDirectory;
 if(!isAbsolute(folder)||resolve(folder)!==folder)throw unavailable();
 const publisher=createPreparedWorkerDescriptorPublisher(configuration.publicationDirectory),secrets=createOwnerWorkerVaultReader(configuration.vault),handles=new Map<string,Handle>();
 const reporter=createOwnerWorkerProcessReporter(configuration.reporter);
 const key=(context:EnrollmentContext)=>`${context.claim.ownerId}:${context.step.capability}`;
 const same=(context:EnrollmentContext,handle:Handle)=>handle.descriptor.binding.ownerId===context.claim.ownerId&&handle.descriptor.binding.generation===context.claim.generation
  &&handle.descriptor.binding.revision===context.claim.revision&&handle.descriptor.binding.operationKey===context.step.operationKey;
 async function artifact(profile:ApprovedWorkerProfile){
  const path=join(folder,"index.js"),manifestPath=join(folder,"build-manifest.json");
  if(await realpath(folder)!==folder)throw unavailable();
  for(const file of[path,manifestPath,join(folder,"raster.js")]){const info=await lstat(file);if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.uid!==process.getuid?.()||(info.mode&0o022)!==0)throw unavailable();}
  const manifest=manifestSchema.parse(JSON.parse(await readFile(manifestPath,"utf8"))),bytes=await readFile(path);
  if(bytes.length>32_000_000||manifest.bundleSha256!==createHash("sha256").update(bytes).digest("hex")||manifest.artifactSha256!==profile.artifactSha256||manifest.rasterSha256!==createHash("sha256").update(await readFile(join(folder,"raster.js"))).digest("hex")||manifest.artifactSha256!==createHash("sha256").update(JSON.stringify({indexSha256:manifest.bundleSha256,rasterSha256:manifest.rasterSha256})).digest("hex")||manifest.sourceRevision!==profile.sourceRevision)throw unavailable();return{path,manifest};
 }
 const exited=(handle:Handle)=>handle.child.exitCode!==null||handle.child.signalCode!==null;
 async function stop(handle:Handle){
  if(exited(handle)){if(!handle.drained)throw unavailable();return;}
  handle.child.kill("SIGTERM");let timer:ReturnType<typeof setTimeout>|undefined;
  try{await Promise.race([handle.exit,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(unavailable()),35_000);})]);}
  finally{clearTimeout(timer);}
  if(!handle.drained||handle.child.exitCode!==0)throw unavailable();
 }
 async function deliver(handle:Handle,message:unknown,signal?:AbortSignal):Promise<ApiTextDeliveryResult>{
  if(handle.descriptor.profile.capability!=="strategy"||!handle.ready||handle.child.exitCode!==null)throw unavailable();
  signal?.throwIfAborted();const id=randomUUID();return new Promise((resolve,reject)=>{
   const finish=(error?:Error,value?:unknown)=>{clearTimeout(timer);handle.child.removeListener("message",receive);signal?.removeEventListener("abort",abort);
    if(error){reject(error);return;}const parsed=z.strictObject({disposition:z.enum(["ack","retry"]),state:z.string().min(1).max(100).regex(/^[a-z_]+$/u)}).safeParse(value);if(!parsed.success)reject(unavailable());else resolve(parsed.data);};
   const receive=(raw:unknown)=>{if(raw&&typeof raw==="object"&&"type" in raw&&raw.type==="delivery"&&"id" in raw&&raw.id===id&&"result" in raw)finish(undefined,raw.result);};
   const abort=()=>finish(unavailable()),timer=setTimeout(abort,275_000);signal?.addEventListener("abort",abort,{once:true});handle.child.on("message",receive);handle.child.send({type:"deliver",id,message},error=>{if(error)finish(unavailable());});
  });
 }
 const controller:ConfiguredOwnerWorkerProcessController={
  hasObservedRuntime(context){return handles.has(key(context));},
  async suspend(context,signal){
   await context.store.operator.query("SELECT public.suspend_account_worker_enrollment($1,$2,$3,$4) value",[context.claim.id,context.claim.leaseToken,context.step.capability,"verification_unavailable"]);
   const handle=handles.get(key(context));if(!handle||!same(context,handle))throw unavailable();
   if(!exited(handle))try{await stop(handle);}catch{if(!exited(handle))throw unavailable();}
   signal?.throwIfAborted();if(!exited(handle))throw unavailable();
   const observedAt=new Date().toISOString(),receipt=`owner-worker-exit:${createHash("sha256").update(JSON.stringify({binding:handle.descriptor.binding,observedAt,exitCode:handle.child.exitCode,signal:handle.child.signalCode})).digest("hex")}`;
   await reporter.report(handle.descriptor.binding,"stopped",receipt,observedAt,signal);
  },
  async maintain(context,signal){
   signal?.throwIfAborted();
   const read=async()=>{
    const response=await context.store.operator.query("SELECT public.read_account_worker_enrollment($1,$2,$3) value",[context.claim.id,context.claim.leaseToken,context.step.capability]);
    const schema=z.strictObject({descriptor:z.strictObject({version:z.literal(1),binding:ownerWorkerBindingSchema,profile:approvedWorkerProfileSchema}),heartbeat:readySchema.nullable(),restartAllowed:z.boolean()});
    if(response.rows.length!==1)throw unavailable();const value=schema.parse((response.rows[0] as{value:unknown}).value),b=value.descriptor.binding;
    if(b.ownerId!==context.claim.ownerId||b.generation!==context.claim.generation||b.revision!==context.claim.revision||b.operationKey!==context.step.operationKey||b.capability!==context.step.capability)throw unavailable();return value;
   };
   let current=await read();const handle=handles.get(key(context));
   // An unknown old process is never declared stopped from a stale heartbeat.
   if(!handle||!same(context,handle)||JSON.stringify(handle.descriptor)!==JSON.stringify(current.descriptor))throw unavailable();
   await artifact(current.descriptor.profile);
   const heartbeat=current.heartbeat;
   let alive=!exited(handle)&&handle.child.connected&&Boolean(handle.child.pid);
   if(alive)try{process.kill(handle.child.pid!,0);}catch{alive=false;}
   const fresh=heartbeat&&heartbeat.workerId===handle.descriptor.binding.workerId&&heartbeat.roleOid===handle.descriptor.binding.roleOid
    &&heartbeat.storageSessionId===handle.ready?.storageSessionId&&Date.now()-Date.parse(heartbeat.observedAt)<=45_000&&Date.parse(heartbeat.observedAt)<=Date.now();
   if(!alive||!fresh){
    await controller.suspend(context,signal);
    // OS exit is known; SQL must additionally prove no live job/leadership lease
    // before the exact same binding can resume. This is not a fabricated drain.
    current=await read();
    if(!current.restartAllowed)throw unavailable();
    const resumed=await context.store.operator.query("SELECT public.resume_account_worker_enrollment($1,$2,$3) value",[context.claim.id,context.claim.leaseToken,context.step.capability]);
    if(resumed.rows.length!==1)throw unavailable();
    const descriptor=z.strictObject({version:z.literal(1),binding:ownerWorkerBindingSchema,profile:approvedWorkerProfileSchema}).parse((resumed.rows[0] as{value:unknown}).value);
    if(JSON.stringify(descriptor)!==JSON.stringify(current.descriptor))throw unavailable();
    handles.delete(key(context));const publication=await controller.publish(context,descriptor,signal);return controller.inspect(context,descriptor,publication,signal);
   }
   if(!heartbeat)throw unavailable();
   // A fresh independent SQL heartbeat plus actual connected/live child justifies
   // a new reporter observation; a saved startup timestamp alone never does.
   handle.ready={...heartbeat,observedAt:new Date().toISOString()};
   return controller.inspect(context,current.descriptor,handle.publication,signal);
  },
  async prepare(context:EnrollmentContext,profile:ApprovedWorkerProfile,reservation:EnrollmentCredentialReservation,signal?:AbortSignal):Promise<OwnerWorkerBinding>{
   signal?.throwIfAborted();await artifact(profile);
   const previous=handles.get(key(context));if(previous&&!same(context,previous)){await stop(previous);handles.delete(key(context));}
   // Lease-derived SQL owns credential reservation, manager creation, fixed
   // grants and exact approved policy/hosted binding installation atomically.
   const result=await context.store.operator.query("SELECT public.provision_account_worker_enrollment($1,$2,$3,$4::jsonb,$5,$6) value",
    [context.claim.id,context.claim.leaseToken,context.step.capability,JSON.stringify(profile),reservation.reference,reservation.verifier]);
   signal?.throwIfAborted();if(result.rows.length!==1)throw unavailable();return(result.rows[0] as{value:OwnerWorkerBinding}).value;
  },
  async publish(context,descriptor,signal){
   signal?.throwIfAborted();const existing=handles.get(key(context));
   if(existing){if(!same(context,existing)||existing.child.exitCode!==null||JSON.stringify(existing.descriptor)!==JSON.stringify(descriptor))throw unavailable();await publisher.verify(context,existing.publication,signal);return existing.publication;}
   const qualified=await artifact(descriptor.profile),secret=await secrets.read(descriptor,signal),publication=await publisher.publish(context,descriptor,signal);signal?.throwIfAborted();
   // Copy only actual deployment metadata. No fake Vercel identity or ambient
   // DB/provider/agent credentials, NODE_OPTIONS, PGOPTIONS or native-PG switch.
   const env=ownerWorkerChildEnvironment();
   const child=fork(qualified.path,[],{cwd:folder,execArgv:[],env,stdio:["ignore","ignore","ignore","ipc"],serialization:"json"});
   let resolveExit!:()=>void;const exit=new Promise<void>(resolve=>{resolveExit=resolve;});
   const handle:Handle={child,descriptor,ready:null,drained:false,exit,publication};handles.set(key(context),handle);
   child.on("exit",()=>resolveExit());child.on("error",()=>{resolveExit();});
   child.on("message",message=>{
    if(!message||typeof message!=="object"||!("type" in message))return;
    if(message.type==="hello"&&"artifactSha256" in message&&message.artifactSha256===qualified.manifest.artifactSha256){child.send({type:"start",descriptor,secrets:secret},()=>{});}
    if(message.type==="ready"&&"notice" in message){const parsed=readySchema.safeParse(message.notice);if(parsed.success&&parsed.data.workerId===descriptor.binding.workerId&&parsed.data.roleOid===descriptor.binding.roleOid)handle.ready=parsed.data;}
    if(message.type==="drained")handle.drained=true;
   });
   return publication;
  },
  async inspect(context,descriptor,publication,signal):Promise<OwnerWorkerRuntimeProof>{
   await publisher.verify(context,publication,signal);const handle=handles.get(key(context));if(!handle||!same(context,handle))throw unavailable();
   const deadline=Date.now()+45_000;
   while(!handle.ready&&handle.child.exitCode===null&&Date.now()<deadline){signal?.throwIfAborted();await new Promise(resolve=>setTimeout(resolve,25));}
   const notice=handle.ready;if(!notice||handle.child.exitCode!==null||Date.now()-Date.parse(notice.observedAt)>30_000||Date.parse(notice.observedAt)>Date.now())throw unavailable();
   const b=descriptor.binding,p=descriptor.profile;
   const receipt=`owner-worker:${createHash("sha256").update(JSON.stringify({publication,notice})).digest("hex")}`;
   await reporter.report(b,"running",receipt,notice.observedAt,signal);
   return{ownerId:b.ownerId,generation:b.generation,revision:b.revision,operationKey:b.operationKey,capability:b.capability,
    receipt,observedAt:notice.observedAt,
    profileFingerprint:workerProfileFingerprint(p),roleOid:b.roleOid,workerId:b.workerId,sourceRevision:p.sourceRevision,artifactSha256:p.artifactSha256,storageSessionId:notice.storageSessionId};
  },
  async revoke(context,signal):Promise<EnrollmentRevocationProof>{
   const handle=handles.get(key(context));
   if(!handle){
    const result=await context.store.operator.query("SELECT public.verify_account_worker_revocation($1,$2,$3) value",[context.claim.id,context.claim.leaseToken,context.step.capability]);
    if(result.rows.length!==1)throw unavailable();const proof=(result.rows[0] as{value:EnrollmentRevocationProof}).value;
    if(!proof||!("scope" in proof)||proof.scope!=="never_provisioned"||!("authorityAbsent" in proof)||proof.authorityAbsent!==true||"runtimeStopped" in proof)throw unavailable();return proof;
   }
   if(handle.descriptor.binding.ownerId!==context.claim.ownerId||handle.descriptor.binding.capability!==context.step.capability
    ||handle.descriptor.binding.generation>context.claim.generation||handle.descriptor.binding.revision>context.claim.revision)throw unavailable();await stop(handle);signal?.throwIfAborted();
   const observedAt=new Date().toISOString(),receipt=`owner-worker-stop:${createHash("sha256").update(JSON.stringify({binding:handle.descriptor.binding,observedAt})).digest("hex")}`;
   await reporter.report(handle.descriptor.binding,"stopped",receipt,observedAt,signal);
   const result=await context.store.operator.query("SELECT public.verify_account_worker_revocation($1,$2,$3) value",[context.claim.id,context.claim.leaseToken,context.step.capability]);
   if(result.rows.length!==1)throw unavailable();const proof=(result.rows[0] as{value:EnrollmentRevocationProof}).value;
   if(proof.authorityDisabled!==true||proof.storageDenied!==true||!("runtimeStopped" in proof)||proof.runtimeStopped!==true)throw unavailable();handles.delete(key(context));return proof;
  },
  async deliver(context,message,signal){
   const handle=handles.get(key(context));if(!handle||!same(context,handle))throw unavailable();return deliver(handle,apiTextDispatchMessageSchema.parse(message),signal);
  },
  async deliverAdmittedStrategy(raw,signal){
   const message=apiTextDispatchMessageSchema.parse(raw),route=await reporter.strategyRoute(message,signal);if(route===null)return{disposition:"ack",state:"not_found"};
   const binding=ownerWorkerBindingSchema.parse(route);if(binding.capability!=="strategy")throw unavailable();
   const handle=handles.get(`${binding.ownerId}:strategy`);
   if(!handle||JSON.stringify(handle.descriptor.binding)!==JSON.stringify(binding))throw unavailable();return deliver(handle,message,signal);
  },
  async close(){const results=await Promise.allSettled([...handles.values()].map(stop));await reporter.close();if(results.some(r=>r.status==="rejected"))throw unavailable();handles.clear();},
 };return controller;
}
