import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.FLUID_E2E_PORT ?? "3105");
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("FLUID_E2E_PORT must be a port between 1024 and 65535");
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  retries: 0,
  reporter: "list",
  use: { baseURL, trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["iPhone 13"], defaultBrowserType: "chromium" } },
  ],
  // Exercise the completed build without cold development compilation or a reused preview.
  webServer: { command: `next start --hostname 127.0.0.1 --port ${port}`, url: baseURL, reuseExistingServer: false, timeout: 120_000 },
});
