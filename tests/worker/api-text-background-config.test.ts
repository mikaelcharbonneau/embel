import { expect, it } from "vitest";
import { apiTextBackgroundRecoveryEnabled } from "../../worker/api-text-background-config";
it("requires both explicit opt-ins and defaults off", () => {
  expect(apiTextBackgroundRecoveryEnabled({})).toBe(false);
  expect(apiTextBackgroundRecoveryEnabled({ FLUID_API_TEXT_BACKGROUND_RECOVERY_ENABLED: "true" })).toBe(false);
  expect(apiTextBackgroundRecoveryEnabled({ FLUID_API_TEXT_MULTI_ACCOUNT_ENABLED: "true" })).toBe(false);
  expect(apiTextBackgroundRecoveryEnabled({ FLUID_API_TEXT_MULTI_ACCOUNT_ENABLED: "true", FLUID_API_TEXT_BACKGROUND_RECOVERY_ENABLED: "1" })).toBe(false);
  expect(apiTextBackgroundRecoveryEnabled({ FLUID_API_TEXT_MULTI_ACCOUNT_ENABLED: "true", FLUID_API_TEXT_BACKGROUND_RECOVERY_ENABLED: "true" })).toBe(true);
});
