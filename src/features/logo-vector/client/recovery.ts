import { logoManualCommandSchema, type LogoManualCommand, type LogoMutationReceipt } from "../../../domain/logo-workspace";
import { freezeLogoRecord } from "../../../domain/logo-vector";
import { isAccountLogoClientCurrent, type AccountLogoClient } from "../../../components/identity/account-logo-client";
import type { LogoDraftMemory } from "../../../components/identity/logo-draft-memory";
import type { VerifiedAccount } from "../../../components/workspace/account-session";
import { AccountRequestError } from "../../../components/workspace/account-api";

export type LogoVectorRecoveryIntent =
  | { kind: "edit"; request: Parameters<AccountLogoClient["saveLogoEdit"]>[0] }
  | { kind: "accept"; request: Parameters<AccountLogoClient["acceptLogoVector"]>[0] }
  | { kind: "restore"; request: Parameters<AccountLogoClient["restoreLogoStage"]>[0] };
type Command = Extract<LogoManualCommand, { method: "saveLogoEdit" | "acceptLogoVector" | "restoreLogoStage" }>;
export type LogoVectorMutationContext = { account: VerifiedAccount; client: AccountLogoClient; memory: LogoDraftMemory; projectId: string; isCurrent(): boolean; signal?: AbortSignal };
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const current = (input: LogoVectorMutationContext): boolean => input.isCurrent() && !input.signal?.aborted && isAccountLogoClientCurrent(input.client, input.account, input.projectId);
function commandFor(input: LogoVectorRecoveryIntent): Command {
  const method = input.kind === "edit" ? "saveLogoEdit" : input.kind === "accept" ? "acceptLogoVector" : "restoreLogoStage";
  const command = logoManualCommandSchema.parse({ method, body: input.request }) as Command;
  if (command.method === "restoreLogoStage" && !["vector", "refinements"].includes(command.body.stage)) throw new AccountRequestError(422);
  return command;
}
export function createVectorRecoveryIntent(input: LogoVectorRecoveryIntent): Readonly<LogoVectorRecoveryIntent> {
  const command = commandFor(input);
  return freezeLogoRecord(command.method === "saveLogoEdit" ? { kind: "edit", request: command.body } : command.method === "acceptLogoVector" ? { kind: "accept", request: command.body } : { kind: "restore", request: command.body });
}
async function apply(input: LogoVectorMutationContext, command: Command, receipt: LogoMutationReceipt): Promise<LogoMutationReceipt | null> {
  if (!current(input)) return null;
  const retained = input.memory.get(input.projectId);
  if (!retained?.workspace || !same(retained.pendingMutation?.command, command)) return null;
  const stage = command.method === "saveLogoEdit" ? "refinements" : command.method === "acceptLogoVector" ? "vector" : command.body.stage;
  if (receipt.ownerId !== input.account.userId || receipt.projectId !== input.projectId || receipt.requestKey !== command.body.requestKey || receipt.revision.stage !== stage ||
    receipt.revision.revision !== command.body.expected.stageRevisions[stage] + 1 || receipt.workspace.heads.workspaceRevision !== command.body.expected.workspaceRevision + 1 ||
    command.method === "acceptLogoVector" && receipt.workspace.approvedLogo?.vectorRevisionId !== command.body.vectorRevisionId ||
    command.method === "saveLogoEdit" && (receipt.revision.stage !== "refinements" || receipt.revision.payload.vectorRevisionId === null || receipt.revision.payload.sourceRequestKey !== command.body.requestKey)) throw new AccountRequestError(502);
  // An exact replay can return a historical receipt. Read current heads before
  // adopting it so recovery never visually selects an old result over newer work.
  const workspace = await input.client.getLogoWorkspace(input.signal);
  if (!workspace || !current(input) || !same(input.memory.get(input.projectId)?.pendingMutation?.command, command)) return null;
  if (workspace.ownerId !== input.account.userId || workspace.projectId !== input.projectId || workspace.heads.workspaceRevision < receipt.workspace.heads.workspaceRevision) throw new AccountRequestError(502);
  const latest = input.memory.get(input.projectId)!;
  const clearDraft = command.method === "saveLogoEdit" && latest.vectorDraft?.baseVectorRevisionId === command.body.baseVectorRevisionId && same(latest.vectorDraft.edit, command.body.edit);
  input.memory.set(input.projectId, { ...latest, workspace, base: workspace.heads, pendingMutation: null, conflict: false, vectorDraft: clearDraft ? null : latest.vectorDraft });
  return receipt;
}
async function send(input: LogoVectorMutationContext, command: Command): Promise<LogoMutationReceipt | null> {
  if (!current(input)) return null;
  try {
    const receipt = command.method === "saveLogoEdit" ? await input.client.saveLogoEdit(command.body, input.signal)
      : command.method === "acceptLogoVector" ? await input.client.acceptLogoVector(command.body, input.signal) : await input.client.restoreLogoStage(command.body, input.signal);
    return receipt ? apply(input, command, receipt) : null;
  } catch (error) {
    const retained = current(input) ? input.memory.get(input.projectId) : null;
    if (retained && same(retained.pendingMutation?.command, command) && error instanceof AccountRequestError && error.status === 409) input.memory.set(input.projectId, { ...retained, conflict: true });
    throw error;
  }
}
/** Explicit manual action only; the original body/key is retained before POST. */
export async function submitVectorIntent(input: LogoVectorMutationContext, raw: LogoVectorRecoveryIntent): Promise<LogoMutationReceipt | null> {
  if (!current(input)) return null;
  const command = commandFor(raw), draft = input.memory.get(input.projectId);
  if (!draft?.workspace || !draft.base || draft.workspace.capabilities.save.status !== "available") throw new AccountRequestError(503);
  if (draft.pendingMutation) {
    if (!same(draft.pendingMutation.command, command)) throw new AccountRequestError(409);
    return recoverVectorMutation(input, false);
  }
  if (!same(command.body.expected, draft.base) || draft.dirty || draft.directionDraft || draft.conflict || draft.pendingIntent || draft.pendingExport || command.method !== "saveLogoEdit" && draft.vectorDraft) throw new AccountRequestError(409);
  input.memory.set(input.projectId, { ...draft, pendingMutation: { requestKey: command.body.requestKey, command } });
  return send(input, command);
}
/** A read never retries. Only the explicit unchanged-request action may POST. */
export async function recoverVectorMutation(input: LogoVectorMutationContext, retry: boolean): Promise<LogoMutationReceipt | null> {
  if (!current(input)) return null;
  const draft = input.memory.get(input.projectId), raw = draft?.pendingMutation?.command;
  if (!draft || !raw || !["saveLogoEdit", "acceptLogoVector", "restoreLogoStage"].includes(raw.method)) return null;
  const command = raw as Command;
  const state = await input.client.readLogoRequest(command.body.requestKey, input.signal);
  if (!state || !current(input) || !same(input.memory.get(input.projectId)?.pendingMutation?.command, command)) return null;
  if (state.status === "succeeded" && state.receipt && "workspace" in state.receipt) return apply(input, command, state.receipt);
  if (state.status !== "not_found" || !retry) return null;
  if (draft.conflict || draft.workspace?.capabilities.save.status !== "available") throw new AccountRequestError(409);
  return send(input, command);
}
