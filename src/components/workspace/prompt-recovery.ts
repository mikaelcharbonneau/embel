import { getLocalDraft } from "./local-drafts";

// Only the existing browser draft ID is retained, in this tab. No account data,
// files or credentials are copied, and recovery never starts a request.
const key = "fluid.prompt-sign-in.v1";

export function rememberPromptForSignIn(draftId: string) {
  window.sessionStorage.setItem(key, draftId);
}

export function readPromptRecovery() {
  try {
    const id = window.sessionStorage.getItem(key);
    return id ? getLocalDraft(id) : null;
  } catch { return null; }
}

export function clearPromptRecovery() {
  try { window.sessionStorage.removeItem(key); } catch { /* The existing draft remains available in Brands. */ }
}
