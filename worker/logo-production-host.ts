import "server-only";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { IdentityConnectionBinding } from "../src/server/data/identity-transaction";
import type { LogoWorkerConnection } from "../src/server/data/logo-jobs";
import type { IdentityPoolPort } from "../src/server/runtime/identity-pool";
import type { GuidelinesDependencies } from "../src/features/identity-deliverables/server/guidelines";
import type { LogoWorkerCapability } from "./logo-readiness";
import { createDevelopmentLogoConnection, createLogoProductionConnection, type LogoProductionConnectionInput } from "./logo-production-connection";
import { createLogoProductionAssetStore } from "./logo-production-asset-store";
import { qualifiedLogoProductionStorageCapability, type LogoProductionStorageAuthorization } from "./logo-production-storage-authorization";
import { createLogoProductionRuntimeQualification } from "./logo-production-qualification";
import { startLogoProductionWorker, type LogoProductionStartup, type LogoProductionImageOperationInput, type LogoProductionDirectionsOperationInput, type LogoProductionProposalOperationInput } from "./logo-production-startup";
import { createLogoGenerativeAssetStore } from "./logo-generative-asset-store";
import { qualifiedLogoGenerativeStorageCapability, type LogoGenerativeStorageAuthorization } from "./logo-generative-storage-authorization";

import { qualifiedLogoVectorProposalCapability } from "./logo-vector-proposal-capability";
import { resolveLogoVectorProposalConfiguration } from "../src/features/logo-vector/server/proposal-policy";
import { createLogoDirectionsAssetStore } from "./logo-directions-asset-store";
import { qualifiedLogoDirectionsStorageCapability, type LogoDirectionsStorageAuthorization } from "./logo-directions-storage-authorization";

export type LogoProductionProposalHostOperation = LogoProductionProposalOperationInput;
export type LogoProductionDirectionsHostOperation = Pick<LogoProductionDirectionsOperationInput, "capability" | "expectedAccountId" | "transport"> & { authorization: LogoDirectionsStorageAuthorization | null };
export type LogoProductionImageHostOperation = Pick<LogoProductionImageOperationInput, "capability" | "image" | "transport"> & { authorization: LogoGenerativeStorageAuthorization | null };
export type LogoProductionHostOperation = { capability: LogoWorkerCapability; authorization: LogoProductionStorageAuthorization | null };
export type LogoProductionHostOptions = { enabled: false } | {
  enabled: true; binding: IdentityConnectionBinding; pool: IdentityPoolPort | null; workerId: string;
  /** Trusted isolated-dev composition only. The selected connection rechecks its gate. */
  development?: true;
  concepts?: LogoProductionImageHostOperation | null;
  proposals?: LogoProductionProposalHostOperation | null;
  refinements?: LogoProductionImageHostOperation | null;
  vector?: LogoProductionHostOperation | null;
  directions?: LogoProductionDirectionsHostOperation | null;
  exports?: (LogoProductionHostOperation & { guidelines?: GuidelinesDependencies }) | null;
  /** Optional construction/host lifetime cancellation; run also requires its own signal. */
  signal?: AbortSignal;
  pollMs?: number;
  timeouts?: Pick<LogoProductionConnectionInput, "acquireTimeoutMs" | "queryTimeoutMs" | "disposalTimeoutMs">;
};
export type LogoProductionHost = Readonly<{ status: "qualified"; manifest: readonly LogoWorkerCapability[]; run(signal: AbortSignal): Promise<void>; close(): Promise<void> }>
  | Readonly<{ status: "disabled" | "unavailable"; reason: "configuration" | "dependency_validation"; phase: "configuration" | "database_identity" | "runtime_qualification" | "composition"; close(): Promise<void> }>;
const unavailable = () => new Error("Logo production host is unavailable.");
const drainUnconfirmed = () => new Error("Logo production host drain is unconfirmed.");
const newWorkSql = new Set([
  "select public.report_logo_worker_ready($1,$2,$3) value", "select public.expire_logo_job_leases() value",
  "select * from public.claim_logo_job($1,$2)", "select public.register_logo_job_plan($1,$2,$3)",
  "select public.begin_logo_job_step($1,$2,$3,$4,$5) value",
]);

/** Explicit dedicated composition with individually selected operation lanes. Merely importing or leaving
 * this disabled does no I/O. A qualified handle proves local qualification and
 * checked SQL identity, not pre-job Storage access or hosted readiness. Nothing
 * reports or claims until run(signal). No credentials/configuration discovery,
 * provider calls, process handlers, deployment, pool or authorization ownership. */
export async function startLogoProductionHost(options: LogoProductionHostOptions | null = null): Promise<LogoProductionHost> {
  const absent = (status: "disabled" | "unavailable", reason: "configuration" | "dependency_validation",
    phase: "configuration" | "database_identity" | "runtime_qualification" | "composition" = "configuration"): LogoProductionHost =>
    Object.freeze({ status, reason, phase, async close() {} });
  if (!options || options.enabled === false) return absent("disabled", "configuration");
  let connection: ReturnType<typeof createLogoProductionConnection>, qualification: ReturnType<typeof createLogoProductionRuntimeQualification> | undefined;
  let ownerId: string, workerId: string, pollMs: number;
  let concepts: LogoProductionImageHostOperation | null, refinements: LogoProductionImageHostOperation | null;
  let directions: LogoProductionDirectionsHostOperation | null;
  let proposals: LogoProductionProposalHostOperation | null;
  let vector: LogoProductionHostOperation | null, exports: (LogoProductionHostOperation & { guidelines?: GuidelinesDependencies }) | null;
  try {
    if (options.enabled !== true || !options.binding || !options.concepts && !options.refinements && !options.vector && !options.exports && !options.directions && !options.proposals) throw unavailable();
    ownerId = z.uuid().parse(options.binding.ownerId).toLowerCase();
    workerId = z.string().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/).parse(options.workerId);
    pollMs = z.number().int().min(10).max(20_000).parse(options.pollMs ?? 1000);
    function capture(input: LogoProductionHostOperation | null | undefined, operation: "identity.logo_vectorize" | "identity.logo_export") {
      if (!input) return null;
      const capability = qualifiedLogoProductionStorageCapability(input.capability), auth = input.authorization;
      if (!capability || capability.operation !== operation || !auth || auth.ownerId !== ownerId
        || !isDeepStrictEqual(capability, qualifiedLogoProductionStorageCapability(auth.capability))
        || ![auth.assertAvailable, auth.authorizeRead, auth.authorizeWrite, auth.authorizeReadback, auth.close].every(method => typeof method === "function")) throw unavailable();
      const authorization: LogoProductionStorageAuthorization = Object.freeze({ ownerId, capability,
        assertAvailable: auth.assertAvailable.bind(auth), authorizeRead: auth.authorizeRead.bind(auth), authorizeWrite: auth.authorizeWrite.bind(auth),
        authorizeReadback: auth.authorizeReadback.bind(auth), close: auth.close.bind(auth) });
      return Object.freeze({ capability, authorization });
    }
    function captureImage(input: LogoProductionImageHostOperation | null | undefined, operation: "identity.logo_concept" | "identity.logo_refine") {
      if (!input) return null;
      const capability = qualifiedLogoGenerativeStorageCapability(input.capability), auth = input.authorization;
      if (!capability || capability.operation !== operation || !auth || auth.ownerId !== ownerId
        || !isDeepStrictEqual(capability, qualifiedLogoGenerativeStorageCapability(auth.capability))
        || ![auth.assertAvailable, auth.authorizeRead, auth.authorizeWrite, auth.close].every(method => typeof method === "function")) throw unavailable();
      const authorization: LogoGenerativeStorageAuthorization = Object.freeze({ ownerId, capability,
        assertAvailable: auth.assertAvailable.bind(auth), authorizeRead: auth.authorizeRead.bind(auth),
        authorizeWrite: auth.authorizeWrite.bind(auth), close: auth.close.bind(auth) });
      return Object.freeze({ capability, authorization, image: Object.freeze({ ...input.image }),
        ...(input.transport ? { transport: Object.freeze({ createImage: input.transport.createImage.bind(input.transport) }) } : {}) });
    }
    directions = null;
    if (options.directions) {
      const input = options.directions, capability = qualifiedLogoDirectionsStorageCapability(input.capability), auth = input.authorization, transport = input.transport;
      if (!capability || !auth || auth.ownerId !== ownerId || !isDeepStrictEqual(capability, qualifiedLogoDirectionsStorageCapability(auth.capability))
        || ![auth.assertAvailable, auth.authorizeRead, auth.close].every(method => typeof method === "function")
        || typeof transport?.streamResponse !== "function" || typeof transport?.listModels !== "function") throw unavailable();
      const authorization: LogoDirectionsStorageAuthorization = Object.freeze({ ownerId, capability, assertAvailable: auth.assertAvailable.bind(auth),
        authorizeRead: auth.authorizeRead.bind(auth), close: auth.close.bind(auth) });
      directions = Object.freeze({ capability, authorization, expectedAccountId: input.expectedAccountId,
        transport: Object.freeze({ streamResponse: transport.streamResponse.bind(transport), listModels: transport.listModels.bind(transport) }) });
    }
    proposals = null;
    if (options.proposals) {
      const input = options.proposals, capability = qualifiedLogoVectorProposalCapability(input.capability);
      const configuration = resolveLogoVectorProposalConfiguration(input.configuration), transport = input.transport;
      if (!capability || !configuration || !isDeepStrictEqual(capability.textPolicy, configuration.textPolicy)
        || transport !== undefined && (typeof transport.countInputTokens !== "function" || typeof transport.createResponse !== "function")) throw unavailable();
      proposals = Object.freeze({ capability, configuration, ...(input.apiKey !== undefined ? { apiKey: input.apiKey } : {}),
        ...(transport ? { transport: Object.freeze({ countInputTokens: transport.countInputTokens.bind(transport), createResponse: transport.createResponse.bind(transport) }) } : {}) });
    }
    concepts = captureImage(options.concepts, "identity.logo_concept");
    refinements = captureImage(options.refinements, "identity.logo_refine");
    vector = capture(options.vector, "identity.logo_vectorize");
    const exportOperation = capture(options.exports, "identity.logo_export"), guidelines = options.exports?.guidelines;
    if (guidelines !== undefined && (!guidelines || typeof guidelines !== "object" || guidelines.resolveEmbeddedFont !== undefined && typeof guidelines.resolveEmbeddedFont !== "function")) throw unavailable();
    exports = exportOperation ? { ...exportOperation, ...(guidelines ? { guidelines: Object.freeze(guidelines.resolveEmbeddedFont ? { resolveEmbeddedFont: guidelines.resolveEmbeddedFont.bind(guidelines) } : {}) } : {}) } : null;
    connection = (options.development === true ? createDevelopmentLogoConnection : createLogoProductionConnection)({ ...options.binding, ownerId, pool: options.pool, ...options.timeouts });
    if (!connection) throw unavailable();
    const productionCapabilities = [vector, exports].flatMap(operation => operation ? [operation.capability] : []);
    qualification = productionCapabilities.length ? createLogoProductionRuntimeQualification({ ownerId, workerId, capabilities: productionCapabilities }) : undefined;
  } catch { return absent("unavailable", "configuration"); }
  const checked = connection;
  let phase: "database_identity" | "runtime_qualification" | "composition" = "composition";
  const operations: LogoWorkerConnection = { async query<Row>(sql: string, values?: unknown[]) {
    try {
      if (closed && newWorkSql.has(sql)) throw unavailable();
      const result = await checked.query<Row>(sql, values, newWorkSql.has(sql) ? lifetime.signal : undefined);
      // A claim/plan/step acknowledged after stop must never start new work.
      // Its already dispatched SQL remains durable for normal lease recovery.
      if (closed && newWorkSql.has(sql)) throw unavailable();
      return result;
    }
    catch (error) { phase = "database_identity"; throw error; }
  } };
  const lifetime = new AbortController(), constructionSignal = options.signal;
  let startup: LogoProductionStartup | undefined, closed = false, closing: Promise<void> | undefined, running: Promise<void> | undefined;
  const stop = () => { void close().catch(() => {}); };
  function close(): Promise<void> {
    if (closing) return closing;
    closed = true; lifetime.abort();
    // Fence startup immediately; allow dispatched evidence/publication to drain
    // with the connection and caller-owned storage capabilities still alive.
    const runtimeDrain = startup?.close();
    const qualificationDrain = qualification?.close();
    closing = (async () => {
      try {
        const settled = await Promise.allSettled([runtimeDrain, qualificationDrain]);
        await checked.close();
        if (settled.some(result => result.status === "rejected")) throw drainUnconfirmed();
      } catch { throw drainUnconfirmed(); }
      finally { constructionSignal?.removeEventListener("abort", stop); }
    })();
    return closing;
  }
  constructionSignal?.addEventListener("abort", stop, { once: true });
  try {
    if (constructionSignal?.aborted) { await close(); return absent("unavailable", "dependency_validation", phase); }
    const operation = (value: LogoProductionHostOperation | null) => value ? {
      capability: value.capability,
      assets: createLogoProductionAssetStore({ connection: operations, authorization: value.authorization }),
      async assertRuntimeAvailable(scope: Parameters<NonNullable<typeof qualification>["assertRuntimeAvailable"]>[0]) {
        try { if (!qualification) throw unavailable(); await qualification.assertRuntimeAvailable(scope, lifetime.signal); }
        catch (error) { phase = "runtime_qualification"; throw error; }
      },
      assertAvailable: value.authorization!.assertAvailable,
    } : null;
    const imageOperation = (value: LogoProductionImageHostOperation | null) => value ? {
      capability: value.capability, image: value.image, transport: value.transport,
      assets: createLogoGenerativeAssetStore({ connection: operations, authorization: value.authorization }),
      assertAvailable: value.authorization!.assertAvailable,
    } : null;
    startup = await startLogoProductionWorker({ enabled: true, ownerId, workerId, connection: operations,
      proposals, concepts: imageOperation(concepts), refinements: imageOperation(refinements), vector: operation(vector),
      directions: directions ? { capability: directions.capability, expectedAccountId: directions.expectedAccountId, transport: directions.transport,
        assets: createLogoDirectionsAssetStore({ connection: operations, authorization: directions.authorization }), assertAvailable: directions.authorization!.assertAvailable } : null,
      exports: exports ? { ...operation(exports)!, guidelines: exports.guidelines } : null });
    if (closed || startup.status !== "ready") {
      // If stop occurred during construction, this newly obtained runtime was
      // not present at the first fence. Close it before confirming cleanup.
      await startup.close(); await close(); return absent("unavailable", "dependency_validation", phase);
    }
    const started = startup;
    return Object.freeze({ status: "qualified", manifest: started.runtime.manifest,
      run(signal: AbortSignal): Promise<void> {
        if (running) return running;
        if (closed) return close();
        if (!signal || typeof signal.addEventListener !== "function") return Promise.reject(unavailable());
        running = (async () => {
          signal.addEventListener("abort", stop, { once: true });
          try {
            if (signal.aborted) { await close(); return; }
            while (!closed) {
              // tick owns readiness refresh, lease expiration and one claim.
              // No competing host heartbeat or overlapping tick is scheduled.
              // Shutdown fences the runtime without cancelling an already
              // dispatched publication, so immutable evidence remains retained.
              await started.runtime.tick();
              if (!closed) await delay(pollMs, undefined, { signal: lifetime.signal }).catch(() => {});
            }
          } catch { if (!closed) { await close(); throw unavailable(); } }
          finally { signal.removeEventListener("abort", stop); await close(); }
        })();
        return running;
      }, close,
    });
  } catch {
    await close(); return absent("unavailable", "dependency_validation", phase);
  }
}
