import { randomUUID } from "node:crypto";
import { afterAll,beforeAll,beforeEach,describe,expect,it,vi } from "vitest";
vi.mock("server-only",()=>({}));
import { createIdentityTransactionService,IdentityUncertainCommitError,productionIdentityTransactions } from "../../src/server/data/identity-transaction";
import { getProjectIdentity } from "../../src/server/data/identity";
import { transformNames } from "../../src/domain/naming";
import { asRole,createTestDatabase,HASH,OWNER_A,OWNER_B,resetFixture,seedProject,type TestDatabase } from "../database/local-supabase";
import { identityDalAuth,seedIdentityRoot } from "../database/identity-system-database";
import { createIdentityTransactionFixture } from "./fixtures/identity-transaction";

describe("Identity shared validation in one actual local PostgreSQL transaction",()=>{
 let db:TestDatabase,project:string,root:Awaited<ReturnType<typeof seedIdentityRoot>>,fixture:ReturnType<typeof createIdentityTransactionFixture>;
 const auth={userId:OWNER_A};
 beforeAll(async()=>{db=await createTestDatabase();},30_000);afterAll(async()=>{await db?.close();});
 beforeEach(async()=>{await resetFixture(db);project=(await seedProject(db)).id;root=await seedIdentityRoot(db,project);fixture=createIdentityTransactionFixture(db,OWNER_A);});
 const select=()=>({systemVersionId:root.system.id,expectedProjectRevision:root.input.projectRevision,expectedReferenceRevision:root.input.referenceSnapshot.referenceRevision,expectedPreferencesRevision:0,expectedIdentityRevision:0,acceptEarlierBasis:false});
 const refine=()=>{const {systemVersionId,...fences}=select();return {...fences,baseSystemVersionId:systemVersionId,component:"colors" as const,input:{swatches:[{key:"primary",name:" New ",hex:"#abcdef"}],usageNotes:" User palette "},idempotencyKey:"transaction-refine-test-0001"};};
 const service=()=>createIdentityTransactionService(fixture.factory);
 async function snapshot(){return (await db.query<{value:unknown}>("select jsonb_build_object('sessions',(select coalesce(jsonb_agg(to_jsonb(t) order by project_id),'[]') from public.identity_sessions t),'systems',(select jsonb_agg(to_jsonb(t) order by id) from public.identity_system_versions t),'files',(select jsonb_agg(to_jsonb(t) order by system_id,slot) from public.identity_system_files t),'selections',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.identity_selections t),'changes',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.identity_component_changes t),'usages',(select coalesce(jsonb_agg(to_jsonb(t) order by selection_id,slot),'[]') from public.asset_usages t),'assets',(select jsonb_agg(to_jsonb(t) order by id) from public.assets t),'snapshots',(select jsonb_agg(to_jsonb(t) order by project_id,reference_revision) from public.identity_reference_snapshots t)) value")).rows[0]!.value;}
 async function saveContext(context:unknown){await asRole(db,"authenticated",OWNER_A,()=>db.query("select public.append_project_revision($1,$2,$3::jsonb,$4)",[project,root.input.projectRevision,JSON.stringify(context),HASH]));}
 it("keeps production unavailable and rejects extra request identity before acquisition",async()=>{
  await expect(productionIdentityTransactions.select(auth,project,select())).rejects.toMatchObject({code:"integration_unavailable"});
  await expect(service().select(auth,project,{...select(),ownerId:OWNER_B})).rejects.toMatchObject({code:"invalid_input"});expect(fixture.events).toEqual([]);
 });
 it("writes exact owned selection and usages and acknowledges only after COMMIT",async()=>{
  const result=await service().select(auth,project.toUpperCase(),{...select(),systemVersionId:root.system.id.toUpperCase()});
  expect(result.currentSelection.system).toEqual(root.system);expect(result.currentSelection.selection.identityRevision).toBe(1);expect(fixture.events.slice(-2)).toEqual(["COMMIT","release"]);expect(fixture.releases).toEqual([false]);
  const actual=await getProjectIdentity(identityDalAuth(db),project);expect(actual.currentSelection!.selection).toEqual(result.currentSelection.selection);
  expect((await db.query("select count(*)::int count from public.asset_usages")).rows[0]).toEqual({count:2});
 });
 it("holds real project/head/source/asset relation locks through validation and write handoff",async()=>{
  const acquire=fixture.factory.acquire;let held:Array<{name:string;mode:string}> = [];
  fixture.factory.acquire=async(...args)=>{const lease=await acquire(...args),query=lease.connection.query;lease.connection.query=async(sql,parameters)=>{
   if(sql.includes("commit_identity_transaction"))held=(await db.query<{name:string;mode:string}>("select c.relname name,l.mode from pg_locks l join pg_class c on c.oid=l.relation join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and l.granted and l.pid=pg_backend_pid() order by c.relname,l.mode")).rows;
   return query(sql,parameters);
  };return lease;};
  await service().select(auth,project,select());
  for(const name of ["projects","identity_reference_heads","identity_sessions","jobs","job_steps","assets"])expect(held).toContainEqual({name,mode:"RowShareLock"});
  // One local backend proves held PostgreSQL locks; this cannot prove live multi-session contention.
 });
 it.each(["expectedProjectRevision","expectedReferenceRevision","expectedPreferencesRevision","expectedIdentityRevision"] as const)("fences %s without any partial write",async(key)=>{
  const before=await snapshot(),request=select();await expect(service().select(auth,project,{...request,[key]:request[key]+1})).rejects.toMatchObject({code:"conflict"});expect(await snapshot()).toEqual(before);expect(fixture.events).not.toContain("commit_helper");expect(fixture.events.slice(-2)).toEqual(["ROLLBACK","release"]);
 });
 it("preserves a two-edit immutable chain and exactly replays the original intent after a newer head and invalid current URL",async()=>{
  const first=await service().refine(auth,project,refine());
  const second=await service().refine(auth,project,{...refine(),baseSystemVersionId:first.system.id,expectedIdentityRevision:1,component:"typography",input:{styles:[{key:"body",role:"Body",family:"Changed Family",weight:500,style:"italic"}],usageNotes:"Specification"},idempotencyKey:"transaction-refine-test-0002"});
  expect(second.system.input).toEqual(root.input);expect(second.system.board.staleComponents).toEqual(["colors","typography"]);expect(second.system.productionFiles).toEqual([]);
  await saveContext({...root.input.context,competitors:[{id:OWNER_A,name:"Invalid current",relevance:"Retained",origin:"user",selected:true,url:"https://[broken",sources:[]}]});
  const before=await snapshot(),start=fixture.events.length;expect(await service().refine(auth,project,refine())).toEqual(first);expect(await snapshot()).toEqual(before);expect(fixture.events.slice(start)).not.toContain("commit_helper");
  expect((await db.query("select current_selection_id from public.identity_sessions where project_id=$1",[project])).rows[0]).toEqual({current_selection_id:second.selection.id});
 });
 it.each(["selection id","change timestamp","identity revision"])("rejects a schema-valid forged replay %s against original persisted graph and fences",async(kind)=>{
  const first=await service().refine(auth,project,refine()),before=await snapshot();
  fixture.hooks.prepare=value=>{
   const response=value.response as typeof first;
   if(kind==="selection id")response.selection.id=randomUUID();
   if(kind==="change timestamp")response.change.createdAt="2026-01-01T00:00:00Z";
   if(kind==="identity revision"){
    response.selection.identityRevision=2;response.selection.previousSelectionId=randomUUID();
    const proofs=value.proofs as {records:Array<{system:{id:string};selection:typeof first.selection}>};
    const record=proofs.records.find(row=>row.system.id===first.system.id)!;record.selection=structuredClone(response.selection);
   }
  };
  await expect(service().refine(auth,project,refine())).rejects.toMatchObject({code:"integration_unavailable"});expect(await snapshot()).toEqual(before);
 });
 it("treats abort during asynchronous release as uncertain committed delivery without retry",async()=>{
  const abort=new AbortController(),acquire=fixture.factory.acquire;
  fixture.factory.acquire=async(...args)=>{const lease=await acquire(...args),release=lease.connection.release;lease.connection.release=async(discard)=>{await release(discard);abort.abort();};return lease;};
  await expect(service().select(auth,project,select(),abort.signal)).rejects.toBeInstanceOf(IdentityUncertainCommitError);
  expect(fixture.events.filter(event=>event==="COMMIT")).toHaveLength(1);expect(fixture.events.filter(event=>event==="commit_helper")).toHaveLength(1);
  expect((await db.query("select count(*)::int count from public.identity_selections")).rows[0]).toEqual({count:1});
 });
 it("rejects a changed canonical intent for the same refinement key",async()=>{
  await service().refine(auth,project,refine());const before=await snapshot();await expect(service().refine(auth,project,{...refine(),acceptEarlierBasis:true})).rejects.toMatchObject({code:"conflict"});expect(await snapshot()).toEqual(before);
 });
 it("scopes the same refinement key to project and rejects same-owner cross-project source",async()=>{
  await service().refine(auth,project,refine());const other=(await seedProject(db)).id,otherRoot=await seedIdentityRoot(db,other);
  await expect(service().refine(auth,other,{...refine(),expectedProjectRevision:otherRoot.input.projectRevision,expectedReferenceRevision:otherRoot.input.referenceSnapshot.referenceRevision})).rejects.toMatchObject({code:"not_found"});
  const accepted=await service().refine(auth,other,{...refine(),baseSystemVersionId:otherRoot.system.id,expectedProjectRevision:otherRoot.input.projectRevision,expectedReferenceRevision:otherRoot.input.referenceSnapshot.referenceRevision});expect(accepted.system.projectId).toBe(other);
 });
 it.each(["session","snapshot","system","files","selection_and_usage","change","receipt"])("rolls back actual rows/usage at failing %s stage",async(stage)=>{
  const before=await snapshot();fixture.hooks.stage=at=>{if(at===stage)throw new Error("Injected local stage failure");};
  await expect(service().refine(auth,project,refine())).rejects.toMatchObject({code:"integration_unavailable"});expect(await snapshot()).toEqual(before);expect(fixture.releases).toEqual([false]);expect(fixture.events).not.toContain("COMMIT");
 });
 it.each(["session","snapshot","system","files","selection_and_usage","change","receipt"])("rolls back an abort after actual %s writes before COMMIT",async(stage)=>{
  const before=await snapshot(),abort=new AbortController();fixture.hooks.stage=at=>{if(at===stage)abort.abort();};
  await expect(service().refine(auth,project,refine(),abort.signal)).rejects.toMatchObject({code:"integration_unavailable"});expect(await snapshot()).toEqual(before);expect(fixture.events).not.toContain("COMMIT");
 });
 it("rolls back prepare parsing failure and invalid authoritative URL before the write helper",async()=>{
  await saveContext({...root.input.context,competitors:[{id:OWNER_A,name:"Invalid",relevance:"Retained",origin:"user",selected:true,url:"https://[broken",sources:[]}]});
  const before=await snapshot();await expect(service().select(auth,project,{...select(),expectedProjectRevision:root.input.projectRevision+1,acceptEarlierBasis:true})).rejects.toMatchObject({code:"integration_unavailable"});expect(await snapshot()).toEqual(before);expect(fixture.events).not.toContain("commit_helper");
 });
 it("accepts valid WHATWG IPv6/Unicode and uppercase research URL spellings without SQL regex restrictions",async()=>{
  await saveContext({...root.input.context,competitors:[{id:OWNER_A,name:"Valid peer",relevance:"Retained",origin:"research",selected:true,url:"HTTPS://[2001:db8::1]:443/path",sources:[{url:"HTTPS://例え.テスト/path",title:"Source",retrievedAt:root.system.createdAt}]}]});
  const result=await service().select(auth,project,{...select(),expectedProjectRevision:root.input.projectRevision+1,acceptEarlierBasis:true});expect(result.currentSelection.selection.currentBasis.strategy.competitors[0]!.sources[0]!.url).toBe("HTTPS://例え.テスト/path");
 });
 it.each([false,true])("runs full Naming history replay; malformed=%s",async(malformed)=>{
  const input={kind:"tweaks" as const,seed:"Cedar",operations:["uppercase" as const]},output=transformNames(input).candidates[0]!.value;
  const source={id:randomUUID(),value:output,createdAt:root.system.createdAt,origin:"workshop",history:[{id:randomUUID(),input,output:malformed?"Invented result":output,createdAt:root.system.createdAt}]};
  await saveContext({...root.input.context,namingSource:source});const before=await snapshot();
  const action=service().select(auth,project,{...select(),expectedProjectRevision:root.input.projectRevision+1});
  if(malformed){await expect(action).rejects.toMatchObject({code:"integration_unavailable"});expect(await snapshot()).toEqual(before);expect(fixture.events).not.toContain("commit_helper");}else expect((await action).currentSelection.freshness.status).toBe("current");
 });
 it.each(["role","oid","owner"])("rejects mismatched prepared principal %s independently of request claims",async(kind)=>{
  const before=await snapshot();fixture.hooks.prepare=value=>{const principal=value.principal as Record<string,unknown>;if(kind==="role")principal.sessionUserName="foreign_role";if(kind==="oid")principal.sessionUserOid=123456;if(kind==="owner")principal.boundOwnerId=OWNER_B;};
  await expect(service().select(auth,project,select())).rejects.toMatchObject({code:kind==="owner"?"not_found":"integration_unavailable"});expect(await snapshot()).toEqual(before);expect(fixture.events).not.toContain("commit_helper");
 });
 it.each(["role","oid"])("rejects wrong acquired binding %s against actual database session_user",async(kind)=>{
  const before=await snapshot(),acquire=fixture.factory.acquire;
  fixture.factory.acquire=async(...args)=>{const lease=await acquire(...args);lease.binding={...lease.binding,...(kind==="role"?{roleName:"foreign_role"}:{roleOid:123456})};return lease;};
  await expect(service().select(auth,project,select())).rejects.toMatchObject({code:"integration_unavailable"});expect(await snapshot()).toEqual(before);expect(fixture.events).not.toContain("prepare");expect(fixture.events.slice(-2)).toEqual(["ROLLBACK","release"]);
 });
 it("rolls back actual writes when the commit helper returns a malformed receipt",async()=>{
  const before=await snapshot();fixture.hooks.receipt=value=>{value.extra=true;};
  await expect(service().refine(auth,project,refine())).rejects.toMatchObject({code:"integration_unavailable"});expect(await snapshot()).toEqual(before);expect(fixture.events).not.toContain("COMMIT");
 });
 it("hard-discards release failure after acknowledged COMMIT and retains original recovery intent",async()=>{
  fixture.hooks.releaseFailure=true;let caught:unknown;try{await service().refine(auth,project,refine());}catch(error){caught=error;}
  expect(caught).toBeInstanceOf(IdentityUncertainCommitError);expect((caught as IdentityUncertainCommitError).recovery.request).toHaveProperty("idempotencyKey",refine().idempotencyKey);expect(fixture.events.at(-1)).toBe("discard");
  expect(fixture.events.filter(event=>event==="commit_helper")).toHaveLength(1);expect((await db.query("select count(*)::int count from public.identity_component_changes")).rows[0]).toEqual({count:1});
 });
 it("rejects foreign authenticated owner and preacquisition abort; releases a lease aborted during acquisition",async()=>{
  await expect(service().select({userId:OWNER_B},project,select())).rejects.toMatchObject({code:"not_found"});expect(fixture.releases).toEqual([false]);
  fixture.events.length=0;const abort=new AbortController();abort.abort();await expect(service().select(auth,project,select(),abort.signal)).rejects.toMatchObject({code:"integration_unavailable"});expect(fixture.events).toEqual([]);
  const acquiring=new AbortController(),original=fixture.factory.acquire;fixture.factory.acquire=async(...args)=>{const lease=await original(...args);acquiring.abort();return lease;};
  await expect(service().select(auth,project,select(),acquiring.signal)).rejects.toMatchObject({code:"integration_unavailable"});expect(fixture.events).not.toContain("BEGIN");expect(fixture.releases).toEqual([false,false]);
 });
 it("discards a connection on rollback acknowledgment failure and on release failure",async()=>{
  fixture.hooks.prepare=value=>{value.extra=true;};fixture.hooks.rollbackFailure=true;
  await expect(service().select(auth,project,select())).rejects.toMatchObject({code:"integration_unavailable"});expect(fixture.releases).toEqual([true]);
  fixture.hooks.rollbackFailure=false;fixture.hooks.releaseFailure=true;await expect(service().select(auth,project,select())).rejects.toMatchObject({code:"integration_unavailable"});expect(fixture.events.at(-1)).toBe("discard");
 });
 it.each(["lost_before","lost_after"] as const)("retains exact refinement key after %s COMMIT acknowledgment and never retries automatically",async(mode)=>{
  fixture.hooks.commitAcknowledgment=mode;let caught:unknown;
  try{await service().refine(auth,project,refine());}catch(error){caught=error;}
  expect(caught).toBeInstanceOf(IdentityUncertainCommitError);const recovery=(caught as IdentityUncertainCommitError).recovery;expect(recovery.operation).toBe("refinement");expect(recovery.request).toMatchObject({idempotencyKey:refine().idempotencyKey,input:{swatches:[{key:"primary",name:"New",hex:"#ABCDEF"}],usageNotes:"User palette"}});
  expect(fixture.events.filter(event=>event==="commit_helper")).toHaveLength(1);expect(fixture.releases).toEqual([true]);fixture.hooks.commitAcknowledgment=undefined;
  const retry=await service().refine(auth,project,recovery.request);expect(retry.change.after).toEqual({swatches:[{key:"primary",name:"New",hex:"#ABCDEF"}],usageNotes:"User palette"});
  expect((await db.query("select count(*)::int count from public.identity_component_changes")).rows[0]).toEqual({count:1});
 });
 it("requires selection reconciliation after uncertain COMMIT and never invents a retry key",async()=>{
  fixture.hooks.commitAcknowledgment="lost_after";let caught:unknown;try{await service().select(auth,project,select());}catch(error){caught=error;}
  const recovery=(caught as IdentityUncertainCommitError).recovery;expect(recovery).toEqual({operation:"selection",action:"read_before_explicit_retry",request:select()});expect(recovery.request).not.toHaveProperty("idempotencyKey");expect(fixture.events.filter(event=>event==="commit_helper")).toHaveLength(1);
  expect((await getProjectIdentity(identityDalAuth(db),project)).currentSelection!.system.id).toBe(root.system.id);
 });
});
