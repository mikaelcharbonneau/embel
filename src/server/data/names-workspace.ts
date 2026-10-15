import "server-only";
import {
  MAX_NAMES_BYTES, NAMES_WORKSPACE_MUTATION_MAX_BYTES, namesWorkspaceResponseSchema,
  saveNamesWorkspaceInputSchema, type NamesWorkspaceResponse,
} from "@/domain/names-workspace";
import type { AuthenticatedContext } from "../auth/context";
import { ApiError } from "../http/errors";

function rpcCode(error: unknown): unknown {
  if (!error || typeof error !== "object") return undefined;
  try {
    const code = Object.getOwnPropertyDescriptor(error, "code");
    return code && "value" in code ? code.value : undefined;
  } catch { return undefined; }
}

async function rpc(auth: AuthenticatedContext, name: "get_names_workspace" | "save_names_workspace", args: Record<string, unknown>) {
  let result;
  try { result = await auth.client.rpc(name, args); }
  catch { throw new ApiError("integration_unavailable"); }
  if (result.error) {
    const code = rpcCode(result.error);
    if (code === "42501") throw new ApiError("unauthenticated");
    if (code === "PT409" || code === "40001" || code === "23505") throw new ApiError("conflict");
    if (code === "54000") throw new ApiError("body_too_large");
    if (code === "22023" || code === "22P02" || code === "22003" || code === "23514" || code === "23502") throw new ApiError("invalid_input");
    throw new ApiError("integration_unavailable");
  }
  return result.data;
}

function verifiedResponse(auth: AuthenticatedContext, raw: unknown): NamesWorkspaceResponse {
  const result = namesWorkspaceResponseSchema.safeParse(raw);
  if (!result.success || result.data.ownerId !== auth.userId.toLowerCase() ||
      (result.data.workspace && Buffer.byteLength(JSON.stringify(result.data.workspace.payload), "utf8") > MAX_NAMES_BYTES)) {
    throw new ApiError("integration_unavailable");
  }
  return result.data;
}

/** Strict V1 validation replays every deterministic history before exposing stored data. */
export async function getNamesWorkspace(auth: AuthenticatedContext): Promise<NamesWorkspaceResponse> {
  return verifiedResponse(auth, await rpc(auth, "get_names_workspace", {}));
}

export async function saveNamesWorkspace(auth: AuthenticatedContext, raw: unknown): Promise<NamesWorkspaceResponse> {
  const parsed = saveNamesWorkspaceInputSchema.safeParse(raw);
  if (!parsed.success) throw new ApiError("invalid_input");
  const input = parsed.data;
  if (Buffer.byteLength(JSON.stringify(input.payload), "utf8") > MAX_NAMES_BYTES ||
      Buffer.byteLength(JSON.stringify(input), "utf8") > NAMES_WORKSPACE_MUTATION_MAX_BYTES) {
    throw new ApiError("body_too_large");
  }
  const response = verifiedResponse(auth, await rpc(auth, "save_names_workspace", {
    p_expected_revision: input.expectedRevision, p_request_key: input.requestKey, p_payload: input.payload,
  }));
  // The receipt binds the original write even if another tab saved a later revision.
  // Never replace an uncertain save with a fresh request key or a read-then-write.
  if (!response.workspace || response.workspace.revision !== input.expectedRevision + 1 ||
      JSON.stringify(response.workspace.payload) !== JSON.stringify(input.payload)) {
    throw new ApiError("integration_unavailable");
  }
  return response;
}
