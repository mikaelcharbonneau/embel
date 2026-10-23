// @vitest-environment jsdom
import { act, useEffect, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { installDialogMethods } from "../helpers/dialog-methods";
import { AccountGuidedInterview } from "@/components/workspace/account-guided-interview";
import { accountProjectSchema } from "@/domain/project-api";
import { accountProjectDraft } from "@/components/workspace/project-draft-adapter";
import { initialGuidedContext } from "@/components/workspace/guided-interview-client";
const tracker = vi.hoisted(() => ({ mounts: 0, unmounts: 0 }));
vi.mock("@/domain/project-handoff", () => ({ getProjectHandoff: () => ({ next: { stage: "naming" } }) }));
vi.mock("@/domain/project-naming", () => ({ getNamingReadiness: () => ({ ready: true }) }));
vi.mock("@/components/naming/project-naming-workspace", () => ({ ProjectNamingWorkspace: ({ conversationHistory }: { conversationHistory: ReactNode }) => {
  useEffect(() => { tracker.mounts++; return () => { tracker.unmounts++; }; }, []);
  return <section data-naming>{conversationHistory}<input aria-label="Naming draft" defaultValue="Keep this text" /></section>;
} }));
vi.mock("@/components/workspace/use-strategy-jobs", () => ({ useStrategyJobs: () => ({ overview: { jobs: [], availability: { status: "unavailable", operations: [], reason: "worker_unavailable" } }, pending: false, readError: null, actionError: null, refresh: vi.fn(), enqueue: vi.fn(), cancel: vi.fn() }) }));

it("keeps the Naming canvas mounted while editing the brief and awaiting its save", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); const restore = installDialogMethods(); tracker.mounts = 0; tracker.unmounts = 0;
  const account = { status: "ready" as const, userId: crypto.randomUUID(), generation: 1 };
  const project = accountProjectSchema.parse({ id: crypto.randomUUID(), owner_id: account.userId, scope: "complete_brand", title: "Brief fixture", current_revision: 1, created_at: "2026-10-23T00:00:00Z", context: { description: "A synthetic brief" } });
  const context = initialGuidedContext(project.context, 1, "2026-10-23T00:00:00Z");
  const saved = { ...project, context: { ...context, intake: { ...context.intake, guidedInterview: { ...context.intake.guidedInterview!, stage: "complete" as const } } } };
  let workspace = { ownerId: account.userId, generation: 1, saved, draft: accountProjectDraft(saved), conflict: false };
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  const render = (busy = false) => act(async () => root.render(<AccountGuidedInterview account={account} workspace={workspace} busy={busy} saveContext={async () => null} storage={{ kind: "account", saveLabel: busy ? "Saving…" : "Saved", onUpdate: () => true }} />));
  try {
    await render(); const canvas = host.querySelector("[data-naming]"); const input = host.querySelector<HTMLInputElement>('[aria-label="Naming draft"]')!;
    await act(async () => host.querySelector<HTMLButtonElement>(".guided-brief-editor > button")!.click());
    expect(host.querySelector("[data-naming]")).toBe(canvas); expect(tracker.unmounts).toBe(0);
    workspace = { ...workspace, draft: { ...workspace.draft, title: "An edited title" } };
    await render(true); expect(host.querySelector("[data-naming]")).toBe(canvas); expect(host.querySelector('[aria-label="Naming draft"]')).toBe(input);
    workspace = { ...workspace, saved: { ...saved, title: "An edited title" } };
    await render();
    await act(async () => [...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Close")!.click());
    expect(host.querySelector("[data-naming]")).toBe(canvas); expect(input.value).toBe("Keep this text"); expect(tracker.mounts).toBe(1); expect(tracker.unmounts).toBe(0);
  } finally { await act(async () => root.unmount()); host.remove(); restore(); vi.unstubAllGlobals(); }
});
