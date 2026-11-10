import "server-only";
import type { AuthenticatedContext } from "@/server/auth/context";
import { sharedAccountHttpConfigured, acquireSharedAccountIdentity, acquireSharedAccountHome } from "../shared-account/bootstrap";
import { resolveAccountHomeAttachmentService, resolveAccountIdentityRuntime, type AccountHomeAttachmentService, type AccountIdentityRuntime } from "./account-http-services";

export type AccountHttpRuntimeLease<T> = Readonly<{ configured: boolean; value: T | null; release(): Promise<void> }>;
const noRelease = async () => {};

/** The web app's restricted Identity write lane: the shared lane when configured, otherwise
 * an operator-configured per-owner login. An unconfigured lane falls back to development. */
export async function acquireAccountIdentityRuntime(auth: AuthenticatedContext, signal?: AbortSignal): Promise<AccountHttpRuntimeLease<AccountIdentityRuntime>> {
  if (sharedAccountHttpConfigured()) return acquireSharedAccountIdentity(auth, signal);
  return { configured: false, value: await resolveAccountIdentityRuntime(auth.userId, signal), release: noRelease };
}
/** The web app's restricted Home attachment lane, chosen the same way. */
export async function acquireAccountHomeAttachmentService(auth: AuthenticatedContext, signal?: AbortSignal): Promise<AccountHttpRuntimeLease<AccountHomeAttachmentService>> {
  if (sharedAccountHttpConfigured()) return acquireSharedAccountHome(auth, signal);
  return { configured: false, value: await resolveAccountHomeAttachmentService(auth, signal), release: noRelease };
}
