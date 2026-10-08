import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: ".", testMatch: "workspace.spec.ts", fullyParallel: false, reporter: "list",
  outputDir: "../../../.tmp/trademark-playwright",
  use: { baseURL: "http://127.0.0.1:3186", screenshot: "only-on-failure" },
  projects: [{ name: "desktop", use: { ...devices["Desktop Chrome"] } }, { name: "mobile", use: { ...devices["iPhone 13"], defaultBrowserType: "chromium" } }],
  webServer: { command: "node tests/features/trademark-workspace/fixture-server.mjs", cwd: new URL("../../..", import.meta.url).pathname, url: "http://127.0.0.1:3186", reuseExistingServer: false },
});
