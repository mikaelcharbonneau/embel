import { expect,it,vi } from "vitest";
vi.mock("server-only",()=>({}));
import { stageLogoDirections } from "@/features/identity-directions/server/publication";
import { normalizeDirectionResponse } from "@/features/identity-directions/server/direction-response";
import type { IdentityAssetStore } from "@/server/data/identity-asset-store";
import type { LogoProviderResponseReceipt } from "@/domain/logo-jobs";
import { subscriptionFixture } from "./subscription-fixtures";
import { id } from "./fixtures";
it("rejects missing or wrong subscription response identity before leased asset reads",async()=>{
 const {job,policy,input,candidate}=subscriptionFixture(),result=normalizeDirectionResponse(candidate,input),query=vi.fn(async()=>({rows:[]}));
 const receipt:LogoProviderResponseReceipt={version:2,billingMode:"chatgpt_subscription",provider:"openai",model:policy.model,registrationId:policy.registrationId,responseId:"resp_fixture",providerRequestId:null,responseHash:"a".repeat(64),artifactHash:null,usage:null,observedAt:"2026-10-07T00:00:00Z",billing:{status:"recorded",confirmedMicrousd:0},id:id(92),ownerId:job.ownerId,projectId:job.projectId,jobId:job.id,leaseToken:job.leaseToken};
 for(const patch of [{responseId:null},{responseHash:null},{registrationId:"wrong"},{model:"wrong"}])await expect(stageLogoDirections({query},job,result,{...receipt,...patch},{} as IdentityAssetStore,new AbortController().signal)).rejects.toThrow();
 expect(query).not.toHaveBeenCalled();
});
