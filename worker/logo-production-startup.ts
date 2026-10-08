import "server-only";
import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import { createLogoVectorProposalWorkerPorts } from "../src/server/data/logo-vector-proposal-worker";
import { createLogoVectorProposalRuntimeAdapter, type LogoVectorProposalRuntimeAdapterInput } from "./logo-vector/proposal-runtime-adapter";
import { qualifiedLogoVectorProposalCapability } from "./logo-vector-proposal-capability";
import type { ClaimedJob } from "../src/domain/jobs";
import { logoUuidSchema } from "../src/domain/logo-vector";
import type { IdentityAssetStore } from "../src/server/data/identity-asset-store";
import type { LogoWorkerConnection } from "../src/server/data/logo-jobs";
import type { GuidelinesDependencies } from "../src/features/identity-deliverables/server/guidelines";
import { createLogoVectorRuntimeAdapter } from "./logo-vector/runtime-adapter";
import { createLogoExportsRuntimeAdapter } from "./logo-exports/runtime-adapter";
import { createLogoWorkerRuntime } from "./logo-runtime";
import { freezeLogoWorkerManifest, type LogoWorkerCapability } from "./logo-readiness";
import { createLogoImageRuntimeAdapter, type LogoImageRuntimeAdapterInput } from "./logo-image-runtime-adapter";
import { createLogoDirectionsRuntimeAdapter, type LogoDirectionsRuntimeAdapterInput } from "./logo-directions/runtime-adapter";

export type LogoProductionProposalOperationInput = Pick<LogoVectorProposalRuntimeAdapterInput, "configuration" | "apiKey" | "transport"> & { capability: LogoWorkerCapability };
export type LogoProductionRuntimeScope = Readonly<{ ownerId: string; workerId: string; capability: LogoWorkerCapability }>;
export type LogoProductionOperationInput = {
  capability: LogoWorkerCapability;
  assets: IdentityAssetStore | null;
  /** Independently qualify the installed runtime and separately authorized
   * operation capability. No credential discovery, provisioning or provider call.
   * Called before startup succeeds and before every readiness report. */
  assertRuntimeAvailable: ((scope: LogoProductionRuntimeScope) => Promise<void>) | null;
  /** Job-bound authorization is separate from installed-runtime qualification.
   * The adapter and database still verify exact owner, frozen input and lease. */
  assertAvailable: ((job: ClaimedJob) => Promise<void>) | null;
};
export type LogoProductionImageOperationInput = Pick<LogoImageRuntimeAdapterInput, "capability" | "image" | "assets" | "assertAvailable" | "transport">;
export type LogoProductionDirectionsOperationInput = Pick<LogoDirectionsRuntimeAdapterInput, "expectedAccountId" | "transport" | "assets" | "assertAvailable"> & { capability: LogoWorkerCapability };
export type LogoProductionStartupOptions = { enabled: false } | {
  enabled: true;
  ownerId: string;
  workerId: string;
  /** Already authorized dedicated logo connection. The caller owns its pool,
   * TLS/principal validation on acquisition, and disposal after close drains. */
  connection: LogoWorkerConnection | null;
  concepts?: LogoProductionImageOperationInput | null;
  proposals?: LogoProductionProposalOperationInput | null;
  refinements?: LogoProductionImageOperationInput | null;
  vector?: LogoProductionOperationInput | null;
  directions?: LogoProductionDirectionsOperationInput | null;
  exports?: (LogoProductionOperationInput & { guidelines?: GuidelinesDependencies }) | null;
};
type Runtime = ReturnType<typeof createLogoWorkerRuntime>;
export type LogoProductionStartup = Readonly<{ status: "ready"; runtime: Runtime; close(): Promise<void> }>
  | Readonly<{ status: "disabled" | "unavailable"; reason: "configuration" | "dependency_validation"; close(): Promise<void> }>;
const unavailable = () => new Error("The exact owner-bound logo production runtime is unavailable.");
const reportSql = "select public.report_logo_worker_ready($1,$2,$3) value";
const ownerSql = "select fluid_private.logo_worker_owner()::text as owner_id";

/** Explicit per-operation opt-in seam, including separately gated image lanes. Never reads environment/configuration,
 * creates a connection or storage authorization, reports readiness, claims work,
 * or starts a timer on startup. Existing concept and text entrypoints do not
 * import or invoke it. A ready result means local qualification only; SQL policy
 * acknowledgement and job-bound storage authorization remain mandatory.
 */
export async function startLogoProductionWorker(options: LogoProductionStartupOptions | null = null): Promise<LogoProductionStartup> {
  const absent = (status: "disabled" | "unavailable", reason: "configuration" | "dependency_validation"): LogoProductionStartup =>
    Object.freeze({ status, reason, async close() {} });
  if (!options || options.enabled === false) return absent("disabled", "configuration");
  let engine: Runtime;
  let closed = false, closing: Promise<void> | undefined;
  const pending = new Set<Promise<unknown>>();
  let assertQualified: () => Promise<void>;
  try {
    if (options.enabled !== true || typeof options.connection?.query !== "function" || !options.concepts && !options.refinements && !options.vector && !options.exports && !options.directions && !options.proposals) throw unavailable();
    const ownerId = logoUuidSchema.parse(options.ownerId);
    const workerId = z.string().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/).parse(options.workerId);
    const query = options.connection.query.bind(options.connection);
    const selected: { scope: LogoProductionRuntimeScope; qualify: (scope: LogoProductionRuntimeScope) => Promise<void> }[] = [];
    const connection: LogoWorkerConnection = { async query<Row>(sql: string, parameters: unknown[] = []) {
      // The wrapped connection is used by the existing runtime's explicit and
      // periodic reports. A failed qualification invalidates readiness there;
      // already-dispatched evidence/completion queries remain drainable.
      if (sql === reportSql) await assertQualified();
      return query<Row>(sql, parameters);
    } };
    function capture(input: LogoProductionOperationInput, capability: LogoWorkerCapability | undefined) {
      if (!capability || typeof input.assertRuntimeAvailable !== "function" || typeof input.assertAvailable !== "function") throw unavailable();
      const expected = freezeLogoWorkerManifest([input.capability])[0]!;
      if (JSON.stringify(expected) !== JSON.stringify(capability)) throw unavailable();
      selected.push({ scope: Object.freeze({ ownerId, workerId, capability }), qualify: input.assertRuntimeAvailable.bind(input) });
    }
    function captureImage(input: LogoProductionImageOperationInput | null | undefined, operation: "identity.logo_concept" | "identity.logo_refine") {
      if (!input) return null;
      if (input.capability?.operation !== operation) throw unavailable();
      const assertion = input.assertAvailable?.bind(input);
      const result = createLogoImageRuntimeAdapter({ ...input, ownerId, connection, references: "uploaded", acceptingWork: () => !closed,
        assertAvailable: assertion ? async job => { if (closed) throw unavailable(); await assertion(job); if (closed) throw unavailable(); } : null });
      if (!result || result.capability.operation !== operation) throw unavailable();
      return result;
    }
    const concepts = captureImage(options.concepts, "identity.logo_concept"), refinements = captureImage(options.refinements, "identity.logo_refine");
    let directions: ReturnType<typeof createLogoDirectionsRuntimeAdapter> = null;
    if (options.directions) {
      const input = options.directions, expected = freezeLogoWorkerManifest([input.capability])[0]!;
      if (expected.operation !== "identity.logo_directions" || !expected.policy) throw unavailable();
      const assertion = input.assertAvailable?.bind(input);
      directions = createLogoDirectionsRuntimeAdapter({ ownerId, connection, policyIdentity: expected.policyIdentity, policy: expected.policy,
        expectedAccountId: input.expectedAccountId, transport: input.transport, assets: input.assets, acceptingWork: () => !closed,
        assertAvailable: assertion ? async job => { if (closed) throw unavailable(); await assertion(job); if (closed) throw unavailable(); } : null });
      if (!directions || JSON.stringify(expected) !== JSON.stringify(directions.capability)) throw unavailable();
    }
    let proposals: ReturnType<typeof createLogoVectorProposalRuntimeAdapter> = null;
    if (options.proposals) {
      const input = options.proposals, capability = qualifiedLogoVectorProposalCapability(input.capability);
      if (!capability) throw unavailable();
      proposals = createLogoVectorProposalRuntimeAdapter({ ownerId, policyIdentity: capability.policyIdentity,
        configuration: input.configuration, apiKey: input.apiKey, transport: input.transport,
        ports: createLogoVectorProposalWorkerPorts(connection), acceptingWork: () => !closed });
      if (!proposals || !isDeepStrictEqual(proposals.capability, capability)) throw unavailable();
    }
    const vector = options.vector ? createLogoVectorRuntimeAdapter({ ownerId, connection, assets: options.vector.assets,
      policyIdentity: options.vector.capability?.policyIdentity, assertAvailable: options.vector.assertAvailable?.bind(options.vector) ?? null }) : null;
    const exports = options.exports ? createLogoExportsRuntimeAdapter({ ownerId, connection, assets: options.exports.assets,
      assertAvailable: options.exports.assertAvailable?.bind(options.exports) ?? null, guidelines: options.exports.guidelines }) : null;
    if (options.vector) capture(options.vector, vector?.capability);
    if (options.exports) capture(options.exports, exports?.capability);
    assertQualified = async () => {
      if (closed) throw unavailable();
      // SQL derives ownership from actual session_user plus current role OID and
      // denies privileged/member roles. No caller JWT/owner parameter is trusted.
      const result = await query<{ owner_id: unknown }>(ownerSql);
      if (closed || result.rows.length !== 1 || result.rows[0]?.owner_id !== ownerId) throw unavailable();
      for (const entry of selected) {
        await entry.qualify(entry.scope);
        if (closed) throw unavailable();
      }
    };
    const manifest = [concepts, refinements, vector, directions, exports, proposals].flatMap(adapter => adapter ? [adapter.capability] : []);
    engine = createLogoWorkerRuntime({ connection, workerId, manifest, composition: {
      concepts: concepts?.concepts ?? null, refinements: refinements?.refinements ?? null, vector: vector?.dependencies ?? null, directions: directions?.dependencies ?? null, exports: exports?.dependencies ?? null, proposals: proposals?.proposals ?? null, unavailableReasons: {},
    } });
    if (engine.manifest.length !== manifest.length) throw unavailable();
  } catch { return absent("unavailable", "configuration"); }
  function track<T>(promise: Promise<T>): Promise<T> {
    pending.add(promise); void promise.then(() => pending.delete(promise), () => pending.delete(promise)); return promise;
  }
  function close(): Promise<void> {
    if (closing) return closing;
    closed = true;
    return closing = (async () => { await engine.close(); await Promise.allSettled([...pending]); })();
  }
  try { await assertQualified(); }
  catch { await close(); return absent("unavailable", "dependency_validation"); }
  const runtime: Runtime = Object.freeze({ ...engine,
    tick: (signal?: AbortSignal) => track(engine.tick(signal)), refreshReadiness: () => track(engine.refreshReadiness()), close,
  });
  return Object.freeze({ status: "ready", runtime, close });
}
