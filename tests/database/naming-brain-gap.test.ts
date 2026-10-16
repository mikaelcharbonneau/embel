import { afterAll,beforeAll,beforeEach,describe,expect,it } from "vitest";
import { createHash } from "node:crypto";
import { createTestDatabase,type TestDatabase } from "./local-supabase";
import { beginBrainStage,brainAction,brainPolicy,brainGapEnvelope,brainManifest,brainWorker,installBrainFixture,saveBrainArtifact,seedBrainFixture,startBrainFixture } from "./naming-brain-fixture";
describe("Naming gap phase envelopes (local SQL)",()=>{
 let db:TestDatabase;let project:string;
 beforeAll(async()=>{db=await createTestDatabase();await installBrainFixture(db);},30000);afterAll(async()=>{await db?.close();});beforeEach(async()=>{project=await seedBrainFixture(db);});
 it("freezes ordered exact phase requests inside fixed75cent/8search envelopes without retries or re-lending",async()=>{
  const job=await startBrainFixture(db,project);
  await expect(brainAction(db,job,"plan",{manifest:brainManifest,gapEnvelope:{...brainGapEnvelope,phases:brainGapEnvelope.phases.map(p=>({...p,cents:p.cents+1}))}})).rejects.toMatchObject({code:"PT409"});
  await expect(db.query("update fluid_private.naming_brain_runs set gap_envelope=jsonb_set(gap_envelope,'{version}','2') where id=$1",[job.input.runId])).rejects.toMatchObject({code:"55000"});
  const research=await saveBrainArtifact(db,job,"research",{role:"researcher",territories:[],facts:[],interpretations:[],uncertainties:[]},{readiness:"sourced",sources:[]});
  await saveBrainArtifact(db,job,"direction",{role:"director",round:"initial",assignments:[],feedbackHypotheses:[]});
  await saveBrainArtifact(db,job,"creation",{role:"creator",assignmentKey:"real",candidates:[]},{candidateIds:[]});
  await saveBrainArtifact(db,job,"curation",{role:"curator",annotations:[],gaps:[]});
  await saveBrainArtifact(db,job,"verification",{role:"verifier",findings:[]},{sources:[]});
  await beginBrainStage(db,job,"gap");
  const stage=await brainAction(db,job,"stage",{stageKey:"gap"}) as {gapEnvelope:unknown;gapPlanIdentity:string};expect(stage.gapEnvelope).toEqual(brainGapEnvelope);expect(stage.gapPlanIdentity).toMatch(/^[a-f0-9]{64}$/);
  const snapshot=(await db.query<{snapshot:Record<string,unknown>}>("select snapshot from fluid_private.naming_brain_runs where id=$1",[job.input.runId])).rows[0]!.snapshot;
  const phases=[{phase:"direction",role:"director",cents:10,searches:0,output:{role:"director",round:"gap",assignments:[],feedbackHypotheses:[]}},{phase:"creation",role:"creator",cents:40,searches:0,output:{role:"creator",assignmentKey:"gap-real",candidates:[]}},{phase:"curation",role:"curator",cents:5,searches:0,output:{role:"curator",annotations:[],gaps:[]}},{phase:"verification",role:"verifier",cents:20,searches:8,output:{role:"verifier",findings:[]}}];
  const artifacts:string[]=[];
  for(const [n,p] of phases.entries()){
   const allocation={providerCallKey:`fixture-gap-${p.phase}`,assignmentKey:p.role==="creator"?"gap-real":null,requestKey:`fixture-gap-request-${p.phase}`,requestHash:createHash("sha256").update(p.phase).digest("hex"),sessionLimitCents:p.cents,maxWebSearchCalls:p.searches,role:p.role};
   const plan={stageKey:"gap",phase:p.phase,calls:[allocation]};
   if(n===0)await expect(brainAction(db,job,"call_plan",{...plan,phase:"creation"})).rejects.toMatchObject({code:"55000"});
   await expect(brainAction(db,job,"call_plan",{...plan,calls:[{...allocation,sessionLimitCents:p.cents+1}]})).rejects.toMatchObject({code:"22023"});
   await expect(brainAction(db,job,"call_plan",{...plan,calls:[{...allocation,maxWebSearchCalls:p.searches+1}]})).rejects.toMatchObject({code:"22023"});
   expect(await brainAction(db,job,"call_plan",plan)).toEqual(plan.calls);
   const request={...allocation,runId:job.input.runId,stageKey:"gap",snapshotHash:snapshot.snapshotHash,input:{role:p.role,snapshot},dependencyArtifactIds:[...artifacts],policy:{version:1,role:p.role,protocol:"openai_agents",model:brainPolicy.model,reasoningEffort:"xhigh",maximumCostMicrousd:p.cents*10000,sessionLimitCents:p.cents,maxWebSearchCalls:p.searches,maxInputBytes:131072,maxOutputBytes:524288,deadlineMs:240000,nativeDelegation:false,allowedTools:p.searches?["web_search","read_reference"]:[],referenceHosts:p.searches?["example.com"]:[]}};
   const authorize=()=>brainWorker(db,async()=>(await db.query<{ok:boolean}>("select public.authorize_naming_brain_dispatch($1,$2,$3::jsonb) ok",[job.id,job.lease_token,JSON.stringify(request)])).rows[0]!.ok);
   expect(await authorize()).toBe(true);expect(await authorize()).toBe(false);
   const itemId="fixture-session-scoped-final",sessionId=`fixture-gap-session-${p.phase}`,turnId=`fixture-gap-turn-${p.phase}`;
   const receipt={...research.providerReceipt,...allocation,stageKey:"gap",sessionId,turnId,artifactItemIds:[itemId]};delete (receipt as Partial<typeof allocation>).maxWebSearchCalls;
   await brainWorker(db,()=>db.query("select public.record_naming_brain_provider_receipt($1,$2,$3::jsonb)",[job.id,job.lease_token,JSON.stringify(receipt)]));
   const text=JSON.stringify(p.output),item={id:itemId,type:"message",role:"assistant",phase:null,status:"completed",turn_id:turnId,content:[{type:"output_text",text}]};
   await brainAction(db,job,"provider_item",{providerCallKey:allocation.providerCallKey,sessionId,turnId,itemId,item});
   const artifact={artifactId:crypto.randomUUID(),runId:job.input.runId,stageKey:"gap",snapshotHash:snapshot.snapshotHash,schemaVersion:1,promptVersion:"naming-brain-v1",providerReceipt:receipt,output:p.output,...(p.role==="verifier"?{sources:[],sourceDependencies:[]} : {}),...(p.role==="creator"?{candidateIds:[],creatorAttribution:{protocol:"openai_agents",executionKind:"independent_session",assignmentKey:"gap-real",assignmentInputHash:allocation.requestHash,sessionId,turnId,responseId:null,subagentId:null,itemId,itemContentHash:createHash("sha256").update(text).digest("hex")}}:{})};
   if(p.role==="creator")await expect(brainAction(db,job,"artifact",{artifact:{...artifact,creatorAttribution:{...artifact.creatorAttribution,assignmentInputHash:"f".repeat(64)}}})).rejects.toMatchObject({code:"22023"});
   await brainAction(db,job,"artifact",{artifact});artifacts.push(artifact.artifactId);
   await expect(brainAction(db,job,"call_plan",{...plan,calls:[{...allocation,providerCallKey:`replacement-${p.phase}`}]})).rejects.toMatchObject({code:"55000"});
  }
  await brainWorker(db,()=>db.query("select public.complete_naming_brain_stage($1,$2,'gap','succeeded',$3::jsonb)",[job.id,job.lease_token,JSON.stringify({artifactIds:artifacts})]));
  expect((await brainAction(db,job,"stage",{stageKey:"gap"}) as {callPlans:unknown[];providerItems:unknown[]}).callPlans).toHaveLength(4);
  expect((await brainAction(db,job,"stage",{stageKey:"gap"}) as {providerItems:unknown[]}).providerItems).toHaveLength(4);
 });
});
