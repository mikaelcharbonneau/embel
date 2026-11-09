import "server-only";
import { z } from "zod";
import { inspirationCatalog, inspirationLabels, inspirationPartElements, inspirationPartLabels, hasInspirationChoice, isInspirationBrand, type InspirationDesign, type InspirationOverview, type InspirationPreferences } from "@/domain/inspiration";
import { logoBriefDraftSchema } from "@/domain/logo-workspace";
import { DEFAULT_LOGO_CONCEPT_TYPES, LOGO_LIKED_UPLOAD_LIMIT, logoInspirationHeading, logoSavedInputsSchema, type LogoUploadNoteStatus } from "@/domain/logo-saved-inputs";
import { inspirationLogoStyles } from "@/domain/inspiration-logo-styles";
import { LIKED_LETTERING, LIKED_LOGO_DIRECTION, LIKED_LOGO_STYLE, LOGO_STYLE_NOTE_VERSION, logoStyleNoteSchema, type LogoStyleNote } from "@/domain/logo-style-notes";
import { logoStringSchema } from "@/domain/logo-vector";
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
/** Liked logos (whole brand or its logo) and typefaces that guide concepts, in like order. */
const LOGO_STYLE_LIKE_LIMIT = 4;
const OLD_CLOSING = "Use the selected visual qualities as direction for an original logo, without copying these brands or their marks. Color preferences guide later identity work; the initial logo concepts remain black and white.";
const NOTES_CLOSING = "Color preferences and the liked brands above guide later identity work.";
type LikedDesign = { choice: InspirationPreferences; design: InspirationDesign };
/** A liked upload's note state; a ready note carries its text. */
export type LikedUploadNote = { referenceId: string; status: LogoUploadNoteStatus; note?: LogoStyleNote };

/** Style notes for logo concepts, in like order and at most four likes: first
 * each liked upload's written note, then each liked brand logo's precomputed
 * note (kept only while it still describes the catalog's logo image) and each
 * liked typeface's description as lettering. A liked earlier single-image
 * design keeps its original line, marked as a liked logo style. */
function styleNoteLines(designs: readonly LikedDesign[], uploads: readonly LikedUploadNote[]) {
  const lines: string[] = []; let used = 0;
  for (const upload of uploads) {
    if (used >= LOGO_STYLE_LIKE_LIMIT || upload.status !== "ready" || !upload.note) continue;
    if (upload.note.symbol) lines.push(LIKED_LOGO_STYLE + upload.note.symbol);
    if (upload.note.lettering) lines.push(LIKED_LETTERING + upload.note.lettering);
    used += 1;
  }
  for (const { choice, design } of designs.some(({ design }) => isInspirationBrand(design)) ? designs : []) {
    if (used >= LOGO_STYLE_LIKE_LIMIT) break;
    const likesLogo = choice.ensemble || choice.elements.includes("logo");
    if (!isInspirationBrand(design)) {
      if (likesLogo) { lines.push(LIKED_LOGO_STYLE + inspirationGuidance(design, choice, false)); used += 1; }
      continue;
    }
    const logo = design.parts.find(part => part.part === "logo"), note = inspirationLogoStyles.notes[design.id];
    const typefaces = choice.elements.includes("typography") ? design.parts.find(part => part.part === "typefaces") : undefined;
    const current = likesLogo && logo && note?.logoContentHash === logo.contentHash ? note : undefined;
    if (!current && !typefaces) continue;
    if (current?.symbol) lines.push(LIKED_LOGO_STYLE + current.symbol);
    if (current?.lettering) lines.push(LIKED_LETTERING + current.lettering);
    if (typefaces) lines.push(LIKED_LETTERING + typefaces.description);
    used += 1;
  }
  return lines;
}
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
export function deriveSavedLogoInputs(project: SavedBrand, inspiration: InspirationOverview, references: LogoReferenceSelection[] = [], uploads: LikedUploadNote[] = []) {
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
  const traits = context.personality ? Object.entries(context.personality).map(([trait, value]) => `${trait}: ${value}`).join("; ") : "";
  const heading = logoInspirationHeading(inspiration.catalogVersion, inspiration.selectionRevision);
  // No model sees the liked images. Liked brand logos reach logo concepts as
  // their style notes; the image prompt keeps only those lines (see
  // logoPromptPersonality). Brand descriptions stay for Creative direction,
  // which reads this brief: detailed when they fit, otherwise a short line each.
  const notes = styleNoteLines(designs, uploads);
  const described = notes.length ? designs.filter(({ choice, design }) => isInspirationBrand(design) || !(choice.ensemble || choice.elements.includes("logo"))) : designs;
  const describe = (detailed: boolean) => described.map(({ choice, design }) => inspirationGuidance(design, choice, detailed));
  const compose = (guidance: string[]) => [traits, context.intake.identityNotes,
    ...(notes.length ? [heading, ...notes, ...guidance, LIKED_LOGO_DIRECTION, NOTES_CLOSING]
      : guidance.length ? [heading, ...guidance, OLD_CLOSING] : []),
  ].filter(value => value.trim()).join("\n");
  const detailed = describe(true);
  const fits = (value: string) => logoStringSchema.safeParse(value).success;
  const personality = notes.length
    ? [compose(detailed), compose(describe(false))].find(fits) ?? compose(describe(false))
    : compose(detailed.join("\n").length <= INSPIRATION_GUIDANCE_BUDGET ? detailed : describe(false));
  const draft = name ? logoBriefDraftSchema.safeParse({ name,
    activity: [context.activity, context.offering].filter(value => value.trim()).join("\n") || context.description,
    audience: context.knownAudience || context.audienceSegments.filter(segment => segment.selected).map(segment => segment.label).join(", "),
    personality, logoTypes: [...DEFAULT_LOGO_CONCEPT_TYPES],
  }) : null;
  // Never silently truncate saved instructions or omit a selected reference.
  if (draft && !draft.success) throw new ApiError("invalid_input");
  return logoSavedInputsSchema.parse({ ownerId: project.owner_id, projectId: project.id, projectRevision: project.current_revision,
    inspirationSelectionRevision: inspiration.selectionRevision, draft: draft?.success ? draft.data : null,
    nameConflict: Boolean(selected && supplied && selected !== supplied), inspirationCount: choices.length, references,
    uploadNotes: uploads.map(({ referenceId, status }) => ({ referenceId, status })) });
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

const noteJobsSchema = z.array(z.strictObject({ referenceId: z.string().nullable(), contentHash: z.string().nullable(), state: z.string() })).max(1000);
/** Two definite failures for the same upload version stop new requests for it. */
const STYLE_NOTE_ATTEMPT_LIMIT = 2;
/** Each liked upload's style note: written for its current bytes (ready), a
 * request still running (pending), an unclear or repeatedly failed request
 * (unavailable: never repeated automatically), or nothing yet (missing). */
export async function likedUploadNotes(auth: AuthenticatedContext, projectId: string, references: readonly LogoReferenceSelection[]): Promise<LikedUploadNote[]> {
  if (!references.length) return [];
  const owned = { project_id: projectId, owner_id: auth.userId }, ids = references.map(row => row.referenceId);
  const sources = rows<{ reference_id: string; content_hash: string }>(
    await auth.client.from("logo_reference_sources").select("reference_id, content_hash").match(owned).in("reference_id", ids));
  const notes = rows<{ reference_id: string; content_hash: string; note_version: string; symbol: string | null; lettering: string | null }>(
    await auth.client.from("logo_style_notes").select("reference_id, content_hash, note_version, symbol, lettering").match(owned).in("reference_id", ids));
  const read = await auth.client.rpc("read_logo_style_note_jobs", { p_project_id: projectId });
  if (read.error) throw new ApiError("integration_unavailable");
  const jobs = noteJobsSchema.parse(read.data);
  return references.map(({ referenceId }) => {
    const hash = sources.find(row => row.reference_id === referenceId)?.content_hash;
    if (!hash) return { referenceId, status: "unavailable" as const };
    const stored = notes.find(row => row.reference_id === referenceId && row.content_hash === hash && row.note_version === LOGO_STYLE_NOTE_VERSION);
    const note = stored ? logoStyleNoteSchema.safeParse({ symbol: stored.symbol, lettering: stored.lettering }) : null;
    if (note?.success && (note.data.symbol || note.data.lettering)) return { referenceId, status: "ready" as const, note: note.data };
    const attempts = jobs.filter(job => job.referenceId === referenceId && job.contentHash === hash);
    if (attempts.some(job => ["queued", "running", "cancel_requested"].includes(job.state))) return { referenceId, status: "pending" as const };
    if (attempts.some(job => job.state === "needs_reconciliation" || job.state === "succeeded")
      || attempts.filter(job => ["failed", "cancelled", "partial"].includes(job.state)).length >= STYLE_NOTE_ATTEMPT_LIMIT) return { referenceId, status: "unavailable" as const };
    return { referenceId, status: "missing" as const };
  });
}

export async function getSavedLogoInputs(auth: AuthenticatedContext, projectId: string) {
  const project = await getProject(auth, projectId);
  if (project.owner_id !== auth.userId || project.id !== projectId.toLowerCase()) throw new ApiError("not_found");
  const inspiration = await getProjectInspiration(auth, project.id);
  if (inspiration.ownerId !== auth.userId) throw new ApiError("not_found");
  const references = await likedUploadReferences(auth, project.id);
  const result = deriveSavedLogoInputs(project, inspiration, references, await likedUploadNotes(auth, project.id, references));
  // Project reads use two normal RLS queries; reject a concurrent revision change
  // rather than presenting a mixed snapshot as the current brand.
  const current = await getProject(auth, project.id);
  if (current.owner_id !== auth.userId || current.current_revision !== project.current_revision) throw new ApiError("conflict");
  return result;
}
