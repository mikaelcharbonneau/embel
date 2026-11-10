import { defineConfig, devices } from "@playwright/test";
import path from "node:path";

const port = Number(process.env.FLUID_E2E_PORT ?? "3105");
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error("FLUID_E2E_PORT must be a port between 1024 and 65535");
const baseURL = `http://127.0.0.1:${port}`;
// Optional local fallback when the bundled headless shell cannot run on the host.
const browserChannel = process.env.FLUID_E2E_BROWSER_CHANNEL;
if (browserChannel && browserChannel !== "chrome")
  throw new Error("FLUID_E2E_BROWSER_CHANNEL only supports the chrome override");
// Cloud images can supply Chromium without a checkout-specific config file.
const browserExecutable = process.env.FLUID_E2E_BROWSER_EXECUTABLE;
if (
  browserExecutable &&
  (!path.isAbsolute(browserExecutable) ||
    browserExecutable.trim() !== browserExecutable ||
    /[\x00-\x1f\x7f]/u.test(browserExecutable))
) {
  throw new Error("FLUID_E2E_BROWSER_EXECUTABLE must be an absolute executable path");
}
if (browserExecutable && browserChannel) {
  throw new Error("Set only one of FLUID_E2E_BROWSER_EXECUTABLE and FLUID_E2E_BROWSER_CHANNEL");
}

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  retries: 0,
  reporter: "list",
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    ...(browserChannel === "chrome" ? { channel: "chrome" } : {}),
    ...(browserExecutable ? { launchOptions: { executablePath: browserExecutable } } : {}),
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["iPhone 13"], defaultBrowserType: "chromium" } },
  ],
  // Exercise the completed build without cold development compilation or a reused preview.
  webServer: {
    command: `next start --hostname 127.0.0.1 --port ${port}`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
