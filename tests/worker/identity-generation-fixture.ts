import { createHash } from "node:crypto";
import { createIdentityInputSnapshot, initialIdentityPreferences, type IdentitySystemVersion } from "../../src/domain/project-identity";
import { createIdentityReferenceSnapshot } from "../../src/domain/identity-references";
import { contextSnapshotSchema } from "../../src/domain/projects";
import { IMAGE_MODEL } from "../../src/domain/providers";
import { identityGenerationCapabilitySchema, identityGenerationJobInputSchema, type IdentityGenerationObservation } from "../../src/domain/identity-jobs";
export const id=(n:number)=>`aaaaaaaa-aaaa-4aaa-8aaa-${n.toString().padStart(12,"0")}`;
export const ownerId=id(1),projectId=id(2),jobId=id(3),batchId=id(4),leaseToken=id(5),timestamp="2026-10-27T00:00:00Z";
export const hash=(v:Uint8Array|string)=>createHash("sha256").update(v).digest("hex");
export const textPolicy={version:1 as const,model:"gpt-6.1-sol" as const,serviceTier:"default" as const,pricingVersion:"2026-10-03" as const,maxInputTokens:32768,maxOutputTokens:8192,maxInputBytes:131072,maxOutputBytes:65536,deadlineMs:240000,maxTools:0 as const};
export const capability=identityGenerationCapabilitySchema.parse({operation:"identity.image",policyIdentity:"a".repeat(64),handlerVersion:"identity-image-v1",provider:"openai",model:IMAGE_MODEL,engine:null,maxCostMicrousd:0,spendControl:"uncapped",textPolicy});
export function snapshot(contentHash="f".repeat(64)){
 const context=contextSnapshotSchema.parse({description:"Clearly synthetic worker fixture",selectedName:"Fixture",intake:{suppliedName:"Fixture"}});
 const refs=createIdentityReferenceSnapshot({ownerId,projectId,referenceRevision:1,selectedReferenceCount:1,capturedAt:timestamp,selected:[{reference:{id:id(10),ownerId,projectId,createdAt:timestamp,media:{assetId:id(11),versionId:id(12),ownerId,projectId,contentHash,purpose:"reference_media",mimeType:"image/png"},source:"user_supplied",attribution:{label:"Synthetic image",creator:null,sourceUrl:null,rightsNote:null},relevantElements:[],tags:[]},reaction:{referenceId:id(10),ownerId,projectId,revision:1,ensemble:true,elements:[],updatedAt:timestamp}}]});
 return createIdentityInputSnapshot({ownerId,projectId,scope:"visual_identity_only",projectRevision:1,context,referenceSnapshot:refs,preferencesRevision:0,preferences:initialIdentityPreferences(context),capturedAt:timestamp});
}
export function jobInput(contentHash?:string){return identityGenerationJobInputSchema.parse({version:2,operation:"identity.image",ownerId,projectId,batchId,input:snapshot(contentHash),policyIdentity:capability.policyIdentity,handlerVersion:capability.handlerVersion,spendControl:"uncapped",textPolicy,systemIds:[id(21),id(22),id(23)]});}
export function specification(n=1){const direction={direction:`Synthetic direction ${n}`,usageNotes:"Specification, no downloadable file implied"};return{components:{logo:direction,colors:{swatches:[{key:"primary",name:"Primary",hex:["#123456","#654321","#345612"][n-1]??"#777777"}],usageNotes:"Proposed palette"},typography:{styles:[{key:"body",role:"Body",family:`Synthetic family ${n}`,weight:400,style:"normal" as const}],usageNotes:"No font files or licenses implied"},graphics:direction,imagery:direction,composition:direction},boardPrompt:`Synthetic distinct board ${n}`};}
export function response(spec=specification()){return{requestId:"req_fixture",body:{id:"resp_fixture",model:textPolicy.model,service_tier:"default",status:"completed",error:null,incomplete_details:null,usage:{input_tokens:100,output_tokens:200,total_tokens:300,input_tokens_details:{cached_tokens:0,cache_write_tokens:0}},output:[{type:"message",role:"assistant",status:"completed",content:[{type:"output_text",text:JSON.stringify(spec)}]}]}};}
export const imageUsage={input_tokens:100,output_tokens:200,input_tokens_details:{text_tokens:100,image_tokens:0}};
export const imageConfiguration={apiKey:"synthetic-test-only",model:IMAGE_MODEL,rateVersion:"2026-10-07.v1",paidCallsApproved:true};
export type StoredFixture={observations:IdentityGenerationObservation[];systems:IdentitySystemVersion[]};

export const generationIntent={version:2 as const,spendControl:"uncapped" as const,expectedProjectRevision:1,expectedReferenceRevision:1,expectedPreferencesRevision:0,expectedIdentityRevision:0,idempotencyKey:"identity-generation-fixture-001",acceptedPolicyIdentity:"a".repeat(64)};
export const batchState=()=>({ownerId,projectId,batchId,jobId,status:"queued" as const,terminal:false,intent:generationIntent,input:jobInput().input,systems:[],fulfillment:{targetCount:3 as const,acceptedCount:0,status:"pending" as const}});
