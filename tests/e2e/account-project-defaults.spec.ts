import { expectProjectCanvas } from "./project-canvas-contract";
import { expect, test, type Page } from "@playwright/test";
import { accountProjectSchema, accountProjectSummarySchema, type AccountProject } from "../../src/domain/project-api";
import { accountProjectDraft } from "../../src/components/workspace/project-draft-adapter";
import { contextSnapshotSchema } from "../../src/domain/projects";
import { accountProjectPageSchema } from "../../src/domain/project-pages";
import { emptyLogoWorkspace } from "../fixtures/empty-logo-workspace";

// All account and provider endpoints are synthetic local route fixtures.
const owner = "aaaaaaaa-1111-4111-8111-111111111111";
const projectId = "bbbbbbbb-1111-4111-8111-111111111111";
const when = "2026-10-15T10:00:00Z";
const prompt = "A neighborhood kitchen serving seasonal lunches and practical cooking classes.";
function project(): AccountProject {
  return accountProjectSchema.parse({
    id: projectId,
    owner_id: owner,
    title: "Saved project fixture",
    scope: "complete_brand",
    current_revision: 1,
    created_at: when,
    context: {
      description: prompt,
      intake: {
        suppliedName: "Kitchen",
        namingNotes: "Keep the original notes",
        identityNotes: "Warm colors",
        conversation: [{ id: "original-prompt", kind: "user_message", text: prompt, createdAt: when }],
      },
    },
  });
}
async function setup(page: Page, initial: AccountProject[] = []) {
  const state = {
    signedIn: true,
    loseCreate: false,
    patchStatus: 200,
    runtimeReady: false,
    creates: [] as string[],
    patches: [] as string[],
    ai: [] as string[],
    projects: new Map(initial.map((item) => [item.id, item])),
  };
  await page.route("**/*", async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      path = url.pathname;
    if (url.hostname !== "127.0.0.1") return route.abort("blockedbyclient");
    if (!path.startsWith("/api/")) return route.continue();
    const reply = (json: unknown, status = 200) => route.fulfill({ json, status });
    if (path === "/api/session") return state.signedIn ? reply({ user: { id: owner } }) : reply({}, 401);
    if (!state.signedIn) return reply({}, 401);
    if (path === "/api/projects/page")
      return reply(
        accountProjectPageSchema.parse({
          ownerId: owner,
          items: [...state.projects.values()]
            .map((item) =>
              accountProjectSummarySchema.parse({
                ...item,
                deleted_at: null,
                deletion_requested_at: null,
                deletion_state: "active",
                lifecycle_version: 0,
              }),
            )
            .sort((a, b) => b.id.localeCompare(a.id)),
          nextCursor: null,
        }),
      );
    if (path.endsWith("/capability"))
      return reply({ ownerId: owner, policy: null, reason: "Synthetic unavailable files" });
    const availability = state.runtimeReady
      ? {
          status: "available",
          operations: [{ operation: "strategy.competitors", maximumCostMicrousd: 10000, interviewVersion: 1 }],
        }
      : { status: "unavailable", operations: [], reason: "worker_unavailable" };
    if (path === "/api/strategy") return reply({ availability });
    if (path.endsWith("/strategy")) {
      if (request.method() === "POST") {
        state.ai.push(request.postData()!);
        return reply({}, 503);
      }
      return reply({ availability, jobs: [] });
    }
    if (path === "/api/projects" && request.method() === "POST") {
      const input = request.postDataJSON();
      state.creates.push(request.postData()!);
      const saved =
        state.projects.get(input.requestKey) ??
        accountProjectSchema.parse({
          ...input,
          id: input.requestKey,
          owner_id: owner,
          current_revision: 1,
          created_at: when,
        });
      state.projects.set(saved.id, saved);
      if (state.loseCreate) {
        state.loseCreate = false;
        return route.abort("failed");
      }
      return reply({ project: saved }, 201);
    }
    const saved = state.projects.get(path.split("/")[3]!);
    if (saved && path === `/api/projects/${saved.id}/logo` && request.method() === "GET")
      return reply(emptyLogoWorkspace(saved));
    if (saved && path === `/api/projects/${saved.id}`) {
      if (request.method() === "GET") return reply({ project: saved });
      const body = request.postDataJSON();
      state.patches.push(request.postData()!);
      if (state.patchStatus !== 200) return reply({}, state.patchStatus);
      if (body.expectedRevision !== saved.current_revision) return reply({}, 409);
      const updated = {
        ...saved,
        context: contextSnapshotSchema.parse(body.context),
        current_revision: saved.current_revision + 1,
      };
      state.projects.set(saved.id, updated);
      return reply({
        revision: {
          project_id: saved.id,
          owner_id: owner,
          revision: updated.current_revision,
          context: updated.context,
          input_hash: "fixture",
          created_at: when,
        },
      });
    }
    return reply({}, 404);
  });
  return state;
}

test("account default: manual Save project persists across reload without AI", async ({ page }) => {
  const state = await setup(page);
  await page.goto("/");
  await page.getByRole("textbox", { name: "Your prompt", exact: true }).fill(prompt);
  await page.getByRole("button", { name: "Save project", exact: true }).click();
  await expect(page).toHaveURL(/\/brands\/account\/[a-f0-9-]+\?view=strategy(#strategy-brief)?$/);
  await expect(
    page.getByRole("log", { name: "Conversation", exact: true }).getByRole("paragraph").filter({ hasText: prompt }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("log", { name: "Conversation", exact: true }).getByRole("paragraph").filter({ hasText: prompt }),
  ).toBeVisible();
  expect(state.creates).toHaveLength(1);
  expect(state.ai).toHaveLength(0);
  expect(state.projects.size).toBe(1);
  await page.goto("/brands");
  await expect(page.locator(".project-card")).toHaveCount(1);
  await expect(page.getByLabel("Filter projects by storage")).toHaveCount(0);
});

test("account default: legacy recovery needs a selection and account confirmation and preserves all context", async ({
  page,
}) => {
  const state = await setup(page);
  const original = project();
  const legacy = { ...accountProjectDraft(original), preservedContext: original.context };
  await page.addInitScript(
    ({ legacy }) => {
      if (!localStorage.getItem("fluid.local-drafts.v1"))
        localStorage.setItem("fluid.local-drafts.v1", JSON.stringify({ version: 1, drafts: [legacy] }));
    },
    { legacy },
  );
  await page.goto("/brands");
  await expect(page.getByText(original.title, { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Recover unsaved projects", exact: true }).click();
  await page.getByRole("radio").check();
  await expect(page.getByRole("button", { name: "Save project", exact: true })).toHaveCount(0);
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Save project", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/brands/account/${legacy.id}\\?view=strategy`));
  expect(state.projects.get(legacy.id)?.context).toEqual(original.context);
  expect(state.ai).toHaveLength(0);
  await page.reload();
  await expect(
    page.getByRole("log", { name: "Conversation", exact: true }).getByRole("paragraph").filter({ hasText: prompt }),
  ).toBeVisible();
  await page.goto("/brands");
  await expect(page.locator(".project-card")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Recover unsaved projects", exact: true })).toHaveCount(0);
});

test("account default: lost creation acknowledgement replays the original save without duplicates or AI", async ({
  page,
}) => {
  const state = await setup(page);
  state.loseCreate = true;
  await page.goto("/");
  await page.getByRole("textbox", { name: "Your prompt", exact: true }).fill(prompt);
  await page.getByRole("button", { name: "Save project", exact: true }).click();
  await expect(page.getByText(/Your project could not be confirmed/)).toBeVisible();
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Your prompt", exact: true })).toHaveValue(prompt);
  await expect(page.getByRole("textbox", { name: "Your prompt", exact: true })).not.toBeEditable();
  await page.getByRole("button", { name: "Check and retry save", exact: true }).click();
  await expect(page).toHaveURL(/\/brands\/account\/[a-f0-9-]+\?view=strategy/);
  expect(state.creates).toHaveLength(2);
  expect(state.creates[1]).toBe(state.creates[0]);
  expect(state.projects.size).toBe(1);
  expect(state.ai).toHaveLength(0);
});

test("account default: failed automatic answer save stays retained and retries its original revision", async ({
  page,
}) => {
  const state = await setup(page, [project()]);
  state.runtimeReady = true;
  state.patchStatus = 503;
  await page.goto(`/brands/account/${projectId}`);
  const answer = "Please include neighborhood families in this brand.";
  await page.getByRole("textbox", { name: "Message Embel", exact: true }).fill(answer);
  await page.getByRole("button", { name: "Send prompt", exact: true }).click();
  await expect(page.getByRole("button", { name: "Retry save", exact: true })).toBeVisible();
  await expect(page.getByRole("log", { name: "Conversation" }).getByText(answer, { exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Message Embel", exact: true })).toHaveValue(answer);
  await page.waitForTimeout(1000);
  expect(state.patches).toHaveLength(1);
  expect(state.ai).toHaveLength(0);
  state.patchStatus = 200;
  state.runtimeReady = false;
  await page.getByRole("button", { name: "Retry save", exact: true }).click();
  await expect.poll(() => state.projects.get(projectId)?.current_revision).toBe(2);
  await page.getByRole("button", { name: "Edit brief", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "Edit current brief", exact: true });
  await expect(editor.getByRole("status")).toHaveText("Saved");
  await editor.getByRole("button", { name: "Close", exact: true }).click();
  await expectProjectCanvas(page);
  await expect(page.getByText(/Your answer is kept in this tab, but saving was not confirmed/)).toHaveCount(0);
  expect(state.patches).toHaveLength(2);
  expect(state.patches[1]).toBe(state.patches[0]);
  await page.reload();
  await expect(page.getByRole("log", { name: "Conversation" }).getByText(answer, { exact: true })).toBeVisible();
});
