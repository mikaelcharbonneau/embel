import { z } from "zod";

// Files attached to the first prompt, and what Embel read in them (docs/home-prompt-inputs.md).
// The first Strategy run of a brand with files reads them once; every later step is given the reading.

/** What a file turned out to be. It decides which steps the file matters to. */
export const BRIEF_FILE_KINDS = [
  "notes",
  "competitor_material",
  "product_photo",
  "visual_reference",
  "existing_logo",
  "other",
] as const;
export const briefFileKindSchema = z.enum(BRIEF_FILE_KINDS);
export type BriefFileKind = z.infer<typeof briefFileKindSchema>;
export const BRIEF_FILE_KIND_LABELS: Record<BriefFileKind, string> = {
  notes: "Notes",
  competitor_material: "Competitor material",
  product_photo: "Product photo",
  visual_reference: "Visual reference",
  existing_logo: "Existing logo",
  other: "Other",
};

export const BRIEF_FILE_MAX = 5;
export const BRIEF_FILE_SUMMARY_MAX = 600;
/** The kinds of file the reading step can open. PDF is not accepted at upload. */
export const briefFileMimeTypeSchema = z.enum(["text/plain", "image/png", "image/jpeg"]);

/** One stored file of the brand, exactly as it was verified at upload. */
export const briefFileRefSchema = z.strictObject({
  id: z.uuid(),
  blobVersionId: z.uuid(),
  name: z.string().min(1).max(255),
  mimeType: briefFileMimeTypeSchema,
  contentHash: z.string().regex(/^[0-9a-f]{64}$/u),
  byteLength: z.number().int().min(1).max(10_485_760),
});
export type BriefFileRef = z.infer<typeof briefFileRefSchema>;

/** What was read in one file. An unreadable file says so; nothing is made up for it. */
export const briefFileNoteSchema = z.discriminatedUnion("status", [
  z.strictObject({
    id: z.uuid(),
    name: z.string().min(1).max(255),
    status: z.literal("read"),
    kind: briefFileKindSchema,
    summary: z.string().min(1).max(BRIEF_FILE_SUMMARY_MAX),
  }),
  z.strictObject({ id: z.uuid(), name: z.string().min(1).max(255), status: z.literal("unreadable") }),
]);
export type BriefFileNote = z.infer<typeof briefFileNoteSchema>;
export const briefFileNotesSchema = z.strictObject({
  version: z.literal(1),
  files: z.array(briefFileNoteSchema).min(1).max(BRIEF_FILE_MAX),
});
export type BriefFileNotes = z.infer<typeof briefFileNotesSchema>;

/** Frozen into a run's input: the brand's files, and their reading once one exists. A run whose
 * `notes` is null reads the files before its own request. */
export const briefFilesInputSchema = z.strictObject({
  refs: z.array(briefFileRefSchema).min(1).max(BRIEF_FILE_MAX),
  notes: briefFileNotesSchema.nullable(),
});
export type BriefFilesInput = z.infer<typeof briefFilesInputSchema>;

/** The readings a prompt is given: only files that were read, without ids. */
export function briefFilesForPrompt(notes: BriefFileNotes | null | undefined) {
  return (notes?.files ?? []).flatMap((file) =>
    file.status === "read" ? [{ name: file.name, kind: file.kind, summary: file.summary }] : [],
  );
}

/** What the brand page shows for each attached file. */
export const briefFileViewSchema = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  mimeType: briefFileMimeTypeSchema,
  /** `waiting`: not read yet (it is read when research starts). */
  status: z.enum(["waiting", "read", "unreadable"]),
  kind: briefFileKindSchema.nullable(),
  summary: z.string().nullable(),
});
export type BriefFileView = z.infer<typeof briefFileViewSchema>;
export const briefFilesResponseSchema = z.strictObject({ files: z.array(briefFileViewSchema).max(BRIEF_FILE_MAX) });
