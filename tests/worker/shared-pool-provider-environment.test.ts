import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { readSharedPoolConfiguration } from "../../worker/shared-pool/configuration";
import { readSharedPoolSecrets } from "../../worker/shared-pool/secrets";
import { sharedConfiguration, sharedEnvironment, sharedSecrets } from "./shared-pool-fixture";

function fixture(projectId = "prj_waP1hoGVtBiqJCTqTWKHfRy8iLMk") {
 const config = sharedConfiguration(), caPem = "synthetic-inert-CA-material-".repeat(5);
 config.target = { kind: "vercel", purpose: "production", applicationOrigin: "https://www.embel.xyz",
  supabaseOrigin: "https://fricsfwqibyhemknqgyf.supabase.co", projectRef: "fricsfwqibyhemknqgyf", projectId,
  deploymentId: "dpl_synthetic_appkey_binding", databaseHost: "db.fricsfwqibyhemknqgyf.supabase.co", databasePort: 5432,
  caSha256: createHash("sha256").update(caPem).digest("hex") };
 config.queue.deploymentId = config.target.deploymentId;
 const secrets = sharedSecrets(config);
 for (const slot of config.slots) Object.assign(secrets.slots[slot.slotId]!, { caPem,
  databaseUrl: "postgresql://" + slot.roleName + ":inert-db-fixture@db.fricsfwqibyhemknqgyf.supabase.co:5432/postgres?sslmode=verify-full" });
 const reference = (lane: "strategy" | "naming" | "logo") => {
  const { bindingRef, model, modelVerificationReceipt } = secrets.providers[lane];
  return { bindingRef, model, modelVerificationReceipt, apiKeyEnvironment: "OPENAI_API_KEY" };
 };
 const input = { version: 1, slots: secrets.slots, providers: { strategy: reference("strategy"), naming: reference("naming"), logo: reference("logo") } };
 const env = { NODE_ENV: "production", VERCEL: "1", VERCEL_ENV: "production", VERCEL_PROJECT_ID: projectId,
  VERCEL_DEPLOYMENT_ID: config.target.deploymentId, EMBEL_SHARED_WORKER_POOL_ENABLED: "true",
  EMBEL_SHARED_WORKER_POOL_CONFIGURATION: JSON.stringify(config), EMBEL_SHARED_WORKER_POOL_SECRETS: JSON.stringify(input),
  OPENAI_API_KEY: "synthetic-existing-application-key" };
 return { config, secrets, input, env };
}

describe("explicit existing production process provider key binding (inert environment only)", () => {
 it.each(["prj_waP1hoGVtBiqJCTqTWKHfRy8iLMk", "prj_vTOc6Kf8th7tXK2cOVwWTTaR20yx"])("resolves only the explicit key reference in selected existing project %s", projectId => {
  const f = fixture(projectId), config = readSharedPoolConfiguration(f.env)!;
  const resolved = readSharedPoolSecrets(config, f.env);
  for (const lane of ["strategy", "naming", "logo"] as const) {
   expect(resolved.providers[lane].apiKey).toBe(f.env.OPENAI_API_KEY);
   expect(resolved.providers[lane]).not.toHaveProperty("apiKeyEnvironment");
  }
  expect(JSON.stringify(resolved)).not.toContain(f.env.OPENAI_API_KEY);
  expect(f.env.EMBEL_SHARED_WORKER_POOL_SECRETS).not.toContain(f.env.OPENAI_API_KEY);
 });
 it("retains explicit literal keys and never reads or silently falls back to an ambient application/agent key", () => {
  const config = sharedConfiguration(), env = sharedEnvironment(config), read = vi.fn(() => { throw Error("Ambient key must not be read"); });
  Object.defineProperty(env, "OPENAI_API_KEY", { get: read });
  expect(readSharedPoolSecrets(config, env)).toEqual(sharedSecrets(config));
  expect(read).not.toHaveBeenCalled();
  const f = fixture();
  expect(readSharedPoolSecrets(f.config, { ...f.env, EMBEL_SHARED_WORKER_POOL_SECRETS: JSON.stringify(f.secrets) })).toEqual(f.secrets);
 });
 it("refuses local/cloud-agent configuration even when a production-shaped config is supplied separately", () => {
  const f = fixture(), local = { ...sharedEnvironment(), EMBEL_SHARED_WORKER_POOL_SECRETS: JSON.stringify(f.input) };
  const read = vi.fn(() => "synthetic-cloud-agent-key-must-not-be-read");
  Object.defineProperty(local, "OPENAI_API_KEY", { get: read });
  expect(() => readSharedPoolSecrets(f.config, local)).toThrow("secrets");
  expect(read).not.toHaveBeenCalled();
 });
 it("refuses a well-formed development binding using a key reference before reading the cloud-agent key", () => {
  const config = sharedConfiguration(), original = sharedSecrets(config);
  const ref = (lane: "strategy" | "naming" | "logo") => ({ bindingRef: original.providers[lane].bindingRef, model: original.providers[lane].model,
   modelVerificationReceipt: original.providers[lane].modelVerificationReceipt, apiKeyEnvironment: "OPENAI_API_KEY" });
  const env = { ...sharedEnvironment(config), EMBEL_SHARED_WORKER_POOL_SECRETS: JSON.stringify({ ...original, providers: { strategy: ref("strategy"), naming: ref("naming"), logo: ref("logo") } }) };
  const read = vi.fn(() => "synthetic-cloud-agent-key-must-not-be-read"); Object.defineProperty(env, "OPENAI_API_KEY", { get: read });
  expect(() => readSharedPoolSecrets(config, env)).toThrow("secrets"); expect(read).not.toHaveBeenCalled();
 });
 it.each([
  { NODE_ENV: "test" }, { VERCEL: "0" }, { VERCEL_ENV: "preview" }, { VERCEL_PROJECT_ID: "prj_wrong_project" },
  { VERCEL_DEPLOYMENT_ID: "dpl_wrong_deployment" }, { EMBEL_SHARED_WORKER_POOL_ENABLED: "false" }
 ])("refuses mismatched actual process metadata %# before reading a key", extra => {
  const f = fixture(), env = { ...f.env, ...extra }, read = vi.fn(() => "synthetic-key-must-not-be-read");
  Object.defineProperty(env, "OPENAI_API_KEY", { get: read });
  expect(() => readSharedPoolSecrets(f.config, env)).toThrow("secrets"); expect(read).not.toHaveBeenCalled();
 });
 it("refuses staging even when its selected public target and actual metadata are internally consistent", () => {
  const f = fixture(); if (f.config.target.kind !== "vercel") throw Error("fixture");
  f.config.target = { ...f.config.target, purpose: "staging", applicationOrigin: "https://staging.fixture.invalid",
   supabaseOrigin: "https://abcdefghijklmnopqrst.supabase.co", projectRef: "abcdefghijklmnopqrst", databaseHost: "db.abcdefghijklmnopqrst.supabase.co" };
  for (const slot of f.config.slots) f.input.slots[slot.slotId]!.databaseUrl = f.input.slots[slot.slotId]!.databaseUrl.replace("fricsfwqibyhemknqgyf", "abcdefghijklmnopqrst");
  const env = { ...f.env, EMBEL_SHARED_WORKER_POOL_CONFIGURATION: JSON.stringify(f.config), EMBEL_SHARED_WORKER_POOL_SECRETS: JSON.stringify(f.input) };
  const read = vi.fn(() => "synthetic-staging-key-must-not-be-read"); Object.defineProperty(env, "OPENAI_API_KEY", { get: read });
  expect(readSharedPoolConfiguration(env)!.target.kind).toBe("vercel");
  expect(() => readSharedPoolSecrets(f.config, env)).toThrow("secrets"); expect(read).not.toHaveBeenCalled();
 });
 it("accepts paired platform selectors only after they resolve to the actual deployment", () => {
  const f = fixture(), raw = JSON.parse(f.env.EMBEL_SHARED_WORKER_POOL_CONFIGURATION);
  raw.target.deploymentId = "platform"; raw.queue.deploymentId = "platform";
  const env = { ...f.env, EMBEL_SHARED_WORKER_POOL_CONFIGURATION: JSON.stringify(raw) };
  const config = readSharedPoolConfiguration(env)!;
  expect(readSharedPoolSecrets(config, env).providers.strategy.apiKey).toBe(f.env.OPENAI_API_KEY);
 });
 it.each(["", "short", "malformed key with spaces"])("rejects missing or malformed installed key without exposing it: %#", value => {
  const f = fixture(); let error: unknown;
  try { readSharedPoolSecrets(f.config, { ...f.env, OPENAI_API_KEY: value }); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(Error); expect(String(error)).toBe("Error: shared_pool_secrets_unavailable");
 });
 it("rejects arbitrary environment names, ambiguous literal+reference and missing key inputs without fallback", () => {
  const f = fixture();
  for (const strategy of [
   { ...f.input.providers.strategy, apiKeyEnvironment: "UNRELATED_SECRET" },
   { ...f.input.providers.strategy, apiKey: f.env.OPENAI_API_KEY },
   { bindingRef: "provider:strategy", model: "synthetic-strategy-model", modelVerificationReceipt: "receipt:strategy" }
  ]) {
   const env = { ...f.env, EMBEL_SHARED_WORKER_POOL_SECRETS: JSON.stringify({ ...f.input, providers: { ...f.input.providers, strategy } }) };
   expect(() => readSharedPoolSecrets(f.config, env)).toThrow("secrets");
  }
 });
 it("validates immutable provider metadata before reading the installed key", () => {
  const f = fixture(); f.input.providers.strategy.modelVerificationReceipt = "mismatched-receipt";
  const env = { ...f.env, EMBEL_SHARED_WORKER_POOL_SECRETS: JSON.stringify(f.input) }, read = vi.fn(() => "synthetic-key-must-not-be-read");
  Object.defineProperty(env, "OPENAI_API_KEY", { get: read });
  expect(() => readSharedPoolSecrets(f.config, env)).toThrow("secrets"); expect(read).not.toHaveBeenCalled();
 });
});
