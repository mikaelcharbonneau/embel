import "server-only";
import { z } from "zod";
import type { AuthenticatedContext } from "@/server/auth/context";
import { ApiError } from "@/server/http/errors";

const delegation = z.strictObject({ version: z.literal(1), token: z.string().regex(/^[a-f0-9]{64}$/u), ownerId: z.uuid(), expiresAt: z.iso.datetime({ offset: true }) });
export async function issueSharedAccountRequest(auth: AuthenticatedContext, lane: "identity" | "home", action: "identity" | "prepare" | "lookup" | "resolve" | "readback" | "save" | "lookup_project", args: unknown[], signal?: AbortSignal): Promise<string> {
  const unavailable = () => new ApiError("integration_unavailable");
  if (signal?.aborted || !z.uuid().safeParse(auth.userId).success) throw unavailable();
  try {
    const query = auth.client.rpc("issue_shared_account_request", { p_lane: lane, p_action: action, p_arguments: args });
    const result = await (signal && typeof query.abortSignal === "function" ? query.abortSignal(signal) : query);
    const parsed = delegation.safeParse(result.data);
    if (signal?.aborted || result.error || !parsed.success || parsed.data.ownerId !== auth.userId.toLowerCase()
      || Date.parse(parsed.data.expiresAt) <= Date.now() || Date.parse(parsed.data.expiresAt) > Date.now() + 31_000) throw unavailable();
    return parsed.data.token;
  } catch { throw unavailable(); }
}
