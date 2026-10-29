import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createNamingBrainstormProvider, NamingBrainstormProviderError } from "../../src/server/ai/naming-brainstorm-provider";
import { namingBrainstormWireSchema } from "../../src/domain/naming-brainstorm";
const body = () => namingBrainstormWireSchema.parse({model:"gpt-6-luna",store:true,stream:true,reasoning:{effort:"low"},max_output_tokens:16000,input:"Synthetic fixture only",text:{verbosity:"low",format:{type:"json_schema",name:"naming_brainstorm_v1",strict:true,schema:{type:"object",properties:{},required:[],additionalProperties:false}}},metadata:{embel_generation_profile:"brainstorm_v1",embel_job_id:"11111111-1111-4111-8111-111111111111",embel_run_id:"22222222-2222-4222-8222-222222222222",embel_call_index:"1"}});
describe("brainstorm provider native SDK boundary, synthetic HTTP only",()=>{
 it.each([400,500,"lost"] as const)("disables retries and sanitizes %s failures",async status=>{
  const fetcher=vi.fn(async()=>{if(status==="lost")throw Error("private-provider-fixture");return Response.json({error:{message:"private-provider-fixture",type:"invalid_request_error",code:"invalid_api_key"}},{status,headers:{"x-request-id":"req_fixture"}});});
  const provider=createNamingBrainstormProvider({apiKey:"synthetic-never-live",fetch:fetcher});const failure=await provider.create(body(),new AbortController().signal).catch(error=>error);
  expect(failure).toBeInstanceOf(NamingBrainstormProviderError);expect(failure.code).toBe(status===400?"request_rejected":"outcome_unknown");expect(JSON.stringify(failure)).not.toContain("private-provider-fixture");expect(fetcher).toHaveBeenCalledOnce();
 });
 it("retrieves a saved response with GET and cancels only that response",async()=>{
  const calls:{method:string;path:string}[]=[];const provider=createNamingBrainstormProvider({apiKey:"synthetic-never-live",fetch:async(incoming,init)=>{const request=new Request(incoming,init);calls.push({method:request.method,path:new URL(request.url).pathname});return Response.json({id:"resp_fixture",model:"gpt-6-luna",status:"cancelled"},{headers:{"x-request-id":"req_read"}});}});
  expect(await provider.retrieve("resp_fixture",new AbortController().signal)).toMatchObject({response:{id:"resp_fixture"},requestId:"req_read"});await provider.cancel("resp_fixture",new AbortController().signal);expect(calls).toEqual([{method:"GET",path:"/v1/responses/resp_fixture"},{method:"POST",path:"/v1/responses/resp_fixture/cancel"}]);
 });
 it("rejects redirects, malformed IDs, unqualified bodies, and oversize raw JSON",async()=>{
  const fetcher=vi.fn(async()=>new Response(null,{status:302,headers:{location:"https://unrelated.invalid"}}));const provider=createNamingBrainstormProvider({apiKey:"synthetic-never-live",fetch:fetcher});
  await expect(provider.create(body(),new AbortController().signal)).rejects.toMatchObject({code:"outcome_unknown"});await expect(provider.retrieve("resp_../secret",new AbortController().signal)).rejects.toBeInstanceOf(NamingBrainstormProviderError);await expect(provider.create({...body(),tools:[]} as ReturnType<typeof body>,new AbortController().signal)).rejects.toBeInstanceOf(NamingBrainstormProviderError);expect(fetcher).toHaveBeenCalledOnce();
  const oversized=createNamingBrainstormProvider({apiKey:"synthetic-never-live",fetch:async()=>new Response("x".repeat(1_048_577),{headers:{"content-type":"application/json"}})});await expect(oversized.retrieve("resp_fixture",new AbortController().signal)).rejects.toBeInstanceOf(NamingBrainstormProviderError);
 });
});
