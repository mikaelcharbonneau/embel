import "server-only";
import { LocalChatGPTError, type LocalChatGPTErrorCode } from "./oauth";

export type SignInFailure = {
  phase: "callback_validation" | "oauth_exchange" | "session_validation" | "session_persistence" |
    "approval" | "session_completion" | "runtime_detach";
  reason: LocalChatGPTErrorCode | "unavailable";
};

const reasons = [
  "invalid_configuration", "invalid_callback", "access_denied", "invalid_identity", "invalid_token_response",
  "sign_in_required", "plan_permission_required", "session_unavailable", "invalid_client", "registration_not_found",
  "credential_store_unavailable", "credential_store_busy", "authorization_pending_limit",
] as const satisfies readonly LocalChatGPTErrorCode[];

function safeReason(error: unknown): SignInFailure["reason"] {
  try {
    if (error instanceof LocalChatGPTError) {
      // Read only an own data property: never invoke a message/code getter,
      // stringify an exception or trust TypeScript's compile-time code union.
      const descriptor = Object.getOwnPropertyDescriptor(error, "code");
      if (descriptor && "value" in descriptor) {
        for (const reason of reasons) if (descriptor.value === reason) return reason;
      }
    }
  } catch { /* Even a hostile proxy must leave the original failure unchanged. */ }
  return "unavailable";
}

export function reportSignInFailure(phase: SignInFailure["phase"], error: unknown, observer?: (failure: SignInFailure) => void) {
  // Only static phase/category labels cross this boundary. No callback, token,
  // identity, provider reply or raw exception reaches the observer.
  try { observer?.({ phase, reason: safeReason(error) }); } catch { /* Diagnostics cannot change sign-in behavior. */ }
}
