import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "../../e2e",
  testMatch: "logo-vector-editor.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 15000,
  outputDir: "../../../.tmp/logo-vector-browser/results",
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:3117",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    launchOptions: { executablePath: process.env.FLUID_TEST_CHROMIUM_EXECUTABLE ?? "/usr/bin/chromium" },
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["iPhone 13"], defaultBrowserType: "chromium" } },
  ],
  webServer: {
    command: "node tests/features/logo-vector/browser-server.mjs",
    url: "http://127.0.0.1:3117",
    reuseExistingServer: false,
    timeout: 30000,
    cwd: "../../..",
  },
});
