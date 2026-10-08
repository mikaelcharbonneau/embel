import { createHash } from "node:crypto";
import { stepOutcomeSchema, type ClaimedJob, type StepOutcome } from "../../src/domain/jobs";
import { logoDirectionsJobInputSchema, logoResolvedDirectionInputSchema, logoProviderObservationSchema, logoProviderHasResponseIdentity, logoProviderResponseReceiptSchema, logoDirectionPublicationReceiptSchema, logoDirectionStepOutputSchema, type LogoResolvedDirectionInput, type LogoProviderObservation, type LogoProviderResponseReceipt, type LogoDirectionPublicationReceipt } from "../../src/domain/logo-jobs";
import type { IdentityDirectionProductionResult } from "../../src/domain/logo-directions";
import type { IdentityAssetStore } from "../../src/server/data/identity-asset-store";
import { canonicalIdentityInput } from "../../src/features/identity-directions/model/font-check-binding";
import { normalizeDirectionResponse } from "../../src/features/identity-directions/server/direction-response";
import { LOGO_DIRECTIONS_HANDLER_VERSION, type DirectionProvider } from "../../src/features/identity-directions/server/propose-directions";
import type { JobHandler } from "../runner";
export type LogoDirectionsDependencies = {
  provider: DirectionProvider; assets: IdentityAssetStore;
  loadInput(job: ClaimedJob): Promise<LogoResolvedDirectionInput>;
  assertReady(job: ClaimedJob): Promise<void>;
  recordResponse(job: ClaimedJob, observation: LogoProviderObservation): Promise<LogoProviderResponseReceipt>;
  publish(job: ClaimedJob, result: IdentityDirectionProductionResult, providerReceipt: LogoProviderResponseReceipt, signal: AbortSignal): Promise<LogoDirectionPublicationReceipt>;
};
const same = (a: unknown, b: unknown) => canonicalIdentityInput(a) === canonicalIdentityInput(b);
const active = (signal: AbortSignal) => { if (signal.aborted) throw new Error("Cancelled"); };
type UnpublishedReason = "provider_outcome_unknown" | "provider_evidence_unconfirmed" | "provider_evidence_incomplete" | "publication_unknown" | "direction_payload_invalid" | "billing_unknown";
type RetainedPayload = { json: string; sha256: string; byteLength: number; truncated: boolean };
const MAX_RETAINED_JSON_BYTES = 262_144;
/** Snapshot before awaiting persistence. JSON-as-text also preserves escaped NUL
 * and isolated surrogates without creating invalid PostgreSQL JSONB strings. */
function retainProviderResult(value: unknown): RetainedPayload | null {
  if (value === undefined) return null;
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) return null;
    const byteLength = Buffer.byteLength(serialized, "utf8");
    const prefix = Buffer.from(serialized.slice(0, MAX_RETAINED_JSON_BYTES), "utf8").subarray(0, MAX_RETAINED_JSON_BYTES);
    const json = byteLength <= MAX_RETAINED_JSON_BYTES ? serialized : new TextDecoder("utf-8", { fatal: true }).decode(prefix, { stream: true });
    return Object.freeze({ json, sha256: createHash("sha256").update(serialized, "utf8").digest("hex"), byteLength, truncated: byteLength > MAX_RETAINED_JSON_BYTES });
  } catch { return null; }
}
function unpublished(code: UnpublishedReason, payload: RetainedPayload | null, common: { costMicrousd: number; providerRequestId: string | null }): StepOutcome {
  return { status: "needs_reconciliation", code, ...(payload ? { result: Object.freeze({ version: 2, kind: "logo_directions_unpublished", reason: code, payload }) } : {}), ...common };
}
export function createLogoDirectionsHandler(deps: LogoDirectionsDependencies): JobHandler {
  return { steps(job) {
    const input = logoDirectionsJobInputSchema.parse(job.input);
    if (job.operation !== input.operation || input.ownerId !== job.ownerId || input.projectId !== job.projectId || input.handlerVersion !== LOGO_DIRECTIONS_HANDLER_VERSION) throw new Error("Invalid directions job binding.");
    return [{ key: "propose-directions", maximumCostMicrousd: job.reservedCostMicrousd, timeoutMs: input.policy?.limits.deadlineMs ?? 300_000,
      async execute({ job: claimed, signal }): Promise<StepOutcome> {
        let resolved: LogoResolvedDirectionInput;
        try {
          active(signal);
          if (claimed.id !== job.id || claimed.leaseToken !== job.leaseToken || !same(claimed.input, job.input)) throw new Error("Claim changed.");
          resolved = logoResolvedDirectionInputSchema.parse(await deps.loadInput(claimed));
          if (resolved.approvedLogo.id !== input.approvedLogoId || resolved.approvedLogo.ownerId !== claimed.ownerId || resolved.approvedLogo.projectId !== claimed.projectId || resolved.brief.id !== input.briefRevisionId || resolved.references.id !== input.referenceSnapshotId || !same(resolved.permittedFonts.map(f => f.id).sort(), [...input.fontVersionIds].sort())) throw new Error("Frozen source changed.");
          await deps.assertReady(claimed); active(signal);
        } catch { return { status: "failed", code: "not_dispatched", costMicrousd: 0, providerRequestId: null }; }
        let outcome: StepOutcome, observation: LogoProviderObservation, retained: RetainedPayload | null = null;
        try {
          const result = await deps.provider.propose(resolved, signal, { job: claimed, beforeDispatch: async current => { if (!same(current, claimed)) throw new Error("Dispatch claim changed."); await deps.assertReady(current); active(signal); } });
          retained = retainProviderResult("result" in result.outcome ? result.outcome.result : undefined);
          outcome = stepOutcomeSchema.parse(result.outcome); observation = logoProviderObservationSchema.parse(result.observation);
          if (input.policy ? !("version" in observation) || observation.registrationId !== input.policy.registrationId || observation.model !== input.policy.model || observation.provider !== "openai" : "version" in observation) throw new Error("Observation billing route mismatch.");
        } catch { return unpublished("provider_outcome_unknown", retained, { costMicrousd: 0, providerRequestId: null }); }
        // No provider response exists for this explicit adapter preflight result.
        // Do not turn proven non-dispatch into unknown billing by recording an
        // empty observation. Contradictory identity/result evidence stays fenced.
        if (input.policy && outcome.status === "failed" && outcome.code === "not_dispatched") {
          if (outcome.costMicrousd === 0 && outcome.providerRequestId === null && !("result" in outcome) && observation.providerRequestId === null && observation.responseHash === null && "version" in observation && observation.responseId === null && observation.usage === null && observation.billing.status === "unknown") return { status: "failed", code: "not_dispatched", costMicrousd: 0, providerRequestId: null };
          outcome = { ...outcome, status: "needs_reconciliation", code: "provider_evidence_incomplete" };
        }
        const common = { costMicrousd: observation.billing.status === "recorded" ? observation.billing.confirmedMicrousd : 0, providerRequestId: observation.providerRequestId };
        let receipt: LogoProviderResponseReceipt;
        try {
          receipt = logoProviderResponseReceiptSchema.parse(await deps.recordResponse(claimed, observation));
          const { id: _id, ownerId, projectId, jobId, leaseToken, ...recorded } = receipt;
          void _id;
          if (ownerId !== claimed.ownerId || projectId !== claimed.projectId || jobId !== claimed.id || leaseToken !== claimed.leaseToken || !same(recorded, observation) || outcome.providerRequestId !== observation.providerRequestId) throw new Error("Provider receipt mismatch.");
        } catch { return unpublished("provider_evidence_unconfirmed", retained, common); }
        if (outcome.status !== "succeeded") return observation.billing.status === "unknown" || outcome.status === "needs_reconciliation"
          ? unpublished(observation.billing.status === "unknown" ? "billing_unknown" : "provider_outcome_unknown", retained, common)
          : { status: "failed", code: outcome.code, ...common };
        if (!logoProviderHasResponseIdentity(observation) || signal.aborted) return unpublished("provider_evidence_incomplete", retained, common);
        let result: IdentityDirectionProductionResult;
        try { result = normalizeDirectionResponse(outcome.result, resolved); }
        catch { return unpublished("direction_payload_invalid", retained, common); }
        try {
          active(signal);
          const publication = logoDirectionPublicationReceiptSchema.parse(await deps.publish(claimed, result, receipt, signal));
          if (publication.ownerId !== claimed.ownerId || publication.projectId !== claimed.projectId || publication.jobId !== claimed.id || publication.inputHash !== input.inputHash || !same(publication.directionIds, result.directions.map(d => d.id))) throw new Error("Publication receipt mismatch.");
          const output = logoDirectionStepOutputSchema.parse({ version: 2, kind: "logo_directions", publicationId: publication.id, providerResponseReceiptId: receipt.id });
          return observation.billing.status === "unknown" ? { status: "needs_reconciliation", code: "billing_unknown", result: output, ...common } : { status: "succeeded", result: output, ...common };
        } catch { return unpublished("publication_unknown", retained, common); }
      },
    }];
  } };
}
