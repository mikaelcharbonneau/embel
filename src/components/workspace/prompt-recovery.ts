import { getLocalDraft } from "./local-drafts";

// Only the existing browser draft ID and its edit fence are retained in this tab. No account data,
// files or credentials are copied, and recovery never starts a request.
const key = "fluid.prompt-sign-in.v1";

export function rememberPromptForSignIn(draftId: string, locked = false) {
  const draft = getLocalDraft(draftId);
  window.sessionStorage.setItem(key, JSON.stringify({ draftId, locked, intent: "continue-prompt", ...(draft?.ownerId ? { ownerId: draft.ownerId } : {}) }));
}

export function readPromptRecoveryState(ownerId?: string | null) {
  try {
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || !("draftId" in value) || typeof value.draftId !== "string" || !("locked" in value) || typeof value.locked !== "boolean") return null;
    const draft = getLocalDraft(value.draftId);
    // Unowned legacy browser drafts need an explicit recovery selection. A new
    // prompt deliberately retained for sign-in can resume in the same tab.
    if (!("intent" in value) || value.intent !== "continue-prompt" || !draft || (draft.ownerId && draft.ownerId !== ownerId)) return null;
    return { draft, locked: value.locked };
  } catch { return null; }
}

export function readPromptRecovery() { return readPromptRecoveryState()?.draft ?? null; }

/** Authentication may route back to an explicit intent without reading its text. */
export function hasPromptRecovery() {
  try {
    const value: unknown = JSON.parse(window.sessionStorage.getItem(key) ?? "null");
    return Boolean(value && typeof value === "object" && "intent" in value && value.intent === "continue-prompt" && "draftId" in value && typeof value.draftId === "string");
  } catch { return false; }
}

export const beforePromptSignInEvent = "fluid:before-prompt-sign-in";
export function preparePromptForSignIn() {
  return window.dispatchEvent(new Event(beforePromptSignInEvent, { cancelable: true }));
}

export function clearPromptRecovery() {
  try { window.sessionStorage.removeItem(key); } catch { /* The existing draft remains available in Brands. */ }
}
