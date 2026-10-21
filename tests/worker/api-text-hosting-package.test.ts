import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
describe("separate worker deployment contract", () => {
  const configuration = JSON.parse(readFileSync(new URL("../../services/api-text-worker/vercel.json", import.meta.url), "utf8"));
  it("makes exactly one private deployment-pinned Queue consumer with bounded deliveries", () => {
    expect(configuration.regions).toEqual(["iad1"]);
    expect(configuration.fluid).toBe(true);
    expect(configuration.functions["api/consume.js"]).toEqual({ maxDuration: 300, experimentalTriggers: [{ type: "queue/v2beta", topic: "fluid-api-text-v1", retryAfterSeconds: 60, maxDeliveries: 5 }] });
    expect(Object.keys(configuration.functions).sort()).toEqual(["api/consume.js", "api/cron/repair-api-text.js", "api/enqueue.js", "api/readiness.js"]);
  });
  it("keeps minute-scale recovery inside the worker Production package without web secrets/configuration", () => {
    expect(configuration.crons).toEqual([{ path: "/api/cron/repair-api-text", schedule: "* * * * *" }]);
    expect(configuration).not.toHaveProperty("env"); expect(configuration).not.toHaveProperty("build.env");
    expect(configuration.framework).toBeNull();
    expect(configuration.functions["api/enqueue.js"].maxDuration).toBe(30);
    expect(configuration.functions["api/readiness.js"].maxDuration).toBe(15);
    expect(configuration.functions["api/cron/repair-api-text.js"].maxDuration).toBe(60);
  });
});
