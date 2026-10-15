import { expect, type Page, type Route } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { createEmptyNamesWorkspace, namesWorkspaceSchema, type AccountNamesWorkspace, type SaveNamesWorkspaceInput } from "../../../src/domain/names-workspace";
import { accountProjectSchema, type AccountProject } from "../../../src/domain/project-api";
import { createProjectInputSchema } from "../../../src/domain/projects";

export const namesOwner = "aaaaaaaa-1111-4111-8111-111111111111";
export function createNamesAccountFixture() {
  const state = { ownerId: namesOwner as string | null, workspace: null as AccountNamesWorkspace | null, failSaves: false, projects: [] as AccountProject[], puts: [] as SaveNamesWorkspaceInput[] };
  const receipts = new Map<string, AccountNamesWorkspace>();
  async function route(route: Route) {
    const path = new URL(route.request().url()).pathname, method = route.request().method();
    const reply = (body: unknown, status = 200) => route.fulfill({ status, json: body });
    if (path === "/api/session") return reply(state.ownerId ? { user: { id: state.ownerId } } : {}, state.ownerId ? 200 : 401);
    if (!state.ownerId) return reply({}, 401);
    if (path === "/api/names/workspace") {
      if (method === "PUT") {
        if (route.request().headers()["x-embel-account"] !== state.ownerId) return reply({}, 401);
        const body = route.request().postDataJSON() as SaveNamesWorkspaceInput; state.puts.push(body);
        if (state.failSaves) return reply({}, 503);
        const receipt = receipts.get(`${state.ownerId}:${body.requestKey}`);
        if (receipt) return reply({ ownerId: state.ownerId, workspace: receipt });
        if (body.expectedRevision !== (state.workspace?.revision ?? 0)) return reply({}, 409);
        state.workspace = { id: state.workspace?.id ?? randomUUID(), ownerId: state.ownerId, revision: body.expectedRevision + 1, payload: namesWorkspaceSchema.parse(body.payload), createdAt: "2026-10-15T12:00:00Z", updatedAt: "2026-10-15T12:00:00Z" };
        receipts.set(`${state.ownerId}:${body.requestKey}`, state.workspace);
      }
      return reply({ ownerId: state.ownerId, workspace: state.workspace });
    }
    if (path === "/api/names") return reply({ ownerId: state.ownerId, items: [], nextCursor: null });
    if (path === "/api/projects/page") return reply({ ownerId: state.ownerId, items: [], nextCursor: null });
    if (path === "/api/projects" && method === "POST") {
      const body = route.request().postDataJSON();
      const input = { scope: body.scope, title: body.title, context: body.context };
      const project = accountProjectSchema.parse({ ...createProjectInputSchema.parse(input), id: randomUUID(), owner_id: state.ownerId, current_revision: 1, created_at: "2026-10-15T12:00:00Z" });
      state.projects.push(project); return reply({ project }, 201);
    }
    const project = state.projects.find(project => path === `/api/projects/${project.id}`);
    if (project) return reply({ project });
    if (path.endsWith("/strategy")) return reply({ availability: { status: "unavailable", operations: [], reason: "runtime_disabled" }, jobs: [] });
    return reply({}, 404);
  }
  return { state, install: (page: Page) => page.route("**/api/**", route), payload: () => state.workspace?.payload ?? createEmptyNamesWorkspace() };
}

export async function waitForNamesSaved(page: Page) { await expect(page.locator(".names-save-label")).toHaveText("Saved to your account"); }
