import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { logoMutationReceiptSchema, type LogoMutationReceipt } from "@/domain/logo-workspace";
import {
  initializeExistingBrandLogoInputSchema,
  isExistingBrandLogoReceipt,
  serializeLogoInitialization,
  logoInitializationRejectionSchema,
  type LogoInitializationRejection,
  type InitializeExistingBrandLogoInput,
} from "@/features/logo-creation/model/existing-brand";
import type { AuthenticatedContext } from "@/server/auth/context";
import { ApiError } from "@/server/http/errors";
import {
  logoDatabaseError,
  logoId,
  logoOwner,
  LogoUncertainCommitError,
  parseLogoInput,
  parseLogoStored,
} from "./logo-transaction";

/** Emitted only after a committed owner/key/body-bound database tombstone. */
export class LogoInitializationRejectedError extends ApiError {
  readonly rejection: LogoInitializationRejection;
  constructor(ownerId: string, projectId: string, input: InitializeExistingBrandLogoInput) {
    super("conflict");
    this.name = "LogoInitializationRejectedError";
    this.rejection = {
      status: "rejected",
      ownerId,
      projectId,
      requestKey: input.requestKey,
      inputHash: createHash("sha256").update(serializeLogoInitialization(input), "utf8").digest("hex"),
    };
  }
}
const committedRejectionSchema = z.strictObject({
  kind: z.literal("logo_initialization_rejected"),
  rejection: logoInitializationRejectionSchema
    .omit({ inputHash: true })
    .extend({ input: initializeExistingBrandLogoInputSchema }),
});

/** Starts only the first V2 brief on an existing owned project. SQL owns the
 * project-first lock, all-head CAS and exact-key receipt. No provider or job. */
export async function initializeExistingBrandLogo(
  auth: AuthenticatedContext,
  projectId: string,
  input: unknown,
  signal?: AbortSignal,
): Promise<LogoMutationReceipt> {
  const ownerId = logoOwner(auth);
  projectId = logoId(projectId);
  const body = parseLogoInput(initializeExistingBrandLogoInputSchema, input);
  const command = { method: "saveLogoBrief" as const, body };
  if (signal?.aborted) throw new ApiError("integration_unavailable");
  let response: { data: unknown; error: unknown };
  try {
    const pending = auth.client.rpc("initialize_existing_brand_logo", { p_project_id: projectId, p_input: body });
    response = await (signal ? pending.abortSignal(signal) : pending);
  } catch {
    throw new LogoUncertainCommitError(projectId, command);
  }
  if (response.error) {
    const error = logoDatabaseError(response.error);
    if (error.code === "integration_unavailable") throw new LogoUncertainCommitError(projectId, command);
    throw error;
  }
  const rejected = committedRejectionSchema.safeParse(response.data);
  if (rejected.success) {
    const proof = rejected.data.rejection;
    if (
      signal?.aborted ||
      proof.ownerId !== ownerId ||
      proof.projectId !== projectId ||
      proof.requestKey !== body.requestKey ||
      serializeLogoInitialization(proof.input) !== serializeLogoInitialization(body)
    )
      throw new LogoUncertainCommitError(projectId, command);
    throw new LogoInitializationRejectedError(ownerId, projectId, body);
  }
  try {
    if (signal?.aborted) throw new ApiError("integration_unavailable");
    const receipt = parseLogoStored(logoMutationReceiptSchema, response.data);
    if (receipt.ownerId !== ownerId || receipt.projectId !== projectId || !isExistingBrandLogoReceipt(receipt, body))
      throw new ApiError("integration_unavailable");
    return receipt;
  } catch {
    throw new LogoUncertainCommitError(projectId, command);
  }
}
