import { beforeAll, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
vi.mock("server-only",()=>({}));
import { createIdentitySystemProducer, createIdentitySpecificationRequest, identityDigest } from "../../worker/identity/producer";
import { selectedLogoJobInput,boardSpecification,hash, imageConfiguration, imageUsage, response, snapshot, specification, textPolicy } from "./identity-generation-fixture";
import type { IdentityDispatch } from "../../worker/identity/producer";
let png:Uint8Array;
beforeAll(async()=>{png=new Uint8Array(await sharp({create:{width:1024,height:1024,channels:3,background:"#aabbcc"}}).png().toBuffer());});
function fixture(){const authorize=vi.fn(async()=>true),beforeDispatch=vi.fn(async()=>{}),observe=vi.fn(async()=>{}),countInputTokens=vi.fn(async()=>100),createResponse=vi.fn(async()=>response()),createImage=vi.fn(async()=>({bytes:png,mimeType:"image/png" as const,providerRequestId:"req_board",responseHash:"a".repeat(64),usage:imageUsage}));
 const options={textPolicy,textProvider:{apiKey:"synthetic-test-only",model:textPolicy.model},image:imageConfiguration,textTransport:{countInputTokens,createResponse},imageTransport:{createImage}};
 return{authorize,beforeDispatch,observe,countInputTokens,createResponse,createImage,options,dispatch:{authorize,beforeDispatch,observe} satisfies IdentityDispatch};}
const signal=()=>new AbortController().signal,key="a".repeat(64);
describe("Identity real provider adapter — mocked transports only",()=>{
 it("keeps historical v2 specification request bytes identical for already-issued recovery",()=>{
  expect(identityDigest(JSON.stringify(createIdentitySpecificationRequest(snapshot(),[],1,textPolicy)))).toBe('3488761d9aa2b24c515300c1a4fa06703a558cd1a8e2ce39ecf5f6c6c3a74bd7');
 });
 it("sends complete immutable input with no spend_control, tools, invented files or preset styles",()=>{const input=snapshot(),request=createIdentitySpecificationRequest(input,[],1,textPolicy);expect(JSON.stringify(request)).not.toContain("spend_control");expect(request.tools).toEqual([]);expect(request).toMatchObject({store:false,background:false,stream:false});expect(JSON.parse((request.input as {content:string}[])[0]!.content).capturedInput).toEqual(input);});
 it("records exact completed text usage, specifications and response identity",async()=>{const f=fixture(),producer=createIdentitySystemProducer(f.options)!;const out=await producer.specify(snapshot(),[],1,key,signal(),f.dispatch);expect(out.status).toBe("completed");expect(f.authorize).toHaveBeenCalledTimes(1);expect(f.beforeDispatch).toHaveBeenCalledTimes(1);expect(f.observe).toHaveBeenCalledWith(expect.objectContaining({phase:"specifications",model:textPolicy.model,billing:{status:"recorded",confirmedMicrousd:2200},specification:specification(),responseId:"resp_fixture"}));});
 it("uses actual inspected fullcolor PNG bytes and actual image usage",async()=>{const f=fixture(),out=await createIdentitySystemProducer(f.options)!.board(snapshot(),specification(),[],key,signal(),f.dispatch);expect(out.status).toBe("completed");expect(f.observe).toHaveBeenCalledWith(expect.objectContaining({phase:"board",artifactHash:hash(png),billing:{status:"recorded",confirmedMicrousd:6500}}));expect(f.createImage).toHaveBeenCalledTimes(1);});
 it("never repeats an already issued call",async()=>{const f=fixture();f.authorize.mockResolvedValue(false);const out=await createIdentitySystemProducer(f.options)!.specify(snapshot(),[],1,key,signal(),f.dispatch);expect(out.status).toBe("needs_reconciliation");expect(f.createResponse).not.toHaveBeenCalled();});
 it("does not dispatch when token count exceeds the exact resource policy",async()=>{const f=fixture();f.countInputTokens.mockResolvedValue(32769);expect((await createIdentitySystemProducer(f.options)!.specify(snapshot(),[],1,key,signal(),f.dispatch)).status).toBe("not_dispatched");expect(f.authorize).not.toHaveBeenCalled();expect(f.createResponse).not.toHaveBeenCalled();});
 it("preserves unknown usage without turning it into zero-cost success",async()=>{const f=fixture(),raw=response();Object.assign(raw.body,{usage:null});f.createResponse.mockResolvedValue(raw);const out=await createIdentitySystemProducer(f.options)!.specify(snapshot(),[],1,key,signal(),f.dispatch);expect(out.status).toBe("needs_reconciliation");expect(f.observe).toHaveBeenCalledWith(expect.objectContaining({billing:{status:"unknown",confirmedMicrousd:null}}));});
 it("retains paid malformed output and never retries generation",async()=>{const f=fixture(),raw=response();raw.body.output[0]!.content[0]!.text="malformed-private-output";f.createResponse.mockResolvedValue(raw);expect((await createIdentitySystemProducer(f.options)!.specify(snapshot(),[],1,key,signal(),f.dispatch)).status).toBe("needs_reconciliation");expect(f.createResponse).toHaveBeenCalledTimes(1);expect(f.observe).toHaveBeenCalledWith(expect.objectContaining({billing:{status:"recorded",confirmedMicrousd:2200},specification:null}));});
 it("blocks the second provider phase after Stop without erasing the first receipt",async()=>{const f=fixture(),controller=new AbortController(),producer=createIdentitySystemProducer(f.options)!;expect((await producer.specify(snapshot(),[],1,key,controller.signal,f.dispatch)).status).toBe("completed");controller.abort();expect((await producer.board(snapshot(),specification(),[],key,controller.signal,f.dispatch)).status).toBe("not_dispatched");expect(f.createImage).not.toHaveBeenCalled();expect(f.observe).toHaveBeenCalledTimes(1);});
 it("fails closed on wrong model/tier and incomplete provider output",async()=>{const f=fixture(),raw=response();Object.assign(raw.body,{model:"unexpected-model"});f.createResponse.mockResolvedValue(raw);const out=await createIdentitySystemProducer(f.options)!.specify(snapshot(),[],1,key,signal(),f.dispatch);expect(out.status).toBe("needs_reconciliation");expect(f.observe).toHaveBeenCalledWith(expect.objectContaining({model:"unexpected-model",billing:{status:"unknown",confirmedMicrousd:null}}));});
 it("does not reinterpret a receipt persistence failure as retry permission",async()=>{const f=fixture();f.observe.mockRejectedValue(Error("private database details"));const out=await createIdentitySystemProducer(f.options)!.board(snapshot(),specification(),[],key,signal(),f.dispatch);expect(out.status).toBe("needs_reconciliation");expect(f.createImage).toHaveBeenCalledTimes(1);expect(JSON.stringify(out)).not.toContain("private database details");});
 it("requires reproducible layout and supported font choices for selected-logo boards",async()=>{
  const f=fixture(),input=selectedLogoJobInput(png);if(input.version!==3)throw Error('Expected v3');
  const request=createIdentitySpecificationRequest(input.input,[],1,textPolicy,input.sourceLogo);
  const data=JSON.parse((request.input as {content:string}[])[0]!.content);
  expect(data.supportedTypography.map((s:{family:string})=>s.family)).toEqual(['Geist','Geist Mono','Lora','Fraunces','Manrope']);
  expect(data.outputSchema.required).toContain('applicationDesign');
  const valid=boardSpecification();f.createResponse.mockResolvedValue(response(valid));
  expect((await createIdentitySystemProducer(f.options)!.specify(input.input,[],1,key,signal(),f.dispatch,input.sourceLogo)).status).toBe('completed');
  const bad=boardSpecification();bad.components.typography.styles[0]!.family='Unbundled font';f.createResponse.mockResolvedValue(response(bad));
  const rejected=await createIdentitySystemProducer(f.options)!.specify(input.input,[],1,'b'.repeat(64),signal(),f.dispatch,input.sourceLogo);
  expect(rejected.status).toBe('failed');expect(rejected.observation?.billing.status).toBe('recorded');expect(rejected.observation?.specification).toBeNull();
 });

});
