import { expect, it } from "vitest";
import {
  reviewVisualDirectionSchema,
  reviewedVisualDirectionSchema,
  visualDirectionOverviewSchema,
  visualDirectionReferences,
} from "@/domain/visual-direction";
import { visualOverview, visualOwner } from "../fixtures/visual-direction";
it("retains only saved selected aspects and exact attributed text without inventing an interpretation or owned media", () => {
  const overview = visualOverview({ likes: true, reviewed: true });
  expect(visualDirectionOverviewSchema.parse(overview).current?.references).toEqual(
    visualDirectionReferences(overview.inspiration),
  );
  expect(overview.current!.references[0]).toMatchObject({ ensemble: false, elements: ["colors"] });
  expect(overview.current!.references[0]).not.toHaveProperty("asset");
  const changed = structuredClone(overview.current!);
  changed.references[0]!.description = "Invented analysis";
  expect(reviewedVisualDirectionSchema.safeParse(changed).success).toBe(false);
  changed.references = [{ ...overview.current!.references[0]!, ensemble: false, elements: [] }];
  expect(reviewedVisualDirectionSchema.safeParse(changed).success).toBe(false);
});
it("binds immutable review history to owner, project and current selection revisions", () => {
  const overview = visualOverview({ reviewed: true });
  expect(
    visualDirectionOverviewSchema.safeParse({
      ...overview,
      inspiration: { ...overview.inspiration, selectionRevision: 2 },
    }).success,
  ).toBe(false);
  expect(
    visualDirectionOverviewSchema.safeParse({
      ...overview,
      inspiration: { ...overview.inspiration, ownerId: overview.inspiration.projectId },
    }).success,
  ).toBe(false);
  expect(visualDirectionOverviewSchema.safeParse({ ...overview, history: [overview.current!] }).success).toBe(false);
  const mutation = {
    expectedRevision: 1,
    expectedProjectRevision: 1,
    expectedSelectionRevision: 0,
    catalogVersion: overview.inspiration.catalogVersion,
    guidance: overview.current!.guidance,
  };
  expect(reviewVisualDirectionSchema.safeParse({ ...mutation, ownerId: visualOwner }).success).toBe(false);
  expect(
    reviewVisualDirectionSchema.safeParse({ ...mutation, guidance: { ...mutation.guidance, colors: "x".repeat(1201) } })
      .success,
  ).toBe(false);
});
