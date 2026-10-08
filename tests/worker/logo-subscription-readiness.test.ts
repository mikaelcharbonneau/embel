import { expect,it,vi } from "vitest";
vi.mock("server-only",()=>({}));
import { createLogoReadiness,freezeLogoWorkerManifest } from "../../worker/logo-readiness";
import { subscriptionFixture } from "../features/identity-directions/subscription-fixtures";
import type { LogoWorkerConnection } from "@/server/data/logo-jobs";
it("freezes and reports the complete dedicated subscription policy without changing legacy descriptors",async()=>{
 const {policy,job}=subscriptionFixture(),capability={operation:"identity.logo_directions",policyIdentity:"b".repeat(64),handlerVersion:policy.handlerVersion,provider:"openai",model:policy.model,engine:null,maxCostMicrousd:0,billingMode:"chatgpt_subscription",policy};
 const manifest=freezeLogoWorkerManifest([capability]);expect(manifest).toEqual([capability]);expect(Object.isFrozen(manifest[0]!.policy!.limits)).toBe(true);
 const query=vi.fn(async()=>({rows:[{value:true}]})), readiness=createLogoReadiness({connection:{query} as unknown as LogoWorkerConnection,workerId:"fixture",manifest});
 await readiness.refresh();await expect(readiness.assertReady(job)).resolves.toBeUndefined();expect(query).toHaveBeenCalledTimes(2);
 const changed={...job,input:{...job.input as object,policy:{...policy,registrationId:"other"}}};await expect(readiness.assertReady(changed)).rejects.toThrow();expect(query).toHaveBeenCalledTimes(2);
 const {billingMode:_b,policy:_p,...legacy}=capability;void _b;void _p;expect(freezeLogoWorkerManifest([legacy])).toEqual([legacy]);
});
it("rejects subscription policies on image manifests and changed money/model/handler descriptors",()=>{
 const {policy}=subscriptionFixture(),capability={operation:"identity.logo_directions",policyIdentity:"b".repeat(64),handlerVersion:policy.handlerVersion,provider:"openai",model:policy.model,engine:null,maxCostMicrousd:0,billingMode:"chatgpt_subscription",policy};
 for(const patch of [{operation:"identity.logo_concept"},{maxCostMicrousd:1},{model:"wrong"},{provider:"wrong"},{handlerVersion:"wrong"},{policy:undefined},{billingMode:undefined}])expect(()=>freezeLogoWorkerManifest([{...capability,...patch}])).toThrow();
});
