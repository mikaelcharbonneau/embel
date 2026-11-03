import { beforeAll, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
vi.mock("server-only",()=>({}));
import { createIdentitySystemProducer, createIdentitySpecificationRequest, identityDigest } from "../../worker/identity/producer";
import { createOpenAIResponsesTransport } from "../../src/server/ai/openai-transport";
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
 it("retains all released selected-logo request hashes and sends the named-direction form for new work",()=>{
  const job = selectedLogoJobInput(Uint8Array.from([1, 2, 3]), "茶屋");
  if (job.version !== 3) throw Error("Expected selected logo");
  const request = (version?: 0|1|2|3) => createIdentitySpecificationRequest(job.input, [], 1, textPolicy, job.sourceLogo, version);
  const digest = (version?: 0|1|2|3) => identityDigest(JSON.stringify(request(version)));
  // Computed with the original producer and font catalog from each revision.
  expect(digest(0)).toBe("7da4c3a96acbcfe5d95bca17e5fbfa7dbc8532c9ff3bece4f91f2a96e254bc17"); // 87579e3
  expect(digest(1)).toBe("9bc860e708d640f38c991b14a0f1c8e5baa3aa2f5990a08078364caebadb91dd"); // 3716696
  expect(digest(2)).toBe("3a89350c6c0eec0dea48bac54fe4e8bcda45d8c4c96d4173c07b616ebff55873"); // 59573f4
  expect(digest()).toBe("c5c4a49bddea564e953c492a8003b7989af6e90459ccc8745b8420e2084d5149");
  expect(request().instructions).toContain("The direction is called “<name>”. <one-sentence summary>.");
  expect(request().instructions).toContain("technical composition guidance in components.composition.usageNotes and boardPrompt");
  expect(request().input).toEqual(request(2).input);
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
  const content=(request.input as {content:string}[])[0]!.content;
  expect(content.startsWith('Return one JSON object matching outputSchema.\n')).toBe(true);
  const data=JSON.parse(content.slice(content.indexOf('\n')+1));
  expect(data.supportedTypography.map((s:{family:string})=>s.family)).toEqual(['Geist','Geist Mono','Lora','Fraunces','Manrope']);
  expect(data.outputSchema.required).toContain('applicationDesign');
  const valid=boardSpecification();f.createResponse.mockResolvedValue(response(valid));
  expect((await createIdentitySystemProducer(f.options)!.specify(input.input,[],1,key,signal(),f.dispatch,input.sourceLogo)).status).toBe('completed');
  const bad=boardSpecification();bad.components.typography.styles[0]!.family='Unbundled font';f.createResponse.mockResolvedValue(response(bad));
  const rejected=await createIdentitySystemProducer(f.options)!.specify(input.input,[],1,'b'.repeat(64),signal(),f.dispatch,input.sourceLogo);
  expect(rejected.status).toBe('failed');expect(rejected.observation?.billing.status).toBe('recorded');expect(rejected.observation?.specification).toBeNull();
 });

 it("passes selected-logo JSON preflight through the real HTTPS transport before one specification create",async()=>{
  const f=fixture(),input=selectedLogoJobInput(png);if(input.version!==3)throw Error('Expected v3');
  const fetcher=vi.fn<typeof fetch>().mockImplementation(async(url,options)=>{
   const request=JSON.parse(options!.body as string);
   if(url==='https://api.openai.com/v1/responses/input_tokens'){
    // Model the two actual provider rejections, at the HTTP boundary rather than a stubbed count result.
    if(['service_tier','max_output_tokens','store','background','stream'].some(field=>Object.hasOwn(request,field)))
     return new Response('Unknown parameter',{status:400});
    if(request.text?.format?.type==='json_object'&&!request.input.some((message:{content:string})=>/json/i.test(message.content)))
     return new Response('Input must mention JSON',{status:400});
    return new Response(JSON.stringify({input_tokens:2527}));
   }
   expect(url).toBe('https://api.openai.com/v1/responses');
   expect(request).toEqual(createIdentitySpecificationRequest(input.input,[],1,textPolicy,input.sourceLogo));
   return new Response(JSON.stringify(response(boardSpecification()).body),{headers:{'x-request-id':'req_fixture'}});
  });
  const textTransport=createOpenAIResponsesTransport({apiKey:'synthetic-test-only',fetch:fetcher});
  const out=await createIdentitySystemProducer({...f.options,textTransport})!.specify(input.input,[],1,key,signal(),f.dispatch,input.sourceLogo);
  expect(out.status).toBe('completed');expect(fetcher).toHaveBeenCalledTimes(2);
  expect(f.authorize).toHaveBeenCalledTimes(1);expect(f.beforeDispatch).toHaveBeenCalledTimes(1);
  const counted=JSON.parse(fetcher.mock.calls[0]![1]!.body as string),created=JSON.parse(fetcher.mock.calls[1]![1]!.body as string);
  expect(counted.input).toEqual(created.input);expect(counted.instructions).toEqual(created.instructions);expect(counted.text).toEqual(created.text);
  expect(created).toMatchObject({service_tier:'default',max_output_tokens:8192,store:false,background:false,stream:false});
  expect(f.authorize).toHaveBeenCalledWith('specifications',key,identityDigest(JSON.stringify(created)));
 });

 it("retains a rejected count preflight as zero generation calls with no implicit retry",async()=>{
  const f=fixture(),input=selectedLogoJobInput(png);if(input.version!==3)throw Error('Expected v3');
  const fetcher=vi.fn<typeof fetch>().mockResolvedValue(new Response('Private provider details',{status:400}));
  const textTransport=createOpenAIResponsesTransport({apiKey:'synthetic-test-only',fetch:fetcher});
  const warning=vi.spyOn(console,'warn').mockImplementation(()=>{});
  try{
   const out=await createIdentitySystemProducer({...f.options,textTransport})!.specify(input.input,[],1,key,signal(),f.dispatch,input.sourceLogo);
   expect(out).toEqual({status:'not_dispatched',observation:null});
   expect(fetcher).toHaveBeenCalledTimes(1);expect(fetcher.mock.calls[0]![0]).toBe('https://api.openai.com/v1/responses/input_tokens');
   expect(f.authorize).not.toHaveBeenCalled();expect(f.observe).not.toHaveBeenCalled();
   expect(warning.mock.calls).toEqual([['identity_specification_preflight_failed',{stage:'token_count',reason:'request_rejected'}]]);
  }finally{warning.mockRestore();}
 });

});


describe("multilingual selected-logo generation", () => {
 it.each([['茶屋', 'Noto Sans JP'], ['مرحبا', 'Noto Sans Arabic'], ['नमस्ते', 'Noto Sans Devanagari']])("offers and validates fonts for %s before rendering a board", async (name, family) => {
  const f=fixture(), input=structuredClone(selectedLogoJobInput(png)); if(input.version!==3) throw Error('Expected v3');
  input.sourceLogo.brief.payload.name=name;
  const request=createIdentitySpecificationRequest(input.input,[],1,textPolicy,input.sourceLogo);
  const content=(request.input as {content:string}[])[0]!.content;
  const data=JSON.parse(content.slice(content.indexOf('\n')+1));
  expect(data.supportedTypography.map((font:{family:string})=>font.family)).toContain(family);
  expect(data.supportedTypography.map((font:{family:string})=>font.family)).not.toContain('Lora');
  const spec=boardSpecification(); spec.components.typography.styles[0]!.family=family;
  f.createResponse.mockResolvedValue(response(spec));
  expect((await createIdentitySystemProducer(f.options)!.specify(input.input,[],1,key,signal(),f.dispatch,input.sourceLogo)).status).toBe('completed');
  f.createResponse.mockResolvedValue(response(boardSpecification()));
  const rejected=await createIdentitySystemProducer(f.options)!.specify(input.input,[],1,key,signal(),f.dispatch,input.sourceLogo);
  expect(rejected.status).toBe('failed');expect(rejected.observation?.specification).toBeNull();
 });
 it("rejects unsupported text before token counting, reservation or paid generation", async () => {
  const f=fixture(), input=structuredClone(selectedLogoJobInput(png)); if(input.version!==3) throw Error('Expected v3');
  input.sourceLogo.brief.payload.name='Studio 🦄';
  expect((await createIdentitySystemProducer(f.options)!.specify(input.input,[],1,key,signal(),f.dispatch,input.sourceLogo)).status).toBe('not_dispatched');
  expect(f.countInputTokens).not.toHaveBeenCalled();expect(f.authorize).not.toHaveBeenCalled();expect(f.createResponse).not.toHaveBeenCalled();
  expect((await createIdentitySystemProducer(f.options)!.board(input.input,boardSpecification(),[],key,signal(),f.dispatch,input.sourceLogo)).status).toBe('not_dispatched');
  expect(f.createImage).not.toHaveBeenCalled();
 });
});
