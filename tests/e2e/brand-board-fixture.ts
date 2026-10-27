import { expect, type Page, type Route } from "@playwright/test";
import { DEFAULT_PROFILE_VALUES } from "../../src/domain/account-profile";
import { INSPIRATION_CATALOG_VERSION, inspirationCatalog, type InspirationOverview } from "../../src/domain/inspiration";
import { contextSnapshotSchema } from "../../src/domain/projects";
import { syntheticRefinementWorkspaceHttp } from "../fixtures/logo-refinement-workspace-http";
import { watchNormalAppErrors } from "./account-check";

/** Real account board/components against explicit synthetic saved rows and
 * hash-verified PNG bytes. No mocked rendering, AI, Storage service or writes. */
export async function setupSavedRasterBoard(page: Page) {
  const browserHealth = watchNormalAppErrors(page);
  const data = await syntheticRefinementWorkspaceHttp(true), ownerId = data.workspace.ownerId, projectId = data.workspace.projectId;
  const base = `/api/projects/${projectId}`, url = `/brands/account/${projectId}/brand-board`;
  const inspiration: InspirationOverview = { ownerId, projectId, projectTitle: "Élan & Co", projectScope: "complete_brand", projectRevision: 1,
    catalogVersion: INSPIRATION_CATALOG_VERSION, selectionRevision: 1, choices: [{ ownerId, projectId,
      referenceId: inspirationCatalog.find(row => row.slug === "dropbox-blue-symbol")!.id, revision: 1, ensemble: false, elements: ["colors"], updatedAt: "2026-10-18T00:00:00Z" }] };
  const requests: { path: string; method: string; denied: boolean }[] = [];
  const json = (route: Route, value: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
  await page.route("**/*", async route => {
    const target = new URL(route.request().url());
    if (target.hostname !== "127.0.0.1") return route.abort("blockedbyclient");
    const path = target.pathname; if (!path.startsWith("/api/")) return route.continue();
    const record = { path, method: route.request().method(), denied: false }; requests.push(record);
    if (record.method !== "GET") return json(route, {}, 405);
    if (path === "/api/session") return json(route, { user: { id: data.owner } });
    if (path === "/api/account/profile") return json(route, { profile: { ownerId: data.owner, email: "board-fixture@example.invalid", revision: 0, updatedAt: null, values: DEFAULT_PROFILE_VALUES } });
    if (data.owner !== ownerId) { record.denied = true; return json(route, {}, 404); }
    if (path === base) return json(route, { project: { id: projectId, owner_id: ownerId, title: "Élan & Co", scope: "complete_brand", current_revision: 1,
      created_at: "2026-10-18T00:00:00Z", deleted_at: null, deletion_requested_at: null, deletion_state: "active", lifecycle_version: 0,
      context: contextSnapshotSchema.parse({ description: "Private synthetic brand brief, never application artwork." }) } });
    if (path === `${base}/inspiration`) return json(route, inspiration);
    const response = await data.fetcher(target.href, { method: "GET" });
    return route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) });
  });
  await page.goto(url);
  await expect(page).toHaveTitle(/Embel/u); await expect(page).toHaveURL(url);
  await expect(page.getByRole("heading", { name: "Brand board", exact: true })).toBeVisible();
  return { data, requests, url, browserHealth, workspaceBefore: JSON.stringify(data.workspace) };
}
