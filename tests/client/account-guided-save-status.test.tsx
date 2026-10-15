// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { accountProjectSchema } from "@/domain/project-api";
import { AccountGuidedInterview } from "@/components/workspace/account-guided-interview";
import { accountProjectDraft } from "@/components/workspace/project-draft-adapter";

vi.mock("@/components/workspace/use-strategy-jobs", () => ({ useStrategyJobs: () => ({ overview: { jobs: [], availability: { status: "unavailable", operations: [], reason: "worker_unavailable" } }, pending: false, readError: null, actionError: null, refresh: vi.fn(), enqueue: vi.fn(), cancel: vi.fn() }) }));

it("shows the parent's validation failure even when no pending context was accepted", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const account = { status: "ready" as const, userId: crypto.randomUUID(), generation: 1 };
  const saved = accountProjectSchema.parse({ id: crypto.randomUUID(), owner_id: account.userId, scope: "complete_brand", title: "Validation fixture", current_revision: 1, created_at: "2026-10-15T00:00:00Z", context: { description: "A neighborhood lunch kitchen" } });
  const workspace = { ownerId: account.userId, generation: 1, saved, draft: accountProjectDraft(saved), conflict: false };
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(AccountGuidedInterview, { account, workspace, busy: false, saveContext: async () => null, storage: { kind: "account", saveLabel: "Saved", onUpdate: () => false, actions: createElement("p", { role: "alert" }, "This answer could not be saved. Your conversation is kept in this tab.") } })));
    expect(host.textContent).toContain("This answer could not be saved. Your conversation is kept in this tab.");
  } finally { await act(async () => root.unmount()); host.remove(); }
});
