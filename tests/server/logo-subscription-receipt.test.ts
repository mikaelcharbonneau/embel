import { expect,it,vi } from "vitest";
vi.mock("server-only",()=>({}));
import { recordLogoProviderResponse, type LogoWorkerConnection } from "@/server/data/logo-jobs";
import { subscriptionFixture } from "../features/identity-directions/subscription-fixtures";
import { id } from "../features/identity-directions/fixtures";
import type { LogoProviderObservation } from "@/domain/logo-jobs";
it("compares all parsed union observation metadata without dropping subscription identity",async()=>{
 const {job,policy}=subscriptionFixture();const observation:LogoProviderObservation={provider:"openai",model:policy.model,providerRequestId:null,responseHash:"a".repeat(64),observedAt:"2026-10-07T00:00:00Z",billing:{status:"recorded",confirmedMicrousd:0},artifactHash:null,version:2,billingMode:"chatgpt_subscription",registrationId:policy.registrationId,responseId:"resp_fixture",usage:null};
 let receipt={...observation,id:id(91),ownerId:job.ownerId,projectId:job.projectId,jobId:job.id,leaseToken:job.leaseToken};const query=vi.fn(async()=>({rows:[{value:receipt}]}));const connection={query} as unknown as LogoWorkerConnection;
 expect(await recordLogoProviderResponse(connection,job,observation)).toEqual(receipt);
 receipt={...receipt,registrationId:"other"};await expect(recordLogoProviderResponse(connection,job,observation)).rejects.toThrow();
 receipt={...receipt,registrationId:policy.registrationId,responseId:"resp_other"};await expect(recordLogoProviderResponse(connection,job,observation)).rejects.toThrow();
 receipt={...receipt,responseId:"resp_fixture",usage:{inputTokens:1,outputTokens:1,totalTokens:2}} as never;await expect(recordLogoProviderResponse(connection,job,observation)).rejects.toThrow();
});
