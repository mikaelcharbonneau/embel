import "server-only";
import type { AuthenticatedContext } from "@/server/auth/context";
import { getLogoWorkspace } from "@/server/data/logo-workspace";
import { logoId, logoOwner } from "@/server/data/logo-transaction";
import { ApiError } from "@/server/http/errors";
import { createLogoServices, type LogoServiceDependencies } from "./logo-services";
import { sharedAccountHttpConfigured, resolveSharedLogoRequestServices } from "../shared-account/bootstrap";

type LogoRequestServiceDependencies = Omit<LogoServiceDependencies, "worker">;
export type LogoRequestServiceResolution = {
  ownerId: string;
  projectId: string;
  dependencies: LogoRequestServiceDependencies;
};
/** Resolves the restricted login and exact private-storage scope for one verified
 * account and project. Not evidence of hosted permissions, readiness or provider availability. */
export type LogoRequestServiceResolver = (
  auth: AuthenticatedContext,
  projectId: string,
  signal?: AbortSignal,
) => Promise<LogoRequestServiceResolution | null>;

const unavailable = () => new ApiError("integration_unavailable");
const active = (signal?: AbortSignal) => {
  if (signal?.aborted) throw unavailable();
};

/** Resolve fresh capabilities for this verified account and exact owned project.
 * Never use a privileged dependency to establish ordinary account ownership. */
export async function resolveLogoRequestServices(auth: AuthenticatedContext, projectId: string, signal?: AbortSignal) {
  if (!auth || typeof auth.client?.rpc !== "function") throw new ApiError("unauthenticated");
  const ownerId = logoOwner(auth);
  projectId = logoId(projectId);
  active(signal);
  if (!sharedAccountHttpConfigured()) return createLogoServices(null);
  const resolve: LogoRequestServiceResolver = resolveSharedLogoRequestServices;
  await getLogoWorkspace(auth, projectId, signal);
  active(signal);
  // A resolver must honor the signal for its own work. Independently fence the
  // HTTP wait and consume late settlement without composing or caching it.
  let rejectAborted!: (error: ApiError) => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAborted = reject;
  });
  const stop = () => rejectAborted(unavailable());
  signal?.addEventListener("abort", stop, { once: true });
  let resolved: LogoRequestServiceResolution | null;
  try {
    active(signal);
    resolved = await Promise.race([
      Promise.resolve().then(() => {
        active(signal);
        return resolve(auth, projectId, signal);
      }),
      aborted,
    ]);
  } finally {
    signal?.removeEventListener("abort", stop);
  }
  active(signal);
  if (resolved === null) return createLogoServices(null);
  if (!resolved || resolved.ownerId !== ownerId || resolved.projectId !== projectId) throw new ApiError("not_found");
  const dependencies = resolved.dependencies;
  if (
    !dependencies ||
    typeof dependencies.connections?.acquire !== "function" ||
    typeof dependencies.storage?.read !== "function" ||
    typeof dependencies.storage?.putIfAbsent !== "function" ||
    (dependencies.validateBytes !== undefined && typeof dependencies.validateBytes !== "function")
  )
    throw unavailable();
  // Explicit projection excludes worker capabilities even from a wider JS value.
  return createLogoServices({
    connections: dependencies.connections,
    storage: dependencies.storage,
    ...(dependencies.validateBytes ? { validateBytes: dependencies.validateBytes } : {}),
  });
}
