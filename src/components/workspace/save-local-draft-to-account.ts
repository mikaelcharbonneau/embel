import { accountProjectResponseSchema, accountSessionSchema, type AccountProject } from "@/domain/project-api";
import type { createProjectInputSchema } from "@/domain/projects";
import type { z } from "zod";
import { AccountRequestError } from "./account-api";
import { boundedAccountRequest } from "./bounded-account-request";
import { forgetReceipt, readDraftFence, readReceipt, rememberReceipt, StartReceiptRecoveryError, withProjectStartLock, type StartReceipt } from "./account-project-start-recovery";
import type { VerifiedAccount } from "./account-session";
import { getLocalDraft, updateLocalDraft, type LocalDraft } from "./local-drafts";
import { createAccountInput } from "./project-draft-adapter";

type Input = z.infer<typeof createProjectInputSchema>;
type SaveOptions = {
  account: VerifiedAccount; draft: LocalDraft; signal: AbortSignal;
  isCurrent: (account: VerifiedAccount) => boolean; expire: (account: VerifiedAccount) => void;
  input?: Input; onReceipt?: (receipt: StartReceipt | null) => void;
  sessionVerified?: boolean;
};

type AccountSave = { receipt: StartReceipt; project: AccountProject | null; newProject: boolean };

/** Manual persistence only: this function never admits an AI job. */
export function saveLocalDraftToAccount(options: SaveOptions): Promise<AccountSave | null> {
  return withProjectStartLock(options.account.userId, options.draft.id, options.signal, () => saveUnderLock(options));
}

async function saveUnderLock({ account, draft, signal, isCurrent, expire, input, onReceipt, sessionVerified = false }: SaveOptions): Promise<AccountSave | null> {
  const current = () => !signal.aborted && isCurrent(account);
  if (!current()) return null;
  if (draft.ownerId && draft.ownerId !== account.userId) throw new StartReceiptRecoveryError("Verify the account that owns this unsaved project before recovering it.");
  if (!sessionVerified) {
    const { user } = await boundedAccountRequest("/api/session", accountSessionSchema, { signal });
    if (!current()) return null;
    if (user.id !== account.userId) { expire(account); return null; }
  }
  let receipt = readReceipt(account.userId, draft.id);
  const firstRequest = receipt === null;
  if (receipt?.projectId) { onReceipt?.(receipt); return { receipt, project: null, newProject: false }; }
  if (receipt && !receipt.request) throw new StartReceiptRecoveryError("The earlier account save is not confirmed. Check your projects before recovering this older request.");
  if (!receipt && readDraftFence(draft.id)) throw new StartReceiptRecoveryError("This project has an earlier save in another account. Verify that account before continuing.");
  if (!receipt) {
    // The stable source UUID also fences concurrent tabs and confirmed receipts
    // retired after their source is gone. The server scopes this key by owner.
    receipt = { ownerId: account.userId, draftId: draft.id, projectId: null, request: { key: draft.id, input: structuredClone(input ?? createAccountInput(draft)) } };
  }
  rememberReceipt(receipt, true);
  onReceipt?.(receipt);
  const request = receipt.request!;
  let project: AccountProject;
  try {
    ({ project } = await boundedAccountRequest("/api/projects", accountProjectResponseSchema, { method: "POST", body: { ...request.input, requestKey: request.key }, expectedOwnerId: account.userId, signal }));
  } catch (cause) {
    if (cause instanceof AccountRequestError && [400, 401, 403, 413, 422, 429].includes(cause.status)) { forgetReceipt(receipt); onReceipt?.(null); }
    throw cause;
  }
  if (!current()) return null;
  if (project.owner_id !== account.userId) { expire(account); return null; }
  // Exact replay may return a later saved head; never restore its first revision.
  if (project.current_revision === 1 && (project.scope !== request.input.scope || project.title !== request.input.title || JSON.stringify(project.context) !== JSON.stringify(request.input.context))) throw new AccountRequestError(502);
  receipt = { ...receipt, projectId: project.id }; rememberReceipt(receipt); onReceipt?.(receipt);
  return { receipt, project, newProject: firstRequest && project.current_revision === 1 };
}

/** Call after consuming the receipt: marking may unmount a recovery picker. */
export function finishLocalDraftRecovery(draftId: string, ownerId: string, projectId: string) {
  const retained = getLocalDraft(draftId);
  if (retained && (!retained.ownerId || retained.ownerId === ownerId)) updateLocalDraft(draftId, { ownerId, accountProjectId: projectId });
}
