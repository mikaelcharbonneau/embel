import { logoManualCommandSchema, logoRasterSourceSchema, type LogoManualCommand, type LogoMutationReceipt, type LogoRasterSource } from "../../domain/logo-workspace";
import type { AccountLogoClient } from "../identity/account-logo-client";
import type { LogoDraftMemory } from "../identity/logo-draft-memory";
import { AccountRequestError } from "../workspace/account-api";
export type LogoSelectionInput = { client: AccountLogoClient; memory: LogoDraftMemory; projectId: string; isCurrent(): boolean; createRequestKey(): string; signal?: AbortSignal };
type Selection = Extract<LogoManualCommand, { method: "selectLogoConcept" | "selectLogoRaster" }>;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const current = (input: LogoSelectionInput) => input.isCurrent() && !input.signal?.aborted;
const selected = (command: Selection): LogoRasterSource => command.method === "selectLogoRaster" ? command.body.source : { kind: "concept", batchId: command.body.batchId, slotId: command.body.slotId, attemptId: command.body.attemptId };
function apply(input: LogoSelectionInput, command: Selection, receipt: LogoMutationReceipt): LogoMutationReceipt | null {
  if (!current(input)) return null;
  const latest = input.memory.get(input.projectId);
  if (!latest?.workspace || !same(latest.pendingMutation?.command, command)) return null;
  if (receipt.ownerId !== latest.workspace.ownerId || receipt.projectId !== input.projectId || receipt.requestKey !== command.body.requestKey || receipt.revision.stage !== "concepts"
    || !same(receipt.revision.payload.selected, selected(command)) || receipt.revision.revision !== command.body.expected.stageRevisions.concepts + 1) throw new AccountRequestError(502);
  input.memory.set(input.projectId, { ...latest, workspace: receipt.workspace, base: receipt.workspace.heads, pendingMutation: null });
  return receipt;
}
async function send(input: LogoSelectionInput, command: Selection) {
  if (!current(input)) return null;
  const receipt = command.method === "selectLogoConcept" ? await input.client.selectLogoConcept(command.body, input.signal) : await input.client.selectLogoRaster(command.body, input.signal);
  return receipt ? apply(input, command, receipt) : null;
}
/** Candidate selection is a manual saved stage, never approval or generation. */
export async function selectLogoCandidate(input: LogoSelectionInput, raw: LogoRasterSource): Promise<LogoMutationReceipt | null> {
  if (!current(input)) return null;
  const source = logoRasterSourceSchema.parse(raw), draft = input.memory.get(input.projectId);
  if (!draft?.workspace || !draft.base || draft.workspace.capabilities.save.status !== "available") throw new AccountRequestError(503);
  if (draft.dirty || draft.conflict || draft.pendingIntent || draft.pendingExport) throw new AccountRequestError(409);
  if (draft.pendingMutation) {
    const pending = draft.pendingMutation.command;
    if (!["selectLogoConcept", "selectLogoRaster"].includes(pending.method) || !same(selected(pending as Selection), source)) throw new AccountRequestError(409);
    return recoverLogoSelection(input, false);
  }
  const common = { requestKey: input.createRequestKey(), expected: draft.base };
  const command = logoManualCommandSchema.parse(source.kind === "concept" ? { method: "selectLogoConcept", body: { ...common, batchId: source.batchId, slotId: source.slotId, attemptId: source.attemptId } }
    : { method: "selectLogoRaster", body: { ...common, source } }) as Selection;
  input.memory.set(input.projectId, { ...draft, pendingMutation: { requestKey: command.body.requestKey, command } });
  return send(input, command);
}
export async function recoverLogoSelection(input: LogoSelectionInput, retry: boolean): Promise<LogoMutationReceipt | null> {
  if (!current(input)) return null;
  const draft = input.memory.get(input.projectId), command = draft?.pendingMutation?.command;
  if (!draft || !command || command.method !== "selectLogoConcept" && command.method !== "selectLogoRaster") return null;
  const request = await input.client.readLogoRequest(command.body.requestKey, input.signal);
  if (!current(input) || !same(input.memory.get(input.projectId)?.pendingMutation?.command, command) || !request) return null;
  if (request.status === "succeeded" && request.receipt && "workspace" in request.receipt) return apply(input, command, request.receipt);
  if (request.status !== "not_found" || !retry) return null;
  if (draft.conflict || draft.workspace?.capabilities.save.status !== "available") throw new AccountRequestError(409);
  // Only the explicit replay action uses the exact retained body/key.
  return send(input, command);
}
