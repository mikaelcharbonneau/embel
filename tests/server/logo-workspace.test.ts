import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createLogoWorkspaceService } from "../../src/server/data/logo-workspace";
import { createLogoTransactionService } from "../../src/server/data/logo-transaction";
import { OWNER_A, OWNER_B } from "../database/local-supabase";
import type { AuthenticatedContext } from "../../src/server/auth/context";
const brief = { name: "Logo", activity: "Studio", audience: "Founders", personality: "Calm", logoTypes: ["wordmark"] };
const auth = (rpc: (...args: unknown[]) => unknown) => ({ userId: OWNER_A, client: { rpc } }) as unknown as AuthenticatedContext;
describe("Logo workspace shared DAL boundary", () => {
  it("validates strict browser input before any RPC", async () => {
    const rpc = vi.fn(); const service = createLogoWorkspaceService();
    await expect(service.startLogoProject(auth(rpc), { requestKey: randomUUID(), brief, ownerId: OWNER_B })).rejects.toMatchObject({ code: "invalid_input" });
    expect(rpc).not.toHaveBeenCalled();
  });
  it("rejects unvalidated account identity before any RPC", async () => {
    const rpc = vi.fn(); const service = createLogoWorkspaceService();
    await expect(service.startLogoProject({ ...auth(rpc), userId: "bad" }, { requestKey: randomUUID(), brief })).rejects.toMatchObject({ code: "unauthenticated" });
    expect(rpc).not.toHaveBeenCalled();
  });
  it("keeps missing privileged producer/connection capabilities unavailable", async () => {
    const service = createLogoTransactionService(null);
    await expect(service.run(auth(vi.fn()), randomUUID(), { method: "acceptLogoVector", body: {} })).rejects.toMatchObject({ code: "invalid_input" });
  });
  it("ordinary owner-scoped request lookup does not require a project or create work", async () => {
    const rpc = vi.fn(async () => ({ data: { status: "not_found" }, error: null }));
    const requestKey = randomUUID(); expect(await createLogoWorkspaceService().readLogoProjectCreation(auth(rpc), requestKey)).toEqual({ status: "not_found" });
    expect(rpc).toHaveBeenCalledExactlyOnceWith("read_logo_project_creation", { p_request_key: requestKey });
  });
  it("a lost creation response retains the exact null-project intent without retry", async () => {
    const rpc = vi.fn(async () => { throw new Error("response lost"); });
    const input = { requestKey: randomUUID(), brief };
    await expect(createLogoWorkspaceService().startLogoProject(auth(rpc), input)).rejects.toMatchObject({ name: "LogoUncertainCommitError", recovery: { projectId: null, input } });
    expect(rpc).toHaveBeenCalledTimes(1);
  });
  it("a cancelled unsent creation does not make a request", async () => {
    const rpc = vi.fn(), controller = new AbortController(); controller.abort();
    await expect(createLogoWorkspaceService().startLogoProject(auth(rpc), { requestKey: randomUUID(), brief }, controller.signal)).rejects.toMatchObject({ code: "integration_unavailable" });
    expect(rpc).not.toHaveBeenCalled();
  });
  it("routes vector restore only through the trusted byte-verifying mutation capability",async()=>{
    const rpc=vi.fn(async()=>({data:null,error:null})),run=vi.fn(async()=>{throw Object.assign(Error("geometry lock changed"),{code:"conflict"});});
    const service=createLogoWorkspaceService({transactions:{run}}),project=randomUUID();
    const body={requestKey:randomUUID(),expected:{projectRevision:1,referenceRevision:0,preferencesRevision:0,workspaceRevision:0,stageRevisions:{brief_references:0,concepts:0,vector:0,refinements:0,directions:0,deliverables:0}},stage:"vector",revisionId:randomUUID(),acceptEarlierBasis:true};
    await expect(service.restoreLogoStage(auth(rpc),project,body)).rejects.toMatchObject({code:"conflict"});
    expect(run).toHaveBeenCalledOnce();expect(rpc).not.toHaveBeenCalled();
  });

});

describe("lightweight owner-fenced concept batch discovery",()=>{
 it("lists only summaries through the fixed owned paging RPC",async()=>{
  const projectId=randomUUID(),item={id:randomUUID(),requestKey:randomUUID(),createdAt:"2026-10-07T00:00:00Z"};
  const rpc=vi.fn(async()=>({data:{ownerId:OWNER_A,projectId,items:[item],nextCursor:null},error:null}));
  expect(await createLogoWorkspaceService().listLogoConceptBatches(auth(rpc),projectId)).toEqual({ownerId:OWNER_A,projectId,items:[item],nextCursor:null});
  expect(rpc).toHaveBeenCalledWith("list_logo_workspace_records",{p_project_id:projectId,p_kind:"concept_batch",p_query:{limit:20}});
 });
 it("rejects a foreign page rather than exposing its request keys",async()=>{
  const projectId=randomUUID(),rpc=vi.fn(async()=>({data:{ownerId:OWNER_B,projectId,items:[],nextCursor:null},error:null}));
  await expect(createLogoWorkspaceService().listLogoConceptBatches(auth(rpc),projectId)).rejects.toMatchObject({code:"not_found"});
 });
});


describe("authoritative current vector projection",()=>{
 it("reads the server-selected current vector without guessing from stage types",async()=>{
  const projectId=randomUUID(),vectorRevisionId=randomUUID(),rpc=vi.fn(async()=>({data:{ownerId:OWNER_A,projectId,vectorRevisionId},error:null}));
  expect(await createLogoWorkspaceService().readLogoCurrentVectorRevisionId(auth(rpc),projectId)).toBe(vectorRevisionId);
  expect(rpc).toHaveBeenCalledWith("read_logo_current_vector",{p_project_id:projectId});
 });
 it("rejects foreign selection metadata",async()=>{
  const projectId=randomUUID(),rpc=vi.fn(async()=>({data:{ownerId:OWNER_B,projectId,vectorRevisionId:null},error:null}));
  await expect(createLogoWorkspaceService().readLogoCurrentVectorRevisionId(auth(rpc),projectId)).rejects.toMatchObject({code:"not_found"});
 });
});
