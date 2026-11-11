import {
  logoManualCommandSchema,
  logoRasterSourceSchema,
  type LogoManualCommand,
  type LogoMutationReceipt,
  type LogoRasterSource,
} from "../../domain/logo-workspace";
import type { AccountLogoClient } from "../identity/account-logo-client";
import type { LogoDraftMemory } from "../identity/logo-draft-memory";
import { AccountRequestError } from "../workspace/account-api";
export type LogoSelectionInput = {
  client: AccountLogoClient;
  memory: LogoDraftMemory;
  projectId: string;
  isCurrent(): boolean;
  createRequestKey(): string;
  signal?: AbortSignal;
};
type Selection = Extract<LogoManualCommand, { method: "selectLogoConcept" | "selectLogoRaster" }>;
/** The exact request is absent after an acknowledged, irreversible head advance.
 * This is a resolved conflict, not permission to resend under a new body/key. */
export class LogoSelectionConflictResolvedError extends AccountRequestError {
  constructor() {
    super(409);
    this.name = "LogoSelectionConflictResolvedError";
  }
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const current = (input: LogoSelectionInput) => input.isCurrent() && !input.signal?.aborted;
const selected = (command: Selection): LogoRasterSource =>
  command.method === "selectLogoRaster"
    ? command.body.source
    : {
        kind: "concept",
        batchId: command.body.batchId,
        slotId: command.body.slotId,
        attemptId: command.body.attemptId,
      };
function apply(
  input: LogoSelectionInput,
  command: Selection,
  receipt: LogoMutationReceipt,
): LogoMutationReceipt | null {
  if (!current(input)) return null;
  const latest = input.memory.get(input.projectId);
  if (!latest?.workspace || !same(latest.pendingMutation?.command, command)) return null;
  if (
    receipt.ownerId !== latest.workspace.ownerId ||
    receipt.projectId !== input.projectId ||
    receipt.requestKey !== command.body.requestKey ||
    receipt.revision.stage !== "concepts" ||
    !same(receipt.revision.payload.selected, selected(command)) ||
    receipt.revision.revision !== command.body.expected.stageRevisions.concepts + 1
  )
    throw new AccountRequestError(502);
  input.memory.set(input.projectId, {
    ...latest,
    workspace: receipt.workspace,
    base: receipt.workspace.heads,
    pendingMutation: null,
  });
  return receipt;
}
async function send(input: LogoSelectionInput, command: Selection) {
  if (!current(input)) return null;
  const receipt =
    command.method === "selectLogoConcept"
      ? await input.client.selectLogoConcept(command.body, input.signal)
      : await input.client.selectLogoRaster(command.body, input.signal);
  return receipt ? apply(input, command, receipt) : null;
}
/** Candidate selection is a manual saved stage, never approval or generation. */
export async function selectLogoCandidate(
  input: LogoSelectionInput,
  raw: LogoRasterSource,
): Promise<LogoMutationReceipt | null> {
  if (!current(input)) return null;
  const source = logoRasterSourceSchema.parse(raw),
    draft = input.memory.get(input.projectId);
  if (!draft?.workspace || !draft.base || draft.workspace.capabilities.save.status !== "available")
    throw new AccountRequestError(503);
  if (draft.dirty || draft.vectorDraft || draft.directionDraft || draft.conflict || draft.pendingExport)
    throw new AccountRequestError(409);
  if (draft.pendingMutation) {
    const pending = draft.pendingMutation.command;
    if (
      !["selectLogoConcept", "selectLogoRaster"].includes(pending.method) ||
      !same(selected(pending as Selection), source)
    )
      throw new AccountRequestError(409);
    return recoverLogoSelection(input, false);
  }
  const common = { requestKey: input.createRequestKey(), expected: draft.base };
  const command = logoManualCommandSchema.parse(
    source.kind === "concept"
      ? {
          method: "selectLogoConcept",
          body: { ...common, batchId: source.batchId, slotId: source.slotId, attemptId: source.attemptId },
        }
      : { method: "selectLogoRaster", body: { ...common, source } },
  ) as Selection;
  input.memory.set(input.projectId, { ...draft, pendingMutation: { requestKey: command.body.requestKey, command } });
  return send(input, command);
}
export async function recoverLogoSelection(
  input: LogoSelectionInput,
  retry: boolean,
): Promise<LogoMutationReceipt | null> {
  if (!current(input)) return null;
  const draft = input.memory.get(input.projectId),
    command = draft?.pendingMutation?.command;
  if (!draft || !command || (command.method !== "selectLogoConcept" && command.method !== "selectLogoRaster"))
    return null;
  const retained = () => current(input) && input.memory.get(input.projectId) === draft;
  const request = await input.client.readLogoRequest(command.body.requestKey, input.signal);
  if (!retained() || !request) return null;
  if (request.status === "succeeded" && request.receipt && "workspace" in request.receipt)
    return apply(input, command, request.receipt);
  if (request.status !== "not_found") return null;
  const workspace = await input.client.getLogoWorkspace(input.signal);
  if (!retained() || !workspace) return null;
  if (workspace.ownerId !== draft.workspace?.ownerId || workspace.projectId !== input.projectId)
    throw new AccountRequestError(502);
  if (workspace.heads.workspaceRevision > command.body.expected.workspaceRevision) {
    // Project serialization and monotonic workspace revisions mean the original
    // expected heads can never commit after this read. It could have committed
    // between the first request read and this head read, so check the SAME key
    // again before retiring the unchanged intent. Never rebase or auto-resubmit.
    const checked = await input.client.readLogoRequest(command.body.requestKey, input.signal);
    if (!retained() || !checked) return null;
    if (checked.status === "succeeded" && checked.receipt && "workspace" in checked.receipt)
      return apply(input, command, checked.receipt);
    if (checked.status !== "not_found") return null;
    input.memory.set(input.projectId, { ...draft, pendingMutation: null });
    throw new LogoSelectionConflictResolvedError();
  }
  if (!retry) return null;
  if (
    draft.dirty ||
    draft.vectorDraft ||
    draft.directionDraft ||
    draft.conflict ||
    draft.workspace?.capabilities.save.status !== "available"
  )
    throw new AccountRequestError(409);
  // Only the explicit replay action uses the exact retained body/key.
  return send(input, command);
}
