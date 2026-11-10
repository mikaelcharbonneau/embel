import "server-only";
import { z } from "zod";
import { logoStyleNoteApiPolicySchema } from "@/domain/logo-jobs";
import { LOGO_STYLE_NOTE_VERSION, logoStyleNoteSchema } from "@/domain/logo-style-notes";
import { logoVectorProposalUsageCost, logoVectorProposalUsageSchema } from "@/domain/logo-vector-proposal-jobs";
import type { ResponsesRequest } from "../ai/openai-transport";
import { OPENAI_STRATEGY_MODEL } from "../ai/config";
import { createStyleNoteRequest, type StyleNoteImage } from "../ai/style-note-request";
import { EngineProviderError, isTerminal, type EngineOpenAI } from "./openai";
import type { EngineStorage } from "./storage";
import {
  LOGO_STYLE_NOTE_KIND,
  logoStyleNoteRunInputSchema,
  styleNoteOutputKey,
  type LogoStyleNoteRunInput,
} from "./logo-input";
import type { ClaimedLogoRun, EngineRunCheck } from "./logo-run";

// Style notes for liked uploads on the generation engine: one short structured
// text request per upload (the upload placed on white), in OpenAI background
// mode so an unknown outcome is looked up by response id, never sent twice.
// The request, model, limits and prices are the worker lane's
// (logo-style-note-v1 under Creative direction's text policy).

/** The fixed text policy of a style note. */
export const ENGINE_STYLE_NOTE_POLICY = logoStyleNoteApiPolicySchema.parse({
  version: 1,
  billingMode: "openai_api",
  spendControl: "uncapped",
  handlerVersion: "logo-style-note-v1",
  adapterVersion: "logo-style-note-openai-v1",
  model: OPENAI_STRATEGY_MODEL,
  serviceTier: "default",
  pricingVersion: "2026-10-03",
  maxInputTokens: 32768,
  maxOutputTokens: 4096,
  maxInputBytes: 131072,
  maxOutputBytes: 32768,
  maxStreamBytes: 2097152,
  deadlineMs: 240000,
  maxTools: 0,
  inputMicrousdPerMillionTokens: 2000000,
  cachedInputMicrousdPerMillionTokens: 100000,
  cacheWriteMicrousdPerMillionTokens: 2500000,
  outputMicrousdPerMillionTokens: 10000000,
});

export type StyleNoteRunDeps = {
  openai: EngineOpenAI;
  storage: EngineStorage;
  /** Decodes the upload in the isolated raster child and places it on white. */
  onWhite(bytes: Uint8Array, mimeType: string): Promise<StyleNoteImage>;
  check(runId: string): Promise<EngineRunCheck>;
  save(
    runId: string,
    outputKey: string,
    output: unknown,
    responseId: string | null,
    costMicrousd: number,
  ): Promise<boolean>;
};
export type PreparedStyleNote =
  { referenceId: string; request: ResponsesRequest; requestKey: string } | { referenceId: string; failed: string };
export type StyleNotePoll = { state: "pending" } | { state: "terminal" } | { state: "stop"; code: string };
export type StyleNoteResult = { referenceId: string; state: "written" | "failed" | "stopped"; code: string | null };

export class StyleNoteRunError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "StyleNoteRunError";
  }
}

export function readStyleNoteRun(run: ClaimedLogoRun): LogoStyleNoteRunInput {
  const input = logoStyleNoteRunInputSchema.safeParse(run.input);
  if (
    run.kind !== LOGO_STYLE_NOTE_KIND ||
    !input.success ||
    input.data.references.some((ref) => ref.asset.ownerId !== run.ownerId || ref.asset.projectId !== run.projectId)
  ) {
    throw new StyleNoteRunError("invalid_run_input");
  }
  return input.data;
}
function reference(run: ClaimedLogoRun, referenceId: string) {
  const found = readStyleNoteRun(run).references.find((ref) => ref.referenceId === referenceId);
  if (!found) throw new StyleNoteRunError("invalid_run_input");
  return found;
}
/** Saves the note's outcome for this upload version once; a run that ended keeps what it has. */
async function record(
  deps: StyleNoteRunDeps,
  run: ClaimedLogoRun,
  referenceId: string,
  output: Record<string, unknown>,
  responseId: string | null,
  cost: number,
) {
  const ref = reference(run, referenceId);
  try {
    await deps.save(
      run.id,
      styleNoteOutputKey(referenceId),
      { referenceId, contentHash: ref.asset.contentHash, noteVersion: LOGO_STYLE_NOTE_VERSION, ...output },
      responseId,
      Math.max(0, Math.round(cost)),
    );
  } catch (error) {
    if (!(error instanceof Error && error.message.includes("run_not_running"))) throw error;
  }
}

/** Reads the exact upload, places it on white and builds the one request every
 * attempt would send. Counting input tokens is free. */
export async function prepareStyleNote(
  deps: StyleNoteRunDeps,
  run: ClaimedLogoRun,
  referenceId: string,
): Promise<PreparedStyleNote> {
  const ref = reference(run, referenceId);
  let request: ResponsesRequest;
  try {
    const stored = await deps.storage.get(run, ref.asset);
    if (stored.mimeType !== ref.mimeType) throw new StyleNoteRunError("source_unavailable");
    request = createStyleNoteRequest(await deps.onWhite(stored.bytes, stored.mimeType), ENGINE_STYLE_NOTE_POLICY);
  } catch (error) {
    if (error instanceof Error && error.message === "storage_unavailable") throw error;
    await record(deps, run, referenceId, { status: "failed", code: "source_unavailable" }, null, 0);
    return { referenceId, failed: "source_unavailable" };
  }
  const counted = await deps.openai.countInputTokens(request);
  if (counted > ENGINE_STYLE_NOTE_POLICY.maxInputTokens) {
    await record(deps, run, referenceId, { status: "failed", code: "input_too_large" }, null, 0);
    return { referenceId, failed: "input_too_large" };
  }
  return { referenceId, request, requestKey: `logo-note-${run.id}-${referenceId}` };
}

/** One paid background create; returns the response id the workflow polls. */
export async function createStyleNote(
  openai: EngineOpenAI,
  prepared: Extract<PreparedStyleNote, { request: ResponsesRequest }>,
) {
  const response = await openai.create(prepared.request, prepared.requestKey);
  return { responseId: response.id };
}

export async function pollStyleNote(deps: StyleNoteRunDeps, runId: string, responseId: string): Promise<StyleNotePoll> {
  const state = await deps.check(runId);
  if (state.status !== "running") return { state: "stop", code: "cancelled" };
  if (state.cancelRequested || state.paused)
    return { state: "stop", code: state.paused ? "generation_paused" : "cancelled" };
  const response = await deps.openai.retrieve(responseId);
  return isTerminal(response.status) ? { state: "terminal" } : { state: "pending" };
}

const record_ = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
/** Usage of any response, at the style-note policy's prices; null when OpenAI reported none. */
export function styleNoteCost(body: unknown): number {
  const usage = record_(record_(body)?.usage),
    details = record_(usage?.input_tokens_details);
  const parsed = logoVectorProposalUsageSchema.safeParse({
    inputTokens: usage?.input_tokens,
    cachedInputTokens: details?.cached_tokens ?? 0,
    cacheWriteInputTokens: details?.cache_write_tokens ?? 0,
    outputTokens: usage?.output_tokens,
  });
  return parsed.success ? logoVectorProposalUsageCost(parsed.data) : 0;
}
/** The note text of a completed response, or null when it carries none. */
export function styleNoteFromResponse(body: unknown): z.infer<typeof logoStyleNoteSchema> | null {
  const value = record_(body);
  if (!value || value.status !== "completed" || !Array.isArray(value.output)) return null;
  let text = "";
  for (const item of value.output) {
    const entry = record_(item);
    if (entry?.type !== "message" || !Array.isArray(entry.content)) continue;
    for (const part of entry.content) {
      const content = record_(part);
      if (content?.type === "output_text" && typeof content.text === "string") text += content.text;
    }
  }
  if (Buffer.byteLength(text) > ENGINE_STYLE_NOTE_POLICY.maxOutputBytes) return null;
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const note = logoStyleNoteSchema.safeParse(json);
  return note.success && (note.data.symbol || note.data.lettering) ? note.data : null;
}

/** Saves the finished note (or why there is none) with its response id and cost. */
export async function settleStyleNote(
  deps: StyleNoteRunDeps,
  run: ClaimedLogoRun,
  referenceId: string,
  responseId: string,
): Promise<StyleNoteResult> {
  const response = await deps.openai.retrieve(responseId);
  if (!isTerminal(response.status)) throw new EngineProviderError("retry", null);
  const note = styleNoteFromResponse(response.body),
    cost = styleNoteCost(response.body);
  if (note) {
    await record(
      deps,
      run,
      referenceId,
      { status: "written", symbol: note.symbol, lettering: note.lettering },
      response.id,
      cost,
    );
    return { referenceId, state: "written", code: null };
  }
  const code = response.status === "completed" ? "invalid_output" : `provider_${response.status}`;
  await record(deps, run, referenceId, { status: "failed", code }, response.id, cost);
  return { referenceId, state: "failed", code };
}

/** Cancels the open response at OpenAI and records what it cost so far. */
export async function stopStyleNote(
  deps: StyleNoteRunDeps,
  run: ClaimedLogoRun,
  referenceId: string,
  responseId: string,
  code: string,
): Promise<StyleNoteResult> {
  let body: unknown = null;
  try {
    body = (await deps.openai.cancel(responseId)).body;
  } catch (error) {
    if (!(error instanceof EngineProviderError) || error.disposition !== "rejected") throw error;
  }
  await record(deps, run, referenceId, { status: "failed", code }, responseId, styleNoteCost(body));
  return { referenceId, state: code === "provider_timeout" ? "failed" : "stopped", code };
}

/** A create whose outcome is unknown is never sent again: that note fails. */
export async function failStyleNote(
  deps: StyleNoteRunDeps,
  run: ClaimedLogoRun,
  referenceId: string,
  code: string,
): Promise<StyleNoteResult> {
  await record(
    deps,
    run,
    referenceId,
    { status: "failed", code: /^[a-z_]{1,64}$/u.test(code) ? code : "generation_failed" },
    null,
    0,
  );
  return { referenceId, state: "failed", code };
}
