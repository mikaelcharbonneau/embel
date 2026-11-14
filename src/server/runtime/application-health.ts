import "server-only";
import { createHash } from "node:crypto";
import { getSupabaseConfiguration } from "../config";

type Environment = Record<string, string | undefined>;
type Check = "reachable" | "unavailable" | "not_configured";
type CoreReadiness = {
  service: "fluid-web";
  release: string;
  scope: "core_connectivity";
  status: "ready" | "unavailable";
  checks: { auth: Check; database: Check; storage: Check };
  workers: "not_checked";
  provider: "not_checked";
  enrollment: "not_checked";
};
export function applicationRevision(env: Environment = process.env): string {
  return (
    [env.VERCEL_GIT_COMMIT_SHA, env.EMBEL_SOURCE_REVISION].find(
      (value) => value !== undefined && /^[a-f0-9]{40}$/u.test(value),
    ) ?? "unknown"
  );
}

async function boundedBody(response: Response, signal: AbortSignal, allowEmpty = false): Promise<string> {
  const length = response.headers.get("content-length");
  if (length !== null && (!/^(0|[1-9][0-9]*)$/u.test(length) || Number(length) > 4096))
    throw new Error("health_response_unavailable");
  if (!response.body) {
    if (allowEmpty && (length === null || length === "0")) return "";
    throw new Error("health_response_unavailable");
  }
  const reader = response.body.getReader(),
    parts: Uint8Array[] = [];
  let size = 0;
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > 4096) throw new Error("health_response_unavailable");
      parts.push(new Uint8Array(item.value));
    }
    signal.throwIfAborted();
    if ((!size && !allowEmpty) || (length !== null && Number(length) !== size))
      throw new Error("health_response_unavailable");
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.byteLength;
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    cancel();
    throw new Error("health_response_unavailable");
  } finally {
    signal.removeEventListener("abort", cancel);
    try {
      reader.releaseLock();
    } catch {
      /* A cancelled read may still settle. */
    }
  }
}

/** Read-only connectivity checks. No session, privileged key, model or job call.
 * The database check requests zero rows and recognizes its actual SQL42501
 * permission response. Neither this result nor liveness asserts worker, account
 * enrollment, provider or complete application readiness. */
export function createCoreReadinessReader(
  dependencies: { env?: Environment; fetch?: typeof fetch; now?: () => number } = {},
) {
  const env = dependencies.env ?? process.env,
    fetcher = dependencies.fetch ?? fetch,
    now = dependencies.now ?? (() => performance.now());
  let cached: { key: string; expires: number; result: CoreReadiness } | undefined;
  let pending: { key: string; result: Promise<CoreReadiness> } | undefined;
  async function probe(url: string, key: string, kind: "auth" | "database" | "storage"): Promise<Check> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stopped = new Promise<Check>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve("unavailable");
      }, 2000);
    });
    const running = (async (): Promise<Check> => {
      let response: Response | undefined;
      try {
        response = await fetcher(url, {
          method: "GET",
          headers: { apikey: key, "accept-encoding": "identity" },
          signal: controller.signal,
          redirect: "error",
          cache: "no-store",
          credentials: "omit",
        });
        if (controller.signal.aborted || response.redirected || (response.url && response.url !== url))
          throw new Error("health_response_unavailable");
        const body = await boundedBody(response, controller.signal, kind === "storage");
        if (kind === "database") {
          const data: unknown = JSON.parse(body);
          if (
            (response.status === 200 && Array.isArray(data) && data.length === 0) ||
            ([401, 403].includes(response.status) &&
              data &&
              typeof data === "object" &&
              "code" in data &&
              data.code === "42501")
          )
            return "reachable";
          return "unavailable";
        }
        if (response.status !== 200) return "unavailable";
        if (kind === "auth") {
          const data: unknown = JSON.parse(body);
          if (!data || typeof data !== "object" || Array.isArray(data) || !("name" in data) || data.name !== "GoTrue")
            return "unavailable";
        }
        return "reachable";
      } catch {
        try {
          void response?.body?.cancel().catch(() => {});
        } catch {
          /* A read may still be settling. */
        }
        return "unavailable";
      }
    })();
    try {
      return await Promise.race([running, stopped]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  return async (): Promise<CoreReadiness> => {
    let configuration: ReturnType<typeof getSupabaseConfiguration> | undefined;
    try {
      configuration = getSupabaseConfiguration(env);
    } catch {
      /* No config/error values enter health responses. */
    }
    const release = applicationRevision(env);
    const key = createHash("sha256")
      .update(JSON.stringify([release, configuration?.url, configuration?.publishableKey]))
      .digest("hex");
    if (cached?.key === key && cached.expires > now()) return structuredClone(cached.result);
    if (pending?.key === key) return structuredClone(await pending.result);
    const result = (async (): Promise<CoreReadiness> => {
      let checks: CoreReadiness["checks"] = {
        auth: "not_configured",
        database: "not_configured",
        storage: "not_configured",
      };
      if (configuration) {
        const { url, publishableKey } = configuration;
        const [auth, database, storage] = await Promise.all([
          probe(`${url}/auth/v1/health`, publishableKey, "auth"),
          probe(`${url}/rest/v1/projects?select=id&limit=0`, publishableKey, "database"),
          probe(`${url}/storage/v1/status`, publishableKey, "storage"),
        ]);
        checks = { auth, database, storage };
      }
      return {
        service: "fluid-web",
        release,
        scope: "core_connectivity",
        status: Object.values(checks).every((value) => value === "reachable") ? "ready" : "unavailable",
        checks,
        workers: "not_checked",
        provider: "not_checked",
        enrollment: "not_checked",
      };
    })();
    pending = { key, result };
    try {
      const value = await result;
      cached = { key, expires: now() + 2000, result: value };
      return structuredClone(value);
    } finally {
      if (pending?.result === result) pending = undefined;
    }
  };
}
