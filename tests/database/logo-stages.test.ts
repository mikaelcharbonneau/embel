import { randomUUID } from "node:crypto";
import { afterAll,beforeAll,beforeEach,describe,expect,it,vi } from "vitest";
import { asRole,createTestDatabase,OWNER_A,OWNER_B,resetFixture,type TestDatabase } from "./local-supabase";
import { captureLogoComponentLocks,assertLogoComponentLocks } from "../../src/features/logo-vector/model/locks";
import { separatedLogoDocument } from "../features/logo-vector/fixtures";
import { logoWorkspaceV2Schema,type LogoMutationReceipt } from "../../src/domain/logo-workspace";
vi.mock("server-only",()=>({}));
const brief={name:"Original Brand",activity:"Studio",audience:"Founders",personality:"Calm",logoTypes:["wordmark"]};
describe("local immutable stage selection and restoration",()=>{
 let db:TestDatabase;beforeAll(async()=>{db=await createTestDatabase();},40_000);afterAll(async()=>{await db?.close();});beforeEach(async()=>{await resetFixture(db);});
 async function rpc(name:string,args:unknown[],owner=OWNER_A){return asRole(db,"authenticated",owner,async()=>(await db.query<{value:unknown}>(`select public.${name}(${args.map((_,i)=>`$${i+1}`).join(",")}) value`,args)).rows[0]!.value);}
 async function start(){return logoWorkspaceV2Schema.parse(await rpc("start_logo_project",[{requestKey:randomUUID(),brief}]));}
 async function append(project:string,stage:string,payload:unknown,inputs:unknown=[]){return (await db.query<{value:{id:string;revision:number}}>("select fluid_private.logo_append_stage($1,$2,$3,$4,$5) value",[OWNER_A,project,stage,payload,inputs])).rows[0]!.value;}
 async function read(project:string){return logoWorkspaceV2Schema.parse(await rpc("get_logo_workspace",[project]));}
 async function command(project:string,method:string,body:unknown,owner=OWNER_A){return await rpc("apply_logo_workspace_command",[project,{method,body}],owner) as LogoMutationReceipt;}
 it("restore_appends_and_marks_downstream_stale",async()=>{
  const w=await start(),vectorId=randomUUID();
  const v1=await append(w.projectId,"vector",{vectorRevisionId:vectorId,approvalId:null});
  const directions=await append(w.projectId,"directions",{directionIds:[randomUUID(),randomUUID(),randomUUID()],selectionId:null,approvalId:null},[{stage:"vector",id:v1.id,revision:v1.revision}]);
  const deliverables=await append(w.projectId,"deliverables",{variantSetId:null,exportManifestIds:[]},[{stage:"directions",id:directions.id,revision:directions.revision},{stage:"vector",id:v1.id,revision:v1.revision}]);
  const original=(await db.query<{record:unknown}>("select record from public.logo_stage_revisions where id=$1",[directions.id])).rows[0]!.record;
  const current=await read(w.projectId);
  const restored=await command(w.projectId,"restoreLogoStage",{requestKey:randomUUID(),expected:current.heads,stage:"directions",revisionId:directions.id,acceptEarlierBasis:true});
  expect(restored.revision.id).not.toBe(directions.id);expect(restored.revision.parentRevisionId).toBe(directions.id);
  expect((await db.query<{record:unknown}>("select record from public.logo_stage_revisions where id=$1",[directions.id])).rows[0]!.record).toEqual(original);
  expect(restored.workspace.staleStages).toContainEqual({stage:"deliverables",reasons:["input_revision_changed"]});
  expect(restored.workspace.stages.deliverables?.id).toBe(deliverables.id);
 });
 it("restore exact replay survives changed heads and does not append twice",async()=>{
  const w=await start(),original=await append(w.projectId,"concepts",{batchIds:[],selected:null});const current=await read(w.projectId);
  const input={requestKey:randomUUID(),expected:current.heads,stage:"concepts",revisionId:original.id,acceptEarlierBasis:true};
  const receipt=await command(w.projectId,"restoreLogoStage",input);
  await command(w.projectId,"saveLogoBrief",{requestKey:randomUUID(),expected:receipt.workspace.heads,brief:{...brief,name:"Later"}});
  expect(await command(w.projectId,"restoreLogoStage",input)).toEqual(receipt);
  expect((await db.query("select count(*)::int count from public.logo_stage_revisions where stage='concepts'")).rows[0]).toEqual({count:2});
 });
 it("foreign source, changed body and stale heads append no stage",async()=>{
  const w=await start(),r=await append(w.projectId,"concepts",{batchIds:[],selected:null}),current=await read(w.projectId);
  const input={requestKey:randomUUID(),expected:current.heads,stage:"concepts",revisionId:r.id,acceptEarlierBasis:true};
  await expect(command(w.projectId,"restoreLogoStage",input,OWNER_B)).rejects.toMatchObject({code:"P0002"});
  await expect(command(w.projectId,"restoreLogoStage",{...input,expected:w.heads})).rejects.toMatchObject({code:"PT409"});
  await command(w.projectId,"restoreLogoStage",input);
  await expect(command(w.projectId,"restoreLogoStage",{...input,acceptEarlierBasis:false})).rejects.toMatchObject({code:"PT409"});
  expect((await db.query("select count(*)::int count from public.logo_stage_revisions where stage='concepts'")).rows[0]).toEqual({count:2});
 });
 it("public restore cannot authorize geometry with identical saved lock digests but a changed viewBox",async()=>{
  const w=await start(),currentDoc=separatedLogoDocument(),targetDoc={...currentDoc,viewBox:[0,0,999,999] as [number,number,number,number]};
  const locks=captureLogoComponentLocks(currentDoc,["synthetic-symbol"]);
  expect(captureLogoComponentLocks(targetDoc,["synthetic-symbol"])).toEqual(locks);
  expect(()=>assertLogoComponentLocks(currentDoc,targetDoc,locks)).toThrow();
  const targetId=randomUUID(),currentId=randomUUID();
  for(const [id,doc] of [[targetId,targetDoc],[currentId,currentDoc]] as const)await db.query("insert into public.logo_vector_revisions(id,owner_id,project_id,record) values($1,$2,$3,$4)",[id,OWNER_A,w.projectId,{id,ownerId:OWNER_A,projectId:w.projectId,reviewStatus:"review_required",inputRevisions:[],locks,proof:{viewBox:doc.viewBox}}]);
  const target=await append(w.projectId,"vector",{vectorRevisionId:targetId,approvalId:null});
  await append(w.projectId,"vector",{vectorRevisionId:currentId,approvalId:null});const current=await read(w.projectId);
  await expect(command(w.projectId,"restoreLogoStage",{requestKey:randomUUID(),expected:current.heads,stage:"vector",revisionId:target.id,acceptEarlierBasis:true})).rejects.toMatchObject({code:"42501"});
  expect((await read(w.projectId)).heads).toEqual(current.heads);
 });

 it("raster-only refinement does not clear the latest selected vector",async()=>{
  const w=await start(),id=randomUUID();await db.query("insert into public.logo_vector_revisions(id,owner_id,project_id,record) values($1,$2,$3,$4)",[id,OWNER_A,w.projectId,{id,ownerId:OWNER_A,projectId:w.projectId,reviewStatus:"review_required",inputRevisions:[],locks:[]}]);
  await append(w.projectId,"vector",{vectorRevisionId:id,approvalId:null});
  await append(w.projectId,"refinements",{rasterRevisionIds:[],vectorRevisionId:null,approvalId:null,sourceRequestKey:null});
  expect(await rpc("read_logo_current_vector",[w.projectId])).toEqual({ownerId:OWNER_A,projectId:w.projectId,vectorRevisionId:id});
  await expect(rpc("read_logo_current_vector",[w.projectId],OWNER_B)).rejects.toMatchObject({code:"P0002"});
 });
 it("does not invent activation order for a legacy vector head",async()=>{
  const w=await start(),id=randomUUID();await db.query("insert into public.logo_vector_revisions(id,owner_id,project_id,record) values($1,$2,$3,$4)",[id,OWNER_A,w.projectId,{id,ownerId:OWNER_A,projectId:w.projectId,reviewStatus:"review_required",inputRevisions:[],locks:[]}]);
  const initial=await append(w.projectId,"vector",{vectorRevisionId:id,approvalId:null});
  const legacy=(await db.query<{record:Record<string,unknown>}>("select record from public.logo_stage_revisions where id=$1",[initial.id])).rows[0]!.record;
  const legacyId=randomUUID(),record={...legacy,id:legacyId,revision:2,parentRevisionId:initial.id};
  await db.query("insert into public.logo_stage_revisions(id,owner_id,project_id,stage,revision,parent_revision_id,record) values($1,$2,$3,'vector',2,$4,$5)",[legacyId,OWNER_A,w.projectId,initial.id,record]);
  await db.query("update public.logo_stage_heads set revision_id=$1 where project_id=$2 and stage='vector'",[legacyId,w.projectId]);
  await expect(rpc("read_logo_current_vector",[w.projectId])).rejects.toMatchObject({code:"55000"});
 });
 it("no browser principal can append caller-provided stage payloads",async()=>{
  const w=await start();await expect(asRole(db,"authenticated",OWNER_A,()=>db.query("select fluid_private.logo_append_stage($1,$2,'concepts',$3,'[]')",[OWNER_A,w.projectId,{batchIds:[],selected:null}]))).rejects.toMatchObject({code:"42501"});
 });
});

describe("trusted approval isolation",()=>{
 let db:TestDatabase;beforeAll(async()=>{db=await createTestDatabase();await db.exec("create role fixture_logo_mutation login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;grant usage on schema public,fluid_private to fixture_logo_mutation;grant execute on function fluid_private.apply_logo_trusted_command(uuid,jsonb,jsonb),fluid_private.read_logo_trusted_request(uuid,jsonb) to fixture_logo_mutation");await db.query("insert into fluid_private.logo_asset_web_principals(role_name,role_oid,owner_id) select rolname,oid,$1 from pg_roles where rolname='fixture_logo_mutation'",[OWNER_A]);},40_000);afterAll(async()=>{await db?.close();});
 it("only a real owner-bound writer may accept a vector and create an immutable approval",async()=>{
  await resetFixture(db);const w=logoWorkspaceV2Schema.parse(await asRole(db,"authenticated",OWNER_A,async()=>(await db.query<{value:unknown}>("select public.start_logo_project($1) value",[{requestKey:randomUUID(),brief}])).rows[0]!.value));
  const id=randomUUID();await db.query("insert into public.logo_vector_revisions(id,owner_id,project_id,record) values($1,$2,$3,$4)",[id,OWNER_A,w.projectId,{id,ownerId:OWNER_A,projectId:w.projectId,reviewStatus:"review_required",inputRevisions:[],locks:[]}]);
  const input={method:"acceptLogoVector",body:{requestKey:randomUUID(),expected:w.heads,vectorRevisionId:id,acceptEarlierBasis:false}};
  await expect(asRole(db,"authenticated",OWNER_A,()=>db.query("select public.apply_logo_workspace_command($1,$2)",[w.projectId,input]))).rejects.toMatchObject({code:"42501"});
  await db.exec("set session authorization fixture_logo_mutation");
  try{
   const receipt=(await db.query<{value:LogoMutationReceipt}>("select fluid_private.apply_logo_trusted_command($1,$2,$3) value",[w.projectId,input,{vectorRevisionId:id,currentVectorRevisionId:null,expected:w.heads}])).rows[0]!.value;
   expect(receipt.workspace.approvedLogo?.vectorRevisionId).toBe(id);expect(receipt.workspace.approvedLogo?.stageRevisionId).toBe(receipt.revision.id);
   expect((await db.query<{value:unknown}>("select fluid_private.read_logo_trusted_request($1,$2) value",[w.projectId,input])).rows[0]!.value).toEqual(receipt);
  }finally{await db.exec("set session authorization postgres");}
  expect((await db.query("select count(*)::int count from public.logo_approvals")).rows[0]).toEqual({count:1});
 });
 it("trusted restore binds the exact checked target/current IDs and heads before appending",async()=>{
  await resetFixture(db);const w=logoWorkspaceV2Schema.parse(await asRole(db,"authenticated",OWNER_A,async()=>(await db.query<{value:unknown}>("select public.start_logo_project($1) value",[{requestKey:randomUUID(),brief}])).rows[0]!.value));
  const targetId=randomUUID(),currentId=randomUUID();
  for(const id of [targetId,currentId])await db.query("insert into public.logo_vector_revisions(id,owner_id,project_id,record) values($1,$2,$3,$4)",[id,OWNER_A,w.projectId,{id,ownerId:OWNER_A,projectId:w.projectId,reviewStatus:"review_required",inputRevisions:[],locks:[]}]);
  const target=(await db.query<{value:{id:string}}>("select fluid_private.logo_append_stage($1,$2,'vector',$3,'[]') value",[OWNER_A,w.projectId,{vectorRevisionId:targetId,approvalId:null}])).rows[0]!.value;
  await db.query("select fluid_private.logo_append_stage($1,$2,'refinements',$3,'[]')",[OWNER_A,w.projectId,{rasterRevisionIds:[],vectorRevisionId:currentId,approvalId:null,sourceRequestKey:null}]);
  const current=logoWorkspaceV2Schema.parse(await asRole(db,"authenticated",OWNER_A,async()=>(await db.query<{value:unknown}>("select public.get_logo_workspace($1) value",[w.projectId])).rows[0]!.value));
  const input={method:"restoreLogoStage",body:{requestKey:randomUUID(),expected:current.heads,stage:"vector",revisionId:target.id,acceptEarlierBasis:true}},evidence={targetStageRevisionId:target.id,currentVectorRevisionId:currentId,targetVectorRevisionId:targetId,expected:current.heads};
  await db.exec("set session authorization fixture_logo_mutation");
  try{
   for(const forged of [{...evidence,currentVectorRevisionId:targetId},{...evidence,targetVectorRevisionId:currentId},{...evidence,expected:w.heads}])await expect(db.query("select fluid_private.apply_logo_trusted_command($1,$2,$3)",[w.projectId,input,forged])).rejects.toMatchObject({code:"PT409"});
   const restored=(await db.query<{value:LogoMutationReceipt}>("select fluid_private.apply_logo_trusted_command($1,$2,$3) value",[w.projectId,input,evidence])).rows[0]!.value;
   expect(restored.revision.parentRevisionId).toBe(target.id);expect(restored.revision.id).not.toBe(target.id);expect(restored.revision.payload).toMatchObject({vectorRevisionId:targetId,approvalId:null});
  }finally{await db.exec("set session authorization postgres");}
  expect((await db.query("select count(*)::int count from public.logo_stage_revisions where stage='vector'")).rows[0]).toEqual({count:2});
 });

 it("explicit locked restore becomes the lock basis for the next acceptance",async()=>{
  await resetFixture(db);const w=logoWorkspaceV2Schema.parse(await asRole(db,"authenticated",OWNER_A,async()=>(await db.query<{value:unknown}>("select public.start_logo_project($1) value",[{requestKey:randomUUID(),brief}])).rows[0]!.value));
  const lockedId=randomUUID(),unlockedId=randomUUID(),changedId=randomUUID(),locks=captureLogoComponentLocks(separatedLogoDocument(),["synthetic-symbol"]);
  for(const id of [lockedId,unlockedId,changedId])await db.query("insert into public.logo_vector_revisions(id,owner_id,project_id,record) values($1,$2,$3,$4)",[id,OWNER_A,w.projectId,{id,ownerId:OWNER_A,projectId:w.projectId,reviewStatus:"review_required",inputRevisions:[],locks:id===lockedId?locks:[]}]);
  const historical=(await db.query<{value:{id:string}}>("select fluid_private.logo_append_stage($1,$2,'vector',$3,'[]') value",[OWNER_A,w.projectId,{vectorRevisionId:lockedId,approvalId:null}])).rows[0]!.value;
  for(let i=0;i<4;i++)await db.query("select fluid_private.logo_append_stage($1,$2,'refinements',$3,'[]')",[OWNER_A,w.projectId,{rasterRevisionIds:[],vectorRevisionId:unlockedId,approvalId:null,sourceRequestKey:null}]);
  const current=logoWorkspaceV2Schema.parse(await asRole(db,"authenticated",OWNER_A,async()=>(await db.query<{value:unknown}>("select public.get_logo_workspace($1) value",[w.projectId])).rows[0]!.value));
  const restore={method:"restoreLogoStage",body:{requestKey:randomUUID(),expected:current.heads,stage:"vector",revisionId:historical.id,acceptEarlierBasis:true}};
  await db.exec("set session authorization fixture_logo_mutation");let restored:LogoMutationReceipt;
  try{restored=(await db.query<{value:LogoMutationReceipt}>("select fluid_private.apply_logo_trusted_command($1,$2,$3) value",[w.projectId,restore,{targetStageRevisionId:historical.id,currentVectorRevisionId:unlockedId,targetVectorRevisionId:lockedId,expected:current.heads}])).rows[0]!.value;}finally{await db.exec("set session authorization postgres");}
  const basis=(await db.query<{value:string}>("select fluid_private.logo_current_vector_id($1,$2) value",[OWNER_A,w.projectId])).rows[0]!.value;
  const accept={method:"acceptLogoVector",body:{requestKey:randomUUID(),expected:restored.workspace.heads,vectorRevisionId:changedId,acceptEarlierBasis:false}};
  await db.exec("set session authorization fixture_logo_mutation");
  try{await expect(db.query("select fluid_private.apply_logo_trusted_command($1,$2,$3)",[w.projectId,accept,{vectorRevisionId:changedId,currentVectorRevisionId:basis,expected:restored.workspace.heads}])).rejects.toMatchObject({code:"PT409"});}finally{await db.exec("set session authorization postgres");}
  expect(restored.revision.revision).toBeLessThan(current.heads.stageRevisions.refinements);
  expect(basis).toBe(lockedId);expect((await db.query("select count(*)::int count from public.logo_approvals")).rows[0]).toEqual({count:0});
 });

 it("an explicit acceptance supersedes an older refinement for the next edit source",async()=>{
  await resetFixture(db);const w=logoWorkspaceV2Schema.parse(await asRole(db,"authenticated",OWNER_A,async()=>(await db.query<{value:unknown}>("select public.start_logo_project($1) value",[{requestKey:randomUUID(),brief}])).rows[0]!.value));
  const older=randomUUID(),selected=randomUUID();for(const id of [older,selected])await db.query("insert into public.logo_vector_revisions(id,owner_id,project_id,record) values($1,$2,$3,$4)",[id,OWNER_A,w.projectId,{id,ownerId:OWNER_A,projectId:w.projectId,reviewStatus:"review_required",inputRevisions:[],locks:[]}]);
  await db.query("select fluid_private.logo_append_stage($1,$2,'refinements',$3,'[]')",[OWNER_A,w.projectId,{rasterRevisionIds:[],vectorRevisionId:older,approvalId:null,sourceRequestKey:null}]);
  const current=logoWorkspaceV2Schema.parse(await asRole(db,"authenticated",OWNER_A,async()=>(await db.query<{value:unknown}>("select public.get_logo_workspace($1) value",[w.projectId])).rows[0]!.value));
  const input={method:"acceptLogoVector",body:{requestKey:randomUUID(),expected:current.heads,vectorRevisionId:selected,acceptEarlierBasis:false}};
  await db.exec("set session authorization fixture_logo_mutation");try{await db.query("select fluid_private.apply_logo_trusted_command($1,$2,$3)",[w.projectId,input,{vectorRevisionId:selected,currentVectorRevisionId:older,expected:current.heads}]);}finally{await db.exec("set session authorization postgres");}
  expect(await asRole(db,"authenticated",OWNER_A,async()=>(await db.query<{value:unknown}>("select public.read_logo_current_vector($1) value",[w.projectId])).rows[0]!.value)).toEqual({ownerId:OWNER_A,projectId:w.projectId,vectorRevisionId:selected});
 });

 it("vector A then locked refinement B then raster-only refinement retains B for the next locked acceptance",async()=>{
  await resetFixture(db);const w=logoWorkspaceV2Schema.parse(await asRole(db,"authenticated",OWNER_A,async()=>(await db.query<{value:unknown}>("select public.start_logo_project($1) value",[{requestKey:randomUUID(),brief}])).rows[0]!.value));
  const a=randomUUID(),b=randomUUID(),rawUnselected=randomUUID(),locks=captureLogoComponentLocks(separatedLogoDocument(),["synthetic-symbol"]);
  for(const id of [a,b,rawUnselected])await db.query("insert into public.logo_vector_revisions(id,owner_id,project_id,record) values($1,$2,$3,$4)",[id,OWNER_A,w.projectId,{id,ownerId:OWNER_A,projectId:w.projectId,reviewStatus:"review_required",inputRevisions:[],locks:id===b?locks:[]}]);
  await db.query("select fluid_private.logo_append_stage($1,$2,'vector',$3,'[]')",[OWNER_A,w.projectId,{vectorRevisionId:a,approvalId:null}]);
  await db.query("select fluid_private.logo_append_stage($1,$2,'refinements',$3,'[]')",[OWNER_A,w.projectId,{rasterRevisionIds:[],vectorRevisionId:b,approvalId:null,sourceRequestKey:null}]);
  await db.query("select fluid_private.logo_append_stage($1,$2,'refinements',$3,'[]')",[OWNER_A,w.projectId,{rasterRevisionIds:[randomUUID()],vectorRevisionId:null,approvalId:null,sourceRequestKey:randomUUID()}]);
  const current=logoWorkspaceV2Schema.parse(await asRole(db,"authenticated",OWNER_A,async()=>(await db.query<{value:unknown}>("select public.get_logo_workspace($1) value",[w.projectId])).rows[0]!.value));
  const selected=await asRole(db,"authenticated",OWNER_A,async()=>(await db.query<{value:{vectorRevisionId:string}}>("select public.read_logo_current_vector($1) value",[w.projectId])).rows[0]!.value.vectorRevisionId);
  const input={method:"acceptLogoVector",body:{requestKey:randomUUID(),expected:current.heads,vectorRevisionId:rawUnselected,acceptEarlierBasis:false}};
  await db.exec("set session authorization fixture_logo_mutation");
  try{await expect(db.query("select fluid_private.apply_logo_trusted_command($1,$2,$3)",[w.projectId,input,{vectorRevisionId:rawUnselected,currentVectorRevisionId:selected,expected:current.heads}])).rejects.toMatchObject({code:"PT409"});}finally{await db.exec("set session authorization postgres");}
  expect(selected).toBe(b);expect((await db.query("select count(*)::int count from public.logo_approvals")).rows[0]).toEqual({count:0});
 });

});
