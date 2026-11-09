// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ProjectProgress } from "@/components/workspace/project-progress";

// The old Creative direction page. No account, provider or network calls.
const fixture = vi.hoisted(() => ({ progress: null as ProjectProgress | null, replace: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: fixture.replace, push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/components/workspace/project-progress", () => ({ useProjectProgress: () => fixture.progress }));
vi.mock("@/components/workspace/account-session", async importOriginal => ({
  ...await importOriginal<typeof import("@/components/workspace/account-session")>(),
  useAccountSession: () => ({ session: { status: "loading" } }), AccountStatus: () => <p data-account-status />,
}));
import { VisualDirectionsPage } from "@/components/visual-directions/visual-directions-page";

const projectId = "bbbbbbbb-3333-4333-8333-333333333333";
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); fixture.replace.mockReset();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

it("sends a complete brand to Creative direction in its project conversation", async () => {
  fixture.progress = { projectId, nextHref: `/brands/account/${projectId}/logo/directions` };
  await act(async () => root.render(<VisualDirectionsPage projectId={projectId} />));
  expect(fixture.replace).toHaveBeenCalledExactlyOnceWith(`/brands/account/${projectId}?view=strategy#journey-directions`);
  expect(host.innerHTML).toBe("");
});

it("keeps the page when the project conversation is not around it", async () => {
  fixture.progress = null;
  await act(async () => root.render(<VisualDirectionsPage projectId={projectId} />));
  expect(fixture.replace).not.toHaveBeenCalled(); expect(host.querySelector("[data-account-status]")).not.toBeNull();
});

it("never redirects when it is shown inside the conversation", async () => {
  fixture.progress = { projectId, nextHref: `/brands/account/${projectId}/logo/directions` };
  await act(async () => root.render(<VisualDirectionsPage projectId={projectId} variant="conversation" />));
  expect(fixture.replace).not.toHaveBeenCalled(); expect(host.querySelector("[data-account-status]")).toBeNull();
});
