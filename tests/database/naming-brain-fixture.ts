import { asRole, OWNER_A, resetFixture, type TestDatabase } from "./local-supabase";
export const brainPolicy = { version: 1, handlerVersion: "naming-brain-v1", billingMode: "openai_api", protocol: "openai_agents", model: "synthetic-fixture-model", reasoningEffort: "xhigh", runAllowanceMicrousd: 5_000_000, aggregateAllowanceMicrousd: 25_000_000, maxUnsettledRuns: 5, maxConcurrentCreators: 3, maxInitialCandidates: 150, maxGapCandidates: 50, maxGapRounds: 1, maxInputBytes: 131072, maxOutputBytes: 524288, stageDeadlineMs: 240000, stageLimits: { research: { maximumCostMicrousd: 750000, maxWebSearchCalls: 4 }, direction: { maximumCostMicrousd: 250000, maxWebSearchCalls: 0 }, creation: { maximumCostMicrousd: 1500000, maxWebSearchCalls: 0 }, curation: { maximumCostMicrousd: 500000, maxWebSearchCalls: 0 }, verification: { maximumCostMicrousd: 1250000, maxWebSearchCalls: 20 }, gap: { maximumCostMicrousd: 750000, maxWebSearchCalls: 8 }, prepare: { maximumCostMicrousd: 0, maxWebSearchCalls: 0 } } } as const;
export const brainPreferences = { version: 2, creativeLocale: "en", notes: "", minimumGraphemes: null, maximumGraphemes: null, approaches: ["real_words"], directness: "open_ended", sourceLanguages: [], heritageNotes: "", culturalNotes: "", requiredText: [], excludedText: [] };
export const brainGapEnvelope = {"version":1,"phases":[{"phase":"direction","cents":10,"searches":0},{"phase":"creation","cents":40,"searches":0},{"phase":"curation","cents":5,"searches":0},{"phase":"verification","cents":20,"searches":8}]} as const;
export const brainManifest = Object.entries(brainPolicy.stageLimits).map(([key, limit]) => ({ key, maximumCostMicrousd: limit.maximumCostMicrousd }));
export async function brainRpc<T = Record<string, unknown>>(db: TestDatabase, name: string, args: unknown[], owner = OWNER_A): Promise<T> {
 if (!/^[a-z_]+$/.test(name)) throw Error("Invalid synthetic RPC name");
 return asRole(db, "authenticated", owner, async () => (await db.query<{ result: T }>(`select to_jsonb(public.${name}(${args.map((_, i) => `$${i+1}`).join(",")})) result`, args.map(v => v && typeof v === "object" ? JSON.stringify(v) : v))).rows[0]!.result);
}
export async function brainWorker<T>(db: TestDatabase, run: () => Promise<T>, owner = OWNER_A) {
 const role = owner === OWNER_A ? "fixture_naming_brain_a" : "fixture_naming_brain_b";
 await db.exec(`set session authorization ${role}`);
 try { return await run(); } finally { await db.exec("set session authorization postgres"); }
}
export async function installBrainFixture(db: TestDatabase) {
 await db.exec(`create role fixture_naming_brain_a login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
 create role fixture_naming_brain_b login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
 grant usage on schema public to fixture_naming_brain_a,fixture_naming_brain_b;`);
 const signatures = (await db.query<{ signature: string }>("select p.oid::regprocedure::text signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=any($1::text[])", [["report_naming_brain_worker_ready", "claim_naming_brain_job", "expire_naming_brain_leases", "naming_brain_worker_action", "authorize_naming_brain_dispatch", "record_naming_brain_provider_receipt", "complete_naming_brain_stage"]])).rows;
 for (const row of signatures) await db.exec(`grant execute on function ${row.signature} to fixture_naming_brain_a,fixture_naming_brain_b`);
}
export async function seedBrainFixture(db: TestDatabase) {
 await resetFixture(db);
 await db.query("update public.usage_accounts set limit_microusd=25000000");
 const project = (await brainRpc<{ id: string }>(db, "create_project", ["naming_only", "Synthetic coffee", { description: "Synthetic coffee naming brief" }, "a".repeat(64)])).id;
 await brainRpc(db, "save_naming_preferences", [project, 0, brainPreferences]);
 await db.query("insert into fluid_private.naming_brain_pilots(owner_id,role_name,role_oid,deployment_id,policy,enabled) select $1,rolname,oid,'fixture-deployment',$2::jsonb,true from pg_roles where rolname='fixture_naming_brain_a'", [OWNER_A, JSON.stringify(brainPolicy)]);
 await brainWorker(db, () => db.query("select public.report_naming_brain_worker_ready($1::jsonb,'fixture-deployment','fixture-worker',120)", [JSON.stringify(brainPolicy)]));
 return project;
}
export function initialIntent(key = "fixture-naming-brain-initial") { return { version: 1, expectedProjectRevision: 1, expectedPreferencesVersion: 1, expectedSteeringRevision: 0, expectedDemandSequence: 0, consumedThrough: null, idempotencyKey: key, reason: "initial" }; }
export async function claimBrain(db: TestDatabase) {
 return brainWorker(db, async () => (await db.query<{ result: { mode: string; job: { id: string; lease_token: string; input: { runId: string } } } }>("select public.claim_naming_brain_job('fixture-worker','fixture-deployment',120) result")).rows[0]!.result);
}
export async function brainAction(db: TestDatabase, job: {id:string;lease_token:string}, action: string, payload: unknown = {}) {
 return brainWorker(db, async () => (await db.query<{result:unknown}>("select public.naming_brain_worker_action($1,$2,$3,$4::jsonb) result",[job.id,job.lease_token,action,JSON.stringify(payload)])).rows[0]!.result);
}
export async function startBrainFixture(db: TestDatabase, project: string) {
 await brainRpc(db,"ensure_naming_brain_run",[project,initialIntent()]);const claim=await claimBrain(db);await brainAction(db,claim.job,"plan",{manifest:brainManifest,gapEnvelope:brainGapEnvelope});return claim.job;
}
export async function beginBrainStage(db: TestDatabase, job: {id:string;lease_token:string}, stage: keyof typeof brainPolicy.stageLimits) {
 return brainAction(db,job,"begin",{stageKey:stage,requestKey:`fixture-stage-${stage}-request`,maximumCostMicrousd:brainPolicy.stageLimits[stage].maximumCostMicrousd});
}
export async function planBrainCall(db: TestDatabase, job: {id:string;lease_token:string;input:{runId:string}}, stage: Exclude<keyof typeof brainPolicy.stageLimits,"prepare"|"gap">, dependencyArtifactIds: string[]=[]) {
 const snapshot=(await db.query<{input:{snapshot:Record<string,unknown>}}>("select input from public.jobs where id=$1",[job.id])).rows[0]!.input.snapshot;
 const role=({research:"researcher",direction:"director",creation:"creator",curation:"curator",verification:"verifier"} as const)[stage];
 const cap=brainPolicy.stageLimits[stage];const requestHash=(await import("node:crypto")).createHash("sha256").update(stage).digest("hex");
 const allocation={providerCallKey:`fixture-call-${stage}`,assignmentKey:role==="creator"?"real":null,requestKey:`fixture-provider-${stage}-request`,requestHash,sessionLimitCents:cap.maximumCostMicrousd/10000,maxWebSearchCalls:cap.maxWebSearchCalls,role};
 await brainAction(db,job,"call_plan",{stageKey:stage,calls:[allocation]});
 const request={runId:job.input.runId,stageKey:stage,snapshotHash:snapshot.snapshotHash,input:{role,snapshot},dependencyArtifactIds,...allocation,policy:{version:1,role,protocol:"openai_agents",model:brainPolicy.model,reasoningEffort:"xhigh",maximumCostMicrousd:cap.maximumCostMicrousd,sessionLimitCents:allocation.sessionLimitCents,maxWebSearchCalls:cap.maxWebSearchCalls,maxInputBytes:131072,maxOutputBytes:524288,deadlineMs:240000,nativeDelegation:false,allowedTools:cap.maxWebSearchCalls?["web_search","read_reference"]:[],referenceHosts:cap.maxWebSearchCalls?["example.com"]:[]}};
 return {request,snapshot,allocation};
}
export async function saveBrainArtifact(db: TestDatabase, job: {id:string;lease_token:string;input:{runId:string}}, stage: Exclude<keyof typeof brainPolicy.stageLimits,"prepare"|"gap">, output: Record<string,unknown>, extra: Record<string,unknown>={}, complete=true) {
 await beginBrainStage(db,job,stage);const {request,snapshot,allocation}=await planBrainCall(db,job,stage,((extra.sourceDependencies??[]) as {artifactId:string}[]).map(dependency=>dependency.artifactId));
 await brainWorker(db,()=>db.query("select public.authorize_naming_brain_dispatch($1,$2,$3::jsonb)",[job.id,job.lease_token,JSON.stringify(request)]));
 const itemId=`fixture-final-${stage}`,sessionId=`fixture-session-${stage}`,turnId=`fixture-turn-${stage}`,at="2026-10-16T12:00:00Z";
 const receipt={version:1,provider:"openai",billingMode:"openai_api",runId:job.input.runId,stageKey:stage,role:allocation.role,snapshotHash:snapshot.snapshotHash,protocol:"openai_agents",providerCallKey:allocation.providerCallKey,assignmentKey:allocation.assignmentKey,requestKey:allocation.requestKey,requestHash:allocation.requestHash,sessionLimitCents:allocation.sessionLimitCents,dispatchState:"dispatched",requestId:null,callIds:[],observedModel:brainPolicy.model,toolCalls:[],artifactItemIds:[itemId],usageObservations:[],estimatedCostMicrousd:null,providerCostCounters:[],accountingStatus:"provisional",confirmedActualCostMicrousd:null,recordedAt:at,sessionId,turnId,agentId:null,responseId:null};
 await brainWorker(db,()=>db.query("select public.record_naming_brain_provider_receipt($1,$2,$3::jsonb)",[job.id,job.lease_token,JSON.stringify(receipt)]));
 if(stage==="research")output={...output,territories:[{territoryId:"nature",title:"Synthetic nature",direction:"Explore nature in this fixture.",sourceKeys:extra.readiness==="sourced"?["fixture-source"]:[]},{territoryId:"sound",title:"Synthetic sound",direction:"Explore sound in this fixture.",sourceKeys:[]}],...(extra.readiness==="sourced"?{facts:[{claimKey:"fixture-fact",statement:"This is synthetic reference material.",sourceKeys:["fixture-source"],status:"unverified"}]}:{})};
 const text=JSON.stringify(output),item={id:itemId,type:"message",role:"assistant",phase:"final_answer",status:"completed",turn_id:turnId,content:[{type:"output_text",text}]};
 await brainAction(db,job,"provider_item",{providerCallKey:allocation.providerCallKey,sessionId,turnId,itemId,item});
 if(stage==="research" && extra.readiness==="sourced") {
  const excerpt="Synthetic reference material for a local SQL ownership test.",contentHash=(await import("node:crypto")).createHash("sha256").update(excerpt).digest("hex");
  const source={sourceKey:"fixture-source",url:"https://example.com/synthetic",title:"Synthetic source",retrievedAt:at,providerItemId:itemId,evidenceStatus:"retrieved",excerpt,contentHash,provenance:{protocol:"openai_agents",sessionId,turnId,responseId:null,itemId,observedUrl:"https://example.com/synthetic"},retrieval:{retrievedAt:at,responseHash:contentHash,extractorVersion:"synthetic-v1",truncated:false}};
  await brainAction(db,job,"tool_result",{providerCallKey:allocation.providerCallKey,sessionId,turnId,callId:"fixture-reference-call",requestHash:allocation.requestHash,result:{source},sourceEvidence:source});
  extra={...extra,sources:[source]};
 }
 const artifact={artifactId:crypto.randomUUID(),runId:job.input.runId,stageKey:stage,snapshotHash:snapshot.snapshotHash,schemaVersion:1,promptVersion:"naming-brain-v1",providerReceipt:receipt,output,...extra};
 if(stage==="creation")Object.assign(artifact,{creatorAttribution:{protocol:"openai_agents",executionKind:"independent_session",assignmentKey:"real",assignmentInputHash:allocation.requestHash,sessionId,turnId,responseId:null,subagentId:null,itemId,itemContentHash:(await import("node:crypto")).createHash("sha256").update(text).digest("hex")}});
 await brainAction(db,job,"artifact",{artifact});
 if(complete)await brainWorker(db,()=>db.query("select public.complete_naming_brain_stage($1,$2,$3,'succeeded',$4::jsonb)",[job.id,job.lease_token,stage,JSON.stringify({artifactIds:[artifact.artifactId]})]));
 return artifact;
}

/** Synthetic complete/partial output persisted through worker boundaries, with
 * exact original Creator items. It is not evidence of live provider quality. */
export async function prepareBrainFixture(db:TestDatabase,project:string,count=100){
 const job=await startBrainFixture(db,project);
 const proposals=Array.from({length:count},(_,i)=>({candidateKey:`name-${i}`,value:`Cedar${i}`,primaryApproach:"real_words",additionalApproaches:[],territoryId:"nature",constructionKey:"whole_word",rationale:"Synthetic natural association.",caution:null,claims:[]}));
 const ids=proposals.map(p=>({candidateKey:p.candidateKey,candidateId:crypto.randomUUID()}));
 await saveBrainArtifact(db,job,"research",{role:"researcher",territories:[],facts:[],interpretations:[],uncertainties:[]},{readiness:"sourced",sources:[]});
 await saveBrainArtifact(db,job,"direction",{role:"director",round:"initial",assignments:[],feedbackHypotheses:[]});
 const creator=await saveBrainArtifact(db,job,"creation",{role:"creator",assignmentKey:"real",candidates:proposals},{candidateIds:ids});
 const curator=await saveBrainArtifact(db,job,"curation",{role:"curator",annotations:[],gaps:[]});
 const verifier=await saveBrainArtifact(db,job,"verification",{role:"verifier",findings:[]},{sources:[]});
 await beginBrainStage(db,job,"gap");await brainWorker(db,()=>db.query("select public.complete_naming_brain_stage($1,$2,'gap','succeeded','{\"artifactIds\":[]}')",[job.id,job.lease_token]));
 await beginBrainStage(db,job,"prepare");const index=await brainAction(db,job,"index_page",{}) as {epoch:number};await brainAction(db,job,"index_finalize",{epoch:index.epoch});
 const preparedSet={version:1,runId:job.input.runId,stageKey:"prepare",snapshotHash:creator.snapshotHash,schemaVersion:1,promptVersion:"naming-brain-v1",targetCount:100,minimumPerApproach:5,candidateIds:ids.map(i=>i.candidateId),primaryCounts:[{approach:"real_words",count}],retainedUnusedIds:[],fulfillment:{status:count===100?"complete":"partial",targetCount:100,acceptedCount:count,missingCount:100-count,coverageSatisfied:count>=5,message:count===100?null:"Synthetic partial set."},deficits:count>=5?[]:[{approach:"real_words",required:5,actual:count,missing:5-count}],rejected:[],annotations:[],curationArtifactId:curator.artifactId,verificationArtifactId:verifier.artifactId,sourceArtifactIds:[creator.artifactId]};
 const candidates=ids.map(i=>({...i,sourceArtifactId:creator.artifactId,assignmentKey:"real",identityKey:proposals.find(p=>p.candidateKey===i.candidateKey)!.value.toLowerCase(),runId:job.input.runId,snapshotHash:creator.snapshotHash}));
 const prepared=await brainAction(db,job,"prepare",{preparedSet,candidates,verification:{artifact:verifier}}) as {preparedSetId:string};
 return {job,preparedSetId:prepared.preparedSetId,preparedSet};
}
