import { z } from "zod";

// Official documentation verified 2026-11-09; not proof of account access or inference.
/** Shared Logo concepts and refinements and Creative direction boards. Released
 * 2026-10-28 as an alias only; OpenAI publishes no dated snapshot for it. */
export const IMAGE_MODEL = "gpt-image-2.6-sunburst" as const;
/** The earlier capped Logo policies (maxCostMicrousd), which still pin this snapshot. */
export const CAPPED_LOGO_IMAGE_MODEL = "gpt-image-2.5-sunburst-2026-09-08" as const;
export type LogoImageModel = typeof IMAGE_MODEL | typeof CAPPED_LOGO_IMAGE_MODEL;
/** The model a shared worker policy names. Production's shared worker still runs the
 * 2.5 snapshot: the packet that would move it (supabase/archive/candidates/shared_image_model_2_6.sql)
 * is not applied, and the generation engine draws Logo images with IMAGE_MODEL instead.
 * Old-path readers accept either, so the old path keeps working until it is retired. */
export const sharedImageModelSchema = z.enum([IMAGE_MODEL, CAPPED_LOGO_IMAGE_MODEL]);
export const textOperationSchema = z.enum([
  "strategy.reformulate",
  "strategy.competitors",
  "strategy.audience",
  "strategy.personality",
  "strategy.positioning",
  "strategy.slogan",
  "naming.generate",
  "ideas.explore",
]);
export type TextOperation = z.infer<typeof textOperationSchema>;
export const operationSchema = z.enum([
  ...textOperationSchema.options,
  "identity.image",
  "identity.vector",
  "brand.export",
  "identity.logo_concept",
  "identity.logo_refine",
  "identity.logo_vectorize",
  "identity.logo_directions",
  "identity.logo_export",
  "identity.logo_vector_propose",
  "identity.logo_style_note",
]);
export type Operation = z.infer<typeof operationSchema>;

export const providerFailureSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("ambiguous"),
    message: z.string().max(1000),
    retrySafe: z.literal(false),
    requestId: z.string().optional(),
  }),
  z.strictObject({ kind: z.literal("refusal"), message: z.string().max(1000), retrySafe: z.literal(false) }),
  z.strictObject({ kind: z.literal("invalid_output"), message: z.string().max(1000), retrySafe: z.literal(false) }),
  z.strictObject({ kind: z.literal("incomplete"), message: z.string().max(1000), retrySafe: z.literal(false) }),
  z.strictObject({ kind: z.literal("not_dispatched"), message: z.string().max(1000), retrySafe: z.literal(true) }),
]);

export type ModelRoutingConfiguration = {
  paidCallsApproved: boolean;
  credentialsPresent: boolean;
  verifiedModelIds: readonly string[];
  textModels: Partial<Record<TextOperation, string>>;
};

export type ModelRoute =
  | { status: "ready"; provider: "openai"; model: string; liveValidated: false }
  | {
      status: "blocked";
      reason:
        | "budget_not_approved"
        | "credentials_missing"
        | "model_not_selected"
        | "model_access_unverified"
        | "pipeline_not_implemented";
    };

export function resolveModelRoute(operation: Operation, config: ModelRoutingConfiguration): ModelRoute {
  if (operation === "identity.vector" || operation === "brand.export")
    return { status: "blocked", reason: "pipeline_not_implemented" };
  if (!config.paidCallsApproved) return { status: "blocked", reason: "budget_not_approved" };
  if (!config.credentialsPresent) return { status: "blocked", reason: "credentials_missing" };
  // Logo-first operations use their separately reviewed policy/handler pipeline.
  // Recognition by the generic job schema never grants this legacy route access.
  const textOperation = textOperationSchema.safeParse(operation);
  if (operation !== "identity.image" && !textOperation.success)
    return { status: "blocked", reason: "pipeline_not_implemented" };
  const model = operation === "identity.image" ? IMAGE_MODEL : config.textModels[textOperation.data!];
  if (!model?.trim()) return { status: "blocked", reason: "model_not_selected" };
  if (!config.verifiedModelIds.includes(model)) return { status: "blocked", reason: "model_access_unverified" };
  return { status: "ready", provider: "openai", model, liveValidated: false };
}
