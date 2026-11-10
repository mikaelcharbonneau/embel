import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { identityGenerationJobInputSchema, identityTextPolicySchema, type IdentityGenerationJobInput } from "@/domain/identity-jobs";
import { canonicalIdentityInput } from "@/features/identity-directions/model/font-check-binding";
import { ENGINE_BOARD_IMAGE } from "./openai-images";

// Creative directions on the generation engine (docs/generation-engine.md, step 5):
// the kind, the fixed request policy and the run input. Shared by the routes and
// the workflow steps; nothing here calls a database or a provider.

export const IDENTITY_DIRECTIONS_KIND = "identity.directions";
/** Directions per round, each its own board. */
export const IDENTITY_DIRECTION_COUNT = 3;

/** The text policy of a direction's specification: the shared worker's identity.image
 * policy (model, tier, prices and limits), unchanged. */
export const ENGINE_IDENTITY_TEXT_POLICY = identityTextPolicySchema.parse({
  version: 1, model: "gpt-6.1-sol", serviceTier: "default", pricingVersion: "2026-10-03",
  maxInputTokens: 32768, maxOutputTokens: 8192, maxInputBytes: 131072, maxOutputBytes: 65536, deadlineMs: 240000, maxTools: 0,
});

/** Names the engine's direction policy in the batch records, as a shared worker's
 * policy identity does. The database pins the same value
 * (fluid_private.engine_identity_policy), and a test checks they agree. */
export const ENGINE_IDENTITY_POLICY_IDENTITY = createHash("sha256").update(canonicalIdentityInput({
  engine: IDENTITY_DIRECTIONS_KIND, version: 1, handlerVersion: "identity-image-v1",
  textPolicy: ENGINE_IDENTITY_TEXT_POLICY, board: ENGINE_BOARD_IMAGE,
})).digest("hex");

/** What generation_runs.input holds: the batch and job the admission created. The
 * frozen request itself is the batch's job input, written in the same transaction. */
export const identityDirectionsRunInputSchema = z.strictObject({
  version: z.literal(1), revision: z.number().int().positive(), batchId: z.uuid(), jobId: z.uuid(),
});
export type IdentityDirectionsRunInput = z.infer<typeof identityDirectionsRunInputSchema>;

/** The job input the admission froze: always version 3 (built around the chosen logo)
 * under the engine's policy. */
export const engineIdentityJobInputSchema = identityGenerationJobInputSchema.refine(
  (value): value is Extract<IdentityGenerationJobInput, { version: 3 }> => value.version === 3
    && value.policyIdentity === ENGINE_IDENTITY_POLICY_IDENTITY && JSON.stringify(value.textPolicy) === JSON.stringify(ENGINE_IDENTITY_TEXT_POLICY),
  "Engine directions run only the engine's selected-logo policy");
export type EngineIdentityJobInput = Extract<IdentityGenerationJobInput, { version: 3 }>;

const ordinal = z.number().int().min(1).max(IDENTITY_DIRECTION_COUNT);
export const directionOrdinalSchema = ordinal;
/** Output keys: `spec.N.T` for try T of direction N's specification, `board.N` for its board. */
export const specificationOutputKey = (n: number, attempt: number) => `spec.${ordinal.parse(n)}.${z.number().int().min(1).max(9).parse(attempt)}`;
export const boardOutputKey = (n: number) => `board.${ordinal.parse(n)}`;
