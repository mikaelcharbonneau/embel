import "server-only";
import { inspirationCatalog, inspirationLabels, hasInspirationChoice, type InspirationOverview } from "@/domain/inspiration";
import { logoBriefDraftSchema } from "@/domain/logo-workspace";
import { DEFAULT_LOGO_CONCEPT_TYPES, logoSavedInputsSchema } from "@/domain/logo-saved-inputs";
import type { ContextSnapshot } from "@/domain/projects";
import type { AuthenticatedContext } from "@/server/auth/context";
import { ApiError } from "@/server/http/errors";
import { getProject } from "./projects";
import { getProjectInspiration } from "./inspiration";

type SavedBrand = { id: string; owner_id: string; current_revision: number; scope: string; context: ContextSnapshot };

/** Textual references to the owner's acknowledged choices, never artwork or a licensing claim. */
export function deriveSavedLogoInputs(project: SavedBrand, inspiration: InspirationOverview) {
  if (project.id !== inspiration.projectId || project.owner_id !== inspiration.ownerId) throw new ApiError("not_found");
  if (project.current_revision !== inspiration.projectRevision) throw new ApiError("conflict");
  if (project.scope === "naming_only") throw new ApiError("invalid_input");
  const context = project.context;
  const selected = context.selectedName?.trim() ?? "";
  const supplied = context.intake.suppliedName.trim();
  const name = selected || supplied;
  const choices = inspiration.choices.filter(hasInspirationChoice);
  const guidance = choices.map(choice => {
    const design = inspirationCatalog.find(item => item.id === choice.referenceId);
    if (!design) throw new ApiError("integration_unavailable");
    const aspects = [...(choice.ensemble ? ["overall look"] : []), ...choice.elements.map(element => inspirationLabels[element])];
    return `${design.slug} (${design.brand}, ${design.creator}): ${aspects.join(", ")}; ${design.tags.join(", ")}.`;
  });
  const traits = context.personality ? Object.entries(context.personality).map(([trait, value]) => `${trait}: ${value}`).join("; ") : "";
  const personality = [traits, context.intake.identityNotes,
    ...(guidance.length ? [`Saved inspiration · catalog ${inspiration.catalogVersion} · selection ${inspiration.selectionRevision}:`, ...guidance,
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
    nameConflict: Boolean(selected && supplied && selected !== supplied), inspirationCount: choices.length });
}

export async function getSavedLogoInputs(auth: AuthenticatedContext, projectId: string) {
  const project = await getProject(auth, projectId);
  if (project.owner_id !== auth.userId || project.id !== projectId.toLowerCase()) throw new ApiError("not_found");
  const inspiration = await getProjectInspiration(auth, project.id);
  if (inspiration.ownerId !== auth.userId) throw new ApiError("not_found");
  const result = deriveSavedLogoInputs(project, inspiration);
  // Project reads use two normal RLS queries; reject a concurrent revision change
  // rather than presenting a mixed snapshot as the current brand.
  const current = await getProject(auth, project.id);
  if (current.owner_id !== auth.userId || current.current_revision !== project.current_revision) throw new ApiError("conflict");
  return result;
}
