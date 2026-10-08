import "server-only";
import { z } from "zod";
import { localChatGPTModelsSchema, localChatGPTStatusSchema, localModelSelectionSchema, localRegistrationSelectionSchema, localSignInResponseSchema, localSignInSchema, localSignOutResponseSchema } from "../../domain/local-chatgpt";
import { getAuthenticatedContext } from "../auth/context";
import { ApiError, errorResponse, privateJson } from "../http/errors";
import { readJson } from "../http/request";

export function localRuntimeEnabled(env: NodeJS.ProcessEnv = process.env) {
  return env.FLUID_RUNTIME === "local" && !env.VERCEL;
}

export function localBridgeConfiguration(env: NodeJS.ProcessEnv = process.env) {
  if (!localRuntimeEnabled(env)) throw new ApiError("not_found");
  if (env.APP_ORIGIN !== "http://127.0.0.1:3106" || !/^[A-Za-z0-9_-]{43,128}$/.test(env.FLUID_LOCAL_BRIDGE_TOKEN ?? "")) throw new ApiError("integration_unavailable");
  return { appOrigin: env.APP_ORIGIN, workerOrigin: "http://127.0.0.1:3107", token: env.FLUID_LOCAL_BRIDGE_TOKEN! };
}

const actions = {
  status: { method: "GET", input: z.strictObject({}), output: localChatGPTStatusSchema },
  models: { method: "POST", input: localRegistrationSelectionSchema, output: localChatGPTModelsSchema },
  "sign-in": { method: "POST", input: localSignInSchema, output: localSignInResponseSchema },
  "select-model": { method: "POST", input: localModelSelectionSchema, output: localChatGPTStatusSchema },
  "sign-out": { method: "POST", input: localRegistrationSelectionSchema, output: localSignOutResponseSchema },
} as const;

/** The only route into the local worker; its shared capability never reaches the browser. */
export async function proxyLocalChatGPT(request: Request, action: string): Promise<Response> {
  try {
    const config = localBridgeConfiguration();
    if (!Object.hasOwn(actions, action)) throw new ApiError("not_found");
    const spec = actions[action as keyof typeof actions];
    if (request.method !== spec.method) throw new ApiError("not_found");
    const url = new URL(request.url);
    // NextRequest canonicalizes loopback URL hostnames to localhost. The wire
    // Host and browser Origin must still be the exact approved 127.0.0.1 origin.
    const localRequestUrl = url.origin === config.appOrigin || url.origin === "http://localhost:3106";
    if (request.headers.get("host") !== "127.0.0.1:3106" || !localRequestUrl || url.search || request.headers.get("sec-fetch-site") === "cross-site") throw new ApiError("forbidden_origin");
    const origin = request.headers.get("origin");
    if ((request.method !== "GET" && origin !== config.appOrigin) || (origin !== null && origin !== config.appOrigin)) throw new ApiError("forbidden_origin");
    const { userId } = await getAuthenticatedContext();
    const input = request.method === "GET" ? {} : await readJson(request, spec.input, 2048);
    const response = await fetch(`${config.workerOrigin}/bridge/${action}`, {
      method: "POST", redirect: "error", cache: "no-store",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.token}` },
      body: JSON.stringify({ ownerId: userId, input }), signal: AbortSignal.timeout(30_000),
    }).catch(() => { throw new ApiError("integration_unavailable"); });
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 403) throw new ApiError("forbidden_origin");
      if (response.status === 404) throw new ApiError("not_found");
      if (response.status === 409) throw new ApiError("conflict");
      throw new ApiError("integration_unavailable");
    }
    // Bound and validate even this trusted process boundary: never forward raw tokens/errors.
    const value = await readJson(new Request(config.workerOrigin, { method: "POST", headers: { "Content-Type": "application/json" }, body: response.body, duplex: "half" } as RequestInit), spec.output, 100_000).catch(() => { throw new ApiError("integration_unavailable"); });
    return privateJson(value);
  } catch (error) { return errorResponse(error); }
}
