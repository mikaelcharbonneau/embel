import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile, chmod } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { guidedStrategyPolicy, OPENAI_STRATEGY_MODEL } from "../../src/server/ai/config";
import { namingGenerationPolicySchema } from "../../src/domain/naming-generation";
import { IMAGE_MODEL } from "../../src/domain/providers";
import { identityGenerationCapabilitySchema, identityTextPolicySchema } from "../../src/domain/identity-jobs";
import { logoDirectionsApiPolicySchema, logoStyleNoteApiPolicySchema, uncappedLogoRasterCapabilitySchema } from "../../src/domain/logo-jobs";
import { uncappedLogoVectorProposalTextPolicySchema } from "../../src/domain/logo-vector-proposal-jobs";
import { canonicalIdentityInput } from "../../src/features/identity-directions/model/font-check-binding";
import { QUALIFIED_VTRACER } from "../../worker/logo-vector/engine";
import { LOGO_EXPORT_HANDLER_VERSION, LOGO_EXPORT_POLICY_IDENTITY } from "../../worker/handlers/logo-exports";
import { qualifySharedLogoCapability, sharedDirectionsCapabilitySchema, sharedStyleNoteCapabilitySchema } from "../../worker/shared-lanes/logo-capability";
import { uncappedLogoVectorProposalCapabilitySchema } from "../../worker/logo-vector-proposal-capability";
import { sharedPoolConfigurationSchema, type SharedPoolConfiguration } from "../../worker/shared-pool/configuration";
import { readSharedPoolSecrets } from "../../worker/shared-pool/secrets";
import { SHARED_CORE_RPC_PROOFS, SHARED_LANE_RPC_PROOFS, SHARED_STRATEGY_OUTBOX_PROOF } from "../../worker/shared-pool/proofs";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const unavailable = () => Error("Development worker configuration is unavailable; private details withheld.");
const dedicatedKey = z.string().min(16).max(8192).regex(/^[^\s]+$/u);
const lane = z.enum(["strategy", "naming", "logo"]);
const storageSchema = z.strictObject({ authUserId: z.uuid(), email: z.email(), password: z.string(), publishableKey: z.string() });
// One Strategy and one Naming slot; Logo slots 1-6, each with its own Storage user (slot 1 uses the top-level one).
const provisioningSchema = z.object({
  version: z.literal(1), target: sharedPoolConfigurationSchema.shape.target.options[0].omit({ kind: true }),
  slots: z.array(z.strictObject({ slotId: z.uuid(), lane, slotIndex: z.number().int().min(1).max(6), roleName: z.string(), roleOid: z.number().int().positive(), databaseUrl: z.string(),
    storage: storageSchema.optional() })).min(3).max(8)
    .refine(slots => slots.every(slot => (slot.lane === "logo" || slot.slotIndex === 1) && (slot.storage !== undefined) === (slot.lane === "logo" && slot.slotIndex > 1))),
  storage: storageSchema,
});
/** Logo slots after the first only run concepts and refinements, as in production,
 * so native vector/export work and Identity stay one at a time on slot 1. */
export const PARALLEL_LOGO_OPERATIONS = Object.freeze(["identity.logo_concept", "identity.logo_refine", "identity.logo_style_note"] as const);
/** Operations only the concept slots run: Logo slot 1 already reports its maximum of seven. */
export const PARALLEL_ONLY_LOGO_OPERATIONS = Object.freeze(["identity.logo_style_note"] as const);
const artifactSchema = sharedPoolConfigurationSchema.shape.artifact.extend({ sourceClean: z.boolean() });
const modelSchema = z.object({ id: z.string(), object: z.literal("model") });
export const DEVELOPMENT_MODELS = Object.freeze({ strategy: OPENAI_STRATEGY_MODEL, naming: "gpt-6-luna", logo: IMAGE_MODEL, logoText: OPENAI_STRATEGY_MODEL });

/** These are the actual versioned engine policies. No output, price estimate,
 * provider access, SQL authority or worker readiness is inferred from them. */
export function developmentWorkerPolicies(): Record<z.infer<typeof lane>, Record<string, Record<string, unknown>>> {
  const identified = (value: Record<string, unknown>) => ({ ...value, policyIdentity: digest(canonicalIdentityInput(value)) });
  const textLimits = { model: OPENAI_STRATEGY_MODEL, serviceTier: "default", pricingVersion: "2026-10-03", maxInputTokens: 32768,
    maxOutputTokens: 4096, maxInputBytes: 131072, maxOutputBytes: 32768, maxStreamBytes: 2097152, deadlineMs: 240000, maxTools: 0,
    inputMicrousdPerMillionTokens: 2000000, cachedInputMicrousdPerMillionTokens: 100000, cacheWriteMicrousdPerMillionTokens: 2500000, outputMicrousdPerMillionTokens: 10000000 };
  const apiPolicy = logoDirectionsApiPolicySchema.parse({ ...textLimits, version: 1, billingMode: "openai_api", spendControl: "uncapped",
    handlerVersion: "logo-directions-api-v1", adapterVersion: "logo-directions-openai-v1" });
  const styleNotePolicy = logoStyleNoteApiPolicySchema.parse({ ...textLimits, version: 1, billingMode: "openai_api", spendControl: "uncapped",
    handlerVersion: "logo-style-note-v1", adapterVersion: "logo-style-note-openai-v1" });
  const proposalTextPolicy = uncappedLogoVectorProposalTextPolicySchema.parse({ ...textLimits, version: 2, billingMode: "openai_api", spendControl: "uncapped",
    handlerVersion: "logo-vector-propose-v1", adapterVersion: "logo-vector-propose-api-uncapped-v2", schemaVersion: "logo-vector-proposal-v1" });
  const identityTextPolicy = identityTextPolicySchema.parse({ version: 1, model: OPENAI_STRATEGY_MODEL, serviceTier: "default", pricingVersion: "2026-10-03",
    maxInputTokens: 32768, maxOutputTokens: 8192, maxInputBytes: 131072, maxOutputBytes: 65536, deadlineMs: 240000, maxTools: 0 });
  const capabilities = [
    ...(["identity.logo_concept", "identity.logo_refine"] as const).map(operation => uncappedLogoRasterCapabilitySchema.parse(identified({ operation,
      handlerVersion: "logo-image-v1", provider: "openai", model: IMAGE_MODEL, engine: null, spendControl: "uncapped", estimatedCostMicrousd: null }))),
    identified({ operation: "identity.logo_vectorize", handlerVersion: "1", provider: null, model: null,
      engine: { id: "vtracer", version: QUALIFIED_VTRACER.version, artifactHash: QUALIFIED_VTRACER.wasm }, maxCostMicrousd: 0 }),
    { operation: "identity.logo_export", policyIdentity: LOGO_EXPORT_POLICY_IDENTITY, handlerVersion: LOGO_EXPORT_HANDLER_VERSION, provider: null, model: null, engine: null, maxCostMicrousd: 0 },
    sharedDirectionsCapabilitySchema.parse(identified({ operation: "identity.logo_directions", handlerVersion: "logo-directions-api-v1", provider: "openai",
      model: OPENAI_STRATEGY_MODEL, engine: null, spendControl: "uncapped", apiPolicy })),
    uncappedLogoVectorProposalCapabilitySchema.parse(identified({ operation: "identity.logo_vector_propose", handlerVersion: "logo-vector-propose-v1", provider: "openai",
      model: OPENAI_STRATEGY_MODEL, engine: null, spendControl: "uncapped", textPolicy: proposalTextPolicy })),
    identityGenerationCapabilitySchema.parse(identified({ operation: "identity.image", handlerVersion: "identity-image-v1", provider: "openai", model: IMAGE_MODEL,
      engine: null, maxCostMicrousd: 0, spendControl: "uncapped", textPolicy: identityTextPolicy })),
    sharedStyleNoteCapabilitySchema.parse(identified({ operation: "identity.logo_style_note", handlerVersion: "logo-style-note-v1", provider: "openai",
      model: OPENAI_STRATEGY_MODEL, engine: null, spendControl: "uncapped", apiPolicy: styleNotePolicy })),
  ].map(value => { const qualified = qualifySharedLogoCapability(value); if (!qualified) throw unavailable(); return qualified; });
  return {
    strategy: Object.fromEntries((["strategy.reformulate", "strategy.competitors", "strategy.audience", "strategy.positioning", "strategy.personality", "strategy.slogan"] as const)
      .map(operation => [operation, guidedStrategyPolicy(operation)])),
    naming: { "naming.generate": namingGenerationPolicySchema.parse({ version: 2, operation: "naming.generate", model: DEVELOPMENT_MODELS.naming, reasoningEffort: "low" }) },
    logo: Object.fromEntries(capabilities.map(value => [value.operation, value])),
  };
}

/** A real model-catalog check, not an inference or billing verification. The
 * caller must explicitly pass its application key; ambient agent keys are never read. */
export async function verifyDevelopmentModels(apiKey: string, transport: typeof fetch = globalThis.fetch) {
  const key = dedicatedKey.parse(apiKey), checkedAt = new Date().toISOString();
  const results: Array<{ model: string; receipt: string; responseSha256: string; checkedAt: string; method: "GET"; endpoint: string }> = [];
  for (const model of new Set(Object.values(DEVELOPMENT_MODELS))) {
    const endpoint = `https://api.openai.com/v1/models/${encodeURIComponent(model)}`;
    let response: Response;
    try { response = await transport(endpoint, { method: "GET", headers: { authorization: `Bearer ${key}` },
      redirect: "error", cache: "no-store", credentials: "omit", signal: AbortSignal.timeout(20000) }); }
    catch { throw unavailable(); }
    if (!response.ok) { await response.body?.cancel().catch(() => {}); throw unavailable(); }
    const body = await response.text();
    if (Buffer.byteLength(body) > 65536) throw unavailable();
    const result = modelSchema.safeParse(JSON.parse(body));
    if (!result.success || result.data.id !== model) throw unavailable();
    const responseSha256 = digest(body);
    results.push({ model, receipt: `model-verification:${digest(JSON.stringify({ model, checkedAt, responseSha256, nonce: randomUUID() }))}`,
      responseSha256, checkedAt, method: "GET", endpoint });
  }
  return { version: 1 as const, evidence: "model_catalog_access" as const, inferenceVerified: false as const, results };
}

async function privateJson(directory: string, filename: string, value: unknown) {
  const destination = path.join(directory, filename), temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    try { const info = await lstat(destination); if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw unavailable(); }
    catch (error) { if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error; }
    await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    await rename(temporary, destination);
  } finally { await rm(temporary, { force: true }); }
}

/** Root runs this after real local provisioning and the packaged --describe.
 * Returns a secret-free configuration for installDevelopmentPolicies(). */
export async function composeSharedDevelopmentConfiguration(options: { root: string; apiKey: string }): Promise<SharedPoolConfiguration> {
  try {
    const key = dedicatedKey.parse(options.apiKey), directory = path.join(options.root, ".embel-dev/shared");
    const provisioning = provisioningSchema.parse(JSON.parse(await readFile(path.join(directory, "provisioning.json"), "utf8")));
    const actual = artifactSchema.parse(JSON.parse(await readFile(path.join(directory, "artifact.json"), "utf8")));
    const verification = await verifyDevelopmentModels(key), policies = developmentWorkerPolicies();
    const provider = (name: keyof typeof DEVELOPMENT_MODELS) => {
      const model = DEVELOPMENT_MODELS[name], receipt = verification.results.find(value => value.model === model)!;
      return { bindingRef: `development:${provisioning.target.deploymentId}:${name}`, model, modelVerificationReceipt: receipt.receipt, apiKey: key };
    };
    const providers = { strategy: provider("strategy"), naming: provider("naming"), logo: provider("logo"), logoText: provider("logoText") };
    const config = sharedPoolConfigurationSchema.parse({ version: 1, target: { kind: "development", ...provisioning.target },
      artifact: { sourceRevision: actual.sourceRevision, artifactSha256: actual.artifactSha256, runtime: actual.runtime }, coreProofs: SHARED_CORE_RPC_PROOFS,
      capacity: { maxConcurrentExecutions: provisioning.slots.length, maxPerTenantPerLane: provisioning.slots.filter(slot => slot.lane === "logo").length,
        leaseSeconds: 60, renewalMs: 15000, idlePollMs: 1000, drainTimeoutMs: 120000 },
      queue: { region: "iad1", topic: "embel-strategy", consumerGroup: "embel-development", deploymentId: provisioning.target.deploymentId,
        visibilityTimeoutSeconds: 60, handlerDeadlineMs: 900000, emptyPollMs: 1000, errorPollMs: 5000, concurrency: 1 },
      slots: provisioning.slots.map(slot => ({ slotId: slot.slotId, lane: slot.lane, roleName: slot.roleName, roleOid: slot.roleOid,
        workerId: `development-${slot.lane}-${slot.slotId}`, providerBindingRef: providers[slot.lane].bindingRef,
        model: providers[slot.lane].model, modelVerificationReceipt: providers[slot.lane].modelVerificationReceipt,
        policies: slot.lane === "logo" && slot.slotIndex > 1 ? Object.fromEntries(PARALLEL_LOGO_OPERATIONS.map(operation => [operation, policies.logo[operation]]))
          : slot.lane === "logo" ? Object.fromEntries(Object.entries(policies.logo).filter(([operation]) => !(PARALLEL_ONLY_LOGO_OPERATIONS as readonly string[]).includes(operation)))
          : policies[slot.lane],
        gatewayProof: SHARED_LANE_RPC_PROOFS[slot.lane], ...(slot.lane === "strategy" ? { outboxProof: SHARED_STRATEGY_OUTBOX_PROOF } : {}),
        ...(slot.lane === "logo" ? { textProvider: { providerBindingRef: providers.logoText.bindingRef, model: providers.logoText.model, modelVerificationReceipt: providers.logoText.modelVerificationReceipt } } : {}) })),
    });
    const suppliedSecrets = { version: 1, providers, slots: Object.fromEntries(provisioning.slots.map(slot => [slot.slotId,
      { databaseUrl: slot.databaseUrl, ...(slot.lane === "logo" ? { storage: slot.storage ?? provisioning.storage } : {}) }])) };
    const secrets = readSharedPoolSecrets(config, { EMBEL_SHARED_WORKER_POOL_ENABLED: "true", EMBEL_SHARED_WORKER_POOL_SECRETS: JSON.stringify(suppliedSecrets) });
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await lstat(directory); if (!info.isDirectory() || info.isSymbolicLink()) throw unavailable();
    await chmod(directory, 0o700);
    await privateJson(directory, "model-verification.json", verification);
    await privateJson(directory, "secrets.json", secrets);
    await privateJson(directory, "configuration.json", config);
    return config;
  } catch { throw unavailable(); }
}
