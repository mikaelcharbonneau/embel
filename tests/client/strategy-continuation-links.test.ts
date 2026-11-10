// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, createElement, useLayoutEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ProjectEditorForm, type DraftPatch } from "@/components/workspace/project-editor";
import { accountProjectDraft, draftContext } from "@/components/workspace/project-draft-adapter";
import type { LocalDraft } from "@/components/workspace/local-drafts";
import { contextSnapshotSchema } from "@/domain/projects";
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
let root: Root | null = null;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  document.body.innerHTML = "";
  window.history.replaceState(null, "", "/");
  vi.unstubAllGlobals();
});
it("opens the requested existing review widget from a continuation link without generating or losing context", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const generate = vi.fn();
  const draft = accountProjectDraft({
    id: "d0000000-0000-4000-8000-000000000002",
    owner_id: "d0000000-0000-4000-8000-000000000001",
    current_revision: 1,
    title: "Fictional brand",
    scope: "complete_brand",
    created_at: "2026-10-07T00:00:00Z",
    context: contextSnapshotSchema.parse({ description: "Keep this original brief" }),
  });
  function Harness() {
    const [value, set] = useState(draft);
    return createElement(ProjectEditorForm, {
      draft: value,
      storage: {
        kind: "account",
        saveLabel: "Saved",
        onUpdate: (patch: DraftPatch) => {
          set((v) => ({ ...v, ...patch }));
          return false;
        },
      },
    });
  }
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(createElement(Harness)));
  await act(async () => {
    window.history.replaceState(null, "", "#strategy-positioning");
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
  expect(host.querySelector('button[aria-label="Collapse positioning"]')).not.toBeNull();
  expect(host.textContent).toContain("Keep this original brief");
  expect(generate).not.toHaveBeenCalled();
  expect(host.querySelector("#strategy-brief")).not.toBeNull();
});

it("lets a missing-description continuation be completed manually without approving downstream Strategy", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const generate = vi.fn();
  let current: LocalDraft | undefined;
  window.history.replaceState(null, "", "/brands/account/d0000000-0000-4000-8000-000000000002#strategy-brief");
  const saved = contextSnapshotSchema.parse({ activity: "Lighting studio", offering: "Repairable lamps" });
  const draft = accountProjectDraft({
    id: "d0000000-0000-4000-8000-000000000002",
    owner_id: "d0000000-0000-4000-8000-000000000001",
    current_revision: 1,
    title: "Fictional brand",
    scope: "complete_brand",
    created_at: "2026-10-07T00:00:00Z",
    context: saved,
  });
  function Harness() {
    const [value, set] = useState(draft);
    useLayoutEffect(() => {
      current = value;
    });
    return createElement(ProjectEditorForm, {
      draft: value,
      storage: {
        kind: "account",
        saveLabel: "Saved",
        savedContext: saved,
        onUpdate: (patch: DraftPatch) => {
          set((v) => ({ ...v, ...patch }));
          return false;
        },
      },
    });
  }
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(createElement(Harness)));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
  const input = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Brief description"]');
  expect(input).not.toBeNull();
  const keep = () => [...host.querySelectorAll("button")].find((button) => button.textContent === "Keep brief")!;
  expect(keep().disabled).toBe(true);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
      input,
      "Repairable lighting for small homes",
    );
    input!.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(keep().disabled).toBe(false);
  await act(async () => keep().click());
  const context = draftContext(current!, saved);
  expect(context.description).toBe("Repairable lighting for small homes");
  expect(context.reformulationConfirmed).toBe(true);
  expect(context.competitorReviewComplete).toBe(false);
  expect(context.intake.audienceReviewedAt).toBeNull();
  expect(context.intake.positioningReviewedAt).toBeNull();
  expect(generate).not.toHaveBeenCalled();
});

it("opens the editable brief from an incoming continuation link without approving or generating", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const generate = vi.fn(),
    update = vi.fn();
  window.history.replaceState(null, "", "/brands/account/d0000000-0000-4000-8000-000000000002#strategy-brief");
  const draft = accountProjectDraft({
    id: "d0000000-0000-4000-8000-000000000002",
    owner_id: "d0000000-0000-4000-8000-000000000001",
    current_revision: 1,
    title: "Fictional brand",
    scope: "complete_brand",
    created_at: "2026-10-07T00:00:00Z",
    context: contextSnapshotSchema.parse({
      description: "Original brief",
      activity: "Lighting studio",
      offering: "Repairable lamps",
    }),
  });
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root!.render(
      createElement(ProjectEditorForm, { draft, storage: { kind: "account", saveLabel: "Saved", onUpdate: update } }),
    ),
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
  expect(host.querySelector('section[aria-label="Project brief"]')).not.toBeNull();
  expect(host.querySelector('aside[aria-label="Live brief"]')?.hasAttribute("hidden")).toBe(false);
  expect(host.querySelector<HTMLInputElement>(".project-brief-widget input")?.value).toBe("Lighting studio");
  expect(update).not.toHaveBeenCalled();
  expect(generate).not.toHaveBeenCalled();
});
