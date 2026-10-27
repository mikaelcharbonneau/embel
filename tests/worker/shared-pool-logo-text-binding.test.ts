import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { readSharedPoolConfiguration } from "../../worker/shared-pool/configuration";
import { readSharedPoolSecrets } from "../../worker/shared-pool/secrets";
import { sharedConfiguration, sharedEnvironment, sharedSecrets } from "./shared-pool-fixture";

function fixture() {
 const config = sharedConfiguration(), logo = config.slots.find(slot => slot.lane === "logo")!;
 logo.textProvider = { providerBindingRef: "provider:logo-text", model: "gpt-6.1-sol", modelVerificationReceipt: "receipt:logo-text" };
 const secrets = sharedSecrets(config);
 secrets.providers.logoText = { bindingRef: "provider:logo-text", model: "gpt-6.1-sol", modelVerificationReceipt: "receipt:logo-text", apiKey: "synthetic-inert-logo-text-key" };
 return { config, logo, secrets };
}

describe("finite shared Logo/Identity text-provider authority", () => {
 it("retains exactly three slot identities while admitting all seven explicit image/native/text operations", () => {
  const f = fixture();
  for (const operation of ["identity.logo_refine", "identity.logo_vectorize", "identity.logo_directions", "identity.logo_export", "identity.logo_vector_propose", "identity.image"]) {
   f.logo.policies[operation] = { version: 1, policyIdentity: "synthetic-policy:" + operation };
  }
  const env = sharedEnvironment(f.config, f.secrets), parsed = readSharedPoolConfiguration(env)!;
  expect(parsed.slots).toHaveLength(3);
  expect(Object.keys(parsed.slots.find(slot => slot.lane === "logo")!.policies)).toHaveLength(7);
  const resolved = readSharedPoolSecrets(parsed, env);
  expect(resolved.providers.logo.model).toBe("synthetic-logo-model");
  expect(resolved.providers.logoText?.model).toBe("gpt-6.1-sol");
  expect(Object.keys(resolved.slots)).toHaveLength(3);
 });
 it.each(["bindingRef", "model", "modelVerificationReceipt"] as const)("rejects mismatched secondary %s before any ambient key lookup", key => {
  const f = fixture(); f.secrets.providers.logoText![key] = "mismatched-secondary-binding";
  const env = sharedEnvironment(f.config, f.secrets), read = vi.fn(() => { throw Error("must not read"); });
  Object.defineProperty(env, "OPENAI_API_KEY", { get: read });
  expect(() => readSharedPoolSecrets(f.config, env)).toThrow("shared_pool_secrets_unavailable");
  expect(read).not.toHaveBeenCalled();
 });
 it("rejects a configured text binding without its separate credential and an unconfigured extra credential", () => {
  const f = fixture(); delete f.secrets.providers.logoText;
  expect(() => readSharedPoolSecrets(f.config, sharedEnvironment(f.config, f.secrets))).toThrow("secrets");
  const other = fixture(); delete other.logo.textProvider;
  expect(() => readSharedPoolSecrets(other.config, sharedEnvironment(other.config, other.secrets))).toThrow("secrets");
 });
 it("does not authorize an arbitrary seventh operation or a text binding on another lane", () => {
  const f = fixture(); f.logo.policies["arbitrary.operation"] = { version: 1 };
  expect(() => readSharedPoolConfiguration(sharedEnvironment(f.config, f.secrets))).toThrow("configuration");
  const other = fixture(); other.config.slots[0]!.textProvider = other.logo.textProvider;
  expect(() => readSharedPoolConfiguration(sharedEnvironment(other.config, other.secrets))).toThrow("configuration");
 });
 it.each(["identity.image", "identity.logo_directions", "identity.logo_vector_propose"])("requires the separate text provider before admitting %s configuration", operation => {
  const f = fixture(); delete f.logo.textProvider; delete f.secrets.providers.logoText;
  f.logo.policies[operation] = { version: 1 };
  expect(() => readSharedPoolConfiguration(sharedEnvironment(f.config, f.secrets))).toThrow("configuration");
 });
 it("rejects explicit installed-key references in local execution for the secondary provider", () => {
  const f = fixture(), input = structuredClone(f.secrets) as unknown as { providers: Record<string, unknown> };
  input.providers.logoText = { bindingRef: "provider:logo-text", model: "gpt-6.1-sol", modelVerificationReceipt: "receipt:logo-text", apiKeyEnvironment: "OPENAI_API_KEY" };
  const env = { ...sharedEnvironment(f.config), EMBEL_SHARED_WORKER_POOL_SECRETS: JSON.stringify(input) }, read = vi.fn(() => "synthetic-agent-key-never-read");
  Object.defineProperty(env, "OPENAI_API_KEY", { get: read });
  expect(() => readSharedPoolSecrets(f.config, env)).toThrow("secrets");
  expect(read).not.toHaveBeenCalled();
 });
});
