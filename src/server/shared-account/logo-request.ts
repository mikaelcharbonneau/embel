import "server-only";
import { z } from "zod";
import type { AuthenticatedContext } from "@/server/auth/context";
import { ApiError } from "@/server/http/errors";
export type SharedLogoAction = "asset_prepare" | "asset_readback" | "command_read" | "command_apply" | "input_prepare" | "input_commit" | "proposal_quote";
const schema = z.strictObject({ version: z.literal(1), token: z.string().regex(/^[a-f0-9]{64}$/u), ownerId: z.uuid(), expiresAt: z.iso.datetime({ offset: true }) });
/** Ownership/intent delegation only. Trusted byte/materialization evidence is
 * never sent to the ordinary customer's issuer. */
export async function issueSharedLogoRequest(auth: AuthenticatedContext, action: SharedLogoAction, project: string, intent: unknown, signal?: AbortSignal) {
  try {
    if (signal?.aborted) throw Error();
    const query = auth.client.rpc("issue_shared_logo_request", { p_action: action, p_arguments: [project, intent] });
    const result = await (signal && typeof query.abortSignal === "function" ? query.abortSignal(signal) : query), proof = schema.safeParse(result.data);
    if (signal?.aborted || result.error || !proof.success || proof.data.ownerId !== auth.userId.toLowerCase() || Date.parse(proof.data.expiresAt) <= Date.now() || Date.parse(proof.data.expiresAt) > Date.now() + 31_000) throw Error();
    return proof.data.token;
  } catch { throw new ApiError("integration_unavailable"); }
}
