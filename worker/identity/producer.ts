import "server-only";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { supportedBrandBoardTypography } from "../../src/domain/brand-board-fonts";
import { createIdentitySpecificationRequest, identityBoardPrompt } from "../../src/server/ai/identity-direction-requests";
import { identityLogoSourceSchema, type IdentityLogoSource } from "../../src/domain/identity-logo-source";
import { identityGenerationObservationSchema, identitySystemSpecificationSchema, identityTextPolicySchema, type IdentityGenerationObservation, type IdentitySystemSpecification, type IdentityTextPolicy } from "../../src/domain/identity-jobs";
import type { IdentityInputSnapshot, IdentitySystemVersion } from "../../src/domain/project-identity";
import { IMAGE_MODEL } from "../../src/domain/providers";
import { logoVectorProposalUsageCost, logoVectorProposalUsageSchema } from "../../src/domain/logo-vector-proposal-jobs";
import type { VerifiedAssetBytes } from "../../src/domain/logo-deliverables";
import { createOpenAIResponsesTransport, OpenAITransportError, type OpenAIResponsesTransport, type ResponsesRequest } from "../../src/server/ai/openai-transport";
import { createOpenAIImageTransport, OpenAIImageTransportError, validateLogoImageInputs, type OpenAIImageRequest, type OpenAIImageTransport } from "../../src/server/logo-creation/openai-image-transport";
import { createSunburstStandardImageUsagePricer, SUNBURST_STANDARD_IMAGE_PRICING } from "../../src/server/logo-creation/openai-image-pricing";
import { inspectIdentityRaster } from "../../src/server/data/identity-asset-store";

export const identityDigest=(value:string|Uint8Array)=>createHash("sha256").update(value).digest("hex");
const safeId=(v:unknown)=>typeof v==="string"&&/^[a-zA-Z0-9_.:-]{1,200}$/.test(v)?v:null;
const record=(v:unknown):Record<string,unknown>|null=>v!==null&&typeof v==="object"&&!Array.isArray(v)?v as Record<string,unknown>:null;
export type IdentityDispatch = {
  /** Must durably reserve the exact call. False means previously issued, never permission to repeat. */
  authorize(phase:"specifications"|"board",requestKey:string,requestHash:string):Promise<boolean>;
  beforeDispatch():Promise<void>;
  observe(observation:IdentityGenerationObservation):Promise<void>;
};
export type IdentityProduction<T>={status:"completed";value:T;observation:IdentityGenerationObservation}|{status:"not_dispatched"|"needs_reconciliation"|"failed";observation:IdentityGenerationObservation|null};
export type IdentitySystemProducer={
  specify(input:IdentityInputSnapshot,prior:readonly IdentitySystemVersion[],ordinal:number,requestKey:string,signal:AbortSignal,dispatch:IdentityDispatch,sourceLogo?:IdentityLogoSource):Promise<IdentityProduction<IdentitySystemSpecification>>;
  board(input:IdentityInputSnapshot,specification:IdentitySystemSpecification,images:readonly VerifiedAssetBytes[],requestKey:string,signal:AbortSignal,dispatch:IdentityDispatch,sourceLogo?:IdentityLogoSource):Promise<IdentityProduction<{bytes:Uint8Array;mimeType:"image/png"}>>;
};
function base(phase:"specifications"|"board",requestKey:string,requestHash:string):IdentityGenerationObservation{return{version:1,phase,provider:"openai",model:null,requestKey,requestHash,responseId:null,providerRequestId:null,responseHash:null,observedAt:new Date().toISOString(),responseComplete:false,serviceTier:null,usage:null,billing:{status:"unknown",confirmedMicrousd:null},specification:null,artifactHash:null};}
export { createIdentitySpecificationRequest };
/** Exactly one call per phase, injected application key only. No account/config discovery, retries, storage, or fabricated provider success. */
export function createIdentitySystemProducer(options:{textPolicy:IdentityTextPolicy;textProvider:{apiKey:string;model:string};image:{apiKey:string;model:string;rateVersion:string;paidCallsApproved:boolean};textTransport?:OpenAIResponsesTransport;imageTransport?:OpenAIImageTransport;acceptingWork?:()=>boolean}):IdentitySystemProducer|null{
  const parsed=identityTextPolicySchema.safeParse(options.textPolicy);
  if(!parsed.success||options.textProvider.model!==parsed.data.model||!options.textProvider.apiKey||options.image.model!==IMAGE_MODEL||options.image.rateVersion!==SUNBURST_STANDARD_IMAGE_PRICING.binding.rateVersion||options.image.paidCallsApproved!==true||!options.image.apiKey)return null;
  const policy=structuredClone(parsed.data),accepting=options.acceptingWork??(()=>true),price=createSunburstStandardImageUsagePricer(SUNBURST_STANDARD_IMAGE_PRICING.binding)!;
  const textKey=options.textProvider.apiKey,imageKey=options.image.apiKey,textTransport=options.textTransport,imageTransport=options.imageTransport,fetcher=globalThis.fetch;
  const fence=(signal:AbortSignal)=>{signal.throwIfAborted();const allowed:unknown=accepting();if(allowed!==true){void Promise.resolve(allowed).catch(()=>{});throw Error("Identity dispatch unavailable");}};
  return{
    async specify(input,prior,ordinal,requestKey,signal,dispatch,sourceLogo){
      let request:ResponsesRequest,observation:IdentityGenerationObservation|null=null,issued=false,invoked=false;
      let preflightStage:"request"|"token_count"|"authorization"="request";
      const current=AbortSignal.any([signal,AbortSignal.timeout(policy.deadlineMs)]);
      const transport=textTransport??createOpenAIResponsesTransport({apiKey:textKey,fetch(...args){fence(current);return fetcher(...args);}});
      try{
        fence(current);request=createIdentitySpecificationRequest(input,prior,ordinal,policy,sourceLogo);
        if(Buffer.byteLength(JSON.stringify(request))>policy.maxInputBytes)throw Error("Input limit");
        preflightStage="token_count";
        const count=await transport.countInputTokens(structuredClone(request),current);if(!Number.isSafeInteger(count)||count<0||count>policy.maxInputTokens)throw Error("Input token limit");
        observation=base("specifications",requestKey,identityDigest(JSON.stringify(request)));
        preflightStage="authorization";
        fence(current);if(!await dispatch.authorize("specifications",requestKey,observation.requestHash))return{status:"needs_reconciliation",observation:null};issued=true;
        await dispatch.beforeDispatch();fence(current);invoked=true;
        const response=await transport.createResponse(request,requestKey,current),body=record(response.body);
        observation.providerRequestId=safeId(response.requestId);observation.responseHash=identityDigest(JSON.stringify(response.body));
        observation.model=safeId(body?.model);observation.serviceTier=safeId(body?.service_tier);observation.responseId=safeId(body?.id);
        const usage=record(body?.usage),details=record(usage?.input_tokens_details),parsedUsage=logoVectorProposalUsageSchema.safeParse({inputTokens:usage?.input_tokens,cachedInputTokens:details?.cached_tokens,cacheWriteInputTokens:details?.cache_write_tokens,outputTokens:usage?.output_tokens});
        let text:string|null=null,valid=false;
        const output=Array.isArray(body?.output)?body.output:[];
        const messages=output.filter(v=>record(v)?.type!=="reasoning");
        if(messages.length===1){const message=record(messages[0]),parts=Array.isArray(message?.content)?message.content:[];
          if(message?.type==="message"&&message.role==="assistant"&&message.status==="completed"&&parts.length===1&&record(parts[0])?.type==="output_text"&&typeof record(parts[0])?.text==="string")text=record(parts[0])!.text as string;
        }
        if(parsedUsage.success&&usage?.total_tokens===parsedUsage.data.inputTokens+parsedUsage.data.outputTokens){observation.usage=parsedUsage.data;
          if(observation.model===policy.model&&observation.serviceTier===policy.serviceTier&&messages.every(v=>record(v)?.type==="message"))observation.billing={status:"recorded",confirmedMicrousd:logoVectorProposalUsageCost(parsedUsage.data)};
        }
        observation.responseComplete=body?.status==="completed"&&body.error==null&&body.incomplete_details==null&&observation.responseId?.startsWith("resp_")===true;
        if(text&&Buffer.byteLength(text)<=policy.maxOutputBytes&&observation.responseComplete&&observation.model===policy.model&&observation.serviceTier===policy.serviceTier&&parsedUsage.success&&parsedUsage.data.inputTokens<=policy.maxInputTokens&&parsedUsage.data.outputTokens<=policy.maxOutputTokens){
          const specification=identitySystemSpecificationSchema.safeParse(JSON.parse(text));if(specification.success&&(!sourceLogo||Boolean(specification.data.applicationDesign&&specification.data.components.typography.styles.every(style=>supportedBrandBoardTypography(style,sourceLogo.brief.payload.name))))){observation.specification=specification.data;valid=true;}
        }
        observation=identityGenerationObservationSchema.parse(observation);await dispatch.observe(observation);
        if(valid&&observation.billing.status==="recorded"&&!current.aborted)return{status:"completed",value:observation.specification!,observation};
        return{status:observation.billing.status==="unknown"||current.aborted?"needs_reconciliation":"failed",observation};
      }catch(e){
        if(!issued){
          // Fixed classifications only: never log prompts, credentials or provider error bodies.
          if(!current.aborted)console.warn("identity_specification_preflight_failed",{stage:preflightStage,reason:e instanceof OpenAITransportError?e.code:"validation_failed"});
          return{status:"not_dispatched",observation:null};
        }
        if(observation){if(e instanceof OpenAITransportError)observation.providerRequestId=e.requestId;
          if(!invoked)observation.billing={status:"recorded",confirmedMicrousd:0};
          try{await dispatch.observe(identityGenerationObservationSchema.parse(observation));}catch{/* Original call remains issued; never retry create. */}}
        return{status:invoked?"needs_reconciliation":"failed",observation};
      }
    },
    async board(input,specification,images,requestKey,signal,dispatch,sourceLogo){
      let observation:IdentityGenerationObservation|null=null,issued=false,invoked=false;
      const transport=imageTransport??createOpenAIImageTransport({apiKey:imageKey,fetch(...args){fence(signal);return fetcher(...args);}});
      try{
        fence(signal);
        if(sourceLogo){
          identityLogoSourceSchema.parse(sourceLogo);
          if(sourceLogo.brief.ownerId!==input.ownerId||sourceLogo.brief.projectId!==input.projectId
            ||!specification.applicationDesign||!specification.components.typography.styles.every(style=>supportedBrandBoardTypography(style,sourceLogo.brief.payload.name))
            ||!images[0]||!isDeepStrictEqual(images[0].reference,sourceLogo.preview.reference))throw Error("The exact selected logo must be the first image");
        }
        const request:OpenAIImageRequest=await validateLogoImageInputs({model:IMAGE_MODEL,size:"1024x1024",quality:"medium",background:"opaque",images,
          prompt:identityBoardPrompt(sourceLogo?.brief.payload.name??input.basis.name,specification,Boolean(sourceLogo))},signal);
        observation=base("board",requestKey,identityDigest(JSON.stringify({...request,images:request.images.map(i=>({reference:i.reference,mimeType:i.mimeType,verification:i.verification}))})));
        fence(signal);if(!await dispatch.authorize("board",requestKey,observation.requestHash))return{status:"needs_reconciliation",observation:null};issued=true;
        await dispatch.beforeDispatch();fence(signal);invoked=true;
        const response=await transport.createImage(request,requestKey,signal);
        observation.model=IMAGE_MODEL;observation.serviceTier="standard";observation.providerRequestId=safeId(response.providerRequestId);observation.responseHash=response.responseHash;
        observation.usage=response.usage;observation.billing=price(response.usage);
        const bytes=Uint8Array.from(response.bytes),raster=await inspectIdentityRaster(bytes,response.mimeType,signal);
        if(response.mimeType!=="image/png"||raster.width!==1024||raster.height!==1024)throw Error("Invalid board bytes");
        observation.artifactHash=identityDigest(bytes);observation.responseComplete=true;
        observation=identityGenerationObservationSchema.parse(observation);await dispatch.observe(observation);
        if(observation.billing.status!=="recorded")return{status:"needs_reconciliation",observation};
        return{status:"completed",value:{bytes,mimeType:"image/png"},observation};
      }catch(e){
        if(!issued)return{status:"not_dispatched",observation:null};
        if(observation){if(e instanceof OpenAIImageTransportError){observation.providerRequestId=e.providerRequestId;observation.responseHash=e.responseHash;observation.usage=e.usage;observation.billing=price(e.usage);}
          if(!invoked)observation.billing={status:"recorded",confirmedMicrousd:0};
          try{await dispatch.observe(identityGenerationObservationSchema.parse(observation));}catch{/* Issued output/expense stays unknown. */}}
        return{status:invoked?"needs_reconciliation":"failed",observation};
      }
    },
  };
}
