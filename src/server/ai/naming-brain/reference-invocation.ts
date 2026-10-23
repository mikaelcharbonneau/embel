import { z } from "zod";

const identifier = z.string().min(1).max(300), hash = z.string().regex(/^[a-f0-9]{64}$/u);
export const namingReferenceArgumentsSchema = z.strictObject({ url: z.string().min(1).max(2000) });
export function parseNamingReferenceArguments(value: unknown) {
  return namingReferenceArgumentsSchema.parse(typeof value === "string" ? JSON.parse(value) : value);
}

/** A request to run a tool, distinct from a completed provider item or a retrieved page.
 * Both argument representations are frozen; the parsed hash binds their shared URL. */
export const namingReferenceInvocationSchema = z.strictObject({
  version: z.literal(1), kind: z.literal("required_action"), providerCallKey: identifier,
  requestHash: hash, sessionId: identifier, turnId: identifier, callId: identifier, itemId: identifier,
  actionArgumentsHash: hash, itemArgumentsHash: hash, parsedArgumentsHash: hash,
});
export type NamingReferenceInvocation = z.infer<typeof namingReferenceInvocationSchema>;
