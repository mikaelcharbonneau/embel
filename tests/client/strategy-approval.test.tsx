// @vitest-environment jsdom
import { act, createElement, useLayoutEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { accountProjectSchema } from "@/domain/project-api";
import type { ConversationWidget } from "@/domain/conversation";
import { getNamingReadiness } from "@/domain/project-naming";
import { ProjectEditorForm, type DraftPatch } from "@/components/workspace/project-editor";
import { accountProjectDraft, draftContext } from "@/components/workspace/project-draft-adapter";
import type { LocalDraft } from "@/components/workspace/local-drafts";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
const when = "2026-10-04T10:00:00.000Z";
const baseline = accountProjectSchema.parse({ id: "bbbbbbbb-1111-4111-8111-111111111111", owner_id: "aaaaaaaa-1111-4111-8111-111111111111", title: "Strategy approval fixture", scope: "complete_brand", current_revision: 1, created_at: when,
  context: { description: "A neighborhood kitchen", activity: "Kitchen", offering: "Seasonal lunches", knownAudience: "Neighbors", reformulationConfirmed: true, competitorReviewComplete: true,
    audienceSegments: [{ id: "eeeeeeee-1111-4111-8111-111111111111", label: "Neighbors", needs: ["Lunch nearby"], reason: "Local customers", selected: true, origin: "user" }],
    personality: { sincerity: 70, excitement: 35, competence: 60, sophistication: 30, ruggedness: 20 }, positioning: "A warm everyday kitchen for neighbors.",
    intake: { step: "positioning", audienceReviewedAt: when, personalityReviewedAt: when } } });
let root: Root | null, host: HTMLDivElement, current: LocalDraft;
const save = vi.fn<(draft: LocalDraft) => Promise<boolean>>(), generate = vi.fn<(widget: ConversationWidget) => Promise<void>>();
function Harness({ project = baseline }: { project?: typeof baseline }) {
  const [draft, setDraft] = useState(() => accountProjectDraft(project));
  useLayoutEffect(() => { current = draft; });
  return createElement(ProjectEditorForm, { draft, storage: { kind: "account", saveLabel: "Saved", savedContext: project.context,
    onUpdate: (patch: DraftPatch) => { setDraft(previous => ({ ...previous, ...patch })); return true; }, onStrategyApproved: save, onStrategyRequested: generate } });
}
async function render(project = baseline) { await act(async () => root!.render(createElement(Harness, { project }))); }
async function click(label: string) { await act(async () => { const button = [...host.querySelectorAll("button")].find(item => item.textContent === label); expect(button).toBeDefined(); button!.click(); }); }
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); save.mockReset().mockResolvedValue(true); generate.mockReset();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = null; document.body.replaceChildren(); window.history.replaceState(null, "", "/"); });

describe("Strategy approval leads to a usable Naming basis", () => {
  it.each(["brief", "competitors", "audience"] as const)("opens the missing %s review instead of claiming full approval", async missing => {
    const context = structuredClone(baseline.context);
    if (missing === "brief") context.reformulationConfirmed = false;
    if (missing === "competitors") context.competitorReviewComplete = false;
    if (missing === "audience") context.intake.audienceReviewedAt = null;
    await render({ ...baseline, context }); await click("Approve strategy");
    expect(save).not.toHaveBeenCalled(); expect(generate).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain("Strategy approved and saved");
    expect(host.textContent).toContain(`Review your ${missing} before approving Strategy`);
    if (missing === "brief") expect(host.querySelector(".project-brief-widget")).not.toBeNull();
    else expect(host.querySelector(`button[aria-label="Collapse ${missing}"]`)).not.toBeNull();
    expect(current.positioning).toBe(baseline.context.positioning);
  });

  it("saves explicit approval only when the resulting strategy is ready for Naming", async () => {
    await render(); await click("Approve strategy");
    expect(save).toHaveBeenCalledTimes(1); expect(generate).not.toHaveBeenCalled();
    const approved = draftContext(save.mock.calls[0]![0] as LocalDraft, baseline.context);
    expect(getNamingReadiness(approved, "complete_brand")).toEqual({ ready: true, missing: [] });
    expect(approved.intake.positioningReviewedAt).not.toBeNull();
    expect(host.textContent).toContain("Strategy approved and saved to your account.");
  });

  it("resumes the missing audience review through personality and approval without generation", async () => {
    const context = { ...baseline.context, intake: { ...baseline.context.intake, audienceReviewedAt: null } };
    await render({ ...baseline, context }); await click("Approve strategy");
    await click("Keep audience"); await click("Keep personality"); await click("Approve strategy");
    expect(save).toHaveBeenCalledTimes(1); expect(generate).not.toHaveBeenCalled();
    const approved = draftContext(save.mock.calls[0]![0] as LocalDraft, context);
    expect(getNamingReadiness(approved, "complete_brand").ready).toBe(true);
    expect(approved.positioning).toBe(baseline.context.positioning);
    expect(approved.audienceSegments).toEqual(baseline.context.audienceSegments);
  });

  it("keeps the complete approval draft after a save failure without starting Naming", async () => {
    save.mockResolvedValue(false); await render(); await click("Approve strategy");
    expect(save).toHaveBeenCalledTimes(1); expect(generate).not.toHaveBeenCalled();
    expect(current.positioning).toBe(baseline.context.positioning);
    expect(getNamingReadiness(draftContext(current, baseline.context), "complete_brand").ready).toBe(true);
    expect(host.textContent).toContain("Strategy approval could not be saved. Your review is kept here.");
    expect(host.textContent).not.toContain("Strategy approved and saved");
  });
});
