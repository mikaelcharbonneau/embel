import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/live/**/*.live.ts"],
    environment: "node",
    fileParallelism: false,
    testTimeout: 15000,
    hookTimeout: 30000,
    retry: 0,
  },
});
