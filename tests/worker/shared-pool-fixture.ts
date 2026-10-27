import type { SharedPoolConfiguration } from "../../worker/shared-pool/configuration";
import type { SharedPoolSecrets } from "../../worker/shared-pool/secrets";
import type { SharedSlotLease } from "../../worker/shared-pool/contracts";
import { SHARED_CORE_RPC_PROOFS,SHARED_LANE_RPC_PROOFS,SHARED_STRATEGY_OUTBOX_PROOF } from "../../worker/shared-pool/proofs";
export const sharedInstance="11111111-1111-4111-8111-111111111111";
export function sharedConfiguration():SharedPoolConfiguration{
 const slots=(["strategy","naming","logo"] as const).map((lane,i)=>({slotId:`${i+2}2222222-2222-4222-8222-222222222222`,lane,roleName:`embel_shared_${lane}_fixture`,roleOid:1000+i,workerId:`synthetic-${lane}-slot`,providerBindingRef:`provider:${lane}`,
  model:`synthetic-${lane}-model`,modelVerificationReceipt:`receipt:${lane}`,policies:{[lane==="naming"?"naming.generate":lane==="logo"?"identity.logo_concept":"strategy.reformulate"]:{version:1,model:`synthetic-${lane}-model`}},gatewayProof:{...SHARED_LANE_RPC_PROOFS[lane]},...(lane==="strategy"?{outboxProof:{...SHARED_STRATEGY_OUTBOX_PROOF}}:{})}));
 return{version:1,target:{kind:"development",applicationOrigin:"http://127.0.0.1:3105",supabaseOrigin:"http://127.0.0.1:54321",databaseHost:"127.0.0.1",databasePort:54322,deploymentId:"synthetic-shared-development"},
  artifact:{sourceRevision:"b".repeat(40),artifactSha256:"c".repeat(64),runtime:{node:process.versions.node,icu:process.versions.icu!,unicode:process.versions.unicode!,platform:"linux",arch:"x64"}},
  coreProofs:structuredClone(SHARED_CORE_RPC_PROOFS),
  capacity:{maxConcurrentExecutions:3,maxPerTenantPerLane:1,leaseSeconds:45,renewalMs:10_000,idlePollMs:100,drainTimeoutMs:1000},
  queue:{region:"iad1",topic:"embel-shared-strategy-v1",consumerGroup:"embel-shared-strategy-workers",deploymentId:"synthetic-shared-development",visibilityTimeoutSeconds:300,handlerDeadlineMs:270_000,emptyPollMs:100,errorPollMs:100,concurrency:1},slots};
}
export function sharedSecrets(config=sharedConfiguration()):SharedPoolSecrets{
 return{version:1,slots:Object.fromEntries(config.slots.map(slot=>[slot.slotId,{databaseUrl:`postgresql://${slot.roleName}:synthetic-inert-slot-password@127.0.0.1:54322/postgres`,
  ...(slot.lane==="logo"?{storage:{authUserId:"55555555-5555-4555-8555-555555555555",publishableKey:"sb_publishable_synthetic_shared_key",email:"fixed-slot@fixture.invalid",password:"synthetic-inert-storage-password"}}:{})}])),
  providers:{strategy:{bindingRef:"provider:strategy",apiKey:"synthetic-strategy-provider-key",model:"synthetic-strategy-model",modelVerificationReceipt:"receipt:strategy"},
   naming:{bindingRef:"provider:naming",apiKey:"synthetic-naming-provider-key",model:"synthetic-naming-model",modelVerificationReceipt:"receipt:naming"},
   logo:{bindingRef:"provider:logo",apiKey:"synthetic-logo-provider-key",model:"synthetic-logo-model",modelVerificationReceipt:"receipt:logo"}}};
}
export function sharedEnvironment(config=sharedConfiguration(),secrets=sharedSecrets(config)){
 return{NODE_ENV:"test",EMBEL_DEVELOPMENT_ENABLED:"true",EMBEL_SHARED_WORKER_POOL_ENABLED:"true",EMBEL_SHARED_WORKER_POOL_CONFIGURATION:JSON.stringify(config),EMBEL_SHARED_WORKER_POOL_SECRETS:JSON.stringify(secrets)};
}
export function sharedLease(config=sharedConfiguration(),lane:"strategy"|"naming"|"logo"="strategy",instance=sharedInstance,generation=1):SharedSlotLease{
 const slot=config.slots.find(s=>s.lane===lane)!;
 return{version:1,slotId:slot.slotId,instanceId:instance,lane,generation,leaseToken:"66666666-6666-4666-8666-666666666666",expiresAt:new Date(Date.now()+45_000).toISOString(),roleName:slot.roleName,roleOid:slot.roleOid};
}
