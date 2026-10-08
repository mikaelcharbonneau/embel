import { expect,it,vi } from "vitest";
vi.mock("server-only",()=>({}));
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DirectionGenerationControls } from "@/features/identity-directions/components/direction-generation";
import type { DirectionGeneration } from "@/features/identity-directions/components/use-direction-generation";
import { subscriptionPolicy } from "./subscription-fixtures";
it("labels subscription usage before confirmation without presenting free dollar usage or an allowance estimate",()=>{
 const policy=subscriptionPolicy(),controller={state:{canEstimate:true,fonts:[],generation:{phase:"awaiting_confirmation",quote:{id:"fixture",request:{operation:"directions",approvedLogoId:"fixture"},provider:"openai",model:policy.model,estimatedCostMicrousd:0,maxCostMicrousd:0,externalProviderCostMicrousd:0,billingMode:"chatgpt_subscription",policy}}}} as unknown as DirectionGeneration;
 const html=renderToStaticMarkup(createElement(DirectionGenerationControls,{controller}));expect(html).toContain("ChatGPT subscription usage applies");expect(html).toContain("Remaining allowance is unavailable");expect(html).toContain("No separate API charge");expect(html).not.toContain("$0");expect(html).not.toContain("Estimated cost");expect(html).toContain("Confirm and generate 3 directions");
});
