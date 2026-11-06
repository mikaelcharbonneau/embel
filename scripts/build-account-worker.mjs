import { build } from "esbuild";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir,writeFile,readFile,realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

if(process.argv.length!==2)throw Error("Account worker build takes no arguments");
const root=fileURLToPath(new URL("../",import.meta.url));
const sourceRevision=execFileSync("git",["rev-parse","HEAD"],{cwd:root,encoding:"utf8"}).trim();
const sourceClean=execFileSync("git",["status","--porcelain","--untracked-files=normal"],{cwd:root,encoding:"utf8"}).trim()==="";
if(!/^[a-f0-9]{40}$/u.test(sourceRevision)||process.env.VERCEL==="1"&&!sourceClean)throw Error("Account worker build source unqualified");
const output=path.join(root,".tmp/account-worker"),entry=path.join(output,"index.js");
// SDKs catch these missing optional peers. Keep them external so a parent
// directory's installations (for example ~/node_modules) can't alter the artifact.
const optionalPeers=["@opentelemetry/api","ws"];
const result=await build({absWorkingDir:root,entryPoints:["worker/account-enrollment/entry.ts"],outfile:entry,bundle:true,platform:"node",format:"esm",
 target:"node22.22",conditions:["react-server"],external:["pg-native","sharp",...optionalPeers],sourcemap:false,metafile:true,legalComments:"none",write:false,
 define:{__EMBEL_LOGO_RASTER_ENTRYPOINT__:JSON.stringify("raster.js"),__EMBEL_LOGO_RASTER_CHILD__:"false"},
 banner:{js:'import { createRequire as __embelCreateRequire } from "node:module"; const require = __embelCreateRequire(import.meta.url);'}});
const inputs=Object.keys(result.metafile.inputs).sort();
if(inputs.some(source=>/(^|\/)(\.env[^/]*|\.local-fluid|\.vercel|\.secrets|\.credentials)(\/|$)/u.test(source)
 ||/^(src\/app\/|scripts\/local-|worker\/index\.ts|worker\/development\/)/u.test(source)))throw Error("Account worker protected build input rejected");
const dependencies=await realpath(path.join(root,"node_modules"));
const firstParty=inputs.filter(source=>{const relative=path.relative(dependencies,path.resolve(root,source));return relative===".."||relative.startsWith(`..${path.sep}`)||path.isAbsolute(relative);});
const approvedInputs=JSON.parse(await readFile(path.join(root,"worker/account-enrollment/source-inputs.json"),"utf8"));
if(!Array.isArray(approvedInputs)||JSON.stringify(approvedInputs)!==JSON.stringify(firstParty))throw Error("Account worker source graph differs from reviewed allowlist");
const bundle=result.outputFiles.find(file=>file.path===entry);if(!bundle||result.outputFiles.length!==1)throw Error("Account worker build output invalid");
const raster=await build({absWorkingDir:root,entryPoints:["worker/logo-vector/process.ts"],outfile:path.join(output,"raster.js"),bundle:true,platform:"node",format:"esm",target:"node22.22",conditions:["react-server"],external:["sharp",...optionalPeers],write:false,legalComments:"none",
 define:{__EMBEL_LOGO_RASTER_CHILD__:"true",__EMBEL_LOGO_RASTER_ENTRYPOINT__:JSON.stringify("raster.js")},
 banner:{js:'import { createRequire as __embelCreateRequire } from "node:module"; const require = __embelCreateRequire(import.meta.url);'}});
const rasterBytes=raster.outputFiles[0].contents,indexSha256=createHash("sha256").update(bundle.contents).digest("hex"),rasterSha256=createHash("sha256").update(rasterBytes).digest("hex");
const artifactSha256=createHash("sha256").update(JSON.stringify({indexSha256,rasterSha256})).digest("hex");
await mkdir(output,{recursive:true});await writeFile(entry,bundle.contents);await writeFile(path.join(output,"raster.js"),rasterBytes);
await writeFile(path.join(output,"package.json"),JSON.stringify({private:true,type:"module",engines:{node:"22.22.2"},dependencies:{sharp:"0.35.5"}})+"\n");
await writeFile(path.join(output,"build-manifest.json"),JSON.stringify({version:1,sourceRevision,sourceClean,bundleSha256:indexSha256,rasterSha256,artifactSha256})+"\n");
await writeFile(path.join(output,"source-inputs.json"),JSON.stringify(inputs,null,2)+"\n");
const controllerPath=path.join(output,"controller.js");
const controller=await build({absWorkingDir:root,entryPoints:["worker/account-enrollment/controller-entry.ts"],outfile:controllerPath,bundle:true,platform:"node",format:"esm",target:"node22.22",conditions:["react-server"],external:["pg-native","sharp",...optionalPeers],sourcemap:false,metafile:true,legalComments:"none",write:false,
 banner:{js:'import { createRequire as __embelCreateRequire } from "node:module"; const require = __embelCreateRequire(import.meta.url);'}});
const controllerInputs=Object.keys(controller.metafile.inputs).sort();
if(controllerInputs.some(source=>/(^|\/)(\.env[^/]*|\.local-fluid|\.vercel|\.secrets|\.credentials)(\/|$)/u.test(source)
 ||/^(src\/app\/|scripts\/local-|worker\/index\.ts|worker\/development\/)/u.test(source)))throw Error("Account controller protected build input rejected");
const controllerFirstParty=controllerInputs.filter(source=>{const relative=path.relative(dependencies,path.resolve(root,source));return relative===".."||relative.startsWith(`..${path.sep}`)||path.isAbsolute(relative);});
await writeFile(path.join(output,"controller-source-inputs.proposed.json"),JSON.stringify(controllerFirstParty,null,2)+"\n");
const approvedControllerInputs=JSON.parse(await readFile(path.join(root,"worker/account-enrollment/controller-source-inputs.json"),"utf8"));
if(!Array.isArray(approvedControllerInputs)||JSON.stringify(approvedControllerInputs)!==JSON.stringify(controllerFirstParty))throw Error("Account controller source graph differs from reviewed allowlist");
const controllerBundle=controller.outputFiles.find(file=>file.path===controllerPath);if(!controllerBundle||controller.outputFiles.length!==1)throw Error("Account controller output invalid");
await writeFile(controllerPath,controllerBundle.contents);
await writeFile(path.join(output,"controller-manifest.json"),JSON.stringify({version:1,sourceRevision,sourceClean,controllerSha256:createHash("sha256").update(controllerBundle.contents).digest("hex")})+"\n");
console.log("Account worker artifact prepared in .tmp/account-worker; no process or deployment activated.");
