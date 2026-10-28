import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { approvedWorkerProfileSchema } from "./configuration";
import type { OwnerWorkerProcessDescriptor } from "./adapter";
import type { OwnerWorkerArtifactAttestation,OwnerWorkerReadyNotice } from "./process-contracts";
import { runOwnerNamingRuntime,type OwnerNamingRuntimeSecrets } from "./naming-runtime";
import { startOwnerStrategyRuntime,type OwnerStrategyRuntimeSecrets } from "./strategy-runtime";
import { runOwnerLogoRuntime,type OwnerLogoRuntimeSecrets } from "./logo-runtime";

const metadataSchema=z.strictObject({version:z.literal(1),sourceRevision:z.string().regex(/^[a-f0-9]{40}$/u),sourceClean:z.boolean(),bundleSha256:z.string().regex(/^[a-f0-9]{64}$/u),rasterSha256:z.string().regex(/^[a-f0-9]{64}$/u),artifactSha256:z.string().regex(/^[a-f0-9]{64}$/u)});
async function metadata(){
 const bytes=await readFile(fileURLToPath(import.meta.url)),manifest=metadataSchema.parse(JSON.parse(await readFile(new URL("./build-manifest.json",import.meta.url),"utf8")));
 if(createHash("sha256").update(bytes).digest("hex")!==manifest.bundleSha256||createHash("sha256").update(await readFile(new URL("./raster.js",import.meta.url))).digest("hex")!==manifest.rasterSha256||createHash("sha256").update(JSON.stringify({indexSha256:manifest.bundleSha256,rasterSha256:manifest.rasterSha256})).digest("hex")!==manifest.artifactSha256)throw Error("worker_artifact_unavailable");return manifest;
}
const lifetime=new AbortController();
process.on("SIGTERM",()=>lifetime.abort());process.on("SIGINT",()=>lifetime.abort());process.on("disconnect",()=>lifetime.abort());
const send=(value:object)=>{if(process.connected)process.send?.(value);};
async function main(){
 const manifest=await metadata();
 if(process.argv.length===3&&process.argv[2]==="--describe"){process.stdout.write(JSON.stringify({...manifest,runtime:{node:process.versions.node,icu:process.versions.icu,unicode:process.versions.unicode,platform:process.platform,arch:process.arch}})+"\n");return;}
 if(process.argv.length!==2||!process.connected)throw Error("worker_controller_unavailable");
 send({type:"hello",artifactSha256:manifest.artifactSha256});
 const initial=await new Promise<unknown>((resolve,reject)=>{const timer=setTimeout(()=>reject(Error("worker_configuration_unavailable")),15_000);
  process.once("message",message=>{clearTimeout(timer);resolve(message);});});
 if(!initial||typeof initial!=="object"||!("type" in initial)||initial.type!=="start"||!("descriptor" in initial)||!("secrets" in initial))throw Error("worker_configuration_unavailable");
 const descriptor=initial.descriptor as OwnerWorkerProcessDescriptor,profile=approvedWorkerProfileSchema.parse(descriptor.profile);
 const attestation:OwnerWorkerArtifactAttestation={sourceRevision:manifest.sourceRevision,sourceClean:manifest.sourceClean,artifactSha256:manifest.artifactSha256,
  deploymentId:process.env.VERCEL_DEPLOYMENT_ID??"",runtime:{node:process.versions.node,icu:process.versions.icu!,unicode:process.versions.unicode!,platform:process.platform as "linux",arch:process.arch as "x64"}};
 const secrets={...(initial.secrets as Record<string,unknown>),attestation};
 const onReady=(notice:OwnerWorkerReadyNotice)=>{send({type:"ready",notice});};
 if(profile.capability==="naming")await runOwnerNamingRuntime({descriptor,secrets:secrets as OwnerNamingRuntimeSecrets,signal:lifetime.signal,onReady});
 else if(profile.capability==="logo")await runOwnerLogoRuntime({descriptor,secrets:secrets as OwnerLogoRuntimeSecrets,signal:lifetime.signal,onReady});
 else{
  const runtime=await startOwnerStrategyRuntime({descriptor,secrets:secrets as OwnerStrategyRuntimeSecrets,signal:lifetime.signal,onReady});
  let active=false;const delivery=(message:unknown)=>{
   if(!message||typeof message!=="object"||!("type" in message)||message.type!=="deliver"||!("id" in message)||!("message" in message)||typeof message.id!=="string"||!z.uuid().safeParse(message.id).success)return;
   const id=message.id;if(active||lifetime.signal.aborted){send({type:"delivery",id,result:{disposition:"retry",state:"busy"}});return;}
   active=true;void runtime.deliver(message.message).then(result=>send({type:"delivery",id,result}),()=>send({type:"delivery",id,result:{disposition:"retry",state:"runtime_unavailable"}})).finally(()=>{active=false;});
  };
  process.on("message",delivery);try{if(!lifetime.signal.aborted)await new Promise<void>(resolve=>lifetime.signal.addEventListener("abort",()=>resolve(),{once:true}));}
  finally{process.removeListener("message",delivery);await runtime.close();}
 }
 send({type:"drained"});process.disconnect?.();
}
void main().catch(()=>{send({type:"unavailable"});process.exitCode=2;process.disconnect?.();});
