import { expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { OpenAITransportError } from "../../src/server/ai/openai-transport";
import { observeBackgroundResponse, type BackgroundResponseJournal, type BackgroundResponseState } from "../../worker/strategy-background-response";
function fixture() {
 let time=0;
 const state: BackgroundResponseState={dispatchState:"not_dispatched",responseId:null,terminalResponse:null,cancelRequested:false,executionDeadlineAt:240000,observationDeadlineAt:540000};
 const queued={body:{id:"resp_synthetic",status:"queued"},requestId:"req_synthetic"};
 const completed={body:{id:"resp_synthetic",status:"completed",output:[{type:"message",text:"Synthetic output"}]},requestId:"req_synthetic"};
 const provider={countInputTokens:vi.fn().mockResolvedValue(10),createResponse:vi.fn().mockResolvedValue(queued),retrieveResponse:vi.fn().mockResolvedValue(completed),cancelResponse:vi.fn().mockResolvedValue({body:{id:"resp_synthetic",status:"cancelled"},requestId:"req_cancel"})};
 const journal: BackgroundResponseJournal={
  load:vi.fn(async()=>({...state})),beginDispatch:vi.fn(async()=>{if(state.dispatchState!=="not_dispatched")return false;state.dispatchState="dispatching";return true;}),
  recordRejection:vi.fn(async(_requestId,reason)=>{state.dispatchState="rejected";state.rejectionReason=reason??"provider_rejected";}),recordHandle:vi.fn(async id=>{state.responseId=id;state.dispatchState="accepted";}),recordTerminal:vi.fn(async response=>{state.terminalResponse=response;}),
 };
 const controller=new AbortController();
 const run=(pollWindowMs=15000)=>observeBackgroundResponse({journal,provider,request:{model:"synthetic-model",store:true,background:false},requestKey:"synthetic-key",signal:controller.signal,now:()=>time,wait:async ms=>{time+=ms;},pollWindowMs});
 return {state,provider,journal,controller,run,completed,queued,setTime:(n:number)=>{time=n;}};
}
it("creates once with temporary storage, then persists a terminal response",async()=>{
 const f=fixture();expect(await f.run()).toEqual({kind:"terminal",response:f.completed});
 expect(f.provider.createResponse).toHaveBeenCalledExactlyOnceWith({model:"synthetic-model",store:false,background:true,stream:false},"synthetic-key",f.controller.signal);
 expect(f.state.terminalResponse).toEqual(f.completed);
 await f.run();expect(f.provider.createResponse).toHaveBeenCalledOnce();expect(f.provider.retrieveResponse).toHaveBeenCalledOnce();
});
it("resumes a saved response with GET after an observer connection failure",async()=>{
 const f=fixture();f.provider.retrieveResponse.mockRejectedValueOnce(new Error("synthetic_disconnect"));
 expect(await f.run()).toMatchObject({kind:"pending",responseId:"resp_synthetic",reason:"observation_unavailable"});
 expect(await f.run()).toMatchObject({kind:"terminal"});expect(f.provider.createResponse).toHaveBeenCalledOnce();
});
it("never repeats a create when its acknowledgement and response identity are missing",async()=>{
 const f=fixture();f.provider.createResponse.mockRejectedValueOnce(new Error("synthetic_lost_ack"));
 expect(await f.run()).toMatchObject({kind:"unresolved",reason:"provider_identity_unknown"});
 expect(await f.run()).toMatchObject({kind:"unresolved",reason:"provider_identity_unknown"});expect(f.provider.createResponse).toHaveBeenCalledOnce();
});
it("recovers a lost handle-write acknowledgement by reading the same persisted identity",async()=>{
 const f=fixture();f.journal.recordHandle=vi.fn(async id=>{f.state.responseId=id;f.state.dispatchState="accepted";throw new Error("synthetic_ack_lost");});
 expect(await f.run()).toMatchObject({kind:"terminal"});expect(f.provider.createResponse).toHaveBeenCalledOnce();
});
it("does not generate again after a terminal persistence acknowledgement is lost",async()=>{
 const f=fixture();f.journal.recordTerminal=vi.fn(async response=>{f.state.terminalResponse=response;throw new Error("synthetic_ack_lost");});
 expect(await f.run()).toMatchObject({kind:"pending",reason:"persistence_unavailable"});
 expect(await f.run()).toMatchObject({kind:"terminal"});expect(f.provider.createResponse).toHaveBeenCalledOnce();expect(f.provider.retrieveResponse).toHaveBeenCalledOnce();
});
it("cancels only the saved response when the user requested Stop",async()=>{
 const f=fixture();f.state.dispatchState="accepted";f.state.responseId="resp_synthetic";f.state.cancelRequested=true;
 expect(await f.run()).toMatchObject({kind:"terminal",response:{body:{status:"cancelled"}}});
 expect(f.provider.createResponse).not.toHaveBeenCalled();expect(f.provider.cancelResponse).toHaveBeenCalledExactlyOnceWith("resp_synthetic",f.controller.signal);
});
it("does not confuse worker shutdown with user cancellation",async()=>{
 const f=fixture();f.state.dispatchState="accepted";f.state.responseId="resp_synthetic";f.controller.abort();
 expect(await f.run()).toMatchObject({kind:"pending",reason:"observer_stopped"});expect(f.provider.cancelResponse).not.toHaveBeenCalled();expect(f.provider.createResponse).not.toHaveBeenCalled();
});
it("preserves a known terminal response arriving together with worker shutdown",async()=>{
 const f=fixture();f.provider.createResponse.mockImplementation(async()=>{f.controller.abort();return f.completed;});
 expect(await f.run()).toMatchObject({kind:"terminal"});expect(f.journal.recordTerminal).toHaveBeenCalledOnce();
});
it("retains unknown identity and refuses a mismatched observation",async()=>{
 const f=fixture();f.state.dispatchState="accepted";f.state.responseId="resp_synthetic";f.provider.retrieveResponse.mockResolvedValue({body:{id:"resp_different",status:"completed"},requestId:null});
 expect(await f.run()).toMatchObject({kind:"unresolved",reason:"provider_identity_mismatch"});expect(f.journal.recordTerminal).not.toHaveBeenCalled();
});
it("enforces original execution and observation deadlines without new inference",async()=>{
 const f=fixture();f.state.dispatchState="accepted";f.state.responseId="resp_synthetic";f.setTime(240001);
 expect(await f.run()).toMatchObject({kind:"terminal"});expect(f.provider.cancelResponse).toHaveBeenCalledOnce();
 const expired=fixture();expired.state.dispatchState="accepted";expired.state.responseId="resp_synthetic";expired.setTime(540001);
 expect(await expired.run()).toMatchObject({kind:"unresolved",reason:"observation_expired"});expect(expired.provider.retrieveResponse).not.toHaveBeenCalled();
});
it("records a confirmed provider rejection and never submits it again",async()=>{
 const f=fixture();f.provider.createResponse.mockRejectedValue(new OpenAITransportError("request_rejected","req_rejected"));
 expect(await f.run()).toMatchObject({kind:"not_dispatched",reason:"provider_rejected"});await f.run();expect(f.provider.createResponse).toHaveBeenCalledOnce();
});

it("records no dispatch when shutdown arrives during the dispatch-journal acknowledgement",async()=>{
 const f=fixture();f.journal.beginDispatch=vi.fn(async()=>{f.state.dispatchState="dispatching";f.controller.abort();return true;});
 expect(await f.run()).toEqual({kind:"not_dispatched",reason:"observer_stopped"});
 expect(f.provider.createResponse).not.toHaveBeenCalled();
 expect(f.journal.recordRejection).toHaveBeenCalledWith(null,"observer_stopped");
 expect(await f.run()).toEqual({kind:"not_dispatched",reason:"observer_stopped"});
});
it("does not dispatch when the original deadline expires during journal acknowledgement",async()=>{
 const f=fixture();f.journal.beginDispatch=vi.fn(async()=>{f.state.dispatchState="dispatching";f.setTime(240001);return true;});
 expect(await f.run()).toEqual({kind:"not_dispatched",reason:"cancelled"});
 expect(f.provider.createResponse).not.toHaveBeenCalled();
});
