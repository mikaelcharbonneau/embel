import "server-only";
import { z } from "zod";
import { identityAvailabilitySchema, identityGenerationIntentSchema, type IdentityAvailability } from "@/domain/identity-jobs";
import { IMAGE_MODEL } from "@/domain/providers";
import type { AuthenticatedContext } from "../auth/context";
import { ApiError } from "../http/errors";

/** Verify the project even when the operation is unavailable; never reveal foreign metadata. */
export async function getIdentityAvailability(auth: AuthenticatedContext, projectId: string): Promise<IdentityAvailability> {
  if (!z.uuid().safeParse(projectId).success) throw new ApiError("not_found");
  projectId = projectId.toLowerCase();
  const { data, error } = await auth.client.from("projects").select("id,owner_id")
    .eq("id", projectId).eq("owner_id", auth.userId).maybeSingle();
  if (error) throw new ApiError("integration_unavailable");
  if (!data || data.id !== projectId || data.owner_id !== auth.userId) throw new ApiError("not_found");
  return identityAvailabilitySchema.parse({ ownerId: auth.userId, projectId, status: "unavailable", operation: "identity.image", requestedModel: IMAGE_MODEL, reason: "pipeline_not_implemented" });
}

/** No queue insertion or provider dispatch until the actual Identity pipeline is implemented. */
export async function enqueueIdentityBatch(auth: AuthenticatedContext, projectId: string, input: unknown): Promise<never> {
  if (!identityGenerationIntentSchema.safeParse(input).success) throw new ApiError("invalid_input");
  await getIdentityAvailability(auth, projectId);
  throw new ApiError("integration_unavailable");
}
