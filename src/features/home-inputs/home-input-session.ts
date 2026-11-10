import type { VerifiedAccount } from "@/components/workspace/account-session";
import type { LocalDraft } from "@/components/workspace/local-drafts";
import { createAccountInput } from "@/components/workspace/project-draft-adapter";
import type { AccountLifecycleClient } from "@/components/workspace/account-lifecycle-client";
import { AccountRequestError } from "@/components/workspace/account-api";
import {
  attachedProjectDraftInputSchema,
  attachedProjectDraftReceiptSchema,
  ownedAttachmentRefSchema,
  stageHomeAttachmentInputSchema,
  type AttachedProjectDraftInput,
  type AttachedProjectDraftReceipt,
  type OwnedAttachmentRef,
  type StageHomeAttachmentInput,
} from "@/domain/attachments";
import { freezeLogoRecord } from "@/domain/logo-vector";
export type HomeInputIntent = {
  browserDraftId: string | null;
  files: {
    localId: string;
    file: File;
    upload: StageHomeAttachmentInput;
    receipt: OwnedAttachmentRef | null;
    outcome: "local" | "pending" | "verified" | "uncertain" | "failed";
  }[];
  saveIntent: AttachedProjectDraftInput | null;
  saveOutcome: "not_started" | "pending" | "uncertain" | "confirmed";
  receipt: AttachedProjectDraftReceipt | null;
};
export const emptyHomeInputIntent = (): HomeInputIntent => ({
  browserDraftId: null,
  files: [],
  saveIntent: null,
  saveOutcome: "not_started",
  receipt: null,
});
function verifyFile(account: VerifiedAccount, file: HomeInputIntent["files"][number]) {
  const ref = file.receipt;
  stageHomeAttachmentInputSchema.parse(file.upload);
  if (
    file.file.name !== file.upload.name ||
    file.file.type !== file.upload.mimeType ||
    file.file.size > 10_485_760 ||
    file.file.size < 1
  )
    throw new Error("Invalid pending file");
  if (ref) {
    ownedAttachmentRefSchema.parse(ref);
    if (
      ref.ownerId !== account.userId.toLowerCase() ||
      ref.contentHash !== file.upload.contentHash ||
      ref.name !== file.file.name ||
      ref.mimeType !== file.file.type ||
      ref.byteLength !== file.file.size ||
      ref.state !== "staged"
    )
      throw new Error("Invalid attachment receipt");
  }
  if ((file.outcome === "verified") !== (ref !== null)) throw new Error("Unverified attachment state");
}
export type HomePendingSelection = { id: string; fileCount: number; status: "reading" | "interrupted" };
export function createHomeInputSession() {
  let owner: string | null = null,
    verified: VerifiedAccount | null = null,
    intent: HomeInputIntent | null = null,
    lease: symbol | null = null,
    selectionLease: symbol | null = null,
    selection: HomePendingSelection | null = null;
  const listeners = new Set<() => void>(),
    publish = () => listeners.forEach((listener) => listener());
  const isCurrent = (account: VerifiedAccount) =>
    verified?.userId === account.userId && verified.generation === account.generation;
  return {
    bind(account: VerifiedAccount | null) {
      if (!account || verified?.userId !== account.userId || verified.generation !== account.generation) {
        lease = null;
        selectionLease = null;
        // A session fence invalidates the reader, not the user's pending file choice.
        if (selection) selection = Object.freeze({ ...selection, status: "interrupted" });
      }
      if (account && owner !== null && account.userId !== owner) {
        intent = null;
        selection = null;
      }
      if (account) owner = account.userId;
      verified = account ? { ...account } : null;
      publish();
    },
    isCurrent,
    get(account: VerifiedAccount) {
      return isCurrent(account) ? intent : null;
    },
    set(account: VerifiedAccount, next: HomeInputIntent) {
      if (!isCurrent(account)) return false;
      if (
        next.files.length > 5 ||
        next.files.reduce((n, f) => n + f.file.size, 0) > 26_214_400 ||
        new Set(next.files.map((f) => f.localId)).size !== next.files.length
      )
        return false;
      next.files.forEach((file) => verifyFile(account, file));
      if (next.saveIntent) attachedProjectDraftInputSchema.parse(next.saveIntent);
      if (
        intent?.saveOutcome !== "confirmed" &&
        intent?.saveIntent &&
        next.saveIntent &&
        JSON.stringify(intent.saveIntent.project) !== JSON.stringify(next.saveIntent.project)
      )
        return false;
      if (
        intent?.saveOutcome !== "confirmed" &&
        intent?.saveOutcome !== "not_started" &&
        intent?.saveIntent &&
        JSON.stringify(intent.saveIntent) !== JSON.stringify(next.saveIntent)
      )
        return false;
      if (next.receipt) {
        const receipt = attachedProjectDraftReceiptSchema.parse(next.receipt),
          input = next.saveIntent;
        if (
          !input ||
          receipt.ownerId !== account.userId.toLowerCase() ||
          receipt.requestKey !== input.requestKey ||
          receipt.project.current_revision !== 1 ||
          receipt.project.title !== input.project.title ||
          receipt.project.scope !== input.project.scope ||
          JSON.stringify(receipt.project.context) !== JSON.stringify(input.project.context) ||
          receipt.attachments.length !== input.attachmentIds.length ||
          receipt.attachments.some((ref) => !input.attachmentIds.includes(ref.id))
        )
          return false;
      }
      if ((next.saveOutcome === "confirmed") !== (next.receipt !== null)) return false;
      // File bytes stay in memory and out of JSON/structuredClone/browser storage.
      intent = Object.freeze({
        ...next,
        files: Object.freeze(
          next.files.map((file) =>
            Object.freeze({
              ...file,
              upload: freezeLogoRecord(structuredClone(file.upload)),
              receipt: file.receipt ? freezeLogoRecord(structuredClone(file.receipt)) : null,
            }),
          ),
        ) as unknown as HomeInputIntent["files"],
        saveIntent: next.saveIntent ? freezeLogoRecord(structuredClone(next.saveIntent)) : null,
        receipt: next.receipt ? freezeLogoRecord(structuredClone(next.receipt)) : null,
      });
      publish();
      return true;
    },
    isSelecting: () => selection !== null,
    getSelection(account: VerifiedAccount): HomePendingSelection | null {
      return isCurrent(account) ? selection : null;
    },
    beginSelection(account: VerifiedAccount, fileCount: number) {
      if (!isCurrent(account) || lease || selection || !Number.isInteger(fileCount) || fileCount < 1 || fileCount > 5)
        return null;
      const token = Symbol(),
        id = crypto.randomUUID();
      selectionLease = token;
      selection = Object.freeze({ id, fileCount, status: "reading" });
      publish();
      const current = () =>
        isCurrent(account) && selectionLease === token && selection?.id === id && selection.status === "reading";
      return {
        current,
        complete() {
          if (current()) {
            selection = null;
            selectionLease = null;
            publish();
          }
        },
        interrupt() {
          if (selection?.id === id && selectionLease === token) {
            selection = Object.freeze({ ...selection, status: "interrupted" });
            selectionLease = null;
            publish();
          }
        },
      };
    },
    cancelSelection(account: VerifiedAccount, selectionId: string) {
      if (!isCurrent(account) || selection?.id !== selectionId) return false;
      // Invalidate the exact reader token before allowing another choice or Send.
      selection = null;
      selectionLease = null;
      publish();
      return true;
    },
    acquire(account: VerifiedAccount) {
      if (!isCurrent(account) || lease || selection) return null;
      const token = Symbol();
      lease = token;
      return () => {
        if (lease === token) lease = null;
      };
    },
    hasUnsaved: () =>
      selection !== null ||
      (!!intent && (intent.files.length > 0 || !!intent.saveIntent) && intent.saveOutcome !== "confirmed"),
    clear() {
      intent = null;
      owner = null;
      verified = null;
      lease = null;
      selectionLease = null;
      selection = null;
      publish();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
export type HomeInputSession = ReturnType<typeof createHomeInputSession>;
/** Explicit user Send only: stages inputs, then commits one exact-key project, never Strategy/AI. */
export async function saveAttachedHomeDraft({
  account,
  draft,
  memory,
  client,
  signal,
  beforeSave,
}: {
  account: VerifiedAccount;
  draft: LocalDraft | null;
  memory: HomeInputSession;
  client: AccountLifecycleClient;
  signal: AbortSignal;
  beforeSave?: (request: AttachedProjectDraftInput) => void;
}): Promise<AttachedProjectDraftReceipt | null> {
  const release = memory.acquire(account);
  if (!release) return null;
  const controller = new AbortController(),
    abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  const unsubscribe = memory.subscribe(() => {
    if (!memory.isCurrent(account)) controller.abort();
  });
  const current = () => !signal.aborted && !controller.signal.aborted && memory.isCurrent(account);
  let state = memory.get(account);
  const put = (next: HomeInputIntent) => {
    if (!current() || !memory.set(account, next)) return false;
    state = memory.get(account);
    return true;
  };
  try {
    if (!current() || !state || !state.files.length) return null;
    if (state.receipt) return state.receipt;
    if (!state.saveIntent) {
      if (!draft) throw new AccountRequestError(422);
      if (
        !put({
          ...state,
          browserDraftId: state.browserDraftId ?? draft.id,
          saveIntent: { requestKey: crypto.randomUUID(), project: createAccountInput(draft), attachmentIds: [] },
        })
      )
        return null;
    }
    beforeSave?.(state!.saveIntent!);
    for (const original of state!.files) {
      if (!current()) return null;
      let file = state!.files.find((f) => f.localId === original.localId)!;
      if (file.receipt) continue;
      if (file.outcome === "uncertain" || file.outcome === "pending") {
        const lookup = await client.readHomeAttachmentRequest(file.upload.requestKey, controller.signal);
        if (!lookup || !current()) return null;
        if (lookup.status === "pending") return null;
        if (lookup.status === "committed") {
          file = { ...file, receipt: lookup.receipt, outcome: "verified" };
          verifyFile(account, file);
          if (!put({ ...state!, files: state!.files.map((f) => (f.localId === file.localId ? file : f)) })) return null;
          continue;
        }
      }
      const receipt = await (async () => {
        if (
          !put({
            ...state!,
            files: state!.files.map((f) => (f.localId === file.localId ? { ...f, outcome: "pending" } : f)),
          })
        )
          return null;
        try {
          const bytes = new Uint8Array(await file.file.arrayBuffer());
          if (!current()) return null;
          return await client.stageHomeAttachment(file.upload, bytes, controller.signal);
        } catch (cause) {
          if (current())
            put({
              ...state!,
              files: state!.files.map((f) =>
                f.localId === file.localId
                  ? {
                      ...f,
                      outcome:
                        cause instanceof AccountRequestError && [409, 413, 422].includes(cause.status)
                          ? "failed"
                          : "uncertain",
                    }
                  : f,
              ),
            });
          throw cause;
        }
      })();
      if (!receipt || !current()) return null;
      file = { ...file, receipt, outcome: "verified" };
      verifyFile(account, file);
      if (!put({ ...state!, files: state!.files.map((f) => (f.localId === file.localId ? file : f)) })) return null;
    }
    if (!current()) return null;
    if (state!.saveOutcome === "pending" || state!.saveOutcome === "uncertain") {
      const lookup = await client.readAttachedProjectDraftRequest(state!.saveIntent!.requestKey, controller.signal);
      if (!lookup || !current()) return null;
      if (lookup.status === "pending") return null;
      if (lookup.status === "committed") {
        if (!put({ ...state!, receipt: lookup.receipt, saveOutcome: "confirmed" }))
          throw new Error("Unverified Home receipt");
        return state!.receipt;
      }
    }
    const input = { ...state!.saveIntent!, attachmentIds: state!.files.map((file) => file.receipt!.id) };
    if (!put({ ...state!, saveIntent: input, saveOutcome: "pending" })) return null;
    try {
      const receipt = await client.saveAttachedProjectDraft(input, controller.signal);
      if (!receipt || !current()) return null;
      if (!put({ ...state!, receipt, saveOutcome: "confirmed" })) throw new Error("Unverified Home receipt");
      return state!.receipt;
    } catch (cause) {
      if (current()) put({ ...state!, saveOutcome: "uncertain" });
      throw cause;
    }
  } finally {
    unsubscribe();
    signal.removeEventListener("abort", abort);
    release();
  }
}
