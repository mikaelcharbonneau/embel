import "server-only";
import type { AuthenticatedContext } from "../auth/context";
import { createSharedAccountHttpRuntime, type SharedAccountHttpDependencies } from "./runtime";
import { createSharedLogoHttpRuntime } from "./logo-runtime";

type Environment = Readonly<Record<string, string | undefined>>;
type Runtime = NonNullable<ReturnType<typeof createSharedAccountHttpRuntime>>;
type State = {
  status: "installed" | "unavailable";
  runtime?: Runtime;
  logo?: NonNullable<ReturnType<typeof createSharedLogoHttpRuntime>>;
};
const key = Symbol.for("embel.shared-account-http.v1");
const empty = () => ({ configured: true as const, value: null, release: async () => {} });
/** The web app's restricted Identity, Home and Logo write lanes (EMBEL_SHARED_ACCOUNT_HTTP_ENABLED). */
export function sharedAccountHttpConfigured(env: Environment = process.env) {
  return env.EMBEL_SHARED_ACCOUNT_HTTP_ENABLED === "true";
}
/** One finite service pool set per web instance. No account registry, customer
 * credential, Vault access or provider key is loaded by web instrumentation. */
export function startSharedAccountHttpServices(
  env: Environment = process.env,
  dependencies?: SharedAccountHttpDependencies,
): "disabled" | State["status"] {
  if (!sharedAccountHttpConfigured(env)) return "disabled";
  const existing = Reflect.get(globalThis, key) as State | undefined;
  if (existing) return existing.status;
  const state: State = { status: "unavailable" };
  Object.defineProperty(globalThis, key, { value: state, configurable: true });
  try {
    const runtime = createSharedAccountHttpRuntime(env, dependencies);
    if (runtime) {
      state.runtime = runtime;
      state.status = "installed";
    }
  } catch {
    /* Credential-bearing errors never enter startup output or fallbacks. */
  }
  try {
    const runtime = createSharedLogoHttpRuntime(env, dependencies);
    if (runtime) {
      state.logo = runtime;
      state.status = "installed";
    }
  } catch {
    /* A failed lane stays unavailable without borrowing another identity. */
  }
  return state.status;
}
function state() {
  startSharedAccountHttpServices();
  return Reflect.get(globalThis, key) as State | undefined;
}
export async function acquireSharedAccountIdentity(auth: AuthenticatedContext, signal?: AbortSignal) {
  const runtime = state()?.runtime;
  return runtime ? runtime.acquireIdentity(auth, signal) : empty();
}
export async function acquireSharedAccountHome(auth: AuthenticatedContext, signal?: AbortSignal) {
  const runtime = state()?.runtime;
  return runtime ? runtime.acquireHome(auth, signal) : empty();
}
export async function resolveSharedLogoRequestServices(
  auth: AuthenticatedContext,
  projectId: string,
  signal?: AbortSignal,
) {
  const runtime = state()?.logo;
  return runtime ? runtime.resolve(auth, projectId, signal) : null;
}
export async function stopSharedAccountHttpServices() {
  const current = Reflect.get(globalThis, key) as State | undefined;
  Reflect.deleteProperty(globalThis, key);
  await Promise.all([current?.runtime?.close(), current?.logo?.close()]);
}
