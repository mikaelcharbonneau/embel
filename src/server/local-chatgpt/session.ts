import "server-only";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { reportSignInFailure, type SignInFailure } from "./sign-in-diagnostics";
import { credentialRecordSchema, registrationIdFor, type ChatGPTCredentialStore, type CredentialRecord } from "./credentials";
import {
  createAuthorizationAttempt, createOpenAIOAuthClient, LocalChatGPTError, PLAN_USAGE_SCOPE,
  readAuthorizationCallback, type AuthorizationAttempt, type OpenAIOAuthClient,
} from "./oauth";

export type ChatGPTRegistrationSummary = { registrationId: string; email: string | null; planUsageEnabled: boolean };
export type ChatGPTInferenceCredential = { registrationId: string; subject: string; clientId: string; accessToken: string; expiresAt: number; scopes: string[] };

function summary(record: CredentialRecord): ChatGPTRegistrationSummary {
  return { registrationId: record.registrationId, email: record.email, planUsageEnabled: Boolean(record.tokens?.accessToken && record.tokens.scopes.includes(PLAN_USAGE_SCOPE) && record.tokens.scopes.includes("resource.invoke")) };
}
function assertOwner(ownerId: string) {
  if (!z.uuid().safeParse(ownerId).success) throw new LocalChatGPTError("registration_not_found");
}

/** Own this manager in the dedicated local worker only. Its constructor is inert.
 * ownerId always comes from verified Supabase auth, never browser JSON.
 * The runtime is responsible for gating the first authorization/storage action. */
export function createLocalChatGPTSessionManager(options: {
  store: ChatGPTCredentialStore; oauth?: OpenAIOAuthClient; now?: () => number;
  onSessionInvalidated?: (ownerId: string, registrationId: string) => void;
  onSignInFailure?: (failure: SignInFailure) => void;
  revocationBackoff?: () => Promise<void>;
}) {
  const { store } = options;
  const now = options.now ?? Date.now;
  const oauth = options.oauth ?? createOpenAIOAuthClient({ now });
  const attempts = new Map<string, AuthorizationAttempt & { generation: number; startedSequence: number }>();
  const registrationRetries = new Map<string, { clientId: string; expiresAt: number }>();
  const refreshes = new Map<string, Promise<ChatGPTInferenceCredential>>();
  const generations = new Map<string, number>();
  const lastInvalidation = new Map<string, number>();
  let invalidationSequence = 0;
  const signingOut = new Set<string>();

  function key(ownerId: string, registrationId: string) { return `${ownerId}:${registrationId}`; }
  function invalidate(ownerId: string, registrationId: string) {
    const id = key(ownerId, registrationId);
    generations.set(id, (generations.get(id) ?? 0) + 1);
    lastInvalidation.set(id, ++invalidationSequence);
    // An observer cannot prevent token invalidation or make a completed rotation
    // appear to have failed. Runtime request cancellation is an additional fence.
    try { options.onSessionInvalidated?.(ownerId, registrationId); } catch { /* No credentials or raw observer errors are logged. */ }
  }
  async function readOwned(ownerId: string, registrationId: string) {
    assertOwner(ownerId);
    const record = await store.read(ownerId, registrationId);
    if (!record || record.ownerId !== ownerId || record.registrationId !== registrationId || !credentialRecordSchema.safeParse(record).success) {
      throw new LocalChatGPTError("registration_not_found");
    }
    return record;
  }

  return {
    async listRegistrations(ownerId: string): Promise<ChatGPTRegistrationSummary[]> {
      assertOwner(ownerId);
      const records = await store.list(ownerId);
      if (records.some(record => record.ownerId !== ownerId || !credentialRecordSchema.safeParse(record).success)) throw new LocalChatGPTError("credential_store_unavailable");
      return records.map(summary);
    },
    async beginSignIn(input: { ownerId: string; browserSessionId: string; redirectUri: string; registrationId?: string }) {
      assertOwner(input.ownerId);
      const startedSequence = invalidationSequence;
      const generation = input.registrationId ? generations.get(key(input.ownerId, input.registrationId)) ?? 0 : 0;
      const registration = input.registrationId ? await readOwned(input.ownerId, input.registrationId) : null;
      const hostId = await store.getHostId();
      if (registration && registration.hostId !== hostId) throw new LocalChatGPTError("invalid_configuration");
      for (const [state, attempt] of attempts) {
        if (attempt.expiresAt <= now() || (attempt.ownerId === input.ownerId && attempt.browserSessionId === input.browserSessionId)) attempts.delete(state);
      }
      for (const [browser, retry] of registrationRetries) if (retry.expiresAt <= now()) registrationRetries.delete(browser);
      if (attempts.size >= 32) throw new LocalChatGPTError("authorization_pending_limit");
      const attempt = createAuthorizationAttempt({ ...input, hostId, ...(registration ? { registration } : {}) }, now());
      const registrationRetry = registrationRetries.get(key(input.ownerId, input.browserSessionId));
      if (!registration && registrationRetry) attempt.clientId = registrationRetry.clientId;
      const pending = { ...attempt, generation, startedSequence };
      attempts.set(attempt.state, pending); // Reserve capacity before discovery's asynchronous wait.
      try {
        // This URL is returned through browser JavaScript. Never put a retained
        // ID token in it; the provider can ask the returning user to select an account.
        const authorizationUrl = await oauth.authorizationUrl(attempt, { email: registration?.email });
        if (attempts.get(attempt.state) !== pending) throw new LocalChatGPTError("invalid_callback");
        if (input.registrationId && (signingOut.has(key(input.ownerId, input.registrationId)) || (generations.get(key(input.ownerId, input.registrationId)) ?? 0) !== generation)) {
          throw new LocalChatGPTError("sign_in_required");
        }
        return { authorizationUrl, expiresAt: attempt.expiresAt };
      } catch (error) { if (attempts.get(attempt.state) === pending) attempts.delete(attempt.state); throw error; }
    },
    async completeSignIn({ callbackUrl }: { callbackUrl: string }): Promise<{ ownerId: string; registration: ChatGPTRegistrationSummary }> {
      let phase: SignInFailure["phase"] = "callback_validation";
      try {
        let state: string;
        try {
          const url = new URL(callbackUrl);
          if (url.searchParams.getAll("state").length !== 1) throw new Error("invalid");
          state = url.searchParams.get("state") ?? "";
        } catch { throw new LocalChatGPTError("invalid_callback"); }
        const attempt = attempts.get(state);
        attempts.delete(state); // One-time consumption precedes code exchange, including failures.
        if (!attempt) throw new LocalChatGPTError("invalid_callback");
        const callback = readAuthorizationCallback(attempt, callbackUrl, now());
        // Exchange includes the existing token response and JWT validation.
        phase = "oauth_exchange";
        let validated: Awaited<ReturnType<OpenAIOAuthClient["exchange"]>>;
        try { validated = await oauth.exchange(attempt, callback); }
        catch (error) {
          if (!attempt.registrationId && error instanceof LocalChatGPTError && error.code === "sign_in_required") {
            // A verified callback issued a client but its code was unusable. Keep only
            // this transient registration hint for an explicit retry by this browser.
            if (registrationRetries.size >= 32) registrationRetries.delete(registrationRetries.keys().next().value!);
            registrationRetries.set(key(attempt.ownerId, attempt.browserSessionId), { clientId: callback.clientId, expiresAt: now() + 10 * 60_000 });
          }
          throw error;
        }
        phase = "session_validation";
        const registrationId = registrationIdFor({ ownerId: attempt.ownerId, ...validated.identity });
        if (attempt.registrationId && registrationId !== attempt.registrationId) throw new LocalChatGPTError("invalid_identity");
        const parsedRecord = credentialRecordSchema.safeParse({
          version: 1, registrationId, ownerId: attempt.ownerId, ...validated.identity,
          hostId: attempt.hostId, tokens: validated.tokens, updatedAt: now(),
        });
        if (!parsedRecord.success) throw new LocalChatGPTError("invalid_token_response");
        const record = parsedRecord.data;
        phase = "session_persistence";
        await refreshes.get(key(attempt.ownerId, registrationId))?.catch(() => {});
        await store.withLock(registrationId, async () => {
          // Even a dynamic-registration callback can resolve to an existing issued
          // identity. A later sign-out of that identity must win over this attempt.
          if (signingOut.has(key(attempt.ownerId, registrationId)) || (lastInvalidation.get(key(attempt.ownerId, registrationId)) ?? 0) > attempt.startedSequence) {
            throw new LocalChatGPTError("sign_in_required");
          }
          if (attempt.registrationId) {
            await readOwned(attempt.ownerId, registrationId);
            if (signingOut.has(key(attempt.ownerId, registrationId)) || (generations.get(key(attempt.ownerId, registrationId)) ?? 0) !== attempt.generation) {
              throw new LocalChatGPTError("sign_in_required");
            }
          }
          await store.write(record);
        });
        invalidate(attempt.ownerId, registrationId);
        registrationRetries.delete(key(attempt.ownerId, attempt.browserSessionId));
        return { ownerId: attempt.ownerId, registration: summary(record) };
      } catch (error) {
        reportSignInFailure(phase, error, options.onSignInFailure);
        throw error;
      }
    },
    getInferenceCredential(ownerId: string, registrationId: string): Promise<ChatGPTInferenceCredential> {
      assertOwner(ownerId);
      const id = key(ownerId, registrationId);
      if (signingOut.has(id)) return Promise.reject(new LocalChatGPTError("sign_in_required"));
      const current = refreshes.get(id);
      if (current) return current;
      const generation = generations.get(id) ?? 0;
      const action = store.withLock(registrationId, async () => {
        let record = await readOwned(ownerId, registrationId);
        let tokens = record.tokens;
        if (!tokens) throw new LocalChatGPTError("sign_in_required");
        if (!tokens.scopes.includes(PLAN_USAGE_SCOPE) || !tokens.scopes.includes("resource.invoke")) throw new LocalChatGPTError("plan_permission_required");
        if (!tokens.accessToken || tokens.expiresAt === null) throw new LocalChatGPTError("sign_in_required");
        const nearExpiry = tokens.expiresAt <= now() + 60_000;
        const refreshAllowed = tokens.earliestRefreshAt === null || tokens.earliestRefreshAt <= now();
        if (nearExpiry && refreshAllowed) {
          try {
            const replacement = await oauth.refresh(record, tokens);
            record = { ...record, tokens: replacement, updatedAt: now() };
            // Replace every rotating field atomically before making it available.
            await store.write(record);
            tokens = replacement;
          } catch (error) {
            if (error instanceof LocalChatGPTError && error.code === "sign_in_required") {
              await store.write({ ...record, tokens: null, updatedAt: now() });
              invalidate(ownerId, registrationId);
            }
            throw error;
          }
        }
        if (!tokens.scopes.includes(PLAN_USAGE_SCOPE) || !tokens.scopes.includes("resource.invoke")) throw new LocalChatGPTError("plan_permission_required");
        if (!tokens.accessToken || tokens.expiresAt === null || tokens.expiresAt <= now()) throw new LocalChatGPTError("session_unavailable");
        await oauth.validateAccessToken(tokens.accessToken, record, tokens.scopes);
        if (signingOut.has(id) || (generations.get(id) ?? 0) !== generation) throw new LocalChatGPTError("sign_in_required");
        return { registrationId, subject: record.subject, clientId: record.clientId, accessToken: tokens.accessToken, expiresAt: tokens.expiresAt, scopes: [...tokens.scopes] };
      }).finally(() => { if (refreshes.get(id) === action) refreshes.delete(id); });
      refreshes.set(id, action);
      return action;
    },
    async signOut(ownerId: string, registrationId: string) {
      assertOwner(ownerId);
      await readOwned(ownerId, registrationId);
      const id = key(ownerId, registrationId);
      signingOut.add(id);
      invalidate(ownerId, registrationId);
      for (const [state, attempt] of attempts) {
        if (attempt.ownerId === ownerId && attempt.registrationId === registrationId) attempts.delete(state);
      }
      try {
        await refreshes.get(id)?.catch(() => {});
        return await store.withLock(registrationId, async () => {
          const record = await readOwned(ownerId, registrationId);
          let remoteRevocationConfirmed = record.tokens === null;
          if (record.tokens?.refreshToken) {
            // Bounded retry. Failure still clears local tokens and is reported to UI.
            for (let attempt = 0; attempt < 2 && !remoteRevocationConfirmed; attempt++) {
              let result: "confirmed" | "retryable" | "unconfirmed";
              try { result = await oauth.revoke(record.clientId, record.tokens.refreshToken); }
              catch { result = "retryable"; }
              remoteRevocationConfirmed = result === "confirmed";
              if (result !== "retryable") break;
              if (attempt === 0) await (options.revocationBackoff?.() ?? delay(250));
            }
          }
          await store.write({ ...record, tokens: null, updatedAt: now() });
          return { registration: summary({ ...record, tokens: null }), remoteRevocationConfirmed };
        });
      } finally { signingOut.delete(id); }
    },
  };
}
export type LocalChatGPTSessionManager = ReturnType<typeof createLocalChatGPTSessionManager>;
