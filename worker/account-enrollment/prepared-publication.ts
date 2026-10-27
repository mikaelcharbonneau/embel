import "server-only";
import { createHash,randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat,mkdir,open,readdir,realpath,unlink,link } from "node:fs/promises";
import { isAbsolute,join,resolve } from "node:path";
import { z } from "zod";
import type { EnrollmentContext,EnrollmentPublication } from "../../src/server/account-enrollment/contracts";
import type { OwnerWorkerProcessDescriptor } from "./adapter";
import { approvedWorkerProfileSchema,ownerWorkerRole,workerProfileFingerprint } from "./configuration";

const unavailable=()=>Error("Prepared worker publication is unavailable");
const ceiling=32_768;
function digest(value:Uint8Array|string){return createHash("sha256").update(value).digest("hex");}
/** Concrete durable preparation, not a worker launcher or runtime-ready proof.
 * The configured supervisor must select the highest generation, independently
 * validate current SQL authority and resolve dedicated credentials itself. No
 * plaintext password, provider key, JWT or session is part of a descriptor. */
export function createPreparedWorkerDescriptorPublisher(directory:string) {
 if(!isAbsolute(directory)||resolve(directory)!==directory)throw unavailable();
 async function safeDirectory(path:string,create=false) {
  if(create)try{await mkdir(path,{mode:0o700});}catch(error){if(!(error&&typeof error==="object"&&"code" in error&&error.code==="EEXIST"))throw unavailable();}
  const info=await lstat(path);
  if(!info.isDirectory()||info.isSymbolicLink()||(info.mode&0o7777)!==0o700||info.uid!==process.getuid?.()||await realpath(path)!==path)throw unavailable();
 }
 async function location(context:EnrollmentContext) {
  await safeDirectory(directory);
  const owner=z.uuid().parse(context.claim.ownerId).toLowerCase();
  const capability=z.enum(["strategy","naming","logo"]).parse(context.step.capability);
  const ownerDirectory=join(directory,owner);await safeDirectory(ownerDirectory,true);
  const target=join(ownerDirectory,capability);await safeDirectory(target,true);
  return target;
 }
 const isNewer=(left:readonly number[],right:readonly number[])=>left[0]!>right[0]!||left[0]===right[0]&&left[1]!>right[1]!;
 async function latestGeneration(path:string) {
  const entries=await readdir(path);
  const generations=entries.filter(name=>/^[1-9][0-9]{0,9}-[1-9][0-9]{0,9}\.json$/u.test(name)).map(name=>name.slice(0,-5).split("-").map(Number));
  return generations.reduce((latest,value)=>isNewer(value,latest)?value:latest,[0,0]);
 }
 async function readExact(path:string) {
  const info=await lstat(path);
  if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||(info.mode&0o7777)!==0o600||info.uid!==process.getuid?.()||info.size>ceiling)throw unavailable();
  const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{const opened=await handle.stat();if(opened.dev!==info.dev||opened.ino!==info.ino||opened.size>ceiling||opened.nlink!==1)throw unavailable();
   const bytes=await handle.readFile();if(bytes.length>ceiling)throw unavailable();return bytes;
  }finally{await handle.close();}
 }
 return{
  async publish(context:EnrollmentContext,descriptor:OwnerWorkerProcessDescriptor,signal?:AbortSignal):Promise<EnrollmentPublication> {
   if(signal?.aborted||context.claim.mode!=="enroll")throw unavailable();
   const profile=approvedWorkerProfileSchema.parse(descriptor.profile),binding=descriptor.binding;
   if(descriptor.version!==1||binding.ownerId!==context.claim.ownerId||binding.generation!==context.claim.generation||binding.revision!==context.claim.revision||binding.operationKey!==context.step.operationKey
    ||binding.capability!==context.step.capability||profile.capability!==binding.capability||binding.roleName!==ownerWorkerRole(binding.capability,binding.ownerId)
    ||binding.profileFingerprint!==workerProfileFingerprint(profile))throw unavailable();
   // Reconstruct only the reviewed public fields; do not serialize a caller's
   // extra properties or a whole environment/credential object.
   const value={version:1,binding:{ownerId:binding.ownerId,generation:binding.generation,revision:binding.revision,operationKey:binding.operationKey,capability:binding.capability,
    roleName:binding.roleName,roleOid:binding.roleOid,credentialRef:binding.credentialRef,workerId:binding.workerId,deploymentId:binding.deploymentId,
    profileFingerprint:binding.profileFingerprint,storageAuthUserId:binding.storageAuthUserId},profile};
   const bytes=Buffer.from(JSON.stringify(value)+"\n");if(bytes.length>ceiling)throw unavailable();
   const folder=await location(context);if(isNewer(await latestGeneration(folder),[binding.generation,binding.revision])||signal?.aborted)throw unavailable();
   const target=join(folder,`${binding.generation}-${binding.revision}.json`),temporary=join(folder,`.prepared-${randomUUID()}`);
   const handle=await open(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
   try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}
   try{
    if(signal?.aborted)throw unavailable();
    try{await link(temporary,target);}catch(error){if(!(error&&typeof error==="object"&&"code" in error&&error.code==="EEXIST"))throw unavailable();}
   }finally{await unlink(temporary);}
   const stored=await readExact(target);if(!stored.equals(bytes)||isNewer(await latestGeneration(folder),[binding.generation,binding.revision])||signal?.aborted)throw unavailable();
   const directoryHandle=await open(folder,constants.O_RDONLY);try{await directoryHandle.sync();}finally{await directoryHandle.close();}
   return{ownerId:binding.ownerId,generation:binding.generation,revision:binding.revision,operationKey:binding.operationKey,capability:binding.capability,
    receipt:`prepared-worker:${digest(stored)}`};
  },
  async verify(context:EnrollmentContext,publication:EnrollmentPublication,signal?:AbortSignal) {
   if(signal?.aborted||publication.ownerId!==context.claim.ownerId||publication.generation!==context.claim.generation||publication.revision!==context.claim.revision
    ||publication.operationKey!==context.step.operationKey||publication.capability!==context.step.capability)throw unavailable();
   const folder=await location(context);if(JSON.stringify(await latestGeneration(folder))!==JSON.stringify([context.claim.generation,context.claim.revision]))throw unavailable();
   const stored=await readExact(join(folder,`${context.claim.generation}-${context.claim.revision}.json`));
   if(publication.receipt!==`prepared-worker:${digest(stored)}`||signal?.aborted)throw unavailable();
   return publication;
  },
 };
}
