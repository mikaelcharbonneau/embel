import { randomUUID } from "node:crypto";
import { describe,expect,it,vi } from "vitest";
vi.mock("server-only",()=>({}));
import { createLogoTransactionService } from "../../src/server/data/logo-transaction";
import type { AuthenticatedContext } from "../../src/server/auth/context";
import type { IdentityConnectionFactory } from "../../src/server/data/identity-transaction";
import type { LogoExpectedHeads } from "../../src/domain/logo-workspace";
const ownerId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",projectId=randomUUID(),vectorId=randomUUID(),revisionId=randomUUID(),requestKey=randomUUID();
const expected:LogoExpectedHeads={projectRevision:1,referenceRevision:0,preferencesRevision:0,workspaceRevision:0,stageRevisions:{brief_references:0,concepts:0,vector:0,refinements:0,directions:0,deliverables:0}};
const command={method:"acceptLogoVector",body:{requestKey,expected,vectorRevisionId:vectorId,acceptEarlierBasis:false}};
const receipt={ownerId,projectId,requestKey,revision:{version:2,id:revisionId,ownerId,projectId,stage:"vector",revision:1,parentRevisionId:null,inputRevisions:[],inputHash:"a".repeat(64),payload:{vectorRevisionId:vectorId,approvalId:null},createdAt:"2026-10-07T00:00:00Z"},workspace:{version:2,ownerId,projectId,heads:{...expected,workspaceRevision:1,stageRevisions:{...expected.stageRevisions,vector:1}},stages:{brief_references:null,concepts:null,vector:{stage:"vector",id:revisionId,revision:1},refinements:null,directions:null,deliverables:null},approvedLogo:null,staleStages:[],capabilities:{save:{status:"available"},upload:{status:"unavailable",reason:"test"},generate:{status:"unavailable",reason:"test"},convert:{status:"unavailable",reason:"test"},export:{status:"unavailable",reason:"test"}}}};
function fixture(){
 const events:string[]=[];let replay=false,lost=false,readFailed=false;
 const factory:IdentityConnectionFactory={async acquire(){events.push("acquire");return {binding:{ownerId,roleName:"fixture_logo_writer",roleOid:123},connection:{async query(sql){events.push(sql);if(sql.includes("session_user"))return {rows:[{role_name:"fixture_logo_writer",role_oid:123}]};if(sql.includes("read_logo_trusted_request")&&readFailed)throw Object.assign(Error("connection reset"),{code:"ECONNRESET"});if(sql.includes("read_logo_trusted_request"))return {rows:[{value:replay?receipt:null}]};if(sql.includes("apply_logo_trusted_command")){replay=true;return {rows:[{value:receipt}]};}if(sql==="COMMIT"&&lost)throw Error("ack lost");return {rows:[]};},release(discard){events.push(`release:${discard}`);},discard(){events.push("discard");}}};}};
 const producer=vi.fn(async()=>{events.push("producer-byte-work");return {vectorRevisionId:vectorId};});
 return {events,factory,producer,replay:()=>{replay=true;},loseCommit:()=>{lost=true;},loseRead:()=>{readFailed=true;},service:createLogoTransactionService(factory,{acceptLogoVector:producer})};
}
describe("trusted fixed logo mutation transaction",()=>{
 it("does byte/producer work before BEGIN and commits only exact parsed receipt",async()=>{
  const f=fixture();expect(await f.service.run({userId:ownerId} as AuthenticatedContext,projectId,command)).toEqual(receipt);
  expect(f.events.indexOf("producer-byte-work")).toBeLessThan(f.events.indexOf("BEGIN"));expect(f.events).toContain("COMMIT");
 });
 it("exact durable replay skips producer work",async()=>{
  const f=fixture();f.replay();expect(await f.service.run({userId:ownerId} as AuthenticatedContext,projectId,command)).toEqual(receipt);expect(f.producer).not.toHaveBeenCalled();
 });
 it("lost commit acknowledgement keeps exact request and discards the connection",async()=>{
  const f=fixture();f.loseCommit();await expect(f.service.run({userId:ownerId} as AuthenticatedContext,projectId,command)).rejects.toMatchObject({name:"LogoUncertainCommitError",recovery:{projectId,input:command}});expect(f.events).toContain("release:true");expect(f.producer).toHaveBeenCalledOnce();
 });
 it("discards a connection after a receipt-reader transport failure",async()=>{
  const f=fixture();f.loseRead();await expect(f.service.run({userId:ownerId} as AuthenticatedContext,projectId,command)).rejects.toMatchObject({code:"integration_unavailable"});
  expect(f.events).toContain("release:true");expect(f.events).not.toContain("release:false");expect(f.events).not.toContain("BEGIN");expect(f.producer).not.toHaveBeenCalled();
 });
 it("no producer capability never substitutes a caller proof",async()=>{
  const f=fixture();await expect(createLogoTransactionService(f.factory).run({userId:ownerId} as AuthenticatedContext,projectId,command)).rejects.toMatchObject({code:"integration_unavailable"});expect(f.events).not.toContain("BEGIN");
 });
});
