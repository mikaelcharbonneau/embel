import { z } from "zod";
import { logoBriefDraftSchema, type LogoType } from "./logo-workspace";
import { logoCounterSchema, logoRevisionSchema, logoUuidSchema } from "./logo-vector";

export const LOGO_SAVED_INPUTS_MAX_BYTES = 65_536;
export const DEFAULT_LOGO_CONCEPT_TYPES: LogoType[] = [
  "wordmark", "lettermark_monogram", "pictorial", "abstract", "combination", "emblem",
];

/** A read of account data, not a saved logo revision or generation receipt.
 * A null draft means the project has no saved selected or supplied brand name. */
export const logoSavedInputsSchema = z.strictObject({
  ownerId: logoUuidSchema,
  projectId: logoUuidSchema,
  projectRevision: logoRevisionSchema,
  inspirationSelectionRevision: logoCounterSchema,
  draft: logoBriefDraftSchema.nullable(),
  nameConflict: z.boolean(),
  inspirationCount: z.number().int().min(0).max(15),
}).refine(value => value.draft !== null || !value.nameConflict, "A name conflict requires a saved name");
export type LogoSavedInputs = z.infer<typeof logoSavedInputsSchema>;

/** The brief line that records which inspiration selection the brief was built from. */
export function logoInspirationHeading(catalogVersion: string, selectionRevision: number) {
  return `Saved inspiration · catalog ${catalogVersion} · selection ${selectionRevision}:`;
}
const inspirationHeading = /^Saved inspiration · catalog \S+ · selection (\d+):$/mu;

/** Whether a saved brief predates the latest brand or inspiration. A brief saved
 * after both that still differs from them was edited by hand. */
export function logoBriefOutdated(saved: { personality: string; sourceProjectRevision: number },
  latest: Pick<LogoSavedInputs, "projectRevision" | "inspirationSelectionRevision" | "inspirationCount">) {
  if (saved.sourceProjectRevision !== latest.projectRevision) return true;
  const selection = inspirationHeading.exec(saved.personality)?.[1];
  return (selection === undefined ? null : Number(selection)) !== (latest.inspirationCount ? latest.inspirationSelectionRevision : null);
}
