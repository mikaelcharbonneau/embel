import { defineConfig, devices } from "@playwright/test";
import path from "node:path";
import { fakeProviderPort, journeyStack } from "./tests/journey/stack.mjs";

// The full-journey browser test (tests/journey): the real app in development mode against this
// checkout's local Supabase (npm run dev:up) and a stand-in OpenAI provider. No real AI calls.
const stack = journeyStack();
const browserExecutable = process.env.FLUID_E2E_BROWSER_EXECUTABLE;
if (browserExecutable && !path.isAbsolute(browserExecutable)) throw new Error("FLUID_E2E_BROWSER_EXECUTABLE must be an absolute executable path");

export default defineConfig({
  testDir: "./tests/journey",
  testMatch: "*.spec.ts",
  outputDir: "./test-results/journey",
  globalSetup: "./tests/journey/global-setup.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 15 * 60_000,
  expect: { timeout: 30_000 },
  reporter: process.env.CI ? [["list"], ["html", { open: "never", outputFolder: "playwright-report/journey" }]] : "list",
  use: {
    ...devices["Desktop Chrome"], baseURL: stack.appOrigin, trace: "retain-on-failure", screenshot: "only-on-failure", video: "retain-on-failure",
    actionTimeout: 30_000, navigationTimeout: 120_000,
    ...(browserExecutable ? { launchOptions: { executablePath: browserExecutable } } : {}),
  },
  webServer: [
    { command: "node tests/journey/fake-openai.mjs", url: `http://127.0.0.1:${fakeProviderPort}/__health`, reuseExistingServer: process.env.JOURNEY_REUSE_SERVERS === "1", timeout: 30_000,
      stdout: "pipe", stderr: "pipe" },
    { command: "node tests/journey/app-server.mjs", url: `${stack.appOrigin}/sign-in`, reuseExistingServer: process.env.JOURNEY_REUSE_SERVERS === "1", timeout: 300_000,
      stdout: "pipe", stderr: "pipe" },
  ],
});
