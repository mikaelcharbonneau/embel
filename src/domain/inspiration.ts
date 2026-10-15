import { z } from "zod";
import { referenceReactionSchema, setReferenceReactionSchema, type ReferenceElement } from "./identity-references";
import { projectScopeSchema } from "./projects";
import catalogData from "./inspiration-catalog.json" with { type: "json" };

export const INSPIRATION_CATALOG_VERSION = "2026-10-13.1";
export type InspirationDesign = {
  id: string; slug: string; brand: string; creator: string; kind: "identity" | "logo";
  description: string; sourceUrl: string; image: string; width: number; height: number; contentHash: string;
  elements: ReferenceElement[]; tags: string[];
};
/** Curated reference artwork, never generated project output or a licensing claim. */
export const inspirationCatalog: readonly InspirationDesign[] = catalogData as InspirationDesign[];
export const inspirationLabels: Record<ReferenceElement, string> = {
  logo: "Logo", typography: "Typography", colors: "Colors", graphics: "Graphics", images: "Photography", composition: "Layout",
};
export const inspirationMutationSchema = setReferenceReactionSchema.extend({
  catalogVersion: z.literal(INSPIRATION_CATALOG_VERSION),
  expectedProjectRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});
export type InspirationMutation = z.infer<typeof inspirationMutationSchema>;
export const inspirationOverviewSchema = z.strictObject({
  ownerId: z.uuid(), projectId: z.uuid(), projectTitle: z.string().min(1).max(160), projectScope: projectScopeSchema,
  projectRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  catalogVersion: z.literal(INSPIRATION_CATALOG_VERSION),
  selectionRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  choices: z.array(referenceReactionSchema).max(100),
}).superRefine((value, ctx) => {
  const seen = new Set<string>();
  for (const choice of value.choices) {
    const design = inspirationCatalog.find(item => item.id === choice.referenceId);
    if (seen.has(choice.referenceId) || !design || choice.ownerId !== value.ownerId || choice.projectId !== value.projectId || choice.revision > value.selectionRevision || choice.elements.some(element => !design.elements.includes(element)))
      ctx.addIssue({ code: "custom", message: "Unbound inspiration choice" });
    seen.add(choice.referenceId);
  }
});
export type InspirationOverview = z.infer<typeof inspirationOverviewSchema>;
export type InspirationChoice = z.infer<typeof referenceReactionSchema>;
export type InspirationPreferences = Pick<InspirationChoice, "ensemble" | "elements">;
export const hasInspirationChoice = (choice?: InspirationPreferences) => Boolean(choice && (choice.ensemble || choice.elements.length));
export function sameInspirationChoice(left: InspirationPreferences, right: InspirationPreferences) {
  return left.ensemble === right.ensemble && left.elements.length === right.elements.length && left.elements.every(element => right.elements.includes(element));
}
export function filterInspiration(designs: readonly InspirationDesign[], query: string, kind: "all" | "identity" | "logo", liked: boolean, choices: ReadonlyMap<string, InspirationPreferences>) {
  const terms = query.trim().normalize("NFKC").toLocaleLowerCase("en").split(/\s+/u).filter(Boolean);
  return designs.filter(design => {
    const searchable = [design.brand, design.creator, design.description, ...design.tags].join(" ").normalize("NFKC").toLocaleLowerCase("en");
    return (kind === "all" || design.kind === kind) && (!liked || hasInspirationChoice(choices.get(design.id))) && terms.every(term => searchable.includes(term));
  });
}
