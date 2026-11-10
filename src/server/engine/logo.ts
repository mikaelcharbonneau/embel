import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { brandTextReadiness } from "@/domain/brand-board-fonts";
import { IMAGE_INPUT_LIMITS } from "@/domain/logo-image-limits";
import type { LogoUploadNoteStatus } from "@/domain/logo-saved-inputs";
import { LOGO_STYLE_NOTE_VERSION, logoStyleNoteSchema, type LogoStyleNote } from "@/domain/logo-style-notes";
import type { LogoReferenceSelection } from "@/domain/logo-workspace";
import type { AuthenticatedContext } from "../auth/context";
import { ApiError } from "../http/errors";
import {
  getLogoStageRevision,
  getLogoWorkspace,
  readLogoConceptBatch,
  readLogoRasterRefinement,
  readLogoReferenceSnapshot,
} from "../data/logo-workspace";
import {
  LOGO_KINDS,
  logoConceptsRequestSchema,
  logoConceptsRunInputSchema,
  logoRefineRequestSchema,
  logoRefineRunInputSchema,
  logoStyleNoteRequestSchema,
  logoStyleNoteRunInputSchema,
  styleNoteOutputKey,
  type LogoConceptsRunInput,
  type LogoRefineRunInput,
  type LogoStyleNoteRunInput,
} from "./logo-input";
import { enabledGenerationKinds } from "./runs";

// Logo concepts, refinements and style notes on the generation engine
// (docs/generation-engine.md, step 4). This module runs with the person's own
// login: it decides whether the engine path is on and freezes each run's input
// from the person's saved Logo work. The browser only names what to draw.

/**
 * The engine path is on only when all three Logo kinds are enabled, so one switch
 * moves the whole step and turning any kind off returns it to the old path. Any
 * failure to read the catalog (including a database without the engine) keeps
 * the old path.
 */
export async function logoEngineEnabled(auth: AuthenticatedContext): Promise<boolean> {
  try {
    const enabled = await enabledGenerationKinds(auth);
    return LOGO_KINDS.every((kind) => enabled.has(kind));
  } catch {
    return false;
  }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
type ConceptSlot = Awaited<ReturnType<typeof readLogoConceptBatch>>["slots"][number];
/** The slot's latest delivered image, as the Logo screens show it. */
function acceptedLogoAttempt(slot: ConceptSlot) {
  return (
    slot.attempts
      .filter(
        (attempt) =>
          attempt.state === "succeeded" &&
          attempt.billing.status === "recorded" &&
          attempt.preview?.publicationState === "committed",
      )
      .at(-1) ?? null
  );
}
const readFailure = (error: unknown) => {
  if (error) throw new ApiError("integration_unavailable");
};

/** The current saved brief, with the heads the person asked from. */
async function currentBrief(auth: AuthenticatedContext, projectId: string, expected: unknown) {
  const workspace = await getLogoWorkspace(auth, projectId);
  if (!same(workspace.heads, expected)) throw new ApiError("conflict");
  const ref = workspace.stages.brief_references;
  if (!ref) throw new ApiError("conflict");
  const revision = await getLogoStageRevision(auth, projectId, "brief_references", ref.id);
  if (revision.stage !== "brief_references" || revision.revision !== ref.revision) throw new ApiError("conflict");
  const { name, activity, audience, personality, logoTypes, referenceSnapshotId } = revision.payload;
  if (!brandTextReadiness(name).supported) throw new ApiError("invalid_input");
  return {
    workspace,
    referenceSnapshotId,
    brief: {
      id: revision.id,
      revision: revision.revision,
      payload: { name, activity, audience, personality, logoTypes },
    },
  };
}

/**
 * Freezes one round of concepts: the saved brief (with its logo types), the heads
 * it was asked from and a new batch id; or, to retry, the failed slots of an
 * earlier round made from the same brief. The database plans the six slots.
 */
export async function buildLogoConceptsRunInput(
  auth: AuthenticatedContext,
  projectId: string,
  raw: unknown,
): Promise<LogoConceptsRunInput> {
  const request = logoConceptsRequestSchema.safeParse(raw);
  if (!request.success) throw new ApiError("invalid_input");
  const { workspace, brief } = await currentBrief(auth, projectId, request.data.expected);
  const base = { version: 1 as const, revision: workspace.heads.projectRevision, expected: workspace.heads, brief };
  if (request.data.operation !== "retry_failed") {
    if (request.data.briefRevisionId !== brief.id) throw new ApiError("conflict");
    return logoConceptsRunInputSchema.parse({ ...base, operation: request.data.operation, batchId: randomUUID() });
  }
  const batch = await readLogoConceptBatch(auth, projectId, request.data.sourceBatchId);
  if (batch.briefRevisionId !== brief.id) throw new ApiError("conflict");
  const ids = [...new Set(request.data.failedSlotIds)];
  for (const id of ids) {
    const last = batch.slots.find((slot) => slot.id === id)?.attempts.at(-1);
    if (!last || last.state !== "failed" || last.billing.status !== "recorded") throw new ApiError("conflict");
  }
  return logoConceptsRunInputSchema.parse({ ...base, operation: "retry_failed", batchId: batch.id, slotIds: ids });
}

/** Freezes one refinement: the chosen image's exact preview, the liked uploads the
 * brief saved, and the requested change. */
export async function buildLogoRefineRunInput(
  auth: AuthenticatedContext,
  projectId: string,
  raw: unknown,
): Promise<LogoRefineRunInput> {
  const request = logoRefineRequestSchema.safeParse(raw);
  if (!request.success) throw new ApiError("invalid_input");
  const { workspace, brief, referenceSnapshotId } = await currentBrief(auth, projectId, request.data.expected);
  const source = request.data.source;
  let preview;
  if (source.kind === "concept") {
    const batch = await readLogoConceptBatch(auth, projectId, source.batchId);
    const slot = batch.slots.find((item) => item.id === source.slotId),
      accepted = slot ? acceptedLogoAttempt(slot) : null;
    if (!accepted || accepted.id !== source.attemptId) throw new ApiError("not_found");
    preview = accepted.preview;
  } else {
    const record = await readLogoRasterRefinement(auth, projectId, source.rasterRevisionId);
    if (record.state !== "succeeded" || record.billing.status !== "recorded") throw new ApiError("not_found");
    preview = record.preview;
  }
  if (!preview || preview.publicationState !== "committed" || preview.verification.mimeType !== "image/png")
    throw new ApiError("not_found");
  const snapshot = await readLogoReferenceSnapshot(auth, projectId, referenceSnapshotId);
  if (snapshot.references.length > IMAGE_INPUT_LIMITS.images - 1) throw new ApiError("invalid_input");
  const versions = snapshot.references.map((ref) => ref.asset.versionId);
  const types = versions.length
    ? await auth.client
        .from("asset_versions")
        .select("id,mime_type")
        .eq("owner_id", auth.userId)
        .eq("project_id", projectId)
        .in("id", versions)
    : { data: [], error: null };
  readFailure(types.error);
  const mimeOf = new Map(
    z
      .array(z.object({ id: z.uuid(), mime_type: z.string() }))
      .parse(types.data ?? [])
      .map((row) => [row.id, row.mime_type]),
  );
  const references = snapshot.references.map((ref) => ({
    asset: ref.asset,
    mimeType: mimeOf.get(ref.asset.versionId),
    aspects: ref.aspects,
  }));
  const input = logoRefineRunInputSchema.safeParse({
    version: 1,
    revision: workspace.heads.projectRevision,
    expected: workspace.heads,
    brief,
    source,
    basePreview: preview.reference,
    references,
    instruction: request.data.instruction,
  });
  if (!input.success) throw new ApiError("invalid_input");
  return input.data;
}

type SourceRow = { reference_id: string; asset_id: string; version_id: string; content_hash: string };
async function uploadSources(
  auth: AuthenticatedContext,
  projectId: string,
  ids: readonly string[],
): Promise<SourceRow[]> {
  if (!ids.length) return [];
  const sources = await auth.client
    .from("logo_reference_sources")
    .select("reference_id,asset_id,version_id,content_hash")
    .match({ owner_id: auth.userId, project_id: projectId, source_kind: "upload" })
    .in("reference_id", [...ids]);
  readFailure(sources.error);
  return z
    .array(
      z.object({
        reference_id: z.uuid(),
        asset_id: z.uuid(),
        version_id: z.uuid(),
        content_hash: z.string().regex(/^[0-9a-f]{64}$/u),
      }),
    )
    .parse(sources.data ?? []);
}

/** A liked upload's note state; a ready note carries its text. */
export type LikedUploadNote = { referenceId: string; status: LogoUploadNoteStatus; note?: LogoStyleNote };
/** Two definite failures for the same upload version stop new requests for it. */
const STYLE_NOTE_ATTEMPT_LIMIT = 2;
const runSchema = z.object({
  id: z.uuid(),
  status: z.enum(["queued", "running", "succeeded", "failed", "cancelled"]),
  input: z.unknown(),
});
const noteOutputSchema = z.object({ run_id: z.uuid(), output_key: z.string(), output: z.unknown() });
const writtenSchema = z.object({
  referenceId: z.uuid(),
  contentHash: z.string(),
  noteVersion: z.literal(LOGO_STYLE_NOTE_VERSION),
  status: z.enum(["written", "failed"]),
  symbol: z.string().nullable().optional(),
  lettering: z.string().nullable().optional(),
  code: z.string().optional(),
});

/**
 * Each liked upload's style note on the engine path: written for its current
 * bytes (ready), being written (pending), refused twice or left unclear
 * (unavailable: never requested again automatically), or not yet (missing).
 * Notes are the outputs of logo.style_note runs; nothing else stores them.
 */
export async function engineUploadNotes(
  auth: AuthenticatedContext,
  projectId: string,
  references: readonly LogoReferenceSelection[],
): Promise<LikedUploadNote[]> {
  if (!references.length) return [];
  const sources = await uploadSources(
    auth,
    projectId,
    references.map((row) => row.referenceId),
  );
  const runs = await auth.client
    .from("generation_runs")
    .select("id,status,input")
    .match({ owner_id: auth.userId, project_id: projectId, kind: "logo.style_note" })
    .order("created_at", { ascending: false })
    .limit(60);
  readFailure(runs.error);
  const rows = z
    .array(runSchema)
    .parse(runs.data ?? [])
    .flatMap((run) => {
      const input = logoStyleNoteRunInputSchema.safeParse(run.input);
      return input.success ? [{ ...run, input: input.data }] : [];
    });
  const outputs = rows.length
    ? await auth.client
        .from("generation_outputs")
        .select("run_id,output_key,output")
        .match({ owner_id: auth.userId })
        .in(
          "run_id",
          rows.map((run) => run.id),
        )
    : { data: [], error: null };
  readFailure(outputs.error);
  const notes = z
    .array(noteOutputSchema)
    .parse(outputs.data ?? [])
    .flatMap((row) => {
      const output = writtenSchema.safeParse(row.output);
      return output.success && row.output_key === styleNoteOutputKey(output.data.referenceId)
        ? [{ runId: row.run_id, ...output.data }]
        : [];
    });
  return references.map(({ referenceId }) => {
    const hash = sources.find((row) => row.reference_id === referenceId)?.content_hash;
    if (!hash) return { referenceId, status: "unavailable" as const };
    const mine = notes.filter((note) => note.referenceId === referenceId && note.contentHash === hash);
    const written = mine
      .map((note) => logoStyleNoteSchema.safeParse({ symbol: note.symbol ?? null, lettering: note.lettering ?? null }))
      .find(
        (note, index) => mine[index]!.status === "written" && note.success && (note.data.symbol || note.data.lettering),
      );
    if (written?.success) return { referenceId, status: "ready" as const, note: written.data };
    const asked = rows.filter((run) =>
      run.input.references.some((ref) => ref.referenceId === referenceId && ref.asset.contentHash === hash),
    );
    if (asked.some((run) => run.status === "queued" || run.status === "running"))
      return { referenceId, status: "pending" as const };
    // A request whose outcome is unknown is never repeated automatically.
    if (mine.some((note) => note.code === "send_interrupted") || asked.length >= STYLE_NOTE_ATTEMPT_LIMIT)
      return { referenceId, status: "unavailable" as const };
    return { referenceId, status: "missing" as const };
  });
}

/** Freezes one style-note run: each named liked upload that still has no note,
 * at its current version. Already written or running notes are not asked again. */
export async function buildLogoStyleNoteRunInput(
  auth: AuthenticatedContext,
  projectId: string,
  raw: unknown,
): Promise<LogoStyleNoteRunInput> {
  const request = logoStyleNoteRequestSchema.safeParse(raw);
  if (!request.success) throw new ApiError("invalid_input");
  // Loaded here: the saved-inputs module reads notes through this one.
  const [{ likedUploadReferences }, { getProject }] = await Promise.all([
    import("../data/logo-saved-inputs"),
    import("../data/projects"),
  ]);
  const [liked, project] = await Promise.all([likedUploadReferences(auth, projectId), getProject(auth, projectId)]);
  const revision = project.current_revision;
  const ids = [...new Set(request.data.referenceIds)];
  if (ids.some((id) => !liked.some((row) => row.referenceId === id))) throw new ApiError("not_found");
  const states = await engineUploadNotes(
    auth,
    projectId,
    ids.map((referenceId) => ({ referenceId, aspects: ["overall_feel"] })),
  );
  const wanted = ids.filter((id) => states.find((state) => state.referenceId === id)?.status === "missing");
  if (!wanted.length) throw new ApiError("conflict");
  const sources = await uploadSources(auth, projectId, wanted);
  const types = await auth.client
    .from("asset_versions")
    .select("id,mime_type")
    .eq("owner_id", auth.userId)
    .eq("project_id", projectId)
    .in(
      "id",
      sources.map((row) => row.version_id),
    );
  readFailure(types.error);
  const mimeOf = new Map(
    z
      .array(z.object({ id: z.uuid(), mime_type: z.string() }))
      .parse(types.data ?? [])
      .map((row) => [row.id, row.mime_type]),
  );
  const input = logoStyleNoteRunInputSchema.safeParse({
    version: 1,
    revision,
    references: wanted.map((referenceId) => {
      const source = sources.find((row) => row.reference_id === referenceId);
      return (
        source && {
          referenceId,
          mimeType: mimeOf.get(source.version_id),
          asset: {
            ownerId: auth.userId,
            projectId,
            assetId: source.asset_id,
            versionId: source.version_id,
            contentHash: source.content_hash,
          },
        }
      );
    }),
  });
  if (!input.success) throw new ApiError("invalid_input");
  return input.data;
}
