// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { installDialogMethods } from "../helpers/dialog-methods";
import { AccountGuidedInterview } from "@/components/workspace/account-guided-interview";
import type { AccountWorkspace } from "@/components/workspace/account-draft-memory";
import type { DraftPatch } from "@/components/workspace/project-editor";
import { accountProjectDraft, draftContext } from "@/components/workspace/project-draft-adapter";
import { accountProjectSchema } from "@/domain/project-api";
import { getNamingReadiness } from "@/domain/project-naming";
import type { ContextSnapshot } from "@/domain/projects";

vi.mock("@/components/inspiration/inspiration-workspace", () => ({ InspirationWorkspace: () => null }));
vi.mock("@/components/inspiration/inspiration-like-count", () => ({ InspirationLikeCount: () => null }));
vi.mock("@/components/logo-creation/logo-creation-workspace", () => ({ LogoCreationWorkspace: () => null }));
vi.mock("@/components/visual-directions/visual-directions-page", () => ({ VisualDirectionsPage: () => null }));
vi.mock("@/components/naming/project-naming-workspace", () => ({
  ProjectNamingWorkspace: () => <section data-naming />,
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

const when = "2026-11-14T00:00:00Z";
it("offers a way forward, not an endless loading state, when the brief changes after Personality is confirmed", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const restore = installDialogMethods();
  const account = { status: "ready" as const, userId: crypto.randomUUID(), generation: 1 };
  // Personality is confirmed: the conversation is at Slogan and shows the names.
  const saved = accountProjectSchema.parse({
    id: crypto.randomUUID(),
    owner_id: account.userId,
    scope: "complete_brand",
    title: "Brief edit fixture",
    current_revision: 5,
    created_at: when,
    context: {
      description: "A repairable lighting studio",
      activity: "Lighting",
      offering: "Repairable lamps",
      competitorReviewComplete: true,
      audienceSegments: [
        { id: crypto.randomUUID(), label: "Small homes", needs: [], reason: "Compact", selected: true, origin: "user" },
      ],
      personality: { sincerity: 60, excitement: 30, competence: 70, sophistication: 40, ruggedness: 20 },
      positioning: "Repairable lights for small homes",
      intake: {
        audienceReviewedAt: when,
        personalityReviewedAt: when,
        positioningReviewedAt: when,
        guidedInterview: { version: 1, stage: "slogan", turns: [], answers: [] },
      },
    },
  });
  expect(getNamingReadiness(saved.context, saved.scope).ready).toBe(true);
  let workspace: AccountWorkspace = {
    ownerId: account.userId,
    generation: 1,
    saved,
    draft: accountProjectDraft(saved),
    conflict: false,
  };
  const saveContext = vi.fn(async (context: ContextSnapshot) => {
    void context;
    return null;
  });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const render = () =>
    act(async () =>
      root.render(
        <AccountGuidedInterview
          account={account}
          workspace={workspace}
          busy={false}
          saveContext={saveContext}
          storage={{
            kind: "account",
            saveLabel: "Saved",
            onUpdate: (patch: DraftPatch) => {
              workspace = { ...workspace, draft: { ...workspace.draft, ...patch } };
              return false;
            },
          }}
        />,
      ),
    );
  const button = (label: string) =>
    [...host.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === label);
  try {
    await render();
    expect(host.querySelector("[data-naming]")).not.toBeNull();
    // Edit the brief in its editor, exactly as a person would.
    await act(async () => host.querySelector<HTMLButtonElement>("button[aria-label='Edit brief']")!.click());
    const description = host.querySelector<HTMLTextAreaElement>("textarea[name='description']")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
        description,
        "A repairable lighting studio for renters",
      );
      description.dispatchEvent(new Event("input", { bubbles: true }));
    });
    // The page saves the edit: the saved brief no longer has a reviewed Strategy, yet the conversation is still at Slogan.
    const context = draftContext(workspace.draft, saved.context);
    const edited = { ...saved, current_revision: 6, context };
    expect(getNamingReadiness(context, "complete_brand").missing).toContain("competitors");
    expect(context.intake.guidedInterview?.stage).toBe("slogan");
    workspace = { ...workspace, saved: edited, draft: accountProjectDraft(edited) };
    await render();
    await act(async () => button("Close")!.click());

    expect(host.querySelector("[data-naming]")).toBeNull();
    expect(host.querySelector('[aria-busy="true"], .guided-option--skeleton')).toBeNull();
    expect(host.textContent).toContain("Your strategy needs another look");
    const review = button("Review competitors")!;
    expect(review.disabled).toBe(false);
    // The one click reopens that step, which makes both records of "is Strategy done?" agree.
    await act(async () => review.click());
    expect(saveContext).toHaveBeenCalledOnce();
    const next = saveContext.mock.calls[0]![0];
    expect(next.intake.guidedInterview?.stage).toBe("competitors");
    expect(next.competitorReviewComplete).toBe(false);
    expect(next.description).toBe("A repairable lighting studio for renters");
  } finally {
    await act(async () => root.unmount());
    host.remove();
    restore();
    vi.unstubAllGlobals();
  }
});
