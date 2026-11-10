import "server-only";
import { z } from "zod";
import { moneySchema, type ClaimedJob } from "../src/domain/jobs";
import { CAPPED_LOGO_IMAGE_MODEL, IMAGE_MODEL } from "../src/domain/providers";
import { logoConceptJobInputSchema, logoRefinementJobInputSchema } from "../src/domain/logo-jobs";
import type { IdentityAssetStore } from "../src/server/data/identity-asset-store";
import { loadLogoConceptInputs, loadLogoRefinementInputs, loadLogoStepAsset, recordLogoProviderResponse, type LogoWorkerConnection } from "../src/server/data/logo-jobs";
import { createLogoImageProvider, LOGO_IMAGE_HANDLER_VERSION, type LogoImageProducer, type LogoImageProductionResult } from "../src/server/ai/logo-image-prompts";
import { createSunburstStandardImageUsagePricer, SUNBURST_STANDARD_IMAGE_PRICING } from "../src/server/ai/openai-image-pricing";
import { createOpenAIImageTransport, type OpenAIImageTransport } from "../src/server/ai/openai-image-transport";
import type { LogoConceptHandlerDependencies } from "./handlers/logo-concepts";
import type { LogoRefinementHandlerDependencies } from "./handlers/logo-refinements";
import type { LogoWorkerCapability } from "./logo-readiness";
import { qualifiedLogoRasterCapability, type LogoRasterCapability } from "./logo-generative-storage-authorization";

export type LogoImageRuntimeConfiguration = {
  apiKey: string; model: string; rateVersion: string;
  /** Runtime configuration only. The deliberate user request and exact enabled
   * policy are independently checked by admission, readiness and leased SQL. */
  paidCallsApproved: boolean;
};
export type LogoImageRuntimeAdapterInput = {
  ownerId: string; capability: LogoWorkerCapability; image: LogoImageRuntimeConfiguration;
  connection: LogoWorkerConnection | null; assets: IdentityAssetStore | null;
  assertAvailable: ((job: ClaimedJob) => Promise<void>) | null;
  /** Existing protected-file caller remains reference-free. Uploaded mode must
   * be composed with the separately reviewed generative Storage broker. */
  references: "none" | "uploaded";
  transport?: OpenAIImageTransport;
  /** Synchronous local host fence; never a consent or remote access check. */
  acceptingWork?: () => boolean;
};
export type LogoImageRuntimeAdapter<T extends LogoRasterCapability = LogoWorkerCapability> = Readonly<{
  capability: T;
  concepts: Readonly<LogoConceptHandlerDependencies> | null;
  refinements: Readonly<LogoRefinementHandlerDependencies> | null;
}>;
const unavailable = () => new Error("The exact owner-bound logo image runtime is unavailable.");
const imageSchema = z.strictObject({ apiKey: z.string().min(1).max(4096).regex(/^[\x21-\x7e]+$/), model: z.enum([IMAGE_MODEL, CAPPED_LOGO_IMAGE_MODEL]),
  rateVersion: z.literal(SUNBURST_STANDARD_IMAGE_PRICING.binding.rateVersion), paidCallsApproved: z.literal(true) });
const jobSchema = z.strictObject({ id: z.uuid(), ownerId: z.uuid(), projectId: z.uuid(), operation: z.string(), input: z.unknown(),
  inputRevision: z.number().int().positive(), leaseToken: z.uuid(), status: z.enum(["running", "partial"]),
  reservedCostMicrousd: moneySchema, actualCostMicrousd: moneySchema });

/** Pure reusable dependency construction. No configuration discovery, pool,
 * Auth/Storage/model probe, timer, readiness report or image request. This is
 * not a runtime: the caller composes exactly one union runtime/readiness owner.
 * Neither a configuration marker nor successful construction proves consent,
 * model access or live background Storage access. */
export function createLogoImageRuntimeAdapter(input: LogoImageRuntimeAdapterInput): LogoImageRuntimeAdapter | null;
export function createLogoImageRuntimeAdapter(input?: (Omit<LogoImageRuntimeAdapterInput,"capability"> & { capability: LogoRasterCapability }) | null): LogoImageRuntimeAdapter<LogoRasterCapability> | null;
export function createLogoImageRuntimeAdapter(input: (Omit<LogoImageRuntimeAdapterInput,"capability"> & { capability: LogoRasterCapability }) | null = null): LogoImageRuntimeAdapter<LogoRasterCapability> | null {
  if (!input) return null;
  try {
    const ownerId = z.uuid().parse(input.ownerId).toLowerCase();
    const image = imageSchema.parse(input.image), references = z.enum(["none", "uploaded"]).parse(input.references);
    const qualified = qualifiedLogoRasterCapability(input.capability);
    if (!qualified) throw unavailable();
    const capability = qualified;
    if (capability.model !== image.model || capability.operation === "identity.logo_refine" && references !== "uploaded"
      || typeof input.connection?.query !== "function" || typeof input.assets?.readLeasedAsset !== "function"
      || typeof input.assets?.publishLeasedAsset !== "function" || typeof input.assertAvailable !== "function"
      || input.transport !== undefined && typeof input.transport?.createImage !== "function"
      || input.acceptingWork !== undefined && typeof input.acceptingWork !== "function") throw unavailable();
    const connection: LogoWorkerConnection = { query: input.connection.query.bind(input.connection) };
    const assets: IdentityAssetStore = { ...input.assets, readLeasedAsset: input.assets.readLeasedAsset.bind(input.assets),
      publishLeasedAsset: input.assets.publishLeasedAsset.bind(input.assets) };
    const assertAvailable = input.assertAvailable;
    const priceUsage = createSunburstStandardImageUsagePricer({ ...SUNBURST_STANDARD_IMAGE_PRICING.binding, model: image.model });
    if (!priceUsage) throw unavailable();
    const configuration = { apiKey: image.apiKey, model: image.model,
      policyIdentity: capability.policyIdentity, handlerVersion: LOGO_IMAGE_HANDLER_VERSION, priceUsage };
    const acceptingWork = input.acceptingWork ?? (() => true);
    const injected = input.transport?.createImage.bind(input.transport), fetcher = globalThis.fetch;
    const notDispatched = (): LogoImageProductionResult => ({ status: "not_dispatched", code: "runtime_stopped",
      providerRequestId: null, responseHash: null, billing: { status: "recorded", confirmedMicrousd: 0 } });
    const producer: LogoImageProducer = { async produce(raw, images, requestId, signal) {
      // Keep the fence per attempt. Host stop may occur during either provider
      // or default-transport byte validation. It must be checked immediately
      // before the actual fetch, without cancelling an already dispatched call.
      let blocked = false;
      const beforeDispatch = () => { try { const allowed: unknown = acceptingWork(); if (allowed === true) return;
        void Promise.resolve(allowed).catch(() => {}); // Observe invalid async guards without awaiting permission.
      } catch { /* Fail closed before I/O. */ }
        blocked = true; throw unavailable(); };
      try { beforeDispatch(); } catch { return notDispatched(); }
      const transport: OpenAIImageTransport = injected ? { createImage(...args) { beforeDispatch(); return injected(...args); } }
        : createOpenAIImageTransport({ apiKey: image.apiKey, fetch(...args) { beforeDispatch(); return fetcher(...args); } });
      const delegate = createLogoImageProvider({ configuration, transport });
      if (!delegate) return notDispatched();
      const result = await delegate.produce(raw, images, requestId, signal);
      // Only our own pre-invocation fence proves non-dispatch. A real response,
      // rejection or uncertain result after invocation retains provider billing.
      return blocked ? notDispatched() : result;
    } };
    function snapshot(raw: ClaimedJob): ClaimedJob {
      const job = jobSchema.parse(raw);
      const frozen = capability.operation === "identity.logo_concept" ? logoConceptJobInputSchema.parse(job.input) : logoRefinementJobInputSchema.parse(job.input);
      if (job.ownerId !== ownerId || job.operation !== capability.operation || frozen.operation !== capability.operation
        || frozen.ownerId !== ownerId || frozen.projectId !== job.projectId || frozen.policyIdentity !== capability.policyIdentity
        || frozen.handlerVersion !== capability.handlerVersion
        || ("spendControl" in capability ? frozen.version !== 3 || job.reservedCostMicrousd !== 0 : frozen.version !== 2 || job.reservedCostMicrousd <= 0 || job.reservedCostMicrousd > capability.maxCostMicrousd)
        || frozen.operation === "identity.logo_concept" && (frozen.plan.targetCount !== 6 || references === "none" && frozen.references.length !== 0)
        || frozen.operation === "identity.logo_refine" && frozen.source.kind !== "preview") throw unavailable();
      return { ...job, input: frozen };
    }
    const common = {
      model: image.model, producer, assets,
      async assertPolicyReady(raw: ClaimedJob) { const job = snapshot(raw); await assertAvailable(structuredClone(job)); snapshot(raw); },
      // Evidence retention deliberately does not run a fresh availability check:
      // a response already dispatched must survive a subsequent host stop.
      recordProviderResponse: (job: ClaimedJob, observation: Parameters<typeof recordLogoProviderResponse>[2]) => recordLogoProviderResponse(connection, snapshot(job), observation),
    };
    const checkReferences = (values: readonly { sourceKind: "curated" | "upload" }[]) => {
      if (references === "none" ? values.length !== 0 : values.some(reference => reference.sourceKind !== "upload")) throw unavailable();
    };
    if (capability.operation === "identity.logo_concept") {
      const concepts: LogoConceptHandlerDependencies = { ...common, async resolveInputs(raw) {
        const result = await loadLogoConceptInputs(connection, snapshot(raw)); checkReferences(result.referenceSnapshot.references); return result;
      } };
      return Object.freeze({ capability, concepts: Object.freeze(concepts), refinements: null });
    }
    const resolveInputs: LogoRefinementHandlerDependencies["resolveInputs"] = async raw => {
      const result = await loadLogoRefinementInputs(connection, snapshot(raw)); checkReferences(result.referenceSnapshot.references); return result;
    };
    const refinements: LogoRefinementHandlerDependencies = { ...common, resolveInputs, vectorRefinement: null,
      async loadGeneratedRaster(raw, signal) { signal.throwIfAborted();
        return loadLogoStepAsset(connection, assets, snapshot(raw), "generate-refinement", signal); },
    };
    return Object.freeze({ capability, concepts: null, refinements: Object.freeze(refinements) });
  } catch { return null; }
}
