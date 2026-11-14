import { test, expect } from "@playwright/test";
import { syntheticLogoBatch, syntheticLogoWorkspace, syntheticResolvedLogoConcept } from "../fixtures/logo-creation";
import { contextSnapshotSchema } from "../../src/domain/projects";
test("six logo concepts being made show the drawing frame and respect reduced motion", async ({ page }, info) => {
  const source = syntheticResolvedLogoConcept(),
    foundation = syntheticLogoWorkspace();
  const batch = syntheticLogoBatch(Array.from({ length: 6 }, () => "running" as const));
  const projectId = foundation.projectId,
    ownerId = foundation.ownerId,
    logoBase = `/api/projects/${projectId}/logo`;
  const workspace = {
    ...foundation,
    heads: {
      ...foundation.heads,
      workspaceRevision: 1,
      stageRevisions: { ...foundation.heads.stageRevisions, brief_references: 1 },
    },
    stages: { ...foundation.stages, brief_references: { id: source.brief.id, revision: 1, stage: "brief_references" } },
  };
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url()),
      p = url.pathname;
    if (url.hostname !== "127.0.0.1") return route.abort();
    if (!p.startsWith("/api/")) return route.continue();
    const value =
      p === "/api/session"
        ? { user: { id: ownerId } }
        : p === `/api/projects/${projectId}`
          ? {
              project: {
                id: projectId,
                owner_id: ownerId,
                title: "Animation comparison fixture",
                scope: "complete_brand",
                current_revision: 1,
                created_at: source.brief.createdAt,
                context: contextSnapshotSchema.parse({ description: "Synthetic fixture only" }),
              },
            }
          : p === logoBase
            ? workspace
            : p === `${logoBase}/batches`
              ? {
                  ownerId,
                  projectId,
                  items: [{ id: batch.id, requestKey: batch.requestKey, createdAt: batch.createdAt }],
                  nextCursor: null,
                }
              : p === `${logoBase}/batches/${batch.id}`
                ? batch
                : p === `${logoBase}/stages/brief_references/revisions/${source.brief.id}`
                  ? source.brief
                  : p === `${logoBase}/reference-snapshots/${source.referenceSnapshot.id}`
                    ? source.referenceSnapshot
                    : p === `${logoBase}/refinements`
                      ? { ownerId, projectId, items: [], nextCursor: null }
                      : null;
    await route.fulfill({ status: value ? 200 : 503, json: value ?? {} });
  });
  await page.goto(`/brands/account/${projectId}/logo`);
  // Each concept being made is a drawing frame named after its concept (decision 5); no shader runs.
  const frames = page.getByRole("img", { name: /^Concept [1-6] is being drawn$/u });
  await expect(frames).toHaveCount(6);
  expect(await frames.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-label")))).toEqual(
    [1, 2, 3, 4, 5, 6].map((n) => `Concept ${n} is being drawn`),
  );
  await page.screenshot({ path: info.outputPath("logo-drawing-loading.png"), fullPage: true });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(page.locator(".e-media--drawing canvas")).toHaveCount(0);
  await expect(page.locator(".e-media--drawing")).toHaveCount(6);
});
