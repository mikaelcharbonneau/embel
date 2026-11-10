import { describe, expect, it } from "vitest";
import { IMAGE_MODEL, resolveModelRoute, providerFailureSchema, operationSchema } from "../../src/domain/providers";

import { logoOperationSchema } from "../../src/domain/logo-jobs";

describe("provider routing gates", () => {
  const base = {
    paidCallsApproved: true,
    credentialsPresent: true,
    verifiedModelIds: [IMAGE_MODEL, "chosen-text-model"],
    textModels: { "strategy.reformulate": "chosen-text-model" },
  };

  it("defaults to blocked and never invents live capability", () => {
    expect(resolveModelRoute("strategy.reformulate", { ...base, paidCallsApproved: false })).toEqual({
      status: "blocked",
      reason: "budget_not_approved",
    });
    expect(resolveModelRoute("strategy.reformulate", { ...base, credentialsPresent: false }).status).toBe("blocked");
    expect(resolveModelRoute("naming.generate", base)).toEqual({ status: "blocked", reason: "model_not_selected" });
  });

  it("allows per-operation text choice without imposing the development model", () => {
    expect(resolveModelRoute("strategy.reformulate", base)).toEqual({
      status: "ready",
      provider: "openai",
      model: "chosen-text-model",
      liveValidated: false,
    });
  });

  it("uses only verified Sunburst and does not fall back", () => {
    expect(resolveModelRoute("identity.image", base)).toMatchObject({ status: "ready", model: IMAGE_MODEL });
    expect(resolveModelRoute("identity.image", { ...base, verifiedModelIds: ["different-image-model"] })).toEqual({
      status: "blocked",
      reason: "model_access_unverified",
    });
  });

  it("requires reconciliation for an unknown paid outcome", () => {
    expect(
      providerFailureSchema.safeParse({ kind: "ambiguous", message: "Request timed out", retrySafe: true }).success,
    ).toBe(false);
    expect(
      providerFailureSchema.safeParse({ kind: "ambiguous", message: "Request timed out", retrySafe: false }).success,
    ).toBe(true);
  });
  it("recognizes additive logo jobs without routing them through the legacy model selector", () => {
    for (const operation of logoOperationSchema.options) {
      expect(operationSchema.safeParse(operation).success).toBe(true);
      expect(resolveModelRoute(operation as Parameters<typeof resolveModelRoute>[0], base)).toEqual({
        status: "blocked",
        reason: "pipeline_not_implemented",
      });
    }
    expect(operationSchema.safeParse("identity.logo_unknown").success).toBe(false);
  });
});
