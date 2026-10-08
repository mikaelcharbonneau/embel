import type { AccountLogoClient } from "@/components/identity/account-logo-client";
import type { LogoDraftMemory, LogoDraftRecord } from "@/components/identity/logo-draft-memory";
import { AccountRequestError } from "@/components/workspace/account-api";
import { selectIdentityDirectionComponentsInputSchema, approveIdentityDirectionInputSchema, logoMutationReceiptSchema, logoWorkspaceV2Schema, type LogoManualCommand, type LogoMutationReceipt, type LogoExpectedHeads } from "@/domain/logo-workspace";
import { identityDirectionsOverviewSchema, type IdentityDirectionsOverview } from "@/domain/logo-directions";
import { logoRequestStateSchema } from "@/domain/logo-jobs";
import { canonicalIdentityInput } from "../model/font-check-binding";
import type { DirectionMixPreview } from "../model/mix";
export type DirectionCommand = Extract<LogoManualCommand, { method: "selectIdentityDirectionComponents" | "approveIdentityDirection" }>;
const same = (a: unknown, b: unknown) => canonicalIdentityInput(a) === canonicalIdentityInput(b);
function writable(record: LogoDraftRecord) {
  if (!record.workspace || !record.base || record.workspace.capabilities.save.status !== "available") throw new AccountRequestError(503);
  if (record.dirty || record.conflict || record.pendingIntent || record.pendingExport || record.pendingMutation) throw new AccountRequestError(409);
}
export function buildDirectionSelectionCommand(record: LogoDraftRecord, preview: DirectionMixPreview, requestKey: string): Extract<DirectionCommand, { method: "selectIdentityDirectionComponents" }> {
  writable(record);
  const retained = record.directionDraft;
  if (retained && (retained.approvedLogoId !== preview.approvedLogoId || retained.paletteVersionId !== preview.components.paletteVersionId || retained.typographyVersionId !== preview.components.typographyVersionId || retained.graphicsVersionId !== preview.components.graphicsVersionId)) throw new AccountRequestError(409);
  if (record.workspace!.approvedLogo?.id !== preview.approvedLogoId || preview.consistency.status === "blocked" || record.workspace!.staleStages.some(s => s.stage === "directions")) throw new AccountRequestError(409);
  return { method: "selectIdentityDirectionComponents", body: selectIdentityDirectionComponentsInputSchema.parse({ requestKey, expected: record.base, approvedLogoId: preview.approvedLogoId, ...preview.components }) };
}
export function buildDirectionApprovalCommand(record: LogoDraftRecord, overview: IdentityDirectionsOverview, requestKey: string): Extract<DirectionCommand, { method: "approveIdentityDirection" }> {
  writable(record); const selection = overview.selection;
  if (!selection || overview.stale || selection.approvedLogoId !== record.workspace!.approvedLogo?.id || selection.consistency.status === "blocked" || record.workspace!.staleStages.some(s => s.stage === "directions")) throw new AccountRequestError(409);
  const draft = record.directionDraft;
  if (draft && (draft.approvedLogoId !== selection.approvedLogoId || draft.paletteVersionId !== selection.paletteVersionId || draft.typographyVersionId !== selection.typographyVersionId || draft.graphicsVersionId !== selection.graphicsVersionId)) throw new AccountRequestError(409);
  if (selection.consistency.status === "warning" && draft?.reviewedConsistencyHash !== selection.consistency.hash) throw new AccountRequestError(409);
  return { method: "approveIdentityDirection", body: approveIdentityDirectionInputSchema.parse({ requestKey, expected: record.base, directionSelectionId: selection.id, consistencyHash: selection.consistency.hash }) };
}
export type DirectionActionContext = { memory: LogoDraftMemory; client: AccountLogoClient; projectId: string; current(): boolean; signal: AbortSignal };
function current(c: DirectionActionContext): boolean { return !c.signal.aborted && c.current(); }
// One in-flight manual operation per shared project buffer, including repeated
// clicks from another mounted view. No request body or account data is cached here.
const operations = new WeakMap<LogoDraftMemory, Map<string, object>>();
async function exclusive(c: DirectionActionContext, work: () => Promise<IdentityDirectionsOverview | null>) {
  if (!current(c)) return null;
  const projects = operations.get(c.memory) ?? new Map<string, object>();
  if (projects.has(c.projectId)) return null;
  const token = {};
  const release = () => { if (projects.get(c.projectId) === token) projects.delete(c.projectId); };
  operations.set(c.memory, projects); projects.set(c.projectId, token);
  // An aborted transport may ignore cancellation. It must not lock out a new
  // mounted session; its late result is still fenced by its original context.
  c.signal.addEventListener("abort", release, { once: true });
  try { return await work(); } finally { c.signal.removeEventListener("abort", release); release(); }
}
function retained(c: DirectionActionContext, original: LogoDraftRecord): LogoDraftRecord | null {
  if (!current(c)) return null;
  const latest = c.memory.get(c.projectId);
  return latest?.workspace && latest.workspace.ownerId === original.workspace?.ownerId && latest.workspace.projectId === c.projectId
    && same(latest.base, original.base) && same(latest.pendingMutation, original.pendingMutation) ? latest : null;
}
function directionCommand(record: LogoDraftRecord): DirectionCommand | null {
  const pending = record.pendingMutation, command = pending?.command;
  if (!command || (command.method !== "selectIdentityDirectionComponents" && command.method !== "approveIdentityDirection")) return null;
  if (!record.workspace || pending!.requestKey !== command.body.requestKey || !same(command.body.expected, record.base)) throw new AccountRequestError(409);
  return command;
}
function advances(latest: LogoExpectedHeads, earlier: LogoExpectedHeads): boolean {
  return latest.workspaceRevision >= earlier.workspaceRevision && latest.projectRevision >= earlier.projectRevision
    && latest.referenceRevision >= earlier.referenceRevision && latest.preferencesRevision >= earlier.preferencesRevision
    && Object.keys(earlier.stageRevisions).every(stage => latest.stageRevisions[stage as keyof typeof earlier.stageRevisions] >= earlier.stageRevisions[stage as keyof typeof earlier.stageRevisions]);
}
async function accept(c: DirectionActionContext, raw: LogoMutationReceipt, original: LogoDraftRecord): Promise<IdentityDirectionsOverview | null> {
  if (!retained(c, original)) return null;
  const command = directionCommand(original), parsed = logoMutationReceiptSchema.safeParse(raw);
  if (!command || !parsed.success) throw new AccountRequestError(502);
  const receipt = parsed.data, revision = receipt.revision;
  const expectedResult = { ...command.body.expected, workspaceRevision: command.body.expected.workspaceRevision + 1,
    stageRevisions: { ...command.body.expected.stageRevisions, directions: command.body.expected.stageRevisions.directions + 1 } };
  if (receipt.requestKey !== command.body.requestKey || receipt.ownerId !== original.workspace!.ownerId || receipt.projectId !== c.projectId
    || revision.stage !== "directions" || revision.parentRevisionId !== (original.workspace!.stages.directions?.id ?? null)
    || !same(receipt.workspace.heads, expectedResult) || !same(receipt.workspace.approvedLogo, original.workspace!.approvedLogo)
    || !revision.payload.selectionId || (command.method === "selectIdentityDirectionComponents" ? revision.payload.approvalId !== null
      || receipt.workspace.approvedLogo?.id !== command.body.approvedLogoId : revision.payload.selectionId !== command.body.directionSelectionId || !revision.payload.approvalId)) throw new AccountRequestError(502);
  // The durable request receipt binds the immutable original transaction. Its
  // stage remains readable even after a newer selection becomes current.
  const savedRevision = await c.client.getLogoStageRevision("directions", revision.id, c.signal);
  if (!savedRevision || !retained(c, original)) return null;
  if (!same(savedRevision, revision)) throw new AccountRequestError(502);
  const [rawWorkspace, rawOverview] = await Promise.all([c.client.getLogoWorkspace(c.signal), c.client.getIdentityDirections({ limit: 50 }, c.signal)]);
  if (!rawWorkspace || !rawOverview || !retained(c, original)) return null;
  const workspaceResult = logoWorkspaceV2Schema.safeParse(rawWorkspace), overviewResult = identityDirectionsOverviewSchema.safeParse(rawOverview);
  if (!workspaceResult.success || !overviewResult.success) throw new AccountRequestError(502);
  const workspace = workspaceResult.data, overview = overviewResult.data, head = workspace.stages.directions;
  if (workspace.ownerId !== receipt.ownerId || workspace.projectId !== c.projectId || overview.ownerId !== receipt.ownerId || overview.projectId !== c.projectId
    || !advances(workspace.heads, receipt.workspace.heads) || !same(overview.currentApprovedLogo, workspace.approvedLogo) || !head) throw new AccountRequestError(409);
  const currentRevision = head.id === revision.id ? savedRevision : await c.client.getLogoStageRevision("directions", head.id, c.signal);
  if (!currentRevision || !retained(c, original)) return null;
  if (currentRevision.stage !== "directions" || currentRevision.ownerId !== receipt.ownerId || currentRevision.projectId !== c.projectId
    || currentRevision.id !== head.id || currentRevision.revision !== head.revision
    || (head.revision === revision.revision && head.id !== revision.id)
    || (overview.selection?.id ?? null) !== currentRevision.payload.selectionId || (overview.approval?.id ?? null) !== currentRevision.payload.approvalId) throw new AccountRequestError(409);
  const selection = overview.selection;
  // Check command details when its selection is still current. A later current
  // selection is not evidence that the original immutable request failed.
  if (selection?.id === revision.payload.selectionId && (command.method === "selectIdentityDirectionComponents"
    ? selection.approvedLogoId !== command.body.approvedLogoId || selection.paletteVersionId !== command.body.paletteVersionId || selection.typographyVersionId !== command.body.typographyVersionId || selection.graphicsVersionId !== command.body.graphicsVersionId
    : selection.consistency.hash !== command.body.consistencyHash || (currentRevision.id === revision.id && overview.approval?.id !== revision.payload.approvalId))) throw new AccountRequestError(502);
  const latest = retained(c, original); if (!latest) return null;
  const draft = latest.directionDraft;
  const savedDraft = draft && same(draft, original.directionDraft) && (command.method === "selectIdentityDirectionComponents"
    ? draft.approvedLogoId === command.body.approvedLogoId && draft.paletteVersionId === command.body.paletteVersionId && draft.typographyVersionId === command.body.typographyVersionId && draft.graphicsVersionId === command.body.graphicsVersionId
    : selection?.id === command.body.directionSelectionId && draft.approvedLogoId === selection.approvedLogoId && draft.paletteVersionId === selection.paletteVersionId && draft.typographyVersionId === selection.typographyVersionId && draft.graphicsVersionId === selection.graphicsVersionId && draft.reviewedConsistencyHash === command.body.consistencyHash);
  // Other retained commands still own their expected heads. Resolve this one
  // without rebasing those commands or losing their recovery state.
  const otherPending = !!(latest.pendingIntent || latest.pendingExport);
  const upstreamChanged = !same({ ...workspace.heads, workspaceRevision: 0, stageRevisions: { ...workspace.heads.stageRevisions, directions: 0, deliverables: 0 } },
    { ...receipt.workspace.heads, workspaceRevision: 0, stageRevisions: { ...receipt.workspace.heads.stageRevisions, directions: 0, deliverables: 0 } });
  c.memory.set(c.projectId, { ...latest, workspace: otherPending ? latest.workspace : workspace, base: otherPending ? latest.base : workspace.heads,
    pendingMutation: null, directionDraft: savedDraft ? null : latest.directionDraft,
    conflict: latest.conflict || latest.dirty || !!latest.vectorDraft || otherPending || upstreamChanged });
  return otherPending ? null : overview;
}
async function send(c: DirectionActionContext, original: LogoDraftRecord): Promise<IdentityDirectionsOverview | null> {
  if (!retained(c, original)) return null;
  const command = directionCommand(original); if (!command) return null;
  const receipt = command.method === "selectIdentityDirectionComponents" ? await c.client.selectIdentityDirectionComponents(command.body, c.signal) : await c.client.approveIdentityDirection(command.body, c.signal);
  return receipt && retained(c, original) ? accept(c, receipt, original) : null;
}
export async function dispatchDirectionCommand(c: DirectionActionContext, command: DirectionCommand): Promise<IdentityDirectionsOverview | null> {
  return exclusive(c, async () => {
    const record = c.memory.get(c.projectId); if (!record) return null; writable(record);
    if (record.workspace!.projectId !== c.projectId || !same(command.body.expected, record.base)) throw new AccountRequestError(409);
    c.memory.set(c.projectId, { ...record, pendingMutation: { requestKey: command.body.requestKey, command } });
    return send(c, c.memory.get(c.projectId)!);
  });
}
async function recover(c: DirectionActionContext, replay: boolean): Promise<IdentityDirectionsOverview | null> {
  return exclusive(c, async () => {
    const original = c.memory.get(c.projectId); if (!original || original.workspace?.projectId !== c.projectId) return null;
    const command = directionCommand(original); if (!command) return null;
    const raw = await c.client.readLogoRequest(command.body.requestKey, c.signal);
    if (!raw || !retained(c, original)) return null;
    const parsed = logoRequestStateSchema.safeParse(raw); if (!parsed.success) throw new AccountRequestError(502);
    const state = parsed.data;
    if (state.status === "not_found") {
      // Absence is only a point-in-time observation. The first POST may still
      // arrive: the server's serialized exact-key/body deduplication makes this
      // explicit replay safe. Never rebuild a command or refresh expected heads.
      return replay ? send(c, original) : null;
    }
    if (state.requestKey !== command.body.requestKey) throw new AccountRequestError(502);
    if (state.status !== "succeeded" || !state.receipt || !("workspace" in state.receipt)) return null;
    if (state.outputs.length || state.billing.status !== "recorded" || state.billing.confirmedMicrousd !== 0 || state.reason !== null || state.rejection) throw new AccountRequestError(502);
    return accept(c, state.receipt, original);
  });
}
/** Reads only. Unknown acknowledgement never creates a new mutation or request key. */
export function reconcileDirectionCommand(c: DirectionActionContext): Promise<IdentityDirectionsOverview | null> { return recover(c, false); }
/** Explicit user action: read first, then replay only the exact retained command. */
export function replayDirectionCommand(c: DirectionActionContext): Promise<IdentityDirectionsOverview | null> { return recover(c, true); }
