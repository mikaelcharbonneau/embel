// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { IdentityDirectionsView } from "@/features/identity-directions/components/identity-directions-panel";
import type { IdentityDirectionsController } from "@/features/identity-directions/components/use-identity-directions";
import { syntheticLogoWorkspace } from "../../fixtures/logo-creation";
import { directionFixture, id } from "./fixtures";

let root: Root | null = null;
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = null; document.body.replaceChildren(); vi.unstubAllGlobals(); });
it("qualifies every retained approval label through checking/error without replacing component choices or local controls", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const overview = directionFixture(), consistency = { hash: "a".repeat(64), status: "pass" as const, checks: [], warnings: [], blockingReasons: [] };
  overview.selection = { id: id(81), ownerId: overview.ownerId, projectId: overview.projectId, approvedLogoId: id(3), inputRevisions: [], paletteVersionId: id(20), typographyVersionId: id(31), graphicsVersionId: id(42), sourceDirectionIds: [id(10), id(11), id(12)], consistency };
  overview.approval = { id: id(82), ownerId: overview.ownerId, projectId: overview.projectId, approvedLogoId: id(3), directionSelectionId: id(81), consistencyHash: consistency.hash, approvedAt: "2026-10-07T00:00:00Z" };
  const controller = { workspace: { ...syntheticLogoWorkspace(), ownerId: overview.ownerId, projectId: overview.projectId, approvedLogo: overview.currentApprovedLogo, staleStages: [] }, canRead: true, loading: false, error: null, overview, directionIds: overview.directions.map(direction => direction.id), draft: null, generation: null, history: { overview: null }, refresh: vi.fn(), preview: vi.fn() } as unknown as IdentityDirectionsController;
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  const controls = <input aria-label="Retained local control" defaultValue="Keep this edit" />;
  const render = async (value: IdentityDirectionsController) => { await act(async () => root!.render(<IdentityDirectionsView controller={value} controls={controls} />)); };
  await render(controller);
  expect(host.textContent).toContain("Current identity approved"); expect(host.textContent).toContain("Approved selection");
  const choices = host.querySelector('[aria-label="Component choices"]'), selects = [...host.querySelectorAll("select")], input = host.querySelector("input")!;
  for (const state of [{ loading: true, error: null }, { loading: false, error: "Synthetic check failed" }]) {
    input.focus(); await render({ ...controller, ...state });
    expect(host.textContent).not.toContain("Current identity approved"); expect(host.textContent).not.toContain("Approved selection");
    expect(host.textContent).toContain("Identity approved at last check"); expect(host.textContent).toContain("Selection approved at last check");
    expect(host.querySelector('[aria-label="Component choices"]')).toBe(choices);
    expect([...host.querySelectorAll("select")]).toEqual(selects);
    expect(host.querySelector("input")).toBe(input); expect(input.value).toBe("Keep this edit"); expect(document.activeElement).toBe(input);
  }
  await render(controller);
  expect(host.textContent).toContain("Current identity approved"); expect(host.querySelector("input")).toBe(input);
  expect(controller.refresh).not.toHaveBeenCalled(); expect(controller.preview).not.toHaveBeenCalled();
});
