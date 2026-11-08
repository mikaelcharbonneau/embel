import { z } from "zod";
import { referenceReactionSchema, setReferenceReactionSchema, type ReferenceElement } from "./identity-references";
import { projectScopeSchema } from "./projects";
import catalogData from "./inspiration-catalog.json" with { type: "json" };
import brandData from "./inspiration-brands.json" with { type: "json" };

export const INSPIRATION_CATALOG_VERSION = "2026-10-13.1";
/** The five images every brand has, in display order. */
export type InspirationPart = "logo" | "colors" | "typefaces" | "socials" | "visuals";
export type InspirationPartImage = {
  part: InspirationPart; image: string; thumbnail: string; width: number; height: number; contentHash: string; description: string;
  /** The image's flat edge color, when it has one (see scripts/build-inspiration-brands.mjs). */
  fill?: string;
};
export type InspirationDesign = {
  id: string; slug: string; brand: string; creator?: string; kind: "identity" | "logo";
  description: string; sourceUrl?: string; image: string; width: number; height: number; contentHash: string;
  elements: ReferenceElement[]; tags: string[];
  availableSince?: string; provenance?: { source: string; license: string; trademarkNotice: string };
  parts?: InspirationPartImage[];
};
export type InspirationBrand = InspirationDesign & { parts: InspirationPartImage[] };
/** Brands shown in the gallery: one saved choice per brand, where liking the
 * whole brand is the choice's ensemble flag and liking a part is its element. */
export const inspirationBrands: readonly InspirationBrand[] = brandData as InspirationBrand[];
/** Every catalog reference a saved choice may name. The earlier single-image
 * designs are no longer shown; they stay so older saved records still read. */
export const inspirationCatalog: readonly InspirationDesign[] = [...catalogData as InspirationDesign[], ...inspirationBrands];
export const inspirationParts: readonly InspirationPart[] = ["logo", "colors", "typefaces", "socials", "visuals"];
export const inspirationPartElements: Record<InspirationPart, ReferenceElement> = {
  logo: "logo", colors: "colors", typefaces: "typography", socials: "composition", visuals: "images",
};
export const inspirationPartLabels: Record<InspirationPart, string> = {
  logo: "Logo", colors: "Colors", typefaces: "Typefaces", socials: "Socials", visuals: "Visuals",
};
/** Gallery categories: whole brands, or one part across every brand. */
export type InspirationCategory = "brands" | InspirationPart;
export const inspirationCategories: readonly { value: InspirationCategory; label: string }[] = [
  { value: "brands", label: "Brands" }, { value: "logo", label: "Logos" }, { value: "colors", label: "Colors" },
  { value: "typefaces", label: "Typefaces" }, { value: "socials", label: "Socials" }, { value: "visuals", label: "Visuals" },
];
export const isInspirationBrand = (design?: InspirationDesign): design is InspirationBrand => Boolean(design?.parts?.length);
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
  availableReferenceIds: z.array(z.uuid()).max(1000).optional(),
  selectionRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  choices: z.array(referenceReactionSchema).max(1000),
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
/** How many likes a choice holds: the whole brand counts once, and so does each part. */
export const inspirationLikeCount = (choice?: InspirationPreferences) => choice ? Number(choice.ensemble) + choice.elements.length : 0;
export const partLiked = (choice: InspirationPreferences | undefined, part: InspirationPart) => Boolean(choice?.elements.includes(inspirationPartElements[part]));
export const toggleWhole = (choice: InspirationPreferences): InspirationPreferences => ({ ensemble: !choice.ensemble, elements: choice.elements });
export function togglePart(choice: InspirationPreferences, part: InspirationPart): InspirationPreferences {
  const element = inspirationPartElements[part];
  return { ensemble: choice.ensemble, elements: choice.elements.includes(element) ? choice.elements.filter(value => value !== element) : [...choice.elements, element] };
}
const searchable = (...values: string[]) => values.join(" ").normalize("NFKC").toLocaleLowerCase("en");
const queryTerms = (query: string) => query.trim().normalize("NFKC").toLocaleLowerCase("en").split(/\s+/u).filter(Boolean);
/** Brands matching a search across their name, description, tags and images. */
export function filterInspirationBrands(brands: readonly InspirationBrand[], query: string) {
  const terms = queryTerms(query);
  return brands.filter(brand => {
    const text = searchable(brand.brand, brand.description, ...brand.tags, ...brand.parts.map(part => part.description));
    return terms.every(term => text.includes(term));
  });
}
/** One part across brands, matching a search on the brand's name, tags and that image. */
export function filterInspirationParts(brands: readonly InspirationBrand[], part: InspirationPart, query: string) {
  const terms = queryTerms(query);
  return brands.flatMap(brand => {
    const image = brand.parts.find(item => item.part === part);
    if (!image) return [];
    const text = searchable(brand.brand, ...brand.tags, image.description);
    return terms.every(term => text.includes(term)) ? [{ brand, image }] : [];
  });
}
