import "server-only";
import { inspirationCatalog, inspirationLabels, inspirationPartElements, inspirationPartLabels, hasInspirationChoice, isInspirationBrand, type InspirationDesign, type InspirationOverview, type InspirationPreferences } from "@/domain/inspiration";
import { logoBriefDraftSchema } from "@/domain/logo-workspace";
import { DEFAULT_LOGO_CONCEPT_TYPES, LOGO_LIKED_UPLOAD_LIMIT, logoInspirationHeading, logoSavedInputsSchema } from "@/domain/logo-saved-inputs";
import type { LogoReferenceSelection } from "@/domain/logo-workspace";
import type { ContextSnapshot } from "@/domain/projects";
import type { AuthenticatedContext } from "@/server/auth/context";
import { ApiError } from "@/server/http/errors";
import { getProject } from "./projects";
import { getProjectInspiration } from "./inspiration";

type SavedBrand = { id: string; owner_id: string; current_revision: number; scope: string; context: ContextSnapshot };

/** Textual references to the owner's acknowledged choices, never artwork or a licensing claim. */
// Leaves room in the 4,000-character personality text for the traits, notes and instructions.
const INSPIRATION_GUIDANCE_BUDGET = 2800;
function inspirationGuidance(design: InspirationDesign, choice: InspirationPreferences, detailed: boolean) {
  if (!isInspirationBrand(design)) {
    const aspects = [...(choice.ensemble ? ["overall look"] : []), ...choice.elements.map(element => inspirationLabels[element])];
    return `${design.slug} (${design.brand}${design.creator ? `, ${design.creator}` : ""}): ${aspects.join(", ")}; ${design.tags.join(", ")}.`;
  }
  const parts = design.parts.filter(part => choice.elements.includes(inspirationPartElements[part.part]));
  const aspects = [...(choice.ensemble ? ["whole brand"] : []), ...parts.map(part => inspirationPartLabels[part.part].toLowerCase())];
  if (!detailed) return `${design.brand} brand: ${aspects.join(", ")}; ${design.tags.join(", ")}.`;
  return [`${design.brand} brand (${aspects.join(", ")}):`, ...(choice.ensemble ? [design.description] : []),
    ...parts.map(part => `${inspirationPartLabels[part.part]}: ${part.description}`)].join(" ");
}
export function deriveSavedLogoInputs(project: SavedBrand, inspiration: InspirationOverview, references: LogoReferenceSelection[] = []) {
  if (project.id !== inspiration.projectId || project.owner_id !== inspiration.ownerId) throw new ApiError("not_found");
  if (project.current_revision !== inspiration.projectRevision) throw new ApiError("conflict");
  if (project.scope === "naming_only") throw new ApiError("invalid_input");
  const context = project.context;
  const selected = context.selectedName?.trim() ?? "";
  const supplied = context.intake.suppliedName.trim();
  const name = selected || supplied;
  const choices = inspiration.choices.filter(hasInspirationChoice);
  const designs = choices.map(choice => {
    const design = inspirationCatalog.find(item => item.id === choice.referenceId);
    if (!design) throw new ApiError("integration_unavailable");
    return { choice, design };
  });
  // The model never sees the images, so brand likes carry their descriptions.
  // If that would overflow the brief, every liked brand keeps a short line instead.
  const describe = (detailed: boolean) => designs.map(({ choice, design }) => inspirationGuidance(design, choice, detailed));
  const detailed = describe(true);
  const guidance = detailed.join("\n").length <= INSPIRATION_GUIDANCE_BUDGET ? detailed : describe(false);
  const traits = context.personality ? Object.entries(context.personality).map(([trait, value]) => `${trait}: ${value}`).join("; ") : "";
  const personality = [traits, context.intake.identityNotes,
    ...(guidance.length ? [logoInspirationHeading(inspiration.catalogVersion, inspiration.selectionRevision), ...guidance,
      "Use the selected visual qualities as direction for an original logo, without copying these brands or their marks. Color preferences guide later identity work; the initial logo concepts remain black and white."] : []),
  ].filter(value => value.trim()).join("\n");
  const draft = name ? logoBriefDraftSchema.safeParse({ name,
    activity: [context.activity, context.offering].filter(value => value.trim()).join("\n") || context.description,
    audience: context.knownAudience || context.audienceSegments.filter(segment => segment.selected).map(segment => segment.label).join(", "),
    personality, logoTypes: [...DEFAULT_LOGO_CONCEPT_TYPES],
  }) : null;
  // Never silently truncate saved instructions or omit a selected reference.
  if (draft && !draft.success) throw new ApiError("invalid_input");
  return logoSavedInputsSchema.parse({ ownerId: project.owner_id, projectId: project.id, projectRevision: project.current_revision,
    inspirationSelectionRevision: inspiration.selectionRevision, draft: draft?.success ? draft.data : null,
    nameConflict: Boolean(selected && supplied && selected !== supplied), inspirationCount: choices.length, references });
}

type Rows<T> = { data: T[] | null; error: unknown };
function rows<T>(result: Rows<T>): T[] { if (result.error || !result.data) throw new ApiError("integration_unavailable"); return result.data; }
/** The owner's liked uploaded images (Inspiration "Your images"), as the logo
 * references their uploads also created: same project, same stored image. The
 * most recently liked come first, up to the limit; each guides the whole look. */
export async function likedUploadReferences(auth: AuthenticatedContext, projectId: string): Promise<LogoReferenceSelection[]> {
  const owned = { project_id: projectId, owner_id: auth.userId };
  const reactions = rows<{ reference_id: string; ensemble: boolean; elements: string[]; updated_at: string | null }>(
    await auth.client.from("identity_reference_reactions").select("reference_id, ensemble, elements, updated_at").match(owned))
    .filter(row => row.ensemble || row.elements.length > 0);
  if (!reactions.length) return [];
  const references = rows<{ id: string; asset_id: string; source: string }>(
    await auth.client.from("identity_references").select("id, asset_id, source").match(owned).in("id", reactions.map(row => row.reference_id)))
    .filter(row => row.source === "user_supplied");
  if (!references.length) return [];
  const sources = rows<{ reference_id: string; asset_id: string }>(
    await auth.client.from("logo_reference_sources").select("reference_id, asset_id").match({ ...owned, source_kind: "upload" }).in("asset_id", references.map(row => row.asset_id)));
  const assetOf = new Map(references.map(row => [row.id, row.asset_id])), sourceOf = new Map(sources.map(row => [row.asset_id, row.reference_id]));
  const recent = [...reactions].sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? "") || a.reference_id.localeCompare(b.reference_id));
  const selected = [...new Set(recent.map(row => sourceOf.get(assetOf.get(row.reference_id) ?? "")).filter((id): id is string => Boolean(id)))].slice(0, LOGO_LIKED_UPLOAD_LIMIT);
  return selected.sort().map(referenceId => ({ referenceId, aspects: ["overall_feel"] }));
}

export async function getSavedLogoInputs(auth: AuthenticatedContext, projectId: string) {
  const project = await getProject(auth, projectId);
  if (project.owner_id !== auth.userId || project.id !== projectId.toLowerCase()) throw new ApiError("not_found");
  const inspiration = await getProjectInspiration(auth, project.id);
  if (inspiration.ownerId !== auth.userId) throw new ApiError("not_found");
  const result = deriveSavedLogoInputs(project, inspiration, await likedUploadReferences(auth, project.id));
  // Project reads use two normal RLS queries; reject a concurrent revision change
  // rather than presenting a mixed snapshot as the current brand.
  const current = await getProject(auth, project.id);
  if (current.owner_id !== auth.userId || current.current_revision !== project.current_revision) throw new ApiError("conflict");
  return result;
}
