import { isDeepStrictEqual } from "node:util";
import type { ClaimedJob } from "../../src/domain/jobs";
import { logoDirectionsApiJobInputSchema,logoProviderObservationSchema,logoProviderResponseReceiptSchema } from "../../src/domain/logo-jobs";
import { loadDirectionInputs,stageLogoDirections,readLeasedLogoRecord,type LogoWorkerConnection } from "../../src/server/data/logo-jobs";
import { createLogoVectorProposalWorkerPorts } from "../../src/server/data/logo-vector-proposal-worker";
import type { IdentityAssetStore } from "../../src/server/data/identity-asset-store";
import type {OpenAIImageTransport} from "../../src/server/logo-creation/openai-image-transport";
import type { OpenAIResponsesTransport } from "../../src/server/ai/openai-transport";
import type { IdentityGenerationRuntimeInput } from "../identity/runtime";
import { createLogoVectorRuntimeAdapter } from "../logo-vector/runtime-adapter";
import { createLogoExportsRuntimeAdapter } from "../logo-exports/runtime-adapter";
import { createLogoVectorProposalRuntimeAdapter } from "../logo-vector/proposal-runtime-adapter";
import { createLogoVectorHandler } from "../logo-vector/handler";
import { createLogoExportsHandler } from "../handlers/logo-exports";
import { createLogoDirectionsHandler } from "../handlers/logo-directions";
import { createLogoVectorProposalHandler } from "../handlers/logo-vector-proposals";
import { SUNBURST_STANDARD_IMAGE_PRICING } from "../../src/server/logo-creation/openai-image-pricing";
import type { JobHandler } from "../runner";
import type { SharedLaneBase } from "./contracts";
import { createSharedDirectionsApiProvider } from "./logo-directions-api";
import type { SharedLogoCapability } from "./logo-capability";
export type SharedIdentityFactory=(options:IdentityGenerationRuntimeInput)=>JobHandler|null;
/** Concrete handlers only; no operation is advertised from a name/model alone. */
export function createSharedAdvancedLogoHandler(options:{job:ClaimedJob;capability:SharedLogoCapability;connection:LogoWorkerConnection;assets:IdentityAssetStore|null;
 provider:SharedLaneBase["provider"];textProvider?:SharedLaneBase["provider"];identityFactory?:SharedIdentityFactory;
 acceptingWork:()=>boolean;assertAvailable:(job:ClaimedJob)=>Promise<void>;textTransport?:OpenAIResponsesTransport;imageTransport?:OpenAIImageTransport}):JobHandler{
 const {job,capability,connection,assets,assertAvailable}=options;
 if(job.operation!==capability.operation)throw Error("shared_logo_operation_unavailable");
 switch(capability.operation){
  case "identity.logo_vectorize":{
   const adapter=createLogoVectorRuntimeAdapter({ownerId:job.ownerId,policyIdentity:capability.policyIdentity,connection,assets,assertAvailable});
   if(!adapter||!isDeepStrictEqual(adapter.capability,capability))break;return createLogoVectorHandler(adapter.dependencies);
  }
  case "identity.logo_export":{
   const adapter=createLogoExportsRuntimeAdapter({ownerId:job.ownerId,connection,assets,assertAvailable});
   if(!adapter||!isDeepStrictEqual(adapter.capability,capability))break;return createLogoExportsHandler(adapter.dependencies);
  }
  case "identity.logo_vector_propose":{
   if(!options.textProvider||!("textPolicy" in capability)||!capability.textPolicy||options.textProvider.model!==capability.textPolicy.model)break;
   const adapter=createLogoVectorProposalRuntimeAdapter({ownerId:job.ownerId,policyIdentity:capability.policyIdentity,
    configuration:{operation:"identity.logo_vector_propose",paidCallsApproved:true,textPolicy:capability.textPolicy},ports:createLogoVectorProposalWorkerPorts(connection),
    apiKey:options.textProvider.apiKey,transport:options.textTransport,acceptingWork:options.acceptingWork});
   if(!adapter||!isDeepStrictEqual(adapter.capability,capability))break;return createLogoVectorProposalHandler(adapter.proposals);
  }
  case "identity.logo_directions":{
   if(!assets||!("apiPolicy" in capability)||!options.textProvider||options.textProvider.model!==capability.apiPolicy.model)break;
   const provider=createSharedDirectionsApiProvider({ownerId:job.ownerId,policy:capability.apiPolicy,apiKey:options.textProvider.apiKey,transport:options.textTransport,acceptingWork:options.acceptingWork});
   const snapshot=(current:ClaimedJob)=>{const input=logoDirectionsApiJobInputSchema.parse(current.input);
    if(current.id!==job.id||current.leaseToken!==job.leaseToken||current.ownerId!==job.ownerId||current.projectId!==job.projectId
     ||input.policyIdentity!==capability.policyIdentity||!isDeepStrictEqual(input.apiPolicy,capability.apiPolicy))throw Error("shared_directions_binding");return current;};
   return createLogoDirectionsHandler({provider,assets,
    loadInput:current=>loadDirectionInputs(connection,assets,snapshot(current)),
    async assertReady(current){await assertAvailable(snapshot(current));if(await readLeasedLogoRecord(connection,current,"runtime_readiness")!==true)throw Error("shared_directions_readiness");},
    async recordResponse(current,observation){const claim=snapshot(current),parsed=logoProviderObservationSchema.parse(observation);
     const result=await connection.query<{value:unknown}>("select public.record_logo_provider_response($1,$2,$3) value",[claim.id,claim.leaseToken,JSON.stringify(parsed)]);
     return logoProviderResponseReceiptSchema.parse(result.rows[0]?.value);},
    publish:(current,result,receipt,signal)=>stageLogoDirections(connection,assets,snapshot(current),result,receipt,signal)});
  }
  case "identity.image":{
   if(!assets||!options.identityFactory||!options.textProvider||!("textPolicy" in capability))break;
   const handler=options.identityFactory({ownerId:job.ownerId,capability,textProvider:options.textProvider,
    image:{apiKey:options.provider.apiKey,model:options.provider.model,rateVersion:SUNBURST_STANDARD_IMAGE_PRICING.binding.rateVersion,paidCallsApproved:true},
    connection,assets,assertAvailable,acceptingWork:options.acceptingWork,textTransport:options.textTransport,imageTransport:options.imageTransport});
   if(handler)return handler;break;
  }
 }
 throw Error("shared_logo_operation_unavailable");
}
