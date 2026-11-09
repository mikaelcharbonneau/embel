import { build } from "esbuild";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir,readFile,writeFile,realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { readSharedRuntimePackages, readSharedRuntimeFilePins } from "../services/shared-worker/package-runtime.mjs";
if(process.argv.length!==2)throw Error("Shared worker build takes no arguments");
const root=fileURLToPath(new URL("../",import.meta.url)),output=path.join(root,".tmp/shared-worker"),entry=path.join(output,"index.js");
const sourceRevision=execFileSync("git",["rev-parse","HEAD"],{cwd:root,encoding:"utf8"}).trim();
const sourceClean=execFileSync("git",["status","--porcelain","--untracked-files=normal"],{cwd:root,encoding:"utf8"}).trim()==="";
if(!/^[a-f0-9]{40}$/u.test(sourceRevision)||process.env.VERCEL==="1"&&!sourceClean)throw Error("Shared worker source is unqualified");
const authority=JSON.parse(await readFile(path.join(root,"worker/shared-pool/authority-manifest.json"),"utf8"));
const authorityPaths=["identity_transactions.sql","shared_worker_pool.sql","shared_account_http.sql","shared_worker_strategy.sql","shared_worker_naming.sql","shared_worker_logo.sql","shared_storage_authority.sql","shared_logo_http.sql","shared_logo_advanced.sql","shared_identity_generation.sql","shared_naming_brainstorm.sql","shared_naming_brainstorm_event_capacity.sql","shared_logo_raster_uncapped.sql","shared_logo_raster_recovery.sql","shared_identity_selected_logo_boards.sql","shared_naming_brainstorm_delivery_recovery.sql","shared_naming_lease_expiry.sql","shared_guided_journey_stages.sql","shared_naming_brainstorm_continuation.sql","shared_naming_generation.sql","shared_naming_cleanup.sql","shared_logo_types_keep_concepts.sql"].map(name=>"supabase/candidates/"+name);
if(authority.version!==1||!Array.isArray(authority.packets)||JSON.stringify(authority.packets.map(packet=>packet.path))!==JSON.stringify(authorityPaths)||!Array.isArray(authority.functions)||!authority.functions.length
 ||authority.functions.some(fn=>typeof fn.broadExecute!=="boolean"))throw Error("Shared worker authority source manifest invalid");
for(const packet of authority.packets){
 if(!/^supabase\/candidates\/[a-z0-9_]+\.sql$/u.test(packet.path)||createHash("sha256").update(await readFile(path.join(root,packet.path))).digest("hex")!==packet.sha256)
  throw Error("Shared worker SQL differs from reviewed authority manifest");
}
const runtimePackages=await readSharedRuntimePackages(root),runtimeFiles=await readSharedRuntimeFilePins(root);
const runtimePinsSha256=createHash("sha256").update(JSON.stringify({packages:runtimePackages,files:runtimeFiles})).digest("hex");
// The Queue SDK catches a missing optional telemetry peer. Keep that optional
// import external so a parent checkout's installations can't alter the artifact.
const nativeExternal=["pg-native","@opentelemetry/api",...runtimePackages.map(pin=>pin.name)];
const childDefines={__EMBEL_LOGO_RASTER_ENTRYPOINT__:JSON.stringify("dist/raster.js"),__EMBEL_LOGO_RASTER_CHILD__:"false",__EMBEL_LOGO_TEXT_ENTRYPOINT__:JSON.stringify("dist/text.js"),__EMBEL_LOGO_TEXT_CHILD__:"false",__EMBEL_LOGO_RENDER_ENTRYPOINT__:JSON.stringify("dist/render.js")};
const banner={js:'import { createRequire as __embelCreateRequire } from "node:module"; const require = __embelCreateRequire(import.meta.url);'};
const result=await build({absWorkingDir:root,entryPoints:["worker/shared-pool/entry.ts"],outfile:entry,bundle:true,platform:"node",format:"esm",target:"node22.22",conditions:["react-server"],
 external:nativeExternal,sourcemap:false,metafile:true,legalComments:"none",write:false,banner,
 define:childDefines});
const raster=await build({absWorkingDir:root,entryPoints:["worker/logo-vector/process.ts"],outfile:path.join(output,"raster.js"),bundle:true,platform:"node",format:"esm",target:"node22.22",conditions:["react-server"],external:nativeExternal,metafile:true,write:false,legalComments:"none",banner,
 define:{...childDefines,__EMBEL_LOGO_RASTER_CHILD__:"true"}});
const text=await build({absWorkingDir:root,entryPoints:["worker/logo-vector/text-process.ts"],outfile:path.join(output,"text.js"),bundle:true,platform:"node",format:"esm",target:"node22.22",conditions:["react-server"],external:nativeExternal,metafile:true,write:false,legalComments:"none",banner,
 define:{...childDefines,__EMBEL_LOGO_TEXT_CHILD__:"true"}});
const render=await build({absWorkingDir:root,entryPoints:["src/features/identity-deliverables/server/render-process.mjs"],outfile:path.join(output,"render.js"),bundle:true,platform:"node",format:"esm",target:"node22.22",external:nativeExternal,metafile:true,write:false,legalComments:"none",banner});
const dependencies=await realpath(path.join(root,"node_modules")),inputs=[...new Set([result,raster,text,render].flatMap(output=>Object.keys(output.metafile.inputs)))].sort();
if(inputs.some(source=>/(^|\/)(\.env[^/]*|\.local-fluid|\.vercel|\.secrets|\.credentials)(\/|$)/u.test(source)||/^(src\/app\/|worker\/account-enrollment\/|worker\/development\/|worker\/index\.ts|scripts\/local-)/u.test(source)))throw Error("Shared worker protected source rejected");
const firstParty=inputs.filter(source=>{const relative=path.relative(dependencies,path.resolve(root,source));return relative===".."||relative.startsWith(`..${path.sep}`)||path.isAbsolute(relative);});
await mkdir(output,{recursive:true});
await writeFile(path.join(output,"review-source-inputs.json"),JSON.stringify(firstParty,null,2)+"\n");
const approved=JSON.parse(await readFile(path.join(root,"worker/shared-pool/source-inputs.json"),"utf8"));
if(!Array.isArray(approved)||JSON.stringify(approved)!==JSON.stringify(firstParty))throw Error("Shared worker source graph differs from reviewed allowlist");
const bundle=result.outputFiles.find(file=>file.path===entry);if(!bundle||result.outputFiles.length!==1)throw Error("Shared worker output invalid");
const rasterBytes=raster.outputFiles[0].contents,textBytes=text.outputFiles[0].contents,renderBytes=render.outputFiles[0].contents,hash=value=>createHash("sha256").update(value).digest("hex");
const indexSha256=hash(bundle.contents),rasterSha256=hash(rasterBytes),textSha256=hash(textBytes),renderSha256=hash(renderBytes);
const hashes={indexSha256,rasterSha256,textSha256,renderSha256,runtimePinsSha256},artifactSha256=hash(JSON.stringify(hashes));
await writeFile(entry,bundle.contents);await writeFile(path.join(output,"raster.js"),rasterBytes);await writeFile(path.join(output,"text.js"),textBytes);await writeFile(path.join(output,"render.js"),renderBytes);
await writeFile(path.join(output,"package.json"),JSON.stringify({private:true,type:"module",engines:{node:"22.22.2"},dependencies:Object.fromEntries(runtimePackages.map(pin=>[pin.name,pin.version]))})+"\n");
await writeFile(path.join(output,"build-manifest.json"),JSON.stringify({version:2,sourceRevision,sourceClean,...hashes,artifactSha256})+"\n");
console.log("Shared three-lane worker artifact prepared in .tmp/shared-worker; disabled until explicitly configured. No runtime or deployment activated.");
