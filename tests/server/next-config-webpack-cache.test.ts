import { expect, it } from "vitest";
import { appConfig } from "../../next.config";

// Skew Protection: next/font bakes the deployment id into its CSS and class name, so a
// webpack cache restored from another deployment must not be reused (vercel/next.js#100642).
const runHook = (deploymentId: string | undefined) => {
  const webpackConfig = { cache: { type: "filesystem", version: "next|16" } };
  const context = { config: { deploymentId } } as unknown as Parameters<NonNullable<typeof appConfig.webpack>>[1];
  return appConfig.webpack!(webpackConfig, context) as typeof webpackConfig;
};

it("keys the webpack build cache to the deployment id when one is set", () => {
  expect(runHook("dpl_AAA").cache.version).toBe("next|16|dpl_AAA");
  expect(runHook("dpl_BBB").cache.version).not.toBe(runHook("dpl_AAA").cache.version);
});

it("leaves the webpack build cache key alone without a deployment id", () => {
  expect(runHook(undefined).cache.version).toBe("next|16");
});
