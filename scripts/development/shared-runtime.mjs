import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { copyFile, cp, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { readSharedRuntimeFilePins, readSharedRuntimePackages } from "../../services/shared-worker/package-runtime.mjs";
import { DevelopmentError, privateDirectory, settingsFor, writeState, localDockerEnvironment } from "./config.mjs";

const execute=promisify(execFile);
const digest=value=>createHash("sha256").update(value).digest("hex");
async function command(binary,args,options={}){
 try{return (await execute(binary,args,{timeout:600_000,maxBuffer:8*1024*1024,windowsHide:true,...options})).stdout.trim();}
 catch{throw new DevelopmentError(`Development worker ${binary==='docker'?'Docker operation':'build'} failed. Command output is withheld because it can include private configuration.`);}
}
async function dockerEnvironment(){
 let endpoint=process.env.DOCKER_CONTEXT?null:process.env.DOCKER_HOST;
 if(!endpoint){const context=process.env.DOCKER_CONTEXT||await command("docker",["context","show"]);endpoint=JSON.parse(await command("docker",["context","inspect",context,"--format","{{json .Endpoints.docker.Host}}"])) ;}
 return localDockerEnvironment(endpoint);
}
async function context(root){
 const settings=await settingsFor(root),directory=path.join(root,".embel-dev/shared"),env=await dockerEnvironment();
 return{settings,directory,env,docker:(args,options={})=>command("docker",args,{env,...options}),name:`embel-shared-${settings.projectId}`,volume:`embel-shared-${settings.projectId}-queue`};
}
/** Host-independent install: exact verified Linux package archives, never host
 * node_modules or host native builds. Only the output package enters Docker. */
export async function prepareSharedRuntime(root){
 const ctx=await context(root);await privateDirectory(ctx.directory);
 await command(process.execPath,["scripts/build-shared-worker.mjs"],{cwd:root});
 const manifest=JSON.parse(await readFile(path.join(root,".tmp/shared-worker/build-manifest.json"),"utf8"));
 const cache=path.join(ctx.directory,"runtime-package"),pins=await readSharedRuntimeFilePins(root);
 let valid=true;
 for(const [relative,hash]of Object.entries(pins)){try{const file=path.join(cache,relative);if(!(await lstat(file)).isFile()||digest(await readFile(file))!==hash){valid=false;break;}}catch{valid=false;break;}}
 if(!valid){await rm(cache,{recursive:true,force:true});await mkdir(cache,{recursive:true});await command(process.execPath,["--input-type=module","-e",'import { installSharedRuntimePackages } from "./services/shared-worker/package-runtime.mjs"; await installSharedRuntimePackages(process.cwd(), process.argv[1]);',cache],{cwd:root,env:{...process.env,NODE_USE_ENV_PROXY:"1"}});}
 const build=await mkdtemp(path.join(ctx.directory,"image-"));
 try{
  await cp(path.join(cache,"node_modules"),path.join(build,"node_modules"),{recursive:true});
  await mkdir(path.join(build,"dist"));
  for(const file of ["index.js","raster.js","text.js","render.js","package.json","build-manifest.json"]){await copyFile(path.join(root,".tmp/shared-worker",file),path.join(build,"dist",file));}
  await writeFile(path.join(build,"dist/runtime-manifest.json"),JSON.stringify({version:1,platform:"linux",arch:"x64",libc:"glibc",packages:await readSharedRuntimePackages(root),files:pins})+"\n");
  await copyFile(path.join(root,"worker/development/shared-container.mjs"),path.join(build,"development.mjs"));
  await writeFile(path.join(build,"Dockerfile"),`FROM node:22.22.2-bookworm-slim\nWORKDIR /opt/embel/shared\nCOPY --chown=node:node node_modules ./node_modules\nCOPY --chown=node:node dist ./dist\nCOPY --chown=node:node development.mjs ./development.mjs\nRUN mkdir -p /var/lib/embel/queue && chown -R node:node /var/lib/embel\nCMD ["node", "dist/index.js"]\n`);
  const wrapperHash=digest(await readFile(path.join(build,"development.mjs"))).slice(0,12);
  const image=`embel-development/shared:${manifest.artifactSha256.slice(0,24)}-${wrapperHash}`;
  await ctx.docker(["build","--platform","linux/amd64","--tag",image,build]);
  const artifact=JSON.parse(await ctx.docker(["run","--rm","--platform","linux/amd64","--network","none",image,"node","dist/index.js","--describe"]));
  if(artifact.artifactSha256!==manifest.artifactSha256||artifact.runtime?.node!=="22.22.2"||artifact.runtime?.platform!=="linux"||artifact.runtime?.arch!=="x64")throw new DevelopmentError("Packaged development runtime attestation failed.");
  const native=JSON.parse(await ctx.docker(["run","--rm","--platform","linux/amd64","--network","none",image,"node","dist/index.js","--native-smoke"]));
  await writeState(path.join(ctx.directory,"artifact.json"),JSON.stringify(artifact,null,2)+"\n");
  await writeState(path.join(ctx.directory,"runtime.json"),JSON.stringify({version:1,image,artifactSha256:artifact.artifactSha256,native},null,2)+"\n");
  return{artifact,native,image};
 }finally{await rm(build,{recursive:true,force:true});}
}
async function runtimeArguments(ctx,mode){
 const runtime=JSON.parse(await readFile(path.join(ctx.directory,"runtime.json"),"utf8"));
 if(runtime.version!==1||!/^embel-development\/shared:[a-f0-9]{24}-[a-f0-9]{12}$/.test(runtime.image??""))throw new DevelopmentError("Run the development worker build first.");
 for(const name of ["configuration.json","secrets.json"]){const info=await lstat(path.join(ctx.directory,name));if(!info.isFile()||info.isSymbolicLink())throw new DevelopmentError("Development worker configuration must be a private regular file.");}
 const network=ctx.settings.projectId+"-loopback";
 const args=["--platform","linux/amd64","--network",network,"--init","--mount",`type=bind,source=${path.join(ctx.directory,"configuration.json")},target=/run/embel/configuration.json,readonly`,"--mount",`type=bind,source=${path.join(ctx.directory,"secrets.json")},target=/run/embel/secrets.json,readonly`,"--mount",`type=volume,source=${ctx.volume},target=/var/lib/embel/queue`];
 for(const key of ["HTTP_PROXY","HTTPS_PROXY","ALL_PROXY","http_proxy","https_proxy","all_proxy"]){if(ctx.env[key])args.push("--env",key);}
 args.push("--env","NO_PROXY=127.0.0.1,localhost","--env","no_proxy=127.0.0.1,localhost","--env","NODE_USE_ENV_PROXY=1");
 if(ctx.env.NODE_EXTRA_CA_CERTS){await lstat(ctx.env.NODE_EXTRA_CA_CERTS);args.push("--mount",`type=bind,source=${ctx.env.NODE_EXTRA_CA_CERTS},target=/run/embel-ca.pem,readonly`,"--env","NODE_EXTRA_CA_CERTS=/run/embel-ca.pem");}
 return[...args,runtime.image,"node","development.mjs",ctx.settings.projectId,mode];
}
export async function preflightSharedRuntime(root){const ctx=await context(root);return JSON.parse(await ctx.docker(["run","--rm",...await runtimeArguments(ctx,"preflight")]));}
/** Merge fixed, timestamped events from both Docker streams. Process state
 * must independently be running; these events alone never prove liveness. */
export function sharedRuntimeReadyLanes(stdout,stderr){
 const ready=new Map();
 const lines=(stdout+"\n"+stderr).split("\n").filter(Boolean).sort();
 for(const line of lines){try{
  if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z /.test(line))continue;
  const event=JSON.parse(line.slice(line.indexOf(" ")+1));
  if(!["strategy","naming","logo"].includes(event.lane))continue;
  if(event.event==="development_shared_worker_lane_ready")ready.set(event.lane,true);
  // Outbox polling retries do not withdraw an already qualified slot. Every
  // other controller diagnostic precedes/follows actual withdrawal.
  if(event.event==="shared_worker_pool_diagnostic"&&event.code!=="strategy_poll_failed")ready.set(event.lane,false);
 }catch{/* Native/Node diagnostics cannot grant readiness. */}}
 return[...ready].filter(([,value])=>value).map(([lane])=>lane).sort();
}
export async function sharedRuntimeStatus(root){
 const ctx=await context(root);
 const names=(await ctx.docker(["ps","--all","--filter",`name=^/${ctx.name}$`,"--format","{{.Names}}"])) .split("\n");
 if(!names.includes(ctx.name))return{exists:false,running:false,ready:false,readyLanes:[]};
 const state=JSON.parse(await ctx.docker(["inspect",ctx.name,"--format","{{json .State}}"]));
 let readyLanes=[];
 if(state.Running===true){
  let logs;try{logs=await execute("docker",["logs","--timestamps",ctx.name],{env:ctx.env,maxBuffer:8*1024*1024,timeout:10000,windowsHide:true});}catch{throw new DevelopmentError("Development worker readiness could not be read.");}
  readyLanes=sharedRuntimeReadyLanes(logs.stdout,logs.stderr);
 }
 return{exists:true,running:state.Running===true,exitCode:state.ExitCode,ready:state.Running===true&&readyLanes.length===3,readyLanes};
}
export async function stopSharedRuntime(root){
 const ctx=await context(root),status=await sharedRuntimeStatus(root);
 if(status.running)await ctx.docker(["stop","--time","120",ctx.name]);
 return{stopped:true,queueRetained:true};
}
export async function startSharedRuntime(root){
 const ctx=await context(root),status=await sharedRuntimeStatus(root);
 if(status.running)return{started:false,alreadyRunning:true,...status};
 if(status.exists)await ctx.docker(["rm",ctx.name]);
 await ctx.docker(["run","--detach","--name",ctx.name,...await runtimeArguments(ctx,"run")]);
 let state;
 for(let attempt=0;attempt<120;attempt++){state=await sharedRuntimeStatus(root);if(state.ready||!state.running)break;await new Promise(resolve=>setTimeout(resolve,250));}
 return{started:true,container:ctx.name,queueRetained:true,...state};
}
