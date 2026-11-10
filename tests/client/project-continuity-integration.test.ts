// @vitest-environment jsdom
import { act, createElement, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AccountSessionProvider, useAccountSession } from "@/components/workspace/account-session";
import { AccountProjectEditor } from "@/components/workspace/account-project-editor";
import { accountProjectSchema, type AccountProject } from "@/domain/project-api";

// This suite checks the Strategy handoff, not Naming's independent API loader.
vi.mock("@/components/naming/project-naming-workspace", () => ({
  ProjectNamingWorkspace: ({ conversationHistory }: { conversationHistory?: import("react").ReactNode }) =>
    createElement("section", { "aria-label": "Inline Naming continuation" }, conversationHistory, "Naming approaches"),
}));
vi.mock("@/components/workspace/use-strategy-jobs", () => ({
  useStrategyJobs: () => ({
    overview: { jobs: [], availability: { status: "unavailable", operations: [], reason: "worker_unavailable" } },
    pending: false,
    readError: null,
    actionError: null,
    refresh: vi.fn(),
    enqueue: vi.fn(),
    cancel: vi.fn(),
  }),
}));
const id = (n: number) => `d0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const when = "2026-10-15T00:00:00Z";
let root: Root,
  host: HTMLDivElement,
  account: ReturnType<typeof useAccountSession>,
  project: AccountProject,
  requests: { path: string; init: RequestInit }[];
function Probe() {
  const next = useAccountSession();
  useLayoutEffect(() => {
    account = next;
  });
  return null;
}
async function render() {
  await act(async () =>
    root.render(
      createElement(
        AccountSessionProvider,
        null,
        createElement(Probe),
        createElement(AccountProjectEditor, { projectId: id(2) }),
      ),
    ),
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  requests = [];
  project = accountProjectSchema.parse({
    id: id(2),
    owner_id: id(1),
    current_revision: 1,
    scope: "complete_brand",
    title: "Synthetic reviewed brand",
    created_at: when,
    context: {
      description: "A neighborhood kitchen",
      activity: "Kitchen",
      offering: "Seasonal lunches",
      competitorReviewComplete: true,
      audienceSegments: [
        {
          id: id(3),
          label: "Neighbors",
          needs: ["A useful lunch"],
          reason: "They live nearby",
          selected: true,
          origin: "user",
        },
      ],
      personality: { sincerity: 80, excitement: 30, competence: 70, sophistication: 30, ruggedness: 10 },
      intake: {
        audienceReviewedAt: when,
        personalityReviewedAt: when,
        guidedInterview: { version: 1, stage: "complete", turns: [], answers: [] },
      },
    },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init: RequestInit) => {
      requests.push({ path, init });
      if (path === "/api/session") return Response.json({ user: { id: id(1) } });
      if (path === `/api/projects/${id(2)}` && init.method === "GET") return Response.json({ project });
      if (path === `/api/projects/${id(2)}/expand` && init.method === "POST") {
        expect(JSON.parse(String(init.body))).toEqual({ expectedRevision: 1 });
        project = { ...project, scope: "complete_brand", current_revision: 2 };
        return Response.json({ project });
      }
      throw new Error(`Unexpected synthetic request ${path}`);
    }),
  );
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it.each([false, true])(
  "continues reviewed saved strategy without adding the removed dashboard (selected name: %s)",
  async (nameSelected) => {
    if (nameSelected) project = { ...project, context: { ...project.context, selectedName: "Tablelight" } };
    const originalContext = structuredClone(project.context);
    await render();
    expect(host.querySelector('[aria-label="Inline Naming continuation"]')).not.toBeNull();
    // Naming continues inside the shared conversation and its floating composer.
    const conversation = host.querySelector<HTMLElement>('[aria-label="Brand conversation"]');
    expect(conversation).not.toBeNull();
    expect(conversation!.querySelector(".guided-naming-messages")).not.toBeNull();
    expect(host.querySelector('[aria-label="Naming composer"]')).not.toBeNull();
    expect(host.querySelector(`a[href="/brands/account/${id(2)}/naming"]`)).toBeNull();
    expect(host.querySelector('[aria-label="Brand context and continuation"]')).toBeNull();
    expect(host.querySelector('[aria-label="Project stages"]')).toBeNull();
    expect(account.drafts.get(id(2))!.saved.context).toEqual(originalContext);
    expect(requests.every((request) => request.init.method === "GET")).toBe(true);
  },
);

it("lets a reviewed legacy brand continue to Naming without creating an interview", async () => {
  project = {
    ...project,
    context: {
      ...project.context,
      reformulationConfirmed: true,
      positioning: "A useful everyday kitchen",
      intake: { ...project.context.intake, positioningReviewedAt: when, guidedInterview: undefined },
    },
  };
  const originalContext = structuredClone(project.context);
  await render();
  expect(host.querySelector(`a[href="/brands/account/${id(2)}/naming"]`)?.textContent).toBe("Continue to Naming");
  expect(host.querySelector('[aria-label="Inline Naming continuation"]')).toBeNull();
  expect(account.drafts.get(id(2))!.saved.context).toEqual(originalContext);
  expect(requests.every((request) => request.init.method === "GET")).toBe(true);
});

it("keeps an incomplete complete-brand project in its guided interview until saved strategy is ready", async () => {
  project = {
    ...project,
    context: { ...project.context, intake: { ...project.context.intake, personalityReviewedAt: null } },
  };
  await render();
  expect(host.querySelector(`a[href="/brands/account/${id(2)}/naming"]`)).toBeNull();
  expect(host.querySelector(`a[href="/brands/account/${id(2)}/inspiration"]`)).toBeNull();
  expect(host.querySelector('[aria-label="Brand conversation"]')).not.toBeNull();
  expect(requests.every((request) => request.init.method === "GET")).toBe(true);
});
