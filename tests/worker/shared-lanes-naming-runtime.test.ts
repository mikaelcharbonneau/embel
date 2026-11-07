import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {describe,expect,it,vi} from 'vitest';
vi.mock('server-only',()=>({}));
import type {NamingModelOutput,NamingStageRequest} from '../../src/domain/naming-brain';
import {createNamingBrainPolicy} from '../../src/server/ai/naming-brain/policy';
import {buildNamingManagedRequest} from '../../src/server/ai/naming-brain/prompts';
import {createNamingManagedProtocol,type ManagedCreateRequest} from '../../src/server/ai/naming-brain/protocol';
import {createNamingReferenceReader} from '../../src/server/ai/naming-brain/source-reader';
import {createSharedNamingLaneEngine} from '../../worker/shared-lanes/naming';
import {sharedSlotLeaseSchema,sharedPendingExecutionSchema} from '../../worker/shared-pool/contracts';
import {namingPreferencesRuntimeFingerprint} from '../../worker/naming-brain-configuration';
import {createSharedWorkerFixture,OWNER_A,OWNER_B} from '../database/shared-worker-fixture';
import {brainRpc,initialIntent,brainPreferences} from '../database/naming-brain-fixture';
import {evidenceDirectorOutput} from '../fixtures/naming-evidence-plan';
const approaches = ["classical_roots", "other_languages", "people_places", "stories_culture"] as const;
const referenceUrl = "https://en.wikipedia.org/wiki/Synthetic_fixture";
const referenceText = "An explicitly fictional reference passage supports the imaginary fixture attribution.";
type Session = { request: NamingStageRequest; wire: ManagedCreateRequest; id: string; turnId: string; agentId: string; terminal: boolean;
  attempt: number; items: Record<string, unknown>[]; controller?: ReadableStreamDefaultController<Uint8Array>; reply?: { status: string; sourceKey: string; excerpt?: string } };


/** Real shared-slot SQL/store/runner and native SDK. Only provider HTTP, DNS,
 * reference pages and model content are synthetic; no paid/live proof. */
async function fixture(mode:'sourced'|'missing'|'irrelevant',options:{loseReceiptAcknowledgement?:boolean;loseFinishAcknowledgement?:boolean}={}){
 const f=await createSharedWorkerFixture({probe:false}),db=f.db;
 await f.seedUser(OWNER_A);await f.seedUser(OWNER_B);
 // The released Naming chain the engine requires (its lease expiry needs delivery recovery).
 for(const file of ['shared_worker_naming.sql','shared_naming_brainstorm.sql','shared_naming_brainstorm_delivery_recovery.sql','shared_naming_lease_expiry.sql'])
  await db.exec(await readFile(new URL(`../../supabase/candidates/${file}`,import.meta.url),'utf8'));
 const policy=createNamingBrainPolicy('gpt-6-luna'),workerId='synthetic-shared-naming';
 const identity=(await db.query<{h:string}>("select encode(sha256(convert_to($1::jsonb::text,'UTF8')),'hex') h",[policy])).rows[0]!.h;
 const slot=await f.seedSlot({lane:'naming',policies:[{operation:'naming.generate',policyIdentity:identity,policy}]});
 const deploymentId=slot.deploymentId;
 await db.exec(`grant execute on function public.shared_naming_worker_action(jsonb,jsonb,text,jsonb) to ${slot.roleName}`);
 await db.query('insert into fluid_private.shared_naming_slot_configuration(slot_id,readiness_fingerprint) values($1,$2)',[slot.slotId,namingPreferencesRuntimeFingerprint()]);
 const lease=sharedSlotLeaseSchema.parse(await f.lease(slot));
 const project=(await brainRpc<{id:string}>(db,'create_project',['naming_only','Shared SDK synthetic',{description:'Synthetic naming brief'},'a'.repeat(64)])).id;
 await brainRpc(db,'save_naming_preferences',[project,0,{...brainPreferences,approaches}]);
 let pageReads=0,submits=0,ordinal=0,researchSaved=false,directorSaved=false;const transportErrors:string[]=[];const networkOperations:string[]=[];let lostReceiptAck=false,lostFinishAck=false;
 const requests=new Map<string,NamingStageRequest>(),sessions=new Map<string,Session>(),creates:string[]=[],dispatchOrder:string[]=[];
 const emit=(session:Session,event:Record<string,unknown>)=>session.controller!.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({...event,event_id:`fixture-shared-${++ordinal}`})}\n\n`));
 const turn=(session:Session)=>({id:session.turnId,session_id:session.id,agent_id:session.agentId,subagent_id:null,object:'agent.session.turn',status:session.terminal?'completed':'waiting',error:null,usage:null,created_at:1,started_at:1,completed_at:session.terminal?2:null});
  const sessionBody = (session: Session, required = true) => ({ id: session.id, object: "agent.session", agent: { ...session.wire.agent, id: session.agentId }, environment: session.wire.environment, metadata: session.wire.metadata,
    status: session.terminal ? "idle" : required && session.request.role === "researcher" ? "requires_action" : "running", required_actions: !session.terminal && required && session.request.role === "researcher" ? [{ type: "function_call", name: "read_reference", call_id: `fixture-read-${session.attempt}`, turn_id: session.turnId, arguments: { url: `${referenceUrl}_${session.attempt}` } }] : [], usage: null });
  const emitReference = (session: Session) => {
    const url = `${referenceUrl}_${session.attempt}`, offset = session.items.length;
    const web = { id: `fixture-web-${session.attempt}`, type: "web_search_call", status: "completed", turn_id: session.turnId, action: { type: "open_page", url } };
    const read = { id: `fixture-read-item-${session.attempt}`, type: "function_call", status: "in_progress", turn_id: session.turnId, name: "read_reference", call_id: `fixture-read-${session.attempt}`, arguments: JSON.stringify({ url }) };
    session.items.push(web, read); emit(session, { type: "agent.session.turn.item.done", session_id: session.id, turn_id: session.turnId, output_index: offset, item: web }); emit(session, { type: "agent.session.turn.item.added", session_id: session.id, turn_id: session.turnId, output_index: offset + 1, item: read }); emit(session, { type: "agent.session.requires_action", session: sessionBody(session) });
  };
  const output = (session: Session): NamingModelOutput => {
    const input = session.request.input;
    if (input.role === "researcher") return { role: "researcher", territories: [{ territoryId: "reference", title: "Synthetic reference", direction: "Explore the actually retained fixture passage.", sourceKeys: [session.reply!.sourceKey] }, { territoryId: "contrast", title: "Contrasts", direction: "Vary imagery and sounds.", sourceKeys: [] }],
      facts: session.reply!.status === "retrieved" ? [{ claimKey: "fixture-fact", statement: session.reply!.excerpt!, sourceKeys: [session.reply!.sourceKey], status: "unverified" }] : [], interpretations: [], uncertainties: session.reply!.status === "retrieved" ? ["The first observed reference returned no passage; a second allowed read supplied the retained text."] : ["Both observed reference requests returned no retained passage."] };
    if (input.role === "director") return evidenceDirectorOutput(session.request, mode === "missing" ? [...approaches] : mode === "irrelevant" ? ["classical_roots"] : []);
    if (input.role === "creator") return { role: "creator", assignmentKey: input.assignment.assignmentKey, candidates: Array.from({ length: input.assignment.targetCount }, (_, index) => ({ candidateKey: `candidate-${index}`, value: `Synthetic${session.request.providerCallKey.slice(4, 7)}Name${index}`, primaryApproach: input.assignment.primaryApproach, additionalApproaches: [], territoryId: input.assignment.territoryId, constructionKey: input.assignment.constructionKey, rationale: "An explicitly fictional attribution fixture.", caution: null,
      claims: [{ claimKey: "fixture-attribution", requirement: "primary_approach", statement: input.assignment.sources[0]!.excerpt!, sourceKeys: input.assignment.sourceKeys, status: "unverified" }] })) };
    if (input.role === "curator") return { role: "curator", annotations: [], gaps: [] };
    const assignments = new Map(input.review.artifacts.map(row => [row.artifactKey, row.assignmentKey]));
    return { role: "verifier", findings: input.review.candidates.flatMap(candidate => candidate.claims.map(claim => ({ assignmentKey: assignments.get(candidate.artifactKey)!, candidateKey: candidate.candidateKey, claimKey: claim.claimKey, status: "supported", supportedWording: claim.statement, sourceKeys: claim.sourceKeys,
      evidence: [{ sourceKey: claim.sourceKeys[0]!, start: 0, end: referenceText.length, quote: referenceText }], supportsPrimaryApproach: true, explanation: "Independent fixture Verifier quotes the exact acquired passage." }))) };
  };
  const complete = (session: Session) => {
    if (session.request.role === "researcher") for (const [index, item] of session.items.entries()) if (item.type === "function_call" && item.status !== "completed") { session.items[index] = { ...item, status: "completed" }; emit(session, { type: "agent.session.turn.item.done", session_id: session.id, turn_id: session.turnId, output_index: index, item: session.items[index] }); }
    const item = { id: `final_${session.id}`, type: "message", role: "assistant", phase: "final_answer", status: "completed", turn_id: session.turnId, content: [{ type: "output_text", text: JSON.stringify(output(session)) }] };
    session.items.push(item); emit(session, { type: "agent.session.turn.item.done", session_id: session.id, turn_id: session.turnId, output_index: session.items.length - 1, item });
    session.terminal = true; emit(session, { type: "agent.session.turn.completed", session_id: session.id, turn_id: session.turnId, turn: turn(session) }); session.controller!.close();
  };
  const protocol = createNamingManagedProtocol({ apiKey: "synthetic-never-live-key", localPrototype: true, fetch: async (incoming, init) => {try{
    const outgoing = new Request(incoming, init), url = new URL(outgoing.url), path = url.pathname;networkOperations.push(outgoing.method);
    expect(url.origin).toBe("https://api.openai.com");
    if (outgoing.method === "POST" && path === "/v1/agents/sessions") {
      const wire = await outgoing.json() as ManagedCreateRequest;
      const request=requests.get(wire.metadata!.embel_call!)!;
      expect(request).toBeDefined(); expect(wire).toEqual(buildNamingManagedRequest(request)); expect(wire).not.toHaveProperty("spend_control");
      expect(request.input.snapshot.ownerId).toBe(OWNER_A); expect(request.policy.progressiveContractVersion).toBe(5);
      if (request.role === "researcher") { expect(wire.agent!.instructions).toContain("Do not stop after one or two attempts"); expect(wire.agent!.instructions).toContain("choose another relevant allowed reference"); }
      if (request.input.role === "creator") { expect(researchSaved).toBe(true); expect(directorSaved).toBe(true); expect(request.input.assignment.sources.every(source => source.evidenceStatus === "retrieved")).toBe(true); expect(request.input.assignment.sourceKeys.length).toBeGreaterThan(0); }
      creates.push(request.providerCallKey); dispatchOrder.push(request.role);
      const count = sessions.size + 1, session: Session = { request, wire, id: `sess_owner_${count}`, turnId: `turn_owner_${count}`, agentId: `agent_owner_${count}`, terminal: false, attempt: 1, items: [] }; sessions.set(session.id, session);
      return new Response(new ReadableStream<Uint8Array>({ start(controller) {
        session.controller = controller; emit(session, { type: "agent.session.created", session: sessionBody(session, false) }); emit(session, { type: "agent.session.turn.created", session_id: session.id, turn_id: session.turnId, turn: turn(session) });
        if (request.role !== "researcher") { complete(session); return; }
        emitReference(session);
      } }), { headers: { "content-type": "text/event-stream" } });
    }
    const session = sessions.get(path.split("/")[4]!)!; if (!session) throw Error("Unexpected inert SDK session");
    if (outgoing.method === "POST") { const body = await outgoing.json() as { events: { type: string; output?: string; call_id?: string }[] }; if (body.events[0]?.type !== "agent.session.input.tool_result") return new Response(null, { status: 202 });
      expect(body.events[0]!.call_id).toBe(`fixture-read-${session.attempt}`); session.reply = JSON.parse(body.events[0]!.output!); submits++;
      if (session.attempt === 1) { expect(session.reply!.status).toBe("unavailable"); const index = session.items.findIndex(item => item.call_id === "fixture-read-1"); session.items[index] = { ...session.items[index], status: "completed" }; emit(session, { type: "agent.session.turn.item.done", session_id: session.id, turn_id: session.turnId, output_index: index, item: session.items[index] }); session.attempt = 2; emitReference(session); }
      else complete(session); return new Response(null, { status: 202 }); }
    if (path.endsWith("/events")) return new Response("", { headers: { "content-type": "text/event-stream" } });
    return Response.json(path.endsWith("/items") ? { data: session.items, has_more: false } : path.endsWith("/turns") ? { data: [turn(session)], has_more: false } : path.endsWith(`/${session.turnId}`) ? turn(session) : sessionBody(session));
  }catch(error){transportErrors.push(error instanceof Error?error.message:String(error));throw error;} } });
  const reader = createNamingReferenceReader({ localPrototype: true, resolveHost: async () => [{ address: "93.184.216.34", family: 4 }], requestPage: async () => { pageReads++; return mode === "missing" || pageReads === 1 ? new Response("Fixture reference unavailable", { status: 404 }) : new Response(referenceText, { headers: { "content-type": "text/plain; charset=utf-8" } }); } });

 const engine=createSharedNamingLaneEngine({database:{async query(sql,values=[]){
  const response=await f.asSlot(slot,()=>db.query<Record<string,unknown>>(sql,values));
  if(values[2]==='action'){
   const args=JSON.parse(String(values[3])) as unknown[];
   const payload=typeof args[3]==='string'?JSON.parse(args[3]) as Record<string,unknown>:null;
   if(args[2]==='progressive_call_plan')for(const request of payload!.requests as NamingStageRequest[])requests.set(request.providerCallKey,request);
   if(options.loseFinishAcknowledgement&&!lostFinishAck&&args[2]==='finish'){lostFinishAck=true;throw Error('synthetic_finish_ack_lost');}
   if(args[2]==='artifact'){
    const artifact=payload!.artifact as {output:{role:string;planVersion?:number}};
    if(artifact.output.role==='researcher')researchSaved=true;
    if(artifact.output.role==='director'){expect(artifact.output.planVersion).toBe(2);directorSaved=true;}
   }
  }
  const envelope=response.rows[0]?.envelope as {result?:{sessionId?:string}}|undefined;
  if(options.loseReceiptAcknowledgement&&!lostReceiptAck&&values[2]==='receipt'&&envelope?.result?.sessionId){lostReceiptAck=true;throw Error('synthetic_receipt_ack_lost');}
  return response;
 }},slot:()=>lease,
  deploymentId,workerId,provider:{apiKey:'synthetic-never-live-key',model:policy.model,modelVerificationReceipt:'synthetic-model-proof'},policy},
  {protocol,referenceReader:reader});
 // First idle turn qualifies the fixed runtime. Owner-derived admission creates
 // only logical metadata; a second idle turn attests the saved preferences.
 expect(await engine.run()).toEqual({disposition:'ack',state:'idle'});
 const intent=initialIntent(`synthetic-shared-${mode}`);
 expect(await brainRpc(db,'ensure_shared_naming_brain_run',[project,intent])).toMatchObject({code:'preferences_validation_pending'});
 expect(await engine.run()).toEqual({disposition:'ack',state:'idle'});
 expect(await brainRpc(db,'ensure_shared_naming_brain_run',[project,intent])).toMatchObject({status:'pending'});
 return{f,db,slot,lease,project,engine,requests,creates,dispatchOrder,transportErrors,networkOperations,counts:()=>({pageReads,submits})};
}
describe('actual shared Naming engine + SDK + SQL, inert provider transports',()=>{
 it.each(['sourced','missing','irrelevant'] as const)('preserves acquired evidence and honest count for %s references',async mode=>{
  const f=await fixture(mode);
  try{
   await expect(brainRpc(f.db,'get_naming_feed',[f.project],OWNER_B)).rejects.toThrow('not_found');
   const result=await f.engine.run();
   expect({result,errors:f.transportErrors}).toEqual({result:{disposition:'ack',state:mode==='sourced'?'succeeded':'failed'},errors:[]});
   expect(f.counts()).toEqual({pageReads:2,submits:2});
   const feed=await brainRpc<{entries:unknown[];activeRun:{fulfillment:{coverageSatisfied:boolean}}}>(f.db,'get_naming_feed',[f.project]);
   expect(feed.entries).toHaveLength(mode==='sourced'?100:mode==='missing'?0:95);
   expect(feed.activeRun.fulfillment.coverageSatisfied).toBe(mode==='sourced');
   expect(f.dispatchOrder.slice(0,2)).toEqual(['researcher','director']);
   if(mode==='missing')expect(f.creates).toHaveLength(2);
   if(mode==='irrelevant')expect([...f.requests.values()].some(r=>r.input.role==='creator'&&r.input.assignment.primaryApproach==='classical_roots')).toBe(false);
   expect([...f.requests.values()].reduce((n,r)=>n+(r.input.role==='creator'?r.input.assignment.targetCount:0),0)).toBe(mode==='sourced'?100:mode==='missing'?0:95);
   expect(new Set(f.creates).size).toBe(f.creates.length);
   expect((await f.db.query('select count(*)::integer count from public.name_candidates where owner_id=$1',[OWNER_B])).rows).toEqual([{count:0}]);
   expect((await f.db.query("select count(*)::integer attempts,count(*) filter(where payload#>>'{sourceEvidence,evidenceStatus}'='retrieved')::integer retrieved from fluid_private.naming_brain_provider_records where kind='tool_result'")).rows).toEqual([{attempts:2,retrieved:mode==='missing'?0:1}]);
   expect((await f.db.query('select * from fluid_private.shared_worker_gateway_context')).rows).toEqual([]);
  }finally{await f.engine.close();await f.f.close();}
 },60000);
 it('uses only native SDK GETs for an actually saved session after a lost receipt acknowledgment',async()=>{
  const f=await fixture('sourced',{loseReceiptAcknowledgement:true});
  try{
   expect(await f.engine.run()).toEqual({disposition:'ack',state:'needs_reconciliation'});
   const before=f.networkOperations.length,creates=f.creates.length;
   const pending=await f.f.asSlot(f.slot,()=>f.db.query<{pending:unknown}>('select public.read_shared_worker_executions($1) pending',[f.lease]));
   const rows=pending.rows.map(r=>sharedPendingExecutionSchema.parse(r.pending));expect(rows).toHaveLength(1);
   await expect(f.engine.recover!([{...rows[0]!,execution:{...rows[0]!.execution,executionToken:randomUUID()}}])).rejects.toThrow(/shared_execution_denied/);
   await expect(f.engine.recover!([{...rows[0]!,execution:{...rows[0]!.execution,ownerId:OWNER_B}}])).rejects.toThrow(/shared_execution_denied/);
   expect(f.networkOperations).toHaveLength(before);
   expect(await f.engine.recover!(rows)).toEqual({disposition:'retry',state:'observation_retained'});
   expect(f.networkOperations.slice(before).length).toBeGreaterThan(0);
   expect(f.networkOperations.slice(before).every(method=>method==='GET')).toBe(true);
   expect(f.creates).toHaveLength(creates);
   expect((await f.db.query('select state,lease_token from public.jobs')).rows).toEqual([{state:'needs_reconciliation',lease_token:null}]);
  }finally{await f.engine.close();await f.f.close();}
 },60000);

 it('retains committed terminal work after a lost finish acknowledgment without reopening or repeating the provider',async()=>{
  const f=await fixture('missing',{loseFinishAcknowledgement:true});
  try{
   expect(await f.engine.run()).toEqual({disposition:'retry',state:'lease_lost'});
   expect((await f.db.query('select state,lease_token from public.jobs')).rows).toEqual([{state:'failed',lease_token:null}]);
   const before=f.creates.length;expect(before).toBe(2);
   expect((await f.f.asSlot(f.slot,()=>f.db.query('select public.read_shared_worker_executions($1)',[f.lease]))).rows).toHaveLength(0);
   expect(await f.engine.run()).toEqual({disposition:'ack',state:'idle'});expect(f.creates).toHaveLength(before);
   expect((await f.db.query('select state from fluid_private.shared_worker_executions')).rows).toEqual([{state:'closed'}]);
  }finally{await f.engine.close();await f.f.close();}
 },60000);

});
