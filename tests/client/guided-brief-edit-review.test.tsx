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
vi.mock("@/components/workspace/use-strategy-jobs", async () => {
  const { withStrategyView } = await import("./guided-strategy-hook");
  return {
    useStrategyJobs: () =>
      withStrategyView({
        overview: { jobs: [], availability: { status: "unavailable", operations: [], reason: "worker_unavailable" } },
        pending: false,
        readError: null,
        actionError: null,
        refresh: vi.fn(),
        enqueue: vi.fn(),
        cancel: vi.fn(),
      }),
  };
});

const when = "2026-11-14T00:00:00Z";
const account = { status: "ready" as const, userId: crypto.randomUUID(), generation: 1 };
/** Personality is confirmed: the conversation is at Slogan and shows the names. */
function fixture(change: (context: Record<string, unknown> & { intake: Record<string, unknown> }) => void = () => {}) {
  const context = {
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
      conversation: [{ id: "first", kind: "user_message", text: "A repairable lighting studio", createdAt: when }],
      guidedInterview: { version: 1, stage: "slogan", turns: [], answers: [] },
    } as Record<string, unknown>,
  };
  change(context);
  return accountProjectSchema.parse({
    id: crypto.randomUUID(),
    owner_id: account.userId,
    scope: "complete_brand",
    title: "Brief edit fixture",
    current_revision: 5,
    created_at: when,
    context,
  });
}
async function mount(saved: ReturnType<typeof fixture>) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const restore = installDialogMethods();
  const state: { workspace: AccountWorkspace } = {
    workspace: { ownerId: account.userId, generation: 1, saved, draft: accountProjectDraft(saved), conflict: false },
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
          workspace={state.workspace}
          busy={false}
          saveContext={saveContext}
          storage={{
            kind: "account",
            saveLabel: "Saved",
            onUpdate: (patch: DraftPatch) => {
              state.workspace = { ...state.workspace, draft: { ...state.workspace.draft, ...patch } };
              return false;
            },
          }}
        />,
      ),
    );
  const button = (label: string) =>
    [...host.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === label);
  /** Edit the brief in its editor, exactly as a person would, then let the page save it. */
  const editDescription = async (text: string) => {
    await act(async () => host.querySelector<HTMLButtonElement>("button[aria-label='Edit brief']")!.click());
    const description = host.querySelector<HTMLTextAreaElement>("textarea[name='description']")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(description, text);
      description.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const context = draftContext(state.workspace.draft, saved.context);
    const edited = { ...saved, current_revision: saved.current_revision + 1, context };
    state.workspace = { ...state.workspace, saved: edited, draft: accountProjectDraft(edited) };
    await render();
    await act(async () => button("Close")!.click());
    return context;
  };
  await render();
  return {
    host,
    saveContext,
    button,
    editDescription,
    done: async () => {
      await act(async () => root.unmount());
      host.remove();
      restore();
      vi.unstubAllGlobals();
    },
  };
}

it("keeps the confirmed answers and the names open when the brief changes, and offers to redo Strategy", async () => {
  const saved = fixture();
  expect(getNamingReadiness(saved.context, saved.scope).ready).toBe(true);
  const { host, saveContext, button, editDescription, done } = await mount(saved);
  try {
    expect(host.querySelector("[data-naming]")).not.toBeNull();
    expect(host.querySelector(".guided-brief-changed")).toBeNull();
    // Owner decision (November 14, 2026): the confirmed answers and progress stay, nothing closes, and both
    // records of "is Strategy done?" still agree.
    const context = await editDescription("A repairable lighting studio for renters");
    expect(context.description).toBe("A repairable lighting studio for renters");
    expect(getNamingReadiness(context, "complete_brand")).toEqual({ ready: true, missing: [] });
    expect(context).toMatchObject({
      competitorReviewComplete: true,
      intake: { audienceReviewedAt: when, personalityReviewedAt: when, positioningReviewedAt: when },
    });
    expect(context.intake.guidedInterview?.stage).toBe("slogan");

    // The names stay open, and nothing asks for a review.
    expect(host.querySelector("[data-naming]")).not.toBeNull();
    expect(host.textContent).not.toContain("Your strategy needs another look");
    // One notice says what happened and offers the redo. It says redoing uses credits (owner decision,
    // November 14, 2026) and names no amount and no price.
    const notice = host.querySelector<HTMLElement>(".guided-brief-changed")!;
    expect(notice.textContent).toContain("Your brief changed");
    expect(notice.textContent).toContain("Your Strategy answers are kept.");
    expect(notice.textContent).toContain("Redoing Strategy uses credits.");
    expect(notice.textContent).not.toMatch(/\$|\d|cost|price/iu);
    expect(saveContext).not.toHaveBeenCalled();
    const redo = button("Redo Strategy")!;
    expect(redo.disabled).toBe(false);
    // Redoing is the usual "Change answer" on the first Strategy step, which also records the brief it starts from.
    await act(async () => redo.click());
    expect(saveContext).toHaveBeenCalledOnce();
    const next = saveContext.mock.calls[0]![0];
    expect(next.intake.guidedInterview?.stage).toBe("competitors");
    expect(next.competitorReviewComplete).toBe(false);
    expect(next.description).toBe("A repairable lighting studio for renters");
    expect(next.intake.conversation?.find((event) => event.kind === "saved_context")).toMatchObject({
      text: "A repairable lighting studio for renters",
    });
  } finally {
    await done();
  }
});

it("closing the notice changes nothing that is saved", async () => {
  const { host, saveContext, editDescription, done } = await mount(fixture());
  try {
    await editDescription("A repairable lighting studio for renters");
    const close = host.querySelector<HTMLButtonElement>(".guided-brief-changed button[aria-label]")!;
    await act(async () => close.click());
    expect(host.querySelector(".guided-brief-changed")).toBeNull();
    expect(host.querySelector("[data-naming]")).not.toBeNull();
    expect(saveContext).not.toHaveBeenCalled();
  } finally {
    await done();
  }
});

it("still stops at an emptied brief: the names close and the work area offers the brief", async () => {
  const { host, button, editDescription, done } = await mount(fixture());
  try {
    const context = await editDescription("");
    expect(getNamingReadiness(context, "complete_brand").missing).toEqual(["description"]);
    expect(host.querySelector("[data-naming]")).toBeNull();
    expect(host.querySelector(".guided-brief-changed")).toBeNull();
    expect(host.querySelector('[aria-busy="true"], .guided-option--skeleton')).toBeNull();
    expect(host.textContent).toContain("Your strategy needs another look");
    expect(button("Edit brief")!.disabled).toBe(false);
  } finally {
    await done();
  }
});

it("offers the step to review, not an endless loading state, to a project whose earlier brief edit cleared its confirmations", async () => {
  // Before November 14, 2026 a brief edit cleared the confirmations and left the conversation at Slogan.
  const saved = fixture((context) => {
    context.description = "A repairable lighting studio for renters";
    context.competitorReviewComplete = false;
    Object.assign(context.intake, {
      audienceReviewedAt: null,
      personalityReviewedAt: null,
      positioningReviewedAt: null,
    });
  });
  const { host, saveContext, button, done } = await mount(saved);
  try {
    expect(host.querySelector("[data-naming]")).toBeNull();
    expect(host.querySelector('[aria-busy="true"], .guided-option--skeleton')).toBeNull();
    expect(host.querySelector(".guided-brief-changed")).toBeNull();
    expect(host.textContent).toContain("Your strategy needs another look");
    const review = button("Review competitors")!;
    expect(review.disabled).toBe(false);
    // The one click reopens that step, which makes both records of "is Strategy done?" agree.
    await act(async () => review.click());
    expect(saveContext).toHaveBeenCalledOnce();
    const next = saveContext.mock.calls[0]![0];
    expect(next.intake.guidedInterview?.stage).toBe("competitors");
    expect(next.competitorReviewComplete).toBe(false);
  } finally {
    await done();
  }
});
