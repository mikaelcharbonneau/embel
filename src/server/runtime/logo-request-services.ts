import "server-only";
import type { AuthenticatedContext } from "@/server/auth/context";
import { getLogoWorkspace } from "@/server/data/logo-workspace";
import { logoId, logoOwner } from "@/server/data/logo-transaction";
import { ApiError } from "@/server/http/errors";
import { createLogoServices, type LogoServiceDependencies } from "./logo-services";
import { sharedAccountHttpConfigured, resolveSharedLogoRequestServices } from "../shared-account/bootstrap";

export type LogoRequestServiceDependencies = Omit<LogoServiceDependencies, "worker">;
export type LogoRequestServiceResolution = {
  ownerId: string;
  projectId: string;
  dependencies: LogoRequestServiceDependencies;
};
/** Trusted server bootstrap only. The caller must independently qualify the
 * restricted login and exact private-storage scope. This structural contract
 * is not evidence of hosted permissions, readiness or provider availability. */
export type LogoRequestServiceResolver = (
  auth: AuthenticatedContext,
  projectId: string,
  signal?: AbortSignal,
) => Promise<LogoRequestServiceResolution | null>;

// Store only the resolver. Never retain an account, project, request, services,
// database connection or private-storage transport at this HTTP boundary.
// Next instrumentation and route bundles can evaluate independent module copies.
// The process-global slot holds only the once-installed resolver, never requests.
const RESOLVER = Symbol.for("fluid.logo.request-services.v1");
const unavailable = () => new ApiError("integration_unavailable");
const active = (signal?: AbortSignal) => { if (signal?.aborted) throw unavailable(); };

/** Installation is explicit, once-only and zero-I/O. There is intentionally no
 * default bootstrap, environment/credential discovery, reset or replacement. */
export function configureLogoRequestServices(trustedResolver: LogoRequestServiceResolver): void {
  if (Reflect.has(globalThis, RESOLVER) || typeof trustedResolver !== "function") throw unavailable();
  Object.defineProperty(globalThis, RESOLVER, { value: trustedResolver, configurable: true });
}

/** Resolve fresh capabilities for this verified account and exact owned project.
 * Never use a privileged dependency to establish ordinary account ownership. */
export async function resolveLogoRequestServices(auth: AuthenticatedContext, projectId: string, signal?: AbortSignal) {
  if (!auth || typeof auth.client?.rpc !== "function") throw new ApiError("unauthenticated");
  const ownerId = logoOwner(auth);
  projectId = logoId(projectId);
  active(signal);
  const resolve = sharedAccountHttpConfigured() ? resolveSharedLogoRequestServices : Reflect.get(globalThis, RESOLVER) as LogoRequestServiceResolver | undefined;
  if (!resolve) return createLogoServices(null);
  await getLogoWorkspace(auth, projectId, signal);
  active(signal);
  // A resolver must honor the signal for its own work. Independently fence the
  // HTTP wait and consume late settlement without composing or caching it.
  let rejectAborted!: (error: ApiError) => void;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAborted = reject; });
  const stop = () => rejectAborted(unavailable());
  signal?.addEventListener("abort", stop, { once: true });
  let resolved: LogoRequestServiceResolution | null;
  try {
    active(signal);
    resolved = await Promise.race([Promise.resolve().then(() => { active(signal); return resolve(auth, projectId, signal); }), aborted]);
  } finally { signal?.removeEventListener("abort", stop); }
  active(signal);
  if (resolved === null) return createLogoServices(null);
  if (!resolved || resolved.ownerId !== ownerId || resolved.projectId !== projectId) throw new ApiError("not_found");
  const dependencies = resolved.dependencies;
  if (!dependencies || typeof dependencies.connections?.acquire !== "function" || typeof dependencies.storage?.read !== "function"
    || typeof dependencies.storage?.putIfAbsent !== "function" || dependencies.validateBytes !== undefined && typeof dependencies.validateBytes !== "function") throw unavailable();
  // Explicit projection excludes worker capabilities even from a wider JS value.
  return createLogoServices({ connections: dependencies.connections, storage: dependencies.storage,
    ...(dependencies.validateBytes ? { validateBytes: dependencies.validateBytes } : {}) });
}
