import { z } from "zod";
import { createProjectInputSchema } from "@/domain/projects";
import { getLocalDraft, type LocalDraft } from "./local-drafts";
import { accountProjectDraft, createAccountInput } from "./project-draft-adapter";

// The marker keeps an explicit continuation intent. New account creates use a
// bounded owner-specific recovery buffer instead of the legacy draft collection.
// Files and credentials are never copied, and reading recovery starts no request.
const key = "fluid.prompt-sign-in.v1";
const bufferKey = (ownerId: string) => `fluid.prompt-buffer.v1:${ownerId}`;
const bufferSchema = z.strictObject({
  draftId: z.uuid(),
  ownerId: z.uuid(),
  createdAt: z.iso.datetime({ offset: true }),
  locked: z.boolean(),
  input: createProjectInputSchema,
});

export function rememberPromptForSignIn(draftId: string, locked = false, pendingDraft?: LocalDraft) {
  const local = getLocalDraft(draftId),
    draft = local ?? pendingDraft;
  if (!local && draft?.ownerId)
    window.sessionStorage.setItem(
      bufferKey(draft.ownerId),
      JSON.stringify(
        bufferSchema.parse({
          draftId,
          ownerId: draft.ownerId,
          createdAt: draft.createdAt,
          locked,
          input: createAccountInput(draft),
        }),
      ),
    );
  window.sessionStorage.setItem(
    key,
    JSON.stringify({
      draftId,
      locked,
      intent: "continue-prompt",
      ...(draft?.ownerId ? { ownerId: draft.ownerId } : {}),
    }),
  );
}

export function readPromptRecoveryState(ownerId?: string | null) {
  try {
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (
      !value ||
      typeof value !== "object" ||
      !("draftId" in value) ||
      typeof value.draftId !== "string" ||
      !("locked" in value) ||
      typeof value.locked !== "boolean"
    )
      return null;
    let draft = getLocalDraft(value.draftId);
    if (!draft && ownerId && "ownerId" in value && value.ownerId === ownerId) {
      const bufferRaw = window.sessionStorage.getItem(bufferKey(ownerId));
      const buffer = bufferRaw && bufferRaw.length < 131_072 ? bufferSchema.safeParse(JSON.parse(bufferRaw)) : null;
      if (buffer?.success && buffer.data.ownerId === ownerId && buffer.data.draftId === value.draftId) {
        const kept = buffer.data;
        draft = {
          ...accountProjectDraft({
            ...kept.input,
            id: kept.draftId,
            owner_id: kept.ownerId,
            current_revision: 1,
            created_at: kept.createdAt,
          }),
          ownerId: kept.ownerId,
        };
      }
    }
    // Unowned legacy browser drafts need an explicit recovery selection. A new
    // prompt deliberately retained for sign-in can resume in the same tab.
    if (
      !("intent" in value) ||
      value.intent !== "continue-prompt" ||
      !draft ||
      (draft.ownerId && draft.ownerId !== ownerId)
    )
      return null;
    return { draft, locked: value.locked };
  } catch {
    return null;
  }
}

/** Authentication may route back to an explicit intent without reading its text. */
export function hasPromptRecovery() {
  try {
    const value: unknown = JSON.parse(window.sessionStorage.getItem(key) ?? "null");
    return Boolean(
      value &&
      typeof value === "object" &&
      "intent" in value &&
      value.intent === "continue-prompt" &&
      "draftId" in value &&
      typeof value.draftId === "string",
    );
  } catch {
    return false;
  }
}

export const beforePromptSignInEvent = "fluid:before-prompt-sign-in";
export function preparePromptForSignIn() {
  return window.dispatchEvent(new Event(beforePromptSignInEvent, { cancelable: true }));
}

export function clearPromptRecovery(ownerId?: string | null) {
  try {
    window.sessionStorage.removeItem(key);
    if (ownerId) window.sessionStorage.removeItem(bufferKey(ownerId));
  } catch {
    /* The existing draft remains available for recovery. */
  }
}
