// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AssetDetailDialog } from "@/components/assets/asset-detail";
import type { AccountAssetsClient } from "@/components/assets/account-assets-client";
import {
  assetDetailSchema,
  assetLibraryItemSchema,
  assetRevisionFreshness,
  assetVersionDetailSchema,
} from "@/domain/asset-library";
const id = (n: number) => `97000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  at = "2026-10-07T00:00:00Z";
const version = assetVersionDetailSchema.parse({
  ownerId: id(1),
  projectId: id(2),
  assetId: id(3),
  versionId: id(4),
  contentHash: "a".repeat(64),
  versionNumber: 1,
  inputRevision: 1,
  inputHash: "b".repeat(64),
  createdAt: at,
  mimeType: "image/svg+xml",
  format: "svg",
  provenance: { status: "legacy_unverified" },
  vectorStatus: "unverified",
  licenseStatus: "unverified",
  fileState: "unverified",
  fileVerification: null,
  freshness: assetRevisionFreshness(1, 1),
});
const asset = {
  id: id(3),
  ownerId: id(1),
  projectId: id(2),
  kind: "Fictional logo",
  purpose: "brand_asset",
  createdAt: at,
  versionCount: 1,
  retentionRevision: 0,
  liked: false,
  saved: false,
  usage: { active: false, legacy: false },
  selectionRevision: 0,
  currentSelection: null,
};
const project = {
  id: id(2),
  owner_id: id(1),
  title: "Fictional brand",
  scope: "complete_brand",
  current_revision: 1,
  created_at: at,
};
const versions = {
  ownerId: id(1),
  projectId: id(2),
  assetId: id(3),
  format: null,
  items: [version],
  totalCount: 1,
  nextCursor: null,
};
const detail = assetDetailSchema.parse({ asset, project, selectedVersion: null, versions }),
  item = assetLibraryItemSchema.parse({
    asset,
    project,
    selectedVersion: null,
    displayedVersion: version,
    matchingVersions: versions,
  });
const manifest = {
  id: id(10),
  ownerId: id(1),
  projectId: id(2),
  requestKey: id(11),
  approvedLogoId: id(12),
  directionApprovalId: id(13),
  variantSetId: id(14),
  variantReviewId: id(15),
  sourceSnapshotHash: "c".repeat(64),
  files: [
    {
      role: "primary.black",
      format: "svg",
      variantId: id(16),
      asset: {
        id: id(9),
        reference: { ownerId: id(1), projectId: id(2), assetId: id(3), versionId: id(4), contentHash: "a".repeat(64) },
        verification: {
          status: "verified",
          checkedAt: at,
          contentHash: "a".repeat(64),
          mimeType: "image/svg+xml",
          byteLength: 100,
        },
        purpose: "brand_asset",
        sourceReceiptId: id(8),
        rightsEvidenceId: null,
        publicationState: "committed",
      },
    },
  ],
  licenseOmissions: [],
  inputRevisions: [],
  createdAt: at,
};
let root: Root | null = null;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}
async function mount(client: AccountAssetsClient, opened = item) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: vi.fn() });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: vi.fn() });
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root!.render(createElement(AssetDetailDialog, { item: opened, client, onClose: vi.fn(), onSelected: vi.fn() })),
  );
  return host;
}
it("loads exact committed export provenance for the opened version without claiming legal clearance", async () => {
  const exportManifest = vi.fn(async () => manifest),
    client = { current: () => true, detail: async () => detail, exportManifest } as unknown as AccountAssetsClient;
  const host = await mount(client);
  expect(exportManifest).toHaveBeenCalled();
  expect(host.textContent).toContain("Approved logo export");
  expect(host.textContent).toContain("Verified vector logo geometry");
  expect(host.textContent).toContain("no exclusivity or trademark guarantee");
  expect(host.querySelector(`a[href="/brands/account/${id(2)}/logo/deliverables"]`)).not.toBeNull();
});
it("keeps the opened version evidence when a previous version lookup resolves late", async () => {
  const newer = assetVersionDetailSchema.parse({ ...version, versionId: id(5), versionNumber: 2 });
  const twoVersions = { ...versions, items: [newer, version], totalCount: 2 },
    twoAssets = { ...asset, versionCount: 2 };
  const loaded = assetDetailSchema.parse({ ...detail, asset: twoAssets, versions: twoVersions });
  const newerManifest = {
    ...manifest,
    id: id(20),
    files: manifest.files.map((file) => ({
      ...file,
      asset: { ...file.asset, reference: { ...file.asset.reference, versionId: newer.versionId } },
    })),
  };
  const first = deferred<typeof manifest | null>(),
    second = deferred<typeof manifest | null>();
  const reads: { versionId: string; signal: AbortSignal | undefined }[] = [];
  const exportManifest = (input: typeof version, signal?: AbortSignal) => {
    reads.push({ versionId: input.versionId, signal });
    return input.versionId === version.versionId ? first.promise : second.promise;
  };
  const client = { current: () => true, detail: async () => loaded, exportManifest } as unknown as AccountAssetsClient;
  // The library card was loaded before version 2; detail now includes both.
  const host = await mount(client);
  expect(reads.map((read) => read.versionId)).toEqual([version.versionId]);
  // The version is a menu select: open it, then choose version 2.
  await act(async () => host.querySelector<HTMLButtonElement>(".assets-version-title")!.click());
  const chooseNewer = Array.from(host.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')).find((button) =>
    button.textContent?.includes("Version 2"),
  );
  expect(chooseNewer).toBeDefined();
  await act(async () => chooseNewer!.click());
  expect(reads.map((read) => read.versionId)).toEqual([version.versionId, newer.versionId]);
  expect(reads[0]!.signal?.aborted).toBe(true);
  expect(host.querySelector(".assets-version-title")?.textContent).toContain("Version 2");
  await act(async () => second.resolve(newerManifest));
  expect(host.textContent).toContain("Approved logo export");
  // Resolve despite abort, as an already-completed transport may still settle.
  // Without the effect's stale-read guard this replaces the newer evidence.
  await act(async () => first.resolve(manifest));
  expect(host.querySelector(".assets-version-title")?.textContent).toContain("Version 2");
  expect(host.textContent).toContain("Approved logo export");
  expect(host.textContent).toContain("Verified vector logo geometry");
  expect(host.querySelector(`a[href="/brands/account/${id(2)}/logo/deliverables"]`)).not.toBeNull();
});
it("does not publish delayed export evidence after the account becomes invalid", async () => {
  let current = true,
    signal: AbortSignal | undefined;
  const pending = deferred<typeof manifest | null>();
  const client = {
    current: () => current,
    detail: async () => detail,
    exportManifest: (_input: typeof version, observed?: AbortSignal) => {
      signal = observed;
      return pending.promise;
    },
  } as unknown as AccountAssetsClient;
  const host = await mount(client);
  expect(signal).toBeDefined();
  expect(signal?.aborted).toBe(false);
  expect(host.textContent).toContain("Legacy record · provider unverified");
  current = false;
  await act(async () => pending.resolve(manifest));
  // Keep the component mounted and the signal live to isolate the account fence.
  expect(signal?.aborted).toBe(false);
  expect(host.textContent).toContain("Legacy record · provider unverified");
  expect(host.textContent).not.toContain("Approved logo export");
  expect(host.textContent).not.toContain("Verified vector logo geometry");
  expect(host.querySelector(`a[href="/brands/account/${id(2)}/logo/deliverables"]`)).toBeNull();
});
