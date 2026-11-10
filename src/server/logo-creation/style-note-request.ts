import "server-only";
import { logoStyleNoteApiPolicySchema, type LogoStyleNoteApiPolicy } from "../../domain/logo-jobs";
import { LOGO_STYLE_NOTE_INSTRUCTION, LOGO_STYLE_NOTE_JSON_SCHEMA } from "../../domain/logo-style-notes";

/** A liked upload, decoded and placed on white, ready to describe. */
export type StyleNoteImage = { bytes: Uint8Array; mimeType: "image/png" | "image/jpeg" };

/** One structured request: the fixed instruction and the upload on white.
 * Shared by the worker lane and the generation engine. */
export function createStyleNoteRequest(image: StyleNoteImage, rawPolicy: LogoStyleNoteApiPolicy) {
 const policy = logoStyleNoteApiPolicySchema.parse(rawPolicy);
 if (!(image.bytes instanceof Uint8Array) || !image.bytes.byteLength || !["image/png", "image/jpeg"].includes(image.mimeType)) throw Error("style_note_input_unavailable");
 const request = { model: policy.model, input: [{ role: "user", content: [{ type: "input_text", text: LOGO_STYLE_NOTE_INSTRUCTION },
   { type: "input_image", image_url: `data:${image.mimeType};base64,${Buffer.from(image.bytes).toString("base64")}`, detail: "high" }] }],
  text: { format: { type: "json_schema", name: "logo_style_note", strict: true, schema: LOGO_STYLE_NOTE_JSON_SCHEMA } },
  reasoning: { effort: "low" }, max_output_tokens: policy.maxOutputTokens, service_tier: policy.serviceTier, store: false, background: false,
  stream: false, parallel_tool_calls: false, truncation: "disabled", tools: [], tool_choice: "none" };
 if (Buffer.byteLength(JSON.stringify(request)) > policy.maxInputBytes) throw Error("style_note_input_unavailable");
 return request;
}
