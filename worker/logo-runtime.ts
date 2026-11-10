import { z } from "zod";
import type { ClaimedJob } from "../src/domain/jobs";
import { CAPPED_LOGO_IMAGE_MODEL } from "../src/domain/providers";
import { LOGO_IMAGE_HANDLER_VERSION } from "../src/server/logo-creation/openai-logo-provider";
import { LOGO_DIRECTIONS_HANDLER_VERSION } from "../src/features/identity-directions/server/propose-directions";
import type { LogoWorkerConnection } from "../src/server/data/logo-jobs";
import { LOGO_EXPORT_HANDLER_VERSION, LOGO_EXPORT_POLICY_IDENTITY } from "./handlers/logo-exports";
import { LOGO_VECTOR_HANDLER_VERSION } from "./logo-vector/handler";
import { QUALIFIED_VTRACER } from "./logo-vector/engine";
import { createLogoOperationComposition, type LogoOperation, type LogoOperationCompositionInput } from "./logo-operation-composition";
import { createLogoJobStore } from "./logo-job-store";
import { createLogoReadiness, freezeLogoWorkerManifest, type LogoWorkerCapability } from "./logo-readiness";
import { qualifiedLogoVectorProposalCapability } from "./logo-vector-proposal-capability";
import { runOneJob } from "./runner";

export type LogoWorkerRuntimeInput = {
  connection: LogoWorkerConnection;
  workerId: string;
  composition: LogoOperationCompositionInput;
  manifest: readonly LogoWorkerCapability[];
  readinessSeconds?: number;
  refreshMs?: number;
  runner?: Pick<Parameters<typeof runOneJob>[0], "leaseSeconds" | "heartbeatMs" | "abortGraceMs">;
};
const methods = (object: unknown, names: readonly string[]): boolean => !!object && typeof object === "object"
  && names.every(name => typeof (object as Record<string, unknown>)[name] === "function");
const assetsReady = (object: unknown) => methods(object, ["readLeasedAsset", "publishLeasedAsset"]);
function qualified(capability: LogoWorkerCapability): boolean {
  switch (capability.operation) {
    case "identity.logo_concept": case "identity.logo_refine":
      return capability.handlerVersion === LOGO_IMAGE_HANDLER_VERSION && capability.provider === "openai" && capability.model === CAPPED_LOGO_IMAGE_MODEL && capability.engine === null && capability.maxCostMicrousd > 0;
    case "identity.logo_directions":
      return capability.handlerVersion === LOGO_DIRECTIONS_HANDLER_VERSION && capability.provider !== null && capability.model !== null && capability.engine === null;
    case "identity.logo_vectorize":
      return capability.handlerVersion === LOGO_VECTOR_HANDLER_VERSION && capability.provider === null && capability.model === null && capability.maxCostMicrousd === 0
        && capability.engine?.id === "vtracer" && capability.engine.version === QUALIFIED_VTRACER.version && capability.engine.artifactHash === QUALIFIED_VTRACER.wasm;
    case "identity.logo_vector_propose": return qualifiedLogoVectorProposalCapability(capability) !== null;
    case "identity.logo_export":
      return capability.handlerVersion === LOGO_EXPORT_HANDLER_VERSION && capability.policyIdentity === LOGO_EXPORT_POLICY_IDENTITY
        && capability.provider === null && capability.model === null && capability.engine === null && capability.maxCostMicrousd === 0;
  }
}

/** Explicit construction only: no configuration discovery, pool creation, probes,
 * provider requests or timers. Inject reviewed adapters and their exact policy.
 * A constructed capability is not proof of installed/live access; policy reports
 * and the leased dispatch check remain independent fail-closed requirements. */
export function createLogoWorkerRuntime(input: LogoWorkerRuntimeInput) {
  const manifest = freezeLogoWorkerManifest(input.manifest), workerId = input.workerId;
  const seconds = z.number().int().min(1).max(90).parse(input.readinessSeconds ?? 60);
  const refreshMs = z.number().int().min(1).max(seconds * 1000 - 1).parse(input.refreshMs ?? Math.min(20_000, Math.floor(seconds * 1000 / 3)));
  const leaseSeconds = z.number().int().min(10).max(300).parse(input.runner?.leaseSeconds ?? 120);
  const heartbeatMs = z.number().int().min(1).lt(leaseSeconds * 500).parse(input.runner?.heartbeatMs ?? 30_000);
  const abortGraceMs = z.number().int().min(0).max(30_000).parse(input.runner?.abortGraceMs ?? 5000);
  const runner = Object.freeze({ leaseSeconds, heartbeatMs, abortGraceMs });
  // Guard closures refer only to the reporter constructed below. Factories must
  // not invoke the closures while merely building their handler registry.
  const chain = (prior: (job: ClaimedJob) => Promise<void>) => async (job: ClaimedJob) => { await prior(job); await readiness.assertReady(job); };
  const eligible = (operation: LogoOperation) => manifest.some(entry => entry.operation === operation && qualified(entry));
  const supplied = input.composition;
  const dependencies: LogoOperationCompositionInput = { concepts: null, refinements: null, vector: null, directions: null, exports: null, proposals: null, unavailableReasons: { ...supplied.unavailableReasons } };
  const concepts = supplied.concepts;
  if (eligible("identity.logo_concept") && methods(concepts, ["assertPolicyReady", "resolveInputs", "recordProviderResponse"]) && methods(concepts?.producer, ["produce"]) && assetsReady(concepts?.assets)) {
    dependencies.concepts = { ...concepts!, assertPolicyReady: chain(concepts!.assertPolicyReady.bind(concepts)) };
  }
  const refinements = supplied.refinements;
  if (eligible("identity.logo_refine") && methods(refinements, ["assertPolicyReady", "resolveInputs", "recordProviderResponse", "loadGeneratedRaster"]) && methods(refinements?.producer, ["produce"]) && assetsReady(refinements?.assets) && refinements?.vectorRefinement === null) {
    dependencies.refinements = { ...refinements, assertPolicyReady: chain(refinements.assertPolicyReady.bind(refinements)) };
  }
  const vector = supplied.vector;
  if (eligible("identity.logo_vectorize") && methods(vector, ["assertReady", "loadInput", "publish"])) dependencies.vector = { ...vector!, assertReady: chain(vector!.assertReady.bind(vector)) };
  const directions = supplied.directions;
  if (eligible("identity.logo_directions") && methods(directions, ["assertReady", "loadInput", "recordResponse", "publish"]) && methods(directions?.provider, ["propose"]) && assetsReady(directions?.assets)) {
    dependencies.directions = { ...directions!, assertReady: chain(directions!.assertReady.bind(directions)) };
  }
  const exports = supplied.exports;
  if (eligible("identity.logo_export") && methods(exports, ["assertReady", "loadInput"]) && methods(exports?.publication, ["assertCurrentLease", "stage"]) && assetsReady(exports?.publication.assets)) {
    dependencies.exports = { ...exports!, assertReady: chain(exports!.assertReady.bind(exports)) };
  }
  const proposals = supplied.proposals;
  if (eligible("identity.logo_vector_propose") && methods(proposals, ["assertReady", "loadInput", "recordResponse", "stageProposal"]) && methods(proposals?.provider, ["propose"])) {
    const assertProposalReady = proposals!.assertReady.bind(proposals);
    dependencies.proposals = { ...proposals!, async assertReady(job, signal) { signal.throwIfAborted(); await assertProposalReady(job, signal); await readiness.assertReady(job); signal.throwIfAborted(); } };
  }
  const composition = createLogoOperationComposition(dependencies);
  // A runner deadline/cancellation can settle before a dispatched proposal does.
  // Keep this exact lane's original observation/staging ports alive until its
  // execution promise settles, even after the runner loses the current lease.
  const pendingProposals = new Set<Promise<unknown>>();
  const handlers = new Map(composition.handlers), proposalHandler = handlers.get("identity.logo_vector_propose");
  if (proposalHandler) handlers.set("identity.logo_vector_propose", { steps(job) {
    return proposalHandler.steps(job).map(step => ({ ...step, execute(args) {
      const promise = step.execute(args); pendingProposals.add(promise);
      void promise.then(() => pendingProposals.delete(promise), () => pendingProposals.delete(promise)); return promise;
    } }));
  } });
  const readiness = createLogoReadiness({ connection: input.connection, workerId, readinessSeconds: seconds,
    manifest: manifest.filter(entry => composition.handlers.has(entry.operation)) });
  const store = createLogoJobStore(input.connection);
  let closed = false, active = false, timer: ReturnType<typeof setInterval> | undefined;
  const stopTimer = () => { clearInterval(timer); timer = undefined; };
  const capabilities = Object.freeze(Object.fromEntries(Object.entries(composition.capabilities).map(([operation, capability]) => [operation, Object.freeze(capability)]))) as typeof composition.capabilities;
  return Object.freeze({
    capabilities, manifest: readiness.manifest,
    refreshReadiness: () => readiness.refresh(),
    async tick(signal?: AbortSignal): ReturnType<typeof runOneJob> {
      if (closed || active || signal?.aborted || !composition.handlers.size) return "idle";
      active = true;
      try {
        if (!await readiness.refresh() || closed || signal?.aborted) return "idle";
        // The restricted SQL expiry quarantines uncertain dispatches rather than
        // replaying them; generic Strategy/Naming expiry excludes logo jobs.
        await store.expireLeases();
        if (closed || signal?.aborted) return "idle";
        timer = setInterval(() => { void readiness.refresh(); }, refreshMs); timer.unref();
        return await runOneJob({ ...runner, store, handlers, workerId, signal });
      } finally { active = false; stopTimer(); }
    },
    // Closing stops new work, but never aborts an already dispatched response or
    // prevents its fenced evidence/publication writes from being retained.
    async close() {
      closed = true; stopTimer(); await readiness.close();
      await Promise.allSettled([...pendingProposals]);
    },
  });
}
