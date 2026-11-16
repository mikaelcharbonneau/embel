import { emptyLogoWorkspace } from "../fixtures/empty-logo-workspace";
import { expect, test, type Page } from "@playwright/test";
import { accountProjectSchema, type AccountProject } from "../../src/domain/project-api";

// Naming is a step of the brand conversation (Voice · Name) and runs on the generation engine. The separate
// Naming page this file used to drive is gone, with its batches, workshop and panes; what the step does is
// covered where it lives now:
// - names in the conversation, marking one and moving on: guided-interview.spec.ts and tests/journey;
// - questions, reload and recovery: tests/client/naming-brain-widgets, naming-chat-reload, naming-brain-memory;
// - the names list, Stop, Try again, credits and limits: tests/client/naming-feed-controller,
//   naming-feed-presentation, naming-conversation-names;
// - choosing, hearts and lost answers: tests/client/project-naming-recovery, name-details;
// - account fences on every read and write: tests/client/project-naming.test.ts.
// What stays here is the old address itself. Every response is an intercepted local fixture.
const ownerId = "aaaaaaaa-1111-4111-8111-111111111111";
const projectId = "bbbbbbbb-1111-4111-8111-111111111111";
const when = "2026-10-04T10:00:00.000Z";
const oldNamingAddress = `/brands/account/${projectId}/naming`;

/** A brand saved before the guided conversation: its Strategy is reviewed, and it has no guided-interview state. */
function fixtureProject(): AccountProject {
  return accountProjectSchema.parse({
    id: projectId,
    owner_id: ownerId,
    title: "Synthetic naming project",
    scope: "complete_brand",
    current_revision: 3,
    created_at: when,
    context: {
      description: "Synthetic brief: a warm neighborhood kitchen.",
      activity: "Neighborhood kitchen",
      offering: "Seasonal lunches",
      knownAudience: "Neighbors",
      reformulationConfirmed: true,
      competitorReviewComplete: true,
      audienceSegments: [
        {
          id: "eeeeeeee-1111-4111-8111-000000000999",
          label: "Local neighbors",
          needs: ["A warm lunch"],
          reason: "Nearby",
          selected: true,
          origin: "user",
        },
      ],
      personality: { sincerity: 70, excitement: 30, competence: 60, sophistication: 30, ruggedness: 10 },
      positioning: "A welcoming everyday kitchen for neighbors.",
      intake: {
        conversation: [
          {
            id: "fixture-user",
            kind: "user_message",
            text: "Synthetic brief: a warm neighborhood kitchen.",
            createdAt: when,
          },
        ],
        audienceReviewedAt: when,
        personalityReviewedAt: when,
        positioningReviewedAt: when,
      },
    },
  });
}

async function fixtures(page: Page) {
  const state = { project: fixtureProject(), writes: [] as string[] };
  await page.route("**/api/**", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    const reply = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (request.method() !== "GET") {
      state.writes.push(`${request.method()} ${path}`);
      return reply({}, 405);
    }
    if (path === "/api/session") return reply({ user: { id: ownerId } });
    if (path === "/api/strategy")
      return reply({ availability: { status: "unavailable", operations: [], reason: "runtime_disabled" } });
    if (path === `/api/projects/${projectId}`) return reply({ project: state.project });
    if (path === `/api/projects/${projectId}/strategy`)
      return reply({ availability: { status: "unavailable", operations: [], reason: "runtime_disabled" }, jobs: [] });
    if (path === `/api/projects/${projectId}/generations`) return reply({ runs: [] });
    if (path === `/api/projects/${projectId}/logo`) return reply(emptyLogoWorkspace(state.project));
    return reply({}, 404);
  });
  return state;
}

test("an older Naming link opens the brand conversation, never a separate Naming page", async ({ page }, info) => {
  test.skip(info.project.name === "mobile", "phone layout is on hold");
  const state = await fixtures(page);
  await page.goto(oldNamingAddress);
  await expect(page).toHaveURL(`/brands/account/${projectId}?view=strategy#journey-voice`);
  await expect(page.getByRole("region", { name: "Brand conversation", exact: true })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Brand journey", exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Message Embel", exact: true })).toBeVisible();
  await expect(page.locator(".project-naming-page")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: /Find a name that feels right|Your selected name/ })).toHaveCount(0);
  expect(state.writes).toEqual([]);
});

test("a brand whose Strategy was reviewed before the guided conversation can reach the Name step", async ({ page }) => {
  test.fixme(
    true,
    "possible defect: a brand with a reviewed Strategy and no guided-interview state offers Continue to Naming, which " +
      "links to /brands/account/<id>/naming (src/domain/journey.ts:200); that address redirects back to the same " +
      "conversation (src/app/brands/account/[projectId]/naming/page.tsx), which shows no Voice section, so the " +
      "Name step never opens",
  );
  await fixtures(page);
  await page.goto(`/brands/account/${projectId}?view=strategy`);
  await page
    .getByRole("navigation", { name: "Continue project", exact: true })
    .getByRole("link", { name: "Continue to Naming", exact: true })
    .click();
  await expect(page.getByRole("heading", { name: "Which approaches would you like to explore?" })).toBeVisible();
});
