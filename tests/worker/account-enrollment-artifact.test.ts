import { execFile,spawn } from "node:child_process";
import { promisify } from "node:util";
import { cp,mkdtemp,readFile,rm,appendFile } from "node:fs/promises";
import { join,resolve } from "node:path";
import { tmpdir } from "node:os";
import { beforeAll,describe,expect,it } from "vitest";
const run=promisify(execFile),directory=resolve(".tmp/account-worker");
beforeAll(async()=>{await run(process.execPath,["scripts/build-account-worker.mjs"],{cwd:resolve("."),timeout:20_000,maxBuffer:64_000});},30_000);
describe("compiled account-worker artifact (inert Node runtime only)",()=>{
 it("starts compiled JavaScript and reports actual source/runtime without credentials or engine activity",async()=>{
  const result=await run(process.execPath,[join(directory,"index.js"),"--describe"],{timeout:10_000,maxBuffer:16_000,
   env:{PATH:process.env.PATH,NODE_ENV:"test",OPENAI_API_KEY:"fixture-do-not-print",PGPASSWORD:"fixture-do-not-print"}});
  const metadata=JSON.parse(result.stdout);expect(result.stderr).toBe("");expect(metadata.runtime.node).toBe(process.versions.node);
  expect(metadata.runtime.icu).toBe(process.versions.icu);expect(metadata.runtime.unicode).toBe(process.versions.unicode);
  expect(metadata.artifactSha256).toMatch(/^[a-f0-9]{64}$/u);expect(result.stdout).not.toContain("fixture-do-not-print");
  expect(metadata).toMatchObject(JSON.parse(await readFile(join(directory,"build-manifest.json"),"utf8")));
 });
 it("rejects running without a configured IPC controller before any network use",async()=>{
  await expect(run(process.execPath,[join(directory,"index.js")],{timeout:10_000,maxBuffer:16_000})).rejects.toMatchObject({code:2,stdout:"",stderr:""});
 });
 it("executes the separately compiled raster prerequisite on a synthetic pixel without provider or Storage access",async()=>{
  const bytes=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWNgYGD4DwABBAEAfbLI3wAAAABJRU5ErkJggg==","base64");
  const response=await new Promise<string>((resolve,reject)=>{
   const child=spawn(process.execPath,[join(directory,"raster.js")],{cwd:directory,env:{PATH:process.env.PATH,NODE_ENV:"test"},stdio:["pipe","pipe","pipe"]});
   let output="",error="";const timer=setTimeout(()=>{child.kill();reject(Error("fixture raster timeout"));},10_000);
   child.stdout.on("data",part=>{output+=String(part);});child.stderr.on("data",part=>{error+=String(part);});child.on("error",reject);
   child.on("close",code=>{clearTimeout(timer);if(code!==0||error)reject(Error("fixture raster unavailable"));else resolve(output);});
   child.stdin.end(Buffer.concat([Buffer.from(JSON.stringify({mode:"inspect",mimeType:"image/png",logoType:"abstract",settings:{preset:"bw",simplify:0,filterSpeckle:0,maxColors:2},byteLength:bytes.length})+"\n"),bytes]));
  });
  expect(JSON.parse(response)).toMatchObject({status:"inspected",output:{width:1,height:1,format:"png"}});
 });
 it("rejects artifact mutation against its manifest without emitting source or secrets",async()=>{
  const target=await mkdtemp(join(tmpdir(),"embel-worker-artifact-"));
  try{for(const file of["index.js","raster.js","package.json","build-manifest.json"])await cp(join(directory,file),join(target,file));
   await appendFile(join(target,"raster.js"),"\n// changed\n");
   await expect(run(process.execPath,[join(target,"index.js"),"--describe"],{timeout:10_000,maxBuffer:16_000})).rejects.toMatchObject({code:2,stdout:"",stderr:""});
  }finally{await rm(target,{recursive:true,force:true});}
 });
 it("executes the separately compiled controller in its default-off mode without reading bootstrap secrets",async()=>{
  const env:NodeJS.ProcessEnv={PATH:process.env.PATH,NODE_ENV:"test",EMBEL_ACCOUNT_BOOTSTRAP_VAULT_TOKEN:"fixture-do-not-print"};
  const result=await run(process.execPath,[join(directory,"controller.js")],{timeout:10_000,maxBuffer:16_000,env});
  expect(JSON.parse(result.stdout)).toEqual({event:"account_service_disabled"});expect(result.stderr).toBe("");expect(result.stdout).not.toContain("fixture-do-not-print");
  const described=await run(process.execPath,[join(directory,"controller.js"),"--describe"],{timeout:10_000,maxBuffer:16_000,env});
  expect(JSON.parse(described.stdout)).toMatchObject(JSON.parse(await readFile(join(directory,"controller-manifest.json"),"utf8")));
 });
 it("refuses active startup in this unqualified environment without printing supplied bootstrap configuration",async()=>{
  await expect(run(process.execPath,[join(directory,"controller.js")],{timeout:10_000,maxBuffer:16_000,
   env:{PATH:process.env.PATH,NODE_ENV:"test",VERCEL:"0",EMBEL_ACCOUNT_SERVICE_ENABLED:"true",EMBEL_ACCOUNT_BOOTSTRAP_VAULT_TOKEN:"fixture-do-not-print"}})).rejects.toMatchObject({code:2,stdout:"",stderr:'{"event":"account_service_unavailable"}\n'});
 });
});
