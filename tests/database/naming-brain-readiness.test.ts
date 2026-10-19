import {afterAll,beforeAll,beforeEach,describe,expect,it} from "vitest";
import {readFile} from "node:fs/promises";
import {createHash} from "node:crypto";
import {createTestDatabase,OWNER_A,type TestDatabase} from "./local-supabase";
import {attestBrainPreferences,brainPreferences,brainReadinessFingerprint,brainRpc,brainWorker,initialIntent,installBrainFixture,seedBrainFixture} from "./naming-brain-fixture";
import {getNamingPreferencesReadiness,matchesNamingTextFragment,namingPreferencesV2Schema} from "../../src/domain/naming-brain-preferences";
import {steerNamingFeedIntentSchema} from "../../src/domain/naming-brain";
const properties=/[\p{White_Space}\p{Default_Ignorable_Code_Point}\p{Mark}\u2800]/u;
const controls=/[\p{Cc}\p{Bidi_Control}]/u;
function unicodeClass(predicate:(s:string)=>boolean){const ranges:number[][]=[];let first:number|null=null,last=0;for(let n=1;n<=0x10ffff;n++){if(n>=0xd800&&n<=0xdfff)continue;if(predicate(String.fromCodePoint(n))){first??=n;last=n;}else if(first!==null){ranges.push([first,last]);first=null;}}if(first!==null)ranges.push([first,last]);const cp=(n:number)=>n<=65535?"\\"+n.toString(16).padStart(4,"0"):"\\+"+n.toString(16).padStart(6,"0");return "["+ranges.map(([a,b])=>cp(a!)+(a===b?"":"-"+cp(b!))).join("")+"]";}
describe("Trusted shared-JS preference readiness and direct text parity",()=>{
 let db:TestDatabase;let project:string;
 beforeAll(async()=>{db=await createTestDatabase();await installBrainFixture(db);},30000);afterAll(async()=>{await db?.close();});beforeEach(async()=>{project=await seedBrainFixture(db);});
 const pending=()=>brainWorker(db,async()=>(await db.query<{work:{projectId:string;preferencesVersion:number;preferencesHash:string;expectedFingerprint:unknown}[]}>("select public.get_naming_brain_preference_work(20) work")).rows[0]!.work);
 it("requires owned trusted exact-version/hash/fingerprint attestation and never trusts a client ready flag",async()=>{
  await brainRpc(db,"save_naming_preferences",[project,1,{...brainPreferences,notes:"Changed saved draft"}]);
  expect(await brainRpc(db,"ensure_naming_brain_run",[project,{...initialIntent(),expectedPreferencesVersion:2}])).toMatchObject({status:"blocked",code:"preferences_validation_pending"});
  const row=(await pending())[0]!;const args=[project,2,row.preferencesHash,brainReadinessFingerprint,{ready:true,missing:[]}];
  await expect(brainRpc(db,"attest_naming_brain_preferences",args)).rejects.toMatchObject({code:"42501"});
  const attest=(values:unknown[])=>brainWorker(db,()=>db.query("select public.attest_naming_brain_preferences($1,$2,$3,$4::jsonb,$5::jsonb)",values.map(v=>v&&typeof v==="object"?JSON.stringify(v):v)));
  await expect(attest([project,1,row.preferencesHash,brainReadinessFingerprint,{ready:true,missing:[]}])).rejects.toMatchObject({code:"PT409"});
  await expect(attest([project,2,"f".repeat(64),brainReadinessFingerprint,{ready:true,missing:[]}])).rejects.toMatchObject({code:"PT409"});
  await expect(attest([project,2,row.preferencesHash,{...brainReadinessFingerprint,unicodeVersion:"unsupported"},{ready:true,missing:[]}])).rejects.toMatchObject({code:"PT409"});
  await attestBrainPreferences(db);await attestBrainPreferences(db);
  const result=await brainRpc<{status:string;run:{runId:string}}>(db,"ensure_naming_brain_run",[project,{...initialIntent(),expectedPreferencesVersion:2}]);expect(result.status).toBe("pending");
  expect((await db.query<{bound:boolean}>("select exists(select 1 from fluid_private.naming_brain_runs r join fluid_private.naming_brain_preference_attestations a on a.id=r.readiness_attestation_id and a.owner_id=r.owner_id and a.project_id=r.project_id where r.id=$1 and a.preferences_version=2) bound",[result.run.runId])).rows[0]!.bound).toBe(true);
 });
 it("keeps invalid drafts saved but withdraws paid Resume eligibility and rejects changed runtime fingerprints",async()=>{
  const first=await brainRpc<{run:{runId:string;jobId:string}}>(db,"ensure_naming_brain_run",[project,initialIntent()]);await brainRpc(db,"request_job_cancel",[first.run.jobId]);
  await brainRpc(db,"save_naming_preferences",[project,1,{...brainPreferences,requiredText:["cedar"],maximumGraphemes:3}]);await attestBrainPreferences(db);
  expect(await brainRpc(db,"get_naming_brain_run",[project,first.run.runId])).toMatchObject({canResume:false});
  await brainRpc(db,"save_naming_preferences",[project,2,{...brainPreferences,requiredText:["Café"],excludedText:["cafe"]}]);await attestBrainPreferences(db);
  expect(await brainRpc(db,"get_naming_brain_run",[project,first.run.runId])).toMatchObject({canResume:true});
  await db.query("update fluid_private.naming_brain_pilots set readiness_fingerprint=jsonb_set(readiness_fingerprint,'{unicodeVersion}','\"future-runtime\"') where owner_id=$1",[OWNER_A]);
  expect(await brainRpc(db,"get_naming_brain_run",[project,first.run.runId])).toMatchObject({canResume:false});
  expect((await db.query<{n:number}>("select count(*)::integer n from public.naming_preferences where project_id=$1",[project])).rows[0]!.n).toBe(3);
 });
 it("pins shared source and exercises the actual Node Unicode corpus through trusted PGlite attestations",async()=>{
  const source=await readFile(new URL("../../src/domain/naming-brain-preferences.ts",import.meta.url),"utf8");expect(createHash("sha256").update(source).digest("hex")).toBe(brainReadinessFingerprint.implementationHash);
  expect(matchesNamingTextFragment("J\u030c","ǰ")).toBe(true);expect(matchesNamingTextFragment("İ","i\u0307")).toBe(true);expect(matchesNamingTextFragment("ΟΣ","ος")).toBe(true);
  const values=new Map<string,string>();for(let cp=1;cp<=0x10ffff;cp++){if(cp>=0xd800&&cp<=0xdfff)continue;const raw=String.fromCodePoint(cp);if(raw.toLowerCase()!==raw)values.set(raw.normalize("NFC").toLowerCase().normalize("NFC"),raw);}
  values.set("ǰ","J\u030c");values.set("ος","ΟΣ");expect(values.size).toBeGreaterThan(1400);
  let version=1;const corpus=[...values.entries()];for(let start=0;start<corpus.length;start+=20){const group=corpus.slice(start,start+20);const prefs=namingPreferencesV2Schema.parse({...brainPreferences,requiredText:group.map(([,upper])=>upper),excludedText:group.map(([lower])=>lower)});expect(getNamingPreferencesReadiness(prefs)).toEqual({ready:false,missing:["conflicting_text"]});
   await brainRpc(db,"save_naming_preferences",[project,version++,prefs]);await attestBrainPreferences(db);
   expect((await db.query<{readiness:unknown}>("select readiness from fluid_private.naming_brain_preference_attestations where owner_id=$1 and project_id=$2 and preferences_version=$3",[OWNER_A,project,version])).rows[0]!.readiness).toEqual({ready:false,missing:["conflicting_text"]});
  }
  expect(await brainRpc(db,"ensure_naming_brain_run",[project,{...initialIntent(),expectedPreferencesVersion:version}])).toMatchObject({status:"blocked",code:"preferences_incomplete"});
  expect((await db.query<{n:number}>("select count(*)::integer n from fluid_private.naming_brain_runs")).rows[0]!.n).toBe(0);
 },30000);
 it("reproduces the fixed visible-text ranges and matches shared trim/code-point/control behavior",async()=>{
  const sql=await readFile(new URL("../../supabase/migrations/20261016180000_naming_brain.sql",import.meta.url),"utf8");expect(sql).toContain("U&'"+unicodeClass(v=>properties.test(v))+"'");expect(sql).toContain("U&'"+unicodeClass(v=>controls.test(v))+"'");
  const base={expectedProjectRevision:1,expectedPreferencesVersion:1,expectedSteeringRevision:0,candidateIds:[crypto.randomUUID()],idempotencyKey:"fixture-visible-text-compare"};
  for(const instruction of ["Hello","  Hello  ","\nHello\n","😀","😀".repeat(1000),"😀".repeat(1001),"😀".repeat(2000),"😀".repeat(2001),"\u0301","\u200b","\u2800","\u00ad","\u2060","\u034f","\u115f","\u061c","\u202e","漢","A\u200dB","hi\nthere","\ufeffHello\ufeff"]){
   const actual=(await db.query<{valid:boolean}>("select fluid_private.naming_brain_visible_text($1::jsonb) valid",[JSON.stringify(instruction)])).rows[0]!.valid;
   expect(actual,`code points ${Array.from(instruction).length}`).toBe(steerNamingFeedIntentSchema.safeParse({...base,instruction}).success);
  }
 });
});
