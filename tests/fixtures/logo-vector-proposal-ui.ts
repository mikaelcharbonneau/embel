/** TEST ONLY: ordinary app routes with synthetic AI metadata and real local
 * authored vector/PNG bytes. No provider, account credentials or live uploads. */
import { createHash } from "node:crypto";
import type { Page, Route } from "@playwright/test";
import { setupSavedVectorEditor } from "./logo-vector-editor-ui";
import { logoFixtureId as id } from "./logo-creation";
import { logoCostQuoteSchema, logoGenerationIntentSchema, type LogoCostQuote, type LogoGenerationIntent } from "../../src/domain/logo-jobs";
import { logoVectorProposalRequestSchema, logoVectorProposalContextSchema } from "../../src/domain/logo-vector-proposals";
import { logoVectorProposalRecordSchema, type LogoVectorProposalRecord } from "../../src/domain/logo-vector-proposal-jobs";
import { logoVectorProposalRequestStateSchema, type LogoVectorProposalRequestState } from "../../src/features/logo-vector/model/proposal-session";
import { getLogoComponentPaintedBounds } from "../../src/features/logo-vector/model/geometry";
import { getLogoVectorProposalComponentOperations } from "../../src/features/logo-vector/model/proposal";
import { applyLogoManualEdit } from "../../src/features/logo-vector/model/edits";
import { applyLogoVectorProposalCommandSchema, type LogoVectorProposalMaterialization, type ApplyLogoVectorProposalInput } from "../../src/features/logo-vector/model/proposal-materialization";
import type { LogoMutationReceipt, LogoStageRevision } from "../../src/domain/logo-workspace";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const policy = { version: 1 as const, billingMode: "openai_api" as const, handlerVersion: "logo-vector-propose-v1" as const, adapterVersion: "logo-vector-propose-api-v1" as const,
  schemaVersion: "logo-vector-proposal-v1" as const, model: "gpt-6.1-sol" as const, pricingVersion: "2026-10-03" as const, serviceTier: "default" as const,
  maxInputTokens: 32768, maxOutputTokens: 4096, maxInputBytes: 131072, maxOutputBytes: 32768, maxStreamBytes: 2097152, deadlineMs: 240000, maxTools: 0 as const,
  inputMicrousdPerMillionTokens: 2000000 as const, cachedInputMicrousdPerMillionTokens: 100000 as const, cacheWriteMicrousdPerMillionTokens: 2500000 as const,
  outputMicrousdPerMillionTokens: 10000000 as const, maximumCostMicrousd: 122880 };

export async function setupVectorProposalUi(page: Page, options: { legacy?: boolean; navigate?: boolean } = {}) {
  const f = await setupSavedVectorEditor(page, { navigate: false }), { ownerId, projectId, base } = f;
  const originalApproval = { id: id(3100), ownerId, projectId, vectorRevisionId: f.initial.revision.id, stageRevisionId: f.workspace.stages.vector!.id, approvedAt: "2026-10-27T00:00:00Z" };
  f.workspace = { ...f.workspace, approvedLogo: originalApproval };
  let sequence = 3200;
  const quotes = new Map<string, LogoCostQuote>(), paid = new Map<string, { input: LogoGenerationIntent; quote: LogoCostQuote; value: LogoVectorProposalRequestState }>();
  const records = new Map<string, LogoVectorProposalRecord>(), materializations = new Map<string, LogoVectorProposalMaterialization>(), applyReceipts = new Map<string, LogoMutationReceipt>(), cancelled = new Map<string, unknown>();
  const state = { base: f, available: true, discoveryFailure: false, loseAdmissionAck: false, refuseAdmission: false, loseApplyAck: false, unsupported: false,
    quotes: [] as unknown[], admissions: [] as LogoGenerationIntent[], applications: [] as ApplyLogoVectorProposalInput[], lookups: [] as LogoGenerationIntent[], closures: [] as LogoGenerationIntent[],
    pending: paid, records, originalApproval, setOwner(value: string) { f.owner = value; } };
  const json = (route: Route, value: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
  function context(quote: LogoCostQuote) {
    if (quote.request.operation !== "propose_vector_edit") throw Error("Fixture quote operation");
    const detail = f.details.get(quote.request.baseVectorRevisionId)!;
    const components = detail.document.components.map(component => {
      const summary = { id: component.id, role: component.role, editingKind: component.editingKind, transform: component.transform,
        paintedBounds: getLogoComponentPaintedBounds(component), localPaintedBounds: getLogoComponentPaintedBounds({ ...component, transform: { x: 0, y: 0, scale: 1, rotation: 0 } }),
        paint: { status: "uniform" as const, fill: component.paths[0]?.fill?.color ?? null, stroke: null, textUniform: true }, text: null };
      return { ...summary, allowedOperations: getLogoVectorProposalComponentOperations(summary, false) };
    });
    return logoVectorProposalContextSchema.parse({ version: 1, ownerId, projectId, baseVectorRevisionId: detail.revision.id, documentHash: detail.revision.documentHash,
      source: detail.revision.source, viewBox: detail.document.viewBox, locks: detail.revision.locks, inputRevisions: detail.revision.inputRevisions,
      brief: { id: f.source.brief.id, revision: f.source.brief.revision, inputHash: f.source.brief.inputHash, name: f.source.brief.payload.name }, components, fonts: [],
      targetComponentIds: quote.request.targetComponentIds, allowedOperations: ["size", "rotation", "color", "arrangement"] });
  }
  function makeQuote(value: unknown): LogoCostQuote {
    const request = logoVectorProposalRequestSchema.parse(value);
      const { maximumCostMicrousd: _maximum, ...rest } = policy; void _maximum;
      const textPolicy = options.legacy ? policy : { ...rest, version: 2, spendControl: "uncapped", adapterVersion: "logo-vector-propose-api-uncapped-v2" };
      const quote = logoCostQuoteSchema.parse({ id: id(sequence++), ownerId, projectId, request, inputHash: hash(request), expected: request.expected, policyIdentity: "7".repeat(64), handlerVersion: "logo-vector-propose-v1", provider: "openai", model: "gpt-6.1-sol", engine: null,
        expiresAt: new Date(Date.now() + 60000).toISOString(), conceptPlan: null, targetSlotIds: [], textPolicy,
        ...(options.legacy ? { estimatedCostMicrousd: policy.maximumCostMicrousd, maxCostMicrousd: policy.maximumCostMicrousd, externalProviderCostMicrousd: policy.maximumCostMicrousd } : { version: 3, billingMode: "openai_api", spendControl: "uncapped" }) });
    quotes.set(quote.id, quote); return quote;
  }
  function seedPending(count: number) {
    for (let index = 0; index < count; index++) {
      const quote = makeQuote({ operation: "propose_vector_edit", expected: f.workspace.heads, baseVectorRevisionId: f.initial.revision.id, instruction: `Synthetic pending request ${index + 1}`, targetComponentIds: [f.initial.document.components[0]!.id] });
      const original = logoGenerationIntentSchema.parse({ requestKey: id(sequence++), quoteId: quote.id, expected: quote.expected, ...("spendControl" in quote ? {} : { acceptedMaxCostMicrousd: quote.maxCostMicrousd }) });
      const receipt = { ownerId, projectId, requestKey: original.requestKey, operation: "identity.logo_vector_propose", batchId: null, jobIds: [id(sequence++)], inputHash: quote.inputHash };
      const value = logoVectorProposalRequestStateSchema.parse({ ownerId, projectId, input: original, state: { status: "admitted", requestKey: original.requestKey, receipt, outputs: [], billing: { status: "unknown", confirmedMicrousd: null }, reason: null }, proposal: null });
      paid.set(original.requestKey, { input: original, quote, value });
    }
  }
  function finish(key: string) {
    const request = paid.get(key)!; if (!request || request.quote.request.operation !== "propose_vector_edit") throw Error("Missing fixture admission");
    const q = request.quote, jobId = request.value.state.status !== "not_found" && request.value.state.receipt && "jobIds" in request.value.state.receipt ? request.value.state.receipt.jobIds[0]! : "";
    const textPolicy = "textPolicy" in q ? q.textPolicy : null; if (!textPolicy) throw Error("Missing actual proposal policy");
    const record = logoVectorProposalRecordSchema.parse({ version: 1, id: id(sequence++), ownerId, projectId, jobId, requestKey: key, quoteId: q.id,
      baseVectorRevisionId: request.quote.request.baseVectorRevisionId, contextHash: hash(context(q)), inputRevisions: f.initial.revision.inputRevisions, expected: q.expected, context: context(q), state: "succeeded",
      payload: state.unsupported ? { version: 1, status: "unsupported", code: "unsupported_request", explanation: "Synthetic unsupported result; original artwork unchanged." }
        : { version: 1, status: "proposed", edit: { kind: "color", componentId: request.quote.request.targetComponentIds[0], fill: "#334455", stroke: null }, explanation: "Synthetic suggestion: use #334455 on the selected symbol." },
      providerReceipt: { id: id(sequence++), ownerId, projectId, jobId, leaseToken: id(sequence++), observation: { version: 1, kind: "logo_vector_proposal_text", provider: "openai", model: "gpt-6.1-sol", responseComplete: true, toolCalls: 0,
        serviceTier: "default", responseId: "synthetic-response", providerRequestId: "synthetic-request", responseHash: "a".repeat(64), observedAt: new Date().toISOString(), textPolicy,
        usage: { inputTokens: 2, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 3 }, billing: { status: "recorded", confirmedMicrousd: 34 } } }, actualCostMicrousd: 34, reason: null, createdAt: new Date().toISOString(), materialization: "unavailable" });
    records.set(record.id, record);
    if (request.value.state.status === "not_found") throw Error("No admission");
    request.value = logoVectorProposalRequestStateSchema.parse({ ...request.value, state: { ...request.value.state, status: "succeeded", billing: { status: "recorded", confirmedMicrousd: 34 } }, proposal: record }); return record;
  }
  await page.route("**/api/projects/*/logo/**", async route => {
    const target = new URL(route.request().url()), path = target.pathname;
    if (!path.startsWith(base) || f.owner !== ownerId) return json(route, {}, 404);
    const body = () => route.request().postDataJSON();
    if (path === `${base}/capabilities`) { const now = Date.now(); return json(route, { ownerId, projectId, observedAt: new Date(now).toISOString(), operations: Object.fromEntries(["identity.logo_concept", "identity.logo_refine", "identity.logo_vectorize", "identity.logo_directions", "identity.logo_export", "identity.logo_vector_propose"].map(operation => [operation, operation === "identity.logo_vector_propose" && state.available ? { status: "available", expiresAt: new Date(now + 30000).toISOString() } : { status: "unavailable" }])) }); }
    if (path === `${base}/vector-proposals/requests/current`) {
      if (state.discoveryFailure) return json(route, {}, 503);
      const pending = [...paid.values()].map(value => value.value).filter(value => value.state.status !== "not_found" && !["succeeded", "failed", "cancelled", "partial"].includes(value.state.status));
      const cursor = target.searchParams.get("cursor"), start = cursor ? pending.findIndex(value => value.input.requestKey === cursor) + 1 : 0, items = pending.slice(start, start + 10);
      return json(route, { ownerId, projectId, items, nextCursor: start + items.length < pending.length ? items.at(-1)!.input.requestKey : null });
    }
    if (path === `${base}/vector-proposals`) return json(route, { ownerId, projectId, items: [...records.values()].map(value => ({ id: value.id, jobId: value.jobId, requestKey: value.requestKey, baseVectorRevisionId: value.baseVectorRevisionId, state: value.state, createdAt: value.createdAt })), nextCursor: null });
    if (path === `${base}/quotes`) { const request = logoVectorProposalRequestSchema.parse(body()); state.quotes.push(request); return json(route, makeQuote(request)); }

    if (path === `${base}/requests` && route.request().method() === "POST") {
      const original = logoGenerationIntentSchema.parse(body()); state.admissions.push(original); const quote = quotes.get(original.quoteId)!;
      if (cancelled.has(original.requestKey)) return json(route, {}, 409);
      if (state.refuseAdmission) return route.abort("failed");
      const receipt = { ownerId, projectId, requestKey: original.requestKey, operation: "identity.logo_vector_propose", batchId: null, jobIds: [id(sequence++)], inputHash: quote.inputHash };
      const value = logoVectorProposalRequestStateSchema.parse({ ownerId, projectId, input: original, state: { status: "admitted", requestKey: original.requestKey, receipt, outputs: [], billing: { status: "unknown", confirmedMicrousd: null }, reason: null }, proposal: null });
      paid.set(original.requestKey, { input: original, quote, value }); if (state.loseAdmissionAck) { state.loseAdmissionAck = false; return route.abort("failed"); } return json(route, receipt);
    }
    if (path.includes("/vector-proposals/requests/") && path.endsWith("/lookup")) { const original = logoGenerationIntentSchema.parse(body()); state.lookups.push(original); const request = paid.get(original.requestKey); return request ? json(route, request.value) : json(route, {}, 404); }
    if (path.includes("/vector-proposals/requests/") && path.endsWith("/cancel")) {
      const original = logoGenerationIntentSchema.parse(body()); state.closures.push(original); const request = paid.get(original.requestKey);
      if (!request) { cancelled.set(original.requestKey, original); return json(route, { status: "not_admitted", ownerId, projectId, input: original }); }
      if (request.value.state.status !== "not_found") request.value = { ...request.value, state: { ...request.value.state, status: "needs_reconciliation", reason: "cancel_requested" } };
      return json(route, { status: "admitted", request: request.value });
    }
    if (path.includes("/vector-proposals/") && path.endsWith("/apply")) {
      const proposalId = path.split("/").at(-2)!, record = records.get(proposalId)!;
      if (!record) return json(route, {}, 404);
      if (route.request().method() === "GET") return json(route, { proposal: record, preparedId: record.id, providerResponseReceiptId: record.providerReceipt!.id, materialization: materializations.get(record.id) ?? null,
        eligible: !materializations.has(record.id) && record.payload?.status === "proposed" && JSON.stringify(record.expected) === JSON.stringify(f.workspace.heads) });
      const command = applyLogoVectorProposalCommandSchema.parse({ method: "applyLogoVectorProposal", body: body() }); state.applications.push(command.body);
      let receipt = applyReceipts.get(command.body.requestKey);
      if (!receipt) {
        if (record.payload?.status !== "proposed") return json(route, {}, 409);
        const previous = f.details.get(record.baseVectorRevisionId)!, candidate = f.makeDetail(applyLogoManualEdit(previous.document, record.payload.edit), previous.revision.id); f.details.set(candidate.revision.id, candidate);
        const revision: LogoStageRevision = { version: 2, id: id(sequence++), ownerId, projectId, stage: "refinements", revision: f.workspace.heads.stageRevisions.refinements + 1,
          parentRevisionId: f.workspace.stages.refinements?.id ?? null, inputRevisions: previous.revision.inputRevisions, inputHash: hash(command.body), createdAt: new Date().toISOString(), payload: { rasterRevisionIds: [], vectorRevisionId: candidate.revision.id, approvalId: null, sourceRequestKey: command.body.requestKey } };
        f.stages.set(revision.id, revision); f.workspace = { ...f.workspace, heads: { ...f.workspace.heads, workspaceRevision: f.workspace.heads.workspaceRevision + 1, stageRevisions: { ...f.workspace.heads.stageRevisions, refinements: revision.revision } }, stages: { ...f.workspace.stages, refinements: { stage: "refinements", id: revision.id, revision: revision.revision } } };
        receipt = { ownerId, projectId, requestKey: command.body.requestKey, workspace: structuredClone(f.workspace), revision }; applyReceipts.set(command.body.requestKey, receipt);
        materializations.set(record.id, { version: 1, ownerId, projectId, proposalId: record.id, requestKey: command.body.requestKey, vectorRevisionId: candidate.revision.id, revisionId: revision.id, createdAt: revision.createdAt });
      }
      if (state.loseApplyAck) { state.loseApplyAck = false; return route.abort("failed"); } return json(route, receipt);
    }
    if (path.includes("/edits/requests/")) {
      const key = path.split("/").at(-1)!, receipt = applyReceipts.get(key);
      if (receipt) { const original = state.applications.find(value => value.requestKey === key);
        return json(route, { status: "succeeded", ownerId, projectId, requestKey: key, command: { method: "applyLogoVectorProposal", body: original }, receipt }); }
    }
    return route.fallback();
  });
  if (options.navigate !== false) await page.goto(f.url);
  return Object.assign(state, { finish, seedPending });
}
