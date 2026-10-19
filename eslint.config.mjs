import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([".next/**", "dist/**", "services/naming-worker/dist/**", ".references/**", ".tmp/**", ".local-fluid/**", "docs/coordination/**/candidate-delta/**", "next-env.d.ts"])
]);
