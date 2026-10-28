import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { createEnrollmentVaultClient } from "./vault-client";
import { createConfiguredAccountEnrollmentService,type ConfiguredAccountEnrollmentServiceInput } from "./service";
import { readApprovedWorkerProfiles } from "./configuration";

const lifetime=new AbortController();
const log=(event:"account_service_disabled"|"account_service_started"|"account_service_unavailable"|"account_service_drain_unconfirmed")=>{
 const line=JSON.stringify({event});if(event.includes("unavailable")||event.includes("unconfirmed"))process.stderr.write(line+"\n");else process.stdout.write(line+"\n");
};
process.on("SIGTERM",()=>lifetime.abort());process.on("SIGINT",()=>lifetime.abort());
process.on("unhandledRejection",()=>{log("account_service_unavailable");process.exitCode=2;lifetime.abort();});
process.on("uncaughtException",()=>{log("account_service_unavailable");process.exitCode=2;lifetime.abort();});
const metadataSchema=z.strictObject({version:z.literal(1),sourceRevision:z.string().regex(/^[a-f0-9]{40}$/u),sourceClean:z.boolean(),controllerSha256:z.string().regex(/^[a-f0-9]{64}$/u)});
async function metadata(){
 const bytes=await readFile(fileURLToPath(import.meta.url)),manifest=metadataSchema.parse(JSON.parse(await readFile(new URL("./controller-manifest.json",import.meta.url),"utf8")));
 if(createHash("sha256").update(bytes).digest("hex")!==manifest.controllerSha256)throw Error("controller_artifact_unavailable");return manifest;
}
async function main(){
 const manifest=await metadata();
 if(process.argv.length===3&&process.argv[2]==="--describe"){
  process.stdout.write(JSON.stringify({...manifest,runtime:{node:process.versions.node,icu:process.versions.icu,unicode:process.versions.unicode,platform:process.platform,arch:process.arch}})+"\n");return;
 }
 if(process.argv.length!==2)throw Error("controller_arguments_unavailable");
 if(process.env.EMBEL_ACCOUNT_SERVICE_ENABLED!=="true"){log("account_service_disabled");return;}
 if(!manifest.sourceClean||process.env.VERCEL!=="1"||process.env.VERCEL_ENV!=="production")throw Error("controller_source_unqualified");
 // These explicit service-only names must be supplied by an approved secret
 // injection mechanism. No agent/provider/database credential discovery occurs.
 const vault=createEnrollmentVaultClient({origin:process.env.EMBEL_ACCOUNT_BOOTSTRAP_VAULT_ORIGIN,mount:process.env.EMBEL_ACCOUNT_BOOTSTRAP_VAULT_MOUNT,token:process.env.EMBEL_ACCOUNT_BOOTSTRAP_VAULT_TOKEN});
 const reference=z.string().min(1).max(199).parse(process.env.EMBEL_ACCOUNT_SERVICE_CONFIGURATION_REF),stored=await vault.read(reference,lifetime.signal);
 const supplied=z.strictObject({version:z.literal(1),service:z.unknown()}).parse(stored?.data).service as ConfiguredAccountEnrollmentServiceInput;
 const profiles=readApprovedWorkerProfiles(supplied.approvedProfiles);
 if([...profiles.values()].some(profile=>profile.sourceRevision!==manifest.sourceRevision||profile.projectId!==process.env.VERCEL_PROJECT_ID||profile.deploymentId!==process.env.VERCEL_DEPLOYMENT_ID))throw Error("controller_profile_unqualified");
 const origin=z.url().refine(raw=>{const url=new URL(raw);return url.protocol==="https:"&&url.origin===raw&&!url.username&&!url.password;}).parse(process.env.EMBEL_ACCOUNT_SERVICE_ORIGIN);
 const port=z.coerce.number().int().min(1).max(65535).parse(process.env.PORT);
 const service=createConfiguredAccountEnrollmentService(supplied),consumer=service.createStrategyQueueConsumer();
 const server=createServer({maxHeaderSize:16_384},(request,response)=>{
  void(async()=>{
   if(request.method!=="POST"||request.url?.split("?")[0]!=="/api/account-strategy-consume"){response.writeHead(404,{"cache-control":"no-store"});response.end();return;}
   const chunks:Buffer[]=[];let size=0;
   for await(const chunk of request){const bytes=Buffer.from(chunk);size+=bytes.length;if(size>65_536){response.writeHead(413,{"cache-control":"no-store"});response.end();request.destroy();return;}chunks.push(bytes);}
   const headers=new Headers();for(const[key,value]of Object.entries(request.headers))if(value!==undefined)headers.set(key,Array.isArray(value)?value.join(","):value);
   const result=await consumer.fetch(new Request(`${origin}${request.url}`,{method:"POST",headers,body:Buffer.concat(chunks)}));
   const output=new Uint8Array(await result.arrayBuffer());if(output.length>65_536)throw Error("queue_response_unavailable");
   response.writeHead(result.status,Object.fromEntries(result.headers));response.end(output);
  })().catch(()=>{if(!response.headersSent)response.writeHead(503,{"cache-control":"no-store"});response.end();});
 });
 server.maxHeadersCount=50;server.requestTimeout=15_000;server.headersTimeout=10_000;
 try{
  await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.listen(port,"0.0.0.0",()=>{server.removeListener("error",reject);resolve();});});
  log("account_service_started");await service.run(lifetime.signal);
 }finally{
  lifetime.abort();
  const closed=new Promise<void>(resolve=>server.close(()=>resolve()));
  try{await service.close();await closed;}catch{log("account_service_drain_unconfirmed");process.exitCode=2;}
 }
}
void main().catch(()=>{log("account_service_unavailable");process.exitCode=2;lifetime.abort();});
