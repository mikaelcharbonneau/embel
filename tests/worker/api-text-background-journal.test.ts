import { expect,it,vi } from "vitest";
vi.mock("server-only",()=>({}));
import { ApiTextBackgroundJournal } from "../../worker/api-text-background-journal";
import type { JobDatabase } from "../../worker/postgres-store";
const jobId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",lease="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const message={version:1 as const,jobId,policyIdentity:"a".repeat(64),deploymentId:"synthetic-deployment",dispatchIdentity:"b".repeat(64)};
const state={dispatchState:"not_dispatched",responseId:null,terminalResponse:null,cancelRequested:false,executionDeadlineAt:240000,observationDeadlineAt:540000};
function fixture(value:unknown=state){
 const query=vi.fn<JobDatabase["query"]>().mockResolvedValue({rows:[{result:{jobId,stepKey:"respond",value}}]});
 return {query,journal:new ApiTextBackgroundJournal({query},message,{jobId,leaseToken:lease,stepKey:"respond"})};
}
it("binds every call to the same admitted descriptor and lease, never an owner selector",async()=>{
 const f=fixture();expect(await f.journal.load()).toEqual(state);
 expect(f.query).toHaveBeenCalledExactlyOnceWith("select public.api_text_dispatch_action($1::jsonb,$2,$3::jsonb) as result",[JSON.stringify(message),"background",JSON.stringify([lease,"respond","load",null])]);
});
it("rejects a foreign job before querying",()=>{
 const f=fixture();expect(()=>new ApiTextBackgroundJournal({query:f.query},message,{jobId:lease,leaseToken:lease,stepKey:"respond"})).toThrow("Background job mismatch");expect(f.query).not.toHaveBeenCalled();
});
it("requires an exact job and step on every database acknowledgement",async()=>{
 const f=fixture();f.query.mockResolvedValue({rows:[{result:{jobId:lease,stepKey:"respond",value:state}}]});
 await expect(f.journal.load()).rejects.toThrow("Background journal binding mismatch");
});
it.each([
 {...state,executionDeadlineAt:600000},
 {...state,dispatchState:"accepted"},
 {...state,responseId:"resp_foreign"},
 {...state,terminalResponse:{body:{id:"resp_fixture",status:"completed"},requestId:null}},
])("rejects inconsistent persisted state",async value=>{await expect(fixture(value).journal.load()).rejects.toThrow();});
it("accepts only a boolean dispatch acknowledgement and never retries",async()=>{
 const f=fixture(true);expect(await f.journal.beginDispatch()).toBe(true);expect(f.query).toHaveBeenCalledOnce();
 const bad=fixture("true");await expect(bad.journal.beginDispatch()).rejects.toThrow();expect(bad.query).toHaveBeenCalledOnce();
});
it("persists a bounded terminal envelope, rejecting pending output before querying",async()=>{
 const f=fixture(true);await f.journal.recordTerminal({body:{id:"resp_fixture",status:"completed"},requestId:"req_fixture"});
 expect(f.query).toHaveBeenCalledOnce();
 await expect(f.journal.recordTerminal({body:{id:"resp_fixture",status:"in_progress"},requestId:null})).rejects.toThrow();
 expect(f.query).toHaveBeenCalledOnce();
});
it("never treats an uncertain database write as acknowledged",async()=>{
 const f=fixture();f.query.mockRejectedValue(new Error("synthetic_disconnect"));
 await expect(f.journal.recordHandle("resp_fixture")).rejects.toThrow("synthetic_disconnect");expect(f.query).toHaveBeenCalledOnce();
});
