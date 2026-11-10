import { z } from "zod";

/** The exact OpenAI Responses request of one Naming generation round. It runs in
 * background mode: the create call returns a receipt number at once, and the
 * worker polls that receipt instead of holding a stream open. */
export const NAMING_GENERATION_PROFILE = "naming_generation_v2" as const;
export const NAMING_GENERATION_FORMAT = "naming_generation_v2" as const;
export const NAMING_GENERATION_REQUEST_BYTES = 131_072;

export const namingGenerationWireSchema = z
  .strictObject({
    model: z.string().min(1).max(150),
    background: z.literal(true),
    store: z.literal(true),
    stream: z.literal(false),
    reasoning: z.strictObject({ effort: z.enum(["low", "medium"]) }),
    max_output_tokens: z.literal(16000),
    input: z.string().min(1).max(125_000),
    text: z.strictObject({
      verbosity: z.literal("low"),
      format: z.strictObject({
        type: z.literal("json_schema"),
        name: z.literal(NAMING_GENERATION_FORMAT),
        strict: z.literal(true),
        schema: z.json(),
      }),
    }),
    metadata: z.strictObject({
      embel_generation_profile: z.literal(NAMING_GENERATION_PROFILE),
      embel_job_id: z.uuid(),
      embel_run_id: z.uuid(),
      embel_round: z.enum(["1", "2", "3"]),
    }),
  })
  .refine(
    (value) => new TextEncoder().encode(JSON.stringify(value)).byteLength <= NAMING_GENERATION_REQUEST_BYTES,
    "The naming request is too large",
  );
export type NamingGenerationWire = z.infer<typeof namingGenerationWireSchema>;
