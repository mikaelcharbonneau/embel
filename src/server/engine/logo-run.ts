import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { IMAGE_MODEL } from "@/domain/providers";
import type { VerifiedAssetBytes } from "@/domain/logo-deliverables";
import { logoTypeSchema } from "@/domain/logo-vector";
import { logoConceptPromptText, logoRefinementPromptText } from "../ai/logo-image-prompts";
import { logServerError } from "../http/errors";
import { EngineProviderError } from "./openai";
import { ENGINE_LOGO_IMAGE, EngineImageRejectedError, type EngineImages } from "./openai-images";
import { EngineStorageError, type EngineStorage, type OwnedAsset } from "./storage";
import {
  LOGO_CONCEPTS_KIND,
  LOGO_REFINE_KIND,
  logoConceptsRunInputSchema,
  logoRefineRunInputSchema,
  type LogoConceptsRunInput,
  type LogoRefineRunInput,
} from "./logo-input";

// The Logo image workflow's step logic (concepts and refinements), with the
// provider, Storage, raster checks and the engine database passed in so tests
// can stub all of them. Each exported function is one durable step.
//
// One image is one paid Images API call. It is marked as sent in the database
// before it is sent, so a step that runs again after a crash can tell it may
// already have been sent, and fails that image instead of paying twice.

export type EngineRunCheck = { status: string; cancelRequested: boolean; paused: boolean };
/** The run as engine_claim returns it. */
export type ClaimedLogoRun = { id: string; ownerId: string; projectId: string; kind: string; input: unknown };
export type LogoEngineDb = {
  check(runId: string): Promise<EngineRunCheck>;
  /** fluid_private.engine_logo_begin */
  begin(runId: string): Promise<unknown>;
  /** fluid_private.engine_logo_save_image */
  saveImage(
    runId: string,
    key: string,
    image: unknown,
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
export type LogoRasterChecks = {
  /** Black-and-white normalization of a new drawing (the worker's concept-grayscale). */
  normalize(bytes: Uint8Array): Promise<Uint8Array>;
  inspect(
    bytes: Uint8Array,
    mimeType: string,
  ): Promise<{ width: number; height: number; isMonochrome: boolean; pixelHash: string }>;
};
export type LogoRunDeps = {
  db: LogoEngineDb;
  images: EngineImages;
  storage: EngineStorage;
  raster: LogoRasterChecks;
  newId(): string;
  now(): Date;
};

/** A known, permanent reason the run can't continue. Its code becomes the run's error code. */
export class LogoRunError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "LogoRunError";
  }
}

/** The images one run draws. A concept carries its slot's type and direction. */
export type LogoImageTarget = { key: string; type?: z.infer<typeof logoTypeSchema>; directionId?: string };
/** One image's end: saved (drawn or failed), not delivered because the run had stopped,
 * or to be tried again because nothing was drawn. */
export type LogoDrawResult =
  | { state: "succeeded" | "failed" | "discarded"; code: string | null }
  | { state: "retry"; retryAfterMs: number | null }
  | { state: "stopped" };

export const LOGO_IMAGE_TRIES = 3;
const KEY = /^image\.([0-5]|refine)$/u;
const ERROR_CODE = /^[a-z][a-z_]{0,63}$/u;
const SAVE_TRIES = 3;

export type LogoImagesRun =
  | { kind: typeof LOGO_CONCEPTS_KIND; input: LogoConceptsRunInput }
  | { kind: typeof LOGO_REFINE_KIND; input: LogoRefineRunInput };
/** Validates the frozen input against its kind. */
export function readLogoImagesRun(run: ClaimedLogoRun): LogoImagesRun {
  if (run.kind === LOGO_CONCEPTS_KIND) {
    const input = logoConceptsRunInputSchema.safeParse(run.input);
    if (input.success) return { kind: LOGO_CONCEPTS_KIND, input: input.data };
  } else if (run.kind === LOGO_REFINE_KIND) {
    const input = logoRefineRunInputSchema.safeParse(run.input);
    if (
      input.success &&
      input.data.basePreview.ownerId === run.ownerId &&
      input.data.basePreview.projectId === run.projectId &&
      input.data.references.every((ref) => ref.asset.ownerId === run.ownerId && ref.asset.projectId === run.projectId)
    )
      return { kind: LOGO_REFINE_KIND, input: input.data };
  }
  throw new LogoRunError("invalid_run_input");
}

const beginSchema = z.object({
  batchId: z.uuid(),
  slots: z
    .array(
      z.object({
        ordinal: z.number().int().min(0).max(5),
        slotId: z.uuid(),
        type: logoTypeSchema,
        directionId: z.string().min(1).max(64),
      }),
    )
    .min(1)
    .max(6),
});
/** Opens the run: a concepts round gets its batch and slots; a refinement draws one image. */
export async function beginLogoImages(
  deps: Pick<LogoRunDeps, "db">,
  run: ClaimedLogoRun,
): Promise<{ targets: LogoImageTarget[] }> {
  const parsed = readLogoImagesRun(run);
  if (parsed.kind === LOGO_REFINE_KIND) return { targets: [{ key: "image.refine" }] };
  const begun = beginSchema.safeParse(await deps.db.begin(run.id));
  if (!begun.success || begun.data.batchId !== parsed.input.batchId) throw new LogoRunError("invalid_run_input");
  return {
    targets: begun.data.slots.map((slot) => ({
      key: `image.${slot.ordinal}`,
      type: slot.type,
      directionId: slot.directionId,
    })),
  };
}

const savedSchema = z.object({ state: z.enum(["succeeded", "failed", "discarded"]), code: z.string().optional() });
const runEnded = (error: unknown) => error instanceof Error && /run_not_running/u.test(error.message);
/** Records one image's outcome. Database outages are retried here, because the
 * paid image must not be lost to a passing outage; refusals are not. */
async function save(
  deps: Pick<LogoRunDeps, "db">,
  run: ClaimedLogoRun,
  key: string,
  image: unknown,
  responseId: string | null,
  cost: number,
): Promise<LogoDrawResult> {
  for (let attempt = 1; ; attempt++) {
    try {
      const saved = savedSchema.parse(
        await deps.db.saveImage(run.id, key, image, responseId, Math.max(0, Math.round(cost))),
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
const failure = (code: string) => ({
  state: "failed" as const,
  code: ERROR_CODE.test(code) ? code : "generation_failed",
});

/** Records an image that will not be drawn, for example after its step stopped answering. */
export async function recordLogoImageFailure(
  deps: Pick<LogoRunDeps, "db">,
  run: ClaimedLogoRun,
  key: string,
  code: string,
): Promise<LogoDrawResult> {
  if (!KEY.test(key)) throw new LogoRunError("invalid_run_input");
  return save(deps, run, key, failure(code), null, 0);
}

async function prepare(deps: LogoRunDeps, run: ClaimedLogoRun, parsed: LogoImagesRun, target: LogoImageTarget) {
  if (parsed.kind === LOGO_CONCEPTS_KIND) {
    const type = logoTypeSchema.safeParse(target.type);
    if (!type.success || !target.directionId) throw new LogoRunError("invalid_run_input");
    return {
      prompt: logoConceptPromptText(
        parsed.input.brief,
        { type: type.data, directionId: target.directionId },
        ENGINE_LOGO_IMAGE.background,
      ),
      images: [] as VerifiedAssetBytes[],
    };
  }
  const { input } = parsed;
  const read = async (asset: OwnedAsset & { contentHash: string }, mimeType: string): Promise<VerifiedAssetBytes> => {
    const stored = await deps.storage.get(run, asset);
    if (stored.mimeType !== mimeType) throw new EngineStorageError("storage_mismatch");
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
    };
  };
  const images = [
    await read(input.basePreview, "image/png"),
    ...(await Promise.all(input.references.map((ref) => read(ref.asset, ref.mimeType)))),
  ];
  return {
    prompt: logoRefinementPromptText(
      input.brief,
      input.references.map((ref) => ref.aspects),
      input.instruction,
      ENGINE_LOGO_IMAGE.background,
    ),
    images,
  };
}

/**
 * Draws one image once and records it:
 * - nothing was drawn (429, 5xx, no connection): `retry`, and the workflow tries again later;
 * - refused, unclear, or drawn but unusable: a failed image, with its usage when known;
 * - drawn: normalized to black and white, checked (1024 x 1024, no color), stored
 *   under the owner's path, then recorded as a concept or refinement.
 */
export async function drawLogoImage(
  deps: LogoRunDeps,
  run: ClaimedLogoRun,
  target: LogoImageTarget,
  attempt: number,
): Promise<LogoDrawResult> {
  const parsed = readLogoImagesRun(run);
  if (
    !KEY.test(target.key) ||
    (parsed.kind === LOGO_REFINE_KIND) !== (target.key === "image.refine") ||
    !Number.isInteger(attempt) ||
    attempt < 1 ||
    attempt > LOGO_IMAGE_TRIES
  ) {
    throw new LogoRunError("invalid_run_input");
  }
  let prepared: Awaited<ReturnType<typeof prepare>>;
  try {
    prepared = await prepare(deps, run, parsed, target);
  } catch (error) {
    if (error instanceof LogoRunError) throw error;
    // The base image or a reference is gone or changed: nothing can be drawn from it.
    if (error instanceof EngineStorageError && error.code !== "storage_unavailable")
      return save(deps, run, target.key, failure("source_unavailable"), null, 0);
    return { state: "retry", retryAfterMs: null };
  }
  try {
    if (
      !(await deps.db.saveOutput(
        run.id,
        `sent.${target.key}.${attempt}`,
        { sentAt: deps.now().toISOString() },
        null,
        0,
      ))
    ) {
      // This exact try was started before and may have been sent: never send it twice.
      return save(deps, run, target.key, failure("provider_outcome_unknown"), null, 0);
    }
  } catch (error) {
    if (runEnded(error)) return { state: "stopped" };
    return { state: "retry", retryAfterMs: null };
  }
  let reply: Awaited<ReturnType<EngineImages["draw"]>>;
  try {
    reply = await deps.images.draw(prepared, `logo-${run.id}-${target.key}-${attempt}`);
  } catch (error) {
    if (error instanceof EngineImageRejectedError)
      return save(deps, run, target.key, failure("provider_rejected"), error.providerRequestId, error.costMicrousd);
    if (error instanceof EngineProviderError && error.disposition === "retry")
      return { state: "retry", retryAfterMs: error.retryAfterMs };
    if (error instanceof EngineProviderError && error.disposition === "rejected")
      return save(deps, run, target.key, failure("provider_rejected"), null, 0);
    return save(deps, run, target.key, failure("provider_outcome_unknown"), null, 0);
  }
  const provider = {
    model: IMAGE_MODEL,
    providerRequestId: reply.providerRequestId,
    responseHash: reply.responseHash,
    observedAt: deps.now().toISOString(),
  };
  if (reply.kind === "unusable")
    return save(
      deps,
      run,
      target.key,
      { ...failure(reply.code), provider },
      reply.providerRequestId,
      reply.costMicrousd,
    );
  let bytes: Uint8Array, inspection: Awaited<ReturnType<LogoRasterChecks["inspect"]>>;
  try {
    bytes = await deps.raster.normalize(reply.bytes);
    inspection = await deps.raster.inspect(bytes, "image/png");
  } catch (error) {
    // A paid image that fails its check is recorded; say why in the logs (type, code, code locations only).
    logServerError("logo_image_check_failed", error, { kind: run.kind, image: target.key });
    return save(
      deps,
      run,
      target.key,
      { ...failure("invalid_output"), provider },
      reply.providerRequestId,
      reply.costMicrousd,
    );
  }
  if (inspection.width !== 1024 || inspection.height !== 1024)
    return save(
      deps,
      run,
      target.key,
      { ...failure("invalid_dimensions"), provider },
      reply.providerRequestId,
      reply.costMicrousd,
    );
  if (!inspection.isMonochrome)
    return save(
      deps,
      run,
      target.key,
      { ...failure("chromatic_output"), provider },
      reply.providerRequestId,
      reply.costMicrousd,
    );
  // A run stopped while this image was drawn keeps its usage but stores no file.
  const state = await deps.db.check(run.id).catch(() => null);
  if (state && (state.status !== "running" || state.cancelRequested)) {
    return save(
      deps,
      run,
      target.key,
      { ...failure("run_stopped"), provider },
      reply.providerRequestId,
      reply.costMicrousd,
    );
  }
  const asset = { ownerId: run.ownerId, projectId: run.projectId, assetId: deps.newId(), versionId: deps.newId() };
  for (let tries = 1; ; tries++) {
    try {
      await deps.storage.put(run, asset, bytes, "image/png");
      break;
    } catch (error) {
      if (tries >= 3 || !(error instanceof EngineStorageError && error.code === "storage_unavailable")) {
        return save(
          deps,
          run,
          target.key,
          { ...failure("storage_unavailable"), provider },
          reply.providerRequestId,
          reply.costMicrousd,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** tries));
    }
  }
  const image = {
    assetId: asset.assetId,
    versionId: asset.versionId,
    mimeType: "image/png",
    byteLength: bytes.byteLength,
    contentHash: createHash("sha256").update(bytes).digest("hex"),
    normalizedPixelHash: inspection.pixelHash,
  };
  return save(
    deps,
    run,
    target.key,
    { state: "succeeded", image, provider },
    reply.providerRequestId,
    reply.costMicrousd,
  );
}
