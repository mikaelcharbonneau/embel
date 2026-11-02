import { supportedBrandBoardTypography } from "../../src/domain/brand-board-fonts";
import "server-only";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { identityBatchBindingSchema, identityGenerationCapabilitySchema, identityGenerationJobInputSchema, identityGenerationProviderReceiptSchema, identityStepOutputSchema, type IdentityGenerationCapability, type IdentityGenerationObservation, type IdentityGenerationProviderReceipt } from "../../src/domain/identity-jobs";
import { identitySystemVersionSchema } from "../../src/domain/project-identity";
import { identityAssetReceiptSchema, verifiedAssetBytesSchema, type VerifiedAssetBytes } from "../../src/domain/logo-deliverables";
import type { ClaimedJob, StepOutcome } from "../../src/domain/jobs";
import type { IdentityAssetStore } from "../../src/server/data/identity-asset-store";
import type { LogoWorkerConnection } from "../../src/server/data/logo-jobs";
import type { OpenAIImageTransport } from "../../src/server/logo-creation/openai-image-transport";
import type { OpenAIResponsesTransport } from "../../src/server/ai/openai-transport";
import { IMAGE_INPUT_LIMITS } from "../../src/domain/logo-image-limits";
import { logoVectorProposalUsageCost, logoVectorProposalUsageSchema } from "../../src/domain/logo-vector-proposal-jobs";
import { createIdentitySpecificationRequest, createIdentitySystemProducer, identityDigest, type IdentityDispatch, type IdentityProduction } from "./producer";
import type { IdentitySystemSpecification } from "../../src/domain/identity-jobs";
import type { JobHandler } from "../runner";

export type IdentityGenerationRuntimeInput={ownerId:string;capability:IdentityGenerationCapability;
  textProvider:{apiKey:string;model:string};image:{apiKey:string;model:string;rateVersion:string;paidCallsApproved:boolean};
  connection:LogoWorkerConnection;assets:IdentityAssetStore;assertAvailable(job:ClaimedJob):Promise<void>;acceptingWork?:()=>boolean;
  imageTransport?:OpenAIImageTransport;textTransport?:OpenAIResponsesTransport;};
const unavailable=()=>Error("Identity generation runtime unavailable");
/** No I/O or implicit configuration during construction. Shared Logo lane owns the actual claim/lease and injected Storage authority. */
export function createIdentityGenerationRuntimeAdapter(options:IdentityGenerationRuntimeInput|null):JobHandler|null{
  if(!options)return null;
  const capability=identityGenerationCapabilitySchema.safeParse(options.capability);
  if(!capability.success||!z.uuid().safeParse(options.ownerId).success||typeof options.connection?.query!=="function"||typeof options.assets?.publishLeasedAsset!=="function"||typeof options.assets?.readLeasedAsset!=="function"||typeof options.assertAvailable!=="function")return null;
  const producer=createIdentitySystemProducer({...options,textPolicy:capability.data.textPolicy});if(!producer)return null;
  const ownerId=options.ownerId;
  const query=options.connection.query.bind(options.connection),publish=options.assets.publishLeasedAsset.bind(options.assets),read=options.assets.readLeasedAsset.bind(options.assets),assertAvailable=options.assertAvailable;
  const snapshot=(job:ClaimedJob)=>{
    const input=identityGenerationJobInputSchema.parse(job.input);
    if(job.operation!=="identity.image"||job.ownerId!==ownerId||input.ownerId!==job.ownerId||input.projectId!==job.projectId||input.policyIdentity!==capability.data.policyIdentity||!isDeepStrictEqual(input.textPolicy,capability.data.textPolicy)||job.inputRevision!==input.input.projectRevision||job.reservedCostMicrousd!==0)throw unavailable();
    return input;
  };
  async function value(sql:string,args:unknown[]){const rows=await query<{value:unknown}>(sql,args);if(rows.rows.length!==1)throw unavailable();return rows.rows[0]!.value;}
  return{steps(job){
    const frozen=snapshot(job),sourceLogo=frozen.version===3?frozen.sourceLogo:undefined;
    return frozen.systemIds.map((systemId,index)=>({key:`identity-system-v1:${index+1}`,maximumCostMicrousd:0,timeoutMs:600_000,
      async execute({job:claimed,signal}):Promise<StepOutcome>{
        let cost=0,requestId:string|null=null,phaseDispatched=false;
        const unknown=(code:string):StepOutcome=>({status:"needs_reconciliation",code,costMicrousd:cost,providerRequestId:requestId});
        const stepKey=`identity-system-v1:${index+1}`,receipts=new Map<string,IdentityGenerationProviderReceipt>();
        const acceptReceipt=(receipt:IdentityGenerationProviderReceipt)=>{
          if(receipt.ownerId!==claimed.ownerId||receipt.projectId!==claimed.projectId||receipt.jobId!==claimed.id||receipt.leaseToken!==claimed.leaseToken)throw unavailable();
          const observation=receipt.observation;
          if(!receipts.has(observation.phase)&&observation.billing.status==="recorded")cost+=observation.billing.confirmedMicrousd;
          receipts.set(observation.phase,receipt);requestId=observation.providerRequestId??requestId;
        };
        const ready=async()=>{signal.throwIfAborted();if(!isDeepStrictEqual(snapshot(claimed),frozen)||claimed.id!==job.id||claimed.leaseToken!==job.leaseToken)throw unavailable();await assertAvailable(claimed);signal.throwIfAborted();};
        const dispatch:IdentityDispatch={
          async authorize(phase,key,hash){await ready();phaseDispatched=true;const reply=z.strictObject({callId:z.uuid(),disposition:z.enum(["started","already_issued"])}).parse(await value("select public.authorize_identity_generation_call($1,$2,$3,$4,$5,$6) value",[claimed.id,claimed.leaseToken,stepKey,phase,key,hash]));
            if(reply.disposition!=="started")return false;callIds.set(phase,reply.callId);phaseDispatched=true;return true;},
          beforeDispatch:ready,
          async observe(observation:IdentityGenerationObservation){
            const callId=callIds.get(observation.phase);if(!callId)throw unavailable();
            const receipt=identityGenerationProviderReceiptSchema.parse(await value("select public.record_identity_generation_response($1,$2,$3,$4) value",[claimed.id,claimed.leaseToken,callId,observation]));
            if(receipt.ownerId!==claimed.ownerId||receipt.projectId!==claimed.projectId||receipt.jobId!==claimed.id||receipt.leaseToken!==claimed.leaseToken||receipt.callId!==callId||!isDeepStrictEqual(receipt.observation,observation))throw unavailable();
            acceptReceipt(receipt);
          },
        };
        const callIds=new Map<string,string>();
        try{
          await ready();
          const loaded=z.strictObject({batch:identityBatchBindingSchema,input:identityGenerationJobInputSchema,systems:z.array(identitySystemVersionSchema).max(3)}).parse(await value("select public.load_identity_generation_input($1,$2) value",[claimed.id,claimed.leaseToken]));
          if(!isDeepStrictEqual(loaded.input,frozen)||loaded.batch.id!==frozen.batchId||loaded.batch.jobId!==claimed.id||!isDeepStrictEqual(loaded.batch.input,frozen.input))throw unavailable();
          if(loaded.systems.length!==index)throw unavailable();
          const priorOrdinals=new Set<number>();
          for(const [priorIndex,prior] of loaded.systems.entries()){
            const ordinal=frozen.systemIds.indexOf(prior.id),source=prior.source;
            if(prior.ownerId!==claimed.ownerId||prior.projectId!==claimed.projectId||!isDeepStrictEqual(prior.input,frozen.input)
              ||source.kind!=="generated"||source.batchId!==frozen.batchId||source.jobId!==claimed.id||ordinal<0||ordinal>=index
              ||ordinal!==priorIndex||source.stepKey!==`identity-system-v1:${ordinal+1}`||priorOrdinals.has(ordinal))throw unavailable();
            priorOrdinals.add(ordinal);
          }
          const knownText=identityGenerationProviderReceiptSchema.nullable().parse(await value("select public.read_identity_generation_call($1,$2,$3,$4) value",[claimed.id,claimed.leaseToken,stepKey,"specifications"]));
          if(knownText){phaseDispatched=true;if(knownText.observation.phase!=="specifications")throw unavailable();acceptReceipt(knownText);}
          const knownBoard=identityGenerationProviderReceiptSchema.nullable().parse(await value("select public.read_identity_generation_call($1,$2,$3,$4) value",[claimed.id,claimed.leaseToken,stepKey,"board"]));
          if(knownBoard){phaseDispatched=true;if(knownBoard.observation.phase!=="board")throw unavailable();acceptReceipt(knownBoard);return unknown("identity_known_board_requires_readback");}
          // Never silently omit selected images to fit a provider limit.
          const references=frozen.input.referenceSnapshot.selected;
          if(!references.length&&!sourceLogo||references.length+(sourceLogo?1:0)>IMAGE_INPUT_LIMITS.images)throw unavailable();
          const images:VerifiedAssetBytes[]=[];let referenceBytes=0;
          if(sourceLogo){
            await ready();const reference=sourceLogo.preview.reference;
            const bytes=verifiedAssetBytesSchema.parse(await read(claimed,reference,signal));
            if(!isDeepStrictEqual(bytes.reference,reference)||bytes.mimeType!==sourceLogo.preview.verification.mimeType
              ||bytes.bytes.byteLength!==sourceLogo.preview.verification.byteLength||identityDigest(bytes.bytes)!==reference.contentHash)throw unavailable();
            referenceBytes=bytes.bytes.byteLength;if(referenceBytes>IMAGE_INPUT_LIMITS.inputBytes)throw unavailable();images.push(bytes);
          }
          for(const entry of references){await ready();const media=entry.reference.media,reference={assetId:media.assetId,versionId:media.versionId,ownerId:claimed.ownerId,projectId:claimed.projectId,contentHash:media.contentHash};
            const bytes=verifiedAssetBytesSchema.parse(await read(claimed,reference,signal));
            if(!isDeepStrictEqual(bytes.reference,reference)||bytes.mimeType!==media.mimeType||identityDigest(bytes.bytes)!==media.contentHash)throw unavailable();
            referenceBytes+=bytes.bytes.byteLength;if(referenceBytes>IMAGE_INPUT_LIMITS.inputBytes)throw unavailable();images.push(bytes);}
          const textKey=identityDigest(`${claimed.id}:${stepKey}:specifications`);
          let text:IdentityProduction<IdentitySystemSpecification>;
          if(knownText){
            const observation=knownText.observation,usage=logoVectorProposalUsageSchema.safeParse(observation.usage);
            // Verify retained responses against either exact released request body.
            // The historical typography list is for observation only; it never authorizes a new call.
            const historicalRequest=createIdentitySpecificationRequest(frozen.input,loaded.systems,index+1,frozen.textPolicy,sourceLogo,1);
            const requestHashes=[identityDigest(JSON.stringify(historicalRequest))];
            try{requestHashes.push(identityDigest(JSON.stringify(createIdentitySpecificationRequest(frozen.input,loaded.systems,index+1,frozen.textPolicy,sourceLogo))));}catch{/* Unsupported saved text retains its original evidence. */}
            if(observation.phase!=="specifications"||observation.requestKey!==textKey||!requestHashes.includes(observation.requestHash)||!observation.responseComplete
              ||!observation.responseId?.startsWith("resp_")||!observation.responseHash||observation.model!==frozen.textPolicy.model||observation.serviceTier!==frozen.textPolicy.serviceTier
              ||!observation.specification||observation.billing.status!=="recorded"||!usage.success||usage.data.inputTokens>frozen.textPolicy.maxInputTokens||usage.data.outputTokens>frozen.textPolicy.maxOutputTokens
              ||observation.billing.confirmedMicrousd!==logoVectorProposalUsageCost(usage.data))return unknown("identity_known_specification_unconfirmed");
            text={status:"completed",value:observation.specification,observation};
          }else text=await producer.specify(frozen.input,loaded.systems,index+1,textKey,signal,dispatch,sourceLogo);
          if(text.status!=="completed")return text.status==="not_dispatched"&&!phaseDispatched?{status:"failed",code:"not_dispatched",costMicrousd:0,providerRequestId:null}:unknown("identity_specification_unconfirmed");
          if(sourceLogo&&(!text.value.applicationDesign||!text.value.components.typography.styles.every(style=>supportedBrandBoardTypography(style,sourceLogo.brief.payload.name))))return unknown("identity_application_design_missing");
          if(loaded.systems.some(s=>isDeepStrictEqual(s.components,text.value.components)))return{status:"failed",code:"duplicate_identity_direction",costMicrousd:cost,providerRequestId:requestId};
          await ready();
          const board=await producer.board(frozen.input,text.value,images,identityDigest(`${claimed.id}:${stepKey}:board`),signal,dispatch,sourceLogo);
          if(board.status!=="completed")return unknown("identity_board_unconfirmed");
          if(loaded.systems.some(s=>s.board.asset.contentHash===board.observation.artifactHash))return{status:"failed",code:"duplicate_identity_board",costMicrousd:cost,providerRequestId:requestId};
          await ready();
          const publication={requestKey:systemId,inputRevisions:[],mimeType:"image/png",contentHash:identityDigest(board.value.bytes),byteLength:board.value.bytes.byteLength,source:{kind:"identity_system" as const,sourceId:systemId}};
          let acknowledgement:unknown;
          // Same immutable bytes/key only. This is persistence replay, never provider retry.
          for(let attempt=0;attempt<2;attempt++){try{await ready();acknowledgement=await publish(claimed,publication,Uint8Array.from(board.value.bytes),signal);break;}catch{if(attempt===1||signal.aborted)throw unavailable();}}
          const asset=identityAssetReceiptSchema.parse(acknowledgement);
          if(asset.publicationState!=="staged"||asset.purpose!=="brand_asset"||asset.sourceReceiptId!==systemId||asset.reference.ownerId!==claimed.ownerId||asset.reference.projectId!==claimed.projectId||asset.reference.contentHash!==publication.contentHash||asset.verification.mimeType!=="image/png"||asset.verification.byteLength!==publication.byteLength)throw unavailable();
          const system=identitySystemVersionSchema.parse({id:systemId,ownerId:claimed.ownerId,projectId:claimed.projectId,createdAt:new Date().toISOString(),input:frozen.input,
            source:{kind:"generated",batchId:frozen.batchId,jobId:claimed.id,stepKey},components:text.value.components,...(text.value.applicationDesign?{applicationDesign:text.value.applicationDesign}:{}),
            board:{asset:{...asset.reference,purpose:"brand_asset",mimeType:"image/png"},depictsSystemVersionId:systemId,staleComponents:[]},productionFiles:[]});
          const output=identityStepOutputSchema.parse({identity:{version:1,operation:"identity.image",ownerId:claimed.ownerId,projectId:claimed.projectId,batchId:frozen.batchId,jobId:claimed.id,stepKey,targetCount:3,input:frozen.input,systems:[system]}});
          const staged=z.strictObject({status:z.literal("staged"),systemVersionId:z.uuid(),stepKey:z.string()}).parse(await value("select public.stage_identity_generation_system($1,$2,$3,$4,$5) value",[claimed.id,claimed.leaseToken,stepKey,output,{textReceiptId:receipts.get("specifications")!.id,imageReceiptId:receipts.get("board")!.id,publicationId:asset.id}]));
          if(staged.systemVersionId!==systemId||staged.stepKey!==stepKey)throw unavailable();
          return{status:"succeeded",result:z.json().parse(output),costMicrousd:cost,providerRequestId:requestId};
        }catch{return phaseDispatched?unknown("identity_outcome_unconfirmed"):{status:"failed",code:"not_dispatched",costMicrousd:0,providerRequestId:null};}
      },
    }));
  }};
}
