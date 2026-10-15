import { INSPIRATION_CATALOG_VERSION, inspirationCatalog, type InspirationOverview } from "@/domain/inspiration";
import { emptyVisualGuidance, visualDirectionReferences, type VisualDirectionOverview } from "@/domain/visual-direction";
export const visualOwner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", visualProject = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export function visualOverview(options: { ownerId?: string; projectId?: string; likes?: boolean; reviewed?: boolean } = {}): VisualDirectionOverview {
  const ownerId = options.ownerId ?? visualOwner, projectId = options.projectId ?? visualProject;
  const inspiration: InspirationOverview = { ownerId, projectId, projectTitle: "Explicit local fixture", projectScope: "complete_brand", projectRevision: 1,
    catalogVersion: INSPIRATION_CATALOG_VERSION, selectionRevision: options.likes ? 1 : 0, choices: options.likes ? [{ ownerId, projectId, referenceId: inspirationCatalog[0]!.id, revision: 1, ensemble: false, elements: ["colors"], updatedAt: "2026-10-13T12:00:00Z" }] : [] };
  return { inspiration, current: options.reviewed ? { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", ownerId, projectId, revision: 1,
    projectRevision: 1, selectionRevision: inspiration.selectionRevision, catalogVersion: inspiration.catalogVersion,
    guidance: { ...emptyVisualGuidance(), character: "Clear and warm" }, references: visualDirectionReferences(inspiration), reviewedAt: "2026-10-13T12:01:00Z" } : null,
    history: [], hasEarlierHistory: false, stale: false };
}
