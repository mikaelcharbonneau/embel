import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
vi.mock("server-only", () => ({}));
import { composeSharedDevelopmentConfiguration, developmentWorkerPolicies, DEVELOPMENT_MODELS, verifyDevelopmentModels } from "../../scripts/development/shared-configuration";
import { readSharedPoolConfiguration } from "../../worker/shared-pool/configuration";
import { readSharedPoolSecrets } from "../../worker/shared-pool/secrets";
import { qualifySharedLogoCapability } from "../../worker/shared-lanes/logo-capability";
import { guidedStrategyPolicy } from "../../src/server/ai/config";
import { createNamingBrainPolicy } from "../../src/server/ai/naming-brain/policy";

const key = "inert-dedicated-application-key";
const directories: string[] = [];
const modelTransport = () => vi.fn<typeof fetch>(async url => new Response(JSON.stringify({ id: decodeURIComponent(String(url).split("/").at(-1)!), object: "model" })));
afterEach(async () => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); await Promise.all(directories.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe("portable shared worker configuration uses genuine policy and credential contracts", () => {
  it("uses the actual guided/naming builders and qualifies all seven Logo/Identity capabilities", () => {
    const policies = developmentWorkerPolicies();
    expect(policies.strategy["strategy.competitors"]).toEqual(guidedStrategyPolicy("strategy.competitors"));
    expect(policies.naming["naming.generate"]).toEqual(createNamingBrainPolicy("gpt-6-luna"));
    expect(Object.keys(policies.logo)).toHaveLength(7);
    for (const policy of Object.values(policies.logo)) expect(qualifySharedLogoCapability(policy)).not.toBeNull();
    expect(policies.logo["identity.image"]).toMatchObject({ spendControl: "uncapped", textPolicy: { model: "gpt-6.1-sol" } });
    expect(policies.logo["identity.logo_concept"]).toMatchObject({ spendControl: "uncapped", estimatedCostMicrousd: null });
  });
  it("records exact catalog access separately from inference and never selects the agent key", async () => {
    vi.stubEnv("OPENAI_API_KEY", "inert-agent-key-never-use");
    const transport = modelTransport(), result = await verifyDevelopmentModels(key, transport);
    expect(result).toMatchObject({ evidence: "model_catalog_access", inferenceVerified: false });
    expect(result.results.map(row => row.model)).toEqual([...new Set(Object.values(DEVELOPMENT_MODELS))]);
    expect(transport).toHaveBeenCalledTimes(3);
    for (const [url, init] of transport.mock.calls) {
      expect(url).toMatch(/^https:\/\/api\.openai\.com\/v1\/models\//u);
      expect(init).toMatchObject({ method: "GET", redirect: "error", credentials: "omit", cache: "no-store", headers: { authorization: `Bearer ${key}` } });
    }
    expect(JSON.stringify(result)).not.toContain(key);
    await expect(verifyDevelopmentModels("", transport)).rejects.toThrow();
    expect(transport).toHaveBeenCalledTimes(3);
  });
  it.each([401, 403, 404, 429, 500])("fails closed on model verification HTTP %s without exposing provider content", async status => {
    const transport = vi.fn<typeof fetch>(async () => new Response("sensitive provider error", { status }));
    await expect(verifyDevelopmentModels(key, transport)).rejects.toThrow("private details withheld");
    expect(transport).toHaveBeenCalledOnce();
  });
  it("rejects a mismatched model and redirected responses", async () => {
    await expect(verifyDevelopmentModels(key, vi.fn(async () => new Response(JSON.stringify({ id: "other-model", object: "model" }))))).rejects.toThrow();
    await expect(verifyDevelopmentModels(key, vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://example.com" } })))).rejects.toThrow();
  });
  it("writes isolated restricted config/secrets that the actual shared runtime readers accept", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "embel-shared-composition-")); directories.push(root);
    const directory = path.join(root, ".embel-dev/shared"); await mkdir(directory, { recursive: true });
    const slots = (["strategy", "naming", "logo"] as const).map((lane, index) => ({ slotId: `${index + 1}0000000-0000-4000-8000-000000000001`, lane, slotIndex: 1,
      roleName: `embel_shared_${lane}_composition`, roleOid: 12000 + index, databaseUrl: `postgresql://embel_shared_${lane}_composition:inert-slot-password@127.0.0.1:55422/postgres?sslmode=disable` }));
    await writeFile(path.join(directory, "provisioning.json"), JSON.stringify({ version: 1, target: { deploymentId: "embel-development-composition", applicationOrigin: "http://127.0.0.1:3155", supabaseOrigin: "http://127.0.0.1:55421", databaseHost: "127.0.0.1", databasePort: 55422 }, slots,
      storage: { authUserId: "40000000-0000-4000-8000-000000000001", email: "worker@example.test", password: "inert-storage-password", publishableKey: "sb_publishable_inert_composition" } }));
    await writeFile(path.join(directory, "artifact.json"), JSON.stringify({ sourceRevision: "a".repeat(40), sourceClean: false, artifactSha256: "b".repeat(64),
      runtime: { node: "22.22.2", icu: "77.1", unicode: "16.0", platform: "linux", arch: "x64" } }));
    vi.stubGlobal("fetch", modelTransport());
    const config = await composeSharedDevelopmentConfiguration({ root, apiKey: key });
    const configText = await readFile(path.join(directory, "configuration.json"), "utf8"), secretsText = await readFile(path.join(directory, "secrets.json"), "utf8");
    const env = { NODE_ENV: "development", EMBEL_DEVELOPMENT_ENABLED: "true", EMBEL_SHARED_WORKER_POOL_ENABLED: "true", EMBEL_SHARED_WORKER_POOL_CONFIGURATION: configText, EMBEL_SHARED_WORKER_POOL_SECRETS: secretsText };
    expect(readSharedPoolConfiguration(env)).toEqual(config);
    const secrets = readSharedPoolSecrets(config, env);
    expect(secrets.providers.logoText!.model).toBe("gpt-6.1-sol");
    expect(secrets.providers.logo.apiKey).toBe(key);
    expect(Object.keys(secrets.slots)).toEqual(slots.map(slot => slot.slotId));
    expect(configText).not.toMatch(/inert-(?:slot|storage|dedicated)/u);
    expect((await stat(path.join(directory, "secrets.json"))).mode & 0o777).toBe(0o600);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
  });
  it("gives six local Logo slots their own Storage users, concepts and refinements on slots 2-6, and matching capacity", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "embel-shared-composition-six-")); directories.push(root);
    const directory = path.join(root, ".embel-dev/shared"); await mkdir(directory, { recursive: true });
    const url = (role: string) => `postgresql://${role}:inert-slot-password@127.0.0.1:55422/postgres?sslmode=disable`;
    const base = (["strategy", "naming", "logo"] as const).map((lane, index) => ({ slotId: `${index + 1}0000000-0000-4000-8000-000000000001`, lane, slotIndex: 1,
      roleName: `embel_shared_${lane}_composition`, roleOid: 12000 + index, databaseUrl: url(`embel_shared_${lane}_composition`) }));
    const extra = [2, 3, 4, 5, 6].map(index => ({ slotId: `${index + 3}0000000-0000-4000-8000-000000000001`, lane: "logo" as const, slotIndex: index,
      roleName: `embel_shared_logo_composition_s${index}`, roleOid: 12100 + index, databaseUrl: url(`embel_shared_logo_composition_s${index}`),
      storage: { authUserId: `4000000${index}-0000-4000-8000-000000000001`, email: `worker-s${index}@example.test`, password: "inert-storage-password", publishableKey: "sb_publishable_inert_composition" } }));
    const slots = [...base, ...extra];
    await writeFile(path.join(directory, "provisioning.json"), JSON.stringify({ version: 1, target: { deploymentId: "embel-development-composition", applicationOrigin: "http://127.0.0.1:3155", supabaseOrigin: "http://127.0.0.1:55421", databaseHost: "127.0.0.1", databasePort: 55422 }, slots,
      storage: { authUserId: "40000000-0000-4000-8000-000000000001", email: "worker@example.test", password: "inert-storage-password", publishableKey: "sb_publishable_inert_composition" } }));
    await writeFile(path.join(directory, "artifact.json"), JSON.stringify({ sourceRevision: "a".repeat(40), sourceClean: false, artifactSha256: "b".repeat(64),
      runtime: { node: "22.22.2", icu: "77.1", unicode: "16.0", platform: "linux", arch: "x64" } }));
    vi.stubGlobal("fetch", modelTransport());
    const config = await composeSharedDevelopmentConfiguration({ root, apiKey: key });
    expect(config.capacity).toMatchObject({ maxConcurrentExecutions: 8, maxPerTenantPerLane: 6 });
    const logo = config.slots.filter(slot => slot.lane === "logo");
    expect(logo).toHaveLength(6);
    expect(Object.keys(logo[0]!.policies)).toHaveLength(7);
    for (const slot of logo.slice(1)) expect(Object.keys(slot.policies).sort()).toEqual(["identity.logo_concept", "identity.logo_refine"]);
    const env = { NODE_ENV: "development", EMBEL_DEVELOPMENT_ENABLED: "true", EMBEL_SHARED_WORKER_POOL_ENABLED: "true",
      EMBEL_SHARED_WORKER_POOL_CONFIGURATION: await readFile(path.join(directory, "configuration.json"), "utf8"), EMBEL_SHARED_WORKER_POOL_SECRETS: await readFile(path.join(directory, "secrets.json"), "utf8") };
    const secrets = readSharedPoolSecrets(readSharedPoolConfiguration(env)!, env);
    expect(new Set(logo.map(slot => secrets.slots[slot.slotId]!.storage!.authUserId)).size).toBe(6);
  });
  it("refuses a second Strategy slot or a Storage user on a slot that should not have one", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "embel-shared-composition-bad-")); directories.push(root);
    const directory = path.join(root, ".embel-dev/shared"); await mkdir(directory, { recursive: true });
    const slot = (lane: "strategy" | "naming" | "logo", index: number, extra = {}) => ({ slotId: `${index}${lane.length}000000-0000-4000-8000-000000000001`, lane, slotIndex: index,
      roleName: `embel_shared_${lane}_bad_${index}`, roleOid: 13000 + index + lane.length, databaseUrl: `postgresql://embel_shared_${lane}_bad_${index}:inert@127.0.0.1:55422/postgres?sslmode=disable`, ...extra });
    const storage = { authUserId: "40000000-0000-4000-8000-000000000009", email: "worker@example.test", password: "inert-storage-password", publishableKey: "sb_publishable_inert" };
    await writeFile(path.join(directory, "artifact.json"), JSON.stringify({ sourceRevision: "a".repeat(40), sourceClean: false, artifactSha256: "b".repeat(64),
      runtime: { node: "22.22.2", icu: "77.1", unicode: "16.0", platform: "linux", arch: "x64" } }));
    vi.stubGlobal("fetch", modelTransport());
    for (const slots of [[slot("strategy", 1), slot("strategy", 2), slot("naming", 1), slot("logo", 1)], [slot("strategy", 1), slot("naming", 1), slot("logo", 1, { storage })]]) {
      await writeFile(path.join(directory, "provisioning.json"), JSON.stringify({ version: 1, target: { deploymentId: "embel-development-bad", applicationOrigin: "http://127.0.0.1:3155",
        supabaseOrigin: "http://127.0.0.1:55421", databaseHost: "127.0.0.1", databasePort: 55422 }, slots, storage }));
      await expect(composeSharedDevelopmentConfiguration({ root, apiKey: key })).rejects.toThrow("private details withheld");
    }
  });
});
