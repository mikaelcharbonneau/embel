import { defineConfig } from "@playwright/test";
import base from "./logo-creation-playwright.config";
export default defineConfig({
  ...base,
  testMatch: "logo-refinement-history.spec.ts",
  outputDir: "../../.tmp/logo-refinement-history-browser/results",
});
