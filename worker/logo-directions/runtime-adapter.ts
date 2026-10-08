import "server-only";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { ClaimedJob } from "../../src/domain/jobs";
import { logoDirectionsJobInputSchema, logoDirectionsSubscriptionPolicySchema, type LogoDirectionsSubscriptionPolicy } from "../../src/domain/logo-jobs";
import { logoHashSchema, logoUuidSchema } from "../../src/domain/logo-vector";
import type { IdentityAssetStore } from "../../src/server/data/identity-asset-store";
import { loadDirectionInputs, recordLogoProviderResponse, stageLogoDirections, readLeasedLogoRecord, type LogoWorkerConnection } from "../../src/server/data/logo-jobs";
import { createChatGPTDirectionsProvider } from "../../src/server/ai/chatgpt-directions";
import type { ChatGPTTransport } from "../../src/server/ai/chatgpt-transport";
import type { DirectionProvider } from "../../src/features/identity-directions/server/propose-directions";
import type { LogoDirectionsDependencies } from "../handlers/logo-directions";
import { qualifiedLogoDirectionsStorageCapability } from "../logo-directions-storage-authorization";
import type { LogoWorkerCapability } from "../logo-readiness";
export type LogoDirectionsRuntimeAdapterInput = {
  ownerId: string; policyIdentity: string; policy: LogoDirectionsSubscriptionPolicy; expectedAccountId: string;
  transport: ChatGPTTransport | null; connection: LogoWorkerConnection | null; assets: IdentityAssetStore | null;
  assertAvailable: ((job: ClaimedJob) => Promise<void>) | null;
  /** Host-owned synchronous stop gate, checked by the qualified transport at
   * actual Responses dispatch. Never cancels an already-invoked response. */
  acceptingWork?: () => boolean;
};
export type LogoDirectionsRuntimeAdapter = Readonly<{ capability: LogoWorkerCapability; dependencies: Readonly<LogoDirectionsDependencies> }>;
const configurationSchema = z.strictObject({ ownerId: logoUuidSchema, policyIdentity: logoHashSchema, policy: logoDirectionsSubscriptionPolicySchema, expectedAccountId: z.string().min(1).max(200).regex(/^[a-zA-Z0-9_.:-]+$/) });
const jobSchema = z.strictObject({ id: logoUuidSchema, ownerId: logoUuidSchema, projectId: logoUuidSchema, operation: z.literal("identity.logo_directions"), input: logoDirectionsJobInputSchema,
  inputRevision: z.number().int().positive(), leaseToken: logoUuidSchema, status: z.literal("running"), reservedCostMicrousd: z.literal(0), actualCostMicrousd: z.literal(0) });
const unavailable = () => new Error("The exact subscription directions runtime is unavailable.");
/** Pure composition only: existing subscription adapter and real persistence.
 * No environment lookup, model fallback, session, pool, timer or second readiness
 * publisher. Parent runtime owns the single worker and union readiness report. */
export function createLogoDirectionsRuntimeAdapter(input: LogoDirectionsRuntimeAdapterInput | null = null): LogoDirectionsRuntimeAdapter | null {
  if (!input) return null;
  const parsed = configurationSchema.safeParse({ ownerId: input.ownerId, policyIdentity: input.policyIdentity, policy: input.policy, expectedAccountId: input.expectedAccountId });
  if (!parsed.success || parsed.data.expectedAccountId !== parsed.data.policy.registrationId || typeof input.transport?.streamResponse !== "function"
    || typeof input.connection?.query !== "function" || typeof input.assets?.readLeasedAsset !== "function" || typeof input.assets?.publishLeasedAsset !== "function" || typeof input.assertAvailable !== "function"
    || input.acceptingWork !== undefined && typeof input.acceptingWork !== "function") return null;
  const { ownerId, policyIdentity, expectedAccountId } = parsed.data;
  const capability = qualifiedLogoDirectionsStorageCapability({ operation: "identity.logo_directions", policyIdentity, handlerVersion: parsed.data.policy.handlerVersion,
    provider: "openai", model: parsed.data.policy.model, engine: null, maxCostMicrousd: 0, billingMode: "chatgpt_subscription", policy: parsed.data.policy });
  if (!capability?.policy) return null;
  const policy = capability.policy, assertAvailable = input.assertAvailable, acceptingWork = input.acceptingWork;
  const connection: LogoWorkerConnection = { query: input.connection.query.bind(input.connection) };
  const streamResponse = input.transport.streamResponse.bind(input.transport);
  const transport: ChatGPTTransport = { ...input.transport, streamResponse(request, options) {
    return streamResponse(request, acceptingWork === undefined ? options : { ...options, acceptingWork });
  } };
  const assets: IdentityAssetStore = { ...input.assets, readLeasedAsset: input.assets.readLeasedAsset.bind(input.assets), publishLeasedAsset: input.assets.publishLeasedAsset.bind(input.assets) };
  function snapshot(raw: ClaimedJob) {
    const job = jobSchema.parse(raw), frozen = job.input;
    if (job.ownerId !== ownerId || frozen.ownerId !== ownerId || frozen.projectId !== job.projectId || frozen.policyIdentity !== policyIdentity || frozen.fontVersionIds.length === 0
      || frozen.handlerVersion !== capability!.handlerVersion || frozen.billingMode !== "chatgpt_subscription" || !isDeepStrictEqual(frozen.policy, policy)) throw unavailable();
    return job;
  }
  const dependencies: LogoDirectionsDependencies = {
    assets,
    async loadInput(raw) {
      // Existing handler supplies no AbortSignal. The concrete store checks its
      // lifetime/session/current lease, and the handler rechecks before dispatch.
      return loadDirectionInputs(connection, assets, snapshot(raw));
    },
    async assertReady(raw) {
      const job = snapshot(raw); await assertAvailable(structuredClone(job));
      if (await readLeasedLogoRecord(connection, job, "runtime_readiness") !== true) throw unavailable();
    },
    provider: Object.freeze<DirectionProvider>({ async propose(resolved, signal, dispatch) {
      const job = snapshot(dispatch.job);
      const provider = createChatGPTDirectionsProvider({ transport, ownerId, projectId: job.projectId, policy, expectedAccountId });
      // The existing provider rechecks exact request/account/policy and invokes
      // the handler/runtime's final beforeDispatch fence immediately before I/O.
      return provider.propose(resolved, signal, { job, beforeDispatch: async current => {
        if (!isDeepStrictEqual(current, job)) throw unavailable();
        await dispatch.beforeDispatch(structuredClone(job));
      } });
    } }),
    async recordResponse(raw, observation) { return recordLogoProviderResponse(connection, snapshot(raw), observation); },
    async publish(raw, result, receipt, signal) {
      if (signal.aborted) throw unavailable();
      // Real frozen records, owned bytes, pinned license and glyph checks precede
      // staging. Any failure retains the original response in the existing handler.
      return stageLogoDirections(connection, assets, snapshot(raw), result, receipt, signal);
    },
  };
  return Object.freeze({ capability, dependencies: Object.freeze(dependencies) });
}
