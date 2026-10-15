import { defineConfig, devices } from "@playwright/test";
export default defineConfig({ testDir: "../e2e", testMatch: "logo-creation.spec.ts", fullyParallel: false, workers: 1, retries: 0, timeout: 15000,
  outputDir: "../../.tmp/logo-creation-browser/results", reporter: "list",
  use: { baseURL: "http://127.0.0.1:3115", trace: "retain-on-failure", screenshot: "only-on-failure", launchOptions: process.env.FLUID_TEST_CHROMIUM_EXECUTABLE ? { executablePath: process.env.FLUID_TEST_CHROMIUM_EXECUTABLE } : {} },
  projects: [{ name: "desktop", use: { ...devices["Desktop Chrome"] } }, { name: "mobile", use: { ...devices["iPhone 13"], defaultBrowserType: "chromium" } }],
  webServer: { command: "node tests/fixtures/logo-creation-browser-server.mjs", url: "http://127.0.0.1:3115", reuseExistingServer: false, timeout: 120000, cwd: "../.." },
});
