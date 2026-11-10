import { z } from "zod";

/** Explicit UI answers, separate from immutable generation preferences and hashes. */
export const namingChatCheckpointSchema = z.strictObject({
  version: z.literal(1),
  preferencesVersion: z.number().int().min(1).max(2_147_483_647),
  confirmed: z.strictObject({
    approaches: z.string().max(400).optional(),
    directness: z.string().max(32).optional(),
    language: z.string().max(200).optional(),
    length: z.string().max(32).optional(),
    fragments: z.string().max(13_200).optional(),
  }),
});
export type NamingChatCheckpoint = z.infer<typeof namingChatCheckpointSchema>;
