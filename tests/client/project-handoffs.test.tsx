// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { accountProjectSchema } from "@/domain/project-api";
import { ProjectContinuityPanel } from "@/features/brand-lifecycle/continuity-panel";

const now = "2026-10-13T00:00:00Z";
const project = accountProjectSchema.parse({ id: "d0000000-0000-4000-8000-000000000002", owner_id: "d0000000-0000-4000-8000-000000000001", current_revision: 3, title: "Luma fixture", scope: "complete_brand", created_at: now,
  context: { description: "Repairable lighting", activity: "Lighting studio", offering: "Repairable lamps", reformulationConfirmed: true, competitorReviewComplete: true,
    audienceSegments: [{ id: "d0000000-0000-4000-8000-000000000003", label: "Small homes", needs: [], reason: "Compact lamps", selected: true, origin: "user" }],
    personality: { sincerity: 60, excitement: 30, competence: 70, sophistication: 40, ruggedness: 20 }, positioning: "Repairable lamps for small homes", selectedName: "Luma",
    intake: { audienceReviewedAt: now, personalityReviewedAt: now, positioningReviewedAt: now } } });
let root: Root | null, host: HTMLDivElement;
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = null; document.body.replaceChildren(); vi.unstubAllGlobals(); });
async function render(saved = project, dirty = false) { await act(async () => root!.render(createElement(ProjectContinuityPanel, { project: saved, source: null, dirty, conflicted: false, busy: false }))); }

it("shows accepted saved context and continues the selected name to Inspiration", async () => {
  await render();
  expect(host.textContent).toContain("Reviewed brief"); expect(host.textContent).toContain("Strategy reviewed"); expect(host.textContent).toContain("Luma");
  expect(host.querySelector(`a[href="/brands/account/${project.id}/inspiration"]`)?.textContent).toBe("Continue to Inspiration");
});
it("guides an unreviewed selected audience without labeling its text as approved", async () => {
  await render({ ...project, context: { ...project.context, intake: { ...project.context.intake, audienceReviewedAt: null } } });
  expect(host.textContent).not.toContain("Strategy reviewed");
  expect(host.querySelector('a[href="#strategy-audience"]')?.textContent).toBe("Review audience");
  expect(host.textContent).toContain("Your saved name is kept");
  expect(host.querySelector(`a[href="/brands/account/${project.id}/inspiration"]`)).toBeNull();
});
it("retains accepted context while dirty edits prevent downstream continuation", async () => {
  await render(project, true);
  expect(host.textContent).toContain("Luma");
  expect(host.querySelector(`a[href="/brands/account/${project.id}/inspiration"]`)).toBeNull();
  expect([...host.querySelectorAll("button")].find(button => button.textContent === "Continue to Inspiration")?.disabled).toBe(true);
  expect(host.textContent).toContain("Save or resolve your edits before continuing");
});
