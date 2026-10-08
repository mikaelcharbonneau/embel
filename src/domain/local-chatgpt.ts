import { z } from "zod";

export const localRegistrationIdSchema = z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/);
export const localModelSchema = z.strictObject({ slug: z.string().min(1).max(150), displayName: z.string().min(1).max(200) });
export const localChatGPTStatusSchema = z.strictObject({
  connectionAllowed: z.boolean(),
  registrations: z.array(z.strictObject({ registrationId: localRegistrationIdSchema, email: z.string().max(320).nullable(), planUsageEnabled: z.boolean() })).max(50),
  selectedRegistrationId: localRegistrationIdSchema.nullable(),
  model: z.string().max(150).nullable(),
  workerReady: z.boolean(),
  images: z.strictObject({ status: z.literal("unavailable"), reason: z.literal("spending_limit_required") }),
});
export type LocalChatGPTStatus = z.infer<typeof localChatGPTStatusSchema>;
export const localChatGPTModelsSchema = z.strictObject({ registrationId: localRegistrationIdSchema, models: z.array(localModelSchema).max(600) });
export const localSignInSchema = z.strictObject({ registrationId: localRegistrationIdSchema.optional() });
export const localRegistrationSelectionSchema = z.strictObject({ registrationId: localRegistrationIdSchema });
export const localModelSelectionSchema = z.strictObject({ registrationId: localRegistrationIdSchema, model: z.string().min(1).max(150) });
export const localSignOutResponseSchema = z.strictObject({ disconnected: z.literal(true), remoteRevocationConfirmed: z.boolean() });
export const localSignInResponseSchema = z.strictObject({ authorizationUrl: z.url().refine(value => {
  const url = new URL(value);
  return url.origin === "https://auth.openai.com" && url.pathname === "/api/accounts/authorize" &&
    !url.username && !url.password && !url.hash &&
    !["id_token_hint", "access_token", "refresh_token", "id_token", "client_secret", "code_verifier"].some(key => url.searchParams.has(key));
}) });
