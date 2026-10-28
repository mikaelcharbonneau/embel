import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { readSharedPoolConfiguration } from "../../worker/shared-pool/configuration";
import { sharedConfiguration } from "./shared-pool-fixture";
const projects = ["prj_waP1hoGVtBiqJCTqTWKHfRy8iLMk", "prj_vTOc6Kf8th7tXK2cOVwWTTaR20yx"];
function production() {
 const config = sharedConfiguration();
 config.target = { kind: "vercel", purpose: "production", applicationOrigin: "https://www.embel.xyz",
  supabaseOrigin: "https://fricsfwqibyhemknqgyf.supabase.co", projectRef: "fricsfwqibyhemknqgyf",
  projectId: projects[0]!, deploymentId: "dpl_synthetic_actual", databaseHost: "db.fricsfwqibyhemknqgyf.supabase.co", databasePort: 5432, caSha256: "e".repeat(64) };
 config.queue.deploymentId = config.target.deploymentId;
 return config;
}
function environment(config = production()) {
 return { NODE_ENV: "production", VERCEL: "1", VERCEL_ENV: "production", VERCEL_PROJECT_ID: config.target.kind === "vercel" ? config.target.projectId : "",
  VERCEL_DEPLOYMENT_ID: "dpl_synthetic_actual", EMBEL_SHARED_WORKER_POOL_ENABLED: "true", EMBEL_SHARED_WORKER_POOL_CONFIGURATION: JSON.stringify(config) };
}
describe("explicit existing production target and trusted deployment bootstrap (configuration only)", () => {
 it.each(projects)("accepts only an explicitly selected existing eligible project %s", project => {
  const config = production(); if (config.target.kind !== "vercel") throw Error("fixture");
  config.target.projectId = project;
  expect(readSharedPoolConfiguration(environment(config))!.target).toEqual(config.target);
 });
 it("materializes both platform selectors without changing the original environment or weakening SQL deployment pins", () => {
  const config = production(), raw = JSON.parse(JSON.stringify(config));
  raw.target.deploymentId = "platform"; raw.queue.deploymentId = "platform";
  const env = { ...environment(config), EMBEL_SHARED_WORKER_POOL_CONFIGURATION: JSON.stringify(raw) }, original = { ...env };
  const parsed = readSharedPoolConfiguration(env)!;
  expect(parsed.target.deploymentId).toBe(env.VERCEL_DEPLOYMENT_ID);
  expect(parsed.queue.deploymentId).toBe(env.VERCEL_DEPLOYMENT_ID);
  expect(env).toEqual(original);
  const next = readSharedPoolConfiguration({ ...env, VERCEL_DEPLOYMENT_ID: "dpl_synthetic_next" })!;
  expect(next.target.deploymentId).toBe("dpl_synthetic_next");
 });
 it.each([
  { VERCEL_DEPLOYMENT_ID: "" }, { VERCEL_DEPLOYMENT_ID: "platform" }, { VERCEL: "0" },
  { VERCEL_ENV: "preview" }, { VERCEL_PROJECT_ID: "prj_unapproved" }
 ])("refuses absent or inconsistent actual platform metadata %#", extra => {
  const raw = production(), value = JSON.parse(JSON.stringify(raw));
  value.target.deploymentId = "platform"; value.queue.deploymentId = "platform";
  expect(() => readSharedPoolConfiguration({ ...environment(raw), ...extra, EMBEL_SHARED_WORKER_POOL_CONFIGURATION: JSON.stringify(value) })).toThrow("configuration");
 });
 it("requires both Queue and target to opt into the platform selector; fixed pins retain exact-match checks", () => {
  const config = production(), value = JSON.parse(JSON.stringify(config)); value.target.deploymentId = "platform";
  expect(() => readSharedPoolConfiguration({ ...environment(config), EMBEL_SHARED_WORKER_POOL_CONFIGURATION: JSON.stringify(value) })).toThrow("configuration");
  expect(() => readSharedPoolConfiguration({ ...environment(config), VERCEL_DEPLOYMENT_ID: "dpl_synthetic_next" })).toThrow("configuration");
 });
 it("refuses changed origins, project, staging relabeling or extra production capacity", () => {
  const mutations = [
   (c: ReturnType<typeof production>) => { c.target.applicationOrigin = "https://embel.xyz"; },
   (c: ReturnType<typeof production>) => { c.target.supabaseOrigin = "https://aaaaaaaaaaaaaaaaaaaa.supabase.co"; },
   (c: ReturnType<typeof production>) => { if (c.target.kind === "vercel") c.target.projectId = "prj_not_an_existing_project"; },
   (c: ReturnType<typeof production>) => { if (c.target.kind === "vercel") c.target.purpose = "staging"; },
   (c: ReturnType<typeof production>) => { c.slots.push({ ...c.slots[0]!, slotId: "99999999-9999-4999-8999-999999999999", roleOid: 9000, roleName: "embel_shared_strategy_extra", workerId: "synthetic-extra" }); c.capacity.maxConcurrentExecutions = 4; }
  ];
  for (const mutate of mutations) { const config = production(); mutate(config); expect(() => readSharedPoolConfiguration(environment(config))).toThrow("configuration"); }
 });
});
