import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { supportedBrandBoardTypography } from "@/domain/brand-board-fonts";
import { identitySystemSpecificationSchema, type IdentitySystemSpecification } from "@/domain/identity-jobs";
import { IMAGE_INPUT_LIMITS } from "@/domain/logo-image-limits";
import type { VerifiedAssetBytes } from "@/domain/logo-deliverables";
import { logoVectorProposalUsageCost, logoVectorProposalUsageSchema } from "@/domain/logo-vector-proposal-jobs";
import { IMAGE_MODEL } from "@/domain/providers";
import { createIdentitySpecificationRequest, identityBoardPrompt } from "../ai/identity-direction-requests";
import type { ResponsesRequest } from "../ai/openai-transport";
import { logServerError } from "../http/errors";
import {
  boardOutputKey,
  directionOrdinalSchema,
  ENGINE_IDENTITY_TEXT_POLICY,
  engineIdentityJobInputSchema,
  IDENTITY_DIRECTIONS_KIND,
  identityDirectionsRunInputSchema,
  specificationOutputKey,
  type EngineIdentityJobInput,
} from "./identity-input";
import { EngineProviderError, isTerminal, type EngineOpenAI } from "./openai";
import { ENGINE_BOARD_IMAGE, EngineImageRejectedError, type EngineImages } from "./openai-images";
import { EngineStorageError, type EngineStorage } from "./storage";

// The Creative directions workflow's step logic, with the database, OpenAI,
// Storage and the raster check passed in so tests can stub all of them. Each
// exported function is one durable step.
//
// A direction is two paid calls: its specification (text, OpenAI background
// mode: created once, then looked up by response id) and its board (one Images
// API call). Every try is marked as sent in the database before it is sent, so a
// step that runs again after a crash never pays twice: it fails that direction.

export type EngineRunCheck = { status: string; cancelRequested: boolean; paused: boolean };
/** The run as engine_claim returns it. */
export type ClaimedIdentityRun = { id: string; ownerId: string; projectId: string; kind: string; input: unknown };
export type IdentityEngineDb = {
  check(runId: string): Promise<EngineRunCheck>;
  /** fluid_private.engine_identity_begin */
  begin(runId: string): Promise<unknown>;
  /** fluid_private.engine_identity_save_board */
  saveBoard(
    runId: string,
    ordinal: number,
    board: unknown,
    responseId: string | null,
    costMicrousd: number,
  ): Promise<unknown>;
  /** fluid_private.engine_save_output; false when the key was already saved. */
  saveOutput(
    runId: string,
    key: string,
    output: unknown,
    responseId: string | null,
    costMicrousd: number,
  ): Promise<boolean>;
};
export type IdentityRunDeps = {
  db: IdentityEngineDb;
  openai: EngineOpenAI;
  images: EngineImages;
  storage: EngineStorage;
  /** Decodes an image in the isolated raster child. */
  inspect(bytes: Uint8Array, mimeType: string): Promise<{ width: number; height: number }>;
  newId(): string;
  now(): Date;
};

/** A known, permanent reason the run can't continue. Its code becomes the run's error code. */
export class IdentityRunError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "IdentityRunError";
  }
}

type Components = IdentitySystemSpecification["components"];
/** Paid tries of one specification whose reply was unusable. */
export const SPECIFICATION_PAID_TRIES = 2;
/** Tries of one call while nothing was sent (429, 5xx, no connection). */
export const IDENTITY_SEND_TRIES = 3;
const ERROR_CODE = /^[a-z][a-z_]{0,63}$/u;
const SAVE_TRIES = 3;
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const runEnded = (error: unknown) => error instanceof Error && /run_not_running/u.test(error.message);
const codeOf = (code: string) => (ERROR_CODE.test(code) ? code : "generation_failed");
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const beginSchema = z.object({
  batchId: z.uuid(),
  jobId: z.uuid(),
  job: z.unknown(),
  pending: z.array(directionOrdinalSchema).max(3),
  prior: z.array(z.record(z.string(), z.unknown())).max(3),
});
/** The round as the admission froze it: the run's batch and the batch's job input. */
export async function readIdentityRound(deps: Pick<IdentityRunDeps, "db">, run: ClaimedIdentityRun) {
  const input = identityDirectionsRunInputSchema.safeParse(run.input);
  if (run.kind !== IDENTITY_DIRECTIONS_KIND || !input.success) throw new IdentityRunError("invalid_run_input");
  const begun = beginSchema.safeParse(await deps.db.begin(run.id));
  const job = engineIdentityJobInputSchema.safeParse(begun.success ? begun.data.job : null);
  if (
    !begun.success ||
    !job.success ||
    begun.data.batchId !== input.data.batchId ||
    begun.data.jobId !== input.data.jobId ||
    job.data.batchId !== input.data.batchId ||
    job.data.ownerId !== run.ownerId ||
    job.data.projectId !== run.projectId
  ) {
    throw new IdentityRunError("invalid_run_input");
  }
  return {
    job: job.data as EngineIdentityJobInput,
    pending: begun.data.pending,
    prior: begun.data.prior as Components[],
  };
}

/** Opens a claimed round: which directions are still to make, and the components of
 * the directions already saved (a later direction must differ from them). */
export async function beginIdentityDirections(
  deps: Pick<IdentityRunDeps, "db">,
  run: ClaimedIdentityRun,
): Promise<{ pending: number[]; prior: Components[] }> {
  const { pending, prior } = await readIdentityRound(deps, run);
  return { pending, prior };
}

// Specifications ------------------------------------------------------------------

export type PreparedSpecification =
  { ordinal: number; request: ResponsesRequest; requestKey: string } | { ordinal: number; failed: string };
export type SpecificationSend =
  | { state: "sent"; responseId: string }
  | { state: "retry"; retryAfterMs: number | null }
  | { state: "failed"; code: string }
  | { state: "stopped" };
export type SpecificationPoll = { state: "pending" } | { state: "terminal" } | { state: "stop"; code: string };
export type SpecificationResult =
  | { state: "ready"; specification: IdentitySystemSpecification }
  | { state: "invalid"; code: string }
  | { state: "failed"; code: string }
  | { state: "stopped" };

/** Saves one try's outcome once; a run that already ended keeps what it has. */
async function saveTry(
  deps: Pick<IdentityRunDeps, "db">,
  runId: string,
  key: string,
  output: Record<string, unknown>,
  responseId: string | null,
  cost: number,
) {
  try {
    await deps.db.saveOutput(runId, key, output, responseId, Math.max(0, Math.round(cost)));
  } catch (error) {
    if (!runEnded(error)) throw error;
  }
}

/** Builds the one request every try of direction `ordinal` sends: the shared worker's
 * exact specification request, with the round's earlier directions as prior systems.
 * Counting input tokens is free. */
export async function prepareSpecification(
  deps: Pick<IdentityRunDeps, "db" | "openai">,
  run: ClaimedIdentityRun,
  ordinal: number,
  prior: readonly Components[],
): Promise<PreparedSpecification> {
  const n = directionOrdinalSchema.parse(ordinal);
  const { job } = await readIdentityRound(deps, run);
  let request: ResponsesRequest;
  try {
    request = createIdentitySpecificationRequest(
      job.input,
      prior.map((components) => ({ components })),
      n,
      job.textPolicy,
      job.sourceLogo,
    );
  } catch {
    return { ordinal: n, failed: "unsupported_brand_text" };
  }
  if (Buffer.byteLength(JSON.stringify(request)) > ENGINE_IDENTITY_TEXT_POLICY.maxInputBytes)
    return { ordinal: n, failed: "input_too_large" };
  const counted = await deps.openai.countInputTokens(request);
  if (!Number.isSafeInteger(counted) || counted < 0 || counted > ENGINE_IDENTITY_TEXT_POLICY.maxInputTokens)
    return { ordinal: n, failed: "input_too_large" };
  return { ordinal: n, request, requestKey: `identity-${run.id}-spec-${n}` };
}

/**
 * One paid background create, once per try:
 * - nothing was sent (429, 5xx, no connection): `retry`, and the workflow tries again later;
 * - refused: the direction fails;
 * - unclear, or this try was already started: the direction fails and is never sent again.
 */
export async function createSpecification(
  deps: Pick<IdentityRunDeps, "db" | "openai" | "now">,
  run: ClaimedIdentityRun,
  prepared: Extract<PreparedSpecification, { request: ResponsesRequest }>,
  attempt: number,
): Promise<SpecificationSend> {
  const n = directionOrdinalSchema.parse(prepared.ordinal);
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > IDENTITY_SEND_TRIES)
    throw new IdentityRunError("invalid_run_input");
  try {
    if (
      !(await deps.db.saveOutput(
        run.id,
        `sent.${specificationOutputKey(n, attempt)}`,
        { sentAt: deps.now().toISOString() },
        null,
        0,
      ))
    ) {
      return { state: "failed", code: "send_interrupted" };
    }
  } catch (error) {
    if (runEnded(error)) return { state: "stopped" };
    return { state: "retry", retryAfterMs: null };
  }
  try {
    return {
      state: "sent",
      responseId: (await deps.openai.create(prepared.request, `${prepared.requestKey}-${attempt}`)).id,
    };
  } catch (error) {
    if (error instanceof EngineProviderError && error.disposition === "retry")
      return { state: "retry", retryAfterMs: error.retryAfterMs };
    return {
      state: "failed",
      code:
        error instanceof EngineProviderError && error.disposition === "rejected"
          ? "provider_rejected"
          : "send_interrupted",
    };
  }
}

/** Looks the response up by id, or tells the workflow to stop. */
export async function pollSpecification(
  deps: Pick<IdentityRunDeps, "db" | "openai">,
  runId: string,
  responseId: string,
): Promise<SpecificationPoll> {
  const state = await deps.db.check(runId);
  if (state.status !== "running") return { state: "stop", code: "cancelled" };
  if (state.cancelRequested || state.paused)
    return { state: "stop", code: state.paused ? "generation_paused" : "cancelled" };
  const response = await deps.openai.retrieve(responseId);
  return isTerminal(response.status) ? { state: "terminal" } : { state: "pending" };
}

/** Estimated from reported usage at the text policy's prices; zero when OpenAI reported none. */
export function specificationCost(body: unknown): number {
  const usage = record(record(body)?.usage),
    details = record(usage?.input_tokens_details);
  const parsed = logoVectorProposalUsageSchema.safeParse({
    inputTokens: usage?.input_tokens,
    cachedInputTokens: details?.cached_tokens ?? 0,
    cacheWriteInputTokens: details?.cache_write_tokens ?? 0,
    outputTokens: usage?.output_tokens,
  });
  return parsed.success ? logoVectorProposalUsageCost(parsed.data) : 0;
}

/**
 * The specification in a finished response, checked as the shared worker checks it:
 * one completed assistant message with one JSON text, the policy's model and tier,
 * complete usage within the limits, a valid specification with an application
 * design and typography the board fonts support for the brand name, and different
 * from the round's earlier directions.
 */
export function specificationFromResponse(
  body: unknown,
  brandName: string,
  prior: readonly Components[],
): { specification: IdentitySystemSpecification } | { code: string } {
  const policy = ENGINE_IDENTITY_TEXT_POLICY,
    value = record(body);
  if (
    !value ||
    value.status !== "completed" ||
    value.error != null ||
    value.incomplete_details != null ||
    typeof value.id !== "string" ||
    !value.id.startsWith("resp_") ||
    value.model !== policy.model ||
    value.service_tier !== policy.serviceTier
  )
    return { code: "invalid_output" };
  const usage = record(value.usage),
    details = record(usage?.input_tokens_details);
  const parsedUsage = logoVectorProposalUsageSchema.safeParse({
    inputTokens: usage?.input_tokens,
    cachedInputTokens: details?.cached_tokens,
    cacheWriteInputTokens: details?.cache_write_tokens,
    outputTokens: usage?.output_tokens,
  });
  if (
    !parsedUsage.success ||
    usage?.total_tokens !== parsedUsage.data.inputTokens + parsedUsage.data.outputTokens ||
    parsedUsage.data.inputTokens > policy.maxInputTokens ||
    parsedUsage.data.outputTokens > policy.maxOutputTokens
  )
    return { code: "invalid_output" };
  const messages = (Array.isArray(value.output) ? value.output : []).filter(
    (item) => record(item)?.type !== "reasoning",
  );
  const message = messages.length === 1 ? record(messages[0]) : null,
    parts = Array.isArray(message?.content) ? message.content : [];
  const part = parts.length === 1 ? record(parts[0]) : null;
  if (
    message?.type !== "message" ||
    message.role !== "assistant" ||
    message.status !== "completed" ||
    part?.type !== "output_text" ||
    typeof part.text !== "string" ||
    Buffer.byteLength(part.text) > policy.maxOutputBytes
  )
    return { code: "invalid_output" };
  let json: unknown;
  try {
    json = JSON.parse(part.text);
  } catch {
    return { code: "invalid_output" };
  }
  const specification = identitySystemSpecificationSchema.safeParse(json);
  if (
    !specification.success ||
    !specification.data.applicationDesign ||
    !specification.data.components.typography.styles.every((style) => supportedBrandBoardTypography(style, brandName))
  )
    return { code: "invalid_output" };
  if (prior.some((components) => same(components, specification.data.components)))
    return { code: "duplicate_identity_direction" };
  return { specification: specification.data };
}

/** Reads the finished response and saves its outcome (`spec.N.T`) with its response id and cost. */
export async function settleSpecification(
  deps: Pick<IdentityRunDeps, "db" | "openai">,
  run: ClaimedIdentityRun,
  ordinal: number,
  attempt: number,
  responseId: string,
  prior: readonly Components[],
): Promise<SpecificationResult> {
  const n = directionOrdinalSchema.parse(ordinal),
    key = specificationOutputKey(n, attempt);
  const { job } = await readIdentityRound(deps, run);
  const response = await deps.openai.retrieve(responseId);
  if (!isTerminal(response.status)) throw new EngineProviderError("retry", null);
  const cost = specificationCost(response.body);
  if (response.status !== "completed") {
    const code = `provider_${response.status}`;
    await saveTry(deps, run.id, key, { state: "failed", code }, response.id, cost);
    return { state: "failed", code };
  }
  const result = specificationFromResponse(response.body, job.sourceLogo.brief.payload.name, prior);
  if ("code" in result) {
    await saveTry(deps, run.id, key, { state: "invalid", code: result.code }, response.id, cost);
    return { state: "invalid", code: result.code };
  }
  await saveTry(deps, run.id, key, { state: "ready", specification: result.specification }, response.id, cost);
  return { state: "ready", specification: result.specification };
}

/** Cancels the open response at OpenAI and records what it cost so far. */
export async function stopSpecification(
  deps: Pick<IdentityRunDeps, "db" | "openai">,
  run: ClaimedIdentityRun,
  ordinal: number,
  attempt: number,
  responseId: string,
  code: string,
): Promise<SpecificationResult> {
  let body: unknown = null;
  try {
    body = (await deps.openai.cancel(responseId)).body;
  } catch (error) {
    if (!(error instanceof EngineProviderError) || error.disposition !== "rejected") throw error;
  }
  await saveTry(
    deps,
    run.id,
    specificationOutputKey(ordinal, attempt),
    { state: "stopped", code: codeOf(code) },
    responseId,
    specificationCost(body),
  );
  return code === "provider_timeout" ? { state: "failed", code } : { state: "stopped" };
}

// Boards ------------------------------------------------------------------------------

/** One board's end: saved (delivered or failed), not delivered because the run had
 * stopped, or to be tried again because nothing was drawn. */
export type BoardResult =
  | { state: "succeeded" | "failed" | "discarded"; code: string | null }
  | { state: "retry"; retryAfterMs: number | null }
  | { state: "stopped" };
const savedSchema = z.object({ state: z.enum(["succeeded", "failed", "discarded"]), code: z.string().optional() });

/** Records one direction's outcome. Database outages are retried here, because a paid
 * board must not be lost to a passing outage; refusals are not. */
async function saveBoard(
  deps: Pick<IdentityRunDeps, "db">,
  run: ClaimedIdentityRun,
  ordinal: number,
  board: unknown,
  responseId: string | null,
  cost: number,
): Promise<BoardResult> {
  for (let attempt = 1; ; attempt++) {
    try {
      const saved = savedSchema.parse(
        await deps.db.saveBoard(run.id, ordinal, board, responseId, Math.max(0, Math.round(cost))),
      );
      return { state: saved.state, code: saved.code ?? null };
    } catch (error) {
      if (runEnded(error)) return { state: "stopped" };
      const code = (error as { code?: unknown }).code;
      if (attempt >= SAVE_TRIES || code === "22023" || code === "P0002" || error instanceof z.ZodError) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
    }
  }
}
const failed = (code: string) => ({ state: "failed" as const, code: codeOf(code) });

/** Records a direction that will not get a board (its specification failed, or its
 * board step stopped answering). */
export async function recordBoardFailure(
  deps: Pick<IdentityRunDeps, "db">,
  run: ClaimedIdentityRun,
  ordinal: number,
  code: string,
): Promise<BoardResult> {
  return saveBoard(deps, run, directionOrdinalSchema.parse(ordinal), failed(code), null, 0);
}

/** The board's images, read back from the owner's Storage and checked against the
 * frozen hashes: the chosen logo first, then the selected references. */
async function boardImages(
  deps: Pick<IdentityRunDeps, "storage" | "now">,
  run: ClaimedIdentityRun,
  job: EngineIdentityJobInput,
): Promise<VerifiedAssetBytes[] | { failed: string }> {
  const logo = job.sourceLogo.preview,
    references = job.input.referenceSnapshot.selected;
  if (references.length + 1 > IMAGE_INPUT_LIMITS.images) return { failed: "input_too_large" };
  const read = async (
    asset: { ownerId: string; projectId: string; assetId: string; versionId: string; contentHash: string },
    mimeType: string,
    byteLength?: number,
  ): Promise<VerifiedAssetBytes> => {
    const stored = await deps.storage.get(run, asset);
    if (stored.mimeType !== mimeType || (byteLength !== undefined && stored.bytes.byteLength !== byteLength))
      throw new EngineStorageError("storage_mismatch");
    return {
      reference: {
        ownerId: asset.ownerId,
        projectId: asset.projectId,
        assetId: asset.assetId,
        versionId: asset.versionId,
        contentHash: asset.contentHash,
      },
      mimeType,
      bytes: Uint8Array.from(stored.bytes),
      verification: {
        status: "verified",
        checkedAt: deps.now().toISOString(),
        contentHash: asset.contentHash,
        mimeType,
        byteLength: stored.bytes.byteLength,
      },
    } as VerifiedAssetBytes;
  };
  const images = [await read(logo.reference, logo.verification.mimeType, logo.verification.byteLength)];
  for (const entry of references) {
    const media = entry.reference.media;
    images.push(
      await read(
        {
          ownerId: run.ownerId,
          projectId: run.projectId,
          assetId: media.assetId,
          versionId: media.versionId,
          contentHash: media.contentHash,
        },
        media.mimeType,
      ),
    );
  }
  if (images.reduce((bytes, image) => bytes + image.bytes.byteLength, 0) > IMAGE_INPUT_LIMITS.inputBytes)
    return { failed: "input_too_large" };
  return images;
}

/**
 * Draws one direction's board once and records it:
 * - nothing was drawn (429, 5xx, no connection): `retry`, and the workflow tries again later;
 * - refused, unclear, or drawn but unusable: a failed direction, with its usage when known;
 * - drawn: checked (a 1024 x 1024 PNG), stored under the owner's path, then recorded
 *   as a direction the Creative direction screens show and select.
 */
export async function drawBoard(
  deps: IdentityRunDeps,
  run: ClaimedIdentityRun,
  ordinal: number,
  specification: IdentitySystemSpecification,
  attempt: number,
): Promise<BoardResult> {
  const n = directionOrdinalSchema.parse(ordinal);
  if (
    !Number.isInteger(attempt) ||
    attempt < 1 ||
    attempt > IDENTITY_SEND_TRIES ||
    !identitySystemSpecificationSchema.safeParse(specification).success ||
    !specification.applicationDesign
  ) {
    throw new IdentityRunError("invalid_run_input");
  }
  const { job } = await readIdentityRound(deps, run);
  let images: Awaited<ReturnType<typeof boardImages>>;
  try {
    images = await boardImages(deps, run, job);
  } catch (error) {
    // The chosen logo or a reference is gone or changed: no board can be drawn from it.
    if (error instanceof EngineStorageError && error.code !== "storage_unavailable")
      return saveBoard(deps, run, n, failed("source_unavailable"), null, 0);
    return { state: "retry", retryAfterMs: null };
  }
  if (!Array.isArray(images)) return saveBoard(deps, run, n, failed(images.failed), null, 0);
  const prompt = identityBoardPrompt(job.sourceLogo.brief.payload.name, specification, true);
  try {
    if (
      !(await deps.db.saveOutput(
        run.id,
        `sent.${boardOutputKey(n)}.${attempt}`,
        { sentAt: deps.now().toISOString() },
        null,
        0,
      ))
    ) {
      // This exact try was started before and may have been sent: never send it twice.
      return saveBoard(deps, run, n, failed("provider_outcome_unknown"), null, 0);
    }
  } catch (error) {
    if (runEnded(error)) return { state: "stopped" };
    return { state: "retry", retryAfterMs: null };
  }
  let reply: Awaited<ReturnType<EngineImages["draw"]>>;
  try {
    reply = await deps.images.draw(
      { prompt, images, profile: ENGINE_BOARD_IMAGE },
      `identity-${run.id}-board-${n}-${attempt}`,
    );
  } catch (error) {
    if (error instanceof EngineImageRejectedError)
      return saveBoard(deps, run, n, failed("provider_rejected"), error.providerRequestId, error.costMicrousd);
    if (error instanceof EngineProviderError && error.disposition === "retry")
      return { state: "retry", retryAfterMs: error.retryAfterMs };
    if (error instanceof EngineProviderError && error.disposition === "rejected")
      return saveBoard(deps, run, n, failed("provider_rejected"), null, 0);
    return saveBoard(deps, run, n, failed("provider_outcome_unknown"), null, 0);
  }
  if (reply.kind === "unusable")
    return saveBoard(deps, run, n, failed(reply.code), reply.providerRequestId, reply.costMicrousd);
  let inspection: { width: number; height: number };
  try {
    inspection = await deps.inspect(reply.bytes, "image/png");
  } catch (error) {
    // A paid board that fails its check is recorded; say why in the logs (type, code, code locations only).
    logServerError("identity_board_check_failed", error, { kind: run.kind, board: boardOutputKey(n) });
    return saveBoard(deps, run, n, failed("invalid_output"), reply.providerRequestId, reply.costMicrousd);
  }
  if (inspection.width !== 1024 || inspection.height !== 1024)
    return saveBoard(deps, run, n, failed("invalid_dimensions"), reply.providerRequestId, reply.costMicrousd);
  // A round stopped while this board was drawn keeps its usage but stores no file.
  const state = await deps.db.check(run.id).catch(() => null);
  if (state && (state.status !== "running" || state.cancelRequested))
    return saveBoard(deps, run, n, failed("run_stopped"), reply.providerRequestId, reply.costMicrousd);
  const asset = { ownerId: run.ownerId, projectId: run.projectId, assetId: deps.newId(), versionId: deps.newId() };
  for (let tries = 1; ; tries++) {
    try {
      await deps.storage.put(run, asset, reply.bytes, "image/png");
      break;
    } catch (error) {
      if (tries >= 3 || !(error instanceof EngineStorageError && error.code === "storage_unavailable")) {
        return saveBoard(deps, run, n, failed("storage_unavailable"), reply.providerRequestId, reply.costMicrousd);
      }
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** tries));
    }
  }
  const image = {
    assetId: asset.assetId,
    versionId: asset.versionId,
    mimeType: "image/png",
    byteLength: reply.bytes.byteLength,
    contentHash: createHash("sha256").update(reply.bytes).digest("hex"),
  };
  return saveBoard(
    deps,
    run,
    n,
    {
      state: "succeeded",
      image,
      specification: { components: specification.components, applicationDesign: specification.applicationDesign },
      provider: { model: IMAGE_MODEL, providerRequestId: reply.providerRequestId, responseHash: reply.responseHash },
    },
    reply.providerRequestId,
    reply.costMicrousd,
  );
}
