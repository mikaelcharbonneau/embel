import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createAccountLogoClient } from "../../src/components/identity/account-logo-client";
import { createLogoCreationController } from "../../src/components/logo-creation/creation-controller";
import { LogoCostConfirmationView } from "../../src/components/logo-creation/cost-confirmation";
import { logoCostQuoteSchema, type LogoGenerationIntent } from "../../src/domain/logo-jobs";
import { syntheticLogoQuote, syntheticLogoWorkspace } from "../fixtures/logo-creation";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const response = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
function fixture() {
 const workspace = syntheticLogoWorkspace(), legacy = syntheticLogoQuote();
 const { estimatedCostMicrousd: _estimate, maxCostMicrousd: _maximum, externalProviderCostMicrousd: _external, ...basis } = legacy;
 void [_estimate, _maximum, _external];
 const quote = logoCostQuoteSchema.parse({ ...basis, version: 3, billingMode: "openai_api", spendControl: "uncapped", provider: "openai", model: "gpt-6.1-sol",
  handlerVersion: "logo-directions-api-v1", engine: null, conceptPlan: null, targetSlotIds: [],
  request: { operation: "directions", approvedLogoId: id(900), expected: workspace.heads }, expected: workspace.heads,
  apiPolicy: { version: 1, billingMode: "openai_api", spendControl: "uncapped", handlerVersion: "logo-directions-api-v1", adapterVersion: "logo-directions-openai-v1",
   model: "gpt-6.1-sol", pricingVersion: "2026-10-03", serviceTier: "default", maxInputTokens: 8192, maxOutputTokens: 2048, maxInputBytes: 32768,
   maxOutputBytes: 16384, maxStreamBytes: 131072, deadlineMs: 30000, maxTools: 0, inputMicrousdPerMillionTokens: 2000000,
   cachedInputMicrousdPerMillionTokens: 100000, cacheWriteMicrousdPerMillionTokens: 2500000, outputMicrousdPerMillionTokens: 10000000 } });
 let pending: LogoGenerationIntent | null = null, lose = false;
 const posted: LogoGenerationIntent[] = [];
 const fetcher: typeof fetch = async (url, init) => {
  if (String(url).endsWith("/quotes")) return response(quote);
  if (String(url).endsWith("/requests")) {
   const value = JSON.parse(String(init?.body)) as LogoGenerationIntent; posted.push(value);
   if (lose) throw Error("Synthetic lost admission acknowledgement");
   return response({ ownerId: workspace.ownerId, projectId: workspace.projectId, requestKey: value.requestKey,
    operation: "identity.logo_directions", batchId: null, jobIds: [id(901)], inputHash: quote.inputHash });
  }
  return response({ status: "not_found" });
 };
 const client = createAccountLogoClient({ status: "ready", userId: workspace.ownerId, generation: 1 }, workspace.projectId, () => true, () => {}, fetcher);
 const controller = createLogoCreationController({ client, projectId: workspace.projectId, getWorkspace: () => workspace, hasUnsavedInputs: () => false,
  getPendingIntent: () => pending, retainIntent: value => { pending = value; }, clearIntent: () => { pending = null; }, isOperationAvailable: () => true,
  refreshWorkspace: async () => "reloaded", isCurrent: () => true, now: () => Date.parse("2026-10-06T11:00:00Z"), createRequestKey: () => id(902) });
 return { quote, controller, posted, get pending() { return pending; }, lose(value: boolean) { lose = value; } };
}

describe("uncapped advanced Logo confirmation through the actual account client", () => {
 it("submits the confirmed original operation without a client spending ceiling", async () => {
  const f = fixture(); await f.controller.prepare(f.quote.request);
  expect(f.posted).toHaveLength(0);
  await Promise.all([f.controller.confirmQuote(f.quote.id), f.controller.confirmQuote(f.quote.id)]);
  expect(f.posted).toEqual([{ requestKey: id(902), quoteId: f.quote.id, expected: f.quote.expected }]);
  expect(f.controller.getSnapshot().phase).toBe("active");
 });
 it("retains an uncertain uncapped admission and replays exactly its original body only on explicit retry", async () => {
  const f = fixture(); f.lose(true); await f.controller.prepare(f.quote.request); await f.controller.confirmQuote(f.quote.id);
  const original = f.pending; expect(original).not.toBeNull();
  await f.controller.checkRequest(); expect(f.posted).toHaveLength(1); expect(f.pending).toEqual(original);
  f.lose(false); await f.controller.retryOriginalIntent();
  expect(f.posted).toEqual([original, original]);
 });
 it("shows an ordinary generation review without inventing an estimate or ceiling", () => {
  const f = fixture();
  const html = renderToStaticMarkup(createElement(LogoCostConfirmationView, { quote: f.quote, onConfirm() {} }));
  expect(html).toContain("Review generation"); expect(html).toContain("Build 3 identity directions");
  expect(html).not.toContain("Estimated cost"); expect(html).not.toContain("Maximum cost");
 });
});
