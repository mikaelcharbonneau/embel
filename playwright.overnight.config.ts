import { defineConfig } from "@playwright/test";
import config from "./playwright.config";
export default defineConfig({
  ...config,
  testMatch: /overnight-review\.spec\.ts/,
  use: {
    ...config.use,
    launchOptions: { executablePath: "/usr/bin/chromium", args: ["--no-sandbox", "--disable-dev-shm-usage"] },
  },
  workers: 1,
  outputDir: "output/overnight/browser",
  reporter: [["list"], ["json", { outputFile: "output/overnight/browser-results.json" }]],
});
