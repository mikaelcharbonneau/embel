import { getLocalDraft } from "./local-drafts";

// Only the existing browser draft ID and its edit fence are retained in this tab. No account data,
// files or credentials are copied, and recovery never starts a request.
const key = "fluid.prompt-sign-in.v1";

export function rememberPromptForSignIn(draftId: string, locked = false) {
  window.sessionStorage.setItem(key, JSON.stringify({ draftId, locked }));
}

export function readPromptRecoveryState() {
  try {
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return null;
    // Older UI checkpoints stored only the draft ID.
    const oldDraft = getLocalDraft(raw);
    if (oldDraft) return { draft: oldDraft, locked: false };
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || !("draftId" in value) || typeof value.draftId !== "string" || !("locked" in value) || typeof value.locked !== "boolean") return null;
    const draft = getLocalDraft(value.draftId);
    return draft ? { draft, locked: value.locked } : null;
  } catch { return null; }
}

export function readPromptRecovery() { return readPromptRecoveryState()?.draft ?? null; }

export const beforePromptSignInEvent = "fluid:before-prompt-sign-in";
export function preparePromptForSignIn() {
  return window.dispatchEvent(new Event(beforePromptSignInEvent, { cancelable: true }));
}

export function clearPromptRecovery() {
  try { window.sessionStorage.removeItem(key); } catch { /* The existing draft remains available in Brands. */ }
}
