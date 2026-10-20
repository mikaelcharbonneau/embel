// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
vi.mock("server-only", () => ({}));
import type { AccountLogoClient } from "@/components/identity/account-logo-client";
import { logoDeliverablesOverviewSchema, type LogoDeliverablesOverview } from "@/domain/logo-deliverables";
import { DeliverablesView } from "@/features/identity-deliverables/components/deliverables-panel";
import type { LogoExportsController } from "@/features/identity-deliverables/components/use-logo-exports";

// Synthetic controller/metadata fixtures only. These tests do not authenticate
// an account, verify asset bytes, exercise HTTP, or establish browser geometry.
const id = (n: number) => `97000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const at = "2026-10-20T00:00:00Z";
const scope = { ownerId: id(1), projectId: id(2) };
const client = { previewAsset: vi.fn(async () => null) } as unknown as AccountLogoClient;
function emptyOverview(): LogoDeliverablesOverview {
  return logoDeliverablesOverviewSchema.parse({
    ...scope, logoApproval: null, directionApproval: null, variantSets: [],
    variantReviews: [], exports: [], exportRequests: [], nextCursor: null, nextRequestCursor: null,
  });
}
function populatedOverview(): LogoDeliverablesOverview {
  const contentHash = "a".repeat(64);
  return logoDeliverablesOverviewSchema.parse({
    ...emptyOverview(),
    exports: [{
      stale: true,
      manifest: {
        id: id(10), ...scope, requestKey: id(11), approvedLogoId: id(12),
        directionApprovalId: id(13), variantSetId: id(14), variantReviewId: id(15),
        sourceSnapshotHash: "b".repeat(64), licenseOmissions: [], inputRevisions: [], createdAt: at,
        files: [{
          role: "primary_color", format: "png", variantId: id(16),
          asset: {
            id: id(17), reference: { ...scope, assetId: id(18), versionId: id(19), contentHash },
            verification: { status: "verified", checkedAt: at, contentHash, mimeType: "image/png", byteLength: 100 },
            purpose: "brand_asset", sourceReceiptId: id(20), rightsEvidenceId: null, publicationState: "committed",
          },
        }],
      },
    }],
  });
}
function controller(extra: Partial<LogoExportsController> = {}): LogoExportsController {
  return {
    workspace: null, overview: emptyOverview(), variantSetId: null,
    selectedOptions: { pngLongEdge: 2048, socialSelections: [] },
    pendingRequestKey: null, requestState: null, loading: false, error: null,
    canRead: true, canPrepare: false, canExport: false,
    blockedReason: "Approve a logo and identity direction first.", downloadMessage: null,
    refresh: vi.fn(async () => {}), prepareVariants: vi.fn(async () => {}),
    reviewVariants: vi.fn(async () => {}), request: vi.fn(async () => {}),
    retryOriginalExport: vi.fn(async () => {}), reconcile: vi.fn(async () => {}),
    download: vi.fn(async () => {}), selectOptions: vi.fn(),
    checkRequest: vi.fn(async () => {}), loadMore: vi.fn(async () => {}),
    ...extra,
  };
}

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
async function render(c: LogoExportsController) {
  await act(async () => root.render(createElement(DeliverablesView, { controller: c, client })));
}
function emptySection() { return host.querySelector(".project-export-empty"); }
function button(label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll("button")].find(node => node.textContent === label);
  expect(found, `button: ${label}`).toBeDefined();
  return found!;
}
async function click(label: string) { await act(async () => button(label).click()); }
function expectNoWrites(c: LogoExportsController) {
  for (const callback of [c.prepareVariants, c.reviewVariants, c.request, c.retryOriginalExport]) {
    expect(callback).not.toHaveBeenCalled();
  }
}

describe("saved export history continuity", () => {
  it("keeps the exact known-empty section, heading and body while saved work is pending", async () => {
    const c = controller({ canPrepare: true, canExport: true });
    await render(c);
    const section = emptySection(), heading = section!.querySelector("h3"), body = section!.querySelector("p");
    await click("Refresh saved work");
    expect(c.refresh).toHaveBeenCalledOnce();
    await render({ ...c, loading: true });

    expect(emptySection()).toBe(section);
    expect(section!.querySelector("h3")).toBe(heading);
    expect(section!.querySelector("p")).toBe(body);
    expect(body!.textContent).toContain("No completed exports at the last check.");
    expect(body!.textContent).toContain("Work is in progress.");
    expect(body!.textContent).not.toContain("No completed exports yet.");
    expect(host.firstElementChild!.getAttribute("aria-busy")).toBe("true");
    for (const label of ["Refresh saved work", "Prepare variants", "Create brand files"]) {
      expect(button(label).disabled).toBe(true);
      await click(label);
    }
    expect(host.querySelector("select")!.disabled).toBe(true);
    expect(host.querySelector("fieldset")!.disabled).toBe(true);
    expect(c.refresh).toHaveBeenCalledOnce();
    expectNoWrites(c);
  });

  it("keeps known-empty nodes after a read failure without claiming a fresh empty result", async () => {
    const c = controller();
    await render(c);
    const section = emptySection(), heading = section!.querySelector("h3"), body = section!.querySelector("p");
    await render({ ...c, loading: true });
    await render({ ...c, error: "Synthetic saved-work read failed." });

    expect(emptySection()).toBe(section);
    expect(section!.querySelector("h3")).toBe(heading);
    expect(section!.querySelector("p")).toBe(body);
    expect(body!.textContent).toContain("No completed exports at the last check.");
    expect(body!.textContent).toContain("Refresh saved work to check the latest history.");
    expect(body!.textContent).not.toContain("No completed exports yet.");
    expect(host.querySelector('[role="alert"]')!.textContent).toBe("Synthetic saved-work read failed.");
    expect(button("Refresh saved work").disabled).toBe(false);
    expectNoWrites(c);
  });

  it("marks an initial read as unconfirmed instead of inventing known-empty history", async () => {
    const c = controller({ overview: null, loading: true });
    await render(c);
    expect(emptySection()).toBeNull();
    expect(host.textContent).not.toContain("No completed exports");
    expect([...host.querySelectorAll("h3")].some(node => node.textContent === "Saved exports")).toBe(false);
    expect(host.textContent).toContain("Export history has not been confirmed yet.");
    expect(host.firstElementChild!.getAttribute("aria-busy")).toBe("true");
    await render({ ...c, loading: false, error: "Synthetic initial read failed." });
    expect(emptySection()).toBeNull();
    expect(host.textContent).not.toContain("No completed exports");
    expectNoWrites(c);
  });

  it("accepts a successful empty read then replaces it with the supplied populated history", async () => {
    const c = controller();
    await render(c);
    const section = emptySection(), heading = section!.querySelector("h3"), body = section!.querySelector("p");
    await render({ ...c, loading: true });
    await render({ ...c, overview: emptyOverview() });
    expect(emptySection()).toBe(section);
    expect(section!.querySelector("h3")).toBe(heading);
    expect(section!.querySelector("p")).toBe(body);
    expect(body!.textContent).toContain("No completed exports yet.");
    expect(body!.textContent).not.toContain("last check");

    const overview = populatedOverview();
    await render({ ...c, overview });
    expect(emptySection()).toBeNull();
    const history = host.querySelector('[aria-label="Saved brand files"]');
    expect(history!.textContent).toContain("Earlier approved version");
    await render({ ...c, overview, loading: true });
    expect(host.querySelector('[aria-label="Saved brand files"]')).toBe(history);
    expect(button("Check and download").disabled).toBe(true);
    await click("Check and download");
    expect(c.download).not.toHaveBeenCalled();
    await render({ ...c, overview, error: "Synthetic unrelated operation failed." });
    expect(host.querySelector('[aria-label="Saved brand files"]')).toBe(history);
    expect(button("Create brand files").disabled).toBe(true);
    expect(button("Check and download").disabled).toBe(false);
    await click("Check and download");
    expect(c.download).toHaveBeenCalledExactlyOnceWith(overview.exports[0]!.manifest.files[0]!.asset);
    expectNoWrites(c);
  });

  it.each(["overview", "canRead"] as const)("immediately removes prior private history when %s is absent", async missing => {
    const c = controller();
    await render(c);
    const prior = emptySection();
    await render({ ...c, loading: true, ...(missing === "overview" ? { overview: null } : { canRead: false }) });
    expect(emptySection()).toBeNull();
    expect(prior!.isConnected).toBe(false);
    expect(host.textContent).not.toContain("No completed exports");
    if (missing === "canRead") {
      expect(host.textContent).toContain("Sign in to the matching account");
      expect(host.querySelectorAll("button,input,select")).toHaveLength(0);
    }
    await render(c);
    expect(emptySection()).not.toBe(prior);
    expectNoWrites(c);
  });

  it("preserves the original-request locks and recovery actions without creating another export", async () => {
    const c = controller({ pendingRequestKey: id(30), canPrepare: true, canExport: true });
    await render(c);
    const section = emptySection();
    for (const label of ["Prepare variants", "Create brand files"]) {
      expect(button(label).disabled).toBe(true);
      await click(label);
    }
    expect(host.querySelector("select")!.disabled).toBe(true);
    expect(host.querySelector("fieldset")!.disabled).toBe(true);
    await render({ ...c, loading: true });
    for (const label of ["Check original export", "Retry original export"]) {
      expect(button(label).disabled).toBe(true);
      await click(label);
    }
    expect(c.reconcile).not.toHaveBeenCalled();
    expectNoWrites(c);
    await render({ ...c, error: "Synthetic original request remains unresolved." });
    expect(emptySection()).toBe(section);
    expect(button("Check original export").disabled).toBe(false);
    expect(button("Retry original export").disabled).toBe(false);
    await click("Check original export");
    expect(c.reconcile).toHaveBeenCalledOnce();
    expectNoWrites(c);
    await click("Retry original export");
    expect(c.retryOriginalExport).toHaveBeenCalledOnce();
    expect(c.request).not.toHaveBeenCalled();
    expect(c.selectOptions).not.toHaveBeenCalled();
  });

  it("does not infer fresh action authority or refresh failure from retained history and a generic error", async () => {
    const c = controller({
      canPrepare: false, canExport: false, error: "Synthetic download verification failed.",
      blockedReason: "The saved approvals changed.",
    });
    await render(c);
    expect(emptySection()!.textContent).toContain("No completed exports at the last check.");
    expect(emptySection()!.textContent).not.toMatch(/refresh failed|could not be refreshed/i);
    expect(host.querySelector('[role="alert"]')!.textContent).toBe(c.error);
    expect(host.textContent).toContain(c.blockedReason);
    for (const label of ["Prepare variants", "Create brand files"]) {
      expect(button(label).disabled).toBe(true);
      await click(label);
    }
    expectNoWrites(c);
  });
});
