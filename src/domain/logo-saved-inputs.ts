import { z } from "zod";
import { logoBriefDraftSchema, logoReferenceSelectionSchema, type LogoType } from "./logo-workspace";
import { logoCounterSchema, logoRevisionSchema, logoUuidSchema } from "./logo-vector";
import { LIKED_LETTERING, LIKED_LOGO_STYLE } from "./logo-style-notes";

export const LOGO_SAVED_INPUTS_MAX_BYTES = 65_536;
/** Liked uploads used as images: a logo refinement sends its base preview plus
 * these, within the four-image model input; Creative direction sends the logo
 * plus these. Inspiration allows liking at most this many of your own images. */
export const LOGO_LIKED_UPLOAD_LIMIT = 3;
const logoUploadNoteStatusSchema = z.enum(["ready", "pending", "missing", "unavailable"]);
export type LogoUploadNoteStatus = z.infer<typeof logoUploadNoteStatusSchema>;
export const DEFAULT_LOGO_CONCEPT_TYPES: LogoType[] = [
  "wordmark",
  "lettermark_monogram",
  "pictorial",
  "abstract",
  "combination",
  "emblem",
];

/** A read of account data, not a saved logo revision or generation receipt.
 * A null draft means the project has no saved selected or supplied brand name. */
export const logoSavedInputsSchema = z
  .strictObject({
    ownerId: logoUuidSchema,
    projectId: logoUuidSchema,
    projectRevision: logoRevisionSchema,
    inspirationSelectionRevision: logoCounterSchema,
    draft: logoBriefDraftSchema.nullable(),
    nameConflict: z.boolean(),
    inspirationCount: z.number().int().min(0).max(1000),
    /** The owner's liked uploaded images, as logo references (whole image). */
    references: z
      .array(logoReferenceSelectionSchema)
      .max(LOGO_LIKED_UPLOAD_LIMIT)
      .refine((rows) => new Set(rows.map((row) => row.referenceId)).size === rows.length, "Duplicate reference"),
    /** Each liked upload's style note: written (and in the draft), being written,
     * not yet requested, or not available (it stays out of the brief). */
    uploadNotes: z
      .array(z.strictObject({ referenceId: logoUuidSchema, status: logoUploadNoteStatusSchema }))
      .max(LOGO_LIKED_UPLOAD_LIMIT),
  })
  .refine((value) => value.draft !== null || !value.nameConflict, "A name conflict requires a saved name");
export type LogoSavedInputs = z.infer<typeof logoSavedInputsSchema>;

/** The brief line that records which inspiration selection the brief was built from. */
export function logoInspirationHeading(catalogVersion: string, selectionRevision: number) {
  return `Saved inspiration · catalog ${catalogVersion} · selection ${selectionRevision}:`;
}
const inspirationHeading = /^Saved inspiration · catalog \S+ · selection (\d+):$/mu;

const likedLines = (personality: string) =>
  personality
    .split("\n")
    .filter((line) => line.startsWith(LIKED_LOGO_STYLE) || line.startsWith(LIKED_LETTERING))
    .join("\n");
/** Whether a saved brief predates the latest brand or inspiration. A brief saved
 * after both that still differs from them was edited by hand, unless its liked
 * style lines differ: those are derived from likes and their notes (an earlier
 * brief format, or an upload's note written after the brief was saved). */
export function logoBriefOutdated(
  saved: { personality: string; sourceProjectRevision: number },
  latest: Pick<LogoSavedInputs, "projectRevision" | "inspirationSelectionRevision" | "inspirationCount"> & {
    draft?: { personality: string } | null;
  },
) {
  if (saved.sourceProjectRevision !== latest.projectRevision) return true;
  const selection = inspirationHeading.exec(saved.personality)?.[1];
  if (
    (selection === undefined ? null : Number(selection)) !==
    (latest.inspirationCount ? latest.inspirationSelectionRevision : null)
  )
    return true;
  return (
    latest.draft !== undefined &&
    latest.draft !== null &&
    likedLines(latest.draft.personality) !== likedLines(saved.personality)
  );
}
