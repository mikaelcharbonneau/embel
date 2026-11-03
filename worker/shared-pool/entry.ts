import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { sharedNativeBuildManifestSchema, inspectPackagedLogoNativeRuntime } from "./logo-native-qualification";
import { createSharedPoolRuntime } from "./runtime";
import type { SharedPoolAttestation } from "./configuration";
import { runSharedPoolLifecycle } from "./lifecycle";
import { preflightSharedPool } from "./preflight";
const hash=(value:Uint8Array|string)=>createHash("sha256").update(value).digest("hex");
async function artifact():Promise<SharedPoolAttestation>{
 const manifest=sharedNativeBuildManifestSchema.parse(JSON.parse(await readFile(new URL("./build-manifest.json",import.meta.url),"utf8")));
 const hashes={indexSha256:manifest.indexSha256,rasterSha256:manifest.rasterSha256,textSha256:manifest.textSha256,renderSha256:manifest.renderSha256,runtimePinsSha256:manifest.runtimePinsSha256};
 for(const [filename,expected]of[["index.js",manifest.indexSha256],["raster.js",manifest.rasterSha256],["text.js",manifest.textSha256],["render.js",manifest.renderSha256]]as const)
  if(hash(await readFile(new URL(filename,import.meta.url)))!==expected)throw Error("shared_pool_artifact_unavailable");
 if(hash(JSON.stringify(hashes))!==manifest.artifactSha256)throw Error("shared_pool_artifact_unavailable");
 return{sourceRevision:manifest.sourceRevision,sourceClean:manifest.sourceClean,artifactSha256:manifest.artifactSha256,
  runtime:{node:process.versions.node,icu:process.versions.icu!,unicode:process.versions.unicode!,platform:process.platform as "linux",arch:process.arch as "x64"}};
}
async function main(){
 if(process.argv.length!==2&&!(process.argv.length===3&&["--describe","--preflight","--native-smoke"].includes(process.argv[2]!)))throw Error("shared_pool_arguments_unavailable");
 if(process.argv[2]==="--native-smoke"){const signal=AbortSignal.timeout(20_000);process.stdout.write(JSON.stringify(await inspectPackagedLogoNativeRuntime(signal))+"\n");return;}
 if(process.argv[2]==="--describe"){process.stdout.write(JSON.stringify(await artifact())+"\n");return;}
 if(process.argv[2]==="--preflight"){process.stdout.write(JSON.stringify(await preflightSharedPool(process.env,await artifact()))+"\n");return;}
 if(process.env.EMBEL_SHARED_WORKER_POOL_ENABLED!=="true"){process.stdout.write('{"event":"shared_worker_pool_disabled"}\n');return;}
 const controller=createSharedPoolRuntime(process.env,await artifact());if(!controller)throw Error("shared_pool_configuration_unavailable");
 const lifetime=new AbortController();let fatal=false;const stop=()=>lifetime.abort();
 const fault=(kind:"unhandled_rejection"|"uncaught_exception",error:unknown)=>{
  if(!fatal){
   const code=error instanceof Error&&"code" in error?error.code:null;
   const reason=typeof code==="string"&&["ECONNRESET","EPIPE","ETIMEDOUT","ECONNREFUSED","ENETUNREACH","EHOSTUNREACH","57P01","57P02","57P03"].includes(code)?"connection_lost":"unclassified";
   process.stderr.write(JSON.stringify({event:"shared_worker_pool_process_fault",kind,reason})+"\n");
  }
  fatal=true;stop();
 };
 const rejected=(reason:unknown)=>fault("unhandled_rejection",reason),uncaught=(error:Error)=>fault("uncaught_exception",error);
 process.once("SIGTERM",stop);process.once("SIGINT",stop);process.on("unhandledRejection",rejected);process.on("uncaughtException",uncaught);
 process.stdout.write('{"event":"shared_worker_pool_starting"}\n');
 try{await runSharedPoolLifecycle(controller,lifetime.signal,{unconfirmed:()=>{process.stderr.write('{"event":"shared_worker_pool_drain_unconfirmed"}\n');},exit:code=>{process.exit(code);}});if(fatal)throw Error("shared_pool_process_failed");}
 finally{lifetime.abort();process.removeListener("SIGTERM",stop);process.removeListener("SIGINT",stop);process.removeListener("unhandledRejection",rejected);process.removeListener("uncaughtException",uncaught);}
}
void main().catch(()=>{process.stderr.write('{"event":"shared_worker_pool_unavailable_or_drain_unconfirmed"}\n');process.exit(2);});
